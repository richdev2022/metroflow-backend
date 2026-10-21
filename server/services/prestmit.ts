import crypto from "crypto";
import axios, { AxiosInstance } from "axios";

/**
 * Prestmit service — REAL gift card buy + sell integration.
 *
 * Sandbox base : https://dev-api.prestmit.io/partners/v1
 * Live base    : https://api.prestmit.io/partners/v1
 * Auth         : API-KEY header (+ Bearer twin for endpoint variants)
 *
 * Verified live against the sandbox during build:
 *   GET  /general/service-availability     → services on/off
 *   GET  /general/user                     → naira/cedis wallet balance
 *   GET  /general/commissions-and-fees     → trade commission percentages
 *   GET  /giftcard-trade/sell/rate-calculator-data → full sell catalog + rates
 *   GET  /giftcard-trade/sell/payout-methods       → NAIRA/CEDIS + FX rate
 *   POST /giftcard-trade/sell/create        (multipart) → REAL sell trade
 *   GET  /giftcard-trade/sell/history
 *   GET  /giftcard-trade/buy/config        → buy catalog (SKU, min/max, currency)
 *   POST /giftcard-trade/buy/calculate-payment      → NGN/USD/CEDIS totals
 *   POST /giftcard-trade/buy/create         (needs partner account PIN)
 *   GET  /giftcard-trade/buy/history
 *   GET  /giftcard-trade/buy/fetch-codes?reference=
 *
 * Webhook: x-prestmit-signature = base64(HMAC_SHA256(webhook_signing_key, raw body))
 */

const BASE = process.env.PRESTMIT_BASE_URL?.includes("dev-api")
  ? process.env.PRESTMIT_BASE_URL
  : process.env.PRESTMIT_ENV === "live"
    ? "https://api.prestmit.io/partners/v1"
    : "https://dev-api.prestmit.io/partners/v1";

function client(): AxiosInstance {
  const key = process.env.PRESTMIT_API_KEY || "";
  if (!key) throw new Error("Prestmit is not configured (PRESTMIT_API_KEY missing)");
  return axios.create({
    baseURL: BASE,
    timeout: 45000,
    headers: {
      "API-KEY": key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Metricorex/1.0",
    },
  });
}

export function isPrestmitConfigured(): boolean {
  return !!process.env.PRESTMIT_API_KEY;
}

export function prestmitErr(e: any): string {
  const d = e?.response?.data;
  if (d?.errors && typeof d.errors === "object") {
    const first = Object.values(d.errors)[0];
    if (Array.isArray(first) && first.length) return String(first[0]);
  }
  return d?.message || d?.details || d?.error || e?.message || "Prestmit request failed";
}

async function unwrap<T = any>(p: Promise<{ data: any }>): Promise<T> {
  const { data } = await p;
  if (data && data.success === false) throw new Error(data.details || data.message || "Prestmit request failed");
  return data as T;
}

// ---------------------------------------------------------------------------
// Account / wallet
// ---------------------------------------------------------------------------
export async function userInfo(): Promise<any> {
  return unwrap(client().get("/general/user"));
}

export async function serviceAvailability(): Promise<any> {
  return unwrap(client().get("/general/service-availability"));
}

export async function commissionsAndFees(): Promise<any> {
  return unwrap(client().get("/general/commissions-and-fees"));
}

// ---------------------------------------------------------------------------
// SELL
// ---------------------------------------------------------------------------
export async function sellRateCalculatorData(): Promise<any> {
  return unwrap(client().get("/giftcard-trade/sell/rate-calculator-data", { timeout: 60000 }));
}

export async function sellPayoutMethods(): Promise<any> {
  return unwrap(client().get("/giftcard-trade/sell/payout-methods"));
}

export interface SellTradeArgs {
  giftcardId: number;
  amount: number;
  payoutMethod: string;
  comments?: string;
  uniqueIdentifier: string;
  /** Prepared attachments: filename + buffer + mime (JPG/PNG only, <5MB each). */
  attachments?: Array<{ filename: string; buffer: Buffer; mime: string }>;
}

export async function createSellTrade(args: SellTradeArgs): Promise<any> {
  const fd = new FormData();
  fd.append("giftcard_id", String(args.giftcardId));
  fd.append("amount", String(args.amount));
  fd.append("payoutMethod", args.payoutMethod);
  if (args.comments) fd.append("comments", args.comments);
  fd.append("uniqueIdentifier", args.uniqueIdentifier);
  for (const a of args.attachments || []) {
    fd.append("attachments[]", new Blob([new Uint8Array(a.buffer)], { type: a.mime }), a.filename);
  }
  const key = process.env.PRESTMIT_API_KEY || "";
  const { data } = await axios.post(`${BASE}/giftcard-trade/sell/create`, fd, {
    timeout: 120000,
    headers: { "API-KEY": key, Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "Metricorex/1.0" },
  });
  if (data?.success === false) throw new Error(data.details || data.message || "Sell trade rejected");
  return data;
}

export async function sellHistory(page = 1, uniqueIdentifier?: string): Promise<any> {
  return unwrap(client().get("/giftcard-trade/sell/history", { params: { page, uniqueIdentifier } }));
}

// ---------------------------------------------------------------------------
// BUY
// ---------------------------------------------------------------------------
export async function buyConfig(): Promise<any> {
  return unwrap(client().get("/giftcard-trade/buy/config", { timeout: 60000 }));
}

export async function buyCalculate(giftCardSKU: number, price: number, quantity: number): Promise<any> {
  return unwrap(client().post("/giftcard-trade/buy/calculate-payment", { giftCardSKU, price, quantity }));
}

export interface BuyTradeArgs {
  giftCardSKU: number;
  price: number;
  quantity: number;
  paymentMethod: string;
  accountPin: string;      // partner account 4-digit PIN (PRESTMIT_ACCOUNT_PIN)
  uniqueIdentifier: string;
}

export async function createBuyTrade(args: BuyTradeArgs): Promise<any> {
  return unwrap(client().post("/giftcard-trade/buy/create", {
    giftCardSKU: args.giftCardSKU,
    price: args.price,
    quantity: args.quantity,
    paymentMethod: args.paymentMethod,
    currentAccountPIN: args.accountPin,
    uniqueIdentifier: args.uniqueIdentifier,
  }, { timeout: 120000 }));
}

export async function buyHistory(page = 1): Promise<any> {
  return unwrap(client().get("/giftcard-trade/buy/history", { params: { page } }));
}

export async function fetchCardCodes(reference: string): Promise<any> {
  return unwrap(client().get("/giftcard-trade/buy/fetch-codes", { params: { reference } }));
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
