import axios from "axios";

/**
 * FLUTTERWAVE BILL PAYMENTS — live provider for the Bills Hub.
 *
 * IMPORTANT (verified live against the production account, Oct 2026): the
 * account is enabled for the CLASSIC V3 bills API only:
 *   GET  /v3/bill-categories   flat list of every payable bill item
 *                              (biller_code, item_code, short_name, label_name,
 *                               is_airtime, fee, default_commission, country)
 *   POST /v3/bills             fulfil a bill — { country, customer, amount,
 *                              type: <item_code>, reference }
 *   GET  /v3/bills?reference=  status of a bill payment
 *
 * The NEWER endpoints (/v3/billers?category=, /v3/billers/{id}/products,
 * /v3/billers/{biller_code}/validate, /v3/bill-payments) are NOT enabled for
 * this account — they answer "Service error" / "Cannot POST" / "contact your
 * account administrator". This module therefore derives the category /
 * biller / product tree from the flat /bill-categories list (nothing is
 * hardcoded — the tree refreshes from Flutterwave on a TTL cache).
 *
 * When FLW_SECRET_KEY is missing the module reports "unconfigured" and
 * callers fall back to the built-in simulator.
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
// Caches (TTL) — the flat item list changes rarely.
// ---------------------------------------------------------------------------
interface TtlCache<T> { data: T; loadedAt: number; }
const ITEMS_TTL_MS = 24 * 60 * 60 * 1000;   // 24h
let itemsCache: TtlCache<any[]> | null = null;

export const invalidateBillsCaches = (): void => {
  itemsCache = null;
};

/** Display-friendly names for our derived category codes. */
const CATEGORY_LABELS: Record<string, string> = {
  AIRTIME: "Airtime",
  DATA: "Data Bundles",
  CABLEBILLS: "Cable TV",
  UTILITY: "Electricity",
  BETTING: "Betting",
  MORE: "More Payments",
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
// Derived catalog tree (from the flat /bill-categories list)
// ---------------------------------------------------------------------------

const DISCO_WORDS = ["DISCO", "EKEDC", "IKEDC", "AEDC", "PHED", "JED", "KEDCO", "EEDC", "BEDC", "IBEDC", "KADUNA", "JOS", "ELECTRIC", "ELECTRICTY", "POWER"];
const CABLE_WORDS = ["DSTV", "GOTV", "STARTIMES", "SHOWMAX", "CABLE", "STATIMES"];
const BETTING_WORDS = ["BET9JA", "BETWAY", "1XBET", "SPORTYBET", "MSPORT", "NAIRABET", "BETKING", "ODDSBET", "BETPAWA", "CLoudbet", "MERRYBET", "NAIJABET", "YANGA", "STAKE", "BET", "PUNTI"];

function classifyItem(item: any): string {
  const name = String(item?.biller_name || item?.short_name || "").toUpperCase();
  const country = String(item?.country || "NG").toUpperCase();

  if (country !== "NG") return "MORE"; // international items stay reachable via "More"
  if (item?.is_airtime === true) return "AIRTIME";
  if (/\b\d+(\.\d+)?\s*(GB|MB)\b/.test(name) || name.includes("DATA BUNDLE") || name.includes(" DATA") || /DATA\b/.test(name) && /(MTN|AIRTEL|GLO|9MOBILE|SMILE|SPECTRANET|NCELL)/.test(name)) return "DATA";
  if (CABLE_WORDS.some((w) => name.includes(w))) return "CABLEBILLS";
  if (DISCO_WORDS.some((w) => name.includes(w))) return "UTILITY";
  if (BETTING_WORDS.some((w) => name.includes(w))) return "BETTING";
  if (name.includes("VTU") || /^(MTN|AIRTEL|GLO|9MOBILE|AIRTIME)$/.test(name)) return "AIRTIME";
  return "MORE";
}

/** Every payable bill item, TTL-cached. Paginates if Flutterwave sends meta. */
export async function getBillItems(force = false): Promise<any[]> {
  if (!isFlutterwaveBillsConfigured()) return [];
  if (!force && itemsCache && Date.now() - itemsCache.loadedAt < ITEMS_TTL_MS) {
    return itemsCache.data;
  }
  const all: any[] = [];
  let page = 1;
  for (; page <= 25; page++) {
    const body = await flwGet<any>("/bill-categories", { page });
    const data: any[] = Array.isArray(body?.data) ? body.data : [];
    all.push(...data);
    const totalPages = Number(body?.meta?.page_info?.total_pages ?? body?.meta?.pagination?.total_pages ?? 1);
    if (data.length === 0 || page >= totalPages) break;
  }
  // Normalize once: keep what the tree derivation + payments need.
  const normalized = all
    .filter((i) => i?.item_code && i?.biller_code)
    .map((i) => ({
      item_code: String(i.item_code),
      biller_code: String(i.biller_code),
      name: String(i.short_name || i.name || i.biller_name || i.item_code),
      biller_name: String(i.biller_name || i.short_name || i.name || i.biller_code),
      label_name: String(i.label_name || "Customer ID"), // "Mobile Number" | "Smart card Number" | "Meter Number" | ...
      amount: Number(i.amount) || 0,
      fee: Number(i.fee) || 0,
      is_amount_fixed: Number(i.amount) > 0,
      country: String(i.country || "NG").toUpperCase(),
      category: classifyItem(i),
    }));
  itemsCache = { data: normalized, loadedAt: Date.now() };
  return normalized;
}

/** All bill categories (derived groups), newest-first feel not needed. */
export async function getBillCategories(force = false): Promise<any[]> {
  const items = await getBillItems(force);
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.category, (counts.get(it.category) || 0) + 1);
  const order = ["AIRTIME", "DATA", "CABLEBILLS", "UTILITY", "BETTING", "MORE"];
  return order
    .filter((code) => counts.has(code))
    .map((code) => ({
      code,
      label: categoryLabel(code),
      biller_count: counts.get(code) || 0,
    }));
}

/** Billers (distinct biller_code) under a derived category. */
export async function getBillers(category: string, force = false): Promise<any[]> {
  const key = String(category || "").toUpperCase();
  const items = await getBillItems(force);
  const seen = new Map<string, any>();
  for (const it of items) {
    if (it.category !== key) continue;
    if (!seen.has(it.biller_code)) {
      seen.set(it.biller_code, {
        id: it.biller_code,
        biller_code: it.biller_code,
        name: it.biller_name,
        label: it.biller_name,
        category: key,
        country: it.country,
        label_name: it.label_name,
        is_amount_fixed: false, // resolved per product below
        supports_validate: false, // classic API has no live validate on this account
        default_commission: null,
      });
    }
  }
  return [...seen.values()];
}

/** Packages (bill items) a biller sells — data bundles, DSTV plans, meters. */
export async function getBillerProducts(billerCode: string | number, force = false): Promise<any[]> {
  const items = await getBillItems(force);
  const code = String(billerCode || "");
  return items
    .filter((it) => it.biller_code === code)
    .map((it) => ({
      id: it.item_code,
      product_id: it.item_code,
      product_code: it.item_code,
      item_code: it.item_code,
      product_name: it.name,
      name: it.name,
      label_name: it.label_name,
      amount: it.amount || null,
      is_amount_fixed: it.is_amount_fixed,
      fee: it.fee,
      category: it.category,
    }));
}

/** Find one bill item by item_code (used to resolve the payment `type`). */
export async function findBillItem(itemCode: string, force = false): Promise<any | null> {
  const items = await getBillItems(force);
  const code = String(itemCode || "").toUpperCase();
  return items.find((it) => it.item_code.toUpperCase() === code) || null;
}

/**
 * Validate a customer identifier for a biller. The classic API on this
 * account has NO validate endpoint — report it honestly as skipped instead
 * of pretending. The bill payment itself will still fail (and auto-refund)
 * for an invalid identifier.
 */
export async function validateCustomer(billerCode: string, customer: string, code?: string | null): Promise<any> {
  return {
    validated: false,
    skipped: true,
    message: "Flutterwave validation is unavailable for this biller — the payment itself will confirm the identifier.",
    data: { biller_code: billerCode, customer, code: code || null },
  };
}

/** Pay a bill via the CLASSIC POST /v3/bills. Amount is in MAJOR units. */
export async function payBill(input: {
  reference: string;               // our unique reference (FLW echoes it)
  category: string;                // derived group (AIRTIME / DATA / ...) — used for narration only
  billerCode?: string | null;      // FLW biller_code (e.g. BIL099)
  itemCode?: string | null;        // FLW item_code (e.g. AT099 / MD374) — the payment `type`
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
    // Resolve the payable item: explicit itemCode, else the biller's first
    // (and usually only) item — e.g. shared airtime item AT099 on BIL099.
    let item = input.itemCode ? await findBillItem(input.itemCode) : null;
    if (!item && input.billerCode) {
      const products = await getBillerProducts(input.billerCode);
      // Prefer an exact-amount match when the request amount is fixed-amount
      // shaped (data bundles), else the first item.
      item = products.find((p: any) => p.is_amount_fixed && Number(p.amount) === Number(input.amount)) || products[0] || null;
    }
    if (!item) {
      return { ok: false, message: "This bill item is not available on Flutterwave right now" };
    }

    const payload: Record<string, any> = {
      country: input.country || item.country || "NG",
      customer: input.customer,
      amount: input.amount,                    // MAJOR units for /v3/bills
      type: item.item_code,                    // CLASSIC API: type = item_code
      reference: input.reference,
    };
    if (input.narration) payload.narration = input.narration;
    if (input.meta) payload.meta = input.meta;

    // Fixed-amount items (data bundles, DSTV packages) must be paid exactly.
    if (item.is_amount_fixed && Number(item.amount) > 0 && Number(input.amount) !== Number(item.amount)) {
      return {
        ok: false,
        message: `${item.name} costs ₦${Number(item.amount).toLocaleString()} exactly — adjust the amount and try again.`,
      };
    }

    const res = await flwBillsClient.post("/bills", payload);
    const body = res?.data;
    const statusOk = body?.status === "success";
    return {
      ok: statusOk,
      providerReference: body?.data?.id ? String(body.data.id) : (body?.data?.flw_ref || body?.data?.reference || null),
      message: statusOk ? (body?.message || "Bill payment successful") : (body?.message || "Bill payment failed"),
      raw: body,
    };
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || "Flutterwave bill payment request failed";
    return { ok: false, message: msg, raw: e?.response?.data || null };
  }
}

/** Post-payment status check (GET /v3/bills?reference=). Best effort. */
export async function getBillStatus(reference: string): Promise<{ status?: string; raw?: any }> {
  if (!isFlutterwaveBillsConfigured()) return {};
  try {
    const body = await flwGet<any>("/bills", { reference });
    return { status: body?.data?.status || undefined, raw: body };
  } catch {
    return {};
  }
}
