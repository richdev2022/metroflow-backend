import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../middleware/auth";
import { generateOTP, getOTPExpiry, hashPassword, verifyPassword } from "../services/auth";
import { sendEmail, generateOtpEmailHtml } from "../services/email";
import { sendSMS } from "../services/sms";
import { validateBody } from "../middleware/validation";
import {
  CreateTransactionPinSchema,
  UpdateTransactionPinSchema,
  ToggleOtpSchema,
} from "../lib/validation";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Settings
 *   description: Business settings management
 */

/**
 * @swagger
 * /settings:
 *   get:
 *     summary: Get business settings
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Business settings details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 settings:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     email:
 *                       type: string
 *                     phone_number:
 *                       type: string
 *                     industry:
 *                       type: string
 *                     logo_url:
 *                       type: string
 *                     currency:
 *                       type: string
 */
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        // Modified to include phone_number and exclude created_at
        const result = await query(
            `SELECT id, name, email, phone_number, industry, logo_url, currency FROM businesses WHERE id = $1`,
            [businessId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Business not found" });
        }

        res.json({ success: true, settings: result.rows[0] });
    } catch (error) {
        console.error("Get settings error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch settings" });
    }
});

/**
 * @swagger
 * /settings:
 *   put:
 *     summary: Update business settings (e.g., currency)
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               currency:
 *                 type: string
 *                 enum: [USD, NGN]
 *               name:
 *                 type: string
 *               industry:
 *                 type: string
 *               logo_url:
 *                 type: string
 *     responses:
 *       200:
 *         description: Settings updated
 */
router.put("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { currency, name, industry, logo_url } = req.body;

        const updates: string[] = [];
        const values: any[] = [];
        let paramIdx = 1;

        if (currency) {
            if (!['USD', 'NGN'].includes(currency)) {
                return res.status(400).json({ success: false, error: "Invalid currency. Must be USD or NGN." });
            }
            updates.push(`currency = $${paramIdx}`);
            values.push(currency);
            paramIdx++;
        }

        if (name) {
            updates.push(`name = $${paramIdx}`);
            values.push(name);
            paramIdx++;
        }

        if (industry) {
            updates.push(`industry = $${paramIdx}`);
            values.push(industry);
            paramIdx++;
        }
        
        if (logo_url) {
            updates.push(`logo_url = $${paramIdx}`);
            values.push(logo_url);
            paramIdx++;
        }

        if (updates.length === 0) {
            return res.json({ success: true, message: "No changes provided" });
        }

        values.push(businessId);
        await query(
            `UPDATE businesses SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIdx}`,
            values
        );

        res.json({ success: true, message: "Settings updated successfully" });

    } catch (error) {
        console.error("Update settings error:", error);
        res.status(500).json({ success: false, error: "Failed to update settings" });
    }
});

/**
 * @swagger
 * /settings/update-contact/request-otp:
 *   post:
 *     summary: Request OTP to update business email or phone number
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - value
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [email, phone]
 *               value:
 *                 type: string
 *                 description: New email address or phone number
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *       400:
 *         description: Invalid input
 */
router.post("/update-contact/request-otp", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { type, value } = req.body;

        if (!type || !value) {
            return res.status(400).json({ success: false, error: "Type and value are required" });
        }

        if (!['email', 'phone'].includes(type)) {
            return res.status(400).json({ success: false, error: "Type must be 'email' or 'phone'" });
        }

        const otpCode = generateOTP();
        const otpExpiresAt = getOTPExpiry();

        if (type === 'email') {
            // Update DB with temp email and OTP
            await query(
                `UPDATE businesses 
                 SET temp_email = $1, otp_code = $2, otp_expires_at = $3, temp_phone = NULL
                 WHERE id = $4`,
                [value, otpCode, otpExpiresAt, businessId]
            );

            // Send Email
            const emailHtml = generateOtpEmailHtml(otpCode, "Verify New Business Email");
            await sendEmail(value, "Business Admin", "Verify New Business Email", emailHtml);

        } else if (type === 'phone') {
            // Update DB with temp phone and OTP
            await query(
                `UPDATE businesses 
                 SET temp_phone = $1, otp_code = $2, otp_expires_at = $3, temp_email = NULL
                 WHERE id = $4`,
                [value, otpCode, otpExpiresAt, businessId]
            );

            // Send SMS
            await sendSMS(value, `Your verification code is: ${otpCode}. Valid for 10 minutes.`);
        }

        res.json({ success: true, message: `OTP sent to ${value}` });

    } catch (error) {
        console.error("Request OTP error:", error);
        res.status(500).json({ success: false, error: "Failed to request OTP" });
    }
});

/**
 * @swagger
 * /settings/update-contact/verify-otp:
 *   post:
 *     summary: Verify OTP and update business email or phone number
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - otp
 *             properties:
 *               otp:
 *                 type: string
 *     responses:
 *       200:
 *         description: Contact updated successfully
 *       400:
 *         description: Invalid OTP or expired
 * */
router.post("/update-contact/verify-otp", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { otp } = req.body;

        if (!otp) {
            return res.status(400).json({ success: false, error: "OTP is required" });
        }

        // Get business pending update info
        const result = await query(
            `SELECT temp_email, temp_phone, otp_code, otp_expires_at FROM businesses WHERE id = $1`,
            [businessId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Business not found" });
        }

        const { temp_email, temp_phone, otp_code, otp_expires_at } = result.rows[0];

        if (!otp_code || otp_code !== otp) {
            return res.status(400).json({ success: false, error: "Invalid OTP" });
        }

        if (new Date(otp_expires_at) < new Date()) {
            return res.status(400).json({ success: false, error: "OTP expired" });
        }

        // Perform update
        if (temp_email) {
            await query(
                `UPDATE businesses 
                 SET email = temp_email, temp_email = NULL, otp_code = NULL, otp_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [businessId]
            );
        } else if (temp_phone) {
            await query(
                `UPDATE businesses 
                 SET phone_number = temp_phone, temp_phone = NULL, otp_code = NULL, otp_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [businessId]
            );
        } else {
            return res.status(400).json({ success: false, error: "No pending update found" });
        }

        res.json({ success: true, message: "Contact information updated successfully" });

    } catch (error) {
        console.error("Verify OTP error:", error);
        res.status(500).json({ success: false, error: "Failed to verify OTP" });
    }
});

/**
 * @swagger
 * /settings/otp-preference:
 *   put:
 *     summary: Update transaction OTP preference
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - preference
 *             properties:
 *               preference:
 *                 type: string
 *                 enum: [email, sms, whatsapp, both]
 *     responses:
 *       200:
 *         description: Preference updated
 */
router.put("/otp-preference", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { preference } = req.body;

        if (!['email', 'sms', 'whatsapp', 'both'].includes(preference)) {
            return res.status(400).json({ success: false, error: "Invalid preference. Must be 'email', 'sms', 'whatsapp', or 'both'" });
        }

        // Validate availability of contact info for chosen preference
        const busRes = await query(`SELECT email, phone_number FROM businesses WHERE id = $1`, [businessId]);
        const business = busRes.rows[0];

        if ((preference === 'sms' || preference === 'whatsapp' || preference === 'both') && !business.phone_number) {
            return res.status(400).json({ success: false, error: "Phone number required for SMS or WhatsApp OTP" });
        }
        
        await query(
            `UPDATE businesses SET otp_preference = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [preference, businessId]
        );

        res.json({ success: true, message: "OTP preference updated" });

    } catch (error) {
        console.error("Update OTP preference error:", error);
        res.status(500).json({ success: false, error: "Failed to update OTP preference" });
    }
});

/**
 * @swagger
 * /settings/otp-preference:
 *   get:
 *     summary: Get transaction OTP preference
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current preference
 */
router.get("/otp-preference", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const result = await query(`SELECT otp_preference FROM businesses WHERE id = $1`, [businessId]);
        
        res.json({ success: true, preference: result.rows[0]?.otp_preference || 'email' });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch OTP preference" });
    }
});

// Transaction PIN endpoints
/**
 * @swagger
 * /settings/pin:
 *   post:
 *     summary: Create transaction PIN
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateTransactionPinInput'
 *     responses:
 *       200:
 *         description: PIN created successfully
 *       400:
 *         description: PIN already exists or invalid input
 */
router.post("/pin", authenticateToken, checkSubscriptionStatus, validateBody(CreateTransactionPinSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const { pin } = req.body;
    
    // Check if PIN already exists
    const existingPin = await query(
      `SELECT transaction_pin_hash FROM businesses WHERE id = $1`,
      [businessId]
    );
    
    if (existingPin.rows[0]?.transaction_pin_hash) {
      return res.status(400).json({ success: false, error: "PIN already exists. Use update endpoint instead." });
    }
    
    // Create PIN hash
    const pinHash = await hashPassword(pin);
    await query(
      `UPDATE businesses SET transaction_pin_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [pinHash, businessId]
    );
    
    res.json({ success: true, message: "Transaction PIN created successfully" });
  } catch (error) {
    console.error("Create PIN error:", error);
    res.status(500).json({ success: false, error: "Failed to create transaction PIN" });
  }
});

/**
 * @swagger
 * /settings/pin/send-otp:
 *   post:
 *     summary: Send OTP for PIN update
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *       500:
 *         description: Failed to send OTP
 */
router.post("/pin/send-otp", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const businessId = req.user!.businessId;

    // Get user email and business phone
    const userRes = await query(
      `SELECT email FROM users WHERE id = $1`,
      [userId]
    );

    const businessRes = await query(
      `SELECT phone FROM businesses WHERE id = $1`,
      [businessId]
    );

    const email = userRes.rows[0]?.email;
    const phone = businessRes.rows[0]?.phone;

    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        error: "No contact information available to send OTP"
      });
    }

    const otpCode = generateOTP();
    const otpExpiresAt = getOTPExpiry();

    // Store OTP
    await query(
      `UPDATE users SET otp_code = $1, otp_expires_at = $2, otp_type = 'pin_update' WHERE id = $3`,
      [otpCode, otpExpiresAt, userId]
    );

    // Send via email
    if (email) {
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #fff; border-radius: 8px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color: #1d4ed8; margin-bottom: 20px;">Update Your Transaction PIN</h2>
            <p style="color: #374151; line-height: 1.6;">
              Use this OTP to update your transaction PIN:
            </p>
            <div style="background: #f1f5f9; border-radius: 4px; padding: 15px; margin: 20px 0; text-align: center;">
              <h1 style="font-size: 32px; letter-spacing: 8px; margin: 0;">${otpCode}</h1>
            </div>
            <p style="color: #9ca3af; font-size: 14px; margin-top: 20px;">
              This OTP expires in 10 minutes.
            </p>
          </div>
        </div>
      `;

      await sendEmail(email, "OTP to Update Transaction PIN - MetricFlow", "Use this OTP to update your PIN", html);
    }

    // Send via SMS
    if (phone) {
      try {
        await sendSMS(phone, `Your MetricFlow OTP to update transaction PIN is: ${otpCode}`);
      } catch (smsErr) {
        console.error("SMS send error:", smsErr);
        // Continue even if SMS fails (email might have worked)
      }
    }

    res.json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error("Send PIN OTP error:", error);
    res.status(500).json({ success: false, error: "Failed to send OTP" });
  }
});

/**
 * @swagger
 * /settings/pin:
 *   put:
 *     summary: Update transaction PIN using OTP
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - newPin
 *               - otp
 *             properties:
 *               newPin:
 *                 type: string
 *                 description: New 4-digit PIN
 *               otp:
 *                 type: string
 *                 description: OTP sent to phone and email
 *     responses:
 *       200:
 *         description: PIN updated successfully
 *       400:
 *         description: Invalid OTP or invalid new PIN
 */
router.put("/pin", authenticateToken, checkSubscriptionStatus, validateBody(UpdateTransactionPinSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const userId = req.user!.userId;
    const { newPin, otp } = req.body;
    
    // Get current PIN hash and OTP
    const [userResult, businessResult] = await Promise.all([
      query(
        `SELECT otp_code, otp_expires_at, otp_type FROM users WHERE id = $1`,
        [userId]
      ),
      query(
        `SELECT transaction_pin_hash FROM businesses WHERE id = $1`,
        [businessId]
      )
    ]);
    
    const currentPinHash = businessResult.rows[0]?.transaction_pin_hash;
    const storedOtp = userResult.rows[0]?.otp_code;
    const otpExpiresAt = userResult.rows[0]?.otp_expires_at;
    const otpType = userResult.rows[0]?.otp_type;
    
    if (!currentPinHash) {
      return res.status(400).json({ success: false, error: "PIN not set. Create one first." });
    }

    if (!storedOtp || storedOtp !== otp) {
      return res.status(400).json({ success: false, error: "Invalid OTP" });
    }

    if (otpType !== "pin_update") {
      return res.status(400).json({ success: false, error: "Invalid OTP type" });
    }

    if (new Date(otpExpiresAt) < new Date()) {
      return res.status(400).json({ success: false, error: "OTP expired" });
    }
    
    // Update with new PIN
    const newPinHash = await hashPassword(newPin);
    await query(
      `UPDATE businesses SET transaction_pin_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [newPinHash, businessId]
    );

    // Clear OTP
    await query(
      `UPDATE users SET otp_code = NULL, otp_expires_at = NULL, otp_type = NULL WHERE id = $1`,
      [userId]
    );
    
    res.json({ success: true, message: "Transaction PIN updated successfully" });
  } catch (error) {
    console.error("Update PIN error:", error);
    res.status(500).json({ success: false, error: "Failed to update transaction PIN" });
  }
});

/**
 * @swagger
 * /settings/otp-enabled:
 *   put:
 *     summary: Toggle OTP requirement for transfers
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ToggleOtpInput'
 *     responses:
 *       200:
 *         description: OTP setting updated successfully
 */
router.put("/otp-enabled", authenticateToken, checkSubscriptionStatus, validateBody(ToggleOtpSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const { enabled } = req.body;
        
        await query(
            `UPDATE businesses SET otp_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [enabled, businessId]
        );
        
        res.json({ success: true, message: `OTP ${enabled ? 'enabled' : 'disabled'} successfully` });
    } catch (error) {
        console.error("Toggle OTP error:", error);
        res.status(500).json({ success: false, error: "Failed to update OTP setting" });
    }
});

/**
 * @swagger
 * /settings/otp-enabled:
 *   get:
 *     summary: Get OTP enabled status
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OTP status retrieved successfully
 */
router.get("/otp-enabled", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const result = await query(
            `SELECT otp_enabled, transaction_pin_hash FROM businesses WHERE id = $1`,
            [businessId]
        );
        
        res.json({
            success: true,
            otpEnabled: result.rows[0]?.otp_enabled ?? true,
            pinCreated: !!result.rows[0]?.transaction_pin_hash
        });
    } catch (error) {
        console.error("Get OTP status error:", error);
        res.status(500).json({ success: false, error: "Failed to get OTP status" });
    }
});

export default router;
