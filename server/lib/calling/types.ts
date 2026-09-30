/**
 * Calling provider abstraction.
 *
 * Metricorex owns the business logic (meetings, calls, permissions, duration,
 * presence via Socket.IO). A CallingProvider is only responsible for the
 * realtime MEDIA infrastructure: connecting participants, publishing audio/
 * video/screen and tearing the media session down when the meeting ends.
 *
 * Two implementations exist:
 *  - "livekit"   → self-hosted LiveKit SFU (tokens minted here, media handled by LiveKit)
 *  - "mediasoup" → the original in-process MediaSoup + Socket.IO signaling stack
 */

export type ProviderName = "livekit" | "mediasoup";

export type RoomType = "call" | "meeting";

/** Everything the provider needs in order to authorize one participant join. */
export interface CallingJoinContext {
  roomType: RoomType;
  /** Resolved DB UUID of the call/meeting — also used as the provider room name. */
  roomId: string;
  /** Human readable meeting/call title (best effort). */
  title: string;
  /** Stable identity inside the provider: `user-<uuid>` or `guest-<id>`. */
  identity: string;
  /** Display name shown to other participants. */
  displayName: string;
  isHost: boolean;
  /** Remaining seconds the participant may stay connected (backend-enforced duration); null = unlimited. */
  remainingSeconds: number | null;
  maxParticipants: number | null;
}

/** Provider-specific credentials handed to a client that wants to join. */
export interface CallingCredentials {
  provider: ProviderName;
  /** Client-facing signaling/media URL (LiveKit only; undefined for mediasoup). */
  serverUrl?: string;
  /** Provider room name — always the resolved UUID. */
  roomName: string;
  /** Short-lived join token (LiveKit JWT; undefined for mediasoup). */
  token?: string;
  tokenExpiresAt?: string;
  roomType: RoomType;
  roomId: string;
  /** True when the configured active provider was unavailable and we degraded to mediasoup. */
  fallback?: boolean;
  fallbackReason?: string;
}

export interface ProviderHealth {
  name: ProviderName;
  label: string;
  enabled: boolean;
  configured: boolean;
  healthy: boolean;
  /** True when this provider is the admin-selected active provider. */
  active: boolean;
  details: Record<string, unknown>;
}

export interface CallingProvider {
  name: ProviderName;
  label: string;
  /** Env/config readiness (no network calls). */
  isConfigured(): boolean;
  /** Readiness incl. a cheap liveness probe against the provider. */
  healthCheck(): Promise<Omit<ProviderHealth, "name" | "label" | "active">>;
  /** Mint short-lived credentials for one participant. Throws on failure. */
  mintJoinCredentials(ctx: CallingJoinContext): Promise<Omit<CallingCredentials, "provider" | "roomType" | "roomId">>;
  /** Forcefully tear down the media session for a room (meeting ended). */
  endSession(roomId: string): Promise<void>;
  /** Host controls (best effort — providers may not support them). */
  removeParticipant?(roomId: string, identity: string): Promise<boolean>;
  muteParticipant?(roomId: string, identity: string, opts?: { audio?: boolean; video?: boolean }): Promise<boolean>;
  /** Optional diagnostics for /health. */
  diagnostics?(): Record<string, unknown>;
}

export function isProviderName(v: unknown): v is ProviderName {
  return v === "livekit" || v === "mediasoup";
}
