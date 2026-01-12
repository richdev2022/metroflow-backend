import { query } from "../db";
import { hashPassword, verifyPassword } from "./auth";

// Admin Token Generation
export function generateAdminToken(adminId: string): string {
  const payload = {
    adminId,
    role: 'platform_admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24 hours
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export function verifyAdminToken(token: string): { adminId: string; role: string } | null {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (payload.role !== 'platform_admin') {
      return null;
    }
    return { adminId: payload.adminId, role: payload.role };
  } catch (error) {
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

  const isValid = verifyPassword(password, admin.password_hash);

  if (!isValid) {
    throw new Error("Invalid credentials");
  }

  // Auto-activate if pending invite
  if (admin.status === 'pending_invite') {
    await query(`UPDATE platform_admins SET status = 'active' WHERE id = $1`, [admin.id]);
    admin.status = 'active';
  }

  const token = generateAdminToken(admin.id);

  return {
    token,
    admin: {
      id: admin.id,
      name: admin.name,
      email: admin.email
    }
  };
}