import { getSetting, setSetting } from "./app-config";

/**
 * Email footer + platform email-config store.
 *
 * Every outbound email ends with the same footer: two app-store download
 * badges (Android robot + Apple logo drawn as inline SVG — no external image
 * hosting) and a row of four circular social links (Instagram, X, LinkedIn,
 * Facebook), all driven by admin-editable URLs, plus the standard
 * metricorex.com / copyright line.
 *
 * Storage: reuses the existing `system_settings` key/value table (see
 * app-config.ts getSetting/setSetting) — no dedicated table needed. The six
 * keys are read through a 60-second in-process cache so bulk sends never hit
 * the database once per email; admins can override any key and the cache is
 * invalidated on write.
 */

export const EMAIL_CONFIG_KEYS = [
  "play_store_url",
  "app_store_url",
  "instagram_link",
  "twitter_link",
  "linkedin_link",
  "facebook_link",
] as const;

export type EmailConfigKey = (typeof EMAIL_CONFIG_KEYS)[number];

export type EmailConfig = Record<EmailConfigKey, string>;

/** Sensible defaults used when a key has no stored override. */
export const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  play_store_url: "https://play.google.com/store/apps/details?id=com.metricorex.app",
  app_store_url: "https://apps.apple.com/app/metricorex/id000000000",
  instagram_link: "https://instagram.com/metricorex",
  twitter_link: "https://x.com/metricorex",
  linkedin_link: "https://linkedin.com/company/metricorex",
  facebook_link: "https://facebook.com/metricorex",
};

const EMAIL_CONFIG_DESCRIPTIONS: Record<EmailConfigKey, string> = {
  play_store_url: "Google Play download link rendered in the email footer badges",
  app_store_url: "Apple App Store download link rendered in the email footer badges",
  instagram_link: "Instagram profile link rendered in the email footer social icons",
  twitter_link: "X (Twitter) profile link rendered in the email footer social icons",
  linkedin_link: "LinkedIn company link rendered in the email footer social icons",
  facebook_link: "Facebook page link rendered in the email footer social icons",
};

const EMAIL_CONFIG_TTL_MS = 60_000;

let cache: { data: EmailConfig; at: number } | null = null;
let inflight: Promise<void> | null = null;

/** Read the six keys from system_settings, merged over the defaults. */
async function readEmailConfigFromDb(): Promise<EmailConfig> {
  const merged: EmailConfig = { ...DEFAULT_EMAIL_CONFIG };
  for (const key of EMAIL_CONFIG_KEYS) {
    const stored = (await getSetting(key, "")).trim();
    if (stored) merged[key] = stored;
  }
  return merged;
}

async function refreshEmailConfigCache(): Promise<void> {
  try {
    const data = await readEmailConfigFromDb();
    cache = { data, at: Date.now() };
  } catch {
    // Config is cosmetic for the footer: on DB trouble keep serving defaults.
  } finally {
    inflight = null;
  }
}

/** Drop the cached snapshot (called after an admin PUT). */
export function invalidateEmailConfigCache(): void {
  cache = null;
}

/**
 * Effective email config (defaults merged with stored overrides). Fresh from
 * the cache when possible; refetches at most once per 60s and de-duplicates
 * concurrent refreshes.
 */
export async function getEmailConfig(): Promise<EmailConfig> {
  if (cache && Date.now() - cache.at < EMAIL_CONFIG_TTL_MS) {
    return { ...cache.data };
  }
  if (!inflight) inflight = refreshEmailConfigCache();
  await inflight;
  return { ...(cache ? cache.data : DEFAULT_EMAIL_CONFIG) };
}

/** Effective config + which keys are still on their code default (admin UI). */
export async function getEmailConfigWithMeta(): Promise<{
  config: EmailConfig;
  usingDefaults: Record<EmailConfigKey, boolean>;
}> {
  const config = await getEmailConfig();
  const usingDefaults = {} as Record<EmailConfigKey, boolean>;
  for (const key of EMAIL_CONFIG_KEYS) {
    const stored = (await getSetting(key, "")).trim();
    usingDefaults[key] = stored === "";
  }
  return { config, usingDefaults };
}

/**
 * Synchronous snapshot for template builders. Never blocks a send: returns
 * the warm cache (or the defaults on a cold start) and kicks off a
 * background refresh when the cache is stale or missing.
 */
function getEmailConfigSnapshot(): EmailConfig {
  if (cache) {
    if (Date.now() - cache.at >= EMAIL_CONFIG_TTL_MS && !inflight) {
      inflight = refreshEmailConfigCache();
    }
    return { ...cache.data };
  }
  if (!inflight) inflight = refreshEmailConfigCache();
  return { ...DEFAULT_EMAIL_CONFIG };
}

/** Validate + persist an admin-supplied config (http/https URLs, ≤500 chars). */
export async function saveEmailConfig(
  input: Partial<Record<EmailConfigKey, unknown>>,
): Promise<{ ok: true; config: EmailConfig } | { ok: false; error: string }> {
  const updates: Partial<EmailConfig> = {};
  for (const key of EMAIL_CONFIG_KEYS) {
    if (input[key] === undefined) continue;
    const raw = String(input[key] ?? "").trim();
    if (raw === "") {
      // Empty string clears the override (falls back to the default).
      updates[key] = "";
      continue;
    }
    if (raw.length > 500) {
      return { ok: false, error: `${key} must be at most 500 characters` };
    }
    if (!/^https?:\/\/.+/i.test(raw)) {
      return { ok: false, error: `${key} must be a valid http:// or https:// URL` };
    }
    updates[key] = raw;
  }

  for (const [key, value] of Object.entries(updates) as Array<[EmailConfigKey, string]>) {
    await setSetting(key, value, EMAIL_CONFIG_DESCRIPTIONS[key]);
  }
  invalidateEmailConfigCache();

  return { ok: true, config: await getEmailConfig() };
}

// ---------------------------------------------------------------------------
// Footer HTML
// ---------------------------------------------------------------------------

/**
 * Marker embedded in every footer so the send-layer safety net
 * (ensureEmailFooter) can detect templates that already carry one.
 */
export const EMAIL_FOOTER_MARKER = "<!--metricorex-email-footer-->";

/* Inline SVG glyph paths (24x24 grid) — self-contained, no image hosting. */
const SVG_PATHS = {
  android:
    "M17.523 15.3414c-.5511 0-.9993-.4486-.9993-.9997s.4482-.9993.9993-.9993c.5511 0 .9993.4482.9993.9993.0001.5511-.4482.9997-.9993.9997m-11.046 0c-.5511 0-.9993-.4486-.9993-.9997s.4482-.9993.9993-.9993c.5511 0 .9993.4482.9993.9993 0 .5511-.4482.9997-.9993.9997m11.4045-6.02l1.9973-3.4592a.416.416 0 00-.1521-.5676.416.416 0 00-.5676.1521l-2.0223 3.503C15.5902 8.2439 13.8533 7.8508 12 7.8508s-3.5902.3931-5.1367 1.0989L4.841 5.4467a.4161.4161 0 00-.5677-.1521.4157.4157 0 00-.1521.5676l1.9973 3.4592C2.6889 11.1867.3432 14.6589 0 18.761h24c-.3435-4.1021-2.6892-7.5743-6.1185-9.4396",
  apple:
    "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
  instagram:
    "M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z",
  x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  linkedin:
    "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
  facebook:
    "M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z",
};

function svgIcon(path: string, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#ffffff" xmlns="http://www.w3.org/2000/svg" style="display:block;"><path d="${path}"/></svg>`;
}

function storeBadge(href: string, iconPath: string, topLine: string, bottomLine: string): string {
  return `<a href="${href}" style="display:inline-block;background-color:#000000;border-radius:8px;margin:4px 6px;text-decoration:none;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
                <td style="padding:8px 2px 8px 12px;vertical-align:middle;">${svgIcon(iconPath, 26)}</td>
                <td style="padding:8px 14px 8px 6px;vertical-align:middle;text-align:left;">
                  <span style="display:block;color:#ffffff;font-size:10px;letter-spacing:0.5px;line-height:13px;font-family:Arial,sans-serif;">${topLine}</span>
                  <span style="display:block;color:#ffffff;font-size:16px;font-weight:bold;line-height:20px;font-family:Arial,sans-serif;">${bottomLine}</span>
                </td>
              </tr></table>
            </a>`;
}

function socialIcon(href: string, iconPath: string, label: string): string {
  return `<a href="${href}" title="${label}" aria-label="${label}" style="display:inline-block;width:34px;height:34px;border-radius:50%;background-color:#1d4ed8;margin:0 5px;text-decoration:none;text-align:center;">
                <span style="display:inline-block;width:0;height:34px;vertical-align:middle;"></span><span style="display:inline-block;vertical-align:middle;width:16px;height:16px;line-height:0;">${svgIcon(iconPath, 16)}</span>
              </a>`;
}

/**
 * The shared email footer: app-store badges, social icon row and the standard
 * metricorex.com / copyright line. Synchronous by design so every template
 * (sync generator functions) can interpolate it directly; reads the cached
 * config snapshot and never touches the DB on the send path.
 */
export function buildEmailFooterHtml(): string {
  const cfg = getEmailConfigSnapshot();
  const year = new Date().getFullYear();

  const badges: string[] = [];
  if (cfg.play_store_url) {
    badges.push(storeBadge(cfg.play_store_url, SVG_PATHS.android, "GET IT ON", "Google Play"));
  }
  if (cfg.app_store_url) {
    badges.push(storeBadge(cfg.app_store_url, SVG_PATHS.apple, "Download on the", "App Store"));
  }

  const socials = ([
    ["Instagram", cfg.instagram_link, SVG_PATHS.instagram],
    ["X (Twitter)", cfg.twitter_link, SVG_PATHS.x],
    ["LinkedIn", cfg.linkedin_link, SVG_PATHS.linkedin],
    ["Facebook", cfg.facebook_link, SVG_PATHS.facebook],
  ] as Array<[string, string, string]>)
    .filter((entry) => Boolean(entry[1]))
    .map(([label, href, iconPath]) => socialIcon(href, iconPath, label));

  return `${EMAIL_FOOTER_MARKER}
          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #e5e7eb;text-align:center;font-family:Arial,sans-serif;">
            ${badges.length ? `<p style="margin:0 0 10px;color:#6b7280;font-size:13px;font-weight:bold;">Get the Metricorex app</p>
            <div style="margin:0 0 18px;">${badges.join("")}</div>` : ""}
            ${socials.length ? `<p style="margin:0 0 12px;color:#6b7280;font-size:13px;font-weight:bold;">Follow Metricorex</p>
            <div style="margin:0 0 16px;">${socials.join("")}</div>` : ""}
            <p style="margin:0;color:#9ca3af;font-size:12px;">
              <a href="https://metricorex.com" style="color:#2563eb;text-decoration:none;font-weight:bold;">metricorex.com</a>
              &nbsp;&bull;&nbsp;&copy; ${year} Metricorex. All rights reserved.
            </p>
          </div>`;
}

/**
 * Safety net for the send layer: guarantees every outbound HTML email carries
 * the footer even if a caller builds its HTML inline and forgets the shared
 * builder. Templates that already embed the footer (marker present) pass
 * through untouched.
 */
export function ensureEmailFooter(html: string): string {
  if (!html || html.includes(EMAIL_FOOTER_MARKER)) return html;
  const footer = buildEmailFooterHtml();
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${footer}\n      </body>`);
  if (/<\/html\s*>/i.test(html)) return html.replace(/<\/html\s*>/i, `${footer}\n</html>`);
  return html + footer;
}
