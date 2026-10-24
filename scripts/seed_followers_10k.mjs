#!/usr/bin/env node
/**
 * seed_followers_10k.mjs — Verification-badge seeding (criteria path).
 *
 * Seeds follower accounts until the target user crosses the 10,000-follower
 * verification threshold (server/services/verification-criteria.ts), then
 * flips their criteria badge. The criteria engine grants the badge on any
 * follow that crosses the threshold, but a one-shot historical seed needs the
 * final evaluation applied explicitly — this script does both.
 *
 * Usage:
 *   node scripts/seed_followers_10k.mjs <email-or-username-or-user-uuid> [--count=10000]
 *   node scripts/seed_followers_10k.mjs me@metricorex.com --count=10000
 *
 * Idempotent: existing seed followers are reused; the script tops up to the
 * requested total and re-applies the badge. Safe to re-run.
 */

import pg from "pg";

const args = process.argv.slice(2);
const targetArg = args.find((a) => !a.startsWith("--"));
const countArg = args.find((a) => a.startsWith("--count="));
const TARGET_TOTAL = Math.max(1, Number(countArg?.split("=")[1]) || 10_000);

if (!targetArg) {
  console.error("Usage: node scripts/seed_followers_10k.mjs <email|username|uuid> [--count=10000]");
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required (load your .env first, e.g. `set -a; source .env; set +a`).");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const q = (text, params) => pool.query(text, params);
const BATCH = 500;

async function resolveTarget() {
  const key = targetArg.trim();
  const r = await q(
    `SELECT id, name, email, username FROM users
     WHERE id::text = $1 OR LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1)
     LIMIT 1`,
    [key],
  );
  if (!r.rows.length) throw new Error(`Target user not found for "${targetArg}"`);
  return r.rows[0];
}

async function existingFollowerCount(userId) {
  const r = await q(`SELECT COUNT(*)::int AS c FROM social_follows WHERE following_id = $1`, [userId]);
  return Number(r.rows[0]?.c) || 0;
}

async function seedFollowers(target) {
  // Placeholder persona rows (personal accounts, business_id NULL). They are
  // real rows so follower lists, avatars and profile taps keep working.
  const created = await q(
    `INSERT INTO users (business_id, email, password_hash, name, role, account_type, email_verified)
     SELECT NULL,
            'seed.follower' || n || '@followers.metricorex.internal',
            NULL, -- no login: seeded personas never authenticate
            'Metricorex Follower ' || n,
            'owner', 'personal', TRUE
     FROM generate_series($1, $2) AS n
     WHERE NOT EXISTS (
       SELECT 1 FROM users u
       WHERE u.email = 'seed.follower' || n || '@followers.metricorex.internal'
     )
     RETURNING id`,
    [1, TARGET_TOTAL + 1000], // headroom pool
  );
  console.log(`Persona rows ensured: ${created.rowCount} (pool may already exist)`);

  // Follow edges — idempotent per (follower, following), created_at spread
  // over the last 90 days so profile/follower ordering looks organic.
  let inserted = 0;
  for (let start = 1; start <= TARGET_TOTAL + 1000; start += BATCH) {
    const end = start + BATCH - 1;
    const r = await q(
      `INSERT INTO social_follows (follower_id, following_id, created_at)
       SELECT u.id, $1, NOW() - (random() * INTERVAL '90 days')
       FROM users u
       WHERE u.email LIKE 'seed.follower%@followers.metricorex.internal'
         AND u.id <> $1
         AND (substring(u.email from 'seed\\.follower(\\d+)@')::int BETWEEN $2 AND $3)
       ON CONFLICT (follower_id, following_id) DO NOTHING
       RETURNING 1`,
      [target.id, start, end],
    );
    inserted += r.rowCount || 0;
    const total = await existingFollowerCount(target.id);
    if (total >= TARGET_TOTAL) break;
  }
  return inserted;
}

async function applyBadge(target) {
  const r = await q(
    `UPDATE users
     SET verified_badge_status = 'active',
         verified_badge_source = CASE WHEN verified_badge_source IN ('subscription') THEN verified_badge_source ELSE 'criteria' END,
         verified_since = COALESCE(verified_since, NOW()),
         verified_until = CASE WHEN verified_badge_source IN ('subscription') THEN verified_until ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING verified_badge_status, verified_badge_source`,
    [target.id],
  );
  return r.rows[0];
}

(async () => {
  const target = await resolveTarget();
  console.log(`Target: ${target.name} <${target.email}> (${target.id})`);
  const before = await existingFollowerCount(target.id);
  console.log(`Followers before: ${before}`);

  if (before < TARGET_TOTAL) {
    const inserted = await seedFollowers(target);
    console.log(`Follow edges inserted: ${inserted}`);
  } else {
    console.log("Target already meets the threshold — skipping edge seeding.");
  }

  const after = await existingFollowerCount(target.id);
  const badge = await applyBadge(target);
  console.log(`Followers after:  ${after}`);
  console.log(`Badge: ${badge.verified_badge_status} (source: ${badge.verified_badge_source})`);
  console.log(after >= TARGET_TOTAL ? "✅ Verification criteria satisfied." : "⚠️ Threshold still not met — raise --count.");
})()
  .catch((e) => { console.error("Seed failed:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
