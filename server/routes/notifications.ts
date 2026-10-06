import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";

/**
 * Map a raw notifications table row (snake_case columns) to camelCase — the
 * shape the Prisma-backed endpoints emit and every client (web/mobile)
 * expects. The mobile app previously crashed on this endpoint with
 * "type 'Null' is not a subtype of type 'String' in type cast" because it
 * read camelCase keys off the raw snake_case rows.
 */
function mapNotificationRow(row: any): any {
  if (!row || typeof row !== "object") return row;
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    message: row.message,
    actionUrl: row.action_url ?? null,
    actionType: row.action_type ?? null,
    metadata: row.metadata ?? null,
    isRead: row.is_read ?? false,
    isActionable: row.is_actionable ?? false,
    actionTaken: row.action_taken ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    updatedAt: row.updated_at,
  };
}

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

    // NOTE: expired-notification cleanup used to run INSIDE this handler
    // (a full-table `DELETE FROM notifications WHERE expires_at < NOW()` on
    // every GET — a table-wide write per request per user). It now runs on a
    // boot-time interval; see startNotificationCleanup() in index.ts.

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
      data: { notifications: result.rows.map(mapNotificationRow), total },
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
      data: mapNotificationRow(result.rows[0]),
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
      data: mapNotificationRow(result.rows[0]),
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

/**
 * POST /notifications/register-device
 * Registers/refreshes an FCM token for the authenticated user so the backend
 * can deliver push notifications (calls, chats, broadcasts).
 * Body: { fcm_token, platform: 'android'|'ios'|'web', device_name?, app_version? }
 */
/**
 * @swagger
 * /notifications/register-device:
 *   post:
 *     summary: Register/refresh an FCM push token for the authenticated user
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fcm_token]
 *             properties:
 *               fcm_token: { type: string }
 *               platform: { type: string, enum: [android, ios, web] }
 *               device_name: { type: string }
 *               app_version: { type: string }
 *     responses:
 *       200:
 *         description: Device registered
 */
export const registerDevice: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const businessId = req.user?.businessId;
    const { fcm_token, platform, device_name, app_version } = req.body || {};

    if (!userId || !fcm_token) {
      return res.status(400).json({ success: false, error: "fcm_token is required" });
    }

    await query(
      `INSERT INTO user_devices (user_id, business_id, fcm_token, platform, device_name, app_version, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (fcm_token) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         business_id = EXCLUDED.business_id,
         platform = EXCLUDED.platform,
         device_name = EXCLUDED.device_name,
         app_version = EXCLUDED.app_version,
         last_seen_at = CURRENT_TIMESTAMP`,
      [userId, businessId || null, fcm_token, platform || null, device_name || null, app_version || null],
    );

    // Diagnostic counters so "notifications don't arrive" is diagnosable from
    // the client: how many devices this account can be pushed to right now.
    let deviceCount = 1;
    try {
      const countRes = await query(`SELECT COUNT(*)::int AS c FROM user_devices WHERE user_id = $1`, [userId]);
      deviceCount = countRes.rows[0]?.c ?? 1;
    } catch {}

    res.json({
      success: true,
      message: "Device registered for push notifications",
      data: { devices: deviceCount, platform: platform || null },
    });
  } catch (error: any) {
    console.error("Register device error:", error);
    res.status(500).json({ success: false, error: "Failed to register device" });
  }
};

/**
 * DELETE /notifications/register-device
 * Removes an FCM token (e.g. on logout).
 */
/**
 * @swagger
 * /notifications/register-device:
 *   delete:
 *     summary: Remove an FCM push token (e.g. on logout)
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fcm_token: { type: string }
 *     responses:
 *       200:
 *         description: Device unregistered
 */
export const unregisterDevice: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { fcm_token } = req.body || {};
    if (!fcm_token) {
      return res.status(400).json({ success: false, error: "fcm_token is required" });
    }
    await query(`DELETE FROM user_devices WHERE fcm_token = $1 AND user_id = $2`, [fcm_token, req.user?.userId]);
    res.json({ success: true, message: "Device unregistered" });
  } catch (error: any) {
    console.error("Unregister device error:", error);
    res.status(500).json({ success: false, error: "Failed to unregister device" });
  }
};
