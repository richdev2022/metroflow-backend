import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../middleware/auth";
import { generateOTP, getOTPExpiry } from "../services/auth";
import { sendEmail, generateOtpEmailHtml } from "../services/email";
import { sendSMS } from "../services/sms";

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
 *                 enum: [email, sms, both]
 *     responses:
 *       200:
 *         description: Preference updated
 */
router.put("/otp-preference", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { preference } = req.body;

        if (!['email', 'sms', 'both'].includes(preference)) {
            return res.status(400).json({ success: false, error: "Invalid preference. Must be 'email', 'sms', or 'both'" });
        }

        // Validate availability of contact info for chosen preference
        const busRes = await query(`SELECT email, phone_number FROM businesses WHERE id = $1`, [businessId]);
        const business = busRes.rows[0];

        if ((preference === 'sms' || preference === 'both') && !business.phone_number) {
            return res.status(400).json({ success: false, error: "Phone number required for SMS OTP" });
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

export default router;
