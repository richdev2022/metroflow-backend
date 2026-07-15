import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: Get notifications for the authenticated user
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: unreadOnly
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: Notifications retrieved successfully
 */
export const getNotifications: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const unreadOnly = req.query.unreadOnly === "true";

    // Delete expired notifications first
    await query(
      `DELETE FROM notifications WHERE expires_at < NOW()`,
      []
    );

    const countResult = await query(
      `SELECT COUNT(*) as total FROM notifications 
       WHERE business_id = $1 AND user_id = $2 
       ${unreadOnly ? "AND is_read = false" : ""}`,
      [businessId, userId]
    );
    const total = parseInt(countResult.rows[0].total);

    const result = await query(
      `SELECT * FROM notifications 
       WHERE business_id = $1 AND user_id = $2 
       ${unreadOnly ? "AND is_read = false" : ""}
       ORDER BY created_at DESC 
       LIMIT $3 OFFSET $4`,
      [businessId, userId, limit, offset]
    );

    const response: ApiResponse<{ notifications: any[]; total: number }> = {
      success: true,
      data: { notifications: result.rows, total },
    };
    res.json(response);
  } catch (error) {
    console.error("Get notifications error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to retrieve notifications",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /notifications/{id}/read:
 *   patch:
 *     summary: Mark a notification as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Notification marked as read successfully
 */
export const markNotificationAsRead: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const result = await query(
      `UPDATE notifications 
       SET is_read = true, updated_at = NOW() 
       WHERE id = $1 AND business_id = $2 AND user_id = $3 
       RETURNING *`,
      [id, businessId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Notification not found",
      });
    }

    const response: ApiResponse<any> = {
      success: true,
      data: result.rows[0],
    };
    res.json(response);
  } catch (error) {
    console.error("Mark notification as read error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to mark notification as read",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /notifications/read-all:
 *   patch:
 *     summary: Mark all notifications as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read successfully
 */
export const markAllNotificationsAsRead: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    await query(
      `UPDATE notifications 
       SET is_read = true, updated_at = NOW() 
       WHERE business_id = $1 AND user_id = $2 AND is_read = false`,
      [businessId, userId]
    );

    const response: ApiResponse<null> = {
      success: true,
    };
    res.json(response);
  } catch (error) {
    console.error("Mark all notifications as read error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to mark all notifications as read",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /notifications/{id}/action:
 *   post:
 *     summary: Take action on an actionable notification
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *             properties:
 *               action:
 *                 type: string
 *                 description: The action to take (e.g., accept, decline)
 *     responses:
 *       200:
 *         description: Action taken successfully
 */
export const takeNotificationAction: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  try {
    const { id } = req.params;
    const { action } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const result = await query(
      `UPDATE notifications 
       SET is_read = true, action_taken = $1, updated_at = NOW() 
       WHERE id = $2 AND business_id = $3 AND user_id = $4 AND is_actionable = true
       RETURNING *`,
      [action, id, businessId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Notification not found or not actionable",
      });
    }

    const response: ApiResponse<any> = {
      success: true,
      data: result.rows[0],
    };
    res.json(response);
  } catch (error) {
    console.error("Take notification action error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to take action on notification",
    };
    res.status(500).json(response);
  }
};
