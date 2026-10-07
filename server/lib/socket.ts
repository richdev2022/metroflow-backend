import { Server } from "socket.io";
import http from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import { getRedisClient } from "./cache";
import logger from "./logger";
import {
  initMediasoup,
  isMediasoupReady,
  getOrCreateRoomAsync,
  getRoom,
  createWebRtcTransportForRoom,
  associateTransport,
  getRoomProducers,
  closePeer,
  maybeCloseRoom,
  ProducerAppData,
} from "./mediasoup";
import { query } from "../db";
import { roomManager } from "./roomManager";
import { verifyToken } from "../services/auth";
import { verifyGuestToken, guestCanAccessRoom } from "../utils/guestTokens";
import { isCorsOriginAllowed } from "../cors";
import crypto from "crypto";
import { glmChat, isGlmConfigured } from "./glm";
import { lightClean, aiCleanCaption } from "./caption-clean";
import {
  buildCallingCredentials,
  computeRemainingSeconds,
  resolveProviderForRoom,
  type CallingCredentials,
} from "./calling/factory";
import { generateMeetingNotesIfEligible } from "./meeting-notes";
import { resolveSingleSpeakerName, looksLikeUuid } from "./speaker-names";
import { postCallLogMessage, CALL_LOG_FINAL_STATUSES } from "./call-log";
import { pushIncomingCall, pushMissedCall, pushCallCancelled } from "./call-push";

let io: Server | null = null;

function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

async function resolveMeetingId(inputId: string): Promise<string | null> {
  if (isValidUUID(inputId)) {
    const result = await query(`SELECT id FROM meetings WHERE id = $1`, [inputId]);
    if (result.rows.length > 0) return result.rows[0].id;
  }
  const codeResult = await query(`SELECT id FROM meetings WHERE meeting_code = $1`, [inputId]);
  if (codeResult.rows.length > 0) return codeResult.rows[0].id;
  return null;
}

async function resolveCallId(inputId: string): Promise<string | null> {
  if (isValidUUID(inputId)) {
    const result = await query(`SELECT id FROM calls WHERE id = $1`, [inputId]);
    if (result.rows.length > 0) return result.rows[0].id;
  }
  const codeResult = await query(`SELECT id FROM calls WHERE call_code = $1`, [inputId]);
  if (codeResult.rows.length > 0) return codeResult.rows[0].id;
  return null;
}

async function resolveRoomId(inputId: string): Promise<{ id: string; type: 'call' | 'meeting' } | null> {
  const callId = await resolveCallId(inputId);
  if (callId) return { id: callId, type: 'call' };
  const meetingId = await resolveMeetingId(inputId);
  if (meetingId) return { id: meetingId, type: 'meeting' };
  return null;
}

/**
 * Persist presence for a user (users.presence_status + last_seen_at) and
 * broadcast `presence:update` to every conversation room they belong to —
 * WhatsApp-style online / last-seen chips. Never throws.
 */
async function broadcastPresence(
  userId: string | null | undefined,
  presenceStatus: "online" | "offline",
): Promise<void> {
  if (!userId || !io) return;
  try {
    const updated = await query(
      `UPDATE users SET presence_status = $2, last_seen_at = NOW()
       WHERE id = $1
       RETURNING last_seen_at as "lastSeenAt"`,
      [userId, presenceStatus],
    );
    const conversations = await query(
      `SELECT conversation_id FROM chat_participants WHERE user_id = $1`,
      [userId],
    );
    const payload = {
      userId,
      lastSeenAt: updated.rows[0]?.lastSeenAt || new Date().toISOString(),
      presenceStatus,
    };
    for (const row of conversations.rows) {
      io.to(`conversation:${row.conversation_id}`).emit("presence:update", payload);
    }
  } catch (err) {
    logger.warn(`Presence broadcast failed for user ${userId}:`, err);
  }
}

// Function to end call/meeting automatically
async function endRoom(roomId: string, roomType: 'call' | 'meeting'): Promise<void> {
  try {
    // MetricAi Call Copilot: drop the live-insights scheduler for this room.
    clearLiveInsightsForRoom(roomId);
    let storedProvider: string | null = null;
    // Snapshot the pre-end row so the call-log below posts only on the FIRST
    // final-state transition (timeout / no-answer auto-close).
    let preEnd: any = null;
    if (roomType === 'call') {
      try {
        const pre = await query(
          `SELECT id, business_id, type, status, duration, call_code, created_by, conversation_id
           FROM calls WHERE id = $1`,
          [roomId],
        );
        preEnd = pre.rows[0] || null;
      } catch (err) {
        logger.warn(`Failed to snapshot call before auto-end for ${roomId}:`, err);
      }
      const r = await query(`UPDATE calls SET status = 'completed', ended_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING provider`, [roomId]);
      storedProvider = r.rows[0]?.provider || null;
    } else {
      const r = await query(`UPDATE meetings SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = $1 RETURNING provider`, [roomId]);
      storedProvider = r.rows[0]?.provider || null;
    }

    const ioServer = getSocketServer();
    if (ioServer) {
      if (roomType === 'call') {
        ioServer.to(`room:${roomId}`).emit("call:ended", { callId: roomId, reason: 'duration_limit' });
      } else {
        ioServer.to(`room:${roomId}`).emit("meeting:ended", { meetingId: roomId, reason: 'duration_limit' });
        ioServer.to(`meeting:${roomId}`).emit("meeting:ended", { meetingId: roomId, reason: 'duration_limit' });
      }
    }

    // Timeout/no-answer lifecycle path: the auto-closed call also gets its
    // WhatsApp-style call-log message (first transition only). Fire-and-forget.
    if (roomType === 'call' && preEnd && !CALL_LOG_FINAL_STATUSES.has(preEnd.status)) {
      try {
        const parts = await query(`SELECT user_id FROM call_participants WHERE call_id = $1`, [roomId]);
        const durationSeconds =
          preEnd.duration == null ? null : Math.max(0, Math.round(Number(preEnd.duration) || 0));
        postCallLogMessage(
          {
            businessId: preEnd.business_id,
            senderId: preEnd.created_by,
            conversationId: preEnd.conversation_id || undefined,
            participantIds: (parts.rows.map((r: any) => r.user_id) || []).filter(Boolean),
            callType: preEnd.type,
            status: "completed",
            durationSeconds,
            callCode: preEnd.call_code,
            callId: roomId,
            endedAt: new Date(),
          },
          ioServer,
        ).catch(() => undefined);
      } catch (err) {
        logger.warn("Call-log posting for auto-ended call failed (non-fatal):", err);
      }
    }

    // Tear down the media session at the provider so nobody stays connected
    // after the backend-enforced deadline (a malicious client cannot extend
    // the meeting by keeping its socket/media connection alive).
    try {
      const provider = await resolveProviderForRoom(roomType, roomId, storedProvider);
      await provider.endSession(roomId);
    } catch (err) {
      logger.warn(`Provider endSession failed for ${roomType}:${roomId}:`, err);
    }

    // Finalize AI notes from the persisted transcript (meetings AND calls,
    // best effort — needs GLM configured + a summarizable transcript).
    if (roomType === 'meeting') {
      generateMeetingNotesIfEligible(roomId).catch((err) =>
        logger.warn("Meeting notes generation failed:", err),
      );
    } else if (roomType === 'call') {
      generateMeetingNotesIfEligible(roomId, 'Call').catch((err) =>
        logger.warn("Call notes generation failed:", err),
      );
    }

    const participants = roomManager.getParticipants(roomId);
    participants.forEach((participant) => {
      roomManager.removeParticipant(roomId, participant.id);
    });
  } catch (error) {
    logger.error("Error ending room:", error);
  }
}

const warnedRooms5min = new Set<string>();
const warnedRooms1min = new Set<string>();

// Room lifecycle checker (countdown warnings + auto-close).
// Cheap by design:
//   - 30s cadence is plenty precise for 5-min/1-min warnings
//   - queries are TIME-BOUNDED: only rooms expiring within the next
//     6 minutes (or already expired but not yet closed, oldest first)
//   - LIMIT caps the batch; idle DBs with thousands of stale
//     'ongoing' rows are no longer fetched every few seconds
//   - errors are rate-limited to one concise line per 5 minutes
let lastRoomCheckErrorLogAt = 0;

async function checkExpiredRooms() {
  try {
    const now = new Date();
    const nowMs = now.getTime();
    const fiveMinMs = 5 * 60 * 1000;
    const oneMinMs = 1 * 60 * 1000;

    // ----- CALLS -----
    // Only rooms that expire within the warning window (+ already-expired
    // ones waiting to be closed). Bounded and ordered oldest-first.
    const upcomingCalls = await query(
      `SELECT id, ended_at, business_id FROM calls
       WHERE status = 'ongoing' AND ended_at IS NOT NULL
         AND ended_at <= NOW() + INTERVAL '6 minutes'
       ORDER BY ended_at ASC
       LIMIT 50`,
    );

    for (const call of upcomingCalls.rows) {
      const endsAtMs = new Date(call.ended_at).getTime();
      const remainingMs = endsAtMs - nowMs;

      if (remainingMs <= 0) {
        await endRoom(call.id, 'call');
        warnedRooms5min.delete(call.id);
        warnedRooms1min.delete(call.id);
        continue;
      }

      const ioServer = getSocketServer();
      if (!ioServer) continue;

      // 5-minute warning
      if (remainingMs <= fiveMinMs && remainingMs > oneMinMs && !warnedRooms5min.has(call.id)) {
        warnedRooms5min.add(call.id);
        ioServer.to(`room:${call.id}`).emit("call:countdown-warning", {
          callId: call.id,
          remainingMs,
          remainingMinutes: 5,
          message: "5 minutes remaining in this call.",
        });
      }

      // 1-minute warning
      if (remainingMs <= oneMinMs && remainingMs > 0 && !warnedRooms1min.has(call.id)) {
        warnedRooms1min.add(call.id);
        ioServer.to(`room:${call.id}`).emit("call:countdown-warning", {
          callId: call.id,
          remainingMs,
          remainingMinutes: 1,
          message: "1 minute remaining in this call.",
        });
      }
    }

    // ----- MEETINGS -----
    const upcomingMeetings = await query(
      `SELECT id, end_time, business_id FROM meetings
       WHERE status = 'ongoing' AND end_time IS NOT NULL
         AND end_time <= NOW() + INTERVAL '6 minutes'
       ORDER BY end_time ASC
       LIMIT 50`,
    );

    for (const meeting of upcomingMeetings.rows) {
      const endsAtMs = new Date(meeting.end_time).getTime();
      const remainingMs = endsAtMs - nowMs;

      if (remainingMs <= 0) {
        await endRoom(meeting.id, 'meeting');
        warnedRooms5min.delete(meeting.id);
        warnedRooms1min.delete(meeting.id);
        continue;
      }

      const ioServer = getSocketServer();
      if (!ioServer) continue;

      // 5-minute warning
      if (remainingMs <= fiveMinMs && remainingMs > oneMinMs && !warnedRooms5min.has(meeting.id)) {
        warnedRooms5min.add(meeting.id);
        const payload = {
          meetingId: meeting.id,
          remainingMs,
          remainingMinutes: 5,
          message: "5 minutes remaining in this meeting.",
        };
        ioServer.to(`room:${meeting.id}`).emit("meeting:countdown-warning", payload);
        ioServer.to(`meeting:${meeting.id}`).emit("meeting:countdown-warning", payload);
      }

      // 1-minute warning
      if (remainingMs <= oneMinMs && remainingMs > 0 && !warnedRooms1min.has(meeting.id)) {
        warnedRooms1min.add(meeting.id);
        const payload = {
          meetingId: meeting.id,
          remainingMs,
          remainingMinutes: 1,
          message: "1 minute remaining in this meeting.",
        };
        ioServer.to(`room:${meeting.id}`).emit("meeting:countdown-warning", payload);
        ioServer.to(`meeting:${meeting.id}`).emit("meeting:countdown-warning", payload);
      }
    }
  } catch (error: any) {
    // Rate-limit: at most one concise error line per 5 minutes
    const nowMs = Date.now();
    if (nowMs - lastRoomCheckErrorLogAt > 5 * 60 * 1000) {
      lastRoomCheckErrorLogAt = nowMs;
      const msg = error?.message || String(error);
      const code = error?.code ? ` [pg ${error.code}]` : "";
      logger.error(`Room lifecycle check skipped: ${msg}${code}`);
    }
  }
}

// Self-scheduling loop: next tick is scheduled only after the current one
// finishes, so slow passes can never overlap (unlike setInterval).
const ROOM_CHECK_INTERVAL_MS = 30_000; // 30 seconds
async function runRoomCheckLoop() {
  await checkExpiredRooms();
  setTimeout(runRoomCheckLoop, ROOM_CHECK_INTERVAL_MS);
}
runRoomCheckLoop();

export function initSocketServer(server: http.Server): void {
  // Initialize mediasoup with one automatic retry — a failed worker spawn must
  // not permanently kill the media plane for the process lifetime.
  initMediasoup().catch(async (err) => {
    logger.error("Mediasoup init failed (retrying once in 5s):", err);
    await new Promise((r) => setTimeout(r, 5000));
    initMediasoup().catch((retryErr) => logger.error("Mediasoup init retry failed:", retryErr));
  });

  io = new Server(server, {
    cors: {
      // Reflect allowed origins instead of "*": browsers REJECT
      // "Access-Control-Allow-Origin: *" whenever a request is sent with
      // credentials (withCredentials: true), which produced the Socket.IO
      // CORS errors in production. Origins are validated with the same
      // policy as the REST API (server/cors.ts). Native/mobile clients that
      // send no Origin header are always allowed.
      origin(requestOrigin, callback) {
        if (!requestOrigin || isCorsOriginAllowed(requestOrigin)) {
          callback(null, requestOrigin || true);
        } else {
          callback(new Error(`Origin ${requestOrigin} is not allowed by CORS`));
        }
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  const redisClient = getRedisClient();
  const isRedisReady = () => redisClient?.status === "ready";

  if (isRedisReady()) {
    const pubClient = redisClient.duplicate();
    const subClient = redisClient.duplicate();

    io.adapter(createAdapter(pubClient, subClient));
    logger.info("Socket.io Redis adapter initialized");
  }

  // Optional socket authentication: if the client provides a Bearer session
  // token in handshake.auth.token we resolve it to userId/businessId.
  // Unauthenticated (guest) sockets are still allowed to connect.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake?.auth?.token;
      if (token) {
        const session = await verifyToken(token);
        if (session) {
          socket.data.userId = session.userId;
          socket.data.businessId = session.businessId;
          socket.data.authenticated = true;
        } else {
          // An INVALID/EXPIRED token must NOT silently downgrade to guest:
          // guest sockets never join user:{id}, so call:incoming / chat
          // events would never reach this client and in-app ringing would
          // quietly die (the "phone only rings on web" bug). Reject the
          // handshake instead — Socket.IO clients auto-reconnect, and the
          // mobile app refreshes its token on connect_error, so the next
          // attempt authenticates properly.
          logger.warn("Socket presented an invalid/expired token - rejecting handshake (client will reconnect with a fresh token)");
          return next(new Error("auth_failed_token_invalid"));
        }
      }
    } catch (err) {
      logger.error("Socket auth middleware error:", err);
    }
    next();
  });

  // Waiting-room queues: roomId -> Map<participantId, entry>.
  // BACKED BY REDIS when available so hosts and participants land on the SAME
  // queue even when Socket.IO spreads connections across PM2 cluster workers
  // (the Redis adapter broadcasts events cross-worker, but a plain in-memory
  // Map made the host's admit hit a DIFFERENT worker with an empty queue ->
  // "approved but participant still stuck in the waiting room").
  // Falls back to in-memory when Redis is unavailable (single process).
  type WaitingEntry = {
    participantId: string;
    socketId: string;
    userName: string;
    isGuest: boolean;
    since: number;
  };
  const waitingRooms = new Map<
    string,
    Map<string, WaitingEntry>
  >();

  const WAITING_KEY_TTL_SECONDS = 60 * 60; // 1h safety net for abandoned queues
  const waitingKey = (roomId: string) => `waitingroom:${roomId}`;
  const admittedKey = (roomId: string) => `waitingroom:admitted:${roomId}`;

  const wrRedisReady = () => isRedisReady();

  async function wrSet(roomId: string, participantId: string, entry: WaitingEntry): Promise<void> {
    if (wrRedisReady()) {
      try {
        await redisClient.hset(waitingKey(roomId), participantId, JSON.stringify(entry));
        await redisClient.expire(waitingKey(roomId), WAITING_KEY_TTL_SECONDS);
        return;
      } catch (err) {
        logger.error("waiting-room redis hset failed, falling back to memory:", err);
      }
    }
    getWaitingQueue(roomId).set(participantId, entry);
  }

  async function wrGet(roomId: string, participantId: string): Promise<WaitingEntry | null> {
    if (wrRedisReady()) {
      try {
        const raw = await redisClient.hget(waitingKey(roomId), participantId);
        return raw ? (JSON.parse(raw) as WaitingEntry) : null;
      } catch (err) {
        logger.error("waiting-room redis hget failed, falling back to memory:", err);
      }
    }
    return getWaitingQueue(roomId).get(participantId) || null;
  }

  async function wrDelete(roomId: string, participantId: string): Promise<void> {
    if (wrRedisReady()) {
      try {
        await redisClient.hdel(waitingKey(roomId), participantId);
        return;
      } catch (err) {
        logger.error("waiting-room redis hdel failed, falling back to memory:", err);
      }
    }
    getWaitingQueue(roomId).delete(participantId);
  }

  async function wrList(roomId: string): Promise<WaitingEntry[]> {
    if (wrRedisReady()) {
      try {
        const raw = await redisClient.hgetall(waitingKey(roomId));
        return Object.values(raw)
          .map((v) => {
            try { return JSON.parse(v) as WaitingEntry; } catch { return null; }
          })
          .filter((e): e is WaitingEntry => !!e)
          .sort((a, b) => a.since - b.since);
      } catch (err) {
        logger.error("waiting-room redis hgetall failed, falling back to memory:", err);
      }
    }
    return Array.from(getWaitingQueue(roomId).values()).sort((a, b) => a.since - b.since);
  }

  // Mark a participant as admitted (server-side enforcement gate for call:join)
  async function wrMarkAdmitted(roomId: string, participantId: string): Promise<void> {
    if (!wrRedisReady()) return;
    try {
      await redisClient.sadd(admittedKey(roomId), participantId);
      await redisClient.expire(admittedKey(roomId), 2 * 60 * 60);
    } catch (err) {
      logger.error("waiting-room sadd admitted failed:", err);
    }
  }

  async function wrIsAdmitted(roomId: string, participantId: string): Promise<boolean> {
    if (!wrRedisReady()) return false;
    try {
      return (await redisClient.sismember(admittedKey(roomId), participantId)) === 1;
    } catch (err) {
      logger.error("waiting-room sismember failed:", err);
      return false;
    }
  }

  async function wrConsumeAdmission(roomId: string, participantId: string): Promise<void> {
    if (!wrRedisReady()) return;
    try {
      await redisClient.srem(admittedKey(roomId), participantId);
    } catch (_) { /* non-fatal */ }
  }

  // Same-account multi-device tracking: roomId -> (socketId -> userId).
  // roomManager dedupes participants by userId, so a second device joining
  // with the SAME account is invisible there. This map counts real sockets
  // per room so the server can tell clients "you joined twice -> echo risk".
  const roomSockets = new Map<string, Map<string, { userId: string; userName: string }>>();

  const trackRoomSocket = (roomId: string, socketId: string, userId: string, userName: string): number => {
    if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Map());
    const sockets = roomSockets.get(roomId)!;
    sockets.set(socketId, { userId, userName });
    let sameUserCount = 0;
    for (const entry of sockets.values()) {
      if (entry.userId === userId) sameUserCount += 1;
    }
    return sameUserCount;
  };

  const untrackRoomSocket = (roomId: string, socketId: string): void => {
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) roomSockets.delete(roomId);
  };

  const untrackSocketFromAllRooms = (socketId: string): void => {
    for (const [roomId, sockets] of roomSockets.entries()) {
      if (sockets.delete(socketId) && sockets.size === 0) {
        roomSockets.delete(roomId);
      }
    }
  };

  // Emit a multi-device (echo risk) alert when the same account holds 2+
  // sockets in the room. Sent to the WHOLE room so every device of that
  // account shows the warning (all of them contribute to the echo loop).
  const maybeEmitMultiDeviceAlert = (
    resolvedRoomId: string,
    userId: string,
    userName: string,
    sameUserCount: number,
    isCall: boolean,
  ): void => {
    if (sameUserCount < 2) return;
    const payload = {
      roomId: resolvedRoomId,
      userId,
      userName,
      deviceCount: sameUserCount,
      message: `${userName || 'This account'} joined on ${sameUserCount} devices — echo likely. Leave on all but one device or use headphones.`,
    };
    // Same prefix for calls and meetings: the web room listens for `call:multi-device`.
    io.to(`room:${resolvedRoomId}`).emit("call:multi-device", payload);
    if (!isCall) {
      io.to(`room:${resolvedRoomId}`).emit("meeting:multi-device", { ...payload, meetingId: resolvedRoomId });
    }
  };

  const getWaitingQueue = (roomId: string) => {
    let q = waitingRooms.get(roomId);
    if (!q) {
      q = new Map();
      waitingRooms.set(roomId, q);
    }
    return q;
  };

  const queueToArray = (entries: WaitingEntry[]) =>
    entries.map((e) => ({
      participantId: e.participantId,
      userName: e.userName,
      isGuest: e.isGuest,
      since: e.since,
    }));

  // Shared waiting-room request logic used by BOTH the explicit
  // `waiting-room:request` event and the server-side enforcement inside
  // call:join/meeting:join. Upserting by participantId means a reconnecting
  // client simply refreshes its socketId instead of being orphaned.
  async function enqueueWaitingParticipant(
    socket: any,
    resolvedRoomId: string,
    socketId: string,
    participantId: string,
    userName: string,
    isGuest: boolean,
  ): Promise<WaitingEntry> {
    const entry: WaitingEntry = {
      participantId,
      socketId,
      userName: userName || "Guest",
      isGuest,
      since: Date.now(),
    };
    await wrSet(resolvedRoomId, participantId, entry);
    socket.data.waitingRoom = true;
    socket.data.waitingRoomId = resolvedRoomId;

    io.to(`room:${resolvedRoomId}`).emit("waiting-room:pending", {
      roomId: resolvedRoomId,
      participantId: entry.participantId,
      userId: entry.participantId,
      userName: entry.userName,
      participantName: entry.userName,
      isGuest: entry.isGuest,
    });
    io.to(`meeting:${resolvedRoomId}`).emit("waiting-room:pending", {
      roomId: resolvedRoomId,
      meetingId: resolvedRoomId,
      participantId: entry.participantId,
      userId: entry.participantId,
      userName: entry.userName,
      participantName: entry.userName,
      isGuest: entry.isGuest,
    });
    logger.info(`Waiting-room request: ${entry.userName} (${entry.participantId}) -> room ${resolvedRoomId}`);
    return entry;
  }

  io.on("connection", (socket) => {
    logger.info(`Socket connected: ${socket.id}${socket.data.authenticated ? ` (user ${socket.data.userId})` : " (guest)"}`);

    // 0. Waiting-room state kept per socket
    socket.data.waitingRoom = false;

    // 0-prec. Presence: an AUTHENTICATED connect flips the user online and
    // stamps last_seen_at; every conversation room they belong to hears
    // `presence:update` { userId, lastSeenAt, presenceStatus }.
    if (socket.data.authenticated && socket.data.userId) {
      broadcastPresence(socket.data.userId, "online").catch(() => undefined);
    }

    // 0-prec-b. Auto-join the user's personal room on authenticated connect.
    // Mobile clients never emit "user-online" (web-only behavior), so call
    // broadcasts to `user:{id}` — call:accepted / call:rejected / call:ended —
    // never reached a mobile CALLER: the callee answered but the caller kept
    // ringing until timeout. Mobile-to-mobile calls were effectively broken.
    // Joining here (and keeping user-online for legacy clients) guarantees
    // every authenticated socket receives its personal events.
    if (socket.data.authenticated && socket.data.userId) {
      socket.join(`user:${socket.data.userId}`);
      if (socket.data.businessId) {
        socket.join(`business:${socket.data.businessId}`);
      }
    }

    // 0a. Optional authentication middleware support: clients may pass
    // { auth: { token } } in io() options. Guests connect without tokens.
    // (The handshake auth was already read in io.use() below; nothing to do here.)

    // -----------------------------------------------------------------
    // Socket identity (set during handshake):
    //  - handshake.auth.token      -> authenticated business user
    //  - handshake.auth.guestToken -> guest scoped to a single room
    // Both are optional for backward compatibility with older clients,
    // but user-scoped events prefer the server-verified identity.
    // -----------------------------------------------------------------
    (async () => {
      try {
        const auth = (socket.handshake.auth || {}) as { token?: string; guestToken?: string };
        if (auth.token) {
          const decoded = await verifyToken(auth.token);
          if (decoded?.userId && decoded?.businessId) {
            socket.data.authUser = { userId: decoded.userId, businessId: decoded.businessId };
            logger.info(`Socket ${socket.id} authenticated as user ${decoded.userId}`);
          }
        }
        if (auth.guestToken) {
          const guest = verifyGuestToken(auth.guestToken);
          if (guest) {
            socket.data.guest = guest;
            logger.info(`Socket ${socket.id} authenticated as guest ${guest.guestId} for room ${guest.roomId}`);
          }
        }
      } catch (error) {
        logger.warn(`Socket ${socket.id} auth handshake failed:`, error);
      }
    })();

    // Verify a room password without exposing the stored password.
    // Single handler (previously registered twice with different ack shapes).
    // Ack includes BOTH `valid` and `success`/`passwordRequired` keys so every
    // client (web/mobile) can read the shape it expects.
    socket.on("room:verifyPassword", async (data: { roomId: string; password: string; roomType?: "meeting" | "call" | "auto" }, callback) => {
      try {
        if (!data?.roomId) {
          callback({ valid: false, success: false, error: "roomId is required" });
          return;
        }
        const resolved = await resolveRoomId(data.roomId);
        if (!resolved) {
          callback({ valid: false, success: false, error: "Room not found" });
          return;
        }
        const table = resolved.type === "call" ? "calls" : "meetings";
        const result = await query(`SELECT password FROM ${table} WHERE id = $1`, [resolved.id]);
        const stored = result.rows[0]?.password;

        if (!stored) {
          // No password set — always valid
          callback({ valid: true, success: true, passwordRequired: false, roomType: resolved.type, roomId: resolved.id });
          return;
        }
        if (stored === data.password) {
          callback({ valid: true, success: true, passwordRequired: true, roomType: resolved.type, roomId: resolved.id });
        } else {
          callback({ valid: false, success: false, error: "Incorrect password" });
        }
      } catch (error) {
        logger.error("Error verifying room password:", error);
        callback({ valid: false, success: false, error: "Server error" });
      }
    });

    // 1. Verify invitation token
    socket.on("invitation:verify", async (data: { token: string; roomId: string }, callback) => {
      try {
        const resolved = await resolveRoomId(data.roomId);
        if (!resolved) {
          callback({ valid: false, error: "Invalid room ID or code" });
          return;
        }
        const resolvedRoomId = resolved.id;

        const result = await query(
          `SELECT * FROM invitation_tokens WHERE token = $1 AND room_id = $2 AND used = FALSE AND expires_at > NOW()`,
          [data.token, resolvedRoomId]
        );

        if (result.rows.length === 0) {
          callback({ valid: false, error: "Invalid or expired token" });
          return;
        }

        await query(
          `UPDATE invitation_tokens SET used = TRUE WHERE token = $1`,
          [data.token]
        );

        callback({ valid: true, roomId: resolvedRoomId });
      } catch (error) {
        logger.error("Error verifying token:", error);
        callback({ valid: false, error: "Server error" });
      }
    });

    // 2. Join call (works for both calls and meetings; guests use guest-* ids)
    socket.on("call:join", async (data: { roomId: string; userId: string; userName: string; isHost: boolean; audioEnabled: boolean; videoEnabled: boolean; isGuest?: boolean }, callback?: (response: any) => void) => {
      try {
        const resolved = await resolveRoomId(data.roomId);
        if (!resolved) {
          logger.warn(`call:join failed - cannot resolve roomId/code: ${data.roomId}`);
          if (callback) callback({ success: false, error: "Call or meeting not found" });
          return;
        }
        const isCall = resolved.type === 'call';
        const resolvedRoomId = resolved.id;

        let endsAt: Date | null = null;
        let maxMeetingDuration: number | null = null;
        let waitingRoomEnabled = false;
        let roomProvider: string | null = null;
        let roomMaxParticipants: number | null = null;

        if (isCall) {
          const callResult = await query(
            `SELECT c.ended_at as "endedAt", c.waiting_room_enabled as "waitingRoomEnabled", c.provider, c.max_participants as "maxParticipants", pp.max_meeting_duration as "maxMeetingDuration" 
             FROM calls c
             LEFT JOIN businesses b ON c.business_id = b.id
             LEFT JOIN pricing_plans pp ON b.plan_id = pp.id
             WHERE c.id = $1`,
            [resolvedRoomId]
          );
          if (callResult.rows.length > 0) {
            const callRow = callResult.rows[0];
            endsAt = callRow.endedAt ? new Date(callRow.endedAt) : null;
            maxMeetingDuration = callRow.maxMeetingDuration;
            waitingRoomEnabled = !!callRow.waitingRoomEnabled;
            roomProvider = callRow.provider || null;
            roomMaxParticipants = callRow.maxParticipants || null;
          }
        } else {
          const meetingResult = await query(
            `SELECT m.end_time as "endedAt", m.waiting_room_enabled as "waitingRoomEnabled", m.provider, m.max_participants as "maxParticipants", pp.max_meeting_duration as "maxMeetingDuration" 
             FROM meetings m
             LEFT JOIN businesses b ON m.business_id = b.id
             LEFT JOIN pricing_plans pp ON b.plan_id = pp.id
             WHERE m.id = $1`,
            [resolvedRoomId]
          );
          if (meetingResult.rows.length > 0) {
            const meetingRow = meetingResult.rows[0];
            endsAt = meetingRow.endedAt ? new Date(meetingRow.endedAt) : null;
            maxMeetingDuration = meetingRow.maxMeetingDuration;
            waitingRoomEnabled = !!meetingRow.waitingRoomEnabled;
            roomProvider = meetingRow.provider || null;
            roomMaxParticipants = meetingRow.maxParticipants || null;
          }
        }

        const isGuest = !!data.isGuest || String(data.userId || "").startsWith("guest-");

        // -----------------------------------------------------------------
        // Server-side waiting-room enforcement. Only applied when the client
        // advertises support (waitingRoomSupport: true) so older clients keep
        // working unchanged. The host always bypasses; an admitted participant
        // consumes their admission grant and proceeds.
        // -----------------------------------------------------------------
        const supportsWaitingRoom = (data as any).waitingRoomSupport === true;
        if (supportsWaitingRoom && waitingRoomEnabled && !data.isHost) {
          const isAdmitted = await wrIsAdmitted(resolvedRoomId, data.userId);
          if (!isAdmitted) {
            const existing = await wrGet(resolvedRoomId, data.userId);
            if (!existing) {
              await enqueueWaitingParticipant(
                socket,
                resolvedRoomId,
                socket.id,
                data.userId,
                data.userName,
                isGuest,
              );
            } else {
              // Reconnect while waiting: refresh the socket binding without
              // spamming the host with another pending notification.
              await wrSet(resolvedRoomId, data.userId, { ...existing, socketId: socket.id });
              socket.data.waitingRoom = true;
              socket.data.waitingRoomId = resolvedRoomId;
            }
            if (callback) callback({ success: true, waitingRoom: true, roomId: resolvedRoomId, participantId: data.userId });
            return;
          }
          await wrConsumeAdmission(resolvedRoomId, data.userId);
        }

        roomManager.addParticipant(resolvedRoomId, {
          id: data.userId,
          name: data.userName,
          isHost: data.isHost,
          audioEnabled: data.audioEnabled,
          videoEnabled: data.videoEnabled,
          screenSharing: false,
          isGuest: isGuest || Boolean(socket.data.guest),
        }, endsAt, maxMeetingDuration);

        const participantCount = roomManager.getParticipants(resolvedRoomId).length;

        let durationStarted = false;
        if (participantCount > 1 && !endsAt && maxMeetingDuration) {
          const now = new Date();
          const calculatedEndsAt = new Date(now.getTime() + maxMeetingDuration * 60000);
          endsAt = calculatedEndsAt;
          durationStarted = true;
          roomManager.setRoomEndsAt(resolvedRoomId, calculatedEndsAt);

          if (isCall) {
            await query(
              `UPDATE calls SET ended_at = $1, duration_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
              [calculatedEndsAt.toISOString(), resolvedRoomId]
            );
          } else {
            await query(
              `UPDATE meetings SET end_time = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
              [calculatedEndsAt.toISOString(), resolvedRoomId]
            );
          }
        }

        socket.join(`room:${resolvedRoomId}`);

        // Push the current waiting-room queue to joining hosts so a host who
        // enters after requests were made immediately sees the admit list.
        if (data.isHost) {
          const entries = await wrList(resolvedRoomId);
          if (entries.length > 0) {
            socket.emit("waiting-room:queue", { roomId: resolvedRoomId, queue: queueToArray(entries) });
          }
        }

        // Track the socket against this room and detect same-account
        // multi-device joins (the real echo cause).
        const sameUserCount = trackRoomSocket(resolvedRoomId, socket.id, data.userId, data.userName);

        socket.to(`room:${resolvedRoomId}`).emit("call:participant-joined", {
          roomId: resolvedRoomId,
          userId: data.userId,
          userName: data.userName,
          isHost: data.isHost,
          isGuest,
        });
        // camelCase alias for older clients (e.g. Flutter socket_service)
        socket.to(`room:${resolvedRoomId}`).emit("call:participantJoined", {
          callId: resolvedRoomId,
          userId: data.userId,
          status: "joined",
        });
        if (!isCall) {
          // Meeting rooms joined via call:join - keep meeting:* aliases in sync
          socket.to(`room:${resolvedRoomId}`).emit("meeting:participant-joined", {
            meetingId: resolvedRoomId,
            meetingCode: data.roomId,
            userId: data.userId,
            userName: data.userName,
            isHost: data.isHost,
          });
          socket.to(`room:${resolvedRoomId}`).emit("meeting:participantJoined", {
            meetingId: resolvedRoomId,
            userId: data.userId,
          });
        }

        const roomState = roomManager.getRoomState(resolvedRoomId);
        const participantsListPayload = {
          roomId: resolvedRoomId,
          participants: roomManager.getParticipants(resolvedRoomId),
          endsAt: roomState?.endsAt?.toISOString() || null,
          maxMeetingDuration: roomState?.maxMeetingDuration,
        };
        socket.emit("call:participants-list", participantsListPayload);

        // Provider-specific media credentials. LiveKit tokens are minted here
        // so the client never touches provider secrets; mediasoup needs none.
        let calling: CallingCredentials | undefined;
        try {
          const provider = await resolveProviderForRoom(isCall ? "call" : "meeting", resolvedRoomId, roomProvider);
          calling = await buildCallingCredentials(provider, {
            roomType: isCall ? "call" : "meeting",
            roomId: resolvedRoomId,
            title: "",
            identity: data.userId,
            displayName: data.userName || "User",
            isHost: !!data.isHost,
            remainingSeconds: computeRemainingSeconds(endsAt),
            maxParticipants: roomMaxParticipants,
          });
        } catch (err) {
          logger.warn("Failed to build calling credentials:", err);
        }

        if (callback) callback({ success: true, roomId: resolvedRoomId, calling });

        if (durationStarted) {
          io.to(`room:${resolvedRoomId}`).emit("call:duration-started", {
            roomId: resolvedRoomId,
            endsAt: endsAt!.toISOString(),
            maxMeetingDuration,
            startedAt: new Date().toISOString(),
          });
        } else if (participantCount > 1 && endsAt) {
          socket.emit("call:duration-active", {
            roomId: resolvedRoomId,
            endsAt: endsAt.toISOString(),
            maxMeetingDuration,
            remainingMs: Math.max(0, endsAt.getTime() - Date.now()),
          });
        } else if (participantCount <= 1) {
          socket.emit("call:waiting-for-participants", {
            roomId: resolvedRoomId,
            message: "Waiting for more participants to join. Duration countdown will start when at least 2 participants are present.",
            maxMeetingDuration,
          });
        }

        // Server-verified echo-risk alert (same account on multiple devices)
        maybeEmitMultiDeviceAlert(resolvedRoomId, data.userId, data.userName, sameUserCount, isCall);
      } catch (error) {
        logger.error("Error joining call:", error);
        if (callback) callback({ success: false, error: "Failed to join call" });
      }
    });

    // 3. Leave call
    socket.on("call:leave", async (data: { roomId: string; userId: string; userName: string }) => {
      try {
        const resolved = await resolveRoomId(data.roomId);
        if (!resolved) return;
        const resolvedRoomId = resolved.id;

        roomManager.removeParticipant(resolvedRoomId, data.userId);
        untrackRoomSocket(resolvedRoomId, socket.id);
        socket.leave(`room:${resolvedRoomId}`);

        socket.to(`room:${resolvedRoomId}`).emit("call:participant-left", {
          roomId: resolvedRoomId,
          userId: data.userId,
          userName: data.userName,
        });
        // camelCase alias for older clients (e.g. Flutter socket_service)
        socket.to(`room:${resolvedRoomId}`).emit("call:participantLeft", {
          callId: resolvedRoomId,
          userId: data.userId,
        });
        if (resolved.type === 'meeting') {
          socket.to(`room:${resolvedRoomId}`).emit("meeting:participant-left", {
            meetingId: resolvedRoomId,
            userId: data.userId,
            userName: data.userName,
          });
          socket.to(`room:${resolvedRoomId}`).emit("meeting:participantLeft", {
            meetingId: resolvedRoomId,
            userId: data.userId,
          });
        }

        // Everyone has left the call -> actually complete it so history shows
        // the real duration instead of an "ongoing" call until the plan deadline.
        if (resolved.type === 'call' && roomManager.getParticipants(resolvedRoomId).length === 0) {
          try {
            await query(
              `UPDATE calls SET status = 'completed', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'ongoing'`,
              [resolvedRoomId]
            );
            warnedRooms5min.delete(resolvedRoomId);
            warnedRooms1min.delete(resolvedRoomId);
            roomManager.setRoomEndsAt(resolvedRoomId, null);
            const ioServer = getSocketServer();
            ioServer?.to(`room:${resolvedRoomId}`).emit("call:ended", {
              callId: resolvedRoomId,
              reason: 'all_participants_left',
            });
            ioServer?.to(`user:${data.userId}`).emit("call:ended", {
              callId: resolvedRoomId,
              reason: 'all_participants_left',
            });
            // Devices that were invited but never joined may still be RINGING
            // — the leaver's socket room broadcast cannot reach them.
            let neverJoinedIds: string[] = [];
            try {
              const parts = await query(`SELECT user_id FROM call_participants WHERE call_id = $1`, [resolvedRoomId]);
              neverJoinedIds = (parts.rows.map((row: any) => row.user_id) || []).filter(Boolean);
            } catch { /* best-effort */ }
            for (const pid of neverJoinedIds) {
              if (pid && pid !== data.userId) {
                ioServer?.to(`user:${pid}`).emit("call:ended", { callId: resolvedRoomId, reason: 'all_participants_left' });
              }
            }
            pushCallCancelled(neverJoinedIds, {
              callId: resolvedRoomId,
              callerId: data.userId,
              reason: "all_participants_left",
            });
          } catch (endError) {
            logger.error("Error completing emptied call:", endError);
          }
        }
      } catch (error) {
        logger.error("Error leaving call:", error);
      }
    });

    // 4. Get participants
    socket.on("call:get-participants", async (data: { roomId: string }, callback) => {
      try {
        const resolved = await resolveRoomId(data.roomId);
        if (!resolved) {
          callback({ participants: [] });
          return;
        }
        const participants = roomManager.getParticipants(resolved.id);
        callback({ participants, roomId: resolved.id });
      } catch (error) {
        logger.error("Error getting participants:", error);
        callback({ error: "Server error" });
      }
    });

    // 5. Update media state
    socket.on("call:participant-media-state", async (data: { roomId: string; userId: string; audioEnabled: boolean; videoEnabled: boolean; screenSharing: boolean }) => {
      try {
        const resolved = await resolveRoomId(data.roomId);
        if (!resolved) return;
        const resolvedRoomId = resolved.id;

        roomManager.updateMediaState(resolvedRoomId, data.userId, {
          audioEnabled: data.audioEnabled,
          videoEnabled: data.videoEnabled,
          screenSharing: data.screenSharing,
        });

        socket.to(`room:${resolvedRoomId}`).emit("call:participant-media-state", { ...data, roomId: resolvedRoomId });
      } catch (error) {
        logger.error("Error updating media state:", error);
      }
    });

    // 5b. Update media state (meeting variant emitted by the web client)
    socket.on("meeting:participant-media-state", async (data: { roomId: string; userId: string; audioEnabled: boolean; videoEnabled: boolean; screenSharing: boolean }) => {
      try {
        const resolved = await resolveRoomId(data.roomId);
        if (!resolved) return;
        const resolvedRoomId = resolved.id;

        roomManager.updateMediaState(resolvedRoomId, data.userId, {
          audioEnabled: data.audioEnabled,
          videoEnabled: data.videoEnabled,
          screenSharing: data.screenSharing,
        });

        socket.to(`room:${resolvedRoomId}`).emit("meeting:participant-media-state", { ...data, roomId: resolvedRoomId });
      } catch (error) {
        logger.error("Error updating meeting media state:", error);
      }
    });

    // 6. Invitation joined
    socket.on("invitation:joined", async (data: { roomId: string; userId: string; userName: string }) => {
      try {
        const resolved = await resolveRoomId(data.roomId);
        if (!resolved) return;
        const resolvedRoomId = resolved.id;

        io.to(`room:${resolvedRoomId}`).emit("invitation:joined", {
          roomId: resolvedRoomId,
          userId: data.userId,
          userName: data.userName,
        });
      } catch (error) {
        logger.error("Error handling invitation joined:", error);
      }
    });

    // 6b. (room:verifyPassword moved above — single handler, combined ack shape)

    // 6c. Waiting-room flow: guests/participants request to join
    socket.on("waiting-room:request", async (
      data: { roomId: string; userId?: string; userName?: string; meetingId?: string; isGuest?: boolean },
      callback?: (response: any) => void,
    ) => {
      try {
        const resolved = await resolveRoomId(data.roomId || data.meetingId || "");
        if (!resolved) {
          if (callback) callback({ success: false, error: "Room not found" });
          return;
        }
        const resolvedRoomId = resolved.id;
        const participantId = data.userId || `guest-${socket.id.slice(0, 8)}`;
        const userName = data.userName || "Guest";

        const entry = await enqueueWaitingParticipant(
          socket,
          resolvedRoomId,
          socket.id,
          participantId,
          userName,
          !!data.isGuest || participantId.startsWith("guest-"),
        );

        if (callback) callback({ success: true, roomId: resolvedRoomId, participantId: entry.participantId, userName: entry.userName });
      } catch (error) {
        logger.error("Error handling waiting-room request:", error);
        if (callback) callback({ success: false, error: "Server error" });
      }
    });

    socket.on("waiting-room:get-queue", async (data: { roomId: string; meetingId?: string }, callback?: (response: any) => void) => {
      try {
        const resolved = await resolveRoomId(data.roomId || data.meetingId || "");
        if (!resolved) {
          if (callback) callback({ queue: [] });
          return;
        }
        const entries = await wrList(resolved.id);
        if (callback) callback({ roomId: resolved.id, queue: queueToArray(entries) });
      } catch (error) {
        logger.error("Error getting waiting-room queue:", error);
        if (callback) callback({ queue: [] });
      }
    });

    socket.on("waiting-room:admit", async (data: { roomId?: string; meetingId?: string; participantId: string }, callback?: (response: any) => void) => {
      try {
        const roomIdInput = data.roomId || data.meetingId || "";
        const resolved = await resolveRoomId(roomIdInput);
        if (!resolved) {
          if (callback) callback({ success: false, error: "Room not found" });
          return;
        }
        const resolvedRoomId = resolved.id;
        const entry = await wrGet(resolvedRoomId, data.participantId);
        if (!entry) {
          // Participant may have connected through another worker, retried, or
          // dropped. Tell the host so their UI can drop the stale entry.
          if (callback) callback({ success: false, error: "Participant is no longer waiting" });
          const entries = await wrList(resolvedRoomId);
          io.to(`room:${resolvedRoomId}`).emit("waiting-room:queue", { roomId: resolvedRoomId, queue: queueToArray(entries) });
          return;
        }
        await wrDelete(resolvedRoomId, data.participantId);
        await wrMarkAdmitted(resolvedRoomId, data.participantId);

        io.to(entry.socketId).emit("waiting-room:admitted", {
          roomId: resolvedRoomId,
          meetingId: resolvedRoomId,
          participantId: entry.participantId,
          userName: entry.userName,
        });
        const entries = await wrList(resolvedRoomId);
        io.to(`room:${resolvedRoomId}`).emit("waiting-room:queue", {
          roomId: resolvedRoomId,
          queue: queueToArray(entries),
        });
        if (callback) callback({ success: true });
        logger.info(`Waiting-room admit: ${entry.userName} -> room ${resolvedRoomId}`);
      } catch (error) {
        logger.error("Error admitting participant:", error);
        if (callback) callback({ success: false, error: "Server error" });
      }
    });

    socket.on("waiting-room:deny", async (data: { roomId?: string; meetingId?: string; participantId: string }, callback?: (response: any) => void) => {
      try {
        const roomIdInput = data.roomId || data.meetingId || "";
        const resolved = await resolveRoomId(roomIdInput);
        if (!resolved) {
          if (callback) callback({ success: false, error: "Room not found" });
          return;
        }
        const resolvedRoomId = resolved.id;
        const entry = await wrGet(resolvedRoomId, data.participantId);
        if (!entry) {
          if (callback) callback({ success: false, error: "Participant is no longer waiting" });
          return;
        }
        await wrDelete(resolvedRoomId, data.participantId);

        io.to(entry.socketId).emit("waiting-room:denied", {
          roomId: resolvedRoomId,
          meetingId: resolvedRoomId,
          participantId: entry.participantId,
        });
        const entries = await wrList(resolvedRoomId);
        io.to(`room:${resolvedRoomId}`).emit("waiting-room:queue", {
          roomId: resolvedRoomId,
          queue: queueToArray(entries),
        });
        if (callback) callback({ success: true });
      } catch (error) {
        logger.error("Error denying participant:", error);
        if (callback) callback({ success: false, error: "Server error" });
      }
    });

    socket.on("waiting-room:admit-all", async (data: { roomId?: string; meetingId?: string }, callback?: (response: any) => void) => {
      try {
        const roomIdInput = data.roomId || data.meetingId || "";
        const resolved = await resolveRoomId(roomIdInput);
        if (!resolved) {
          if (callback) callback({ success: false, error: "Room not found" });
          return;
        }
        const resolvedRoomId = resolved.id;
        const entries = await wrList(resolvedRoomId);
        for (const entry of entries) {
          await wrMarkAdmitted(resolvedRoomId, entry.participantId);
          io.to(entry.socketId).emit("waiting-room:admitted", {
            roomId: resolvedRoomId,
            meetingId: resolvedRoomId,
            participantId: entry.participantId,
            userName: entry.userName,
          });
        }
        for (const entry of entries) {
          await wrDelete(resolvedRoomId, entry.participantId);
        }
        io.to(`room:${resolvedRoomId}`).emit("waiting-room:queue", {
          roomId: resolvedRoomId,
          queue: [],
        });
        if (callback) callback({ success: true, admitted: entries.length });
      } catch (error) {
        logger.error("Error admitting all participants:", error);
        if (callback) callback({ success: false, error: "Server error" });
      }
    });

    // User presence — accepts BOTH payload shapes:
    //   - web-style (JS client): two positional args (userId, businessId)
    //   - mobile (Dart client): ONE data argument — socket_io_client's emit()
    //     only takes a single data param, so Dart sends {userId, businessId}
    //     as a map (three positional args do not compile there).
    // The server-verified handshake identity always wins when present, and
    // anything unresolvable is discarded instead of being stringified into
    // garbage rooms like "user:[object Object]" or "user:abc,def".
    socket.on("user-online", async (...args: any[]) => {
      const first = args[0];
      const payload =
        first && typeof first === "object" && !Array.isArray(first)
          ? (first as { userId?: string; businessId?: string })
          : null;
      let userId: string =
        payload?.userId ?? (typeof first === "string" ? first : "");
      let businessId: string =
        payload?.businessId ?? (typeof args[1] === "string" ? args[1] : "");
      // Prefer the server-verified identity from handshake auth when present
      if (socket.data.authenticated) {
        userId = socket.data.userId;
        businessId = socket.data.businessId;
      }
      if (!userId || !businessId) return;
      socket.data.userId = userId;
      socket.data.businessId = businessId;

      socket.join(`user:${userId}`);
      socket.join(`business:${businessId}`);

      if (isRedisReady()) {
        await redisClient.setex(
          `online:${businessId}:${userId}`,
          60,
          Date.now().toString()
        );
      }

      socket.to(`business:${businessId}`).emit("user-presence-updated", {
        userId,
        status: "online",
      });

      logger.info(`User ${userId} marked as online in business ${businessId}`);
    });

    socket.on("user-presence", async (status: string) => {
      const { userId, businessId } = socket.data;
      if (userId && businessId) {
        socket.to(`business:${businessId}`).emit("user-presence-updated", {
          userId,
          status,
        });
      }
    });

    // Same dual-shape contract as "user-online" above; the handshake identity
    // wins so unauthenticated or malformed payloads can never poison the
    // presence keys with "online:undefined:undefined".
    socket.on("user-keep-alive", async (...args: any[]) => {
      const first = args[0];
      const payload =
        first && typeof first === "object" && !Array.isArray(first)
          ? (first as { userId?: string; businessId?: string })
          : null;
      let userId: string =
        payload?.userId ?? (typeof first === "string" ? first : "");
      let businessId: string =
        payload?.businessId ?? (typeof args[1] === "string" ? args[1] : "");
      if (socket.data.authenticated) {
        userId = socket.data.userId;
        businessId = socket.data.businessId;
      }
      if (!userId || !businessId) return;
      if (isRedisReady()) {
        await redisClient.setex(
          `online:${businessId}:${userId}`,
          60,
          Date.now().toString()
        );
      }
    });

    // WhatsApp-style last-seen keepalive from chat clients: bump
    // users.last_seen_at so the conversation list shows a fresh timestamp.
    socket.on("presence:ping", async () => {
      const pingUserId = socket.data.userId;
      if (!pingUserId) return;
      try {
        await query(`UPDATE users SET last_seen_at = NOW() WHERE id = $1`, [pingUserId]);
      } catch (err) {
        logger.warn(`presence:ping failed for user ${pingUserId}:`, err);
      }
    });

    socket.on("join-conversation", (conversationId: string) => {
      socket.join(`conversation:${conversationId}`);
      logger.info(`Socket ${socket.id} joined conversation:${conversationId}`);
    });

    // Typing indicators (web client emits these; rebroadcast to the conversation room)
    socket.on("chat:typing", (data: { conversationId: string; userId?: string; userName?: string }) => {
      if (!data?.conversationId) return;
      socket.to(`conversation:${data.conversationId}`).emit("chat:typing", {
        conversationId: data.conversationId,
        userId: data.userId || socket.data.userId,
        userName: data.userName,
      });
    });

    socket.on("chat:stop-typing", (data: { conversationId: string; userId?: string; userName?: string }) => {
      if (!data?.conversationId) return;
      socket.to(`conversation:${data.conversationId}`).emit("chat:stop-typing", {
        conversationId: data.conversationId,
        userId: data.userId || socket.data.userId,
        userName: data.userName,
      });
    });

    // Read receipts: the web client emits this when a conversation is opened
    // (previously a silent no-op). Rebroadcast so OTHER participants clear
    // their unread badges for this user in real time.
    socket.on("chat:mark-read", (data: { conversationId: string; userId?: string }) => {
      if (!data?.conversationId) return;
      socket.to(`conversation:${data.conversationId}`).emit("chat:conversation-read", {
        conversationId: data.conversationId,
        userId: data.userId || socket.data.userId,
        readAt: new Date().toISOString(),
      });
    });

    // Call events
    socket.on("call:invite", async (data: { callId: string; targetUserId: string; type: string; callerName?: string }) => {
      logger.info(`Call invite: ${data.callId} to user ${data.targetUserId}`);
      const resolvedCallId = await resolveCallId(data.callId);
      const finalCallId = resolvedCallId || data.callId;
      // Resolve the caller's display name so clients (especially mobile) can
      // render "John is calling" instead of a raw user UUID.
      let callerName: string | null = null;
      let callConversationId: string | null = null;
      try {
        const callerRes = await query(`SELECT name FROM users WHERE id = $1`, [socket.data.userId]);
        callerName = callerRes.rows[0]?.name || null;
      } catch { /* best-effort */ }
      if (resolvedCallId) {
        try {
          const convRes = await query(`SELECT conversation_id FROM calls WHERE id = $1`, [resolvedCallId]);
          callConversationId = convRes.rows[0]?.conversation_id || null;
        } catch { /* best-effort */ }
      }
      socket.to(`user:${data.targetUserId}`).emit("call:incoming", {
        callId: finalCallId,
        callCode: data.callId,
        from: socket.data.userId,
        callerName: callerName || data.callerName || undefined,
        type: data.type,
      });
      // Ring the callee's OTHER devices too (FCM + Web Push). Fire-and-forget:
      // a push failure must never break the live call flow.
      if (data.targetUserId && data.targetUserId !== socket.data.userId) {
        pushIncomingCall([data.targetUserId], {
          callId: finalCallId,
          callType: data.type,
          callerName: callerName || data.callerName || "Someone",
          callerId: socket.data.userId || "",
          callCode: data.callId,
          conversationId: callConversationId,
        });
      }
    });

    socket.on("call:accept", async (data: { callId: string }) => {
      logger.info(`Call accepted: ${data.callId}`);
      const resolvedCallId = await resolveCallId(data.callId);
      if (!resolvedCallId) return;
      // Notify the room AND the call creator: the creator may still be waiting
      // in the ringback screen before entering the room, so `user:` is the only
      // room guaranteed to reach them. `call:` rooms are never joined anywhere.
      let creatorId: string | null = null;
      try {
        const callRes = await query(`SELECT created_by FROM calls WHERE id = $1`, [resolvedCallId]);
        creatorId = callRes.rows[0]?.created_by || null;
      } catch { /* best-effort */ }
      io.to(`room:${resolvedCallId}`).emit("call:accepted", { callId: resolvedCallId, userId: socket.data.userId });
      if (creatorId && creatorId !== socket.data.userId) {
        io.to(`user:${creatorId}`).emit("call:accepted", { callId: resolvedCallId, userId: socket.data.userId });
      }
    });

    socket.on("call:reject", async (data: { callId: string }) => {
      logger.info(`Call rejected: ${data.callId}`);
      const resolvedCallId = await resolveCallId(data.callId);
      if (!resolvedCallId) return;
      let creatorId: string | null = null;
      let preReject: any = null;
      try {
        const callRes = await query(
          `SELECT id, business_id, type, status, duration, call_code, created_by, conversation_id
           FROM calls WHERE id = $1`,
          [resolvedCallId],
        );
        preReject = callRes.rows[0] || null;
        creatorId = preReject?.created_by || null;
      } catch { /* best-effort */ }

      // Decline lifecycle path: the FIRST decline closes the call as MISSED
      // (the conventional status for an unanswered call) so history stops
      // showing it as ongoing, the chat gets its call-log message and the
      // callee side gets a "Missed call" notification. All best-effort.
      if (preReject && !CALL_LOG_FINAL_STATUSES.has(preReject.status)) {
        try {
          await query(
            `UPDATE calls SET status = 'missed', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status NOT IN ('completed','missed','cancelled')`,
            [resolvedCallId],
          );
        } catch (error) {
          logger.error(`Failed to persist missed status for ${resolvedCallId}:`, error);
        }
        try {
          const parts = await query(`SELECT user_id FROM call_participants WHERE call_id = $1`, [resolvedCallId]);
          const participantIds = (parts.rows.map((r: any) => r.user_id) || []).filter(Boolean);
          postCallLogMessage(
            {
              businessId: preReject.business_id,
              senderId: preReject.created_by,
              conversationId: preReject.conversation_id || undefined,
              participantIds,
              callType: preReject.type,
              status: "missed",
              durationSeconds: null,
              callCode: preReject.call_code,
              callId: resolvedCallId,
              endedAt: new Date(),
            },
            io,
          ).catch(() => undefined);

          const calleeIds = participantIds.filter((pid: string) => pid !== preReject.created_by);
          let callerName: string | null = null;
          try {
            const nameRes = await query(`SELECT name FROM users WHERE id = $1`, [preReject.created_by]);
            callerName = nameRes.rows[0]?.name || null;
          } catch { /* best-effort */ }
          pushMissedCall(calleeIds, {
            callId: resolvedCallId,
            callerName: callerName || "Someone",
            callerId: preReject.created_by,
            callCode: preReject.call_code,
            status: "missed",
          });
        } catch (err) {
          logger.warn("call:reject side effects failed (non-fatal):", err);
        }
      }

      io.to(`room:${resolvedCallId}`).emit("call:rejected", { callId: resolvedCallId, userId: socket.data.userId });
      if (creatorId && creatorId !== socket.data.userId) {
        io.to(`user:${creatorId}`).emit("call:rejected", { callId: resolvedCallId, userId: socket.data.userId });
      }
    });

    socket.on("call:end", async (data: { callId: string }) => {
      logger.info(`Call ended: ${data.callId}`);
      const resolvedCallId = await resolveCallId(data.callId);
      if (!resolvedCallId) return;
      // Fetch the pre-end row FIRST — needed to detect the first final-state
      // transition for the WhatsApp-style chat call-log below.
      let preEnd: any = null;
      let preEndParticipantIds: string[] = [];
      try {
        const r = await query(
          `SELECT id, business_id, type, status, duration, call_code, created_by, conversation_id
           FROM calls WHERE id = $1`,
          [resolvedCallId],
        );
        preEnd = r.rows[0] || null;
      } catch (error) {
        logger.error(`Failed to load call row before end for ${resolvedCallId}:`, error);
      }
      try {
        const parts = await query(`SELECT user_id FROM call_participants WHERE call_id = $1`, [resolvedCallId]);
        preEndParticipantIds = (parts.rows.map((row: any) => row.user_id) || []).filter(Boolean);
      } catch { /* best-effort */ }
      // Persist the ended state so history lists stop showing the call as
      // ongoing. Calls that already reached a final state (missed/cancelled)
      // keep that status — the caller ending a declined call must not
      // rewrite it to 'completed'.
      try {
        await query(
          `UPDATE calls SET status = 'completed', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status NOT IN ('completed','missed','cancelled')`,
          [resolvedCallId]
        );
      } catch (error) {
        logger.error(`Failed to persist call end for ${resolvedCallId}:`, error);
      }
      // Call-log message into the linked chat (first transition only) —
      // fire-and-forget: must never block or fail the end flow.
      if (preEnd && !CALL_LOG_FINAL_STATUSES.has(preEnd.status)) {
        const durationSeconds =
          preEnd.duration == null ? null : Math.max(0, Math.round(Number(preEnd.duration) || 0));
        postCallLogMessage(
          {
            businessId: preEnd.business_id,
            senderId: preEnd.created_by || socket.data.userId,
            conversationId: preEnd.conversation_id || undefined,
            participantIds: preEndParticipantIds,
            callType: preEnd.type,
            status: "completed",
            durationSeconds,
            callCode: preEnd.call_code,
            callId: resolvedCallId,
            endedAt: new Date(),
          },
          io,
        ).catch(() => undefined);
      }
      // Broadcast to the LIVE room (`room:{id}`) — `call:{id}` is never joined.
      io.to(`room:${resolvedCallId}`).emit("call:ended", { callId: resolvedCallId, endedBy: socket.data.userId });
      // A callee who is still RINGING (or browsing any other route) has NOT
      // joined room:{id} yet — reach their personal user rooms too, otherwise
      // their phone keeps ringing until the local 45s timeout.
      for (const pid of preEndParticipantIds) {
        if (pid) {
          io.to(`user:${pid}`).emit("call:ended", { callId: resolvedCallId, endedBy: socket.data.userId });
        }
      }
      if (preEnd?.created_by) {
        io.to(`user:${preEnd.created_by}`).emit("call:ended", { callId: resolvedCallId, endedBy: socket.data.userId });
      }
      // SILENT push for the devices still ringing in another room / with the
      // app backgrounded: dismiss the full-screen ring notification + the
      // in-app incoming overlay NOW instead of after the 45s timeout.
      pushCallCancelled([...preEndParticipantIds, preEnd?.created_by].filter(Boolean), {
        callId: resolvedCallId,
        callerId: socket.data.userId,
        reason: "call_ended",
      });
      socket.leave(`room:${resolvedCallId}`);
    });

    // Meeting events (with roomManager integration and duration support)
    socket.on("meeting:join", async (data: { meetingId?: string; roomId?: string; userId: string; userName?: string; isHost?: boolean; audioEnabled?: boolean; videoEnabled?: boolean; waitingRoomSupport?: boolean }, callback?: (response: any) => void) => {
      try {
        // Accept BOTH payload keys: the web CallRoom historically emitted
        // `roomId` (mirroring call:join) while mobile/native clients send
        // `meetingId`. Keying on `data.meetingId` alone made every web meeting
        // join fail with "Meeting not found" and forced users through the
        // error screen's retry path (media-only, no presence).
        const inputId = data.meetingId || data.roomId;
        const resolvedMeetingId = await resolveMeetingId(inputId ?? "");
        if (!resolvedMeetingId) {
          logger.warn(`meeting:join failed - cannot resolve meetingId/code: ${inputId}`);
          if (callback) callback({ success: false, error: "Meeting not found" });
          return;
        }

        const userId = data.userId || socket.data.userId;
        const userName = data.userName || 'User';
        const isHost = data.isHost || false;
        const audioEnabled = data.audioEnabled !== undefined ? data.audioEnabled : true;
        const videoEnabled = data.videoEnabled !== undefined ? data.videoEnabled : true;

        let endsAt: Date | null = null;
        let maxMeetingDuration: number | null = null;
        let waitingRoomEnabled = false;

        const meetingResult = await query(
          `SELECT m.end_time as "endedAt", m.waiting_room_enabled as "waitingRoomEnabled", m.provider, m.max_participants as "maxParticipants", pp.max_meeting_duration as "maxMeetingDuration" 
           FROM meetings m
           LEFT JOIN businesses b ON m.business_id = b.id
           LEFT JOIN pricing_plans pp ON b.plan_id = pp.id
           WHERE m.id = $1`,
          [resolvedMeetingId]
        );

        let roomProvider: string | null = null;
        let roomMaxParticipants: number | null = null;
        if (meetingResult.rows.length > 0) {
          const meetingRow = meetingResult.rows[0];
          endsAt = meetingRow.endedAt ? new Date(meetingRow.endedAt) : null;
          maxMeetingDuration = meetingRow.maxMeetingDuration;
          waitingRoomEnabled = !!meetingRow.waitingRoomEnabled;
          roomProvider = meetingRow.provider || null;
          roomMaxParticipants = meetingRow.maxParticipants || null;
        }

        // Server-side waiting-room enforcement (clients that advertise support)
        const supportsWaitingRoom = (data as any).waitingRoomSupport === true;
        if (supportsWaitingRoom && waitingRoomEnabled && !isHost) {
          const isAdmitted = await wrIsAdmitted(resolvedMeetingId, userId);
          if (!isAdmitted) {
            const existing = await wrGet(resolvedMeetingId, userId);
            if (!existing) {
              await enqueueWaitingParticipant(
                socket,
                resolvedMeetingId,
                socket.id,
                userId,
                userName,
                String(userId || "").startsWith("guest-"),
              );
            } else {
              await wrSet(resolvedMeetingId, userId, { ...existing, socketId: socket.id });
              socket.data.waitingRoom = true;
              socket.data.waitingRoomId = resolvedMeetingId;
            }
            if (callback) callback({ success: true, waitingRoom: true, meetingId: resolvedMeetingId, participantId: userId });
            return;
          }
          await wrConsumeAdmission(resolvedMeetingId, userId);
        }

        roomManager.addParticipant(resolvedMeetingId, {
          id: userId,
          name: userName,
          isHost,
          audioEnabled,
          videoEnabled,
          screenSharing: false,
        }, endsAt, maxMeetingDuration);

        const participantCount = roomManager.getParticipants(resolvedMeetingId).length;

        let durationStarted = false;
        if (participantCount > 1 && !endsAt && maxMeetingDuration) {
          const now = new Date();
          const calculatedEndsAt = new Date(now.getTime() + maxMeetingDuration * 60000);
          endsAt = calculatedEndsAt;
          durationStarted = true;
          roomManager.setRoomEndsAt(resolvedMeetingId, calculatedEndsAt);

          await query(
            `UPDATE meetings SET end_time = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [calculatedEndsAt.toISOString(), resolvedMeetingId]
          );
        }

        socket.join(`room:${resolvedMeetingId}`);
        socket.join(`meeting:${resolvedMeetingId}`);

        // Push the current waiting-room queue to joining hosts so a host who
        // enters after requests were made immediately sees the admit list.
        if (isHost) {
          const entries = await wrList(resolvedMeetingId);
          if (entries.length > 0) {
            socket.emit("waiting-room:queue", { roomId: resolvedMeetingId, queue: queueToArray(entries) });
          }
        }

        // Track the socket against this room and detect same-account
        // multi-device joins (the real echo cause).
        const sameUserCount = trackRoomSocket(resolvedMeetingId, socket.id, userId, userName);

        logger.info(`Socket ${socket.id} joined meeting:${resolvedMeetingId} (input: ${data.meetingId})`);
        socket.to(`room:${resolvedMeetingId}`).emit("meeting:participant-joined", {
          meetingId: resolvedMeetingId,
          meetingCode: data.meetingId,
          userId,
          userName,
          isHost,
        });
        socket.to(`meeting:${resolvedMeetingId}`).emit("meeting:participant-joined", {
          meetingId: resolvedMeetingId,
          meetingCode: data.meetingId,
          userId,
          userName,
          isHost,
        });
        // camelCase alias for older clients (e.g. Flutter socket_service)
        socket.to(`room:${resolvedMeetingId}`).emit("meeting:participantJoined", {
          meetingId: resolvedMeetingId,
          userId,
        });
        socket.to(`meeting:${resolvedMeetingId}`).emit("meeting:participantJoined", {
          meetingId: resolvedMeetingId,
          userId,
        });

        const roomState = roomManager.getRoomState(resolvedMeetingId);
        const participantsListPayload = {
          meetingId: resolvedMeetingId,
          meetingCode: data.meetingId,
          participants: roomManager.getParticipants(resolvedMeetingId),
          endsAt: roomState?.endsAt?.toISOString() || null,
          maxMeetingDuration: roomState?.maxMeetingDuration,
        };
        socket.emit("meeting:participants-list", participantsListPayload);
        // Provider-specific media credentials (LiveKit token minted here).
        let calling: CallingCredentials | undefined;
        try {
          const provider = await resolveProviderForRoom("meeting", resolvedMeetingId, roomProvider);
          calling = await buildCallingCredentials(provider, {
            roomType: "meeting",
            roomId: resolvedMeetingId,
            title: "",
            identity: userId,
            displayName: userName,
            isHost,
            remainingSeconds: computeRemainingSeconds(endsAt),
            maxParticipants: roomMaxParticipants,
          });
        } catch (err) {
          logger.warn("Failed to build meeting calling credentials:", err);
        }

        if (callback) callback({ success: true, meetingId: resolvedMeetingId, meetingCode: data.meetingId, calling });

        if (durationStarted) {
          io.to(`room:${resolvedMeetingId}`).emit("meeting:duration-started", {
            meetingId: resolvedMeetingId,
            endsAt: endsAt!.toISOString(),
            maxMeetingDuration,
            startedAt: new Date().toISOString(),
          });
          io.to(`meeting:${resolvedMeetingId}`).emit("meeting:duration-started", {
            meetingId: resolvedMeetingId,
            endsAt: endsAt!.toISOString(),
            maxMeetingDuration,
            startedAt: new Date().toISOString(),
          });
        } else if (participantCount > 1 && endsAt) {
          socket.emit("meeting:duration-active", {
            meetingId: resolvedMeetingId,
            endsAt: endsAt.toISOString(),
            maxMeetingDuration,
            remainingMs: Math.max(0, endsAt.getTime() - Date.now()),
          });
        } else if (participantCount <= 1) {
          socket.emit("meeting:waiting-for-participants", {
            meetingId: resolvedMeetingId,
            message: "Waiting for more participants to join. Duration countdown will start when at least 2 participants are present.",
            maxMeetingDuration,
          });
        }

        // Server-verified echo-risk alert (same account on multiple devices)
        maybeEmitMultiDeviceAlert(resolvedMeetingId, userId, userName, sameUserCount, false);
      } catch (error) {
        logger.error("Error joining meeting:", error);
        if (callback) callback({ success: false, error: "Failed to join meeting" });
      }
    });

    socket.on("meeting:leave", async (data: { meetingId?: string; roomId?: string; userId: string; userName?: string }) => {
      try {
        // Key-agnostic resolve (see meeting:join) — the web emits `roomId`.
        const resolvedMeetingId = await resolveMeetingId(data.meetingId || data.roomId || "");
        if (!resolvedMeetingId) return;

        const userId = data.userId || socket.data.userId;
        const userName = data.userName || 'User';

        roomManager.removeParticipant(resolvedMeetingId, userId);
        untrackRoomSocket(resolvedMeetingId, socket.id);

        socket.to(`room:${resolvedMeetingId}`).emit("meeting:participant-left", {
          meetingId: resolvedMeetingId,
          userId,
          userName,
        });
        socket.to(`meeting:${resolvedMeetingId}`).emit("meeting:participant-left", {
          meetingId: resolvedMeetingId,
          userId,
          userName,
        });
        // camelCase alias for older clients (e.g. Flutter socket_service)
        socket.to(`room:${resolvedMeetingId}`).emit("meeting:participantLeft", {
          meetingId: resolvedMeetingId,
          userId,
        });
        socket.to(`meeting:${resolvedMeetingId}`).emit("meeting:participantLeft", {
          meetingId: resolvedMeetingId,
          userId,
        });
        socket.leave(`room:${resolvedMeetingId}`);
        socket.leave(`meeting:${resolvedMeetingId}`);
      } catch (error) {
        logger.error("Error leaving meeting:", error);
      }
    });

    socket.on("meeting:end", async (data: { meetingId?: string; roomId?: string }) => {
      try {
        // Key-agnostic resolve (see meeting:join).
        const resolvedMeetingId = await resolveMeetingId(data.meetingId || data.roomId || "");
        if (!resolvedMeetingId) return;

        // Guard removed: meetings can now be ended from any non-completed
        // state. Nothing historically set status='ongoing' (joinMeeting does
        // now), so the old guard silently swallowed every host "end meeting".
        await query(
          `UPDATE meetings SET status = 'completed', end_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status <> 'completed'`,
          [resolvedMeetingId]
        );
        socket.to(`room:${resolvedMeetingId}`).emit("meeting:ended", { meetingId: resolvedMeetingId });
        socket.to(`meeting:${resolvedMeetingId}`).emit("meeting:ended", { meetingId: resolvedMeetingId });
      } catch (error) {
        logger.error("Error ending meeting:", error);
      }
    });

    // Mediasoup / WebRTC signaling
    socket.on("mediasoup:getRouterRtpCapabilities", async ({ roomId }: { roomId?: string }, callback) => {
      try {
        if (!isMediasoupReady()) {
          // Workers are still booting — tell the client to retry shortly
          // instead of stranding it on the join screen.
          callback({ error: "Media service is starting, please retry", retryable: true });
          return;
        }
        let router;
        if (roomId) {
          const resolved = await resolveRoomId(roomId);
          const resolvedRoomId = resolved ? resolved.id : roomId;
          const room = await getOrCreateRoomAsync(resolvedRoomId);
          router = room.router;
        }
        if (!router) {
          callback({ error: "Router not initialized", retryable: true });
          return;
        }
        callback({ rtpCapabilities: router.rtpCapabilities });
      } catch (error) {
        logger.error("Error getting router rtp capabilities:", error);
        callback({ error: String(error) });
      }
    });

    socket.on("mediasoup:createWebRtcTransport", async ({ roomId }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const { transport } = await createWebRtcTransportForRoom(resolvedRoomId);
        associateTransport(resolvedRoomId, transport.id, socket.id);

        transport.on("dtlsstatechange", (state) => {
          if (state === "closed" || state === "failed") {
            logger.warn(`Transport ${transport.id} DTLS ${state}, cleaning up`);
            transport.close();
          }
        });

        callback({
          id: transport.id,
          roomId: resolvedRoomId,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (error) {
        logger.error("Error creating transport:", error);
        callback({ error: String(error) });
      }
    });

    socket.on("mediasoup:connectWebRtcTransport", async ({ transportId, dtlsParameters, roomId }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const room = getRoom(resolvedRoomId);
        const transport = room?.transports.get(transportId);
        if (!transport) throw new Error("Transport not found");
        await transport.connect({ dtlsParameters });
        callback();
      } catch (error) {
        logger.error("Error connecting transport:", error);
        callback({ error: String(error) });
      }
    });

    socket.on("mediasoup:produce", async (
      {
        transportId,
        kind,
        rtpParameters,
        roomId,
        appData,
        userId,
        userName,
      }: {
        transportId: string;
        kind: "audio" | "video" | string;
        rtpParameters: any;
        roomId: string;
        appData?: ProducerAppData;
        userId?: string;
        userName?: string;
      },
      callback,
    ) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const room = getRoom(resolvedRoomId);
        const transport = room?.transports.get(transportId);
        if (!transport) throw new Error("Transport not found");

        const effectiveUserId = userId || socket.data.userId || `guest-${socket.id.slice(0, 8)}`;
        const effectiveUserName = userName || socket.data.userName || "Guest";

        const producer = await transport.produce({
          kind: kind as "audio" | "video",
          rtpParameters,
          appData: {
            socketId: socket.id,
            userId: effectiveUserId,
            userName: effectiveUserName,
            ...(appData || {}),
          },
        });
        room!.producers.set(producer.id, producer);

        producer.on("transportclose", () => {
          room!.producers.delete(producer.id);
          maybeCloseRoom(resolvedRoomId);
        });
        producer.on("score", () => {
          /* could forward scores for quality UI later */
        });

        const newProducerPayload = {
          producerId: producer.id,
          kind,
          roomId: resolvedRoomId,
          peerId: effectiveUserId,
          peerName: effectiveUserName,
          appData: producer.appData,
        };
        // Notify everyone except the producer's own socket
        socket.to(`room:${resolvedRoomId}`).emit("mediasoup:newProducer", newProducerPayload);

        callback({ id: producer.id, roomId: resolvedRoomId, appData: producer.appData });
      } catch (error) {
        logger.error("Error producing:", error);
        callback({ error: String(error) });
      }
    });

    // CRITICAL: existing producers discovery for late joiners.
    // Without this, participants who join after others can never see/hear them.
    socket.on("mediasoup:getProducers", async ({ roomId }: { roomId: string }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const producers = getRoomProducers(resolvedRoomId, socket.id);
        callback({ producers });
      } catch (error) {
        logger.error("Error getting room producers:", error);
        callback({ error: String(error) });
      }
    });

    // Close a producer explicitly (e.g. screen-share stopped, track ended)
    socket.on("mediasoup:closeProducer", async ({ roomId, producerId }: { roomId: string; producerId: string }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const room = getRoom(resolvedRoomId);
        const producer = room?.producers.get(producerId);
        if (producer && (producer.appData as ProducerAppData)?.socketId === socket.id) {
          producer.close(); // fires transportclose? no - fires 'producerclose'; clean map explicitly
          room!.producers.delete(producerId);
          socket.to(`room:${resolvedRoomId}`).emit("mediasoup:producerClosed", {
            producerId,
            roomId: resolvedRoomId,
            peerId: (producer.appData as ProducerAppData)?.userId,
            appData: producer.appData,
          });
          maybeCloseRoom(resolvedRoomId);
          if (callback) callback({ success: true });
        } else if (callback) {
          callback({ success: false, error: "Producer not found or not owned by you" });
        }
      } catch (error) {
        logger.error("Error closing producer:", error);
        if (callback) callback({ success: false, error: String(error) });
      }
    });

    socket.on("mediasoup:consume", async ({ transportId, producerId, rtpCapabilities, roomId }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const room = getRoom(resolvedRoomId);
        const router = room?.router;
        const transport = room?.transports.get(transportId);
        if (!router || !transport) throw new Error("Transport not found");

        if (!router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error("Cannot consume");
        }

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true, // client resumes after attaching the track (recommended flow)
        });
        room!.consumers.set(consumer.id, consumer);

        // Surface the producing peer's identity so clients can label/remove
        // the matching remote tile (consume response otherwise has no peerId).
        const producerAppData = (room!.producers.get(producerId)?.appData ?? {}) as ProducerAppData;

        consumer.on("transportclose", () => {
          room!.consumers.delete(consumer.id);
          maybeCloseRoom(resolvedRoomId);
        });
        consumer.on("producerclose", () => {
          room!.consumers.delete(consumer.id);
          socket.emit("mediasoup:producerClosed", {
            producerId,
            consumerId: consumer.id,
            roomId: resolvedRoomId,
          });
          maybeCloseRoom(resolvedRoomId);
        });

        callback({
          id: consumer.id,
          producerId: producerId,
          kind: consumer.kind,
          roomId: resolvedRoomId,
          peerId: producerAppData.userId,
          peerName: producerAppData.userName,
          rtpParameters: consumer.rtpParameters,
          appData: consumer.appData,
        });
      } catch (error) {
        logger.error("Error consuming:", error);
        callback({ error: String(error) });
      }
    });

    socket.on("mediasoup:resume", async ({ consumerId, roomId }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const room = getRoom(resolvedRoomId);
        const consumer = room?.consumers.get(consumerId);
        if (!consumer) throw new Error("Consumer not found");
        await consumer.resume();
        if (callback) callback();
      } catch (error) {
        logger.error("Error resuming consumer:", error);
        if (callback) callback({ error: String(error) });
      }
    });

    socket.on("mediasoup:pauseProducer", async ({ roomId, producerId }: { roomId: string; producerId: string }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const room = getRoom(resolvedRoomId);
        const producer = room?.producers.get(producerId);
        if (producer && (producer.appData as ProducerAppData)?.socketId === socket.id) {
          await producer.pause();
          socket.to(`room:${resolvedRoomId}`).emit("mediasoup:producerPaused", { producerId, roomId: resolvedRoomId });
          if (callback) callback({ success: true });
        } else if (callback) callback({ success: false, error: "Producer not found" });
      } catch (error) {
        if (callback) callback({ error: String(error) });
      }
    });

    socket.on("mediasoup:resumeProducer", async ({ roomId, producerId }: { roomId: string; producerId: string }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const room = getRoom(resolvedRoomId);
        const producer = room?.producers.get(producerId);
        if (producer && (producer.appData as ProducerAppData)?.socketId === socket.id) {
          await producer.resume();
          socket.to(`room:${resolvedRoomId}`).emit("mediasoup:producerResumed", { producerId, roomId: resolvedRoomId });
          if (callback) callback({ success: true });
        } else if (callback) callback({ success: false, error: "Producer not found" });
      } catch (error) {
        if (callback) callback({ error: String(error) });
      }
    });

    // Recording events
    socket.on("recording:start", async (data: { meetingId?: string; callId?: string }) => {
      logger.info(`Recording started for: ${data.meetingId || data.callId}`);
      if (data.meetingId) {
        const resolved = await resolveMeetingId(data.meetingId);
        if (resolved) {
          socket.to(`meeting:${resolved}`).emit("recording:started", { ...data, meetingId: resolved });
          socket.to(`room:${resolved}`).emit("recording:started", { ...data, meetingId: resolved });
        }
      } else if (data.callId) {
        const resolved = await resolveCallId(data.callId);
        if (resolved) {
          socket.to(`call:${resolved}`).emit("recording:started", { ...data, callId: resolved });
          socket.to(`room:${resolved}`).emit("recording:started", { ...data, callId: resolved });
        }
      }
    });

    socket.on("recording:stop", async (data: { meetingId?: string; callId?: string }) => {
      logger.info(`Recording stopped for: ${data.meetingId || data.callId}`);
      if (data.meetingId) {
        const resolved = await resolveMeetingId(data.meetingId);
        if (resolved) {
          socket.to(`meeting:${resolved}`).emit("recording:stopped", { ...data, meetingId: resolved });
          socket.to(`room:${resolved}`).emit("recording:stopped", { ...data, meetingId: resolved });
        }
      } else if (data.callId) {
        const resolved = await resolveCallId(data.callId);
        if (resolved) {
          socket.to(`call:${resolved}`).emit("recording:stopped", { ...data, callId: resolved });
          socket.to(`room:${resolved}`).emit("recording:stopped", { ...data, callId: resolved });
        }
      }
    });

    // Screen share
    socket.on("screen-share:start", async (data: { meetingId?: string; callId?: string }) => {
      if (data.meetingId) {
        const resolved = await resolveMeetingId(data.meetingId);
        if (resolved) {
          socket.to(`meeting:${resolved}`).emit("screen-share:started", { userId: socket.data.userId, meetingId: resolved });
          socket.to(`room:${resolved}`).emit("screen-share:started", { userId: socket.data.userId, meetingId: resolved });
        }
      } else if (data.callId) {
        const resolved = await resolveCallId(data.callId);
        if (resolved) {
          socket.to(`call:${resolved}`).emit("screen-share:started", { userId: socket.data.userId, callId: resolved });
          socket.to(`room:${resolved}`).emit("screen-share:started", { userId: socket.data.userId, callId: resolved });
        }
      }
    });

    socket.on("screen-share:stop", async (data: { meetingId?: string; callId?: string }) => {
      if (data.meetingId) {
        const resolved = await resolveMeetingId(data.meetingId);
        if (resolved) {
          socket.to(`meeting:${resolved}`).emit("screen-share:stopped", { userId: socket.data.userId, meetingId: resolved });
          socket.to(`room:${resolved}`).emit("screen-share:stopped", { userId: socket.data.userId, meetingId: resolved });
        }
      } else if (data.callId) {
        const resolved = await resolveCallId(data.callId);
        if (resolved) {
          socket.to(`call:${resolved}`).emit("screen-share:stopped", { userId: socket.data.userId, callId: resolved });
          socket.to(`room:${resolved}`).emit("screen-share:stopped", { userId: socket.data.userId, callId: resolved });
        }
      }
    });

    // In-meeting chat (primary event) - shared implementation
    const handleMeetingChat = async (data: { meetingId?: string; callId?: string; roomId?: string; message: string; senderName?: string; userId?: string }) => {
      try {
        // Resolve the room from whichever identifier the client sent
        let resolvedId: string | null = null;
        let resolvedType: "meeting" | "call" = "meeting";
        if (data.meetingId) {
          resolvedId = await resolveMeetingId(data.meetingId);
          resolvedType = "meeting";
        } else if (data.callId) {
          resolvedId = await resolveCallId(data.callId);
          resolvedType = "call";
        } else if (data.roomId) {
          const resolved = await resolveRoomId(data.roomId);
          if (resolved) {
            resolvedId = resolved.id;
            resolvedType = resolved.type;
          }
        }
        if (!resolvedId) return;

        // Identity: authenticated user first, then client-provided, then guest
        const senderId = socket.data.authUser?.userId || data.userId || socket.data.guest?.guestId || socket.id;
        const senderName = data.senderName || socket.data.guest?.name || "User";

        const payload = {
          userId: senderId,
          senderName,
          isGuest: Boolean(socket.data.guest),
          meetingId: resolvedType === "meeting" ? resolvedId : undefined,
          callId: resolvedType === "call" ? resolvedId : undefined,
          roomId: resolvedId,
          message: data.message,
          timestamp: new Date(),
        };
        // Broadcast to everyone in the room (including sender for consistency)
        io.to(`room:${resolvedId}`).emit("meeting-chat:message", payload);
      } catch (error) {
        logger.error("Error handling meeting chat:", error);
      }
    };

    socket.on("meeting-chat:message", handleMeetingChat);
    // Alias event used by some clients
    socket.on("meeting-chat:send", handleMeetingChat);

    // ---------------------------------------------------------------------
    // Live captions (provider-agnostic). Clients run their own speech-to-text
    // (e.g. browser SpeechRecognition) and stream segments here; the backend
    // relays them to everyone in the room and persists final segments for
    // meetings so transcripts + AI notes can be generated later. Works the
    // same whether the media provider is LiveKit or MediaSoup.
    // ---------------------------------------------------------------------
    socket.on(
      "caption:segment",
      async (
        data: {
          roomId: string;
          roomType?: "call" | "meeting";
          text: string;
          isFinal?: boolean;
          language?: string;
        },
        callback?: (response: any) => void,
      ) => {
        try {
          const text = String(data?.text || "").slice(0, 2000);
          if (!data?.roomId || !text.trim()) {
            if (callback) callback({ success: false, error: "roomId and text are required" });
            return;
          }
          const resolved = await resolveRoomId(data.roomId);
          if (!resolved) {
            if (callback) callback({ success: false, error: "Room not found" });
            return;
          }
          const roomId = resolved.id;
          const roomType: "call" | "meeting" = data.roomType || resolved.type;
          const speakerId: string =
            socket.data.userId ||
            (socket.data.guest as any)?.guestId ||
            socket.id;
          // Resolve a human speaker name: room roster → guest profile → cached
          // users-table lookup (UUID speaker ids used to leak into transcripts).
          const rosterName = roomManager.getParticipants(roomId).find((p) => p.id === speakerId)?.name;
          const guestName = (socket.data.guest as any)?.name;
          let speakerName =
            (rosterName && !looksLikeUuid(rosterName) && rosterName) ||
            (guestName && !looksLikeUuid(guestName) && guestName) ||
            "";
          if (!speakerName) {
            try {
              speakerName = (await resolveSingleSpeakerName(speakerId)) || "";
            } catch { /* keep fallback below */ }
          }
          if (!speakerName) {
            const fallback = socket.data.userId || (socket.data.guest as any)?.name || "Speaker";
            speakerName = looksLikeUuid(fallback) ? "Participant" : String(fallback);
          }

          const payload = {
            roomId,
            roomType,
            speakerId,
            speakerName,
            // FINAL segments are cleaned before relay/persistence (instant
            // regex pass) so no client ever renders raw ASR garbage. Interim
            // segments stay raw — they are replaced by the final in <1s.
            text: data.isFinal !== false ? lightClean(text) : text,
            isFinal: data.isFinal !== false,
            language: data.language || null,
            ts: new Date().toISOString(),
          };

          // Relay to everyone in the room (including back to sender for UI echo).
          io.to(`room:${roomId}`).emit("caption:updated", payload);
          if (roomType === "meeting") {
            io.to(`meeting:${roomId}`).emit("caption:updated", payload);
          }

          // Persist final segments for meetings AND calls → transcript +
          // AI notes / call-detail views (meeting_transcripts is keyed by the
          // room id for both room types; GET /calls/:id/transcript reads it).
          if (payload.isFinal) {
            let segmentId: string | null = null;
            try {
              const inserted = await query(
                `INSERT INTO meeting_transcripts (id, meeting_id, speaker_id, speaker_name, text, language, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                 RETURNING id`,
                [crypto.randomUUID(), roomId, String(speakerId), String(speakerName).slice(0, 120), payload.text, payload.language],
              );
              segmentId = inserted.rows[0]?.id || null;
            } catch (err) {
              logger.warn("Failed to persist caption segment:", err);
            }
            // AI polish (async, never blocks the relay): fix mis-hearings and
            // update the persisted row + notify open clients.
            void (async () => {
              try {
                const polished = await aiCleanCaption(text, payload.language);
                if (polished && polished !== payload.text) {
                  if (segmentId) {
                    await query(`UPDATE meeting_transcripts SET text = $1 WHERE id = $2`, [polished, segmentId]).catch(() => {});
                  }
                  io.to(`room:${roomId}`).emit("caption:polished", {
                    roomId, roomType, speakerId, speakerName, segmentId,
                    text: polished, originalText: payload.text, ts: payload.ts,
                  });
                  if (roomType === "meeting") {
                    io.to(`meeting:${roomId}`).emit("caption:polished", {
                      roomId, roomType, speakerId, speakerName, segmentId,
                      text: polished, originalText: payload.text, ts: payload.ts,
                    });
                  }
                }
              } catch { /* polish is best-effort */ }
            })();
            // MetricAi Call Copilot: per-user translated captions + live AI
            // insights. Both are enhancements — they must NEVER break the
            // caption relay, so every failure is swallowed.
            try {
              void deliverTranslatedCaption(io, roomId, payload);
            } catch (err) {
              logger.warn("Translated caption dispatch failed:", err);
            }
            try {
              scheduleLiveInsights(io, roomId);
            } catch (err) {
              logger.warn("Live insights scheduling failed:", err);
            }
          }
          if (callback) callback({ success: true });
        } catch (error) {
          logger.error("Error handling caption segment:", error);
          if (callback) callback({ success: false, error: "Failed to relay caption" });
        }
      },
    );

    // MetricAi Call Copilot — the language THIS participant wants live captions
    // translated into ("" disables translation). Final caption segments are
    // translated via GLM and unicast as `caption:translated`.
    socket.on(
      "caption:set-language",
      (data: { language?: string }, callback?: (response: any) => void) => {
        const lang = String(data?.language || "").trim().slice(0, 8).toLowerCase();
        if (lang) captionLanguageBySocket.set(socket.id, lang);
        else captionLanguageBySocket.delete(socket.id);
        if (callback) callback({ success: true, language: lang || null });
      },
    );

    // ---------------------------------------------------------------------
    // CALL-ROOM REACTIONS + RAISE HAND (web & mobile)
    // Lightweight room broadcast enhancements carried on the existing socket
    // transport. Room resolution matches caption:segment so both id shapes
    // (call uuid, call code, room id) work.
    // ---------------------------------------------------------------------
    socket.on(
      "call:reaction",
      async (
        data: { roomCode?: string; roomId?: string; callId?: string; emoji?: string; roomType?: "call" | "meeting" },
        callback?: (response: any) => void,
      ) => {
        try {
          const key = data?.roomCode || data?.roomId || data?.callId || "";
          const emoji = String(data?.emoji || "").slice(0, 8);
          if (!key || !emoji) {
            if (callback) callback({ success: false, error: "room and emoji are required" });
            return;
          }
          const resolved = await resolveRoomId(key);
          if (!resolved) {
            if (callback) callback({ success: false, error: "Room not found" });
            return;
          }
          const rosterName = roomManager.getParticipants(resolved.id).find((p) => p.id === socket.data.userId)?.name;
          const fromName = (rosterName && !looksLikeUuid(rosterName) && rosterName)
            || (socket.data.guest as any)?.name
            || "Someone";
          const event = {
            emoji,
            from: String(socket.data.userId || (socket.data.guest as any)?.guestId || socket.id),
            fromName,
            roomId: resolved.id,
            roomType: data.roomType || resolved.type,
            ts: new Date().toISOString(),
          };
          io.to(`room:${resolved.id}`).emit("call:reaction-received", event);
          if (event.roomType === "meeting") {
            io.to(`meeting:${resolved.id}`).emit("call:reaction-received", event);
          }
          if (callback) callback({ success: true });
        } catch (error) {
          logger.error("Error handling call reaction:", error);
          if (callback) callback({ success: false, error: "Failed to send reaction" });
        }
      },
    );

    socket.on(
      "call:raise-hand",
      async (
        data: { roomCode?: string; roomId?: string; callId?: string; raised?: boolean; roomType?: "call" | "meeting" },
        callback?: (response: any) => void,
      ) => {
        try {
          const key = data?.roomCode || data?.roomId || data?.callId || "";
          if (!key) {
            if (callback) callback({ success: false, error: "room is required" });
            return;
          }
          const resolved = await resolveRoomId(key);
          if (!resolved) {
            if (callback) callback({ success: false, error: "Room not found" });
            return;
          }
          const rosterName = roomManager.getParticipants(resolved.id).find((p) => p.id === socket.data.userId)?.name;
          const name = (rosterName && !looksLikeUuid(rosterName) && rosterName)
            || (socket.data.guest as any)?.name
            || "Someone";
          const event = {
            userId: String(socket.data.userId || (socket.data.guest as any)?.guestId || socket.id),
            name,
            raised: data?.raised !== false,
            roomId: resolved.id,
            roomType: data.roomType || resolved.type,
            ts: new Date().toISOString(),
          };
          io.to(`room:${resolved.id}`).emit("call:hand-updated", event);
          if (event.roomType === "meeting") {
            io.to(`meeting:${resolved.id}`).emit("call:hand-updated", event);
          }
          if (callback) callback({ success: true });
        } catch (error) {
          logger.error("Error handling raise hand:", error);
          if (callback) callback({ success: false, error: "Failed to update hand state" });
        }
      },
    );

    // ---------------------------------------------------------------------
    // CHAT TYPING INDICATORS — WhatsApp-style "typing…" presence. Ephemeral:
    // relayed to the conversation room and to each other participant's user
    // room (mobile listens on the user room), never persisted.
    // ---------------------------------------------------------------------
    socket.on(
      "chat:typing",
      async (data: { conversationId?: string; isTyping?: boolean }, callback?: (response: any) => void) => {
        try {
          const conversationId = String(data?.conversationId || "");
          if (!conversationId || !socket.data.userId) {
            if (callback) callback({ success: false, error: "conversationId required" });
            return;
          }
          const participants = await query(
            `SELECT user_id FROM chat_participants WHERE conversation_id = $1`,
            [conversationId],
          );
          const event = {
            conversationId,
            userId: String(socket.data.userId),
            name: String((socket.data as any).name || socket.data.email || "Someone"),
            isTyping: data?.isTyping !== false,
            ts: new Date().toISOString(),
          };
          for (const row of participants.rows) {
            const uid = String((row as any).user_id || "");
            if (!uid || uid === event.userId) continue;
            io.to(`user:${uid}`).emit("chat:typing-updated", event);
          }
          if (callback) callback({ success: true });
        } catch (error) {
          logger.error("Error handling chat typing:", error);
          if (callback) callback({ success: false, error: "Failed to relay typing state" });
        }
      },
    );

    // Disconnect
    socket.on("disconnect", async () => {
      captionLanguageBySocket.delete(socket.id);
      const { userId, businessId, waitingRoom: wasWaiting, waitingRoomId } = socket.data;

      // Remove this socket from all room-tracking maps so multi-device
      // detection stays accurate after refreshes/crashes.
      untrackSocketFromAllRooms(socket.id);

      // Remove from waiting-room queue if applicable (only this socket's own
      // entry — a reconnecting participant re-registered under a new socket id
      // and must NOT be dropped when the OLD socket eventually disconnects).
      if (wasWaiting && waitingRoomId) {
        // The entry is keyed by participantId; find the entry bound to THIS
        // socket (works for both redis-backed and memory-backed queues).
        const entries = await wrList(waitingRoomId);
        const own = entries.find((e) => e.socketId === socket.id);
        if (own) {
          await wrDelete(waitingRoomId, own.participantId);
          const remaining = await wrList(waitingRoomId);
          io.to(`room:${waitingRoomId}`).emit("waiting-room:queue", {
            roomId: waitingRoomId,
            queue: queueToArray(remaining),
          });
        }
      }

      // Close all mediasoup transports/producers owned by this socket and
      // notify rooms so peers can drop the corresponding consumers/streams.
      try {
        const { affectedRooms } = closePeer(socket.id);
        for (const roomId of affectedRooms) {
          socket.to(`room:${roomId}`).emit("mediasoup:peerLeft", { roomId, socketId: socket.id });
          maybeCloseRoom(roomId);
        }
      } catch (err) {
        logger.error("Error cleaning up mediasoup peer on disconnect:", err);
      }

      if (userId && businessId) {
        if (isRedisReady()) {
          await redisClient.del(`online:${businessId}:${userId}`);
        }

        socket.to(`business:${businessId}`).emit("user-presence-updated", {
          userId,
          status: "offline",
        });

        // Persist offline presence + last_seen_at and tell the conversation
        // rooms (WhatsApp-style "last seen" chips). Fire-and-forget.
        broadcastPresence(userId, "offline").catch(() => undefined);

        logger.info(`User ${userId} marked as offline in business ${businessId}`);
      }
      logger.info(`Socket disconnected: ${socket.id}`);
    });
  });

  logger.info("Socket.io server initialized");
}

export function getSocketServer(): Server | null {
  return io;
}

// =============================================================================
// MetricAi Call Copilot — never-existed-before live call intelligence.
//
// 1. TRANSLATED CAPTIONS: each participant picks a caption language
//    (`caption:set-language`); every FINAL caption segment is translated via
//    GLM and unicast only to the sockets that asked for that language
//    (`caption:translated`). Two people in one call can each read captions in
//    their own language — a WhatsApp-level differentiator for calls.
//
// 2. LIVE AI INSIGHTS: while the call is running, the accumulating transcript
//    is summarized every ~45s (min 3 new finals) and broadcast as
//    `call:ai-insights` { summary, keyPoints[], actionItems[] } so late
//    joiners and busy participants see a living digest DURING the call — not
//    only in the post-call notes.
//
// All of it is fail-soft: when GLM is unconfigured or a call errors, the room
// simply gets no translations/insights and the plain caption relay continues.
// =============================================================================

/** socket.id -> requested caption language (lowercase ISO-ish code, or unset). */
const captionLanguageBySocket = new Map<string, string>();

/** (text|targetLang) -> translation cache, so repeated segments/echoes cost one call. */
const captionTranslationCache = new Map<string, string>();

/** roomId -> live insights scheduler state. */
const liveInsightsRooms = new Map<string, { lastRunAt: number; pendingFinals: number; running: boolean }>();

const LIVE_INSIGHTS_INTERVAL_MS = 45_000;
const LIVE_INSIGHTS_MIN_FINALS = 3;

function stashTranslation(key: string, value: string): void {
  if (captionTranslationCache.size > 200) captionTranslationCache.clear();
  captionTranslationCache.set(key, value);
}

/** Translate one final caption for the sockets in the room that opted in. */
async function deliverTranslatedCaption(
  io: Server,
  roomId: string,
  payload: { speakerName: string; text: string; language?: string | null; roomId: string; roomType: string; ts: string },
): Promise<void> {
  const room = io.of("/").adapter.rooms?.get(`room:${roomId}`);
  if (!room || captionLanguageBySocket.size === 0) return;

  // Collect the distinct target languages actually wanted in this room.
  const wanted = new Map<string, string[]>(); // lang -> socketIds
  for (const socketId of room) {
    const lang = captionLanguageBySocket.get(socketId);
    if (!lang) continue;
    const source = (payload.language || "").toLowerCase();
    if (lang === source) continue; // already reading the source language
    const list = wanted.get(lang) || [];
    list.push(socketId);
    wanted.set(lang, list);
  }
  if (wanted.size === 0) return;

  for (const [lang, socketIds] of wanted) {
    const cacheKey = `${lang}|${payload.text}`;
    let translation = captionTranslationCache.get(cacheKey) || "";
    if (!translation) {
      const raw = await glmChat({
        messages: [
          {
            role: "system",
            content:
              "You are a real-time translation engine inside a live call. Translate the " +
              "user's spoken sentence faithfully and idiomatically. Preserve names, numbers " +
              "and tone. Reply with ONLY the translation — no quotes, no labels, no notes.",
          },
          { role: "user", content: payload.text },
        ],
        temperature: 0.1,
        maxTokens: 600,
      });
      translation = String(raw || "").trim().replace(/^["']|["']$/g, "");
      if (!translation) continue;
      stashTranslation(cacheKey, translation);
    }
    const translatedPayload = {
      roomId,
      roomType: payload.roomType,
      speakerName: payload.speakerName,
      text: payload.text,
      translation,
      targetLanguage: lang,
      sourceLanguage: payload.language || null,
      ts: payload.ts,
    };
    for (const socketId of socketIds) {
      io.of("/").sockets.get(socketId)?.emit("caption:translated", translatedPayload);
    }
  }
}

/** Throttled live-insights scheduler: ≥45s apart and ≥3 new finals. */
function scheduleLiveInsights(io: Server, roomId: string): void {
  const state = liveInsightsRooms.get(roomId) || { lastRunAt: 0, pendingFinals: 0, running: false };
  state.pendingFinals += 1;
  const since = Date.now() - state.lastRunAt;
  liveInsightsRooms.set(roomId, state);
  if (state.running) return;
  if (since < LIVE_INSIGHTS_INTERVAL_MS || state.pendingFinals < LIVE_INSIGHTS_MIN_FINALS) {
    // Retry shortly after the interval elapses even if speech pauses.
    if (since < LIVE_INSIGHTS_INTERVAL_MS) {
      const wait = LIVE_INSIGHTS_INTERVAL_MS - since + 500;
      state.running = true;
      setTimeout(() => {
        state.running = false;
        const cur = liveInsightsRooms.get(roomId);
        if (cur && cur.pendingFinals >= 1) {
          cur.lastRunAt = Date.now();
          cur.pendingFinals = 0;
          void runLiveInsights(io, roomId);
        }
      }, wait).unref?.();
    }
    return;
  }
  state.lastRunAt = Date.now();
  state.pendingFinals = 0;
  void runLiveInsights(io, roomId);
}

/** Summarize the transcript-so-far and broadcast `call:ai-insights`. */
async function runLiveInsights(io: Server, roomId: string): Promise<void> {
  try {
    if (!isGlmConfigured()) return;
    const rows = await query(
      `SELECT speaker_name, text, created_at
       FROM meeting_transcripts
       WHERE meeting_id = $1
       ORDER BY created_at DESC
       LIMIT 80`,
      [roomId],
    );
    if (!rows.rows || rows.rows.length < 4) return; // not enough signal yet
    const transcript = rows.rows
      .reverse()
      .map((r: any) => `${r.speaker_name}: ${r.text}`.slice(0, 400))
      .join("\n")
      .slice(-44000);

    const raw = await glmChat({
      messages: [
        {
          role: "system",
          content:
            "You are the live meeting-intelligence copilot for an ongoing call. Using the " +
            "transcript so far, reply with STRICT JSON only (no markdown fences):\n" +
            '{"summary": "2-3 sentence running summary", "keyPoints": ["up to 5 short bullets"], "actionItems": ["Owner: task"]}.\n' +
            "Rules: use the transcript's language; be concrete with names/numbers; keyPoints " +
            "max 5 items, each <= 16 words; actionItems max 4, use [] when none. This is a " +
            "LIVE feed — reflect the current state, not a final report.",
        },
        { role: "user", content: transcript },
      ],
      temperature: 0.2,
      maxTokens: 650,
    });

    let summary = String(raw || "").trim();
    let keyPoints: string[] = [];
    let actionItems: string[] = [];
    try {
      const jsonStart = summary.indexOf("{");
      const jsonEnd = summary.lastIndexOf("}");
      if (jsonStart > -1 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(summary.slice(jsonStart, jsonEnd + 1));
        if (parsed?.summary) summary = String(parsed.summary);
        if (Array.isArray(parsed?.keyPoints)) keyPoints = parsed.keyPoints.slice(0, 5).map(String);
        if (Array.isArray(parsed?.actionItems)) actionItems = parsed.actionItems.slice(0, 4).map(String);
      }
    } catch {
      // Keep the raw text as the summary when the model returned prose.
    }
    if (!summary.trim()) return;

    io.to(`room:${roomId}`).emit("call:ai-insights", {
      roomId,
      summary,
      keyPoints,
      actionItems,
      generatedAt: new Date().toISOString(),
      transcriptLines: rows.rows.length,
    });
  } catch (err) {
    logger.warn("Live insights generation failed:", err);
  }
}

/** Drop scheduler state once a room is gone (called from endRoom cleanup). */
export function clearLiveInsightsForRoom(roomId: string): void {
  liveInsightsRooms.delete(roomId);
  captionTranslationCache.clear();
}
