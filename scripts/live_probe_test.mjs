/**
 * Live streaming E2E probe — runs against a LOCAL backend instance (PORT=3099)
 * built from the UPSTREAM personal live router (server/features/personal/routes/live.ts),
 * using the real database with self-cleaning probe rows.
 *
 *   node scripts/live_probe_test.mjs
 *
 * Covers: go-live (bridged calls row), duplicate go-live guard, wall, join by
 * code AND uuid, /calls/:id/join media bridge, chat send/poll/cursor,
 * slow-mode 429, pin, moderation (remove + ban), reactions, viewer counts,
 * gifting end-to-end (catalog, real NGN debit/credit, ledger rows, ticker id,
 * insufficient funds, self-gift guard), leave, end + summary + wall removal.
 */
import crypto from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ override: true });
import pg from "pg";

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:3099/api";
const stamp = Date.now().toString(36);
const HOST_EMAIL = `live-probe-host-${stamp}@probe.metricorex.test`;
const VIEWER_EMAIL = `live-probe-viewer-${stamp}@probe.metricorex.test`;

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
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let hostUserId, viewerUserId, businessId, hostToken, viewerToken;
let sessionId, callCode, callId;

// ---------------------------------------------------------------------------
// Setup: business (cheapest plan) + two users + NGN wallets + session tokens
// ---------------------------------------------------------------------------
const plan = await client.query(`SELECT id FROM pricing_plans ORDER BY (price::numeric) ASC LIMIT 1`);
businessId = crypto.randomUUID();
await client.query(
  `INSERT INTO businesses (id, name, email, currency, plan_id, subscription_status, kyc_status, created_at, updated_at)
   VALUES ($1, $2, $3, 'NGN', $4, 'active', 'none', NOW(), NOW())`,
  [businessId, `Live Probe Co ${stamp}`, `live-probe-biz-${stamp}@probe.metricorex.test`, plan.rows[0].id],
);

async function mkUser(email, name) {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO users (id, business_id, email, name, role, status, email_verified, auth_provider, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'owner', 'active', TRUE, 'email', NOW(), NOW())`,
    [id, businessId, email, name],
  );
  return id;
}
hostUserId = await mkUser(HOST_EMAIL, "Probe Host");
viewerUserId = await mkUser(VIEWER_EMAIL, "Probe Viewer");

await client.query(`INSERT INTO wallets (id, user_id, currency, balance) VALUES ($1, $2, 'NGN', 10000)`, [crypto.randomUUID(), viewerUserId]);
await client.query(`INSERT INTO wallets (id, user_id, currency, balance) VALUES ($1, $2, 'NGN', 0)`, [crypto.randomUUID(), hostUserId]);

async function mkToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await client.query(`INSERT INTO user_sessions (user_id, business_id, token) VALUES ($1, $2, $3)`, [userId, businessId, token]);
  return token;
}
hostToken = await mkToken(hostUserId);
viewerToken = await mkToken(viewerUserId);

// ---------------------------------------------------------------------------
// 1) Go live
// ---------------------------------------------------------------------------
const go = await api("POST", "/live", hostToken, { title: "Probe Live Show", category: "music", description: "E2E probe" });
check("POST /live → 201", go.status === 201, `got ${go.status} ${JSON.stringify(go.json).slice(0, 200)}`);
sessionId = go.json?.data?.session?.id;
callCode = go.json?.data?.session?.call_code;
callId = go.json?.data?.call_id;
check("create returns session.call_code + call_id", Boolean(sessionId && callCode && callId), JSON.stringify(go.json?.data || {}).slice(0, 200));

const callRow = await client.query(`SELECT status, type FROM calls WHERE id = $1`, [callId]);
check("bridged calls row exists (ongoing/live)", callRow.rows[0]?.status === "ongoing" && callRow.rows[0]?.type === "live", JSON.stringify(callRow.rows[0]));

const again = await api("POST", "/live", hostToken, { title: "Second show" });
check("duplicate go-live reopens same session", again.json?.data?.session?.id === sessionId && /already live/i.test(String(again.json?.data?.message || "")));

// ---------------------------------------------------------------------------
// 2) Wall + join
// ---------------------------------------------------------------------------
const wall = await api("GET", "/live", viewerToken);
check("wall lists the live session (host hydrated)", (wall.json?.data?.sessions || []).some((s) => s.id === sessionId && s.host_name === "Probe Host"));

const joinByCode = await api("POST", `/live/${callCode}/join`, viewerToken, {});
check("join by call_code → call_id + watch_url", joinByCode.json?.data?.call_id === callId && String(joinByCode.json?.data?.watch_url || "").includes("watch=1"), JSON.stringify(joinByCode.json?.data || {}).slice(0, 200));

const joinById = await api("POST", `/live/${sessionId}/join`, viewerToken, {});
check("join by uuid works too", joinById.json?.data?.call_id === callId);

const mediaJoin = await api("POST", `/calls/${callId}/join`, viewerToken, {});
check("POST /calls/:id/join works (media bridge)", mediaJoin.status === 200, `got ${mediaJoin.status} ${JSON.stringify(mediaJoin.json).slice(0, 180)}`);

const detailV = await api("GET", `/live/${sessionId}`, viewerToken);
check("viewer detail: is_host false, viewers hidden", detailV.json?.data?.session?.is_host === false && (detailV.json?.data?.viewers || []).length === 0);

// ---------------------------------------------------------------------------
// 3) Chat
// ---------------------------------------------------------------------------
const sent = await api("POST", `/live/${sessionId}/chat`, viewerToken, { body: "Hello from the probe" });
check("viewer posts chat", sent.status === 201 && sent.json?.data?.message?.body === "Hello from the probe");
const msgId = sent.json?.data?.message?.id;

const hostChat = await api("GET", `/live/${sessionId}/chat`, hostToken);
check("host poll sees message (author hydrated)", (hostChat.json?.data?.messages || []).some((m) => m.id === msgId && m.author?.name === "Probe Viewer"));

const cursorPoll = await api("GET", `/live/${sessionId}/chat?since_id=${msgId}`, hostToken);
check("since_id cursor returns no repeats", (cursorPoll.json?.data?.messages || []).length === 0, JSON.stringify(cursorPoll.json?.data?.messages || []).slice(0, 120));

// ---------------------------------------------------------------------------
// 4) Reactions
// ---------------------------------------------------------------------------
await api("POST", `/live/${sessionId}/react`, viewerToken, { emoji: "heart" });
const reacts = await api("GET", `/live/${sessionId}/reactions?minutes=2`, hostToken);
check("reaction aggregated (heart ×1)", reacts.json?.data?.reactions?.[0]?.emoji === "heart" && Number(rectsN(reacts)) === 1, JSON.stringify(reacts.json?.data));
function rectsN(r) { return r.json?.data?.reactions?.[0]?.n; }

// ---------------------------------------------------------------------------
// 5) Host dashboard detail
// ---------------------------------------------------------------------------
const detail = await api("GET", `/live/${sessionId}`, hostToken);
check("host detail: is_host, viewer listed", detail.json?.data?.session?.is_host === true && (detail.json?.data?.viewers || []).length === 1);
check("detail counters (views ≥1, reactions 1)", Number(detail.json?.data?.session?.total_views) >= 1 && Number(detail.json?.data?.session?.reaction_count) === 1, JSON.stringify({
  tv: detail.json?.data?.session?.total_views, rc: detail.json?.data?.session?.reaction_count, cv: detail.json?.data?.session?.current_viewers,
}));
// NOTE: upstream bumps total_views/current_viewers on EVERY join call — a
// repeated join double-counts until the viewer leaves. Frontend joins once
// per entry, so real impact is cosmetic; flagged in the worklog.

// ---------------------------------------------------------------------------
// 6) Slow mode
// ---------------------------------------------------------------------------
await api("POST", `/live/${sessionId}/slow-mode`, hostToken, { seconds: 30 });
const slowHit = await api("POST", `/live/${sessionId}/chat`, viewerToken, { body: "too fast?" });
check("slow mode → 429 SLOW_MODE", slowHit.status === 429 && slowHit.json?.code === "SLOW_MODE", `got ${slowHit.status} ${JSON.stringify(slowHit.json)}`);
await api("POST", `/live/${sessionId}/slow-mode`, hostToken, { seconds: 0 });

// ---------------------------------------------------------------------------
// 7) Pin + moderation
// ---------------------------------------------------------------------------
const pin = await api("POST", `/live/${sessionId}/pin`, hostToken, { message_id: msgId });
const afterPin = await api("GET", `/live/${sessionId}`, hostToken);
check("pin works + detail exposes pinned_message", pin.status === 200 && afterPin.json?.data?.session?.pinned_message === "Hello from the probe", JSON.stringify({ p: pin.json, pm: afterPin.json?.data?.session?.pinned_message }));

const second = await api("POST", `/live/${sessionId}/chat`, viewerToken, { body: "to be removed" });
await api("POST", `/live/${sessionId}/moderate`, hostToken, { action: "remove_message", target_id: second.json?.data?.message?.id });
const afterRemove = await api("GET", `/live/${sessionId}/chat`, viewerToken);
check("removed message excluded from chat", !(afterRemove.json?.data?.messages || []).some((m) => m.body === "to be removed"));

await api("POST", `/live/${sessionId}/moderate`, hostToken, { action: "ban_viewer", target_id: viewerUserId });
const detailAfterBan = await api("GET", `/live/${sessionId}`, hostToken);
check("ban removes viewer from the list", (detailAfterBan.json?.data?.viewers || []).length === 0);

// ---------------------------------------------------------------------------
// 8) Gifts (real wallet movement)
// ---------------------------------------------------------------------------
const catalog = await api("GET", "/live/gifts", viewerToken);
const gifts = catalog.json?.data?.gifts || [];
check("gift catalog served (10 tiers)", gifts.length === 10 && gifts.every((g) => g.id && g.icon && g.price > 0), `got ${gifts.length}`);
const rose = gifts.find((g) => g.name === "Rose");
const yacht = gifts.find((g) => g.name === "Yacht");

const gift = await api("POST", `/live/${callCode}/gifts`, viewerToken, { gift_id: rose.id, quantity: 2 });
check("gift sent → sender debited (10000-40=9960)", gift.json?.data?.balance === 9960, JSON.stringify(gift.json).slice(0, 240));
// Pocket flow (default 0% commission): the HOST's gift pocket earns the full
// ₦40; the NGN wallet stays untouched until the streamer withdraws.
const hostPocket = await client.query(`SELECT total_earned FROM live_gift_pockets WHERE user_id = $1`, [hostUserId]);
check("host gift pocket credited ₦40", Number(hostPocket.rows[0]?.total_earned) === 40, String(hostPocket.rows[0]?.total_earned));
const hostWallet = await client.query(`SELECT balance FROM wallets WHERE user_id = $1`, [hostUserId]);
check("host NGN wallet untouched (0) until withdrawal", Number(hostWallet.rows[0].balance) === 0, String(hostWallet.rows[0].balance));
const legs = await client.query(
  `SELECT transaction_type, direction FROM transactions WHERE reference LIKE 'LGFT-%' AND user_id IN ($1,$2)`,
  [hostUserId, viewerUserId],
);
check("sender leg ledgered (live_gift debit)", legs.rows.length === 1 && legs.rows.some((r) => r.transaction_type === "live_gift" && r.direction === "debit"), JSON.stringify(legs.rows));
const giftSplit = await client.query(`SELECT commission_amount, host_amount FROM live_gifts WHERE session_id = $1 AND gift_id = 'rose' LIMIT 1`, [sessionId]);
check("gift row carries pocket split (0% commission → host_amount = 40)", Number(giftSplit.rows[0]?.host_amount) === 40 && Number(giftSplit.rows[0]?.commission_amount) === 0, JSON.stringify(giftSplit.rows[0]));

const recent = await api("GET", `/live/${callCode}/gifts`, hostToken);
const rec = recent.json?.data?.recent || [];
check("recent gift ticker has id + sender (frontend needs g.id)", rec.some((g) => g.gift_name === "Rose" && g.sender_name === "Probe Viewer" && g.quantity === 2 && Boolean(g.id)), JSON.stringify(rec[0] || {}).slice(0, 200));

const broke = await api("POST", `/live/${callCode}/gifts`, viewerToken, { gift_id: yacht.id, quantity: 99 });
check("insufficient funds → 400 INSUFFICIENT_BALANCE", broke.status === 400 && broke.json?.code === "INSUFFICIENT_BALANCE", JSON.stringify(broke.json).slice(0, 160));

const selfGift = await api("POST", `/live/${callCode}/gifts`, hostToken, { gift_id: rose.id, quantity: 1 });
check("self-gift rejected", selfGift.status === 400);

// ---------------------------------------------------------------------------
// 9) Leave + end
// ---------------------------------------------------------------------------
await api("POST", `/live/${sessionId}/join`, viewerToken, {}); // rejoin after ban (upstream ban = kick)
const leave = await api("POST", `/live/${sessionId}/leave`, viewerToken, {});
check("leave accepted", leave.status === 200);
const detailAfterLeave = await api("GET", `/live/${sessionId}`, hostToken);
check("viewer list empty after leave", (detailAfterLeave.json?.data?.viewers || []).length === 0);

const end = await api("POST", `/live/${sessionId}/end`, hostToken, {});
const sum = end.json?.data?.summary || {};
check("end → summary (peak/views/reactions)", end.status === 200 && "peak_viewers" in sum && "total_views" in sum && "reaction_count" in sum, JSON.stringify(sum));
const callAfter = await client.query(`SELECT status FROM calls WHERE id = $1`, [callId]);
check("bridged calls row completed on end", callAfter.rows[0]?.status === "completed");
const wallAfter = await api("GET", "/live", viewerToken);
check("ended stream off the wall", !(wallAfter.json?.data?.sessions || []).some((s) => s.id === sessionId));
const joinEnded = await api("POST", `/live/${sessionId}/join`, viewerToken, {});
check("join after end → 404 (not live)", joinEnded.status === 404);

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
await client.query(`DELETE FROM live_gifts WHERE session_id = $1`, [sessionId]);
await client.query(`DELETE FROM live_pocket_withdrawals WHERE user_id IN ($1,$2)`, [hostUserId, viewerUserId]);
await client.query(`DELETE FROM live_gift_pockets WHERE user_id IN ($1,$2)`, [hostUserId, viewerUserId]);
await client.query(`DELETE FROM live_battles WHERE host_a_id = $1 OR host_b_id = $1`, [hostUserId]);
await client.query(`DELETE FROM live_messages WHERE session_id = $1`, [sessionId]);
await client.query(`DELETE FROM live_reactions WHERE session_id = $1`, [sessionId]);
await client.query(`DELETE FROM live_viewers WHERE session_id = $1`, [sessionId]);
await client.query(`DELETE FROM live_sessions WHERE id = $1`, [sessionId]);
await client.query(`DELETE FROM transactions WHERE (reference LIKE 'LGFT-%') AND user_id IN ($1,$2)`, [hostUserId, viewerUserId]);
await client.query(`DELETE FROM calls WHERE id = $1`, [callId]);
await client.query(`DELETE FROM wallets WHERE user_id IN ($1,$2)`, [hostUserId, viewerUserId]);
await client.query(`DELETE FROM user_sessions WHERE user_id IN ($1,$2)`, [hostUserId, viewerUserId]);
await client.query(`DELETE FROM users WHERE id IN ($1,$2)`, [hostUserId, viewerUserId]);
await client.query(`DELETE FROM businesses WHERE id = $1`, [businessId]);

console.log(results.join("\n"));
console.log(`\nLIVE PROBE: ${passed} passed, ${failed} failed`);
await client.end();
process.exit(failed ? 1 : 0);
