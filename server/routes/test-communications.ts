import express from "express";
import { sendSMS } from "../services/sms";
import { sendEmail, generateOtpEmailHtml, generateKYCOtpEmailHtml } from "../services/email";
import { getAvailableSMSProviders, getSMSProvider } from "../services/sms-providers/factory";
import crypto from "crypto";

const router = express.Router();

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
 *     summary: Send test SMS or Email
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
 *                 enum: [sms, email]
 *                 description: Type of communication to send
 *               category:
 *                 type: string
 *                 description: Category of message (see examples for available categories)
 *               recipient:
 *                 type: string
 *                 description: Phone number for SMS or email address for Email
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
    if (!['sms', 'email'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: "Type must be 'sms' or 'email'" 
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
      } else {
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
 *     summary: Get available categories for SMS and Email
 *     tags: [Test Communications]
 *     responses:
 *       200:
 *         description: List of available categories
 */
router.get("/categories", (req, res) => {
  res.json({
    success: true,
    sms_categories: Object.keys(SMS_CATEGORIES),
    email_categories: Object.keys(EMAIL_CATEGORIES),
    available_sms_providers: getAvailableSMSProviders()
  });
});

export default router;
