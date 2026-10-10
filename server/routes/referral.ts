import express from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import {
  attributeReferrer,
  ensureUserReferralCode,
  getReferralConfig,
  getReferralInfo,
  resolveReferrerByCode,
} from "../services/referral";
import { query } from "../db";

/**
 * Refer & Earn routes.
 *
 *  GET  /referrals/me            — code + link + stats + referred users (auth)
 *  POST /referrals/claim         — attach a referral code after signup (auth)
 *  GET  /referrals/validate/:code — public code check for the signup page
 *  GET  /referrals/public-config  — public bonus config (site + signup pages)
 */
const router = express.Router();

const getAppBaseUrl = (): string =>
  (process.env.APP_BASE_URL || process.env.CLIENT_URL || "https://app.metricorex.com").replace(/\/+$/, "");

/**
 * @swagger
 * /referrals/me:
 *   get:
 *     summary: My referral code, stats and referred users
 *     tags: [Referrals]
 *     security:
 *       - bearerAuth: []
 */
router.get("/me", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: "Authentication required" });

    const info = await getReferralInfo(userId);

    // Referrer presence so clients can show/hide the "Have a code?" claim box.
    const meRow = await query(`SELECT (referred_by IS NOT NULL) as "hasReferrer" FROM users WHERE id = $1 LIMIT 1`, [userId]);
    const hasReferrer = meRow.rows[0]?.hasReferrer === true;

    const baseUrl = getAppBaseUrl();
    const referralLink = info.referralCode ? `${baseUrl}/r/${info.referralCode}` : null;

    return res.json({
      success: true,
      data: {
        referralCode: info.referralCode,
        referralLink,
        hasReferrer,
        config: {
          enabled: info.config.enabled,
          amount: info.config.amount,
          currency: info.config.currency,
        },
        stats: info.stats,
        referred: info.referred,
      },
    });
  } catch (error: any) {
    console.error("Referral /me error:", error?.message);
    return res.status(500).json({ success: false, message: "Failed to load referral info" });
  }
});

/**
 * @swagger
 * /referrals/claim:
 *   post:
 *     summary: Attach a referral code to my account (post-signup, Google SSO prompt)
 *     tags: [Referrals]
 *     security:
 *       - bearerAuth: []
 */
router.post("/claim", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: "Authentication required" });

    const code = (req.body?.referralCode || req.body?.code || "").toString();
    if (!code.trim()) {
      return res.status(400).json({ success: false, message: "Referral code is required" });
    }

    const result = await attributeReferrer(userId, code);
    if (result.applied) {
      return res.json({
        success: true,
        message: `Referral code applied. Welcome aboard!`,
        data: { applied: true, referrerName: result.referrerName ?? null },
      });
    }

    const messages: Record<string, string> = {
      invalid_code: "That referral code doesn't exist. Check it and try again.",
      self_referral: "You can't use your own referral code.",
      already_referred: "Your account already has a referral attached.",
    };
    return res.status(result.reason === "already_referred" ? 409 : 400).json({
      success: false,
      message: messages[result.reason || "invalid_code"] || "Referral code could not be applied",
      data: { applied: false, reason: result.reason },
    });
  } catch (error: any) {
    console.error("Referral claim error:", error?.message);
    return res.status(500).json({ success: false, message: "Failed to apply referral code" });
  }
});

/**
 * @swagger
 * /referrals/validate/{code}:
 *   get:
 *     summary: Public — check whether a referral code is valid (signup page)
 *     tags: [Referrals]
 *     security: []
 */
router.get("/validate/:code", async (req, res) => {
  try {
    const code = (req.params.code || "").toString();
    const referrer = await resolveReferrerByCode(code);
    const config = await getReferralConfig();
    return res.json({
      success: true,
      data: {
        valid: Boolean(referrer),
        referralEnabled: config.enabled,
        amount: config.amount,
        currency: config.currency,
      },
    });
  } catch (error: any) {
    console.error("Referral validate error:", error?.message);
    return res.json({ success: true, data: { valid: false, referralEnabled: false, amount: 0, currency: "NGN" } });
  }
});

/**
 * @swagger
 * /referrals/public-config:
 *   get:
 *     summary: Public — referral bonus config (website Refer & Earn section)
 *     tags: [Referrals]
 *     security: []
 */
router.get("/public-config", async (req, res) => {
  try {
    const config = await getReferralConfig();
    return res.json({
      success: true,
      data: {
        enabled: config.enabled && config.amount > 0,
        amount: config.amount,
        currency: config.currency,
      },
    });
  } catch (error: any) {
    console.error("Referral public-config error:", error?.message);
    return res.json({ success: true, data: { enabled: false, amount: 0, currency: "NGN" } });
  }
});

export default router;
