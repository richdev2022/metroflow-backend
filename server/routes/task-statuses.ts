import express from "express";
import { authenticateToken, checkSubscriptionStatus, AuthenticatedRequest } from "../middleware/auth";
import { query } from "../db";
import { logActivity } from "../services/activity";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Task Statuses
 *   description: Custom task status management
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     TaskStatus:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         business_id:
 *           type: string
 *         name:
 *           type: string
 *         color:
 *           type: string
 *           description: Hexadecimal color code (e.g. #FF0000)
 *         is_default:
 *           type: boolean
 *         sort_order:
 *           type: integer
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 *
 *     TaskStatusCreate:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         name:
 *           type: string
 *         color:
 *           type: string
 *           description: Hexadecimal color code (e.g. #FF0000, #6b7280, #3b82f6, #10b981, #f59e0b, #ef4444)
 *           example: "#6b7280"
 *         sort_order:
 *           type: integer
 *
 *     TaskStatusUpdate:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *         color:
 *           type: string
 *           description: Hexadecimal color code (e.g. #FF0000, #6b7280, #3b82f6, #10b981, #f59e0b, #ef4444)
 *           example: "#6b7280"
 *         sort_order:
 *           type: integer
 */

/**
 * @swagger
 * /task-statuses:
 *   get:
 *     summary: Get all task statuses for the current business
 *     tags: [Task Statuses]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of task statuses
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
 *                     $ref: '#/components/schemas/TaskStatus'
 *       500:
 *         description: Server error
 */
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(400).json({ success: false, error: "Business ID not found" });
    }

    // Ensure default statuses exist for this business
    const defaultStatuses = [
      { name: 'pending', color: '#6b7280', is_default: true },
      { name: 'in_progress', color: '#3b82f6', is_default: true },
      { name: 'completed', color: '#10b981', is_default: true }
    ];
    for (let i = 0; i < defaultStatuses.length; i++) {
      const status = defaultStatuses[i];
      await query(
        `INSERT INTO task_statuses (business_id, name, color, is_default, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (business_id, name) DO NOTHING`,
        [businessId, status.name, status.color, status.is_default, i]
      );
    }

    const result = await query(
      `SELECT * FROM task_statuses WHERE business_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [businessId]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("Get task statuses error:", error);
    res.status(500).json({ success: false, error: "Failed to get task statuses" });
  }
});

/**
 * @swagger
 * /task-statuses:
 *   post:
 *     summary: Create a new custom task status
 *     tags: [Task Statuses]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TaskStatusCreate'
 *     responses:
 *       201:
 *         description: Task status created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/TaskStatus'
 *       400:
 *         description: Invalid input
 *       500:
 *         description: Server error
 */
router.post("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const { name, color, sort_order } = req.body;
    if (!name || name.trim() === "") {
      return res.status(400).json({ success: false, error: "Name is required" });
    }

    // Validate color format if provided
    if (color) {
      const colorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
      if (!colorRegex.test(color)) {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid color format. Please use hexadecimal format like #FF0000 or #F00" 
        });
      }
    }

    // Check if status name already exists for this business
    const existingCheck = await query(
      `SELECT id FROM task_statuses WHERE business_id = $1 AND name = $2`,
      [businessId, name]
    );
    if (existingCheck.rows.length > 0) {
      return res.status(400).json({ success: false, error: "Status name already exists" });
    }

    const result = await query(
      `INSERT INTO task_statuses (business_id, name, color, sort_order)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [businessId, name, color || '#6b7280', sort_order || 0]
    );

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "create",
      actionType: "task_status",
      description: `Created task status: ${name}`,
      metadata: { statusName: name }
    });

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Create task status error:", error);
    res.status(500).json({ success: false, error: "Failed to create task status" });
  }
});

/**
 * @swagger
 * /task-statuses/{id}:
 *   put:
 *     summary: Update an existing task status
 *     tags: [Task Statuses]
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
 *             $ref: '#/components/schemas/TaskStatusUpdate'
 *     responses:
 *       200:
 *         description: Task status updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/TaskStatus'
 *       400:
 *         description: Invalid input
 *       404:
 *         description: Task status not found
 *       500:
 *         description: Server error
 */
router.put("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    const { id } = req.params;
    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const { name, color, sort_order } = req.body;

    // Validate color format if provided
    if (color) {
      const colorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
      if (!colorRegex.test(color)) {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid color format. Please use hexadecimal format like #FF0000 or #F00" 
        });
      }
    }

    // Check if status exists for this business
    const existingCheck = await query(
      `SELECT * FROM task_statuses WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );
    if (existingCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Task status not found" });
    }

    const oldStatus = existingCheck.rows[0];

    // Check if updating name would cause conflict
    if (name && name !== oldStatus.name) {
      const nameCheck = await query(
        `SELECT id FROM task_statuses WHERE business_id = $1 AND name = $2 AND id != $3`,
        [businessId, name, id]
      );
      if (nameCheck.rows.length > 0) {
        return res.status(400).json({ success: false, error: "Status name already exists" });
      }
    }

    const result = await query(
      `UPDATE task_statuses
       SET name = COALESCE($1, name),
           color = COALESCE($2, color),
           sort_order = COALESCE($3, sort_order),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND business_id = $5
       RETURNING *`,
      [name, color, sort_order, id, businessId]
    );

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "update",
      actionType: "task_status",
      description: `Updated task status: ${oldStatus.name} -> ${name || oldStatus.name}`,
      metadata: { oldStatus, newStatus: result.rows[0] }
    });

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Update task status error:", error);
    res.status(500).json({ success: false, error: "Failed to update task status" });
  }
});

/**
 * @swagger
 * /task-statuses/{id}:
 *   delete:
 *     summary: Delete a custom task status
 *     tags: [Task Statuses]
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
 *         description: Task status deleted
 *       400:
 *         description: Cannot delete default status
 *       404:
 *         description: Task status not found
 *       500:
 *         description: Server error
 */
router.delete("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    const { id } = req.params;
    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    // Check if status exists and is not a default
    const existingCheck = await query(
      `SELECT * FROM task_statuses WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );
    if (existingCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Task status not found" });
    }

    const statusToDelete = existingCheck.rows[0];

    if (statusToDelete.is_default) {
      return res.status(400).json({ success: false, error: "Cannot delete default statuses" });
    }

    // Delete the status
    await query(
      `DELETE FROM task_statuses WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "delete",
      actionType: "task_status",
      description: `Deleted task status: ${statusToDelete.name}`,
      metadata: { statusName: statusToDelete.name }
    });

    res.json({ success: true, message: "Task status deleted" });
  } catch (error) {
    console.error("Delete task status error:", error);
    res.status(500).json({ success: false, error: "Failed to delete task status" });
  }
});

export default router;
