import { query } from "../db";

/**
 * system_settings helpers (app-wide flags like maintenance mode,
 * international transfer pricing).
 */

export async function getSetting(key: string, fallback: string = ""): Promise<string> {
  try {
    const res = await query(`SELECT value FROM system_settings WHERE key = $1 LIMIT 1`, [key]);
    return res.rows[0]?.value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setSetting(key: string, value: string, description?: string): Promise<void> {
  await query(
    `INSERT INTO system_settings (key, value, description, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
    [key, value, description || null],
  );
}

export async function isMaintenanceMode(): Promise<boolean> {
  return (await getSetting("maintenance_mode", "off")) === "on";
}

export interface IntlTransferConfig {
  markupPercent: number;
  feePercent: number;
  feeFlat: number;
  /**
   * Admin-only margin layered ON TOP of markupPercent. Never surfaced to
   * customers: the quote merges it into the effective markup so users only
   * ever see one markup number.
   */
  spreadPercent: number;
  /** Quote lock window (seconds) — admin-editable countdown duration. */
  quoteTtlSeconds: number;
}

export async function getIntlTransferConfig(): Promise<IntlTransferConfig> {
  const [markup, feePct, feeFlat, spread, quoteTtl] = await Promise.all([
    getSetting("intl_transfer_markup_percent", "0"),
    getSetting("intl_transfer_fee_percent", "0"),
    getSetting("intl_transfer_fee_flat", "0"),
    getSetting("intl_transfer_spread_percent", "0"),
    getSetting("intl_quote_ttl_seconds", ""),
  ]);
  // Quote lock TTL: system_settings wins, then env INTL_QUOTE_TTL_SECONDS,
  // then 60s. Clamped to a sane 30s..30min window.
  const envTtl = parseInt(process.env.INTL_QUOTE_TTL_SECONDS || "60", 10) || 60;
  const rawTtl = quoteTtl.trim() !== "" ? parseInt(quoteTtl, 10) : envTtl;
  const ttl = Number.isFinite(rawTtl) ? rawTtl : 60;
  return {
    markupPercent: Number(markup) || 0,
    feePercent: Number(feePct) || 0,
    feeFlat: Number(feeFlat) || 0,
    spreadPercent: Number(spread) || 0,
    quoteTtlSeconds: Math.min(1800, Math.max(30, ttl)),
  };
}

/** Effective customer-facing markup = markup + spread (spread is invisible). */
export function effectiveMarkupPercent(config: IntlTransferConfig): number {
  return Math.round((config.markupPercent + config.spreadPercent) * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// International payout limits (min / max per payout currency)
// ---------------------------------------------------------------------------
export interface PayoutLimit {
  min: number;
  max: number;
}

export type PayoutLimits = Record<string, PayoutLimit>;

/**
 * Flutterwave's published international payout limits (developer.flutterwave.com
 * — international USD/EUR/GBP guide): minimum 10, maximum 20,000 per transfer
 * for USD, GBP and EUR. Admins can override per currency via the
 * `intl_payout_limits` system setting (JSON: {"USD":{"min":10,"max":20000},...}).
 */
export const DEFAULT_PAYOUT_LIMITS: PayoutLimits = {
  USD: { min: 10, max: 20000 },
  GBP: { min: 10, max: 20000 },
  EUR: { min: 10, max: 20000 },
};

export async function getIntlPayoutLimits(): Promise<PayoutLimits> {
  const raw = await getSetting("intl_payout_limits", "");
  if (!raw) return { ...DEFAULT_PAYOUT_LIMITS };
  try {
    const parsed = JSON.parse(raw);
    const merged: PayoutLimits = { ...DEFAULT_PAYOUT_LIMITS };
    for (const [cur, val] of Object.entries(parsed || {})) {
      const currency = String(cur).toUpperCase();
      if (!["USD", "GBP", "EUR"].includes(currency)) continue;
      const min = Number((val as any)?.min);
      const max = Number((val as any)?.max);
      if (Number.isFinite(min) && min > 0) merged[currency] = { ...merged[currency], min };
      if (Number.isFinite(max) && max > 0 && (!merged[currency] || max >= merged[currency].min)) {
        merged[currency] = { ...(merged[currency] || { min: 10 }), max };
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_PAYOUT_LIMITS };
  }
}

export function limitForCurrency(limits: PayoutLimits, currency: string): PayoutLimit {
  const cur = String(currency || "USD").toUpperCase();
  return limits[cur] || DEFAULT_PAYOUT_LIMITS[cur] || { min: 10, max: 20000 };
}

/**
 * Currency of the PLATFORM float that funds international payouts on the
 * provider side (Flutterwave debits this wallet and converts). Admins can
 * switch it via `intl_payout_source_currency` (default NGN so payouts draw
 * from the Naira float — no pre-funded USD/GBP/EUR balance required).
 */
export async function getIntlPayoutSourceCurrency(): Promise<string> {
  const raw = (await getSetting("intl_payout_source_currency", "NGN")).toUpperCase();
  return ["NGN", "USD", "GBP", "EUR"].includes(raw) ? raw : "NGN";
}

/** Guard a destination-currency amount against the admin-configured limits. */
export function checkPayoutLimit(
  currency: string,
  amount: number,
  limits: PayoutLimits,
): { ok: boolean; error?: string; code?: string; limit?: PayoutLimit } {
  const limit = limitForCurrency(limits, currency);
  if (amount < limit.min) {
    return {
      ok: false,
      code: "PAYOUT_LIMIT_MIN",
      error: `The minimum amount for ${currency.toUpperCase()} payouts is ${limit.min} ${currency.toUpperCase()}`,
      limit,
    };
  }
  if (amount > limit.max) {
    return {
      ok: false,
      code: "PAYOUT_LIMIT_MAX",
      error: `The maximum amount for ${currency.toUpperCase()} payouts is ${limit.max} ${currency.toUpperCase()} per transfer`,
      limit,
    };
  }
  return { ok: true, limit };
}
