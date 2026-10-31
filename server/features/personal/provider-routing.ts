import { query } from "../../db";
import { getSetting } from "../../services/app-config";
import { isSogoConfigured } from "../../services/sogo";
import { isPrestmitConfigured } from "../../services/prestmit";
import { isBitnobConfigured } from "../../services/bitnob";

/**
 * PERSONAL PROVIDER ROUTING — the layer that lets the platform swap money
 * providers per service WITHOUT the frontend ever changing endpoints.
 *
 *   bills      → sogo (default) | flutterwave | simulator
 *   giftcards  → sogo (default) | prestmit    | simulator
 *   crypto     → sogo (default) | bitnob      | simulator
 *   rmb        → sogo (default) | simulator
 *
 * The active provider per service lives in system_settings
 * (`personal_provider_routing` JSON, admin-editable via /admin/personal/
 * providers). "sogo" is the DEFAULT ACTIVE provider for all three services.
 *
 * Frontend contract: every unified endpoint (bills / giftcards / crypto)
 * reads getActiveProvider() and dispatches — the client never learns (or
 * cares) which provider fulfilled a request beyond an informational
 * `provider` field in responses.
 */

export const ROUTABLE_SERVICES = ["bills", "giftcards", "crypto", "rmb"] as const;
export type RoutableService = (typeof ROUTABLE_SERVICES)[number];

export type BillProvider = "sogo" | "flutterwave" | "simulator";
export type GiftcardProvider = "sogo" | "prestmit" | "simulator";
export type CryptoProvider = "sogo" | "bitnob" | "simulator";
export type RmbProvider = "sogo" | "simulator";
export type RoutedProvider = BillProvider | GiftcardProvider | CryptoProvider | RmbProvider;

export const SERVICE_PROVIDERS: Record<RoutableService, readonly RoutedProvider[]> = {
  bills: ["sogo", "flutterwave", "simulator"],
  giftcards: ["sogo", "prestmit", "simulator"],
  crypto: ["sogo", "bitnob", "simulator"],
  rmb: ["sogo", "simulator"],
};

const DEFAULT_PROVIDER: Record<RoutableService, RoutedProvider> = {
  bills: "sogo",
  giftcards: "sogo",
  crypto: "sogo",
  rmb: "sogo",
};

const LABELS: Record<RoutableService, string> = {
  bills: "Bill payments",
  giftcards: "Gift card trading",
  crypto: "Crypto & stablecoins",
  rmb: "RMB (Yuan purchases)",
};

/** Is `provider` actually usable in this deployment (env keys present)? */
export function isProviderConfigured(service: RoutableService, provider: RoutedProvider): boolean {
  switch (provider) {
    case "sogo":
      return isSogoConfigured();
    case "prestmit":
      return isPrestmitConfigured();
    case "bitnob":
      return isBitnobConfigured();
    case "flutterwave": {
      const flw = process.env.FLW_SECRET_KEY || process.env.FLUTTERWAVE_SECRET_KEY;
      return !!flw;
    }
    case "simulator":
      return true;
    default:
      return false;
  }
}

/**
 * Resolve the ACTIVE provider for a service.
 *  1. The admin toggle (personal_provider_routing) decides.
 *  2. When the toggled provider is not configured (env keys missing) we
 *     fail over to the first configured alternative, then "simulator" —
 *     the product stays up and the operator sees the reason in the
 *     /admin/personal/providers status surface.
 */
export async function getActiveProvider(service: RoutableService): Promise<RoutedProvider> {
  let active = DEFAULT_PROVIDER[service];
  try {
    const raw = await getSetting("personal_provider_routing", "");
    if (raw) {
      const parsed = JSON.parse(raw);
      const wanted = parsed?.[service];
      if (wanted && (SERVICE_PROVIDERS[service] as readonly string[]).includes(wanted)) {
        active = wanted;
      }
    }
  } catch {
    /* corrupt/absent setting → default (sogo) */
  }
  if (isProviderConfigured(service, active)) return active;

  // Fail-over chain (never leave the product dead because of env drift).
  for (const candidate of SERVICE_PROVIDERS[service]) {
    if (candidate !== active && isProviderConfigured(service, candidate)) {
      console.warn(`[provider-routing] ${service}: active provider "${active}" is NOT configured — failing over to "${candidate}".`);
      return candidate;
    }
  }
  console.warn(`[provider-routing] ${service}: no provider configured — using simulator.`);
  return "simulator";
}

/** Read the full routing table (+ configured/live status) for admin surfaces. */
export async function getRoutingStatus(): Promise<{
  routing: Record<RoutableService, RoutedProvider>;
  providers: Record<RoutableService, Array<{ id: RoutedProvider; configured: boolean; active: boolean }>>;
}> {
  const routing = {} as Record<RoutableService, RoutedProvider>;
  const providers = {} as Record<RoutableService, Array<{ id: RoutedProvider; configured: boolean; active: boolean }>>;
  for (const service of ROUTABLE_SERVICES) {
    const active = await getActiveProvider(service);
    routing[service] = active;
    providers[service] = SERVICE_PROVIDERS[service].map((id) => ({
      id,
      configured: isProviderConfigured(service, id),
      active: id === active,
    }));
  }
  return { routing, providers };
}

/** Admin toggle: set the active provider for a service (validated + audited). */
export async function setActiveProvider(service: RoutableService, provider: RoutedProvider): Promise<void> {
  if (!(SERVICE_PROVIDERS[service] as readonly string[]).includes(provider)) {
    throw new Error(`${service} supports providers: ${SERVICE_PROVIDERS[service].join(", ")}`);
  }
  const current = await getActiveProvider(service);
  const raw = await getSetting("personal_provider_routing", "");
  let parsed: Record<string, string> = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  parsed[service] = provider;
  await query(
    `INSERT INTO system_settings (key, value, description, updated_at)
     VALUES ('personal_provider_routing', $1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
    [JSON.stringify(parsed), "Personal provider routing — active provider per service (bills/giftcards/crypto/rmb)"],
  );
  console.log(`[provider-routing] ${service}: ${current} -> ${provider}`);
}

/** Human label for customer-facing surfaces. */
export function providerLabel(service: RoutableService, provider: RoutedProvider): string {
  if (provider === "simulator") return `${LABELS[service]} (sandbox mode)`;
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
