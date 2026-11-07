import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import { insertTransaction, creditWallet } from "../personal-utils";

/**
 * ROUND-UP AUTO-SAVE — spare-change saving into goal vaults (mounted at
 * /roundup, personal users only).
 *
 * Every personal NGN spend (bills, transfers, marketplace, gift cards) calls
 * the exported `maybeApplyRoundUp` hook after its debit-completion site. The
 * helper rounds the spend up to the user's chosen step (₦100/₦200/₦500),
 * multiplies the change (1x/2x/3x) and moves it from the user's personal NGN
 * wallet into their chosen savings vault.
 *
 * HARD RULE: round-up must NEVER break a payment. The helper never throws —
 * every failure path logs and returns. Idempotency: one roundup_ledger row
 * per (user_id, source_reference) claimed with ON CONFLICT DO NOTHING BEFORE
 * any money moves, so webhook replays / handler retries can never double-save.
 *
 * Endpoints:
 *   GET /roundup/settings                    → { success, settings }
 *   PUT /roundup/settings                    → { success, settings }
 *   GET /roundup/summary                     → { success, month_total, all_time_total, streak_weeks, recent }
 *   GET /roundup/ledger?limit=&offset=       → { success, rows, total }
 */

const router = express.Router();

const ROUND_TO_STEPS = [100, 200, 500];
const MULTIPLIERS = [1, 2, 3];

function num(v: any): number { return Number(v) || 0; }
function money(v: number): number { return Math.round(v * 100) / 100; }

// ---------------------------------------------------------------------------
// Shared hook — called by bills / transfers / marketplace / giftcards after
// each successful personal NGN spend.
// ---------------------------------------------------------------------------

export interface RoundUpInput {
  userId: string;
  /** The NGN spend amount the round-up is computed from. */
  amount: number;
  sourceType: string; // bill | airtime | data | transfer | marketplace | giftcard
  sourceReference: string; // the flow's unique reference — idempotency key
}

export interface RoundUpResult {
  applied: boolean;
  roundUp: number;
  reason?: string;
}

/**
 * Apply (or silently skip) a round-up for a completed personal NGN spend.
 * NEVER throws. Safe to `await` inline in any payment completion site.
 */
export async function maybeApplyRoundUp(opts: RoundUpInput): Promise<RoundUpResult> {
  const result: RoundUpResult = { applied: false, roundUp: 0 };
  try {
    const userId = String(opts.userId || "");
    const sourceReference = String(opts.sourceReference || "").slice(0, 255);
    const amount = money(num(opts.amount));
    if (!userId || !sourceReference || !(amount > 0)) {
      result.reason = "missing-inputs";
      return result;
    }

    // 1. Settings — disabled / absent → silent no-op.
    const s = await query(
      `SELECT enabled, multiplier, round_to, vault_id FROM roundup_settings WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    const settings = s.rows[0];
    if (!settings || settings.enabled !== true) {
      result.reason = "not-enabled";
      return result;
    }

    // 2. Vault — must exist, be owned by the user, active and NGN.
    const v = await query(
      `SELECT id, name, currency, status FROM savings_vaults WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [settings.vault_id, userId],
    );
    const vault = v.rows[0];
    if (!vault || vault.status !== "active" || String(vault.currency || "NGN").toUpperCase() !== "NGN") {
      result.reason = "vault-unavailable";
      return result;
    }

    // 3. Spare change: distance to the next step, times the multiplier.
    const roundTo = Math.max(1, Math.round(num(settings.round_to) || 100));
    const multiplier = Math.min(3, Math.max(1, Math.round(num(settings.multiplier) || 1)));
    const change = Math.round((roundTo - (amount % roundTo)) % roundTo);
    const roundUp = money(change * multiplier);
    if (!(roundUp > 0)) {
      result.reason = "no-change";
      return result;
    }

    // 4. Idempotent claim BEFORE any money moves — a repeat call for the same
    //    source reference (webhook replay, handler retry) lands here and stops.
    const claim = await query(
      `INSERT INTO roundup_ledger (user_id, vault_id, source_type, source_reference, source_amount, round_up, currency)
       VALUES ($1,$2,$3,$4,$5,$6,'NGN')
       ON CONFLICT (user_id, source_reference) DO NOTHING
       RETURNING id`,
      [userId, vault.id, String(opts.sourceType || "spend").slice(0, 40), sourceReference, amount, roundUp],
    );
    if (!claim.rows.length) {
      result.reason = "already-applied";
      return result;
    }
    const ledgerId = claim.rows[0].id;

    // 5. Balance-guarded wallet debit from the user's personal NGN wallet.
    //    Underfunded → skip silently (round-up is a nicety, not a bill).
    const w = await query(
      `SELECT id FROM wallets
        WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`,
      [userId],
    );
    const wallet = w.rows[0];
    let debited = false;
    if (wallet) {
      const d = await query(
        `UPDATE wallets SET balance = balance - $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND balance >= $2 AND status = 'active' RETURNING id`,
        [wallet.id, roundUp],
      );
      debited = d.rows.length > 0;
    }
    if (!wallet || !debited) {
      // Release the claim so a genuine retry of this reference can still apply.
      await query(`DELETE FROM roundup_ledger WHERE id = $1`, [ledgerId]).catch(() => {});
      result.reason = wallet ? "insufficient-balance" : "no-ngn-wallet";
      return result;
    }

    // 6. Vault credit + ledger rows. Any failure → full compensation (refund
    //    wallet, reverse vault, clean rows) and return quietly.
    try {
      const vu = await query(
        `UPDATE savings_vaults
            SET balance = balance + $2, total_deposited = total_deposited + $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 RETURNING balance`,
        [vault.id, roundUp],
      );
      const balanceAfter = num(vu.rows[0]?.balance);

      // Vault-facing ledger row — reference UNIQUE makes the write itself
      // idempotent even if the claim above were somehow bypassed.
      await query(
        `INSERT INTO savings_transactions (vault_id, type, amount, fee, balance_after, wallet_id, reference, note)
         VALUES ($1, 'roundup', $2, 0, $3, $4, $5, $6)`,
        [vault.id, roundUp, balanceAfter, wallet.id, `RUP-${sourceReference}`.slice(0, 255), `Round-up from ${String(opts.sourceType).slice(0, 40)}`],
      );

      // Wallet-facing platform transaction row.
      await insertTransaction({
        userId,
        walletId: wallet.id,
        reference: `RUP-W-${sourceReference}`.slice(0, 255),
        type: "debit",
        transactionType: "roundup",
        amount: roundUp,
        currency: "NGN",
        description: `Round-up auto-save → ${String(vault.name).slice(0, 80)}`,
      });

      result.applied = true;
      result.roundUp = roundUp;
      return result;
    } catch (finErr: any) {
      console.error(`[roundup] apply failed for ${sourceReference} — compensating:`, finErr?.message);
      // Refund the wallet (atomic credit — never guarded).
      await creditWallet(wallet.id, roundUp).catch((e: any) =>
        console.error(`[roundup] CRITICAL: wallet refund failed for ${sourceReference}:`, e?.message));
      // Reverse the vault credit + any committed ledger rows.
      await query(
        `UPDATE savings_vaults
            SET balance = GREATEST(0, balance - $2), total_deposited = GREATEST(0, total_deposited - $2), updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [vault.id, roundUp],
      ).catch(() => {});
      await query(
        `DELETE FROM savings_transactions WHERE vault_id = $1 AND reference = $2`,
        [vault.id, `RUP-${sourceReference}`.slice(0, 255)],
      ).catch(() => {});
      await query(`DELETE FROM transactions WHERE reference = $1`, [`RUP-W-${sourceReference}`.slice(0, 255)]).catch(() => {});
      await query(`DELETE FROM roundup_ledger WHERE id = $1`, [ledgerId]).catch(() => {});
      return result;
    }
  } catch (e: any) {
    // NEVER throw into the caller — round-up must never break a payment.
    console.error(`[roundup] hook error (${opts.sourceType} ${opts.sourceReference}):`, e?.message);
    result.reason = "error";
    return result;
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeVault(v: any) {
  if (!v) return null;
  return {
    id: v.id,
    name: v.name,
    goal_amount: num(v.goal_amount),
    balance: num(v.balance),
    currency: v.currency || "NGN",
  };
}

async function buildSettingsPayload(userId: string) {
  const s = await query(`SELECT * FROM roundup_settings WHERE user_id = $1 LIMIT 1`, [userId]);
  const row = s.rows[0];
  let vault = null;
  if (row?.vault_id) {
    const v = await query(
      `SELECT id, name, goal_amount, balance, currency FROM savings_vaults WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [row.vault_id, userId],
    );
    vault = serializeVault(v.rows[0]);
  }
  return {
    enabled: row ? row.enabled === true : false,
    multiplier: row ? Math.min(3, Math.max(1, Math.round(num(row.multiplier) || 1))) : 1,
    round_to: row ? Math.round(num(row.round_to) || 100) : 100,
    vault_id: vault ? vault.id : null,
    vault,
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

router.get("/settings", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const settings = await buildSettingsPayload(req.user!.userId);
    res.json({ success: true, settings });
  } catch (e: any) {
    console.error("[roundup/settings]", e?.message);
    res.status(500).json({ success: false, error: "Could not load round-up settings" });
  }
});

router.put("/settings", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const enabled = req.body?.enabled === true || req.body?.enabled === "true";
    const multiplier = Math.round(Number(req.body?.multiplier));
    const roundTo = Math.round(Number(req.body?.round_to));

    if (!MULTIPLIERS.includes(multiplier)) {
      return res.status(400).json({ success: false, error: "multiplier must be 1, 2 or 3" });
    }
    if (!ROUND_TO_STEPS.includes(roundTo)) {
      return res.status(400).json({ success: false, error: "round_to must be 100, 200 or 500" });
    }

    let vaultId = req.body?.vault_id ? String(req.body.vault_id).trim() : null;
    if (enabled) {
      if (!vaultId) {
        // AUTO-PICK: both the web toggle and the mobile quick-enable switch
        // flip ON before a destination vault is chosen (the vault picker only
        // renders once enabled) — rejecting with "vault_id is required" here
        // deadlocked the feature (found in production 2026-11-07). Instead,
        // resolve to the user's first active NGN vault; only ask them to
        // create one when they genuinely have none.
        const auto = await query(
          `SELECT id FROM savings_vaults
            WHERE user_id = $1 AND status = 'active' AND UPPER(currency) = 'NGN'
            ORDER BY created_at ASC LIMIT 1`,
          [userId],
        );
        if (!auto.rows.length) {
          return res.status(400).json({
            success: false,
            code: "NO_VAULT",
            error: "Create a savings vault first — round-up needs somewhere to save the spare change",
          });
        }
        vaultId = String(auto.rows[0].id);
      }
      const v = await query(
        `SELECT id, currency, status FROM savings_vaults WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [vaultId, userId],
      );
      if (!v.rows.length) {
        return res.status(400).json({ success: false, code: "VAULT_NOT_FOUND", error: "Vault not found — choose one of your own vaults" });
      }
      if (v.rows[0].status !== "active") {
        return res.status(400).json({ success: false, code: "VAULT_NOT_ACTIVE", error: "This vault is not active" });
      }
      if (String(v.rows[0].currency || "NGN").toUpperCase() !== "NGN") {
        return res.status(400).json({ success: false, code: "VAULT_NOT_NGN", error: "Round-up saves in Naira — choose an NGN vault" });
      }
    }

    await query(
      `INSERT INTO roundup_settings (user_id, enabled, multiplier, round_to, vault_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET
         enabled = $2,
         multiplier = $3,
         round_to = $4,
         vault_id = COALESCE($5, roundup_settings.vault_id),
         updated_at = CURRENT_TIMESTAMP`,
      [userId, enabled, multiplier, roundTo, vaultId],
    );

    const settings = await buildSettingsPayload(userId);
    res.json({ success: true, settings });
  } catch (e: any) {
    console.error("[roundup/settings PUT]", e?.message);
    res.status(500).json({ success: false, error: "Could not save round-up settings" });
  }
});

router.get("/summary", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;

    const agg = await query(
      `SELECT
         COALESCE(SUM(round_up) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE)), 0)::float AS month_total,
         COALESCE(SUM(round_up), 0)::float AS all_time_total
       FROM roundup_ledger WHERE user_id = $1`,
      [userId],
    );

    // Streak: consecutive calendar weeks (Monday-based — matching
    // date_trunc('week')) with at least one round-up, ending this week.
    // Weeks come back as TEXT dates and "today" comes from the DB clock —
    // comparing plain YYYY-MM-DD strings keeps this timezone-safe.
    const weeks = await query(
      `SELECT DISTINCT date_trunc('week', created_at)::date::text AS week_start
         FROM roundup_ledger WHERE user_id = $1
        ORDER BY week_start DESC LIMIT 60`,
      [userId],
    );
    const todayRow = await query(`SELECT CURRENT_DATE::text AS today`);
    const weekSet = new Set<string>(weeks.rows.map((r: any) => String(r.week_start)));
    const [ty, tm, td] = String(todayRow.rows[0]?.today || "").split("-").map(Number);
    const mondayOffset = (new Date(Date.UTC(ty, tm - 1, td)).getUTCDay() + 6) % 7; // Monday = 0
    const cursor = new Date(Date.UTC(ty, tm - 1, td - mondayOffset));
    let streakWeeks = 0;
    while (weekSet.has(cursor.toISOString().slice(0, 10))) {
      streakWeeks++;
      cursor.setUTCDate(cursor.getUTCDate() - 7);
    }

    const recent = await query(
      `SELECT id, source_type, source_reference, source_amount, round_up, currency, created_at
         FROM roundup_ledger WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 30`,
      [userId],
    );

    res.json({
      success: true,
      month_total: num(agg.rows[0]?.month_total),
      all_time_total: num(agg.rows[0]?.all_time_total),
      streak_weeks: streakWeeks,
      recent: recent.rows.map((r: any) => ({
        ...r,
        source_amount: num(r.source_amount),
        round_up: num(r.round_up),
      })),
    });
  } catch (e: any) {
    console.error("[roundup/summary]", e?.message);
    res.status(500).json({ success: false, error: "Could not load round-up summary" });
  }
});

router.get("/ledger", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const rows = await query(
      `SELECT id, vault_id, source_type, source_reference, source_amount, round_up, currency, created_at
         FROM roundup_ledger WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      [userId],
    );
    const total = await query(`SELECT COUNT(*)::int AS n FROM roundup_ledger WHERE user_id = $1`, [userId]);

    res.json({
      success: true,
      rows: rows.rows.map((r: any) => ({ ...r, source_amount: num(r.source_amount), round_up: num(r.round_up) })),
      total: total.rows[0]?.n || 0,
    });
  } catch (e: any) {
    console.error("[roundup/ledger]", e?.message);
    res.status(500).json({ success: false, error: "Could not load round-up ledger" });
  }
});

export default router;
