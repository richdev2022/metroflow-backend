/**
 * SOCIAL MUSIC CATALOG — real, full-length licensed streaming tracks.
 *
 * The old picker bundled 8 SoundHelix algorithmic clips (the "ringtone"
 * complaint). This module serves a REAL catalog by proxying Audius
 * (audius.co) — a licensed, rights-cleared streaming platform where
 * independent artists publish full-length tracks (deep Afrobeats/Naija,
 * Hip-Hop/Rap, Pop and R&B catalogs included). The backend proxy keeps the
 * provider swappable, hides infra details from clients, and caches
 * responses so the picker opens instantly.
 *
 *   GET /social/music/catalog?genre=afrobeats|hiphop|pop|rnb|naija|gospel|
 *        amapiano|dancehall|highlife|fuji&q=free+text
 *     → { success, data: { tracks: [{ id, title, artist, artwork_url,
 *           stream_url, duration, genre }], provider, cached, genres } }
 *
 * Each genre bucket merges 2-3 Audius pages (offset 0/100/200) so the picker
 * opens with 200-400 tracks instead of a single ~30-track page, and free-text
 * `q` searches are executed for real (page 1 + page 2 when warranted). Pages
 * load via Promise.allSettled with a short per-request timeout — one slow or
 * failing page degrades to whatever succeeded, and a stale cache is the last
 * resort before the clean empty state.
 *
 * Tracks stream via progressive MP3 (audioplayers UrlSource handles the
 * 302 → CDN hop natively — no extra client deps).
 */
import express, { Router } from "express";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";

const AUDIUS_HOST = (process.env.AUDIUS_HOST || "https://api.audius.co").replace(/\/$/, "");
const AUDIUS_APP = process.env.AUDIUS_APP_NAME || "metricorex";
const CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_LIMIT = 100;        // Audius max page size
const PAGES_PER_BUCKET = 3;    // offset 0/100/200 per genre bucket
const TRACKS_PER_BUCKET = 300; // aim: 200-400 tracks per bucket
const PAGE_TIMEOUT_MS = 8000;  // one slow page must not kill the bucket
const MIN_DURATION_S = 45;     // skip jingles/loops — the "ringtone" complaint

/** genre param → Audius query plan. Old keys stay FIRST (client chip order). */
const BUCKETS: Record<string, { search?: string; trendingGenre?: string }> = {
  afrobeats: { search: "afrobeats" },
  hiphop: { trendingGenre: "Hip-Hop/Rap" },
  pop: { trendingGenre: "Pop" },
  rnb: { trendingGenre: "R&B/Soul" },
  naija: { search: "naija" },
  gospel: { search: "gospel" },
  amapiano: { search: "amapiano" },
  dancehall: { search: "dancehall" },
  highlife: { search: "highlife" },
  fuji: { search: "fuji" },
};

/** Chip payloads for the client picker — old keys first so existing clients keep working. */
const GENRES = Object.keys(BUCKETS).map((key) => ({
  key,
  label: key === "hiphop" ? "Hip-Hop" : key === "rnb" ? "R&B" : key.charAt(0).toUpperCase() + key.slice(1),
}));

const cache = new Map<string, { at: number; tracks: any[] }>();
const CACHE_MAX_ENTRIES = 40;

function normTrack(t: any): any | null {
  const id = t?.id ? String(t.id) : "";
  const title = String(t?.title ?? "").trim();
  if (!id || !title) return null;
  if (t?.is_delete === true) return null;
  const duration = Number(t?.duration) || 0;
  if (duration && duration < MIN_DURATION_S) return null; // ringtone-length clip
  const art =
    t?.artwork?.["480x480"] ||
    t?.artwork?.["150x150"] ||
    t?.artwork?.["1000x1000"] ||
    null;
  return {
    id,
    title,
    artist: String(t?.user?.name ?? t?.user?.handle ?? "Unknown artist"),
    artwork_url: art,
    stream_url: `${AUDIUS_HOST}/v1/tracks/${id}/stream?app_name=${encodeURIComponent(AUDIUS_APP)}`,
    duration,
    genre: t?.genre ? String(t.genre) : null,
    source: "audius",
  };
}

async function audiusFetch(path: string, timeoutMs: number = 12000): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${AUDIUS_HOST}${path}${sep}app_name=${encodeURIComponent(AUDIUS_APP)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit);
  if (!res.ok) throw new Error(`audius ${res.status}`);
  const json: any = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

/** Merge raw Audius pages IN ORDER (trending first) → dedupe + duration filter. */
function mergeTracks(raw: any[], cap: number): any[] {
  const seen = new Set<string>();
  const tracks: any[] = [];
  for (const t of raw) {
    const n = normTrack(t);
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      tracks.push(n);
    }
    if (tracks.length >= cap) break;
  }
  return tracks;
}

function cachePut(key: string, tracks: any[]): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), tracks });
}

/** Page paths for a genre bucket: 2-3 pages of its endpoint, offset 0/100/200. */
function bucketPagePaths(bucket: { search?: string; trendingGenre?: string }): string[] {
  const paths: string[] = [];
  if (bucket.search) {
    for (let p = 0; p < PAGES_PER_BUCKET; p++) {
      paths.push(`/v1/tracks/search?query=${encodeURIComponent(bucket.search)}&limit=${PAGE_LIMIT}&offset=${p * PAGE_LIMIT}`);
    }
  } else if (bucket.trendingGenre) {
    for (let p = 0; p < PAGES_PER_BUCKET; p++) {
      paths.push(`/v1/tracks/trending?genre=${encodeURIComponent(bucket.trendingGenre)}&limit=${PAGE_LIMIT}&offset=${p * PAGE_LIMIT}`);
    }
    // The trending endpoint occasionally hiccups for a genre — a search page
    // backfills the bucket (kept LAST so trending rows stay first in the merge).
    paths.push(`/v1/tracks/search?query=${encodeURIComponent(bucket.trendingGenre)}&limit=${PAGE_LIMIT}`);
  } else {
    for (let p = 0; p < PAGES_PER_BUCKET; p++) {
      paths.push(`/v1/tracks/trending?limit=${PAGE_LIMIT}&offset=${p * PAGE_LIMIT}`);
    }
  }
  return paths;
}

async function loadBucket(key: string): Promise<{ tracks: any[]; cached: boolean }> {
  const stale = cache.get(key) || null;
  if (stale && Date.now() - stale.at < CACHE_TTL_MS) {
    return { tracks: stale.tracks, cached: true };
  }
  const bucket = BUCKETS[key] ?? {};
  // Per-page timeout + allSettled: a single slow/failed page never kills the
  // bucket — we merge whatever pages succeeded (trending order preserved).
  const settled = await Promise.allSettled(
    bucketPagePaths(bucket).map((p) => audiusFetch(p, PAGE_TIMEOUT_MS)),
  );
  const raw = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const tracks = mergeTracks(raw, TRACKS_PER_BUCKET);
  if (!tracks.length) {
    // Every page failed — serve the stale cache (even past TTL) rather than
    // an empty picker; with no stale entry, bubble up to the clean empty state.
    if (stale?.tracks?.length) return { tracks: stale.tracks, cached: true };
    throw new Error(`audius bucket "${key}" unavailable`);
  }
  cachePut(key, tracks);
  return { tracks, cached: false };
}

/**
 * Free-text search — actually queries Audius. (The old code accepted `q` but
 * only used it as a cache key, so search silently returned the genre list.)
 * Page 1 always loads; page 2 (offset=100) is merged when the first page
 * comes back full.
 */
async function loadSearch(q: string): Promise<{ tracks: any[]; cached: boolean }> {
  const key = `q:${q.toLowerCase()}`;
  const stale = cache.get(key) || null;
  if (stale && Date.now() - stale.at < CACHE_TTL_MS) {
    return { tracks: stale.tracks, cached: true };
  }
  const first = await audiusFetch(
    `/v1/tracks/search?query=${encodeURIComponent(q)}&limit=${PAGE_LIMIT}`,
    PAGE_TIMEOUT_MS,
  ).catch(() => [] as any[]);
  let raw = first;
  if (first.length >= PAGE_LIMIT) {
    const second = await audiusFetch(
      `/v1/tracks/search?query=${encodeURIComponent(q)}&limit=${PAGE_LIMIT}&offset=${PAGE_LIMIT}`,
      PAGE_TIMEOUT_MS,
    ).catch(() => [] as any[]);
    raw = [...first, ...second];
  }
  const tracks = mergeTracks(raw, PAGE_LIMIT * 2);
  if (!tracks.length) {
    if (stale?.tracks?.length) return { tracks: stale.tracks, cached: true };
    throw new Error(`audius search "${q}" unavailable`);
  }
  cachePut(key, tracks);
  return { tracks, cached: false };
}

const router = Router();

router.get(
  "/catalog",
  authenticateToken,
  checkSubscriptionStatus,
  async (req: AuthenticatedRequest, res) => {
    try {
      const genre = String(req.query.genre ?? "afrobeats").toLowerCase();
      const q = String(req.query.q ?? "").trim();
      const bucketKey = genre in BUCKETS ? genre : "afrobeats";
      const { tracks, cached } = q ? await loadSearch(q) : await loadBucket(bucketKey);
      res.json({
        success: true,
        data: {
          tracks,
          provider: "audius",
          genre: q ? null : bucketKey,
          cached,
          // Renderable chip list — old bucket keys first for back-compat.
          genres: GENRES,
        },
      });
    } catch (e: any) {
      // Cosmetic feature — a clean empty state beats a hard error banner.
      console.error("social music catalog error:", e?.message);
      res.json({ success: true, data: { tracks: [], provider: "audius", unavailable: true, genres: GENRES } });
    }
  },
);

export default router;
