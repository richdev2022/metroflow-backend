/**
 * CLIENT_URL / APP_URL multi-origin handling.
 *
 * Deployment reality: the platform now serves BOTH the Business app
 * (app.metricorex.com) and the Personal app (personal.metricorex.com) against
 * one API. Ops used to express that as a comma-separated CLIENT_URL — which
 * silently corrupted every link builder that does `${CLIENT_URL}/login`
 * (emails, invites, payment redirects), because those call sites expect a
 * single base URL. Meanwhile CORS never looked at CLIENT_URL at all, so the
 * Personal origin 403'd on preflights.
 *
 * This module is imported FIRST (before cors.ts and index.ts body) and:
 *   1. Captures the RAW comma-separated values at module load.
 *   2. Exposes configuredClientOrigins() — every origin across all URL env
 *      vars — for the CORS allow-list.
 *   3. Normalizes process.env.CLIENT_URL / CLIENT_APP_URL / APP_URL /
 *      APP_BASE_URL to their FIRST entry at boot, so every existing
 *      `${ENV}/path` link builder keeps producing valid URLs.
 */

const URL_ENV_KEYS = ["CLIENT_URL", "CLIENT_APP_URL", "APP_URL", "APP_BASE_URL"] as const;

/** Raw values captured before any normalization mutates process.env. */
const RAW_VALUES = new Map<string, string>();
for (const key of URL_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.trim()) RAW_VALUES.set(key, value.trim());
}

function splitList(value: string | null | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((part) => part.trim().replace(/\/+$/, ""))
        .filter(Boolean);
}

/**
 * Every origin configured across CLIENT_URL / CLIENT_APP_URL / APP_URL /
 * APP_BASE_URL / CORS_ORIGINS (all comma-separated aware). Consumed by the
 * CORS allow-list so multi-app deployments work without a bespoke env var.
 */
export function configuredClientOrigins(): string[] {
    const origins = new Set<string>();
    for (const raw of RAW_VALUES.values()) {
        for (const origin of splitList(raw)) origins.add(origin);
    }
    for (const origin of splitList(process.env.CORS_ORIGINS)) origins.add(origin);
    return [...origins];
}

/**
 * The first configured client URL — the safe base for building absolute
 * links (emails, invites, payment callbacks). Order: CLIENT_URL, then
 * CLIENT_APP_URL, APP_URL, APP_BASE_URL.
 */
export function primaryClientUrl(fallback = "https://app.metricorex.com"): string {
    for (const key of URL_ENV_KEYS) {
        const [first] = splitList(RAW_VALUES.get(key));
        if (first) return first;
    }
    return fallback;
}

// Boot-time normalization: link builders all interpolate `${CLIENT_URL}/...`;
// a comma-separated value would leak into every generated URL. Rewrite each
// URL env var to its first entry — the full list lives on in RAW_VALUES for
// configuredClientOrigins().
for (const key of RAW_VALUES.keys()) {
    const [first] = splitList(RAW_VALUES.get(key));
    if (first) process.env[key] = first;
}
