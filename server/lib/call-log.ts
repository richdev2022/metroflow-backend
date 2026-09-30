import type { Server } from "socket.io";
import { query } from "../db";

/**
 * WhatsApp-style call log: append a 'call-log' chat message to the linked
 * conversation (or every direct conversation between the initiator and each
 * participant) when a call reaches its FIRST final state.
 *
 * Shared by:
 *  - REST paths (server/routes/calls.ts via updateCall/createCall)
 *  - Socket paths (server/lib/socket.ts call:end / call:reject)
 *
 * Lives in lib/ (not routes/) so both layers import the same implementation
 * without a routes → lib → routes import cycle: callers pass the Socket.IO
 * server instance explicitly (chat routes already import getSocketServer and
 * socket.ts owns the module-level io).
 *
 * JSON payload (backward compatible — callers may rely on the original keys):
 *   callType, status, durationSeconds, initiatorName, callCode
 * plus (v2): callId, conversationId (first conversation the log was posted
 * to), hasTranscript, endedAt (ISO).
 * Never throws.
 */

const CALL_LOG_FINAL_STATUSES = new Set(["completed", "missed", "cancelled"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CallLogOptions {
  businessId: string;
  senderId: string;                     // call initiator
  conversationId?: string | null;       // explicit conversation (when call was started from chat)
  participantIds: string[];             // all call participants (incl. initiator)
  callType: "audio" | "video" | string;
  status: "completed" | "missed" | "cancelled" | string;
  durationSeconds?: number | null;
  callCode?: string | null;
  callId?: string | null;               // calls.id — enables hasTranscript lookup
  endedAt?: string | Date | null;       // when the call reached its final state
}

export async function postCallLogMessage(
  opts: CallLogOptions,
  io?: Server | null,
): Promise<void> {
  try {
    const { businessId, senderId, conversationId, participantIds } = opts;
    if (!businessId || !senderId) return;

    const initiatorResult = await query(`SELECT name FROM users WHERE id = $1`, [senderId]);
    const initiatorName = initiatorResult.rows[0]?.name || null;

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
      (pid) => pid && pid !== senderId && UUID_RE.test(pid),
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

    // Call transcripts (captions persisted via meeting_transcripts with
    // meeting_id = the room id). Today only meetings record captions, so for
    // calls this is false until a call-transcript pipeline exists.
    let hasTranscript = false;
    if (opts.callId && UUID_RE.test(opts.callId)) {
      try {
        const t = await query(
          `SELECT EXISTS(SELECT 1 FROM meeting_transcripts WHERE meeting_id = $1) AS exists`,
          [opts.callId],
        );
        hasTranscript = !!t.rows[0]?.exists;
      } catch { /* non-fatal */ }
    }

    const durationSeconds =
      typeof opts.durationSeconds === "number" && Number.isFinite(opts.durationSeconds)
        ? Math.max(0, Math.round(opts.durationSeconds))
        : null;
    const endedAtIso = opts.endedAt
      ? new Date(opts.endedAt as any).toISOString()
      : null;

    const firstConversationId = targetConversations.values().next().value as string;

    for (const convId of targetConversations) {
      const payload = JSON.stringify({
        callType: opts.callType === "audio" ? "audio" : "video",
        status: opts.status,
        durationSeconds,
        initiatorName,
        callCode: opts.callCode || null,
        // v2 fields (additive — old clients ignore unknown keys)
        callId: opts.callId || null,
        conversationId: firstConversationId,
        hasTranscript,
        endedAt: endedAtIso,
      });

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

export { CALL_LOG_FINAL_STATUSES };
