import { Server } from "socket.io";
import http from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import { getRedisClient } from "./cache";
import logger from "./logger";
import { initMediasoup, getRouter, getOrCreateRoom } from "./mediasoup";

let io: Server | null = null;

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
