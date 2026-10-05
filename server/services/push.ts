import axios from "axios";
import { query } from "../db";
import { createNotification } from "./notifications";

/**
 * Push notifications (FCM).
 *
 * Works in two modes:
 *  1. FCM HTTP v1 with a Google service account (recommended).
 *     Set FIREBASE_SERVICE_ACCOUNT_JSON to the full JSON (or base64 of it)
 *     and FIREBASE_PROJECT_ID.
 *  2. Legacy FCM server key: set FCM_SERVER_KEY (authorization-key API).
 *
 * If neither is configured the push is skipped gracefully - in-app
 * notifications via sockets still fire, so nothing breaks.
 */

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (parsed.client_email && parsed.private_key) return parsed;
    return null;
  } catch (err) {
    console.error("[push] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", err);
    return null;
  }
}

export function isPushConfigured(): boolean {
  return Boolean(loadServiceAccount() || process.env.FCM_SERVER_KEY);
}

/** Diagnostics: which FCM delivery path will actually be used. */
export function pushDeliveryMode(): "http-v1" | "legacy" | "none" {
  if (loadServiceAccount()) return "http-v1";
  if (process.env.FCM_SERVER_KEY) return "legacy";
  return "none";
}

async function getAccessToken(): Promise<string | null> {
  const account = loadServiceAccount();
  if (!account) return null;

  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  try {
    const jwt = await createGoogleJwt(account);
    const res = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
      { timeout: 15000 },
    );
    const token = res.data?.access_token;
    if (!token) return null;
    cachedAccessToken = { token, expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000 };
    return token;
  } catch (err: any) {
    console.error("[push] Failed to obtain Google access token:", err.response?.data || err.message);
    return null;
  }
}

/** Minimal RS256 JWT signer (avoids adding firebase-admin dependency). */
async function createGoogleJwt(account: ServiceAccount): Promise<string> {
  const crypto = await import("crypto");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const b64 = (obj: any) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64(header)}.${b64(claims)}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(account.private_key.replace(/\\n/g, "\n"), "base64url");
  return `${unsigned}.${signature}`;
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  /** High priority data-only messages wake the app for incoming calls. */
  androidChannelId?: string;
  /** Per-platform expiry (seconds) — stale calls/messages must die quietly. */
  ttlSeconds?: number;
  /** Collapse key so a re-ring REPLACES the queued notification, not stacks. */
  collapseKey?: string;
  /**
   * Silent device-side signal (e.g. call-cancelled): delivered as data-only
   * on BOTH platforms — no tray banner, no sound. Android also drops it
   * when the app was force-stopped, which is acceptable for cleanup pushes.
   */
  silent?: boolean;
}

/**
 * PLATFORM-AWARE FCM delivery.
 *
 * A single delivery strategy cannot serve both OSes:
 *
 *  - ANDROID (visible pushes): HYBRID — a real `notification` payload is what
 *    WhatsApp-style delivery needs. Android data-only messages are silently
 *    DROPPED by many OEM launchers (and by force-stop) when the app was
 *    swiped away — the exact "mobile-to-mobile call/chat never shows in the
 *    notification panel and never rings" regression. FCM itself renders the
 *    tray notification on the given channel even with the process dead:
 *    the app pre-creates "calls" (looping-capable ringtone + alarm usage, so
 *    an incoming call rings on the lock screen) and "general" (messages).
 *    The data payload still rides along for tap deep-links and the app's
 *    foreground handler skips its own local notification when
 *    message.notification != null, so nothing duplicates.
 *
 *  - ANDROID (silent pushes, `silent: true`): data-only — no tray UI.
 *
 *  - IOS (visible pushes): HYBRID — a real `aps.alert` (apns-push-type:
 *    alert, apns-priority: 10) that APNs displays system-side no matter
 *    what state the app is in, PLUS the full data payload so a tap still
 *    deep-links.
 *
 *  - IOS (silent pushes): content-available background push (priority 5,
 *    push-type background) — the app's handler runs state cleanup only.
 */

let pushProjectLogged = false;
let isPushUnconfiguredLogged = false;

function resolveProjectId(account: ServiceAccount | null): string | null {
  const projectId = process.env.FIREBASE_PROJECT_ID || account?.project_id || null;
  if (projectId && !pushProjectLogged) {
    pushProjectLogged = true;
    console.log(
      `[push] FCM HTTP v1 active for project "${projectId}". Mobile devices register tokens ` +
        `from THEIR Firebase project — if this is not the same project (currently expected: ` +
        `project-65e11808-f15a-47a5-b68), every send will 404 and tokens get pruned.`,
    );
  }
  return projectId;
}

async function sendToTokens(tokens: string[], payload: PushPayload): Promise<{ sent: number; failed: number }> {
  if (tokens.length === 0) return { sent: 0, failed: 0 };

  // Mode 1: FCM HTTP v1
  const account = loadServiceAccount();
  if (account) {
    const projectId = resolveProjectId(account);
    if (!projectId) {
      console.error("[push] FIREBASE_PROJECT_ID missing - cannot send via HTTP v1");
      return { sent: 0, failed: tokens.length };
    }
    const accessToken = await getAccessToken();
    if (!accessToken) return { sent: 0, failed: tokens.length };

    // title/body folded into data — clients render/handle them either way.
    const dataPayload: Record<string, string> = {
      ...(payload.data || {}),
      title: payload.title,
      body: payload.body,
    };
    const badgeRaw = dataPayload.badge ? parseInt(String(dataPayload.badge), 10) : NaN;

    // Split tokens by platform so each OS gets the strategy it needs.
    let iosTokens = new Set<string>();
    try {
      const platRes = await query(
        `SELECT fcm_token, platform FROM user_devices WHERE fcm_token = ANY($1)`,
        [tokens],
      );
      iosTokens = new Set(
        platRes.rows
          .filter((r: any) => String(r.platform || "").toLowerCase().startsWith("ios"))
          .map((r: any) => r.fcm_token),
      );
    } catch {
      // Table missing / DB hiccup — default everything to Android strategy.
    }

    let sent = 0;
    let failed = 0;
    // Expiry + collapse: a queued ring that arrives after its useful window
    // must be dropped by the OS, and a re-ring must replace (not stack).
    const apnsExpiration = payload.ttlSeconds
      ? String(Math.floor(Date.now() / 1000) + payload.ttlSeconds)
      : null;
    const isSilent = payload.silent === true;
    for (const token of tokens) {
      const isIos = iosTokens.has(token);
      try {
        const message: any = isIos
          ? (isSilent
              ? {
                  token,
                  data: dataPayload,
                  apns: {
                    headers: {
                      "apns-priority": "5",
                      "apns-push-type": "background",
                      ...(apnsExpiration ? { "apns-expiration": apnsExpiration } : {}),
                      ...(payload.collapseKey ? { "apns-collapse-id": payload.collapseKey } : {}),
                    },
                    payload: { aps: { "content-available": 1 } },
                  },
                }
              : {
                  token,
                  data: dataPayload,
                  apns: {
                    headers: {
                      "apns-priority": "10",
                      "apns-push-type": "alert",
                      ...(apnsExpiration ? { "apns-expiration": apnsExpiration } : {}),
                      ...(payload.collapseKey ? { "apns-collapse-id": payload.collapseKey } : {}),
                    },
                    payload: {
                      aps: {
                        alert: { title: payload.title, body: payload.body },
                        sound: "default",
                        "interruption-level": "time-sensitive",
                        ...(Number.isFinite(badgeRaw) && badgeRaw > 0 ? { badge: badgeRaw } : {}),
                        "thread-id": String(dataPayload.type || "general"),
                      },
                    },
                  },
                })
          : {
              token,
              data: dataPayload,
              android: {
                priority: "high",
                ...(payload.ttlSeconds ? { ttl: `${payload.ttlSeconds}s` } : {}),
                ...(payload.collapseKey ? { collapse_key: payload.collapseKey } : {}),
                // Visible pushes: FCM posts the system-tray notification
                // itself (heads-up, lock screen, channel sound) — reliable
                // even when the receiving app was swiped away. Silent pushes
                // stay data-only so nothing shows.
                ...(!isSilent
                  ? {
                      notification: {
                        title: payload.title,
                        body: payload.body,
                        channel_id: payload.androidChannelId || "general",
                        ...(payload.collapseKey ? { tag: payload.collapseKey } : {}),
                        ...(Number.isFinite(badgeRaw) && badgeRaw > 0
                          ? { notification_count: badgeRaw }
                          : {}),
                      },
                    }
                  : {}),
              },
            };

        await axios.post(
          `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
          { message },
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000,
          },
        );
        sent++;
      } catch (err: any) {
        failed++;
        const status = err.response?.status;
        if (status === 404 || status === 410) {
          // Token no longer valid - remove it
          await query(`DELETE FROM user_devices WHERE fcm_token = $1`, [token]).catch(() => {});
        } else {
          console.error(
            `[push] send failed (${isIos ? "ios" : "android"}) status=${status || "?"}:`,
            JSON.stringify(err.response?.data?.error || err.message).slice(0, 300),
          );
        }
      }
    }
    return { sent, failed };
  }

  // Mode 2: legacy server key
  const serverKey = process.env.FCM_SERVER_KEY;
  if (serverKey) {
    try {
      const isSilent = payload.silent === true;
      await axios.post(
        "https://fcm.googleapis.com/fcm/send",
        {
          registration_ids: tokens,
          data: { ...(payload.data || {}), title: payload.title, body: payload.body },
          // Visible: system-tray notification (see the HTTP v1 doc above).
          // Silent: data-only, nothing rendered.
          ...(!isSilent
            ? {
                notification: {
                  title: payload.title,
                  body: payload.body,
                  ...(payload.androidChannelId ? { android_channel_id: payload.androidChannelId } : {}),
                  ...(payload.collapseKey ? { tag: payload.collapseKey } : {}),
                },
              }
            : {}),
          android: { priority: "high" },
          priority: "high",
          content_available: true,
        },
        {
          headers: { Authorization: `key=${serverKey}`, "Content-Type": "application/json" },
          timeout: 15000,
        },
      );
      // Success/failure per-token is not granular here; count as delivered.
      return { sent: tokens.length, failed: 0 };
    } catch (err: any) {
      console.error("[push] FCM legacy send failed:", err.response?.data || err.message);
    }
  }
  return { sent: 0, failed: tokens.length };
}

export interface PushTarget {
  userId: string;
  businessId?: string;
}

/**
 * Send a push to every registered device of the given users and mirror an
 * in-app notification. Best-effort: never throws.
 */
export async function sendPushToUsers(
  users: PushTarget[],
  payload: PushPayload,
  options: { inApp?: boolean; type?: string; businessId?: string } = {},
): Promise<{ sent: number; failed: number; users: number }> {
  const { inApp = true, type = "push" } = options;
  let sent = 0;
  let failed = 0;
  let reachedUsers = 0;

  for (const target of users) {
    try {
      if (inApp) {
        const bid = target.businessId || options.businessId;
        if (bid) {
          await createNotification({
            businessId: bid,
            userId: target.userId,
            type,
            title: payload.title,
            message: payload.body,
            metadata: payload.data,
          }).catch(() => {});
        }
      }

      const tokensRes = await query(`SELECT fcm_token FROM user_devices WHERE user_id = $1`, [target.userId]);
      const tokens = tokensRes.rows.map((r: any) => r.fcm_token).filter(Boolean);
      if (tokens.length > 0) {
        const result = await sendToTokens(tokens, payload);
        sent += result.sent;
        failed += result.failed;
        if (result.sent > 0) reachedUsers++;
      } else if (!isPushUnconfiguredLogged) {
        // Silent zero-token skips made "no notifications" undiagnosable. Log
        // ONCE (rate-limited) with the reason so a missing device registration
        // or unconfigured FCM shows up in the logs immediately.
        isPushUnconfiguredLogged = true;
        console.warn(
          `[push] no FCM tokens registered for user ${target.userId} (${payload.data?.type || type}) — ` +
            `device never registered via /notifications/register-device, or FCM is ` +
            `${isPushConfigured() ? "configured" : "NOT configured (FIREBASE_SERVICE_ACCOUNT_JSON missing)"}`
        );
      }
    } catch (err: any) {
      console.error("[push] sendPushToUsers error:", err.message);
    }
  }

  return { sent, failed, users: reachedUsers };
}

/** Push to every user with at least one registered device. */
export async function sendPushToAll(payload: PushPayload, type: string = "broadcast"): Promise<{ sent: number; failed: number; users: number }> {
  const usersRes = await query(`SELECT DISTINCT user_id FROM user_devices`);
  const targets: PushTarget[] = usersRes.rows.map((r: any) => ({ userId: r.user_id }));
  return sendPushToUsers(targets, payload, { inApp: false, type });
}

export { sendToTokens };
