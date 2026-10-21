import { Response, NextFunction } from "express";
import { query } from "../../db";
import { AuthenticatedRequest } from "../../middleware/auth";
import { verifyPassword } from "../../services/auth";

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
 * Verify the transaction PIN. Personal users: users.transaction_pin_hash.
 * Business users: businesses.transaction_pin_hash. The wallet row decides
 * which side the caller is on (wallet.user_id / wallet.business_id).
 */
export async function verifyTransactionPin(
  pin: string | undefined,
  opts: { userId: string; businessId?: string | null; wallet?: PersonalWalletRow | null }
): Promise<{ ok: boolean; code?: string; error?: string }> {
  if (!pin) return { ok: false, code: "PIN_REQUIRED", error: "Transaction PIN is required" };
  const isBusinessWallet = !!opts.wallet?.business_id && opts.wallet.business_id !== opts.userId;
  if (isBusinessWallet && opts.businessId) {
    const r = await query(`SELECT transaction_pin_hash FROM businesses WHERE id = $1`, [opts.businessId]);
    const hash = r.rows[0]?.transaction_pin_hash;
    if (!hash) return { ok: false, code: "PIN_NOT_SET", error: "Transaction PIN not set. Please create one first." };
    const ok = await verifyPassword(pin, hash);
    return ok ? { ok: true } : { ok: false, code: "INVALID_PIN", error: "Incorrect transaction PIN" };
  }
  const r = await query(`SELECT transaction_pin_hash FROM users WHERE id = $1`, [opts.userId]);
  const hash = r.rows[0]?.transaction_pin_hash;
  if (!hash) return { ok: false, code: "PIN_NOT_SET", error: "Transaction PIN not set. Please create one in Settings → Security." };
  const ok = await verifyPassword(pin, hash);
  return ok ? { ok: true } : { ok: false, code: "INVALID_PIN", error: "Incorrect transaction PIN" };
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
  return { bills: true, savings: true, giftcards: true, esim: true, virtualcards: true, crypto: true, social: true, live: true, marketplace: true, swap: true };
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
