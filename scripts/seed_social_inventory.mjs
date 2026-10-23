#!/usr/bin/env node
/**
 * Inventory of social_posts + social_polls authors on the production DB.
 * READ-ONLY — decides which accounts are "seed" authors before reassignment.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Load DATABASE_URL from backend .env (the sandbox may pre-set a localhost
// DATABASE_URL — the Neon URL in .env wins for production inventory).
function loadEnv() {
  for (const f of [".env", ".env.local"]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      const cur = process.env[m[1]];
      // Prefer values that look like production (neon), keep otherwise-empty.
      if (!cur || (/neon\.tech/.test(val) && !/neon\.tech/.test(cur))) process.env[m[1]] = val;
    }
  }
}
loadEnv();
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!dbUrl) { console.error("No DATABASE_URL found"); process.exit(1); }

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

const authors = await client.query(`
  SELECT u.id, u.email, u.name, COUNT(p.id)::int AS posts
  FROM social_posts p JOIN users u ON u.id = p.user_id
  GROUP BY u.id, u.email, u.name ORDER BY posts DESC LIMIT 30`);
console.log("=== POST AUTHORS ===");
for (const a of authors.rows) console.log(`${a.posts}x  ${a.name}  <${a.email}>  ${a.id}`);

const pollAuthors = await client.query(`
  SELECT u.id, u.email, u.name, COUNT(pl.id)::int AS polls
  FROM social_polls pl JOIN users u ON u.id = pl.user_id
  GROUP BY u.id, u.email, u.name ORDER BY polls DESC LIMIT 30`);
console.log("=== POLL AUTHORS ===");
for (const a of pollAuthors.rows) console.log(`${a.polls}x  ${a.name}  <${a.email}>  ${a.id}`);

const target = await client.query(`SELECT id, email, name FROM users WHERE LOWER(email) = 'metricorexlimited@gmail.com' LIMIT 1`);
console.log("=== TARGET ACCOUNT ===", target.rows[0] || "NOT FOUND");

const totals = await client.query(`SELECT (SELECT COUNT(*) FROM social_posts) AS posts, (SELECT COUNT(*) FROM social_polls) AS polls, (SELECT COUNT(*) FROM social_comments) AS comments`);
console.log("=== TOTALS ===", totals.rows[0]);

const sample = await client.query(`SELECT LEFT(body, 60) AS body, created_at FROM social_posts ORDER BY created_at DESC LIMIT 12`);
console.log("=== RECENT POST BODIES ===");
for (const s of sample.rows) console.log(`- [${s.created_at?.toISOString?.().slice(0, 10)}] ${s.body}`);

await client.end();
