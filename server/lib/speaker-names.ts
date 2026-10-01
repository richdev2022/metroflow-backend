import { query } from "../db";

/**
 * Speaker-name resolution for persisted transcripts.
 *
 * Early caption segments stored `speaker_name` as a raw user UUID whenever the
 * roomManager lookup missed (media-only joins, socket reconnects, guests).
 * Downstream consumers (meeting report, transcripts, PDF, AI notes) must show
 * human names, so every consumer funnels its rows through `resolveSpeakerNames`
 * — which batch-resolves UUID-looking names via the users table and caches the
 * results in-process (5 min TTL) to keep repeated report loads fast.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { name: string; expiresAt: number }>();

function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

async function lookupUsers(ids: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (ids.length === 0) return found;
  const now = Date.now();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = cache.get(id);
    if (hit && hit.expiresAt > now) found.set(id, hit.name);
    else missing.push(id);
  }
  if (missing.length === 0) return found;
  try {
    const res = await query(
      `SELECT id, COALESCE(NULLIF(TRIM(name), ''), SPLIT_PART(email, '@', 1), 'Participant') AS name
       FROM users WHERE id = ANY($1::uuid[])`,
      [missing],
    );
    for (const row of res.rows) {
      const name = String(row.name || "Participant");
      found.set(String(row.id), name);
      cache.set(String(row.id), { name, expiresAt: now + CACHE_TTL_MS });
    }
  } catch {
    // Never break the caller — unresolved rows keep their raw values.
  }
  return found;
}

export interface SpeakerRow {
  speakerId?: string | null;
  speaker_name?: string | null;
  speakerName?: string | null;
}

/**
 * Returns a copy of `rows` with `speakerName` guaranteed to be a human label:
 * existing non-UUID names are kept, UUID/empty names are resolved from the
 * users table (by speakerId) or fall back to "Participant".
 */
export async function resolveSpeakerNames<T extends SpeakerRow>(rows: T[]): Promise<Array<T & { speakerName: string }>> {
  const needsLookup = new Set<string>();
  for (const row of rows) {
    const current = row.speakerName ?? row.speaker_name ?? "";
    if (!current.trim() || isUuid(current)) {
      if (row.speakerId && isUuid(row.speakerId)) needsLookup.add(String(row.speakerId));
    }
  }
  const resolved = await lookupUsers([...needsLookup]);
  return rows.map((row) => {
    const current = String(row.speakerName ?? row.speaker_name ?? "").trim();
    let name = current;
    if (!name || isUuid(name)) {
      name =
        (row.speakerId ? resolved.get(String(row.speakerId)) : undefined) ||
        (!isUuid(current) && current) ||
        "Participant";
    }
    return { ...row, speakerName: name };
  });
}

/** One-off resolution for a single speaker id (caption persistence path). */
export async function resolveSingleSpeakerName(speakerId: string | null | undefined): Promise<string | null> {
  if (!speakerId || !isUuid(speakerId)) return null;
  const map = await lookupUsers([speakerId]);
  return map.get(speakerId) || null;
}

export { isUuid as looksLikeUuid };
