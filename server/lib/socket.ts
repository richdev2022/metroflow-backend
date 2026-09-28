import { Server } from "socket.io";
import http from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import { getRedisClient } from "./cache";
import logger from "./logger";
import {
  initMediasoup,
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

// Function to end call/meeting automatically
async function endRoom(roomId: string, roomType: 'call' | 'meeting'): Promise<void> {
  try {
    if (roomType === 'call') {
      await query(
        `UPDATE calls SET status = 'completed', ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [roomId]
      );
    } else {
      await query(
        `UPDATE meetings SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = $1`,
        [roomId]
      );
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
  // Initialize mediasoup first
  initMediasoup().catch(err => logger.error("Mediasoup init failed:", err));

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
          logger.warn("Socket presented an invalid/expired token - continuing as guest");
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

        if (isCall) {
          const callResult = await query(
            `SELECT c.ended_at as "endedAt", c.waiting_room_enabled as "waitingRoomEnabled", pp.max_meeting_duration as "maxMeetingDuration" 
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
          }
        } else {
          const meetingResult = await query(
            `SELECT m.end_time as "endedAt", m.waiting_room_enabled as "waitingRoomEnabled", pp.max_meeting_duration as "maxMeetingDuration" 
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
        if (callback) callback({ success: true, roomId: resolvedRoomId });

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

    // User presence
    socket.on("user-online", async (userId: string, businessId: string) => {
      // Prefer the server-verified identity from handshake auth when present
      if (socket.data.authenticated) {
        userId = socket.data.userId;
        businessId = socket.data.businessId;
      }
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

    socket.on("user-keep-alive", async (userId: string, businessId: string) => {
      if (isRedisReady()) {
        await redisClient.setex(
          `online:${businessId}:${userId}`,
          60,
          Date.now().toString()
        );
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
      try {
        const callerRes = await query(`SELECT name FROM users WHERE id = $1`, [socket.data.userId]);
        callerName = callerRes.rows[0]?.name || null;
      } catch { /* best-effort */ }
      socket.to(`user:${data.targetUserId}`).emit("call:incoming", {
        callId: finalCallId,
        callCode: data.callId,
        from: socket.data.userId,
        callerName: callerName || data.callerName || undefined,
        type: data.type,
      });
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
      try {
        const callRes = await query(`SELECT created_by FROM calls WHERE id = $1`, [resolvedCallId]);
        creatorId = callRes.rows[0]?.created_by || null;
      } catch { /* best-effort */ }
      io.to(`room:${resolvedCallId}`).emit("call:rejected", { callId: resolvedCallId, userId: socket.data.userId });
      if (creatorId && creatorId !== socket.data.userId) {
        io.to(`user:${creatorId}`).emit("call:rejected", { callId: resolvedCallId, userId: socket.data.userId });
      }
    });

    socket.on("call:end", async (data: { callId: string }) => {
      logger.info(`Call ended: ${data.callId}`);
      const resolvedCallId = await resolveCallId(data.callId);
      if (!resolvedCallId) return;
      // Persist the ended state so history lists stop showing the call as ongoing.
      try {
        await query(
          `UPDATE calls SET status = 'completed', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status <> 'completed'`,
          [resolvedCallId]
        );
      } catch (error) {
        logger.error(`Failed to persist call end for ${resolvedCallId}:`, error);
      }
      // Broadcast to the LIVE room (`room:{id}`) — `call:{id}` is never joined.
      io.to(`room:${resolvedCallId}`).emit("call:ended", { callId: resolvedCallId, endedBy: socket.data.userId });
      socket.leave(`room:${resolvedCallId}`);
    });

    // Meeting events (with roomManager integration and duration support)
    socket.on("meeting:join", async (data: { meetingId: string; userId: string; userName?: string; isHost?: boolean; audioEnabled?: boolean; videoEnabled?: boolean }, callback?: (response: any) => void) => {
      try {
        const resolvedMeetingId = await resolveMeetingId(data.meetingId);
        if (!resolvedMeetingId) {
          logger.warn(`meeting:join failed - cannot resolve meetingId/code: ${data.meetingId}`);
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
          `SELECT m.end_time as "endedAt", m.waiting_room_enabled as "waitingRoomEnabled", pp.max_meeting_duration as "maxMeetingDuration" 
           FROM meetings m
           LEFT JOIN businesses b ON m.business_id = b.id
           LEFT JOIN pricing_plans pp ON b.plan_id = pp.id
           WHERE m.id = $1`,
          [resolvedMeetingId]
        );

        if (meetingResult.rows.length > 0) {
          const meetingRow = meetingResult.rows[0];
          endsAt = meetingRow.endedAt ? new Date(meetingRow.endedAt) : null;
          maxMeetingDuration = meetingRow.maxMeetingDuration;
          waitingRoomEnabled = !!meetingRow.waitingRoomEnabled;
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
        if (callback) callback({ success: true, meetingId: resolvedMeetingId, meetingCode: data.meetingId });

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

    socket.on("meeting:leave", async (data: { meetingId: string; userId: string; userName?: string }) => {
      try {
        const resolvedMeetingId = await resolveMeetingId(data.meetingId);
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

    socket.on("meeting:end", async (data: { meetingId: string }) => {
      try {
        const resolvedMeetingId = await resolveMeetingId(data.meetingId);
        if (!resolvedMeetingId) return;

        await query(
          `UPDATE meetings SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'ongoing'`,
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
        let router;
        if (roomId) {
          const resolved = await resolveRoomId(roomId);
          const resolvedRoomId = resolved ? resolved.id : roomId;
          const room = await getOrCreateRoomAsync(resolvedRoomId);
          router = room.router;
        }
        if (!router) {
          callback({ error: "Router not initialized" });
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

    // Disconnect
    socket.on("disconnect", async () => {
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
