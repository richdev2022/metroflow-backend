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
import { sendEmail, generateBusinessRegistrationEmailHtml } from "../services/email";
import { logActivity } from "../services/activity";
import { generateBusinessId } from "../utils/idGenerator";

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
    const passwordHash = hashPassword(input.password);

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

    // Update business to set owner_id
    await query(
      `UPDATE businesses SET owner_id = $1 WHERE id = $2`,
      [user.id, business.id]
    );

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
      `SELECT id, business_id as "businessId", otp_code, otp_expires_at 
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

    // Send welcome email
    const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
    const loginLink = baseUrl ? `${baseUrl}/login` : 'http://localhost:8080/login';
    const welcomeEmailHtml = generateBusinessRegistrationEmailHtml(
      user.name,
      business.name,
      loginLink,
    );

    const emailSent = await sendEmail(
      input.email,
      user.name,
      "Welcome to MetricFlow!",
      welcomeEmailHtml,
    );

    if (!emailSent) {
      console.error("Failed to send welcome email to", input.email);
      // Don't fail the registration for email issues
    }

    // Generate token
    const token = generateToken(user.id, user.businessId);

    const response: AuthResponse = {
      success: true,
      userId: user.id,
      businessId: user.businessId,
      token,
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
    const passwordHash = hashPassword(input.newPassword);

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

    const result = await query(
      `SELECT id, business_id as "businessId", password_hash, email_verified, otp_code, otp_expires_at
       FROM users
       WHERE email = $1`,
      [input.email],
    );
    console.log("Query result rows:", result.rows.length);

    if (result.rows.length === 0) {
      console.log("User not found for email:", input.email);
      return res.status(400).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = result.rows[0];
    console.log("User found, email_verified:", user.email_verified);

    if (!verifyPassword(input.password, user.password_hash)) {
      console.log("Password verification failed");
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

    // Update last login
    await query(
      `UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1`,
      [user.id],
    );

    // Log login activity
    await logActivity({
      businessId: user.businessId,
      userId: user.id,
      action: "login",
      actionType: "authentication",
      description: "User logged in successfully",
    });

    const token = generateToken(user.id, user.businessId);

    const response: AuthResponse = {
      success: true,
      userId: user.id,
      businessId: user.businessId,
      token,
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
