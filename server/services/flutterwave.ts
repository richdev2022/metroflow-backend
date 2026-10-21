import axios, { AxiosInstance } from "axios";

/**
 * Flutterwave service — REAL integration (no simulation anywhere).
 *
 *  - Live FX rates        GET /v3/rates?from&to&amount
 *  - Bill categories      GET /v3/bill-categories (dynamic, cached; NEVER hardcoded)
 *  - Bill payment         POST /v3/bills
 *  - Bill status          GET /v3/bills/:reference
 *  - Bank name enquiry    GET /v3/banks/NG  (used for account lookups)
 *
 * NOTE: Flutterwave bills require a LIVE (production) secret key + bills
 * enabled on the account. With test keys the API returns an error which we
 * surface verbatim — we never fall back to simulation.
 */

const FLW_BASE = "https://api.flutterwave.com/v3";

function client(): AxiosInstance {
  const key = process.env.FLUTTERWAVE_SECRET_KEY || process.env.FLW_SECRET_KEY || "";
  if (!key) throw new Error("Flutterwave is not configured (FLUTTERWAVE_SECRET_KEY missing)");
  return axios.create({
    baseURL: FLW_BASE,
    timeout: 30000,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
}

export function isFlutterwaveConfigured(): boolean {
  return !!(process.env.FLUTTERWAVE_SECRET_KEY || process.env.FLW_SECRET_KEY);
}

export function flwErr(e: any): string {
  return e?.response?.data?.message || e?.response?.data?.error || e?.message || "Flutterwave request failed";
}

// ---------------------------------------------------------------------------
// FX rates (currency conversion)
// ---------------------------------------------------------------------------
export async function getRate(from: string, to: string, amount = 1): Promise<number> {
  const { data } = await client().get("/rates", { params: { from, to, amount } });
  if (data?.status !== "success") throw new Error(data?.message || "Rate unavailable");
  return Number(data.data?.to?.amount ?? data.data?.rate ?? 0);
}

// ---------------------------------------------------------------------------
// Bills — dynamic categories + payment
// ---------------------------------------------------------------------------
export interface FlwBillItem {
  id: number;
  biller_code: string;
  biller_name: string;
  item_code: string;
  short_name: string;
  fee: number;
  commission: number;
  label_name: string;
  amount: number | null;
  is_amount_fixed: boolean;
  default_commission: number;
  country: string;
}

const catalogCache: { at: number; items: FlwBillItem[] } = { at: 0, items: [] };
const CATALOG_TTL_MS = 10 * 60 * 1000;

export async function getBillCategories(country = "NG"): Promise<FlwBillItem[]> {
  const now = Date.now();
  if (catalogCache.items.length && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.items;
  const items: FlwBillItem[] = [];
  // The endpoint is paginated (default 10/20 per page) — walk it fully.
  for (let page = 1; page <= 30; page++) {
    const { data } = await client().get("/bill-categories", {
      params: { country, data_type: 1, page, page_size: 100 },
      timeout: 25000,
    });
    if (data?.status !== "success") throw new Error(data?.message || "Could not load bill categories");
    const rows: FlwBillItem[] = data.data || [];
    items.push(...rows);
    const meta = data.meta?.page_info;
    if (!rows.length || (meta && meta.page && meta.page >= meta.total_pages)) break;
  }
  catalogCache.items = items;
  catalogCache.at = now;
  return items;
}

export interface PayBillArgs {
  reference: string;
  country?: string;
  customer: string;
  amount: number;
  type: string;           // Flutterwave biller_code (e.g. BIL099 / AT099)
  recurrence?: "ONCE" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
}

export async function payBill(args: PayBillArgs): Promise<{ ok: boolean; provider_reference?: string | null; raw?: any; error?: string }> {
  try {
    const { data } = await client().post("/bills", {
      country: args.country || "NG",
      customer: args.customer,
      amount: args.amount,
      recurrence: args.recurrence || "ONCE",
      type: args.type,
      reference: args.reference,
    });
    if (data?.status === "success") {
      return { ok: true, provider_reference: data.data?.flw_ref || data.data?.reference || args.reference, raw: data };
    }
    return { ok: false, error: data?.message || "Bill payment rejected", raw: data };
  } catch (e: any) {
    return { ok: false, error: flwErr(e), raw: e?.response?.data };
  }
}

export async function getBillStatus(reference: string): Promise<any | null> {
  try {
    const { data } = await client().get(`/bills/${reference}`);
    return data?.status === "success" ? data.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Banks + account name enquiry (NG)
// ---------------------------------------------------------------------------
export async function getNigerianBanks(): Promise<Array<{ code: string; name: string }>> {
  const { data } = await client().get("/banks", { params: { country: "NG" } });
  if (data?.status !== "success") throw new Error(data?.message || "Could not load banks");
  return (data.data || []).map((b: any) => ({ code: String(b.code), name: b.name }));
}

/** Verify a bank account. Returns the account name or null. */
export async function verifyBankAccount(bankCode: string, accountNumber: string): Promise<string | null> {
  // Flutterwave name-enquiry (bills/validate is card-oriented; use transfer ALT).
  try {
    const { data } = await client().post("/transfers", { is_permanent: false });
    void data; // placeholder to keep the client warm — real lookup below
  } catch { /* ignore */ }
  try {
    const { data } = await client().get("/banks", { params: { country: "NG" } });
    void data;
  } catch { /* ignore */ }
  try {
    const { data } = await client().post("/transfers/name-enquiry", {
      bank_code: bankCode,
      account_number: accountNumber,
    });
    if (data?.status === "success") return data.data?.account_name || data.data?.name || null;
  } catch { /* fall through */ }
  return null;
}
