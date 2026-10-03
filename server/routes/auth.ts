import { RequestHandler } from "express";
import { query } from "../db";
import {
  RegisterBusinessInput,
  LoginInput,
  OTPVerificationInput,
  ForgotPasswordInput,
  VerifyResetOTPInput,
  ResetPasswordInput,
  AuthResponse,
} from "@shared/api";
import {
  hashPassword,
  verifyPassword,
  generateOTP,
  getOTPExpiry,
  generateToken,
} from "../services/auth";
import { sendEmail, generateBusinessRegistrationEmailHtml, generateLoginAttemptEmailHtml, generateAccountCreationEmailHtml, parseDeviceInfo } from "../services/email";
import { logActivity } from "../services/activity";
import { generateBusinessId } from "../utils/idGenerator";
import {
  checkAccountLockout,
  recordFailedLogin,
  recordSuccessfulLogin,
} from "../services/login-security";
import { verifyGoogleIdToken } from "../services/googleAuth";
import { AuthenticatedRequest } from "../middleware/auth";

export const registerBusiness: RequestHandler = async (req, res) => {
/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication endpoints
 */

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new business and admin user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessName
 *               - businessEmail
 *               - adminName
 *               - adminEmail
 *               - password
 *             properties:
 *               businessName:
 *                 type: string
 *               businessEmail:
 *                 type: string
 *                 format: email
 *               adminName:
 *                 type: string
 *               adminEmail:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *               businessIndustry:
 *                 type: string
 *     responses:
 *       200:
 *         description: Registration successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 businessId:
 *                   type: string
 *       400:
 *         description: Bad request
 */
  try {
    const input: RegisterBusinessInput = req.body;

    if (
      !input.businessName ||
      !input.businessEmail ||
      !input.adminName ||
      !input.adminEmail ||
      !input.password
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    // Check if business email already exists
    const existingBusiness = await query(
      "SELECT id FROM businesses WHERE email = $1",
      [input.businessEmail],
    );

    if (existingBusiness.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Business email already registered",
      });
    }

    // Get default free/trial plan
    const planResult = await query("SELECT * FROM pricing_plans WHERE price = 0 LIMIT 1");
    let planId = null;
    let trialEndsAt = null;

    if (planResult.rows.length > 0) {
      planId = planResult.rows[0].id;
      // Ensure trial days is at least 7 for free plan
      const trialDays = planResult.rows[0].trial_days && planResult.rows[0].trial_days > 0 ? planResult.rows[0].trial_days : 7;
      const date = new Date();
      date.setDate(date.getDate() + trialDays);
      trialEndsAt = date;
    } else {
        // Fallback if no free plan found in DB (should be seeded)
        // We might want to create one or just use default 7 days
        const date = new Date();
        date.setDate(date.getDate() + 7);
        trialEndsAt = date;
    }

    // Create business
    const businessId = generateBusinessId(input.businessName);
    const businessResult = await query(
      `INSERT INTO businesses (id, name, email, industry, plan_id, trial_ends_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, name, email, created_at as "createdAt"`,
      [businessId, input.businessName, input.businessEmail, input.businessIndustry || null, planId, trialEndsAt],
    );

    const business = businessResult.rows[0];

    // Create admin user
    const otpCode = generateOTP();
    const otpExpiresAt = getOTPExpiry();
    const passwordHash = await hashPassword(input.password);

    const userResult = await query(
      `INSERT INTO users
        (business_id, email, password_hash, name, role, otp_code, otp_expires_at)
        VALUES ($1, $2, $3, $4, 'admin', $5, $6)
        RETURNING id, email, name, role`,
      [
        business.id,
        input.adminEmail,
        passwordHash,
        input.adminName,
        otpCode,
        otpExpiresAt,
      ],
    );

    const user = userResult.rows[0];

    // Welcome email on account creation (best effort, does not block registration)
    try {
      const loginLink = `${process.env.CLIENT_URL || process.env.APP_BASE_URL || 'https://metricorex.com'}/login`;
      const welcomeEmail = generateAccountCreationEmailHtml(user.name || input.adminName, loginLink);
      sendEmail(user.email, user.name || input.adminName, 'Welcome to Metricorex - Your account has been created', welcomeEmail).catch((e) =>
        console.warn('Account creation email failed:', e?.message),
      );
    } catch (welcomeErr: any) {
      console.warn('Failed to send account creation email:', welcomeErr?.message);
    }

    // Update business to set owner_id
    await query(
      `UPDATE businesses SET owner_id = $1 WHERE id = $2`,
      [user.id, business.id]
    );

    // Seed default task statuses for the new business
    const defaultStatuses = [
      { name: 'pending', color: '#6b7280', is_default: true, sort_order: 0 },
      { name: 'in_progress', color: '#3b82f6', is_default: true, sort_order: 1 },
      { name: 'completed', color: '#10b981', is_default: true, sort_order: 2 }
    ];
    for (const status of defaultStatuses) {
      await query(
        `INSERT INTO task_statuses (business_id, name, color, is_default, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [business.id, status.name, status.color, status.is_default, status.sort_order]
      );
    }

    // Log business registration activity
    await logActivity({
      businessId: business.id,
      userId: user.id,
      action: "register",
      actionType: "business",
      description: `Business registered: ${business.name}`,
      metadata: {
        businessName: business.name,
        businessEmail: business.email,
        adminName: user.name,
        adminEmail: user.email,
      },
    });

    // Send OTP email
    const otpEmailHtml = `
      <html>
        <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px;">
            <h2 style="color: #1d4ed8; margin-bottom: 20px;">Verify Your Email</h2>
            <p style="color: #333; margin-bottom: 15px;">Welcome to MetricFlow!</p>
            <p style="color: #666; line-height: 1.6; margin-bottom: 15px;">
              Your business has been registered successfully. Please verify your email using the code below:
            </p>
            <div style="background-color: #f0f0f0; padding: 20px; border-radius: 4px; margin: 20px 0; text-align: center;">
              <p style="font-size: 32px; font-weight: bold; color: #1d4ed8; margin: 0; letter-spacing: 5px;">
                ${otpCode}
              </p>
            </div>
            <p style="color: #999; font-size: 12px;">This code expires in 10 minutes.</p>
          </div>
        </body>
      </html>
    `;

    const emailSent = await sendEmail(
      input.adminEmail,
      input.adminName,
      "Verify Your MetricFlow Account",
      otpEmailHtml,
    );

    if (!emailSent) {
      console.error("Failed to send OTP email to", input.adminEmail);
      // Roll back the partially-created account so the user can retry cleanly.
      // Previously the business/user rows stayed behind and every retry was
      // rejected with "A business with this email already exists", permanently
      // locking the email out of signup.
      try {
        // Delete CHILD rows first — task_statuses/users carry FKs to the
        // business, so deleting the business last is the only order that
        // actually succeeds (the previous order left the business + user
        // rows behind and permanently locked the email out of signup).
        await query(`DELETE FROM task_statuses WHERE business_id = $1`, [business.id]);
        await query(`DELETE FROM users WHERE business_id = $1`, [business.id]);
        await query(`DELETE FROM activity_logs WHERE business_id = $1`, [business.id]);
        await query(`DELETE FROM audit_logs WHERE business_id = $1`, [business.id]);
        await query(`DELETE FROM businesses WHERE id = $1`, [business.id]);
      } catch (cleanupError: any) {
        console.error(
          `Registration rollback failed for business ${business.id}: ${cleanupError?.message || cleanupError}`,
        );
      }
      return res.status(500).json({
        success: false,
        message: "Failed to send verification email. Please try again.",
      });
    }

    const response: AuthResponse = {
      success: true,
      businessId: business.id,
      userId: user.id,
      requiresOtp: true,
      message:
        "Business registered. Please verify your email with the OTP sent.",
    };

    res.status(201).json(response);
  } catch (error) {
    console.error("Register business error:", error);
    const response: AuthResponse = {
      success: false,
      message: "Failed to register business",
    };
    res.status(500).json(response);
  }
};

export const verifyOTP: RequestHandler = async (req, res) => {
  /**
   * @swagger
   * /auth/verify-otp:
   *   post:
   *     summary: Verify email with OTP
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - email
   *               - otpCode
   *             properties:
   *               email:
   *                 type: string
   *                 format: email
   *               otpCode:
   *                 type: string
   *     responses:
   *       200:
   *         description: Email verified successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 token:
   *                   type: string
   *                 userId:
   *                   type: string
   *                 businessId:
   *                   type: string
   *       400:
   *         description: Invalid code or email
   */
  try {
    const input: OTPVerificationInput = req.body;

    if (!input.email || !input.otpCode) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP code are required",
      });
    }

    const result = await query(
      `SELECT id, business_id as "businessId", otp_code, otp_expires_at, name, email 
       FROM users 
       WHERE email = $1`,
      [input.email],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "User not found",
      });
    }

    const user = result.rows[0];

    if (!user.otp_code || user.otp_code !== input.otpCode) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP code",
      });
    }

    const expiryTime = new Date(user.otp_expires_at);
    if (expiryTime < new Date()) {
      return res.status(400).json({
        success: false,
        message: "OTP code has expired",
      });
    }

    // Mark email as verified
    await query(
      `UPDATE users
        SET email_verified = TRUE, verified_at = CURRENT_TIMESTAMP,
            otp_code = NULL, otp_expires_at = NULL
        WHERE id = $1`,
      [user.id],
    );

    // Get business details for welcome email
    const businessResult = await query(
      `SELECT name FROM businesses WHERE id = $1`,
      [user.businessId],
    );

    const business = businessResult.rows[0];

    // Send welcome email. NOTE: this must NEVER be able to fail the
    // verification itself — a missing CLIENT_URL used to throw here and turn
    // every correct-OTP submission into a 500 "Failed to verify OTP", which
    // is exactly the "signup OTP screen is not working" report. Email is
    // best-effort; the account is verified either way.
    const baseUrl = process.env.CLIENT_URL || process.env.APP_BASE_URL || process.env.APP_URL || "https://app.metricorex.com";
    const loginLink = `${baseUrl}/login`;
    let emailSent = false;
    try {
      const welcomeEmailHtml = generateBusinessRegistrationEmailHtml(
        user.name,
        business?.name || "your business",
        loginLink,
      );

      emailSent = await sendEmail(
        input.email,
        user.name,
        "Welcome to MetricFlow!",
        welcomeEmailHtml,
      );
    } catch (emailErr: any) {
      console.error("Welcome email error (non-fatal):", emailErr?.message || emailErr);
    }

    if (!emailSent) {
      console.error("Failed to send welcome email to", input.email);
      // Don't fail the registration for email issues
    }

    // Generate token
    const token = await generateToken(user.id, user.businessId);

    const response: AuthResponse = {
      success: true,
      userId: user.id,
      businessId: user.businessId,
      token,
      name: user.name || "",
      email: user.email || "",
      message: "Email verified successfully",
    };

    res.json(response);
  } catch (error) {
    console.error("Verify OTP error:", error);
    const response: AuthResponse = {
      success: false,
      message: "Failed to verify OTP",
    };
    res.status(500).json(response);
  }
};

export const forgotPassword: RequestHandler = async (req, res) => {
  /**
   * @swagger
   * /auth/forgot-password:
   *   post:
   *     summary: Request password reset
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - email
   *             properties:
   *               email:
   *                 type: string
   *                 format: email
   *     responses:
   *       200:
   *         description: Password reset OTP sent
   *       400:
   *         description: User not found
   */
  try {
    const input: ForgotPasswordInput = req.body;

    if (!input.email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const result = await query(
      `SELECT id, name FROM users WHERE email = $1`,
      [input.email],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "User not found",
      });
    }

    const user = result.rows[0];

    // Generate new OTP for password reset
    const otpCode = generateOTP();
    const otpExpiresAt = getOTPExpiry();

    await query(
      `UPDATE users
       SET otp_code = $1, otp_expires_at = $2
       WHERE id = $3`,
      [otpCode, otpExpiresAt, user.id],
    );

    // Send password reset OTP email
    const resetEmailHtml = `
      <html>
        <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px;">
            <h2 style="color: #1d4ed8; margin-bottom: 20px;">Reset Your Password</h2>
            <p style="color: #333; margin-bottom: 15px;">Hi ${user.name},</p>
            <p style="color: #666; line-height: 1.6; margin-bottom: 15px;">
              We received a request to reset your password. Use the code below to proceed:
            </p>
            <div style="background-color: #f0f0f0; padding: 20px; border-radius: 4px; margin: 20px 0; text-align: center;">
              <p style="font-size: 32px; font-weight: bold; color: #1d4ed8; margin: 0; letter-spacing: 5px;">
                ${otpCode}
              </p>
            </div>
            <p style="color: #999; font-size: 12px;">This code expires in 10 minutes.</p>
            <p style="color: #666; line-height: 1.6; margin-bottom: 15px;">
              If you didn't request this reset, please ignore this email.
            </p>
          </div>
        </body>
      </html>
    `;

    const emailSent = await sendEmail(
      input.email,
      user.name,
      "Reset Your MetricFlow Password",
      resetEmailHtml,
    );

    if (!emailSent) {
      console.error("Failed to send reset OTP email to", input.email);
      return res.status(500).json({
        success: false,
        message: "Failed to send reset email. Please try again.",
      });
    }

    const response: AuthResponse = {
      success: true,
      message: "Password reset OTP sent to your email",
    };

    res.json(response);
  } catch (error) {
    console.error("Forgot password error:", error);
    const response: AuthResponse = {
      success: false,
      message: "Failed to send reset email",
    };
    res.status(500).json(response);
  }
};

export const verifyResetOTP: RequestHandler = async (req, res) => {
  /**
   * @swagger
   * /auth/verify-reset-otp:
   *   post:
   *     summary: Verify password reset OTP
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - email
   *               - otpCode
   *             properties:
   *               email:
   *                 type: string
   *                 format: email
   *               otpCode:
   *                 type: string
   *     responses:
   *       200:
   *         description: OTP verified
   *       400:
   *         description: Invalid code
   */
  try {
    const input: VerifyResetOTPInput = req.body;

    if (!input.email || !input.otpCode) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP code are required",
      });
    }

    const result = await query(
      `SELECT id, otp_code, otp_expires_at
       FROM users
       WHERE email = $1`,
      [input.email],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "User not found",
      });
    }

    const user = result.rows[0];

    if (!user.otp_code || user.otp_code !== input.otpCode) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP code",
      });
    }

    const expiryTime = new Date(user.otp_expires_at);
    if (expiryTime < new Date()) {
      return res.status(400).json({
        success: false,
        message: "OTP code has expired",
      });
    }

    // OTP is valid, but don't clear it yet - wait for password reset
    const response: AuthResponse = {
      success: true,
      message: "OTP verified successfully",
    };

    res.json(response);
  } catch (error) {
    console.error("Verify reset OTP error:", error);
    const response: AuthResponse = {
      success: false,
      message: "Failed to verify OTP",
    };
    res.status(500).json(response);
  }
};

export const resetPassword: RequestHandler = async (req, res) => {
  /**
   * @swagger
   * /auth/reset-password:
   *   post:
   *     summary: Reset password
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - email
   *               - otpCode
   *               - newPassword
   *             properties:
   *               email:
   *                 type: string
   *                 format: email
   *               otpCode:
   *                 type: string
   *               newPassword:
   *                 type: string
   *     responses:
   *       200:
   *         description: Password reset successfully
   *       400:
   *         description: Invalid code or password
   */
  try {
    const input: ResetPasswordInput = req.body;

    if (!input.email || !input.otpCode || !input.newPassword) {
      return res.status(400).json({
        success: false,
        message: "Email, OTP code, and new password are required",
      });
    }

    if (input.newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    const result = await query(
      `SELECT id, otp_code, otp_expires_at
       FROM users
       WHERE email = $1`,
      [input.email],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "User not found",
      });
    }

    const user = result.rows[0];

    if (!user.otp_code || user.otp_code !== input.otpCode) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP code",
      });
    }

    const expiryTime = new Date(user.otp_expires_at);
    if (expiryTime < new Date()) {
      return res.status(400).json({
        success: false,
        message: "OTP code has expired",
      });
    }

    // Update password and clear OTP
    const passwordHash = await hashPassword(input.newPassword);

    await query(
      `UPDATE users
       SET password_hash = $1, otp_code = NULL, otp_expires_at = NULL
       WHERE id = $2`,
      [passwordHash, user.id],
    );

    const response: AuthResponse = {
      success: true,
      message: "Password reset successfully",
    };

    res.json(response);
  } catch (error) {
    console.error("Reset password error:", error);
    const response: AuthResponse = {
      success: false,
      message: "Failed to reset password",
    };
    res.status(500).json(response);
  }
};

export const resendOTP: RequestHandler = async (req, res) => {
  /**
   * @swagger
   * /auth/resend-otp:
   *   post:
   *     summary: Resend OTP
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - email
   *             properties:
   *               email:
   *                 type: string
   *                 format: email
   *     responses:
   *       200:
   *         description: OTP resent successfully
   *       400:
   *         description: User not found
   */
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const result = await query(
      `SELECT id, name FROM users WHERE email = $1`,
      [email],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "User not found",
      });
    }

    const user = result.rows[0];

    // Generate new OTP
    const otpCode = generateOTP();
    const otpExpiresAt = getOTPExpiry();

    await query(
      `UPDATE users
       SET otp_code = $1, otp_expires_at = $2
       WHERE id = $3`,
      [otpCode, otpExpiresAt, user.id],
    );

    // Send OTP email
    const otpEmailHtml = `
      <html>
        <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px;">
            <h2 style="color: #1d4ed8; margin-bottom: 20px;">Verify Your Email</h2>
            <p style="color: #333; margin-bottom: 15px;">Hi ${user.name},</p>
            <p style="color: #666; line-height: 1.6; margin-bottom: 15px;">
              Your new verification code is:
            </p>
            <div style="background-color: #f0f0f0; padding: 20px; border-radius: 4px; margin: 20px 0; text-align: center;">
              <p style="font-size: 32px; font-weight: bold; color: #1d4ed8; margin: 0; letter-spacing: 5px;">
                ${otpCode}
              </p>
            </div>
            <p style="color: #999; font-size: 12px;">This code expires in 10 minutes.</p>
          </div>
        </body>
      </html>
    `;

    const emailSent = await sendEmail(
      email,
      user.name,
      "Verify Your MetricFlow Account",
      otpEmailHtml,
    );

    if (!emailSent) {
      return res.status(500).json({
        success: false,
        message: "Failed to send verification email. Please try again.",
      });
    }

    const response: AuthResponse = {
      success: true,
      message: "OTP sent successfully",
    };

    res.json(response);
  } catch (error) {
    console.error("Resend OTP error:", error);
    const response: AuthResponse = {
      success: false,
      message: "Failed to resend OTP",
    };
    res.status(500).json(response);
  }
};

export const login: RequestHandler = async (req, res) => {
/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 token:
 *                   type: string
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 business:
 *                   $ref: '#/components/schemas/Business'
 *       401:
 *         description: Invalid credentials
 */
  try {
    const input: LoginInput = req.body;
    // Get IP address with better detection
    let ipAddress: string | undefined;
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string') {
      // Get first IP in the list (client IP)
      ipAddress = xForwardedFor.split(',')[0].trim();
    } else {
      ipAddress = req.ip || req.connection.remoteAddress;
    }
    const userAgent = req.headers['user-agent'];
    console.log("Login input:", input);

    if (!input.email || !input.password) {
      console.log("Missing email or password");
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
        debug: {
          receivedBody: req.body,
          contentType: req.headers['content-type'],
          contentLength: req.headers['content-length'],
          isBase64: (req as any).isBase64Encoded,
          netlifyEventBody: (req as any).netlifyEvent?.body,
          netlifyEventIsBase64: (req as any).netlifyEvent?.isBase64Encoded,
        }
      });
    }

    // Check for account lockout
    const lockoutStatus = await checkAccountLockout(input.email);
    if (lockoutStatus.locked) {
      return res.status(403).json({
        success: false,
        message: "Account temporarily locked. Please try again later.",
        lockoutEnd: lockoutStatus.lockoutEnd?.toISOString(),
      });
    }

    const result = await query(
      `SELECT id, business_id as "businessId", password_hash, email_verified, otp_code, otp_expires_at, auth_provider, google_id, name, email
       FROM users
       WHERE email = $1`,
      [input.email],
    );
    console.log("Query result rows:", result.rows.length);

    if (result.rows.length === 0) {
      console.log("User not found for email:", input.email);
      // Log failed attempt
      await recordFailedLogin(input.email, ipAddress, userAgent);
      return res.status(400).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = result.rows[0];
    console.log("User found, email_verified:", user.email_verified);

    // Google SSO account that has not created a password yet
    if (!user.password_hash) {
      return res.status(400).json({
        success: false,
        code: "GOOGLE_ACCOUNT_NO_PASSWORD",
        message:
          "This account is signed up with Google. Please continue with Google Sign-In, or create a password from Settings after signing in with Google.",
      });
    }

    const passwordValid = await verifyPassword(input.password, user.password_hash);
    if (!passwordValid) {
      console.log("Password verification failed");
      await recordFailedLogin(input.email, ipAddress, userAgent);

      // Always-on failed login attempt notification with device info - best effort
      try {
        const deviceInfo = parseDeviceInfo(userAgent);
        await query(
          `INSERT INTO login_attempts (email, user_id, business_id, status, ip_address, user_agent, device_info)
           VALUES ($1, $2, $3, 'failed', $4, $5, $6)`,
          [user.email, user.id, user.businessId, ipAddress, String(userAgent || ''), deviceInfo],
        );
        const attemptEmail = generateLoginAttemptEmailHtml(user.email, 'failed', deviceInfo, ipAddress);
        sendEmail(user.email, user.email, 'Failed login attempt on your Metricorex account', attemptEmail).catch((e) =>
          console.warn('Login attempt email failed:', e?.message),
        );
      } catch (logErr: any) {
        console.warn('Failed to record failed login attempt:', logErr?.message);
      }

      return res.status(400).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    if (!user.email_verified) {
      // Generate new OTP for re-verification
      const otpCode = generateOTP();
      const otpExpiresAt = getOTPExpiry();

      await query(
        `UPDATE users 
         SET otp_code = $1, otp_expires_at = $2
         WHERE id = $3`,
        [otpCode, otpExpiresAt, user.id],
      );

      return res.json({
        success: true,
        requiresOtp: true,
        message: "Please verify your email with OTP",
      });
    }

    // Record successful login
    await recordSuccessfulLogin(input.email, ipAddress, userAgent);

    // Always-on login attempt notification (success) with device info - best effort
    try {
      const deviceInfo = parseDeviceInfo(userAgent);
      await query(
        `INSERT INTO login_attempts (email, user_id, business_id, status, ip_address, user_agent, device_info)
         VALUES ($1, $2, $3, 'success', $4, $5, $6)`,
        [user.email, user.id, user.businessId, ipAddress, String(userAgent || ''), deviceInfo],
      );
      const attemptEmail = generateLoginAttemptEmailHtml(user.email, 'success', deviceInfo, ipAddress);
      sendEmail(user.email, user.email, 'New login to your Metricorex account', attemptEmail).catch((e) =>
        console.warn('Login attempt email failed:', e?.message),
      );
    } catch (logErr: any) {
      console.warn('Failed to record login attempt:', logErr?.message);
    }

    // Log login activity
    await logActivity({
      businessId: user.businessId,
      userId: user.id,
      action: "login",
      actionType: "authentication",
      description: "User logged in successfully",
    });

    const token = await generateToken(user.id, user.businessId);

    // Name/email ride along so every client (web + mobile) can greet the user
    // by NAME after email/password login — not by their email address.
    const response: AuthResponse = {
      success: true,
      userId: user.id,
      businessId: user.businessId,
      token,
      name: user.name || "",
      email: user.email || "",
      message: "Login successful",
    };

    res.json(response);
  } catch (error) {
    console.error("Login error:", error);
    const response: AuthResponse = {
      success: false,
      message: "Failed to login",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /auth/google:
 *   post:
 *     summary: Sign up or log in with Google (ID token from Google Identity Services)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - credential
 *             properties:
 *               credential:
 *                 type: string
 *                 description: Google ID token
 *               businessName:
 *                 type: string
 *                 description: Optional business name for new sign-ups
 *               businessIndustry:
 *                 type: string
 *     responses:
 *       200:
 *         description: Google authentication successful
 */
export const googleAuth: RequestHandler = async (req, res) => {
  try {
    const { credential, businessName, businessIndustry } = req.body || {};

    if (!credential) {
      return res.status(400).json({
        success: false,
        message: "Google credential is required",
      });
    }

    const googleUser = await verifyGoogleIdToken(credential);
    if (!googleUser) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired Google credential",
      });
    }

    if (!googleUser.emailVerified) {
      return res.status(400).json({
        success: false,
        message: "Your Google account email is not verified",
      });
    }

    // 1) Existing user linked by google_id
    const byGoogleId = await query(
      `SELECT id, business_id as "businessId", email, name, avatar_url as "avatarUrl",
              auth_provider as "authProvider", password_hash as "passwordHash", email_verified
       FROM users WHERE google_id = $1 LIMIT 1`,
      [googleUser.googleId],
    );

    let user = byGoogleId.rows[0] || null;

    // 2) Existing user with same email (link Google account)
    if (!user) {
      const byEmail = await query(
        `SELECT id, business_id as "businessId", email, name, avatar_url as "avatarUrl",
                auth_provider as "authProvider", password_hash as "passwordHash", email_verified
         FROM users WHERE email = $1 LIMIT 1`,
        [googleUser.email],
      );

      if (byEmail.rows.length > 0) {
        user = byEmail.rows[0];
        // Link google identity to the existing account and trust Google-verified email
        await query(
          `UPDATE users
           SET google_id = $1,
               auth_provider = CASE WHEN auth_provider = 'google' THEN auth_provider ELSE auth_provider || '+google' END,
               email_verified = TRUE,
               avatar_url = COALESCE(avatar_url, $2),
               verified_at = COALESCE(verified_at, NOW()),
               otp_code = NULL,
               otp_expires_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [googleUser.googleId, googleUser.picture || null, user.id],
        );
      }
    }

    let isNewUser = false;

    // 3) Brand-new user: create business + admin user (Google-verified email, no password)
    if (!user) {
      isNewUser = true;
      const derivedBusinessName =
        (businessName && String(businessName).trim()) ||
        `${googleUser.name.split(" ")[0]}'s Workspace`;

      const existingBusiness = await query(
        "SELECT id FROM businesses WHERE email = $1",
        [googleUser.email],
      );
      if (existingBusiness.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message:
            "A business with this email already exists. Please sign in instead.",
        });
      }

      // Get default free/trial plan (same logic as email registration)
      const planResult = await query("SELECT * FROM pricing_plans WHERE price = 0 LIMIT 1");
      let planId = null;
      let trialEndsAt = null;
      const trialDaysDefault =
        planResult.rows.length > 0 &&
        planResult.rows[0].trial_days &&
        planResult.rows[0].trial_days > 0
          ? planResult.rows[0].trial_days
          : 7;
      const trialDate = new Date();
      trialDate.setDate(trialDate.getDate() + trialDaysDefault);
      trialEndsAt = trialDate;
      if (planResult.rows.length > 0) planId = planResult.rows[0].id;

      const businessId = generateBusinessId(derivedBusinessName);
      const businessResult = await query(
        `INSERT INTO businesses (id, name, email, industry, plan_id, trial_ends_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, email`,
        [
          businessId,
          derivedBusinessName,
          googleUser.email,
          businessIndustry || null,
          planId,
          trialEndsAt,
        ],
      );
      const business = businessResult.rows[0];

      const userResult = await query(
        `INSERT INTO users
          (business_id, email, name, role, email_verified, verified_at, google_id, auth_provider, avatar_url)
         VALUES ($1, $2, $3, 'admin', TRUE, CURRENT_TIMESTAMP, $4, 'google', $5)
         RETURNING id, email, name, role`,
        [business.id, googleUser.email, googleUser.name, googleUser.googleId, googleUser.picture || null],
      );
      const newUser = userResult.rows[0];

      // Welcome email on Google account creation (best effort)
      try {
        const loginLink = `${process.env.CLIENT_URL || process.env.APP_BASE_URL || 'https://metricorex.com'}/login`;
        const welcomeEmail = generateAccountCreationEmailHtml(newUser.name || googleUser.name, loginLink);
        sendEmail(newUser.email, newUser.name || googleUser.name, 'Welcome to Metricorex - Your account has been created', welcomeEmail).catch((e) =>
          console.warn('Account creation email failed:', e?.message),
        );
      } catch (welcomeErr: any) {
        console.warn('Failed to send account creation email:', welcomeErr?.message);
      }

      await query(`UPDATE businesses SET owner_id = $1 WHERE id = $2`, [
        newUser.id,
        business.id,
      ]);

      // Seed default task statuses (parity with email registration)
      const defaultStatuses = [
        { name: "pending", color: "#6b7280", is_default: true, sort_order: 0 },
        { name: "in_progress", color: "#3b82f6", is_default: true, sort_order: 1 },
        { name: "completed", color: "#10b981", is_default: true, sort_order: 2 },
      ];
      for (const status of defaultStatuses) {
        await query(
          `INSERT INTO task_statuses (business_id, name, color, is_default, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [business.id, status.name, status.color, status.is_default, status.sort_order],
        );
      }

      await logActivity({
        businessId: business.id,
        userId: newUser.id,
        action: "register",
        actionType: "business",
        description: `Business registered via Google SSO: ${business.name}`,
        metadata: {
          businessName: business.name,
          authProvider: "google",
        },
      });

      const token = await generateToken(newUser.id, business.id);

      return res.json({
        success: true,
        token,
        userId: newUser.id,
        businessId: business.id,
        isNewUser,
        requiresPasswordSetup: true,
        // Fresh SSO sign-up: derived workspace name, no phone/industry/logo
        // yet — clients MUST route to the profile-completion screen first.
        profileCompleted: false,
        message: "Google sign-up successful",
        user: {
          id: newUser.id,
          name: newUser.name,
          email: newUser.email,
          avatarUrl: googleUser.picture || null,
          authProvider: "google",
          hasPassword: false,
        },
        business: {
          id: business.id,
          name: business.name,
          email: business.email,
          industry: businessIndustry || null,
          phoneNumber: null,
          logoUrl: null,
        },
      });
    }

    // 4) Existing user login
    if (user.email === null || user.email === undefined) {
      return res.status(400).json({ success: false, message: "Account error" });
    }

    await recordSuccessfulLogin(user.email);
    await logActivity({
      businessId: user.businessId,
      userId: user.id,
      action: "login",
      actionType: "authentication",
      description: "User logged in with Google SSO",
    });

    const token = await generateToken(user.id, user.businessId);

    return res.json({
      success: true,
      token,
      userId: user.id,
      businessId: user.businessId,
      isNewUser,
      requiresPasswordSetup: !user.passwordHash,
      // Existing SSO accounts still owe a complete business profile (phone,
      // industry, real name, logo) before reaching the dashboard.
      profileCompleted: await computeBusinessProfileCompleted(user.businessId),
      message: isNewUser ? "Google sign-up successful" : "Google login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        authProvider: user.authProvider,
        hasPassword: !!user.passwordHash,
      },
    });
  } catch (error) {
    console.error("Google auth error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to authenticate with Google",
    });
  }
};

/**
 * @swagger
 * /auth/set-password:
 *   post:
 *     summary: Create a password for SSO accounts (allows future email+password login)
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password created
 */
export const setPassword: RequestHandler = async (req: AuthenticatedRequest, res) => {
  // A valid bcrypt hash always starts with $2a$, $2b$ or $2y$. Anything else
  // in password_hash (e.g. "{}" written by the historic missing-await bug in
  // accept-invite) is corrupt and MUST be treated as "no password" so the
  // user can recover via set-password instead of being locked out forever.
  const isBcryptHash = (hash: unknown): boolean =>
    typeof hash === "string" && /^\$2[aby]\$/.test(hash);

  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const { password } = req.body || {};
    if (!password || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const result = await query(
      `SELECT id, password_hash as "passwordHash", auth_provider as "authProvider" FROM users WHERE id = $1`,
      [userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = result.rows[0];
    if (user.passwordHash && isBcryptHash(user.passwordHash)) {
      return res.status(400).json({
        success: false,
        code: "PASSWORD_ALREADY_SET",
        message:
          "A password already exists for this account. Use change-password instead.",
      });
    }

    const passwordHash = await hashPassword(password);
    await query(
      `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [passwordHash, userId],
    );

    await logActivity({
      businessId: req.user?.businessId,
      userId,
      action: "set_password",
      actionType: "authentication",
      description: "Password created for SSO account",
    });

    return res.json({
      success: true,
      message:
        "Password created successfully. You can now sign in with your email and password or with Google.",
    });
  } catch (error) {
    console.error("Set password error:", error);
    return res.status(500).json({ success: false, message: "Failed to set password" });
  }
};

/**
 * @swagger
 * /auth/change-password:
 *   post:
 *     summary: Change password for accounts that already have one
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
export const changePassword: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters",
      });
    }

    const result = await query(
      `SELECT id, password_hash as "passwordHash" FROM users WHERE id = $1`,
      [userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = result.rows[0];
    // Only trust a real bcrypt hash here. A corrupt hash (e.g. "{}") means
    // no usable password exists — the user must go through set-password.
    if (!user.passwordHash || !/^\$2[aby]\$/.test(user.passwordHash)) {
      return res.status(400).json({
        success: false,
        code: "NO_PASSWORD_SET",
        message: "This account has no password yet. Use set-password first.",
      });
    }

    const valid = await verifyPassword(currentPassword || "", user.passwordHash);
    if (!valid) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" });
    }

    const passwordHash = await hashPassword(newPassword);
    await query(
      `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [passwordHash, userId],
    );

    await logActivity({
      businessId: req.user?.businessId,
      userId,
      action: "change_password",
      actionType: "authentication",
      description: "Password changed",
    });

    return res.json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({ success: false, message: "Failed to change password" });
  }
};

/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Get the current authenticated user profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
/**
 * SSO onboarding gate — is the business profile fully filled in?
 *
 * Google sign-ups create the business with a DERIVED name ("Ada's Workspace"),
 * no phone number, no industry (when not supplied) and no logo. The mobile/web
 * clients route those users to the profile-completion screen until every
 * required field is present. Fails CLOSED (false) on DB errors so the user is
 * always given the chance to complete — never silently skipped.
 */
export async function computeBusinessProfileCompleted(businessId: string | null | undefined): Promise<boolean> {
  if (!businessId) return false;
  try {
    const res = await query(
      `SELECT name, industry, phone_number, logo_url FROM businesses WHERE id = $1 LIMIT 1`,
      [businessId],
    );
    const b = res.rows[0];
    if (!b) return false;
    const name = String(b.name || '').trim();
    const derivedPattern = /'s workspace$/i; // auto-generated SSO placeholder
    return Boolean(
      name &&
        !derivedPattern.test(name) &&
        String(b.industry || '').trim() &&
        String(b.phone_number || '').trim() &&
        String(b.logo_url || '').trim(),
    );
  } catch (e) {
    console.error('computeBusinessProfileCompleted failed:', e);
    return false;
  }
}

export const getMe: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const result = await query(
      `SELECT id, business_id as "businessId", email, name, role,
              avatar_url as "avatarUrl", auth_provider as "authProvider",
              (password_hash IS NOT NULL) as "hasPassword",
              email_verified as "emailVerified", kyc_status as "kycStatus",
              phone_number as "phoneNumber"
       FROM users WHERE id = $1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const data: Record<string, unknown> = result.rows[0];
    // SSO onboarding gate — clients route to the profile-completion screen
    // until the business profile is fully filled in.
    data.profileCompleted = await computeBusinessProfileCompleted(data.businessId as string);

    return res.json({ success: true, data });
  } catch (error) {
    console.error("Get me error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch profile" });
  }
};

// ============================================================================
// Biometric unlock (server-backed). The mobile/web client stores the
// biometric_token in secure storage gated by the platform biometric API.
// Enrollment requires a normal authenticated session; login only requires the
// biometric token (no password), keeping the flow passwordless-but-safe.
// ============================================================================

import { createHash, randomBytes } from "crypto";

const hashBiometricToken = (token: string) =>
  createHash("sha256").update(`${token}${process.env.JWT_SECRET || ""}`).digest("hex");

/**
 * POST /auth/biometric/enroll (auth required)
 * Body: { device_id, device_name?, platform? }
 * Returns the ONE-TIME plaintext biometric_token to store in secure storage.
 */
export const biometricEnroll: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const businessId = req.user?.businessId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    const { device_id, device_name, platform } = req.body || {};
    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ success: false, message: "device_id is required" });
    }

    const token = randomBytes(32).toString("hex");
    const tokenHash = hashBiometricToken(token);

    // Revoke previous credentials for this user+device
    await query(
      `UPDATE biometric_credentials SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
      [userId, device_id],
    );
    await query(
      `INSERT INTO biometric_credentials (user_id, device_id, token_hash, platform, device_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, device_id, tokenHash, platform || null, device_name || null],
    );
    // businessId intentionally unused here; kept for future policy scoping
    void businessId;

    res.json({
      success: true,
      message: "Biometric unlock enabled for this device",
      data: { biometric_token: token, device_id },
    });
  } catch (error: any) {
    console.error("Biometric enroll error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to enable biometric unlock" });
  }
};

/**
 * POST /auth/biometric/login
 * Body: { biometric_token, device_id, device_name? }
 * Returns the same envelope as /auth/login on success.
 */
export const biometricLogin: RequestHandler = async (req, res) => {
  try {
    const { biometric_token, device_id, device_name } = req.body || {};
    if (!biometric_token || !device_id) {
      return res.status(400).json({ success: false, message: "biometric_token and device_id are required" });
    }

    const tokenHash = hashBiometricToken(String(biometric_token));
    const credRes = await query(
      `SELECT bc.id, bc.user_id, u.id AS uid, u.business_id AS "businessId", u.email, u.name,
              u.email_verified, u.status, u.auth_provider as "authProvider"
       FROM biometric_credentials bc
       JOIN users u ON u.id = bc.user_id
       WHERE bc.token_hash = $1 AND bc.device_id = $2 AND bc.revoked_at IS NULL
       LIMIT 1`,
      [tokenHash, String(device_id)],
    );

    const cred = credRes.rows[0];
    if (!cred) {
      return res.status(401).json({ success: false, message: "Biometric unlock is not set up on this device. Please sign in with your password once." });
    }
    if (cred.status !== 'active' || !cred.email_verified) {
      return res.status(403).json({ success: false, message: "Account is not active. Please sign in with your password." });
    }

    await query(
      `UPDATE biometric_credentials SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [cred.id],
    );
    if (device_name) {
      await query(`UPDATE biometric_credentials SET device_name = $1 WHERE id = $2`, [String(device_name).slice(0, 255), cred.id]).catch(() => {});
    }

    // Login attempt notification (success via biometric)
    try {
      const deviceInfo = parseDeviceInfo(req.headers['user-agent']);
      await query(
        `INSERT INTO login_attempts (email, user_id, business_id, status, ip_address, user_agent, device_info)
         VALUES ($1, $2, $3, 'success', $4, $5, $6)`,
        [cred.email, cred.uid, cred.businessId, req.ip || null, String(req.headers['user-agent'] || ''), { ...deviceInfo, method: 'biometric' }],
      );
      const attemptEmail = generateLoginAttemptEmailHtml(cred.email, 'success', deviceInfo, req.ip);
      sendEmail(cred.email, cred.email, 'New login to your Metricorex account (biometric)', attemptEmail).catch(() => {});
    } catch { /* best effort */ }

    const token = await generateToken(cred.uid, cred.businessId);
    res.json({
      success: true,
      userId: cred.uid,
      businessId: cred.businessId,
      token,
      message: "Biometric login successful",
    });
  } catch (error: any) {
    console.error("Biometric login error:", error);
    res.status(500).json({ success: false, message: error.message || "Biometric login failed" });
  }
};

/**
 * POST /auth/biometric/status (no auth — same trust level as biometric/login)
 * Body: { device_id }
 * Soft probe so clients can reconcile local biometric state with what the
 * server still holds for this device. Only ever returns a boolean; lets the
 * app self-heal (e.g. after a DB restore wiped credentials) by clearing its
 * local token and silently re-enrolling on the next password/Google login.
 */
export const biometricStatus: RequestHandler = async (req, res) => {
  try {
    const deviceId = String(req.body?.device_id || "").trim();
    if (!deviceId) {
      return res.status(400).json({ success: false, message: "device_id is required" });
    }
    const result = await query(
      `SELECT 1 FROM biometric_credentials
        WHERE device_id = $1 AND revoked_at IS NULL
        LIMIT 1`,
      [deviceId],
    );
    res.json({ success: true, enrolled: result.rows.length > 0 });
  } catch (error: any) {
    console.error("Biometric status error:", error);
    // Soft-success: a broken probe must never brick biometric unlock.
    res.json({ success: true, enrolled: true });
  }
};

/**
 * DELETE /auth/biometric/enroll (auth required)
 * Body: { device_id? } - revokes all credentials for the caller (or one device).
 */
export const biometricRevoke: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const { device_id } = req.body || {};
    if (device_id) {
      await query(
        `UPDATE biometric_credentials SET revoked_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
        [userId, String(device_id)],
      );
    } else {
      await query(
        `UPDATE biometric_credentials SET revoked_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    }
    res.json({ success: true, message: "Biometric unlock disabled" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message || "Failed to disable biometric unlock" });
  }
};
