import {
  AccessToken,
  RoomServiceClient,
  RoomConfiguration,
  TrackSource,
  type EgressClient,
} from "livekit-server-sdk";
import { isPlaceholderValue } from "../config-flags";
import type {
  CallingJoinContext,
  CallingProvider,
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

    // Enforce the plan's participant cap at the media layer too.
    if (ctx.maxParticipants && ctx.maxParticipants > 0) {
      token.roomConfig = new RoomConfiguration({
        maxParticipants: ctx.maxParticipants,
      });
    }

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
};
