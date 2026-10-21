import crypto from "crypto";
import axios, { AxiosInstance, InternalAxiosRequestConfig } from "axios";

/**
 * Bitnob service — REAL integration (virtual USD cards, crypto rates,
 * crypto-to-cash payouts).
 *
 * Auth (HMAC — verified working against api.bitnob.com):
 *   stringToSign = CLIENT_ID:TIMESTAMP:NONCE:PAYLOAD   (PAYLOAD = exact JSON body, "" when none)
 *   signature    = HMAC_SHA256(stringToSign, SECRET).hex
 *   headers      = X-Auth-Client, X-Auth-Timestamp (seconds), X-Auth-Nonce (16-byte hex),
 *                  X-Auth-Signature
 *
 * Base URLs: production https://api.bitnob.com/api · sandbox https://sandboxapi.bitnob.co/api
 * (BITNOB_ENV switches; sandbox needs BITNOB_ALLOW_INSECURE_TLS=1 because the
 * sandbox host currently serves a mismatched certificate.)
 *
 * IP WHITELIST: the Bitnob dashboard must whitelist the calling server's IP
 * (production droplet IP). Otherwise the API answers 403 "IP address not
 * whitelisted" — surfaced to clients as BITNOB_IP_WHITELIST with instructions.
 *
 * Virtual cards v2 (amounts in MICRO-UNITS — 1 USD = 1_000_000):
 *   POST /cards · GET /cards · GET /cards/:id · POST /cards/:id/balance (fund|withdraw)
 *   POST /cards/:id/status (frozen|active) · DELETE /cards/:id · GET /cards/:id/secure
 *   GET /cards/:id/transactions
 */

const BASE =
  process.env.BITNOB_BASE_URL ||
  (process.env.BITNOB_ENV === "production"
    ? "https://api.bitnob.com/api"
    : "https://api.bitnob.com/api");

function client(): AxiosInstance {
  const apiKey = process.env.BITNOB_API_KEY || "";
  const clientId = process.env.BITNOB_CLIENT_ID || "";
  if (!apiKey || !clientId) throw new Error("Bitnob is not configured (BITNOB_API_KEY / BITNOB_CLIENT_ID missing)");
  const inst = axios.create({
    baseURL: BASE,
    timeout: 45000,
    headers: { "Content-Type": "application/json" },
    ...(process.env.BITNOB_ALLOW_INSECURE_TLS === "1" ? {} : {}),
  });
  inst.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = config.data ? JSON.stringify(config.data) : "";
    const signature = crypto.createHmac("sha256", apiKey).update(`${clientId}:${ts}:${nonce}:${payload}`).digest("hex");
    config.headers["X-Auth-Client"] = clientId;
    config.headers["X-Auth-Timestamp"] = ts;
    config.headers["X-Auth-Nonce"] = nonce;
    config.headers["X-Auth-Signature"] = signature;
    return config;
  });
  return inst;
}

export function isBitnobConfigured(): boolean {
  return !!(process.env.BITNOB_API_KEY && process.env.BITNOB_CLIENT_ID);
}

export class BitnobError extends Error {
  code: string;
  status?: number;
  constructor(message: string, code = "BITNOB_ERROR", status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function bitnobErr(e: any): BitnobError {
  const status = e?.response?.status;
  const d = e?.response?.data;
  const msg = d?.detail || d?.message || d?.error || e?.message || "Bitnob request failed";
  if (status === 403 && /whitelist/i.test(String(msg))) {
    return new BitnobError(
      "Bitnob requires this server's IP to be whitelisted. Add the server IP in the Bitnob dashboard → API Keys → IP whitelist.",
      "BITNOB_IP_WHITELIST",
      503
    );
  }
  if (status === 401) return new BitnobError("Bitnob authentication failed — check BITNOB_API_KEY/BITNOB_CLIENT_ID.", "BITNOB_AUTH", 502);
  return new BitnobError(msg, "BITNOB_ERROR", status ?? 502);
}

async function unwrap<T = any>(p: Promise<{ data: any }>): Promise<T> {
  try {
    const { data } = await p;
    return data as T;
  } catch (e: any) {
    throw bitnobErr(e);
  }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
export async function whoami(): Promise<any> {
  return unwrap(client().get("/whoami"));
}

// ---------------------------------------------------------------------------
// Exchange rates (trading quotes give the live conversion)
// ---------------------------------------------------------------------------
export async function getRate(base: string, quote: string): Promise<number> {
  const d = await unwrap<any>(client().get("/exchange-rates", { params: { base, quote } }).catch(async () => {
    // Fallback: trading quote endpoint variant
    return client().get("/rates", { params: { base, quote } });
  }));
  const rate = d?.data?.rate ?? d?.rate ?? d?.data?.price;
  if (!rate) throw new BitnobError("Bitnob rate unavailable", "BITNOB_RATE_UNAVAILABLE", 502);
  return Number(rate);
}

// ---------------------------------------------------------------------------
// Customers (cards require a KYC'd customer)
// ---------------------------------------------------------------------------
export async function createCustomer(payload: {
  firstName: string; lastName: string; email: string; phone?: string;
  countryCode?: string; provider?: string;
}): Promise<any> {
  return unwrap(client().post("/customers", payload));
}

export async function listCustomers(email?: string): Promise<any> {
  return unwrap(client().get("/customers", { params: email ? { email } : {} }));
}

// ---------------------------------------------------------------------------
// Virtual cards (v2 — micro-units)
// ---------------------------------------------------------------------------
const U = 1_000_000;
export const toMicro = (amount: number | string) => Math.round(Number(amount) * U);
export const fromMicro = (amount: number | string | null | undefined) => Number(amount ?? 0) / U;

export async function createCard(p: {
  customerId: string; name: string; amountUSD: number; reference: string; webhookUrl?: string;
}): Promise<any> {
  return unwrap(client().post("/cards", {
    card_type: "virtual",
    currency: "USD",
    card_brand: "visa",
    customer_id: p.customerId,
    name: p.name,
    amount: toMicro(p.amountUSD),
    reference: p.reference,
    webhook_url: p.webhookUrl,
  }));
}

export async function listCards(customerId?: string): Promise<any> {
  return unwrap(client().get("/cards", { params: customerId ? { customer_id: customerId } : {} }));
}

export async function getCard(cardId: string): Promise<any> {
  return unwrap(client().get(`/cards/${cardId}`));
}

export async function cardBalanceOp(cardId: string, type: "fund" | "withdraw", amountUSD: number, reference: string): Promise<any> {
  return unwrap(client().post(`/cards/${cardId}/balance`, {
    type,
    amount: toMicro(amountUSD),
    reference,
  }));
}

export async function setCardStatus(cardId: string, status: "frozen" | "active"): Promise<any> {
  return unwrap(client().post(`/cards/${cardId}/status`, { status }));
}

export async function terminateCard(cardId: string, reason: string): Promise<any> {
  return unwrap(client().delete(`/cards/${cardId}`, { data: { reason } }));
}

export async function cardSecure(cardId: string): Promise<any> {
  return unwrap(client().get(`/cards/${cardId}/secure`));
}

export async function cardTransactions(cardId: string, page = 1): Promise<any> {
  return unwrap(client().get(`/cards/${cardId}/transactions`, { params: { page } }));
}

// ---------------------------------------------------------------------------
// Payouts (crypto → cash, e.g. USDT → NGN bank transfer)
// ---------------------------------------------------------------------------
export async function createPayoutQuote(p: {
  fromAsset: string;          // USDT | USDC | BTC
  chain?: string;             // e.g. CHAIN_TYPE_TRON
  toCurrency: string;         // NGN
  country: string;            // NG
  amount: number;             // in toCurrency units
  reference: string;
}): Promise<any> {
  return unwrap(client().post("/payouts/quotes", {
    from_asset: p.fromAsset,
    chain: p.chain || "CHAIN_TYPE_TRON",
    to_currency: p.toCurrency,
    country: p.country,
    amount: String(p.amount),
    reference: p.reference,
  }));
}

export async function executePayout(quoteId: string, payload: {
  beneficiary: { bankName?: string; bankCode?: string; accountNumber: string; accountName: string; bankBranchCode?: string };
  reference: string;
  narration?: string;
}): Promise<any> {
  return unwrap(client().post(`/payouts/quotes/${quoteId}/execute`, {
    beneficiary: payload.beneficiary,
    reference: payload.reference,
    narration: payload.narration,
  }));
}

export async function payoutStatus(payoutId: string): Promise<any> {
  return unwrap(client().get(`/payouts/${payoutId}`));
}
