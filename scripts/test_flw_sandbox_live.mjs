/**
 * REAL Flutterwave SANDBOX E2E — USD / EUR / GBP international payouts.
 *
 * Drives the REAL provider (server/services/providers/flutterwave.ts) against the
 * REAL Flutterwave API (https://api.flutterwave.com) using the merchant's TEST-mode
 * secret key (passed via env FLW_SECRET_KEY — never hardcoded, never committed).
 *
 * For each corridor:
 *   1. initiateTransfer  → POST /v3/transfers   (doc-sample beneficiary, unique ref)
 *   2. TSQ               → GET  /v3/transfers/{id} (immediately + after a short wait)
 *   3. verifyWebhook     → verif-hash acceptance check (signature logic)
 *
 * Any non-2xx from Flutterwave is printed VERBATIM (status + body) — that is the
 * point: real-API validation of the exact payload our backend builds.
 *
 * Run:
 *   FLW_SECRET_KEY='FLWSECK_TEST-...' \
 *     npx tsx /home/z/my-project/repos/metroflow-backend/scripts/test_flw_sandbox_live.mjs
 */
import assert from "node:assert/strict";

const SECRET = process.env.FLW_SECRET_KEY || "";
if (!SECRET.startsWith("FLWSECK_TEST") && !SECRET.startsWith("FLWSECK-TEST")) {
  console.error("Refusing to run: pass the TEST-mode secret via env FLW_SECRET_KEY (FLWSECK_TEST-...)");
  process.exit(2);
}
// Real sandbox: do NOT let ambient env override the base URL.
process.env.FLW_BASE_URL = "https://api.flutterwave.com";
process.env.FLW_MOCK = "false";
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:5432/unused";
process.env.FLW_SECRET_HASH ||= "sandbox-e2e-hash";

const { flutterwaveProvider } = await import(
  "/home/z/my-project/repos/metroflow-backend/server/services/providers/flutterwave.ts"
);

const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};
const show = (label, data) => {
  const { id, reference, status, fee, bank_name, debit_currency, complete_message } = data || {};
  console.log(`    ${label}: id=${id} ref=${reference} status=${status} fee=${fee} bank=${bank_name ?? "-"} debit=${debit_currency ?? "-"} msg=${complete_message ?? "-"}`);
};
const failHard = (label, e) => {
  const resp = e?.response;
  if (resp) {
    console.error(`  ✗ ${label}: HTTP ${resp.status}`);
    console.error("    " + JSON.stringify(resp.data).slice(0, 1200));
  } else {
    console.error(`  ✗ ${label}: ${e.message}`);
  }
  failed++;
  return null;
};

// Real network sanity: the key must be live before we assert anything else.
console.log("\n[0] Sandbox connectivity + key check (GET /v3/transfers?page=1)");
let keyOK = false;
try {
  const r = await fetch("https://api.flutterwave.com/v3/transfers?page=1&page_size=1", {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const body = await r.json();
  keyOK = r.ok && body?.status === "success";
  console.log(`    auth OK — HTTP ${r.status} status=${body?.status} (${body?.message ?? ""})`);
} catch (e) { failHard("auth check", e); }
check("TEST secret key authenticates against real sandbox", () => assert.equal(keyOK, true));

const isIpGate = (e) =>
  e?.response?.data?.message?.toLowerCase().includes("ip whitelisting") === true;
const ipGateHint = () =>
  `\n    ► ACTION (dashboard, one-time): Flutterwave Dashboard → Settings → API Settings →\n` +
  `      enable "IP Whitelisting" and add this machine's egress IP (curl api.ipify.org).\n` +
  `      In TEST mode Flutterwave gates POST /v3/transfers behind the whitelist; until the\n` +
  `      calling IP is whitelisted the payload cannot reach payload validation. Also add\n` +
  `      the PRODUCTION server's egress IP or live payouts will fail the same way.`;

// ---------------------------------------------------------------------------
console.log("\n[1] USD payout — doc sample through the REAL API");
const usdRef = `sandbox-usd-${stamp}`;
let usdId = null;
try {
  const resp = await flutterwaveProvider.initiateTransfer({
    bankCode: "ACH",
    accountNumber: "09182972BH",
    accountName: "Mark Cuban",
    amount: 50000, // minor units → 500.00 USD
    transactionReference: usdRef,
    remark: "Sample USD Transfer",
    currencyId: "USD",
    sourceCurrency: "NGN",
    bankName: "BANK OF AMERICA, N.A., SAN FRANCISCO, CA",
    swiftCode: "ABJG190",
    routingNumber: "021000021",
    accountType: "checking",
    beneficiaryAddress: "4 Newton",
    beneficiaryCity: "San Francisco",
    beneficiaryState: "CA",
    beneficiaryCountry: "US",
    beneficiaryEmail: "markcuban@example.com",
  });
  usdId = resp.data?.id ?? null;
  show("initiated", resp.data);
  check("USD initiate accepted (status success / NEW)", () => {
    assert.equal(resp.status, "success");
    assert.equal(resp.data.status, "NEW");
    assert.equal(resp.data.reference, usdRef);
    assert.equal(resp.data.fee, 35);
  });
} catch (e) { failHard("USD initiate", e); if (isIpGate(e)) console.log(ipGateHint()); }

// ---------------------------------------------------------------------------
console.log("\n[2] EUR payout — doc sample through the REAL API");
const eurRef = `sandbox-eur-${stamp}`;
let eurId = null;
try {
  const resp = await flutterwaveProvider.initiateTransfer({
    bankCode: "SWIFT",
    accountNumber: "DA091983888373BGH",
    accountName: "John Twain",
    amount: 50000,
    transactionReference: eurRef,
    remark: "Sample EUR Transfer",
    currencyId: "EUR",
    sourceCurrency: "NGN",
    bankName: "LLOYDS BANK",
    swiftCode: "BECFDE7HKKX",
    routingNumber: "BECFDE7HKKX",
    beneficiaryAddress: "Handelsbank Elsenheimer Str. 31",
    beneficiaryCity: "München",
    beneficiaryPostalCode: "80489",
    beneficiaryCountry: "DE",
  });
  eurId = resp.data?.id ?? null;
  show("initiated", resp.data);
  check("EUR initiate accepted (status success / NEW)", () => {
    assert.equal(resp.status, "success");
    assert.equal(resp.data.status, "NEW");
    assert.equal(resp.data.reference, eurRef);
    assert.equal(resp.data.fee, 45);
  });
} catch (e) { failHard("EUR initiate", e); if (isIpGate(e)) console.log(ipGateHint()); }

// ---------------------------------------------------------------------------
console.log("\n[3] GBP payout — doc sample + account_type through the REAL API");
const gbpRef = `sandbox-gbp-${stamp}`;
let gbpId = null;
try {
  const resp = await flutterwaveProvider.initiateTransfer({
    bankCode: "SWIFT",
    accountNumber: "DA091983888373BGH",
    accountName: "John Twain",
    amount: 50000,
    transactionReference: gbpRef,
    remark: "Sample GBP Transfer",
    currencyId: "GBP",
    sourceCurrency: "NGN",
    bankName: "LLOYDS BANK",
    swiftCode: "BUKBGB22",
    routingNumber: "308463",
    accountType: "corporate",
    beneficiaryAddress: "1 High St",
    beneficiaryCity: "London",
    beneficiaryPostalCode: "EC1A 1BB",
    beneficiaryCountry: "GB",
  });
  gbpId = resp.data?.id ?? null;
  show("initiated", resp.data);
  check("GBP initiate accepted (status success / NEW)", () => {
    assert.equal(resp.status, "success");
    assert.equal(resp.data.status, "NEW");
    assert.equal(resp.data.reference, gbpRef);
    assert.equal(resp.data.fee, 45);
  });
} catch (e) { failHard("GBP initiate", e); if (isIpGate(e)) console.log(ipGateHint()); }

// ---------------------------------------------------------------------------
console.log("\n[4] TSQ against the REAL API (by stored FLW id)");
const tsq = async (label, ref, id) => {
  if (!id) { console.log(`    ${label}: skipped (no id)`); return; }
  try {
    const resp = await flutterwaveProvider.verifyTransfer(ref, { data: { id } });
    show(label, resp.data);
    check(`${label} TSQ returns the transfer`, () => {
      assert.equal(resp.status, "success");
      assert.equal(resp.data.id, id);
      assert.ok(["NEW", "PENDING", "SUCCESSFUL", "FAILED", "CANCELLED"].includes(resp.data.status));
    });
  } catch (e) { failHard(`${label} TSQ`, e); }
};
await tsq("USD", usdRef, usdId);
await tsq("EUR", eurRef, eurId);
await tsq("GBP", gbpRef, gbpId);

console.log("\n    waiting 20s for sandbox processing, then final TSQ…");
await sleep(20000);
await tsq("USD-final", usdRef, usdId);
await tsq("EUR-final", eurRef, eurId);
await tsq("GBP-final", gbpRef, gbpId);

// ---------------------------------------------------------------------------
console.log("\n[5] Webhook signature (verif-hash) logic");
check("matching verif-hash accepted", () => {
  assert.equal(flutterwaveProvider.verifyWebhook({ event: "transfer.completed", data: { id: usdId ?? 1 } }, process.env.FLW_SECRET_HASH), true);
});
check("wrong verif-hash rejected", () => {
  assert.equal(flutterwaveProvider.verifyWebhook({ event: "transfer.completed", data: { id: 1 } }, "nope"), false);
});

console.log(`\n=== SANDBOX E2E RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
