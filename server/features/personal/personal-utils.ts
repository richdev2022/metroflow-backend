import { Response, NextFunction } from "express";
import { query } from "../../db";
import { AuthenticatedRequest } from "../../middleware/auth";
import { verifyPassword } from "../../services/auth";
import { verifyTransactionPin as verifyPerUserPin } from "../../lib/transaction-pin";

/**
 * PERSONAL APP — shared helpers.
 *
 * The Personal app runs OUTSIDE the business context: users have
 * business_id = NULL, so every business-scoped gate (checkKycStatus,
 * businesses.transaction_pin_hash, wallet lookups keyed on business_id)
 * needs a personal-aware counterpart here.
 */

export interface PersonalWalletRow {
  id: string;
  user_id: string | null;
  business_id: string | null;
  balance: string;
  currency: string;
  status: string;
  virtual_account_number?: string | null;
  bank_code?: string | null;
  account_name?: string | null;
}

/** Personal KYC gate — BVN or NIN verified, NO businessId required. */
export function requirePersonalKyc() {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });
      const r = await query(`SELECT bvn_status, nin_status FROM users WHERE id = $1`, [userId]);
      const u = r.rows[0];
      if (!u || (u.bvn_status !== "verified" && u.nin_status !== "verified")) {
        return res.status(403).json({
          success: false,
          code: "KYC_REQUIRED",
          error: "KYC verification is required to access this feature. Please complete your KYC verification.",
        });
      }
      next();
    } catch (e: any) {
      console.error("requirePersonalKyc error:", e?.message);
      res.status(500).json({ success: false, error: "Failed to verify KYC status" });
    }
  };
}

/**
 * Inline KYC probe for endpoints where only a BRANCH of the handler moves
 * money (e.g. paid poll votes — free votes stay open to everyone). Use the
 * requirePersonalKyc() middleware when the WHOLE endpoint needs KYC.
 */
export async function isPersonalKycVerified(userId: string): Promise<boolean> {
  try {
    const r = await query(`SELECT bvn_status, nin_status FROM users WHERE id = $1`, [userId]);
    const u = r.rows[0];
    return !!u && (u.bvn_status === "verified" || u.nin_status === "verified");
  } catch {
    return false;
  }
}

/**
 * Verify the transaction PIN — PER-USER (see lib/transaction-pin.ts): the
 * caller's own users.transaction_pin_hash is tried first; the legacy shared
 * business hash still verifies for pre-rollout PINs. Kept under the original
 * name because every personal route imports it from here.
 */
export async function verifyTransactionPin(
  pin: string | undefined,
  opts: { userId: string; businessId?: string | null; wallet?: PersonalWalletRow | null }
): Promise<{ ok: boolean; code?: string; error?: string }> {
  return verifyPerUserPin(pin, { userId: opts.userId, businessId: opts.businessId ?? null });
}

/**
 * Resolve an owned wallet for the caller. A wallet belongs to the caller when
 * user_id = caller (personal) OR business_id = caller's business. The wallet
 * row decides personal vs business semantics everywhere downstream.
 */
export async function getOwnedWallet(walletId: string, userId: string, businessId?: string | null): Promise<PersonalWalletRow | null> {
  const r = await query(
    `SELECT id, user_id, business_id, balance, currency, status
     FROM wallets WHERE id = $1 AND (user_id = $2 OR ($3::varchar IS NOT NULL AND business_id = $3))`,
    [walletId, userId, businessId ?? null]
  );
  return r.rows[0] ?? null;
}

/** Atomic guarded debit. Returns false when balance/status check fails. */
export async function debitWallet(walletId: string, amount: number): Promise<boolean> {
  const r = await query(
    `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND balance >= $1 AND status = 'active' RETURNING id`,
    [amount, walletId]
  );
  return r.rows.length > 0;
}

/** Atomic credit. Never guarded on balance. */
export async function creditWallet(walletId: string, amount: number): Promise<void> {
  await query(
    `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [amount, walletId]
  );
}

// ---------------------------------------------------------------------------
// CASHBACK BALANCE — a dedicated spendable balance on the wallet row.
// Airtime/data cashback accrues here (NOT the main balance); bill payments
// can draw it down with `use_cashback` before touching the main balance.
// ---------------------------------------------------------------------------
let cashbackColumnReady = false;

export async function ensureCashbackColumn(): Promise<void> {
  if (cashbackColumnReady) return;
  await query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS cashback_balance DECIMAL(15,2) NOT NULL DEFAULT 0`);
  cashbackColumnReady = true;
}

/** Add to the wallet's cashback balance. */
export async function creditCashbackBalance(walletId: string, amount: number): Promise<void> {
  if (!(amount > 0)) return;
  await ensureCashbackColumn();
  await query(
    `UPDATE wallets SET cashback_balance = COALESCE(cashback_balance, 0) + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [amount, walletId],
  );
}

/** Guarded debit of the cashback balance — returns the amount actually taken. */
export async function debitCashbackBalance(walletId: string, amount: number): Promise<number> {
  if (!(amount > 0)) return 0;
  await ensureCashbackColumn();
  // Atomic: the CTE snapshots the pre-update balance under the row lock the
  // UPDATE takes, so RETURNING reports the exact applied delta even under
  // concurrent spends.
  const r = await query(
    `WITH prev AS (
       SELECT COALESCE(cashback_balance, 0) AS bal FROM wallets WHERE id = $2 FOR UPDATE
     )
     UPDATE wallets w
        SET cashback_balance = GREATEST(COALESCE(w.cashback_balance, 0) - $1, 0),
            updated_at = CURRENT_TIMESTAMP
       FROM prev
      WHERE w.id = $2 AND prev.bal > 0
      RETURNING LEAST($1, prev.bal) AS taken`,
    [amount, walletId],
  );
  return Math.max(0, Number(r.rows[0]?.taken || 0));
}

/** Current cashback balance of a wallet (0 when the column is missing). */
export async function getCashbackBalance(walletId: string): Promise<number> {
  await ensureCashbackColumn();
  const r = await query(`SELECT COALESCE(cashback_balance, 0) AS cb FROM wallets WHERE id = $1`, [walletId]);
  return Number(r.rows[0]?.cb || 0);
}

/**
 * Ledger row. transaction_type is feature-specific (bill, boost, market_order,
 * giftcard_sell, giftcard_buy, crypto_sale, vcard_fund, ...).
 */
export async function insertTransaction(opts: {
  userId?: string | null;
  businessId?: string | null;
  walletId?: string | null;
  reference: string;
  type: "credit" | "debit";
  transactionType: string;
  amount: number;
  currency?: string;
  fee?: number;
  status?: string;
  description?: string;
  paymentProvider?: string;
}) {
  await query(
    `INSERT INTO transactions
       (business_id, user_id, amount, currency, status, reference, type, description,
        transaction_type, wallet_id, direction, fee, payment_provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      opts.businessId ?? null,
      opts.userId ?? null,
      opts.amount,
      opts.currency ?? "NGN",
      opts.status ?? "success",
      opts.reference,
      opts.type,
      opts.description ?? null,
      opts.transactionType,
      opts.walletId ?? null,
      opts.type, // direction mirrors type for personal rows
      opts.fee ?? 0,
      opts.paymentProvider ?? null,
    ]
  );
}

/** Personal service flags from system_settings (admin kill-switches). */
export async function getPersonalServiceFlags(): Promise<Record<string, boolean>> {
  try {
    const r = await query(
      `SELECT value FROM system_settings WHERE key = 'personal_service_flags' LIMIT 1`
    );
    if (r.rows[0]?.value) return JSON.parse(r.rows[0].value);
  } catch { /* fall through to defaults */ }
  return { bills: true, savings: true, giftcards: true, esim: true, virtualcards: true, crypto: true, social: true, live: true, marketplace: true, swap: true, donations: true };
}

export async function assertPersonalService(res: Response, flag: string): Promise<boolean> {
  const flags = await getPersonalServiceFlags();
  if (flags[flag] === false) {
    res.status(403).json({ success: false, code: "SERVICE_DISABLED", error: "This service is temporarily unavailable." });
    return false;
  }
  return true;
}

export const genRef = (prefix: string) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
