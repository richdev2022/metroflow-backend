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
import { getTenorApiKey } from "../lib/config-flags";

// Call-log messages (WhatsApp-style call history in chat) are inserted by the
// SHARED helper in lib/call-log.ts — used by both the REST call paths and the
// socket call paths. Re-exported here for backward compatibility.
export { postCallLogMessage } from "../lib/call-log";

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


async function getBusinessUserIds(userIds: string[], businessId: string) {
  if (userIds.length === 0) return new Set<string>();

  const result = await query(
    `SELECT id FROM users WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, userIds],
  );

  return new Set(result.rows.map((row) => row.id));
}

// ---------------------------------------------------------------------------
// Block enforcement (WhatsApp-style contact blocking, direct chats only)
// ---------------------------------------------------------------------------

export const BLOCK_ERROR_BLOCKER = "You blocked this contact. Unblock to send messages.";
export const BLOCK_ERROR_BLOCKED = "You can no longer reply to this contact.";

/**
 * For a DIRECT conversation, return the OTHER participant's user id (null for
 * group conversations / conversations without another participant). Groups are
 * never block-enforced.
 */
async function getDirectOtherParticipant(
  conversationId: string,
  businessId: string,
  userId: string,
): Promise<string | null> {
  const result = await query(
    `SELECT cc.type, cp.user_id as "userId"
     FROM chat_conversations cc
     JOIN chat_participants cp ON cp.conversation_id = cc.id
     WHERE cc.id = $1 AND cc.business_id = $2 AND cp.user_id <> $3
     LIMIT 1`,
    [conversationId, businessId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if ((row.type || "direct") !== "direct") return null; // groups unaffected
  return row.userId || null;
}

/**
 * Direction of an existing block between the two users:
 *  - "i-blocked-them": the requester blocked the other user
 *  - "they-blocked-me": the other user blocked the requester
 *  - null: no block in either direction
 */
async function getBlockDirection(
  businessId: string,
  blockerCandidate: string,
  otherCandidate: string,
): Promise<"i-blocked-them" | "they-blocked-me" | null> {
  const result = await query(
    `SELECT blocker_id as "blockerId"
     FROM user_blocks
     WHERE business_id = $1
       AND ((blocker_id = $2 AND blocked_id = $3) OR (blocker_id = $3 AND blocked_id = $2))
     LIMIT 1`,
    [businessId, blockerCandidate, otherCandidate],
  );
  const row = result.rows[0];
  if (!row) return null;
  return row.blockerId === blockerCandidate ? "i-blocked-them" : "they-blocked-me";
}

/**
 * 403 response payload when a direct conversation between the two users is
 * blocked (either direction), or null when messaging is allowed.
 */
async function resolveBlockError(
  businessId: string,
  userId: string,
  otherUserId: string | null,
): Promise<{ status: number; error: string } | null> {
  if (!otherUserId) return null;
  const direction = await getBlockDirection(businessId, userId, otherUserId);
  if (direction === "i-blocked-them") {
    return { status: 403, error: BLOCK_ERROR_BLOCKER };
  }
  if (direction === "they-blocked-me") {
    return { status: 403, error: BLOCK_ERROR_BLOCKED };
  }
  return null;
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
            'role', COALESCE(cp.role, 'member'),
            'lastReadAt', cp.last_read_at,
            'lastSeen', (
              SELECT us.last_activity_at
              FROM user_sessions us
              WHERE us.user_id = cp.user_id
              ORDER BY us.last_activity_at DESC
              LIMIT 1
            ),
            'presenceStatus', COALESCE(u.presence_status, 'offline'),
            'lastSeenAt', u.last_seen_at,
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

    // Blocks involving the requester (both directions) — one query for the
    // whole list; direct conversations surface blockedByMe/blockedMe flags.
    const blocksResult = await query(
      `SELECT blocker_id as "blockerId", blocked_id as "blockedId"
       FROM user_blocks
       WHERE business_id = $1 AND (blocker_id = $2 OR blocked_id = $2)`,
      [businessId, userId],
    );
    const blockedByMeIds = new Set(
      blocksResult.rows.filter((r: any) => r.blockerId === userId).map((r: any) => r.blockedId),
    );
    const blockedMeIds = new Set(
      blocksResult.rows.filter((r: any) => r.blockedId === userId).map((r: any) => r.blockerId),
    );

    // Derive display helpers: direct chats show the OTHER participant's name
    // and avatar; group chats show the conversation name.
    const data = result.rows.map((conv: any) => {
      const participants = Array.isArray(conv.participants) ? conv.participants : [];
      const other = participants.find((p: any) => p && p.userId && String(p.userId) !== String(userId));
      const mine = participants.find((p: any) => p && p.userId && String(p.userId) === String(userId));
      const isGroup = (conv.type || 'direct') !== 'direct' || participants.length > 2;
      const isDirect = !isGroup && !!other;
      return {
        ...conv,
        isGroup,
        displayName: isGroup ? (conv.name || 'Group chat') : (other?.name || conv.name || 'Direct chat'),
        displayAvatarUrl: isGroup ? null : (other?.avatarUrl || null),
        myRole: mine?.role || 'member',
        otherUserLastSeenAt: isDirect ? (other?.lastSeenAt || null) : null,
        otherUserPresenceStatus: isDirect ? (other?.presenceStatus || 'offline') : null,
        blockedByMe: isDirect ? blockedByMeIds.has(other.userId) : false,
        blockedMe: isDirect ? blockedMeIds.has(other.userId) : false,
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
        cm.edited_at as "editedAt",
        cm.deleted_for_everyone as "deletedForEveryone",
        cm.reply_to_id as "replyToId",
        (cm.sender_id = $2) as "canDeleteForEveryone",
        ($2 = ANY(cm.deleted_for)) as "deletedForMe",
        u.name as "senderName",
        rm.sender_id as "replyToSenderId",
        ru.name as "replyToSenderName",
        rm.content as "replyToContent",
        rm.message_type as "replyToMessageType",
        rm.attachment_type as "replyToAttachmentType"
      FROM chat_messages cm
      JOIN users u ON cm.sender_id = u.id
      LEFT JOIN chat_messages rm ON rm.id = cm.reply_to_id
      LEFT JOIN users ru ON ru.id = rm.sender_id
      WHERE cm.conversation_id = $1
      ORDER BY cm.created_at DESC
      LIMIT $3 OFFSET $4`,
      [conversationId, userId, limit, offset],
    );

    // Reshape the flat reply columns into a nested replyTo preview and strip
    // content from messages this requester deleted for themselves (the row is
    // kept so clients can render a tombstone in the correct position).
    // NOTE: the query is DESC and the public contract is ascending, keep .reverse().
    const messages = result.rows.reverse().map((row: any) => {
      const isDeletedForMe = !!row.deletedForMe;
      const message: any = {
        id: row.id,
        conversationId: row.conversationId,
        senderId: row.senderId,
        senderName: row.senderName,
        // Tombstone: content/attachments hidden for messages deleted for me.
        content: isDeletedForMe ? null : row.content,
        attachmentUrl: isDeletedForMe ? null : row.attachmentUrl,
        attachmentType: isDeletedForMe ? null : row.attachmentType,
        attachmentName: isDeletedForMe ? null : row.attachmentName,
        attachmentSize: isDeletedForMe ? null : row.attachmentSize,
        messageType: row.messageType,
        createdAt: row.createdAt,
        editedAt: row.editedAt || null,
        deletedForEveryone: !!row.deletedForEveryone,
        deletedForMe: isDeletedForMe,
        canDeleteForEveryone: !!row.canDeleteForEveryone,
        replyTo: row.replyToId
          ? {
              id: row.replyToId,
              senderId: row.replyToSenderId || null,
              senderName: row.replyToSenderName || null,
              content: row.replyToContent,
              messageType: row.replyToMessageType || null,
              attachmentType: row.replyToAttachmentType || null,
            }
          : null,
      };
      return message;
    });

    const response: ApiResponse<{ messages: any[]; total: number }> = {
      success: true,
      data: { messages, total },
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

    // Block enforcement: a direct conversation with a blocked contact cannot
    // be created (or reopened) — groups are unaffected.
    if (type === "direct" && providedIds.length === 1) {
      const blockError = await resolveBlockError(businessId, userId, providedIds[0]);
      if (blockError) {
        return res.status(blockError.status).json({
          success: false,
          error: blockError.error,
        });
      }
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
      // Group creators become the conversation admin (direct chats keep
      // everyone as 'member').
      const participantRole = (type || "direct") !== "direct" && pid === userId ? "admin" : "member";
      const participantResult = await query(
        `INSERT INTO chat_participants (conversation_id, user_id, role)
         VALUES ($1, $2, $3)
         RETURNING id, user_id as "userId", role, last_read_at as "lastReadAt"`,
        [conversation.id, pid, participantRole],
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

    // Block enforcement: direct chats with a blocked contact cannot receive
    // messages (either direction). Group conversations are unaffected.
    const otherParticipantId = await getDirectOtherParticipant(conversationId, businessId, userId);
    const blockError = await resolveBlockError(businessId, userId, otherParticipantId);
    if (blockError) {
      return res.status(blockError.status).json({
        success: false,
        error: blockError.error,
      });
    }

    // Reply threading: replyToId must reference a message in the SAME
    // conversation (otherwise the client could stitch together fake quotes).
    let replyToId: string | null = null;
    if (req.body?.replyToId != null && req.body.replyToId !== "") {
      const candidate = String(req.body.replyToId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
        return res.status(400).json({
          success: false,
          error: "replyToId must be a valid message id",
        });
      }
      const replyCheck = await query(
        `SELECT id FROM chat_messages WHERE id = $1 AND conversation_id = $2 LIMIT 1`,
        [candidate, conversationId],
      );
      if (replyCheck.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: "replyToId must reference a message in the same conversation",
        });
      }
      replyToId = candidate;
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
         attachment_name, attachment_size, message_type, reply_to_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, conversation_id as "conversationId", sender_id as "senderId",
                 content, attachment_url as "attachmentUrl", attachment_type as "attachmentType",
                 attachment_name as "attachmentName", attachment_size as "attachmentSize",
                 message_type as "messageType", reply_to_id as "replyToId",
                 edited_at as "editedAt", deleted_for_everyone as "deletedForEveryone",
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
        replyToId,
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

        // FCM push for OTHER participants (WhatsApp-style): without this,
        // chat messages only ever reached devices through the socket — a
        // killed app never saw any chat notification. Fire-and-forget;
        // carries the recipient's TOTAL unread count so the mobile launcher
        // badge stays exact.
        try {
          const { sendPushToUsers } = await import("../services/push");
          const recipientIds = participantsResult.rows
            .map((row: any) => row.userId)
            .filter((id: any): id is string => !!id && id !== userId);
          if (recipientIds.length > 0) {
            const pushTitle = conversationType === "group"
              ? `${message.senderName || "Someone"} · ${conversationName || "Group"}`
              : message.senderName || "New message";
            const pushBody = conversationType === "group" && conversationName
              ? `${message.senderName || "Someone"}: ${preview}`
              : preview || "Sent you a message";
            const unreadByUser = new Map<string, number>();
            await Promise.all(
              recipientIds.map(async (recipientId: string) => {
                try {
                  const unreadRes = await query(
                    `SELECT COUNT(*)::int AS unread
                     FROM chat_messages cm
                     JOIN chat_participants cp
                       ON cp.conversation_id = cm.conversation_id AND cp.user_id = $1
                     WHERE cm.sender_id <> $1
                       AND cm.created_at > COALESCE(cp.last_read_at, cp.created_at, to_timestamp(0))`,
                    [recipientId],
                  );
                  unreadByUser.set(recipientId, unreadRes.rows[0]?.unread || 1);
                } catch {
                  unreadByUser.set(recipientId, 1);
                }
              }),
            );
            await sendPushToUsers(
              recipientIds.map((recipientId: string) => ({ userId: recipientId })),
              {
                title: pushTitle,
                body: pushBody,
                data: {
                  type: "chat-message",
                  conversationId,
                  messageId: message.id,
                  senderId: userId,
                  senderName: message.senderName || "Someone",
                  conversationName: conversationName || "",
                  conversationType,
                  message: preview,
                  badge: String(unreadByUser.size > 0 ? Math.max(...unreadByUser.values()) : 1),
                },
                androidChannelId: "general",
              },
              { inApp: false, type: "chat_message" },
            ).catch(() => {});
          }
        } catch (chatPushError) {
          console.error("Chat FCM push error:", chatPushError);
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
    // Placeholder values ("PASTE_TENOR_KEY_HERE") count as not configured so
    // clients hide the GIF tab instead of showing an empty broken picker.
    const apiKey = getTenorApiKey();
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
    res.json({ success: true, data: { configured: !!getTenorApiKey(), gifs: [] } });
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

// ---------------------------------------------------------------------------
// Message edit / delete (WhatsApp-style)
// ---------------------------------------------------------------------------

const MESSAGE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_MESSAGE_LENGTH = 4000;

/** Shared SELECT for one message inside a conversation (member-scoped). */
async function getConversationMessage(conversationId: string, messageId: string) {
  const result = await query(
    `SELECT cm.id, cm.conversation_id as "conversationId", cm.sender_id as "senderId",
            cm.content, cm.message_type as "messageType", cm.created_at as "createdAt",
            cm.edited_at as "editedAt", cm.deleted_for_everyone as "deletedForEveryone",
            u.name as "senderName"
     FROM chat_messages cm
     JOIN users u ON u.id = cm.sender_id
     WHERE cm.id = $1 AND cm.conversation_id = $2
     LIMIT 1`,
    [messageId, conversationId],
  );
  return result.rows[0] || null;
}

/**
 * PATCH /chat/conversations/:conversationId/messages/:messageId
 * Edit a message's text. Sender only, never call-logs, within 24h of sending.
 * Emits `message:updated` to the conversation room.
 */
export const editMessage: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { conversationId, messageId } = req.params as { conversationId: string; messageId: string };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const hasAccess = await ensureConversationParticipant(conversationId, businessId, userId);
    if (!hasAccess) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const message = await getConversationMessage(conversationId, messageId);
    if (!message) {
      return res.status(404).json({ success: false, error: "Message not found" });
    }
    if (message.senderId !== userId) {
      return res.status(403).json({ success: false, error: "Only the sender can edit this message" });
    }
    if (message.messageType === "call-log") {
      return res.status(403).json({ success: false, error: "Call log messages cannot be edited" });
    }
    if (message.deletedForEveryone) {
      return res.status(403).json({ success: false, error: "This message was deleted" });
    }
    const createdAtMs = new Date(message.createdAt).getTime();
    if (!Number.isFinite(createdAtMs) || Date.now() - createdAtMs > MESSAGE_EDIT_WINDOW_MS) {
      return res.status(403).json({ success: false, error: "Messages can only be edited within 24 hours" });
    }

    const rawContent = typeof req.body?.content === "string" ? req.body.content : "";
    const content = rawContent.trim();
    if (!content) {
      return res.status(400).json({ success: false, error: "Message content cannot be empty" });
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ success: false, error: `Message content cannot exceed ${MAX_MESSAGE_LENGTH} characters` });
    }

    const updateResult = await query(
      `UPDATE chat_messages
       SET content = $1, edited_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, conversation_id as "conversationId", sender_id as "senderId",
                 content, attachment_url as "attachmentUrl", attachment_type as "attachmentType",
                 attachment_name as "attachmentName", attachment_size as "attachmentSize",
                 message_type as "messageType", created_at as "createdAt",
                 edited_at as "editedAt", deleted_for_everyone as "deletedForEveryone",
                 reply_to_id as "replyToId"`,
      [content, messageId],
    );
    const row = updateResult.rows[0];

    const updated = {
      ...row,
      senderName: message.senderName || null,
      deletedForMe: false,
      canDeleteForEveryone: row.senderId === userId,
      replyTo: null,
    };

    const io = getSocketServer();
    if (io) {
      io.to(`conversation:${conversationId}`).emit("message:updated", {
        conversationId,
        message: updated,
      });
    }

    const response: ApiResponse<any> = { success: true, data: updated };
    res.json(response);
  } catch (error) {
    console.error("Edit message error:", error);
    res.status(500).json({ success: false, error: "Failed to edit message" });
  }
};

/**
 * DELETE /chat/conversations/:conversationId/messages/:messageId?scope=me|everyone
 *  - scope=everyone: sender only. Tombstones the message (content/attachments
 *    nulled, deleted_for_everyone=TRUE) and broadcasts `message:updated`.
 *  - scope=me: any participant. Appends the requester to deleted_for
 *    (idempotent, no broadcast) — the message disappears only for them.
 * Call-log messages can be deleted for me but never for everyone.
 */
export const deleteMessage: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { conversationId, messageId } = req.params as { conversationId: string; messageId: string };
    const scope = req.query.scope === "everyone" ? "everyone" : "me";
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const hasAccess = await ensureConversationParticipant(conversationId, businessId, userId);
    if (!hasAccess) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const message = await getConversationMessage(conversationId, messageId);
    if (!message) {
      return res.status(404).json({ success: false, error: "Message not found" });
    }

    if (scope === "everyone") {
      if (message.senderId !== userId) {
        return res.status(403).json({ success: false, error: "Only the sender can delete this message for everyone" });
      }
      if (message.messageType === "call-log") {
        return res.status(403).json({ success: false, error: "Call log messages cannot be deleted for everyone" });
      }

      const updateResult = await query(
        `UPDATE chat_messages
         SET deleted_for_everyone = TRUE, content = NULL,
             attachment_url = NULL, attachment_name = NULL, attachment_size = NULL
         WHERE id = $1
         RETURNING id, conversation_id as "conversationId", sender_id as "senderId",
                   content, attachment_url as "attachmentUrl", attachment_type as "attachmentType",
                   attachment_name as "attachmentName", attachment_size as "attachmentSize",
                   message_type as "messageType", created_at as "createdAt",
                   edited_at as "editedAt", deleted_for_everyone as "deletedForEveryone"`,
        [messageId],
      );

      const updated = {
        ...updateResult.rows[0],
        senderName: null,
        deletedForMe: false,
        canDeleteForEveryone: true,
        replyTo: null,
      };

      const io = getSocketServer();
      if (io) {
        io.to(`conversation:${conversationId}`).emit("message:updated", {
          conversationId,
          message: updated,
        });
      }

      const response: ApiResponse<any> = { success: true, data: updated };
      return res.json(response);
    }

    // scope=me — idempotent array append, NO broadcast.
    await query(
      `UPDATE chat_messages
       SET deleted_for = ARRAY_APPEND(deleted_for, $2)
       WHERE id = $1 AND NOT ($2 = ANY(deleted_for))`,
      [messageId, userId],
    );

    const response: ApiResponse<any> = {
      success: true,
      data: {
        id: messageId,
        conversationId,
        deletedForMe: true,
      },
    };
    res.json(response);
  } catch (error) {
    console.error("Delete message error:", error);
    res.status(500).json({ success: false, error: "Failed to delete message" });
  }
};

// ---------------------------------------------------------------------------
// Participants: list / leave / roles / remove
// ---------------------------------------------------------------------------

/**
 * GET /chat/conversations/:conversationId/participants
 * Participant roster with roles, presence and last-seen (WhatsApp-style).
 */
export const getParticipants: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { conversationId } = req.params as { conversationId: string };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const hasAccess = await ensureConversationParticipant(conversationId, businessId, userId);
    if (!hasAccess) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const result = await query(
      `SELECT cp.user_id as "userId", u.name, u.avatar_url as "avatarUrl",
              COALESCE(cp.role, 'member') as role,
              COALESCE(u.presence_status, 'offline') as "presenceStatus",
              u.last_seen_at as "lastSeenAt",
              cp.created_at as "joinedAt"
       FROM chat_participants cp
       LEFT JOIN users u ON u.id = cp.user_id
       WHERE cp.conversation_id = $1
       ORDER BY cp.created_at ASC`,
      [conversationId],
    );

    const response: ApiResponse<{ participants: any[] }> = {
      success: true,
      data: {
        participants: result.rows.map((row: any) => ({
          userId: row.userId,
          name: row.name || null,
          avatarUrl: row.avatarUrl || null,
          role: row.role || "member",
          presenceStatus: row.presenceStatus || "offline",
          lastSeenAt: row.lastSeenAt || null,
          joinedAt: row.joinedAt || null,
        })),
      },
    };
    res.json(response);
  } catch (error) {
    console.error("Get participants error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch participants" });
  }
};

/**
 * POST /chat/conversations/:conversationId/leave
 * The requester removes their own membership. The room is told via
 * `conversation:participant-left`.
 */
export const leaveConversation: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { conversationId } = req.params as { conversationId: string };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const hasAccess = await ensureConversationParticipant(conversationId, businessId, userId);
    if (!hasAccess) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const nameResult = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
    const userName = nameResult.rows[0]?.name || null;

    const deleteResult = await query(
      `DELETE FROM chat_participants
       WHERE conversation_id = $1 AND user_id = $2
       RETURNING id`,
      [conversationId, userId],
    );
    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Participant record not found" });
    }

    const io = getSocketServer();
    if (io) {
      io.to(`conversation:${conversationId}`).emit("conversation:participant-left", {
        conversationId,
        userId,
        userName,
      });
    }

    const response: ApiResponse<any> = {
      success: true,
      data: { conversationId, userId, userName },
    };
    res.json(response);
  } catch (error) {
    console.error("Leave conversation error:", error);
    res.status(500).json({ success: false, error: "Failed to leave conversation" });
  }
};

/** Is the requester allowed to manage participants of this conversation? */
async function isConversationAdmin(
  conversationId: string,
  businessId: string,
  userId: string,
): Promise<boolean> {
  const result = await query(
    `SELECT (cc.created_by = $3) as "isCreator", COALESCE(cp.role, 'member') as "myRole"
     FROM chat_conversations cc
     LEFT JOIN chat_participants cp ON cp.conversation_id = cc.id AND cp.user_id = $3
     WHERE cc.id = $1 AND cc.business_id = $2
     LIMIT 1`,
    [conversationId, businessId, userId],
  );
  const row = result.rows[0];
  if (!row) return false;
  return row.isCreator === true || row.myRole === "admin";
}

/**
 * PATCH /chat/conversations/:conversationId/participants/:userId
 * Promote/demote a participant. Admins (or the conversation creator) only.
 * Body: { role: 'admin' | 'member' }
 */
export const updateParticipantRole: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { conversationId, userId: targetUserId } = req.params as {
      conversationId: string;
      userId: string;
    };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const hasAccess = await ensureConversationParticipant(conversationId, businessId, userId);
    if (!hasAccess) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const role = req.body?.role;
    if (role !== "admin" && role !== "member") {
      return res.status(400).json({ success: false, error: "role must be 'admin' or 'member'" });
    }

    if (!(await isConversationAdmin(conversationId, businessId, userId))) {
      return res.status(403).json({ success: false, error: "Only conversation admins can change participant roles" });
    }

    const updateResult = await query(
      `UPDATE chat_participants
       SET role = $1
       WHERE conversation_id = $2 AND user_id = $3
       RETURNING id, user_id as "userId", role`,
      [role, conversationId, targetUserId],
    );
    if (updateResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Participant not found" });
    }

    const response: ApiResponse<any> = { success: true, data: updateResult.rows[0] };
    res.json(response);
  } catch (error) {
    console.error("Update participant role error:", error);
    res.status(500).json({ success: false, error: "Failed to update participant role" });
  }
};

/**
 * DELETE /chat/conversations/:conversationId/participants/:userId
 * Admins (or the conversation creator) remove a participant. The room is told
 * via `conversation:participant-removed`.
 */
export const removeParticipant: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { conversationId, userId: targetUserId } = req.params as {
      conversationId: string;
      userId: string;
    };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const hasAccess = await ensureConversationParticipant(conversationId, businessId, userId);
    if (!hasAccess) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    if (!(await isConversationAdmin(conversationId, businessId, userId))) {
      return res.status(403).json({ success: false, error: "Only conversation admins can remove participants" });
    }

    if (targetUserId === userId) {
      return res.status(400).json({ success: false, error: "Use the leave endpoint to remove yourself" });
    }

    const nameResult = await query(`SELECT name FROM users WHERE id = $1`, [targetUserId]);
    const userName = nameResult.rows[0]?.name || null;

    const deleteResult = await query(
      `DELETE FROM chat_participants
       WHERE conversation_id = $1 AND user_id = $2
       RETURNING id`,
      [conversationId, targetUserId],
    );
    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Participant not found" });
    }

    const io = getSocketServer();
    if (io) {
      io.to(`conversation:${conversationId}`).emit("conversation:participant-removed", {
        conversationId,
        userId: targetUserId,
        userName,
      });
    }

    const response: ApiResponse<any> = {
      success: true,
      data: { conversationId, userId: targetUserId, userName },
    };
    res.json(response);
  } catch (error) {
    console.error("Remove participant error:", error);
    res.status(500).json({ success: false, error: "Failed to remove participant" });
  }
};
