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
 *   2. If the caller has no personal PIN yet, the legacy shared business hash
 *      still verifies so PINs created before the per-user rollout keep working.
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

  if (businessId) {
    const bizRes = await query(
      `SELECT transaction_pin_hash FROM businesses WHERE id = $1`,
      [businessId],
    );
    const bizHash: string | null = bizRes.rows[0]?.transaction_pin_hash || null;
    if (bizHash) return { pinHash: bizHash, source: "business" };
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
