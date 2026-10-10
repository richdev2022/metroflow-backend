import { query } from "../db";
import { getSetting } from "./app-config";

/**
 * Refer & Earn service.
 *
 * - Every user gets a unique referral code (lazily minted, idempotent).
 * - A new user can be attributed to a referrer at signup (referralCode on
 *   /auth/register and /auth/google) or later via POST /referrals/claim.
 * - When the referred user's business pays its FIRST successful subscription,
 *   the referrer earns the admin-configured bonus straight into their
 *   personal Metricorex wallet. The payout is debited from the PLATFORM
 *   REVENUE ledger (platform_wallet + a wallet_id NULL revenue row) and is
 *   idempotent: referral_bonuses.referred_user_id is UNIQUE, and the ledger
 *   rows use deterministic references.
 */

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L

export interface ReferralConfig {
  enabled: boolean;
  amount: number;
  currency: string;
}

export async function getReferralConfig(): Promise<ReferralConfig> {
  const [enabled, amount, currency] = await Promise.all([
    getSetting("referral_bonus_enabled", "true"),
    getSetting("referral_bonus_amount", "5000"),
    getSetting("referral_bonus_currency", "NGN"),
  ]);
  const parsedAmount = Number(amount);
  return {
    enabled: enabled === "true",
    amount: Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0,
    currency: (currency || "NGN").toUpperCase().slice(0, 3),
  };
}

function randomCode(length = 8): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Mint a referral code for a user if they don't have one. Idempotent and
 * safe to call on every read — it is a no-op once a code exists.
 */
export async function ensureUserReferralCode(userId: string): Promise<string | null> {
  try {
    const updated = await query(
      `UPDATE users SET referral_code = $2
       WHERE id = $1 AND referral_code IS NULL
       RETURNING referral_code`,
      [userId, randomCode()],
    );
    if (updated.rows.length > 0) return updated.rows[0].referral_code as string;
    const existing = await query(`SELECT referral_code FROM users WHERE id = $1 LIMIT 1`, [userId]);
    return (existing.rows[0]?.referral_code as string) || null;
  } catch (err: any) {
    console.warn("ensureUserReferralCode failed:", err?.message);
    return null;
  }
}

/**
 * Resolve a referral code to a referrer user id. Codes are compared
 * case-insensitively (clients may lowercase them when sharing links).
 */
export async function resolveReferrerByCode(
  code: string | null | undefined,
): Promise<{ id: string; name: string | null } | null> {
  const trimmed = (code || "").trim().toUpperCase();
  if (!trimmed || trimmed.length < 4 || trimmed.length > 20) return null;
  const res = await query(
    `SELECT id, name FROM users WHERE UPPER(referral_code) = $1 AND status != 'banned' LIMIT 1`,
    [trimmed],
  );
  return res.rows[0] ? { id: res.rows[0].id, name: res.rows[0].name ?? null } : null;
}

/**
 * Attach a referrer to a user (once). Used by signup attribution and by the
 * authenticated /referrals/claim endpoint (Google SSO / missed field).
 * Never overwrites an existing referrer. Self-referral is rejected.
 */
export async function attributeReferrer(
  userId: string,
  code: string | null | undefined,
): Promise<{ applied: boolean; reason?: string; referrerName?: string | null }> {
  const referrer = await resolveReferrerByCode(code);
  if (!referrer) return { applied: false, reason: "invalid_code" };
  if (referrer.id === userId) return { applied: false, reason: "self_referral" };

  const current = await query(`SELECT referred_by FROM users WHERE id = $1 LIMIT 1`, [userId]);
  if (current.rows[0]?.referred_by) return { applied: false, reason: "already_referred" };

  const updated = await query(
    `UPDATE users SET referred_by = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND referred_by IS NULL
     RETURNING id`,
    [referrer.id, userId],
  );
  return { applied: updated.rows.length > 0, referrerName: referrer.name };
}

function shortRef(userId: string): string {
  return userId.replace(/-/g, "").slice(0, 12).toUpperCase();
}

/**
 * Pay the referral bonus for a business's FIRST successful subscription.
 * Called from every subscription activation path (verify-payment, gateway
 * webhooks, admin manual upgrade). Never throws into the caller — all
 * failures are logged and swallowed so payments never break because of it.
 *
 * Atomicity: referral_bonuses.referred_user_id is UNIQUE and the INSERT uses
 * ON CONFLICT DO NOTHING ... RETURNING — exactly one concurrent caller wins.
 */
export async function maybePayReferralBonus(
  businessId: string | null | undefined,
  planId?: string | null,
): Promise<void> {
  try {
    if (!businessId) return;

    const config = await getReferralConfig();
    if (!config.enabled || config.amount <= 0) return;

    const pool = (await import("../db")).pool;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. The referred user = the business owner, must have a referrer.
      const ownerRes = await client.query(
        `SELECT u.id AS user_id, u.name AS user_name, u.referred_by
         FROM businesses b JOIN users u ON u.id = b.owner_id
         WHERE b.id = $1 LIMIT 1`,
        [businessId],
      );
      const owner = ownerRes.rows[0];
      if (!owner || !owner.referred_by) {
        await client.query("ROLLBACK");
        return;
      }

      // 2. First-successful-subscription only (the current payment is
      //    already recorded as a success by the caller at this point).
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM transactions
         WHERE business_id = $1 AND transaction_type = 'subscription' AND status = 'success'`,
        [businessId],
      );
      if ((countRes.rows[0]?.n ?? 0) > 1) {
        await client.query("ROLLBACK");
        return;
      }

      // 3. Idempotency anchor — one bonus per referred user, ever.
      const reference = `REFBON-${shortRef(owner.user_id)}`;
      const bonusInsert = await client.query(
        `INSERT INTO referral_bonuses
           (referrer_user_id, referred_user_id, referred_business_id, plan_id,
            amount, currency, status, reference)
         VALUES ($1, $2, $3, $4, $5, $6, 'paid', $7)
         ON CONFLICT (referred_user_id) DO NOTHING
         RETURNING id`,
        [owner.referred_by, owner.user_id, businessId, planId || null,
         config.amount.toFixed(2), config.currency, reference],
      );
      if (bonusInsert.rows.length === 0) {
        await client.query("ROLLBACK");
        return;
      }
      const bonusId = bonusInsert.rows[0].id as string;

      // 4. Credit the referrer's personal wallet (create if missing).
      let walletRes = await client.query(
        `SELECT id FROM wallets WHERE user_id = $1 AND business_id IS NULL LIMIT 1`,
        [owner.referred_by],
      );
      if (walletRes.rows.length === 0) {
        walletRes = await client.query(
          `INSERT INTO wallets (user_id, balance, currency, status)
           VALUES ($1, 0, $2, 'active')
           ON CONFLICT (user_id) DO NOTHING
           RETURNING id`,
          [owner.referred_by, config.currency],
        );
        if (walletRes.rows.length === 0) {
          walletRes = await client.query(
            `SELECT id FROM wallets WHERE user_id = $1 AND business_id IS NULL LIMIT 1`,
            [owner.referred_by],
          );
        }
      }
      const walletId = walletRes.rows[0]?.id;
      if (!walletId) throw new Error("referrer wallet unavailable");

      await client.query(
        `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [config.amount.toFixed(2), walletId],
      );

      // 5. Referrer-facing ledger row (their wallet history).
      const txInsert = await client.query(
        `INSERT INTO transactions
           (business_id, amount, currency, reference, status, type, description,
            transaction_type, wallet_id, direction)
         VALUES ($1, $2, $3, $4, 'success', 'credit', $5, 'referral_bonus', $6, 'credit')
         RETURNING id`,
        [
          businessId,
          config.amount.toFixed(2),
          config.currency,
          reference,
          `Referral bonus earned`,
          walletId,
        ],
      );

      await client.query(
        `UPDATE referral_bonuses SET transaction_id = $1 WHERE id = $2`,
        [txInsert.rows[0].id, bonusId],
      );

      // 6. DEBIT the platform revenue ledger (owner spec: referral bonuses
      //    are paid out of platform revenue). Mirrors creditRevenueWallet's
      //    revenue-row convention (wallet_id NULL, debit direction).
      let revWallet = await client.query(
        `SELECT id FROM platform_wallet WHERE currency = $1 LIMIT 1`,
        [config.currency],
      );
      if (revWallet.rows.length === 0) {
        revWallet = await client.query(
          `INSERT INTO platform_wallet (balance, currency) VALUES (0, $1) RETURNING id`,
          [config.currency],
        );
      }
      await client.query(
        `UPDATE platform_wallet SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [config.amount.toFixed(2), revWallet.rows[0].id],
      );
      await client.query(
        `INSERT INTO transactions
           (amount, currency, reference, status, type, description, transaction_type, direction)
         VALUES ($1, $2, $3, 'success', 'debit', $4, 'referral_bonus', 'debit')`,
        [
          config.amount.toFixed(2),
          config.currency,
          `${reference}-REVENUE-DEBIT`,
          "Referral bonus payout (revenue debit)",
        ],
      );

      await client.query("COMMIT");

      console.log(
        `Referral bonus paid: ${config.amount} ${config.currency} -> user ${owner.referred_by} (referred user ${owner.user_id}, business ${businessId})`,
      );

      // 7. Best-effort notification email to the referrer.
      try {
        const referrerRes = await query(
          `SELECT email, name FROM users WHERE id = $1 LIMIT 1`,
          [owner.referred_by],
        );
        const referrer = referrerRes.rows[0];
        if (referrer?.email) {
          const { sendEmail, generateReferralBonusEmailHtml } = await import("../services/email");
          const html = generateReferralBonusEmailHtml(
            referrer.name || "there",
            config.amount,
            config.currency,
            owner.user_name || "A business you referred",
          );
          sendEmail(
            referrer.email,
            referrer.name || "there",
            `You earned a referral bonus of ${config.currency} ${config.amount.toLocaleString()}`,
            html,
          ).catch((e: any) => console.warn("Referral bonus email failed:", e?.message));
        }
      } catch (mailErr: any) {
        console.warn("Referral bonus email skipped:", mailErr?.message);
      }
    } catch (txErr) {
      await client.query("ROLLBACK").catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.warn("Referral bonus payout skipped:", err?.message || err);
  }
}

export interface ReferralStats {
  totalReferred: number;
  subscribed: number;
  totalEarned: number;
  earnedCurrency: string;
}

export interface ReferredUserRow {
  id: string;
  name: string | null;
  email: string;
  joinedAt: string;
  businessName: string | null;
  planId: string | null;
  subscriptionCount: number;
  bonusAmount: number | null;
  bonusCurrency: string | null;
  bonusStatus: string | null;
  bonusPaidAt: string | null;
  status: "pending" | "subscribed" | "paid";
}

export async function getReferralInfo(userId: string): Promise<{
  referralCode: string | null;
  config: ReferralConfig;
  stats: ReferralStats;
  referred: ReferredUserRow[];
}> {
  const referralCode = await ensureUserReferralCode(userId);
  const config = await getReferralConfig();

  const rows = await query(
    `SELECT u.id, u.name, u.email, u.created_at as "joinedAt",
            biz.name as "businessName", biz.plan_id as "planId",
            (SELECT COUNT(*)::int FROM transactions t
              WHERE t.business_id = biz.id AND t.transaction_type = 'subscription' AND t.status = 'success'
            ) as "subscriptionCount",
            rb.amount as "bonusAmount", rb.currency as "bonusCurrency",
            rb.status as "bonusStatus", rb.created_at as "bonusPaidAt"
     FROM users u
     LEFT JOIN LATERAL (
       SELECT name, plan_id FROM businesses WHERE owner_id = u.id ORDER BY created_at LIMIT 1
     ) biz ON TRUE
     LEFT JOIN referral_bonuses rb ON rb.referred_user_id = u.id
     WHERE u.referred_by = $1
     ORDER BY u.created_at DESC`,
    [userId],
  );

  const referred: ReferredUserRow[] = rows.rows.map((r: any) => {
    const hasBonus = r.bonusAmount != null;
    const hasSub = Number(r.subscriptionCount || 0) > 0;
    const status: ReferredUserRow["status"] = hasBonus ? "paid" : hasSub ? "subscribed" : "pending";
    return {
      id: r.id,
      name: r.name ?? null,
      email: r.email,
      joinedAt: r.joinedAt,
      businessName: r.businessName ?? null,
      planId: r.planId ?? null,
      subscriptionCount: Number(r.subscriptionCount || 0),
      bonusAmount: r.bonusAmount != null ? Number(r.bonusAmount) : null,
      bonusCurrency: r.bonusCurrency ?? null,
      bonusStatus: r.bonusStatus ?? null,
      bonusPaidAt: r.bonusPaidAt ?? null,
      status,
    };
  });

  const totalEarned = referred.reduce((sum, r) => sum + (r.bonusAmount || 0), 0);
  const stats: ReferralStats = {
    totalReferred: referred.length,
    subscribed: referred.filter((r) => r.status !== "pending").length,
    totalEarned,
    earnedCurrency: config.currency,
  };

  return { referralCode, config, stats, referred };
}
