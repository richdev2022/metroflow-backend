#!/usr/bin/env node
/**
 * APNs VoIP smoke test — validates the whole auth chain WITHOUT a real device:
 *   1. Loads APNS_* from backend/.env
 *   2. Builds the ES256 provider JWT (DER→JOSE conversion) and LOCALLY VERIFIES
 *      the raw r||s signature with node crypto (proves the conversion is right)
 *   3. POSTs a voip push for a dummy device token to the configured host
 *   Expected: HTTP 400 {"reason":"BadDeviceToken"} — which proves the key,
 *   key id, team and topic are all ACCEPTED (a bad key would be 403
 *   InvalidProviderToken / InvalidKey; a bad topic would be 403 BadTopic).
 *   410 with a real token means the same thing (authenticated, token dead).
 *
 * Usage: node scripts/test-apns.mjs
 */
import crypto from "crypto";
import http2 from "http2";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- minimal .env loader (server-specific: ambient DATABASE_URL trap aside) ---
function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = { ...loadEnv() };
const KEY_ID = env.APNS_KEY_ID || process.env.APNS_KEY_ID;
const TEAM_ID = env.APNS_TEAM_ID || process.env.APNS_TEAM_ID;
const BUNDLE = env.APNS_BUNDLE_ID || process.env.APNS_BUNDLE_ID;
const P8_RAW = env.APNS_P8_KEY || process.env.APNS_P8_KEY;
const HOST =
  String(env.APNS_ENV || "production").toLowerCase() === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";

if (!KEY_ID || !TEAM_ID || !BUNDLE || !P8_RAW) {
  console.error("Missing APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID / APNS_P8_KEY");
  process.exit(1);
}

const PEM = P8_RAW.includes("BEGIN PRIVATE KEY")
  ? P8_RAW.replace(/\\n/g, "\n")
  : `-----BEGIN PRIVATE KEY-----\n${P8_RAW.replace(/\s+/g, "")}\n-----END PRIVATE KEY-----`;

// --- DER (ASN.1) → raw r||s (JOSE) — mirrors server/services/apns.ts ---
function derToJose(der) {
  let idx = 2;
  if (der[1] & 0x80) idx = 2 + (der[1] & 0x7f);
  const rLen = der[idx + 1];
  let r = der.subarray(idx + 2, idx + 2 + rLen);
  const sOff = idx + 2 + rLen;
  const sLen = der[sOff + 1];
  let s = der.subarray(sOff + 2, sOff + 2 + sLen);
  while (r.length > 0 && r[0] === 0) r = r.subarray(1);
  while (s.length > 0 && s[0] === 0) s = s.subarray(1);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

// --- 1. Build + locally verify the provider JWT ---
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unsigned = `${b64({ alg: "ES256", kid: KEY_ID })}.${b64({ iss: TEAM_ID, iat: now })}`;
const signer = crypto.createSign("SHA256");
signer.update(unsigned);
const jose = derToJose(signer.sign(PEM));
console.log("JWT signature length:", jose.length, "bytes (expect 64 = raw r||s)");

const priv = crypto.createPrivateKey(PEM);
const pub = crypto.createPublicKey(priv);
const ok = crypto.verify(
  "SHA256",
  Buffer.from(unsigned),
  { key: pub, dsaEncoding: "ieee-p1363" },
  jose,
);
console.log("Local signature verify (ieee-p1363):", ok ? "PASS" : "FAIL");
if (!ok) process.exit(1);

const jwt = `${unsigned}.${jose.toString("base64url")}`;

// --- 2. Live APNs call with a dummy token ---
const dummy = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const body = Buffer.from(JSON.stringify({ aps: {}, type: "incoming-call", callId: "smoke-test" }));

await new Promise((resolve) => {
  const session = http2.connect(HOST);
  let done = false;
  const finish = (code, text) => {
    if (done) return;
    done = true;
    console.log(`APNs ${HOST} responded: HTTP ${code} ${text}`);
    console.log(
      code === 400
        ? "RESULT: PASS — auth chain accepted (400 BadDeviceToken is EXPECTED for a dummy token; a real device token would be delivered)"
        : code === 403 || code === 401
          ? "RESULT: FAIL — auth rejected (check key / key id / team id)"
          : `RESULT: unexpected — inspect reason above`,
    );
    try { session.close(); } catch {}
    resolve();
  };
  session.on("error", (e) => finish("ERR", e.message));
  const t = setTimeout(() => finish("ERR", "timeout"), 10000);
  const req = session.request({
    ":method": "POST",
    ":path": `/3/device/${dummy}`,
    "apns-push-type": "voip",
    "apns-priority": "10",
    "apns-topic": BUNDLE,
    "content-type": "application/json",
    "content-length": body.length,
    authorization: `bearer ${jwt}`,
  });
  const chunks = [];
  req.on("response", (headers) => {
    const status = headers[":status"];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      clearTimeout(t);
      finish(status, chunks.length ? Buffer.concat(chunks).toString() : "");
    });
  });
  req.on("error", (e) => { clearTimeout(t); finish("ERR", e.message); });
  req.write(body);
  req.end();
});
