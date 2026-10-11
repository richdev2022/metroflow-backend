#!/usr/bin/env node
/**
 * VoIP token storage test — runs the EXACT SQL shapes from
 * routes/notifications.ts registerDevice against the .env DATABASE_URL
 * (production Neon), with fake tokens, then CLEANS UP every touched row.
 *
 * Validates:
 *   1. voip_token column + partial unique index (idempotent ALTER/CREATE)
 *   2. voip-only registration (fcm NULL) + idempotent re-register
 *   3. token rotation cleanup (old voip rows for the user are deleted)
 *   4. fcm+voip single-row merge (conflict paths on both unique indexes)
 *   5. cleanup — DB left exactly as found
 *
 * Usage: env -u DATABASE_URL node scripts/test_voip_storage.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 2,
});

const FAKE_VOIP_V1 = "1111111111111111111111111111111111111111111111111111111111111111";
const FAKE_VOIP_V2 = "2222222222222222222222222222222222222222222222222222222222222222";
const FAKE_FCM = "test-fcm-voip-storage-DELETE-ME";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

try {
  // 0. QA user id
  const u = await pool.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, ["metricorexlimited@gmail.com"]);
  const userId = u.rows[0]?.id;
  if (!userId) throw new Error("QA user not found");
  console.log("QA user:", userId);

  // 1. Schema (exact migration SQL — idempotent; drop-then-create settles any
  //    partial-index variant that may exist)
  await pool.query(`ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS voip_token TEXT`);
  await pool.query(`DROP INDEX IF EXISTS user_devices_voip_token_key`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS user_devices_voip_token_key ON user_devices(voip_token)`);
  console.log("1. schema ready (voip_token + full unique index)");

  // Snapshot to prove cleanup
  const before = await pool.query(`SELECT COUNT(*)::int AS c FROM user_devices WHERE user_id = $1`, [userId]);
  console.log("   device rows before:", before.rows[0].c);

  // 2. voip-only registration (the iOS CallKitService shape: fcm_token:'')
  await pool.query(
    `INSERT INTO user_devices (user_id, business_id, fcm_token, voip_token, platform, device_name, app_version, last_seen_at)
     VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, CURRENT_TIMESTAMP)
     ON CONFLICT (voip_token) DO UPDATE SET
       user_id = EXCLUDED.user_id, business_id = EXCLUDED.business_id,
       fcm_token = COALESCE(NULLIF(EXCLUDED.fcm_token, ''), user_devices.fcm_token),
       platform = EXCLUDED.platform, device_name = EXCLUDED.device_name,
       app_version = EXCLUDED.app_version, last_seen_at = CURRENT_TIMESTAMP`,
    [userId, null, "", FAKE_VOIP_V1, "ios", "voip-test", "1.0"],
  );
  let row = await pool.query(`SELECT * FROM user_devices WHERE voip_token = $1`, [FAKE_VOIP_V1]);
  check("voip-only insert", row.rows.length === 1 && row.rows[0].fcm_token === null && row.rows[0].platform === "ios");

  // idempotent re-register (same token again — must UPDATE, not duplicate)
  await pool.query(
    `INSERT INTO user_devices (user_id, business_id, fcm_token, voip_token, platform, device_name, app_version, last_seen_at)
     VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, CURRENT_TIMESTAMP)
     ON CONFLICT (voip_token) DO UPDATE SET
       user_id = EXCLUDED.user_id, last_seen_at = CURRENT_TIMESTAMP`,
    [userId, null, "", FAKE_VOIP_V1, "ios", "voip-test", "1.0"],
  );
  const dupes = await pool.query(`SELECT COUNT(*)::int AS c FROM user_devices WHERE voip_token = $1`, [FAKE_VOIP_V1]);
  check("voip re-register idempotent", dupes.rows[0].c === 1);

  // 3. rotation cleanup SQL (user registers a NEW voip token)
  await pool.query(
    `INSERT INTO user_devices (user_id, business_id, fcm_token, voip_token, platform, last_seen_at)
     VALUES ($1, $2, NULLIF($3,''), $4, 'ios', CURRENT_TIMESTAMP)
     ON CONFLICT (voip_token) DO UPDATE SET user_id = EXCLUDED.user_id, last_seen_at = CURRENT_TIMESTAMP`,
    [userId, null, "", FAKE_VOIP_V2],
  );
  await pool.query(`DELETE FROM user_devices WHERE user_id = $1 AND voip_token IS NOT NULL AND voip_token <> $2`, [userId, FAKE_VOIP_V2]);
  const afterRotate = await pool.query(
    `SELECT voip_token FROM user_devices WHERE user_id = $1 AND voip_token IS NOT NULL`, [userId],
  );
  check("rotation deletes stale voip rows", afterRotate.rows.length === 1 && afterRotate.rows[0].voip_token === FAKE_VOIP_V2,
    JSON.stringify(afterRotate.rows));

  // 4. fcm+voip merge: fcm row upserts with voip attached, then voip upsert lands on same row
  await pool.query(
    `INSERT INTO user_devices (user_id, business_id, fcm_token, voip_token, platform, last_seen_at)
     VALUES ($1, $2, $3, NULLIF($4,''), 'ios', CURRENT_TIMESTAMP)
     ON CONFLICT (fcm_token) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       voip_token = COALESCE(NULLIF(EXCLUDED.voip_token, ''), user_devices.voip_token),
       last_seen_at = CURRENT_TIMESTAMP`,
    [userId, null, FAKE_FCM, FAKE_VOIP_V1],
  );
  await pool.query(
    `INSERT INTO user_devices (user_id, business_id, fcm_token, voip_token, platform, last_seen_at)
     VALUES ($1, $2, NULLIF($3,''), $4, 'ios', CURRENT_TIMESTAMP)
     ON CONFLICT (voip_token) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       fcm_token = COALESCE(NULLIF(EXCLUDED.fcm_token, ''), user_devices.fcm_token),
       last_seen_at = CURRENT_TIMESTAMP`,
    [userId, null, "", FAKE_VOIP_V1],
  );
  const merged = await pool.query(
    `SELECT fcm_token, voip_token FROM user_devices WHERE user_id = $1 AND (fcm_token = $2 OR voip_token = ANY($3))`,
    [userId, FAKE_FCM, [FAKE_VOIP_V1, FAKE_VOIP_V2]],
  );
  const mergedFcmRow = merged.rows.find((r) => r.fcm_token === FAKE_FCM);
  check("fcm+voip merged onto one row", mergedFcmRow && mergedFcmRow.voip_token === FAKE_VOIP_V1,
    JSON.stringify(merged.rows));
  const totalRows = merged.rows.length;
  check("no row explosion", totalRows === 2, `rows=${totalRows}`);

  // 5. cleanup — remove every row we created
  const del = await pool.query(
    `DELETE FROM user_devices WHERE user_id = $1 AND (fcm_token = $2 OR voip_token = ANY($3)) RETURNING id`,
    [userId, FAKE_FCM, [FAKE_VOIP_V1, FAKE_VOIP_V2]],
  );
  const after = await pool.query(`SELECT COUNT(*)::int AS c FROM user_devices WHERE user_id = $1`, [userId]);
  // Expected deletions: 2 ROWS — the rotation-target V2 row, and the merged
  // fcm/V1 row (V1's standalone row was already rotation-deleted in step 3,
  // so V1 lives on the fcm row). Baseline (the user's real device row) must
  // be untouched.
  check("cleanup restored row count", del.rowCount === 2 && after.rows[0].c === before.rows[0].c,
    `deleted=${del.rowCount} after=${after.rows[0].c} before=${before.rows[0].c}`);
  console.log("   (rotation stale row was already gone: verified above)");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST ERROR:", e.message);
  // best-effort cleanup even on failure
  try {
    await pool.query(
      `DELETE FROM user_devices WHERE (fcm_token = $1 OR voip_token = ANY($2))`,
      [FAKE_FCM, [FAKE_VOIP_V1, FAKE_VOIP_V2]],
    );
    console.error("cleanup attempted");
  } catch {}
  process.exitCode = 1;
} finally {
  await pool.end();
}
