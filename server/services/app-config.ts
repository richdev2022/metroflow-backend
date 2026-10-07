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
