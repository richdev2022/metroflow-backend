import axios from "axios";
import nodemailer from "nodemailer";
import { sendEmail } from "./email-sender";

export { sendEmail };

interface EmailPayload {
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
  replyTo: {
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
            <img src="${logoUrl}" alt="MetricFlow Logo" style="max-width: 150px; height: auto;" />
          </div>
          <h2 style="color: #1d4ed8; margin-bottom: 20px;">Welcome to MetricFlow!</h2>

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
             <img src="${logoUrl}" alt="MetroFlow Logo" style="max-width: 180px; height: auto;" />
          </div>
          
          <h1 style="color: #111827; font-size: 24px; font-weight: 700; text-align: center; margin-bottom: 24px;">Admin Access Invitation</h1>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Hello ${adminName},
          </p>

          <p style="color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            You have been invited to join the <strong>MetroFlow</strong> platform as an Administrator.
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
              &copy; ${new Date().getFullYear()} MetroFlow. All rights reserved.
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
            <img src="${logoUrl}" alt="MetricFlow Logo" style="max-width: 150px; height: auto;" />
          </div>
          <h2 style="color: #1d4ed8; margin-bottom: 20px; text-align: center;">Welcome to MetricFlow!</h2>

          <p style="color: #333; margin-bottom: 15px;">Hi ${userName},</p>

          <p style="color: #666; line-height: 1.6; margin-bottom: 15px;">
            Congratulations! Your business <strong>${businessName}</strong> has been successfully registered with MetricFlow.
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
                <img src="${logoUrl}" alt="MetricFlow Logo" style="max-width: 150px; height: auto;" />
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
                <img src="${logoUrl}" alt="MetricFlow Logo" style="max-width: 150px; height: auto;" />
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
            <img src="${logoUrl}" alt="MetricFlow Logo" style="max-width: 150px; height: auto;" />
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
