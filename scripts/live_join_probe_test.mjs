/**
 * LIVE "raise hand" (join-request → stage) E2E probe — LOCAL backend
 * (PORT=3099), real DB, self-cleaning.
 *
 *   node scripts/live_join_probe_test.mjs
 *
 * Covers: raise hand (pending), idempotent re-raise, host queue w/ profiles,
 * approve → cohost_ids + viewer poll approved, decline → re-raise cycle,
 * cancel, host-cannot-raise, non-host-cannot-approve, stage cap (5),
 * stage exit on leave, re-approve already-responded → 404.
 */
import crypto from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ override: true });
import pg from "pg";

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:3099/api";
const stamp = Date.now().toString(36);
const EH = `ljp-host-${stamp}@probe.metricorex.test`;
const E1 = `ljp-v1-${stamp}@probe.metricorex.test`;
const E2 = `ljp-v2-${stamp}@probe.metricorex.test`;

const results = [];
let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
}

async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body && !["GET", "HEAD"].includes(method) ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let bizH, biz1, biz2, host, v1, v2, tokH, tok1, tok2, session, code;

async function mkBiz(name) {
  const id = crypto.randomUUID();
  const plan = await client.query(`SELECT id FROM pricing_plans ORDER BY (price::numeric) ASC LIMIT 1`);
  await client.query(
    `INSERT INTO businesses (id, name, email, currency, plan_id, subscription_status, kyc_status, created_at, updated_at)
     VALUES ($1, $2, $3, 'NGN', $4, 'active', 'none', NOW(), NOW())`,
    [id, name, `${name.toLowerCase().replace(/\s+/g, "-")}-${stamp}@probe.metricorex.test`, plan.rows[0].id],
  );
  return id;
}
async function mkUser(bizId, email, name) {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO users (id, business_id, email, name, role, status, email_verified, auth_provider, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'owner', 'active', TRUE, 'email', NOW(), NOW())`,
    [id, bizId, email, name],
  );
  return id;
}
async function mkToken(userId, bizId) {
  const token = crypto.randomBytes(32).toString("hex");
  await client.query(`INSERT INTO user_sessions (user_id, business_id, token) VALUES ($1, $2, $3)`, [userId, bizId, token]);
  return token;
}

try {
  bizH = await mkBiz(`LJP H ${stamp}`); biz1 = await mkBiz(`LJP V1 ${stamp}`); biz2 = await mkBiz(`LJP V2 ${stamp}`);
  host = await mkUser(bizH, EH, "LJP Host");
  v1 = await mkUser(biz1, E1, "LJP Viewer One");
  v2 = await mkUser(biz2, E2, "LJP Viewer Two");
  tokH = await mkToken(host, bizH); tok1 = await mkToken(v1, biz1); tok2 = await mkToken(v2, biz2);

  // Host goes live
  const go = await api("POST", "/live", tokH, { title: "Join Request Night", category: "chat" });
  check("host goes live", go.status === 201 || go.status === 200, JSON.stringify(go.json).slice(0, 140));
  session = go.json?.data?.session?.id || go.json?.data?.id;
  code = go.json?.data?.session?.call_code || go.json?.data?.call_code;
  check("session id + call_code returned", Boolean(session) && Boolean(code));

  // 1) viewer raises hand → pending
  const r1 = await api("POST", `/live/${code}/join-requests`, tok1, {});
  check("viewer raises hand → pending", (r1.status === 200 || r1.status === 201) && r1.json?.data?.status === "pending", JSON.stringify(r1.json).slice(0, 160));
  const rid1 = r1.json?.data?.request?.id;

  // 2) idempotent re-raise
  const r1b = await api("POST", `/live/${code}/join-requests`, tok1, {});
  check("re-raise keeps single pending row", (r1b.status === 200 || r1b.status === 201) && r1b.json?.data?.status === "pending" && r1b.json?.data?.request?.id === rid1);

  // 3) host cannot raise on their own stream
  const rHost = await api("POST", `/live/${code}/join-requests`, tokH, {});
  check("host cannot raise hand", rHost.status === 400);

  // 4) host queue shows viewer one with profile
  const q1 = await api("GET", `/live/${code}/join-requests`, tokH, {});
  check("host queue: 1 pending w/ name", q1.status === 200 && q1.json?.data?.pending_count === 1 && q1.json?.data?.pending?.[0]?.name === "LJP Viewer One", JSON.stringify(q1.json?.data).slice(0, 200));

  // 5) non-host cannot approve
  const forb = await api("POST", `/live/${code}/join-requests/${rid1}/approve`, tok2, {});
  check("non-host approve → 403", forb.status === 403);

  // 6) second viewer raises; host declines
  const r2 = await api("POST", `/live/${code}/join-requests`, tok2, {});
  check("viewer two raises → pending", r2.json?.data?.status === "pending", JSON.stringify(r2.json).slice(0, 120));
  const rid2 = r2.json?.data?.request?.id;
  const dec = await api("POST", `/live/${code}/join-requests/${rid2}/decline`, tokH, {});
  check("host declines viewer two", dec.status === 200 && dec.json?.data?.request?.status === "declined");
  const mine2 = await api("GET", `/live/${code}/join-requests`, tok2, {});
  check("viewer two poll → declined", mine2.json?.data?.status === "declined", JSON.stringify(mine2.json?.data).slice(0, 140));

  // 7) re-raise after decline works
  const r2b = await api("POST", `/live/${code}/join-requests`, tok2, {});
  check("declined viewer can re-raise", r2b.json?.data?.status === "pending");
  await api("DELETE", `/live/${code}/join-requests`, tok2, {});
  const mine2b = await api("GET", `/live/${code}/join-requests`, tok2, {});
  check("cancel → status none", mine2b.json?.data?.status === "none", JSON.stringify(mine2b.json?.data).slice(0, 140));

  // 8) approve viewer one → lands on stage
  const app = await api("POST", `/live/${code}/join-requests/${rid1}/approve`, tokH, {});
  check("host approves viewer one", app.status === 200 && app.json?.data?.request?.status === "approved", JSON.stringify(app.json).slice(0, 160));
  const cohosts = app.json?.data?.cohost_ids || [];
  check("cohost_ids now includes viewer one", cohosts.includes(v1), JSON.stringify(cohosts));

  const mine1 = await api("GET", `/live/${code}/join-requests`, tok1, {});
  check("viewer one poll → approved + is_stage", mine1.json?.data?.status === "approved" && mine1.json?.data?.is_stage === true, JSON.stringify(mine1.json?.data).slice(0, 140));

  // 9) re-respond to a settled request → 404
  const appAgain = await api("POST", `/live/${code}/join-requests/${rid1}/approve`, tokH, {});
  check("re-approve settled request → 404", appAgain.status === 404);

  // 10) raise hand while already on stage → approved shortcut
  const r1c = await api("POST", `/live/${code}/join-requests`, tok1, {});
  check("on-stage raise → approved shortcut", r1c.status === 200 && r1c.json?.data?.status === "approved");

  // 11) stage cap — fill to 5 fake cohosts then viewer two raises → 400
  await client.query(`UPDATE live_sessions SET cohost_ids = $1::jsonb WHERE id = $2`, [JSON.stringify([v1, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]), session]);
  const cap = await api("POST", `/live/${code}/join-requests`, tok2, {});
  check("stage full (5) → 400", cap.status === 400 && /full/i.test(cap.json?.error || cap.json?.data?.error || cap.json?.error || ""), JSON.stringify(cap.json).slice(0, 140));
  // restore for the stage-exit test
  await client.query(`UPDATE live_sessions SET cohost_ids = $1::jsonb WHERE id = $2`, [JSON.stringify([v1]), session]);

  // 12) stage exit on leave
  const lv = await api("POST", `/live/${code}/leave`, tok1, {});
  check("viewer one leaves", lv.status === 200);
  const after = await client.query(`SELECT cohost_ids FROM live_sessions WHERE id = $1`, [session]);
  check("leave removes viewer one from stage", !(after.rows[0]?.cohost_ids || []).includes(v1), JSON.stringify(after.rows[0]?.cohost_ids));

  // 13) join-request by unknown code → 404
  const bad = await api("POST", `/live/LIVE-NOPE/join-requests`, tok1, {});
  check("unknown code → 404", bad.status === 404);

  // 14) end stream (coverage of the flow the UI rides)
  const end = await api("POST", `/live/${code}/end`, tokH, {});
  check("host ends stream", end.status === 200 && end.json?.data?.summary?.call_code === code);

} catch (e) {
  failed++;
  results.push(`  FATAL ${e?.message}`);
} finally {
  try {
    await client.query(`DELETE FROM live_join_requests WHERE session_id IN (SELECT id FROM live_sessions WHERE host_id = $1)`, [host]);
    await client.query(`DELETE FROM live_viewers WHERE session_id IN (SELECT id FROM live_sessions WHERE host_id = $1)`, [host]);
    await client.query(`DELETE FROM live_messages WHERE session_id IN (SELECT id FROM live_sessions WHERE host_id = $1)`, [host]);
    await client.query(`DELETE FROM live_reactions WHERE session_id IN (SELECT id FROM live_sessions WHERE host_id = $1)`, [host]);
    await client.query(`DELETE FROM live_sessions WHERE host_id = $1`, [host]);
    await client.query(`DELETE FROM calls WHERE call_code = $1`, [code]);
    await client.query(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [host, v1, v2]);
    await client.query(`DELETE FROM businesses WHERE id IN ($1,$2,$3)`, [bizH, biz1, biz2]);
  } catch (te) {
    results.push(`  TEARDOWN-WARN ${te?.message}`);
  }
  await client.end();
}

console.log("\n=== Live join-request (raise hand) probe ===");
for (const r of results) console.log(r);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
