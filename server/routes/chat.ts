import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { getSocketServer } from "../lib/socket";
import multer from "multer";
import path from "path";
import {
  uploadMediaBuffer,
  detectMediaKind,
} from "../services/media-upload";

// Chat media upload (WhatsApp-style): voice notes, images, videos, documents,
// GIFs and stickers. 100 MB covers multi-minute videos while remaining within
// typical proxy limits (nginx client_max_body_size should be >= 100m).
const CHAT_MEDIA_LIMIT_MB = 100;
const CHAT_MEDIA_MIMES = [
  /^image\//,
  /^video\//,
  /^audio\//,
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "application/x-zip-compressed",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/gzip",
  "application/json",
  "text/plain",
  "text/csv",
  "application/octet-stream", // final fallback for exotic types; extension-checked below
];

const chatMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHAT_MEDIA_LIMIT_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mimeOk = CHAT_MEDIA_MIMES.some((m) =>
      typeof m === "string" ? file.mimetype === m : m.test(file.mimetype),
    );
    const ext = path.extname(file.originalname).toLowerCase().replace(".", "");
    const allowedExts = /^(jpg|jpeg|png|gif|webp|bmp|svg|avif|heic|heif|mp4|webm|mov|avi|mkv|3gp|m4v|mp3|m4a|aac|ogg|oga|opus|wav|weba|flac|amr|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|rtf|csv|tsv|md|json|xml|zip|rar|7z|tar|gz|apk|ics)$/;
    const extOk = allowedExts.test(ext);
    if (mimeOk && extOk) return cb(null, true);
    cb(new Error("Unsupported file type. Allowed: images, videos, audio, PDF, Office documents, text files and archives"));
  },
} as multer.Options);

export const chatMediaMiddleware = chatMediaUpload.single('file');

const VALID_MESSAGE_TYPES = new Set([
  "text", "image", "video", "audio", "document", "gif", "sticker", "voice",
]);

const CALL_LOG_JSON_META = Symbol("callLogJson");

/**
 * Insert a WhatsApp-style call log entry into a chat conversation.
 * Used by the calls service when a call ends/misses so the conversation
 * transcript reflects call history. Never throws.
 */
export async function postCallLogMessage(opts: {
  businessId: string;
  senderId: string;                     // call initiator
  conversationId?: string | null;       // explicit conversation (when call was started from chat)
  participantIds: string[];             // all call participants (incl. initiator)
  callType: "audio" | "video" | string;
  status: "completed" | "missed" | "cancelled" | string;
  durationSeconds?: number | null;
  callCode?: string | null;
}): Promise<void> {
  try {
    const { businessId, senderId, conversationId, participantIds } = opts;
    if (!businessId || !senderId) return;

    const initiatorResult = await query(`SELECT name FROM users WHERE id = $1`, [senderId]);
    const initiatorName = initiatorResult.rows[0]?.name || null;

    const payload = JSON.stringify({
      callType: opts.callType === "audio" ? "audio" : "video",
      status: opts.status,
      durationSeconds: typeof opts.durationSeconds === "number" ? Math.max(0, Math.round(opts.durationSeconds)) : null,
      initiatorName,
      callCode: opts.callCode || null,
    });

    const targetConversations = new Set<string>();

    // Preferred: explicit conversation the call was started from.
    if (conversationId) {
      const valid = await ensureConversationParticipant(conversationId, businessId, senderId);
      if (valid) targetConversations.add(conversationId);
    }

    // Fallback: every DIRECT conversation the initiator shares with another
    // participant (covers "call initiated from chat" even when the client did
    // not pass conversation_id).
    const otherIds = (participantIds || []).filter(
      (pid) => pid && pid !== senderId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pid),
    );
    for (const otherId of otherIds) {
      const conv = await query(
        `SELECT cc.id FROM chat_conversations cc
         JOIN chat_participants cp1 ON cp1.conversation_id = cc.id AND cp1.user_id = $1
         JOIN chat_participants cp2 ON cp2.conversation_id = cc.id AND cp2.user_id = $2
         WHERE cc.business_id = $3 AND cc.type = 'direct'
         AND (SELECT COUNT(*) FROM chat_participants cpc WHERE cpc.conversation_id = cc.id) = 2
         LIMIT 1`,
        [senderId, otherId, businessId],
      );
      if (conv.rows[0]?.id) targetConversations.add(conv.rows[0].id);
    }

    if (targetConversations.size === 0) return;

    for (const convId of targetConversations) {
      const insert = await query(
        `INSERT INTO chat_messages
          (conversation_id, sender_id, content, message_type)
         VALUES ($1, $2, $3, 'call-log')
         RETURNING id, conversation_id as "conversationId", sender_id as "senderId",
                   content, attachment_url as "attachmentUrl", attachment_type as "attachmentType",
                   attachment_name as "attachmentName", attachment_size as "attachmentSize",
                   message_type as "messageType", created_at as "createdAt"`,
        [convId, senderId, payload],
      );
      const message = { ...insert.rows[0], senderName: initiatorName };

      await query(
        `UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [convId],
      );
      await query(
        `UPDATE chat_participants SET last_read_at = CURRENT_TIMESTAMP
         WHERE conversation_id = $1 AND user_id = $2`,
        [convId, senderId],
      );

      const participants = await query(
        `SELECT user_id as "userId" FROM chat_participants WHERE conversation_id = $1`,
        [convId],
      );

      const io = getSocketServer();
      if (io) {
        io.to(`conversation:${convId}`).emit("message:created", message);
        for (const row of participants.rows) {
          if (!row.userId || row.userId === senderId) continue;
          io.to(`user:${row.userId}`).emit("chat:new-message-notification", {
            conversationId: convId,
            messageId: message.id,
            senderId,
            senderName: initiatorName || "Someone",
            conversationName: null,
            conversationType: "direct",
            content: "Call log",
            attachmentType: "call-log",
            messageType: "call-log",
            createdAt: message.createdAt,
          });
        }
      }
    }
  } catch (error) {
    console.error("postCallLogMessage error (non-fatal):", error);
  }
}

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
         ORDER BY cm.created_at DESC LIMIT 1) as lastMessageAt,
        (
          SELECT COUNT(*)::int
          FROM chat_messages cm
          JOIN chat_participants cp_me
            ON cp_me.conversation_id = cm.conversation_id AND cp_me.user_id = $2
          WHERE cm.conversation_id = cc.id
            AND cm.sender_id <> $2
            AND cm.created_at > COALESCE(cp_me.last_read_at, cp_me.created_at, to_timestamp(0))
        ) as "unreadCount"
      FROM chat_conversations cc
      WHERE cc.business_id = $1 AND EXISTS (
        SELECT 1 FROM chat_participants cp_current 
        WHERE cp_current.conversation_id = cc.id AND cp_current.user_id = $2
      )
      ORDER BY cc.updated_at DESC`,
      [businessId, userId],
    );

    // Derive display helpers: direct chats show the OTHER participant's name
    // and avatar; group chats show the conversation name.
    const data = result.rows.map((conv: any) => {
      const participants = Array.isArray(conv.participants) ? conv.participants : [];
      const other = participants.find((p: any) => p && p.userId && String(p.userId) !== String(userId));
      const isGroup = (conv.type || 'direct') !== 'direct' || participants.length > 2;
      return {
        ...conv,
        isGroup,
        displayName: isGroup ? (conv.name || 'Group chat') : (other?.name || conv.name || 'Direct chat'),
        displayAvatarUrl: isGroup ? null : (other?.avatarUrl || null),
      };
    });

    const response: ApiResponse<any[]> = {
      success: true,
      data,
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
    const { conversationId } = req.params as { conversationId: string };
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
        cm.attachment_name as "attachmentName", cm.attachment_size as "attachmentSize",
        cm.message_type as "messageType",
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

    // Normalize + validate participant ids BEFORE the ::uuid[] cast — a single
    // non-UUID value (e.g. an email or a client-generated id) would throw 22P02
    // and surface as a 500 "Failed to create conversation".
    let rawParticipantIds: unknown = participantIds;
    if (rawParticipantIds != null && !Array.isArray(rawParticipantIds)) {
      rawParticipantIds = [rawParticipantIds];
    }
    const providedIds = ((rawParticipantIds as any[]) || [])
      .filter((pid): pid is string => typeof pid === "string" && pid.trim().length > 0)
      .map((pid) => pid.trim());
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const invalidIds = providedIds.filter((pid) => !uuidRegex.test(pid));
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid chat participants: one or more participant ids are not valid user ids",
      });
    }

    const uniqueParticipantIds = [...new Set([userId, ...providedIds])];
    const validParticipantIds = await getBusinessUserIds(uniqueParticipantIds, businessId);
    if (validParticipantIds.size !== uniqueParticipantIds.length) {
      return res.status(400).json({
        success: false,
        error: "All chat participants must belong to this business",
      });
    }

    // For direct messages, check if conversation already exists
    if (type === "direct" && providedIds.length === 1) {
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
    const { conversationId } = req.params as { conversationId: string };
    const { content, attachmentUrl, attachmentType, attachmentName, attachmentSize, messageType } = req.body;
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

    // message_type: clients may send explicit kinds (image/video/document/gif/
    // sticker/voice); call-log is RESERVED for the internal calls service so a
    // forged request cannot fabricate fake call history.
    let resolvedType = "text";
    if (typeof messageType === "string" && VALID_MESSAGE_TYPES.has(messageType)) {
      resolvedType = messageType;
    } else if (typeof attachmentType === "string" && VALID_MESSAGE_TYPES.has(attachmentType)) {
      resolvedType = attachmentType;
    } else if (attachmentUrl) {
      // Derive from mime/ext when the client did not send a type
      const derived = detectMediaKind(attachmentType, attachmentName || attachmentUrl);
      resolvedType = derived;
    }

    const result = await query(
      `INSERT INTO chat_messages 
        (conversation_id, sender_id, content, attachment_url, attachment_type,
         attachment_name, attachment_size, message_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, conversation_id as "conversationId", sender_id as "senderId", 
                 content, attachment_url as "attachmentUrl", attachment_type as "attachmentType",
                 attachment_name as "attachmentName", attachment_size as "attachmentSize",
                 message_type as "messageType",
                 created_at as "createdAt"`,
      [
        conversationId,
        userId,
        content || null,
        attachmentUrl || null,
        attachmentType || null,
        attachmentName ? String(attachmentName).slice(0, 255) : null,
        Number.isFinite(Number(attachmentSize)) && Number(attachmentSize) > 0
          ? Math.round(Number(attachmentSize))
          : null,
        resolvedType,
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

      // Real-time badge/sound/popup push to every OTHER participant's personal
      // room (works even when they have not joined the conversation room).
      try {
        const convResult = await query(
          `SELECT name, type FROM chat_conversations WHERE id = $1`,
          [conversationId],
        );
        const conversationName = convResult.rows[0]?.name || null;
        const conversationType = convResult.rows[0]?.type || "direct";
        const preview = String(content || "").slice(0, 140);
        const notificationPayload = {
          conversationId,
          messageId: message.id,
          senderId: userId,
          senderName: message.senderName || "Someone",
          conversationName,
          conversationType,
          content: preview,
          attachmentType: attachmentType || null,
          createdAt: message.createdAt,
        };
        for (const row of participantsResult.rows) {
          const participantId = row.userId;
          if (!participantId || participantId === userId) continue;
          io.to(`user:${participantId}`).emit(
            "chat:new-message-notification",
            notificationPayload,
          );
        }
      } catch (notifyError) {
        console.error("Chat notification push error:", notifyError);
      }
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
    const { conversationId } = req.params as { conversationId: string };
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

/**
 * GIF search via Tenor v2 (server-side key keeps TENOR_API_KEY out of clients).
 * Returns an empty configured=false payload when the key is absent so clients
 * can hide the GIF tab and fall back to emoji stickers.
 */
/**
 * @swagger
 * /chat/gifs:
 *   get:
 *     summary: Search trending Tenor GIFs for the chat GIF picker
 *     description: Returns an empty configured=false payload when TENOR_API_KEY is absent so clients hide the GIF tab.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 16 }
 *     responses:
 *       200:
 *         description: GIF objects or configured=false
 */
export const searchChatGifs: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const apiKey = process.env.TENOR_API_KEY;
    if (!apiKey) {
      return res.json({ success: true, data: { configured: false, gifs: [] } });
    }
    const search = String(req.query.search || "trending").slice(0, 80) || "trending";
    const limit = Math.min(24, Math.max(4, parseInt(req.query.limit as string) || 16));

    const isTrending = search.toLowerCase() === "trending";
    const url = isTrending
      ? `https://tenor.googleapis.com/v2/featured?key=${encodeURIComponent(apiKey)}&limit=${limit}&media_filter=gif,tinygif&client_key=metricorex_web`
      : `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(search)}&key=${encodeURIComponent(apiKey)}&limit=${limit}&media_filter=gif,tinygif&client_key=metricorex_web`;

    const tenorRes = await fetch(url);
    if (!tenorRes.ok) {
      console.error("Tenor request failed:", tenorRes.status, await tenorRes.text().catch(() => ""));
      return res.json({ success: true, data: { configured: true, gifs: [] } });
    }
    const payload = (await tenorRes.json()) as {
      results?: Array<{
        id: string;
        content_description?: string;
        media_formats?: Record<string, { url: string; dims?: number[] }>;
      }>;
    };
    const gifs = (payload.results || []).map((r) => ({
      id: r.id,
      description: r.content_description || "GIF",
      url: r.media_formats?.gif?.url || r.media_formats?.tinygif?.url || null,
      previewUrl: r.media_formats?.tinygif?.url || r.media_formats?.gif?.url || null,
    })).filter((g) => g.url);

    res.json({ success: true, data: { configured: true, gifs } });
  } catch (error) {
    console.error("GIF search error:", error);
    res.json({ success: true, data: { configured: !!process.env.TENOR_API_KEY, gifs: [] } });
  }
};

/**
 * Upload chat media (WhatsApp-style) — voice notes, images, videos, documents,
 * GIFs and stickers. Accepts multipart/form-data with a `file` field.
 * Storage chain: Cloudflare R2 -> Cloudinary -> local /uploads.
 * Returns a URL + metadata that can be passed to the send-message endpoint as
 * { attachmentUrl, attachmentType, attachmentName, attachmentSize, messageType }.
 */
/**
 * @swagger
 * /chat/media:
 *   post:
 *     summary: Upload chat media (images, videos, audio, documents, GIFs)
 *     description: >
 *       Multipart upload used by the WhatsApp-style chat attachments and voice
 *       notes. Storage chain: Cloudflare R2 -> Cloudinary -> local /uploads.
 *       Returns a URL + metadata to pass to the send-message endpoint as
 *       { attachmentUrl, attachmentType, attachmentName, attachmentSize, messageType }.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Up to 100MB
 *     responses:
 *       200:
 *         description: Uploaded media metadata (url, attachmentType, size...)
 */
export const uploadChatMedia: RequestHandler = async (req: AuthenticatedRequest, res) => {
  chatMediaMiddleware(req as any, res as any, async (err: any) => {
    if (err) {
      // Multer size errors arrive as generic MulterError — surface a friendly message
      const isTooLarge = err?.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({
        success: false,
        error: isTooLarge
          ? `File exceeds the ${CHAT_MEDIA_LIMIT_MB} MB upload limit`
          : err.message || "File upload error",
      });
    }
    try {
      const businessId = req.user?.businessId;
      const userId = req.user?.userId;
      if (!businessId || !userId) {
        return res.status(400).json({ success: false, error: "User authentication required" });
      }

      const uploadedFile = (req as any).file as Express.Multer.File | undefined;
      if (!uploadedFile) {
        return res.status(400).json({ success: false, error: "file field is required" });
      }

      const media = await uploadMediaBuffer({
        buffer: uploadedFile.buffer,
        originalname: uploadedFile.originalname,
        mimeType: uploadedFile.mimetype || "application/octet-stream",
        folder: "chat-media",
        businessId,
        userId,
      });

      res.json({
        success: true,
        data: {
          url: media.url,
          filename: media.filename,
          name: media.filename,
          mimeType: media.mimeType,
          size: media.size,
          attachmentType: media.kind,
          storage: media.storage,
        },
      });
    } catch (error) {
      console.error("Chat media upload error:", error);
      res.status(500).json({ success: false, error: "Failed to upload media" });
    }
  });
};
