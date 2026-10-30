import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BILL REFUND GUARD — regression tests for the 2026-10-30 false-refund
 * incident: a bill payment Sogo DELIVERED was auto-refunded (user got a
 * "Bill payment refunded" notification while the airtime landed on the
 * recipient's phone) because the reaper asked the provider with OUR
 * MF-BILL… fallback reference, got a 404 (live Sogo does not index it —
 * it assigns its own BILL… reference) and misread that as "provider has
 * no record → safe to refund".
 *
 * Pinned invariants:
 *   1. Ambiguous evidence (fallback-reference 404, 401/403, missing key,
 *      outage) NEVER auto-refunds — the row holds in 'processing' with a
 *      console HOLD alarm for the operator.
 *   2. A 404 on Sogo's OWN reference (trusted lookup) still refunds after
 *      the grace window — that really is "dispatch never landed".
 *   3. Provider-confirmed success settles, never refunds.
 *   4. Sandbox keeps its old timed-refund behaviour (fake money).
 *   5. reverseBillPayment refuses ambiguous provider state without force.
 */

vi.mock("../db", () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  pool: { connect: vi.fn() },
}));
vi.mock("../features/personal/personal-utils", () => ({
  creditWallet: vi.fn(async () => ({})),
  insertTransaction: vi.fn(async () => ({})),
}));
vi.mock("../services/notifications", () => ({ createNotification: vi.fn(async () => ({})) }));
vi.mock("../services/fees", () => ({
  creditPlatformWallet: vi.fn(async () => ({})),
  debitRevenueWallet: vi.fn(async () => ({})),
}));
vi.mock("../services/push", () => ({ sendPushToUsers: vi.fn(async () => ({})) }));
vi.mock("../features/personal/provider-routing", () => ({
  getActiveProvider: vi.fn(async () => "sogo"),
}));

import { query, pool } from "../db";
import { creditWallet, insertTransaction } from "../features/personal/personal-utils";
import * as sogo from "../services/sogo";
import {
  reconcileProcessingBills,
  reverseBillPayment,
} from "../features/personal/bill-settlement";

type Route = (sql: string, params: any[]) => { rows: any[]; rowCount: number } | undefined;

/** Install a db mock that routes by SQL shape; returns the call log. */
function mockDb(route: Route = () => undefined) {
  const calls: { sql: string; params: any[] }[] = [];
  (query as any).mockImplementation(async (sql: string, params?: any[]) => {
    const p = params || [];
    calls.push({ sql, params: p });
    return route(sql, p) || { rows: [], rowCount: 0 };
  });
  return calls;
}

/**
 * Pool mock: the refund claim (INSERT … ON CONFLICT … RETURNING id) must
 * succeed inside the client transaction; everything else returns empty.
 * Returns the client call log — reverseBillPayment credits the wallet with a
 * raw `UPDATE wallets …` on the client (NOT the creditWallet helper), so
 * refund assertions read from this log.
 */
function mockPoolClaim() {
  const clientCalls: { sql: string; params: any[] }[] = [];
  (pool.connect as any).mockImplementation(async () => ({
    query: vi.fn(async (sql: string, params?: any[]) => {
      clientCalls.push({ sql, params: params || [] });
      return sql.includes("ON CONFLICT (reference) DO NOTHING")
        ? { rows: [{ id: "ledger-1" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  }));
  return clientCalls;
}

/** The client credited the wallet with the bill total. */
function walletCredited(clientCalls: { sql: string; params: any[] }[], total: number) {
  return clientCalls.some((c) => c.sql.includes("UPDATE wallets SET balance") && Number(c.params[0]) === total);
}

/** The client claimed the -REFUND ledger row. */
function refundClaimed(clientCalls: { sql: string; params: any[] }[], reference: string) {
  return clientCalls.some(
    (c) => c.sql.includes("ON CONFLICT (reference) DO NOTHING") && c.params[3] === `${reference}-REFUND`,
  );
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

function billRow(overrides: Record<string, any> = {}) {
  return {
    id: "row-1",
    reference: "MF-BILL-TEST1",
    provider: "sogo",
    provider_reference: null,
    category: "airtime",
    provider_slug: "airtel",
    customer_ref: "09025832235",
    amount: "100.00",
    fee: "0.00",
    total: "100.00",
    status: "processing",
    user_id: "u-1",
    wallet_id: "w-1",
    business_id: null,
    details: {},
    settled_at: null,
    created_at: new Date(Date.now() - 2 * 3600_000), // 2 h old
    ...overrides,
  };
}

/** Route the stale-rows SELECT to return the given bill(s). */
function selectReturns(rows: any[]) {
  return mockDb((sql) => {
    if (sql.includes("FROM bill_transactions") && sql.includes("status = 'processing'")) {
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("SELECT 1 FROM transactions WHERE reference")) {
      return { rows: [{ ok: 1 }], rowCount: 1 }; // debit ledger exists
    }
    return undefined;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Live Sogo: not sandbox, configured — tests override per case.
  vi.spyOn(sogo, "isSogoSandbox").mockReturnValue(false);
  vi.spyOn(sogo, "isSogoConfigured").mockReturnValue(true);
  mockDb();
  (pool.connect as any).mockReset?.();
});

describe("reconcileProcessingBills — ambiguous evidence never refunds (the false-refund incident)", () => {
  it("a fallback-reference 404 HOLDS the bill — no refund, HOLD alarm raised", async () => {
    const bill = billRow(); // provider_reference NULL → fallback lookup
    selectReturns([bill]);
    const getTx = vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(404));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await reconcileProcessingBills(10);

    // The lookup ran against OUR reference (Sogo 404s it — proves nothing).
    expect(getTx).toHaveBeenCalledWith("MF-BILL-TEST1");
    // No money moved, no refund ledger, no refunded status write.
    expect(creditWallet).not.toHaveBeenCalled();
    expect(insertTransaction).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    // The operator is told why the row is being held.
    expect(errSpy.mock.calls.some(([m]) => String(m).includes("HOLD — MF-BILL-TEST1"))).toBe(true);
    errSpy.mockRestore();
  });

  it("a 401 (broken API key) HOLDS the bill — a config error is never refund evidence", async () => {
    selectReturns([billRow()]);
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(401));

    await reconcileProcessingBills(10);

    expect(creditWallet).not.toHaveBeenCalled();
    expect(insertTransaction).not.toHaveBeenCalled();
  });

  it("a 403 HOLDS the bill", async () => {
    selectReturns([billRow()]);
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(403));

    await reconcileProcessingBills(10);

    expect(creditWallet).not.toHaveBeenCalled();
  });

  it("missing SOGO credentials HOLDS the bill", async () => {
    vi.spyOn(sogo, "isSogoConfigured").mockReturnValue(false);
    selectReturns([billRow()]);
    const getTx = vi.spyOn(sogo, "getTransaction");

    await reconcileProcessingBills(10);

    expect(getTx).not.toHaveBeenCalled();
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it("a provider outage (500) HOLDS the bill — no timed refund after silence", async () => {
    selectReturns([billRow()]);
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(500));

    await reconcileProcessingBills(10);

    expect(creditWallet).not.toHaveBeenCalled();
    expect(insertTransaction).not.toHaveBeenCalled();
  });

  it("a 429 rate-limit HOLDS the bill", async () => {
    selectReturns([billRow()]);
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(429));

    await reconcileProcessingBills(10);

    expect(creditWallet).not.toHaveBeenCalled();
  });
});

describe("reconcileProcessingBills — positive evidence still settles money", () => {
  it("a 404 on Sogo's OWN reference refunds after the grace window", async () => {
    const bill = billRow({
      provider_reference: "BILL202610301534S35246573",
      created_at: new Date(Date.now() - 45 * 60_000), // past the 30-min window
    });
    selectReturns([bill]);
    const clientCalls = mockPoolClaim();
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(404));

    await reconcileProcessingBills(10);

    expect(walletCredited(clientCalls, 100)).toBe(true);
    expect(refundClaimed(clientCalls, "MF-BILL-TEST1")).toBe(true);
  });

  it("a recent trusted-reference 404 waits out the grace window first", async () => {
    const bill = billRow({
      provider_reference: "BILL202610301534S35246573",
      created_at: new Date(Date.now() - 5 * 60_000), // inside the window
    });
    selectReturns([bill]);
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(404));

    await reconcileProcessingBills(10);

    expect(creditWallet).not.toHaveBeenCalled();
  });

  it("provider-confirmed success settles the bill instead of refunding", async () => {
    const bill = billRow({ provider_reference: "BILL202610301534S35246573" });
    const calls = selectReturns([bill]);
    vi.spyOn(sogo, "getTransaction").mockResolvedValue({
      transaction: { reference: "BILL202610301534S35246573", status: { value: "successful", is_final: true } },
    });

    await reconcileProcessingBills(10);

    // No refund anywhere.
    expect(creditWallet).not.toHaveBeenCalled();
    expect(insertTransaction).not.toHaveBeenCalled();
    expect(calls.some((c) => c.sql.includes("SET status = 'refunded'"))).toBe(false);
    // The completion claim was attempted.
    expect(calls.some((c) => c.sql.includes("SET status = 'completed'"))).toBe(true);
  });

  it("sandbox bills keep the timed refund (fake money)", async () => {
    vi.spyOn(sogo, "isSogoSandbox").mockReturnValue(true);
    const bill = billRow({ created_at: new Date(Date.now() - 45 * 60_000) });
    selectReturns([bill]);
    const clientCalls = mockPoolClaim();
    const getTx = vi.spyOn(sogo, "getTransaction");

    await reconcileProcessingBills(10);

    expect(getTx).not.toHaveBeenCalled();
    expect(walletCredited(clientCalls, 100)).toBe(true);
  });
});

describe("reverseBillPayment — the ambiguity guard", () => {
  it("refuses to reverse when the provider state is unverifiable (no force)", async () => {
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(404));

    const result = await reverseBillPayment(billRow() as any, "test reversal", {});

    expect(result.reversed).toBe(false);
    expect(result.providerVerified).toBe("unverifiable");
    expect(result.notes.join(" ")).toMatch(/could not be verified/i);
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it("refuses to reverse on a 401 without force", async () => {
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(401));

    const result = await reverseBillPayment(billRow() as any, "test reversal", {});

    expect(result.reversed).toBe(false);
    expect(result.providerVerified).toBe("unverifiable");
  });

  it("still reverses on a 404 when the lookup used Sogo's OWN reference", async () => {
    selectReturns([]); // debit ledger exists
    const clientCalls = mockPoolClaim();
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(404));

    const result = await reverseBillPayment(
      billRow({ provider_reference: "BILL202610301534S35246573" }) as any,
      "test reversal",
      {},
    );

    expect(result.reversed).toBe(true);
    expect(result.providerVerified).toBe("no-record");
    expect(result.credited).toBe(true);
    expect(walletCredited(clientCalls, 100)).toBe(true);
    expect(refundClaimed(clientCalls, "MF-BILL-TEST1")).toBe(true);
  });

  it("force overrides an ambiguous lookup (explicit admin decision)", async () => {
    selectReturns([]); // debit ledger exists
    const clientCalls = mockPoolClaim();
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(httpError(404));

    const result = await reverseBillPayment(billRow() as any, "admin override", { force: true });

    expect(result.reversed).toBe(true);
    expect(result.credited).toBe(true);
    expect(walletCredited(clientCalls, 100)).toBe(true);
  });

  it("never reverses a bill the provider DELIVERED (hard guard, no force)", async () => {
    vi.spyOn(sogo, "getTransaction").mockResolvedValue({
      transaction: { reference: "BILL202610301534S35246573", status: { value: "delivered", is_final: true } },
    });

    const result = await reverseBillPayment(
      billRow({ provider_reference: "BILL202610301534S35246573" }) as any,
      "test reversal",
      {},
    );

    expect(result.reversed).toBe(false);
    expect(result.providerVerified).toBe("completed");
    expect(result.notes.join(" ")).toMatch(/fulfilled/i);
    expect(creditWallet).not.toHaveBeenCalled();
  });
});
