import { query } from "../db";
import { getCache, setCache } from "./cache";

/**
 * MetricAi usage limits — per-plan, admin-configurable, per-feature
 * (chat | image | video) with independent DAILY and MONTHLY caps.
 *
 * Storage:
 *   - Limits live on `pricing_plans` columns (metric_ai_{feature}_{daily|monthly}).
 *     NULL = unlimited. Admin edits them via /admin/ai/limits (metroflow-admin).
 *   - Counters live in `metric_ai_usage` keyed (user_id, feature, day) with a
 *     month column for cheap monthly SUMs. Postgres upsert = atomic, durable
 *     across restarts and multi-worker safe (PM2 fork mode: one process, but
 *     still correct if that changes).
 *   - Plan limit rows are cached (Redis when available, else a tiny in-process
 *     TTL map) because they are read on every chat message.
 *
 * A message that triggers generation consumes from BOTH buckets:
 *   plain chat          -> chat
 *   image generation    -> chat + image
 *   video job created   -> chat + video
 */

export type AiFeature = "chat" | "image" | "video";

export interface AiFeatureLimit {
  daily: number | null;
  monthly: number | null;
}

export interface AiPlanLimits {
  chat: AiFeatureLimit;
  image: AiFeatureLimit;
  video: AiFeatureLimit;
}

export interface AiFeatureUsage {
  daily: { used: number; limit: number | null; resetsAt: string };
  monthly: { used: number; limit: number | null; resetsAt: string };
}

const LIMITS_CACHE_KEY = "ai:plan-limits";
const LIMITS_CACHE_TTL_S = 60;

/** In-process fallback cache when Redis is unavailable (single-node VPS). */
const memCache = new Map<string, { value: unknown; expiresAt: number }>();

async function cachedGet<T>(key: string): Promise<T | null> {
  try {
    const redisValue = await getCache<T>(key);
    if (redisValue !== null && redisValue !== undefined) return redisValue;
  } catch { /* redis down — fall through to memory */ }
  const mem = memCache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.value as T;
  return null;
}

async function cachedSet(key: string, value: unknown, ttlS: number): Promise<void> {
  memCache.set(key, { value, expiresAt: Date.now() + ttlS * 1000 });
  try {
    await setCache(key, value, ttlS);
  } catch { /* redis down — memory already set */ }
}

export function invalidatePlanLimitsCache(): void {
  memCache.delete(LIMITS_CACHE_KEY);
  void setCache(LIMITS_CACHE_KEY, null, 1).catch(() => {});
}

interface PlanRow {
  metric_ai_chat_daily: number | null;
  metric_ai_chat_monthly: number | null;
  metric_ai_image_daily: number | null;
  metric_ai_image_monthly: number | null;
  metric_ai_video_daily: number | null;
  metric_ai_video_monthly: number | null;
}

function toLimits(row: PlanRow | null | undefined): AiPlanLimits {
  const n = (v: unknown): number | null => {
    const num = Number(v);
    return Number.isFinite(num) && num >= 0 ? num : null;
  };
  return {
    chat: { daily: n(row?.metric_ai_chat_daily), monthly: n(row?.metric_ai_chat_monthly) },
    image: { daily: n(row?.metric_ai_image_daily), monthly: n(row?.metric_ai_image_monthly) },
    video: { daily: n(row?.metric_ai_video_daily), monthly: n(row?.metric_ai_video_monthly) },
  };
}

/** Fetch (and cache) the AI limits configured for one pricing plan row. */
export async function getPlanAiLimits(planId: string | null): Promise<AiPlanLimits> {
  if (!planId) return toLimits(null);
  const cacheKey = `${LIMITS_CACHE_KEY}:${planId}`;
  const hit = await cachedGet<AiPlanLimits>(cacheKey);
  if (hit) return hit;
  try {
    const result = await query(
      `SELECT metric_ai_chat_daily, metric_ai_chat_monthly,
              metric_ai_image_daily, metric_ai_image_monthly,
              metric_ai_video_daily, metric_ai_video_monthly
       FROM pricing_plans WHERE id = $1`,
      [planId],
    );
    const limits = toLimits(result.rows[0]);
    await cachedSet(cacheKey, limits, LIMITS_CACHE_TTL_S);
    return limits;
  } catch (e) {
    console.error("[ai-usage] failed to load plan limits:", e);
    return toLimits(null);
  }
}

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
function utcMonthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}
function nextUtcMidnight(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return t.toISOString();
}
function nextUtcMonth(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return t.toISOString();
}

/** Check-only: would consuming one slot exceed a cap? */
export async function assertWithinAiUsage(
  userId: string,
  feature: AiFeature,
  limits: AiPlanLimits,
): Promise<{ ok: true } | { ok: false; feature: AiFeature; period: "daily" | "monthly"; limit: number; used: number; resetsAt: string; friendlyError: string }> {
  const featureLimits = limits[feature];
  const day = utcDayKey();
  const month = utcMonthKey();

  if (featureLimits.monthly !== null) {
    const usedMonth = await usedInMonth(userId, feature, month);
    if (usedMonth >= featureLimits.monthly) {
      return {
        ok: false, feature, period: "monthly", limit: featureLimits.monthly, used: usedMonth,
        resetsAt: nextUtcMonth(), friendlyError: monthlyMessage(feature, featureLimits.monthly),
      };
    }
  }
  if (featureLimits.daily !== null) {
    const usedToday = await usedOnDay(userId, feature, day);
    if (usedToday >= featureLimits.daily) {
      return {
        ok: false, feature, period: "daily", limit: featureLimits.daily, used: usedToday,
        resetsAt: nextUtcMidnight(), friendlyError: dailyMessage(feature, featureLimits.daily),
      };
    }
  }
  return { ok: true };
}

/** Record one consumed slot (atomic upsert). Never throws into the caller. */
export async function recordAiUsage(userId: string, businessId: string | null, feature: AiFeature): Promise<void> {
  try {
    await query(
      `INSERT INTO metric_ai_usage (user_id, business_id, feature, day, month, count)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (user_id, feature, day)
       DO UPDATE SET count = metric_ai_usage.count + 1, updated_at = NOW()`,
      [userId, businessId, feature, utcDayKey(), utcMonthKey()],
    );
  } catch (e) {
    console.error("[ai-usage] counter increment failed (non-fatal):", e);
  }
}

/** Atomic "check + consume one slot" (used for plain chat messages). */
export async function tryConsumeAiUsage(
  userId: string,
  businessId: string | null,
  feature: AiFeature,
  limits: AiPlanLimits,
): Promise<{ ok: true } | { ok: false; feature: AiFeature; period: "daily" | "monthly"; limit: number; used: number; resetsAt: string; friendlyError: string }> {
  const gate = await assertWithinAiUsage(userId, feature, limits);
  if (!gate.ok) return gate;
  await recordAiUsage(userId, businessId, feature);
  return { ok: true };
}

export async function usedOnDay(userId: string, feature: AiFeature, day = utcDayKey()): Promise<number> {
  const r = await query(
    `SELECT count FROM metric_ai_usage WHERE user_id = $1 AND feature = $2 AND day = $3`,
    [userId, feature, day],
  );
  return Number(r.rows[0]?.count) || 0;
}

export async function usedInMonth(userId: string, feature: AiFeature, month = utcMonthKey()): Promise<number> {
  const r = await query(
    `SELECT COALESCE(SUM(count), 0) AS total FROM metric_ai_usage
     WHERE user_id = $1 AND feature = $2 AND month = $3`,
    [userId, feature, month],
  );
  return Number(r.rows[0]?.total) || 0;
}

/** Full usage snapshot for the UI (header chips + settings screens). */
export async function getAiUsageSnapshot(userId: string, limits: AiPlanLimits): Promise<Record<AiFeature, AiFeatureUsage>> {
  const day = utcDayKey();
  const month = utcMonthKey();
  const dailyResets = nextUtcMidnight();
  const monthlyResets = nextUtcMonth();
  const out = {} as Record<AiFeature, AiFeatureUsage>;
  for (const feature of ["chat", "image", "video"] as AiFeature[]) {
    const [dailyUsed, monthlyUsed] = await Promise.all([
      usedOnDay(userId, feature, day),
      usedInMonth(userId, feature, month),
    ]);
    out[feature] = {
      daily: { used: dailyUsed, limit: limits[feature].daily, resetsAt: dailyResets },
      monthly: { used: monthlyUsed, limit: limits[feature].monthly, resetsAt: monthlyResets },
    };
  }
  return out;
}

const FEATURE_LABEL: Record<AiFeature, string> = {
  chat: "MetricAi chats",
  image: "MetricAi image generations",
  video: "MetricAi video generations",
};

function dailyMessage(feature: AiFeature, limit: number): string {
  return `You've reached today's limit of ${limit} ${FEATURE_LABEL[feature]} on your plan. Your allowance resets at midnight UTC — or upgrade your plan for more.`;
}
function monthlyMessage(feature: AiFeature, limit: number): string {
  return `You've used all ${limit} ${FEATURE_LABEL[feature]} included in your plan this month. Your allowance resets next month — or upgrade for a higher limit.`;
}
