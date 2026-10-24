#!/usr/bin/env node
/**
 * remove_seed_social.mjs — purge test/seed social content (DRY RUN by default).
 *
 * Removes everything owned by the seeded smoke-test accounts
 * (*@example.com — the seeding convention used by the e2e probe scripts):
 *   · social_posts + media + tags + reactions + comments + views + boosts
 *   · social_stories (+ views/likes)
 *   · social_sounds minted by seed accounts
 *   · live_sessions (+ messages, reactions, viewers, clips, vods, join requests)
 *   · market_listings (+ orders/saves) from seed sellers
 *
 * Usage:
 *   node scripts/remove_seed_social.mjs             # dry run — prints what WOULD go
 *   node scripts/remove_seed_social.mjs --apply     # actually delete
 *   node scripts/remove_seed_social.mjs --apply --pattern=%@staging.example.com
 */

import pg from "pg";

const APPLY = process.argv.includes("--apply");
const patternArg = process.argv.find((a) => a.startsWith("--pattern="));
const PATTERN = patternArg?.split("=")[1] || "%@example.com";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required (load your .env first).");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const q = (text, params) => pool.query(text, params);

const STEPS = [
  ["seed accounts (users)", `SELECT COUNT(*)::int AS n FROM users WHERE email LIKE $1`],
  ["social posts", `SELECT COUNT(*)::int AS n FROM social_posts p JOIN users u ON u.id = p.user_id WHERE u.email LIKE $1`],
  ["stories", `SELECT COUNT(*)::int AS n FROM social_stories s JOIN users u ON u.id = s.user_id WHERE u.email LIKE $1`],
  ["sounds (minted by seeds)", `SELECT COUNT(*)::int AS n FROM social_sounds s JOIN users u ON u.id = s.owner_id WHERE u.email LIKE $1`],
  ["market listings", `SELECT COUNT(*)::int AS n FROM market_listings l JOIN users u ON u.id = l.seller_id WHERE u.email LIKE $1`],
  ["live sessions", `SELECT COUNT(*)::int AS n FROM live_sessions s JOIN users u ON u.id = s.host_id WHERE u.email LIKE $1`],
];

(async () => {
  console.log(`Mode: ${APPLY ? "APPLY (destructive)" : "DRY RUN"} · pattern: ${PATTERN}\n`);
  for (const [label, countSql] of STEPS) {
    const r = await q(countSql, [PATTERN]);
    console.log(`  ${label.padEnd(28)} ${r.rows[0].n}`);
  }

  if (!APPLY) {
    console.log("\nDry run only — re-run with --apply to delete.");
    return;
  }

  console.log("\nDeleting…");
  // Children first (FK chains), parents last. All scoped to the seed pattern.
  await q(
    `DELETE FROM social_post_views USING social_posts p JOIN users u ON u.id = p.user_id WHERE social_post_views.post_id = p.id AND u.email LIKE $1`,
    [PATTERN],
  );
  await q(
    `DELETE FROM social_post_tags USING social_posts p JOIN users u ON u.id = p.user_id WHERE social_post_tags.post_id = p.id AND u.email LIKE $1`,
    [PATTERN],
  );
  await q(
    `DELETE FROM social_post_media USING social_posts p JOIN users u ON u.id = p.user_id WHERE social_post_media.post_id = p.id AND u.email LIKE $1`,
    [PATTERN],
  );
  await q(
    `DELETE FROM social_reactions USING social_posts p JOIN users u ON u.id = p.user_id WHERE social_reactions.post_id = p.id AND u.email LIKE $1`,
    [PATTERN],
  );
  await q(
    `DELETE FROM social_comments USING social_posts p JOIN users u ON u.id = p.user_id WHERE social_comments.post_id = p.id AND u.email LIKE $1`,
    [PATTERN],
  );
  await q(
    `DELETE FROM social_stories WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [PATTERN],
  );
  await q(
    `DELETE FROM social_post_media WHERE sound_id IN (
       SELECT s.id FROM social_sounds s JOIN users u ON u.id = s.owner_id WHERE u.email LIKE $1)`,
    [PATTERN],
  );
  await q(
    `DELETE FROM social_sounds WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [PATTERN],
  );
  await q(
    `DELETE FROM social_posts WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [PATTERN],
  );
  await q(
    `DELETE FROM live_messages WHERE session_id IN (
       SELECT s.id FROM live_sessions s JOIN users u ON u.id = s.host_id WHERE u.email LIKE $1)`,
    [PATTERN],
  );
  await q(
    `DELETE FROM live_reactions WHERE session_id IN (
       SELECT s.id FROM live_sessions s JOIN users u ON u.id = s.host_id WHERE u.email LIKE $1)`,
    [PATTERN],
  );
  await q(
    `DELETE FROM live_viewers WHERE session_id IN (
       SELECT s.id FROM live_sessions s JOIN users u ON u.id = s.host_id WHERE u.email LIKE $1)`,
    [PATTERN],
  );
  await q(
    `DELETE FROM live_sessions WHERE host_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [PATTERN],
  );
  await q(
    `DELETE FROM market_listings WHERE seller_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [PATTERN],
  );
  console.log("✅ Seed content removed.");
})()
  .catch((e) => { console.error("Cleanup failed:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
