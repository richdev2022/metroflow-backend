import { RequestHandler } from "express";
import { query } from "../db";
import { CreateTaskInput, BulkTaskInput, Task, ApiResponse, EpicCounts } from "@shared/api";
import { AuthenticatedRequest } from "../middleware/auth";
import { logActivity } from "../services/activity";
import { sendTaskNotification } from "../services/email";

export const getTasks: RequestHandler = async (req: AuthenticatedRequest, res) => {
/**
 * @swagger
 * tags:
 *   name: Tasks
 *   description: Task management endpoints
 */

/**
 * @swagger
 * /tasks:
 *   get:
 *     summary: Get all tasks
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Number of items per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by task status
 *     responses:
 *       200:
 *         description: List of tasks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     tasks:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Task'
 *                     total:
 *                       type: integer
 *                     epicCounts:
 *                       type: object
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

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = (page - 1) * limit;
    const status = req.query.status as string;

    // Build WHERE clause
    let whereClause = `WHERE t.business_id = $1`;
    const params: any[] = [businessId];
    let paramIndex = 2;

    if (status) {
      whereClause += ` AND t.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) as total FROM tasks t ${whereClause}`,
      params, // Note: params might include status now, but count query needs to match
    );
    // Fix: Count query params need to match the WHERE clause
    // We used 't' alias in whereClause, so we need to use it in count query too? 
    // Wait, the original count query was simpler. Let's fix this properly.
    
    // Recalculate count query with correct params
    const countQuery = `SELECT COUNT(*) as total FROM tasks t ${whereClause}`;
    const countRes = await query(countQuery, params);
    const total = parseInt(countRes.rows[0].total);

    params.push(limit);
    params.push(offset);

    const result = await query(
      `SELECT
        t.id, t.title, t.description, t.epic, t.epic_id as "epicId", t.sprint, t.target_value as "targetValue",
        t.accomplished_value as "accomplishedValue",
        t.start_date as "startDate", t.end_date as "endDate",
        t.due_date as "dueDate", t.status, t.is_overdue as "isOverdue",
        t.created_at as "createdAt", t.updated_at as "updatedAt",
        array_agg(ta.user_id) FILTER (WHERE ta.user_id IS NOT NULL) as "assignedTo"
       FROM tasks t
       LEFT JOIN task_assignments ta ON t.id = ta.task_id
       ${whereClause}
       GROUP BY t.id
       ORDER BY t.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      params,
    );

    // Get epic counts
    const epicCountResult = await query(
      `SELECT COALESCE(epic, 'No Epic') as epic, COUNT(*) as count
       FROM tasks
       WHERE business_id = $1
       GROUP BY epic`,
      [businessId],
    );

    const epicCounts: EpicCounts = {};
    epicCountResult.rows.forEach(row => {
      epicCounts[row.epic] = parseInt(row.count);
    });

    const response: ApiResponse<{ tasks: Task[]; total: number; epicCounts: EpicCounts }> = {
      success: true,
      data: { tasks: result.rows, total, epicCounts },
    };
    res.json(response);
  } catch (error) {
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to fetch tasks",
    };
    res.status(500).json(response);
  }
};

export const createTask: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /tasks:
   *   post:
   *     summary: Create a new task
   *     tags: [Tasks]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - title
   *             properties:
   *               title:
   *                 type: string
   *               description:
   *                 type: string
   *               epic:
   *                 type: string
   *               epicId:
   *                 type: string
   *               sprint:
   *                 type: string
   *               startDate:
   *                 type: string
   *                 format: date
   *               endDate:
   *                 type: string
   *                 format: date
   *               dueDate:
   *                 type: string
   *                 format: date
   *               assignedTo:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       201:
   *         description: Task created
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/Task'
   *       400:
   *         description: Invalid input
   */
  try {
    const input: CreateTaskInput = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const result = await query(
      `INSERT INTO tasks
        (business_id, created_by, title, description, epic, epic_id, sprint, target_value, start_date, end_date, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, title, description, epic, epic_id as "epicId", sprint, target_value as "targetValue",
                   accomplished_value as "accomplishedValue",
                   start_date as "startDate", end_date as "endDate",
                   due_date as "dueDate", status, is_overdue as "isOverdue",
                   created_at as "createdAt", updated_at as "updatedAt"`,
      [
        businessId,
        userId,
        input.title,
        input.description || null,
        input.epic || null,
        input.epicId || null,
        input.sprint || null,
        0, // default target_value
        input.startDate || new Date().toISOString().split("T")[0],
        input.endDate || new Date().toISOString().split("T")[0],
        input.dueDate || null,
      ],
    );

    const task = result.rows[0];

    // Assign developers if provided
    if (input.assignedTo && input.assignedTo.length > 0) {
      for (const assignedUserId of input.assignedTo) {
        await query(
          `INSERT INTO task_assignments (task_id, user_id, assigned_by)
           VALUES ($1, $2, $3)`,
          [task.id, assignedUserId, userId],
        );
      }

      // Update task with assignedTo
      task.assignedTo = input.assignedTo;
     }

     // Log task creation activity
     await logActivity({
       businessId,
       userId,
       action: "create",
       actionType: "task",
       description: `Created task: ${task.title}`,
       taskId: task.id,
       metadata: {
         title: task.title,
         assignedTo: input.assignedTo || [],
       },
     });

     // Get user name for notification
     const userResult = await query(
       "SELECT name FROM users WHERE id = $1",
       [userId]
     );
     const userName = userResult.rows[0]?.name || "Unknown User";

     // Send task creation notification
     await sendTaskNotification(
       businessId,
       "created",
       task.title,
       task.description || "No description provided",
       userName,
       task.id
     );

     const response: ApiResponse<Task> = {
       success: true,
       data: task,
     };
     res.status(201).json(response);
  } catch (error) {
    console.error("Create task error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to create task",
    };
    res.status(500).json(response);
  }
};

export const bulkCreateTasks: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /tasks/bulk:
   *   post:
   *     summary: Bulk create tasks
   *     tags: [Tasks]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - tasks
   *             properties:
   *               tasks:
   *                 type: array
   *                 items:
   *                   type: object
   *                   required:
   *                     - title
   *                   properties:
   *                     title:
   *                       type: string
   *                     description:
   *                       type: string
   *                     epic:
   *                       type: string
   *                     sprint:
   *                       type: string
   *                     startDate:
   *                       type: string
   *                       format: date
   *                     endDate:
   *                       type: string
   *                       format: date
   *     responses:
   *       201:
   *         description: Tasks created
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
   *                     $ref: '#/components/schemas/Task'
   *       400:
   *         description: Invalid input
   *       500:
   *         description: Server error
   */
  try {
    const input: BulkTaskInput = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const createdTasks: Task[] = [];

    for (const taskInput of input.tasks) {
      const result = await query(
        `INSERT INTO tasks
          (business_id, created_by, title, description, epic, epic_id, sprint, target_value, start_date, end_date, due_date, images)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id, title, description, epic, epic_id as "epicId", sprint, target_value as "targetValue",
                    accomplished_value as "accomplishedValue",
                    start_date as "startDate", end_date as "endDate",
                    due_date as "dueDate", status, is_overdue as "isOverdue",
                    created_at as "createdAt", updated_at as "updatedAt", images`,
        [
          businessId,
          userId,
          taskInput.title,
          taskInput.description || null,
          taskInput.epic || null,
          taskInput.epicId || null,
          taskInput.sprint || null,
          0, // default target_value
          taskInput.startDate || new Date().toISOString().split("T")[0],
          taskInput.endDate || new Date().toISOString().split("T")[0],
          taskInput.dueDate || null,
          taskInput.images ? JSON.stringify(taskInput.images) : null,
        ],
      );
      const task = result.rows[0];

      // Assign team members if provided
      if (taskInput.assignedTo && taskInput.assignedTo.length > 0) {
        for (const assignedUserId of taskInput.assignedTo) {
          await query(
            `INSERT INTO task_assignments (task_id, user_id, assigned_by)
             VALUES ($1, $2, $3)`,
            [task.id, assignedUserId, userId],
          );
        }
        task.assignedTo = taskInput.assignedTo;
      }

      createdTasks.push(task);
    }

    // Log bulk task creation activity
    await logActivity({
      businessId,
      userId,
      action: "create",
      actionType: "task",
      description: `Bulk created ${createdTasks.length} tasks`,
      metadata: {
        taskCount: createdTasks.length,
        taskTitles: createdTasks.map(t => t.title),
        assignedTo: createdTasks.flatMap(t => t.assignedTo || []),
      },
    });

    // Get user name for notification
    const userResult = await query(
      "SELECT name FROM users WHERE id = $1",
      [userId]
    );
    const userName = userResult.rows[0]?.name || "Unknown User";

    // Send bulk task creation notification
    await sendTaskNotification(
      businessId,
      "created",
      `${createdTasks.length} tasks created`,
      `Bulk task creation by ${userName}`,
      userName,
      createdTasks[0]?.id || "" // Use first task ID for notification
    );

    const response: ApiResponse<Task[]> = {
      success: true,
      data: createdTasks,
    };
    res.status(201).json(response);
  } catch (error) {
    console.error("Bulk create tasks error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to create tasks",
    };
    res.status(500).json(response);
  }
};

export const updateTask: RequestHandler = async (req: AuthenticatedRequest, res) => {
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

    const {
      title,
      description,
      epic,
      epicId,
      sprint,
      startDate,
      endDate,
      dueDate,
      assignedTo,
      accomplished_value,
      status,
    }: {
      title?: string;
      description?: string;
      epic?: string;
      epicId?: string;
      sprint?: string;
      startDate?: string;
      endDate?: string;
      dueDate?: string;
      assignedTo?: string[];
      accomplished_value?: number;
      status?: string;
    } = req.body;

    // Get task info before update for logging
    const taskBeforeResult = await query(
      `SELECT title, description, epic, epic_id, sprint, start_date, end_date, due_date, accomplished_value, status FROM tasks WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );

    if (taskBeforeResult.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Task not found",
      };
      return res.status(404).json(response);
    }

    const taskBefore = taskBeforeResult.rows[0];

    const result = await query(
      `UPDATE tasks
        SET title = COALESCE($1, title),
            description = COALESCE($2, description),
            epic = COALESCE($3, epic),
            epic_id = COALESCE($4, epic_id),
            sprint = COALESCE($5, sprint),
            start_date = COALESCE($6, start_date),
            end_date = COALESCE($7, end_date),
            due_date = COALESCE($8, due_date),
            accomplished_value = COALESCE($9, accomplished_value),
            status = COALESCE($10, status),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $11 AND business_id = $12
        RETURNING id, title, description, epic, epic_id as "epicId", sprint, target_value as "targetValue",
                  accomplished_value as "accomplishedValue",
                  start_date as "startDate", end_date as "endDate",
                  due_date as "dueDate", status, is_overdue as "isOverdue",
                  created_at as "createdAt", updated_at as "updatedAt"`,
      [title, description, epic, epicId, sprint, startDate, endDate, dueDate, accomplished_value, status, id, businessId],
    );

    if (result.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Task not found",
      };
      return res.status(404).json(response);
    }

    const updatedTask = result.rows[0];

    // Update assigned users if provided
    if (assignedTo !== undefined && assignedTo !== null) {
      // Delete existing assignments
      await query(
        `DELETE FROM task_assignments WHERE task_id = $1`,
        [id],
      );

      // Insert new assignments
      if (assignedTo.length > 0) {
        for (const assignedUserId of assignedTo) {
          await query(
            `INSERT INTO task_assignments (task_id, user_id, assigned_by)
             VALUES ($1, $2, $3)`,
            [id, assignedUserId, userId],
          );
        }
      }

      updatedTask.assignedTo = assignedTo;
    } else {
      // Get existing assigned users
      const assignResult = await query(
        `SELECT user_id FROM task_assignments WHERE task_id = $1`,
        [id],
      );
      updatedTask.assignedTo = assignResult.rows.map(row => row.user_id);
    }

    // Log task update activity
    const changes = [];
    if (title !== undefined && title !== taskBefore.title) {
      changes.push(`title: ${taskBefore.title} → ${title}`);
    }
    if (description !== undefined && description !== taskBefore.description) {
      changes.push(`description: ${taskBefore.description} → ${description}`);
    }
    if (epic !== undefined && epic !== taskBefore.epic) {
      changes.push(`epic: ${taskBefore.epic} → ${epic}`);
    }
    // Optionally record epicId change
    if (epicId !== undefined && epicId !== taskBefore.epic_id) {
      changes.push(`epic_id: ${taskBefore.epic_id} → ${epicId}`);
    }
    if (sprint !== undefined && sprint !== taskBefore.sprint) {
      changes.push(`sprint: ${taskBefore.sprint} → ${sprint}`);
    }
    if (startDate !== undefined && startDate !== taskBefore.start_date) {
      changes.push(`start_date: ${taskBefore.start_date} → ${startDate}`);
    }
    if (endDate !== undefined && endDate !== taskBefore.end_date) {
      changes.push(`end_date: ${taskBefore.end_date} → ${endDate}`);
    }
    if (dueDate !== undefined && dueDate !== taskBefore.due_date) {
      changes.push(`due_date: ${taskBefore.due_date} → ${dueDate}`);
    }
    if (accomplished_value !== undefined && accomplished_value !== taskBefore.accomplished_value) {
      changes.push(`accomplished_value: ${taskBefore.accomplished_value} → ${accomplished_value}`);
    }
    if (status !== undefined && status !== taskBefore.status) {
      changes.push(`status: ${taskBefore.status} → ${status}`);
    }

    if (changes.length > 0) {
      await logActivity({
        businessId,
        userId,
        action: "update",
        actionType: "task",
        description: `Updated task: ${updatedTask.title}`,
        taskId: updatedTask.id,
        metadata: {
          changes: changes.join(", "),
          oldValues: taskBefore,
          newValues: {
            title: updatedTask.title,
            description: updatedTask.description,
            epic: updatedTask.epic,
            sprint: updatedTask.sprint,
            startDate: updatedTask.startDate,
            endDate: updatedTask.endDate,
            dueDate: updatedTask.dueDate,
            accomplished_value: updatedTask.accomplishedValue,
            status: updatedTask.status,
            assignedTo: updatedTask.assignedTo,
          },
        },
      });

      // Get user name for notification
      const userResult = await query(
        "SELECT name FROM users WHERE id = $1",
        [userId]
      );
      const userName = userResult.rows[0]?.name || "Unknown User";

      // Send task update notification
      await sendTaskNotification(
        businessId,
        "updated",
        updatedTask.title,
        updatedTask.description || "No description provided",
        userName,
        updatedTask.id
      );
    }

    const response: ApiResponse<Task> = {
      success: true,
      data: updatedTask,
    };
    res.json(response);
  } catch (error) {
    console.error("Update task error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to update task",
    };
    res.status(500).json(response);
  }
};

export const bulkUpdateTasks: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /tasks/bulk:
   *   patch:
   *     summary: Bulk update tasks
   *     tags: [Tasks]
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
   *               - updates
   *             properties:
   *               taskIds:
   *                 type: array
   *                 items:
   *                   type: string
   *               updates:
   *                 type: object
   *     responses:
   *       200:
   *         description: Tasks updated
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
   *                     $ref: '#/components/schemas/Task'
   *       400:
   *         description: Invalid input
   */
  try {
    const { taskIds, updates } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Task IDs are required",
      });
    }

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({
        success: false,
        error: "Updates are required",
      });
    }

    // Get task info before update for logging
    const taskResult = await query(
      `SELECT id, title FROM tasks WHERE id = ANY($1) AND business_id = $2`,
      [taskIds, businessId],
    );

    if (taskResult.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "No tasks found",
      };
      return res.status(404).json(response);
    }

    const taskTitles = taskResult.rows.map(t => t.title);

    // Build update query dynamically
    const updateFields = [];
    const values = [];
    let paramIndex = 1;

    if (updates.epic !== undefined) {
      updateFields.push(`epic = $${paramIndex++}`);
      values.push(updates.epic);
    }
    if ((updates as any).epicId !== undefined) {
      updateFields.push(`epic_id = $${paramIndex++}`);
      values.push((updates as any).epicId);
    }
    if (updates.sprint !== undefined) {
      updateFields.push(`sprint = $${paramIndex++}`);
      values.push(updates.sprint);
    }
    if (updates.startDate !== undefined) {
      updateFields.push(`start_date = $${paramIndex++}`);
      values.push(updates.startDate);
    }
    if (updates.endDate !== undefined) {
      updateFields.push(`end_date = $${paramIndex++}`);
      values.push(updates.endDate);
    }
    if (updates.dueDate !== undefined) {
      updateFields.push(`due_date = $${paramIndex++}`);
      values.push(updates.dueDate);
    }
    if (updates.status !== undefined) {
      updateFields.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.assignedTo !== undefined) {
      // For assignedTo, we need to update task_assignments
      // Delete existing assignments
      await query(
        `DELETE FROM task_assignments WHERE task_id = ANY($1)`,
        [taskIds],
      );

      // Insert new assignments for each task
      if (updates.assignedTo.length > 0) {
        for (const taskId of taskIds) {
          for (const assignedUserId of updates.assignedTo) {
            await query(
              `INSERT INTO task_assignments (task_id, user_id, assigned_by)
               VALUES ($1, $2, $3)`,
              [taskId, assignedUserId, userId],
            );
          }
        }
      }
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No valid updates provided",
      });
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(taskIds, businessId);

    const updateQuery = `
      UPDATE tasks
      SET ${updateFields.join(', ')}
      WHERE id = ANY($${paramIndex++}) AND business_id = $${paramIndex++}
      RETURNING id, title, description, epic, epic_id as "epicId", sprint, target_value as "targetValue",
                accomplished_value as "accomplishedValue",
                start_date as "startDate", end_date as "endDate",
                due_date as "dueDate", status, is_overdue as "isOverdue",
                created_at as "createdAt", updated_at as "updatedAt"
    `;

    const result = await query(updateQuery, values);

    if (result.rowCount === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "No tasks updated",
      };
      return res.status(404).json(response);
    }

    // Get assigned users for updated tasks
    const updatedTasks = [];
    for (const task of result.rows) {
      const assignResult = await query(
        `SELECT user_id FROM task_assignments WHERE task_id = $1`,
        [task.id],
      );
      task.assignedTo = assignResult.rows.map(row => row.user_id);
      updatedTasks.push(task);
    }

    // Log bulk task update activity
    await logActivity({
      businessId,
      userId,
      action: "update",
      actionType: "task",
      description: `Bulk updated ${result.rowCount} tasks`,
      metadata: {
        taskCount: result.rowCount,
        taskTitles: taskTitles,
        updates: updates,
      },
    });

    // Get user name for notification
    const userResult = await query(
      "SELECT name FROM users WHERE id = $1",
      [userId]
    );
    const userName = userResult.rows[0]?.name || "Unknown User";

    // Send bulk task update notification
    await sendTaskNotification(
      businessId,
      "updated",
      `${result.rowCount} tasks updated`,
      `Bulk task update by ${userName}`,
      userName,
      taskResult.rows[0]?.id || "" // Use first task ID for notification
    );

    const response: ApiResponse<Task[]> = {
      success: true,
      data: updatedTasks,
    };
    res.json(response);
  } catch (error) {
    console.error("Bulk update tasks error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to update tasks",
    };
    res.status(500).json(response);
  }
};

export const bulkDeleteTasks: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { taskIds } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Task IDs are required",
      });
    }

    // Get task info before deletion for logging
    const taskResult = await query(
      `SELECT id, title FROM tasks WHERE id = ANY($1) AND business_id = $2`,
      [taskIds, businessId],
    );

    if (taskResult.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "No tasks found",
      };
      return res.status(404).json(response);
    }

    const taskTitles = taskResult.rows.map(t => t.title);

    // Delete task assignments first
    await query(
      `DELETE FROM task_assignments WHERE task_id = ANY($1)`,
      [taskIds],
    );

    // Delete activity logs
    await query(
      `DELETE FROM activity_logs WHERE task_id = ANY($1)`,
      [taskIds],
    );

    // Delete the tasks
    const result = await query(
      `DELETE FROM tasks WHERE id = ANY($1) AND business_id = $2`,
      [taskIds, businessId],
    );

    if (result.rowCount === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "No tasks found",
      };
      return res.status(404).json(response);
    }

    // Log bulk task deletion activity
    await logActivity({
      businessId,
      userId,
      action: "delete",
      actionType: "task",
      description: `Bulk deleted ${result.rowCount} tasks`,
      metadata: {
        taskCount: result.rowCount,
        taskTitles: taskTitles,
      },
    });

    // Get user name for notification
    const userResult = await query(
      "SELECT name FROM users WHERE id = $1",
      [userId]
    );
    const userName = userResult.rows[0]?.name || "Unknown User";

    // Send bulk task deletion notification
    await sendTaskNotification(
      businessId,
      "deleted",
      `${result.rowCount} tasks deleted`,
      `Bulk task deletion by ${userName}`,
      userName,
      taskResult.rows[0]?.id || "" // Use first task ID for notification
    );

    const response: ApiResponse<{ deletedCount: number }> = {
      success: true,
      data: { deletedCount: result.rowCount },
    };
    res.json(response);
  } catch (error) {
    console.error("Bulk delete tasks error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to delete tasks",
    };
    res.status(500).json(response);
  }
};

export const deleteTask: RequestHandler = async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /tasks/{id}:
   *   delete:
   *     summary: Delete a task
   *     tags: [Tasks]
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
   *         description: Task deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *       404:
   *         description: Task not found
   *       500:
   *         description: Server error
   */
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

    // Get task info before deletion for logging
    const taskResult = await query(
      `SELECT title FROM tasks WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );

    if (taskResult.rows.length === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Task not found",
      };
      return res.status(404).json(response);
    }

    const taskTitle = taskResult.rows[0].title;

    // Delete task assignments first
    await query(
      `DELETE FROM task_assignments WHERE task_id = $1`,
      [id],
    );

    // Delete activity logs
    await query(
      `DELETE FROM activity_logs WHERE task_id = $1`,
      [id],
    );

    // Delete the task
    const result = await query(
      `DELETE FROM tasks WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );

    if (result.rowCount === 0) {
      const response: ApiResponse<null> = {
        success: false,
        error: "Task not found",
      };
      return res.status(404).json(response);
    }

    // Log task deletion activity
    await logActivity({
      businessId,
      userId,
      action: "delete",
      actionType: "task",
      description: `Deleted task: ${taskTitle}`,
      taskId: id,
      metadata: {
        title: taskTitle,
      },
    });

    // Get user name for notification
    const userResult = await query(
      "SELECT name FROM users WHERE id = $1",
      [userId]
    );
    const userName = userResult.rows[0]?.name || "Unknown User";

    // Send task deletion notification
    await sendTaskNotification(
      businessId,
      "deleted",
      taskTitle,
      "Task has been deleted",
      userName,
      id
    );

    const response: ApiResponse<null> = {
      success: true,
    };
    res.json(response);
  } catch (error) {
    console.error("Delete task error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to delete task",
    };
    res.status(500).json(response);
  }
};
