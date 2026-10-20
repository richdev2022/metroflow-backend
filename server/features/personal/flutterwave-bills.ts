import axios from "axios";

/**
 * FLUTTERWAVE BILL PAYMENTS — live provider for the Bills Hub.
 *
 * Implements the Flutterwave bill-payment suite (developer.flutterwave.com/docs/bill-payment):
 *   GET  /bill-categories                     every category the account can pay (Nigeria today)
 *   GET  /billers?category=<code>             billers under a category (e.g. DSTV/GOTV under CABLEBILLS)
 *   GET  /billers/{id}/products               products/packages a biller sells
 *   POST /billers/{biller_code}/validate      customer identifier validation
 *   POST /bill-payments                       fulfil a bill (amount in MAJOR units)
 *
 * NOTHING is hardcoded: the site and apps render whatever /bill-categories
 * returns (refreshed on a TTL cache with an admin force-refresh knob). When
 * FLW_SECRET_KEY is missing the module reports "unconfigured" and callers
 * fall back to the built-in simulator — staging keeps working.
 */

const FLW_BASE_URL = process.env.FLW_BASE_URL || "https://api.flutterwave.com";
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || process.env.FLUTTERWAVE_SECRET_KEY;

const flwBillsClient = axios.create({
  baseURL: FLW_BASE_URL,
  headers: {
    Authorization: `Bearer ${FLW_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 45_000,
});

export function isFlutterwaveBillsConfigured(): boolean {
  return !!FLW_SECRET_KEY;
}

// ---------------------------------------------------------------------------
// Caches (TTL) — categories change rarely; billers per category likewise.
// ---------------------------------------------------------------------------
interface TtlCache<T> { data: T; loadedAt: number; }
const CATEGORY_TTL_MS = 24 * 60 * 60 * 1000;   // 24h
const BILLER_TTL_MS = 6 * 60 * 60 * 1000;      // 6h
let categoriesCache: TtlCache<any[]> | null = null;
const billersCaches = new Map<string, TtlCache<any[]>>();

export const invalidateBillsCaches = (): void => {
  categoriesCache = null;
  billersCaches.clear();
};

/** Display-friendly names for known category codes (fallback metadata only —
 * the live list always wins). */
const CATEGORY_LABELS: Record<string, string> = {
  AIRTIME: "Airtime",
  MOBILEDATA: "Mobile Data Service",
  CABLEBILLS: "Cable Bill Payment",
  INTSERVICE: "Internet Service",
  UTILITYBILLS: "Utility Bills",
  TAX: "Tax Payment",
  DONATIONS: "Donations",
  TRANSLOG: "Transport and Logistics",
  DEALPAY: "Dealer Payments",
  RELINST: "Religious Institutions",
  SCHPB: "Schools & Professional Bodies",
};

export function categoryLabel(code: string): string {
  return CATEGORY_LABELS[String(code || "").toUpperCase()] || String(code);
}

async function flwGet<T = any>(url: string, params?: Record<string, any>): Promise<T> {
  const res = await flwBillsClient.get(url, { params });
  const body = res?.data;
  if (!body || body.status === "error") {
    throw new Error(body?.message || `Flutterwave responded with ${res.status}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All bill categories from Flutterwave (live, TTL-cached). */
export async function getBillCategories(force = false): Promise<any[]> {
  if (!isFlutterwaveBillsConfigured()) return [];
  if (!force && categoriesCache && Date.now() - categoriesCache.loadedAt < CATEGORY_TTL_MS) {
    return categoriesCache.data;
  }
  const body = await flwGet<any>("/bill-categories");
  const data: any[] = Array.isArray(body?.data) ? body.data : [];
  // Normalize: { code, label, ... } — some responses use name/biller_name.
  const normalized = data.map((c: any) => ({
    code: String(c.code || c.id || "").toUpperCase(),
    label: c.label || c.name || categoryLabel(String(c.code || c.id || "")),
    country: c.country || "NG",
    is_airtime: !!c.is_airtime,
    is_data: !!c.is_data,
    is_cable: !!c.is_cable,
    default_commission: c.default_commission ?? null,
    raw: c,
  })).filter((c) => c.code);
  categoriesCache = { data: normalized, loadedAt: Date.now() };
  return normalized;
}

/** Billers under a category code (live, TTL-cached per category). */
export async function getBillers(category: string, force = false): Promise<any[]> {
  if (!isFlutterwaveBillsConfigured()) return [];
  const key = String(category || "").toUpperCase();
  if (!key) return [];
  const cached = billersCaches.get(key);
  if (!force && cached && Date.now() - cached.loadedAt < BILLER_TTL_MS) return cached.data;
  const body = await flwGet<any>("/billers", { category: key });
  const data: any[] = Array.isArray(body?.data) ? body.data : [];
  const normalized = data.map((b: any) => ({
    id: b.id,
    biller_code: String(b.biller_code ?? b.code ?? ""),
    name: b.name || b.biller_name || b.biller_code,
    label: b.label || b.name || b.biller_name,
    category: b.category || key,
    country: b.country || "NG",
    item_fee: b.item_fee ?? 0,
    amount: b.amount ?? null,
    is_amount_fixed: !!b.is_amount_fixed,
    biller_name: b.biller_name || null,
    billsinger_name: b.billsinger_name || b.biller_name || null,
    supports_validate: b.supports_validate !== false,
    default_commission: b.default_commission ?? null,
    label_name: b.label_name || "Customer ID",
    raw: b,
  }));
  billersCaches.set(key, { data: normalized, loadedAt: Date.now() });
  return normalized;
}

/** Products (packages) a biller sells — e.g. DSTV padi / compact packages. */
export async function getBillerProducts(billerId: string | number): Promise<any[]> {
  if (!isFlutterwaveBillsConfigured()) return [];
  const body = await flwGet<any>(`/billers/${encodeURIComponent(String(billerId))}/products`);
  const data: any[] = Array.isArray(body?.data) ? body.data : [];
  return data.map((p: any) => ({
    id: p.id,
    product_id: p.product_id ?? p.id,
    product_name: p.product_name || p.name,
    is_amount_fixed: !!p.is_amount_fixed,
    amount: p.amount ?? null,
    product_code: p.product_code ?? null,
    raw: p,
  }));
}

/** Validate a customer identifier for a biller (returns name when found). */
export async function validateCustomer(billerCode: string, customer: string, code?: string | null): Promise<any> {
  if (!isFlutterwaveBillsConfigured()) {
    return { validated: false, simulated: true, message: "Bills provider not configured — validation skipped" };
  }
  const body = await flwBillsClient.post(
    `/billers/${encodeURIComponent(String(biller_code_str(billerCode)))}/validate`,
    { customer, ...(code ? { code } : {}), country: "NG" },
  );
  const payload = body?.data;
  // A validation miss still returns 200 with { status: 'error' } in some
  // shapes; surface both honestly.
  if (payload?.status === "error") {
    return { validated: false, message: payload?.message || "Validation failed", data: payload?.data || null };
  }
  return { validated: true, name: payload?.data?.name || payload?.data?.customer_name || null, data: payload?.data || null };
}

function biller_code_str(v: string): string { return String(v || "").trim(); }

/** Pay a bill via Flutterwave. Amount is in MAJOR units (e.g. 500.00). */
export async function payBill(input: {
  reference: string;               // our unique reference (FLW echoes it)
  category: string;                // e.g. CABLEBILLS / AIRTIME (the bill "type")
  billerCode?: string | null;
  customer: string;                // phone | smartcard | meter | customer id
  amount: number;
  country?: string;                // default NG
  narration?: string | null;
  meta?: Record<string, any> | null;
}): Promise<{ ok: boolean; providerReference?: string | null; message?: string; raw?: any }> {
  if (!isFlutterwaveBillsConfigured()) {
    return { ok: false, message: "Flutterwave bills not configured" };
  }
  try {
    const payload: Record<string, any> = {
      country: input.country || "NG",
      customer: input.customer,
      amount: input.amount,                    // MAJOR units for /bill-payments
      type: String(input.category || "").toUpperCase(),
      reference: input.reference,
    };
    if (input.billerCode) payload.biller_code = input.billerCode;
    if (input.narration) payload.narration = input.narration;
    if (input.meta) payload.meta = input.meta;

    const res = await flwBillsClient.post("/bill-payments", payload);
    const body = res?.data;
    const statusOk = body?.status === "success";
    return {
      ok: statusOk,
      providerReference: body?.data?.id ? String(body.data.id) : (body?.data?.flw_ref || null),
      message: statusOk ? (body?.message || "Bill payment successful") : (body?.message || "Bill payment failed"),
      raw: body,
    };
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || "Flutterwave bill payment request failed";
    return { ok: false, message: msg, raw: e?.response?.data || null };
  }
}
