import crypto from "crypto";

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

// JWT Token (simple implementation - in production use jsonwebtoken library)
export function generateToken(userId: string, businessId: string): string {
  const payload = {
    userId,
    businessId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24 hours
  };

  // Simple token encoding - in production use JWT library
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export function verifyToken(
  token: string,
): { userId: string; businessId: string } | null {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64").toString());

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null; // Token expired
    }

    return { userId: payload.userId, businessId: payload.businessId };
  } catch (error) {
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
