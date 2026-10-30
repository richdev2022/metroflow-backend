import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SOGO BILL WEBHOOK — end-to-end offline tests for the live-event pipeline.
 *
 * Root-caused production incident (2026-10-30, livemode): the webhook
 * `transaction.completed` for an airtime bill arrived, passed signature
 * verification and was logged "processed", but the bill row stayed
 * 'processing' because
 *   1. `payload.data.object` is the discriminator STRING "transaction" — the
 *      old extraction turned the event object into that literal string;
 *   2. live Sogo webhooks carry Sogo's OWN reference (BILL…), while our
 *      bill row had provider_reference NULL (purchase response lost) — no
 *      reference match, silent drop;
 *   3. the old strict status equality ["completed","failed",…] maps Sogo's
 *      live vocabulary ("successful", "delivered", "failure", "canceled")
 *      to "processing".
 *
 * These tests pin the fixed pipeline: extraction → routing → reference
 * match → backfill reconciliation → status normalization → reconfirm →
 * settlement engine.
 */

vi.mock("../db", () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock("../services/prestmit", () => ({ verifyPrestmitWebhook: vi.fn() }));
vi.mock("../services/notifications", () => ({ createNotification: vi.fn(async () => ({})) }));
vi.mock("../services/providers/bitnob", () => ({}));
vi.mock("../features/personal/personal-utils", () => ({
  creditWallet: vi.fn(async () => ({})),
  insertTransaction: vi.fn(async () => ({})),
}));
vi.mock("../features/personal/bill-settlement", () => ({
  settleBillCompleted: vi.fn(async () => true),
  refundBillRow: vi.fn(async () => true),
  reverseBillPayment: vi.fn(async () => ({ reversed: true, alreadyReversed: false, credited: true, notes: [] })),
}));
vi.mock("../services/app-config", () => ({
  getSetting: vi.fn(async (_k: string, fallback: string) => fallback),
}));

import { query } from "../db";
import { processSogoEvent } from "../routes/personal-webhooks";
import * as sogo from "../services/sogo";
import { settleBillCompleted, refundBillRow } from "../features/personal/bill-settlement";

const OLD_ENV = process.env;

/** The EXACT live payload observed 2026-10-30 (redacted idents preserved). */
const LIVE_COMPLETED_EVENT = {
  id: "evt_ngNNC603bLa6tJNM0DmW",
  data: {
    id: "01a18d3b-e64e-720b-a717-4c32b3936662",
    fee: { raw: 0, formatted: "NGN 0.00" },
    type: { value: "bill_payment", is_credit: false },
    amount: { raw: 97, currency: "NGN", formatted: "NGN 97.00" },
    object: "transaction",
    status: { value: "completed", is_final: true },
    metadata: { source: "partner_api", network: "Airtel", discount: 3, bill_type: "Airtime", face_value: 100, phone_number: "09025832235" },
    reference: "BILL202610301534S35246573",
    net_amount: { raw: 97, formatted: "NGN 97.00" },
    timestamps: {
      failed_at: null, created_at: "2026-10-30T14:34:35.000000Z",
      updated_at: "2026-10-30T14:34:39.000000Z", cancelled_at: null,
      completed_at: "2026-10-30T14:34:39.000000Z",
    },
    description: "Airtime - Airtel (09025832235)",
    failure_reason: null,
    cancellation_reason: null,
  },
  event: "transaction.completed",
  created: 1793370879,
  livemode: true,
  api_version: "2026-05-07",
};

const STRANDED_ROW = {
  id: "row-1", reference: "MF-BILL-MVV2PRHWECRO4Y", provider: "sogo",
  provider_reference: null, category: "airtime", provider_slug: "airtel",
  customer_ref: "09025832235", amount: "100.00", fee: "0.00", total: "100.00",
  status: "processing", user_id: "u-1", wallet_id: "w-1", business_id: null,
  created_at: new Date("2026-10-30T14:34:35.252Z"),
};

type Route = (sql: string, params: any[]) => { rows: any[]; rowCount: number } | undefined;

/** Install a db mock that routes by SQL shape; returns the call log. */
function mockDb(route: Route) {
  const calls: { sql: string; params: any[] }[] = [];
  (query as any).mockImplementation(async (sql: string, params?: any[]) => {
    const p = params || [];
    calls.push({ sql, params: p });
    return route(sql, p) || { rows: [], rowCount: 0 };
  });
  return calls;
}

beforeEach(() => {
  process.env = { ...OLD_ENV };
  process.env.SOGO_WEBHOOK_SECRET = "whsec_test";
  (query as any).mockReset?.();
  (query as any).mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  vi.mocked(settleBillCompleted).mockClear();
  vi.mocked(refundBillRow).mockClear();
  // Default: sandbox OFF so the reconfirm path is exercised; tests override.
  vi.spyOn(sogo, "isSogoSandbox").mockReturnValue(true);
  vi.restoreAllMocks?.();
});

describe("sogo extraction helpers", () => {
  it("sogoTx returns data (never the data.object discriminator string)", () => {
    const tx = sogo.sogoTx(LIVE_COMPLETED_EVENT);
    expect(tx.reference).toBe("BILL202610301534S35246573");
    expect(typeof tx).toBe("object");
  });

  it("sogoType unwraps {value} objects", () => {
    expect(sogo.sogoType(LIVE_COMPLETED_EVENT.data)).toBe("bill_payment");
    expect(sogo.sogoType({ type: "buy_giftcard" })).toBe("buy_giftcard");
    expect(sogo.sogoType({})).toBe("");
  });

  it("sogoAmount unwraps {raw} money objects", () => {
    expect(sogo.sogoAmount(LIVE_COMPLETED_EVENT.data.amount)).toBe(97);
    expect(sogo.sogoAmount(150)).toBe(150);
    expect(sogo.sogoAmount(undefined)).toBe(0);
    expect(sogo.sogoAmount({ raw: NaN })).toBe(0);
  });

  it("normalizeSogoStatus maps Sogo's live vocabulary", () => {
    expect(sogo.normalizeSogoStatus({ value: "completed", is_final: true })).toBe("completed");
    expect(sogo.normalizeSogoStatus("successful")).toBe("completed");
    expect(sogo.normalizeSogoStatus("delivered")).toBe("completed");
    expect(sogo.normalizeSogoStatus("failure")).toBe("failed");
    expect(sogo.normalizeSogoStatus("canceled")).toBe("cancelled");
    expect(sogo.normalizeSogoStatus("reversed")).toBe("refunded");
    expect(sogo.normalizeSogoStatus("pending")).toBe("processing");
    expect(sogo.normalizeSogoStatus(undefined)).toBe("processing");
  });

  it("sogoReference sees through the {data: {transaction}} envelope", () => {
    expect(sogo.sogoReference({ data: { transaction: { reference: "BILL-1" } } })).toBe("BILL-1");
    expect(sogo.sogoReference({ transaction: { reference: "BILL-2" } })).toBe("BILL-2");
    expect(sogo.sogoReference({ reference: "BILL-3" })).toBe("BILL-3");
  });
});

describe("sogo bill webhook pipeline (live payload)", () => {
  it("reconciles the stranded bill via BACKFILL and settles it completed", async () => {
    const calls = mockDb((sql) => {
      if (sql.includes("FROM bill_transactions WHERE reference = $1 OR provider_reference = $1")) {
        return { rows: [], rowCount: 0 }; // no direct match (provider_reference NULL)
      }
      if (sql.includes("ORDER BY created_at DESC LIMIT 5")) {
        return { rows: [STRANDED_ROW], rowCount: 1 }; // unique backfill candidate
      }
      if (sql.includes("SET provider_reference = $2")) {
        return { rows: [{ ...STRANDED_ROW, provider_reference: "BILL202610301534S35246573" }], rowCount: 1 };
      }
      return undefined;
    });

    const outcome = await processSogoEvent(LIVE_COMPLETED_EVENT);
    expect(outcome).toBe("processed");
    expect(settleBillCompleted).toHaveBeenCalledTimes(1);
    const [billArg] = vi.mocked(settleBillCompleted).mock.calls[0];
    expect(billArg.reference).toBe("MF-BILL-MVV2PRHWECRO4Y");

    // Backfill filtered by amount (face value 100), phone + category + window.
    const backfill = calls.find((c) => c.sql.includes("ORDER BY created_at DESC LIMIT 5"));
    expect(backfill).toBeTruthy();
    expect(backfill!.params).toContain("09025832235");
    expect(backfill!.params).toContain("airtime");
    const amountsParam = backfill!.params.find((p) => Array.isArray(p) && p.includes(100));
    expect(amountsParam).toBeTruthy();
    // The claim stored Sogo's own reference on our row.
    const claim = calls.find((c) => c.sql.includes("SET provider_reference = $2"));
    expect(claim!.params[1]).toBe("BILL202610301534S35246573");
  });

  it("matches directly when provider_reference already holds Sogo's reference", async () => {
    mockDb((sql) => {
      if (sql.includes("FROM bill_transactions WHERE reference = $1 OR provider_reference = $1")) {
        return { rows: [{ ...STRANDED_ROW, provider_reference: "BILL202610301534S35246573" }], rowCount: 1 };
      }
      return undefined;
    });
    const outcome = await processSogoEvent(LIVE_COMPLETED_EVENT);
    expect(outcome).toBe("processed");
    expect(settleBillCompleted).toHaveBeenCalledTimes(1);
    // No backfill ran (no LIMIT 5 statement).
  });

  it("normalizes Sogo's live status vocabulary ('successful' → completed)", async () => {
    mockDb((sql) => {
      if (sql.includes("FROM bill_transactions WHERE reference = $1 OR provider_reference = $1")) {
        return { rows: [STRANDED_ROW], rowCount: 1 };
      }
      return undefined;
    });
    const payload = {
      event: "transaction.completed",
      data: { object: "transaction", reference: "BILL-X", status: "successful", type: "bill_payment", metadata: {} },
    };
    const outcome = await processSogoEvent(payload);
    expect(outcome).toBe("processed");
    expect(settleBillCompleted).toHaveBeenCalledTimes(1);
  });

  it("routes failed events to refundBillRow with the normalized status", async () => {
    mockDb((sql) => {
      if (sql.includes("FROM bill_transactions WHERE reference = $1 OR provider_reference = $1")) {
        return { rows: [STRANDED_ROW], rowCount: 1 };
      }
      return undefined;
    });
    await processSogoEvent({
      event: "transaction.failed",
      data: { object: "transaction", reference: "BILL-X", status: { value: "failure", is_final: true }, type: { value: "bill_payment" }, metadata: {} },
    });
    expect(refundBillRow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refundBillRow).mock.calls[0][1]).toMatch(/failed/i);
  });

  it("reconfirm MISMATCH (webhook completed, provider failed) refuses to settle", async () => {
    vi.spyOn(sogo, "isSogoSandbox").mockReturnValue(false);
    vi.spyOn(sogo, "getTransaction").mockResolvedValue({
      transaction: { reference: "BILL-X", status: { value: "failed", is_final: true } },
    });
    mockDb((sql) => {
      if (sql.includes("FROM bill_transactions WHERE reference = $1 OR provider_reference = $1")) {
        return { rows: [STRANDED_ROW], rowCount: 1 };
      }
      return undefined;
    });
    await processSogoEvent(LIVE_COMPLETED_EVENT);
    expect(settleBillCompleted).not.toHaveBeenCalled();
    expect(refundBillRow).not.toHaveBeenCalled();
  });

  it("reconfirm AGREEMENT settles; unreachable provider falls back to the signed webhook", async () => {
    vi.spyOn(sogo, "isSogoSandbox").mockReturnValue(false);
    vi.spyOn(sogo, "getTransaction").mockRejectedValue(new Error("timeout"));
    mockDb((sql) => {
      if (sql.includes("FROM bill_transactions WHERE reference = $1 OR provider_reference = $1")) {
        return { rows: [STRANDED_ROW], rowCount: 1 };
      }
      return undefined;
    });
    await processSogoEvent(LIVE_COMPLETED_EVENT);
    expect(settleBillCompleted).toHaveBeenCalledTimes(1);
  });

  it("drops events for unknown bills without settling anything", async () => {
    mockDb(() => undefined); // every lookup empty
    const outcome = await processSogoEvent(LIVE_COMPLETED_EVENT);
    expect(outcome).toBe("processed");
    expect(settleBillCompleted).not.toHaveBeenCalled();
    expect(refundBillRow).not.toHaveBeenCalled();
  });

  it("does not guess when the backfill matcher is ambiguous", async () => {
    mockDb((sql) => {
      if (sql.includes("FROM bill_transactions WHERE reference = $1 OR provider_reference = $1")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("ORDER BY created_at DESC LIMIT 5")) {
        return {
          rows: [STRANDED_ROW, { ...STRANDED_ROW, id: "row-2", reference: "MF-BILL-SECOND" }],
          rowCount: 2,
        };
      }
      return undefined;
    });
    await processSogoEvent(LIVE_COMPLETED_EVENT);
    expect(settleBillCompleted).not.toHaveBeenCalled();
  });

  it("routes {value} giftcard types to the giftcard handler (type-object fix)", async () => {
    const calls = mockDb((sql) => {
      if (sql.includes("FROM giftcard_buy_orders")) {
        return { rows: [{ id: "gc-1", reference: "MF-GC-1", provider: "sogo", status: "processing", card_codes: [{ pin: "1234" }], giftcard_name: "Steam", user_id: "u-1", wallet_id: "w-1", business_id: null, total_charged: "50.00" }], rowCount: 1 };
      }
      return undefined;
    });
    await processSogoEvent({
      event: "transaction.completed",
      data: { object: "transaction", reference: "MF-GC-1", status: { value: "completed" }, type: { value: "buy_giftcard" }, metadata: {} },
    });
    expect(calls.some((c) => c.sql.includes("FROM giftcard_buy_orders"))).toBe(true);
    // The old String(type) routing would have sent this to the bill handler.
    expect(settleBillCompleted).not.toHaveBeenCalled();
  });

  it("ignores unknown event names", async () => {
    const calls = mockDb(() => undefined);
    const outcome = await processSogoEvent({ event: "bill.exploded", data: { reference: "BILL-1" } });
    expect(outcome).toBe("ignored");
    expect(calls.length).toBe(0);
  });
});
