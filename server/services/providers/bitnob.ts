import crypto from "crypto";

/**
 * Bitnob API client — HMAC-SHA256 signed requests.
 *
 * Auth (per https://bitnob.dev/api-reference/authentication):
 *   signature = HMAC_SHA256(secret, `${CLIENT_ID}:${TIMESTAMP}:${NONCE}:${PAYLOAD}`)
 *   headers:  X-Auth-Client, X-Auth-Timestamp (unix seconds), X-Auth-Nonce (16-byte hex),
 *             X-Auth-Signature (hex). PAYLOAD is the exact JSON body ("" when none).
 *
 * Env (UNIFIED CONTRACT — same for services/bitnob.ts and providers/bitnob.ts):
 *   BITNOB_CLIENT_ID    — the client id (X-Auth-Client header)
 *   BITNOB_SECRET_KEY   — HMAC secret used to sign requests
 *   BITNOB_API_KEY      — DEPRECATED alias of BITNOB_SECRET_KEY (kept for
 *                         backward compatibility; do not use in new code)
 *   BITNOB_BASE_URL     — default https://api.bitnob.com (live, confirmed
 *                         2026-10; sandbox host sandboxapi.bitnob.co currently
 *                         serves a mismatched TLS cert and 404s all routes)
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
    super("Bitnob is not configured (BITNOB_CLIENT_ID / BITNOB_SECRET_KEY missing)");
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

// BASE_URL is normalized to NEVER end in "/api" — every request path below
// already starts with "/api/...". Both "https://api.bitnob.com" and the
// (previously documented, error-prone) "https://api.bitnob.com/api" work.
const BASE_URL = (process.env.BITNOB_BASE_URL || "https://api.bitnob.com")
  .replace(/\/+$/, "")
  .replace(/\/api$/, "");
// Unified contract: X-Auth-Client = BITNOB_CLIENT_ID, HMAC secret =
// BITNOB_SECRET_KEY (falls back to the legacy BITNOB_API_KEY alias).
const CLIENT_ID = process.env.BITNOB_CLIENT_ID || "";
const SECRET_KEY = process.env.BITNOB_SECRET_KEY || process.env.BITNOB_API_KEY || "";
const TIMEOUT_MS = 30_000;

export function isBitnobConfigured(): boolean {
  return Boolean(CLIENT_ID && SECRET_KEY);
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
  const base = `${CLIENT_ID}:${timestamp}:${nonce}:${payload}`;
  const signature = crypto.createHmac("sha256", SECRET_KEY).update(base).digest("hex");
  return {
    "X-Auth-Client": CLIENT_ID,
    "X-Auth-Timestamp": timestamp,
    "X-Auth-Nonce": nonce,
    "X-Auth-Signature": signature,
  };
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

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
const PATCH = <T = any>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {});

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

/**
 * PATCH /api/cards/:cardId/contact — cardholder notification details
 * (email and/or mobile). Omitted fields keep their current value.
 */
export function updateCardContact(
  cardId: string,
  input: { email?: string; mobile?: string },
) {
  return PATCH(`/api/cards/${cardId}/contact`, input);
}

/**
 * Decrypt `GET /api/cards/:cardId/secure` credentials when the merchant RSA
 * private key is configured (BITNOB_RSA_PRIVATE_KEY, PEM, PKCS#8).
 *
 * Wire format (per Bitnob Card Issuing docs):
 *   encrypted_key  = base64 AES-256 content key wrapped with the registered
 *                    RSA PUBLIC key (OAEP w/ SHA-256)
 *   encrypted_data = base64( nonce[12] || ciphertext || tag[16] ) of the
 *                    credentials JSON under AES-256-GCM, no AAD
 *   algorithm      = "RSA-OAEP-256+AES-256-GCM" (anything else is rejected)
 *
 * Returns the decrypted credentials object (card_id, card_number, cvv,
 * expiry_month, expiry_year, name, balance_amount) or null when decryption
 * is impossible (no key configured / wrong algorithm / crypto failure) — the
 * caller then falls back to provider-plaintext fields if any.
 */
export async function decryptCardSecureDetails(payload: {
  encrypted_data?: string;
  encrypted_key?: string;
  algorithm?: string;
}): Promise<Record<string, unknown> | null> {
  const pem = (process.env.BITNOB_RSA_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  if (!pem || !payload?.encrypted_data || !payload?.encrypted_key) return null;
  const algorithm = String(payload.algorithm || "RSA-OAEP-256+AES-256-GCM");
  if (algorithm !== "RSA-OAEP-256+AES-256-GCM") return null;
  try {
    const crypto = await import("crypto");
    const wrapped = Buffer.from(payload.encrypted_key, "base64");
    const aesKey = crypto.privateDecrypt(
      { key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      wrapped,
    );
    const blob = Buffer.from(payload.encrypted_data, "base64");
    const nonce = blob.subarray(0, 12);
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(12, blob.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plain);
  } catch (e: any) {
    console.error("[bitnob] card secure decrypt failed:", e?.message);
    return null;
  }
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
// Stablecoins (USDT / USDC)
// ---------------------------------------------------------------------------
/** Chains Bitnob supports for stablecoin deposits (GET /api/stablecoins/supported-chains). */
export function getSupportedStablecoinChains() {
  return GET("/api/stablecoins/supported-chains");
}

/**
 * On-chain stablecoin withdrawal (send USDT/USDC out to an external address).
 * Amount is a STRING in BASE UNITS in production examples (docs show
 * "150500000" for 150.5 USDT on 6-decimal chains) — callers decide units and
 * pass them explicitly via `amount`. `reference` must be unique per withdrawal.
 */
export function createWithdrawal(input: {
  to_address: string;
  amount: string;
  currency: "USDT" | "USDC";
  chain: string;
  reference: string;
  description: string;
}) {
  return POST("/api/withdrawals", input);
}

/** Transactions feed — used to server-side verify deposit webhooks (fraud check). */
export function listTransactions(query: { cursor?: string; limit?: number } = {}) {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]),
  ).toString();
  return GET(`/api/transactions${qs ? `?${qs}` : ""}`);
}
export function getTransaction(idOrReference: string) {
  return GET(`/api/transactions/${encodeURIComponent(idOrReference)}`);
}

// ---------------------------------------------------------------------------
// Trading (USDT/USDC/BTC <-> NGN conversions, executed on Bitnob's book)
// ---------------------------------------------------------------------------
export function listTradingPrices() {
  return GET("/api/trading/prices");
}
export function getTradingPrice(pair: string) {
  return GET(`/api/trading/prices/${encodeURIComponent(pair.toUpperCase())}`);
}

/**
 * Create a trade quote (docs: exactly 4 request fields — base_currency,
 * quote_currency, side 'buy'|'sell' LOWERCASE, quantity = amount of BASE
 * currency). `exchange` in the response carries send/receive legs.
 *   USDT→NGN sell: { base_currency: "USDT", quote_currency: "NGN", side: "sell", quantity: "<USDT units>" }
 *   NGN→USDT buy:  { base_currency: "NGN",  quote_currency: "USDT", side: "sell", quantity: "<NGN units>" }
 */
export function createTradingQuote(input: {
  base_currency: string;
  quote_currency: string;
  side: "BUY" | "SELL" | "buy" | "sell";
  quantity: string;
}) {
  return POST("/api/trading/quotes", { ...input, side: String(input.side).toLowerCase() });
}
export function getTradingQuote(quoteId: string) {
  return GET(`/api/trading/quotes/${encodeURIComponent(quoteId)}`);
}

/** Submit an order against a quote (see Create Order) — `reference` unique per order. */
export function createTradingOrder(input: {
  base_currency: string;
  quote_currency: string;
  side: "BUY" | "SELL" | "buy" | "sell";
  quantity: string;
  price?: string;
  quote_id: string;
  quantity_in_base_units?: boolean;
  reference: string;
}) {
  return POST("/api/trading/orders", { ...input, side: String(input.side).toLowerCase() });
}
/** Get order by id OR reference (docs accept both). */
export function getTradingOrder(idOrReference: string) {
  return GET(`/api/trading/orders/${encodeURIComponent(idOrReference)}`);
}
export function cancelTradingOrder(idOrReference: string) {
  return DEL(`/api/trading/orders/${encodeURIComponent(idOrReference)}`);
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
