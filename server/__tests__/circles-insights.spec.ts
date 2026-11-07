import { describe, it, expect } from "vitest";

/**
 * SAVINGS CIRCLES + SMART SPENDING INSIGHTS — pure-logic unit tests over the
 * REAL exported helpers (addFrequency / clampTrust from the circles route,
 * categorize / buildCoreNudges / naira from the insights route).
 * The money-path integration is exercised by the local end-to-end run
 * (e2e_4_circles_insights.mjs) against a real Postgres.
 */

import { addFrequency, clampTrust } from "../features/personal/routes/circles";
import {
  categorize,
  buildCoreNudges,
  naira,
  CATEGORY_LABELS,
} from "../features/personal/routes/insights";

// ---------------------------------------------------------------------------
// CIRCLES — calendar scheduling + trust score clamping
// ---------------------------------------------------------------------------

describe("circles · addFrequency", () => {
  const base = new Date("2026-11-07T10:00:00.000Z");

  it("advances weekly by seven days", () => {
    expect(addFrequency(base, "weekly", 1).toISOString()).toBe("2026-11-14T10:00:00.000Z");
  });

  it("advances biweekly by fourteen days", () => {
    expect(addFrequency(base, "biweekly", 1).toISOString()).toBe("2026-11-21T10:00:00.000Z");
  });

  it("steps forward N cycles at once", () => {
    expect(addFrequency(base, "weekly", 3).toISOString()).toBe("2026-11-28T10:00:00.000Z");
  });

  it("advances monthly by one calendar month (Jan 31 → Feb 28 overflow-safe)", () => {
    const jan31 = new Date("2027-01-31T10:00:00.000Z");
    const next = addFrequency(jan31, "monthly", 1);
    expect(next.getUTCMonth()).toBe(1); // February
    expect(next.getUTCDate()).toBeLessThanOrEqual(28); // never overflows to Mar 2/3
  });

  it("keeps unknown frequencies safe (treated as weekly)", () => {
    const next = addFrequency(base, "whatever", 1);
    expect(next.toISOString()).toBe("2026-11-14T10:00:00.000Z");
  });

  it("never mutates the input date", () => {
    const input = new Date(base.getTime());
    addFrequency(input, "monthly", 2);
    expect(input.toISOString()).toBe(base.toISOString());
  });
});

describe("circles · clampTrust", () => {
  it("clamps negatives to 0", () => {
    expect(clampTrust(-25)).toBe(0);
  });

  it("clamps above 100 to 100", () => {
    expect(clampTrust(120)).toBe(100);
  });

  it("rounds fractional scores", () => {
    expect(clampTrust(99.4)).toBe(99);
    expect(clampTrust(99.6)).toBe(100);
  });

  it("passes through in-band integers", () => {
    expect(clampTrust(0)).toBe(0);
    expect(clampTrust(50)).toBe(50);
    expect(clampTrust(100)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// INSIGHTS — auto-categorisation over the personal ledger
// ---------------------------------------------------------------------------

describe("insights · categorize", () => {
  it("keeps known bill sub-categories (bill_payments.category)", () => {
    expect(categorize("bill", "airtime")).toBe("airtime");
    expect(categorize("bill", "data")).toBe("data");
    expect(categorize("bill", "tv")).toBe("tv");
    expect(categorize("bill", "electricity")).toBe("electricity");
    expect(categorize("bill", "betting")).toBe("betting");
  });

  it("falls back to the Bills & Utilities bucket for unknown bill categories", () => {
    expect(categorize("bill", "other")).toBe("bills");
    expect(categorize("bill", "")).toBe("bills");
  });

  it("maps the non-bill personal transaction types", () => {
    expect(categorize("transfer", "")).toBe("transfers");
    expect(categorize("market_order", "")).toBe("marketplace");
    expect(categorize("giftcard_buy", "")).toBe("giftcards");
    expect(categorize("rmb_buy", "")).toBe("giftcards");
    expect(categorize("vcard_fund", "")).toBe("virtual_cards");
    expect(categorize("vcard_create", "")).toBe("virtual_cards");
    expect(categorize("vcard_terminate", "")).toBe("virtual_cards");
    expect(categorize("esim_order", "")).toBe("esim");
    expect(categorize("split_payment", "")).toBe("splits");
    expect(categorize("pot_contribution", "")).toBe("group_pots");
    expect(categorize("circle_contribution", "")).toBe("savings_circles");
    expect(categorize("donation", "")).toBe("donations");
    expect(categorize("boost", "")).toBe("boosts");
    expect(categorize("live_gift", "")).toBe("live_gifts");
    expect(categorize("poll_vote", "")).toBe("polls");
    expect(categorize("stablecoin_convert", "")).toBe("conversions");
  });

  it("groups crypto/stablecoin variants and falls back to other", () => {
    expect(categorize("crypto_sale", "")).toBe("crypto");
    expect(categorize("stablecoin_buy_usdt", "")).toBe("crypto");
    expect(categorize("some_new_type", "")).toBe("other");
  });

  it("every taxonomy category carries a human label", () => {
    for (const cat of Object.values(CATEGORY_LABELS)) {
      expect(cat).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// INSIGHTS — nudges ("you spent ₦12,400 on airtime — 3× your average")
// ---------------------------------------------------------------------------

describe("insights · buildCoreNudges", () => {
  const bucket = (amount: number, count = 1) => ({ amount, count });

  it("flags a category far above its trailing average", () => {
    const nudges = buildCoreNudges(
      { airtime: bucket(12400, 6) },
      new Map([["airtime", 4133.33]]),
      [],
      12400,
    );
    const spike = nudges.find((n) => n.type === "spike");
    expect(spike).toBeTruthy();
    expect(spike!.title).toContain("Airtime");
    expect(spike!.body).toContain("3×");
    expect(spike!.body).toContain("₦12,400");
  });

  it("stays quiet inside the normal band", () => {
    const nudges = buildCoreNudges(
      { airtime: bucket(12400) },
      new Map([["airtime", 12000]]), // 1.03× — inside the 2× band
      [],
      12400,
    );
    expect(nudges.find((n) => n.type === "spike")).toBeUndefined();
  });

  it("never nudges a first-time small spend", () => {
    const nudges = buildCoreNudges(
      { betting: bucket(1500) }, // below the ₦2,000 floor
      new Map([["betting", 0]]),
      [],
      1500,
    );
    expect(nudges).toHaveLength(0);
  });

  it("ignores a spike whose trailing average is still tiny", () => {
    const nudges = buildCoreNudges(
      { betting: bucket(6000) },
      new Map([["betting", 400]]), // avg < ₦500 — no baseline yet
      [],
      6000,
    );
    expect(nudges.find((n) => n.type === "spike")).toBeUndefined();
  });

  it("announces a blown budget envelope with the overage", () => {
    const nudges = buildCoreNudges(
      { airtime: bucket(12400) },
      new Map(),
      [{ label: "Airtime", monthly_limit: 10000, spent: 12400, remaining: 0, pct: 124 }],
      12400,
    );
    const alert = nudges.find((n) => n.type === "budget_over");
    expect(alert).toBeTruthy();
    expect(alert!.title).toContain("Airtime budget blown");
    expect(alert!.body).toContain("124%");
    expect(alert!.body).toContain("₦2,400");
  });

  it("warns at the 80% envelope line", () => {
    const nudges = buildCoreNudges(
      { data: bucket(8500) },
      new Map(),
      [{ label: "Data", monthly_limit: 10000, spent: 8500, remaining: 1500, pct: 85 }],
      8500,
    );
    const warn = nudges.find((n) => n.type === "budget_warn");
    expect(warn).toBeTruthy();
    expect(warn!.body).toContain("85%");
    expect(warn!.body).toContain("₦1,500");
  });

  it("adds the always-on top-category context once spend is meaningful", () => {
    const nudges = buildCoreNudges(
      { airtime: bucket(8000, 4), data: bucket(2000, 2) },
      new Map(),
      [],
      10000,
    );
    const top = nudges.find((n) => n.type === "top_category");
    expect(top).toBeTruthy();
    expect(top!.title).toContain("Airtime");
    expect(top!.body).toContain("80%");
  });

  it("stays silent about the top category when the month was tiny", () => {
    const nudges = buildCoreNudges({ airtime: bucket(3000) }, new Map(), [], 3000);
    expect(nudges.find((n) => n.type === "top_category")).toBeUndefined();
  });

  it("caps spikes at the two biggest categories", () => {
    const nudges = buildCoreNudges(
      { airtime: bucket(12000), data: bucket(9000), electricity: bucket(7000) },
      new Map([
        ["airtime", 1000],
        ["data", 1000],
        ["electricity", 1000],
      ]),
      [],
      28000,
    );
    expect(nudges.filter((n) => n.type === "spike")).toHaveLength(2);
  });
});

describe("insights · naira", () => {
  it("formats whole-naira with grouping", () => {
    expect(naira(12400)).toBe("₦12,400");
    expect(naira(999.4)).toBe("₦999");
  });
});
