import { getSetting } from "./app-config";

/**
 * FX RATES — the platform's currency-conversion source of truth, with an
 * admin toggle.
 *
 * The NGN <-> stablecoin (USDT/USDC) conversion, the wallet swap and the
 * crypto quote/sell USD math all price through here. The active FX source is
 * the system_settings key `fx_rates_provider` (admin-editable):
 *
 *   "flutterwave" — Flutterwave /v3/rates (default, the platform's FX desk)
 *   "sogo"        — Sogo live USDT/NGN market rate (the active crypto rails)
 *   "auto"        — Flutterwave first, Sogo as fallback (default when unset)
 *
 * Rates are cached for 60 seconds: /v3/rates is rate-limited and the swap /
 * quote screens call it on every keystroke debounce.
 */

const CACHE_TTL_MS = 60_000;
let cache: { at: number; rate: number; provider: string } | null = null;

export type FxProvider = "flutterwave" | "sogo" | "auto";

export async function getFxProvider(): Promise<FxProvider> {
  try {
    const raw = String(await getSetting("fx_rates_provider", "") || "").toLowerCase();
    if (raw === "flutterwave" || raw === "sogo" || raw === "auto") return raw;
  } catch { /* settings table not ready — default */ }
  return "auto";
}

async function flutterwaveUsdNgn(): Promise<number> {
  const { getRate } = await import("./flutterwave");
  const rate = Number(await getRate("USD", "NGN", 1));
  if (!(rate > 1)) throw new Error("Flutterwave returned an invalid USD/NGN rate");
  return rate;
}

async function sogoUsdtNgn(): Promise<number> {
  const sogo = await import("../services/sogo");
  if (!sogo.isSogoConfigured()) throw new Error("Sogo is not configured");
  const sr = await sogo.cryptoRate("usdt", 1);
  const rate = Number(sr?.rate ?? sr?.user_receives_ngn ?? sr?.estimated_ngn ?? 0);
  if (!(rate > 1)) throw new Error("Sogo returned an invalid USDT/NGN rate");
  return rate;
}

/**
 * Live NGN-per-USD unit rate (stablecoins price 1:1 against USD).
 * Throws ONLY when every enabled source fails — callers surface an honest
 * error, they never fall back to fabricated numbers.
 */
export async function getUsdNgnRate(): Promise<{ rate: number; provider: string }> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return { rate: cache.rate, provider: cache.provider };

  const provider = await getFxProvider();
  const attempts: Array<{ id: string; run: () => Promise<number> }> = [];
  if (provider === "flutterwave") {
    attempts.push({ id: "flutterwave", run: flutterwaveUsdNgn });
  } else if (provider === "sogo") {
    attempts.push({ id: "sogo", run: sogoUsdtNgn });
  } else {
    attempts.push({ id: "flutterwave", run: flutterwaveUsdNgn });
    attempts.push({ id: "sogo", run: sogoUsdtNgn });
  }

  let lastErr: any = null;
  for (const attempt of attempts) {
    try {
      const rate = await attempt.run();
      cache = { at: now, rate: Math.round(rate * 100) / 100, provider: attempt.id };
      return { rate: cache.rate, provider: attempt.id };
    } catch (e: any) {
      lastErr = e;
      console.warn(`[fx] ${attempt.id} USD/NGN rate failed:`, e?.message);
    }
  }
  throw lastErr || new Error("No FX rate source is currently available");
}

/** Stablecoin family — priced against USD. */
export function isUsdCurrency(cur: string): boolean {
  return ["USD", "USDT", "USDC"].includes(String(cur || "").toUpperCase());
}

/**
 * Generic converter for wallet pairs. USD-family pairs price through
 * getUsdNgnRate (respecting the admin FX toggle); anything else falls back
 * to the Flutterwave /v3/rates cross rate.
 */
export async function getRate(from: string, to: string, amount = 1): Promise<number> {
  const f = String(from || "").toUpperCase();
  const t = String(to || "").toUpperCase();
  if (f === t) return 1;
  if (isUsdCurrency(t) && t !== "NGN" && f === "NGN") {
    const { rate } = await getUsdNgnRate();
    return Math.round((1 / rate) * 1000000) / 1000000; // NGN -> USD unit
  }
  if (isUsdCurrency(f) && t === "NGN") {
    const { rate } = await getUsdNgnRate();
    return rate; // USD-family -> NGN unit
  }
  // USD-family cross (USDT -> USDC) is 1:1.
  if (isUsdCurrency(f) && isUsdCurrency(t)) return 1;
  const { getRate: flwRate } = await import("./flutterwave");
  return flwRate(f, t, amount);
}
