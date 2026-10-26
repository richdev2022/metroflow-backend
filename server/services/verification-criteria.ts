import { query } from "../db";
import { getSetting, setSetting } from "./app-config";

/**
 * Verification badge — CRITERIA engine (in addition to the paid subscription).
 *
 * Product rule: any account that satisfies the admin-configured criteria earns
 * the verified badge automatically. The criteria live in system_settings
 * `verification_badge_criteria` and are fully admin-manageable (dashboard →
 * Personal Products → Verified badge card). The engine runs on every
 * follow/unfollow so badges appear/disappear live, and admins can force a
 * full resync via POST /admin/personal/verification-criteria/reapply.
 *
 * Criteria (each additional knob can be 0/off — at least one must be active):
 *   enabled                master switch
 *   followers              min follower count          (0 = not required)
 *   min_posts              min posts created           (0 = not required)
 *   min_account_age_days   min account age in days     (0 = not required)
 *   require_kyc            BVN or NIN verified         (false = not required)
 *   require_phone          phone number verified       (false = not required)
 *
 * Badge sources on users.verified_badge_source:
 *   'subscription' — paid monthly badge (verified_until matters)
 *   'criteria'     — earned via criteria (never expires)
 *   'admin'        — manual grant (behaves like a comp'd subscription)
 * The source guards revocation: downgrades only ever affect criteria
 * badges, never paid or admin-granted ones.
 */

export interface BadgeCriteria {
  enabled: boolean;
  followers: number;
  min_posts: number;
  min_account_age_days: number;
  require_kyc: boolean;
  require_phone: boolean;
}

const DEFAULT_CRITERIA: BadgeCriteria = {
  enabled: true,
  followers: 10_000,
  min_posts: 0,
  min_account_age_days: 0,
  require_kyc: false,
  require_phone: false,
};

const nonNegInt = (v: unknown, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export async function getBadgeCriteria(): Promise<BadgeCriteria> {
  try {
    const raw = await getSetting("verification_badge_criteria", "");
    if (!raw) return { ...DEFAULT_CRITERIA };
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed?.enabled !== false,
      followers: nonNegInt(parsed?.followers, DEFAULT_CRITERIA.followers),
      min_posts: nonNegInt(parsed?.min_posts, 0),
      min_account_age_days: nonNegInt(parsed?.min_account_age_days, 0),
      require_kyc: parsed?.require_kyc === true,
      require_phone: parsed?.require_phone === true,
    };
  } catch {
    return { ...DEFAULT_CRITERIA };
  }
}

export async function setBadgeCriteria(next: Partial<BadgeCriteria>): Promise<BadgeCriteria> {
  const current = await getBadgeCriteria();
  const clean: BadgeCriteria = {
    enabled: next.enabled !== undefined ? Boolean(next.enabled) : current.enabled,
    followers: nonNegInt(next.followers ?? current.followers, current.followers),
    min_posts: nonNegInt(next.min_posts ?? current.min_posts, 0),
    min_account_age_days: nonNegInt(next.min_account_age_days ?? current.min_account_age_days, 0),
    require_kyc: next.require_kyc !== undefined ? Boolean(next.require_kyc) : current.require_kyc,
    require_phone: next.require_phone !== undefined ? Boolean(next.require_phone) : current.require_phone,
  };
  if (clean.enabled) {
    const anyActive =
      clean.followers > 0 ||
      clean.min_posts > 0 ||
      clean.min_account_age_days > 0 ||
      clean.require_kyc ||
      clean.require_phone;
    if (!anyActive) {
      throw new Error("Enable at least one criterion (followers, posts, account age, KYC or phone) — otherwise every account would auto-verify.");
    }
  }
  await setSetting(
    "verification_badge_criteria",
    JSON.stringify(clean),
    "Verified badge auto-criteria (personal app) — followers/posts/age/KYC/phone",
  );
  return clean;
}

/** SQL fragment (per-user alias `u`) that checks every countable criterion. */
function criteriaSql(criteria: BadgeCriteria): string {
  const parts: string[] = [];
  if (criteria.followers > 0) {
    parts.push(`(SELECT COUNT(*) FROM social_follows f WHERE f.following_id = u.id) >= ${Math.round(criteria.followers)}`);
  }
  if (criteria.min_posts > 0) {
    parts.push(`(SELECT COUNT(*) FROM social_posts p WHERE p.user_id = u.id) >= ${Math.round(criteria.min_posts)}`);
  }
  if (criteria.min_account_age_days > 0) {
    parts.push(`u.created_at <= CURRENT_TIMESTAMP - INTERVAL '${Math.round(criteria.min_account_age_days)} days'`);
  }
  if (criteria.require_kyc) {
    parts.push(`(u.bvn_status = 'verified' OR u.nin_status = 'verified')`);
  }
  if (criteria.require_phone) {
    parts.push(`u.phone_verified = true`);
  }
  // No criteria active → nobody qualifies via the engine (guard upstream).
  return parts.length ? `(${parts.join(" AND ")})` : `false`;
}

export type BadgeEvaluation = "granted" | "revoked" | "unchanged";

/**
 * Re-evaluate the criteria badge for a user after their standing moved.
 * Call with "up" after a follow/post and "down" after an unfollow (the
 * direction only hints at the cheap exit — the criteria are always re-checked).
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
      const check = await query(
        `SELECT ${criteriaSql(criteria)} AS qualifies FROM users u WHERE u.id = $1`,
        [userId],
      );
      if (check.rows[0]?.qualifies === true && (status === "none" || status === "expired")) {
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

    // Below the criteria (or engine disabled): only criteria-earned badges
    // may be taken away — paid subscriptions and admin grants stay untouched.
    if (status === "active" && source === "criteria") {
      const check = await query(
        `SELECT ${criteria.enabled ? criteriaSql(criteria) : "false"} AS qualifies FROM users u WHERE u.id = $1`,
        [userId],
      );
      if (check.rows[0]?.qualifies !== true) {
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

export interface BadgeResyncResult {
  checked: number;
  granted: number;
  revoked: number;
}

/**
 * FULL RESYNC — re-apply the current criteria to every account in one pass.
 * Used by the dashboard's "Re-apply criteria" button after the admin changes
 * thresholds. Grants to every qualifying account without an active badge and
 * revokes criteria-earned badges that no longer qualify. Paid ('subscription')
 * and manual ('admin') badges are NEVER touched.
 */
export async function reapplyBadgeCriteria(): Promise<BadgeResyncResult> {
  const criteria = await getBadgeCriteria();
  const counts = await query(`SELECT COUNT(*)::int AS c FROM users`);
  const checked = Number(counts.rows[0]?.c) || 0;

  if (!criteria.enabled) {
    // Engine off — strip only criteria-earned badges.
    const off = await query(
      `UPDATE users SET verified_badge_status = 'none', verified_badge_source = NULL, verified_until = NULL
       WHERE verified_badge_status = 'active' AND verified_badge_source = 'criteria'`,
    );
    return { checked, granted: 0, revoked: off.rowCount || 0 };
  }

  const qualifies = criteriaSql(criteria);

  // GRANT: none/expired accounts that now qualify.
  const grant = await query(
    `UPDATE users u
       SET verified_badge_status = 'active',
           verified_badge_source = 'criteria',
           verified_since = COALESCE(u.verified_since, CURRENT_TIMESTAMP),
           verified_until = NULL
     WHERE COALESCE(u.verified_badge_status, 'none') IN ('none', 'expired')
       AND ${qualifies}`,
  );

  // REVOKE: criteria-earned badges that no longer qualify.
  const revoke = await query(
    `UPDATE users u
       SET verified_badge_status = 'none', verified_badge_source = NULL, verified_until = NULL
     WHERE u.verified_badge_status = 'active'
       AND u.verified_badge_source = 'criteria'
       AND NOT ${qualifies}`,
  );

  return { checked, granted: grant.rowCount || 0, revoked: revoke.rowCount || 0 };
}
