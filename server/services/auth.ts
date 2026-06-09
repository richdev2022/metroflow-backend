import crypto from "crypto";
import { query } from "../db";

// Simple password hashing (in production, use bcrypt instead)
export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
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
  console.log("Generated new token for user:", { userId, businessId, token });
  
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
    // Get idle timeout from env (default to 30 minutes)
    const idleTimeoutMinutes = parseInt(process.env.TOKEN_IDLE_TIMEOUT_MINUTES || "30", 10);
    
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
