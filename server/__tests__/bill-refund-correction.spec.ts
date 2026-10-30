import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BILL REFUND CORRECTION — correctWrongRefund + ambiguous-error policy.
 *
 * Production class being pinned (2026-10-30): bill MF-BILL-MVV2PRHWECRO4Y
 * was fulfilled by live Sogo (webhook transaction.completed captured), yet
 * the row got auto-refunded — the customer had the service AND the money.
 * correctWrongRefund is the webhook-driven money fix: claim the row
 * (refunded|failed|cancelled → completed), re-debit the wallet (guarded by
 * balance), write the `${ref}-REFUND-REVERSAL` debit ledger row and restore
 * the original debit's display status — all in ONE transaction.
 */

vi.mock("../db", () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  pool: { connect: vi.fn() },
}));
vi.mock("../services/notifications", () => ({ createNotification: vi.fn(async () => ({})) }));
vi.mock("../services/push", () => ({ sendPushToUsers: vi.fn(async () => ({})) }));
vi.mock("../services/fees", () => ({
  creditPlatformWallet: vi.fn(async () => ({})),
  debitRevenueWallet: vi.fn(async () => ({})),
  creditRevenueWallet: vi.fn(async () => ({})),
}));
vi.mock("../features/personal/personal-utils", () => ({
  creditWallet: vi.fn(async () => ({})),
  insertTransaction: vi.fn(async () => ({})),
}));
vi.mock("../features/personal/provider-routing", () => ({
  getActiveProvider: vi.fn(async () => "sogo"),
}));
vi.mock("../services/app-config", () => ({
  getSetting: vi.fn(async (_k: string, fallback: string) => fallback),
}));

import { query, pool } from "../db";
import { createNotification } from "../services/notifications";
import { sendPushToUsers } from "../services/push";
import { correctWrongRefund } from "../features/personal/bill-settlement";
import { isAmbiguousProviderError } from "../services/sogo";

const REF = "MF-BILL-TESTCORRECTION";

const BASE_BILL = {
  id: "row-1",
  reference: REF,
  user_id: "u-1",
  business_id: null,
  wallet_id: "w-1",
  provider: "sogo",
  category: "airtime",
  amount: "100.00",
  fee: "0.00",
  total: "100.00",
  status: "refunded",
  details: {},
  provider_reference: "BILL20261030TEST",
  created_at: new Date("2026-10-30T14:34:35Z"),
};

type Route = (sql: string, params?: any[]) => { rows: any[]; rowCount: number } | undefined;

/** Install db mock + a transactional client mock; returns call logs. */
function install(opts: { claimWins: boolean; walletCovers: boolean; refundCreditExists: boolean }) {
  const poolCalls: { sql: string; params?: any[] }[] = [];
  const clientCalls: { sql: string; params?: any[] }[] = [];

  (query as any).mockImplementation(async (sql: string, params?: any[]) => {
    poolCalls.push({ sql, params });
    const hit = ((sql: string) => {
      if (sql.includes("FROM transactions WHERE reference = $1 AND type = 'credit'")) {
        return { rows: opts.refundCreditExists ? [{ id: 1 }] : [], rowCount: opts.refundCreditExists ? 1 : 0 };
      }
      if (sql.includes("FROM wallets WHERE id = $1")) {
        return { rows: [{ user_id: "u-1", business_id: null }], rowCount: 1 };
      }
      return undefined;
    })(sql);
    return hit || { rows: [], rowCount: 0 };
  });

  const client = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      clientCalls.push({ sql, params });
      const hit = ((sql: string) => {
        if (sql.includes("UPDATE bill_transactions") && sql.includes("RETURNING id")) {
          return { rows: opts.claimWins ? [{ id: "row-1" }] : [], rowCount: opts.claimWins ? 1 : 0 };
        }
        if (sql.includes("UPDATE wallets") && sql.includes("RETURNING id")) {
          return { rows: opts.walletCovers ? [{ id: "w-1" }] : [], rowCount: opts.walletCovers ? 1 : 0 };
        }
        return undefined;
      })(sql);
      return hit || { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  (pool.connect as any).mockResolvedValue(client);

  return { poolCalls, clientCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("correctWrongRefund", () => {
  it("re-debits a refunded-but-fulfilled bill atomically and restores the ledger", async () => {
    const { clientCalls } = install({ claimWins: true, walletCovers: true, refundCreditExists: true });

    const out = await correctWrongRefund(BASE_BILL, { webhook: "transaction.completed" });

    expect(out).toMatchObject({ corrected: true, reDebited: true });
    const sqls = clientCalls.map((c) => c.sql).join("\n");
    expect(sqls).toContain("BEGIN");
    expect(sqls).toContain("COMMIT");
    expect(sqls).toContain("bill_refund_reversal");
    // the reversal reference rides as a bound parameter of the ledger INSERT
    const insertCall = clientCalls.find((c) => c.sql.includes("bill_refund_reversal"));
    expect(insertCall?.params?.[3]).toBe(`${REF}-REFUND-REVERSAL`);
    // original debit display flip runs inside the same tx
    expect(sqls).toContain("SET status = 'success'");
    // customer is told
    expect(createNotification).toHaveBeenCalled();
    expect(sendPushToUsers).toHaveBeenCalled();
  });

  it("rolls back completely when the wallet can no longer cover the re-debit", async () => {
    const { clientCalls } = install({ claimWins: true, walletCovers: false, refundCreditExists: true });

    const out = await correctWrongRefund(BASE_BILL, null);

    expect(out.corrected).toBe(false);
    expect(out.note).toMatch(/support/i);
    const sqls = clientCalls.map((c) => c.sql).join("\n");
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
    // support is flagged instead of a surprise negative balance
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "Bill correction pending" }));
  });

  it("is a no-op when the row was settled concurrently (claim lost)", async () => {
    const { clientCalls } = install({ claimWins: false, walletCovers: true, refundCreditExists: true });

    const out = await correctWrongRefund(BASE_BILL, null);

    expect(out.corrected).toBe(false);
    expect(out.note).toMatch(/no longer correctable/);
    const sqls = clientCalls.map((c) => c.sql).join("\n");
    expect(sqls).toContain("ROLLBACK");
  });

  it("completes a failed row without any wallet movement when nothing was refunded", async () => {
    const { clientCalls } = install({ claimWins: true, walletCovers: true, refundCreditExists: false });

    const out = await correctWrongRefund({ ...BASE_BILL, status: "failed" }, null);

    expect(out.corrected).toBe(true);
    expect(out.reDebited).toBe(false);
    const sqls = clientCalls.map((c) => c.sql).join("\n");
    expect(sqls).toContain("COMMIT");
    expect(sqls).not.toContain("UPDATE wallets");
  });

  it("refuses to correct without a wallet link or a positive total", async () => {
    install({ claimWins: true, walletCovers: true, refundCreditExists: true });
    const out = await correctWrongRefund({ ...BASE_BILL, wallet_id: null }, null);
    expect(out.corrected).toBe(false);
  });
});

describe("isAmbiguousProviderError (money-safety policy)", () => {
  it("treats 5xx gateway errors as ambiguous — the order may have landed", () => {
    expect(isAmbiguousProviderError({ response: { status: 500 } })).toBe(true);
    expect(isAmbiguousProviderError({ response: { status: 502 } })).toBe(true);
    expect(isAmbiguousProviderError({ response: { status: 504 } })).toBe(true);
  });

  it("treats explicit 4xx rejections as definitive — safe to refund", () => {
    expect(isAmbiguousProviderError({ response: { status: 400 } })).toBe(false);
    expect(isAmbiguousProviderError({ response: { status: 402 } })).toBe(false);
    expect(isAmbiguousProviderError({ response: { status: 422 } })).toBe(false);
  });

  it("treats network-level failures (timeout, DNS, reset) as ambiguous", () => {
    expect(isAmbiguousProviderError(new Error("timeout of 60000ms exceeded"))).toBe(true);
    expect(isAmbiguousProviderError({ code: "ECONNABORTED" })).toBe(true);
    expect(isAmbiguousProviderError(undefined)).toBe(true);
  });
});
