import { query } from "../db";
import { verifyPassword } from "../services/auth";

/**
 * PER-USER TRANSACTION PIN (identity model fix)
 * ---------------------------------------------
 * Historically the transaction PIN lived on the BUSINESS row
 * (businesses.transaction_pin_hash) and was shared by every member of the
 * business — so any invited admin could change (and use) the owner's PIN.
 *
 * From now on every user owns their own PIN on users.transaction_pin_hash:
 *   1. The CALLING user's own hash is always tried first.
 *   2. The legacy shared business hash verifies ONLY for the business OWNER —
 *      it historically held the owner's own PIN, so the owner keeps working
 *      seamlessly. INVITED MEMBERS NEVER FALL BACK TO IT: an invited member
 *      without a personal PIN gets PIN_NOT_SET and is prompted to create
 *      their own, so every user's Transaction PIN stays fully separate.
 *   3. When the business OWNER sets/updates their PIN, the shared business
 *      hash is re-seeded in the settings routes, keeping legacy clients and
 *      legacy verify paths consistent.
 */

export interface PinVerifyResult {
  ok: boolean;
  source?: "user" | "business";
  code?: "PIN_REQUIRED" | "PIN_NOT_SET" | "INVALID_PIN";
  error?: string;
}

export async function resolveTransactionPinHash(
  userId: string,
  businessId?: string | null,
): Promise<{ pinHash: string | null; source: "user" | "business" | "none" }> {
  const userRes = await query(
    `SELECT transaction_pin_hash FROM users WHERE id = $1`,
    [userId],
  );
  const userHash: string | null = userRes.rows[0]?.transaction_pin_hash || null;
  if (userHash) return { pinHash: userHash, source: "user" };

  // Legacy shared business hash: ONLY the business owner may fall back to it
  // (it historically stored the owner's own PIN). Invited members must verify
  // with their OWN pin — if they have none the caller returns PIN_NOT_SET so
  // the UI can prompt them to create one. This keeps every user's Transaction
  // PIN fully separate.
  if (businessId) {
    const ownerRes = await query(
      `SELECT b.transaction_pin_hash AS biz_hash, b.owner_id, u.role
       FROM businesses b LEFT JOIN users u ON u.id = $1
       WHERE b.id = $2`,
      [userId, businessId],
    );
    const row = ownerRes.rows[0];
    const isOwner =
      !!row &&
      (row.owner_id === userId ||
        String(row.role || "").toLowerCase() === "owner");
    if (isOwner && row.biz_hash) {
      return { pinHash: row.biz_hash, source: "business" };
    }
  }

  return { pinHash: null, source: "none" };
}

export async function verifyTransactionPin(
  pin: string | undefined | null,
  opts: { userId: string; businessId?: string | null },
): Promise<PinVerifyResult> {
  if (!pin) {
    return { ok: false, code: "PIN_REQUIRED", error: "Transaction PIN is required" };
  }
  const { pinHash, source } = await resolveTransactionPinHash(opts.userId, opts.businessId);
  if (!pinHash) {
    return {
      ok: false,
      code: "PIN_NOT_SET",
      error: "Transaction PIN not set. Please create one first.",
    };
  }
  const ok = await verifyPassword(String(pin), pinHash);
  if (!ok) {
    return { ok: false, code: "INVALID_PIN", error: "Incorrect transaction PIN" };
  }
  return { ok: true, source: source as "user" | "business" };
}

/**
 * OWNER RESOLUTION — a caller "owns" their business when the businesses row
 * points at them (owner_id) or their role says owner. Invited admins do NOT
 * pass this check even when their role is 'admin'.
 */
export async function isBusinessOwner(
  userId: string,
): Promise<{ isOwner: boolean; isPersonalSpace: boolean; businessId: string | null }> {
  const res = await query(
    `SELECT u.id, u.role, u.business_id, b.owner_id, COALESCE(b.industry, '') AS industry
     FROM users u LEFT JOIN businesses b ON b.id = u.business_id
     WHERE u.id = $1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) return { isOwner: false, isPersonalSpace: false, businessId: null };
  const isOwner =
    row.owner_id === row.id || String(row.role || "").toLowerCase() === "owner";
  const isPersonalSpace = String(row.industry).toLowerCase() === "personal";
  return { isOwner, isPersonalSpace, businessId: row.business_id || null };
}
