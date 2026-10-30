import axios, { AxiosInstance } from "axios";
import crypto from "crypto";

/**
 * Sogo Partner API service — REAL end-to-end integration.
 *
 * Products covered (developer.sogo.africa/reference):
 *   Crypto (Off-Ramp) : assets, rates, deposit addresses (GET/POST), sandbox
 *                       test-deposit simulator.
 *   RMB               : live NGN/CNY rates + multipart buy orders (Alipay /
 *                       WeChat Pay QR + Chinese bank transfers).
 *   Bills (VTU)       : catalog, data plans, cable packages, education plans,
 *                       discount rates, ePIN stock, ePIN voucher image,
 *                       verification (meter / smartcard / JAMB / betting) and
 *                       all 8 purchase endpoints.
 *   Gift Cards (Buy)  : countries, products, calculate, purchase.
 *   Gift Cards (Sell) : catalog, rates, submit (JSON e-code + multipart
 *                       physical cards).
 *   Transactions      : GET /transactions/{reference}, POST /transactions/verify.
 *
 * Environments (key prefix decides — mixing returns 403 environment_mismatch):
 *   sandbox : https://sandbox.sogo.africa/v1   (sogo_sk_test_ keys)
 *   live    : https://api.sogo.africa/v1       (sogo_sk_live_ keys)
 *
 * Auth: Bearer secret key. ALL write endpoints additionally require an
 * `Idempotency-Key` header (UUID v4) — we pass OUR reference so webhook
 * events + GET /transactions/{reference} reconcile by the same string.
 *
 * Webhooks: X-Sogo-Signature-256 = "sha256=" + HMAC_SHA256(rawBody, secret).
 *
 * Sandbox behaviours used by tests (developer.sogo.africa/docs):
 *   - wallet balance fixed at NGN 1,000,000; transactions NOT persisted
 *     (GET /transactions/{ref} 404s in sandbox — use the purchase response).
 *   - outcomes keyed on the last 4 digits/chars of customer identifiers:
 *     *0000 → refunded/cancelled, *9999 → stuck processing, anything else →
 *     completed. Published test identifiers: phone 09012341234, meter
 *     12345671234, smartcard 10001234, JAMB 12341234, bet 12341234,
 *     e-code GIFTUSA1234, Alipay recipient1234.
 *   - rate limit: 10 requests/min per key (300 on live).
 */

const SANDBOX_BASE = "https://sandbox.sogo.africa/v1";
const LIVE_BASE = "https://api.sogo.africa/v1";

/**
 * Env keys are read DYNAMICALLY (not captured at module load) so runtime
 * env overrides and tests work — env-override.ts may mutate process.env
 * after imports evaluate.
 */
function secretKey(): string {
  return (process.env.SOGO_SECRET_KEY || "").trim();
}
function publicKey(): string {
  return (process.env.SOGO_PUBLIC_KEY || "").trim();
}
function webhookSecret(): string {
  return (process.env.SOGO_WEBHOOK_SECRET || "").trim();
}

export function sogoKeyKind(): "sandbox" | "live" | "unknown" {
  const key = secretKey();
  if (key.startsWith("sogo_sk_test_")) return "sandbox";
  if (key.startsWith("sogo_sk_live_")) return "live";
  return "unknown";
}

function resolveBaseUrl(): string {
  const override = (process.env.SOGO_BASE_URL || "").trim();
  if (override) return override.replace(/\/+$/, "");
  const kind = sogoKeyKind();
  if (kind === "sandbox") return SANDBOX_BASE;
  if (kind === "live") return LIVE_BASE;
  return LIVE_BASE;
}

export function sogoBaseUrl(): string {
  try { return new URL(resolveBaseUrl()).host; } catch { return ""; }
}

export function isSogoConfigured(): boolean {
  return !!secretKey();
}

export function isSogoSandbox(): boolean {
  return resolveBaseUrl().includes("sandbox");
}

/** Actionable error text for operator surfaces (admin console, 502 bodies). */
export function sogoErr(e: any): string {
  const d = e?.response?.data;
  let msg = d?.message || d?.error || d?.details || e?.message || "Sogo request failed";
  if (d?.errors && typeof d.errors === "object") {
    const first = Object.values(d.errors)[0];
    if (Array.isArray(first) && first.length) msg = String(first[0]);
  }
  const status = e?.response?.status;
  if (status === 401) {
    msg = `${msg} — Sogo rejected the API key. Check SOGO_SECRET_KEY (sogo_sk_test_ keys only work against sandbox.sogo.africa, sogo_sk_live_ against api.sogo.africa).`;
  } else if (status === 403 && /environment_mismatch/i.test(String(d?.code || d?.message || ""))) {
    msg = `${msg} — key/environment mismatch: a sogo_sk_test_ key must be used against sandbox.sogo.africa and sogo_sk_live_ against api.sogo.africa.`;
  } else if (status === 429) {
    msg = `${msg} — Sogo rate limit reached (sandbox allows 10 requests/min). Retry shortly.`;
  }
  return String(msg).slice(0, 500);
}

function client(): AxiosInstance {
  if (!isSogoConfigured()) {
    throw new Error("Sogo is not configured (SOGO_SECRET_KEY missing)");
  }
  return axios.create({
    baseURL: resolveBaseUrl(),
    timeout: 60_000,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      Accept: "application/json",
      "User-Agent": "Metricorex/1.0",
    },
  });
}

/**
 * Idempotency-Key for writes: pass OUR reference through when it is a safe
 * opaque token (UUID or alphanumeric+dash) so webhooks + transaction
 * lookups reconcile 1:1; fall back to a UUID v4 otherwise (Sogo's
 * recommended format).
 */
export function sogoIdempotencyKey(reference?: string | null): string {
  const ref = (reference || "").trim();
  if (ref && /^[0-9a-zA-Z-]{8,80}$/.test(ref)) return ref;
  return crypto.randomUUID();
}

/**
 * Unified request. `reference` (when provided) becomes the Idempotency-Key on
 * writes so Sogo transaction lookups + webhooks reconcile by OUR reference.
 */
async function sogoRequest<T = any>(
  method: "GET" | "POST",
  path: string,
  opts: {
    params?: Record<string, any>;
    body?: Record<string, any> | null;
    reference?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const instance = client();
  const headers: Record<string, any> = {};
  if (method === "POST") headers["Idempotency-Key"] = sogoIdempotencyKey(opts.reference);
  const res = await instance.request({
    method,
    url: path,
    params: opts.params,
    data: opts.body === null ? undefined : (opts.body ?? undefined),
    headers,
    timeout: opts.timeoutMs ?? 60_000,
    maxBodyLength: Infinity,
  });
  return res?.data;
}

/** Multipart POST — RMB buy (QR code) + gift card sell (physical images). */
async function sogoPostMultipart<T = any>(
  path: string,
  fields: Record<string, any>,
  files: Array<{ field: string; buffer: Buffer; filename: string; contentType?: string }> = [],
  reference?: string | null,
): Promise<T> {
  const instance = client();
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    form.append(k, String(v));
  }
  for (const f of files) {
    form.append(f.field, f.buffer, {
      filename: f.filename || "upload.jpg",
      contentType: f.contentType || "application/octet-stream",
    });
  }
  const res = await instance.post(path, form, {
    headers: {
      "Idempotency-Key": sogoIdempotencyKey(reference),
      ...form.getHeaders(),
    },
    timeout: 120_000,
    maxBodyLength: Infinity,
  });
  return res?.data;
}

/** Binary GET (ePIN voucher image) → Buffer. */
async function sogoGetBinary(path: string, params: Record<string, any> = {}): Promise<Buffer> {
  const res = await client().get(path, { params, responseType: "arraybuffer", timeout: 60_000 });
  return Buffer.from(res?.data || []);
}

/* ------------------------------------------------------------------ */
/* Small TTL cache for read-heavy catalogue endpoints. Sogo's sandbox  */
/* allows only 10 req/min — caching protects interactive UIs (catalog, */
/* plans, rates) from bursting the limit. Values cached per-key.       */
/* ------------------------------------------------------------------ */
const cache = new Map<string, { at: number; value: any }>();
const CATALOG_TTL_MS = Number(process.env.SOGO_CACHE_TTL_MS || 90_000);

async function cached<T>(key: string, loader: () => Promise<T>, ttlMs = CATALOG_TTL_MS): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) {
    const cutoff = Date.now() - ttlMs;
    for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
  }
  return value;
}

/**
 * Sogo transaction status can be a plain string OR an object
 * {value, is_final} (observed live on sandbox). Normalize to a lowercase
 * string everywhere.
 */
export function sogoStatus(tx: any): string {
  const raw = tx?.status ?? tx;
  if (raw && typeof raw === "object") return String(raw.value || "").toLowerCase();
  return String(raw || "").toLowerCase();
}

/**
 * The transaction object out of ANY Sogo shape — purchase responses
 * ({transaction: {...}} or the tx itself), and webhook events.
 *
 * LIVE WEBHOOK SHAPE (observed 2026-10-30, livemode):
 *   { id: "evt_…", event: "transaction.completed",
 *     data: { id, object: "transaction", reference: "BILL…", status: {value,is_final},
 *             type: {value, is_credit}, amount: {raw, currency, formatted}, metadata, timestamps } }
 *
 * `data.object` is a Stripe-style DISCRIMINATOR STRING ("transaction"), NOT a
 * nested object — the old `payload?.data?.object || payload?.data` extraction
 * turned every live bill webhook into the literal string "transaction" and
 * silently dropped it (the "webhook arrived but bill stayed processing" bug).
 */
export function sogoTx(payload: any): any {
  if (!payload || typeof payload !== "object") return payload ?? {};
  const data = payload.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return payload;
}

/** Sogo `type` arrives as a string OR {value, is_credit} — normalize to lowercase string. */
export function sogoType(tx: any): string {
  const raw = tx?.type ?? tx;
  const v = raw && typeof raw === "object" ? (raw.value ?? "") : raw;
  return String(v || "").toLowerCase();
}

/** Sogo money fields arrive as numbers OR {raw, currency, formatted} — extract the number. */
export function sogoAmount(v: any): number {
  if (v == null) return 0;
  const n = typeof v === "object" ? Number(v.raw ?? v.value ?? v.amount) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Sogo status vocabulary → OUR canonical statuses. Live webhooks/polling use
 * "successful" / "delivered" / "failure" / "canceled" — the webhook handlers
 * previously did a strict ["completed","failed",…] equality and silently
 * mapped every one of those to "processing".
 */
export function normalizeSogoStatus(raw: any): string {
  const s = String((raw && typeof raw === "object" ? raw.value : raw) ?? "").toLowerCase();
  if (["completed", "successful", "success", "delivered"].includes(s)) return "completed";
  if (["failed", "failure"].includes(s)) return "failed";
  if (["refunded", "reversed"].includes(s)) return "refunded";
  if (["cancelled", "canceled"].includes(s)) return "cancelled";
  return "processing";
}

/** Sogo transaction reference from any response shape (envelope-aware). */
export function sogoReference(tx: any): string {
  return String(
    tx?.transaction?.reference || tx?.data?.transaction?.reference ||
      tx?.reference || tx?.order?.reference || "",
  );
}

/** Unwrap the {data: ...} envelope (Sogo responses) with graceful fallbacks. */
function unwrap<T = any>(body: any, fallback: T): T {
  if (body && typeof body === "object" && "data" in body) return (body.data ?? fallback) as T;
  return (body ?? fallback) as T;
}

// ===========================================================================
// CRYPTO (OFF-RAMP)
// ===========================================================================

/** All supported crypto assets + networks + fee tiers. */
export async function cryptoAssets(): Promise<any[]> {
  return cached("crypto:assets", async () => {
    const body = await sogoRequest<any>("GET", "/crypto/assets");
    return unwrap<any[]>(body, []);
  });
}

/** Estimated NGN payout for `amount` of `asset` (rate, fee, net). */
export async function cryptoRate(asset: string, amount?: number): Promise<any> {
  const body = await sogoRequest<any>("GET", `/crypto/assets/${encodeURIComponent(asset)}/rate`, {
    params: amount != null && Number.isFinite(Number(amount)) ? { amount } : {},
  });
  return unwrap(body, {});
}

/** Look up an existing deposit address (null when none). */
export async function cryptoGetDepositAddress(asset: string, network?: string): Promise<any | null> {
  try {
    const body = await sogoRequest<any>("GET", "/crypto/deposit-address", {
      params: { asset, ...(network ? { network } : {}) },
    });
    return unwrap<any>(body, null);
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

/** Get-or-create a deposit address for asset+network. */
export async function cryptoCreateDepositAddress(asset: string, network?: string, reference?: string | null): Promise<any> {
  const body = await sogoRequest<any>("POST", "/crypto/deposit-address", {
    body: { asset, ...(network ? { network } : {}) },
    reference,
  });
  return unwrap(body, {});
}

/**
 * SANDBOX ONLY — simulate an on-chain deposit against a sandbox address and
 * fire the full webhook pipeline. Outcome keyed on test_reference's last 4
 * chars: *0000 held, *9999 stuck, otherwise completed.
 */
export async function cryptoTestDeposit(input: {
  asset: string;
  network?: string;
  crypto_amount: number;
  test_reference: string;
}): Promise<any> {
  const body = await sogoRequest<any>("POST", "/crypto/test-deposit", {
    body: {
      asset: input.asset,
      ...(input.network ? { network: input.network } : {}),
      crypto_amount: input.crypto_amount,
      test_reference: input.test_reference,
    },
  });
  return unwrap(body, {});
}

// ===========================================================================
// RMB (CNY PURCHASE)
// ===========================================================================

/** Live NGN/CNY rates + channels + account types + fee structure. */
export async function rmbRates(): Promise<any> {
  return cached("rmb:rates", async () => {
    const body = await sogoRequest<any>("GET", "/rmb/buy/rates");
    return unwrap(body, {});
  }, 30_000);
}

/**
 * Submit an RMB buy order. Alipay/WeChat require the recipient's receive QR
 * (image); bank requires bank name + account number. multipart/form-data.
 */
export async function rmbBuy(input: {
  channel: "alipay" | "wechat" | "bank";
  alipay_account_type?: "nigerian" | "chinese";
  wechat_account_type?: "nigerian" | "chinese";
  rmb_amount: number;
  recipient_name: string;
  recipient_identifier?: string;
  recipient_bank_name?: string;
  recipient_bank_account_number?: string;
  description: string;
  qr_code?: { buffer: Buffer; filename: string; contentType?: string } | null;
  reference: string;
}): Promise<any> {
  const fields: Record<string, any> = {
    channel: input.channel,
    rmb_amount: input.rmb_amount,
    recipient_name: input.recipient_name,
    description: input.description,
  };
  if (input.channel === "alipay" && input.alipay_account_type) fields.alipay_account_type = input.alipay_account_type;
  if (input.channel === "wechat" && input.wechat_account_type) fields.wechat_account_type = input.wechat_account_type;
  if (input.recipient_identifier) fields.recipient_identifier = input.recipient_identifier;
  if (input.channel === "bank") {
    if (input.recipient_bank_name) fields.recipient_bank_name = input.recipient_bank_name;
    if (input.recipient_bank_account_number) fields.recipient_bank_account_number = input.recipient_bank_account_number;
  }
  const files = input.qr_code
    ? [{ field: "qr_code", buffer: input.qr_code.buffer, filename: input.qr_code.filename, contentType: input.qr_code.contentType }]
    : [];
  const body = await sogoPostMultipart<any>("/rmb/buy", fields, files, input.reference);
  return unwrap(body, {});
}

// ===========================================================================
// BILLS (VTU) — catalogue, verification, purchases
// ===========================================================================

/** Full bill catalog (types → providers → slugs). ?type= filters. */
export async function billsCatalog(type?: string): Promise<any> {
  return cached(`bills:catalog:${(type || "all").toLowerCase()}`, async () => {
    const body = await sogoRequest<any>("GET", "/bills/catalog", { params: type ? { type } : {} });
    return unwrap<any[]>(body, []);
  });
}

/** Data plans per network (variation_code per plan). */
export async function billsDataPlans(network?: string): Promise<any[]> {
  return cached(`bills:data-plans:${(network || "all").toLowerCase()}`, async () => {
    const body = await sogoRequest<any>("GET", "/bills/data-plans", { params: network ? { network } : {} });
    return unwrap<any[]>(body, []);
  });
}

/** Cable packages per provider (variation_code per package). */
export async function billsCablePackages(provider?: string): Promise<any[]> {
  return cached(`bills:cable:${(provider || "all").toLowerCase()}`, async () => {
    const body = await sogoRequest<any>("GET", "/bills/cable-packages", { params: provider ? { provider } : {} });
    return unwrap<any[]>(body, []);
  });
}

/** Education plans (JAMB / WAEC variation codes + prices). The endpoint
 * REQUIRES ?provider= — fetch both and merge (cached per provider). */
export async function billsEducationPlans(provider?: string): Promise<any[]> {
  const wanted = provider ? [provider.toLowerCase()] : ["jamb", "waec"];
  const merged: any[] = [];
  for (const p of wanted) {
    const plans = await cached(`bills:education:${p}`, async () => {
      const body = await sogoRequest<any>("GET", "/bills/education-plans", { params: { provider: p } });
      return unwrap<any[]>(body, []);
    });
    for (const plan of Array.isArray(plans) ? plans : []) {
      if (!merged.some((m) => String(m.variation_code ?? m.code) === String(plan.variation_code ?? plan.code))) {
        merged.push({ ...plan, __provider: p });
      }
    }
  }
  return merged;
}

/** Per-category/provider discount percentages for our API key. */
export async function billsDiscountRates(): Promise<any> {
  return cached("bills:discounts", async () => {
    const body = await sogoRequest<any>("GET", "/bills/discount-rates");
    return unwrap(body, {});
  }, 60_000);
}

/** ePIN stock matrix (network × denomination, pack counts). */
export async function billsEpinStock(): Promise<any> {
  return cached("bills:epin-stock", async () => {
    const body = await sogoRequest<any>("GET", "/bills/epin-stock");
    return unwrap(body, {});
  }, 30_000);
}

/** WebP voucher image for a purchased ePIN pack. */
export async function billsEpinVoucherImage(voucherId: string | number): Promise<Buffer> {
  return sogoGetBinary(`/bills/epin/vouchers/${encodeURIComponent(String(voucherId))}/image`);
}

// --- Verification (no charge) ---------------------------------------------

export async function verifyElectricityMeter(disco_slug: string, meter_number: string, meter_type: "prepaid" | "postpaid"): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/electricity/verify-meter", {
    body: { disco_slug, meter_number, meter_type },
  });
  return unwrap(body, {});
}

export async function verifyCableSmartcard(provider: string, smartcard_number: string): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/cable-tv/verify-smartcard", {
    body: { provider, smartcard_number },
  });
  return unwrap(body, {});
}

export async function verifyJambProfile(profile_id: string, variation_code?: string): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/education/verify-jamb", {
    body: { profile_id, ...(variation_code ? { variation_code } : {}) },
  });
  return unwrap(body, {});
}

export async function verifyBettingAccount(provider: string, account_id: string): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/bet-funding/verify-account", {
    body: { provider, account_id },
  });
  return unwrap(body, {});
}

// --- Purchases (all keyed on OUR reference via Idempotency-Key) ------------

export async function buyAirtime(input: { network: string; phone: string; amount: number; ported?: boolean; reference: string }): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/airtime", {
    body: { network: input.network, phone: input.phone, amount: input.amount, ...(input.ported ? { ported: true } : {}) },
    reference: input.reference,
  });
  return unwrap(body, {});
}

export async function buyData(input: { network: string; phone: string; variation_code: string; ported?: boolean; reference: string }): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/data", {
    body: { network: input.network, phone: input.phone, variation_code: input.variation_code, ...(input.ported ? { ported: true } : {}) },
    reference: input.reference,
  });
  return unwrap(body, {});
}

export async function payElectricity(input: { disco_slug: string; meter_number: string; meter_type: "prepaid" | "postpaid"; amount: number; reference: string }): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/electricity", {
    body: { disco_slug: input.disco_slug, meter_number: input.meter_number, meter_type: input.meter_type, amount: input.amount },
    reference: input.reference,
  });
  return unwrap(body, {});
}

export async function payCableTv(input: { provider: string; smartcard_number: string; subscription_type: "renew" | "change"; variation_code: string; amount: number; reference: string }): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/cable-tv", {
    body: {
      provider: input.provider,
      smartcard_number: input.smartcard_number,
      subscription_type: input.subscription_type,
      variation_code: input.variation_code,
      amount: input.amount,
    },
    reference: input.reference,
  });
  return unwrap(body, {});
}

export async function payEducation(input: { provider: string; variation_code: string; amount: number; profile_id?: string; service_type?: string; reference: string }): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/education", {
    body: {
      provider: input.provider,
      variation_code: input.variation_code,
      amount: input.amount,
      ...(input.profile_id ? { profile_id: input.profile_id } : {}),
      ...(input.service_type ? { service_type: input.service_type } : {}),
    },
    reference: input.reference,
  });
  return unwrap(body, {});
}

export async function buyEpin(input: { network: string; denomination: number; quantity?: number; reference: string }): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/epin", {
    body: { network: input.network, denomination: input.denomination, ...(input.quantity ? { quantity: input.quantity } : {}) },
    reference: input.reference,
  });
  return unwrap(body, {});
}

export async function fundBetting(input: { provider: string; account_id: string; amount: number; reference: string }): Promise<any> {
  const body = await sogoRequest<any>("POST", "/bills/bet-funding", {
    body: { provider: input.provider, account_id: input.account_id, amount: input.amount },
    reference: input.reference,
  });
  return unwrap(body, {});
}

// ===========================================================================
// GIFT CARDS — BUY
// ===========================================================================

/** Countries with buyable gift card products. */
export async function giftcardBuyCountries(): Promise<any[]> {
  return cached("gc:buy:countries", async () => {
    const body = await sogoRequest<any>("GET", "/gift-cards/buy/countries");
    return unwrap<any[]>(body, []);
  });
}

/**
 * Buyable products. NOTE: the sandbox (and live) REQUIRE country_code —
 * "The country code field is required." — so we fan out the catalog across
 * the country list when no filter is given (cached, paginated by page).
 */
export async function giftcardBuyProducts(opts: { country_code?: string; search?: string; page?: number } = {}): Promise<any> {
  const key = `gc:buy:products:${opts.country_code || "ALL"}:${(opts.search || "").toLowerCase()}:${opts.page || 1}`;
  return cached(key, async () => {
    // Explicit country filter → single call (returns a flat product array).
    if (opts.country_code) {
      const body = await sogoRequest<any>("GET", "/gift-cards/buy/products", {
        params: { country_code: opts.country_code, ...(opts.search ? { search: opts.search } : {}) },
      });
      return unwrap<any[]>(body, []);
    }
    // No filter → merge the first N country pages (catalog breadth with a
    // bounded request count; callers get per-country grouped results too).
    const countries = await giftcardBuyCountries();
    const codes = (Array.isArray(countries) ? countries : [])
      .map((c: any) => c.country_code)
      .filter(Boolean)
      .slice(0, 12);
    const merged: any[] = [];
    for (const code of codes) {
      try {
        const body = await sogoRequest<any>("GET", "/gift-cards/buy/products", {
          params: { country_code: code, ...(opts.search ? { search: opts.search } : {}) },
        });
        const list = unwrap<any[]>(body, []);
        for (const p of list) {
          if (!merged.some((m) => String(m.product_id ?? m.id) === String(p.product_id ?? p.id))) merged.push(p);
        }
      } catch { /* country without products — skip */ }
    }
    return merged;
  });
}

/** Exact NGN price for product_id + amount + quantity (slippage guard input). */
export async function giftcardBuyCalculate(product_id: number | string, amount: number, quantity: number): Promise<any> {
  const body = await sogoRequest<any>("POST", "/gift-cards/buy/calculate", {
    body: { product_id: Number(product_id), amount: Number(amount), quantity: Math.max(1, Number(quantity) || 1) },
  });
  return unwrap(body, {});
}

/**
 * Purchase gift cards. `expected_amount_ngn` protects against rate movement
 * between calculate and buy — the router always passes the calculate total.
 */
export async function giftcardBuy(input: {
  product_id: number | string;
  amount: number;
  quantity: number;
  expected_amount_ngn: number;
  reference: string;
}): Promise<any> {
  const body = await sogoRequest<any>("POST", "/gift-cards/buy", {
    body: {
      product_id: Number(input.product_id),
      amount: Number(input.amount),
      quantity: Math.max(1, Number(input.quantity) || 1),
      expected_amount_ngn: Number(input.expected_amount_ngn),
    },
    reference: input.reference,
  });
  return unwrap(body, {});
}

// ===========================================================================
// GIFT CARDS — SELL
// ===========================================================================

/** Sellable brands (slug, countries, card types, denominations, instructions). */
export async function giftcardSellCatalog(): Promise<any[]> {
  return cached("gc:sell:catalog", async () => {
    const body = await sogoRequest<any>("GET", "/gift-cards/sell/catalog");
    return unwrap<any[]>(body, []);
  });
}

/** Sell rates (per brand → currency → card type → NGN). ?slug= filters. */
export async function giftcardSellRates(slug?: string): Promise<any> {
  const key = `gc:sell:rates:${(slug || "all").toLowerCase()}`;
  return cached(key, async () => {
    const body = await sogoRequest<any>("GET", "/gift-cards/sell/rates", { params: slug ? { slug } : {} });
    return unwrap(body, {});
  }, 30_000);
}

/**
 * Submit a gift card sell. e-codes send JSON `additional_info`; physical
 * cards POST multipart images[1..5]. Outcome (sandbox) keyed on the last 4
 * chars of additional_info / first image filename: *0000 cancelled,
 * *9999 pending, otherwise completed.
 */
export async function giftcardSell(input: {
  slug: string;
  card_country: string;
  card_type: "ecode" | "physical";
  sub_type?: string;
  card_currency: string;
  card_amount: number;
  additional_info?: string;
  images?: Array<{ buffer: Buffer; filename: string; contentType?: string }>;
  payout_currency?: string;
  specific_country?: string;
  reference: string;
}): Promise<any> {
  if (input.card_type === "physical" && input.images?.length) {
    const fields: Record<string, any> = {
      slug: input.slug,
      card_country: input.card_country,
      card_type: input.card_type,
      card_currency: input.card_currency,
      card_amount: input.card_amount,
    };
    if (input.sub_type) fields.sub_type = input.sub_type;
    if (input.payout_currency) fields.payout_currency = input.payout_currency;
    if (input.specific_country) fields.specific_country = input.specific_country;
    if (input.additional_info) fields.additional_info = input.additional_info;
    const files = input.images.slice(0, 5).map((img, i) => ({
      field: "images[]",
      buffer: img.buffer,
      filename: img.filename || `card-${i + 1}.jpg`,
      contentType: img.contentType || "image/jpeg",
    }));
    const body = await sogoPostMultipart<any>("/gift-cards/sell", fields, files, input.reference);
    return unwrap(body, {});
  }
  const payload: Record<string, any> = {
    slug: input.slug,
    card_country: input.card_country,
    card_type: input.card_type,
    card_currency: input.card_currency,
    card_amount: input.card_amount,
  };
  if (input.sub_type) payload.sub_type = input.sub_type;
  if (input.additional_info) payload.additional_info = input.additional_info;
  if (input.payout_currency) payload.payout_currency = input.payout_currency;
  if (input.specific_country) payload.specific_country = input.specific_country;
  const body = await sogoRequest<any>("POST", "/gift-cards/sell", { body: payload, reference: input.reference });
  return unwrap(body, {});
}

// ===========================================================================
// TRANSACTIONS
// ===========================================================================

/** Fetch a Sogo transaction by reference (404 in sandbox — not persisted). */
export async function getTransaction(reference: string, timeoutMs = 60_000): Promise<any> {
  const body = await sogoRequest<any>("GET", `/transactions/${encodeURIComponent(reference)}`, { timeoutMs });
  return unwrap(body, {});
}

/** Payment verification (verified:false + reason on mismatch). */
export async function verifyTransaction(input: { reference: string; amount?: number; currency?: string }): Promise<any> {
  const body = await sogoRequest<any>("POST", "/transactions/verify", {
    body: {
      reference: input.reference,
      ...(input.amount != null ? { amount: input.amount } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
    },
  });
  return unwrap(body, {});
}

// ===========================================================================
// WEBHOOKS
// ===========================================================================

/**
 * Verify X-Sogo-Signature-256: "sha256=" + HMAC_SHA256(rawBody, secret),
 * timing-safe. Requires SOGO_WEBHOOK_SECRET in the server env.
 *
 * Liberal on the RECEIVED format, strict on the HMAC itself:
 *   - the "sha256=" scheme prefix is OPTIONAL (Swagger UI, curl one-liners
 *     and some gateways send the bare hex digest);
 *   - hex is case-insensitive.
 * The digest must still be the HMAC-SHA256 of the EXACT raw request bytes —
 * re-serialized JSON will never match.
 */
export function verifySogoWebhook(rawBody: Buffer | string, signature: string | undefined | null): boolean {
  const secret = webhookSecret();
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody as any).digest("hex");
  const received = String(signature).trim().replace(/^sha256=/i, "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false; // not a sha-256 hex digest
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * True only when the server actually has a signing secret configured. The
 * webhook handler uses this to answer 503 (misconfiguration) instead of 401
 * (bad signature) — otherwise an unconfigured secret is indistinguishable
 * from a wrong signature and sends the operator debugging the wrong thing.
 */
export function sogoWebhookSecretConfigured(): boolean {
  return !!webhookSecret();
}

/** Normalize the sandbox environment for tests that need the sandbox host. */
export function sandboxInfo(): { base_url: string; key_kind: string; sandbox: boolean } {
  return { base_url: sogoBaseUrl(), key_kind: sogoKeyKind(), sandbox: isSogoSandbox() };
}
