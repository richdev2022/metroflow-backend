/**
 * Funding-limits unit tests (inflow transaction limits + over-limit rejection).
 *
 * Boots the REAL server/services/transaction-limits.ts and
 * server/services/funding-limits.ts with a stubbed DB layer (module-hooks
 * pattern, see funding-test-hooks.mjs) and stubbed provider/email/push.
 * Asserts:
 *   1. single-limit rejection for non_registered
 *   2. daily-limit rejection (usage + amount > daily)
 *   3. monthly-limit rejection
 *   4. within-limits allow
 *   5. registered tier gets the higher thresholds
 *   6. non-NGN currencies bypass the check
 *   7. rejectOverLimitFunding: failed transaction row + refund attempt +
 *      push/email/in-app notifications (with and without provider refunds)
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./funding-test-hooks.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

// ---- env BEFORE imports ----
process.env.DATABASE_URL = "postgresql://smoke:smoke@127.0.0.1:1/db";
process.env.PGPOOL_MAX = "1";

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const { enforceInflowLimits, getBusinessInflowUsage } = await import("../server/services/transaction-limits.ts");
const funding = await import("../server/services/funding-limits.ts");

// ============ 1. single-limit rejection ============
globalThis.__inUsedToday = 0; globalThis.__inUsedMonth = 0; globalThis.__bizCategory = "non_registered";
{
  const r = await enforceInflowLimits("biz-1", 60000, { currency: "NGN" });
  ok(r.ok === false, "1a. 60k rejected for non_registered (single limit 50k)");
  ok(r.code === "SINGLE_LIMIT_EXCEEDED", "1b. code is SINGLE_LIMIT_EXCEEDED");
  ok(r.data?.limit === 50000 && r.data?.direction === "inflow", "1c. data carries limit + direction=inflow");
  ok(/funding limit/i.test(r.error || ""), "1d. message mentions funding limit");
}

// ============ 2. daily-limit rejection ============
globalThis.__inUsedToday = 80000;
{
  const r = await enforceInflowLimits("biz-1", 30000, { currency: "NGN" });
  ok(r.ok === false && r.code === "DAILY_LIMIT_EXCEEDED", "2. 30k with 80k used today -> DAILY_LIMIT_EXCEEDED");
}

// ============ 3. monthly-limit rejection ============
globalThis.__inUsedToday = 0; globalThis.__inUsedMonth = 480000;
{
  const r = await enforceInflowLimits("biz-1", 30000, { currency: "NGN" });
  ok(r.ok === false && r.code === "MONTHLY_LIMIT_EXCEEDED", "3. 30k with 480k used this month -> MONTHLY_LIMIT_EXCEEDED");
}

// ============ 4. within limits ============
globalThis.__inUsedToday = 20000; globalThis.__inUsedMonth = 100000;
{
  const r = await enforceInflowLimits("biz-1", 30000, { currency: "NGN" });
  ok(r.ok === true, "4. 30k with 20k today / 100k month -> allowed");
}

// ============ 5. registered tier ============
globalThis.__bizCategory = "registered";
{
  const r = await enforceInflowLimits("biz-1", 4000000, { currency: "NGN" });
  ok(r.ok === true, "5a. 4M allowed for registered tier");
  const r2 = await enforceInflowLimits("biz-1", 6000000, { currency: "NGN" });
  ok(r2.ok === false && r2.code === "SINGLE_LIMIT_EXCEEDED", "5b. 6M rejected for registered tier");
  ok(r2.data?.limit === 5000000 && r2.data?.upgradeHint === false, "5c. registered rejection has no upgrade hint");
}
globalThis.__bizCategory = "non_registered";

// ============ 6. non-NGN bypass ============
{
  const r = await enforceInflowLimits("biz-1", 999999999, { currency: "USD" });
  ok(r.ok === true, "6. non-NGN currencies bypass the category limits");
}

// ============ 7. rejectOverLimitFunding ============
// 7a. WITH provider refund support (checkout path, existing pending txn)
globalThis.__pushCalls = []; globalThis.__emailCalls = []; globalThis.__notifCalls = [];
let refundCalls = [];
globalThis.__providerImpl = async (req) => {
  refundCalls.push(req);
  return { success: true, message: "Refund queued" };
};
{
  const res = await funding.rejectOverLimitFunding({
    walletId: "w-1",
    businessId: "biz-1",
    userId: "user-1",
    amount: 60000,
    currency: "NGN",
    reference: "FUND-test-1",
    provider: "flutterwave",
    source: "checkout",
    providerTransactionId: 987654,
    existingTransactionId: "txn-pending-1",
    limitResult: { ok: false, code: "SINGLE_LIMIT_EXCEEDED", error: "limit is NGN 50,000", data: { limit: 50000, limitType: "single", category: "non_registered", currency: "NGN", upgradeHint: true, amount: 60000, usedToday: 0, usedThisMonth: 0 } },
  });
  ok(res.rejected === true, "7a.1 rejection recorded");
  ok(res.refund.attempted === true && res.refund.success === true, "7a.2 automatic refund attempted + success");
  ok(refundCalls.length === 1 && String(refundCalls[0].transactionId) === "987654", "7a.3 refund keyed off the provider transaction id");
  ok(globalThis.__pushCalls.length === 1, "7a.4 owner push sent");
  ok(globalThis.__pushCalls[0].payload.title.includes("rejected"), "7a.5 push title mentions rejection");
  ok(globalThis.__pushCalls[0].options.inApp === true, "7a.6 push carries inApp mirror (in-app notification path)");
  ok(globalThis.__emailCalls.length === 1 && globalThis.__emailCalls[0].to === "owner@test.dev", "7a.7 owner email sent");
}

// 7b. WITHOUT provider refund support (Squad VA path, new failed row)
globalThis.__providerImpl = null; // squad has no refundPayment on the provider
globalThis.__pushCalls = []; globalThis.__emailCalls = [];
{
  const res = await funding.rejectOverLimitFunding({
    walletId: "w-1",
    businessId: "biz-1",
    userId: "user-1",
    amount: 90000,
    currency: "NGN",
    reference: "FLW-VA-TEST-2",
    provider: "squad",
    source: "virtual_account",
    limitResult: { ok: false, code: "DAILY_LIMIT_EXCEEDED", error: "daily limit", data: { limit: 100000, limitType: "daily", category: "non_registered", currency: "NGN", upgradeHint: true, amount: 90000, usedToday: 20000, usedThisMonth: 0 } },
  });
  ok(res.rejected === true && res.refund.attempted === false, "7b.1 no refund API for squad -> manual review flag");
  ok(/manual refund/i.test(res.refund.message), "7b.2 refund message flags manual refund");
  ok(globalThis.__emailCalls.length === 1, "7b.3 owner still notified by email");
}

// 7c. owner lookup fails -> still records the rejection, no crash
globalThis.__noOwner = true; globalThis.__emailCalls = [];
{
  const res = await funding.rejectOverLimitFunding({
    walletId: "w-1",
    amount: 60000,
    reference: "FUND-test-3",
    provider: "monnify",
    source: "virtual_account",
    limitResult: { ok: false, code: "SINGLE_LIMIT_EXCEEDED", error: "x", data: { limit: 50000, limitType: "single", category: "non_registered", currency: "NGN", upgradeHint: true, amount: 60000, usedToday: 0, usedThisMonth: 0 } },
  });
  ok(res.rejected === true && globalThis.__emailCalls.length === 0, "7c. missing owner -> rejection recorded, notifications skipped");
}
globalThis.__noOwner = false;

// 7d. checkFundingLimit with no owner key -> allow (never blocks orphans)
{
  const r = await funding.checkFundingLimit({}, 999999);
  ok(r.ok === true, "7d. no owner key -> allow (fail-open)");
}

// ============ 8. HTML rejection page ============
{
  const html = funding.fundingRejectedHtml("Daily limit exceeded", true, "https://app.metricorex.com");
  ok(html.includes("Payment Rejected") && html.includes("refunded"), "8. rejection HTML page renders with refund notice");
}

console.log(failures === 0 ? "\nALL FUNDING-LIMITS TESTS PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
