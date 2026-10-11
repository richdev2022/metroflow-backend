import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Refer & Earn payout unit tests — locks the idempotency contract of
 * maybePayReferralBonus: exactly ONE bonus per referred user, only on the
 * business's FIRST successful subscription, only when the feature is enabled,
 * and the revenue ledger is debited in the same transaction.
 */

const queryMock = vi.fn();
const poolQueryMock = vi.fn();
const poolConnectMock = vi.fn();

vi.mock("../../db", () => ({
  query: (...args: any[]) => queryMock(...args),
  pool: {
    connect: (...args: any[]) => poolConnectMock(...args),
  },
}));

vi.mock("./app-config", () => ({
  getSetting: vi.fn(async (key: string, fallback: string) => {
    const values: Record<string, string> = {
      referral_bonus_enabled: "true",
      referral_bonus_amount: "5000",
      referral_bonus_currency: "NGN",
    };
    return values[key] ?? fallback;
  }),
}));

import { maybePayReferralBonus } from "../referral";

function makeClient() {
  return {
    query: vi.fn(),
    release: vi.fn(),
  };
}

beforeEach(() => {
  queryMock.mockReset();
  poolConnectMock.mockReset();
});

describe("maybePayReferralBonus", () => {
  it("pays once on the first subscription: credits referrer wallet, records ledger rows, debits revenue", async () => {
    const client = makeClient();
    poolConnectMock.mockResolvedValue(client);

    client.query.mockImplementation((sql: string) => {
      if (sql.includes("BEGIN") || sql.includes("COMMIT") || sql.includes("ROLLBACK")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("FROM businesses b JOIN users u")) {
        return Promise.resolve({
          rows: [{ user_id: "referred-uuid", user_name: "Referred Owner", referred_by: "referrer-uuid" }],
        });
      }
      if (sql.includes("COUNT(*)::int AS n FROM transactions")) {
        return Promise.resolve({ rows: [{ n: 1 }] }); // first payment
      }
      if (sql.includes("INSERT INTO referral_bonuses")) {
        return Promise.resolve({ rows: [{ id: "bonus-1" }] }); // inserted → we win
      }
      if (sql.includes("INSERT INTO transactions")) {
        return Promise.resolve({ rows: [{ id: "tx-1" }] }); // RETURNING id
      }
      if (sql.includes("FROM wallets WHERE user_id")) {
        return Promise.resolve({ rows: [{ id: "wallet-1" }] });
      }
      if (sql.includes("FROM platform_wallet")) {
        return Promise.resolve({ rows: [{ id: "rev-1" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await maybePayReferralBonus("biz-1", "plan-1");

    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    // referrer wallet credited
    const credit = client.query.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE wallets SET balance = balance +"),
    );
    expect(credit).toBeTruthy();
    expect(credit![1]).toEqual(["5000.00", "wallet-1"]);
    // revenue ledger debited
    const revDebit = client.query.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE platform_wallet SET balance = balance -"),
    );
    expect(revDebit).toBeTruthy();
  });

  it("is idempotent: a second payout for the same referred user is a no-op (ON CONFLICT gate)", async () => {
    const client = makeClient();
    poolConnectMock.mockResolvedValue(client);
    client.query.mockImplementation((sql: string) => {
      if (sql.includes("BEGIN") || sql.includes("COMMIT") || sql.includes("ROLLBACK")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("FROM businesses b JOIN users u")) {
        return Promise.resolve({
          rows: [{ user_id: "referred-uuid", user_name: "Referred Owner", referred_by: "referrer-uuid" }],
        });
      }
      if (sql.includes("COUNT(*)::int AS n FROM transactions")) {
        return Promise.resolve({ rows: [{ n: 2 }] }); // renewal → not first
      }
      return Promise.resolve({ rows: [] });
    });

    await maybePayReferralBonus("biz-1", "plan-1");

    // ROLLBACK (no payout), never COMMIT
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("skips when the owner has no referrer", async () => {
    const client = makeClient();
    poolConnectMock.mockResolvedValue(client);
    client.query.mockImplementation((sql: string) => {
      if (sql.includes("BEGIN") || sql.includes("COMMIT") || sql.includes("ROLLBACK")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("FROM businesses b JOIN users u")) {
        return Promise.resolve({ rows: [{ user_id: "u1", user_name: "X", referred_by: null }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await maybePayReferralBonus("biz-1", null);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("never throws into the caller even when the DB connection fails", async () => {
    poolConnectMock.mockRejectedValue(new Error("connection refused"));
    await expect(maybePayReferralBonus("biz-1", null)).resolves.toBeUndefined();
  });
});
