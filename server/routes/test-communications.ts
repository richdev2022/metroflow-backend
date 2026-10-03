import express from "express";
import { sendSMS } from "../services/sms";
import { sendEmail, generateOtpEmailHtml, generateKYCOtpEmailHtml } from "../services/email";
import { sendWhatsApp } from "../services/whatsapp";
import { getAvailableSMSProviders, getSMSProvider } from "../services/sms-providers/factory";
import { isPushConfigured } from "../services/push";
import { query } from "../db";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import crypto from "crypto";

const router = express.Router();

/**
 * @swagger
 * /test-communications/push-status:
 *   get:
 *     summary: Push (FCM) diagnostics for the signed-in user
 *     description: Shows whether FCM credentials are configured server-side, which Firebase project sends are targeting, and how many devices are registered for the caller. Use this to verify the push pipeline end to end.
 *     tags: [Test Communications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Diagnostics
 */
router.get("/push-status", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const devicesRes = await query(
      `SELECT platform, COUNT(*)::int AS count FROM user_devices WHERE user_id = $1 GROUP BY platform`,
      [userId],
    );
    const account = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? (() => {
          try {
            const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
            const json = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
            return { project_id: json.project_id || null, client_email: json.client_email || null };
          } catch {
            return { project_id: null, client_email: null, parse_error: true };
          }
        })()
      : null;

    res.json({
      success: true,
      data: {
        fcmConfigured: isPushConfigured(),
        mode: process.env.FIREBASE_SERVICE_ACCOUNT_JSON
          ? "http-v1 (service account)"
          : process.env.FCM_SERVER_KEY
            ? "legacy server key"
            : "NOT CONFIGURED — pushes are dropped silently; set FIREBASE_SERVICE_ACCOUNT_JSON + FIREBASE_PROJECT_ID",
        firebaseProjectId: process.env.FIREBASE_PROJECT_ID || account?.project_id || null,
        serviceAccountEmail: account?.client_email || null,
        serviceAccountParseError: !!(account as any)?.parse_error,
        myDevices: devicesRes.rows,
        hint:
          "If fcmConfigured is false, no push will ever reach any device. If firebaseProjectId does not match the apps' Firebase project, every send 404s and tokens get pruned.",
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || "Failed to read push status" });
  }
});

/**
 * @swagger
 * tags:
 *   name: Test Communications
 *   description: Test SMS and Email functionality
 */

// SMS Categories
const SMS_CATEGORIES = {
  'otp': (otp: string) => `Your verification code is: ${otp}. Valid for 10 minutes.`,
  'transfer_otp': (otp: string) => `Your Transfer OTP is: ${otp}`,
  'bvn_nin_otp': (otp: string) => `Your Metroflow verification code is: ${otp}. Valid for 10 minutes.`
};

// Email Categories
const EMAIL_CATEGORIES = {
  'otp': {
    subject: (purpose: string = "Verification") => `${purpose} OTP`,
    html: (otp: string, purpose: string = "Verification") => generateOtpEmailHtml(otp, purpose)
  },
  'kyc_otp': {
    subject: () => "KYC Verification OTP",
    html: (otp: string, name: string = "User") => generateKYCOtpEmailHtml(name, otp)
  },
  'transfer_otp': {
    subject: () => "Confirm Transfer",
    html: (otp: string) => generateOtpEmailHtml(otp, "Transfer Verification")
  }
};

// Helper to generate OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

/**
 * @swagger
 * /test-communications/send:
 *   post:
 *     summary: Send test SMS, Email, or WhatsApp
 *     tags: [Test Communications]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - category
 *               - recipient
 *             properties:
 *               type:
 *                 type: string
 *                 enum:
 *                   - sms
 *                   - email
 *                   - whatsapp
 *                 description: Type of communication to send
 *               category:
 *                 type: string
 *                 description: Category of message (see examples for available categories)
 *               recipient:
 *                 type: string
 *                 description: Phone number for SMS/WhatsApp or email address for Email
 *               otp:
 *                 type: string
 *                 description: Optional custom OTP (auto-generated if not provided)
 *               name:
 *                 type: string
 *                 description: Optional recipient name (for email)
 *               purpose:
 *                 type: string
 *                 description: Optional purpose (for OTP emails)
 *               provider:
 *                 type: string
 *                 description: Optional SMS provider (e.g., kudi or termii)
 *     responses:
 *       200:
 *         description: Message sent successfully
 *       400:
 *         description: Invalid input
 */
router.post("/send", async (req, res) => {
  try {
    const { type, category, recipient, otp: customOtp, name, purpose, provider } = req.body;

    // Validate required fields
    if (!type || !category || !recipient) {
      return res.status(400).json({ 
        success: false, 
        error: "Type, category, and recipient are required" 
      });
    }

    // Validate type
    if (!['sms', 'email', 'whatsapp'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: "Type must be 'sms', 'email', or 'whatsapp'" 
      });
    }

    const otp = customOtp || generateOTP();

    if (type === 'sms') {
      // Validate SMS category
      const smsCategory = category as keyof typeof SMS_CATEGORIES;
      if (!SMS_CATEGORIES[smsCategory]) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid SMS category. Available categories: ${Object.keys(SMS_CATEGORIES).join(', ')}` 
        });
      }

      // Validate provider if specified
      const availableProviders = getAvailableSMSProviders();
      if (provider && !availableProviders.includes(provider)) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid SMS provider. Available providers: ${availableProviders.join(', ')}` 
        });
      }

      // Send SMS
      const message = SMS_CATEGORIES[smsCategory](otp);
      console.log("Sending SMS with message:", message, "to recipient:", recipient, "using provider:", provider || 'default');
      
      let smsResult;
      if (provider) {
        const smsProvider = getSMSProvider(provider);
        smsResult = await smsProvider.sendSMS(recipient, message);
        // Direct provider calls return a normalized envelope instead of
        // throwing — check it so a rejected delivery is reported honestly.
        if (!smsResult || smsResult.success === false) {
          const reason = smsResult?.error || 'unknown provider error';
          console.error(`Test SMS delivery failed via ${provider}: ${reason}`);
          return res.status(502).json({
            success: false,
            error: `SMS delivery failed via ${provider}: ${reason}`,
            otp,
            category,
            recipient,
            provider,
            providerResponse: smsResult
          });
        }
      } else {
        // sendSMS throws on provider failure; the outer catch reports it.
        smsResult = await sendSMS(recipient, message);
      }
      
      console.log("SMS provider response:", smsResult);
      
      res.json({ 
        success: true, 
        message: "SMS sent successfully", 
        otp, 
        category,
        recipient,
        provider,
        providerResponse: smsResult
      });

    } else if (type === 'whatsapp') {
      // Validate WhatsApp category (uses the same as SMS categories
      const whatsappCategory = category as keyof typeof SMS_CATEGORIES;
      if (!SMS_CATEGORIES[whatsappCategory]) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid WhatsApp category. Available categories: ${Object.keys(SMS_CATEGORIES).join(', ')}` 
        });
      }

      // Send WhatsApp
      const message = SMS_CATEGORIES[whatsappCategory](otp);
      console.log("Sending WhatsApp with message:", message, "to recipient:", recipient);
      
      const whatsappResult = await sendWhatsApp(recipient, message);
      
      console.log("WhatsApp provider response:", whatsappResult);
      
      res.json({ 
        success: true, 
        message: "WhatsApp sent successfully", 
        otp, 
        category,
        recipient,
        providerResponse: whatsappResult
      });

    } else {
      // Validate Email category
      const emailCategory = category as keyof typeof EMAIL_CATEGORIES;
      if (!EMAIL_CATEGORIES[emailCategory]) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid email category. Available categories: ${Object.keys(EMAIL_CATEGORIES).join(', ')}` 
        });
      }

      // Send Email
      const subject = EMAIL_CATEGORIES[emailCategory].subject(purpose);
      const html = EMAIL_CATEGORIES[emailCategory].html(otp, name);
      await sendEmail(recipient, name || "User", subject, html);
      
      res.json({ 
        success: true, 
        message: "Email sent successfully", 
        otp, 
        category,
        recipient 
      });
    }

  } catch (error) {
    console.error("Test communication error:", error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : "Failed to send message" 
    });
  }
});

/**
 * @swagger
 * /test-communications/categories:
 *   get:
 *     summary: Get available categories for SMS, Email, and WhatsApp
 *     tags: [Test Communications]
 *     responses:
 *       200:
 *         description: List of available categories
 */
router.get("/categories", (req, res) => {
  res.json({
    success: true,
    sms_categories: Object.keys(SMS_CATEGORIES),
    whatsapp_categories: Object.keys(SMS_CATEGORIES),
    email_categories: Object.keys(EMAIL_CATEGORIES),
    available_sms_providers: getAvailableSMSProviders()
  });
});

export default router;
