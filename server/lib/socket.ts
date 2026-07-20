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

    // Emit to all participants in the room
    const ioServer = getSocketServer();
    if (ioServer) {
      ioServer.to(`room:${roomId}`).emit("call:ended");
    }

    // Remove room from room manager
    const participants = roomManager.getParticipants(roomId);
    participants.forEach((participant) => {
      roomManager.removeParticipant(roomId, participant.id);
    });
  } catch (error) {
    logger.error("Error ending room:", error);
  }
}

// Check for expired rooms every 10 seconds
setInterval(async () => {
  try {
    const now = new Date();
    
    // Check all ongoing calls and meetings
    const ongoingCalls = await query(
      `SELECT id, ended_at, business_id FROM calls WHERE status = 'ongoing' AND ended_at IS NOT NULL AND ended_at < $1`,
      [now.toISOString()]
    );

    for (const call of ongoingCalls.rows) {
      await endRoom(call.id, 'call');
    }

    const ongoingMeetings = await query(
      `SELECT id, end_time, business_id FROM meetings WHERE status = 'ongoing' AND end_time IS NOT NULL AND end_time < $1`,
      [now.toISOString()]
    );

    for (const meeting of ongoingMeetings.rows) {
      await endRoom(meeting.id, 'meeting');
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
        const result = await query(
          `SELECT * FROM invitation_tokens WHERE token = $1 AND room_id = $2 AND used = FALSE AND expires_at > NOW()`,
          [data.token, data.roomId]
        );

        if (result.rows.length === 0) {
          callback({ valid: false, error: "Invalid or expired token" });
          return;
        }

        // Mark token as used
        await query(
          `UPDATE invitation_tokens SET used = TRUE WHERE token = $1`,
          [data.token]
        );

        callback({ valid: true });
      } catch (error) {
        logger.error("Error verifying token:", error);
        callback({ valid: false, error: "Server error" });
      }
    });

    // 2. Join call
    socket.on("call:join", async (data: { roomId: string; userId: string; userName: string; isHost: boolean; audioEnabled: boolean; videoEnabled: boolean }) => {
      try {
        // Get call/meeting details to get endsAt and maxMeetingDuration
        let endsAt: Date | null = null;
        let maxMeetingDuration: number | null = null;

        // Check if it's a call
        const callResult = await query(
          `SELECT c.ended_at as "endedAt", pp.max_meeting_duration as "maxMeetingDuration" 
           FROM calls c
           LEFT JOIN businesses b ON c.business_id = b.id
           LEFT JOIN pricing_plans pp ON b.plan_id = pp.id
           WHERE c.id = $1`,
          [data.roomId]
        );

        if (callResult.rows.length > 0) {
          const callRow = callResult.rows[0];
          endsAt = callRow.endedAt ? new Date(callRow.endedAt) : null;
          maxMeetingDuration = callRow.maxMeetingDuration;
        } else {
          // Check if it's a meeting
          const meetingResult = await query(
            `SELECT m.end_time as "endedAt", pp.max_meeting_duration as "maxMeetingDuration" 
             FROM meetings m
             LEFT JOIN businesses b ON m.business_id = b.id
             LEFT JOIN pricing_plans pp ON b.plan_id = pp.id
             WHERE m.id = $1`,
            [data.roomId]
          );
          if (meetingResult.rows.length > 0) {
            const meetingRow = meetingResult.rows[0];
            endsAt = meetingRow.endedAt ? new Date(meetingRow.endedAt) : null;
            maxMeetingDuration = meetingRow.maxMeetingDuration;
          }
        }

        // Add to room manager
        roomManager.addParticipant(data.roomId, {
          id: data.userId,
          name: data.userName,
          isHost: data.isHost,
          audioEnabled: data.audioEnabled,
          videoEnabled: data.videoEnabled,
          screenSharing: false,
        }, endsAt, maxMeetingDuration);

        // Join socket room
        socket.join(`room:${data.roomId}`);

        // Emit to others in the room
        socket.to(`room:${data.roomId}`).emit("call:participant-joined", {
          userId: data.userId,
          userName: data.userName,
          isHost: data.isHost,
        });

        // Emit participants list and room state to the new user
        const roomState = roomManager.getRoomState(data.roomId);
        socket.emit("call:participants-list", {
          participants: roomManager.getParticipants(data.roomId),
          endsAt: roomState?.endsAt?.toISOString() || null,
          maxMeetingDuration: roomState?.maxMeetingDuration,
        });
      } catch (error) {
        logger.error("Error joining call:", error);
      }
    });

    // 3. Leave call
    socket.on("call:leave", async (data: { roomId: string; userId: string; userName: string }) => {
      try {
        // Remove from room manager
        roomManager.removeParticipant(data.roomId, data.userId);

        // Leave socket room
        socket.leave(`room:${data.roomId}`);

        // Emit to others
        socket.to(`room:${data.roomId}`).emit("call:participant-left", {
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
        const participants = roomManager.getParticipants(data.roomId);
        callback({ participants });
      } catch (error) {
        logger.error("Error getting participants:", error);
        callback({ error: "Server error" });
      }
    });

    // 5. Update media state
    socket.on("call:participant-media-state", async (data: { roomId: string; userId: string; audioEnabled: boolean; videoEnabled: boolean; screenSharing: boolean }) => {
      try {
        roomManager.updateMediaState(data.roomId, data.userId, {
          audioEnabled: data.audioEnabled,
          videoEnabled: data.videoEnabled,
          screenSharing: data.screenSharing,
        });

        // Emit to others
        socket.to(`room:${data.roomId}`).emit("call:participant-media-state", data);
      } catch (error) {
        logger.error("Error updating media state:", error);
      }
    });

    // 6. Invitation joined
    socket.on("invitation:joined", async (data: { roomId: string; userId: string; userName: string }) => {
      try {
        // Emit to everyone in the room including the sender
        io.to(`room:${data.roomId}`).emit("invitation:joined", {
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
      socket.to(`user:${data.targetUserId}`).emit("call:incoming", {
        callId: data.callId,
        from: socket.data.userId,
        type: data.type,
      });
    });

    socket.on("call:accept", async (data: { callId: string }) => {
      logger.info(`Call accepted: ${data.callId}`);
      socket.to(`call:${data.callId}`).emit("call:accepted", { callId: data.callId });
    });

    socket.on("call:reject", async (data: { callId: string }) => {
      logger.info(`Call rejected: ${data.callId}`);
      socket.to(`call:${data.callId}`).emit("call:rejected", { callId: data.callId });
    });

    socket.on("call:end", async (data: { callId: string }) => {
      logger.info(`Call ended: ${data.callId}`);
      socket.to(`call:${data.callId}`).emit("call:ended", { callId: data.callId });
      socket.leave(`call:${data.callId}`);
    });

    // Meeting events
    socket.on("meeting:join", async (data: { meetingId: string }) => {
      socket.join(`meeting:${data.meetingId}`);
      logger.info(`Socket ${socket.id} joined meeting:${data.meetingId}`);
      socket.to(`meeting:${data.meetingId}`).emit("meeting:participant-joined", { userId: socket.data.userId });
    });

    socket.on("meeting:leave", async (data: { meetingId: string }) => {
      socket.to(`meeting:${data.meetingId}`).emit("meeting:participant-left", { userId: socket.data.userId });
      socket.leave(`meeting:${data.meetingId}`);
    });

    socket.on("meeting:end", async (data: { meetingId: string }) => {
      socket.to(`meeting:${data.meetingId}`).emit("meeting:ended", { meetingId: data.meetingId });
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
        const room = getOrCreateRoom(roomId);
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
        const room = getOrCreateRoom(roomId);
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
        const room = getOrCreateRoom(roomId);
        const transport = room.transports.get(transportId);
        if (!transport) throw new Error("Transport not found");

        const producer = await transport.produce({ kind, rtpParameters });
        room.producers.set(producer.id, producer);

        producer.on("transportclose", () => {
          room.producers.delete(producer.id);
        });

        // Notify others in room
        socket.to(`room:${roomId}`).emit("mediasoup:newProducer", { producerId: producer.id, kind });

        callback({ id: producer.id });
      } catch (error) {
        logger.error("Error producing:", error);
        callback({ error: String(error) });
      }
    });

    socket.on("mediasoup:consume", async ({ transportId, producerId, rtpCapabilities, roomId }, callback) => {
      try {
        const room = getOrCreateRoom(roomId);
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
          rtpParameters: consumer.rtpParameters,
        });
      } catch (error) {
        logger.error("Error consuming:", error);
        callback({ error: String(error) });
      }
    });

    socket.on("mediasoup:resume", async ({ consumerId, roomId }, callback) => {
      try {
        const room = getOrCreateRoom(roomId);
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
      const room = data.meetingId ? `meeting:${data.meetingId}` : `call:${data.callId}`;
      socket.to(room).emit("recording:started", data);
    });

    socket.on("recording:stop", async (data: { meetingId?: string; callId?: string }) => {
      logger.info(`Recording stopped for: ${data.meetingId || data.callId}`);
      const room = data.meetingId ? `meeting:${data.meetingId}` : `call:${data.callId}`;
      socket.to(room).emit("recording:stopped", data);
    });

    // Screen share
    socket.on("screen-share:start", async (data: { meetingId?: string; callId?: string }) => {
      const room = data.meetingId ? `meeting:${data.meetingId}` : `call:${data.callId}`;
      socket.to(room).emit("screen-share:started", { userId: socket.data.userId });
    });

    socket.on("screen-share:stop", async (data: { meetingId?: string; callId?: string }) => {
      const room = data.meetingId ? `meeting:${data.meetingId}` : `call:${data.callId}`;
      socket.to(room).emit("screen-share:stopped", { userId: socket.data.userId });
    });

    // In-meeting chat
    socket.on("meeting-chat:message", async (data: { meetingId?: string; callId?: string; message: string }) => {
      const room = data.meetingId ? `meeting:${data.meetingId}` : `call:${data.callId}`;
      socket.to(room).emit("meeting-chat:message", {
        userId: socket.data.userId,
        message: data.message,
        timestamp: new Date(),
      });
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
