import { query } from "../db";
import { getSetting, setSetting } from "./app-config";

/**
 * Verification badge — CRITERIA engine (in addition to the paid subscription).
 *
 * Product rule: any account that reaches the follower threshold (default
 * 10,000) earns the verified badge automatically. The criteria themselves are
 * admin-configurable (system_settings `verification_badge_criteria`), and the
 * engine runs on every follow/unfollow so badges appear/disappear live.
 *
 * Badge sources on users.verified_badge_source:
 *   'subscription' — paid monthly badge (verified_until matters)
 *   'criteria'     — earned via follower threshold (never expires)
 *   'admin'        — manual grant (behaves like a comp'd subscription)
 * The source guards revocation: unfollows only ever downgrade criteria
 * badges, never paid or admin-granted ones.
 */

export interface BadgeCriteria {
  enabled: boolean;
  followers: number;
}

const DEFAULT_CRITERIA: BadgeCriteria = { enabled: true, followers: 10_000 };

export async function getBadgeCriteria(): Promise<BadgeCriteria> {
  try {
    const raw = await getSetting("verification_badge_criteria", "");
    if (!raw) return { ...DEFAULT_CRITERIA };
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed?.enabled !== false,
      followers: Math.max(1, Number(parsed?.followers) || DEFAULT_CRITERIA.followers),
    };
  } catch {
    return { ...DEFAULT_CRITERIA };
  }
}

export async function setBadgeCriteria(next: BadgeCriteria): Promise<BadgeCriteria> {
  const clean: BadgeCriteria = {
    enabled: Boolean(next.enabled),
    followers: Math.max(1, Math.round(Number(next.followers) || DEFAULT_CRITERIA.followers)),
  };
  await setSetting(
    "verification_badge_criteria",
    JSON.stringify(clean),
    "Verified badge auto-criteria (personal app) — followers threshold",
  );
  return clean;
}

async function followerCount(userId: string): Promise<number> {
  const r = await query(`SELECT COUNT(*)::int AS c FROM social_follows WHERE following_id = $1`, [userId]);
  return Number(r.rows[0]?.c) || 0;
}

export type BadgeEvaluation = "granted" | "revoked" | "unchanged";

/**
 * Re-evaluate the criteria badge for a user after their follower count moved.
 * Call with "up" after a follow and "down" after an unfollow (the direction
 * only hints at the cheap exit — the count is always re-checked).
 */
export async function evaluateFollowerBadge(userId: string, _direction: "up" | "down"): Promise<BadgeEvaluation> {
  try {
    const criteria = await getBadgeCriteria();
    const state = await query(
      `SELECT COALESCE(verified_badge_status, 'none') AS status, verified_badge_source AS source FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    const status = state.rows[0]?.status || "none";
    const source = state.rows[0]?.source || null;

    if (criteria.enabled) {
      const count = await followerCount(userId);
      if (count >= criteria.followers && (status === "none" || status === "expired")) {
        await query(
          `UPDATE users
             SET verified_badge_status = 'active',
                 verified_badge_source = 'criteria',
                 verified_since = COALESCE(verified_since, CURRENT_TIMESTAMP),
                 verified_until = NULL
           WHERE id = $1`,
          [userId],
        );
        return "granted";
      }
    }

    // Below the threshold (or criteria disabled): only criteria-earned badges
    // may be taken away — paid subscriptions and admin grants stay untouched.
    if (status === "active" && source === "criteria") {
      const count = await followerCount(userId);
      if (!criteria.enabled || count < criteria.followers) {
        await query(
          `UPDATE users SET verified_badge_status = 'none', verified_badge_source = NULL, verified_until = NULL WHERE id = $1`,
          [userId],
        );
        return "revoked";
      }
    }

    return "unchanged";
  } catch (e: any) {
    console.error("[verification-criteria] evaluate failed:", e?.message);
    return "unchanged";
  }
}
