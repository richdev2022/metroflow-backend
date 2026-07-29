import { Server } from "socket.io";
import http from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import { getRedisClient } from "./cache";
import logger from "./logger";
import { initMediasoup, getRouter, getOrCreateRoom } from "./mediasoup";
import { query } from "../db";
import { roomManager } from "./roomManager";
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

// Check for expired rooms every 10 seconds and emit countdown warnings
setInterval(async () => {
  try {
    const now = new Date();
    const nowMs = now.getTime();
    const fiveMinMs = 5 * 60 * 1000;
    const oneMinMs = 1 * 60 * 1000;

    // ----- CALLS -----
    const upcomingCalls = await query(
      `SELECT id, ended_at, business_id FROM calls WHERE status = 'ongoing' AND ended_at IS NOT NULL`,
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
      `SELECT id, end_time, business_id FROM meetings WHERE status = 'ongoing' AND end_time IS NOT NULL`,
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
  } catch (error) {
    logger.error("Error checking for expired rooms:", error);
  }
}, 10000); // Check every 10 seconds

export function initSocketServer(server: http.Server): void {
  // Initialize mediasoup first
  initMediasoup().catch(err => logger.error("Mediasoup init failed:", err));

  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
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

  io.on("connection", (socket) => {
    logger.info(`Socket connected: ${socket.id}`);

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

    // 2. Join call
    socket.on("call:join", async (data: { roomId: string; userId: string; userName: string; isHost: boolean; audioEnabled: boolean; videoEnabled: boolean }, callback?: (response: any) => void) => {
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

        if (isCall) {
          const callResult = await query(
            `SELECT c.ended_at as "endedAt", pp.max_meeting_duration as "maxMeetingDuration" 
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
          }
        } else {
          const meetingResult = await query(
            `SELECT m.end_time as "endedAt", pp.max_meeting_duration as "maxMeetingDuration" 
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
          }
        }

        roomManager.addParticipant(resolvedRoomId, {
          id: data.userId,
          name: data.userName,
          isHost: data.isHost,
          audioEnabled: data.audioEnabled,
          videoEnabled: data.videoEnabled,
          screenSharing: false,
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
              `UPDATE calls SET ended_at = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
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

        socket.to(`room:${resolvedRoomId}`).emit("call:participant-joined", {
          roomId: resolvedRoomId,
          userId: data.userId,
          userName: data.userName,
          isHost: data.isHost,
        });

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
        socket.leave(`room:${resolvedRoomId}`);

        socket.to(`room:${resolvedRoomId}`).emit("call:participant-left", {
          roomId: resolvedRoomId,
          userId: data.userId,
          userName: data.userName,
        });
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

    // User presence
    socket.on("user-online", async (userId: string, businessId: string) => {
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

    // Call events
    socket.on("call:invite", async (data: { callId: string; targetUserId: string; type: string }) => {
      logger.info(`Call invite: ${data.callId} to user ${data.targetUserId}`);
      const resolvedCallId = await resolveCallId(data.callId);
      const finalCallId = resolvedCallId || data.callId;
      socket.to(`user:${data.targetUserId}`).emit("call:incoming", {
        callId: finalCallId,
        callCode: data.callId,
        from: socket.data.userId,
        type: data.type,
      });
    });

    socket.on("call:accept", async (data: { callId: string }) => {
      logger.info(`Call accepted: ${data.callId}`);
      const resolvedCallId = await resolveCallId(data.callId);
      if (!resolvedCallId) return;
      socket.to(`call:${resolvedCallId}`).emit("call:accepted", { callId: resolvedCallId });
    });

    socket.on("call:reject", async (data: { callId: string }) => {
      logger.info(`Call rejected: ${data.callId}`);
      const resolvedCallId = await resolveCallId(data.callId);
      if (!resolvedCallId) return;
      socket.to(`call:${resolvedCallId}`).emit("call:rejected", { callId: resolvedCallId });
    });

    socket.on("call:end", async (data: { callId: string }) => {
      logger.info(`Call ended: ${data.callId}`);
      const resolvedCallId = await resolveCallId(data.callId);
      if (!resolvedCallId) return;
      socket.to(`call:${resolvedCallId}`).emit("call:ended", { callId: resolvedCallId });
      socket.leave(`call:${resolvedCallId}`);
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

        const meetingResult = await query(
          `SELECT m.end_time as "endedAt", pp.max_meeting_duration as "maxMeetingDuration" 
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
    socket.on("mediasoup:getRouterRtpCapabilities", async (callback) => {
      const router = getRouter();
      if (router) {
        callback({ rtpCapabilities: router.rtpCapabilities });
      } else {
        callback({ error: "Router not initialized" });
      }
    });

    socket.on("mediasoup:createWebRtcTransport", async ({ roomId }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const room = getOrCreateRoom(resolvedRoomId);
        const router = room.router;

        const transport = await router.createWebRtcTransport({
          listenIps: [{ ip: "0.0.0.0", announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || "127.0.0.1" }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        });

        room.transports.set(transport.id, transport);

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
        const room = getOrCreateRoom(resolvedRoomId);
        const transport = room.transports.get(transportId);
        if (!transport) throw new Error("Transport not found");
        await transport.connect({ dtlsParameters });
        callback();
      } catch (error) {
        logger.error("Error connecting transport:", error);
        callback({ error: String(error) });
      }
    });

    socket.on("mediasoup:produce", async ({ transportId, kind, rtpParameters, roomId }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const room = getOrCreateRoom(resolvedRoomId);
        const transport = room.transports.get(transportId);
        if (!transport) throw new Error("Transport not found");

        const producer = await transport.produce({ kind, rtpParameters });
        room.producers.set(producer.id, producer);

        producer.on("transportclose", () => {
          room.producers.delete(producer.id);
        });

        socket.to(`room:${resolvedRoomId}`).emit("mediasoup:newProducer", { producerId: producer.id, kind, roomId: resolvedRoomId });

        callback({ id: producer.id, roomId: resolvedRoomId });
      } catch (error) {
        logger.error("Error producing:", error);
        callback({ error: String(error) });
      }
    });

    socket.on("mediasoup:consume", async ({ transportId, producerId, rtpCapabilities, roomId }, callback) => {
      try {
        const resolved = await resolveRoomId(roomId);
        const resolvedRoomId = resolved ? resolved.id : roomId;
        const room = getOrCreateRoom(resolvedRoomId);
        const router = room.router;
        const transport = room.transports.get(transportId);
        if (!transport) throw new Error("Transport not found");

        if (!router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error("Cannot consume");
        }

        const consumer = await transport.consume({ producerId, rtpCapabilities });
        room.consumers.set(consumer.id, consumer);

        consumer.on("transportclose", () => {
          room.consumers.delete(consumer.id);
        });

        callback({
          id: consumer.id,
          producerId: producerId,
          kind: consumer.kind,
          roomId: resolvedRoomId,
          rtpParameters: consumer.rtpParameters,
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
        const room = getOrCreateRoom(resolvedRoomId);
        const consumer = room.consumers.get(consumerId);
        if (!consumer) throw new Error("Consumer not found");
        await consumer.resume();
        callback();
      } catch (error) {
        logger.error("Error resuming consumer:", error);
        callback({ error: String(error) });
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

    // In-meeting chat
    socket.on("meeting-chat:message", async (data: { meetingId?: string; callId?: string; message: string }) => {
      if (data.meetingId) {
        const resolved = await resolveMeetingId(data.meetingId);
        if (resolved) {
          const payload = {
            userId: socket.data.userId,
            meetingId: resolved,
            message: data.message,
            timestamp: new Date(),
          };
          socket.to(`meeting:${resolved}`).emit("meeting-chat:message", payload);
          socket.to(`room:${resolved}`).emit("meeting-chat:message", payload);
        }
      } else if (data.callId) {
        const resolved = await resolveCallId(data.callId);
        if (resolved) {
          const payload = {
            userId: socket.data.userId,
            callId: resolved,
            message: data.message,
            timestamp: new Date(),
          };
          socket.to(`call:${resolved}`).emit("meeting-chat:message", payload);
          socket.to(`room:${resolved}`).emit("meeting-chat:message", payload);
        }
      }
    });

    // Disconnect
    socket.on("disconnect", async () => {
      const { userId, businessId } = socket.data;
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
