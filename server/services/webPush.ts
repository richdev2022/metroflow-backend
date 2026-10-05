import webpush from "web-push";
import { query } from "../db";

/**
 * Web Push (VAPID) — browser push notifications.
 *
 * Complements the FCM push (services/push.ts) so web clients can receive
 * incoming-call rings even when the tab is closed (service worker).
 *
 * VAPID keys resolution (cached in memory):
 *  1. env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (recommended — set them once).
 *  2. system_settings table (persisted by a previous boot).
 *  3. webpush.generateVAPIDKeys() → persisted to system_settings + printed
 *     as a banner so the operator can copy them into .env.
 *
 * Keys must be STABLE across restarts: a changed public key silently
 * invalidates every existing PushSubscription.
 */

let cachedKeys: { publicKey: string; privateKey: string } | null = null;
let webpushConfigured = false;

const SETTINGS_KEYS = {
  publicKey: "vapid_public_key",
  privateKey: "vapid_private_key",
} as const;

async function loadKeysFromSettings(): Promise<{ publicKey: string; privateKey: string } | null> {
  try {
    const res = await query(
      `SELECT key, value FROM system_settings WHERE key = ANY($1::text[])`,
      [[SETTINGS_KEYS.publicKey, SETTINGS_KEYS.privateKey]],
    );
    const map = new Map<string, string>(res.rows.map((r: any) => [r.key, r.value]));
    const publicKey = map.get(SETTINGS_KEYS.publicKey);
    const privateKey = map.get(SETTINGS_KEYS.privateKey);
    if (publicKey && privateKey) return { publicKey, privateKey };
    return null;
  } catch {
    return null;
  }
}

async function persistKeysToSettings(keys: { publicKey: string; privateKey: string }): Promise<void> {
  await query(
    `INSERT INTO system_settings (key, value, description)
     VALUES ($1, $2, 'Web Push VAPID public key (browser push notifications)'),
            ($3, $4, 'Web Push VAPID private key (browser push notifications)')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [SETTINGS_KEYS.publicKey, keys.publicKey, SETTINGS_KEYS.privateKey, keys.privateKey],
  );
}

function configureWebpush(keys: { publicKey: string; privateKey: string }): void {
  if (!webpushConfigured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:support@metricorex.com",
      keys.publicKey,
      keys.privateKey,
    );
    webpushConfigured = true;
  }
}

/**
 * Resolve (or generate + persist) the VAPID keys. Safe to call on every boot.
 * Never throws — Web Push is an enhancement, not a boot blocker.
 */
export async function ensureVapidKeys(): Promise<{ publicKey: string; privateKey: string } | null> {
  if (cachedKeys) {
    configureWebpush(cachedKeys);
    return cachedKeys;
  }

  try {
    const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
    const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
    if (envPublic && envPrivate) {
      cachedKeys = { publicKey: envPublic, privateKey: envPrivate };
    } else {
      const fromSettings = await loadKeysFromSettings();
      if (fromSettings) {
        cachedKeys = fromSettings;
      } else {
        const generated = webpush.generateVAPIDKeys();
        cachedKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
        await persistKeysToSettings(cachedKeys);
        // Operator banner: copy these into .env so keys survive database resets.
        console.log("┌──────────────────────────────────────────────────────────────────┐");
        console.log("│ Web Push (VAPID) keys generated and persisted to system_settings │");
        console.log(`│ VAPID_PUBLIC_KEY=${cachedKeys.publicKey}`);
        console.log(`│ VAPID_PRIVATE_KEY=${cachedKeys.privateKey}`);
        console.log("│ → Copy both into .env so the keys are stable across deployments. │");
        console.log("└──────────────────────────────────────────────────────────────────┘");
      }
    }
    configureWebpush(cachedKeys);
    return cachedKeys;
  } catch (err: any) {
    console.error("[web-push] Failed to bootstrap VAPID keys:", err?.message || err);
    return null;
  }
}

/** Public key for GET /push/vapid-public-key (null when bootstrap failed). */
export async function getVapidPublicKey(): Promise<string | null> {
  const keys = await ensureVapidKeys();
  return keys?.publicKey || null;
}

/** Diagnostics: web-push VAPID keys available (env or persisted settings). */
export function isWebPushConfigured(): boolean {
  if (cachedKeys) return true;
  if (process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim()) return true;
  return false;
}

export interface WebPushPayload {
  type: string;
  [key: string]: unknown;
}

export interface WebPushOptions {
  TTL?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
}

/**
 * Send a Web Push notification to every browser subscription of the given
 * users. Best-effort by design: never throws, removes dead subscriptions
 * (404/410) so the table stays clean.
 */
export async function sendWebPushToUsers(
  userIds: string[],
  payload: WebPushPayload,
  options: WebPushOptions = {},
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  try {
    const keys = await ensureVapidKeys();
    if (!keys) return { sent, failed };
    const ids = (userIds || []).filter(Boolean);
    if (ids.length === 0) return { sent, failed };

    const subs = await query(
      `SELECT id, endpoint, p256dh_key as "p256dhKey", auth_key as "authKey"
       FROM web_push_subscriptions WHERE user_id = ANY($1::uuid[])`,
      [ids],
    );
    if (subs.rows.length === 0) return { sent, failed };

    configureWebpush(keys);
    const pushOptions: webpush.RequestOptions = {
      TTL: options.TTL ?? 60,
      urgency: options.urgency ?? "high",
    };

    for (const sub of subs.rows) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dhKey, auth: sub.authKey },
          },
          JSON.stringify(payload),
          pushOptions,
        );
        sent++;
      } catch (err: any) {
        failed++;
        const statusCode = err?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscription expired/gone — drop it so we don't retry forever.
          await query(`DELETE FROM web_push_subscriptions WHERE id = $1`, [sub.id]).catch(() => {});
        } else {
          console.error("[web-push] sendNotification failed:", statusCode || err?.message);
        }
      }
    }
  } catch (err: any) {
    console.error("[web-push] sendWebPushToUsers error:", err?.message || err);
  }
  return { sent, failed };
}
