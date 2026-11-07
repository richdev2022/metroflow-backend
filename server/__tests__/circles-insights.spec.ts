import { describe, it, expect } from "vitest";

/**
 * SAVINGS CIRCLES + SMART SPENDING INSIGHTS — pure-logic unit tests.
 * The money-path integration is exercised by the local end-to-end run
 * (scripts/e2e_4_circles_insights.ts) against a real Postgres.
 */

import { addInterval, clampTrust } from "../features/personal/routes/circles";
import {
  categorizeTransaction,
  buildNudge,
  INSIGHT_CATEGORIES,
  CATEGORY_LABELS,
  SAVING_TYPES,
} from "../features/personal/routes/insights";

// ---------------------------------------------------------------------------
// CIRCLES — calendar scheduling + trust score clamping
// ---------------------------------------------------------------------------

describe("circles · addInterval", () => {
  const base = new Date("2026-11-07T10:00:00.000Z");

  it("advances daily by one day", () => {
    expect(addInterval(base, "daily").toISOString()).toBe("2026-11-08T10:00:00.000Z");
  });

  it("advances weekly by seven days", () => {
    expect(addInterval(base, "weekly").toISOString()).toBe("2026-11-14T10:00:00.000Z");
  });

  it("advances monthly by one calendar month (Jan 31 → Feb 28 overflow-safe)", () => {
    const jan31 = new Date("2027-01-31T10:00:00.000Z");
    const next = addInterval(jan31, "monthly");
    expect(next.getUTCMonth()).toBe(1); // February
    expect(next.getUTCDate()).toBeLessThanOrEqual(28);
  });

  it("keeps unknown frequencies safe (treated as monthly)", () => {
    const next = addInterval(base, "whatever");
    expect(next.getUTCMonth()).toBe(11); // December
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
});

// ---------------------------------------------------------------------------
// INSIGHTS — auto-categorisation over the personal ledger
// ---------------------------------------------------------------------------

describe("insights · categorizeTransaction", () => {
  it("parses bill categories from the ledger description", () => {
    expect(categorizeTransaction("bill", "Bill payment — airtime (SOGO) — 08031234567")).toBe("airtime");
    expect(categorizeTransaction("bill", "Bill payment — data — 08031234567")).toBe("data");
    expect(categorizeTransaction("bill", "Bill payment — electricity (IKEDC) — 45001234567")).toBe("electricity");
    expect(categorizeTransaction("bill", "Bill payment — cable (DSTV) — 7012345678")).toBe("cable_tv");
    expect(categorizeTransaction("bill", "Bill payment — education — 55012345678")).toBe("education");
    expect(categorizeTransaction("bill", "Bill payment — epin")).toBe("epin");
    expect(categorizeTransaction("bill", "Bill payment — betting — OPay-99887")).toBe("betting");
  });

  it("maps the non-bill personal transaction types", () => {
    expect(categorizeTransaction("transfer", "Transfer to Chidi O.")).toBe("transfers");
    expect(categorizeTransaction("market_order", "Market order — Ankara set")).toBe("marketplace");
    expect(categorizeTransaction("giftcard_buy", "Gift card purchase — Apple $50")).toBe("giftcards");
    expect(categorizeTransaction("crypto_sale", "Crypto sale — 0.004 BTC")).toBe("crypto");
    expect(categorizeTransaction("vcard_fund", "Virtual card funding")).toBe("virtual_cards");
    expect(categorizeTransaction("vcard_create", "Virtual card creation")).toBe("virtual_cards");
    expect(categorizeTransaction("esim_order", "eSIM order — 1GB")).toBe("esim");
    expect(categorizeTransaction("rmb_buy", "RMB purchase — ¥500")).toBe("rmb");
    expect(categorizeTransaction("live_gift", "Live gift — rose x5")).toBe("live");
    expect(categorizeTransaction("split_payment", "Split payment — Lunch")).toBe("social");
    expect(categorizeTransaction("pot_contribution", "Group pot contribution — Detty December")).toBe("social");
    expect(categorizeTransaction("poll_vote", "Paid poll vote")).toBe("social");
  });

  it("falls back to other for unmapped spend types", () => {
    expect(categorizeTransaction("some_new_type", "Something new")).toBe("other");
    expect(categorizeTransaction("bill", "Unparseable description")).toBe("other");
  });

  it("exposes saving move types so spend totals skip them", () => {
    for (const t of ["savings_deposit", "roundup", "circle_contribution", "circle_payout", "pot_payout"]) {
      expect(SAVING_TYPES.has(t)).toBe(true);
    }
  });

  it("every insight category carries a human label", () => {
    for (const c of INSIGHT_CATEGORIES) {
      expect(CATEGORY_LABELS[c]).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// INSIGHTS — nudges ("you spent ₦12,400 on airtime — 3× your average")
// ---------------------------------------------------------------------------

describe("insights · buildNudge", () => {
  it("flags a category far above its trailing average", () => {
    const nudge = buildNudge("airtime", 12400, 4133.33);
    expect(nudge).toContain("Airtime");
    expect(nudge).toContain("3×");
    expect(nudge).toContain("₦12,400");
  });

  it("stays quiet inside the normal band", () => {
    expect(buildNudge("airtime", 12400, 12000)).toBeNull();
    expect(buildNudge("data", 500, 300)).toBeNull(); // below the ₦2,000 floor
  });

  it("announces a brand-new pattern when there is no average yet", () => {
    const nudge = buildNudge("betting", 15000, 0);
    expect(nudge).toContain("New spending pattern");
  });

  it("never nudges a first-time small spend", () => {
    expect(buildNudge("betting", 1500, 0)).toBeNull();
  });
});
