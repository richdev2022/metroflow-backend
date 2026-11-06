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
 *   GET /social/music/catalog?genre=afrobeats|hiphop|pop|rnb&q=free+text
 *     → { success, data: { tracks: [{ id, title, artist, artwork_url,
 *           stream_url, duration, genre }], provider, cached } }
 *
 * Tracks stream via progressive MP3 (audioplayers UrlSource handles the
 * 302 → CDN hop natively — no extra client deps).
 */
import express, { Router } from "express";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";

const AUDIUS_HOST = (process.env.AUDIUS_HOST || "https://api.audius.co").replace(/\/$/, "");
const AUDIUS_APP = process.env.AUDIUS_APP_NAME || "metricorex";
const CACHE_TTL_MS = 10 * 60 * 1000;
const TRACKS_PER_BUCKET = 30;
const MIN_DURATION_S = 45; // skip jingles/loops — the "ringtone" complaint

/** genre param → Audius query plan */
const BUCKETS: Record<string, { search?: string; trendingGenre?: string }> = {
  afrobeats: { search: "afrobeats" },
  hiphop: { trendingGenre: "Hip-Hop/Rap" },
  pop: { trendingGenre: "Pop" },
  rnb: { trendingGenre: "R&B/Soul" },
};

const cache = new Map<string, { at: number; tracks: any[] }>();
const CACHE_MAX_ENTRIES = 8;

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

async function audiusFetch(path: string): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${AUDIUS_HOST}${path}${sep}app_name=${encodeURIComponent(AUDIUS_APP)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  } as RequestInit);
  if (!res.ok) throw new Error(`audius ${res.status}`);
  const json: any = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

async function loadBucket(key: string): Promise<{ tracks: any[]; cached: boolean }> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { tracks: hit.tracks, cached: true };
  }
  const bucket = BUCKETS[key] ?? {};
  let raw: any[] = [];
  if (bucket.search) {
    raw = await audiusFetch(`/v1/tracks/search?query=${encodeURIComponent(bucket.search)}`);
  } else if (bucket.trendingGenre) {
    try {
      raw = await audiusFetch(
        `/v1/tracks/trending?genre=${encodeURIComponent(bucket.trendingGenre)}&limit=${TRACKS_PER_BUCKET}`,
      );
    } catch {
      // Trending endpoint occasionally hiccups for a genre — search falls back.
      raw = await audiusFetch(`/v1/tracks/search?query=${encodeURIComponent(bucket.trendingGenre)}`);
    }
  } else {
    raw = await audiusFetch(`/v1/tracks/trending?limit=${TRACKS_PER_BUCKET}`);
  }
  const seen = new Set<string>();
  const tracks: any[] = [];
  for (const t of raw) {
    const n = normTrack(t);
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      tracks.push(n);
    }
    if (tracks.length >= TRACKS_PER_BUCKET) break;
  }
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), tracks });
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
      const key = q ? `q:${q.toLowerCase()}` : genre in BUCKETS ? genre : "afrobeats";
      const { tracks, cached } = await loadBucket(key);
      res.json({
        success: true,
        data: { tracks, provider: "audius", genre: q ? null : key, cached },
      });
    } catch (e: any) {
      // Cosmetic feature — a clean empty state beats a hard error banner.
      console.error("social music catalog error:", e?.message);
      res.json({ success: true, data: { tracks: [], provider: "audius", unavailable: true } });
    }
  },
);

export default router;
