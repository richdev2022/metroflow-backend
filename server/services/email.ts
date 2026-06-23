import axios from "axios";
import nodemailer from "nodemailer";

// Configure Nodemailer Transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_SECURE === "true", // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_URL = process.env.BREVO_BASE_URL || "https://api.brevo.com/v3/smtp/email";

async function sendEmailViaBrevo(payload: any) {
    try {
        const response = await axios.post(
            `${BREVO_URL}/v3/smtp/email`,
            {
                sender: payload.sender,
                to: payload.to,
                subject: payload.subject,
                htmlContent: payload.htmlContent,
                replyTo: payload.replyTo
            },
            {
                headers: {
                    'api-key': BREVO_API_KEY,
                    'Content-Type': 'application/json',
                    'accept': 'application/json'
                },
                timeout: parseInt(process.env.BREVO_TIMEOUT_SECONDS || '30') * 1000
            }
        );
        console.log("Email sent via Brevo:", response.data?.messageId);
        return response.data;
    } catch (error: any) {
        console.error("Brevo Email Error:", error.response?.data || error.message);
        throw error;
    }
}

export async function sendEmail(
  to: string | EmailPayload | { email: string; name?: string }[],
  nameOrSubject?: string,
  subjectOrHtml?: string,
  htmlContent?: string
) {
  try {
    let recipientEmail = "";
    let recipientName = "";
    let subject = "";
    let html = "";

    // Handle overload: sendEmail(to: string, name: string, subject: string, html: string)
    if (typeof to === "string") {
      recipientEmail = to;
      recipientName = nameOrSubject || "";
      subject = subjectOrHtml || "";
      html = htmlContent || "";
    } else if (Array.isArray(to)) {
      const recipients = (to as { email: string; name?: string }[]).map(r => r.email).join(",");
      recipientEmail = recipients;
      recipientName = nameOrSubject || "";
      subject = subjectOrHtml || "";
      html = htmlContent || "";
    }

    // Prepare payload for Brevo/Nodemailer
    let payload: any = {};
    
    if (typeof to === 'object' && !Array.isArray(to)) {
        // It's the object payload style
        payload = to;
    } else {
        // Construct payload from arguments
        payload = {
            sender: {
                name: process.env.BREVO_SENDER_NAME || process.env.EMAIL_FROM_NAME || 'Metricorex',
                email: process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM_ADDRESS || 'no-reply@metricorex.com'
            },
            to: [{ email: recipientEmail, name: recipientName }],
            subject: subject,
            htmlContent: html
        };
    }

    // Try Brevo first if API Key is present
    if (BREVO_API_KEY) {
        return await sendEmailViaBrevo(payload);
    }

    // Fallback to Nodemailer
    if (typeof to === 'object' && !Array.isArray(to)) {
        // It's the object payload style
        const info = await transporter.sendMail({
            from: `"${payload.sender.name}" <${payload.sender.email}>`,
            to: payload.to.map((r: any) => r.email).join(", "),
            subject: payload.subject,
            html: payload.htmlContent,
            replyTo: payload.replyTo?.email
        });
        console.log("Email sent:", info.messageId);
        return info;
    }
    
    // 4-arg style (or array converted to string)
    if (recipientEmail) {
        const info = await transporter.sendMail({
            from: `"${process.env.EMAIL_FROM_NAME || 'Metricorex'}" <${process.env.EMAIL_FROM_ADDRESS || 'no-reply@metricorex.com'}>`,
            to: `"${recipientName}" <${recipientEmail}>`,
            subject: subject,
            html: html,
        });
        console.log("Email sent:", info.messageId);
        return info;
    }

  } catch (error) {
    console.error("Error sending email:", error);
    // Don't throw to avoid breaking the flow, just log
  }
}

export interface EmailPayload {
  to: Array<{
    email: string;
    name?: string;
  }>;
  subject: string;
  htmlContent: string;
  sender: {
    name: string;
    email: string;
  };
  replyTo?: {
    email: string;
  };
}

export function generateInviteEmailHtml(
  teamMemberName: string,
  inviteLink: string,
): string {
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899';

  return `
    <html>
      <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <div style="text-align: center; margin-bottom: 20px;">
            <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 150px; height: auto;" />
          </div>
          <h2 style="color: #1d4ed8; margin-bottom: 20px;">Welcome to Metricorex!</h2>

          <p style="color: #333; margin-bottom: 15px;">Hi ${teamMemberName},</p>

          <p style="color: #666; line-height: 1.6; margin-bottom: 15px;">
            You have been invited to join our Team Performance Tracking system.
            Click the link below to accept the invitation and start tracking your performance metrics.
          </p>

          <div style="margin: 30px 0; text-align: center;">
            <a href="${inviteLink}"
               style="background-color: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">
              Accept Invitation
            </a>
          </div>

          <p style="color: #999; font-size: 12px; margin-top: 20px;">
            Or copy and paste this link in your browser: <br/>
            <span style="word-break: break-all;">${inviteLink}</span>
          </p>

          <p style="color: #999; font-size: 12px; margin-top: 15px;">
            This link will expire in 7 days.
          </p>
        </div>
      </body>
    </html>
  `;
}

export function generateAdminInviteEmailHtml(
  adminName: string,
  adminEmail: string,
  tempPassword: string,
  loginLink: string
): string {
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899';

  return `
    <html>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; padding: 40px 0; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          <div style="text-align: center; margin-bottom: 30px;">
             <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 180px; height: auto;" />
          </div>
          
          <h1 style="color: #111827; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 24px;">Admin Access Invitation</h1>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Hello ${adminName},
          </p>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            You have been invited to join the <strong>Metricorex</strong> platform as an Administrator.
          </p>

          <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; margin-bottom: 24px;">
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Your Login Credentials</p>
            
            <div style="margin-bottom: 16px;">
              <span style="color: #4b5563; font-size: 14px;">Email:</span><br/>
              <strong style="color: #111827; font-size: 16px;">${adminEmail}</strong>
            </div>
            
            <div>
              <span style="color: #4b5563; font-size: 14px;">Temporary Password:</span><br/>
              <code style="background-color: #e0e7ff; color: #4338ca; padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 18px; font-weight: 600; letter-spacing: 1px;">${tempPassword}</code>
            </div>
          </div>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
            Please click the button below to log in. You can decide to reset your password.
          </p>

          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${loginLink}"
               style="background-color: #2563eb; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2);">
              Login to Admin Dashboard
            </a>
          </div>

          <p style="color: #6b7280; font-size: 14px; text-align: center; margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 24px;">
            If the button above doesn't work, copy and paste this link into your browser:<br/>
            <a href="${loginLink}" style="color: #2563eb; text-decoration: none; word-break: break-all;">${loginLink}</a>
          </p>
          
          <div style="text-align: center; margin-top: 24px;">
            <p style="color: #9ca3af; font-size: 12px;">
              &copy; ${new Date().getFullYear()} Metricorex. All rights reserved.
            </p>
          </div>
        </div>
      </body>
    </html>
  `;
}

export function generateBusinessRegistrationEmailHtml(
  userName: string,
  businessName: string,
  loginLink: string,
): string {
  const logoUrl = process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/Assets/logo.png` : 'https://via.placeholder.com/150x50/2563eb/ffffff?text=KPI+Tracker';

  return `
    <html>
      <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <div style="text-align: center; margin-bottom: 20px;">
            <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 150px; height: auto;" />
          </div>
          <h2 style="color: #1d4ed8; margin-bottom: 20px; text-align: center;">Welcome to Metricorex!</h2>

          <p style="color: #333; margin-bottom: 15px;">Hi ${userName},</p>

          <p style="color: #666; line-height: 1.6; margin-bottom: 15px;">
            Congratulations! Your business <strong>${businessName}</strong> has been successfully registered with Metricorex.
          </p>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            You can now start tracking your team's performance metrics, creating tasks, and monitoring progress.
          </p>

          <div style="background-color: #f0f9ff; padding: 15px; border-left: 4px solid #2563eb; margin: 20px 0;">
            <p style="margin: 0; color: #1e40af; font-weight: bold;">Next Steps:</p>
            <ul style="margin: 10px 0 0 20px; color: #374151; padding: 0;">
              <li>Invite team members to join your business</li>
              <li>Create your first tasks and set targets</li>
              <li>Start tracking performance metrics</li>
            </ul>
          </div>

          <div style="margin: 30px 0; text-align: center;">
            <a href="${loginLink}"
               style="background-color: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">
              Access Your Dashboard
            </a>
          </div>

          <p style="color: #999; font-size: 12px; margin-top: 20px; text-align: center;">
            If you have any questions, feel free to contact our support team.
          </p>
        </div>
      </body>
    </html>
  `;
}

export async function sendTaskNotification(
  businessId: string,
  actionType: string,
  taskTitle: string,
  taskDescription: string,
  actorName: string,
  taskId: string,
): Promise<void> {
  try {
    // Get all users in the business
    const { query } = await import("../db");
    const usersResult = await query(
      "SELECT id, name, email FROM users WHERE business_id = $1 AND email_verified = TRUE",
      [businessId]
    );

    if (usersResult.rows.length === 0) {
      return;
    }

    const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
    const taskLink = baseUrl ? `${baseUrl}/tasks` : 'http://localhost:8080/tasks';

    // Send email to each user
    for (const user of usersResult.rows) {
      const emailHtml = generateTaskActivityEmailHtml(
        actionType,
        taskTitle,
        taskDescription,
        actorName,
        taskLink
      );

      await sendEmail(
        user.email,
        user.name,
        `Task ${actionType}: ${taskTitle}`,
        emailHtml
      );
    }
  } catch (error) {
    console.error("Failed to send task notifications:", error);
  }
}


export async function sendCommentNotification(
  businessId: string,
  action: "added" | "deleted",
  content: string,
  actorName: string,
  targetTitle: string,
  targetType: "task" | "epic"
): Promise<void> {
  try {
    const { query } = await import("../db");
    const usersResult = await query(
      "SELECT id, name, email FROM users WHERE business_id = $1 AND email_verified = TRUE",
      [businessId]
    );

    if (usersResult.rows.length === 0) return;

    // Filter out the actor (don't email the person who commented)
    const recipients = usersResult.rows.filter(u => u.name !== actorName);

    if (recipients.length === 0) return;

    const subject = `Comment ${action} on ${targetType}: ${targetTitle}`;
    const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
    const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://via.placeholder.com/150x50/2563eb/ffffff?text=KPI+Tracker';

    for (const user of recipients) {
      const emailHtml = `
        <html>
          <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <div style="text-align: center; margin-bottom: 20px;">
                <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 150px; height: auto;" />
              </div>
              <h2 style="color: #1d4ed8; margin-bottom: 20px;">Comment Activity</h2>
              
              <p style="color: #333; margin-bottom: 15px;">
                <strong>${actorName}</strong> ${action} a comment on ${targetType}: <strong>${targetTitle}</strong>
              </p>
              
              <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #2563eb; margin: 20px 0;">
                <p style="margin: 0; color: #333; white-space: pre-wrap;">${content}</p>
              </div>
              
              <p style="color: #999; font-size: 12px; margin-top: 20px;">
                You received this email because you are a member of this business.
              </p>
            </div>
          </body>
        </html>
      `;
      
      await sendEmail(user.email, user.name, subject, emailHtml);
    }
  } catch (error) {
    console.error("Failed to send comment notification:", error);
  }
}

export async function sendMentionNotification(
  businessId: string,
  mentionedUserIds: string[], // List of user IDs mentioned
  commentContent: string,
  actorName: string,
  targetTitle: string,
  targetType: "task" | "epic",
  targetId: string, // taskId or epicId
  commentId: string
): Promise<void> {
  try {
    const { query } = await import("../db");
    
    if (mentionedUserIds.length === 0) return;

    // Fetch mentioned users details
    // We need to convert array to parameter list $1, $2, ...
    const placeholders = mentionedUserIds.map((_, i) => `$${i + 2}`).join(',');
    const usersResult = await query(
      `SELECT id, name, email FROM users WHERE business_id = $1 AND id IN (${placeholders}) AND email_verified = TRUE`,
      [businessId, ...mentionedUserIds]
    );

    if (usersResult.rows.length === 0) return;

    const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
    // Construct link based on target type
    // Assuming /tasks handles both or we have /epics route. 
    // If it's a task, link to task. If epic, link to epic page or backlog?
    // For now point to tasks page with some query param or just tasks page
    const targetLink = baseUrl 
        ? `${baseUrl}/${targetType === 'task' ? 'tasks' : 'backlog'}?${targetType}Id=${targetId}` 
        : `http://localhost:8080/${targetType === 'task' ? 'tasks' : 'backlog'}`;

    const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://via.placeholder.com/150x50/2563eb/ffffff?text=KPI+Tracker';

    for (const user of usersResult.rows) {
      const subject = `You were mentioned in a comment on ${targetType}: ${targetTitle}`;
      
      const emailHtml = `
        <html>
          <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <div style="text-align: center; margin-bottom: 20px;">
                <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 150px; height: auto;" />
              </div>
              <h2 style="color: #1d4ed8; margin-bottom: 20px;">You were mentioned!</h2>
              
              <p style="color: #333; margin-bottom: 15px;">
                <strong>${actorName}</strong> mentioned you in a comment on ${targetType}: <strong>${targetTitle}</strong>
              </p>
              
              <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #2563eb; margin: 20px 0;">
                <p style="margin: 0; color: #333; white-space: pre-wrap;">${commentContent}</p>
              </div>
              
              <div style="margin: 30px 0; text-align: center;">
                <a href="${targetLink}"
                   style="background-color: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">
                  View Comment
                </a>
              </div>
              
              <p style="color: #999; font-size: 12px; margin-top: 20px;">
                You received this email because you were mentioned in a comment.
              </p>
            </div>
          </body>
        </html>
      `;
      
      await sendEmail(user.email, user.name, subject, emailHtml);
    }
  } catch (error) {
    console.error("Failed to send mention notification:", error);
  }
}

export async function sendTransferFailureNotification(
  adminEmails: string[],
  businessName: string,
  reference: string,
  recipientName: string,
  amount: number,
  currency: string,
  failureReason: string
) {
  const subject = `Transfer Failed - ${reference}`;
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899';

  const htmlContent = `
    <html>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #fef2f2; padding: 40px 0; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); border-top: 4px solid #ef4444;">
          <div style="text-align: center; margin-bottom: 30px;">
             <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 180px; height: auto;" />
          </div>
          
          <h1 style="color: #991b1b; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 24px;">Transfer Failed</h1>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            A transfer for <strong>${businessName}</strong> could not be completed.
          </p>

          <div style="background-color: #fff5f5; border: 1px solid #fecaca; border-radius: 8px; padding: 24px; margin-bottom: 24px;">
            <div style="margin-bottom: 12px; display: flex; justify-content: space-between; border-bottom: 1px solid #fee2e2; padding-bottom: 8px;">
              <span style="color: #7f1d1d; font-weight: 600;">Reference</span>
              <span style="color: #374151; font-family: monospace;">${reference}</span>
            </div>
            <div style="margin-bottom: 12px; display: flex; justify-content: space-between; border-bottom: 1px solid #fee2e2; padding-bottom: 8px;">
              <span style="color: #7f1d1d; font-weight: 600;">Recipient</span>
              <span style="color: #374151;">${recipientName}</span>
            </div>
            <div style="margin-bottom: 12px; display: flex; justify-content: space-between; border-bottom: 1px solid #fee2e2; padding-bottom: 8px;">
              <span style="color: #7f1d1d; font-weight: 600;">Amount</span>
              <span style="color: #374151;">${currency} ${amount}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: #7f1d1d; font-weight: 600;">Reason</span>
              <span style="color: #ef4444; font-weight: 500;">${failureReason}</span>
            </div>
          </div>

          <p style="color: #6b7280; font-size: 14px; text-align: center;">
            Please check your dashboard to retry the transaction or investigate the issue.
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

  for (const email of adminEmails) {
    await sendEmail({
      to: [{ email }],
      subject,
      htmlContent,
      sender: { name: "Metricorex", email: "no-reply@metricorex.com" },
      replyTo: { email: "support@metricorex.com" },
    });
  }
}

export async function sendPayrollAdjustmentNotification(
  emails: string[],
  recipientName: string,
  type: string,
  amount: number,
  currency: string,
  reason: string,
  businessName: string
) {
  const subject = `Payroll Adjustment Notification - ${businessName}`;
  const adjustmentType = type.charAt(0).toUpperCase() + type.slice(1);
  const isBonus = type.toLowerCase() === 'bonus';
  const color = isBonus ? '#10b981' : '#ef4444'; // Green for bonus, Red for deduction

  const htmlContent = `
    <html>
      <body style="font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; background-color: #f9fafb;">
        <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h2 style="color: #111827;">Payroll Adjustment Notice</h2>
          <p>This is to inform you that a <strong>${adjustmentType}</strong> has been applied to the upcoming payroll for <strong>${recipientName}</strong>.</p>
          
          <div style="background-color: ${isBonus ? '#ecfdf5' : '#fef2f2'}; border-left: 4px solid ${color}; padding: 15px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>Type:</strong> <span style="color: ${color}; font-weight: bold;">${adjustmentType}</span></p>
            <p style="margin: 5px 0;"><strong>Amount:</strong> ${currency} ${amount}</p>
            <p style="margin: 5px 0;"><strong>Reason:</strong> ${reason}</p>
          </div>

          <p style="color: #6b7280; font-size: 14px;">This adjustment will be reflected in the next salary processing.</p>
        </div>
      </body>
    </html>
  `;

  for (const email of emails) {
    await sendEmail({
      to: [{ email }],
      subject,
      htmlContent,
      sender: { name: "Metricorex", email: "no-reply@metricorex.com" },
      replyTo: { email: "support@metricorex.com" },
    });
  }
}

export function generateOtpEmailHtml(
  otpCode: string,
  purpose: string = "Transaction Verification"
): string {
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899';

  return `
    <html>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; padding: 40px 0; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          <div style="text-align: center; margin-bottom: 30px;">
             <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 180px; height: auto;" />
          </div>
          
          <h1 style="color: #111827; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 24px;">${purpose}</h1>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px; text-align: center;">
            Use the One-Time Password (OTP) below to complete your request.
          </p>

          <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; margin-bottom: 24px; text-align: center;">
            <span style="color: #6b7280; font-size: 14px; margin-bottom: 8px; display: block; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Your OTP Code</span>
            <code style="color: #2563eb; font-size: 32px; font-weight: 700; letter-spacing: 4px; display: block;">${otpCode}</code>
          </div>

          <p style="color: #6b7280; font-size: 14px; text-align: center; margin-bottom: 8px;">
            This code is valid for <strong>10 minutes</strong>.
          </p>
          <p style="color: #ef4444; font-size: 14px; text-align: center; margin-bottom: 32px; font-weight: 500;">
            Do not share this code with anyone.
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
}

export function generateTaskActivityEmailHtml(
  actionType: string,
  taskTitle: string,
  taskDescription: string,
  actorName: string,
  taskLink: string,
): string {
  const logoUrl = process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/Assets/logo.png` : 'https://via.placeholder.com/150x50/2563eb/ffffff?text=KPI+Tracker';

  const actionLabels: Record<string, string> = {
    created: "created a new task",
    updated: "updated a task",
    completed: "marked a task as completed",
    deleted: "deleted a task",
    commented: "added a comment to a task",
    assigned: "assigned you a task",
  };

  const label = actionLabels[actionType] || actionType;
  const backgroundColor = actionType === "deleted" ? "#ef4444" : "#2563eb";

  return `
    <html>
      <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <div style="text-align: center; margin-bottom: 20px;">
            <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 150px; height: auto;" />
          </div>
          <h2 style="color: #1d4ed8; margin-bottom: 20px;">KPI Task Activity</h2>

          <p style="color: #333; margin-bottom: 15px;">
            <strong>${actorName}</strong> ${label}
          </p>

          <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid ${backgroundColor}; margin: 20px 0;">
            <p style="margin: 0 0 10px 0; font-weight: bold; color: #333;">${taskTitle}</p>
            <p style="margin: 0; color: #666; font-size: 14px;">${taskDescription}</p>
          </div>

          <div style="margin: 30px 0; text-align: center;">
            <a href="${taskLink}"
               style="background-color: ${backgroundColor}; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">
              View Task
            </a>
          </div>

          <p style="color: #999; font-size: 12px; margin-top: 20px;">
            You received this email because you are assigned to this task or are an admin.
          </p>
        </div>
      </body>
    </html>
  `;
}

export function generateKYCOtpEmailHtml(
  userName: string,
  otp: string,
  expiresInMinutes: number = 10
): string {
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899';

  return `
    <html>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; padding: 40px 0; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          <div style="text-align: center; margin-bottom: 30px;">
             <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 180px; height: auto;" />
          </div>
          
          <h1 style="color: #111827; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 24px;">KYC Verification</h1>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Hello ${userName},
          </p>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            To complete your identity verification, please use the One-Time Password (OTP) below.
          </p>

          <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; margin-bottom: 24px; text-align: center;">
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 16px 0; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Your Verification Code</p>
            
            <div style="font-family: monospace; font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #2563eb;">
              ${otp}
            </div>
          </div>

          <p style="color: #374151; font-size: 14px; line-height: 1.6; margin-bottom: 8px; text-align: center;">
            This code is valid for <strong>${expiresInMinutes} minutes</strong>.
          </p>
          
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6; margin-bottom: 32px; text-align: center;">
            Do not share this code with anyone. Metricorex support will never ask for this code.
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
}

export function generateSubscriptionCancelledEmail(
  businessName: string,
  planName: string
): string {
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899';

  return `
    <html>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; padding: 40px 0; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          <div style="text-align: center; margin-bottom: 30px;">
             <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 180px; height: auto;" />
          </div>
          
          <h1 style="color: #111827; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 24px;">Your Subscription Has Been Cancelled</h1>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Hello ${businessName},
          </p>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            This is to confirm that your subscription to the <strong>${planName}</strong> plan has been cancelled.
          </p>

          <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 20px; margin-bottom: 24px; border-radius: 4px;">
            <p style="color: #92400e; font-size: 14px; margin: 0;">
              Your access will continue until your current billing period ends. After that, you will be moved to our free plan.
            </p>
          </div>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
            We're sorry to see you go! If you have any feedback or if there's anything we can do to improve, please don't hesitate to reach out.
          </p>

          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${baseUrl || 'https://app.metricorex.com'}" style="background-color: #2563eb; color: #ffffff; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px; display: inline-block;">
              Visit Metricorex
            </a>
          </div>

          <div style="text-align: center; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 24px;">
            <p style="color: #9ca3af; font-size: 12px;">
              &copy; ${new Date().getFullYear()} Metricorex. All rights reserved.
            </p>
          </div>
        </div>
      </body>
    </html>
  `;
}

export function generateSubscriptionDowngradedEmail(
  businessName: string,
  oldPlanName: string,
  newPlanName: string
): string {
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899';

  return `
    <html>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; padding: 40px 0; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          <div style="text-align: center; margin-bottom: 30px;">
             <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 180px; height: auto;" />
          </div>
          
          <h1 style="color: #111827; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 24px;">Your Subscription Has Been Downgraded</h1>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Hello ${businessName},
          </p>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            This is to confirm that your subscription has been changed from <strong>${oldPlanName}</strong> to <strong>${newPlanName}</strong>.
          </p>

          <div style="background-color: #ecfdf5; border-left: 4px solid #10b981; padding: 20px; margin-bottom: 24px; border-radius: 4px;">
            <p style="color: #065f46; font-size: 14px; margin: 0;">
              Your downgrade will take effect at the end of your current billing period. Until then, you'll continue to have access to your current plan features.
            </p>
          </div>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
            Thank you for being a Metricorex customer! If you have any questions, please don't hesitate to contact our support team.
          </p>

          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${baseUrl || 'https://app.metricorex.com'}" style="background-color: #2563eb; color: #ffffff; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px; display: inline-block;">
              Visit Metricorex
            </a>
          </div>

          <div style="text-align: center; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 24px;">
            <p style="color: #9ca3af; font-size: 12px;">
              &copy; ${new Date().getFullYear()} Metricorex. All rights reserved.
            </p>
          </div>
        </div>
      </body>
    </html>
  `;
}

export function generateRenewalFailedEmail(
  businessName: string,
  planName: string,
  reason: string
): string {
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const logoUrl = baseUrl ? `${baseUrl}/Assets/logo.png` : 'https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899';

  return `
    <html>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #fef2f2; padding: 40px 0; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); border-top: 4px solid #ef4444;">
          <div style="text-align: center; margin-bottom: 30px;">
             <img src="${logoUrl}" alt="Metricorex Logo" style="max-width: 180px; height: auto;" />
          </div>
          
          <h1 style="color: #991b1b; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 24px;">Subscription Renewal Failed</h1>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Hello ${businessName},
          </p>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            We attempted to renew your <strong>${planName}</strong> subscription, but the payment failed.
          </p>

          <div style="background-color: #fee2e2; border: 1px solid #fecaca; padding: 20px; margin-bottom: 24px; border-radius: 8px;">
            <p style="color: #991b1b; font-size: 14px; margin: 0 0 8px 0; font-weight: 600;">Failure Reason:</p>
            <p style="color: #7f1d1d; font-size: 16px; margin: 0;">${reason}</p>
          </div>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            To avoid service interruption, please update your payment method as soon as possible.
          </p>

          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${baseUrl || 'https://app.metricorex.com'}/billing" style="background-color: #ef4444; color: #ffffff; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px; display: inline-block;">
              Update Payment Method
            </a>
          </div>

          <div style="text-align: center; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 24px;">
            <p style="color: #9ca3af; font-size: 12px;">
              &copy; ${new Date().getFullYear()} Metricorex. All rights reserved.
            </p>
          </div>
        </div>
      </body>
    </html>
  `;
}
