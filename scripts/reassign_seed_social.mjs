#!/usr/bin/env node
/**
 * Reassign SEED social content (authored by smoke.test.personal@example.com)
 * to metricorexlimited@gmail.com so the owner can delete it from their own
 * account. Real users' content is untouched.
 *
 * DRY RUN by default — pass --apply to execute.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

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
if (!dbUrl) { console.error("No DATABASE_URL found"); process.exit(1); }

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

const seed = await client.query(`SELECT id, email, name FROM users WHERE LOWER(email) = 'smoke.test.personal@example.com' LIMIT 1`);
const target = await client.query(`SELECT id, email, name FROM users WHERE LOWER(email) = 'metricorexlimited@gmail.com' LIMIT 1`);
if (!seed.rows.length) { console.log("No seed account found — nothing to do."); process.exit(0); }
if (!target.rows.length) { console.error("Target account metricorexlimited@gmail.com NOT FOUND"); process.exit(1); }

const seedId = seed.rows[0].id;
const targetId = target.rows[0].id;
console.log(`Seed author:  ${seed.rows[0].name} <${seed.rows[0].email}> (${seedId})`);
console.log(`Target owner: ${target.rows[0].name} <${target.rows[0].email}> (${targetId})`);
console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

const posts = await client.query(`SELECT id, LEFT(body, 50) AS body FROM social_posts WHERE user_id = $1`, [seedId]);
const polls = await client.query(`SELECT id FROM social_polls WHERE user_id = $1`, [seedId]);
const comments = await client.query(`SELECT id, LEFT(body, 50) AS body FROM social_comments WHERE user_id = $1`, [seedId]);
console.log(`Posts by seed author:    ${posts.rows.length}`);
for (const p of posts.rows) console.log(`  - ${p.id}  "${p.body}"`);
console.log(`Polls by seed author:    ${polls.rows.length}`);
for (const p of polls.rows) console.log(`  - ${p.id}`);
console.log(`Comments by seed author: ${comments.rows.length} (also reassigned for consistency)`);

if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to execute."); await client.end(); process.exit(0); }

const r1 = await client.query(`UPDATE social_posts SET user_id = $2 WHERE user_id = $1 RETURNING id`, [seedId, targetId]);
const r2 = await client.query(`UPDATE social_polls SET user_id = $2 WHERE user_id = $1 RETURNING id`, [seedId, targetId]);
const r3 = await client.query(`UPDATE social_comments SET user_id = $2 WHERE user_id = $1 RETURNING id`, [seedId, targetId]);
console.log(`\nAPPLIED: ${r1.rows.length} posts, ${r2.rows.length} polls, ${r3.rows.length} comments -> metricorexlimited@gmail.com`);

const verify = await client.query(`SELECT user_id, COUNT(*) FROM social_posts WHERE user_id IN ($1,$2) GROUP BY user_id`, [seedId, targetId]);
console.log("Post-count by owner after:", verify.rows);
await client.end();
