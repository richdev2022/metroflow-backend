/**
 * Social graph + LIVE battles + gift pocket E2E probe — LOCAL backend
 * (PORT=3099), real DB, self-cleaning.
 *
 *   node scripts/social_live_probe_test.mjs
 *
 * Covers:
 *   SOCIAL  — follow (public instant / private request), follow-back,
 *             unfollow, followers+following lists, public profile endpoint
 *             (stats incl. likes, posts grid, private lock), username+bio
 *             update, profile lookup by username.
 *   BATTLES — invite (binds both sessions), accept, gift scoring with the
 *             admin multiplier, lazy finalize + winner, rankings (top viewers
 *             / top gifters / guardian).
 *   POCKET  — gift commission split, host POCKET credit (NOT wallet),
 *             per-session breakdown, withdrawal fee + min + PIN, atomic
 *             insufficient guard, wallet credit + ledger, stream detail log.
 */
import crypto from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ override: true });
import pg from "pg";

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:3099/api";
const stamp = Date.now().toString(36);
const EA = `slp-hosta-${stamp}@probe.metricorex.test`;
const EB = `slp-hostb-${stamp}@probe.metricorex.test`;
const EV = `slp-viewer-${stamp}@probe.metricorex.test`;
const EP = `slp-priv-${stamp}@probe.metricorex.test`;

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

let bizA, bizB, bizV, bizP;
let hostA, hostB, viewer, priv;
let tokA, tokB, tokV, tokP;
let sessionA, sessionB, codeA, codeB, callA, callB;

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

// Save the live_settings so we can restore it.
const savedSettings = (await client.query(`SELECT value FROM system_settings WHERE key = 'live_settings'`)).rows[0]?.value ?? null;

try {
  // ------------------------------------------------------------------
  // Setup: 4 users (2 streamers, 1 viewer, 1 private account)
  // ------------------------------------------------------------------
  bizA = await mkBiz(`SLP A ${stamp}`); bizB = await mkBiz(`SLP B ${stamp}`);
  bizV = await mkBiz(`SLP V ${stamp}`); bizP = await mkBiz(`SLP P ${stamp}`);
  hostA = await mkUser(bizA, EA, "Probe HostA");
  hostB = await mkUser(bizB, EB, "Probe HostB");
  viewer = await mkUser(bizV, EV, "Probe Viewer");
  priv = await mkUser(bizP, EP, "Probe Private");

  await client.query(`INSERT INTO wallets (id, user_id, currency, balance) VALUES ($1,$2,'NGN',20000)`, [crypto.randomUUID(), viewer]);
  await client.query(`INSERT INTO wallets (id, user_id, currency, balance) VALUES ($1,$2,'NGN',0)`, [crypto.randomUUID(), hostA]);
  await client.query(`INSERT INTO wallets (id, user_id, currency, balance) VALUES ($1,$2,'NGN',0)`, [crypto.randomUUID(), hostB]);

  tokA = await mkToken(hostA, bizA); tokB = await mkToken(hostB, bizB);
  tokV = await mkToken(viewer, bizV); tokP = await mkToken(priv, bizP);

  // Test economics: 10% commission, 5%+10 withdrawal fee, min 100, ×2 battles
  await client.query(
    `INSERT INTO system_settings (key, value, description) VALUES ('live_settings', $1::jsonb, 'probe')
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`,
    [JSON.stringify({ currency: "NGN", gift_prices: {}, gift_commission_percent: 10, withdrawal_fee_percent: 5, withdrawal_fee_flat: 10, withdrawal_min: 100, battle_duration_seconds: 300, battle_multiplier: 2 })],
  );

  // ==================================================================
  // 1) SOCIAL GRAPH
  // ==================================================================
  const f1 = await api("POST", `/social/users/${hostB}/follow`, tokA, {});
  check("follow public account → following", f1.status === 201 && f1.json?.data?.status === "following", JSON.stringify(f1.json).slice(0, 160));

  const f1b = await api("POST", `/social/users/${hostB}/follow`, tokA, {});
  check("follow idempotent", f1b.status === 200 && f1b.json?.data?.status === "following");

  // hostB's profile shows followed_by for hostA relationship? (B views A)
  const profAasB = await api("GET", `/social/users/${hostA}`, tokB, {});
  check("profile endpoint works by UUID", profAasB.status === 200 && profAasB.json?.data?.user?.id === hostA, JSON.stringify(profAasB.json?.data?.user || {}).slice(0, 160));

  const f2 = await api("POST", `/social/users/${hostA}/follow`, tokB, {});
  check("reverse follow works (follow-back setup)", f2.status === 201);

  const profAasAv2 = await api("GET", `/social/users/${hostB}`, tokA, {});
  check("relationship: following + followed_by + friends", profAasAv2.json?.data?.relationship?.following === true && profAasAv2.json?.data?.relationship?.followed_by === true && profAasAv2.json?.data?.relationship?.friends === true, JSON.stringify(profAasAv2.json?.data?.relationship || {}));

  const followersB = await api("GET", `/social/users/${hostB}/followers`, tokB, {});
  check("followers list includes hostA", (followersB.json?.data?.users || []).some((u) => u.id === hostA));

  // Private account: viewer requests to follow `priv`
  await client.query(`UPDATE users SET account_privacy = 'private' WHERE id = $1`, [priv]);
  const pf = await api("POST", `/social/users/${priv}/follow`, tokV, {});
  check("private account → follow REQUESTED", pf.status === 201 && pf.json?.data?.status === "requested", JSON.stringify(pf.json).slice(0, 140));

  const privReqs = await api("GET", "/social/follow/requests", tokP, {});
  const incomingId = (privReqs.json?.data?.incoming || [])[0]?.id;
  check("private account sees the follow request", Boolean(incomingId), JSON.stringify(privReqs.json?.data || {}).slice(0, 140));

  const profPrivAsViewer = await api("GET", `/social/users/${priv}`, tokV, {});
  check("private profile locked for non-follower", profPrivAsViewer.json?.data?.is_private === true && profPrivAsViewer.json?.data?.can_view_posts === false);

  const acc = await api("POST", `/social/follow/requests/${incomingId}/accept`, tokP, {});
  check("accept follow request", acc.status === 200);

  const profPrivAfter = await api("GET", `/social/users/${priv}`, tokV, {});
  check("posts unlocked after accept + following=true", profPrivAfter.json?.data?.can_view_posts === true && profPrivAfter.json?.data?.relationship?.following === true, JSON.stringify(profPrivAfter.json?.data?.relationship || {}).slice(0, 140));

  // Username + bio + lookup
  const up = await api("PUT", "/settings/profile", tokA, { username: `slp_hosta_${stamp}`, bio: "Probe streamer — check my live shows" });
  check("PUT /settings/profile sets username+bio", up.status === 200, JSON.stringify(up.json).slice(0, 160));
  const byHandle = await api("GET", `/social/users/slp_hosta_${stamp}`, tokV, {});
  check("profile resolves by username handle", byHandle.status === 200 && byHandle.json?.data?.user?.id === hostA);
  const dupe = await api("PUT", "/settings/profile", tokB, { username: `SLP_HOSTA_${stamp}` });
  check("duplicate username rejected 409", dupe.status === 409 && dupe.json?.code === "USERNAME_TAKEN", JSON.stringify(dupe.json).slice(0, 140));

  // ==================================================================
  // 2) GO LIVE (both hosts) + BATTLE
  // ==================================================================
  const goA = await api("POST", "/live", tokA, { title: "Battle Night A", category: "music" });
  const goB = await api("POST", "/live", tokB, { title: "Battle Night B", category: "dance" });
  check("both hosts live", goA.status === 201 && goB.status === 201);
  sessionA = goA.json?.data?.session?.id; codeA = goA.json?.data?.session?.call_code;
  sessionB = goB.json?.data?.session?.id; codeB = goB.json?.data?.session?.call_code;
  callA = goA.json?.data?.call_id; callB = goB.json?.data?.call_id;

  const opps = await api("GET", "/live/battles/opponents", tokA, {});
  check("opponent list includes hostB's session", (opps.json?.data?.opponents || []).some((o) => o.session_id === sessionB), JSON.stringify(opps.json?.data || {}).slice(0, 200));

  const inv = await api("POST", `/live/${sessionA}/battle`, tokA, { opponent_session_id: sessionB });
  check("battle invite created (pending, both bound)", inv.status === 201 && inv.json?.data?.battle?.status === "pending" && inv.json?.data?.battle?.host_b?.id === hostB, JSON.stringify(inv.json?.data?.battle || {}).slice(0, 240));
  const battleId = inv.json?.data?.battle?.id;

  const stateB = await api("GET", `/live/${codeB}/battle`, tokB, {});
  check("opponent sees invite via call_code (can_accept)", stateB.json?.data?.battle?.can_accept === true && stateB.json?.data?.battle?.i_am_host_b === true);

  // viewer joins both rooms (watch-time for rankings)
  await api("POST", `/live/${sessionA}/join`, tokV, {});
  await api("POST", `/live/${sessionB}/join`, tokV, {});

  const accB = await api("POST", `/live/battles/${battleId}/accept`, tokB, {});
  check("accept → battle ACTIVE with countdown", accB.status === 200 && accB.json?.data?.battle?.status === "active" && accB.json?.data?.battle?.seconds_left > 0, JSON.stringify(accB.json?.data?.battle || {}).slice(0, 200));

  // ==================================================================
  // 3) GIFTS DURING BATTLE → pocket + scores
  // ==================================================================
  // rose = ₦20 (default). qty 2 → ₦40. commission 10% → ₦4, host net ₦36.
  const g1 = await api("POST", `/live/${sessionA}/gifts`, tokV, { gift_id: "rose", quantity: 2 });
  check("gift to A accepted", g1.status === 201, JSON.stringify(g1.json).slice(0, 200));
  check("battle points reported (40 × 2 = 80)", g1.json?.data?.battle?.points === 80 && g1.json?.data?.battle?.side === "a", JSON.stringify(g1.json?.data?.battle || {}).slice(0, 140));

  const g2 = await api("POST", `/live/${sessionB}/gifts`, tokV, { gift_id: "crown", quantity: 1 });
  check("gift to B accepted (points 500)", g2.json?.data?.battle?.points === 500 && g2.json?.data?.battle?.side === "b", JSON.stringify(g2.json?.data?.battle || {}).slice(0, 140));

  // Host pockets credited (net of 10% commission), wallets NOT
  const pocketA = (await client.query(`SELECT total_earned FROM live_gift_pockets WHERE user_id = $1`, [hostA])).rows[0];
  check("hostA pocket +36 (40 - 10%)", Number(pocketA?.total_earned) === 36, String(pocketA?.total_earned));
  const walletA = (await client.query(`SELECT balance FROM wallets WHERE user_id = $1 AND currency = 'NGN'`, [hostA])).rows[0];
  check("hostA NGN wallet untouched (0)", Number(walletA?.balance) === 0, String(walletA?.balance));
  const giftRow = (await client.query(`SELECT commission_amount, host_amount FROM live_gifts WHERE sender_id = $1 AND gift_id = 'rose'`, [viewer])).rows[0];
  check("live_gifts row carries commission + host split", Number(giftRow?.commission_amount) === 4 && Number(giftRow?.host_amount) === 36, JSON.stringify(giftRow));

  const stateBattle = await api("GET", `/live/${sessionA}/battle`, tokV, {});
  check("battle scores: A=80, B=500", stateBattle.json?.data?.battle?.scores?.a === 80 && stateBattle.json?.data?.battle?.scores?.b === 500, JSON.stringify(stateBattle.json?.data?.battle?.scores || {}));

  // Rankings
  const rank = await api("GET", `/live/${sessionA}/rankings`, tokV, {});
  check("top gifters ranked (viewer)", (rank.json?.data?.top_gifters || []).some((g) => g.sender_id === viewer && Number(g.total_sent) === 40));
  check("guardian = top gifter", rank.json?.data?.guardian?.sender_id === viewer, JSON.stringify(rank.json?.data?.guardian || {}).slice(0, 160));
  check("top viewers includes viewer w/ watch time", (rank.json?.data?.top_viewers || []).some((v) => v.user_id === viewer && v.watch_seconds >= 0));

  // Expire the battle via direct DB nudge → lazy finalize on next read
  await client.query(`UPDATE live_battles SET ends_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [battleId]);
  const stateFinal = await api("GET", `/live/${sessionB}/battle`, tokB, {});
  check("battle finalized: B wins (500 > 80)", stateFinal.json?.data?.battle?.status === "ended" && stateFinal.json?.data?.battle?.winner === "b", JSON.stringify(stateFinal.json?.data?.battle || {}).slice(0, 200));
  check("win count for hostB = 1", stateFinal.json?.data?.battle?.wins?.b === 1);

  // ==================================================================
  // 4) GIFT POCKET + WITHDRAWAL
  // ==================================================================
  const pk = await api("GET", "/live/pocket", tokA, {});
  check("pocket balance 36 + fee schedule present", pk.json?.data?.balance === 36 && pk.json?.data?.fees?.withdrawal_min === 100, JSON.stringify(pk.json?.data || {}).slice(0, 240));

  const belowMin = await api("POST", "/live/pocket/withdraw", tokA, { amount: 50, pin: "123456" });
  check("below minimum → 400 BELOW_MIN", belowMin.status === 400 && belowMin.json?.code === "BELOW_MIN", JSON.stringify(belowMin.json).slice(0, 140));

  const badPin = await api("POST", "/live/pocket/withdraw", tokA, { amount: 100, pin: "000000" });
  check("wrong/absent PIN blocked", badPin.status === 400 || badPin.status === 403, JSON.stringify(badPin.json).slice(0, 140));

  // Give hostA a PIN (123456) using the same hashing the app uses.
  const bcrypt = (await import("bcryptjs")).default;
  const pinHash = await bcrypt.hash("123456", 10);
  await client.query(`UPDATE users SET transaction_pin_hash = $1 WHERE id = $2`, [pinHash, hostA]);

  // Top up the pocket with a bigger gift (yacht ₦10,000 → net 9,000)
  const g3 = await api("POST", `/live/${sessionA}/gifts`, tokV, { gift_id: "yacht", quantity: 1 });
  check("big gift accepted (net 9000 to pocket)", g3.status === 201);
  const pk2 = await api("GET", "/live/pocket", tokA, {});
  check("pocket now 9036", pk2.json?.data?.balance === 9036, String(pk2.json?.data?.balance));

  const wd = await api("POST", "/live/pocket/withdraw", tokA, { amount: 1000, pin: "123456" });
  // fee = 5% (50) + flat 10 = 60 → net 940
  check("withdrawal succeeds (net 940 after ₦60 fee)", wd.status === 201 && wd.json?.data?.withdrawal?.net_amount === 940 && wd.json?.data?.withdrawal?.fee === 60, JSON.stringify(wd.json).slice(0, 240));
  const walletA2 = (await client.query(`SELECT balance FROM wallets WHERE user_id = $1 AND currency = 'NGN'`, [hostA])).rows[0];
  check("NGN wallet credited 940", Number(walletA2?.balance) === 940, String(walletA2?.balance));
  const ledger = (await client.query(`SELECT transaction_type, amount, direction FROM transactions WHERE reference = $1`, [wd.json?.data?.withdrawal?.reference])).rows[0];
  check("withdrawal ledgered as live_pocket_withdrawal credit", ledger?.transaction_type === "live_pocket_withdrawal" && Number(ledger?.amount) === 940, JSON.stringify(ledger));
  const pk3 = await api("GET", "/live/pocket", tokA, {});
  check("pocket debited (9036-1000=8036) + withdrawals list", pk3.json?.data?.balance === 8036 && (pk3.json?.data?.withdrawals || []).length === 1, JSON.stringify({ bal: pk3.json?.data?.balance, n: (pk3.json?.data?.withdrawals || []).length }));

  const overWd = await api("POST", "/live/pocket/withdraw", tokA, { amount: 999999, pin: "123456" });
  check("overdraw blocked INSUFFICIENT_POCKET", overWd.status === 400 && overWd.json?.code === "INSUFFICIENT_POCKET");

  // ==================================================================
  // 5) STREAM DETAIL (log page)
  // ==================================================================
  const det = await api("GET", `/live/${sessionA}/detail`, tokA, {});
  const ds = det.json?.data || {};
  check("detail: session + stats + gifts + top gifters + battles", det.status === 200 && ds.session?.id === sessionA && Array.isArray(ds.gifts) && Array.isArray(ds.battles) && Array.isArray(ds.top_gifters), JSON.stringify(ds.session || {}).slice(0, 200));
  check("detail (host): commission + host_net exposed", Number(ds.stats?.commission) === 1004 && Number(ds.stats?.host_net) === 9036, JSON.stringify(ds.stats || {}).slice(0, 200));
  check("detail battle result recorded", (ds.battles || []).some((b) => b.id === battleId));
  const detV = await api("GET", `/live/${sessionA}/detail`, tokV, {});
  check("viewer detail hides money internals", detV.json?.data?.stats?.commission === undefined && detV.json?.data?.stats?.host_net === undefined);

  // End stream → summary carries id + call_code for the log page
  const endA = await api("POST", `/live/${sessionA}/end`, tokA, {});
  check("end returns id + call_code (log page nav)", endA.status === 200 && Boolean(endA.json?.data?.summary?.id) && Boolean(endA.json?.data?.summary?.call_code), JSON.stringify(endA.json?.data?.summary || {}).slice(0, 140));

} catch (e) {
  failed++;
  results.push(`  FATAL ${e?.message}`);
} finally {
  // ------------------------------------------------------------------
  // Teardown — self-cleaning
  // ------------------------------------------------------------------
  try {
    await client.query(`DELETE FROM live_pocket_withdrawals WHERE user_id IN ($1,$2,$3,$4)`, [hostA, hostB, viewer, priv]);
    await client.query(`DELETE FROM live_gift_pockets WHERE user_id IN ($1,$2,$3,$4)`, [hostA, hostB, viewer, priv]);
    await client.query(`DELETE FROM live_battles WHERE host_a_id IN ($1,$2,$3,$4) OR host_b_id IN ($1,$2,$3,$4)`, [hostA, hostB, viewer, priv]);
    await client.query(`DELETE FROM live_gifts WHERE host_user_id IN ($1,$2) OR sender_id IN ($1,$2,$3,$4)`, [hostA, hostB, viewer, priv]);
    await client.query(`DELETE FROM live_viewers WHERE session_id IN (SELECT id FROM live_sessions WHERE host_id IN ($1,$2))`, [hostA, hostB]);
    await client.query(`DELETE FROM live_messages WHERE session_id IN (SELECT id FROM live_sessions WHERE host_id IN ($1,$2))`, [hostA, hostB]);
    await client.query(`DELETE FROM live_reactions WHERE session_id IN (SELECT id FROM live_sessions WHERE host_id IN ($1,$2))`, [hostA, hostB]);
    await client.query(`DELETE FROM live_sessions WHERE host_id IN ($1,$2)`, [hostA, hostB]);
    await client.query(`DELETE FROM calls WHERE id IN ($1,$2)`, [callA, callB]);
    await client.query(`DELETE FROM transactions WHERE user_id IN ($1,$2,$3,$4) AND (reference LIKE 'LGFT%' OR reference LIKE 'LPWD%')`, [hostA, hostB, viewer, priv]);
    await client.query(`DELETE FROM social_follows WHERE follower_id IN ($1,$2,$3,$4) OR following_id IN ($1,$2,$3,$4)`, [hostA, hostB, viewer, priv]);
    await client.query(`DELETE FROM social_follow_requests WHERE requester_id IN ($1,$2,$3,$4) OR target_id IN ($1,$2,$3,$4)`, [hostA, hostB, viewer, priv]);
    await client.query(`DELETE FROM users WHERE id IN ($1,$2,$3,$4)`, [hostA, hostB, viewer, priv]);
    await client.query(`DELETE FROM businesses WHERE id IN ($1,$2,$3,$4)`, [bizA, bizB, bizV, bizP]);
  } catch (te) {
    results.push(`  TEARDOWN-WARN ${te?.message}`);
  }
  // The settings restore MUST run even if row cleanup above failed.
  try {
    if (savedSettings !== null) {
      await client.query(`UPDATE system_settings SET value = $1::jsonb WHERE key = 'live_settings'`, [typeof savedSettings === "string" ? savedSettings : JSON.stringify(savedSettings)]);
    } else {
      await client.query(`DELETE FROM system_settings WHERE key = 'live_settings'`);
    }
  } catch (te) {
    results.push(`  TEARDOWN-SETTINGS-WARN ${te?.message}`);
  }
  await client.end();
}

console.log("\n=== Social + Battles + Pocket probe ===");
for (const r of results) console.log(r);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
