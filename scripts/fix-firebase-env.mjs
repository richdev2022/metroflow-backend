#!/usr/bin/env node
/**
 * fix-firebase-env.mjs — repairs a FIREBASE_SERVICE_ACCOUNT_JSON that was pasted
 * into .env as multi-line JSON (dotenv reads line-by-line, so only `{` survives
 * and every FCM send fails with "Push NOT configured").
 *
 * What it does (idempotent — safe to re-run):
 *   1. Reads ./.env, extracts the FULL multi-line JSON block that follows
 *      FIREBASE_SERVICE_ACCOUNT_JSON= (brace-balanced, string-aware).
 *   2. Validates it parses as a Google service account (client_email + private_key).
 *   3. Writes it to ./firebase-service-account.json (chmod 600).
 *   4. Rewrites the .env block as TWO .env-safe single lines:
 *        FIREBASE_SERVICE_ACCOUNT_FILE=<abs path to the json file>
 *        FIREBASE_SERVICE_ACCOUNT_JSON=<base64 of the JSON (single line)>
 *   5. Prints the exact pm2 restart + verification commands.
 *
 * Usage:  cd ~/metroflow-backend && node scripts/fix-firebase-env.mjs
 */

import fs from "fs";
import path from "path";

const cwd = process.cwd();
const envPath = path.join(cwd, ".env");
const jsonPath = path.join(cwd, "firebase-service-account.json");

if (!fs.existsSync(envPath)) {
  console.error(`✗ .env not found at ${envPath} — run this from the backend root (~/metroflow-backend).`);
  process.exit(1);
}

const envRaw = fs.readFileSync(envPath, "utf8");
const lines = envRaw.split("\n");

// ---- locate the FIREBASE_SERVICE_ACCOUNT_JSON line -------------------------
const keyIdx = lines.findIndex((l) => /^FIREBASE_SERVICE_ACCOUNT_JSON=/.test(l));
if (keyIdx === -1) {
  console.error("✗ FIREBASE_SERVICE_ACCOUNT_JSON not found in .env — nothing to fix here.");
  process.exit(1);
}

const firstValue = lines[keyIdx].slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length).trim();

/** Extract a brace-balanced JSON object starting at `text` offset 0 (string-aware). */
function extractJsonBlock(text) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null; // unbalanced → caller handles
}

let jsonText = null;
let consumedLines = 1;

if (firstValue.startsWith("{")) {
  // Join this line + following lines until braces balance.
  const joined = lines.slice(keyIdx).join("\n").slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length);
  const block = extractJsonBlock(joined);
  if (block) {
    jsonText = block;
    consumedLines = block.split("\n").length;
  }
} else if (/^[A-Za-z0-9+/=\s]+$/.test(firstValue) && firstValue.length > 40 && !firstValue.includes(" ")) {
  // Already base64 — decode to validate + still write the file for convenience.
  try {
    jsonText = Buffer.from(firstValue, "base64").toString("utf8");
  } catch {
    /* fallthrough */
  }
  if (jsonText) consumedLines = 1;
}

if (!jsonText) {
  // Maybe it's already a single-line JSON.
  if (firstValue.startsWith("{")) {
    try {
      JSON.parse(firstValue);
      jsonText = firstValue;
      consumedLines = 1;
    } catch {
      /* fallthrough */
    }
  }
}

if (!jsonText) {
  console.error("✗ Could not extract a complete JSON block after FIREBASE_SERVICE_ACCOUNT_JSON=.");
  console.error("  The .env value may be truncated beyond repair — re-paste the JSON and re-run this script,");
  console.error("  or paste the JSON into firebase-service-account.json manually and add:");
  console.error("    FIREBASE_SERVICE_ACCOUNT_FILE=" + jsonPath);
  process.exit(1);
}

// strip accidental wrapping quotes
jsonText = jsonText.trim().replace(/^["']|["']$/g, "").trim();

// ---- validate ----------------------------------------------------------------
let account;
try {
  account = JSON.parse(jsonText);
} catch (err) {
  console.error(`✗ Extracted JSON does not parse: ${err.message}`);
  process.exit(1);
}
if (!account.client_email || !account.private_key) {
  console.error("✗ JSON parsed but is missing client_email/private_key — not a service account.");
  process.exit(1);
}
console.log(`✓ Service account OK: ${account.client_email}`);
console.log(`✓ project_id: ${account.project_id || "(not present in JSON)"}`);

// ---- write the JSON file (chmod 600) ------------------------------------------
fs.writeFileSync(jsonPath, JSON.stringify(account, null, 2) + "\n", { mode: 0o600 });
try {
  fs.chmodSync(jsonPath, 0o600);
} catch {}
console.log(`✓ Wrote ${jsonPath}`);

// ---- rewrite .env --------------------------------------------------------------
const b64 = Buffer.from(JSON.stringify(account)).toString("base64");
const replacement = [
  `# Firebase service account — file reference is the .env-safe form (no line-splitting risk).`,
  `FIREBASE_SERVICE_ACCOUNT_FILE=${jsonPath}`,
  `# Base64 single-line fallback of the same JSON (either mechanism works).`,
  `FIREBASE_SERVICE_ACCOUNT_JSON=${b64}`,
].join("\n");

const newLines = [...lines];
newLines.splice(keyIdx, consumedLines, replacement);
fs.writeFileSync(envPath, newLines.join("\n"));
console.log(`✓ Rewrote .env (${consumedLines} line block → file ref + base64 single line)`);

// ---- sanity check like the server does ------------------------------------------
const reloaded = fs.readFileSync(envPath, "utf8");
const check = reloaded.split("\n").findIndex((l) => /^FIREBASE_SERVICE_ACCOUNT_JSON=/.test(l));
const val = reloaded.split("\n")[check].slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length);
const ok = (() => {
  try {
    const decoded = Buffer.from(val, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return !!(parsed.client_email && parsed.private_key);
  } catch {
    return false;
  }
})();
console.log(ok ? "✓ Verified: .env single-line base64 parses as a service account" : "✗ Verification FAILED");

console.log("\n──── NEXT STEPS ────");
console.log("1) pm2 restart metroflow --update-env");
console.log("   (if Redis/other env changes still look stale: pm2 delete metroflow && pm2 start dist/server/node-build.mjs --name metroflow --update-env)");
console.log("2) Verify:  curl -s -H 'Authorization: Bearer <token>' https://api.metricorex.com/api/test-communications/push-status");
console.log("   → expect fcmConfigured:true, serviceAccountOk:true");
console.log("3) Fire:    curl -s -X POST -H 'Authorization: Bearer <token>' https://api.metricorex.com/api/test-communications/push-send -H 'Content-Type: application/json' -d '{\"kind\":\"general\"}'");
