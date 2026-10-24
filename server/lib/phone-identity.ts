import { query } from "../db";

/**
 * IDENTITY-AWARE CONTACT AVAILABILITY
 * -----------------------------------
 * "This phone number is already in use by another account" must never fire
 * for a user claiming their OWN number back. The rule: a phone number is in
 * use only by a DIFFERENT human identity.
 *
 * Ignored when checking availability:
 *   - the caller's own user row;
 *   - other user rows sharing the caller's email (the same human across the
 *     Personal and Business apps — phone/PIN/email stay identical per the
 *     cross-app identity rule);
 *   - abandoned sign-ups (email_verified = FALSE and phone_verified = FALSE)
 *     so an unverified registration can never squat a number;
 *   - businesses OWNED by the caller (owner_id match, or the business's own
 *     contact email equals the caller's email, or the caller has a user row
 *     inside that business) — those are RELEASED automatically so the caller
 *     can move their number between their own spaces, exactly like moving a
 *     sim card between your own phones.
 */

export interface PhoneAvailability {
  ok: boolean;
  releasedBusinessIds?: string[];
  code?: "PHONE_ALREADY_EXISTS";
  error?: string;
  heldBy?: "user" | "business";
}

export async function claimPhoneForCaller(
  phone: string,
  caller: { userId: string; email: string },
): Promise<PhoneAvailability> {
  const normalizedEmail = String(caller.email || "").toLowerCase();

  // 1) USER ROW conflicts — ignore: caller's own row, same-email rows
  //    (same human), and fully-unverified rows (abandoned sign-ups).
  const userConflict = await query(
    `SELECT id FROM users
     WHERE phone_number = $1
       AND id <> $2
       AND LOWER(email) <> $3
       AND NOT (COALESCE(email_verified, FALSE) = FALSE AND COALESCE(phone_verified, FALSE) = FALSE)
     LIMIT 1`,
    [phone, caller.userId, normalizedEmail],
  );
  if (userConflict.rows.length > 0) {
    return {
      ok: false,
      code: "PHONE_ALREADY_EXISTS",
      error: "This phone number is already in use by another account. Please use a different number.",
      heldBy: "user",
    };
  }

  // 2) BUSINESS rows — caller-owned ones are released, foreign ones block.
  const bizConflicts = await query(
    `SELECT b.id,
            (b.owner_id = $2
             OR LOWER(b.email) = $3
             OR EXISTS (SELECT 1 FROM users u
                        WHERE u.business_id = b.id AND LOWER(u.email) = $3)
            ) AS owned_by_caller
     FROM businesses b
     WHERE b.phone_number = $1`,
    [phone, caller.userId, normalizedEmail],
  );

  if (bizConflicts.rows.length === 0) return { ok: true, releasedBusinessIds: [] };

  const foreign = bizConflicts.rows.filter((r: any) => !r.owned_by_caller);
  if (foreign.length > 0) {
    return {
      ok: false,
      code: "PHONE_ALREADY_EXISTS",
      error: "This phone number is already in use by another business. Please use a different number.",
      heldBy: "business",
    };
  }

  // All conflicts belong to the caller — free them (the number moves).
  const ids: string[] = bizConflicts.rows.map((r: any) => r.id);
  await query(
    `UPDATE businesses SET phone_number = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1::text[])`,
    [ids],
  );
  return { ok: true, releasedBusinessIds: ids };
}

/**
 * Registration-time phone check (no caller identity yet): only VERIFIED
 * accounts hold a number. Unverified rows (email never confirmed) do not
 * squat it.
 */
export async function isPhoneHeldByVerifiedAccount(phone: string): Promise<boolean> {
  const res = await query(
    `SELECT id FROM users
     WHERE phone_number = $1
       AND (COALESCE(email_verified, FALSE) = TRUE OR COALESCE(phone_verified, FALSE) = TRUE)
     LIMIT 1`,
    [phone],
  );
  return res.rows.length > 0;
}
