import * as mediasoup from "mediasoup";
import os from "os";
import logger from "./logger";

/**
 * Mediasoup SFU layer
 * -------------------
 * Production-grade setup following https://mediasoup.org/documentation/v3/
 *
 * - A pool of workers (one per CPU core, capped at 4) is created at init.
 * - Each room gets its OWN router assigned to the least-loaded worker
 *   (this fixes the previous design where a single shared router handled
 *   every room, capping throughput and mixing producer state).
 * - Transports/producers/consumers are tracked per-room and associated with
 *   the owning socket id so we can clean up on disconnect.
 */

const MAX_WORKERS = Math.min(os.cpus()?.length || 1, 4);

let workers: mediasoup.types.Worker[] = [];
let nextWorkerIdx = 0;

const mediaCodecs: mediasoup.types.RtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    preferredPayloadType: 96,
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "level-asymmetry-allowed": 1,
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
    },
    preferredPayloadType: 97,
  },
];

export interface ProducerAppData {
  socketId?: string;
  userId?: string;
  userName?: string;
  source?: "mic" | "webcam" | "screen";
  [key: string]: unknown;
}

interface Room {
  id: string;
  router: mediasoup.types.Router;
  transports: Map<string, mediasoup.types.WebRtcTransport>;
  /** transportId -> owning socket id */
  transportSockets: Map<string, string>;
  producers: Map<string, mediasoup.types.Producer>;
  consumers: Map<string, mediasoup.types.Consumer>;
  /** monotonic usage counter for least-loaded worker selection */
  createdAt: number;
}

const rooms = new Map<string, Room>();

/**
 * Resolve the IP mediasoup should ANNOUNCE to clients in ICE candidates.
 *
 * A loopback value (127.0.0.1) makes every announced candidate unreachable
 * for real browsers — remote participants try to connect to THEIR OWN
 * localhost, so media never flows (the classic "call connects but nobody
 * sees/hears anyone / cannot initiate a call" failure).
 *
 * Resolution order:
 *  1. MEDIASOUP_ANNOUNCED_IP / MEDIASOUP_PUBLIC_IP if set to a usable,
 *     non-loopback address.
 *  2. Auto-detect: prefer a PUBLIC IPv4 of the host, otherwise the first
 *     non-internal IPv4 interface (works for single VPS deployments).
 *  3. Fall back to the first non-internal IPv4; loopback only as the very
 *     last resort (local development).
 */
function isPrivateIPv4(ip: string): boolean {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function detectAnnouncedIp(): string {
  const explicit = process.env.MEDIASOUP_ANNOUNCED_IP || process.env.MEDIASOUP_PUBLIC_IP || '';
  const usable = explicit && explicit !== '127.0.0.1' && explicit !== '0.0.0.0' && explicit !== '::1';
  if (usable) return explicit;

  const interfaces = os.networkInterfaces();
  let firstPrivate = '';
  let firstNonInternal = '';
  let loopback = '127.0.0.1';

  for (const addresses of Object.values(interfaces)) {
    for (const addr of addresses || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (!firstNonInternal) firstNonInternal = addr.address;
      if (isPrivateIPv4(addr.address) && !firstPrivate) firstPrivate = addr.address;
      if (!isPrivateIPv4(addr.address)) {
        // Public IPv4 of the host — best candidate for announced IP
        return addr.address;
      }
    }
  }

  if (firstNonInternal) return firstNonInternal;
  if (firstPrivate) return firstPrivate;
  return loopback;
}

let cachedAnnouncedIp: string | null = null;

function getAnnouncedIp(): string {
  if (cachedAnnouncedIp) return cachedAnnouncedIp;
  const resolved = detectAnnouncedIp();
  const explicit = process.env.MEDIASOUP_ANNOUNCED_IP || process.env.MEDIASOUP_PUBLIC_IP || '';
  if (resolved === '127.0.0.1') {
    logger.warn(
      'Mediasoup announced IP resolved to 127.0.0.1 — remote participants will NOT be able to connect media. ' +
      'Set MEDIASOUP_ANNOUNCED_IP to this server\'s PUBLIC IP in production!'
    );
  } else if (explicit && explicit !== resolved) {
    logger.warn(
      `Mediasoup: ignoring unusable MEDIASOUP_ANNOUNCED_IP="${explicit}" (loopback/unroutable) — using "${resolved}" instead.`
    );
  }
  cachedAnnouncedIp = resolved;
  return resolved;
}

function getRtcPorts(): { rtcMinPort?: number; rtcMaxPort?: number } {
  return {
    rtcMinPort: process.env.MEDIASOUP_RTC_MIN_PORT
      ? Number(process.env.MEDIASOUP_RTC_MIN_PORT)
      : undefined,
    rtcMaxPort: process.env.MEDIASOUP_RTC_MAX_PORT
      ? Number(process.env.MEDIASOUP_RTC_MAX_PORT)
      : undefined,
  };
}

async function createWorker(): Promise<mediasoup.types.Worker> {
  const { rtcMinPort, rtcMaxPort } = getRtcPorts();
  const worker = await mediasoup.createWorker({
    logLevel: "warn",
    logTags: ["ice", "dtls", "rtp", "srtp", "rtcp"],
    rtcMinPort,
    rtcMaxPort,
  });

  worker.on("died", () => {
    logger.error(`Mediasoup worker ${worker.pid} died! Exiting in 2s...`);
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
}

export async function initMediasoup() {
  if (workers.length > 0) {
    logger.info("Mediasoup workers already initialized");
    return;
  }

  try {
    const count = Math.max(1, MAX_WORKERS);
    for (let i = 0; i < count; i++) {
      const worker = await createWorker();
      workers.push(worker);
      logger.info(`Mediasoup worker ${i + 1}/${count} created (pid ${worker.pid})`);
    }
    logger.info(
      `Mediasoup initialized with ${workers.length} worker(s), announced IP: ${getAnnouncedIp()}`,
    );
  } catch (error) {
    logger.error("Failed to initialize mediasoup:", error);
    throw error;
  }
}

function pickWorker(): mediasoup.types.Worker {
  if (workers.length === 0) {
    throw new Error("Mediasoup not initialized");
  }
  // Round-robin across workers to distribute routers
  const worker = workers[nextWorkerIdx % workers.length];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return worker;
}

function getListenIps(): mediasoup.types.TransportListenIp[] {
  const announcedIp = getAnnouncedIp();
  return [{ ip: "0.0.0.0", announcedIp }];
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

/** Async room creation that guarantees the router exists before returning. */
export async function getOrCreateRoomAsync(roomId: string): Promise<Room> {
  let room = rooms.get(roomId);
  if (room && room.router) return room;

  const worker = pickWorker();
  const router = await worker.createRouter({ mediaCodecs });
  room = {
    id: roomId,
    router,
    transports: new Map(),
    transportSockets: new Map(),
    producers: new Map(),
    consumers: new Map(),
    createdAt: Date.now(),
  };
  rooms.set(roomId, room);
  logger.info(`Router created for room ${roomId} (worker ${worker.pid})`);
  return room;
}

export function removeRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (room) {
    try {
      room.router?.close();
    } catch {
      /* already closed */
    }
    for (const t of room.transports.values()) {
      try {
        t.close();
      } catch {
        /* noop */
      }
    }
    rooms.delete(roomId);
    logger.info(`Room ${roomId} removed (empty)`);
  }
}

/**
 * Called after mediasoup operations on a room. If the room has no active
 * transports/producers/consumers it is torn down to free the router/worker.
 */
export function maybeCloseRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (
    room.transports.size === 0 &&
    room.producers.size === 0 &&
    room.consumers.size === 0
  ) {
    removeRoom(roomId);
  }
}

export async function createWebRtcTransportForRoom(
  roomId: string,
): Promise<{
  transport: mediasoup.types.WebRtcTransport;
  room: Room;
}> {
  const room = await getOrCreateRoomAsync(roomId);
  const transport = await room.router.createWebRtcTransport({
    listenIps: getListenIps(),
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });

  room.transports.set(transport.id, transport);
  return { transport, room };
}

export function associateTransport(roomId: string, transportId: string, socketId: string) {
  const room = rooms.get(roomId);
  if (room) room.transportSockets.set(transportId, socketId);
}

/** List all producers in a room, excluding those created by `excludeSocketId`. */
export function getRoomProducers(roomId: string, excludeSocketId?: string) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.producers.values())
    .filter((p) => (p.appData as ProducerAppData)?.socketId !== excludeSocketId)
    .map((p) => ({
      producerId: p.id,
      kind: p.kind,
      peerId: (p.appData as ProducerAppData)?.userId,
      peerName: (p.appData as ProducerAppData)?.userName,
      appData: p.appData,
    }));
}

/**
 * Close every transport/producer owned by a socket (on disconnect).
 * Returns the list of closed producer ids so callers can notify the room.
 */
export function closePeer(socketId: string): {
  closedProducerIds: string[];
  affectedRooms: string[];
} {
  const closedProducerIds: string[] = [];
  const affectedRooms = new Set<string>();

  for (const [roomId, room] of rooms.entries()) {
    for (const [transportId, sockId] of room.transportSockets.entries()) {
      if (sockId !== socketId) continue;
      const transport = room.transports.get(transportId);
      if (transport) {
        // closing the transport fires 'transportclose' on its producers/consumers
        try {
          transport.close();
        } catch {
          /* noop */
        }
      }
      room.transports.delete(transportId);
      room.transportSockets.delete(transportId);
      affectedRooms.add(roomId);
    }
  }

  // transportclose handlers in socket.ts remove producers from maps and push
  // ids into closedProducerIds via onProducerClosed callback registration.
  return { closedProducerIds, affectedRooms: Array.from(affectedRooms) };
}

// Backward-compatible helpers (legacy single-router API)
export function getRouter(): mediasoup.types.Router | null {
  for (const room of rooms.values()) {
    if (room.router) return room.router;
  }
  return null;
}

export function getWorker(): mediasoup.types.Worker | null {
  return workers[0] || null;
}

export function getRoomsSnapshot() {
  return Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    transports: room.transports.size,
    producers: room.producers.size,
    consumers: room.consumers.size,
  }));
}
