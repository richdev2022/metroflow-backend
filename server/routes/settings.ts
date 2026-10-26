import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../middleware/auth";
import { generateOTP, getOTPExpiry, hashPassword, verifyPassword, hashOtp, otpMatches } from "../services/auth";
import { sendEmail, generateOtpEmailHtml } from "../services/email";
import { sendSMS } from "../services/sms";
import { validateBody } from "../middleware/validation";
import {
  CreateTransactionPinSchema,
  UpdateTransactionPinSchema,
  ToggleOtpSchema,
} from "../lib/validation";
import { isBusinessOwner } from "../lib/transaction-pin";
import { claimPhoneForCaller } from "../lib/phone-identity";

const router = express.Router();

/**
 * Guard used by the BUSINESS contact-change flow (email/phone): only the
 * business OWNER may move the company's contact details. Invited admins and
 * managers must keep their own contact details on their personal profile
 * (PUT /settings/profile, /settings/profile/phone/*, /settings/profile/email/*)
 * so one invited member can never hijack the business identity.
 */
async function requireBusinessOwnerForContact(req: AuthenticatedRequest): Promise<{ ok: boolean; status?: number; body?: Record<string, unknown> }> {
    const requesterId = req.user!.userId;
    const { isOwner, isPersonalSpace } = await isBusinessOwner(requesterId);
    if (!isOwner && !isPersonalSpace) {
        return {
            ok: false,
            status: 403,
            body: {
                success: false,
                error: "Only the business owner can change the business email or phone number. Invited members manage their own contact details from their personal profile instead.",
                code: "BUSINESS_SETTINGS_FORBIDDEN",
            },
        };
    }
    return { ok: true };
}

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
                    COALESCE(b.time_format, '24h') as time_format,
                    (b.transaction_pin_hash IS NOT NULL) as "legacyBusinessPinSet"
             FROM businesses b WHERE b.id = $1`,
            [businessId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Business not found" });
        }

        // The caller's own profile + role so the UI can decide whether business
        // info is editable (owner) or read-only (invited members), plus the
        // caller's own per-user PIN state.
        const meRes = await query(
            `SELECT id, name, email, phone_number, avatar_url as "avatarUrl", role, status,
                    salary_amount as "salaryAmount", salary_currency as "salaryCurrency",
                    job_title as "jobTitle", department,
                    bank_code as "bankCode", bank_name as "bankName", account_number as "accountNumber",
                    account_name as "accountName", verification_status as "verificationStatus",
                    verified_account_name as "verifiedAccountName",
                    referral_code as "referralCode",
                    username, bio, COALESCE(account_privacy, 'public') as "accountPrivacy",
                    (transaction_pin_hash IS NOT NULL) as "transactionPinSet"
             FROM users WHERE id = $1`,
            [userId]
        );

        // Owner resolution: the businesses row points at the caller, or their
        // role says owner. Invited admins NEVER pass this check.
        const { isOwner } = await isBusinessOwner(userId);
        const profile = meRes.rows[0] || null;
        if (profile) profile.isOwner = isOwner;

        // IDENTITY SEPARATION (hard backend guarantee): invited users must
        // NEVER receive the business contact details (email/phone) — their
        // profile pages render ONLY their own identity, so even a client bug
        // can never leak the company email/phone onto an invited user's
        // profile. Business contact fields are delivered to the business
        // OWNER (the admin who registered the account) only. App-wide
        // preferences the UI needs (currency/timezone/time_format) remain
        // available to everyone.
        const canSeeBusinessContact = isOwner;
        const settings = { ...result.rows[0] };
        if (!canSeeBusinessContact) {
            delete settings.email;
            delete settings.phone_number;
        }

        res.json({
            success: true,
            settings,
            profile,
        });
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
        // time format) are the company's identity — OWNER-ONLY (per-user
        // identity model). Invited admins/managers see them read-only and
        // manage their own profile instead.
        const { isOwner, isPersonalSpace } = await isBusinessOwner(userId);
        if (!isOwner && !isPersonalSpace) {
            return res.status(403).json({
                success: false,
                error: "Only the business owner can change business settings. You can edit your personal profile below.",
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

// Multipart storage for the SSO profile-completion logo upload (R2 when
// configured, local /uploads fallback — mirrors POST /settings/profile/avatar).
const completeLogoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

/**
 * POST /settings/business/complete (multipart: logo optional, field 'logo')
 * One-call SSO onboarding completion: business name, industry, phone number
 * and logo. Owner/admin only. Returns the recomputed profileCompleted flag so
 * the client knows whether the gate is cleared.
 */
router.post("/business/complete", authenticateToken, checkSubscriptionStatus, completeLogoUpload.single('logo'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const userId = req.user!.userId;

        // OWNER-ONLY: completing/updating the business profile is reserved for
        // the admin user who REGISTERED the account (businesses.owner_id).
        // Invited admins and members manage their own profile instead.
        const { isOwner: isCompleterOwner, isPersonalSpace: completerPersonal } = await isBusinessOwner(userId);
        if (!isCompleterOwner && !completerPersonal) {
            return res.status(403).json({
                success: false,
                error: "Only the business owner who registered this account can update the business profile. Invited members manage their own profile instead.",
                code: "BUSINESS_SETTINGS_FORBIDDEN",
            });
        }

        const { name, industry, phone_number } = req.body || {};
        const updates: string[] = [];
        const values: any[] = [];
        let idx = 1;

        const trimmedName = String(name || '').trim();
        if (!trimmedName) {
            return res.status(400).json({ success: false, error: "Business name is required" });
        }
        if (/'s workspace$/i.test(trimmedName)) {
            return res.status(400).json({
                success: false,
                error: "Please enter your real business name (not the auto-generated placeholder)",
            });
        }
        updates.push(`name = $${idx}`); values.push(trimmedName); idx++;

        const trimmedIndustry = String(industry || '').trim();
        if (!trimmedIndustry) {
            return res.status(400).json({ success: false, error: "Industry is required" });
        }
        updates.push(`industry = $${idx}`); values.push(trimmedIndustry); idx++;

        const trimmedPhone = String(phone_number || '').trim();
        if (!trimmedPhone) {
            return res.status(400).json({ success: false, error: "Phone number is required" });
        }
        updates.push(`phone_number = $${idx}`); values.push(trimmedPhone); idx++;

        // Logo (optional but REQUIRED to clear the gate — it is part of the
        // completion checklist) — accept the multipart upload, or a
        // logo_url string the client already uploaded elsewhere.
        const file = (req as any).file as Express.Multer.File | undefined;
        let logoUrl: string | null = null;
        if (file?.buffer) {
            const { r2Storage } = await import("../lib/storage");
            if (r2Storage.isAvailable()) {
                try {
                    const ext = file.originalname.includes(".")
                        ? file.originalname.split(".").pop()!.toLowerCase()
                        : (file.mimetype.includes('png') ? 'png' : 'jpg');
                    const key = `logos/${businessId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
                    logoUrl = await r2Storage.uploadFile(key, file.buffer, file.mimetype);
                } catch (uploadError) {
                    console.error("Business logo R2 upload failed, falling back to local:", uploadError);
                }
            }
            if (!logoUrl) {
                const fs = await import("fs");
                const uploadDir = path.join(process.cwd(), "uploads");
                if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                const ext = file.originalname.includes(".")
                    ? file.originalname.split(".").pop()!.toLowerCase()
                    : (file.mimetype.includes('png') ? 'png' : 'jpg');
                const filename = `logo-${businessId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
                fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
                const apiOrigin = process.env.API_PUBLIC_BASE_URL
                    || process.env.APP_BASE_URL
                    || 'https://api.metricorex.com';
                logoUrl = `${apiOrigin.replace(/\/$/, '')}/uploads/${filename}`;
            }
        } else if (String((req.body as any).logo_url || '').trim()) {
            logoUrl = String((req.body as any).logo_url).trim();
        }
        if (!logoUrl) {
            return res.status(400).json({ success: false, error: "Business logo is required" });
        }
        updates.push(`logo_url = $${idx}`); values.push(logoUrl); idx++;

        values.push(businessId);
        await query(
            `UPDATE businesses SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`,
            values
        );

        const { computeBusinessProfileCompleted } = await import("./auth");
        const profileCompleted = await computeBusinessProfileCompleted(businessId);

        res.json({
            success: true,
            data: { profileCompleted, logoUrl },
            message: "Business profile completed",
        });
    } catch (error: any) {
        console.error("Business complete error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to complete business profile" });
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

        // BUSINESS contact details (email/phone) are the company's identity —
        // ONLY the business owner may change them (per-user identity model).
        // Invited admins/managers edit their OWN profile via /settings/profile*.
        const ownerGuard = await requireBusinessOwnerForContact(req);
        if (!ownerGuard.ok) {
            return res.status(ownerGuard.status).json(ownerGuard.body);
        }

        if (!type || !value) {
            return res.status(400).json({ success: false, error: "Type and value are required" });
        }

        if (!['email', 'phone'].includes(type)) {
            return res.status(400).json({ success: false, error: "Type must be 'email' or 'phone'" });
        }

        const otpCode = generateOTP();
        const otpExpiresAt = getOTPExpiry();

        // Duplicate protection BEFORE storing/sending the OTP: reject contact
        // details that already belong to another business (email is DB-unique;
        // phones are app-enforced) or another user's profile phone.
        // PHONE IS IDENTITY-AWARE: the caller's own rows (same email across the
        // Personal/Business apps) never block, unverified sign-ups never squat,
        // and a number still held by another business of the SAME owner is
        // released automatically so the owner can move their number.
        const contactValue = String(value).trim();
        if (type === 'email') {
            const emailDupe = await query(
                `SELECT id FROM businesses WHERE email = $1 AND id <> $2 LIMIT 1`,
                [contactValue, businessId],
            );
            if (emailDupe.rows.length > 0) {
                return res.status(409).json({
                    success: false,
                    error: "This email is already in use by another business. Please use a different email.",
                    code: "EMAIL_ALREADY_EXISTS",
                });
            }
        } else if (type === 'phone') {
            const meRes = await query(`SELECT email FROM users WHERE id = $1`, [req.user!.userId]);
            const availability = await claimPhoneForCaller(contactValue, {
                userId: req.user!.userId,
                email: meRes.rows[0]?.email || '',
            });
            if (!availability.ok) {
                return res.status(409).json({
                    success: false,
                    error: availability.error,
                    code: availability.code,
                    heldBy: availability.heldBy,
                });
            }
        }

        if (type === 'email') {
            // Update DB with temp email and OTP (VAPT MF-012: OTP stored hashed)
            await query(
                `UPDATE businesses 
                 SET temp_email = $1, otp_code = $2, otp_expires_at = $3, temp_phone = NULL
                 WHERE id = $4`,
                [value, hashOtp(otpCode), otpExpiresAt, businessId]
            );

            // Send Email
            const emailHtml = generateOtpEmailHtml(otpCode, "Verify New Business Email");
            await sendEmail(value, "Business Admin", "Verify New Business Email", emailHtml);

        } else if (type === 'phone') {
            // Update DB with temp phone and OTP (VAPT MF-012: OTP stored hashed)
            await query(
                `UPDATE businesses 
                 SET temp_phone = $1, otp_code = $2, otp_expires_at = $3, temp_email = NULL
                 WHERE id = $4`,
                [value, hashOtp(otpCode), otpExpiresAt, businessId]
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

        // Same OWNER-ONLY gate as the request step — an invited member must
        // not be able to complete a queued business contact change.
        const verifierId = req.user!.userId;
        const ownerGuard = await requireBusinessOwnerForContact(req);
        if (!ownerGuard.ok) {
            return res.status(ownerGuard.status).json(ownerGuard.body);
        }

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

        // VAPT MF-012: hashed-OTP compare
        if (!otp_code || !otpMatches(otp, otp_code)) {
            return res.status(400).json({ success: false, error: "Invalid OTP" });
        }

        if (new Date(otp_expires_at) < new Date()) {
            return res.status(400).json({ success: false, error: "OTP expired" });
        }

        // Perform update — re-check duplicates first (the requested value was
        // stored as temp_* when the OTP was requested; another account may
        // have taken it in the meantime).
        if (temp_email) {
            const dupe = await query(
                `SELECT id FROM businesses WHERE email = $1 AND id <> $2 LIMIT 1`,
                [temp_email, businessId],
            );
            if (dupe.rows.length > 0) {
                return res.status(409).json({
                    success: false,
                    error: "This email is already in use by another business. Please use a different email.",
                    code: "EMAIL_ALREADY_EXISTS",
                });
            }
            await query(
                `UPDATE businesses 
                 SET email = temp_email, temp_email = NULL, otp_code = NULL, otp_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [businessId]
            );
        } else if (temp_phone) {
            // Identity-aware re-check at commit time (another account may have
            // taken the number while the OTP was pending).
            const verifierMe = await query(`SELECT email FROM users WHERE id = $1`, [verifierId]);
            const availability = await claimPhoneForCaller(temp_phone, {
                userId: verifierId,
                email: verifierMe.rows[0]?.email || '',
            });
            if (!availability.ok) {
                return res.status(409).json({
                    success: false,
                    error: availability.error,
                    code: availability.code,
                    heldBy: availability.heldBy,
                });
            }
            await query(
                `UPDATE businesses 
                 SET phone_number = temp_phone, temp_phone = NULL, otp_code = NULL, otp_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [businessId]
            );
            // CROSS-APP PHONE SYNC: this number was just OTP-verified at the
            // business level, so it is verified for the Personal app too —
            // mark every member of the business who uses this number as
            // phone_verified, and seed it onto the verifying admin's personal
            // profile when they don't have a personal number yet.
            //
            // The contact commit above is the source of truth — the sync below
            // is DENORMALIZATION. It must never turn a completed verification
            // into a 500 (that is the "phone was actually added but the app
            // said Failed to verify OTP" class of bug), so each statement is
            // individually fault-isolated.
            const commitTime = temp_phone; // captured before any await below
            try {
                await query(
                    `UPDATE users SET phone_verified = TRUE, updated_at = CURRENT_TIMESTAMP
                     WHERE business_id = $1 AND phone_number = $2 AND COALESCE(phone_verified, FALSE) = FALSE`,
                    [businessId, commitTime]
                );
            } catch (syncErr) {
                console.error("Business contact cross-app sync (members) skipped:", syncErr);
            }
            try {
                await query(
                    `UPDATE users SET phone_number = $2, phone_verified = TRUE, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $3 AND (phone_number IS NULL OR phone_number = '')`,
                    [businessId, commitTime, verifierId]
                );
            } catch (syncErr) {
                console.error("Business contact cross-app sync (verifier) skipped:", syncErr);
            }
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
        // OWNER-ONLY: the transfer-OTP preference is a business-wide security
        // policy. An invited member (admin or not) must never be able to
        // change how the company's transaction OTPs are delivered.
        const guard = await requireBusinessOwnerForContact(req);
        if (!guard.ok) return res.status(guard.status!).json(guard.body);

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
    const businessId = req.user!.businessId || null;
    const userId = req.user!.userId;
    const { pin } = req.body;

    // PER-USER PIN: every member — owner or invited — stores the PIN on their
    // OWN user row. No shared business PIN for new creation anymore.
    const existingUserPin = await query(
      `SELECT transaction_pin_hash FROM users WHERE id = $1`,
      [userId]
    );
    if (existingUserPin.rows[0]?.transaction_pin_hash) {
      return res.status(400).json({ success: false, error: "PIN already exists. Use update endpoint instead." });
    }

    const pinHash = await hashPassword(pin);
    await query(`UPDATE users SET transaction_pin_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [pinHash, userId]);

    // Legacy parity: when the business OWNER creates their PIN, also seed the
    // shared business hash so older clients and legacy verify paths stay in
    // step with the owner's PIN. Invited members only ever touch their own.
    if (businessId) {
      const { isOwner } = await isBusinessOwner(userId);
      if (isOwner) {
        await query(
          `UPDATE businesses SET transaction_pin_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [pinHash, businessId]
        );
      }
    }

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
    const businessId = req.user!.businessId || null;

    // PER-USER PIN: the OTP is delivered to the CALLER'S OWN contact points —
    // their account email and their own profile phone. Never to the shared
    // business phone (an invited member must not be able to intercept the
    // owner's PIN OTP, and vice versa).
    const userRes = await query(
      `SELECT email, phone_number FROM users WHERE id = $1`,
      [userId]
    );

    const email = userRes.rows[0]?.email;
    const phone = userRes.rows[0]?.phone_number || null;

    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        error: "No contact information available to send OTP"
      });
    }

    const otpCode = generateOTP();
    const otpExpiresAt = getOTPExpiry();

    // Store OTP (VAPT MF-012: hashed at rest)
    await query(
      `UPDATE users SET otp_code = $1, otp_expires_at = $2, otp_type = 'pin_update' WHERE id = $3`,
      [hashOtp(otpCode), otpExpiresAt, userId]
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
    const businessId = req.user!.businessId || null;
    const userId = req.user!.userId;
    const { newPin, otp } = req.body;

    // PER-USER PIN UPDATE: the new hash goes onto the CALLER'S OWN row.
    // Works when the caller has a personal PIN OR only the legacy shared
    // business PIN (pre-rollout) — both count as "a PIN exists".
    const u = await query(
      `SELECT otp_code, otp_expires_at, otp_type, transaction_pin_hash FROM users WHERE id = $1`,
      [userId]
    );
    const userRow = u.rows[0];
    if (!userRow) return res.status(404).json({ success: false, error: "User not found" });

    if (!userRow.transaction_pin_hash && businessId) {
      const legacy = await query(
        `SELECT transaction_pin_hash FROM businesses WHERE id = $1`,
        [businessId]
      );
      if (!legacy.rows[0]?.transaction_pin_hash) {
        return res.status(400).json({ success: false, error: "PIN not set. Create one first." });
      }
    } else if (!userRow.transaction_pin_hash) {
      return res.status(400).json({ success: false, error: "PIN not set. Create one first." });
    }

    // OTP gate (VAPT MF-012: hashed-OTP compare). Required whenever one was
    // requested via /pin/send-otp; type must be 'pin_update'.
    if (userRow.otp_code) {
      if (!otp) return res.status(400).json({ success: false, error: "OTP is required to update your PIN" });
      if (!otpMatches(otp, userRow.otp_code)) return res.status(400).json({ success: false, error: "Invalid OTP" });
      if (userRow.otp_type && userRow.otp_type !== "pin_update") {
        return res.status(400).json({ success: false, error: "Invalid OTP type" });
      }
      if (userRow.otp_expires_at && new Date(userRow.otp_expires_at) < new Date()) {
        return res.status(400).json({ success: false, error: "OTP has expired" });
      }
    } else if (otp) {
      return res.status(400).json({ success: false, error: "No OTP was requested" });
    }

    const newHash = await hashPassword(newPin);
    await query(
      `UPDATE users SET transaction_pin_hash = $1, otp_code = NULL, otp_expires_at = NULL, otp_type = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [newHash, userId]
    );

    // Legacy parity: the OWNER's new PIN re-seeds the shared business hash so
    // legacy clients and legacy verify paths stay consistent. Invited members
    // only ever change their own PIN — never the business's.
    if (businessId) {
      const { isOwner } = await isBusinessOwner(userId);
      if (isOwner) {
        await query(
          `UPDATE businesses SET transaction_pin_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [newHash, businessId]
        );
      }
    }

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
    // OWNER-ONLY: toggling the business-wide transfer-OTP requirement is a
    // security-policy change reserved for the business owner. The confirmation
    // OTP is delivered to the CALLER'S OWN contact points (their email and
    // their own profile phone) — never to the shared business phone.
    const guard = await requireBusinessOwnerForContact(req);
    if (!guard.ok) return res.status(guard.status!).json(guard.body);

    const userId = req.user!.userId;

    const userRes = await query(
      `SELECT email, phone_number FROM users WHERE id = $1`,
      [userId]
    );

    const email = userRes.rows[0]?.email;
    const phone = userRes.rows[0]?.phone_number || null;

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
      [hashOtp(otpCode), otpExpiresAt, userId] // VAPT MF-012: hashed at rest
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
    // OWNER-ONLY: this flips the BUSINESS-wide transfer-OTP requirement. An
    // invited member (even an admin) must never be able to strip the OTP
    // layer off the company's transfers.
    const guard = await requireBusinessOwnerForContact(req);
    if (!guard.ok) return res.status(guard.status!).json(guard.body);

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
    // VAPT MF-012: hashed-OTP compare
    if (!otpMatches(otp, user.otp_code)) {
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
        const userId = req.user!.userId;
        // PER-USER PIN: "pinCreated" now reflects the CALLER'S own PIN, with the
        // legacy shared business PIN as fallback so pre-rollout users keep
        // seeing their existing PIN as set.
        //
        // PERSONAL ACCOUNTS (businessId IS NULL): the businesses join matches no
        // row, which used to force otpEnabled=true and silently HIDE the user's
        // own PIN (pinCreated=false) — that dead-end blocked every personal
        // transfer behind an OTP flow that could never be completed. Personal
        // accounts have no business-level OTP policy, so OTP is simply off and
        // the per-user PIN alone decides pinCreated.
        if (!businessId) {
            const personal = await query(
                `SELECT (transaction_pin_hash IS NOT NULL) AS user_pin FROM users WHERE id = $1`,
                [userId]
            );
            return res.json({
                success: true,
                otpEnabled: false,
                pinCreated: !!personal.rows[0]?.user_pin
            });
        }
        const result = await query(
            `SELECT b.otp_enabled,
                    (b.transaction_pin_hash IS NOT NULL) AS business_pin,
                    (u.transaction_pin_hash IS NOT NULL) AS user_pin
             FROM businesses b CROSS JOIN (SELECT transaction_pin_hash FROM users WHERE id = $2) u
             WHERE b.id = $1`,
            [businessId, userId]
        );

        // PER-USER PIN: "pinCreated" reflects ONLY the caller's own PIN. The
        // legacy shared business hash must NOT leak the owner's PIN state to
        // invited members (each user manages their own PIN separately).
        const { isOwner } = await isBusinessOwner(userId);
        res.json({
            success: true,
            otpEnabled: result.rows[0]?.otp_enabled ?? true,
            pinCreated: !!(result.rows[0]?.user_pin || (isOwner && result.rows[0]?.business_pin))
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
 * EMAIL IS DELIBERATELY NOT ACCEPTED — it is read-only in the first-login
 * profile prompt (SSO or password) and can never be changed here.
 * Any successful save marks the personal profile as COMPLETED and dismisses
 * the first-login prompt. Changing the phone number re-opens verification.
 * Business-level info lives in PUT /settings (owner/admin only).
 */
router.put("/profile/privacy", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const privacy = String(req.body?.privacy || "").toLowerCase();
        if (!["public", "private"].includes(privacy)) {
            return res.status(400).json({ success: false, error: "privacy must be 'public' or 'private'" });
        }
        await query(
            `UPDATE users SET account_privacy = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [userId, privacy],
        );
        res.json({ success: true, data: { accountPrivacy: privacy } });
    } catch {
        res.status(500).json({ success: false, error: "Could not update privacy" });
    }
});

router.put("/profile", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const { name, phone_number, username, bio } = req.body || {};

        const updates: string[] = [];
        const values: any[] = [];
        let idx = 1;
        if (name !== undefined) {
            const trimmed = String(name).trim();
            if (!trimmed) return res.status(400).json({ success: false, error: "Name cannot be empty" });
            updates.push(`name = $${idx}`); values.push(trimmed); idx++;
        }
        if (phone_number !== undefined) {
            // Sanitize: some clients send the literal strings "null"/"undefined"
            // (or empty) — all of those mean "no phone", never a real value.
            const rawPhone = String(phone_number).trim();
            const phone = !rawPhone || ['null', 'undefined'].includes(rawPhone.toLowerCase()) ? null : rawPhone;

            // IDENTITY-AWARE duplicate protection: a phone may only belong to
            // ONE identity — but the caller's own rows (same email across the
            // Personal/Business apps) never block, unverified sign-ups never
            // squat, and numbers held by the caller's own other businesses are
            // released automatically.
            //
            // VERIFIED-PHONE PRESERVATION: when the submitted phone equals the
            // caller's CURRENT phone, the claim check and the verified flag
            // are left untouched. Saving the profile must never silently strip
            // a verification the user already completed via the OTP flow.
            let phoneWasVerified = false;
            if (phone) {
                const me = await query(`SELECT email, phone_number, COALESCE(phone_verified, FALSE) AS phone_verified FROM users WHERE id = $1`, [userId]);
                if (me.rows[0]?.phone_number && phone === String(me.rows[0].phone_number).trim()) {
                    phoneWasVerified = !!me.rows[0].phone_verified;
                } else {
                    const availability = await claimPhoneForCaller(phone, {
                        userId,
                        email: me.rows[0]?.email || '',
                    });
                    if (!availability.ok) {
                        return res.status(409).json({
                            success: false,
                            error: availability.error,
                            code: availability.code,
                            heldBy: availability.heldBy,
                        });
                    }
                }
            }

            updates.push(`phone_number = $${idx}`); values.push(phone); idx++;
            // A hand-typed phone number is UNVERIFIED until confirmed via the
            // phone-verify OTP flow — EXCEPT the number that was already
            // verified and is being re-saved unchanged (see above).
            updates.push(`phone_verified = ${phone ? phoneWasVerified ? 'TRUE' : 'FALSE' : 'FALSE'}`);
        }
        if (username !== undefined) {
            // TikTok-style handle for shareable profile links (/u/:username).
            const handle = String(username).trim().toLowerCase();
            if (handle) {
                if (!/^[a-z0-9._]{3,32}$/.test(handle)) {
                    return res.status(400).json({
                        success: false,
                        error: "Username must be 3-32 characters — letters, numbers, dots or underscores.",
                        code: "INVALID_USERNAME",
                    });
                }
                const taken = await query(
                    `SELECT id FROM users WHERE LOWER(username) = $1 AND id <> $2 LIMIT 1`,
                    [handle, userId],
                );
                if (taken.rows.length > 0) {
                    return res.status(409).json({ success: false, error: "That username is already taken.", code: "USERNAME_TAKEN" });
                }
                updates.push(`username = $${idx}`); values.push(handle); idx++;
            } else {
                updates.push(`username = NULL`); // clearing the handle
            }
        }
        if (bio !== undefined) {
            updates.push(`bio = $${idx}`); values.push(String(bio).slice(0, 300)); idx++;
        }
        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: "Nothing to update" });
        }
        // Completing the personal profile also permanently dismisses the
        // first-login prompt (skip + complete both stop the nagging).
        updates.push(`profile_completed = TRUE`);
        updates.push(`profile_prompt_dismissed = TRUE`);

        const result = await query(
            `UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${idx}
             RETURNING id, name, email, phone_number, avatar_url as "avatarUrl", role,
                       COALESCE(phone_verified, FALSE) as "phoneVerified", username, bio`,
            [...values, userId]
        );

        res.json({ success: true, data: result.rows[0], message: "Profile updated" });
    } catch (error: any) {
        console.error("Update profile error:", error);
        if (error?.code === "23505") {
            return res.status(409).json({
                success: false,
                error: "This phone number is already in use by another account.",
                code: "PHONE_ALREADY_EXISTS",
            });
        }
        res.status(500).json({ success: false, error: "Failed to update profile" });
    }
});

/**
 * POST /settings/profile/phone/send-otp
 * First-login personal profile completion: send a 6-digit OTP to the phone
 * number the user wants to verify. Reuses users.otp_hash/otp_type with the
 * dedicated 'phone_verify' type so it never collides with PIN/transfer OTPs.
 * Body: { phone }
 */
router.post("/profile/phone/send-otp", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const phone = String(req.body?.phone || "").trim();
        if (!phone || phone.replace(/\D/g, "").length < 7) {
            return res.status(400).json({ success: false, error: "A valid phone number is required" });
        }

        const otpCode = generateOTP();
        const otpExpiresAt = getOTPExpiry();
        const otpHash = crypto.createHash("sha256").update(otpCode).digest("hex");
        await query(
            `UPDATE users SET otp_hash = $1, otp_expires_at = $2, otp_type = 'phone_verify', updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [otpHash, otpExpiresAt, userId],
        );

        let smsSent = false;
        let smsError: string | null = null;
        try {
            await sendSMS(phone, `Your Metricorex verification code is: ${otpCode}. Valid for 10 minutes.`);
            smsSent = true;
        } catch (e: any) {
            smsError = e?.message || "SMS delivery failed";
            console.error("Profile phone OTP SMS failed:", smsError);
        }

        if (!smsSent) {
            return res.status(502).json({
                success: false,
                error: smsError || "Failed to send verification SMS. Please try again.",
            });
        }

        res.json({ success: true, message: `Verification code sent to ${phone}` });
    } catch (error: any) {
        console.error("Profile phone send-otp error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to send OTP" });
    }
});

/**
 * POST /settings/profile/phone/verify-otp
 * Verify the OTP sent to the user's phone. On success the phone number is
 * committed, phone_verified flips TRUE and the personal profile is marked
 * complete. Body: { phone, otp }
 */
router.post("/profile/phone/verify-otp", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const phone = String(req.body?.phone || "").trim();
        const otp = String(req.body?.otp || "").trim();
        if (!phone || !otp) {
            return res.status(400).json({ success: false, error: "Phone number and OTP are required" });
        }

        const userRes = await query(
            `SELECT otp_hash, otp_expires_at, otp_type, phone_number, COALESCE(phone_verified, FALSE) AS phone_verified FROM users WHERE id = $1`,
            [userId],
        );
        const user = userRes.rows[0];

        // IDEMPOTENT RETRY GUARD: a double-tap (or a flaky retry after a
        // dropped response) lands here AFTER the first request already
        // committed and cleared the OTP. If the requested phone matches what
        // was just verified, return success instead of a confusing
        // "no code was sent" error — the phone IS verified.
        if ((!user?.otp_hash || user.otp_type !== "phone_verify")
            && user?.phone_number && String(user.phone_number).trim() === phone && user.phone_verified) {
            return res.json({
                success: true,
                data: { phone_number: user.phone_number, phoneVerified: true },
                message: "Phone number verified",
            });
        }

        if (!user?.otp_hash || user.otp_type !== "phone_verify") {
            return res.status(400).json({ success: false, error: "No verification code was sent to this phone. Please request a new one." });
        }
        if (new Date(user.otp_expires_at) < new Date()) {
            return res.status(400).json({ success: false, error: "Verification code has expired. Please request a new one." });
        }
        const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
        if (otpHash !== user.otp_hash) {
            return res.status(400).json({ success: false, error: "Invalid verification code" });
        }

        // Identity-aware conflict re-check at commit time (another account may
        // have claimed the number after the code was sent).
        const me = await query(`SELECT email FROM users WHERE id = $1`, [userId]);
        const availability = await claimPhoneForCaller(phone, {
            userId,
            email: me.rows[0]?.email || '',
        });
        if (!availability.ok) {
            return res.status(409).json({
                success: false,
                error: availability.error,
                code: availability.code,
                heldBy: availability.heldBy,
            });
        }

        const result = await query(
            `UPDATE users
             SET phone_number = $1, phone_verified = TRUE, profile_completed = TRUE, profile_prompt_dismissed = TRUE,
                 otp_hash = NULL, otp_expires_at = NULL, otp_type = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING id, name, email, phone_number, avatar_url as "avatarUrl", role, phone_verified as "phoneVerified"`,
            [phone, userId],
        );

        res.json({ success: true, data: result.rows[0], message: "Phone number verified" });
    } catch (error: any) {
        console.error("Profile phone verify-otp error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to verify phone" });
    }
});

/**
 * POST /settings/profile/email/send-otp
 * Request the verification code for changing the CALLER'S OWN email address
 * (any role — this is the user's personal contact detail, NOT the business
 * email which stays owner/admin-only via /settings/update-contact).
 * Flow mirrors /profile/phone/*: 6-digit code, hashed at rest (VAPT MF-012),
 * staged in users.temp_email until /profile/email/verify-otp commits it.
 */
router.post("/profile/email/send-otp", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const email = String(req.body?.email || "").trim().toLowerCase();
        if (!email) {
            return res.status(400).json({ success: false, error: "New email address is required" });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
            return res.status(400).json({ success: false, error: "Please enter a valid email address" });
        }

        // Duplicate protection: the new email must not belong to another user
        // or to any business (business emails are unique keys too).
        const userDupe = await query(
            `SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1`,
            [email, userId],
        );
        const bizDupe = await query(
            `SELECT id FROM businesses WHERE LOWER(email) = $1 LIMIT 1`,
            [email],
        );
        if (userDupe.rows.length > 0 || bizDupe.rows.length > 0) {
            return res.status(409).json({
                success: false,
                error: "This email is already in use by another account. Please use a different email.",
                code: "EMAIL_ALREADY_EXISTS",
            });
        }

        const otpCode = generateOTP();
        const otpExpiresAt = getOTPExpiry();
        await query(
            `UPDATE users
             SET temp_email = $1, otp_hash = $2, otp_expires_at = $3, otp_type = 'email_verify', updated_at = CURRENT_TIMESTAMP
             WHERE id = $4`,
            [email, hashOtp(otpCode), otpExpiresAt, userId],
        );

        const emailHtml = generateOtpEmailHtml(otpCode, "Verify Your New Email");
        await sendEmail(email, "Metricorex User", "Verify Your New Email", emailHtml);

        res.json({ success: true, message: `Verification code sent to ${email}` });
    } catch (error: any) {
        console.error("Profile email send-otp error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to send the verification code" });
    }
});

/**
 * POST /settings/profile/email/verify-otp
 * Verify the code and commit the email change. users.email is the login
 * identity, so the whole change is OTP-gated and the new address is
 * re-checked for collisions at commit time.
 */
router.post("/profile/email/verify-otp", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const otp = String(req.body?.otp || "").trim();
        if (!otp) {
            return res.status(400).json({ success: false, error: "Verification code is required" });
        }

        const userRes = await query(
            `SELECT temp_email, otp_hash, otp_expires_at, otp_type FROM users WHERE id = $1`,
            [userId],
        );
        const user = userRes.rows[0];
        if (!user?.otp_hash || user.otp_type !== "email_verify" || !user.temp_email) {
            return res.status(400).json({ success: false, error: "No email change was requested. Please request a new code." });
        }
        if (new Date(user.otp_expires_at) < new Date()) {
            return res.status(400).json({ success: false, error: "Verification code has expired. Please request a new one." });
        }
        const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
        if (otpHash !== user.otp_hash) {
            return res.status(400).json({ success: false, error: "Invalid verification code" });
        }

        // Re-check duplicates at commit time (another account may have taken
        // the address while the code was in flight).
        const userDupe = await query(
            `SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1`,
            [user.temp_email, userId],
        );
        const bizDupe = await query(
            `SELECT id FROM businesses WHERE LOWER(email) = $1 LIMIT 1`,
            [user.temp_email],
        );
        if (userDupe.rows.length > 0 || bizDupe.rows.length > 0) {
            return res.status(409).json({
                success: false,
                error: "This email is already in use by another account. Please use a different email.",
                code: "EMAIL_ALREADY_EXISTS",
            });
        }

        const result = await query(
            `UPDATE users
             SET email = temp_email, temp_email = NULL, email_verified = TRUE,
                 otp_hash = NULL, otp_expires_at = NULL, otp_type = NULL,
                 profile_completed = TRUE, profile_prompt_dismissed = TRUE, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id, name, email, phone_number, avatar_url as "avatarUrl", role, email_verified as "emailVerified"`,
            [userId],
        );

        res.json({ success: true, data: result.rows[0], message: "Email address updated successfully" });
    } catch (error: any) {
        console.error("Profile email verify-otp error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to verify the email change" });
    }
});

/**
 * POST /settings/profile/dismiss
 * Skip CTA for the first-login profile completion prompt — the user can
 * finish their personal profile later from Settings. Persisted server-side
 * so the prompt does not reappear on every device.
 */
router.post("/profile/dismiss", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        await query(
            `UPDATE users SET profile_prompt_dismissed = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [userId],
        );
        res.json({ success: true, message: "Profile prompt dismissed — you can complete it later in Settings" });
    } catch (error: any) {
        console.error("Profile dismiss error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to dismiss profile prompt" });
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

            const { getCloudStorage } = await import("../lib/storage");
            let avatarUrl = '';
            try {
                const storage = getCloudStorage();
                if (storage) {
                    const ext = file.originalname.includes(".")
                        ? file.originalname.split(".").pop()!.toLowerCase()
                        : (file.mimetype.includes('png') ? 'png' : 'jpg');
                    const key = `avatars/${userId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
                    avatarUrl = await storage.uploadFile(key, file.buffer, file.mimetype);
                }
            } catch (uploadError) {
                console.error("Avatar upload failed, falling back to local:", uploadError);
            }
            // A bare object key (cloud storage without a public base URL)
            // renders nowhere — fall back to local /uploads + absolute URL.
            if (!avatarUrl || !avatarUrl.startsWith('http')) {
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

/**
 * POST /settings/business/logo (multipart field: 'file')
 * Upload the BUSINESS logo (owner/admin only) and store it in
 * businesses.logo_url. Rendered on the dashboard/workspace header and the
 * SSO "complete your profile" flow. Always returns an ABSOLUTE URL —
 * R2 without a configured public base returns a bare object key which no
 * client can render, so we fall back to local /uploads in that case.
 */
router.post("/business/logo", authenticateToken, (req: AuthenticatedRequest, res) => {
    avatarUpload.single('file')(req as any, res as any, async (err: any) => {
        if (err) {
            const isTooLarge = err?.code === "LIMIT_FILE_SIZE";
            return res.status(isTooLarge ? 413 : 400).json({
                success: false,
                error: isTooLarge
                    ? `That image is too large — logos are limited to ${AVATAR_MAX_MB} MB. Try a smaller image.`
                    : err.message || "Upload failed",
            });
        }
        try {
            const businessId = req.user!.businessId;
            const userId = req.user!.userId;

            // OWNER-ONLY: the business logo is company identity — only the
            // admin who registered the account may change it.
            const { isOwner: isLogoOwner, isPersonalSpace: logoPersonal } = await isBusinessOwner(userId);
            if (!isLogoOwner && !logoPersonal) {
                return res.status(403).json({
                    success: false,
                    error: "Only the business owner who registered this account can change the business logo.",
                    code: "BUSINESS_SETTINGS_FORBIDDEN",
                });
            }

            const file = (req as any).file as Express.Multer.File | undefined;
            if (!file) {
                return res.status(400).json({ success: false, error: "file field is required" });
            }

            const ext = file.originalname.includes(".")
                ? file.originalname.split(".").pop()!.toLowerCase()
                : (file.mimetype.includes('png') ? 'png' : 'jpg');
            const key = `logos/${businessId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;

            let logoUrl = '';
            try {
                const { getCloudStorage } = await import("../lib/storage");
                const storage = getCloudStorage();
                if (storage) {
                    logoUrl = await storage.uploadFile(key, file.buffer, file.mimetype);
                }
            } catch (uploadError) {
                console.error("Logo cloud upload failed, falling back to local:", uploadError);
            }

            // A bare object key (cloud storage without a public base URL) is
            // unrenderable for every client — treat it as a failure and use
            // the local /uploads fallback with an absolute URL instead.
            if (!logoUrl || !logoUrl.startsWith('http')) {
                const fs = await import("fs");
                const baseDir = process.cwd();
                const uploadDir = path.join(baseDir, "uploads");
                if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                const filename = `logo-${businessId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
                fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
                const apiOrigin = process.env.API_PUBLIC_BASE_URL
                    || process.env.APP_BASE_URL
                    || 'https://api.metricorex.com';
                logoUrl = `${apiOrigin.replace(/\/$/, '')}/uploads/${filename}`;
            }

            const result = await query(
                `UPDATE businesses SET logo_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2
                 RETURNING id, name, logo_url as "logoUrl"`,
                [logoUrl, businessId]
            );

            res.json({ success: true, data: result.rows[0], message: "Business logo updated" });
        } catch (error: any) {
            console.error("Business logo upload error:", error);
            res.status(500).json({ success: false, error: "Failed to upload logo" });
        }
    });
});

export default router;
