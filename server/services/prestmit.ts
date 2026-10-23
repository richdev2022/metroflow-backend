import crypto from "crypto";
import axios, { AxiosInstance } from "axios";
import FormData from "form-data";

/**
 * Prestmit Partners API service — REAL gift card trading + wallet management.
 *
 * Auth (HMAC, per Prestmit docs + official SDK):
 *   - Header API-KEY  = the partner API key
 *   - Header API-Hash = HMAC-SHA256(`${API_KEY}:${payload}`, API_SECRET)
 *     where payload is
 *       POST JSON : the exact JSON string sent on the wire (attachments
 *                   excluded for multipart calls)
 *       GET       : JSON.stringify(queryParams) with empty/undefined
 *                   values dropped (matches the official SDK)
 *
 * Environments
 *   sandbox : https://dev-api.prestmit.io/partners/v1
 *   live    : https://api.prestmit.io/partners/v1
 *
 * Verified endpoint surface (docs + prestmit-partners-api SDK):
 *   GET  /general/service-availability
 *   GET  /general/user                          (profile + wallet balances)
 *   GET  /general/commissions-and-fees          (commission structure)
 *   GET  /lookup/sell-giftcard-categories
 *   GET  /lookup/sell-giftcard-subcategories    (?categoryID=&form=&country=)
 *   GET  /lookup/sell-giftcard-filters          (countries)
 *   GET  /lookup/sell-giftcard-countries
 *   GET  /lookup/sell-giftcard-payout-methods
 *   GET  /lookup/buy-giftcard-currencies
 *   GET  /giftcard-trade/sell/rate-calculator-data
 *   POST /giftcard-trade/sell/create            (multipart + attachments[])
 *   GET  /giftcard-trade/sell/history           (?uniqueIdentifier=&referenceOrID=&page=&perPage=)
 *   GET  /giftcard-trade/buy/config             (+ /config/v2)
 *   GET  /giftcard-trade/buy/fetch-buyable-giftcards (?currencyCode=&page=&perPage=)
 *   POST /giftcard-trade/buy/check-availability
 *   POST /giftcard-trade/buy/calculate-payment
 *   POST /giftcard-trade/buy/create             (currentAccountPIN required)
 *   GET  /giftcard-trade/buy/history
 *   GET  /giftcard-trade/buy/fetch-codes/{reference}
 *   GET  /giftcard-trade/buy/crypto-payment-status/{reference}
 *   GET  /wallet/fiat/details?wallet=NAIRA|CEDIS
 *   GET  /wallet/fiat/withdrawal-history?page=&wallet=
 *   GET  /wallet/fiat/withdrawal-history/{id}/receipt
 *   POST /wallet/fiat/withdrawal                (create withdrawal)
 *   GET  /lookup/nigerian-banks
 *   GET  /lookup/ghanian-banks[?type=]
 *   POST /bank-accounts/naira/create
 *   GET  /bank-accounts/naira/list?page=
 *   DEL  /bank-accounts/naira/{id}
 *   POST /bank-accounts/cedis/create-v2
 *   GET  /bank-accounts/cedis/list?page=
 *   DEL  /bank-accounts/cedis/{id}
 *
 * Webhook: x-prestmit-signature = base64(HMAC_SHA256(PRESTMIT_WEBHOOK_SIGNING_KEY, raw body))
 */

const SANDBOX_BASE = "https://dev-api.prestmit.io/partners/v1";
const LIVE_BASE = "https://api.prestmit.io/partners/v1";

const API_KEY = (process.env.PRESTMIT_API_KEY || "").trim();
const API_SECRET = (process.env.PRESTMIT_API_SECRET || "").trim();

/**
 * "sandbox" | "live" | "unknown" — inferred from the API key prefix.
 * Prestmit enforces key/env pairing (a key_dev_ key is rejected by the live
 * host with 401 "Unauthenticated." and vice versa), so the prefix is the
 * most reliable signal for which base URL to use.
 */
export function prestmitKeyKind(): "sandbox" | "live" | "unknown" {
  if (API_KEY.startsWith("key_dev_")) return "sandbox";
  if (API_KEY.startsWith("key_live_")) return "live";
  return "unknown";
}

/** Host (no path, no secrets) for diagnostics surfaces. */
export function prestmitBaseUrl(): string {
  try { return new URL(resolveBaseUrl()).host; } catch { return ""; }
}

function resolveBaseUrl(): string {
  // 1. Explicit override always wins (escape hatch).
  const override = (process.env.PRESTMIT_BASE_URL || "").trim();
  if (override) return override;
  // 2. Key-prefix routing — Prestmit enforces key/env pairing, so a sandbox
  //    key MUST hit dev-api and a live key MUST hit api. This auto-fixes the
  //    "Unauthenticated." failure caused by a key/env mismatch in the env.
  const kind = prestmitKeyKind();
  if (kind === "sandbox") return SANDBOX_BASE;
  if (kind === "live") return LIVE_BASE;
  // 3. Legacy env switches (keys without a recognisable prefix).
  if (String(process.env.PRESTMIT_SANDBOX || "").trim().toLowerCase() === "true") return SANDBOX_BASE;
  if (String(process.env.PRESTMIT_ENV || "").trim().toLowerCase() === "live") return LIVE_BASE;
  return LIVE_BASE; // default: production
}

export function isPrestmitConfigured(): boolean {
  return !!(API_KEY && API_SECRET);
}

export function isPrestmitSandbox(): boolean {
  return resolveBaseUrl().includes("dev-api");
}

export function prestmitErr(e: any): string {
  const d = e?.response?.data;
  if (d?.errors && typeof d.errors === "object") {
    const first = Object.values(d.errors)[0];
    if (Array.isArray(first) && first.length) return String(first[0]);
  }
  const base = d?.message || d?.details || d?.error || e?.message || "Prestmit request failed";
  const status = e?.response?.status;
  // 401 "Unauthenticated." = Prestmit rejected the credentials. With prefix
  // auto-routing in place this now almost always means a wrong/revoked key
  // or an IP-whitelist block — give the operator something actionable.
  if (status === 401 || /unauthenticated/i.test(String(base))) {
    return `${base} — Prestmit rejected the API key. ` +
      `Check PRESTMIT_API_KEY / PRESTMIT_API_SECRET (a key_dev_ key only works against dev-api.prestmit.io, key_live_ against api.prestmit.io) ` +
      `and confirm this server's IP is whitelisted on the Prestmit console.`;
  }
  return base;
}

function client(): AxiosInstance {
  if (!isPrestmitConfigured()) {
    throw new Error("Prestmit is not configured (PRESTMIT_API_KEY / PRESTMIT_API_SECRET)");
  }
  return axios.create({
    baseURL: resolveBaseUrl(),
    timeout: 60_000,
    headers: {
      "API-KEY": API_KEY,
      Accept: "application/json",
      "User-Agent": "Metricorex/1.0",
    },
  });
}

// ---------------------------------------------------------------------------
// Signing helpers (mirror the official SDK exactly)
// ---------------------------------------------------------------------------

function apiHash(payload: string): string {
  return crypto.createHmac("sha256", API_SECRET).update(payload, "utf8").digest("hex");
}

/** Drop empty/undefined values the same way the SDK does before hashing GETs. */
function cleanParams(params: Record<string, any> = {}): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === "undefined") continue;
    out[k] = v;
  }
  return out;
}

async function unwrap<T = any>(p: Promise<{ data: any }>): Promise<T> {
  const { data } = await p;
  if (data && data.success === false) {
    throw new Error(data.details || data.message || "Prestmit request failed");
  }
  return data as T;
}

/** Signed GET — the query object participates in the hash. */
export async function prestmitGet<T = any>(path: string, params: Record<string, any> = {}): Promise<T> {
  const cleaned = cleanParams(params);
  const qs = JSON.stringify(cleaned);
  const res = await client().get(path, {
    params: cleaned,
    headers: { "API-Hash": apiHash(`${API_KEY}:${qs}`) },
  });
  return res?.data;
}

/** Signed JSON POST — the exact wire body string is hashed. */
export async function prestmitPost<T = any>(path: string, body: Record<string, any> = {}): Promise<T> {
  const bodyStr = JSON.stringify(body ?? {});
  const res = await client().post(path, bodyStr, {
    headers: { "Content-Type": "application/json", "API-Hash": apiHash(`${API_KEY}:${bodyStr}`) },
    timeout: 120_000,
    maxBodyLength: Infinity,
  });
  return res?.data;
}

/** Signed DELETE. */
export async function prestmitDelete<T = any>(path: string): Promise<T> {
  const res = await client().delete(path, {
    headers: { "API-Hash": apiHash(`${API_KEY}:{}`) },
  });
  return res?.data;
}

/**
 * Signed multipart POST (sell trade). `attachments` ride as binary parts;
 * the hash covers the JSON body WITHOUT the attachments field.
 */
export async function prestmitPostMultipart<T = any>(
  path: string,
  body: Record<string, any>,
  attachments: Array<{ buffer: Buffer; filename: string; contentType?: string }> = [],
): Promise<T> {
  if (!isPrestmitConfigured()) throw new Error("Prestmit is not configured");
  const hashPayload = `${API_KEY}:${JSON.stringify(body)}`;
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) {
    form.append(k, String(v));
  }
  for (const a of attachments) {
    form.append("attachments[]", a.buffer, {
      filename: a.filename || "card.jpg",
      contentType: a.contentType || "application/octet-stream",
    });
  }
  const res = await axios.post(`${resolveBaseUrl()}${path}`, form, {
    headers: {
      "API-KEY": API_KEY,
      Accept: "application/json",
      "API-Hash": apiHash(hashPayload),
      ...form.getHeaders(),
    },
    timeout: 120_000,
    maxBodyLength: Infinity,
  });
  return res?.data;
}

// ---------------------------------------------------------------------------
// Account / wallet
// ---------------------------------------------------------------------------
export async function userInfo(): Promise<any> {
  return unwrap(prestmitGet("/general/user"));
}

export async function serviceAvailability(): Promise<Record<string, boolean>> {
  const body = await prestmitGet<any>("/general/service-availability");
  return body?.data || body || {};
}

export async function commissionsAndFees(): Promise<any> {
  const body = await prestmitGet<any>("/general/commissions-and-fees");
  return body?.data || body || {};
}

// ---------------------------------------------------------------------------
// Wallet (fiat) — balance, withdrawals, receipts
// ---------------------------------------------------------------------------
export async function walletDetails(wallet: "NAIRA" | "CEDIS" = "NAIRA"): Promise<any> {
  const body = await prestmitGet<any>("/wallet/fiat/details", { wallet });
  return body?.data || body || {};
}

export async function withdrawalHistory(page = 1, wallet?: "NAIRA" | "CEDIS"): Promise<any> {
  const body = await prestmitGet<any>("/wallet/fiat/withdrawal-history", { page, wallet });
  return body?.data || body || {};
}

export async function withdrawalReceipt(id: number | string): Promise<any> {
  const body = await prestmitGet<any>(`/wallet/fiat/withdrawal-history/${id}/receipt`);
  return body?.data || body || {};
}

export async function createWithdrawal(payload: Record<string, any>): Promise<any> {
  return prestmitPost("/wallet/fiat/withdrawal", payload);
}

// ---------------------------------------------------------------------------
// Bank accounts + bank lookups
// ---------------------------------------------------------------------------
export async function nigerianBanks(): Promise<any[]> {
  const body = await prestmitGet<any>("/lookup/nigerian-banks");
  const d = body?.data || body || [];
  return Array.isArray(d) ? d : [];
}

export async function ghanaianBanks(type?: string): Promise<any[]> {
  const body = await prestmitGet<any>("/lookup/ghanian-banks", type ? { type } : {});
  const d = body?.data || body || [];
  return Array.isArray(d) ? d : [];
}

export async function nairaBankAccounts(page = 1): Promise<any> {
  const body = await prestmitGet<any>("/bank-accounts/naira/list", { page });
  return body?.data || body || {};
}

export async function addNairaBankAccount(data: Record<string, any>): Promise<any> {
  return prestmitPost("/bank-accounts/naira/create", data);
}

export async function removeNairaBankAccount(id: string | number): Promise<any> {
  return prestmitDelete(`/bank-accounts/naira/${id}`);
}

export async function cedisBankAccounts(page = 1): Promise<any> {
  const body = await prestmitGet<any>("/bank-accounts/cedis/list", { page });
  return body?.data || body || {};
}

export async function addCedisBankAccount(data: Record<string, any>): Promise<any> {
  return prestmitPost("/bank-accounts/cedis/create-v2", data);
}

export async function removeCedisBankAccount(id: string | number): Promise<any> {
  return prestmitDelete(`/bank-accounts/cedis/${id}`);
}

// ---------------------------------------------------------------------------
// SELL — lookups, rates, trades
// ---------------------------------------------------------------------------
export async function sellCategories(): Promise<any[]> {
  const body = await prestmitGet<any>("/lookup/sell-giftcard-categories");
  const d = body?.data || body || [];
  return Array.isArray(d) ? d : [];
}

export async function sellSubcategories(params: Record<string, any> = {}): Promise<any[]> {
  const body = await prestmitGet<any>("/lookup/sell-giftcard-subcategories", params);
  const d = body?.data || body || [];
  return Array.isArray(d) ? d : [];
}

/** Country filters for the sell catalogue (flags, currencies). */
export async function sellCountries(): Promise<any[]> {
  try {
    const body = await prestmitGet<any>("/lookup/sell-giftcard-countries");
    const d = body?.data || body || [];
    return Array.isArray(d) ? d : [];
  } catch {
    // Older accounts only expose the combined filters endpoint.
    const body = await prestmitGet<any>("/lookup/sell-giftcard-filters");
    const d = body?.countries || body?.data || body || [];
    return Array.isArray(d) ? d : [];
  }
}

/** Rate calculator data (rates per giftcard, ranges, payout FX). */
export async function sellRateCalculatorData(): Promise<any> {
  const body = await prestmitGet<any>("/giftcard-trade/sell/rate-calculator-data", {}, );
  return body?.data || body || {};
}

export async function sellPayoutMethods(): Promise<any[]> {
  const body = await prestmitGet<any>("/lookup/sell-giftcard-payout-methods");
  const d = body?.data || body || [];
  return Array.isArray(d) ? d : [];
}

export interface PrestmitSellResult {
  ok: boolean;
  reference?: string | null;
  status?: string | null;
  rate?: number | null;
  totalAmount?: number | null;
  message?: string;
  raw?: any;
}

/** Create a SELL trade — user's card goes to Prestmit review; payout lands
 * in the partner NAIRA/CEDIS wallet when approved. */
export async function createSellTrade(input: {
  giftcardId: number;
  amount: number;
  payoutMethod?: string;                       // default NAIRA
  comments?: string | null;
  uniqueIdentifier?: string | null;            // OUR reference (links trades)
  attachments: Array<{ buffer: Buffer; filename: string; contentType?: string }>;
}): Promise<PrestmitSellResult> {
  try {
    const body: Record<string, any> = {
      giftcard_id: input.giftcardId,
      amount: input.amount,
      payoutMethod: input.payoutMethod || "NAIRA",
    };
    if (input.comments) body.comments = input.comments;
    if (input.uniqueIdentifier) body.uniqueIdentifier = input.uniqueIdentifier;
    const resp = await prestmitPostMultipart<any>("/giftcard-trade/sell/create", body, input.attachments || []);
    if (resp?.success === false) {
      return { ok: false, message: resp?.details || resp?.message || "Sell trade rejected", raw: resp };
    }
    return {
      ok: true,
      reference: resp?.trade?.reference || resp?.data?.trade?.reference || resp?.reference || null,
      status: resp?.trade?.status || resp?.data?.trade?.status || "PENDING",
      rate: resp?.trade?.rate ?? resp?.data?.trade?.rate ?? null,
      totalAmount: resp?.trade?.totalAmount ?? resp?.data?.trade?.totalAmount ?? null,
      raw: resp,
    };
  } catch (e: any) {
    return { ok: false, message: prestmitErr(e), raw: e?.response?.data };
  }
}

/** Sell trade history — filterable by our uniqueIdentifier or reference. */
export async function sellHistory(params: Record<string, any> = {}): Promise<any[]> {
  const body = await prestmitGet<any>("/giftcard-trade/sell/history", params);
  const d = body?.data || body || [];
  return Array.isArray(d) ? d : [];
}

// ---------------------------------------------------------------------------
// BUY — catalogue, availability, payment, orders, codes
// ---------------------------------------------------------------------------
export async function buyConfig(): Promise<any> {
  const body = await prestmitGet<any>("/giftcard-trade/buy/config");
  return body?.data || body || {};
}

export async function buyConfigV2(): Promise<any> {
  const body = await prestmitGet<any>("/giftcard-trade/buy/config/v2");
  return body?.data || body || {};
}

/** Paginated buyable catalogue (sku, min/max price, currency, regions). */
export async function fetchBuyableGiftcards(params: { currencyCode?: string; page?: number; perPage?: number } = {}): Promise<any> {
  const body = await prestmitGet<any>("/giftcard-trade/buy/fetch-buyable-giftcards", {
    currencyCode: params.currencyCode,
    page: params.page || 1,
    perPage: Math.min(Math.max(params.perPage || 25, 1), 25),
  });
  return body || {};
}

export async function buyCurrencies(): Promise<any[]> {
  const body = await prestmitGet<any>("/lookup/buy-giftcard-currencies");
  const d = body?.data || body || [];
  return Array.isArray(d) ? d : [];
}

/** Stock check before creating an order. */
export async function buyCheckAvailability(giftCardSKU: number | string, price: number, quantity: number): Promise<boolean> {
  const body = await prestmitPost<any>("/giftcard-trade/buy/check-availability", { giftCardSKU, price, quantity });
  return body?.data?.isAvailable ?? body?.isAvailable ?? true;
}

/** Exact payment amount for a buy order (NGN/USD/CEDIS totals). */
export async function buyCalculate(giftCardSKU: number | string, price: number, quantity: number): Promise<any> {
  const body = await prestmitPost<any>("/giftcard-trade/buy/calculate-payment", { giftCardSKU, price, quantity });
  return body?.data || body || {};
}

export interface PrestmitBuyResult {
  ok: boolean;
  reference?: string | null;
  status?: string | null;
  message?: string;
  raw?: any;
}

/** Create a BUY trade — partner wallet is debited by Prestmit (needs the
 * partner account PIN via PRESTMIT_ACCOUNT_PIN). */
export async function createBuyTrade(input: {
  giftCardSKU: number | string;
  quantity: number;
  price: number;
  paymentMethod?: string;                      // default NAIRA
  accountPin?: string;                         // partner 4-digit PIN
  twoFactorCode?: string | null;               // required when 2FA is enabled
  uniqueIdentifier?: string | null;
}): Promise<PrestmitBuyResult> {
  try {
    const body: Record<string, any> = {
      giftCardSKU: input.giftCardSKU,
      quantity: input.quantity,
      price: input.price,
      paymentMethod: input.paymentMethod || "NAIRA",
    };
    if (input.accountPin) body.currentAccountPIN = input.accountPin;
    if (input.twoFactorCode) body["2fa_code"] = input.twoFactorCode;
    if (input.uniqueIdentifier) body.uniqueIdentifier = input.uniqueIdentifier;
    const resp = await prestmitPost<any>("/giftcard-trade/buy/create", body);
    if (resp?.success === false) {
      return { ok: false, message: resp?.details || resp?.message || "Buy trade rejected", raw: resp };
    }
    return {
      ok: true,
      reference: resp?.data?.reference || resp?.reference || null,
      status: resp?.data?.status || resp?.status || "PENDING",
      raw: resp,
    };
  } catch (e: any) {
    return { ok: false, message: prestmitErr(e), raw: e?.response?.data };
  }
}

export async function buyHistory(params: Record<string, any> = {}): Promise<any[]> {
  const body = await prestmitGet<any>("/giftcard-trade/buy/history", params);
  const d = body?.data || body || [];
  return Array.isArray(d) ? d : [];
}

/** Codes for a fulfilled buy order (path-style per docs/SDK, query fallback). */
export async function fetchCardCodes(reference: string): Promise<any> {
  try {
    const body = await prestmitGet<any>(`/giftcard-trade/buy/fetch-codes/${encodeURIComponent(reference)}`);
    return body?.data || body || {};
  } catch (e: any) {
    const status = e?.response?.status;
    if (status !== 404 && status !== 405) throw e;
    const body = await prestmitGet<any>("/giftcard-trade/buy/fetch-codes", { reference });
    return body?.data || body || {};
  }
}

/** Crypto payment status (BTC/USDT paid orders). */
export async function buyCryptoPaymentStatus(reference: string): Promise<any> {
  const body = await prestmitGet<any>(`/giftcard-trade/buy/crypto-payment-status/${encodeURIComponent(reference)}`);
  return body?.data || body || {};
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------
export function verifyPrestmitWebhook(rawBody: Buffer | string, signature: string | undefined): boolean {
  const secret = process.env.PRESTMIT_WEBHOOK_SIGNING_KEY || "";
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
