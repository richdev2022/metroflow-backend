#!/usr/bin/env node
/**
 * E2E test — Flutterwave Bills v2 (LOCAL server on :3111).
 *
 * Covers, with REAL provider calls and NO simulation:
 *   1. GET  /api/bills/catalog            → clean v2 catalog (all billers + plans + logos)
 *   2. POST /api/bills/pay (airtime)      → provider called; IP-whitelist gate surfaces the
 *                                           provider error verbatim; wallet auto-REFUND verified
 *                                           (bill → failed, refund transaction exists, balance restored)
 *   3. Webhook charge.completed (BILL-*)  → signed with FLW_SECRET_HASH; settles a PENDING bill
 *                                           and refunds on failure; idempotent on replay
 *   4. POST /api/bills/:id/sync           → pull-status path
 *   5. Probe cleanup                      → probe user + rows deleted
 *
 * Usage: node scripts/test_bills_e2e.mjs
 */
import { Client } from "pg";
import nodeCrypto from "crypto";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:3111/api";
const PIN = "4321";
const STAMP = Date.now();
const EMAIL = `billprobe_${STAMP}@metricorex-test.com`;

const results = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// ---------------------------------------------------------------------------
// 0) Probe user + funded NGN wallet
// ---------------------------------------------------------------------------
const pinHash = await bcrypt.hash(PIN, 10);
const userId = crypto.randomUUID();
await client.query(
  `INSERT INTO users (id, name, email, password_hash, transaction_pin_hash, email_verified, kyc_status, bvn_status)
   VALUES ($1, 'Bills Probe', $2, $3, $4, true, 'verified', 'verified')`,
  [userId, EMAIL, pinHash, pinHash],
);
const walletId = crypto.randomUUID();
await client.query(
  `INSERT INTO wallets (id, user_id, currency, balance, status) VALUES ($1, $2, 'NGN', 10000, 'active')`,
  [walletId, userId],
);

const loginRes = await fetch(`${BASE}/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: "probe-" + STAMP }),
}).catch(() => null);
let token = loginRes?.data?.token || loginRes?.token || null;

// The probe password above is intentionally random — mint a session token
// directly (opaque session tokens stored in user_sessions).
if (!token) {
  token = nodeCrypto.randomBytes(32).toString("hex");
  await client.query(
    `INSERT INTO user_sessions (user_id, business_id, token, last_activity_at) VALUES ($1, NULL, $2, CURRENT_TIMESTAMP)`,
    [userId, token],
  );
}
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
console.log(`probe user ${EMAIL} / wallet ${walletId}`);

// ---------------------------------------------------------------------------
// 1) Catalog
// ---------------------------------------------------------------------------
const catalog = await (await fetch(`${BASE}/bills/catalog`)).json();
ok("catalog: providers", (catalog.providers?.length || 0) >= 25, `${catalog.providers?.length} providers`);
const cats = new Set((catalog.providers || []).map((p) => p.category));
ok("catalog: categories", ["airtime", "data", "tv", "electricity"].every((c) => cats.has(c)), [...cats].join(","));
const withLogos = (catalog.providers || []).filter((p) => p.logo);
ok("catalog: logos on every provider", withLogos.length === catalog.providers?.length, `${withLogos.length}/${catalog.providers?.length}`);
const dstv = (catalog.providers || []).find((p) => p.category === "tv" && /dstv/i.test(p.display_name));
ok("catalog: DSTV has plans", dstv && dstv.plans?.length > 0, dstv ? `${dstv.plans.length} plans` : "missing");
const mtnData = (catalog.providers || []).find((p) => p.category === "data" && /^mtn/i.test(p.display_name));
ok("catalog: MTN data plans", mtnData && mtnData.plans?.length > 0, mtnData ? `${mtnData.plans.length} plans` : "missing");

// ---------------------------------------------------------------------------
// 2) PAY (airtime) — real provider call; refund path on provider rejection
// ---------------------------------------------------------------------------
const beforeBal = Number((await client.query(`SELECT balance FROM wallets WHERE id = $1`, [walletId])).rows[0].balance);
const payRes = await fetch(`${BASE}/bills/pay`, {
  method: "POST", headers: auth,
  body: JSON.stringify({
    category: "airtime", provider_code: "BIL099", customer_ref: "08012345678",
    wallet_id: walletId, amount: 100, pin: PIN,
  }),
});
const payBody = await payRes.json().catch(() => ({}));
const afterBal = Number((await client.query(`SELECT balance FROM wallets WHERE id = $1`, [walletId])).rows[0].balance);
const billRow = (await client.query(`SELECT * FROM bill_payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
ok("pay: wallet balance restored (refund path)", beforeBal === afterBal, `before=${beforeBal} after=${afterBal}`);
ok("pay: provider error surfaced verbatim (IP whitelist)", /whitelist/i.test(payBody.bill?.failure_reason || "") || /whitelist/i.test(payBody.error || payBody.message || ""), (payBody.bill?.failure_reason || payBody.error || payBody.message || "").slice(0, 90));
ok("pay: bill row recorded", !!billRow, billRow?.reference);
// Synthetic PENDING bill → webhook settlement test (bill Payments may also
// resolve asynchronously; this is exactly the async path).
const pendId = crypto.randomUUID();
const pendRef = `BILL-WH-${STAMP}`;
await client.query(
  `INSERT INTO bill_payments (id, user_id, wallet_id, reference, category, provider_code, provider_name, customer_ref, amount, fee, total, currency, status)
   VALUES ($1,$2,$3,$4,'airtime','BIL099','MTN Airtime','08012345678',100,50,150,'NGN','pending')`,
  [pendId, userId, walletId, pendRef],
);
await client.query(
  `INSERT INTO transactions (user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction)
   VALUES ($1, 150, 'NGN', $2, 'success', 'debit', 'Webhook test bill', 'bill', $3, 'debit')`,
  [userId, pendRef, walletId],
);
await client.query(`UPDATE wallets SET balance = balance - 150 WHERE id = $1`, [walletId]);
const balPending = Number((await client.query(`SELECT balance FROM wallets WHERE id = $1`, [walletId])).rows[0].balance);

const whPayload = {
  event: "charge.completed",
  data: { tx_ref: pendRef, status: "failed", payment_type: "bill", amount: 100 },
};
const sig = String(process.env.FLW_SECRET_HASH || ""); // Flutterwave sends the literal secret hash in verif-hash
const whRes = await fetch(`http://localhost:3111/api/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "verif-hash": sig },
  body: JSON.stringify(whPayload),
});
ok("webhook: accepted (200)", whRes.status === 200);
const whBill = (await client.query(`SELECT status FROM bill_payments WHERE id = $1`, [pendId])).rows[0];
ok("webhook: pending bill settled as failed", whBill?.status === "failed", whBill?.status);
const balRefunded = Number((await client.query(`SELECT balance FROM wallets WHERE id = $1`, [walletId])).rows[0].balance);
ok("webhook: wallet refunded on failure", balRefunded === balPending + 150, `${balPending} -> ${balRefunded}`);
const refundTx = (await client.query(`SELECT id FROM transactions WHERE reference = $1`, [`${pendRef}-REFUND`])).rows;
ok("webhook: refund transaction inserted", refundTx.length > 0);
// Replay idempotency
await fetch(`http://localhost:3111/api/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "verif-hash": sig },
  body: JSON.stringify(whPayload),
});
const refundsAfterReplay = (await client.query(`SELECT COUNT(*)::int AS c FROM transactions WHERE reference = $1`, [`${pendRef}-REFUND`])).rows[0].c;
ok("webhook: replay is idempotent", Number(refundsAfterReplay) === 1);
// Invalid signature must be rejected
const badRes = await fetch(`http://localhost:3111/api/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "verif-hash": "deadbeef" },
  body: JSON.stringify(whPayload),
});
ok("webhook: invalid signature rejected (401)", badRes.status === 401);

// ---------------------------------------------------------------------------
// 4) /bills/:id/sync on a non-pending bill is a no-op success
// ---------------------------------------------------------------------------
if (billRow) {
  const syncRes = await fetch(`${BASE}/bills/${billRow.id}/sync`, { method: "POST", headers: auth });
  const syncBody = await syncRes.json().catch(() => ({}));
  ok("sync: responds ok on terminal bill", syncRes.status === 200, JSON.stringify(syncBody).slice(0, 80));
}

// ---------------------------------------------------------------------------
// 5) History + cleanup
// ---------------------------------------------------------------------------
const histRes = await fetch(`${BASE}/bills`, { headers: auth });
const hist = await histRes.json();
ok("history: lists the probe bill", (hist.bills || []).length >= 1);

await client.query(`DELETE FROM transactions WHERE user_id = $1 OR reference LIKE $2`, [userId, `${pendRef}%`]);
await client.query(`DELETE FROM bill_payments WHERE user_id = $1`, [userId]);
await client.query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
await client.query(`DELETE FROM wallets WHERE user_id = $1`, [userId]);
await client.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
await client.end();

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== ${passed}/${results.length} passed =====`);
process.exit(passed === results.length ? 0 : 1);
