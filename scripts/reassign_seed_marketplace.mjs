#!/usr/bin/env node
/**
 * Reassign SEED marketplace listings (authored by example.com seed accounts,
 * e.g. smoke.test.personal@example.com) to metricorexlimited@gmail.com so the
 * owner can edit or delete them from their own account ("My listings").
 *
 * Real users' listings are untouched — only sellers whose email is on an
 * example.com address (the seed convention) are reassigned.
 *
 * DRY RUN by default — pass --apply to execute.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Load DATABASE_URL from backend .env (a sandbox may pre-set a localhost
// DATABASE_URL — the Neon URL in .env wins for production data).
function loadEnv() {
  for (const f of [".env", ".env.local"]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      const cur = process.env[m[1]];
      if (!cur || (/neon\.tech/.test(val) && !/neon\.tech/.test(cur))) process.env[m[1]] = val;
    }
  }
}
loadEnv();
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!dbUrl) { console.error("No DATABASE_URL found — run from metroflow-backend with .env present"); process.exit(1); }

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

const target = await client.query(`SELECT id, email, name FROM users WHERE LOWER(email) = 'metricorexlimited@gmail.com' LIMIT 1`);
if (!target.rows.length) { console.error("Target account metricorexlimited@gmail.com NOT FOUND"); process.exit(1); }
const targetId = target.rows[0].id;
console.log(`Target owner: ${target.rows[0].name} <${target.rows[0].email}> (${targetId})`);
console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

// Seed sellers = any account on an example.com address (the seeding
// convention) that actually owns marketplace listings.
const seedSellers = await client.query(`
  SELECT DISTINCT u.id, u.email, u.name, COUNT(l.id)::int AS listings
  FROM market_listings l JOIN users u ON u.id = l.seller_id
  WHERE LOWER(u.email) LIKE '%@example.com'
  GROUP BY u.id, u.email, u.name ORDER BY listings DESC`);
if (!seedSellers.rows.length) { console.log("No example.com seed sellers own marketplace listings — nothing to do."); await client.end(); process.exit(0); }

console.log("=== SEED SELLERS (market_listings) ===");
for (const s of seedSellers.rows) console.log(`${s.listings}x  ${s.name}  <${s.email}>  ${s.id}`);

const seedIds = seedSellers.rows.map((s) => s.id);
const listings = await client.query(
  `SELECT l.id, l.name, l.price, l.status FROM market_listings l WHERE l.seller_id = ANY($1::uuid[]) ORDER BY l.created_at DESC`,
  [seedIds],
);
console.log(`\nListings to reassign: ${listings.rows.length}`);
for (const l of listings.rows) console.log(`  - ${l.id}  ₦${Number(l.price).toLocaleString()}  [${l.status}]  "${l.name}"`);

if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to execute."); await client.end(); process.exit(0); }

// Reassign listings (and keep boost rows consistent — they hang off listing
// ids so no change needed there).
const r1 = await client.query(
  `UPDATE market_listings SET seller_id = $2, updated_at = CURRENT_TIMESTAMP WHERE seller_id = ANY($1::uuid[]) RETURNING id`,
  [seedIds, targetId],
);
console.log(`\nAPPLIED: ${r1.rows.length} marketplace listings -> metricorexlimited@gmail.com`);

// Any market orders referencing seed sellers as buyer/seller stay as-is —
// they are transactional history, not editable content.

const verify = await client.query(
  `SELECT u.email, COUNT(l.id)::int AS listings FROM market_listings l JOIN users u ON u.id = l.seller_id
   WHERE u.id = $1 OR LOWER(u.email) LIKE '%@example.com' GROUP BY u.email`,
  [targetId],
);
console.log("Listings by owner after:", verify.rows);
await client.end();
