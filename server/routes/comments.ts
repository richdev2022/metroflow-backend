import { RequestHandler } from "express";
import { query } from "../db";
import { Comment, ApiResponse, CreateCommentInput, Reaction } from "@shared/api";
import { sendTaskNotification, sendCommentNotification, sendMentionNotification } from "../services/email";
import { logActivity } from "../services/activity";
import { AuthenticatedRequest } from "../middleware/auth";

// Get all comments for a task or epic (threaded)
export const getComments: RequestHandler = async (req: AuthenticatedRequest, res) => {
/**
 * @swagger
 * tags:
 *   name: Comments
 *   description: Comment management endpoints
 */

/**
 * @swagger
 * /comments/{taskId}:
 *   get:
 *     summary: Get comments for a task
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Task ID
 *     responses:
 *       200:
 *         description: List of comments
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
 *                       content:
 *                         type: string
 *                       userId:
 *                         type: string
 *                         format: uuid
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *       500:
 *         description: Server error
 */
  try {
    const { taskId, epicName, epicId } = req.params;
    const businessId = req.user?.businessId;

    if (!businessId) {
      return res.status(401).json({
        success: false,
        error: "Business ID required",
      });
    }

    let whereClause = "";
    let params: any[] = [];

    if (taskId) {
      whereClause = "c.task_id = $1";
      params = [taskId];
    } else if (epicName) {
      whereClause = "c.epic_name = $1";
      params = [epicName];
    } else if (epicId) {
        whereClause = "c.epic_id = $1";
        params = [epicId];
    } else {
        return res.status(400).json({ success: false, error: "Task ID, Epic Name, or Epic ID required" });
    }

    // Get all parent comments
    const parentResult = await query(
      `SELECT c.id, c.task_id as "taskId", c.user_id as "userId", c.epic_name as "epicName", c.epic_id as "epicId",
              c.content, c.mentions, c.likes, c.created_at as "createdAt",
              c.updated_at as "updatedAt", u.name as "userName", u.email as "userEmail"
       FROM comments c
       LEFT JOIN users u ON c.user_id = u.id
       WHERE ${whereClause} AND c.parent_comment_id IS NULL
       ORDER BY c.created_at ASC`,
      params,
    );

    // Get replies for each parent comment
    const comments: Comment[] = await Promise.all(
      parentResult.rows.map(async (parent: any) => {
        const repliesResult = await query(
          `SELECT c.id, c.task_id as "taskId", c.user_id as "userId", c.epic_name as "epicName", c.epic_id as "epicId",
                  c.content, c.mentions, c.likes, c.created_at as "createdAt",
                  c.updated_at as "updatedAt", u.name as "userName", u.email as "userEmail"
           FROM comments c
           LEFT JOIN users u ON c.user_id = u.id
           WHERE c.parent_comment_id = $1
           ORDER BY c.created_at ASC`,
          [parent.id],
        );

        return {
          ...parent,
          mentions: parent.mentions || [],
          reactions: parent.likes || [], // Map DB 'likes' column to 'reactions'
          replies: repliesResult.rows.map((reply: any) => ({
            ...reply,
            mentions: reply.mentions || [],
            reactions: reply.likes || [],
          })),
        };
      }),
    );

    const response: ApiResponse<Comment[]> = {
      success: true,
      data: comments,
    };
    res.json(response);
  } catch (error) {
    console.error("Get comments error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch comments",
    });
  }
};

// Create a new comment
export const createComment: RequestHandler = async (req: AuthenticatedRequest, res) => {
/**
 * @swagger
 * /comments:
 *   post:
 *     summary: Create a new comment
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               taskId:
 *                 type: string
 *                 format: uuid
 *               content:
 *                 type: string
 *               parentCommentId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Comment created
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
 *       400:
 *         description: Bad request
 */
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    const input: CreateCommentInput = req.body;

    if (!businessId || !userId) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
      });
    }

    if (!input.content || (!input.taskId && !input.epicName && !input.epicId)) {
      return res.status(400).json({
        success: false,
        error: "Content and either Task ID, Epic Name, or Epic ID are required",
      });
    }

    // Verify task belongs to this business if taskId is provided
    let taskTitle = "";
    if (input.taskId) {
        const taskCheck = await query(
        `SELECT id, title FROM tasks WHERE id = $1 AND business_id = $2`,
        [input.taskId, businessId],
        );

        if (taskCheck.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Task not found" });
        }
        taskTitle = taskCheck.rows[0].title;
    }

    const result = await query(
      `INSERT INTO comments (task_id, epic_name, epic_id, user_id, parent_comment_id, content, mentions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, task_id as "taskId", epic_name as "epicName", epic_id as "epicId", user_id as "userId",
                 parent_comment_id as "parentCommentId", content, mentions, likes,
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [
        input.taskId || null,
        input.epicName || null,
        input.epicId || null,
        userId,
        input.parentCommentId || null,
        input.content,
        JSON.stringify(input.mentions || []),
      ],
    );

    const newComment = result.rows[0];
    
    // Fetch user details
    const userResult = await query(`SELECT name, email FROM users WHERE id = $1`, [userId]);
    const user = userResult.rows[0];

    const comment: Comment = {
        ...newComment,
        userName: user.name,
        userEmail: user.email,
        reactions: newComment.likes || [],
    };

    // Send notification
    try {
        // Send mention notifications if there are mentions
        if (input.mentions && input.mentions.length > 0) {
            const mentionedUserIds = input.mentions.map((m: any) => m.id);
            const targetTitle = input.taskId ? taskTitle : (input.epicName || input.epicId || "Unknown Epic");
            const targetType = input.taskId ? "task" : "epic";
            const targetId = input.taskId || input.epicId || input.epicName || ""; // epicName used as ID for legacy

            await sendMentionNotification(
                businessId,
                mentionedUserIds,
                input.content,
                user.name,
                targetTitle,
                targetType,
                targetId,
                comment.id
            );
        }

        if (input.taskId) {
             await sendCommentNotification(
               businessId,
               "added",
               comment.content,
               user.name,
               taskTitle,
               "task"
             );
             await logActivity({
                businessId,
                userId,
                action: "comment_added",
                actionType: "Comment",
                description: `Added a comment to task`,
                taskId: input.taskId,
                metadata: { taskId: input.taskId, commentId: comment.id }
              });
        } else if (input.epicName || input.epicId) {
             const targetTitle = input.epicName || input.epicId || "Epic";
             await sendCommentNotification(
               businessId,
               "added",
               comment.content,
               user.name,
               targetTitle,
               "epic"
             );

             await logActivity({
                businessId,
                userId,
                action: "comment_added",
                actionType: "Comment",
                description: `Added a comment to epic ${input.epicName || input.epicId}`,
                metadata: { epicName: input.epicName, epicId: input.epicId, commentId: comment.id }
              });
        }
    } catch (err) {
        console.error("Failed to send notification/log activity", err);
    }

    const response: ApiResponse<Comment> = {
      success: true,
      data: comment,
    };
    res.json(response);
  } catch (error) {
    console.error("Create comment error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create comment",
    });
  }
};

export const deleteComment: RequestHandler = async (req: AuthenticatedRequest, res) => {
    /**
     * @swagger
     * /comments/{commentId}:
     *   delete:
     *     summary: Delete a comment
     *     tags: [Comments]
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: path
     *         name: commentId
     *         required: true
     *         schema:
     *           type: string
     *           format: uuid
     *     responses:
     *       200:
     *         description: Comment deleted
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success:
     *                   type: boolean
     *       404:
     *         description: Comment not found
     *       500:
     *         description: Server error
     */
    try {
        const { commentId } = req.params;
        const userId = req.user?.userId;

        if (!userId) {
            return res.status(401).json({ success: false, error: "Unauthorized" });
        }

        // Only allow deleting own comments
        const result = await query(
            `DELETE FROM comments WHERE id = $1 AND user_id = $2 RETURNING id`,
            [commentId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: "Comment not found or not authorized" });
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Delete comment error:", error);
        res.status(500).json({ success: false, error: "Failed to delete comment" });
    }
};

export const toggleReaction: RequestHandler = async (req: AuthenticatedRequest, res) => {
    /**
     * @swagger
     * /comments/{commentId}/reaction:
     *   put:
     *     summary: Toggle reaction on a comment
     *     tags: [Comments]
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: path
     *         name: commentId
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
     *               - type
     *             properties:
     *               type:
     *                 type: string
     *                 enum: [like, love]
     *     responses:
     *       200:
     *         description: Reaction updated
     *       400:
     *         description: Invalid reaction type
     *       404:
     *         description: Comment not found
     */
    try {
        const { commentId } = req.params;
        const { type } = req.body; // 'like' or 'love'
        const userId = req.user?.userId;
        const userName = req.user?.userId; // We don't have name in token usually, but we can fetch it or just store ID. 
        // Actually we need name for UI sometimes, but ID is enough for uniqueness.

        if (!userId) {
            return res.status(401).json({ success: false, error: "Unauthorized" });
        }

        if (!['like', 'love'].includes(type)) {
             return res.status(400).json({ success: false, error: "Invalid reaction type" });
        }

        // Get current likes
        const commentResult = await query(`SELECT likes FROM comments WHERE id = $1`, [commentId]);
        if (commentResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Comment not found" });
        }

        let currentLikes: Reaction[] = commentResult.rows[0].likes || [];
        
        // Check if user already reacted
        const existingIndex = currentLikes.findIndex((r: Reaction) => r.userId === userId);

        if (existingIndex >= 0) {
            if (currentLikes[existingIndex].type === type) {
                // Remove reaction if same type (toggle off)
                currentLikes.splice(existingIndex, 1);
            } else {
                // Change reaction type
                currentLikes[existingIndex].type = type;
            }
        } else {
            // Add new reaction
            currentLikes.push({ userId, type: type as "like" | "love" });
        }

        // Update DB
        await query(
            `UPDATE comments SET likes = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [JSON.stringify(currentLikes), commentId]
        );

        res.json({ success: true, data: currentLikes });
    } catch (error) {
        console.error("Toggle reaction error:", error);
        res.status(500).json({ success: false, error: "Failed to toggle reaction" });
    }
}
