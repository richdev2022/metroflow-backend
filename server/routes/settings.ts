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
        const userId = req.user!.userId;
        // Modified to include phone_number and exclude created_at
        const result = await query(
            `SELECT b.id, b.name, b.email, b.phone_number, b.industry, b.logo_url, b.currency,
                    COALESCE(b.timezone, 'UTC') as timezone,
                    COALESCE(b.time_format, '24h') as time_format
             FROM businesses b WHERE b.id = $1`,
            [businessId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Business not found" });
        }

        // The caller's own profile + role so the UI can decide whether business
        // info is editable (owner/admin) or read-only (invited members).
        const meRes = await query(
            `SELECT id, name, email, phone_number, avatar_url as "avatarUrl", role, status,
                    salary_amount as "salaryAmount", salary_currency as "salaryCurrency",
                    job_title as "jobTitle", department,
                    bank_code as "bankCode", bank_name as "bankName", account_number as "accountNumber",
                    account_name as "accountName", verification_status as "verificationStatus",
                    verified_account_name as "verifiedAccountName"
             FROM users WHERE id = $1`,
            [userId]
        );

        res.json({ success: true, settings: result.rows[0], profile: meRes.rows[0] || null });
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
        const userId = req.user!.userId;
        const { currency, name, industry, logo_url, timezone, time_format } = req.body;

        // BUSINESS-level fields (name, currency, industry, logo, timezone,
        // time format) can only be changed by owner/admin. Invited members
        // see them read-only.
        const roleRes = await query(`SELECT role FROM users WHERE id = $1`, [userId]);
        const role = roleRes.rows[0]?.role;
        if (!['owner', 'admin'].includes(role)) {
            return res.status(403).json({
                success: false,
                error: "Only business owners and admins can change business settings. You can edit your personal profile below.",
                code: "BUSINESS_SETTINGS_FORBIDDEN",
            });
        }

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

        if (timezone) {
            // Basic IANA timezone shape validation (e.g. Africa/Lagos, UTC)
            if (!/^[A-Za-z_]+\/[A-Za-z0-9_+\-]+$/.test(timezone) && timezone !== 'UTC') {
                return res.status(400).json({ success: false, error: "Invalid timezone. Use an IANA timezone name (e.g. Africa/Lagos)." });
            }
            try {
                new Intl.DateTimeFormat('en-US', { timeZone: timezone });
            } catch (_) {
                return res.status(400).json({ success: false, error: "Unknown timezone" });
            }
            updates.push(`timezone = $${paramIdx}`);
            values.push(timezone);
            paramIdx++;
        }

        if (time_format) {
            const tf = String(time_format).toLowerCase();
            if (!['12h', '24h'].includes(tf)) {
                return res.status(400).json({ success: false, error: "Invalid time format. Use '12h' or '24h'." });
            }
            updates.push(`time_format = $${paramIdx}`);
            values.push(tf);
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
      `SELECT phone_number FROM businesses WHERE id = $1`,
      [businessId]
    );

    const email = userRes.rows[0]?.email;
    const phone = businessRes.rows[0]?.phone_number;

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

    // Deliver the OTP over every available channel; only fail when NO
    // channel succeeded (sendEmail resolves to false instead of throwing,
    // sendSMS throws on provider failure).
    let emailSent = false;
    let smsSent = false;

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
      emailSent = await sendEmail(email, "OTP to Update Transaction PIN - MetricFlow", "Use this OTP to update your PIN", html);
      if (!emailSent) console.error("PIN OTP email delivery failed");
    }

    if (phone) {
      try {
        await sendSMS(phone, `Your MetricFlow OTP to update transaction PIN is: ${otpCode}`);
        smsSent = true;
      } catch (smsErr) {
        console.error("PIN OTP SMS send error:", smsErr);
      }
    }

    if (!emailSent && !smsSent) {
      return res.status(500).json({ success: false, error: "Failed to send OTP via email and SMS" });
    }

    res.json({ success: true, message: "OTP sent successfully", channels: [...(emailSent ? ['email'] : []), ...(smsSent ? ['sms'] : [])] });
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
 * /settings/otp-enabled/send-otp:
 *   post:
 *     summary: Send an OTP that authorizes toggling OTP-for-transactions
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *       400:
 *         description: No contact information available
 *       500:
 *         description: Failed to send OTP
 */
router.post("/otp-enabled/send-otp", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const businessId = req.user!.businessId;

    const userRes = await query(
      `SELECT email FROM users WHERE id = $1`,
      [userId]
    );
    const businessRes = await query(
      `SELECT phone_number FROM businesses WHERE id = $1`,
      [businessId]
    );

    const email = userRes.rows[0]?.email;
    const phone = businessRes.rows[0]?.phone_number;

    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        error: "No contact information available to send OTP"
      });
    }

    const otpCode = generateOTP();
    const otpExpiresAt = getOTPExpiry();

    await query(
      `UPDATE users SET otp_code = $1, otp_expires_at = $2, otp_type = 'otp_toggle' WHERE id = $3`,
      [otpCode, otpExpiresAt, userId]
    );

    let emailSent = false;
    let smsSent = false;

    if (email) {
      const html = generateOtpEmailHtml(otpCode, "Confirm Transaction OTP Setting");
      emailSent = await sendEmail(
        email,
        "Confirm Transaction OTP Setting - MetricFlow",
        "Use this OTP to confirm your security setting change",
        html
      );
      if (!emailSent) console.error("OTP-toggle OTP email delivery failed");
    }

    if (phone) {
      try {
        await sendSMS(phone, `Your MetricFlow OTP to confirm your transaction OTP setting change is: ${otpCode}`);
        smsSent = true;
      } catch (smsErr) {
        console.error("OTP-toggle OTP SMS send error:", smsErr);
      }
    }

    if (!emailSent && !smsSent) {
      return res.status(500).json({ success: false, error: "Failed to send OTP via email and SMS" });
    }

    res.json({ success: true, message: "OTP sent successfully", channels: [...(emailSent ? ['email'] : []), ...(smsSent ? ['sms'] : [])] });
  } catch (error) {
    console.error("Send OTP-toggle OTP error:", error);
    res.status(500).json({ success: false, error: "Failed to send OTP" });
  }
});

/**
 * @swagger
 * /settings/otp-enabled:
 *   put:
 *     summary: Toggle OTP requirement for transfers (requires OTP confirmation)
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
 *       400:
 *         description: Missing/invalid/expired OTP
 */
router.put("/otp-enabled", authenticateToken, checkSubscriptionStatus, validateBody(ToggleOtpSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const businessId = req.user!.businessId;
    const { enabled, otp } = req.body;

    // Changing this setting is security-sensitive: an attacker (or a stolen
    // session) must not be able to silently strip the OTP layer off
    // transfers. Require a fresh OTP confirmation (otp_type 'otp_toggle')
    // before the flip is applied — mirrors the transaction PIN update flow.
    const userRes = await query(
      `SELECT otp_code, otp_expires_at, otp_type FROM users WHERE id = $1`,
      [userId]
    );
    const user = userRes.rows[0];

    if (!user?.otp_code || user.otp_type !== "otp_toggle") {
      return res.status(400).json({
        success: false,
        error: "OTP verification required. Please request an OTP first."
      });
    }
    if (user.otp_code !== otp) {
      return res.status(400).json({ success: false, error: "Invalid OTP" });
    }
    if (!user.otp_expires_at || new Date(user.otp_expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        error: "OTP expired. Please request a new one."
      });
    }

    await query(
      `UPDATE businesses SET otp_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [enabled, businessId]
    );

    // Consume the OTP so it cannot be replayed.
    await query(
      `UPDATE users SET otp_code = NULL, otp_expires_at = NULL, otp_type = NULL WHERE id = $1`,
      [userId]
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


// ============================================================================
// Personal profile (any role) - profile fields + avatar upload
// ============================================================================

import multer from "multer";
import path from "path";
import crypto from "crypto";

const AVATAR_MAX_MB = 100;

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_MB * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (/^image\/(png|jpe?g|webp|gif|avif|heic|heif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files (PNG, JPG, WEBP, GIF and similar) are allowed"));
  },
} as multer.Options);

/**
 * PUT /settings/profile
 * Update the CALLER'S OWN profile (any role): name, phone_number.
 * Business-level info lives in PUT /settings (owner/admin only).
 */
router.put("/profile", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const { name, phone_number } = req.body || {};

        const updates: string[] = [];
        const values: any[] = [];
        let idx = 1;
        if (name !== undefined) {
            const trimmed = String(name).trim();
            if (!trimmed) return res.status(400).json({ success: false, error: "Name cannot be empty" });
            updates.push(`name = $${idx}`); values.push(trimmed); idx++;
        }
        if (phone_number !== undefined) {
            updates.push(`phone_number = $${idx}`); values.push(String(phone_number).trim() || null); idx++;
        }
        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: "Nothing to update" });
        }

        const result = await query(
            `UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${idx}
             RETURNING id, name, email, phone_number, avatar_url as "avatarUrl", role`,
            [...values, userId]
        );

        res.json({ success: true, data: result.rows[0], message: "Profile updated" });
    } catch (error: any) {
        console.error("Update profile error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to update profile" });
    }
});

/**
 * POST /settings/profile/avatar (multipart field: 'file')
 * Upload a profile picture (R2 when configured, else local /uploads with an
 * absolute URL) and attach it to the caller's profile. Rendered in chat
 * avatars and profile pages; initials are shown when not set.
 */
router.post("/profile/avatar", authenticateToken, (req: AuthenticatedRequest, res) => {
    avatarUpload.single('file')(req as any, res as any, async (err: any) => {
        if (err) {
            const isTooLarge = err?.code === "LIMIT_FILE_SIZE";
            return res.status(isTooLarge ? 413 : 400).json({
                success: false,
                error: isTooLarge
                    ? `That image is too large — profile pictures are limited to ${AVATAR_MAX_MB} MB. Try a smaller image.`
                    : err.message || "Upload failed",
            });
        }
        try {
            const userId = req.user!.userId;
            const file = (req as any).file as Express.Multer.File | undefined;
            if (!file) {
                return res.status(400).json({ success: false, error: "file field is required" });
            }

            const { r2Storage } = await import("../lib/storage");
            let avatarUrl = '';
            if (r2Storage.isAvailable()) {
                try {
                    const ext = file.originalname.includes(".")
                        ? file.originalname.split(".").pop()!.toLowerCase()
                        : (file.mimetype.includes('png') ? 'png' : 'jpg');
                    const key = `avatars/${userId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
                    avatarUrl = await r2Storage.uploadFile(key, file.buffer, file.mimetype);
                } catch (uploadError) {
                    console.error("Avatar R2 upload failed, falling back to local:", uploadError);
                }
            }
            if (!avatarUrl) {
                const fs = await import("fs");
                const baseDir = process.cwd();
                const uploadDir = path.join(baseDir, "uploads");
                if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                const ext = file.originalname.includes(".")
                    ? file.originalname.split(".").pop()!.toLowerCase()
                    : (file.mimetype.includes('png') ? 'png' : 'jpg');
                const filename = `avatar-${userId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
                fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
                avatarUrl = `/uploads/${filename}`;
                // Absolute URL so mobile + chat render it directly
                const apiOrigin = process.env.API_PUBLIC_BASE_URL
                    || process.env.APP_BASE_URL
                    || 'https://api.metricorex.com';
                avatarUrl = `${apiOrigin.replace(/\/$/, '')}${avatarUrl}`;
            }

            const result = await query(
                `UPDATE users SET avatar_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2
                 RETURNING id, name, email, avatar_url as "avatarUrl"`,
                [avatarUrl, userId]
            );

            res.json({ success: true, data: result.rows[0], message: "Profile picture updated" });
        } catch (error: any) {
            console.error("Avatar upload error:", error);
            res.status(500).json({ success: false, error: error.message || "Failed to upload avatar" });
        }
    });
});

export default router;
