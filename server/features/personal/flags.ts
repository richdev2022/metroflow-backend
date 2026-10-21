/**
 * Personal product governance — service flags, provider routing and pricing
 * knobs, all admin-managed via /api/admin/personal (console: Personal
 * Products). Stored as JSON blobs in system_settings so no schema migration
 * is needed and every value is auditable through the settings trail.
 *
 *   personal_service_flags   {"bills":true,"savings":true,...}   (default: all ON)
 *   personal_provider_modes  {"bills":"auto","crypto":"auto",...}(auto|provider|simulator)
 *   giftcard_sell_fee_percent / giftcard_buy_fee_percent               (default 5)
 *   crypto_spread_percent                        (default 1 — applied to quotes)
 *   virtualcard_funding_fee_percent              (default 1 — applied on funding)
 *
 * Fee rows that live in fee_configurations (bills 'bill', eSIM 'esim',
 * swap 'swap') are seeded by migrations.ts and edited by the admin console.
 */

import type { NextFunction, Request, Response } from "express";
import { query } from "../../db";
import { getSetting } from "../../services/app-config";

export const PERSONAL_SERVICES = [
    "bills",
    "savings",
    "giftcards",
    "esim",
    "virtualcards",
    "crypto",
    "social",
    "live",
    "swap",
] as const;
export type PersonalService = (typeof PERSONAL_SERVICES)[number];

/** Services with an external fulfilment provider (routing applies). */
export const ROUTED_SERVICES = ["bills", "esim", "giftcards", "virtualcards", "crypto"] as const;
export type RoutedService = (typeof ROUTED_SERVICES)[number];

export type ProviderMode = "auto" | "provider" | "simulator";

const DEFAULT_FLAGS: Record<PersonalService, boolean> = {
    bills: true,
    savings: true,
    giftcards: true,
    esim: true,
    virtualcards: true,
    crypto: true,
    social: true,
    live: true,
    swap: true,
};

export async function getPersonalServiceFlags(): Promise<Record<PersonalService, boolean>> {
    const raw = await getSetting("personal_service_flags", "");
    const merged: Record<PersonalService, boolean> = { ...DEFAULT_FLAGS };
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            for (const key of PERSONAL_SERVICES) {
                if (typeof parsed?.[key] === "boolean") merged[key] = parsed[key];
            }
        } catch {
            /* corrupt value -> defaults */
        }
    }
    return merged;
}

export async function isPersonalServiceEnabled(service: PersonalService): Promise<boolean> {
    const flags = await getPersonalServiceFlags();
    return flags[service] !== false;
}

/** Express gate — 403 with a customer-friendly message when a service is off. */
export function requirePersonalService(service: PersonalService) {
    return async (_req: Request, res: Response, next: NextFunction) => {
        try {
            if (await isPersonalServiceEnabled(service)) return next();
            const labels: Record<PersonalService, string> = {
                bills: "Bill payments",
                savings: "Savings Vaults",
                giftcards: "Gift card trading",
                esim: "eSIM data plans",
                virtualcards: "Virtual cards",
                crypto: "Crypto to cash",
                social: "The social feed",
                live: "Live streaming",
                swap: "Wallet swap",
            };
            return res.status(403).json({
                success: false,
                error: `${labels[service]} is being tuned right now — check back shortly.`,
                code: "SERVICE_DISABLED",
            });
        } catch (e: any) {
            // Fail OPEN on infra errors: never lock the whole product line
            // because a settings read hiccupped.
            console.error(`[personal-flags] ${service} check failed:`, e?.message);
            return next();
        }
    };
}

export async function getProviderModes(): Promise<Record<string, ProviderMode>> {
    const raw = await getSetting("personal_provider_modes", "");
    const modes: Record<string, ProviderMode> = {};
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            for (const key of ROUTED_SERVICES) {
                if (["auto", "provider", "simulator"].includes(parsed?.[key])) modes[key] = parsed[key];
            }
        } catch {
            /* corrupt value -> all auto */
        }
    }
    for (const key of ROUTED_SERVICES) {
        if (!modes[key]) modes[key] = "auto";
    }
    return modes;
}

/**
 * Resolve whether a routed service should hit the LIVE provider.
 *   auto      -> live when the provider's env config exists
 *   provider  -> always live (caller surfaces an error if unconfigured)
 *   simulator -> never live, even when configured (sandbox / incident mode)
 */
export async function useProvider(service: RoutedService, configured: boolean): Promise<boolean> {
    const modes = await getProviderModes();
    const mode = modes[service] || "auto";
    if (mode === "provider") return true;
    if (mode === "simulator") return false;
    return configured;
}

// ---------------------------------------------------------------------------
// Pricing knobs (settings-backed, numeric, clamped)
// ---------------------------------------------------------------------------
export interface PercentSetting {
    key: string;
    fallback: number;
    max?: number;
}

const PERCENT_SETTINGS: PercentSetting[] = [
    { key: "giftcard_sell_fee_percent", fallback: 5, max: 50 },
    { key: "giftcard_buy_fee_percent", fallback: 5, max: 50 },
    { key: "crypto_spread_percent", fallback: 1, max: 50 },
    { key: "virtualcard_funding_fee_percent", fallback: 1, max: 50 },
];

export async function getPercent(key: string, fallback: number, max = 50): Promise<number> {
    const raw = await getSetting(key, "");
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(n, max);
}

export async function getAllPercentSettings(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const s of PERCENT_SETTINGS) out[s.key] = await getPercent(s.key, s.fallback, s.max);
    return out;
}

/** Numeric JSONB-ish helper: set a percent setting (or clear it to default). */
export async function setPercent(key: string, value: number | null | undefined, fallback: number, max = 50): Promise<void> {
    if (value === null || value === undefined) {
        // Reset = remove override so the default applies again.
        await query(`DELETE FROM system_settings WHERE key = $1`, [key]);
        return;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > max) {
        throw new Error(`${key} must be between 0 and ${max}`);
    }
    await query(
        `INSERT INTO system_settings (key, value, description, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
        [key, String(n), `Personal product pricing — ${key} (percent)`],
    );
}
