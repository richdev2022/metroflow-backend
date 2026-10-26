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
  enabled: boolean;
}

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

let schemaReady = false;

export async function ensureBillPricingSchema(): Promise<void> {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS bill_pricing_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category VARCHAR(24) NOT NULL UNIQUE,
      discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
      cashback_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT true,
      updated_by VARCHAR(255),
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  schemaReady = true;
}

export async function getAllBillPricingRules(): Promise<BillPricingRule[]> {
  await ensureBillPricingSchema();
  const res = await query(
    `SELECT category, discount_percent, cashback_percent, enabled
       FROM bill_pricing_rules ORDER BY category ASC`,
  );
  return res.rows.map((r: any) => ({
    category: String(r.category),
    discount_percent: Number(r.discount_percent) || 0,
    cashback_percent: Number(r.cashback_percent) || 0,
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
    `SELECT category, discount_percent, cashback_percent, enabled
       FROM bill_pricing_rules WHERE category = $1 LIMIT 1`,
    [String(category).toLowerCase()],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    category: String(r.category),
    discount_percent: Number(r.discount_percent) || 0,
    cashback_percent: Number(r.cashback_percent) || 0,
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
  payload: { discount_percent?: unknown; cashback_percent?: unknown; enabled?: unknown },
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
  const enabled = payload.enabled !== false;
  if (enabled && discount === 0 && cashback === 0) {
    // Allowed (a no-op rule) but pointless — surface it to the caller; admin
    // UI prefers disabling the row instead.
  }
  await query(
    `INSERT INTO bill_pricing_rules (category, discount_percent, cashback_percent, enabled, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (category) DO UPDATE SET
       discount_percent = EXCLUDED.discount_percent,
       cashback_percent = EXCLUDED.cashback_percent,
       enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = CURRENT_TIMESTAMP`,
    [cat, discount, cashback, enabled, updatedBy || null],
  );
  return { category: cat, discount_percent: discount, cashback_percent: cashback, enabled };
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
  const cashback = active ? round2(face * (active.cashback_percent / 100)) : 0;
  return { discount, chargeable, total, cashback };
}
