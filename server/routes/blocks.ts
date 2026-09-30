import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";

/**
 * Contact blocking (WhatsApp-style).
 *
 * A block is scoped to a business and one-directional: blocker can no longer
 * message the blocked contact (and vice versa — both directions are enforced
 * in routes/chat.ts sendMessage/createConversation). Group conversations are
 * never affected.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @swagger
 * /users/{userId}/block:
 *   post:
 *     summary: Block a contact
 *     description: Blocks a user in the same business. Direct conversations between the two users stop accepting messages in both directions. 409 when the block already exists.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Contact blocked
 *       400:
 *         description: Invalid target / cannot block yourself
 *       404:
 *         description: Target user not found in this business
 *       409:
 *         description: Contact already blocked
 */
export const blockUser: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { userId: targetUserId } = req.params as { userId: string };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }
    if (!targetUserId || !UUID_RE.test(targetUserId)) {
      return res.status(400).json({ success: false, error: "Invalid user id" });
    }
    if (targetUserId === userId) {
      return res.status(400).json({ success: false, error: "You cannot block yourself" });
    }

    // Same-business enforcement (mirrors chat participant validation).
    const targetResult = await query(
      `SELECT id, name FROM users WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [targetUserId, businessId],
    );
    if (targetResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "User not found in this business" });
    }

    // Idempotent insert — a duplicate (blocker_id, blocked_id) means 409.
    const insertResult = await query(
      `INSERT INTO user_blocks (business_id, blocker_id, blocked_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING
       RETURNING id, created_at as "createdAt"`,
      [businessId, userId, targetUserId],
    );
    if (insertResult.rows.length === 0) {
      return res.status(409).json({ success: false, error: "Contact is already blocked" });
    }

    const response: ApiResponse<any> = {
      success: true,
      data: {
        id: insertResult.rows[0].id,
        blockerId: userId,
        blockedId: targetUserId,
        blockedName: targetResult.rows[0]?.name || null,
        createdAt: insertResult.rows[0].createdAt,
      },
    };
    res.json(response);
  } catch (error) {
    console.error("Block user error:", error);
    res.status(500).json({ success: false, error: "Failed to block contact" });
  }
};

/**
 * @swagger
 * /users/{userId}/block:
 *   delete:
 *     summary: Unblock a contact
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Contact unblocked
 *       404:
 *         description: No such block
 */
export const unblockUser: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { userId: targetUserId } = req.params as { userId: string };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }
    if (!targetUserId || !UUID_RE.test(targetUserId)) {
      return res.status(400).json({ success: false, error: "Invalid user id" });
    }

    const deleteResult = await query(
      `DELETE FROM user_blocks
       WHERE blocker_id = $1 AND blocked_id = $2 AND business_id = $3
       RETURNING id`,
      [userId, targetUserId, businessId],
    );
    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "This contact is not blocked" });
    }

    const response: ApiResponse<any> = {
      success: true,
      data: { blockerId: userId, blockedId: targetUserId, blocked: false },
    };
    res.json(response);
  } catch (error) {
    console.error("Unblock user error:", error);
    res.status(500).json({ success: false, error: "Failed to unblock contact" });
  }
};

/**
 * @swagger
 * /users/blocked:
 *   get:
 *     summary: List blocked contacts
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Blocked contacts fetched successfully
 */
export const listBlocked: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const result = await query(
      `SELECT ub.id, ub.blocked_id as "userId", u.name, u.avatar_url as "avatarUrl",
              ub.created_at as "blockedAt"
       FROM user_blocks ub
       LEFT JOIN users u ON u.id = ub.blocked_id
       WHERE ub.blocker_id = $1 AND ub.business_id = $2
       ORDER BY ub.created_at DESC`,
      [userId, businessId],
    );

    const response: ApiResponse<{ blocked: any[] }> = {
      success: true,
      data: { blocked: result.rows },
    };
    res.json(response);
  } catch (error) {
    console.error("List blocked users error:", error);
    res.status(500).json({ success: false, error: "Failed to list blocked contacts" });
  }
};
