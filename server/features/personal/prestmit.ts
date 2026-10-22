import crypto from "crypto";
import axios from "axios";
import FormData from "form-data";

/**
 * PRESTMIT PARTNER API — gift card trading provider (buy + sell).
 *
 * Auth: every request carries
 *   API-Key:  <PRESTMIT_API_KEY>
 *   API-Hash: HMAC-SHA256("<API_KEY>:<JSON.stringify(body|query)>", <API_SECRET>)
 * POST bodies must EXCLUDE the attachments field from the hash payload
 * (attachments ride as multipart parts, not JSON).
 *
 * Base URLs: live https://api.prestmit.io/partners/v1
 *            sandbox https://dev-api.prestmit.io/partners/v1
 *
 * Endpoints used:
 *   GET  /general/service-availability
 *   GET  /lookup/sell-giftcard-categories
 *   GET  /lookup/sell-giftcard-subcategories
 *   GET  /giftcard-trade/sell/rate-calculator-data
 *   POST /giftcard-trade/sell/create            (multipart w/ attachments[])
 *   GET  /giftcard-trade/sell/history
 *   GET  /giftcard-trade/buy/config
 *   POST /giftcard-trade/buy/calculate-payment
 *   POST /giftcard-trade/buy/create
 *   GET  /giftcard-trade/buy/history
 *   GET  /giftcard-trade/buy/fetch-codes?reference=
 */

const BASE_URL =
  process.env.PRESTMIT_BASE_URL ||
  (String(process.env.PRESTMIT_SANDBOX || "").toLowerCase() === "true"
    ? "https://dev-api.prestmit.io/partners/v1"
    : "https://api.prestmit.io/partners/v1");

const API_KEY = process.env.PRESTMIT_API_KEY || "";
const API_SECRET = process.env.PRESTMIT_API_SECRET || "";

export function isPrestmitConfigured(): boolean {
  return !!(API_KEY && API_SECRET);
}

function apiHash(payload: string): string {
  return crypto.createHmac("sha256", API_SECRET).update(payload, "utf8").digest("hex");
}

function baseHeaders(): Record<string, string> {
  return {
    "API-Key": API_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** GET helper — query params object (may be {}) participates in the hash. */
export async function prestmitGet<T = any>(path: string, params: Record<string, any> = {}): Promise<T> {
  if (!isPrestmitConfigured()) throw new Error("Prestmit is not configured (PRESTMIT_API_KEY / PRESTMIT_API_SECRET)");
  const qs = JSON.stringify(params);
  const res = await axios.get(`${BASE_URL}${path}`, {
    params,
    headers: { ...baseHeaders(), "API-Hash": apiHash(`${API_KEY}:${qs}`) },
    timeout: 45_000,
  });
  return res?.data;
}

/** JSON POST helper. */
export async function prestmitPost<T = any>(path: string, body: Record<string, any>): Promise<T> {
  if (!isPrestmitConfigured()) throw new Error("Prestmit is not configured");
  const hashBody = JSON.stringify(body);
  const res = await axios.post(`${BASE_URL}${path}`, hashBody, {
    headers: { ...baseHeaders(), "API-Hash": apiHash(`${API_KEY}:${hashBody}`) },
    timeout: 60_000,
  });
  return res?.data;
}

/**
 * Multipart POST for the sell trade (attachments[] are binary parts; the
 * hash covers the JSON body WITHOUT the attachments field).
 */
export async function prestmitPostMultipart<T = any>(
  path: string,
  body: Record<string, any>,
  attachments: Array<{ buffer: Buffer; filename: string; contentType?: string }>,
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
  const res = await axios.post(`${BASE_URL}${path}`, form, {
    headers: {
      ...baseHeaders(),
      "API-Hash": apiHash(hashPayload),
      ...form.getHeaders(),
    },
    timeout: 120_000,
    maxBodyLength: Infinity,
  });
  return res?.data;
}

// ---------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------

export async function prestmitServiceAvailability(): Promise<Record<string, boolean>> {
  const body = await prestmitGet<any>("/general/service-availability");
  return body?.data || body || {};
}

/** Categories available for SELL trades. */
export async function sellCategories(): Promise<any[]> {
  const body = await prestmitGet<any>("/lookup/sell-giftcard-categories");
  const data = body?.data || body || [];
  return Array.isArray(data) ? data : [];
}

/** Gift cards (subcategories) available for SELL — filterable by category. */
export async function sellSubcategories(params: Record<string, any> = {}): Promise<any[]> {
  const body = await prestmitGet<any>("/lookup/sell-giftcard-subcategories", params);
  const data = body?.data || body || [];
  return Array.isArray(data) ? data : [];
}

/** Rate calculator data (rates per giftcard, ranges, currencies). */
export async function sellRateCalculatorData(): Promise<any> {
  const body = await prestmitGet<any>("/giftcard-trade/sell/rate-calculator-data");
  return body?.data || body || {};
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

/** Create a SELL trade — user sends us a card; payout lands in our Prestmit
 * NAIRA wallet once Prestmit confirms the card. */
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
      reference: resp?.trade?.reference || null,
      status: resp?.trade?.status || "PENDING",
      rate: resp?.trade?.rate ?? null,
      totalAmount: resp?.trade?.totalAmount ?? null,
      raw: resp,
    };
  } catch (e: any) {
    return { ok: false, message: e?.response?.data?.details || e?.response?.data?.message || e?.message || "Sell trade failed", raw: e?.response?.data };
  }
}

/** Sell trade history — optionally filtered by our uniqueIdentifier. */
export async function sellHistory(params: Record<string, any> = {}): Promise<any[]> {
  const body = await prestmitGet<any>("/giftcard-trade/sell/history", params);
  const data = body?.data || body || [];
  return Array.isArray(data) ? data : [];
}

/** Buy catalog config (enabled? payment methods? cards with ranges). */
export async function buyConfig(): Promise<any> {
  const body = await prestmitGet<any>("/giftcard-trade/buy/config");
  return body?.data || body || {};
}

/** Exact payment amount for a buy order (SKU + unit price + quantity). */
export async function buyCalculatePayment(input: { giftCardSKU: string; price: number; quantity: number }): Promise<any> {
  const body = await prestmitPost<any>("/giftcard-trade/buy/calculate-payment", {
    giftCardSKU: input.giftCardSKU,
    price: input.price,
    quantity: input.quantity,
  });
  return body?.data || body || {};
}

export interface PrestmitBuyResult {
  ok: boolean;
  reference?: string | null;
  status?: string | null;
  message?: string;
  raw?: any;
}

/** Create a BUY trade — we pay Prestmit from the partner wallet; codes are
 * fetched once fulfilled. */
export async function createBuyTrade(input: {
  giftCardSKU: string;
  quantity: number;
  price: number;
  paymentMethod?: string;                      // default NAIRA
  uniqueIdentifier?: string | null;
}): Promise<PrestmitBuyResult> {
  try {
    const body: Record<string, any> = {
      giftCardSKU: input.giftCardSKU,
      quantity: input.quantity,
      price: input.price,
      paymentMethod: input.paymentMethod || "NAIRA",
    };
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
    return { ok: false, message: e?.response?.data?.details || e?.response?.data?.message || e?.message || "Buy trade failed", raw: e?.response?.data };
  }
}

export async function buyHistory(params: Record<string, any> = {}): Promise<any[]> {
  const body = await prestmitGet<any>("/giftcard-trade/buy/history", params);
  const data = body?.data || body || [];
  return Array.isArray(data) ? data : [];
}

/** Codes for a fulfilled buy order. */
export async function buyFetchCodes(reference: string): Promise<any> {
  const body = await prestmitGet<any>("/giftcard-trade/buy/fetch-codes", { reference });
  return body?.data || body || {};
}
