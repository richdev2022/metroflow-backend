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
    await sendAccountLockoutEmail(email, lockoutEnd, ipAddress, userAgent);
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

function parseUserAgent(userAgent?: string) {
  if (!userAgent) return { browser: 'Unknown', device: 'Unknown', os: 'Unknown' };
  
  let browser = 'Unknown';
  let device = 'Unknown';
  let os = 'Unknown';

  // Detect OS
  if (userAgent.includes('Windows NT')) os = 'Windows';
  else if (userAgent.includes('Mac OS X')) os = 'macOS';
  else if (userAgent.includes('Linux')) os = 'Linux';
  else if (userAgent.includes('Android')) os = 'Android';
  else if (userAgent.includes('iPhone') || userAgent.includes('iPad') || userAgent.includes('iOS')) os = 'iOS';
  else if (userAgent.includes('CrOS')) os = 'Chrome OS';

  // Detect Browser
  if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) browser = 'Chrome';
  else if (userAgent.includes('Firefox')) browser = 'Firefox';
  else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) browser = 'Safari';
  else if (userAgent.includes('Edg')) browser = 'Edge';
  else if (userAgent.includes('Opera') || userAgent.includes('OPR')) browser = 'Opera';

  // Detect Device Type
  if (userAgent.includes('Mobile')) device = 'Mobile';
  else if (userAgent.includes('Tablet')) device = 'Tablet';
  else device = 'Desktop';

  return { browser, device, os };
}

async function sendAccountLockoutEmail(email: string, lockoutEnd: Date, ipAddress?: string, userAgent?: string) {
  const lockoutEndLocal = lockoutEnd.toLocaleString();
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899';
  const userAgentInfo = parseUserAgent(userAgent);

  const html = `
    <html>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #fef2f2; padding: 40px 0; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); border-top: 4px solid #dc2626;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 180px; height: auto;" />
          </div>
          
          <h1 style="color: #991b1b; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 24px;">Account Locked</h1>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Your account has been temporarily locked due to multiple failed login attempts.
          </p>
          
          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Your account will be unlocked at: <strong>${lockoutEndLocal}</strong>
          </p>
          
          ${ipAddress ? `<p style="color: #374151; line-height: 1.6; margin-bottom: 8px;"><strong>IP Address:</strong> ${ipAddress}</p>` : ''}
          
          ${userAgent ? `
            <div style="margin: 20px 0;">
              <p style="color: #374151; line-height: 1.6; margin-bottom: 8px;"><strong>Device:</strong> ${userAgentInfo.device}</p>
              <p style="color: #374151; line-height: 1.6; margin-bottom: 8px;"><strong>Browser:</strong> ${userAgentInfo.browser}</p>
              <p style="color: #374151; line-height: 1.6;"><strong>Operating System:</strong> ${userAgentInfo.os}</p>
            </div>
          ` : ''}
          
          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
            If you didn't attempt to login, please reset your password immediately and contact support.
          </p>

          <div style="text-align: center; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 24px;">
            <p style="color: #9ca3af; font-size: 12px;">
              &copy; ${new Date().getFullYear()} Metricorex. All rights reserved.
            </p>
          </div>
        </div>
      </body>
    </html>
  `;

  await sendEmail(email, "Account Locked - Metricorex", "Your account has been locked", html);
}

async function sendLoginNotificationEmail(email: string, ipAddress?: string, userAgent?: string) {
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899';
  const userAgentInfo = parseUserAgent(userAgent);

  const html = `
    <html>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; padding: 40px 0; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); border-top: 4px solid #1d4ed8;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 180px; height: auto;" />
          </div>
          
          <h1 style="color: #111827; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 24px;">New Login to Your Account</h1>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            A new login was detected to your Metricorex account.
          </p>
          
          ${ipAddress ? `<p style="color: #374151; line-height: 1.6; margin-bottom: 8px;"><strong>IP Address:</strong> ${ipAddress}</p>` : ''}
          
          ${userAgent ? `
            <div style="margin: 20px 0;">
              <p style="color: #374151; line-height: 1.6; margin-bottom: 8px;"><strong>Device:</strong> ${userAgentInfo.device}</p>
              <p style="color: #374151; line-height: 1.6; margin-bottom: 8px;"><strong>Browser:</strong> ${userAgentInfo.browser}</p>
              <p style="color: #374151; line-height: 1.6;"><strong>Operating System:</strong> ${userAgentInfo.os}</p>
            </div>
          ` : ''}
          
          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
            If this was you, you can ignore this email. If you didn't login, please reset your password immediately and contact support.
          </p>

          <div style="text-align: center; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 24px;">
            <p style="color: #9ca3af; font-size: 12px;">
              &copy; ${new Date().getFullYear()} Metricorex. All rights reserved.
            </p>
          </div>
        </div>
      </body>
    </html>
  `;

  await sendEmail(email, "New Login Detected - Metricorex", "New login to your account", html);
}
