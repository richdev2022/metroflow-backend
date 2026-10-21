import { RequestHandler } from "express";
import { query } from "../db";
import { ApiResponse } from "@shared/api";
import { AuthenticatedRequest } from "../middleware/auth";

export interface ActivityLog {
  id: string;
  businessId: string;
  taskId?: string;
  userId: string;
  action: string;
  actionType?: string;
  description?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  userName?: string;
  taskTitle?: string;
}

export const getActivityLogs: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /activity-logs:
   *   get:
   *     summary: Get activity logs
   *     tags: [Activity]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: page
   *         schema:
   *           type: integer
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *       - in: query
   *         name: startDate
   *         schema:
   *           type: string
   *           format: date
   *       - in: query
   *         name: endDate
   *         schema:
   *           type: string
   *           format: date
   *       - in: query
   *         name: action
   *         schema:
   *           type: string
   *       - in: query
   *         name: userId
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: List of activity logs
   */
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "Business ID not found",
      });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = (page - 1) * limit;

    const { startDate, endDate, action, userId: filterUserId } = req.query;

    const params: any[] = [businessId];
    let queryText = `
      SELECT
        al.id,
        al.business_id as "businessId",
        al.task_id as "taskId",
        al.user_id as "userId",
        al.action,
        al.action_type as "actionType",
        al.description,
        al.metadata,
        al.created_at as "createdAt",
        u.name as "userName",
        t.title as "taskTitle"
       FROM activity_logs al
       LEFT JOIN users u ON al.user_id = u.id
       LEFT JOIN tasks t ON al.task_id = t.id
       WHERE al.business_id = $1
    `;

    if (startDate) {
      params.push(startDate);
      queryText += ` AND al.created_at >= $${params.length}`;
    }

    if (endDate) {
      params.push(endDate);
      queryText += ` AND al.created_at <= $${params.length}`;
    }

    if (action && action !== 'all') {
      params.push(action);
      queryText += ` AND al.action = $${params.length}`;
    }

    if (filterUserId && filterUserId !== 'all') {
      params.push(filterUserId);
      queryText += ` AND al.user_id = $${params.length}`;
    }

    // Get total count for pagination
    const countResult = await query(
      `SELECT COUNT(*) as total FROM (${queryText}) as count_query`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    // Add ordering and pagination
    queryText += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(queryText, params);

    const response: ApiResponse<{ logs: ActivityLog[]; total: number; page: number; totalPages: number }> = {
      success: true,
      data: {
        logs: result.rows,
        total,
        page,
        totalPages: Math.ceil(total / limit)
      },
    };
    res.json(response);
  } catch (error) {
    console.error("Get activity logs error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to fetch activity logs",
    };
    res.status(500).json(response);
  }
};