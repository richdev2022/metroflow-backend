import crypto from "crypto";
import bcrypt from "bcryptjs";
import { query } from "../db";

/**
 * Session idle timeout (minutes). Each successful verifyToken slides the
 * window forward (last_activity_at = NOW()), so this is INACTIVITY-only:
 * an app in active use never expires.
 *
 * HISTORY: the default was 30 minutes, which silently killed mobile sessions
 * between screens — the app stayed "logged in" (token still on the device)
 * while EVERY REST call started returning 403 "Invalid or expired token" and
 * sockets dropped to guest (no calls, no live chat, no push registration).
 * A fintech app whose users expect to open it occasionally must not destroy
 * the session that fast. 30 days of inactivity is the new floor; operators
 * can still tighten it with TOKEN_IDLE_TIMEOUT_MINUTES.
 */
export const SESSION_IDLE_TIMEOUT_MINUTES = parseInt(
  process.env.TOKEN_IDLE_TIMEOUT_MINUTES || "43200",
  10,
);

// Secure password hashing with bcrypt
const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// VAPT MF-005 fix: login / forgot-password must spend the same time on
// "unknown email" as on "wrong password", otherwise response timing is an
// account-existence oracle (measured live: ~220ms fake vs ~800ms real).
// Callers run verifyPassword(password, TIMING_EQUALIZER_HASH) on the
// unknown-user path — a real bcrypt-12 round that never matches.
export const TIMING_EQUALIZER_HASH =
  "$2b$12$7OElVLSj6hrdOCHPihnM7On.Y6/RzeRMzSv9CG5NEsaiTajZ8wbBe";

// OTP Generation
// VAPT MF-011 fix: OTPs are authentication secrets — Math.random() is a PRNG
// with predictable internal state, so a 6-digit code was enumerable from a
// few observed outputs. crypto.randomInt() draws from the OS CSPRNG.
export function generateOTP(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

// VAPT MF-012 fix: OTPs were stored PLAINTEXT in users.otp_code /
// businesses.otp_code, so a database read (backup, support query, partial
// SQL leak) exposed every live code. The established otp_hash pattern
// (routes/kyc.ts, settings.ts phone_verify) already stores SHA-256 — this
// helper set brings every OTP flow onto it. otpMatches() transparently
// accepts legacy plaintext rows so in-flight codes keep working across the
// deploy boundary.
export function hashOtp(otp: string | number): string {
  return crypto.createHash("sha256").update(String(otp).trim()).digest("hex");
}

export function otpMatches(candidate: unknown, stored: unknown): boolean {
  if (candidate === null || candidate === undefined || stored === null || stored === undefined) {
    return false;
  }
  const c = String(candidate).trim();
  const s = String(stored).trim();
  if (!c || !s) return false;

  if (/^[a-f0-9]{64}$/i.test(s)) {
    // Stored value is a SHA-256 digest — hash the candidate and compare in
    // constant time.
    const candidateHash = hashOtp(c);
    try {
      return crypto.timingSafeEqual(
        Buffer.from(candidateHash, "hex"),
        Buffer.from(s.toLowerCase(), "hex"),
      );
    } catch {
      return false;
    }
  }

  // Legacy plaintext row (pre-hardening): direct compare keeps codes issued
  // just before a deploy valid for their remaining lifetime.
  return c === s;
}

// VAPT MF-006 fix: registration and every password-set path accepted
// purely-numeric secrets like "12345678". Policy: minimum length, at least
// one letter AND one digit, rejection of the obvious denylist.
const COMMON_PASSWORDS = new Set([
  "12345678", "123456789", "1234567890", "password", "password1", "password12",
  "password123", "passw0rd", "qwerty123", "qwertyui", "11111111", "00000000",
  "12121212", "12341234", "12345678a", "abcd1234", "abcd12345", "iloveyou1",
  "metricorex", "metricorex1", "admin1234", "letmein12", "welcome1", "welcome12",
]);

export interface PasswordPolicyResult {
  ok: boolean;
  error?: string;
}

export function validatePasswordPolicy(
  password: unknown,
  options: { minLength?: number } = {},
): PasswordPolicyResult {
  const minLength = options.minLength ?? 8;
  if (typeof password !== "string" || password.length < minLength) {
    return {
      ok: false,
      error: `Password must be at least ${minLength} characters long`,
    };
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return {
      ok: false,
      error: "Password must contain at least one letter and one number",
    };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return {
      ok: false,
      error: "This password is too common. Please choose a stronger one",
    };
  }
  return { ok: true };
}

export function getOTPExpiry(): Date {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + 10); // OTP valid for 10 minutes
  return expiry;
}

// Generate secure random token
export async function generateToken(userId: string, businessId: string): Promise<string> {
  // Generate secure token
  const token = crypto.randomBytes(32).toString("hex");
  // NEVER log the token value — logs are shipped to third parties.
  console.log("Generated new session token for user:", { userId, businessId });
  
  // Store token in user_sessions table with last_activity_at set explicitly
  await query(
    `INSERT INTO user_sessions (user_id, business_id, token, last_activity_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [userId, businessId, token]
  );
  console.log("Token stored in user_sessions successfully");
  
  return token;
}

export async function verifyToken(
  token: string,
): Promise<{ userId: string; businessId: string } | null> {
  try {
    // Sliding idle window: every successful verification extends the session.
    // NOTE: never log the token value — pm2 logs leave the box.
    const idleTimeoutMinutes = SESSION_IDLE_TIMEOUT_MINUTES;
    
    // First, try to update the session and get the session info in one query
    const updateResult = await query(
      `UPDATE user_sessions 
       SET last_activity_at = NOW() 
       WHERE token = $1 
       AND last_activity_at > NOW() - ($2 || ' minutes')::INTERVAL
       RETURNING user_id, business_id`,
      [token, idleTimeoutMinutes]
    );
    console.log("Update result rows:", updateResult.rows.length);

    if (updateResult.rows.length > 0) {
      // Success! Token was active and we updated it
      console.log("Token verified successfully");
      return {
        userId: updateResult.rows[0].user_id,
        businessId: updateResult.rows[0].business_id
      };
    }

    // If no rows returned, either token doesn't exist or it's expired
    // Let's check if token exists (so we can delete it if expired)
    const checkResult = await query(
      `SELECT user_id, business_id FROM user_sessions WHERE token = $1`,
      [token]
    );
    console.log("Check result rows:", checkResult.rows.length);

    if (checkResult.rows.length > 0) {
      // Token exists but is expired - delete it
      console.log("Token expired due to inactivity, deleting it");
      await query(`DELETE FROM user_sessions WHERE token = $1`, [token]);
    } else {
      console.log("Token not found in user_sessions");
    }

    return null;
  } catch (error) {
    console.error("Error verifying token:", error);
    return null;
  }
}

export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function getInviteExpiry(): Date {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 7); // Invite valid for 7 days
  return expiry;
}
