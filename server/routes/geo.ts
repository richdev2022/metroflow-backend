import express from "express";
import { AuthenticatedRequest, authenticateToken } from "../middleware/auth";

const router = express.Router();

/**
 * Address autocomplete proxy (OpenStreetMap Nominatim).
 *
 * WHY THIS EXISTS: Nominatim's usage policy requires an identifying
 * User-Agent, and its edge (Cloudflare) rejects requests carrying a generic
 * browser UA with 503. Web autocomplete therefore returned EMPTY results
 * while the mobile app (which sends the identified "Metroflow-Mobile/1.0"
 * UA from its HTTP client) kept working. Both apps now call THIS endpoint,
 * so web and mobile share one provider, one UA identity and one response
 * shape — and the server absorbs repeats through a small TTL cache.
 */

const NOMINATIM_BASE = (
  process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org"
).replace(/\/+$/, "");
const NOMINATIM_UA =
  process.env.NOMINATIM_USER_AGENT ||
  "Metroflow/1.0 (support@metricorex.com)";
const NOMINATIM_TIMEOUT_MS = 8000;

// ---- Tiny in-process TTL cache --------------------------------------------
// Address prefixes are queried repeatedly while the user types ("1801 M",
// "1801 Mai", ...). Caching full-query responses for a few minutes keeps us
// comfortably inside Nominatim's politeness budget on both apps' behalf.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const suggestCache = new Map<string, { at: number; rows: unknown[] }>();

function cacheGet(key: string): unknown[] | null {
  const hit = suggestCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    suggestCache.delete(key);
    return null;
  }
  return hit.rows;
}

function cacheSet(key: string, rows: unknown[]): void {
  // Naive size cap: drop the OLDEST entries first (insertion order).
  if (suggestCache.size >= CACHE_MAX_ENTRIES) {
    const drop = suggestCache.size - CACHE_MAX_ENTRIES + 1;
    let i = 0;
    for (const k of suggestCache.keys()) {
      if (i++ >= drop) break;
      suggestCache.delete(k);
    }
  }
  suggestCache.set(key, { at: Date.now(), rows });
}

// Nominatim fields both clients consume. Pass them through 1:1 (snake_case)
// so the existing pickers keep working without a translation layer.
const ALLOWED_ADDRESS_FIELDS = [
  "house_number",
  "road",
  "neighbourhood",
  "suburb",
  "city_district",
  "city",
  "town",
  "village",
  "municipality",
  "county",
  "state",
  "state_district",
  "postcode",
  "country",
  "country_code",
] as const;

function pickAddress(address: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (address && typeof address === "object") {
    for (const [k, v] of Object.entries(address as Record<string, unknown>)) {
      if (
        (ALLOWED_ADDRESS_FIELDS as readonly string[]).includes(k) &&
        (typeof v === "string" || typeof v === "number")
      ) {
        out[k] = String(v);
      }
    }
  }
  return out;
}

/**
 * @swagger
 * tags:
 *   name: Geo
 *   description: Address autocomplete (OpenStreetMap via server proxy)
 */

/**
 * @swagger
 * /geo/address-suggest:
 *   get:
 *     summary: Suggest international addresses for beneficiary/payout forms
 *     tags: [Geo]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Free-text address query (min 3 chars)
 *       - in: query
 *         name: cc
 *         schema:
 *           type: string
 *         description: ISO-3166-1 alpha-2 country code to scope the search
 *     responses:
 *       200:
 *         description: Nominatim-shaped suggestions (place_id, display_name, name, address)
 *       400:
 *         description: Missing/short query or invalid country code
 *       502:
 *         description: Upstream provider failure or timeout
 */
router.get(
  "/address-suggest",
  authenticateToken,
  async (req: AuthenticatedRequest, res) => {
    const q = String(req.query.q ?? "").trim();
    const cc = String(req.query.cc ?? "")
      .trim()
      .toLowerCase();

    if (q.length < 3 || q.length > 120) {
      return res.status(400).json({
        success: false,
        error: "Provide an address query of 3-120 characters",
      });
    }
    if (cc && !/^[a-z]{2}$/.test(cc)) {
      return res.status(400).json({
        success: false,
        error: "cc must be a 2-letter ISO country code",
      });
    }

    const cacheKey = `${cc}|${q.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, cached: true });
    }

    const url = new URL(`${NOMINATIM_BASE}/search`);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "5");
    if (cc) url.searchParams.set("countrycodes", cc);
    url.searchParams.set("q", q);

    try {
      const upstream = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          // The identified UA is what the mobile app already sends — the
          // exact reason mobile worked while direct browser fetches got 503.
          "User-Agent": NOMINATIM_UA,
          "Accept-Language": "en",
        },
        signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
      });

      if (!upstream.ok) {
        console.error(
          `Nominatim suggest failed: HTTP ${upstream.status} for q=${JSON.stringify(q)} cc=${cc}`,
        );
        return res.status(502).json({
          success: false,
          error: "Address lookup is temporarily unavailable — try again shortly",
        });
      }

      const raw = await upstream.json();
      const list = Array.isArray(raw) ? raw : [];

      const rows = list
        .filter((item: unknown) => item && typeof item === "object")
        .map((item: Record<string, unknown>) => ({
          place_id: item.place_id,
          osm_type: item.osm_type,
          osm_id: item.osm_id,
          lat: item.lat,
          lon: item.lon,
          name: typeof item.name === "string" ? item.name : "",
          display_name:
            typeof item.display_name === "string" ? item.display_name : "",
          address: pickAddress(item.address),
        }));

      cacheSet(cacheKey, rows);
      return res.json({ success: true, data: rows });
    } catch (err: any) {
      const reason =
        err?.name === "TimeoutError" || err?.name === "AbortError"
          ? "upstream timeout"
          : err?.message || "unknown error";
      console.error(`Nominatim suggest error (${reason}) for q=${JSON.stringify(q)}`);
      return res.status(502).json({
        success: false,
        error: "Address lookup is temporarily unavailable — try again shortly",
      });
    }
  },
);

export default router;
