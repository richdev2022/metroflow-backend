
import { Provider } from "./index";
import { squadProvider } from "./squad";
import { monnifyProvider } from "./monnify";
import { flutterwaveProvider } from "./flutterwave";
import { query } from "../../db";

const providers: Record<string, Provider> = {
  squad: squadProvider,
  monnify: monnifyProvider,
  flutterwave: flutterwaveProvider,
};

const DEFAULT_PROVIDER = process.env.DEFAULT_PAYMENT_PROVIDER || "flutterwave";

// Global active provider (managed by admins) is stored in system_settings.
// Cached in-memory briefly to avoid a DB hit on every payment call.
let activeProviderCache: { name: string; fetchedAt: number } | null = null;
const ACTIVE_PROVIDER_CACHE_TTL_MS = 30_000;

export function getProvider(providerName?: string): Provider {
  const provider = providerName || DEFAULT_PROVIDER;
  if (!providers[provider]) {
    throw new Error(`Provider ${provider} not found`);
  }
  return providers[provider];
}

/**
 * Resolve the provider to use, honouring (in order):
 *  1. explicit provider name argument
 *  2. globally configured active provider (system_settings.active_payment_provider)
 *  3. DEFAULT_PAYMENT_PROVIDER env fallback
 * Throws if the resolved provider is unknown.
 */
export async function resolveProvider(explicitName?: string): Promise<Provider> {
  const name = explicitName || (await getActiveProviderName());
  return getProvider(name);
}

/**
 * Returns the globally active payment provider name (admin-managed),
 * falling back to the env default.
 */
export async function getActiveProviderName(): Promise<string> {
  const now = Date.now();
  if (activeProviderCache && now - activeProviderCache.fetchedAt < ACTIVE_PROVIDER_CACHE_TTL_MS) {
    return activeProviderCache.name;
  }
  try {
    const result = await query(
      `SELECT value FROM system_settings WHERE key = 'active_payment_provider' LIMIT 1`
    );
    const value = result.rows[0]?.value;
    if (value && providers[value]) {
      activeProviderCache = { name: value, fetchedAt: now };
      return value;
    }
  } catch (error) {
    // Table may not exist yet or DB hiccup - fall back to env default silently
    console.warn("[ProviderFactory] Failed to read active_payment_provider, using default:", error);
  }
  return DEFAULT_PROVIDER;
}

export function invalidateActiveProviderCache(): void {
  activeProviderCache = null;
}

export function getAvailableProviders(): string[] {
  return Object.keys(providers);
}

export function getProviderConfigStatus(): Record<string, any> {
  return {
    squad: {
      configured: Boolean(process.env.SQUAD_SECRET_KEY),
      requiredEnv: ["SQUAD_SECRET_KEY"],
    },
    monnify: {
      configured: Boolean(
        process.env.MONNIFY_API_KEY &&
          process.env.MONNIFY_SECRET_KEY &&
          process.env.MONNIFY_CONTRACT_CODE
      ),
      requiredEnv: ["MONNIFY_API_KEY", "MONNIFY_SECRET_KEY", "MONNIFY_CONTRACT_CODE"],
    },
    flutterwave: {
      configured: Boolean(process.env.FLW_SECRET_KEY),
      // Public key powers CLIENT-SIDE inline checkout (v3.js / mobile SDKs).
      // Public by design - safe to expose to clients.
      publicKeyConfigured: Boolean(process.env.FLW_PUBLIC_KEY),
      publicKey: process.env.FLW_PUBLIC_KEY || null,
      // Webhook secret hash must ALSO be set in the Flutterwave dashboard
      // (webhook settings) - otherwise all webhooks are rejected with 401.
      webhookSecretConfigured: Boolean(process.env.FLW_SECRET_HASH),
      requiredEnv: ["FLW_SECRET_KEY", "FLW_PUBLIC_KEY", "FLW_SECRET_HASH"],
      optionalEnv: ["FLW_ENCRYPTION_KEY (direct charges only)", "FLW_BASE_URL"],
    },
  };
}
