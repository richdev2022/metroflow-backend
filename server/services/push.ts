import axios from "axios";
import fs from "fs";
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

/**
 * Service-account loading that survives real-world .env damage:
 *  - FIREBASE_SERVICE_ACCOUNT_JSON as raw JSON (single line or quoted)
 *  - FIREBASE_SERVICE_ACCOUNT_JSON as base64 (recommended for .env — single line, no escaping)
 *  - FIREBASE_SERVICE_ACCOUNT_FILE / GOOGLE_APPLICATION_CREDENTIALS pointing at the JSON file
 *    (RECOMMENDED overall: immune to .env line-splitting entirely)
 *
 * A multi-line JSON pasted directly into .env is BROKEN by design (dotenv reads
 * line-by-line, so only `{` survives). We detect that exact shape and return a
 * loud, actionable error instead of failing later with a cryptic JSON.parse position.
 */
export interface ServiceAccountLoadResult {
  account: ServiceAccount | null;
  source: "env-json" | "env-base64" | "file" | null;
  error: string | null;
  /** True when the env value looks like a multi-line JSON paste that got line-truncated. */
  multilineEnvSuspected?: boolean;
}

const MULTILINE_FIX_HINT =
  "FIX: on the server run `cd ~/metroflow-backend && node scripts/fix-firebase-env.mjs` " +
  "(writes firebase-service-account.json + rewrites .env safely), then `pm2 restart metroflow --update-env`. " +
  "Alternative: put the JSON on ONE line, or base64 it: `base64 -w0 service-account.json` into FIREBASE_SERVICE_ACCOUNT_JSON, " +
  "or point FIREBASE_SERVICE_ACCOUNT_FILE at the JSON file.";

interface ServiceAccountLoadCache {
  fingerprint: string;
  result: ServiceAccountLoadResult;
}
let loadCache: ServiceAccountLoadCache | null = null;

function envFingerprint(): string {
  return [
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "",
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE || "",
    process.env.GOOGLE_APPLICATION_CREDENTIALS || "",
  ].join("|");
}

function parseServiceAccountJson(json: string): ServiceAccount | null {
  const parsed = JSON.parse(json);
  if (parsed && parsed.client_email && parsed.private_key) return parsed as ServiceAccount;
  throw new Error("JSON is missing client_email or private_key");
}

function loadServiceAccountUncached(): ServiceAccountLoadResult {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (raw && raw.trim()) {
    const trimmed = raw.trim().replace(/^["']|["']$/g, "").trim();
    // Path 1: inline JSON
    if (trimmed.startsWith("{")) {
      try {
        return { account: parseServiceAccountJson(trimmed), source: "env-json", error: null };
      } catch (err: any) {
        // dotenv keeps only the FIRST line of a pasted multi-line JSON — the classic
        // signature is a value that starts with '{' but fails to parse immediately.
        const truncated = trimmed === "{" || trimmed.length < 2 || /position 1|Expected property name/i.test(String(err?.message || ""));
        return {
          account: null,
          source: null,
          error:
            `FIREBASE_SERVICE_ACCOUNT_JSON failed to parse: ${err?.message || err}. ` +
            (truncated
              ? `This looks like a MULTI-LINE JSON pasted into .env (only the first line survived). ${MULTILINE_FIX_HINT}`
              : MULTILINE_FIX_HINT),
          multilineEnvSuspected: truncated,
        };
      }
    }
    // Path 2: base64 (single line, .env-safe)
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8");
      const account = parseServiceAccountJson(decoded);
      return { account, source: "env-base64", error: null };
    } catch (err: any) {
      return {
        account: null,
        source: null,
        error:
          `FIREBASE_SERVICE_ACCOUNT_JSON is neither valid JSON nor valid base64 of JSON: ${err?.message || err}. ${MULTILINE_FIX_HINT}`,
      };
    }
  }

  // Path 3: JSON file on disk (best practice)
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (filePath) {
    try {
      const account = parseServiceAccountJson(fs.readFileSync(filePath, "utf8"));
      return { account, source: "file", error: null };
    } catch (err: any) {
      return {
        account: null,
        source: null,
        error: `Failed to load service account file (${filePath}): ${err?.message || err}`,
      };
    }
  }

  return { account: null, source: null, error: null };
}

function loadServiceAccountDetailed(): ServiceAccountLoadResult {
  const fingerprint = envFingerprint();
  if (loadCache && loadCache.fingerprint === fingerprint) return loadCache.result;
  const result = loadServiceAccountUncached();
  loadCache = { fingerprint, result };
  if (result.error) {
    console.error(`[push] ${result.error}`);
  }
  return result;
}

function loadServiceAccount(): ServiceAccount | null {
  return loadServiceAccountDetailed().account;
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

/** Full diagnostics for status endpoints — includes the actionable parse error. */
export function getPushServiceAccountDiagnostics(): ServiceAccountLoadResult {
  return loadServiceAccountDetailed();
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
  /**
   * ANDROID data-only: skip the FCM system-tray notification block so the
   * app's own handlers render the rich UI (full-screen ringing call with
   * Accept/Decline). iOS is unaffected — it keeps its APNs alert.
   */
  androidDataOnly?: boolean;
  // Max-priority call rendering for the ANDROID system-tray notification:
  // category "call" + PRIORITY_MAX (heads-up over everything, alarm-channel
  // sound). Used by the incoming-call visible fallback so a swiped-away app
  // still rings loudly even when its own full-screen render never ran.
  androidCallStyle?: boolean;
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
let pushMismatchWarned = false;

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

/** Per-token delivery outcome, filled when the caller passes a diagnostics array. */
export interface PushSendDiagnostic {
  tokenPreview: string;
  platform: string;
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
}

async function sendToTokens(
  tokens: string[],
  payload: PushPayload,
  diagnostics?: PushSendDiagnostic[],
): Promise<{ sent: number; failed: number }> {
  if (tokens.length === 0) return { sent: 0, failed: 0 };

  // Platform lookup once for the whole batch (diagnostics + prune logs below).
  let platformByToken = new Map<string, string>();
  try {
    const platRes = await query(
      `SELECT fcm_token, platform FROM user_devices WHERE fcm_token = ANY($1)`,
      [tokens],
    );
    platformByToken = new Map(
      platRes.rows.map((r: any) => [r.fcm_token, String(r.platform || "unknown")]),
    );
  } catch {
    // Table missing / DB hiccup — diagnostics just report "unknown".
  }

  // Mode 1: FCM HTTP v1
  const account = loadServiceAccount();
  if (account) {
    const projectId = resolveProjectId(account);
    if (!projectId) {
      console.error("[push] FIREBASE_PROJECT_ID missing - cannot send via HTTP v1");
      diagnostics?.push(
        ...tokens.map((t) => ({
          tokenPreview: t.slice(0, 18),
          platform: platformByToken.get(t) || "unknown",
          ok: false,
          httpStatus: null,
          error: "FIREBASE_PROJECT_ID missing — cannot send via HTTP v1",
        })),
      );
      return { sent: 0, failed: tokens.length };
    }
    const accessToken = await getAccessToken();
    if (!accessToken) {
      diagnostics?.push(
        ...tokens.map((t) => ({
          tokenPreview: t.slice(0, 18),
          platform: platformByToken.get(t) || "unknown",
          ok: false,
          httpStatus: null,
          error: "Failed to obtain Google OAuth access token — check FIREBASE_SERVICE_ACCOUNT_JSON",
        })),
      );
      return { sent: 0, failed: tokens.length };
    }

    // title/body folded into data — clients render/handle them either way.
    const dataPayload: Record<string, string> = {
      ...(payload.data || {}),
      title: payload.title,
      body: payload.body,
    };
    const badgeRaw = dataPayload.badge ? parseInt(String(dataPayload.badge), 10) : NaN;

    // Split tokens by platform so each OS gets the strategy it needs
    // (reuses the single platform lookup from above).
    const iosTokens = new Set(
      [...platformByToken.entries()]
        .filter(([, platform]) => platform.toLowerCase().startsWith("ios"))
        .map(([token]) => token),
    );

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
                // stay data-only so nothing shows. androidDataOnly pushes
                // (incoming calls) also stay data-only: the app renders the
                // full-screen ringing UI itself from the data payload.
                ...(!isSilent && payload.androidDataOnly !== true
                  ? {
                      notification: {
                        title: payload.title,
                        body: payload.body,
                        channel_id: payload.androidChannelId || "general",
                        ...(payload.collapseKey ? { tag: payload.collapseKey } : {}),
                        ...(payload.androidCallStyle === true
                          ? { notification_priority: "PRIORITY_MAX", category: "call" as const }
                          : {}),
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
        diagnostics?.push({
          tokenPreview: token.slice(0, 18),
          platform: platformByToken.get(token) || "unknown",
          ok: true,
          httpStatus: 200,
          error: null,
        });
      } catch (err: any) {
        failed++;
        const status = err.response?.status;
        const fcmError = JSON.stringify(err.response?.data?.error || err.message).slice(0, 300);
        diagnostics?.push({
          tokenPreview: token.slice(0, 18),
          platform: platformByToken.get(token) || "unknown",
          ok: false,
          httpStatus: status ?? null,
          error: fcmError,
        });
        if (status === 404 || status === 410) {
          // Token no longer valid — remove it, but leave a paper trail so
          // "my device disappeared from push-status" is diagnosable.
          try {
            const freshRes = await query(
              `SELECT created_at, last_seen_at FROM user_devices WHERE fcm_token = $1`,
              [token],
            );
            const row = freshRes.rows[0];
            const freshMs = row
              ? Date.now() - new Date(row.last_seen_at || row.created_at).getTime()
              : Infinity;
            await query(`DELETE FROM user_devices WHERE fcm_token = $1`, [token]);
            console.error(
              `[push] pruned invalid token (${platformByToken.get(token) || "unknown"}, ` +
                `${token.slice(0, 12)}…) status=${status} fcm=${fcmError}`,
            );
            // A token registered MINUTES ago that already 404s is almost never
            // "stale" — it is a Firebase PROJECT MISMATCH (the app fetched its
            // token from a different project than FIREBASE_PROJECT_ID) or an
            // APNs key missing on the Firebase console (iOS). Shout once per
            // process so the operator sees it.
            if (freshMs < 15 * 60_000 && !pushMismatchWarned) {
              pushMismatchWarned = true;
              console.error(
                `[push] ⚠️ FRESH token pruned with ${status} — this is a CONFIG problem, not a stale device. ` +
                  `Backend sends to project "${projectId}". The apps' project lives in ` +
                  `android/app/google-services.json + ios/Runner/GoogleService-Info.plist — ` +
                  `project_id / PROJECT_ID there MUST equal FIREBASE_PROJECT_ID. iOS also needs ` +
                  `an APNs auth key uploaded in the Firebase console. Until they match, EVERY ` +
                  `push 404s and devices keep disappearing from user_devices.`,
              );
            }
          } catch (pruneErr: any) {
            console.error(`[push] prune failed:`, pruneErr?.message || pruneErr);
          }
        } else {
          console.error(
            `[push] send failed (${platformByToken.get(token) || (isIos ? "ios" : "android")}) status=${status || "?"}:`,
            fcmError,
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
      const androidDataOnly = payload.androidDataOnly === true;
      await axios.post(
        "https://fcm.googleapis.com/fcm/send",
        {
          registration_ids: tokens,
          data: { ...(payload.data || {}), title: payload.title, body: payload.body },
          // Visible: system-tray notification (see the HTTP v1 doc above).
          // Silent / androidDataOnly: data-only, nothing rendered system-side.
          ...(!isSilent && !androidDataOnly
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
      diagnostics?.push(
        ...tokens.map((t) => ({
          tokenPreview: t.slice(0, 18),
          platform: platformByToken.get(t) || "unknown",
          ok: true,
          httpStatus: 200 as number | null,
          error: null as string | null,
        })),
      );
      return { sent: tokens.length, failed: 0 };
    } catch (err: any) {
      console.error("[push] FCM legacy send failed:", err.response?.data || err.message);
      diagnostics?.push(
        ...tokens.map((t) => ({
          tokenPreview: t.slice(0, 18),
          platform: platformByToken.get(t) || "unknown",
          ok: false,
          httpStatus: (err.response?.status ?? null) as number | null,
          error: String(err.response?.data || err.message).slice(0, 300),
        })),
      );
    }
  }
  // Neither mode configured — nothing went out.
  diagnostics?.push(
    ...tokens.map((t) => ({
      tokenPreview: t.slice(0, 18),
      platform: platformByToken.get(t) || "unknown",
      ok: false,
      httpStatus: null,
      error: "Push NOT configured (FIREBASE_SERVICE_ACCOUNT_JSON / FCM_SERVER_KEY missing)",
    })),
  );
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
