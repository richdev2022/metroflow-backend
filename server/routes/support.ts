import { Router, RequestHandler } from "express";
import crypto from "crypto";
import { query } from "../db";
import {
  AuthenticatedRequest,
  authenticateToken,
} from "../middleware/auth";
import { verifyToken } from "../services/auth";
import {
  AuthenticatedAdminRequest,
  authenticateAdmin,
  requirePermission,
} from "../middleware/adminAuth";
import { sendEmail } from "../services/email-sender";
import { ApiResponse } from "@shared/api";

/**
 * Customer Support desk — the human side of MetricAi.
 *
 * Flow:
 *  1. A user chats with MetricAi (in-app) or the public "Ask MetricAi" widget.
 *  2. When MetricAi cannot help, it suggests a human; the client collects the
 *     customer's name + email and POSTs the full transcript to /support/escalate.
 *  3. A support conversation is created (with the transcript attached) and all
 *     support agents receive an in-app notification; the admin Support dashboard
 *     plays a loud ringtone until an agent opens the conversation.
 *  4. Agent and customer chat live (polling friendly: `?after=` cursor), then
 *     the agent (or customer) concludes the conversation (resolved / closed).
 *
 * Agents are platform admins whose role carries the `support` permission
 * (super admins always have access).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tiny in-memory rate limiter (per IP). Good enough for a single PM2 worker. */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function allowRate(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

function clientIp(req: any): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

/** Insert a notification for support agents (dedupeKey suppresses repeats for 30 min). */
async function notifySupportAgents(
  type: string,
  title: string,
  body: string | null,
  conversationId: string | null,
  dedupeKey?: string | null,
): Promise<void> {
  try {
    if (dedupeKey) {
      await query(
        `INSERT INTO admin_notifications (type, title, body, conversation_id, dedupe_key)
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (
           SELECT 1 FROM admin_notifications
           WHERE dedupe_key = $5 AND created_at > NOW() - INTERVAL '30 minutes'
         )`,
        [type, title, body, conversationId, dedupeKey],
      );
    } else {
      await query(
        `INSERT INTO admin_notifications (type, title, body, conversation_id)
         VALUES ($1, $2, $3, $4)`,
        [type, title, body, conversationId],
      );
    }
  } catch (error) {
    console.error("notifySupportAgents error:", error);
  }
}

/** Best-effort email ping to the support inbox (SUPPORT_ALERT_EMAIL env). */
async function emailSupportInbox(subject: string, html: string): Promise<void> {
  const to = process.env.SUPPORT_ALERT_EMAIL || process.env.ADMIN_ALERT_EMAIL;
  if (!to) return;
  try {
    await sendEmail(to, "Support Desk", subject, html);
  } catch (error) {
    console.error("support email notify failed (non-fatal):", error);
  }
}

function truncatePreview(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function formatTranscript(
  transcript: Array<{ role?: string; content?: string; createdAt?: string }>,
): string {
  return transcript
    .map((m) => {
      const who =
        m.role === "assistant" || m.role === "ai"
          ? "MetricAi"
          : m.role === "agent"
            ? "Support Agent"
            : "Customer";
      const when = m.createdAt ? ` (${m.createdAt})` : "";
      return `[${who}]${when}: ${m.content || ""}`;
    })
    .join("\n");
}

interface SupportConversationRow {
  id: string;
  status: string;
  access_key: string | null;
  user_id: string | null;
  guest_name: string | null;
  guest_email: string | null;
  [key: string]: any;
}

const CONVERSATION_SELECT = `
  SELECT c.*,
    u.name  AS user_name,
    u.email AS user_email,
    b.name  AS business_name,
    pa.name AS assigned_agent_name,
    (SELECT COUNT(*)::int FROM support_messages m WHERE m.conversation_id = c.id) AS message_count
  FROM support_conversations c
  LEFT JOIN users u            ON u.id = c.user_id
  LEFT JOIN businesses b       ON b.id = c.business_id
  LEFT JOIN platform_admins pa ON pa.id = c.assigned_agent_id
`;

/** Optional bearer auth — attaches req.user when a valid token is present. */
const optionalAuth: RequestHandler = async (req, res, next) => {
  const header = req.headers.authorization;
  const token = header && header.split(" ")[1];
  if (token) {
    const decoded = await verifyToken(token);
    if (decoded) {
      (req as AuthenticatedRequest).user = decoded as any;
    }
  }
  next();
};

// ---------------------------------------------------------------------------
// Public: escalate from MetricAi (in-app, widget, website) — no auth required
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /support/escalate:
 *   post:
 *     summary: Hand a MetricAi conversation over to human support
 *     description: >
 *       Creates a support conversation from a MetricAi handoff (or a direct
 *       support request). The full chat transcript is attached so agents see
 *       everything so far. Supports both authenticated users and guests
 *       (website widget). Returns an accessKey that guests must keep to read
 *       and reply to the conversation.
 *     tags: [Support]
 *     security: []           # public (bearer optional for logged-in users)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email]
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               subject:
 *                 type: string
 *               message:
 *                 type: string
 *                 description: Optional final message from the customer
 *               channel:
 *                 type: string
 *                 enum: [metric_ai, webapp_widget, website_widget, mobile]
 *               transcript:
 *                 type: array
 *                 description: MetricAi messages so far (oldest first)
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant]
 *                     content:
 *                       type: string
 *                     createdAt:
 *                       type: string
 *     responses:
 *       200:
 *         description: Conversation created
 */
export const escalateToSupport: RequestHandler = async (req, res) => {
  try {
    if (!allowRate(`escalate:${clientIp(req)}`, 8, 60 * 60 * 1000)) {
      return res.status(429).json({
        success: false,
        error: "Too many support requests. Please try again later.",
      });
    }

    const { name, email, subject, message, transcript, channel } = req.body || {};
    const cleanName = typeof name === "string" ? name.trim() : "";
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!cleanName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res
        .status(400)
        .json({ success: false, error: "Your name and a valid email are required" });
    }

    const user = (req as AuthenticatedRequest).user;
    const userId = user?.userId || null;
    const businessId = user?.businessId || null;
    const accessKey = crypto.randomBytes(24).toString("hex");
    const safeChannel = ["metric_ai", "webapp_widget", "website_widget", "mobile"].includes(channel)
      ? channel
      : "metric_ai";

    const insert = await query(
      `INSERT INTO support_conversations
        (business_id, user_id, guest_name, guest_email, channel, subject, access_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        businessId,
        userId,
        cleanName,
        cleanEmail,
        safeChannel,
        typeof subject === "string" && subject.trim()
          ? truncatePreview(subject, 120)
          : "MetricAi handoff",
        accessKey,
      ],
    );
    const conversation = insert.rows[0];

    // System message documenting the origin
    await query(
      `INSERT INTO support_messages (conversation_id, sender_type, sender_name, body)
       VALUES ($1, 'system', 'System', $2)`,
      [
        conversation.id,
        `Support request received via ${
          safeChannel === "website_widget"
            ? "the Metricorex website"
            : safeChannel === "webapp_widget"
              ? "the Ask MetricAi widget"
              : safeChannel === "mobile"
                ? "the mobile app"
                : "MetricAi"
        }.`,
      ],
    );

    // Attach the MetricAi transcript so agents have full context
    const transcriptBody = Array.isArray(transcript) ? formatTranscript(transcript) : "";
    if (transcriptBody) {
      await query(
        `INSERT INTO support_messages (conversation_id, sender_type, sender_name, body, meta)
         VALUES ($1, 'system', 'MetricAi transcript', $2, $3)`,
        [conversation.id, transcriptBody, JSON.stringify({ transcript: true })],
      );
    }

    if (typeof message === "string" && message.trim()) {
      await query(
        `INSERT INTO support_messages (conversation_id, sender_type, sender_id, sender_name, body)
         VALUES ($1, 'customer', $2, $3, $4)`,
        [conversation.id, userId, cleanName, message.trim()],
      );
    }

    await query(
      `UPDATE support_conversations
       SET last_message_preview = $2, unread_for_agent = 1
       WHERE id = $1`,
      [conversation.id, truncatePreview(message || transcriptBody || "New support request")],
    );

    await notifySupportAgents(
      "support_new_conversation",
      `New support request from ${cleanName}`,
      truncatePreview(message || transcriptBody || "A customer needs human support"),
      conversation.id,
    );

    emailSupportInbox(
      `[Metricorex Support] New request from ${cleanName}`,
      `<p><b>${cleanName}</b> (${cleanEmail}) requested human support via ${safeChannel}.</p>
       <p>${(message || transcriptBody || "").replace(/</g, "&lt;").slice(0, 2000)}</p>`,
    );

    const response: ApiResponse<any> = {
      success: true,
      data: {
        conversationId: conversation.id,
        accessKey: userId ? undefined : accessKey, // guests need the key to chat
        status: "open",
      },
    };
    res.json(response);
  } catch (error) {
    console.error("Support escalate error:", error);
    res.status(500).json({ success: false, error: "Failed to submit your support request" });
  }
};

// ---------------------------------------------------------------------------
// Guest access (website widget) — authorized by the conversation access_key
// ---------------------------------------------------------------------------

async function loadGuestConversation(id: string, key: string): Promise<SupportConversationRow | null> {
  const result = await query(
    `SELECT * FROM support_conversations WHERE id = $1 AND access_key = $2`,
    [id, key],
  );
  return result.rows[0] || null;
}

/**
 * @swagger
 * /support/guest/{id}/messages:
 *   get:
 *     summary: Guest reads a support conversation (website widget)
 *     tags: [Support]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: key
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: after
 *         schema: { type: string, format: date-time }
 *         description: Only return messages created after this timestamp (polling cursor)
 *     responses:
 *       200:
 *         description: Messages + conversation status
 */
export const getGuestMessages: RequestHandler = async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const key = String(req.query.key || "");
    if (!id || !key) {
      return res.status(400).json({ success: false, error: "conversation id and key are required" });
    }
    const conversation = await loadGuestConversation(id, key);
    if (!conversation) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const after = String(req.query.after || "");
    const params: any[] = [id];
    let where = "";
    if (after) {
      params.push(after);
      where = `AND created_at > $2`;
    }
    const messages = await query(
      `SELECT id, sender_type, sender_name, body, meta, created_at
       FROM support_messages WHERE conversation_id = $1 ${where}
       ORDER BY created_at ASC LIMIT 300`,
      params,
    );

    // Guest has seen agent replies
    if (!after) {
      await query(
        `UPDATE support_conversations SET unread_for_customer = 0 WHERE id = $1`,
        [id],
      );
    }

    res.json({
      success: true,
      data: {
        messages: messages.rows,
        status: conversation.status,
        guestName: conversation.guest_name,
      },
    });
  } catch (error) {
    console.error("Guest messages error:", error);
    res.status(500).json({ success: false, error: "Failed to load messages" });
  }
};

/**
 * @swagger
 * /support/guest/{id}/messages:
 *   post:
 *     summary: Guest replies to a support conversation (website widget)
 *     tags: [Support]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body, key]
 *             properties:
 *               body:
 *                 type: string
 *               key:
 *                 type: string
 *     responses:
 *       200:
 *         description: Message stored
 */
export const postGuestMessage: RequestHandler = async (req, res) => {
  try {
    if (!allowRate(`guest-msg:${clientIp(req)}`, 40, 60 * 60 * 1000)) {
      return res.status(429).json({ success: false, error: "Too many messages. Slow down a little." });
    }
    const id = String(req.params.id || "");
    const key = String(req.body?.key || req.query.key || "");
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!id || !key || !body) {
      return res.status(400).json({ success: false, error: "conversation id, key and body are required" });
    }
    const conversation = await loadGuestConversation(id, key);
    if (!conversation) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }
    if (["resolved", "closed"].includes(conversation.status)) {
      return res.status(400).json({
        success: false,
        error: "This conversation has been concluded. Start a new support request if you still need help.",
        code: "conversation_concluded",
      });
    }

    const insert = await query(
      `INSERT INTO support_messages (conversation_id, sender_type, sender_name, body)
       VALUES ($1, 'customer', $2, $3) RETURNING id, created_at`,
      [id, conversation.guest_name || "Guest", body],
    );
    await query(
      `UPDATE support_conversations
       SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
           unread_for_agent = unread_for_agent + 1, status = CASE WHEN status IN ('resolved','closed') THEN 'open' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id, truncatePreview(body)],
    );
    await notifySupportAgents(
      "support_new_message",
      `New message from ${conversation.guest_name || "Guest"}`,
      truncatePreview(body),
      id,
      `support-msg-${id}`,
    );

    res.json({
      success: true,
      data: { id: insert.rows[0].id, createdAt: insert.rows[0].created_at },
    });
  } catch (error) {
    console.error("Guest post message error:", error);
    res.status(500).json({ success: false, error: "Failed to send message" });
  }
};

// ---------------------------------------------------------------------------
// Customer access (authenticated users — in-app MetricAi handoff / support)
// ---------------------------------------------------------------------------

async function assertOwnership(id: string, userId?: string): Promise<SupportConversationRow | null> {
  if (!userId) return null;
  const result = await query(
    `SELECT * FROM support_conversations WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rows[0] || null;
}

/**
 * @swagger
 * /support/my/conversations:
 *   get:
 *     summary: Support conversations of the authenticated user
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of the user's support conversations
 */
export const getMyConversations: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "User authentication required" });
    const result = await query(
      `${CONVERSATION_SELECT} WHERE c.user_id = $1 ORDER BY c.last_message_at DESC LIMIT 50`,
      [userId],
    );
    res.json({ success: true, data: { conversations: result.rows } });
  } catch (error) {
    console.error("My conversations error:", error);
    res.status(500).json({ success: false, error: "Failed to load support conversations" });
  }
};

/**
 * @swagger
 * /support/my/{id}/messages:
 *   get:
 *     summary: Customer reads messages of their support conversation
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: after
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Messages + status
 */
export const getMyMessages: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const conversation = await assertOwnership(String(req.params.id || ""), userId);
    if (!conversation) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }
    const after = String(req.query.after || "");
    const params: any[] = [conversation.id];
    let where = "";
    if (after) {
      params.push(after);
      where = `AND created_at > $2`;
    }
    const messages = await query(
      `SELECT id, sender_type, sender_name, body, meta, created_at
       FROM support_messages WHERE conversation_id = $1 ${where}
       ORDER BY created_at ASC LIMIT 300`,
      params,
    );
    if (!after) {
      await query(`UPDATE support_conversations SET unread_for_customer = 0 WHERE id = $1`, [
        conversation.id,
      ]);
    }
    res.json({
      success: true,
      data: { messages: messages.rows, status: conversation.status },
    });
  } catch (error) {
    console.error("My messages error:", error);
    res.status(500).json({ success: false, error: "Failed to load messages" });
  }
};

/**
 * @swagger
 * /support/my/{id}/messages:
 *   post:
 *     summary: Customer replies to their support conversation
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body]
 *             properties:
 *               body: { type: string }
 *     responses:
 *       200:
 *         description: Message stored
 */
export const postMyMessage: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const conversation = await assertOwnership(String(req.params.id || ""), userId);
    if (!conversation) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }
    if (["resolved", "closed"].includes(conversation.status)) {
      return res.status(400).json({
        success: false,
        error: "This conversation has been concluded. Start a new support request if you still need help.",
        code: "conversation_concluded",
      });
    }
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) {
      return res.status(400).json({ success: false, error: "body is required" });
    }
    const senderName =
      (req.user as any)?.name || conversation.guest_name || "Customer";
    const insert = await query(
      `INSERT INTO support_messages (conversation_id, sender_type, sender_id, sender_name, body)
       VALUES ($1, 'customer', $2, $3, $4) RETURNING id, created_at`,
      [conversation.id, userId, senderName, body],
    );
    await query(
      `UPDATE support_conversations
       SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
           unread_for_agent = unread_for_agent + 1, status = CASE WHEN status IN ('resolved','closed') THEN 'open' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [conversation.id, truncatePreview(body)],
    );
    await notifySupportAgents(
      "support_new_message",
      `New message from ${senderName}`,
      truncatePreview(body),
      conversation.id,
      `support-msg-${conversation.id}`,
    );
    res.json({ success: true, data: { id: insert.rows[0].id, createdAt: insert.rows[0].created_at } });
  } catch (error) {
    console.error("Post my message error:", error);
    res.status(500).json({ success: false, error: "Failed to send message" });
  }
};

/**
 * @swagger
 * /support/my/{id}/close:
 *   post:
 *     summary: Customer concludes their support conversation
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Conversation closed
 */
export const closeMyConversation: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const conversation = await assertOwnership(String(req.params.id || ""), userId);
    if (!conversation) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }
    await query(
      `UPDATE support_conversations SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [conversation.id],
    );
    await query(
      `INSERT INTO support_messages (conversation_id, sender_type, sender_name, body)
       VALUES ($1, 'system', 'System', 'The customer concluded this conversation.')`,
      [conversation.id],
    );
    res.json({ success: true, data: { status: "closed" }, message: "Conversation concluded" });
  } catch (error) {
    console.error("Close my conversation error:", error);
    res.status(500).json({ success: false, error: "Failed to conclude conversation" });
  }
};

// ---------------------------------------------------------------------------
// Agent access (admin console) — requires the `support` permission
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /support/admin/conversations:
 *   get:
 *     summary: Support inbox for agents (filter + search + pagination)
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [all, open, pending, resolved, closed] }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30 }
 *     responses:
 *       200:
 *         description: Conversations with customer info and unread counters
 */
export const getAgentConversations: RequestHandler = async (
  req: AuthenticatedAdminRequest,
  res,
) => {
  try {
    const status = String(req.query.status || "open");
    const search = String(req.query.q || "").trim();
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit)) || 30));
    const offset = (page - 1) * limit;

    const params: any[] = [];
    const conditions: string[] = [];

    if (status !== "all") {
      params.push(status);
      conditions.push(`c.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      const idx = `$${params.length}`;
      conditions.push(
        `(c.guest_name ILIKE ${idx} OR c.guest_email ILIKE ${idx} OR u.name ILIKE ${idx} OR u.email ILIKE ${idx} OR c.subject ILIKE ${idx})`,
      );
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(limit);
    const limitIdx = `$${params.length}`;
    params.push(offset);
    const offsetIdx = `$${params.length}`;

    const rows = await query(
      `${CONVERSATION_SELECT} ${whereClause} ORDER BY c.last_message_at DESC LIMIT ${limitIdx} OFFSET ${offsetIdx}`,
      params,
    );

    const countParams = params.slice(0, params.length - 2);
    const count = await query(
      `SELECT COUNT(*)::int AS total FROM support_conversations c
       LEFT JOIN users u ON u.id = c.user_id ${whereClause}`,
      countParams,
    );

    res.json({
      success: true,
      data: {
        conversations: rows.rows,
        total: count.rows[0]?.total || 0,
        page,
        limit,
      },
    });
  } catch (error) {
    console.error("Agent conversations error:", error);
    res.status(500).json({ success: false, error: "Failed to load support conversations" });
  }
};

/**
 * @swagger
 * /support/admin/{id}/messages:
 *   get:
 *     summary: Agent reads a support conversation (supports ?after= polling cursor)
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: after
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Messages, status and customer info
 */
export const getAgentMessages: RequestHandler = async (req: AuthenticatedAdminRequest, res) => {
  try {
    const id = String(req.params.id || "");
    const conversation = await query(`${CONVERSATION_SELECT} WHERE c.id = $1`, [id]);
    if (conversation.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }
    const after = String(req.query.after || "");
    const params: any[] = [id];
    let where = "";
    if (after) {
      params.push(after);
      where = `AND created_at > $2`;
    }
    const messages = await query(
      `SELECT id, sender_type, sender_id, sender_name, body, meta, created_at
       FROM support_messages WHERE conversation_id = $1 ${where}
       ORDER BY created_at ASC LIMIT 500`,
      params,
    );
    if (!after) {
      await query(
        `UPDATE support_conversations SET unread_for_agent = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id],
      );
    }
    res.json({
      success: true,
      data: { messages: messages.rows, conversation: conversation.rows[0] },
    });
  } catch (error) {
    console.error("Agent messages error:", error);
    res.status(500).json({ success: false, error: "Failed to load messages" });
  }
};

/**
 * @swagger
 * /support/admin/{id}/messages:
 *   post:
 *     summary: Agent replies to a support conversation
 *     description: >
 *       Stores the agent reply, bumps the customer unread counter and sends a
 *       best-effort FCM push + in-app notification to registered customers.
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body]
 *             properties:
 *               body: { type: string }
 *     responses:
 *       200:
 *         description: Reply stored
 */
export const postAgentMessage: RequestHandler = async (req: AuthenticatedAdminRequest, res) => {
  try {
    const id = String(req.params.id || "");
    const adminId = req.admin?.adminId;
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) {
      return res.status(400).json({ success: false, error: "body is required" });
    }
    const conversation = await query(`SELECT * FROM support_conversations WHERE id = $1`, [id]);
    if (conversation.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }
    const convo = conversation.rows[0];
    if (["resolved", "closed"].includes(convo.status) && !req.body?.reopen) {
      return res.status(400).json({
        success: false,
        error: "This conversation is concluded. Reopen it before replying.",
        code: "conversation_concluded",
      });
    }

    // Resolve the agent display name
    let agentName = "Support Agent";
    if (adminId) {
      const adminRow = await query(`SELECT name FROM platform_admins WHERE id = $1`, [adminId]);
      if (adminRow.rows[0]?.name) agentName = adminRow.rows[0].name;
    }

    const insert = await query(
      `INSERT INTO support_messages (conversation_id, sender_type, sender_id, sender_name, body)
       VALUES ($1, 'agent', $2, $3, $4) RETURNING id, created_at`,
      [id, adminId, agentName, body],
    );
    await query(
      `UPDATE support_conversations
       SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
           unread_for_customer = unread_for_customer + 1,
           status = CASE WHEN status IN ('resolved','closed') THEN 'pending' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id, truncatePreview(body)],
    );

    // Best-effort push + in-app notification for registered customers
    if (convo.user_id) {
      try {
        const { sendPushToUsers } = await import("../services/push");
        await sendPushToUsers(
          [{ userId: convo.user_id, businessId: convo.business_id || undefined }],
          {
            title: "Support Team",
            body: truncatePreview(body, 120),
            data: { type: "support_reply", conversationId: id },
          },
          { inApp: true, type: "support_reply" },
        );
      } catch (pushError) {
        console.error("support push failed (non-fatal):", pushError);
      }
    }

    res.json({
      success: true,
      data: { id: insert.rows[0].id, createdAt: insert.rows[0].created_at },
    });
  } catch (error) {
    console.error("Agent post message error:", error);
    res.status(500).json({ success: false, error: "Failed to send reply" });
  }
};

/**
 * @swagger
 * /support/admin/{id}/status:
 *   post:
 *     summary: Update a conversation status (assign / resolve / close / reopen)
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [open, pending, resolved, closed]
 *     responses:
 *       200:
 *         description: Updated status
 */
export const updateConversationStatus: RequestHandler = async (
  req: AuthenticatedAdminRequest,
  res,
) => {
  try {
    const id = String(req.params.id || "");
    const status = String(req.body?.status || "");
    if (!["open", "pending", "resolved", "closed"].includes(status)) {
      return res.status(400).json({ success: false, error: "Invalid status" });
    }
    const conversation = await query(`SELECT id, user_id FROM support_conversations WHERE id = $1`, [id]);
    if (conversation.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    await query(
      `UPDATE support_conversations SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id, status],
    );

    const labels: Record<string, string> = {
      open: "reopened",
      pending: "marked as pending",
      resolved: "marked as resolved",
      closed: "concluded",
    };
    await query(
      `INSERT INTO support_messages (conversation_id, sender_type, sender_name, body)
       VALUES ($1, 'system', 'System', $2)`,
      [id, `Support marked this conversation as ${labels[status]}.`],
    );

    // Let the customer know (registered users only, best-effort)
    if (["resolved", "closed"].includes(status) && conversation.rows[0].user_id) {
      try {
        const { sendPushToUsers } = await import("../services/push");
        await sendPushToUsers(
          [{ userId: conversation.rows[0].user_id }],
          {
            title: "Support Update",
            body:
              status === "resolved"
                ? "Your support conversation has been resolved. Glad we could help!"
                : "Your support conversation has been concluded.",
            data: { type: "support_status", conversationId: id, status },
          },
          { inApp: true, type: "support_status" },
        );
      } catch (pushError) {
        console.error("support status push failed (non-fatal):", pushError);
      }
    }

    res.json({ success: true, data: { status } });
  } catch (error) {
    console.error("Update conversation status error:", error);
    res.status(500).json({ success: false, error: "Failed to update conversation" });
  }
};

/**
 * @swagger
 * /support/admin/{id}/assign:
 *   post:
 *     summary: Assign a conversation to an agent (defaults to self)
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Assigned
 */
export const assignConversation: RequestHandler = async (req: AuthenticatedAdminRequest, res) => {
  try {
    const id = String(req.params.id || "");
    const adminId = String(req.body?.adminId || req.admin?.adminId || "");
    if (!adminId) {
      return res.status(400).json({ success: false, error: "adminId is required" });
    }
    const adminRow = await query(`SELECT name FROM platform_admins WHERE id = $1`, [adminId]);
    if (adminRow.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Admin not found" });
    }
    await query(
      `UPDATE support_conversations SET assigned_agent_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id, adminId],
    );
    await query(
      `INSERT INTO support_messages (conversation_id, sender_type, sender_name, body)
       VALUES ($1, 'system', 'System', $2)`,
      [id, `${adminRow.rows[0].name} from support joined the conversation.`],
    );
    res.json({ success: true, data: { assignedAgentId: adminId } });
  } catch (error) {
    console.error("Assign conversation error:", error);
    res.status(500).json({ success: false, error: "Failed to assign conversation" });
  }
};

/**
 * @swagger
 * /support/admin/notifications:
 *   get:
 *     summary: In-app notifications for support agents (new requests, new messages, MetricAi activity)
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30 }
 *     responses:
 *       200:
 *         description: Notifications + unreadCount
 */
export const getAgentNotifications: RequestHandler = async (req: AuthenticatedAdminRequest, res) => {
  try {
    const adminId = req.admin?.adminId;
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit)) || 30));
    const rows = await query(
      `SELECT id, type, title, body, conversation_id, is_read, created_at
       FROM admin_notifications
       WHERE admin_id IS NULL OR admin_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [adminId, limit],
    );
    const unread = await query(
      `SELECT COUNT(*)::int AS total FROM admin_notifications
       WHERE is_read = FALSE AND (admin_id IS NULL OR admin_id = $1)`,
      [adminId],
    );
    res.json({
      success: true,
      data: { notifications: rows.rows, unreadCount: unread.rows[0]?.total || 0 },
    });
  } catch (error) {
    console.error("Agent notifications error:", error);
    res.status(500).json({ success: false, error: "Failed to load notifications" });
  }
};

/**
 * @swagger
 * /support/admin/notifications/read-all:
 *   post:
 *     summary: Mark all support notifications as read
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: All marked read
 */
export const readAllAgentNotifications: RequestHandler = async (req: AuthenticatedAdminRequest, res) => {
  try {
    await query(`UPDATE admin_notifications SET is_read = TRUE WHERE is_read = FALSE`);
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    console.error("Read all notifications error:", error);
    res.status(500).json({ success: false, error: "Failed to update notifications" });
  }
};

/**
 * @swagger
 * /support/admin/stats:
 *   get:
 *     summary: Support desk statistics (inbox counts + MetricAi activity today)
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Counters for the dashboard header
 */
export const getSupportStats: RequestHandler = async (req: AuthenticatedAdminRequest, res) => {
  try {
    const statusCounts = await query(
      `SELECT status, COUNT(*)::int AS count FROM support_conversations GROUP BY status`,
    );
    const unread = await query(
      `SELECT COUNT(*)::int AS total FROM support_conversations WHERE unread_for_agent > 0 AND status IN ('open','pending')`,
    );
    const newToday = await query(
      `SELECT COUNT(*)::int AS total FROM support_conversations WHERE created_at >= CURRENT_DATE`,
    );
    const aiQuestionsToday = await query(
      `SELECT COUNT(*)::int AS total FROM ai_messages WHERE role = 'user' AND created_at >= CURRENT_DATE`,
    );
    const stats: Record<string, number> = { open: 0, pending: 0, resolved: 0, closed: 0 };
    for (const row of statusCounts.rows) stats[row.status] = row.count;
    res.json({
      success: true,
      data: {
        ...stats,
        unreadConversations: unread.rows[0]?.total || 0,
        newToday: newToday.rows[0]?.total || 0,
        aiQuestionsToday: aiQuestionsToday.rows[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error("Support stats error:", error);
    res.status(500).json({ success: false, error: "Failed to load support stats" });
  }
};

/**
 * @swagger
 * /support/admin/ai-activity:
 *   get:
 *     summary: Recent MetricAi questions across the platform (activity feed)
 *     tags: [Support]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Recent user questions asked to MetricAi
 */
export const getAiActivity: RequestHandler = async (req: AuthenticatedAdminRequest, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit)) || 50));
    const rows = await query(
      `SELECT m.id, m.content, m.image_url, m.created_at,
              u.name AS user_name, u.email AS user_email, b.name AS business_name
       FROM ai_messages m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN businesses b ON b.id = m.business_id
       WHERE m.role = 'user'
       ORDER BY m.created_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ success: true, data: { activity: rows.rows } });
  } catch (error) {
    console.error("AI activity error:", error);
    res.status(500).json({ success: false, error: "Failed to load MetricAi activity" });
  }
};

// ---------------------------------------------------------------------------
// Router wiring
// ---------------------------------------------------------------------------

const router = Router();

// Public (optional auth — attaches user when a bearer token is present)
router.post("/escalate", optionalAuth, escalateToSupport as any);

// Guest (website widget)
router.get("/guest/:id/messages", getGuestMessages as any);
router.post("/guest/:id/messages", postGuestMessage as any);

// Customer (authenticated user)
router.get("/my/conversations", authenticateToken as any, getMyConversations as any);
router.get("/my/:id/messages", authenticateToken as any, getMyMessages as any);
router.post("/my/:id/messages", authenticateToken as any, postMyMessage as any);
router.post("/my/:id/close", authenticateToken as any, closeMyConversation as any);

// Agent (admin console) — `support` permission or super admin
const requireAgent: any[] = [
  authenticateAdmin as any,
  requirePermission("support") as any,
];
// NOTE: fixed-path routes must be registered before the "/admin/:id/..." routes
router.get("/admin/conversations", ...requireAgent, getAgentConversations as any);
router.get("/admin/notifications", ...requireAgent, getAgentNotifications as any);
router.post("/admin/notifications/read-all", ...requireAgent, readAllAgentNotifications as any);
router.get("/admin/stats", ...requireAgent, getSupportStats as any);
router.get("/admin/ai-activity", ...requireAgent, getAiActivity as any);
router.get("/admin/:id/messages", ...requireAgent, getAgentMessages as any);
router.post("/admin/:id/messages", ...requireAgent, postAgentMessage as any);
router.post("/admin/:id/status", ...requireAgent, updateConversationStatus as any);
router.post("/admin/:id/assign", ...requireAgent, assignConversation as any);

export default router;
