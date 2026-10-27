import express from "express";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";
import { createNotification } from "../../services/notifications";
import { evaluateOutflow, fraudRejectReason } from "../../services/fraud";
import * as bitnob from "../../services/providers/bitnob";
import * as sogo from "../../services/sogo";
import { getActiveProvider } from "./provider-routing";
import { requirePersonalService, useProvider, getPercent } from "./flags";
import { verifyTransactionPin, requirePersonalKyc } from "./personal-utils";

/**
 * Stablecoin hub (USDT + USDC) — the replacement for the retired "USD wallet".
 *
 * Flows (Bitnob Genesis stablecoin + trading APIs, https://bitnob.dev):
 *   RECEIVE   POST /api/addresses            per-user deposit address (per coin, per chain)
 *             webhook deposit.success        → credit the user's USDT/USDC wallet
 *   CONVERT   POST /api/trading/quotes       lock a rate (stablecoin ↔ NGN)
 *             POST /api/trading/orders       execute; NGN lands in Bitnob NGN wallet
 *                                            → credit/debit the user's platform wallets
 *   SEND      POST /api/withdrawals          on-chain payout to an external address
 *             POST /api/addresses/validate   destination address validation (fraud gate)
 *
 * Fraud hardening (defence in depth):
 *   - webhooks: HMAC-SHA512 (+ SHA256 legacy) signature verification, event-id
 *     de-duplication (replay-proof), address binding (only addresses we issued),
 *     currency/chain matching, minimum deposit ($1 per Bitnob), and a
 *     server-side transaction lookup that cross-checks amount/currency/address.
 *   - conversions & withdrawals: transaction-PIN gate, outflow fraud engine,
 *     per-coin min/max clamps, unique references (idempotency), and wallet
 *     debits guarded by `balance >= amount` atomic UPDATEs (refund on failure).
 *
 * When Bitnob is not configured (or the Personal Products console routes the
 * service to the simulator) every flow degrades to a built-in SIMULATOR so the
 * product stays testable end-to-end in non-production environments.
 */

const router = express.Router();
router.use(requirePersonalService("crypto"));

const STABLECOINS = ["USDT", "USDC"] as const;
type Stablecoin = (typeof STABLECOINS)[number];

const MIN_CONVERT_CRYPTO = 2;         // 2 USDT/USDC per conversion (Bitnob min $1)
const MAX_CONVERT_CRYPTO = 50_000;    // per single conversion
const MIN_CONVERT_NGN = 2_000;        // ₦2,000 minimum when buying stablecoins
const MAX_CONVERT_NGN = 80_000_000;   // per single conversion
const MIN_WITHDRAW_CRYPTO = 2;        // $2 — network fees make dust uneconomical
const MAX_WITHDRAW_CRYPTO = 20_000;
const MAX_ADDRESSES_PER_USER_PER_DAY = 20;

// Fallback chains (Bitnob production support matrix — refreshed from
// GET /api/stablecoins/supported-chains when the provider is live).
const FALLBACK_CHAINS: Record<Stablecoin, string[]> = {
    USDT: ["ethereum", "tron", "solana", "polygon", "avalanche", "bsc", "arbitrum", "optimism", "plasma"],
    USDC: ["ethereum", "solana", "polygon", "avalanche", "base", "bsc", "arbitrum", "optimism"],
};

// SOGO ROUTING — when the Personal provider routing toggles crypto to sogo,
// deposit-address generation moves off Bitnob. Sogo settles on-chain
// stablecoin deposits to the user's NGN wallet through /webhook/sogo (the
// deposit IS the conversion — that is the product the owner wants on Sogo).
const SOGO_CHAINS: Record<Stablecoin, string[]> = {
    USDT: ["tron", "ethereum", "bsc"],
    USDC: ["ethereum", "tron", "bsc"],
};

/** Our chain names -> Sogo network slugs (their API speaks trc20/erc20/bep20). */
const SOGO_NETWORK_BY_CHAIN: Record<string, string> = {
    tron: "trc20",
    ethereum: "erc20",
    bsc: "bep20",
    "bnb-smart-chain": "bep20",
    polygon: "polygon",
    solana: "solana",
};

// Local address format gates — first line of defence before Bitnob validates.
const CHAIN_ADDRESS_RE: Record<string, RegExp> = {
    ethereum: /^0x[a-fA-F0-9]{40}$/,
    bsc: /^0x[a-fA-F0-9]{40}$/,
    polygon: /^0x[a-fA-F0-9]{40}$/,
    avalanche: /^0x[a-fA-F0-9]{40}$/,
    base: /^0x[a-fA-F0-9]{40}$/,
    arbitrum: /^0x[a-fA-F0-9]{40}$/,
    optimism: /^0x[a-fA-F0-9]{40}$/,
    plasma: /^0x[a-fA-F0-9]{40}$/,
    tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    stellar: /^G[A-Z2-7]{55}$/,
    bitcoin: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
};

function localAddressLooksValid(chain: string, address: string): boolean {
    const re = CHAIN_ADDRESS_RE[String(chain || "").toLowerCase()];
    return re ? re.test(String(address || "").trim()) : false;
}

async function bitnobLive(): Promise<boolean> {
    return useProvider("crypto", bitnob.isBitnobConfigured());
}

function randomReference(prefix: string): string {
    return `${prefix}_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

const n2 = (v: number) => Math.round(Number(v || 0) * 100) / 100;
const n8 = (v: number) => Math.round(Number(v || 0) * 1e8) / 1e8;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export async function ensureStablecoinSchema(): Promise<void> {
    await query(`
    CREATE TABLE IF NOT EXISTS stablecoin_addresses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      currency VARCHAR(8) NOT NULL,                       -- USDT | USDC
      chain VARCHAR(20) NOT NULL,                         -- tron | ethereum | ...
      address VARCHAR(160) NOT NULL,
      bitnob_id VARCHAR(80),
      label VARCHAR(120),
      reference VARCHAR(80) UNIQUE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',       -- active | retired
      provider VARCHAR(20) NOT NULL DEFAULT 'bitnob',     -- bitnob | simulator
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, currency, chain)
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sc_addresses_user ON stablecoin_addresses(user_id, currency)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sc_addresses_lookup ON stablecoin_addresses(address, chain)`);

    // PROVIDER MIGRATION support: the original UNIQUE(user_id, currency,
    // chain) blocks retiring a legacy Bitnob row and issuing a Sogo row for
    // the same (user, coin, chain) — the owner directive is exactly that
    // regeneration. Replace it with a PARTIAL unique index over ACTIVE rows
    // so retired rows keep their history (and their address stays queryable
    // for late webhook deposits) without blocking re-issuance.
    await query(`ALTER TABLE stablecoin_addresses DROP CONSTRAINT IF EXISTS stablecoin_addresses_user_id_currency_chain_key`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sc_addresses_active ON stablecoin_addresses (user_id, currency, chain) WHERE status = 'active'`);
    await query(`ALTER TABLE stablecoin_addresses ADD COLUMN IF NOT EXISTS provider_ref VARCHAR(120)`);

    await query(`
    CREATE TABLE IF NOT EXISTS stablecoin_deposits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      address_id UUID,
      currency VARCHAR(8) NOT NULL,
      chain VARCHAR(20),
      address VARCHAR(160),
      amount DECIMAL(20,8) NOT NULL DEFAULT 0,
      tx_hash VARCHAR(160),
      event_id VARCHAR(160) UNIQUE,                       -- webhook de-dup (replay-proof)
      status VARCHAR(20) NOT NULL DEFAULT 'pending',      -- pending | credited | rejected
      rejection_reason TEXT,
      verification JSONB,                                 -- server-side tx cross-check
      credited_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sc_deposits_user ON stablecoin_deposits(user_id, created_at DESC)`);

    await query(`
    CREATE TABLE IF NOT EXISTS stablecoin_conversions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      reference VARCHAR(80) UNIQUE NOT NULL,
      direction VARCHAR(16) NOT NULL,                     -- stable_to_naira | naira_to_stable
      currency VARCHAR(8) NOT NULL,                       -- USDT | USDC
      crypto_amount DECIMAL(20,8),
      ngn_amount DECIMAL(15,2),
      rate DECIMAL(18,6),
      fee DECIMAL(15,2) DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',      -- quoted|pending|processing|completed|failed
      quote_id VARCHAR(80),
      order_id VARCHAR(80),
      provider VARCHAR(20) NOT NULL DEFAULT 'bitnob',
      provider_response JSONB,
      failure_reason TEXT,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sc_conversions_user ON stablecoin_conversions(user_id, created_at DESC)`);

    await query(`
    CREATE TABLE IF NOT EXISTS stablecoin_withdrawals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      wallet_id UUID,
      reference VARCHAR(80) UNIQUE NOT NULL,
      currency VARCHAR(8) NOT NULL,
      chain VARCHAR(20) NOT NULL,
      to_address VARCHAR(160) NOT NULL,
      amount DECIMAL(20,8) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',      -- pending|processing|completed|failed
      provider VARCHAR(20) NOT NULL DEFAULT 'bitnob',
      provider_reference VARCHAR(120),
      provider_response JSONB,
      failure_reason TEXT,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sc_withdrawals_user ON stablecoin_withdrawals(user_id, created_at DESC)`);

    // Webhook event ledger — unique (provider, event_id) makes replay impossible.
    await query(`
    CREATE TABLE IF NOT EXISTS provider_webhook_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider VARCHAR(20) NOT NULL,
      event_id VARCHAR(160) NOT NULL,
      event_type VARCHAR(80),
      payload JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider, event_id)
    )`);

    // Stablecoin amounts need > VARCHAR(3) currency storage on wallets AND on
    // the ledger: transactions.currency (VARCHAR(3)) cannot hold "USDT".
    await query(`ALTER TABLE wallets ALTER COLUMN currency TYPE VARCHAR(8)`);
    // Ledger types like "stablecoin_withdrawal" exceed the legacy VARCHAR(12)
    // on transactions.transaction_type.
    await query(`ALTER TABLE transactions ALTER COLUMN transaction_type TYPE VARCHAR(32)`);
    await query(`ALTER TABLE transactions ALTER COLUMN currency TYPE VARCHAR(8)`);
    // Older boots created direction as VARCHAR(12) — "stable_to_naira" needs 15.
    await query(`ALTER TABLE stablecoin_conversions ALTER COLUMN direction TYPE VARCHAR(16)`);
}

// ---------------------------------------------------------------------------
// Wallet helpers
// ---------------------------------------------------------------------------
async function getUserStableWallet(userId: string, currency: string) {
    const r = await query(
        `SELECT * FROM wallets WHERE user_id = $1 AND UPPER(currency) = $2 AND status = 'active' LIMIT 1`,
        [userId, String(currency).toUpperCase()],
    );
    if (r.rows.length) return r.rows[0];
    // Lazy-provision (mirrors GET /wallet behaviour).
    const created = await query(
        `INSERT INTO wallets (user_id, balance, currency, status) VALUES ($1, 0, $2, 'active')
         ON CONFLICT (user_id, currency) DO UPDATE SET status = 'active' RETURNING *`,
        [userId, String(currency).toUpperCase()],
    );
    return created.rows[0];
}

async function getUserNgnWallet(userId: string) {
    const r = await query(
        `SELECT * FROM wallets WHERE user_id = $1 AND UPPER(currency) = 'NGN' AND status = 'active' LIMIT 1`,
        [userId],
    );
    if (r.rows.length) return r.rows[0];
    const created = await query(
        `INSERT INTO wallets (user_id, balance, currency, status) VALUES ($1, 0, 'NGN', 'active')
         ON CONFLICT (user_id, currency) DO UPDATE SET status = 'active' RETURNING *`,
        [userId],
    );
    return created.rows[0];
}

async function debitWallet(walletId: string, amount: number): Promise<boolean> {
    const r = await query(
        `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND balance >= $1 AND status = 'active' RETURNING balance`,
        [amount, walletId],
    );
    return r.rows.length > 0;
}

async function creditWalletById(walletId: string, amount: number): Promise<void> {
    await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [amount, walletId]);
}

async function insertLedger(opts: {
    userId: string; walletId: string; reference: string; type: "credit" | "debit";
    transactionType: string; amount: number; currency: string; description: string;
}) {
    await query(
        `INSERT INTO transactions
           (business_id, user_id, amount, currency, status, reference, type, description,
            transaction_type, wallet_id, direction, fee)
         VALUES (NULL, $1, $2, $3, 'success', $4, $5, $6, $7, $8, $9, 0)
         ON CONFLICT (reference) DO NOTHING`,
        [opts.userId, opts.amount, opts.currency, opts.reference, opts.type, opts.description,
         opts.transactionType, opts.walletId, opts.type],
    );
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------
/** Simulator rate — a believable NGN/USDT market band, jittered per call. */
function simRate(): number {
    return Math.round((1545 + Math.random() * 30) * 100) / 100;
}

/** Admin spread (crypto_spread_percent, default 1%) shrinks what the user receives. */
async function receiveAfterSpread(value: number): Promise<number> {
    const spread = await getPercent("crypto_spread_percent", 1);
    return n2(value * (1 - spread / 100));
}

/** Live mid-market rate for 1 <coin> in NGN (Bitnob exchange-rates → convert API → simulator). */
async function stableNgnRate(currency: Stablecoin): Promise<{ rate: number; mode: string }> {
    if (await bitnobLive()) {
        // Preferred: GET /api/exchange-rates?from=&to= — returns buy_rate,
        // sell_rate and mid_rate (docs: Exchange Rates). mid_rate is the fair
        // display rate; the trading quote prices the actual execution.
        try {
            const r = await bitnob.getExchangeRate(currency, "NGN");
            const d = r?.data || {};
            const rate = Number(d.mid_rate ?? d.midRate ?? d.sell_rate ?? d.buy_rate);
            if (rate > 10) return { rate: Math.round(rate * 100) / 100, mode: "bitnob" };
        } catch { /* try next */ }
        // Fallback: GET /api/exchange-rates/convert (1 USDT → NGN, sell_rate).
        try {
            const c = await bitnob.convertAmount(currency, "NGN", 1);
            const rate = Number(c?.data?.rate_used || c?.data?.to_amount);
            if (rate > 10) return { rate: Math.round(rate * 100) / 100, mode: "bitnob" };
        } catch { /* fall through */ }
    }
    return { rate: simRate(), mode: "simulator" };
}

/** Bitnob trading quote (stable→NGN SELL, NGN→stable SELL-NGN) with graceful simulator fallback. */
async function createConversionQuote(direction: "stable_to_naira" | "naira_to_stable", currency: Stablecoin, amount: number) {
    if (await bitnobLive()) {
        try {
            // Docs: quote request = exactly 4 fields; side lowercase; quantity
            // is denominated in the BASE currency.
            const body = direction === "stable_to_naira"
                ? { base_currency: currency, quote_currency: "NGN", side: "SELL" as const, quantity: String(n8(amount)) }
                : { base_currency: "NGN", quote_currency: currency, side: "SELL" as const, quantity: String(n2(amount)) };
            const q = await bitnob.createTradingQuote(body);
            const quote = q?.data?.quote;
            if (quote?.id) {
                const ex = quote.exchange || {};
                return {
                    mode: "bitnob" as const,
                    quote_id: String(quote.id),
                    price: Number(quote.price || 0),
                    // receive leg: NGN out (stable→naira) or stablecoin out (naira→stable)
                    receive_amount: Number(ex.receive_quantity ?? 0),
                    receive_currency: String(ex.receive_currency || (direction === "stable_to_naira" ? "NGN" : currency)).toUpperCase(),
                    send_amount: Number(ex.send_quantity ?? amount),
                    expires_at: quote.expires_at || null,
                    raw: quote,
                };
            }
        } catch (e: any) {
            console.error("[stablecoin] trading quote failed:", e?.message);
            throw new Error(e?.message || "Bitnob quote failed");
        }
    }
    // Simulator
    const rate = simRate();
    return direction === "stable_to_naira"
        ? { mode: "simulator" as const, quote_id: `SIMQ_${randomReference("SC")}`, price: rate, receive_amount: n2(amount * rate), receive_currency: "NGN", send_amount: n8(amount), expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), raw: {} }
        : { mode: "simulator" as const, quote_id: `SIMQ_${randomReference("SC")}`, price: rate, receive_amount: n8(amount / rate), receive_currency: currency, send_amount: n2(amount), expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), raw: {} };
}

/** Submit the trading order against a quote. Returns the Bitnob order (or simulator no-op). */
async function submitConversionOrder(input: {
    mode: "bitnob" | "simulator"; direction: "stable_to_naira" | "naira_to_stable";
    currency: Stablecoin; amount: number; quote: Awaited<ReturnType<typeof createConversionQuote>>; reference: string;
}): Promise<{ orderId: string | null; status: string; filled: boolean; raw: any }> {
    if (input.mode === "simulator") return { orderId: null, status: "filled", filled: true, raw: {} };
    const { currency, direction, amount, quote, reference } = input;
    const body = direction === "stable_to_naira"
        ? { base_currency: currency, quote_currency: "NGN", side: "SELL" as const, quantity: String(n8(amount)), quote_id: quote.quote_id, reference }
        : { base_currency: "NGN", quote_currency: currency, side: "SELL" as const, quantity: String(n2(amount)), price: String(quote.price || ""), quote_id: quote.quote_id, quantity_in_base_units: false, reference };
    const r = await bitnob.createTradingOrder(body);
    const order = r?.data?.order || {};
    const fills = r?.data?.fills || [];
    const filled = String(order.status || "").toLowerCase() === "filled" || fills.length > 0 || Number(order.filled_quantity || 0) > 0;
    return { orderId: String(order.id || ""), status: String(order.status || "pending"), filled, raw: r?.data || order };
}

/**
 * Settle a conversion from its Bitnob order state: credit the destination
 * wallet once the order is filled; refund the source wallet when it failed.
 * Safe to call repeatedly (status guards + idempotent ledger).
 * Exported for the trading-order webhook path in personal-webhooks.ts.
 */
export async function settleConversion(ref: string): Promise<any> {
    const r = await query(`SELECT * FROM stablecoin_conversions WHERE reference = $1 LIMIT 1`, [ref]);
    const conv = r.rows[0];
    if (!conv || ["completed", "failed"].includes(conv.status)) return conv;
    if (conv.provider !== "bitnob" || !conv.order_id) return conv;

    let order: any = null;
    try {
        const o = await bitnob.getTradingOrder(conv.order_id);
        order = o?.data?.order || null;
    } catch (e: any) {
        console.warn("[stablecoin] order poll failed:", e?.message);
        return conv; // try again on the next poll
    }
    const status = String(order?.status || "").toLowerCase();
    const filledQty = Number(order?.filled_quantity || 0);

    if (status === "filled" || (filledQty > 0 && ["pending", "partially_filled", "processing"].includes(status))) {
        // Value of the fill: recompute from the conversion's stored amounts.
        const credit = await receiveAfterSpread(
            conv.direction === "stable_to_naira" ? Number(conv.ngn_amount || 0) : Number(conv.crypto_amount || 0),
        );
        if (conv.direction === "stable_to_naira") {
            const ngn = await getUserNgnWallet(conv.user_id);
            await creditWalletById(ngn.id, credit);
            await insertLedger({
                userId: conv.user_id, walletId: ngn.id, reference: `${conv.reference}-IN`, type: "credit",
                transactionType: "stablecoin_convert", amount: credit, currency: "NGN",
                description: `Stablecoin conversion — ${conv.currency} ${Number(conv.crypto_amount)} → ₦${credit.toLocaleString()}`,
            });
        } else {
            const sw = await getUserStableWallet(conv.user_id, conv.currency);
            const stableCredit = n8(credit);
            await creditWalletById(sw.id, stableCredit);
            await insertLedger({
                userId: conv.user_id, walletId: sw.id, reference: `${conv.reference}-IN`, type: "credit",
                transactionType: "stablecoin_convert", amount: stableCredit, currency: conv.currency,
                description: `Stablecoin conversion — ₦${Number(conv.ngn_amount).toLocaleString()} → ${stableCredit} ${conv.currency}`,
            });
        }
        await query(
            `UPDATE stablecoin_conversions SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP, provider_response = provider_response || $2::jsonb WHERE id = $1`,
            [conv.id, JSON.stringify({ settled_order: order })],
        );
        createNotification({
            userId: conv.user_id, type: "transaction", title: "Conversion completed",
            message: conv.direction === "stable_to_naira"
                ? `₦${credit.toLocaleString()} credited — your ${conv.currency} conversion is done.`
                : `${credit} ${conv.currency} credited — your naira conversion is done.`,
        }).catch(() => {});
    } else if (["cancelled", "rejected", "expired", "failed"].includes(status)) {
        // Refund the source wallet.
        if (conv.direction === "stable_to_naira") {
            const sw = await getUserStableWallet(conv.user_id, conv.currency);
            await creditWalletById(sw.id, Number(conv.crypto_amount || 0));
            await insertLedger({
                userId: conv.user_id, walletId: sw.id, reference: `${conv.reference}-RF`, type: "credit",
                transactionType: "stablecoin_convert_refund", amount: Number(conv.crypto_amount || 0),
                currency: conv.currency, description: "Conversion failed — stablecoin refunded",
            });
        } else {
            const ngn = await getUserNgnWallet(conv.user_id);
            await creditWalletById(ngn.id, Number(conv.ngn_amount || 0));
            await insertLedger({
                userId: conv.user_id, walletId: ngn.id, reference: `${conv.reference}-RF`, type: "credit",
                transactionType: "stablecoin_convert_refund", amount: Number(conv.ngn_amount || 0),
                currency: "NGN", description: "Conversion failed — naira refunded",
            });
        }
        await query(
            `UPDATE stablecoin_conversions SET status = 'failed', failure_reason = $2,
               updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [conv.id, `Bitnob order ${status}`],
        );
    }
    const refreshed = await query(`SELECT * FROM stablecoin_conversions WHERE id = $1`, [conv.id]);
    return refreshed.rows[0];
}

// ---------------------------------------------------------------------------
// Public row shapers
// ---------------------------------------------------------------------------
function publicAddress(row: any) {
    return {
        id: row.id, currency: row.currency, chain: row.chain, address: row.address,
        label: row.label, status: row.status, provider: row.provider, created_at: row.created_at,
    };
}

/**
 * Create (or fetch) a Sogo deposit address for (user, coin, chain) and
 * DUAL-REGISTER it in crypto_deposit_addresses — the sogo deposit webhook
 * resolves address ownership through that table, so a deposit sent to a
 * hub-issued address settles to the user's NGN wallet end-to-end.
 */
async function createSogoDepositAddress(userId: string, currency: Stablecoin, chain: string): Promise<{ address: string; providerRef: string | null }> {
    const network = SOGO_NETWORK_BY_CHAIN[chain];
    const reference = randomReference("SOGOADDR");
    const created = await sogo.cryptoCreateDepositAddress(currency, network, reference);
    const address = String(created?.address || created?.deposit_address || created?.data?.address || "").trim();
    if (!address) throw new Error("Sogo returned no deposit address");
    const providerRef = created?.id != null ? String(created.id) : (created?.reference ? String(created.reference) : null);
    await query(
        `INSERT INTO crypto_deposit_addresses (user_id, provider, asset, network, address, extra)
         VALUES ($1, 'sogo', $2, $3, $4, $5::jsonb)
         ON CONFLICT (user_id, asset, network, provider)
         DO UPDATE SET address = EXCLUDED.address, extra = EXCLUDED.extra, updated_at = CURRENT_TIMESTAMP`,
        [userId, currency, network || chain, address, JSON.stringify({ stablecoin_chain: chain, provider_ref: providerRef })],
    );
    return { address, providerRef };
}

/** Issue a fresh sogo-backed row in stablecoin_addresses. */
async function insertSogoAddressRow(userId: string, currency: Stablecoin, chain: string, address: string, providerRef: string | null) {
    return query(
        `INSERT INTO stablecoin_addresses (user_id, currency, chain, address, label, reference, provider, provider_ref)
         VALUES ($1, $2, $3, $4, $5, $6, 'sogo', $7) RETURNING *`,
        [userId, currency, chain, address, `metroflow:${userId.slice(0, 8)}:${currency}`, randomReference("ADDR"), providerRef],
    );
}
function publicConversion(row: any) {
    return {
        id: row.id, reference: row.reference, direction: row.direction, currency: row.currency,
        crypto_amount: row.crypto_amount != null ? Number(row.crypto_amount) : null,
        ngn_amount: row.ngn_amount != null ? Number(row.ngn_amount) : null,
        rate: row.rate != null ? Number(row.rate) : null,
        status: row.status, quote_id: row.quote_id, order_id: row.order_id,
        failure_reason: row.failure_reason, created_at: row.created_at, completed_at: row.completed_at,
    };
}
function publicWithdrawal(row: any) {
    return {
        id: row.id, reference: row.reference, currency: row.currency, chain: row.chain,
        to_address: row.to_address, amount: Number(row.amount), status: row.status,
        failure_reason: row.failure_reason, created_at: row.created_at, completed_at: row.completed_at,
    };
}
function publicDeposit(row: any) {
    return {
        id: row.id, currency: row.currency, chain: row.chain, amount: Number(row.amount),
        tx_hash: row.tx_hash, status: row.status, created_at: row.created_at, credited_at: row.credited_at,
    };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /crypto/stablecoin/chains — supported deposit networks per coin. */
router.get("/chains", authenticateToken, checkSubscriptionStatus, async (_req: AuthenticatedRequest, res) => {
    const provider = await getActiveProvider("crypto");
    if (provider === "sogo") {
        return res.json({ success: true, data: { chains: SOGO_CHAINS, mode: "sogo" } });
    }
    if (await bitnobLive()) {
        try {
            const r = await bitnob.getSupportedStablecoinChains();
            const chains = r?.data?.chains || [];
            const shaped: Record<string, string[]> = { USDT: [], USDC: [] };
            for (const c of chains) {
                for (const s of c.stablecoins || []) {
                    const sym = String(s.symbol || "").toUpperCase();
                    if (sym in shaped && c.chain !== "bitcoin") shaped[sym].push(String(c.chain));
                }
            }
            if (shaped.USDT.length || shaped.USDC.length) {
                return res.json({ success: true, data: { chains: shaped, mode: "bitnob" } });
            }
        } catch (e: any) {
            console.error("[stablecoin] supported-chains failed:", e?.message);
        }
    }
    return res.json({ success: true, data: { chains: FALLBACK_CHAINS, mode: "simulator" } });
});

/** GET /crypto/stablecoin/addresses — the caller's deposit addresses. */
router.get("/addresses", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const select = () => query(
        `SELECT * FROM stablecoin_addresses WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 60`,
        [userId],
    );
    let rows = (await select()).rows;

    // PROVIDER MIGRATION — when crypto routing flips to sogo, existing active
    // Bitnob addresses are regenerated on Sogo the first time the wallet is
    // opened (owner directive: "some wallet addresses were generated using
    // bitnob, regenerate them as Sogo is toggled ON"). Best-effort per chain:
    // a Sogo outage keeps the legacy address active rather than stranding the
    // user with nothing.
    const provider = await getActiveProvider("crypto");
    if (provider === "sogo") {
        const stale = rows.filter((r: any) => r.provider !== "sogo" && (SOGO_CHAINS as Record<string, string[]>)[r.currency]?.includes(r.chain));
        for (const s of stale.slice(0, 4)) {
            try {
                await query(`UPDATE stablecoin_addresses SET status = 'retired', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [s.id]);
                const { address, providerRef } = await createSogoDepositAddress(userId, s.currency as Stablecoin, s.chain);
                await insertSogoAddressRow(userId, s.currency as Stablecoin, s.chain, address, providerRef);
            } catch (e: any) {
                console.warn("[stablecoin] sogo regeneration failed, keeping legacy address:", e?.message);
                await query(`UPDATE stablecoin_addresses SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'retired'`, [s.id]).catch(() => {});
            }
        }
        if (stale.length) rows = (await select()).rows;
    }

    res.json({ success: true, data: { addresses: rows.map(publicAddress), mode: provider } });
});

/**
 * POST /crypto/stablecoin/addresses { currency, chain }
 * Generate (or re-use) a deposit address. One address per user per coin per
 * chain — re-issuance keeps reconciliation clean and dodges address-farming.
 */
router.post("/addresses", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const currency = String(req.body?.currency || "").toUpperCase() as Stablecoin;
    const chain = String(req.body?.chain || "").toLowerCase().trim();
    if (!STABLECOINS.includes(currency)) {
        return res.status(400).json({ success: false, error: "currency must be USDT or USDC" });
    }

    // Chain must be supported for this coin — by the ACTIVE provider.
    const provider = await getActiveProvider("crypto");
    let chains: string[];
    let mode = provider;
    if (provider === "sogo") {
        chains = SOGO_CHAINS[currency];
    } else if (provider === "bitnob") {
        let live: string[] | null = null;
        try {
            const r = await bitnob.getSupportedStablecoinChains();
            live = (r?.data?.chains || [])
                .filter((c: any) => c.chain !== "bitcoin")
                .filter((c: any) => (c.stablecoins || []).some((s: any) => String(s.symbol || "").toUpperCase() === currency))
                .map((c: any) => String(c.chain));
        } catch { /* fallback list */ }
        if (live && live.length) { chains = live; } else { chains = FALLBACK_CHAINS[currency]; mode = "simulator"; }
    } else {
        chains = FALLBACK_CHAINS[currency];
        mode = "simulator";
    }
    if (!chain || !chains.includes(chain)) {
        return res.status(400).json({ success: false, error: `chain must be one of: ${chains.join(", ")}`, supported: chains });
    }

    // Fraud/abuse gate: address-farming rate limit.
    const recent = await query(
        `SELECT COUNT(*)::int AS n FROM stablecoin_addresses
         WHERE user_id = $1 AND created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'`,
        [userId],
    );
    if ((recent.rows[0]?.n || 0) >= MAX_ADDRESSES_PER_USER_PER_DAY) {
        return res.status(429).json({ success: false, error: "Too many addresses requested today — try again tomorrow." });
    }

    // Re-use an existing ACTIVE address for this (user, coin, chain) — but
    // ONLY one issued by the currently active provider. When the routing
    // toggles (bitnob -> sogo) the legacy row is retired below and a fresh
    // address is issued, per the owner directive.
    const existing = await query(
        `SELECT * FROM stablecoin_addresses WHERE user_id = $1 AND currency = $2 AND chain = $3 AND status = 'active' AND provider = $4 LIMIT 1`,
        [userId, currency, chain, mode],
    );
    if (existing.rows.length) {
        return res.json({ success: true, data: { address: publicAddress(existing.rows[0]), reused: true, mode: existing.rows[0].provider } });
    }

    // Retire cross-provider actives for this (user, coin, chain) — the
    // regeneration. Retired rows keep their address queryable so a late
    // deposit to the old Bitnob address still credits its owner.
    await query(
        `UPDATE stablecoin_addresses SET status = 'retired', updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND currency = $2 AND chain = $3 AND status = 'active' AND provider <> $4`,
        [userId, currency, chain, mode],
    );

    const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [userId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    if (mode === "sogo") {
        try {
            const { address, providerRef } = await createSogoDepositAddress(userId, currency, chain);
            const ins = await insertSogoAddressRow(userId, currency, chain, address, providerRef);
            return res.json({ success: true, data: { address: publicAddress(ins.rows[0]), reused: false, mode: "sogo" } });
        } catch (e: any) {
            console.error("[stablecoin] sogo address generation failed:", e?.message);
            return res.status(502).json({ success: false, error: e?.message || "Could not generate a deposit address right now" });
        }
    }

    if (mode === "bitnob") {
        const reference = randomReference("ADDR");
        try {
            const created = await bitnob.createAddress({
                chain,
                customer_email: String(user.email),
                label: `metroflow:${userId.slice(0, 8)}:${currency}`,
                reference,
            });
            const a = created?.data || {};
            const address = String(a.address || "");
            if (!address) throw new Error("Provider returned no address");
            const ins = await query(
                `INSERT INTO stablecoin_addresses (user_id, currency, chain, address, bitnob_id, label, reference, provider)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'bitnob') RETURNING *`,
                [userId, currency, chain, address, a.id ? String(a.id) : null, `metroflow:${userId.slice(0, 8)}:${currency}`, reference],
            );
            return res.json({ success: true, data: { address: publicAddress(ins.rows[0]), reused: false, mode: "bitnob" } });
        } catch (e: any) {
            console.error("[stablecoin] address generation failed:", e?.message);
            return res.status(502).json({ success: false, error: e?.message || "Could not generate a deposit address right now" });
        }
    }

    // Simulator address (obviously test-only prefix so nobody sends real funds).
    const reference = randomReference("SIMADDR");
    const simAddr = `sim1${chain.slice(0, 4)}${randomReference("x").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 28)}`;
    const ins = await query(
        `INSERT INTO stablecoin_addresses (user_id, currency, chain, address, label, reference, provider)
         VALUES ($1, $2, $3, $4, $5, $6, 'simulator') RETURNING *`,
        [userId, currency, chain, simAddr, `metroflow:${userId.slice(0, 8)}:${currency}`, reference],
    );
    res.json({ success: true, data: { address: publicAddress(ins.rows[0]), reused: false, mode: "simulator" } });
});

/** GET /crypto/stablecoin/rate?currency=USDT — live stablecoin → NGN rate. */
router.get("/rate", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const currency = String(req.query.currency || "USDT").toUpperCase() as Stablecoin;
    if (!STABLECOINS.includes(currency)) return res.status(400).json({ success: false, error: "currency must be USDT or USDC" });
    const { rate, mode } = await stableNgnRate(currency);
    res.json({ success: true, data: { currency, rate, mode, fetched_at: new Date().toISOString() } });
});

/**
 * POST /crypto/stablecoin/convert/quote { direction, currency, amount }
 * direction: stable_to_naira (amount in coin) | naira_to_stable (amount in NGN)
 */
router.post("/convert/quote", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const direction = String(req.body?.direction || "");
    const currency = String(req.body?.currency || "USDT").toUpperCase() as Stablecoin;
    const amount = Number(req.body?.amount);
    if (!["stable_to_naira", "naira_to_stable"].includes(direction)) {
        return res.status(400).json({ success: false, error: "direction must be stable_to_naira or naira_to_stable" });
    }
    if (!STABLECOINS.includes(currency)) return res.status(400).json({ success: false, error: "currency must be USDT or USDC" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "amount is required" });
    if (direction === "stable_to_naira" && (amount < MIN_CONVERT_CRYPTO || amount > MAX_CONVERT_CRYPTO)) {
        return res.status(400).json({ success: false, error: `amount must be between ${MIN_CONVERT_CRYPTO} and ${MAX_CONVERT_CRYPTO.toLocaleString()} ${currency}` });
    }
    if (direction === "naira_to_stable" && (amount < MIN_CONVERT_NGN || amount > MAX_CONVERT_NGN)) {
        return res.status(400).json({ success: false, error: `amount must be between ₦${MIN_CONVERT_NGN.toLocaleString()} and ₦${MAX_CONVERT_NGN.toLocaleString()}` });
    }
    try {
        const quote = await createConversionQuote(direction as any, currency, amount);
        const credit = await receiveAfterSpread(quote.receive_amount);
        return res.json({
            success: true,
            data: {
                direction, currency, amount,
                quote_id: quote.quote_id,
                rate: quote.price,
                you_receive: credit,
                receive_currency: quote.receive_currency,
                expires_at: quote.expires_at,
                mode: quote.mode,
            },
        });
    } catch (e: any) {
        return res.status(502).json({ success: false, error: e?.message || "Quote unavailable right now" });
    }
});

/**
 * POST /crypto/stablecoin/convert { direction, currency, amount, pin, quote_id? }
 * Executes the conversion end-to-end: debit source wallet → Bitnob trade →
 * credit destination wallet (spread applied). Refund on any failure.
 */
router.post("/convert", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const direction = String(req.body?.direction || "");
    const currency = String(req.body?.currency || "USDT").toUpperCase() as Stablecoin;
    const amount = Number(req.body?.amount);
    const pin = typeof req.body?.pin === "string" ? req.body.pin : undefined;
    if (!["stable_to_naira", "naira_to_stable"].includes(direction)) {
        return res.status(400).json({ success: false, error: "direction must be stable_to_naira or naira_to_stable" });
    }
    if (!STABLECOINS.includes(currency)) return res.status(400).json({ success: false, error: "currency must be USDT or USDC" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "amount is required" });
    if (direction === "stable_to_naira" && (amount < MIN_CONVERT_CRYPTO || amount > MAX_CONVERT_CRYPTO)) {
        return res.status(400).json({ success: false, error: `amount must be between ${MIN_CONVERT_CRYPTO} and ${MAX_CONVERT_CRYPTO.toLocaleString()} ${currency}` });
    }
    if (direction === "naira_to_stable" && (amount < MIN_CONVERT_NGN || amount > MAX_CONVERT_NGN)) {
        return res.status(400).json({ success: false, error: `amount must be between ₦${MIN_CONVERT_NGN.toLocaleString()} and ₦${MAX_CONVERT_NGN.toLocaleString()}` });
    }

    // Transaction PIN (personal or business hash — same policy as wallet swap).
    const pinCheck = await verifyTransactionPin(pin, { userId, businessId: (req.user as any).businessId || null, wallet: null as any });
    if (!pinCheck.ok) return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code || "PIN_REQUIRED" });

    const userRes = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const reference = randomReference("SCV");

    // FRAUD GATE — conversions move value across rails.
    const fraudResult = await evaluateOutflow({
        flow: "crypto",
        userId,
        walletId: null,
        amount: direction === "naira_to_stable" ? amount : amount * (await stableNgnRate(currency)).rate,
        currency: direction === "naira_to_stable" ? "NGN" : "NGN",
        reference,
        ip: (String(req.headers["x-forwarded-for"] || "")).split(",")[0]?.trim() || req.ip || null,
        userAgent: (req.headers["user-agent"] as string) || null,
        deviceId: (req.headers["x-device-id"] as string) || null,
        beneficiary: { destination: "internal_conversion" } as any,
        channel: `stablecoin:convert:${direction}:${currency}`,
    });
    if (fraudResult.decision === "reject") {
        return res.status(403).json({ success: false, error: fraudRejectReason(fraudResult), code: "FRAUD_REJECTED" });
    }
    if (fraudResult.decision === "hold") {
        return res.status(202).json({
            success: true, message: "Conversion received but held for a quick security review.",
            code: "FRAUD_HOLD", fraud: { decision: "hold", score: fraudResult.score, dueDiligenceId: fraudResult.dueDiligenceId },
        });
    }

    // Quote (fresh at execution time — the quote_id from the UI is advisory only).
    let quote: Awaited<ReturnType<typeof createConversionQuote>>;
    try {
        quote = await createConversionQuote(direction as any, currency, amount);
    } catch (e: any) {
        return res.status(502).json({ success: false, error: e?.message || "Rate unavailable — try again shortly" });
    }

    // Debit the SOURCE wallet atomically.
    const sourceWallet = direction === "stable_to_naira"
        ? await getUserStableWallet(userId, currency)
        : await getUserNgnWallet(userId);
    const sourceAmount = direction === "stable_to_naira" ? n8(amount) : n2(amount);
    if (!(await debitWallet(sourceWallet.id, sourceAmount))) {
        return res.status(400).json({
            success: false, code: "INSUFFICIENT_BALANCE",
            error: direction === "stable_to_naira"
                ? `Insufficient ${currency} balance — this conversion needs ${n8(amount)} ${currency}.`
                : `Insufficient NGN balance — this conversion needs ₦${n2(amount).toLocaleString()}.`,
        });
    }

    const ins = await query(
        `INSERT INTO stablecoin_conversions
           (user_id, reference, direction, currency, crypto_amount, ngn_amount, rate, status, quote_id, provider, provider_response)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, '{}'::jsonb) RETURNING *`,
        [userId, reference, direction, currency,
         direction === "stable_to_naira" ? n8(amount) : n8(quote.receive_amount),
         direction === "stable_to_naira" ? n2(quote.receive_amount) : n2(amount),
         quote.price, quote.quote_id, quote.mode],
    );
    const conv = ins.rows[0];

    await insertLedger({
        userId, walletId: sourceWallet.id, reference, type: "debit",
        transactionType: "stablecoin_convert", amount: sourceAmount,
        currency: direction === "stable_to_naira" ? currency : "NGN",
        description: direction === "stable_to_naira"
            ? `Stablecoin conversion — ${currency} ${n8(amount)} → NGN @ ₦${quote.price}`
            : `Stablecoin conversion — ₦${n2(amount).toLocaleString()} → ${currency} @ ₦${quote.price}`,
    });

    try {
        const order = await submitConversionOrder({ mode: quote.mode as any, direction: direction as any, currency, amount, quote, reference });
        await query(
            `UPDATE stablecoin_conversions SET order_id = $2, provider_response = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [conv.id, order.orderId, JSON.stringify(order.raw || {})],
        );

        if (quote.mode === "simulator") {
            const credit = await receiveAfterSpread(quote.receive_amount);
            if (direction === "stable_to_naira") {
                const ngn = await getUserNgnWallet(userId);
                await creditWalletById(ngn.id, credit);
                await insertLedger({
                    userId, walletId: ngn.id, reference: `${reference}-IN`, type: "credit",
                    transactionType: "stablecoin_convert", amount: credit, currency: "NGN",
                    description: `Stablecoin conversion — ${currency} ${n8(amount)} → ₦${credit.toLocaleString()}`,
                });
            } else {
                const sw = await getUserStableWallet(userId, currency);
                const stableCredit = n8(credit);
                await creditWalletById(sw.id, stableCredit);
                await insertLedger({
                    userId, walletId: sw.id, reference: `${reference}-IN`, type: "credit",
                    transactionType: "stablecoin_convert", amount: stableCredit, currency,
                    description: `Stablecoin conversion — ₦${n2(amount).toLocaleString()} → ${stableCredit} ${currency}`,
                });
            }
            await query(
                `UPDATE stablecoin_conversions SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [conv.id],
            );
            const done = await query(`SELECT * FROM stablecoin_conversions WHERE id = $1`, [conv.id]);
            return res.json({ success: true, data: { conversion: publicConversion(done.rows[0]), mode: "simulator" } });
        }

        if (order.filled) {
            await settleConversion(reference);
            const done = await query(`SELECT * FROM stablecoin_conversions WHERE reference = $1`, [reference]);
            return res.json({ success: true, data: { conversion: publicConversion(done.rows[0]), mode: "bitnob" } });
        }

        // Order still pending — the client polls GET /conversions/:reference.
        const current = await query(`SELECT * FROM stablecoin_conversions WHERE reference = $1`, [reference]);
        return res.json({ success: true, data: { conversion: publicConversion(current.rows[0]), mode: "bitnob", pending: true } });
    } catch (e: any) {
        console.error("[stablecoin] conversion failed:", e?.message);
        // Refund + mark failed.
        await creditWalletById(sourceWallet.id, sourceAmount);
        await insertLedger({
            userId, walletId: sourceWallet.id, reference: `${reference}-RF`, type: "credit",
            transactionType: "stablecoin_convert_refund", amount: sourceAmount,
            currency: direction === "stable_to_naira" ? currency : "NGN",
            description: "Conversion failed — refunded in full",
        });
        await query(
            `UPDATE stablecoin_conversions SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [conv.id, String(e?.message || "Order failed").slice(0, 500)],
        );
        return res.status(502).json({ success: false, error: `${e?.message || "Conversion failed"} — your wallet was refunded in full.` });
    }
});

/** GET /crypto/stablecoin/conversions — history (re-checks any still-pending order). */
router.get("/conversions", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    // Opportunistic settlement: give pending orders one more chance to resolve.
    const pending = await query(
        `SELECT reference FROM stablecoin_conversions WHERE user_id = $1 AND status NOT IN ('completed','failed') AND provider = 'bitnob' AND order_id IS NOT NULL LIMIT 5`,
        [userId],
    );
    for (const p of pending.rows) {
        try { await settleConversion(p.reference); } catch { /* next poll */ }
    }
    const r = await query(
        `SELECT * FROM stablecoin_conversions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [userId],
    );
    res.json({ success: true, data: { conversions: r.rows.map(publicConversion) } });
});

/** GET /crypto/stablecoin/conversions/:reference — single conversion status (poll target). */
router.get("/conversions/:reference", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const ref = String(req.params.reference || "");
    try { await settleConversion(ref); } catch { /* poll again later */ }
    const r = await query(`SELECT * FROM stablecoin_conversions WHERE reference = $1 AND user_id = $2 LIMIT 1`, [ref, req.user!.userId]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Conversion not found" });
    res.json({ success: true, data: { conversion: publicConversion(r.rows[0]) } });
});

/** GET /crypto/stablecoin/deposits — deposit history. */
router.get("/deposits", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const r = await query(
        `SELECT * FROM stablecoin_deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [req.user!.userId],
    );
    res.json({ success: true, data: { deposits: r.rows.map(publicDeposit) } });
});

/**
 * POST /crypto/stablecoin/withdraw { currency, chain, to_address, amount, pin }
 * On-chain payout of stablecoins to an external wallet (Bitnob /api/withdrawals).
 * Fraud gates: local + provider address validation, PIN, outflow engine,
 * min/max clamps, atomic debit with automatic refund when the provider fails.
 */
router.post("/withdraw", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const currency = String(req.body?.currency || "").toUpperCase() as Stablecoin;
    const chain = String(req.body?.chain || "").toLowerCase().trim();
    const toAddress = String(req.body?.to_address || "").trim();
    const amount = Number(req.body?.amount);
    const pin = typeof req.body?.pin === "string" ? req.body.pin : undefined;

    if (!STABLECOINS.includes(currency)) return res.status(400).json({ success: false, error: "currency must be USDT or USDC" });
    if (!chain) return res.status(400).json({ success: false, error: "chain is required" });
    if (!toAddress) return res.status(400).json({ success: false, error: "to_address is required" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "amount is required" });
    if (amount < MIN_WITHDRAW_CRYPTO || amount > MAX_WITHDRAW_CRYPTO) {
        return res.status(400).json({ success: false, error: `amount must be between ${MIN_WITHDRAW_CRYPTO} and ${MAX_WITHDRAW_CRYPTO.toLocaleString()} ${currency}` });
    }
    if (!localAddressLooksValid(chain, toAddress)) {
        return res.status(400).json({ success: false, error: `That does not look like a valid ${chain} address — double-check it.`, code: "INVALID_ADDRESS" });
    }

    const pinCheck = await verifyTransactionPin(pin, { userId, businessId: (req.user as any).businessId || null, wallet: null as any });
    if (!pinCheck.ok) return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code || "PIN_REQUIRED" });

    const userRes = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    // Provider-side validation (authoritative) — local regex already passed.
    if (await bitnobLive()) {
        try {
            const v = await bitnob.validateAddress(toAddress, chain);
            if (v?.data && v.data.valid === false) {
                return res.status(400).json({ success: false, error: "This address failed validation — it may not exist on the chosen network.", code: "INVALID_ADDRESS" });
            }
        } catch (e: any) {
            console.warn("[stablecoin] address validation unavailable:", e?.message);
            // Do not block the withdrawal solely because validation is unreachable;
            // the local format gate + fraud engine still apply.
        }
    }

    const reference = randomReference("SCW");

    // FRAUD GATE — on-chain payouts are the highest-risk outflow.
    const { rate } = await stableNgnRate(currency);
    const fraudResult = await evaluateOutflow({
        flow: "crypto",
        userId,
        walletId: null,
        amount: amount * rate,
        currency: "NGN",
        reference,
        ip: (String(req.headers["x-forwarded-for"] || "")).split(",")[0]?.trim() || req.ip || null,
        userAgent: (req.headers["user-agent"] as string) || null,
        deviceId: (req.headers["x-device-id"] as string) || null,
        beneficiary: { destination_type: "onchain", chain, address: toAddress.slice(0, 12) + "…" } as any,
        channel: `stablecoin:withdraw:${currency}:${chain}`,
    });
    if (fraudResult.decision === "reject") {
        return res.status(403).json({ success: false, error: fraudRejectReason(fraudResult), code: "FRAUD_REJECTED" });
    }
    if (fraudResult.decision === "hold") {
        return res.status(202).json({
            success: true, message: "Withdrawal received but held for a quick security review.",
            code: "FRAUD_HOLD", fraud: { decision: "hold", score: fraudResult.score, dueDiligenceId: fraudResult.dueDiligenceId },
        });
    }

    const wallet = await getUserStableWallet(userId, currency);
    const debitAmount = n8(amount);
    if (!(await debitWallet(wallet.id, debitAmount))) {
        return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: `Insufficient ${currency} balance — this withdrawal needs ${debitAmount} ${currency}.` });
    }

    const ins = await query(
        `INSERT INTO stablecoin_withdrawals
           (user_id, wallet_id, reference, currency, chain, to_address, amount, status, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) RETURNING *`,
        [userId, wallet.id, reference, currency, chain, toAddress, debitAmount, (await bitnobLive()) ? "bitnob" : "simulator"],
    );
    const wd = ins.rows[0];
    await insertLedger({
        userId, walletId: wallet.id, reference, type: "debit", transactionType: "stablecoin_withdrawal",
        amount: debitAmount, currency,
        description: `Stablecoin withdrawal — ${currency} ${debitAmount} → ${chain}`,
    });

    if (wd.provider === "simulator") {
        await query(`UPDATE stablecoin_withdrawals SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [wd.id]);
        createNotification({
            userId, type: "transaction", title: "Withdrawal sent (test mode)",
            message: `${currency} ${debitAmount} was sent to your ${chain} address (simulator).`,
        }).catch(() => {});
        const done = await query(`SELECT * FROM stablecoin_withdrawals WHERE id = $1`, [wd.id]);
        return res.json({ success: true, data: { withdrawal: publicWithdrawal(done.rows[0]), mode: "simulator" } });
    }

    try {
        const r = await bitnob.createWithdrawal({
            to_address: toAddress,
            amount: String(Math.round(debitAmount * 1e6)), // 6-decimal base units (docs: "150500000" = 150.5)
            currency,
            chain,
            reference,
            description: `MetriCorex withdrawal ${reference}`,
        });
        const data = r?.data || {};
        await query(
            `UPDATE stablecoin_withdrawals SET status = 'processing', provider_reference = $2, provider_response = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [wd.id, String(data.id || data.reference || reference), JSON.stringify(data)],
        );
        createNotification({
            userId, type: "transaction", title: "Withdrawal processing",
            message: `${currency} ${debitAmount} is on its way to your ${chain} address.`,
        }).catch(() => {});
        const done = await query(`SELECT * FROM stablecoin_withdrawals WHERE id = $1`, [wd.id]);
        return res.json({ success: true, data: { withdrawal: publicWithdrawal(done.rows[0]), mode: "bitnob" } });
    } catch (e: any) {
        console.error("[stablecoin] withdrawal failed:", e?.message);
        await creditWalletById(wallet.id, debitAmount);
        await insertLedger({
            userId, walletId: wallet.id, reference: `${reference}-RF`, type: "credit",
            transactionType: "stablecoin_withdrawal_refund", amount: debitAmount, currency,
            description: "Withdrawal failed — refunded in full",
        });
        await query(
            `UPDATE stablecoin_withdrawals SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [wd.id, String(e?.message || "Withdrawal failed").slice(0, 500)],
        );
        return res.status(502).json({ success: false, error: `${e?.message || "Withdrawal failed"} — your wallet was refunded in full.` });
    }
});

/** GET /crypto/stablecoin/withdrawals — withdrawal history. */
router.get("/withdrawals", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const r = await query(
        `SELECT * FROM stablecoin_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [req.user!.userId],
    );
    res.json({ success: true, data: { withdrawals: r.rows.map(publicWithdrawal) } });
});

export default router;
