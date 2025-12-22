import { RequestHandler } from "express";
import { query } from "../db";
import { ApiResponse, AssignTaskInput } from "@shared/api";

// Assign task(s) to user(s)
export const assignTasks: RequestHandler = async (req, res) => {
/**
 * @swagger
 * /assignments:
 *   post:
 *     summary: Assign tasks to users
 *     tags: [Assignments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - taskIds
 *               - userIds
 *             properties:
 *               taskIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *               userIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       201:
 *         description: Assignments created
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
 *       400:
 *         description: Bad request
 *       404:
 *         description: Task or user not found
 *       500:
 *         description: Server error
 */
  try {
    const businessId = req.headers["x-business-id"] as string;
    const userId = req.headers["x-user-id"] as string;
    const input: AssignTaskInput = req.body;

    if (!businessId || !userId) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
      });
    }

    if (!input.taskIds || !input.userIds) {
      return res.status(400).json({
        success: false,
        error: "Task IDs and user IDs are required",
      });
    }

    // Verify all tasks belong to this business
    const taskCheck = await query(
      `SELECT id FROM tasks WHERE id = ANY($1) AND business_id = $2`,
      [input.taskIds, businessId],
    );

    if (taskCheck.rows.length !== input.taskIds.length) {
      return res.status(404).json({
        success: false,
        error: "Some tasks not found",
      });
    }

    // Verify all users belong to this business
    const userCheck = await query(
      `SELECT id FROM users WHERE id = ANY($1) AND business_id = $2`,
      [input.userIds, businessId],
    );

    if (userCheck.rows.length !== input.userIds.length) {
      return res.status(404).json({
        success: false,
        error: "Some users not found",
      });
    }

    // Create assignments
    const assignments = [];

    for (const taskId of input.taskIds) {
      for (const assigneeId of input.userIds) {
        const result = await query(
          `INSERT INTO task_assignments (task_id, user_id, assigned_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (task_id, user_id) DO NOTHING
           RETURNING id, task_id as "taskId", user_id as "userId", assigned_by as "assignedBy", assigned_at as "assignedAt"`,
          [taskId, assigneeId, userId],
        );

        if (result.rows.length > 0) {
          assignments.push(result.rows[0]);
        }
      }
    }

    const response: ApiResponse<typeof assignments> = {
      success: true,
      data: assignments,
    };
    res.status(201).json(response);
  } catch (error) {
    console.error("Assign tasks error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to assign tasks",
    });
  }
};

// Get task assignments
export const getAssignments: RequestHandler = async (req, res) => {
/**
 * @swagger
 * /assignments/{taskId}:
 *   get:
 *     summary: Get assignments for a task
 *     tags: [Assignments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: List of assignments
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
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
  try {
    const businessId = req.headers["x-business-id"] as string;
    const { taskId } = req.params;

    if (!businessId) {
      return res.status(401).json({
        success: false,
        error: "Business ID required",
      });
    }

    const result = await query(
      `SELECT ta.id, ta.task_id as "taskId", ta.user_id as "userId",
              ta.assigned_by as "assignedBy", ta.assigned_at as "assignedAt",
              u.name as "userName", u.email as "userEmail"
       FROM task_assignments ta
       JOIN users u ON ta.user_id = u.id
       WHERE ta.task_id = $1`,
      [taskId],
    );

    const response: ApiResponse<typeof result.rows> = {
      success: true,
      data: result.rows,
    };
    res.json(response);
  } catch (error) {
    console.error("Get assignments error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch assignments",
    });
  }
};

// Remove assignment
export const removeAssignment: RequestHandler = async (req, res) => {
/**
 * @swagger
 * /assignments/{assignmentId}:
 *   delete:
 *     summary: Remove an assignment
 *     tags: [Assignments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: assignmentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Assignment removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       404:
 *         description: Assignment not found
 *       500:
 *         description: Server error
 */
  try {
    const businessId = req.headers["x-business-id"] as string;
    const { assignmentId } = req.params;

    if (!businessId) {
      return res.status(401).json({
        success: false,
        error: "Business ID required",
      });
    }

    // Verify assignment belongs to this business
    const assignmentCheck = await query(
      `SELECT ta.id FROM task_assignments ta
       JOIN tasks t ON ta.task_id = t.id
       WHERE ta.id = $1 AND t.business_id = $2`,
      [assignmentId, businessId],
    );

    if (assignmentCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Assignment not found",
      });
    }

    const result = await query(
      `DELETE FROM task_assignments WHERE id = $1 RETURNING id`,
      [assignmentId],
    );

    res.json({
      success: true,
      data: { id: result.rows[0].id },
    });
  } catch (error) {
    console.error("Remove assignment error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to remove assignment",
    });
  }
};
