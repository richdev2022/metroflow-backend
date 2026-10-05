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

// OTP Generation
export function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
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
    console.log("Verifying token:", token);
    // Sliding idle window: every successful verification extends the session.
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
