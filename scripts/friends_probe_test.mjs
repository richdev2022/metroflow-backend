/**
 * Friends + account-privacy E2E probe — LOCAL backend (PORT=3099), real DB,
 * self-cleaning. Verifies: friend request lifecycle (send/list/accept/decline/
 * cancel), the PRIVATE_ACCOUNT chat gate on POST /chat/conversations, the
 * public-account open-chat path, /auth/me accountPrivacy, and the
 * PUT /settings/profile/privacy endpoint.
 *
 *   node scripts/friends_probe_test.mjs
 */
import crypto from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ override: true });
import pg from "pg";

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:3099/api";
const stamp = Date.now().toString(36);

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
  try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const mk = async (name, biz = businessId, privacy = "public") => {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO users (id, business_id, email, name, role, status, email_verified, auth_provider, account_privacy, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'owner', 'active', TRUE, 'email', $5, NOW(), NOW())`,
    [id, biz, `${name.toLowerCase()}-${stamp}@probe.metricorex.test`, name, privacy],
  );
  return id;
};

let businessId = crypto.randomUUID();
const plan = await client.query(`SELECT id FROM pricing_plans ORDER BY (price::numeric) ASC LIMIT 1`);
await client.query(
  `INSERT INTO businesses (id, name, email, currency, plan_id, subscription_status, kyc_status, created_at, updated_at)
   VALUES ($1, $2, $3, 'NGN', $4, 'active', 'none', NOW(), NOW())`,
  [businessId, `Friends Probe ${stamp}`, `friends-probe-${stamp}@probe.metricorex.test`, plan.rows[0].id],
);
// Alice lives in her OWN workspace (like real Personal users) so the
// teammate exemption in the private-chat gate does NOT apply.
let aliceBizId = crypto.randomUUID();
await client.query(
  `INSERT INTO businesses (id, name, email, currency, plan_id, subscription_status, kyc_status, created_at, updated_at)
   VALUES ($1, $2, $3, 'NGN', $4, 'active', 'none', NOW(), NOW())`,
  [aliceBizId, `Alice Space ${stamp}`, `alice-space-${stamp}@probe.metricorex.test`, plan.rows[0].id],
);

const alice = await mk("Probe Alice", aliceBizId, "public");   // will go PRIVATE via settings
const bob   = await mk("Probe Bob");     // requester
const carol = await mk("Probe Carol");   // public control

const mkToken = async (userId) => {
  const token = crypto.randomBytes(32).toString("hex");
  await client.query(`INSERT INTO user_sessions (user_id, business_id, token) VALUES ($1, $2, $3)`, [userId, businessId, token]);
  return token;
};
const aliceTok = await mkToken(alice);
const bobTok = await mkToken(bob);
const carolTok = await mkToken(carol);

// 1) Alice goes private via the settings endpoint
const setPriv = await api("PUT", "/settings/profile/privacy", aliceTok, { privacy: "private" });
check("PUT /settings/profile/privacy → private", setPriv.status === 200 && setPriv.json?.data?.accountPrivacy === "private", JSON.stringify(setPriv.json));
const me1 = await api("GET", "/auth/me", aliceTok);
check("/auth/me exposes accountPrivacy=private", me1.json?.data?.accountPrivacy === "private");

// 2) Private gate: Bob CANNOT DM Alice
const dmBlocked = await api("POST", "/chat/conversations", bobTok, { type: "direct", participantIds: [alice] });
check("direct chat to private account → 403 PRIVATE_ACCOUNT", dmBlocked.status === 403 && dmBlocked.json?.code === "PRIVATE_ACCOUNT", JSON.stringify(dmBlocked.json).slice(0, 180));

// 3) Public control: Bob CAN DM Carol
const dmOk = await api("POST", "/chat/conversations", bobTok, { type: "direct", participantIds: [carol] });
check("direct chat to public account works", dmOk.status === 200 || dmOk.status === 201, `got ${dmOk.status} ${JSON.stringify(dmOk.json).slice(0, 140)}`);

// 4) Bob sends Alice a friend request
const req1 = await api("POST", "/friends/requests", bobTok, { user_id: alice });
check("friend request → pending_out", req1.status === 201 && req1.json?.data?.status === "pending_out", JSON.stringify(req1.json));

// duplicate send is idempotent
const req2 = await api("POST", "/friends/requests", bobTok, { user_id: alice });
check("duplicate request stays pending_out", req2.json?.data?.status === "pending_out");

// 5) Alice sees it incoming; Bob sees it outgoing
const inbox = await api("GET", "/friends/requests", aliceTok);
const hit = (inbox.json?.data?.incoming || []).find((x) => x.user_id === bob);
check("incoming request listed (with name)", Boolean(hit) && hit.name === "Probe Bob");
const outbox = await api("GET", "/friends/requests", bobTok);
check("outgoing request listed", (outbox.json?.data?.outgoing || []).some((x) => x.user_id === alice));

// 6) Alice accepts → friends; Bob can now DM Alice
const acc = await api("POST", `/friends/requests/${hit.id}/accept`, aliceTok, {});
check("accept → friends", acc.json?.data?.status === "friends", JSON.stringify(acc.json));
const dmUnlocked = await api("POST", "/chat/conversations", bobTok, { type: "direct", participantIds: [alice] });
check("friend can DM the private account now", dmUnlocked.status === 200 || dmUnlocked.status === 201, `got ${dmUnlocked.status}`);
const friendsList = await api("GET", "/friends", aliceTok);
check("friends list contains Bob", (friendsList.json?.data?.friends || []).some((f) => f.id === bob));

// 7) Carol sends Bob a request then cancels it
const reqC = await api("POST", "/friends/requests", carolTok, { user_id: bob });
const outC = await api("GET", "/friends/requests", carolTok);
const outHit = (outC.json?.data?.outgoing || []).find((x) => x.user_id === bob);
check("cancel outgoing request", outHit && (await api("DELETE", `/friends/requests/${outHit.id}`, carolTok, {})).status === 200);
const outAfter = await api("GET", "/friends/requests", carolTok);
check("cancelled request gone", !(outAfter.json?.data?.outgoing || []).some((x) => x.user_id === bob));
void reqC;

// 8) Decline path: Carol → Alice, Alice declines
await api("POST", "/friends/requests", carolTok, { user_id: alice });
const inbox2 = await api("GET", "/friends/requests", aliceTok);
const hit2 = (inbox2.json?.data?.incoming || []).find((x) => x.user_id === carol);
const dec = await api("POST", `/friends/requests/${hit2.id}/decline`, aliceTok, {});
check("decline → declined", dec.json?.data?.status === "declined");

// 9) Alice back to public
await api("PUT", "/settings/profile/privacy", aliceTok, { privacy: "public" });
const me2 = await api("GET", "/auth/me", aliceTok);
check("public again via settings", me2.json?.data?.accountPrivacy === "public");

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
await client.query(`DELETE FROM friend_requests WHERE requester_id IN ($1,$2,$3) OR addressee_id IN ($1,$2,$3)`, [alice, bob, carol]);
await client.query(`DELETE FROM chat_messages WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE created_by = $1)`, [bob]);
await client.query(`DELETE FROM chat_participants WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE created_by = $1)`, [bob]);
await client.query(`DELETE FROM chat_conversations WHERE created_by = $1`, [bob]);
await client.query(`DELETE FROM user_sessions WHERE user_id IN ($1,$2,$3)`, [alice, bob, carol]);
await client.query(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [alice, bob, carol]);
await client.query(`DELETE FROM businesses WHERE id IN ($1,$2)`, [businessId, aliceBizId]);

console.log(results.join("\n"));
console.log(`\nFRIENDS PROBE: ${passed} passed, ${failed} failed`);
await client.end();
process.exit(failed ? 1 : 0);
