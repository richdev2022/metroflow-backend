import { query } from "../db";
import { sendEmail } from "./email";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

export interface LoginAttempt {
  email: string;
  ipAddress?: string;
  userAgent?: string;
  success: boolean;
  failureReason?: string;
}

export async function logLoginAttempt(attempt: LoginAttempt) {
  await query(
    `INSERT INTO login_attempts
     (email, ip_address, user_agent, success, failure_reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      attempt.email,
      attempt.ipAddress || null,
      attempt.userAgent || null,
      attempt.success,
      attempt.failureReason || null,
    ]
  );
}

export async function checkAccountLockout(email: string): Promise<{ locked: boolean; lockoutEnd?: Date }> {
  const result = await query(
    `SELECT locked_until FROM users WHERE email = $1`,
    [email]
  );

  if (result.rows.length === 0) {
    return { locked: false };
  }

  const lockedUntil = result.rows[0].locked_until;
  if (lockedUntil && new Date(lockedUntil) > new Date()) {
    return { locked: true, lockoutEnd: new Date(lockedUntil) };
  }

  return { locked: false };
}

export async function recordFailedLogin(email: string, ipAddress?: string, userAgent?: string) {
  // Increment failed attempts
  const result = await query(
    `UPDATE users
     SET failed_login_attempts = failed_login_attempts + 1,
         last_login_ip = $2,
         last_login_user_agent = $3
     WHERE email = $1
     RETURNING failed_login_attempts`,
    [email, ipAddress || null, userAgent || null]
  );

  const attempts = result.rows[0]?.failed_login_attempts || 0;

  // Check if we need to lock the account
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const lockoutEnd = new Date(Date.now() + LOCKOUT_DURATION_MS);
    await query(
      `UPDATE users
       SET locked_until = $2
       WHERE email = $1`,
      [email, lockoutEnd]
    );

    // Send lockout email notification
    await sendAccountLockoutEmail(email, lockoutEnd);
  }

  // Log the attempt
  await logLoginAttempt({
    email,
    ipAddress,
    userAgent,
    success: false,
    failureReason: "Invalid password",
  });
}

export async function recordSuccessfulLogin(email: string, ipAddress?: string, userAgent?: string) {
  // Reset failed attempts and update login info
  await query(
    `UPDATE users
     SET failed_login_attempts = 0,
         locked_until = NULL,
         last_login_ip = $2,
         last_login_user_agent = $3
     WHERE email = $1`,
    [email, ipAddress || null, userAgent || null]
  );

  // Log the attempt
  await logLoginAttempt({
    email,
    ipAddress,
    userAgent,
    success: true,
  });

  // Send login notification email
  await sendLoginNotificationEmail(email, ipAddress, userAgent);
}

async function sendAccountLockoutEmail(email: string, lockoutEnd: Date) {
  const lockoutEndLocal = lockoutEnd.toLocaleString();
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #fff; border-radius: 8px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
        <h2 style="color: #dc2626; margin-bottom: 20px;">Account Locked</h2>
        <p style="color: #374151; line-height: 1.6;">
          Your account has been temporarily locked due to multiple failed login attempts.
        </p>
        <p style="color: #374151; line-height: 1.6;">
          Your account will be unlocked at: <strong>${lockoutEndLocal}</strong>
        </p>
        <p style="color: #374151; line-height: 1.6;">
          If you did not attempt to login, please reset your password immediately and contact support.
        </p>
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
          <p style="color: #9ca3af; font-size: 12px;">
            This is an automated email. Please do not reply.
          </p>
        </div>
      </div>
    </div>
  `;

  await sendEmail(email, "Account Locked - MetricFlow", "Your account has been locked", html);
}

async function sendLoginNotificationEmail(email: string, ipAddress?: string, userAgent?: string) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #fff; border-radius: 8px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
        <h2 style="color: #1d4ed8; margin-bottom: 20px;">New Login to Your Account</h2>
        <p style="color: #374151; line-height: 1.6;">
          A new login was detected to your MetricFlow account.
        </p>
        ${ipAddress ? `<p style="color: #374151; line-height: 1.6;"><strong>IP Address:</strong> ${ipAddress}</p>` : ''}
        ${userAgent ? `<p style="color: #374151; line-height: 1.6;"><strong>Device:</strong> ${userAgent.substring(0, 200)}</p>` : ''}
        <p style="color: #374151; line-height: 1.6;">
          If this was you, you can ignore this email. If you did not login, please reset your password immediately and contact support.
        </p>
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
          <p style="color: #9ca3af; font-size: 12px;">
            This is an automated email. Please do not reply.
          </p>
        </div>
      </div>
    </div>
  `;

  await sendEmail(email, "New Login Detected - MetricFlow", "New login to your account", html);
}
