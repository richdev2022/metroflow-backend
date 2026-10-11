import crypto from "crypto";
import http2 from "http2";

/**
 * Minimal APNs client with token-based (.p8) auth — used for iOS VoIP pushes.
 *
 * WHY THIS EXISTS: FCM cannot deliver PushKit/VoIP pushes. Incoming-call
 * ringing on iOS when the app is backgrounded/terminated REQUIRES a VoIP
 * push sent DIRECTLY to APNs against the PushKit token the app registers.
 * The VoIP push wakes the app and the native side reports the call to
 * CallKit — the full-screen native ring UI the user expects (WhatsApp-style).
 *
 * Configuration (env — never commit the key itself):
 *   APNS_KEY_ID    — key id of the .p8 signing key (App Store Connect → Keys)
 *   APNS_TEAM_ID   — Apple Developer team id
 *   APNS_P8_KEY    — the .p8 PEM (raw multiline or base64-encoded)
 *   APNS_BUNDLE_ID — e.g. com.metricorex.app
 *   APNS_HOST      — optional; defaults to api.push.apple.com
 *                    (sandbox api.sandbox.push.apple.com is NOT used —
 *                    distribution builds always hit the production host)
 *
 * Everything degrades gracefully: when unconfigured, iOS keeps the existing
 * FCM alert behaviour (banner + sound) and callers are no worse off.
 */

let cachedKey: string | null | undefined;
let cachedToken: { jwt: string; expiresAt: number } | null = null;

interface ApnsConfig {
  keyId: string;
  teamId: string;
  p8: string;
  bundleId: string;
  host: string;
}

function loadP8(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = (process.env.APNS_P8_KEY || "").trim();
  if (!raw) {
    cachedKey = null;
    return null;
  }
  // Accept the PEM as-is (with \n escapes or real newlines) or base64.
  let pem = raw.includes("BEGIN PRIVATE KEY") ? raw.replace(/\\n/g, "\n") : "";
  if (!pem) {
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      if (decoded.includes("BEGIN PRIVATE KEY")) pem = decoded;
    } catch {
      /* not base64 */
    }
  }
  if (!pem) {
    // Raw single-line key content without headers — wrap it.
    const body = raw.replace(/\\n/g, "").replace(/\n/g, "");
    if (body.length > 100 && /^[A-Za-z0-9+/=\r\n-]+$/.test(body)) {
      pem = `-----BEGIN PRIVATE KEY-----\n${body.replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
    }
  }
  cachedKey = pem || null;
  return cachedKey;
}

export function getApnsConfig(): ApnsConfig | null {
  const keyId = (process.env.APNS_KEY_ID || "").trim();
  const teamId = (process.env.APNS_TEAM_ID || "").trim();
  const bundleId = (process.env.APNS_BUNDLE_ID || "com.metricorex.app").trim();
  const host = (process.env.APNS_HOST || "api.push.apple.com").trim();
  const p8 = loadP8();
  if (!keyId || !teamId || !p8) return null;
  return { keyId, teamId, p8, bundleId, host };
}

export function isApnsVoipConfigured(): boolean {
  return getApnsConfig() !== null;
}

function providerToken(cfg: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.jwt;
  const header = { alg: "ES256", kid: cfg.keyId };
  const claims = { iss: cfg.teamId, iat: now };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64(header)}.${b64(claims)}`;
  // ES256 = ECDSA P-256 over SHA-256: createSign("SHA256") + .update(data)
  // + .sign(pem) does exactly that in one step (Node hashes, then signs).
  const signature = crypto.createSign("SHA256").update(unsigned).sign(cfg.p8, "base64url");
  const jwt = `${unsigned}.${signature}`;
  cachedToken = { jwt, expiresAt: now + 1800 };
  return jwt;
}

export interface VoipPushResult {
  ok: boolean;
  status: number | null;
  reason?: string;
  /** true when APNs answered 410/404 — the token is dead and must be pruned. */
  prune?: boolean;
}

/**
 * Send a VoIP push for an incoming call. The payload contract with the app:
 *   { aps: { alert: {...}, sound }, callId, callType, callerName, callerId,
 *     callCode, isGroupCall }
 * The app's PushKit delegate MUST report this to CallKit immediately.
 */
export async function sendVoipPush(
  voipToken: string,
  payload: Record<string, unknown>,
  ttlSeconds = 45,
): Promise<VoipPushResult> {
  const cfg = getApnsConfig();
  if (!cfg) return { ok: false, status: null, reason: "APNs not configured" };

  const body = JSON.stringify({
    aps: {
      alert: (payload.alert as object) || { title: "", body: "" },
      // CallKit renders its own ring UI + sound; this keeps the lock screen
      // audible for the brief moment before CallKit takes over.
      sound: "call_ringtone.caf",
      ...(payload.aps as object | undefined),
    },
    ...payload,
  });

  return new Promise<VoipPushResult>((resolve) => {
    let settled = false;
    const done = (r: VoipPushResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const client = http2.connect(`https://${cfg.host}`);
      client.on("error", (err) => {
        done({ ok: false, status: null, reason: `h2 error: ${err.message}` });
        try { client.close(); } catch {}
      });
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${voipToken}`,
        authorization: `bearer ${providerToken(cfg)}`,
        "apns-topic": `${cfg.bundleId}.voip`,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + ttlSeconds),
      });
      req.setEncoding("utf8");
      let respBody = "";
      req.on("response", (headers) => {
        const status = Number(headers[":status"] || 0);
        req.on("data", (chunk: string) => { respBody += chunk; });
        req.on("end", () => {
          done({
            ok: status === 200,
            status,
            ...(status !== 200 ? { reason: respBody.slice(0, 300) || `HTTP ${status}` } : {}),
            prune: status === 410 || status === 404,
          });
          try { client.close(); } catch {}
        });
      });
      req.on("error", (err) => {
        done({ ok: false, status: null, reason: err.message });
        try { client.close(); } catch {}
      });
      req.end(body);
      // Never hang a call ring on a stuck connection.
      setTimeout(() => done({ ok: false, status: null, reason: "timeout" }), 10_000).unref();
    } catch (err: any) {
      done({ ok: false, status: null, reason: err?.message || "send failed" });
    }
  });
}

/** Send a VoIP push to every iOS device of the given users. Prunes dead tokens. */
export async function sendVoipToUsers(
  userIds: string[],
  payload: Record<string, unknown>,
): Promise<{ sent: number; failed: number }> {
  if (!isApnsVoipConfigured()) return { sent: 0, failed: 0 };
  if (userIds.length === 0) return { sent: 0, failed: 0 };
  try {
    const { query } = await import("../db");
    const res = await query(
      `SELECT user_id, voip_token FROM user_devices
        WHERE user_id = ANY($1) AND voip_token IS NOT NULL AND platform ILIKE 'ios'`,
      [userIds],
    );
    let sent = 0;
    let failed = 0;
    await Promise.all(
      res.rows.map(async (row: any) => {
        const r = await sendVoipPush(row.voip_token, payload);
        if (r.ok) {
          sent += 1;
        } else {
          failed += 1;
          if (r.prune) {
            await query(`UPDATE user_devices SET voip_token = NULL WHERE voip_token = $1`, [row.voip_token]).catch(() => {});
          }
          if (!r.ok && r.reason) {
            console.warn(`[apns] voip push failed (${String(row.voip_token).slice(0, 12)}…): ${r.reason}`);
          }
        }
      }),
    );
    return { sent, failed };
  } catch (err: any) {
    console.warn("[apns] sendVoipToUsers failed:", err?.message);
    return { sent: 0, failed: 0 };
  }
}
