import * as mediasoup from "mediasoup";
import logger from "./logger";

let worker: mediasoup.types.Worker;
let router: mediasoup.types.Router;

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

export async function initMediasoup() {
  if (worker) {
    logger.info("Mediasoup worker already initialized");
    return;
  }

  try {
    worker = await mediasoup.createWorker({
      logLevel: "warn",
      logTags: [
        "ice",
        "dtls",
        "rtp",
        "srtp",
        "rtcp",
      ],
    });

    logger.info("Mediasoup worker created");

    worker.on("died", () => {
      logger.error("Mediasoup worker died! Exiting...");
      process.exit(1);
    });

    router = await worker.createRouter({ mediaCodecs });
    logger.info("Mediasoup router created");
  } catch (error) {
    logger.error("Failed to initialize mediasoup:", error);
    throw error;
  }
}

export function getRouter() {
  return router;
}

export function getWorker() {
  return worker;
}

// Room storage (in-memory for now; scale with Redis later)
interface Room {
  id: string;
  router: mediasoup.types.Router;
  transports: Map<string, mediasoup.types.WebRtcTransport>;
  producers: Map<string, mediasoup.types.Producer>;
  consumers: Map<string, mediasoup.types.Consumer>;
}

const rooms = new Map<string, Room>();

export function getOrCreateRoom(roomId: string): Room {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      router,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    });
  }
  return rooms.get(roomId)!;
}

export function removeRoom(roomId: string) {
  rooms.delete(roomId);
}
