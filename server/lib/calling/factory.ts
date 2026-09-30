import { getSetting, setSetting } from "../../services/app-config";
import { query } from "../../db";
import { mediasoupProvider } from "./mediasoup";
import { livekitProvider, isLiveKitConfigured } from "./livekit";
import type {
  CallingCredentials,
  CallingJoinContext,
  CallingProvider,
  ProviderName,
  ProviderHealth,
  RoomType,
} from "./types";

export * from "./types";

/**
 * CallingProviderFactory — resolves which media provider a call/meeting uses.
 *
 * Resolution order (backend is the source of truth):
 *   1. The `provider` column stored on the calls/meetings row (a session is
 *      always kept on the provider it was created with — switching the admin
 *      setting never migrates an in-flight room).
 *   2. The admin-selected `calling_provider` system setting.
 *   3. Built-in default: LiveKit.
 *
 * Degradation: if the selected provider is LiveKit but LiveKit is not
 * configured on this deployment, joins degrade to MediaSoup instead of
 * failing, and the credentials carry `fallback: true` so admins can detect it.
 */

export const CALLING_PROVIDER_SETTING_KEY = "calling_provider";
export const DEFAULT_CALLING_PROVIDER: ProviderName = "livekit";

const PROVIDERS: Record<ProviderName, CallingProvider> = {
  livekit: livekitProvider,
  mediasoup: mediasoupProvider,
};

export function getProviderByName(name: ProviderName): CallingProvider {
  return PROVIDERS[name] ?? mediasoupProvider;
}

export function listProviderNames(): ProviderName[] {
  return ["livekit", "mediasoup"];
}

/** Admin-selected active provider (system_settings). */
export async function getActiveProviderName(): Promise<ProviderName> {
  try {
    const v = (await getSetting(CALLING_PROVIDER_SETTING_KEY, "")).trim().toLowerCase();
    if (v === "livekit" || v === "mediasoup") return v;
  } catch {
    // DB not ready yet — fall through to default.
  }
  return DEFAULT_CALLING_PROVIDER;
}

export async function setActiveProviderName(name: ProviderName): Promise<void> {
  await setSetting(
    CALLING_PROVIDER_SETTING_KEY,
    name,
    "Globally active calling provider for calls & meetings (managed by platform admins)",
  );
}

/**
 * Resolve the provider for an existing call/meeting row.
 * `storedProvider` is the value of the row's `provider` column (may be null
 * for pre-migration rooms). Legacy rows are backfilled to the active setting.
 */
export async function resolveProviderForRoom(
  roomType: RoomType,
  roomId: string,
  storedProvider: string | null | undefined,
): Promise<CallingProvider> {
  let name: ProviderName | null = null;
  if (storedProvider === "livekit" || storedProvider === "mediasoup") {
    name = storedProvider;
  } else {
    name = await getActiveProviderName();
    // Backfill so the room stays on this provider for its whole lifetime.
    try {
      const table = roomType === "call" ? "calls" : "meetings";
      await query(`UPDATE ${table} SET provider = $1 WHERE id = $2 AND provider IS NULL`, [name, roomId]);
    } catch {
      // Column may not exist yet in exotic deployments — join still proceeds.
    }
  }
  return getProviderByName(name);
}

/** Readiness of every provider + the active one (for admin UI / health). */
export async function getProvidersStatus(): Promise<{
  activeProvider: ProviderName;
  providers: ProviderHealth[];
}> {
  const active = await getActiveProviderName();
  const names = listProviderNames();
  const providers = await Promise.all(
    names.map(async (name) => {
      const p = getProviderByName(name);
      const health = await p.healthCheck().catch(() => ({
        enabled: true,
        configured: p.isConfigured(),
        healthy: false,
        details: { error: "health probe failed" },
      }));
      return {
        name: p.name,
        label: p.label,
        active: name === active,
        ...health,
      } as ProviderHealth;
    }),
  );
  return { activeProvider: active, providers };
}

/**
 * Build the `calling` credentials block for a join response.
 * Returns undefined for MediaSoup (legacy clients just signal over Socket.IO),
 * and degrades LiveKit→MediaSoup when LiveKit is not configured.
 */
export async function buildCallingCredentials(
  provider: CallingProvider,
  ctx: CallingJoinContext,
): Promise<CallingCredentials | undefined> {
  let effective = provider;
  let fallback = false;
  let fallbackReason: string | undefined;

  if (effective.name === "livekit" && !isLiveKitConfigured()) {
    fallback = true;
    fallbackReason = "LiveKit is not configured on this deployment; using MediaSoup";
    effective = mediasoupProvider;
  }

  try {
    const base = await effective.mintJoinCredentials(ctx);
    return {
      ...base,
      provider: effective.name,
      roomType: ctx.roomType,
      roomId: ctx.roomId,
      ...(fallback ? { fallback, fallbackReason } : {}),
    };
  } catch (err) {
    if (effective.name === "livekit") {
      // Never strand a user because token minting failed — degrade to MediaSoup.
      const base = await mediasoupProvider.mintJoinCredentials(ctx);
      return {
        ...base,
        provider: "mediasoup",
        roomType: ctx.roomType,
        roomId: ctx.roomId,
        fallback: true,
        fallbackReason: `LiveKit join failed: ${String((err as Error)?.message || err)}`,
      };
    }
    throw err;
  }
}

/** Remaining seconds before the backend-enforced deadline (calls.ended_at / meetings.end_time), or null. */
export function computeRemainingSeconds(deadline: Date | string | null | undefined): number | null {
  if (!deadline) return null;
  const t = new Date(deadline).getTime();
  if (!Number.isFinite(t)) return null;
  const remaining = Math.floor((t - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}
