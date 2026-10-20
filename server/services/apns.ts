import crypto from "crypto";
import http2 from "http2";

/**
 * Direct Apple APNs provider client — VoIP (PushKit) pushes.
 *
 * WHY THIS EXISTS: incoming-call rings on iOS MUST be delivered as native
 * APNs pushes with `apns-push-type: voip`. FCM (v1 or legacy) CANNOT carry
 * the voip push type at all — an FCM message only wakes PushKit handlers
 * when the app is foregrounded, which is exactly the "Android→iOS call only
 * shows in the notification panel" regression. With this client the backend
 * delivers the VoIP push itself; PushKit wakes the app and AppDelegate
 * reports the call to CallKit for the full-screen native ring.
 *
 * Env (all required for activation, otherwise every send is a no-op):
 *   APNS_KEY_ID     — 10-char key id of the APNs auth key (ASC → Integrations → Keys)
 *   APNS_TEAM_ID    — Apple Developer team id
 *   APNS_BUNDLE_ID  — app bundle id the topic is set to (com.metricorex.app)
 *   APNS_P8_KEY     — the .p8 key. Accepts the full PEM (BEGIN/END PRIVATE KEY)
 *                     or the raw base64 DER body (single line, .env-safe).
 *   APNS_ENV        — "production" (default) or "sandbox".
 *                     TestFlight / App Store builds = production host; debug
 *                     builds run against sandbox.
 *
 * Design notes:
 *  - ES256 JWT (token-based auth) built with node crypto only — no deps.
 *    APNs requires the ECDSA signature as raw r||s (IEEE P1363), while node
 *    emits DER — converted here.
 *  - One fresh HTTP/2 session per send. Reuse would be faster, but call rates
 *    are low and a self-healing connection beats a stale-session edge case.
 *  - Every failure resolves to a status/reason object — callers decide
 *    (e.g. delete the device row on 410 Unregistered). Nothing throws.
 */

const JWT_TTL_MS = 45 * 60 * 1000; // APNs accepts up to 1h; refresh early.

let cachedJwt: { token: string; expiresAt: number } | null = null;

interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKeyPem: string;
  host: string;
}

export function isApnsConfigured(): boolean {
  return Boolean(
    process.env.APNS_KEY_ID &&
      process.env.APNS_TEAM_ID &&
      process.env.APNS_BUNDLE_ID &&
      process.env.APNS_P8_KEY,
  );
}

/** Accepts full PEM or the raw base64 DER body (whitespace/newline tolerant). */
function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) return trimmed.replace(/\\n/g, "\n");
  const base64 = trimmed.replace(/\s+/g, "");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

function loadConfig(): ApnsConfig | null {
  if (!isApnsConfigured()) return null;
  return {
    keyId: process.env.APNS_KEY_ID as string,
    teamId: process.env.APNS_TEAM_ID as string,
    bundleId: process.env.APNS_BUNDLE_ID as string,
    privateKeyPem: normalizePrivateKey(process.env.APNS_P8_KEY as string),
    host:
      String(process.env.APNS_ENV || "production").toLowerCase() === "sandbox"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com",
  };
}

/**
 * DER (ASN.1 SEQUENCE of two INTEGERs) → raw r||s, 32 bytes each (JOSE/ES256).
 * node's sign() returns DER for EC keys; APNs rejects anything else.
 */
function derSignatureToJose(der: Buffer): Buffer {
  let idx = 2;
  if (der[1] & 0x80) idx = 2 + (der[1] & 0x7f);
  const rLen = der[idx + 1];
  let r = der.subarray(idx + 2, idx + 2 + rLen);
  const sOff = idx + 2 + rLen;
  const sLen = der[sOff + 1];
  let s = der.subarray(sOff + 2, sOff + 2 + sLen);
  // INTEGER may carry a leading 0x00 (positive sign pad) — strip it.
  while (r.length > 0 && r[0] === 0) r = r.subarray(1);
  while (s.length > 0 && s[0] === 0) s = s.subarray(1);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

/** ES256 provider token for APNs (header.kid + claims.iss), cached 45 min. */
function providerToken(config: ApnsConfig): string {
  if (cachedJwt && cachedJwt.expiresAt > Date.now()) return cachedJwt.token;

  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "ES256", kid: config.keyId })}.${b64({
    iss: config.teamId,
    iat: now,
  })}`;
  const signer = crypto.createSign("SHA256");
  signer.update(unsigned);
  const der = signer.sign(config.privateKeyPem);
  const jose = derSignatureToJose(der).toString("base64url");
  const token = `${unsigned}.${jose}`;
  cachedJwt = { token, expiresAt: Date.now() + JWT_TTL_MS };
  return token;
}

export interface ApnsSendResult {
  ok: boolean;
  /** APNs HTTP status: 200 ok; 410 = token dead (delete it); 4xx/5xx with reason. */
  status: number;
  reason?: string;
}

/**
 * Send a VoIP push to one PushKit token.
 * The payload body is arbitrary JSON — top-level keys land in
 * PKPushPayload.dictionaryPayload (AppDelegate reads callId/callerName/callType).
 */
export function sendVoipPush(
  voipToken: string,
  payload: Record<string, unknown>,
): Promise<ApnsSendResult> {
  return new Promise((resolve) => {
    const config = loadConfig();
    if (!config) {
      resolve({ ok: false, status: 0, reason: "apns-not-configured" });
      return;
    }
    if (!voipToken || !/^[0-9a-f]{64}$/i.test(voipToken)) {
      resolve({ ok: false, status: 0, reason: "invalid-voip-token" });
      return;
    }

    const body = Buffer.from(JSON.stringify({ aps: {}, ...payload }));
    let settled = false;
    const finish = (result: ApnsSendResult) => {
      if (settled) return;
      settled = true;
      try {
        session.close();
      } catch {}
      resolve(result);
    };

    const session = http2.connect(config.host);
    session.on("error", (err) => {
      console.error("[apns] http2 session error:", err.message);
      finish({ ok: false, status: 0, reason: `session-error:${err.message}` });
    });

    const timeout = setTimeout(() => {
      finish({ ok: false, status: 0, reason: "timeout" });
    }, 8000);
    if (typeof timeout.unref === "function") timeout.unref();

    const req = session.request({
      [http2.constants.HTTP2_HEADER_METHOD]: "POST",
      [http2.constants.HTTP2_HEADER_PATH]: `/3/device/${voipToken}`,
      [http2.constants.HTTP2_HEADER_SCHEME]: "https",
      [http2.constants.HTTP2_HEADER_AUTHORITY]: new URL(config.host).host,
      "apns-push-type": "voip",
      "apns-priority": "10",
      "apns-topic": config.bundleId,
      "content-type": "application/json",
      "content-length": body.length,
      authorization: `bearer ${providerToken(config)}`,
    });

    const chunks: Buffer[] = [];
    req.on("response", (headers) => {
      const status = Number(headers[":status"] || 0);
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        clearTimeout(timeout);
        const reason = (() => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").reason;
          } catch {
            return undefined;
          }
        })();
        finish({ ok: status === 200, status, reason });
      });
    });
    req.on("error", (err) => {
      clearTimeout(timeout);
      console.error("[apns] request error:", err.message);
      finish({ ok: false, status: 0, reason: `request-error:${err.message}` });
    });

    req.write(body);
    req.end();
  });
}

/** Diagnostics: which APNs host a configured client will use. */
export function apnsDeliveryMode(): string {
  if (!isApnsConfigured()) return "none";
  return loadConfig()?.host ?? "none";
}
