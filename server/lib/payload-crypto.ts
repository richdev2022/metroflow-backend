import crypto from "crypto";

/**
 * End-to-end payload encryption for ALL API endpoints.
 *
 * Goal: a user inspecting the browser network tab must never see raw request
 * or response bodies — every JSON body travels as ciphertext. Admins can
 * decrypt individual logged requests through a permission-gated endpoint.
 *
 * ARCHITECTURE
 * ------------
 * AES-256-GCM envelope encryption with a server-side key distributed to the
 * first-party clients through env vars:
 *
 *   backend : PAYLOAD_ENCRYPTION_KEY   (base64 or hex, 32 bytes)
 *   web     : VITE_PAYLOAD_ENCRYPTION_KEY
 *   admin   : VITE_PAYLOAD_ENCRYPTION_KEY
 *   mobile  : EXPO_PUBLIC_PAYLOAD_ENCRYPTION_KEY (flutter_dotenv asset)
 *
 * Wire format (JSON object — survives every JSON body parser):
 *   { "v": 1, "iv": <b64 12B>, "tag": <b64 16B>, "ct": <b64 ciphertext> }
 *
 * Protocol:
 *   - Clients that have a key send `x-mfv-enc: 1` + an encrypted envelope.
 *   - The server decrypts the request body (middleware AFTER express.json,
 *     so `req.body` becomes the plaintext object for every handler) and
 *     wraps `res.json` so EVERY JSON response — success and error — is
 *     returned as an envelope, and sets `x-mfv-enc: 1` on the response.
 *   - Clients without a key (old builds, curl, third parties) are unaffected:
 *     no header => plaintext in, plaintext out.
 *   - Multipart uploads, raw streaming bodies and provider webhooks bypass
 *     encryption (files are already encrypted in transit by TLS and webhook
 *     signatures require the raw body).
 *
 * Requests/responses are mirrored into `api_request_logs` (payloads stored
 * ENCRYPTED at rest); only admins holding `decrypt_request_logs` (or super
 * admins) can decrypt a log entry through POST /admin/request-logs/:id/decrypt.
 */

const ENVELOPE_VERSION = 1;

export interface EncryptedEnvelope {
  v: number;
  iv: string;
  tag: string;
  ct: string;
}

let cachedKey: Buffer | null | undefined;

/** 32-byte key from PAYLOAD_ENCRYPTION_KEY (base64 or hex). undefined => not configured. */
function loadKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.PAYLOAD_ENCRYPTION_KEY || "";
  if (!raw.trim()) {
    cachedKey = null;
    return cachedKey;
  }
  const trimmed = raw.trim();
  try {
    let key: Buffer | null = null;
    if (/^[0-9a-f]{64}$/i.test(trimmed)) {
      key = Buffer.from(trimmed, "hex");
    } else {
      const b64 = Buffer.from(trimmed, "base64");
      if (b64.length === 32) key = b64;
    }
    if (!key || key.length !== 32) {
      console.error(
        "[payload-crypto] PAYLOAD_ENCRYPTION_KEY ignored: expected 32 bytes (base64 or 64 hex chars). " +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
      cachedKey = null;
      return cachedKey;
    }
    cachedKey = key;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

export function isPayloadEncryptionEnabled(): boolean {
  if (process.env.PAYLOAD_ENCRYPTION_DISABLED === "true") return false;
  return loadKey() !== null;
}

export function encryptJson(value: unknown): EncryptedEnvelope {
  const key = loadKey();
  if (!key) throw new Error("PAYLOAD_ENCRYPTION_KEY is not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? null), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: ENVELOPE_VERSION, iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") };
}

export function decryptJson<T = any>(envelope: EncryptedEnvelope): T {
  const key = loadKey();
  if (!key) throw new Error("PAYLOAD_ENCRYPTION_KEY is not configured");
  if (!envelope || envelope.v !== ENVELOPE_VERSION || !envelope.iv || !envelope.tag || !envelope.ct) {
    throw new Error("Malformed encrypted payload envelope");
  }
  const iv = Buffer.from(String(envelope.iv), "base64");
  const tag = Buffer.from(String(envelope.tag), "base64");
  const ct = Buffer.from(String(envelope.ct), "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Malformed encrypted payload envelope");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/** Encrypt an arbitrary string (used to store log payloads at rest). */
export function encryptString(plaintext: string): string {
  const key = loadKey();
  if (!key) throw new Error("PAYLOAD_ENCRYPTION_KEY is not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt a stored log payload. Returns null when the blob is not decryptable. */
export function decryptString(blob: string): string | null {
  try {
    const key = loadKey();
    if (!key) return null;
    const parts = String(blob || "").split(":");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const ct = Buffer.from(parts[3], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function looksLikeEncryptedEnvelope(body: any): body is EncryptedEnvelope {
  return (
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    body.v === ENVELOPE_VERSION &&
    typeof body.iv === "string" &&
    typeof body.tag === "string" &&
    typeof body.ct === "string"
  );
}

/** Encrypt a JSON-serialisable value into a wire envelope object. */
export function encryptBody(value: unknown): EncryptedEnvelope {
  return encryptJson(value);
}
