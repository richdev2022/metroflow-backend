import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { getSocketServer } from "../lib/socket";

async function getBusinessUserIds(userIds: string[], businessId: string) {
  if (userIds.length === 0) return new Set<string>();

  const result = await query(
    `SELECT id FROM users WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, userIds],
  );

  return new Set(result.rows.map((row) => row.id));
}

async function ensureConversationParticipant(
  conversationId: string,
  businessId: string,
  userId: string,
) {
  const result = await query(
    `SELECT cc.id
     FROM chat_conversations cc
     JOIN chat_participants cp_current ON cc.id = cp_current.conversation_id
     WHERE cc.id = $1 AND cc.business_id = $2 AND cp_current.user_id = $3
     LIMIT 1`,
    [conversationId, businessId, userId],
  );

  return result.rows.length > 0;
}

/**
 * @swagger
 * /chat/conversations:
 *   get:
 *     summary: Get chat conversations
 *     description: Returns conversations that include the authenticated user.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Conversations fetched successfully
 */
export const getConversations: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
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

    const result = await query(
      `SELECT 
        cc.id, cc.business_id as "businessId", cc.name, cc.type, 
        cc.created_by as "createdById", cc.created_at as "createdAt", cc.updated_at as "updatedAt",
        (
          SELECT json_agg(json_build_object(
            'id', cp.id,
            'userId', cp.user_id,
            'lastReadAt', cp.last_read_at,
            'lastSeen', (
              SELECT us.last_activity_at
              FROM user_sessions us
              WHERE us.user_id = cp.user_id
              ORDER BY us.last_activity_at DESC
              LIMIT 1
            ),
            'name', u.name,
            'email', u.email,
            'avatarUrl', u.avatar_url
          ))
          FROM chat_participants cp
          LEFT JOIN users u ON cp.user_id = u.id
          WHERE cp.conversation_id = cc.id
        ) as participants,
        (SELECT cm.content FROM chat_messages cm 
         WHERE cm.conversation_id = cc.id 
         ORDER BY cm.created_at DESC LIMIT 1) as lastMessage,
        (SELECT cm.created_at FROM chat_messages cm 
         WHERE cm.conversation_id = cc.id 
         ORDER BY cm.created_at DESC LIMIT 1) as lastMessageAt
      FROM chat_conversations cc
      WHERE cc.business_id = $1 AND EXISTS (
        SELECT 1 FROM chat_participants cp_current 
        WHERE cp_current.conversation_id = cc.id AND cp_current.user_id = $2
      )
      ORDER BY cc.updated_at DESC`,
      [businessId, userId],
    );

    const response: ApiResponse<any[]> = {
      success: true,
      data: result.rows,
    };
    res.json(response);
  } catch (error) {
    console.error("Get conversations error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to fetch conversations",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /chat/conversations/{conversationId}/messages:
 *   get:
 *     summary: Get conversation messages
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Messages fetched successfully
 */
export const getConversationMessages: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { conversationId } = req.params;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = (page - 1) * limit;

    const hasAccess = await ensureConversationParticipant(conversationId, businessId, userId);
    if (!hasAccess) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    const countResult = await query(
      `SELECT COUNT(*) as total FROM chat_messages WHERE conversation_id = $1`,
      [conversationId],
    );
    const total = parseInt(countResult.rows[0].total);

    await query(
      `UPDATE chat_participants 
       SET last_read_at = CURRENT_TIMESTAMP 
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );

    const result = await query(
      `SELECT 
        cm.id, cm.conversation_id as "conversationId", cm.sender_id as "senderId", 
        cm.content, cm.attachment_url as "attachmentUrl", cm.attachment_type as "attachmentType", 
        cm.created_at as "createdAt",
        u.name as "senderName"
      FROM chat_messages cm
      JOIN users u ON cm.sender_id = u.id
      WHERE cm.conversation_id = $1
      ORDER BY cm.created_at DESC
      LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset],
    );

    const response: ApiResponse<{ messages: any[]; total: number }> = {
      success: true,
      data: { messages: result.rows.reverse(), total },
    };
    res.json(response);
  } catch (error) {
    console.error("Get messages error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to fetch messages",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /chat/conversations:
 *   post:
 *     summary: Create a chat conversation
 *     description: Creates a direct or group conversation. Direct conversations with the same two users reuse the existing conversation.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: Project Team Chat
 *               type:
 *                 type: string
 *                 enum: [direct, group]
 *                 example: group
 *               participantIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       201:
 *         description: Conversation created successfully
 *       200:
 *         description: Existing direct conversation returned
 */
export const createConversation: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { name, type, participantIds } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const uniqueParticipantIds = [...new Set([userId, ...(participantIds || [])])];
    const validParticipantIds = await getBusinessUserIds(uniqueParticipantIds, businessId);
    if (validParticipantIds.size !== uniqueParticipantIds.length) {
      return res.status(400).json({
        success: false,
        error: "All chat participants must belong to this business",
      });
    }

    // For direct messages, check if conversation already exists
    if (type === "direct" && participantIds && participantIds.length === 1) {
      const existingResult = await query(
        `SELECT cc.id FROM chat_conversations cc
         JOIN chat_participants cp1 ON cc.id = cp1.conversation_id
         JOIN chat_participants cp2 ON cc.id = cp2.conversation_id
         WHERE cc.business_id = $1 AND cc.type = 'direct'
         AND cp1.user_id = $2 AND cp2.user_id = $3
         AND (
           SELECT COUNT(*) FROM chat_participants cp_count
           WHERE cp_count.conversation_id = cc.id
         ) = 2
         LIMIT 1`,
        [businessId, userId, participantIds[0]],
      );

      if (existingResult.rows.length > 0) {
        const response: ApiResponse<any> = {
          success: true,
          data: { id: existingResult.rows[0].id },
        };
        return res.json(response);
      }
    }

    const result = await query(
      `INSERT INTO chat_conversations (business_id, name, type, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, business_id as "businessId", name, type, created_by as "createdById",
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [businessId, name || null, type || "direct", userId],
    );

    const conversation = result.rows[0];

    const participants = [];
    for (const pid of uniqueParticipantIds) {
      const participantResult = await query(
        `INSERT INTO chat_participants (conversation_id, user_id)
         VALUES ($1, $2)
         RETURNING id, user_id as "userId", last_read_at as "lastReadAt"`,
        [conversation.id, pid],
      );
      participants.push(participantResult.rows[0]);
    }

    conversation.participants = participants;

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      for (const pid of uniqueParticipantIds) {
        io.to(`user:${pid}`).emit("conversation:created", conversation);
      }
    }

    const response: ApiResponse<any> = {
      success: true,
      data: conversation,
    };
    res.status(201).json(response);
  } catch (error) {
    console.error("Create conversation error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to create conversation",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /chat/conversations/{conversationId}/messages:
 *   post:
 *     summary: Send a chat message
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
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
 *             properties:
 *               content:
 *                 type: string
 *                 example: Hello everyone!
 *               attachmentUrl:
 *                 type: string
 *                 format: uri
 *               attachmentType:
 *                 type: string
 *                 example: image/png
 *     responses:
 *       201:
 *         description: Message sent successfully
 */
export const sendMessage: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { conversationId } = req.params;
    const { content, attachmentUrl, attachmentType } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const hasAccess = await ensureConversationParticipant(conversationId, businessId, userId);
    if (!hasAccess) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    const result = await query(
      `INSERT INTO chat_messages 
        (conversation_id, sender_id, content, attachment_url, attachment_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, conversation_id as "conversationId", sender_id as "senderId", 
                 content, attachment_url as "attachmentUrl", attachment_type as "attachmentType", 
                 created_at as "createdAt"`,
      [
        conversationId,
        userId,
        content || null,
        attachmentUrl || null,
        attachmentType || null,
      ],
    );

    const message = result.rows[0];

    // Get sender name
    const userResult = await query(`SELECT name FROM users WHERE id = $1`, [
      userId,
    ]);
    message.senderName = userResult.rows[0]?.name;

    // Update conversation updated_at and mark sender as read
    await query(
      `UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [conversationId],
    );

    await query(
      `UPDATE chat_participants 
       SET last_read_at = CURRENT_TIMESTAMP 
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );

    // Get participants in conversation
    const participantsResult = await query(
      `SELECT user_id as "userId" FROM chat_participants WHERE conversation_id = $1`,
      [conversationId],
    );

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      io.to(`conversation:${conversationId}`).emit("message:created", message);
    }

    const response: ApiResponse<any> = {
      success: true,
      data: message,
    };
    res.status(201).json(response);
  } catch (error) {
    console.error("Send message error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to send message",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /chat/conversations/{conversationId}/read:
 *   put:
 *     summary: Mark conversation as read
 *     description: Updates the authenticated user's last_read_at timestamp for the conversation.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Conversation marked as read successfully
 *       404:
 *         description: Conversation not found
 *   post:
 *     summary: Mark conversation as read
 *     description: Updates the authenticated user's last_read_at timestamp for the conversation.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Conversation marked as read successfully
 *       404:
 *         description: Conversation not found
 */
export const markConversationAsRead: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { conversationId } = req.params;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const hasAccess = await ensureConversationParticipant(conversationId, businessId, userId);
    if (!hasAccess) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    const updateResult = await query(
      `UPDATE chat_participants 
       SET last_read_at = CURRENT_TIMESTAMP 
       WHERE conversation_id = $1 AND user_id = $2
       RETURNING last_read_at as "lastReadAt"`,
      [conversationId, userId],
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Participant record not found",
      });
    }

    await query(
      `UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [conversationId],
    );

    const lastReadAt = updateResult.rows[0].lastReadAt;

    const io = getSocketServer();
    if (io) {
      io.to(`conversation:${conversationId}`).emit("conversation:read", {
        conversationId,
        userId,
        lastReadAt,
      });
    }

    const response: ApiResponse<{ lastReadAt: Date; conversationId: string }> = {
      success: true,
      data: { lastReadAt, conversationId },
    };
    res.json(response);
  } catch (error) {
    console.error("Mark conversation as read error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to mark conversation as read",
    };
    res.status(500).json(response);
  }
};
