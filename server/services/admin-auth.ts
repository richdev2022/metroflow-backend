import { query } from "../db";
import { hashPassword, verifyPassword } from "./auth";
import crypto from "crypto";

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
    // Get idle timeout from env (default to 30 minutes)
    const idleTimeoutMinutes = parseInt(process.env.TOKEN_IDLE_TIMEOUT_MINUTES || "30", 10);
    
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

export async function loginAdmin(email: string, password: string) {
  const result = await query(
    `SELECT * FROM platform_admins WHERE email = $1`,
    [email]
  );

  if (result.rows.length === 0) {
    throw new Error("Invalid credentials");
  }

  const admin = result.rows[0];

  if (admin.status === 'inactive') {
    throw new Error("Account is inactive");
  }

  const isValid = await verifyPassword(password, admin.password_hash);

  if (!isValid) {
    throw new Error("Invalid credentials");
  }

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