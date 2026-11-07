/**
 * E2E step 4: SAVINGS CIRCLES + SMART SPENDING INSIGHTS & BUDGETS — end to
 * end against a real local server + Postgres, plus regression smoke tests of
 * the three features shipped before them (Round-Up Auto-Save, Split Bills &
 * Group Pots, Savings Vaults / Live Shopping surface).
 *
 * Run:
 *   1) userspace Postgres on 127.0.0.1:54329 + DATABASE_URL in .env
 *   2) node scripts/boot_local_server.mjs   (PROBE_PORT 3099)
 *   3) npx tsx e2e_4_circles_insights.mjs
 */
import { Client } from "pg";

const BASE = "http://localhost:3099/api";
const DB = "postgresql://postgres@127.0.0.1:54329/metricorex";

let failures = 0;
function assert(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!cond) failures += 1;
}

const H = (t) => ({ "Content-Type": "application/json", Authorization: `Bearer ${t}` });
const stamp = Date.now().toString(36);
let refCounter = 0;

async function pg() {
  const c = new Client({ connectionString: DB });
  await c.connect();
  return c;
}

async function registerUser(db, tag) {
  const email = `e2e4-${tag}-${stamp}@metricorex.test`;
  const r = await fetch(`${BASE}/auth/register/personal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, phone_number: `+23480${Math.floor(10000000 + Math.random() * 89999999)}`, password: "Circle#Pass1", name: `E2E ${tag}` }),
  });
  const body = await r.json();
  if (!r.ok || !body.userId) throw new Error(`register ${tag} failed: ${r.status} ${JSON.stringify(body)}`);
  const userId = body.userId;
  // Verify + password flag for login (OTP email is stubbed out locally).
  await db.query(`UPDATE users SET email_verified = TRUE WHERE id = $1`, [userId]);
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Circle#Pass1" }),
  });
  const loginBody = await login.json();
  if (!login.ok || !loginBody.token) throw new Error(`login ${tag} failed: ${login.status} ${JSON.stringify(loginBody).slice(0, 200)}`);
  const wallet = await db.query(
    `SELECT id FROM wallets WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' ORDER BY created_at ASC LIMIT 1`,
    [userId],
  );
  return { userId, token: loginBody.token, email, walletId: wallet.rows[0].id };
}

async function setBalance(db, walletId, balance) {
  await db.query(`UPDATE wallets SET balance = $2 WHERE id = $1`, [walletId, balance]);
}

async function balance(db, walletId) {
  const r = await db.query(`SELECT balance FROM wallets WHERE id = $1`, [walletId]);
  return Number(r.rows[0].balance);
}

async function seedTxn(db, userId, walletId, { type, description, amount, when }) {
  await db.query(
    `INSERT INTO transactions (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, created_at)
     VALUES (NULL, $1, $2, 'NGN', 'success', $3, 'debit', $4, $5, $6, 'debit', $7)`,
    [userId, amount, `E2E4-${stamp}-${refCounter++}`, description, type, walletId, when],
  );
}

async function main() {
  const db = await pg();

  // ---- Users -------------------------------------------------------------
  const owner = await registerUser(db, "owner");
  const m1 = await registerUser(db, "m1");
  const m2 = await registerUser(db, "m2");
  const m3 = await registerUser(db, "m3");
  const m4 = await registerUser(db, "m4");
  const everyone = [owner, m1, m2, m3, m4];
  assert("5 personal users registered + logged in", everyone.every((u) => u.token && u.walletId));

  // ---- CIRCLES -----------------------------------------------------------
  const created = await fetch(`${BASE}/circles`, {
    method: "POST", headers: H(owner.token),
    body: JSON.stringify({ name: "Ajo Squad", contribution_amount: 2000, frequency: "weekly", member_limit: 5 }),
  });
  const createdBody = await created.json();
  assert("circle created (owner = slot 1)", created.status === 201 && !!createdBody.circle?.id && createdBody.circle?.invite_code);
  const circleId = createdBody.circle.id;
  const inviteCode = createdBody.circle.invite_code;

  const badJoin = await fetch(`${BASE}/circles/${circleId}/join`, {
    method: "POST", headers: H(m1.token), body: JSON.stringify({ invite_code: "WRONG" }),
  });
  assert("join rejects a wrong invite code", badJoin.status === 403);

  for (const [i, m] of [m1, m2, m3, m4].entries()) {
    const j = await fetch(`${BASE}/circles/${circleId}/join`, {
      method: "POST", headers: H(m.token), body: JSON.stringify({ invite_code: inviteCode }),
    });
    const jb = await j.json();
    assert(`member m${i + 1} joined (slot ${jb.slot})`, j.status === 201 && jb.slot === i + 2);
  }

  const early = await fetch(`${BASE}/circles/${circleId}/collect`, { method: "POST", headers: H(owner.token) });
  assert("collect before start is refused", early.status === 400);

  const started = await fetch(`${BASE}/circles/${circleId}/start`, {
    method: "POST", headers: H(owner.token), body: JSON.stringify({ start_at: new Date().toISOString() }),
  });
  const startedBody = await started.json();
  assert("owner started the circle", started.status === 200);
  assert("payment calendar built — 5 cycles, weekly dues, slot order", startedBody.cycles?.length === 5
    && startedBody.cycles[0].payout_user_id === owner.userId
    && startedBody.cycles[1].payout_user_id === m1.userId
    && new Date(startedBody.cycles[1].due_at) - new Date(startedBody.cycles[0].due_at) === 7 * 86400000,
    JSON.stringify(startedBody.cycles?.map((c) => c.cycle_number)));

  // Fund wallets — m3 stays broke to exercise the missed path.
  for (const u of everyone) await setBalance(db, u.walletId, 50000);
  await setBalance(db, m3.walletId, 0);

  const balancesBefore = {};
  for (const u of everyone) balancesBefore[u.userId] = await balance(db, u.walletId);

  // ---- Cycle 1: owner collects; m3 misses --------------------------------
  const c1 = await fetch(`${BASE}/circles/${circleId}/collect`, { method: "POST", headers: H(owner.token) });
  const c1Body = await c1.json();
  assert("cycle 1 collected by the payout member (owner)", c1.status === 200 && c1Body.cycle_number === 1);
  assert("pot = 3 × ₦2,000 (payout member exempt, m3 missed)", c1Body.pot === 6000, `pot=${c1Body.pot}`);
  assert("m3 surfaced as missed (insufficient balance)", c1Body.missed?.some((x) => x.user_id === m3.userId));
  assert("owner wallet credited ₦6,000", (await balance(db, owner.walletId)) === balancesBefore[owner.userId] + 6000);
  assert("m1 debited ₦2,000", (await balance(db, m1.walletId)) === balancesBefore[m1.userId] - 2000);

  const m3Trust = await db.query(`SELECT trust_score, missed_count FROM circle_members WHERE circle_id = $1 AND user_id = $2`, [circleId, m3.userId]);
  assert("m3 trust −20 and missed_count = 1", Number(m3Trust.rows[0].trust_score) === 80 && m3Trust.rows[0].missed_count === 1);

  const ledger = await db.query(
    `SELECT transaction_type, COUNT(*)::int AS n FROM transactions WHERE user_id = ANY($1) AND transaction_type IN ('circle_contribution','circle_payout') GROUP BY 1`,
    [everyone.map((u) => u.userId)],
  );
  const ledgerMap = Object.fromEntries(ledger.rows.map((r) => [r.transaction_type, r.n]));
  assert("ledger double-entry: 3 circle_contribution + 1 circle_payout", ledgerMap["circle_contribution"] === 3 && ledgerMap["circle_payout"] === 1, JSON.stringify(ledgerMap));

  // Idempotency — a second collect call must not roll into cycle 2 early:
  // the calendar gate refuses it (cycle 2 is not due for another week).
  const c1again = await fetch(`${BASE}/circles/${circleId}/collect`, { method: "POST", headers: H(owner.token) });
  const c1AgainBody = await c1again.json();
  assert("second collect refused — next cycle not due yet", c1again.status === 400 && c1AgainBody.code === "CYCLE_NOT_DUE", JSON.stringify(c1AgainBody).slice(0, 120));
  assert("owner wallet unchanged after early-collect attempt", (await balance(db, owner.walletId)) === balancesBefore[owner.userId] + 6000);

  // ---- Grace settle ------------------------------------------------------
  const earlySettle = await fetch(`${BASE}/circles/${circleId}/cycles/${c1Body.missed?.find((x) => x.user_id === m3.userId) ? "00000000-0000-0000-0000-000000000000" : "x"}/settle`, { method: "POST", headers: H(m3.token) });
  assert("settle on a foreign cycle id is 404", earlySettle.status === 404);

  const cycle1 = await db.query(`SELECT id FROM circle_cycles WHERE circle_id = $1 AND cycle_number = 1`, [circleId]);
  await setBalance(db, m3.walletId, 2000);
  const settled = await fetch(`${BASE}/circles/${circleId}/cycles/${cycle1.rows[0].id}/settle`, { method: "POST", headers: H(m3.token) });
  assert("m3 settled the missed payment inside the grace window", settled.status === 200, JSON.stringify(await settled.json()).slice(0, 120));
  assert("payout member topped up ₦2,000", (await balance(db, owner.walletId)) === balancesBefore[owner.userId] + 8000);
  const m3After = await db.query(`SELECT trust_score FROM circle_members WHERE circle_id = $1 AND user_id = $2`, [circleId, m3.userId]);
  assert("m3 trust recovered +1 (late)", Number(m3After.rows[0].trust_score) === 81);

  // ---- Cycle 2: m1 collects, everyone pays -------------------------------
  for (const u of everyone) await setBalance(db, u.walletId, 50000);
  // The weekly calendar puts cycle 2 a week out — backdate it to test the
  // due-date gate opening.
  await db.query(`UPDATE circle_cycles SET due_at = NOW() - INTERVAL '1 hour' WHERE circle_id = $1 AND cycle_number = 2`, [circleId]);
  const c2 = await fetch(`${BASE}/circles/${circleId}/collect`, { method: "POST", headers: H(m1.token) });
  const c2Body = await c2.json();
  assert("cycle 2 collected — m1 takes an ₦8,000 pot", c2.status === 200 && c2Body.pot === 8000 && c2Body.paid?.length === 4, `pot=${c2Body.pot} paid=${c2Body.paid?.length}`);
  assert("m1 wallet credited ₦8,000", (await balance(db, m1.walletId)) === 58000);
  const m3AfterC2 = await db.query(`SELECT trust_score FROM circle_members WHERE circle_id = $1 AND user_id = $2`, [circleId, m3.userId]);
  assert("m3 on-time in cycle 2 → trust 83 (81 + 2)", Number(m3AfterC2.rows[0].trust_score) === 83, `trust=${m3AfterC2.rows[0].trust_score}`);

  // ---- Skip logic --------------------------------------------------------
  const cycle3 = await db.query(`SELECT id, payout_user_id FROM circle_cycles WHERE circle_id = $1 AND cycle_number = 3`, [circleId]);
  assert("cycle 3 pays m2 (slot 3)", cycle3.rows[0].payout_user_id === m2.userId);
  const skip = await fetch(`${BASE}/circles/${circleId}/members/${m4.userId}/skip`, {
    method: "POST", headers: H(owner.token), body: JSON.stringify({ cycle_id: cycle3.rows[0].id }),
  });
  assert("owner skipped m4 for cycle 3", skip.status === 200);
  const calendar = await db.query(
    `SELECT cycle_number, payout_user_id, status FROM circle_cycles WHERE circle_id = $1 ORDER BY cycle_number`,
    [circleId],
  );
  const skippedCycle = calendar.rows.find((r) => r.payout_user_id === m4.userId);
  assert("m4's payout moved to a fresh appended cycle (#6)", skippedCycle?.cycle_number === 6 && calendar.rows.length === 5, JSON.stringify(calendar.rows.map((r) => r.cycle_number)));
  const skipRow = await db.query(`SELECT status FROM circle_contributions WHERE cycle_id = $1 AND user_id = $2`, [cycle3.rows[0].id, m4.userId]);
  assert("m4 has a 'skipped' contribution row for cycle 3", skipRow.rows[0]?.status === "skipped");

  // ---- Removal rules -----------------------------------------------------
  const removeEarly = await fetch(`${BASE}/circles/${circleId}/members/${m3.userId}/remove`, { method: "POST", headers: H(owner.token) });
  assert("remove refused below the miss threshold (1 miss)", removeEarly.status === 400 && (await removeEarly.json()).code === "TOO_FEW_MISSES");
  await db.query(`UPDATE circle_members SET missed_count = 2 WHERE circle_id = $1 AND user_id = $2`, [circleId, m3.userId]);
  const removed = await fetch(`${BASE}/circles/${circleId}/members/${m3.userId}/remove`, { method: "POST", headers: H(owner.token) });
  assert("owner removed m3 after repeated misses", removed.status === 200);
  const m3Status = await db.query(`SELECT status, trust_score FROM circle_members WHERE circle_id = $1 AND user_id = $2`, [circleId, m3.userId]);
  assert("m3 marked removed, trust −30 (83 → 53)", m3Status.rows[0].status === "removed" && Number(m3Status.rows[0].trust_score) === 53, JSON.stringify(m3Status.rows[0]));

  const detail = await fetch(`${BASE}/circles/${circleId}`, { headers: H(owner.token) });
  const detailBody = await detail.json();
  assert("detail: members + cycles + contributions matrix + my_member", detail.status === 200
    && detailBody.members?.length === 4
    && detailBody.cycles?.length === 5
    && !!detailBody.my_member
    && typeof detailBody.contributions === "object");

  const mine = await fetch(`${BASE}/circles/mine`, { headers: H(m2.token) });
  const mineBody = await mine.json();
  assert("GET /circles/mine lists membership with trust + next payout", mine.status === 200
    && mineBody.circles?.length === 1
    && mineBody.circles[0].my_trust_score === 100
    && !!mineBody.circles[0].next_payout_name);

  // ---- INSIGHTS ----------------------------------------------------------
  // Seed the owner's ledger: this month + 3 prior months (airtime average) +
  // last-7 vs previous-7 windows for the week-over-week trend.
  const now = new Date();
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000);
  const monthsAgo = (n, day) => { const d = new Date(now.getFullYear(), now.getMonth() - n, day); return d; };

  await seedTxn(db, owner.userId, owner.walletId, { type: "bill", description: "Bill payment — airtime (SOGO) — 08031234567", amount: 12400, when: daysAgo(0) });
  await seedTxn(db, owner.userId, owner.walletId, { type: "transfer", description: "Transfer to Chidi O.", amount: 5000, when: daysAgo(3) });
  await seedTxn(db, owner.userId, owner.walletId, { type: "transfer", description: "Transfer to Ada N.", amount: 6000, when: daysAgo(1) });
  await seedTxn(db, owner.userId, owner.walletId, { type: "market_order", description: "Market order — Ankara set", amount: 8000, when: daysAgo(2) });
  await seedTxn(db, owner.userId, owner.walletId, { type: "transfer", description: "Transfer to Bola A.", amount: 2000, when: daysAgo(10) });
  await seedTxn(db, owner.userId, owner.walletId, { type: "savings_deposit", description: "Vault deposit — Japan fund", amount: 10000, when: daysAgo(1) });
  for (let i = 1; i <= 3; i++) {
    await seedTxn(db, owner.userId, owner.walletId, { type: "bill", description: "Bill payment — airtime (SOGO) — 08031234567", amount: 4000, when: monthsAgo(i, 12) });
  }

  const sum = await fetch(`${BASE}/insights/summary`, { headers: H(owner.token) });
  const sumBody = await sum.json();
  const airtime = sumBody.categories?.find((c) => c.category === "airtime");
  assert("summary: airtime auto-categorised ₦12,400", sum.status === 200 && airtime?.amount === 12400, JSON.stringify(sumBody.categories?.map((c) => [c.category, c.amount])));
  assert("nudge: airtime 3× the ₦4,000 average", !!airtime?.nudge && airtime.nudge.includes("3×") && airtime.trailing_avg === 4000, airtime?.nudge);
  assert("savings deposits excluded from spend, surfaced as saved", sumBody.saved_this_month === 12000 && !sumBody.categories?.some((c) => c.category === "savings"), `saved=${sumBody.saved_this_month}`);
  assert("week-over-week computed and rising", sumBody.trend?.direction === "up" && sumBody.trend.last_7_days > sumBody.trend.previous_7_days, JSON.stringify(sumBody.trend));
  assert("top spends include the largest item", sumBody.top_spends?.[0]?.amount === 12400);
  assert("round-up bridge present (disabled state before opt-in)", sumBody.round_up_bridge && sumBody.round_up_bridge.enabled === false);

  // Budgets
  const putB = await fetch(`${BASE}/insights/budgets/airtime`, {
    method: "PUT", headers: H(owner.token), body: JSON.stringify({ monthly_limit: 10000 }),
  });
  assert("budget envelope saved (airtime ₦10,000)", putB.status === 200);
  const badB = await fetch(`${BASE}/insights/budgets/airtime`, { method: "PUT", headers: H(owner.token), body: JSON.stringify({ monthly_limit: -5 }) });
  assert("negative budget rejected", badB.status === 400);
  const getB = await fetch(`${BASE}/insights/budgets`, { headers: H(owner.token) });
  const getBBody = await getB.json();
  const airtimeBudget = getBBody.budgets?.find((b) => b.category === "airtime");
  assert("budgets endpoint: spent 12,400 / limit 10,000 → over budget", airtimeBudget?.spent === 12400 && airtimeBudget?.over === true && airtimeBudget?.percent === 100, JSON.stringify(airtimeBudget));
  const delB = await fetch(`${BASE}/insights/budgets/airtime`, { method: "DELETE", headers: H(owner.token) });
  assert("budget envelope deleted", delB.status === 200);

  const trends = await fetch(`${BASE}/insights/trends?months=3`, { headers: H(owner.token) });
  const trendsBody = await trends.json();
  assert("trends: 3 monthly buckets with per-category split", trends.status === 200 && trendsBody.months?.length === 3 && Object.keys(trendsBody.months[2].categories).length >= 3, JSON.stringify(trendsBody.months?.[2]?.categories));

  // ---- Round-Up bridge flips ON (cross-checks feature 1) ------------------
  const vault = await fetch(`${BASE}/savings/vaults`, {
    method: "POST", headers: H(owner.token),
    body: JSON.stringify({ name: "Japan trip", target_amount: 500000, auto_save_enabled: false }),
  });
  const vaultBody = await vault.json();
  assert("regression: savings vault creation still works", vault.ok && !!vaultBody.vault?.id, JSON.stringify(vaultBody).slice(0, 160));
  const ruPut = await fetch(`${BASE}/roundup/settings`, {
    method: "PUT", headers: H(owner.token), body: JSON.stringify({ enabled: true, multiplier: 2, round_to: 100 }),
  });
  assert("regression: round-up settings PUT still works", ruPut.status === 200 && (await ruPut.json()).settings?.enabled === true);
  const sum2 = await fetch(`${BASE}/insights/summary`, { headers: H(owner.token) });
  const sum2Body = await sum2.json();
  assert("round-up bridge now suggests 2× round-up", sum2Body.round_up_bridge?.enabled === true && sum2Body.round_up_bridge?.multiplier === 2);

  // ---- Regression smoke: splits + pots -----------------------------------
  const split = await fetch(`${BASE}/splits`, {
    method: "POST", headers: H(owner.token),
    body: JSON.stringify({ title: "E2E lunch", total_amount: 1000, participants: [{ user_id: m1.userId }, { user_id: m2.userId }] }),
  });
  const splitBody = await split.json();
  assert("regression: split creation still works", split.ok && !!splitBody.split?.id, JSON.stringify(splitBody).slice(0, 160));
  const pot = await fetch(`${BASE}/pots`, {
    method: "POST", headers: H(owner.token), body: JSON.stringify({ title: "E2E pot", target_amount: 5000 }),
  });
  const potBody = await pot.json();
  assert("regression: pot creation still works", pot.status === 201 && !!potBody.pot?.id);
  const contrib = await fetch(`${BASE}/pots/${potBody.pot.id}/contribute`, {
    method: "POST", headers: H(m2.token), body: JSON.stringify({ amount: 500, note: "e2e" }),
  });
  assert("regression: pot contribution still works", contrib.status === 201);

  // ---- Notifications for circle events -----------------------------------
  const notif = await db.query(
    `SELECT type FROM notifications WHERE user_id = $1 AND type = 'circle_payout' LIMIT 1`,
    [m1.userId],
  );
  assert("circle payout notification delivered to m1", notif.rows.length === 1);

  await db.end();
  console.log(failures === 0 ? "\nALL E2E CHECKS PASSED ✅" : `\n${failures} E2E CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
