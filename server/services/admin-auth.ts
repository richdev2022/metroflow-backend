import { query } from "../db";
import { verifyPassword, SESSION_IDLE_TIMEOUT_MINUTES, TIMING_EQUALIZER_HASH } from "./auth";
import crypto from "crypto";

// VAPT MF-002 fix: platform_admins previously had NO lockout — unlimited
// offline password guessing against /admin/auth/login. Mirrors the user
// login-security policy (5 failures -> 30-minute lock) WITHOUT the permanent
// block escalation: an admin console locked "forever" is a business-continuity
// risk; repeated lock cycles alert via email and pm2 logs instead.
const ADMIN_MAX_FAILED_ATTEMPTS = Math.max(
  3,
  parseInt(process.env.ADMIN_LOGIN_MAX_FAILED_ATTEMPTS || "5", 10) || 5,
);
const ADMIN_LOCK_MINUTES = Math.max(
  1,
  parseInt(process.env.ADMIN_LOGIN_LOCK_MINUTES || "30", 10) || 30,
);

/** Thrown by loginAdmin so route handlers can map to the right HTTP status
 *  without guessing from the message text. */
export class AdminAccountLockedError extends Error {
  lockoutEnd: Date;
  retryAfterSeconds: number;
  constructor(lockoutEnd: Date) {
    super("Account temporarily locked due to repeated failed sign-in attempts");
    this.name = "AdminAccountLockedError";
    this.lockoutEnd = lockoutEnd;
    this.retryAfterSeconds = Math.max(
      1,
      Math.ceil((lockoutEnd.getTime() - Date.now()) / 1000),
    );
  }
}

// Admin Token Generation
export async function generateAdminToken(adminId: string): Promise<string> {
  // Generate secure token
  const token = crypto.randomBytes(32).toString("hex");
  
  // Store token in admin_sessions table
  await query(
    `INSERT INTO admin_sessions (admin_id, token, last_activity_at) VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    [adminId, token]
  );
  
  return token;
}

export async function verifyAdminToken(token: string): Promise<{ adminId: string } | null> {
  try {
    // Same sliding idle window as user sessions (shared default).
    const idleTimeoutMinutes = SESSION_IDLE_TIMEOUT_MINUTES;
    
    // First, try to update the session and get the session info in one query
    const updateResult = await query(
      `UPDATE admin_sessions 
       SET last_activity_at = CURRENT_TIMESTAMP 
       WHERE token = $1 
         AND last_activity_at > CURRENT_TIMESTAMP - ($2 || ' minutes')::INTERVAL
       RETURNING admin_id`,
      [token, idleTimeoutMinutes]
    );
    
    if (updateResult.rows.length > 0) {
      return { adminId: updateResult.rows[0].admin_id };
    }
    
    // If no rows returned, either token doesn't exist or it's expired, clean up expired token
    await query(`DELETE FROM admin_sessions WHERE token = $1`, [token]);
    return null;
  } catch (error) {
    console.error("Error verifying admin token:", error);
    return null;
  }
}

export async function loginAdmin(email: string, password: string, meta: { ipAddress?: string; userAgent?: string } = {}) {
  // VAPT MF-006: validate input shape first — an undefined email used to hit
  // Postgres and bubble a raw parser error into the response.
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
    throw new Error("Invalid email or password");
  }

  const result = await query(
    `SELECT id, email, name, password_hash, status,
            failed_login_attempts, locked_until, lock_count
       FROM platform_admins WHERE email = $1`,
    [email.trim()]
  );

  if (result.rows.length === 0) {
    // Unknown admin — burn one bcrypt round so response timing matches the
    // "admin exists, wrong password" path (MF-005), then give the GENERIC
    // error (no account-existence oracle).
    await verifyPassword(password, TIMING_EQUALIZER_HASH);
    throw new Error("Invalid email or password");
  }

  const admin = result.rows[0];

  if (admin.status === 'inactive') {
    throw new Error("Invalid email or password");
  }

  // ---- Lockout gate (VAPT MF-002) ------------------------------------
  if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
    throw new AdminAccountLockedError(new Date(admin.locked_until));
  }

  const isValid = await verifyPassword(password, admin.password_hash);

  if (!isValid) {
    await recordFailedAdminLogin(admin, meta);
    // ALWAYS the generic message — never "wrong password" vs "no account".
    throw new Error("Invalid email or password");
  }

  // ---- Success: reset failure counters (best-effort) ------------------
  if (admin.failed_login_attempts > 0 || admin.locked_until) {
    try {
      await query(
        `UPDATE platform_admins
            SET failed_login_attempts = 0, locked_until = NULL
          WHERE id = $1`,
        [admin.id]
      );
    } catch (e: any) {
      console.warn("admin login reset skipped:", (e?.message || e).toString().substring(0, 120));
    }
  }
  await logAdminLoginAttempt({ email: email.trim(), ipAddress: meta.ipAddress, userAgent: meta.userAgent, success: true });

  // Auto-activate if pending invite
  if (admin.status === 'pending_invite') {
    await query(`UPDATE platform_admins SET status = 'active' WHERE id = $1`, [admin.id]);
    admin.status = 'active';
  }

  const token = await generateAdminToken(admin.id);

  return {
    token,
    admin: {
      id: admin.id,
      name: admin.name,
      email: admin.email
    }
  };
}

async function recordFailedAdminLogin(admin: any, meta: { ipAddress?: string; userAgent?: string }) {
  try {
    const attempts = (admin.failed_login_attempts || 0) + 1;
    if (attempts >= ADMIN_MAX_FAILED_ATTEMPTS) {
      const lockoutEnd = new Date(Date.now() + ADMIN_LOCK_MINUTES * 60 * 1000);
      await query(
        `UPDATE platform_admins
            SET failed_login_attempts = 0,
                locked_until = $2,
                lock_count = COALESCE(lock_count, 0) + 1
          WHERE id = $1`,
        [admin.id, lockoutEnd]
      );
      console.warn(
        `[security] ADMIN ACCOUNT LOCKED for ${ADMIN_LOCK_MINUTES}m after ${ADMIN_MAX_FAILED_ATTEMPTS} failed logins: ` +
        `${admin.email} ip=${meta.ipAddress || "unknown"} lock_cycle=${(admin.lock_count || 0) + 1}`,
      );
      await notifyAdminLockout(admin.email, lockoutEnd, meta);
    } else {
      await query(
        `UPDATE platform_admins SET failed_login_attempts = $2 WHERE id = $1`,
        [admin.id, attempts]
      );
    }
  } catch (e: any) {
    // Lockout bookkeeping must never mask the authentication result.
    console.warn("admin lockout bookkeeping skipped:", (e?.message || e).toString().substring(0, 160));
  }
  await logAdminLoginAttempt({
    email: admin.email,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: false,
    failureReason: "Invalid password",
  });
}

/** Audit trail in the shared login_attempts table (best-effort — the column
 *  set there is user-shaped, so wrap in its own guard). */
async function logAdminLoginAttempt(attempt: {
  email: string; ipAddress?: string; userAgent?: string; success: boolean; failureReason?: string;
}) {
  try {
    await query(
      `INSERT INTO login_attempts (email, ip_address, user_agent, success, failure_reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        attempt.email,
        attempt.ipAddress || null,
        attempt.userAgent ? `admin-console | ${String(attempt.userAgent).substring(0, 250)}` : "admin-console",
        attempt.success,
        attempt.failureReason || null,
      ]
    );
  } catch (e: any) {
    console.warn("admin login audit skipped:", (e?.message || e).toString().substring(0, 120));
  }
}

async function notifyAdminLockout(email: string, lockoutEnd: Date, meta: { ipAddress?: string; userAgent?: string }) {
  // Alert the admin on their own address. sendEmail resolves false instead of
  // throwing on provider errors, but guard anyway.
  try {
    const { sendEmail } = await import("./email");
    await sendEmail(
      email,
      "Platform Admin",
      "Metricorex admin sign-in temporarily locked",
      `<html><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px">
        <div style="max-width:600px;margin:0 auto;background:#fff;padding:30px;border-radius:8px;border-top:4px solid #dc2626">
          <h2 style="color:#991b1b;margin-bottom:16px">Admin sign-in locked</h2>
          <p style="color:#333;line-height:1.6">There were ${ADMIN_MAX_FAILED_ATTEMPTS} consecutive failed sign-in attempts on the
          Metricorex admin console account <strong>${email}</strong>. As a protection the account is locked until
          <strong>${lockoutEnd.toISOString()}</strong>.</p>
          ${meta.ipAddress ? `<p style="color:#666">IP address: ${meta.ipAddress}</p>` : ""}
          <p style="color:#666;line-height:1.6">If this was not you, rotate this account's password immediately and
          review the Activity Logs in the admin console.</p>
        </div>
      </body></html>`,
    );
  } catch (e: any) {
    console.warn("admin lockout email skipped:", (e?.message || e).toString().substring(0, 120));
  }
}