import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
  type EgressClient,
} from "livekit-server-sdk";
import { isPlaceholderValue } from "../config-flags";
import type {
  CallingJoinContext,
  CallingProvider,
  ProviderRecordingStartResult,
} from "./types";

/**
 * LiveKit provider — self-hosted LiveKit SFU.
 *
 * Metricorex keeps full control of the frontend; LiveKit only carries the
 * realtime media. Access tokens are minted here (short-lived, scoped to one
 * room, host/participant grants differ) and API_SECRET never leaves the server.
 */

const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60; // 1h floor so pre-joins don't expire instantly
const MAX_TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12h hard cap

export function getLiveKitConfig() {
  const apiKey = (process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET || "").trim();
  const url = (process.env.LIVEKIT_URL || "").trim(); // client-facing ws(s):// host
  const apiUrl = (process.env.LIVEKIT_API_URL || "").trim(); // server-side http(s) host (defaults derived from url)
  const egressUrl = (process.env.LIVEKIT_EGRESS_URL || "").trim(); // optional dedicated egress host
  return {
    apiKey: isPlaceholderValue(apiKey) ? "" : apiKey,
    apiSecret: isPlaceholderValue(apiSecret) ? "" : apiSecret,
    url: isPlaceholderValue(url) ? "" : url,
    apiUrl: isPlaceholderValue(apiUrl) ? "" : apiUrl,
    egressUrl: isPlaceholderValue(egressUrl) ? "" : egressUrl,
  };
}

function serverApiHost(): string {
  const { url, apiUrl } = getLiveKitConfig();
  const base = apiUrl || url;
  if (!base) return "";
  return base.replace(/^ws(s):\/\//i, (_m, s) => (s ? "https://" : "http://"));
}

export function isLiveKitConfigured(): boolean {
  const { apiKey, apiSecret, url } = getLiveKitConfig();
  return !!(apiKey && apiSecret && url);
}

let roomServiceClient: RoomServiceClient | null = null;
function getRoomService(): RoomServiceClient {
  if (!roomServiceClient) {
    const { apiKey, apiSecret } = getLiveKitConfig();
    const host = serverApiHost();
    if (!apiKey || !apiSecret || !host) {
      throw new Error("LiveKit is not configured (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)");
    }
    roomServiceClient = new RoomServiceClient(host, apiKey, apiSecret);
  }
  return roomServiceClient;
}

export function getEgressClient(): EgressClient | null {
  const { apiKey, apiSecret } = getLiveKitConfig();
  const { egressUrl } = getLiveKitConfig();
  const host = egressUrl || serverApiHost();
  if (!apiKey || !apiSecret || !host) return null;
  // Lazy import binding kept simple: construct a fresh client per call.
  const { EgressClient } = require("livekit-server-sdk");
  return new EgressClient(host, apiKey, apiSecret);
}

/** Convert an http(s) API host back to a ws(s) client URL (for derived defaults). */
function clientUrlFromApiHost(): string {
  const { url } = getLiveKitConfig();
  return url;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

/**
 * Cached liveness probe against the LiveKit server.
 *
 * `mintJoinCredentials` only signs a JWT — it never touches the network, so a
 * deployment with LIVEKIT_* env vars pointing at a dead server (502 behind the
 * reverse proxy) would otherwise hand out credentials clients cannot use.
 * This probe is the gate: joins degrade to MediaSoup while the SFU is down.
 *
 * Results are cached (30s healthy / 10s unhealthy) so a burst of joins does
 * not hammer the server.
 */
let reachabilityCache: { value: boolean; expiresAt: number } | null = null;
export function resetLiveKitReachabilityCache(): void {
  reachabilityCache = null;
}

export async function isLiveKitReachable(): Promise<boolean> {
  if (!isLiveKitConfigured()) return false;
  if (reachabilityCache && reachabilityCache.expiresAt > Date.now()) {
    return reachabilityCache.value;
  }
  let reachable = false;
  try {
    await withTimeout(getRoomService().listRooms(), 2500);
    reachable = true;
  } catch {
    reachable = false;
  }
  reachabilityCache = {
    value: reachable,
    expiresAt: Date.now() + (reachable ? 30_000 : 10_000),
  };
  return reachable;
}

/**
 * S3-compatible upload target for Egress output — reuses the deployment's
 * Cloudflare R2 credentials (same bucket/credentials the backend already
 * uses for media uploads) so no extra egress-specific secrets are needed.
 */
function egressS3Upload(): S3Upload {
  const accountId = (process.env.CLOUDFLARE_R2_ACCOUNT_ID || "").trim();
  const accessKey = (process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || "").trim();
  const secret = (process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = (process.env.CLOUDFLARE_R2_BUCKET_NAME || "").trim();
  if (!accountId || !accessKey || !secret || !bucket) {
    throw new Error(
      "Recording storage is not configured (CLOUDFLARE_R2_* env vars are required for server-side recording)",
    );
  }
  return new S3Upload({
    accessKey,
    secret,
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucket,
    forcePathStyle: true,
  });
}

export const livekitProvider: CallingProvider = {
  name: "livekit",
  label: "LiveKit",

  isConfigured: isLiveKitConfigured,

  async healthCheck() {
    const configured = isLiveKitConfigured();
    if (!configured) {
      return {
        enabled: true,
        configured: false,
        healthy: false,
        details: { reason: "LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing or placeholder" },
      };
    }
    try {
      const rooms = await withTimeout(getRoomService().listRooms(), 4000);
      return { enabled: true, configured: true, healthy: true, details: { server: clientUrlFromApiHost(), activeRooms: Array.isArray(rooms) ? rooms.length : 0 } };
    } catch (err: any) {
      return {
        enabled: true,
        configured: true,
        healthy: false,
        details: { server: clientUrlFromApiHost(), error: String(err?.message || err) },
      };
    }
  },

  async mintJoinCredentials(ctx: CallingJoinContext) {
    const { apiKey, apiSecret, url } = getLiveKitConfig();
    if (!apiKey || !apiSecret || !url) {
      throw new Error("LiveKit is not configured");
    }

    // Token lifetime tracks the backend-enforced meeting duration so a stolen
    // token cannot outlive the meeting window. Floor 1h for pre-join, cap 12h.
    const ttl = Math.min(
      MAX_TOKEN_TTL_SECONDS,
      Math.max(DEFAULT_TOKEN_TTL_SECONDS, Math.ceil((ctx.remainingSeconds ?? 0) + 600)),
    );

    const token = new AccessToken(apiKey, apiSecret, {
      identity: ctx.identity,
      name: ctx.displayName,
      ttl,
      metadata: JSON.stringify({
        roomType: ctx.roomType,
        roomId: ctx.roomId,
        isHost: ctx.isHost,
        provider: "metricorex",
      }),
    });

    token.addGrant({
      roomJoin: true,
      room: ctx.roomId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      // Mic, camera, screen share (incl. audio). Hosts may publish everything;
      // participants the same — host *moderation* is what differs.
      canPublishSources: [
        TrackSource.CAMERA,
        TrackSource.MICROPHONE,
        TrackSource.SCREEN_SHARE,
        TrackSource.SCREEN_SHARE_AUDIO,
      ],
      // Hosts become room admins: they can mute/remove other participants and
      // receive participant-level moderation events.
      roomAdmin: ctx.isHost,
      hidden: false,
    });

    // NOTE: do NOT set token.roomConfig (RoomConfiguration in the join token):
    // LiveKit 1.9.x rejects such tokens with 401 "invalid token". The plan's
    // participant cap is enforced by the Metricorex backend on every join
    // (409 max_participants_reached), which is authoritative anyway.

    const jwt = await token.toJwt();
    return {
      serverUrl: url,
      roomName: ctx.roomId,
      token: jwt,
      tokenExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  },

  async endSession(roomId: string) {
    try {
      await getRoomService().deleteRoom(roomId);
    } catch (err: any) {
      // Room may not exist (nobody joined) — treat as success.
      const msg = String(err?.message || err);
      if (!/not found|does not exist/i.test(msg)) {
        throw err;
      }
    }
  },

  async removeParticipant(roomId: string, identity: string) {
    try {
      await getRoomService().removeParticipant(roomId, identity);
      return true;
    } catch {
      return false;
    }
  },

  async muteParticipant(roomId: string, identity: string, opts) {
    try {
      const svc = getRoomService();
      const participant = await svc.getParticipant(roomId, identity);
      const tracks = participant?.tracks || [];
      const wantAudio = opts?.audio !== false;
      for (const t of tracks) {
        const isAudio = String(t.source) === "MICROPHONE";
        const isVideo = String(t.source) === "CAMERA";
        if ((wantAudio && isAudio) || (opts?.video && isVideo)) {
          await svc.mutePublishedTrack(roomId, identity, t.sid, true);
        }
      }
      return true;
    } catch {
      return false;
    }
  },

  /** Room-composite Egress recording → MP4 in R2 (key = opts.fileKey). */
  async startRecording(roomId, opts): Promise<ProviderRecordingStartResult> {
    if (!isLiveKitConfigured()) {
      return { supported: false, reason: "LiveKit is not configured" };
    }
    const egress = getEgressClient();
    if (!egress) {
      return { supported: false, reason: "LiveKit egress client unavailable" };
    }
    let s3: S3Upload;
    try {
      s3 = egressS3Upload();
    } catch (err: any) {
      return { supported: false, reason: String(err?.message || err) };
    }
    try {
      const info = await withTimeout(
        egress.startRoomCompositeEgress(
          roomId,
          new EncodedFileOutput({
            fileType: EncodedFileType.MP4,
            filepath: opts.fileKey,
            output: { case: "s3", value: s3 },
          }),
          { audioOnly: opts.audioOnly === true },
        ),
        8000,
      );
      return {
        supported: true,
        egressId: String(info.egressId || ""),
        startedAt: info.startedAt ? new Date(Number(info.startedAt)).toISOString() : new Date().toISOString(),
      };
    } catch (err: any) {
      throw new Error(String(err?.message || "Failed to start LiveKit egress recording"));
    }
  },

  async stopRecording(roomId: string, egressId: string) {
    const egress = getEgressClient();
    if (!egress || !egressId) return false;
    try {
      await withTimeout(egress.stopEgress(egressId), 8000);
      return true;
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (/not found|does not exist/i.test(msg)) return true; // already stopped
      return false;
    }
  },
};
