import crypto from "crypto";

/**
 * Bitnob API client — HMAC-SHA256 signed requests.
 *
 * Auth (per https://bitnob.dev/api-reference/authentication):
 *   signature = HMAC_SHA256(secret, `${CLIENT_ID}:${TIMESTAMP}:${NONCE}:${PAYLOAD}`)
 *   headers:  X-Auth-Client, X-Auth-Timestamp (unix seconds), X-Auth-Nonce (16-byte hex),
 *             X-Auth-Signature (hex). PAYLOAD is the exact JSON body ("" when none).
 *
 * Env:
 *   BITNOB_API_KEY      — the client id (X-Auth-Client)
 *   BITNOB_SECRET_KEY   — HMAC secret
 *   BITNOB_BASE_URL     — default https://api.bitnob.com (sandbox: https://sandboxapi.bitnob.com)
 *
 * When credentials are missing the client throws BitnobNotConfiguredError; routers
 * fall back to the built-in simulator so the product still works end-to-end in
 * non-production environments.
 *
 * Specs implemented (v2 card API + payouts + wallets + addresses + rates + customers):
 *  - Cards:      POST /api/cards, POST /api/cards/lite, GET /api/cards[/:id],
 *                POST /api/cards/:cardId/balance (type fund|withdraw),
 *                POST /api/cards/:cardId/status (active|frozen), DELETE /api/cards/:cardId,
 *                GET /api/cards/:cardId/transactions, GET /api/cards/:cardId/secure,
 *                POST /api/cards/kyc
 *  - Amounts:    card amounts are MICRO-UNITS (1 USD = 1_000_000).
 *  - Payouts:    POST /api/payouts/quotes, POST /api/payouts/:quoteId/initialize,
 *                POST /api/payouts/:quoteId/finalize, GET /api/payouts,
 *                GET /api/payouts/banks/:countryCode, POST /api/payouts/account-lookup
 *  - Wallets:    GET /api/balances, GET /api/balances/:currency
 *  - Addresses:  POST /api/addresses, GET /api/addresses, POST /api/addresses/validate
 *  - Rates:      GET /api/exchange-rates?from=&to=, GET /api/exchange-rates?base=,
 *                GET /api/exchange-rates/convert?from=&to=&amount=
 *  - Customers:  POST /api/customers, GET /api/customers/:id, GET /api/customers
 *  - Beneficiaries: GET/POST /api/beneficiaries
 */

export class BitnobNotConfiguredError extends Error {
  constructor() {
    super("Bitnob is not configured (BITNOB_API_KEY / BITNOB_SECRET_KEY missing)");
    this.name = "BitnobNotConfiguredError";
  }
}

export class BitnobApiError extends Error {
  status: number;
  payload: any;
  constructor(status: number, message: string, payload?: any) {
    super(`Bitnob API ${status}: ${message}`);
    this.name = "BitnobApiError";
    this.status = status;
    this.payload = payload;
  }
}

const BASE_URL = (process.env.BITNOB_BASE_URL || "https://api.bitnob.com").replace(/\/+$/, "");
const API_KEY = process.env.BITNOB_API_KEY || "";
const SECRET_KEY = process.env.BITNOB_SECRET_KEY || "";
const TIMEOUT_MS = 30_000;

export function isBitnobConfigured(): boolean {
  return Boolean(API_KEY && SECRET_KEY);
}

/** 1 whole card-currency unit in Bitnob micro-units. */
export const MICRO = 1_000_000;
export function toMicros(amount: number | string): number {
  return Math.round(Number(amount) * MICRO);
}
export function fromMicros(micros: number | string): number {
  return Number(micros) / MICRO;
}

function hmacHeaders(payload: string): Record<string, string> {
  if (!isBitnobConfigured()) throw new BitnobNotConfiguredError();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const base = `${API_KEY}:${timestamp}:${nonce}:${payload}`;
  const signature = crypto.createHmac("sha256", SECRET_KEY).update(base).digest("hex");
  return {
    "X-Auth-Client": API_KEY,
    "X-Auth-Timestamp": timestamp,
    "X-Auth-Nonce": nonce,
    "X-Auth-Signature": signature,
  };
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function request<T = any>(method: Method, path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...hmacHeaders(payload),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : payload,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { success: false, message: text.slice(0, 300) };
    }
    if (!res.ok || json?.success === false) {
      throw new BitnobApiError(res.status, json?.message || res.statusText, json);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

const GET = <T = any>(path: string) => request<T>("GET", path);
const POST = <T = any>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const PUT = <T = any>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {});
const DEL = <T = any>(path: string, body?: unknown) => request<T>("DELETE", path, body ?? {});

// ---------------------------------------------------------------------------
// Wallets / balances
// ---------------------------------------------------------------------------
export function getBalances() {
  return GET("/api/balances");
}
export function getBalanceByCurrency(currency: string) {
  return GET(`/api/balances/${encodeURIComponent(currency.toUpperCase())}`);
}

// ---------------------------------------------------------------------------
// Exchange rates
// ---------------------------------------------------------------------------
export function getExchangeRate(from: string, to: string) {
  return GET(`/api/exchange-rates?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}
export function listExchangeRates(base: string) {
  return GET(`/api/exchange-rates?base=${encodeURIComponent(base)}`);
}
export function convertAmount(from: string, to: string, amount: number) {
  return GET(
    `/api/exchange-rates/convert?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&amount=${amount}`,
  );
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
export function createAddress(input: { chain: string; customer_email?: string; label?: string; reference?: string }) {
  return POST("/api/addresses", input);
}
export function listAddresses(query: { chain?: string; status?: string; cursor?: string; limit?: number } = {}) {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]),
  ).toString();
  return GET(`/api/addresses${qs ? `?${qs}` : ""}`);
}
export function validateAddress(address: string, chain: string) {
  return POST("/api/addresses/validate", { address, chain });
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export function createCustomer(input: {
  email: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  country_code?: string;
  customer_type: "individual" | "business";
  reference?: string;
}) {
  return POST("/api/customers", input);
}
export function getCustomer(customerId: string) {
  return GET(`/api/customers/${customerId}`);
}
export function listCustomers(query: { email?: string; reference?: string } = {}) {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]),
  ).toString();
  return GET(`/api/customers${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------
// Card KYC (POST /api/cards/kyc) — returns customer_id used by Create Card
// ---------------------------------------------------------------------------
export function submitCardKyc(input: Record<string, unknown>) {
  return POST("/api/cards/kyc", input);
}

// ---------------------------------------------------------------------------
// Virtual cards (v2, micro-units)
// ---------------------------------------------------------------------------
export function createCard(input: {
  customer_id: string;
  amount: number; // micro-units
  currency?: string;
  card_type?: "virtual";
  card_brand?: string;
  name?: string;
  contactless_payment?: boolean;
  reference?: string;
  webhook_url?: string;
  card_limits?: Record<string, number>;
}) {
  return POST("/api/cards", { card_type: "virtual", currency: "USD", ...input });
}
export function getCard(cardId: string) {
  return GET(`/api/cards/${cardId}`);
}
export function listCards(query: { status?: string; cursor?: string; limit?: number } = {}) {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]),
  ).toString();
  return GET(`/api/cards${qs ? `?${qs}` : ""}`);
}
export function fundOrWithdrawCard(cardId: string, input: { amount: number; type: "fund" | "withdraw"; reference: string }) {
  return POST(`/api/cards/${cardId}/balance`, input);
}
export function setCardStatus(cardId: string, status: "active" | "frozen") {
  return POST(`/api/cards/${cardId}/status`, { status });
}
export function terminateCard(cardId: string, reason: string) {
  return DEL(`/api/cards/${cardId}`, { reason });
}
export function getCardTransactions(cardId: string, cursor?: string) {
  return GET(`/api/cards/${cardId}/transactions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
}
export function getCardSecureDetails(cardId: string) {
  return GET(`/api/cards/${cardId}/secure`);
}

// ---------------------------------------------------------------------------
// Payouts (crypto → fiat, e.g. USDT → NGN)
// ---------------------------------------------------------------------------
export function createPayoutQuote(input: {
  from_asset: "BTC" | "USDT" | "USDC";
  to_currency: string;
  country: string; // e.g. "NG"
  source?: "offchain" | "onchain";
  chain?: string;
  amount?: string;
  settlement_amount?: string;
  payment_reason?: string;
  reference: string;
}) {
  return POST("/api/payouts/quotes", { source: "offchain", ...input });
}
export function initializePayout(
  quoteId: string,
  input: {
    quote_id: string;
    reference: string;
    payment_reason: string;
    callback_url?: string;
    beneficiary: {
      destination_type: "bank" | "mobile_money" | "swift";
      country: string;
      account_name: string;
      account_number: string;
      bank_code?: string;
      network?: string;
    };
  },
) {
  return POST(`/api/payouts/${encodeURIComponent(quoteId)}/initialize`, input);
}
export function finalizePayout(quoteId: string) {
  return POST(`/api/payouts/${encodeURIComponent(quoteId)}/finalize`);
}
export function listPayouts(query: { cursor?: string; limit?: number } = {}) {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]),
  ).toString();
  return GET(`/api/payouts${qs ? `?${qs}` : ""}`);
}
export function getPayoutBanks(countryCode: string) {
  return GET(`/api/payouts/banks/${encodeURIComponent(countryCode)}`);
}
export function accountLookup(input: { account_number: string; bank_code: string; country?: string }) {
  return POST("/api/payouts/account-lookup", input);
}
export function getSupportedCountries() {
  return GET("/api/payouts/supported-countries");
}

// ---------------------------------------------------------------------------
// Beneficiaries
// ---------------------------------------------------------------------------
export function listBeneficiaries(limit = 50, offset = 0) {
  return GET(`/api/beneficiaries?limit=${limit}&offset=${offset}`);
}
export function createBeneficiary(input: {
  name: string;
  type: "bank" | "crypto";
  destination?: string; // JSON-encoded {account_number, bank_code, account_name} for bank
  wallet_address?: string;
  currency?: string;
  network?: string;
}) {
  return POST("/api/beneficiaries", input);
}
