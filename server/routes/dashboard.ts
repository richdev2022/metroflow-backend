import express from "express";
import { authenticateToken, AuthenticatedRequest, checkSubscriptionStatus } from "../middleware/auth";
import { query } from "../db";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Dashboard
 *   description: Dashboard metrics and statistics
 */

/**
 * @swagger
 * /dashboard/metrics:
 *   get:
 *     summary: Get dashboard metrics
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: memberId
 *         schema:
 *           type: string
 *         description: Optional member ID to filter metrics
 *     responses:
 *       200:
 *         description: Dashboard metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get("/metrics", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const businessId = authReq.user?.businessId;
    if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const memberId = req.query.memberId as string;
    
    // Build filter clause
    let memberFilter = "";
    const params = [businessId];
    let paramIndex = 2;

    if (memberId && memberId !== 'all') {
        // Filter tasks that have this user assigned
        memberFilter = `AND EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id AND ta.user_id = $${paramIndex})`;
        params.push(memberId);
        paramIndex++;
    }

    // 1. Total Tasks & Completed
    const tasksStatsRes = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed
      FROM tasks t
      WHERE business_id = $1 ${memberFilter}
    `, params);
    
    const totalTasks = parseInt(tasksStatsRes.rows[0].total);
    const completedTasks = parseInt(tasksStatsRes.rows[0].completed);

    // 2. Current Month Progress
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    // We need separate params for this query because we add dates
    const currentMonthParams: any[] = [...params]; 
    const startIdx = paramIndex;
    const endIdx = paramIndex + 1;
    currentMonthParams.push(startOfMonth, now);

    const currentMonthStatsRes = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed
      FROM tasks t
      WHERE business_id = $1 ${memberFilter}
      AND start_date >= $${startIdx} AND start_date <= $${endIdx}
    `, currentMonthParams);

    const currentMonthTotal = parseInt(currentMonthStatsRes.rows[0].total);
    const currentMonthCompleted = parseInt(currentMonthStatsRes.rows[0].completed);

    // 3. Overdue Tasks
    const overdueRes = await query(`
      SELECT t.*, array_agg(ta.user_id) as "assignedTo"
      FROM tasks t
      LEFT JOIN task_assignments ta ON t.id = ta.task_id
      WHERE t.business_id = $1 ${memberFilter}
      AND t.is_overdue = true 
      AND t.status != 'completed'
      GROUP BY t.id
    `, params);
    
    const overdueTasks = overdueRes.rows;

    // 4. Epic Summaries
    // Note: If we filter by member, we only count tasks assigned to that member within the epic.
    const epicsRes = await query(`
      SELECT 
        COALESCE(t.epic, 'No Epic') as epic,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE t.status = 'completed') as completed,
        MIN(t.start_date) as start_date,
        MAX(t.end_date) as end_date
      FROM tasks t
      WHERE t.business_id = $1 ${memberFilter}
      GROUP BY t.epic
    `, params);

    // Get assigned users for epics (all users involved in these epics, or just the filtered one?)
    // Typically, the "Assigned To" in Epic summary shows everyone working on the epic.
    // If we filter by member, maybe we still want to see who else is on the epic? 
    // Or maybe just the filtered member?
    // Let's stick to showing all assignments for the epic to give context, 
    // BUT since we are filtering metrics by member, maybe the "Assigned To" should reflect the filter?
    // The previous frontend code: `allAssignedIds = Array.from(new Set(epicTasks.flatMap(t => t.assignedTo || [])));`
    // If `epicTasks` was filtered by member, then it only included tasks assigned to that member.
    // So it would show users assigned to *those* tasks.
    
    // Let's get assignments for the tasks included in the filter.
    const epicAssignmentsRes = await query(`
        SELECT 
            t.epic, 
            array_agg(DISTINCT ta.user_id) as assigned_to
        FROM tasks t
        JOIN task_assignments ta ON t.id = ta.task_id
        WHERE t.business_id = $1 ${memberFilter}
        GROUP BY t.epic
    `, params);
    
    const epicAssignmentsMap: Record<string, string[]> = {};
    epicAssignmentsRes.rows.forEach(row => {
        epicAssignmentsMap[row.epic || 'No Epic'] = row.assigned_to;
    });

    const epicSummaries: Record<string, any> = {};
    let totalTarget = 0;
    let totalAccomplished = 0;

    epicsRes.rows.forEach(row => {
        const epicName = row.epic;
        const total = parseInt(row.total);
        const completed = parseInt(row.completed);
        
        totalTarget += total;
        totalAccomplished += completed;

        epicSummaries[epicName] = {
            total,
            completed,
            percentageCompletion: total > 0 ? (completed / total) * 100 : 0,
            startDate: row.start_date,
            endDate: row.end_date,
            assignedTo: epicAssignmentsMap[epicName] || []
        };
    });

    const summary = {
      current: {
        total: currentMonthTotal,
        completed: currentMonthCompleted,
        percentageCompletion: currentMonthTotal > 0 ? (currentMonthCompleted / currentMonthTotal) * 100 : 0,
      },
      monthly: {
        total: totalTasks,
        completed: completedTasks,
        percentageCompletion: totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0,
        targetVsAccomplishment: {
          target: totalTarget,
          accomplished: totalAccomplished,
        },
      },
      epics: epicSummaries,
      overdueTasks,
    };

    res.json({ success: true, data: summary });

  } catch (error) {
    console.error("Dashboard metrics error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch dashboard metrics" });
  }
});

export default router;
