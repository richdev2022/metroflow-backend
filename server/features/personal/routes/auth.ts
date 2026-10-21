import { Router, RequestHandler } from "express";
import crypto from "crypto";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken } from "../../../middleware/auth";
import {
  generateToken, generateOTP, getOTPExpiry, hashOtp, hashPassword,
  validatePasswordPolicy, otpMatches,
} from "../../../services/auth";
import { isMaintenanceMode } from "../../../services/app-config";
import { sendEmail, emailLogoHeader } from "../../../services/email";
import { attributeReferrer, ensureUserReferralCode } from "../../../services/referral";
import { Response } from "express";

/**
 * PERSONAL AUTH — registration + cross-app SSO (Business <-> Personal).
 *
 *  POST /auth/register/personal  — minimal signup: email + phone + password
 *                                  (+ optional referral code). Creates a
 *                                  personal user (business_id NULL) with NGN
 *                                  + USD wallets.
 *  POST /auth/sso/ticket         — source app mints a one-time ticket.
 *  POST /auth/sso/redeem         — target app exchanges ticket for a session
 *                                  bound to the user's OWN business context.
 *
 * SSO rule: a session always carries the user's canonical businessId —
 * their owned business when they are a business owner, NULL when they are
 * personal-only. Wallet visibility is decided per-wallet, not per-session.
 */

const router = Router();

async function rejectIfUnderMaintenance(res: Response): Promise<boolean> {
  try {
    if (!(await isMaintenanceMode())) return false;
    res.status(503).json({
      success: false,
      code: "MAINTENANCE_MODE",
      message: "Metricorex is undergoing scheduled maintenance. Please try again in a little while.",
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /auth/register/personal
// ---------------------------------------------------------------------------
const registerPersonal: RequestHandler = async (req, res) => {
  try {
    if (await rejectIfUnderMaintenance(res)) return;
    const { email, phone_number, password, referralCode, name } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }
    const emailNorm = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ success: false, message: "Enter a valid email address" });
    }
    const pwCheck = validatePasswordPolicy(password, { minLength: 8 });
    if (!pwCheck.ok) return res.status(400).json({ success: false, message: pwCheck.error });
    let phone: string | null = null;
    if (phone_number) {
      phone = String(phone_number).replace(/[\s-()]/g, "");
      if (!/^\+?\d{7,15}$/.test(phone)) {
        return res.status(400).json({ success: false, message: "Enter a valid phone number" });
      }
    }

    const existing = await query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [emailNorm]);
    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "An account with this email already exists. Please sign in instead.",
      });
    }

    const otpCode = generateOTP();
    const otpExpiresAt = getOTPExpiry();
    const passwordHash = await hashPassword(password);
    const displayName = String(name || emailNorm.split("@")[0]).slice(0, 80);

    const userResult = await query(
      `INSERT INTO users
         (business_id, email, password_hash, name, role, account_type, phone_number,
          otp_code, otp_expires_at)
       VALUES (NULL, $1, $2, $3, 'owner', 'personal', $4, $5, $6)
       RETURNING id, email, name`,
      [emailNorm, passwordHash, displayName, phone, hashOtp(otpCode), otpExpiresAt],
    );
    const user = userResult.rows[0];

    // Personal wallets: NGN (primary) + USD — per-currency uniques allow both.
    await query(
      `INSERT INTO wallets (user_id, business_id, balance, currency, status)
       VALUES ($1, NULL, 0, 'NGN', 'active') ON CONFLICT (user_id, currency) DO NOTHING`,
      [user.id],
    );
    await query(
      `INSERT INTO wallets (user_id, business_id, balance, currency, status)
       VALUES ($1, NULL, 0, 'USD', 'active') ON CONFLICT (user_id, currency) DO NOTHING`,
      [user.id],
    );

    // Referral (best effort) + mint own code
    try {
      if (referralCode) await attributeReferrer(user.id, referralCode);
      await ensureUserReferralCode(user.id);
    } catch (e: any) {
      console.warn("registerPersonal referral step skipped:", e?.message);
    }

    // OTP email (best effort — account stays usable even if email fails)
    const otpEmailHtml = `
      <html><body style="font-family: Arial, sans-serif; background-color:#f5f5f5; padding:20px;">
        <div style="max-width:600px;margin:0 auto;background:#fff;padding:30px;border-radius:8px;">
          ${emailLogoHeader(150)}
          <h2 style="color:#7c3aed;margin-bottom:20px;">Verify your email</h2>
          <p style="color:#333;">Welcome to MetriCorex Personal!</p>
          <div style="background:#f0f0f0;padding:20px;border-radius:4px;margin:20px 0;text-align:center;">
            <p style="font-size:32px;font-weight:bold;color:#7c3aed;margin:0;letter-spacing:5px;">${otpCode}</p>
          </div>
          <p style="color:#999;font-size:12px;">This code expires in 10 minutes.</p>
        </div>
      </body></html>`;
    sendEmail(emailNorm, displayName, "Verify Your MetriCorex Account", otpEmailHtml).catch((e) =>
      console.warn("registerPersonal OTP email failed:", e?.message),
    );

    return res.status(201).json({
      success: true,
      message: "Account created! We sent a 6-digit code to your email.",
      userId: user.id,
      accountType: "personal",
    });
  } catch (error: any) {
    console.error("registerPersonal error:", error?.message);
    return res.status(500).json({ success: false, message: "Could not create your account. Please try again." });
  }
};

// ---------------------------------------------------------------------------
// Cross-app SSO
// ---------------------------------------------------------------------------
const SSO_PURPOSES = new Set(["personal", "business"]);

const mintSsoTicket: RequestHandler = async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { userId, businessId } = authReq.user || {};
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });
    const { purpose, next } = req.body || {};
    if (!SSO_PURPOSES.has(purpose)) {
      return res.status(400).json({ success: false, error: "purpose must be 'personal' or 'business'" });
    }
    const ticket = crypto.randomBytes(24).toString("hex");
    await query(
      `INSERT INTO sso_tickets (ticket, user_id, business_id, purpose, next_url, expires_at)
       VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '2 minutes')`,
      [ticket, userId, businessId ?? null, purpose, typeof next === "string" ? next.slice(0, 300) : null],
    );
    return res.json({ success: true, data: { ticket, expires_in: 120 } });
  } catch (error: any) {
    console.error("sso/ticket error:", error?.message);
    return res.status(500).json({ success: false, error: "Could not create SSO ticket" });
  }
};

const redeemSsoTicket: RequestHandler = async (req, res) => {
  try {
    const { ticket } = req.body || {};
    if (!ticket) return res.status(400).json({ success: false, error: "ticket is required" });
    const r = await query(
      `DELETE FROM sso_tickets WHERE ticket = $1 AND expires_at > NOW()
       RETURNING user_id, purpose, next_url`,
      [String(ticket)],
    );
    if (r.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: "This sign-in link has expired. Please try again.",
        code: "SSO_TICKET_INVALID",
      });
    }
    const t = r.rows[0];
    const u = await query(
      `SELECT id, business_id as "businessId", email_verified, name, email, account_type FROM users WHERE id = $1`,
      [t.user_id],
    );
    if (!u.rows.length) return res.status(400).json({ success: false, error: "User no longer exists" });
    const user = u.rows[0];
    if (!user.email_verified) {
      return res.status(403).json({ success: false, error: "Verify your email first.", code: "EMAIL_UNVERIFIED" });
    }
    // Canonical business context: the user's OWN owned business (if any).
    let businessId: string | null = user.businessId ?? null;
    if (t.purpose === "business" && !businessId) {
      const owned = await query(
        `SELECT id FROM businesses WHERE owner_id = $1 ORDER BY created_at LIMIT 1`,
        [user.id],
      );
      if (owned.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: "You don't have a business account yet. Create one from the Business app.",
          code: "NO_BUSINESS",
        });
      }
      businessId = owned.rows[0].id;
    }
    const token = await generateToken(user.id, businessId);
    const base = t.purpose === "business"
      ? (process.env.CLIENT_URL || "https://app.metricorex.com")
      : "https://personal.metricorex.com";
    const nextUrl = t.next_url || "";
    const redirectUrl = nextUrl ? `${base}${nextUrl.startsWith("/") ? nextUrl : `/${nextUrl}`}` : base;
    return res.json({
      success: true,
      data: {
        token,
        userId: user.id,
        businessId,
        accountType: user.account_type || (businessId ? "business" : "personal"),
        name: user.name,
        email: user.email,
        redirect_url: redirectUrl,
      },
    });
  } catch (error: any) {
    console.error("sso/redeem error:", error?.message);
    return res.status(500).json({ success: false, error: "Could not complete sign-in" });
  }
};

// Whoami for cross-app bootstrapping (authenticated).
router.get("/sso/whoami", authenticateToken, async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const u = await query(
    `SELECT id, business_id as "businessId", name, email, avatar_url, account_type
     FROM users WHERE id = $1`,
    [authReq.user?.userId],
  );
  if (!u.rows.length) return res.status(403).json({ success: false, error: "Invalid or expired token" });
  const user = u.rows[0];
  let ownsBusiness = false;
  if (user.businessId) {
    const b = await query(`SELECT 1 FROM businesses WHERE id = $1 AND owner_id = $2`, [user.businessId, user.id]);
    ownsBusiness = b.rows.length > 0;
  }
  res.json({
    success: true,
    data: {
      userId: user.id, businessId: user.businessId, name: user.name, email: user.email,
      avatarUrl: user.avatar_url, accountType: user.account_type || "business", ownsBusiness,
    },
  });
});

export { registerPersonal, mintSsoTicket, redeemSsoTicket };
export default router;
