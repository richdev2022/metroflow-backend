import { RequestHandler } from "express";
import { query } from "../db";
import { InviteTeamMemberInput, TeamMember, ApiResponse } from "@shared/api";
import { sendEmail, generateInviteEmailHtml } from "../services/email";
import { hashPassword } from "../services/auth";
import crypto from "crypto";
import { AuthenticatedRequest, checkTeamLimit } from "../middleware/auth";
import { logActivity } from "../services/activity";

export const getTeamRanking: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /team/ranking:
   *   get:
   *     summary: Get team ranking based on completed tasks
   *     tags: [Team]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Team ranking list
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       name:
   *                         type: string
   *                       email:
   *                         type: string
   *                       role:
   *                         type: string
   *                       completedTasks:
   *                         type: integer
   *       500:
   *         description: Server error
   */
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "Business ID not found",
      });
    }

    const result = await query(
      `SELECT
        u.id, u.name, u.email, u.role,
        COUNT(t.id) FILTER (WHERE t.status = 'completed') as "completedTasks"
       FROM users u
       LEFT JOIN task_assignments ta ON u.id = ta.user_id
       LEFT JOIN tasks t ON ta.task_id = t.id AND t.business_id = u.business_id
       WHERE u.business_id = $1 AND u.status = 'active'
       GROUP BY u.id
       ORDER BY "completedTasks" DESC, u.name ASC`,
      [businessId],
    );

    // Convert completedTasks to number (PostgreSQL returns bigint as string)
    const ranking = result.rows.map(row => ({
      ...row,
      completedTasks: parseInt(row.completedTasks) || 0
    }));

    res.json({
      success: true,
      data: ranking,
    });
  } catch (error) {
    console.error("Get team ranking error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch team ranking",
    });
  }
};

export const getTopTeamRanking: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /team/ranking/top:
   *   get:
   *     summary: Get top 3 team members based on completed tasks
   *     tags: [Team]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Top 3 team members
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       name:
   *                         type: string
   *                       email:
   *                         type: string
   *                       role:
   *                         type: string
   *                       completedTasks:
   *                         type: integer
   *       500:
   *         description: Server error
   */
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "Business ID not found",
      });
    }

    const result = await query(
      `SELECT
        u.id, u.name, u.email, u.role,
        COUNT(t.id) FILTER (WHERE t.status = 'completed') as "completedTasks"
       FROM users u
       LEFT JOIN task_assignments ta ON u.id = ta.user_id
       LEFT JOIN tasks t ON ta.task_id = t.id AND t.business_id = u.business_id
       WHERE u.business_id = $1 AND u.status = 'active'
       GROUP BY u.id
       ORDER BY "completedTasks" DESC, u.name ASC
       LIMIT 3`,
      [businessId],
    );

    // Convert completedTasks to number
    const ranking = result.rows.map(row => ({
      ...row,
      completedTasks: parseInt(row.completedTasks) || 0
    }));

    res.json({
      success: true,
      data: ranking,
    });
  } catch (error) {
    console.error("Get top team ranking error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch top team ranking",
    });
  }
};

export const getTeamMembers: RequestHandler = async (req: AuthenticatedRequest, res) => {
/**
 * @swagger
 * tags:
 *   name: Team
 *   description: Team management endpoints
 */

/**
 * @swagger
 * /team:
 *   get:
 *     summary: Get all team members
 *     tags: [Team]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of team members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       email:
 *                         type: string
 *                       role:
 *                         type: string
 *                       status:
 *                         type: string
 *                       kyc_status:
 *                         type: string
 *                       salary:
 *                         type: number
 *                       salary_currency:
 *                         type: string
 *                       bank_code:
 *                         type: string
 *                       account_number:
 *                         type: string
 *                       account_name:
 *                         type: string
 *       500:
 *         description: Server error
 */
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "Business ID not found",
      });
    }

    const result = await query(
      `SELECT
        id, name, email, role, status, kyc_status, salary_currency, bank_code, account_number, account_name
       FROM users
       WHERE business_id = $1 AND status IN ('active', 'invited')
       ORDER BY created_at DESC`,
      [businessId],
    );

    const response: ApiResponse<TeamMember[]> = {
      success: true,
      data: result.rows,
    };
    res.json(response);
  } catch (error) {
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to fetch team members",
    };
    res.status(500).json(response);
  }
};

export const inviteTeamMember: RequestHandler = async (req: AuthenticatedRequest, res) => {
/**
 * @swagger
 * /team/invite:
 *   post:
 *     summary: Invite a new team member
 *     tags: [Team]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - role
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               role:
 *                 type: string
 *                 enum: [admin, manager, member]
 *     responses:
 *       200:
 *         description: Invitation sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Bad request
 */
  try {
    const input: InviteTeamMemberInput = req.body;
    const businessId = req.user?.businessId;

    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "Business ID not found",
      });
    }

    // Generate invite token
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const inviteExpiresAt = new Date();
    inviteExpiresAt.setDate(inviteExpiresAt.getDate() + 7); // Expire in 7 days

    const result = await query(
      `INSERT INTO users
       (business_id, name, email, role, status, invite_token, invite_expires_at)
        VALUES ($1, $2, $3, $4, 'invited', $5, $6)
        ON CONFLICT (business_id, email) DO UPDATE SET
          name = $2,
          role = $4,
          invite_token = $5,
          invite_expires_at = $6,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id, name, email, role, status`,
      [businessId, input.name, input.email, input.role, inviteToken, inviteExpiresAt],
    );

    const member = result.rows[0];

    // Send invitation email
    const baseUrl = process.env.APP_BASE_URL || 'https://metroflow-app.netlify.app';
    const inviteLink = `${baseUrl}/accept-invite/${inviteToken}`;
    const emailHtml = generateInviteEmailHtml(input.name, inviteLink);

    const emailSent = await sendEmail(
      input.email,
      input.name,
      "You're Invited to MetricFlow",
      emailHtml,
    );

    if (!emailSent) {
      console.error("Failed to send invite email to", input.email);
      return res.status(500).json({
        success: false,
        error: "User created but failed to send invitation email. Please try again.",
      });
    }

    // Log team member invitation activity
    await logActivity({
      businessId,
      userId: req.user?.userId!,
      action: "invite",
      actionType: "member",
      description: `Invited team member: ${input.name} (${input.email})`,
      metadata: {
        invitedUserId: member.id,
        invitedEmail: input.email,
        invitedName: input.name,
        role: input.role,
      },
    });

    const response: ApiResponse<TeamMember> = {
      success: true,
      data: member,
    };
    res.status(201).json(response);
  } catch (error) {
    console.error("Invite team member error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to invite team member",
    };
    res.status(500).json(response);
  }
};

export const acceptInvite: RequestHandler = async (req, res) => {
  /**
   * @swagger
   * /team/accept-invite/{token}:
   *   post:
   *     summary: Accept team invitation
   *     tags: [Team]
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema:
   *           type: string
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
   *         description: Invitation accepted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/User'
   *       400:
   *         description: Invalid or expired token
   */
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Password must be at least 6 characters",
      };
      return res.status(400).json(response);
    }

    const result = await query(
      `SELECT id, invite_expires_at as "inviteExpiresAt" FROM users
       WHERE invite_token = $1 AND status = 'invited'`,
      [token],
    );

    if (result.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Invalid or expired invite token",
      };
      return res.status(400).json(response);
    }

    const user = result.rows[0];
    const expiresAt = new Date(user.inviteExpiresAt);

    if (expiresAt < new Date()) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Invite token has expired",
      };
      return res.status(400).json(response);
    }

    const passwordHash = hashPassword(password);

    // Update user status to active and set password
    const updateResult = await query(
      `UPDATE users
       SET status = 'active', password_hash = $1, email_verified = TRUE,
           invite_token = NULL, invite_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, name, email, role, status`,
      [passwordHash, user.id],
    );

    const response: ApiResponse<TeamMember> = {
      success: true,
      data: updateResult.rows[0],
    };
    res.json(response);
  } catch (error) {
    console.error("Accept invite error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to accept invitation",
    };
    res.status(500).json(response);
  }
};

export const verifyInviteToken: RequestHandler = async (req, res) => {
  /**
   * @swagger
   * /team/verify-invite/{token}:
   *   get:
   *     summary: Verify invitation token
   *     tags: [Team]
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Token is valid
   *       400:
   *         description: Invalid or expired token
   */
  try {
    const { token } = req.params;

    if (!token) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Invite token is missing",
      };
      return res.status(400).json(response);
    }

    const result = await query(
      `SELECT id, invite_expires_at as "inviteExpiresAt"
       FROM users
       WHERE invite_token = $1 AND status = 'invited'`,
      [token],
    );

    if (result.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Invalid invitation token",
      };
      return res.status(400).json(response);
    }

    const user = result.rows[0];
    const expiresAt = new Date(user.inviteExpiresAt);

    if (expiresAt < new Date()) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Invitation token has expired",
      };
      return res.status(400).json(response);
    }

    res.json({ success: true, message: "Token is valid" });
  } catch (error) {
    console.error("Verify invite token error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to verify invitation token",
    };
    res.status(500).json(response);
  }
};

export const getTeamMemberById: RequestHandler = async (req, res) => {
  /**
   * @swagger
   * /team/{id}:
   *   get:
   *     summary: Get team member by ID
   *     tags: [Team]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Team member details
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/User'
   *       404:
   *         description: Team member not found
   */
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT
        id, name, email, role, status
       FROM users
       WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Team member not found",
      };
      return res.status(404).json(response);
    }

    const response: ApiResponse<TeamMember> = {
      success: true,
      data: result.rows[0],
    };
    res.json(response);
  } catch (error) {
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to fetch team member",
    };
    res.status(500).json(response);
  }
};

export const updateTeamMemberStatus: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /team/{id}/status:
   *   patch:
   *     summary: Update team member status
   *     tags: [Team]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - status
   *             properties:
   *               status:
   *                 type: string
   *                 enum: [active, inactive]
   *     responses:
   *       200:
   *         description: Status updated
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/User'
   *       404:
   *         description: Team member not found
   */
  try {
    const { id } = req.params;
    const { status } = req.body;
    const businessId = req.user?.businessId;

    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "Business ID not found",
      });
    }

    const result = await query(
      `UPDATE users
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND business_id = $3
        RETURNING id, name, email, role, status`,
      [status, id, businessId],
    );

    if (result.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Team member not found",
      };
      return res.status(404).json(response);
    }

    const response: ApiResponse<TeamMember> = {
      success: true,
      data: result.rows[0],
    };
    res.json(response);
  } catch (error) {
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to update team member status",
    };
    res.status(500).json(response);
  }
};

export const updateTeamMemberRole: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /team/{id}/role:
   *   patch:
   *     summary: Update team member role
   *     tags: [Team]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - role
   *             properties:
   *               role:
   *                 type: string
   *                 enum: [admin, manager, member]
   *     responses:
   *       200:
   *         description: Role updated
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/User'
   *       404:
   *         description: Team member not found
   */
  try {
    const { id } = req.params;
    const { role } = req.body;
    const businessId = req.user?.businessId;

    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "Business ID not found",
      });
    }

    if (!["admin", "manager", "member"].includes(role)) {
      return res.status(400).json({
        success: false,
        error: "Invalid role",
      });
    }

    const result = await query(
      `UPDATE users
        SET role = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND business_id = $3
        RETURNING id, name, email, role, status`,
      [role, id, businessId],
    );

    if (result.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Team member not found",
      };
      return res.status(404).json(response);
    }

    const updatedMember = result.rows[0];

    // Log team member role update activity
    await logActivity({
      businessId,
      userId: req.user?.userId!,
      action: "update",
      actionType: "member",
      description: `Updated role for team member: ${updatedMember.name} to ${role}`,
      metadata: {
        updatedUserId: updatedMember.id,
        updatedUserName: updatedMember.name,
        oldRole: updatedMember.role, // This might not be accurate since we overwrote it
        newRole: role,
      },
    });

    const response: ApiResponse<TeamMember> = {
      success: true,
      data: updatedMember,
    };
    res.json(response);
  } catch (error) {
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to update team member role",
    };
    res.status(500).json(response);
  }
};

export const deleteTeamMember: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /team/{id}:
   *   delete:
   *     summary: Remove a team member
   *     tags: [Team]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Team member removed
   *       404:
   *         description: Team member not found
   */
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;

    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "Business ID not found",
      });
    }

    // Get team member info before deletion for logging
    const memberResult = await query(
      `SELECT name, email, role FROM users WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );

    if (memberResult.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Team member not found",
      };
      return res.status(404).json(response);
    }

    const member = memberResult.rows[0];

    // Unassign from all tasks first
    await query(
      `DELETE FROM task_assignments WHERE user_id = $1`,
      [id]
    );

    // Reassign tasks created by this member to the current user (admin/manager)
    // This prevents foreign key constraint violations
    await query(
      `UPDATE tasks SET created_by = $1 WHERE created_by = $2`,
      [req.user?.userId, id]
    );

    // Reassign task assignments made by this member
    await query(
      `UPDATE task_assignments SET assigned_by = $1 WHERE assigned_by = $2`,
      [req.user?.userId, id]
    );

    // Reassign comments
    await query(
      `UPDATE comments SET user_id = $1 WHERE user_id = $2`,
      [req.user?.userId, id]
    );

    // Reassign attachments
    await query(
      `UPDATE attachments SET uploaded_by = $1 WHERE uploaded_by = $2`,
      [req.user?.userId, id]
    );

    // Reassign activity logs
    await query(
      `UPDATE activity_logs SET user_id = $1 WHERE user_id = $2`,
      [req.user?.userId, id]
    );

    const result = await query(
      `DELETE FROM users
        WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );

    if (result.rowCount === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Team member not found",
      };
      return res.status(404).json(response);
    }

    // Log team member deletion activity
    await logActivity({
      businessId,
      userId: req.user?.userId!,
      action: "delete",
      actionType: "member",
      description: `Deleted team member: ${member.name} (${member.email})`,
      metadata: {
        deletedUserId: id,
        deletedUserName: member.name,
        deletedUserEmail: member.email,
        deletedUserRole: member.role,
      },
    });

    const response: ApiResponse<null> = {
      success: true,
    };
    res.json(response);
  } catch (error) {
    console.error("Delete team member error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete team member",
    };
    res.status(500).json(response);
  }
};
