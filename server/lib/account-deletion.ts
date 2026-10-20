import crypto from "crypto";
import { query } from "../db";
import { sendEmail } from "../services/email";

/**
 * Account deletion requests — GDPR/CCPA-style erasure flow.
 *
 * STANDARD PROCESS (why each step exists):
 *  1. REQUEST  — anyone can submit an email on the public site. We do NOT
 *     reveal whether the address has an account (anti-enumeration): the
 *     response is always generic and the confirmation email is only sent to
 *     real addresses.
 *  2. CONFIRM  — the request only becomes actionable after the mailbox owner
 *     clicks the emailed confirmation link (24h token, stored HASHED so a DB
 *     leak cannot be used to confirm requests). This prevents weaponized
 *     deletion of someone else's account.
 *  3. REVIEW   — confirmed requests land in the admin queue. Deletion is
 *     executed by an ADMIN (never automatic), with full audit fields.
 *  4. EXECUTE  — "delete" means standard account erasure:
 *       - PII is anonymized in place (email/name/avatar/oauth ids/password),
 *         the user is locked out (status='deleted') and cannot log in again;
 *       - sessions + push devices are revoked so live tokens go dead;
 *       - financial/ledger records are RETAINED (legal/tax retention) — the
 *         anonymized user id keeps referential integrity without PII;
 *       - the final confirmation email is sent BEFORE the address is scrubbed.
 *     A business owner with active teammates is refused until ownership is
 *     reassigned (admin handles that in Businesses first).
 */

export type DeletionStatus =
  | "pending"
  | "confirmed"
  | "completed"
  | "rejected"
  | "cancelled";

const CONFIRM_TOKEN_TTL_HOURS = 24;
const SITE_URL = process.env.APP_BASE_URL || "https://metricorex.com";
const SUPPORT_EMAIL =
  process.env.SUPPORT_EMAIL || "support@metricorex.com";

const sha256 = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

/** In-memory rate limit for the public endpoints (per IP). */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
export function isRateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

// ---------------------------------------------------------------------------
// Public flow
// ---------------------------------------------------------------------------

export async function createDeletionRequest(
  rawEmail: string,
  reason: string | null,
  ip: string | null,
): Promise<{ ok: boolean; duplicate?: boolean }> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false };
  }

  // One active request per address — never stack duplicates.
  const active = await query(
    `SELECT id FROM account_delete_requests
      WHERE email = $1 AND status IN ('pending','confirmed') LIMIT 1`,
    [email],
  );
  if (active.rows.length > 0) return { ok: true, duplicate: true };

  const token = crypto.randomBytes(32).toString("hex");
  await query(
    `INSERT INTO account_delete_requests
       (email, reason, token_hash, status, requested_ip, confirm_expires_at)
     VALUES ($1, $2, $3, 'pending', $4, NOW() + INTERVAL '${CONFIRM_TOKEN_TTL_HOURS} hours')`,
    [email, reason ? reason.slice(0, 2000) : null, sha256(token), ip],
  );

  // Only a real mailbox receives this — an unknown address silently no-ops.
  await sendEmail(
    email,
    email.split("@")[0],
    "Confirm your Metricorex account deletion request",
    buildConfirmEmailHtml(token),
  ).catch((err) =>
    console.error("[account-deletion] confirm email failed:", err?.message || err),
  );

  return { ok: true };
}

export async function confirmDeletionRequest(
  rawToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = (rawToken || "").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return { ok: false, error: "invalid_token" };

  const res = await query(
    `SELECT id, status, confirm_expires_at FROM account_delete_requests
      WHERE token_hash = $1 LIMIT 1`,
    [sha256(token)],
  );
  if (res.rows.length === 0) return { ok: false, error: "invalid_token" };

  const row = res.rows[0] as {
    id: string;
    status: DeletionStatus;
    confirm_expires_at: string | null;
  };
  if (row.status !== "pending") {
    return { ok: false, error: `already_${row.status}` };
  }
  if (row.confirm_expires_at && new Date(row.confirm_expires_at).getTime() < Date.now()) {
    return { ok: false, error: "expired" };
  }

  await query(
    `UPDATE account_delete_requests
        SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [row.id],
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin flow
// ---------------------------------------------------------------------------

export async function rejectDeletionRequest(
  requestId: string,
  adminId: string,
  note: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const res = await query(
    `UPDATE account_delete_requests
        SET status = 'rejected', note = $2, processed_by = $3,
            processed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status IN ('pending','confirmed')
      RETURNING email`,
    [requestId, note ? note.slice(0, 2000) : null, adminId],
  );
  if (res.rows.length === 0) return { ok: false, error: "not_found" };

  const email = (res.rows[0] as { email: string }).email;
  await sendEmail(
    email,
    email.split("@")[0],
    "Your Metricorex account deletion request",
    buildRejectedEmailHtml(note),
  ).catch(() => {});
  return { ok: true };
}

export interface DeletionResult {
  ok: boolean;
  error?: string;
  message?: string;
  summary?: Record<string, unknown>;
}

export async function executeAccountDeletion(
  requestId: string,
  adminId: string,
): Promise<DeletionResult> {
  // 1. Load the request — must be confirmed (email verified) and open.
  const reqRes = await query(
    `SELECT id, email, status FROM account_delete_requests WHERE id = $1`,
    [requestId],
  );
  if (reqRes.rows.length === 0) return { ok: false, error: "not_found" };
  const request = reqRes.rows[0] as { id: string; email: string; status: DeletionStatus };
  if (request.status !== "confirmed") {
    return { ok: false, error: `request is ${request.status}, only confirmed requests can be completed` };
  }

  // 2. Resolve the account(s) — one email can hold rows in several
  //    businesses (multi-workspace). Deleting the person means ALL of them.
  const userRes = await query(
    `SELECT id, name, email, role, business_id FROM users WHERE LOWER(email) = LOWER($1)`,
    [request.email],
  );
  if (userRes.rows.length === 0) {
    await query(
      `UPDATE account_delete_requests
          SET status = 'completed', note = 'No matching account found at processing time',
              processed_by = $2, processed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [requestId, adminId],
    );
    return { ok: true, message: "No matching account — request closed as completed" };
  }
  const users = userRes.rows as Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    business_id: string;
  }>;

  // 3. Business-owner guard: an owner with active teammates must transfer
  //    ownership first (handled in admin Businesses) — refusing here keeps
  //    the team intact instead of stranding it.
  for (const user of users) {
    if (user.role !== "owner") continue;
    const members = await query(
      `SELECT COUNT(*)::int AS c FROM users
        WHERE business_id = $1 AND id <> $2 AND status = 'active'`,
      [user.business_id, user.id],
    );
    const activeMembers = (members.rows[0] as { c: number }).c;
    if (activeMembers > 0) {
      return {
        ok: false,
        error: `This user owns a business with ${activeMembers} active teammate(s). Reassign ownership or remove the team first.`,
      };
    }
  }

  // 4. Final confirmation email — sent BEFORE the address is scrubbed.
  await sendEmail(
    request.email,
    users[0].name || request.email.split("@")[0],
    "Your Metricorex account has been deleted",
    buildCompletedEmailHtml(),
  ).catch((err) =>
    console.error("[account-deletion] completion email failed (deletion continues):", err?.message || err),
  );

  // 5. Anonymize + lock out EVERY account row for this identity. Financial
  //    rows (ledger, payroll, invoices, transactions) reference the user ids
  //    and are intentionally RETAINED — they keep their integrity with zero
  //    remaining PII.
  const userIds = users.map((u) => u.id);
  for (const user of users) {
    const anonEmail = `deleted.${user.id}@deleted-users.metricorex.com`;
    await query(
      `UPDATE users SET
          email = $2, name = 'Deleted User', password_hash = NULL,
          google_id = NULL, avatar_url = NULL,
          otp_code = NULL, otp_expires_at = NULL,
          invite_token = NULL, invite_expires_at = NULL,
          email_verified = FALSE, status = 'deleted', updated_at = NOW()
        WHERE id = $1`,
      [user.id, anonEmail],
    );
  }

  // 6. Revoke access surfaces: sessions + push devices (FCM/VoIP/WebPush).
  await query(`DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])`, [userIds]);
  await query(`DELETE FROM user_devices WHERE user_id = ANY($1::uuid[])`, [userIds]);

  // 7. Audit the request row.
  await query(
    `UPDATE account_delete_requests
        SET status = 'completed',
            note = COALESCE(note, '') || CASE WHEN note IS NULL OR note = '' THEN '' ELSE ' | ' END ||
                   $2 || ' account row(s) anonymized (status=deleted, sessions+devices revoked, financial records retained)',
            processed_by = $3, processed_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [requestId, String(users.length), adminId],
  );

  return {
    ok: true,
    message: `Account deleted (${users.length} workspace row(s) anonymized, access revoked)`,
    summary: {
      userIds,
      previousEmail: request.email,
      anonymizedEmails: userIds.map((id) => `deleted.${id}@deleted-users.metricorex.com`),
      businesses: users.map((u) => u.business_id),
      retainedFinancialRecords: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

const shell = (title: string, body: string) => `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e;">
    <h2 style="color:#1a1a2e;">${title}</h2>
    ${body}
    <p style="color:#6b7280;font-size:12px;margin-top:24px;">
      Metricorex — need help? Contact ${SUPPORT_EMAIL}.
    </p>
  </div>`;

function buildConfirmEmailHtml(token: string): string {
  const url = `${SITE_URL}/delete-account?token=${token}`;
  return shell(
    "Confirm your account deletion request",
    `<p>We received a request to delete the Metricorex account registered with this email address.</p>
     <p>This request only proceeds if YOU confirm it. The confirmation link below is valid for ${CONFIRM_TOKEN_TTL_HOURS} hours.</p>
     <p style="text-align:center;margin:28px 0;">
       <a href="${url}" style="background:#4f46e5;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">Confirm account deletion</a>
     </p>
     <p>If the button does not work, copy this link into your browser:<br/>
        <span style="word-break:break-all;color:#4f46e5;">${url}</span></p>
     <p><strong>Did not request this?</strong> Ignore this email — nothing happens without confirmation, and your account stays untouched.</p>`,
  );
}

function buildCompletedEmailHtml(): string {
  return shell(
    "Your account has been deleted",
    `<p>Your Metricorex account and personal data have been deleted as requested.</p>
     <p>What this means:</p>
     <ul>
       <li>Your profile, login credentials and devices have been removed and anonymized.</li>
       <li>You can no longer sign in to this account.</li>
       <li>Financial records we must legally retain are kept in anonymized form only.</li>
     </ul>
     <p>You are always welcome back — just create a new account any time.</p>`,
  );
}

function buildRejectedEmailHtml(note: string | null): string {
  return shell(
    "Your account deletion request was not processed",
    `<p>Your recent Metricorex account deletion request was reviewed and closed by our team without deleting the account.</p>
     ${note ? `<p><strong>Reason:</strong> ${note}</p>` : ""}
     <p>If you still want your account deleted or believe this was a mistake, contact ${SUPPORT_EMAIL}.</p>`,
  );
}
