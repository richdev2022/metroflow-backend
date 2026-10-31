import { query } from "../../db";

/**
 * BILL PROMOTIONS — admin-managed per-category pricing.
 *
 * Two levers, configurable per bill category (airtime, data, electricity,
 * cable, education, epin, betting) from the admin dashboard:
 *
 *   discount_percent  — knocks X% OFF the bill face value. The customer pays
 *                       `amount - discount + fee`; the provider is still paid
 *                       the full face value (the platform absorbs the promo).
 *   cashback_percent  — after a SUCCESSFUL payment, X% of the face value is
 *                       credited back to the paying wallet (Opay-style
 *                       cashback) with its own wallet_transactions entry.
 *
 * Stored in `bill_pricing_rules` (one row per category — created lazily,
 * idempotent, like every other personal-feature schema).
 */

export const BILL_CATEGORIES = ["airtime", "data", "electricity", "cable", "education", "epin", "betting"] as const;
export type BillPricingCategory = (typeof BILL_CATEGORIES)[number];

export interface BillPricingRule {
  category: string;
  discount_percent: number;
  cashback_percent: number;
  /** Maximum cashback payable per single bill (₦) — caps the percentage calc. */
  cashback_cap: number;
  enabled: boolean;
}

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

let schemaReady = false;

/**
 * CASHBACK SEED (one-time) — the platform's default bill cashback is 0.5% of
 * the face value, capped at ₦30 per bill (down from the old 2% default).
 * Guarded by a system_settings marker so it runs exactly once across
 * redeploys and never tramples an operator's later customizations:
 *   - legacy airtime/data rows still at the old 2% default are converted to
 *     0.5% with a ₦30 cap
 *   - categories with no rule yet are seeded 0.5% / ₦30 cap, enabled
 */
export async function seedDefaultCashbackRules(): Promise<void> {
  try {
    const marker = await query(
      `SELECT 1 FROM system_settings WHERE key = $1 LIMIT 1`,
      ["bill_cashback_seed_05_v1"],
    );
    if (marker.rows.length) return;
    // Legacy 2% default → 0.5% capped at ₦30.
    await query(
      `UPDATE bill_pricing_rules
          SET cashback_percent = 0.5, cashback_cap = 30, updated_at = CURRENT_TIMESTAMP
        WHERE category IN ('airtime', 'data') AND cashback_percent = 2`,
    );
    // First-time seed when a category has no rule row yet.
    for (const cat of ["airtime", "data"]) {
      await query(
        `INSERT INTO bill_pricing_rules (category, discount_percent, cashback_percent, cashback_cap, enabled)
         SELECT $1, 0, 0.5, 30, true
          WHERE NOT EXISTS (SELECT 1 FROM bill_pricing_rules WHERE category = $1)`,
        [cat],
      );
    }
    await query(
      `INSERT INTO system_settings (key, value, description)
       VALUES ('bill_cashback_seed_05_v1', 'done', 'One-time bill cashback seed — 0.5% of face value, capped at ₦30 per bill (airtime/data)')
       ON CONFLICT (key) DO NOTHING`,
    );
    console.log("[bill-pricing] cashback seed applied — 0.5% capped at ₦30 (airtime/data)");
  } catch (e: any) {
    console.error("[bill-pricing] cashback seed skipped:", e?.message);
  }
}

export async function ensureBillPricingSchema(): Promise<void> {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS bill_pricing_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category VARCHAR(24) NOT NULL UNIQUE,
      discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
      cashback_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
      cashback_cap DECIMAL(15,2) NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT true,
      updated_by VARCHAR(255),
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`ALTER TABLE bill_pricing_rules ADD COLUMN IF NOT EXISTS cashback_cap DECIMAL(15,2) NOT NULL DEFAULT 0`);
  schemaReady = true;
  // One-time default cashback seed (0.5% capped at ₦30) — no-op after the
  // first successful run thanks to the system_settings marker.
  await seedDefaultCashbackRules();
}

export async function getAllBillPricingRules(): Promise<BillPricingRule[]> {
  await ensureBillPricingSchema();
  const res = await query(
    `SELECT category, discount_percent, cashback_percent, cashback_cap, enabled
       FROM bill_pricing_rules ORDER BY category ASC`,
  );
  return res.rows.map((r: any) => ({
    category: String(r.category),
    discount_percent: Number(r.discount_percent) || 0,
    cashback_percent: Number(r.cashback_percent) || 0,
    cashback_cap: Number(r.cashback_cap) || 0,
    enabled: r.enabled !== false,
  }));
}

/** Category → rule map for the pay flow (missing category = no promo). */
export async function getBillPricingMap(): Promise<Record<string, BillPricingRule>> {
  const rules = await getAllBillPricingRules();
  const map: Record<string, BillPricingRule> = {};
  for (const r of rules) map[r.category] = r;
  return map;
}

export async function getBillPricingRule(category: string): Promise<BillPricingRule | null> {
  await ensureBillPricingSchema();
  const res = await query(
    `SELECT category, discount_percent, cashback_percent, cashback_cap, enabled
       FROM bill_pricing_rules WHERE category = $1 LIMIT 1`,
    [String(category).toLowerCase()],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    category: String(r.category),
    discount_percent: Number(r.discount_percent) || 0,
    cashback_percent: Number(r.cashback_percent) || 0,
    cashback_cap: Number(r.cashback_cap) || 0,
    enabled: r.enabled !== false,
  };
}

const clampPct = (v: unknown, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(round2(n), 0), max);
};

export async function upsertBillPricingRule(
  category: string,
  payload: { discount_percent?: unknown; cashback_percent?: unknown; cashback_cap?: unknown; enabled?: unknown },
  updatedBy?: string | null,
): Promise<BillPricingRule> {
  await ensureBillPricingSchema();
  const cat = String(category).toLowerCase();
  if (!BILL_CATEGORIES.includes(cat as BillPricingCategory)) {
    throw new Error(`category must be one of: ${BILL_CATEGORIES.join(", ")}`);
  }
  // Promotions are generous but bounded: discount up to 90%, cashback up to 50%.
  const discount = clampPct(payload.discount_percent ?? 0, 90);
  const cashback = clampPct(payload.cashback_percent ?? 0, 50);
  // Cap: 0 = no cap. Any positive value bounds the per-transaction cashback.
  const capRaw = Number(payload.cashback_cap ?? 0);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? round2(capRaw) : 0;
  const enabled = payload.enabled !== false;
  await query(
    `INSERT INTO bill_pricing_rules (category, discount_percent, cashback_percent, cashback_cap, enabled, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (category) DO UPDATE SET
       discount_percent = EXCLUDED.discount_percent,
       cashback_percent = EXCLUDED.cashback_percent,
       cashback_cap = EXCLUDED.cashback_cap,
       enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = CURRENT_TIMESTAMP`,
    [cat, discount, cashback, cap, enabled, updatedBy || null],
  );
  return { category: cat, discount_percent: discount, cashback_percent: cashback, cashback_cap: cap, enabled };
}

/** What the customer is actually charged for a face-value bill. */
export function applyBillPricing(
  amount: number,
  fee: number,
  rule: BillPricingRule | null,
): { discount: number; chargeable: number; total: number; cashback: number } {
  const face = round2(amount);
  const active = rule && rule.enabled ? rule : null;
  const discount = active ? round2(face * (active.discount_percent / 100)) : 0;
  const chargeable = round2(face - discount);
  const total = round2(chargeable + round2(fee));
  // Percentage cashback bounded by the admin cap (0 = uncapped).
  let cashback = active ? round2(face * (active.cashback_percent / 100)) : 0;
  if (active && active.cashback_cap > 0) cashback = Math.min(cashback, round2(active.cashback_cap));
  return { discount, chargeable, total, cashback };
}
