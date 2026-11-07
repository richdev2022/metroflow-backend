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

// ---------------------------------------------------------------------------
// DISCONNECT GRACE
// ---------------------------------------------------------------------------
// A dropped Socket.IO connection used to tear the peer's WebRtcTransports (and
// with them every producer/consumer, and eventually the whole router) down
// IMMEDIATELY. Mobile networks flap constantly (Wi-Fi↔LTE handover, Android
// killing background sockets, elevator dead-zones) — the media plane itself
// was frequently still healthy (DTLS stays up independent of Socket.IO), so
// killing it converted a 3-second reconnect into a dead black stream for
// every viewer of a live room.
//
// Now a disconnect MARKS the peer's transports orphaned and schedules a sweep:
//   · sweep 1 (+PEER_GRACE_MS): transports whose DTLS is no longer 'connected'
//     are closed; still-connected ones (media genuinely still flowing) get
//     ONE more grace window.
//   · sweep 2 (+PEER_GRACE_MS again): everything still owned by the dead
//     socket is force-closed — leaks are bounded at 2× grace.
// A returning client re-associates its NEW transports on join; orphaned
// leftovers age out independently, so rejoin-within-grace reuses the room.
// ---------------------------------------------------------------------------
const PEER_GRACE_MS = Math.max(15_000, Math.min(120_000, Number(process.env.MEDIASOUP_PEER_GRACE_MS) || 45_000));
const ROOM_GRACE_MS = Math.max(10_000, Math.min(120_000, Number(process.env.MEDIASOUP_ROOM_GRACE_MS) || 45_000));

interface PeerSweep {
  timer: NodeJS.Timeout;
  sweep: number;
}
/** socketId -> scheduled cleanup sweep. */
const peerSweeps = new Map<string, PeerSweep>();
/** roomId -> scheduled empty-room teardown. */
const roomCloseTimers = new Map<string, NodeJS.Timeout>();

/**
 * Socket.id -> roomId registry. `mediasoup:newProducer` used to fan out via
 * `socket.to(room:*)` ONLY — a viewer whose `call:join` ack lagged or failed
 * (mobile proceeds with media once it holds credentials) was never in the
 * Socket.IO room and therefore NEVER heard that the host started publishing
 * (the classic "viewers see nothing" livestream bug). The registry lets the
 * signalling layer broadcast to every socket that has media in the room,
 * regardless of its Socket.IO room membership.
 */
const roomSocketRegistry = new Map<string, Set<string>>();
const socketRoomIndex = new Map<string, Set<string>>();

export function registerSocketForRoom(roomId: string, socketId: string): void {
  let set = roomSocketRegistry.get(roomId);
  if (!set) {
    set = new Set();
    roomSocketRegistry.set(roomId, set);
  }
  set.add(socketId);
  let idx = socketRoomIndex.get(socketId);
  if (!idx) {
    idx = new Set();
    socketRoomIndex.set(socketId, idx);
  }
  idx.add(roomId);
}

export function unregisterSocketFromRooms(socketId: string): void {
  const idx = socketRoomIndex.get(socketId);
  if (!idx) return;
  for (const roomId of idx) {
    const set = roomSocketRegistry.get(roomId);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) roomSocketRegistry.delete(roomId);
    }
  }
  socketRoomIndex.delete(socketId);
}

/** Every socket id with media interest in a room (registry, best-effort). */
export function getRoomSocketIds(roomId: string): string[] {
  return Array.from(roomSocketRegistry.get(roomId) || []);
}

function closeTransportFully(room: Room, transportId: string): void {
  const transport = room.transports.get(transportId);
  if (transport) {
    try {
      transport.close(); // fires 'transportclose' on its producers/consumers
    } catch {
      /* already closed */
    }
  }
  room.transports.delete(transportId);
  room.transportSockets.delete(transportId);
}

/** socketId -> true when the one-time still-connected extension was used. */
const peerGraceExtended = new Map<string, boolean>();

/**
 * One disconnect-grace sweep for a socket's transports. Only transports still
 * OWNED by this socket are touched — a returning client that recreated its
 * transports under a new socket id is never affected.
 */
function sweepSocketTransports(socketId: string): void {
  const touchedRooms = new Set<string>();
  for (const room of rooms.values()) {
    for (const [transportId, ownerId] of Array.from(room.transportSockets.entries())) {
      if (ownerId !== socketId) continue;
      const transport = room.transports.get(transportId);
      if (!transport) {
        room.transportSockets.delete(transportId);
        continue;
      }
      const dtls = String((transport as any).dtlsState || "");
      if (dtls === "connected" && !peerGraceExtended.get(socketId)) {
        // Media is genuinely still flowing without signalling — extend once.
        peerGraceExtended.set(socketId, true);
        armPeerSweep(socketId);
        return;
      }
      closeTransportFully(room, transportId);
      touchedRooms.add(room.id);
    }
  }
  peerGraceExtended.delete(socketId);
  for (const roomId of touchedRooms) scheduleRoomCloseIfEmpty(roomId);
  if (touchedRooms.size > 0) notifyPeerCleanup(socketId, Array.from(touchedRooms));
}

function armPeerSweep(socketId: string): void {
  const existing = peerSweeps.get(socketId);
  if (existing) clearTimeout(existing.timer);
  const sweep = (existing?.sweep || 0) + 1;
  const timer = setTimeout(() => {
    peerSweeps.delete(socketId);
    try {
      sweepSocketTransports(socketId);
    } catch (err) {
      logger.warn(`Peer grace sweep failed for ${socketId}:`, err);
    }
  }, PEER_GRACE_MS);
  timer.unref?.();
  peerSweeps.set(socketId, { timer, sweep });
}

/**
 * Grace-period replacement for the old immediate `closePeer(socketId)` on
 * socket disconnect. Does NOT close anything synchronously; returns the rooms
 * the socket had transports in (for optional same-tick notifications).
 */
export function schedulePeerClose(socketId: string): { affectedRooms: string[] } {
  const affectedRooms = new Set<string>();
  for (const [roomId, room] of rooms.entries()) {
    for (const ownerId of room.transportSockets.values()) {
      if (ownerId === socketId) affectedRooms.add(roomId);
    }
  }
  unregisterSocketFromRooms(socketId);
  if (affectedRooms.size > 0) armPeerSweep(socketId);
  return { affectedRooms: Array.from(affectedRooms) };
}

/**
 * Immediate, targeted teardown of ONE socket's transports in ONE room — used
 * on EXPLICIT `call:leave` (intentional exits must free the SFU slot right
 * away instead of waiting out the grace window).
 */
export function closePeerInRoom(roomId: string, socketId: string): { closedProducerIds: string[] } {
  const closedProducerIds: string[] = [];
  const room = rooms.get(roomId);
  if (!room) return { closedProducerIds };
  for (const [transportId, ownerId] of Array.from(room.transportSockets.entries())) {
    if (ownerId !== socketId) continue;
    for (const [producerId, producer] of room.producers) {
      if ((producer.appData as ProducerAppData)?.socketId === socketId) closedProducerIds.push(producerId);
    }
    closeTransportFully(room, transportId);
  }
  maybeCloseRoom(roomId);
  return { closedProducerIds };
}

/**
 * Cancel a pending grace sweep — the socket re-associated its transports
 * (fresh transports carry a new socket id, so this only fires for the rare
 * same-id re-association) or an admin path took over.
 */
export function cancelPeerGrace(socketId: string): void {
  const pending = peerSweeps.get(socketId);
  if (pending) {
    clearTimeout(pending.timer);
    peerSweeps.delete(socketId);
  }
  peerGraceExtended.delete(socketId);
}

/** True when a disconnect-grace sweep is pending for this socket. */
export function hasPendingPeerGrace(socketId: string): boolean {
  return peerSweeps.has(socketId);
}

// ---------------------------------------------------------------------------
// Sweep notification hook. The SFU layer cannot import the socket layer
// (circular), so socket.ts registers a callback here and emits the room
// notifications (`mediasoup:peerLeft`) at the moment transports are ACTUALLY
// closed — after the grace window — instead of at disconnect time.
// ---------------------------------------------------------------------------
let peerCleanupHook: ((info: { socketId: string; roomIds: string[] }) => void) | null = null;
export function setPeerCleanupHook(fn: (info: { socketId: string; roomIds: string[] }) => void): void {
  peerCleanupHook = fn;
}
function notifyPeerCleanup(socketId: string, roomIds: string[]): void {
  try {
    peerCleanupHook?.({ socketId, roomIds });
  } catch (err) {
    logger.warn("peerCleanup hook failed:", err);
  }
}

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
 *  2. The outbound public IP from the metadata/echo service (ipify) — on NAT
 *     hosts (CGNAT VPS, Docker, k8s, VPC droplets) this is the ONLY address
 *     remote peers can reach; the NIC address is unroutable.
 *  3. A genuinely PUBLIC IPv4 on the host's interfaces (single-VPS setup —
 *     ipify then returns the same address anyway).
 *  4. Fall back to the first non-internal IPv4; loopback only as the very
 *     last resort (local development).
 */
function isPrivateIPv4(ip: string): boolean {
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^127\./.test(ip) ||
    // RFC 6598 CGNAT (100.64.0.0/10): looks public to an RFC1918-only check
    // but is carrier-internal and UNROUTABLE from the internet — announcing it
    // strands every remote participant in ICE 'checking' forever.
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
  );
}

/**
 * Public IP discovered from the hosting provider's metadata service (or an
 * external echo service). Many VPS setups (DigitalOcean VPC-enabled droplets,
 * most cloud boxes) only carry a PRIVATE address on the network interfaces —
 * announcing that as the mediasoup ICE candidate makes the server unreachable
 * for every remote participant (the classic "stuck on Preparing to join" bug).
 * Resolved once at init; env override always wins.
 */
let metadataPublicIp: string | null = null;

async function lookupPublicIpFromMetadata(): Promise<string | null> {
  const sources = [
    { url: "http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address", provider: "digitalocean-metadata" },
    { url: "https://api.ipify.org", provider: "ipify" },
  ];
  for (const source of sources) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(source.url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text) && !text.startsWith("127.") && !isPrivateIPv4(text)) {
        logger.info(`Mediasoup public IP ${text} detected via ${source.provider}`);
        return text;
      }
    } catch {
      /* try next source */
    }
  }
  return null;
}

function detectAnnouncedIp(): string {
  const explicit = process.env.MEDIASOUP_ANNOUNCED_IP || process.env.MEDIASOUP_PUBLIC_IP || '';
  // MEDIASOUP_ALLOW_LOOPBACK=true is for local development / same-machine
  // browser tests only — a loopback announced IP can never serve remote peers.
  const loopbackAllowed = process.env.MEDIASOUP_ALLOW_LOOPBACK === 'true';
  const usable =
    explicit &&
    explicit !== '0.0.0.0' &&
    explicit !== '::1' &&
    (explicit !== '127.0.0.1' || loopbackAllowed);
  if (usable) return explicit;

  const interfaces = os.networkInterfaces();
  let firstPrivate = '';
  let firstNonInternal = '';
  let loopback = '127.0.0.1';

  // NAT-aware preference: the outbound public IP (what the internet sees as
  // this host) is the ONLY reachable address on NAT'd deployments (CGNAT
  // VPS, Docker, k8s, VPC droplets). An interface address that merely LOOKS
  // public (non-RFC1918, e.g. 100.x CGNAT or provider-internal ranges) is
  // NOT routable from phones — preferring it strands clients in ICE
  // 'checking' forever (the "livestream connecting forever" report).
  // On a plain single-VPS box ipify returns the same address as the NIC, so
  // preferring the metadata result is always safe when it exists.
  if (metadataPublicIp) return metadataPublicIp;

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

  // No public IP on the interfaces (VPC-only droplet): use the metadata service.
  if (firstNonInternal) return firstNonInternal;
  if (firstPrivate) return firstPrivate;
  return loopback;
}

let cachedAnnouncedIp: string | null = null;

function getAnnouncedIp(): string {
  if (cachedAnnouncedIp) {
    // Late metadata upgrade: the cache may hold a NIC guess made BEFORE the
    // outbound public IP resolved. NIC addresses that merely LOOK public
    // (provider-internal ranges like 21.x, 100.64/10 CGNAT, EC2 1:1-NAT where
    // the public IP never sits on the NIC) are unroutable from phones and
    // strand every remote peer in ICE 'checking' (forever-connecting). The
    // outbound public IP is what the internet sees — it always wins over a
    // cached NIC guess. An explicit MEDIASOUP_ANNOUNCED_IP env override is
    // still respected.
    const explicit = process.env.MEDIASOUP_ANNOUNCED_IP || process.env.MEDIASOUP_PUBLIC_IP || '';
    if (!explicit && metadataPublicIp && metadataPublicIp !== cachedAnnouncedIp) {
      logger.warn(
        `Mediasoup announced IP upgraded from stale "${cachedAnnouncedIp}" to outbound public "${metadataPublicIp}"`,
      );
      cachedAnnouncedIp = metadataPublicIp;
    }
    return cachedAnnouncedIp;
  }
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
    // Resolve the real public IP BEFORE the announced IP gets cached — on
    // VPC-only droplets the interfaces only expose a private address.
    if (!metadataPublicIp) {
      metadataPublicIp = await lookupPublicIpFromMetadata();
    }
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

/** True once at least one worker pool is alive (used by /health + guards). */
export function isMediasoupReady(): boolean {
  return workers.length > 0;
}

/** RTC diagnostics for the /health endpoint and deploy verification. */
export function getMediasoupDiagnostics() {
  const announcedIp = cachedAnnouncedIp || getAnnouncedIp();
  return {
    ready: workers.length > 0,
    workers: workers.length,
    announcedIp,
    announcedIpIsPublic: !!announcedIp && !isPrivateIPv4(announcedIp) && announcedIp !== '127.0.0.1',
    rooms: rooms.size,
    rtcPortRange: {
      min: Number(process.env.MEDIASOUP_RTC_MIN_PORT) || 40000,
      max: Number(process.env.MEDIASOUP_RTC_MAX_PORT) || 49999,
    },
  };
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
  const pending = roomCloseTimers.get(roomId);
  if (pending) {
    clearTimeout(pending);
    roomCloseTimers.delete(roomId);
  }
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
 * transports/producers/consumers it is torn down — but on a GRACE TIMER, not
 * synchronously. The old eager teardown destroyed the router the instant the
 * last transport went away, so a viewer joining 2 seconds later paid a full
 * router re-creation (and any racing `consume`/`connect` in between 500'd
 * with "Transport not found"). The grace window keeps the router warm across
 * quick leave/rejoin cycles; `removeRoom` cancels the timer if anyone joins.
 */
export function maybeCloseRoom(roomId: string) {
  scheduleRoomCloseIfEmpty(roomId);
}

/** Schedule an empty-room teardown after ROOM_GRACE_MS (idempotent). */
export function scheduleRoomCloseIfEmpty(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  if (
    room.transports.size !== 0 ||
    room.producers.size !== 0 ||
    room.consumers.size !== 0
  ) {
    // Room came back to life — cancel any pending teardown.
    const pending = roomCloseTimers.get(roomId);
    if (pending) {
      clearTimeout(pending);
      roomCloseTimers.delete(roomId);
    }
    return;
  }
  if (roomCloseTimers.has(roomId)) return; // already scheduled
  const timer = setTimeout(() => {
    roomCloseTimers.delete(roomId);
    const cur = rooms.get(roomId);
    if (!cur) return;
    if (
      cur.transports.size === 0 &&
      cur.producers.size === 0 &&
      cur.consumers.size === 0
    ) {
      removeRoom(roomId);
    }
  }, ROOM_GRACE_MS);
  timer.unref?.();
  roomCloseTimers.set(roomId, timer);
}

export async function createWebRtcTransportForRoom(
  roomId: string,
  transportOwnerSocketId?: string,
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
  // Registry: this socket now has media interest in the room — used by the
  // signalling layer to fan out `mediasoup:newProducer` even to sockets that
  // are not members of the Socket.IO room (late-joiner race fix).
  if (transportOwnerSocketId) registerSocketForRoom(roomId, transportOwnerSocketId);
  return { transport, room };
}

export function associateTransport(roomId: string, transportId: string, socketId: string) {
  const room = rooms.get(roomId);
  if (room) room.transportSockets.set(transportId, socketId);
  if (socketId) registerSocketForRoom(roomId, socketId);
}

/** List all producers in a room, excluding those created by `excludeSocketId`
 *  OR by the same authenticated user (a reconnecting peer must never discover
 *  its own stale producers from a previous socket and try to consume them). */
export function getRoomProducers(roomId: string, excludeSocketId?: string, excludeUserId?: string) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.producers.values())
    .filter((p) => {
      const appData = (p.appData as ProducerAppData) || {};
      if (excludeSocketId && appData.socketId === excludeSocketId) return false;
      if (excludeUserId && appData.userId && appData.userId === excludeUserId) return false;
      return true;
    })
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
