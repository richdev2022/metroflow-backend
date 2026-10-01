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
}

/**
 * DATA-ONLY FCM delivery.
 *
 * Messages that carry an FCM `notification` block are displayed by the OS
 * tray on Android/iOS and the app's background handler (FirebaseMessaging
 * onBackgroundMessage) is NEVER invoked for them. Our clients render their
 * own rich notifications (full-screen incoming-call ring, chat style,
 * launcher badge count), so every push must arrive as a pure data message:
 *  - Android: high-priority data message wakes the background isolate.
 *  - iOS:     `content-available: 1` wakes the background handler.
 * `title`/`body` are still folded INTO the data payload so any client-side
 * generic handler can display them.
 */

async function sendToTokens(tokens: string[], payload: PushPayload): Promise<{ sent: number; failed: number }> {
  if (tokens.length === 0) return { sent: 0, failed: 0 };

  // Mode 1: FCM HTTP v1
  const account = loadServiceAccount();
  if (account) {
    const projectId = process.env.FIREBASE_PROJECT_ID || account.project_id;
    if (!projectId) {
      console.error("[push] FIREBASE_PROJECT_ID missing - cannot send via HTTP v1");
      return { sent: 0, failed: tokens.length };
    }
    const accessToken = await getAccessToken();
    if (!accessToken) return { sent: 0, failed: tokens.length };

    // title/body folded into data — clients render notifications themselves.
    const dataPayload: Record<string, string> = {
      ...(payload.data || {}),
      title: payload.title,
      body: payload.body,
    };

    let sent = 0;
    let failed = 0;
    for (const token of tokens) {
      try {
        await axios.post(
          `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
          {
            message: {
              token,
              // NO `notification` block — see the doc comment above. A
              // notification+data message is shown by the OS tray and the
              // app's background handler never runs (no ring, no badge).
              data: dataPayload,
              android: {
                priority: "high",
              },
              apns: {
                headers: { "apns-priority": "5" },
                payload: {
                  aps: {
                    "content-available": 1,
                  },
                },
              },
            },
          },
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
        }
      }
    }
    return { sent, failed };
  }

  // Mode 2: legacy server key
  const serverKey = process.env.FCM_SERVER_KEY;
  if (serverKey) {
    try {
      const res = await axios.post(
        "https://fcm.googleapis.com/fcm/send",
        {
          registration_ids: tokens,
          // Data-only (see doc comment on PushPayload).
          data: { ...(payload.data || {}), title: payload.title, body: payload.body },
          android: { priority: "high" },
          priority: "high",
          content_available: true,
        },
        {
          headers: { Authorization: `key=${serverKey}`, "Content-Type": "application/json" },
          timeout: 15000,
        },
      );
      const sent = Number(res.data?.success) || 0;
      return { sent, failed: tokens.length - sent };
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
