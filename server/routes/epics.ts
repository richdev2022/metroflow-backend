import { RequestHandler } from "express";
import { query } from "../db";
import { Epic, ApiResponse } from "@shared/api";
import { AuthenticatedRequest } from "../middleware/auth";

export const getEpics: RequestHandler = async (req: AuthenticatedRequest, res) => {
/**
 * @swagger
 * tags:
 *   name: Epics
 *   description: Epic management endpoints
 */

/**
 * @swagger
 * /epics:
 *   get:
 *     summary: Get all epics
 *     tags: [Epics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of epics
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
 *                         format: uuid
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       status:
 *                         type: string
 *       500:
 *         description: Server error
 */
  try {
    const businessId = req.user?.businessId;
    console.log("getEpics request received. User:", req.user);
    
    if (!businessId) {
      console.log("No businessId found in user object");
      return res.status(400).json({ success: false, error: "Business ID not found" });
    }

    // Debug: Check total epics count regardless of business
    const allEpicsCount = await query('SELECT COUNT(*) FROM epics');
    console.log(`DEBUG: Total epics in DB (all businesses): ${allEpicsCount.rows[0].count}`);

    const result = await query(
      `SELECT id, business_id as "businessId", name, description, status,
              created_at as "createdAt", updated_at as "updatedAt"
       FROM epics
       WHERE business_id = $1
       ORDER BY created_at DESC`,
      [businessId]
    );
    
    console.log(`Found ${result.rows.length} epics for businessId ${businessId}`);

    const response: ApiResponse<Epic[]> = {
      success: true,
      data: result.rows,
    };
    res.json(response);
  } catch (error) {
    console.error("Get epics error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch epics" });
  }
};

export const createEpic: RequestHandler = async (req: AuthenticatedRequest, res) => {
/**
 * @swagger
 * /epics:
 *   post:
 *     summary: Create a new epic
 *     tags: [Epics]
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
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Epic created
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
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     name:
 *                       type: string
 *       400:
 *         description: Bad request
 */
  try {
    const businessId = req.user?.businessId;
    const { name, description } = req.body;

    if (!businessId) {
      return res.status(400).json({ success: false, error: "Business ID not found" });
    }
    if (!name) {
      return res.status(400).json({ success: false, error: "Name is required" });
    }

    console.log(`Creating epic "${name}" for businessId ${businessId}`);

    const result = await query(
      `INSERT INTO epics (business_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING id, business_id as "businessId", name, description, status,
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [businessId, name, description || null]
    );

    const response: ApiResponse<Epic> = {
      success: true,
      data: result.rows[0],
    };
    res.json(response);
  } catch (error) {
    console.error("Create epic error:", error);
    res.status(500).json({ success: false, error: "Failed to create epic" });
  }
};

export const linkTasksToEpic: RequestHandler = async (req: AuthenticatedRequest, res) => {
    /**
     * @swagger
     * /epics/{epicId}/link-tasks:
     *   post:
     *     summary: Link tasks to an epic
     *     tags: [Epics]
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: path
     *         name: epicId
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
     *               - taskIds
     *             properties:
     *               taskIds:
     *                 type: array
     *                 items:
     *                   type: string
     *                   format: uuid
     *     responses:
     *       200:
     *         description: Tasks linked successfully
     *       404:
     *         description: Epic not found
     */
    try {
        const businessId = req.user?.businessId;
        const { epicId } = req.params;
        const { taskIds } = req.body; // Array of task IDs

        if (!businessId) {
            return res.status(400).json({ success: false, error: "Business ID not found" });
        }
        
        // Update tasks to set epic_id AND epic (string) for backward compatibility
        // First get the epic name
        const epicResult = await query(`SELECT name FROM epics WHERE id = $1 AND business_id = $2`, [epicId, businessId]);
        if (epicResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Epic not found" });
        }
        const epicName = epicResult.rows[0].name;

        // Bulk update
        await query(
            `UPDATE tasks 
             SET epic_id = $1, epic = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = ANY($3) AND business_id = $4`,
            [epicId, epicName, taskIds, businessId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error("Link tasks to epic error:", error);
        res.status(500).json({ success: false, error: "Failed to link tasks to epic" });
    }
}

export const backfillEpics: RequestHandler = async (req: AuthenticatedRequest, res) => {
/**
 * @swagger
 * /epics/backfill:
 *   post:
 *     summary: Backfill epics from tasks
 *     tags: [Epics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Backfill completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       500:
 *         description: Server error
 */
    try {
        const businessId = req.user?.businessId;
        if (!businessId) {
            return res.status(400).json({ success: false, error: "Business ID required" });
        }

        // 1. Get all unique epic names from tasks that are not null/empty
        const tasksResult = await query(
            `SELECT DISTINCT epic FROM tasks WHERE business_id = $1 AND epic IS NOT NULL AND epic != ''`,
            [businessId]
        );

        const distinctEpics = tasksResult.rows.map(r => r.epic);
        let createdCount = 0;
        let updatedCount = 0;

        for (const epicName of distinctEpics) {
            // 2. Check if epic exists in epics table
            const epicResult = await query(
                `SELECT id FROM epics WHERE business_id = $1 AND name = $2`,
                [businessId, epicName]
            );

            let epicId: string;

            if (epicResult.rows.length === 0) {
                // Create it
                const newEpic = await query(
                    `INSERT INTO epics (business_id, name, status) VALUES ($1, $2, 'todo') RETURNING id`,
                    [businessId, epicName]
                );
                epicId = newEpic.rows[0].id;
                createdCount++;
            } else {
                epicId = epicResult.rows[0].id;
            }

            // 3. Update tasks with epic_id
            const updateResult = await query(
                `UPDATE tasks SET epic_id = $1 WHERE business_id = $2 AND epic = $3 AND (epic_id IS NULL OR epic_id != $1)`,
                [epicId, businessId, epicName]
            );
            updatedCount += updateResult.rowCount;
        }

        res.json({ success: true, message: `Backfilled ${createdCount} epics and updated ${updatedCount} tasks.` });

    } catch (error) {
        console.error("Backfill error:", error);
        res.status(500).json({ success: false, error: "Backfill failed" });
    }
};
