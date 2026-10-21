import express from "express";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";
import { createNotification } from "../../services/notifications";
import { evaluateOutflow, fraudRejectReason } from "../../services/fraud";
import * as bitnob from "../../services/providers/bitnob";
import { requirePersonalService, useProvider, getPercent } from "./flags";

const router = express.Router();
// Personal Products console kill-switch for crypto -> cash.
router.use(requirePersonalService("crypto"));

/** Provider routing (Personal Products console): auto | provider | simulator. */
async function bitnobLive(): Promise<boolean> {
    return useProvider("crypto", bitnob.isBitnobConfigured());
}

/**
 * Admin spread (crypto_spread_percent, default 1%) — silently widens the
 * quote so the customer pays slightly more crypto for the same NGN. Applied
 * to both Bitnob and simulator quotes.
 */
async function applySpread(usdDebit: number): Promise<number> {
    const spread = await getPercent("crypto_spread_percent", 1);
    return Math.round(usdDebit * (1 + spread / 100) * 100) / 100;
}

/**
 * Crypto → Cash (Personal) — convert stablecoins (USDT / USDC) into NGN paid
 * straight to a Nigerian bank account, powered by the Bitnob Payouts API:
 *   quote (POST /api/payouts/quotes) → initialize (beneficiary) → finalize.
 *
 * Wallet semantics (end-to-end with the platform ledger):
 *   - `source: offchain` debits Bitnob's own wallet; on OUR side the caller's
 *     MATCHING STABLECOIN wallet is debited (USDT sale → USDT wallet, USDC
 *     sale → USDC wallet). The legacy "USD wallet" was retired into USDT.
 *
 * When Bitnob is not configured, a built-in SIMULATOR produces instant quotes
 * and instant payouts so the flow remains testable end-to-end.
 */

const MIN_SETTLEMENT_NGN = 500;
const MAX_SETTLEMENT_NGN = 10_000_000;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export async function ensureCryptoSchema(): Promise<void> {
    await query(`
    CREATE TABLE IF NOT EXISTS crypto_sales (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID NOT NULL,
      wallet_id UUID,
      reference VARCHAR(80) UNIQUE NOT NULL,
      provider VARCHAR(20) NOT NULL DEFAULT 'bitnob',      -- bitnob | simulator
      from_asset VARCHAR(8) NOT NULL,                      -- BTC | USDT | USDC
      to_currency VARCHAR(8) NOT NULL DEFAULT 'NGN',
      country VARCHAR(2) NOT NULL DEFAULT 'NG',
      crypto_amount DECIMAL(20,8),
      settlement_amount DECIMAL(15,2) NOT NULL,
      usd_debit DECIMAL(15,2) NOT NULL DEFAULT 0,
      rate DECIMAL(18,6),
      fee DECIMAL(15,2) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',                -- quoted|pending|processing|completed|failed|expired
      payout_id VARCHAR(80),
      quote_id VARCHAR(80),
      beneficiary JSONB,
      provider_response JSONB,
      failure_reason TEXT,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_crypto_sales_user ON crypto_sales(user_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_crypto_sales_status ON crypto_sales(status)`);
}

function randomReference(prefix: string): string {
    return `${prefix}_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function publicSale(row: any) {
    return {
        id: row.id,
        reference: row.reference,
        from_asset: row.from_asset,
        to_currency: row.to_currency,
        crypto_amount: row.crypto_amount ? Number(row.crypto_amount) : null,
        settlement_amount: Number(row.settlement_amount),
        usd_debit: Number(row.usd_debit),
        rate: row.rate ? Number(row.rate) : null,
        status: row.status,
        beneficiary: row.beneficiary,
        created_at: row.created_at,
        completed_at: row.completed_at,
    };
}

/**
 * @swagger
 * tags:
 *   name: CryptoToCash
 *   description: Sell crypto (BTC/USDT/USDC) for NGN paid to any Nigerian bank
 */

/**
 * @swagger
 * /crypto/banks:
 *   get:
 *     summary: Banks supported for NGN payouts (live from Bitnob when configured)
 *     tags: [CryptoToCash]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/banks", authenticateToken, checkSubscriptionStatus, async (_req: AuthenticatedRequest, res) => {
    if (await bitnobLive()) {
        try {
            const banks = await bitnob.getPayoutBanks("NG");
            const list = (banks?.data?.banks || banks?.data || []).map((b: any) => ({
                code: String(b.bank_code ?? b.code ?? b.id ?? ""),
                name: String(b.bank_name ?? b.name ?? ""),
            })).filter((b: any) => b.code && b.name);
            if (list.length) return res.json({ success: true, data: { banks: list, mode: "bitnob" } });
        } catch (e: any) {
            console.error("[crypto] banks fetch failed:", e?.message);
        }
    }
    // Simulator / fallback bank list (common Nigerian banks).
    const fallback = [
        { code: "058", name: "GTBank" }, { code: "011", name: "First Bank" }, { code: "033", name: "United Bank for Africa" },
        { code: "044", name: "Access Bank" }, { code: "050", name: "Ecobank" }, { code: "070", name: "Fidelity Bank" },
        { code: "082", name: "Keystone Bank" }, { code: "076", name: "Polaris Bank" }, { code: "221", name: "Stanbic IBTC" },
        { code: "068", name: "Standard Chartered" }, { code: "030", name: "Sterling Bank" }, { code: "232", name: "Sterling Bank Pro" },
        { code: "100", name: "SunTrust Bank" }, { code: "032", name: "Union Bank" }, { code: "035", name: "Wema Bank" },
        { code: "057", name: "Zenith Bank" }, { code: "999", name: "OPay" }, { code: "566", name: "Palmpay" },
        { code: "101", name: "Providus Bank" }, { code: "090", name: "Kuda MFB" }, { code: "013", name: "Jaiz Bank" },
    ];
    res.json({ success: true, data: { banks: fallback, mode: "simulator" } });
});

/**
 * @swagger
 * /crypto/lookup:
 *   post:
 *     summary: Resolve a bank account name (account lookup) before selling
 *     tags: [CryptoToCash]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/lookup", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const { account_number, bank_code } = req.body || {};
    if (!account_number || !bank_code) return res.status(400).json({ success: false, error: "account_number and bank_code are required" });
    if (await bitnobLive()) {
        try {
            const r = await bitnob.accountLookup({ account_number: String(account_number), bank_code: String(bank_code), country: "NG" });
            const name = r?.data?.account_name || r?.data?.accountName;
            if (name) return res.json({ success: true, data: { account_name: name, mode: "bitnob" } });
        } catch (e: any) {
            console.error("[crypto] lookup failed:", e?.message);
        }
    }
    return res.json({ success: true, data: { account_name: null, mode: "simulator" } });
});

/**
 * @swagger
 * /crypto/quote:
 *   get:
 *     summary: Quote a crypto → NGN conversion
 *     tags: [CryptoToCash]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/quote", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const fromAsset = String(req.query.from_asset || "USDT").toUpperCase() as "USDT" | "USDC";
    if (!"USDT USDC".split(" ").includes(fromAsset)) {
        return res.status(400).json({ success: false, error: "from_asset must be USDT or USDC" });
    }
    const settlementAmount = Number(req.query.settlement_amount);
    if (!settlementAmount || Number.isNaN(settlementAmount)) {
        return res.status(400).json({ success: false, error: "settlement_amount (NGN) is required" });
    }
    if (settlementAmount < MIN_SETTLEMENT_NGN || settlementAmount > MAX_SETTLEMENT_NGN) {
        return res.status(400).json({
            success: false,
            error: `settlement_amount must be between ₦${MIN_SETTLEMENT_NGN.toLocaleString()} and ₦${MAX_SETTLEMENT_NGN.toLocaleString()}`,
        });
    }

    const reference = randomReference("QT");
    if (await bitnobLive()) {
        try {
            const q = await bitnob.createPayoutQuote({
                from_asset: fromAsset,
                to_currency: "NGN",
                country: "NG",
                source: "offchain",
                settlement_amount: String(settlementAmount),
                reference,
            });
            const p = q?.data?.payout;
            if (p) {
                // Admin spread: the customer pays spread% more crypto for the
                // same NGN settlement (margin stays invisible in the UI).
                const spread = await getPercent("crypto_spread_percent", 1);
                const factor = 1 + spread / 100;
                const cryptoAmount = Math.round(Number(p.amount) * factor * 1e8) / 1e8;
                return res.json({
                    success: true,
                    data: {
                        quote_id: p.quote_id,
                        reference,
                        from_asset: p.from_asset,
                        settlement_amount: Number(p.settlement_amount),
                        crypto_amount: cryptoAmount,
                        rate: Number(p.exchange_rate?.effective_rate || p.exchange_rate?.rate),
                        fees: Number(p.fees || 0),
                        usd_debit: cryptoAmount,
                        expires_at: p.expires_at,
                        mode: "bitnob",
                    },
                });
            }
        } catch (e: any) {
            console.error("[crypto] quote failed:", e?.message);
            return res.status(502).json({ success: false, error: e?.message || "Quote failed" });
        }
    }
    // Simulator: stable-ish NGN/USD rate.
    const simRate = 1560 + Math.random() * 25;
    const usdDebit = Math.round((settlementAmount / simRate) * 100 * (1 + (await getPercent("crypto_spread_percent", 1)) / 100)) / 100;
    return res.json({
        success: true,
        data: {
            quote_id: `SIMQT_${reference}`,
            reference,
            from_asset: fromAsset,
            settlement_amount: settlementAmount,
            crypto_amount: usdDebit,
            rate: Math.round(simRate * 100) / 100,
            fees: 0,
            usd_debit: usdDebit,
            expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
            mode: "simulator",
        },
    });
});

/**
 * @swagger
 * /crypto/sell:
 *   post:
 *     summary: Sell stablecoin (USDT/USDC) for NGN — debits the caller's matching stablecoin wallet and pays the beneficiary's bank account
 *     tags: [CryptoToCash]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/sell", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const {
        from_asset, settlement_amount, account_number, bank_code, account_name, quote_reference, save_beneficiary,
    } = req.body || {};

    const fromAsset = String(from_asset || "USDT").toUpperCase() as "USDT" | "USDC";
    if (!"USDT USDC".split(" ").includes(fromAsset)) {
        return res.status(400).json({ success: false, error: "from_asset must be USDT or USDC" });
    }
    const settlementAmount = Number(settlement_amount);
    if (!settlementAmount || Number.isNaN(settlementAmount) || settlementAmount < MIN_SETTLEMENT_NGN || settlementAmount > MAX_SETTLEMENT_NGN) {
        return res.status(400).json({ success: false, error: `settlement_amount must be between ₦${MIN_SETTLEMENT_NGN.toLocaleString()} and ₦${MAX_SETTLEMENT_NGN.toLocaleString()}` });
    }
    if (!account_number || !bank_code || !account_name) {
        return res.status(400).json({ success: false, error: "beneficiary account_number, bank_code and account_name are required" });
    }

    const userRes = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    // Wallet: the caller's matching stablecoin wallet (USDT sale → USDT wallet).
    const walletRes = await query(
        `SELECT * FROM wallets WHERE user_id = $1 AND status = 'active' AND (business_id IS NULL)
         AND UPPER(currency) = $2 ORDER BY created_at ASC LIMIT 1`,
        [userId, fromAsset],
    );
    const wallet = walletRes.rows[0];
    if (!wallet) return res.status(404).json({ success: false, error: `No active ${fromAsset} wallet found`, code: "STABLECOIN_WALLET_REQUIRED" });
    const walletCurrency = String(wallet.currency || "NGN").toUpperCase();

    // ---- Quote (fresh at sell time; quote_reference is informational) ----
    let quote: any = null;
    let mode = (await bitnobLive()) ? "bitnob" : "simulator";
    const quoteRes = await new Promise<{ ok: boolean; data?: any; error?: string }>((resolve) => {
        // Internal reuse: call the quote logic through the router by building a fake req is overkill —
        // re-derive the quote inline (same rules as GET /quote).
        (async () => {
            const reference = randomReference("QT");
            if (mode === "bitnob") {
                try {
                    const q = await bitnob.createPayoutQuote({
                        from_asset: fromAsset, to_currency: "NGN", country: "NG", source: "offchain",
                        settlement_amount: String(settlementAmount), reference,
                    });
                    const p = q?.data?.payout;
                    if (p) {
                        // Admin spread (same rule as GET /quote).
                        const spread = await getPercent("crypto_spread_percent", 1);
                        const factor = 1 + spread / 100;
                        const cryptoAmount = Math.round(Number(p.amount) * factor * 1e8) / 1e8;
                        return resolve({
                            ok: true,
                            data: {
                                quote_id: p.quote_id, reference, crypto_amount: cryptoAmount,
                                rate: Number(p.exchange_rate?.effective_rate || p.exchange_rate?.rate),
                                fees: Number(p.fees || 0),
                                usd_debit: cryptoAmount,
                            },
                        });
                    }
                } catch (e: any) {
                    return resolve({ ok: false, error: e?.message || "Quote failed" });
                }
            }
            const simRate = 1560 + Math.random() * 25;
            const usdDebit = Math.round((settlementAmount / simRate) * 100 * (1 + (await getPercent("crypto_spread_percent", 1)) / 100)) / 100;
            return resolve({
                ok: true,
                data: {
                    quote_id: `SIMQT_${reference}`, reference,
                    crypto_amount: usdDebit,
                    rate: Math.round(simRate * 100) / 100, fees: 0, usd_debit: usdDebit,
                },
            });
        })();
    });
    if (!quoteRes.ok) return res.status(502).json({ success: false, error: quoteRes.error });
    quote = quoteRes.data;

    const usdDebit = Math.round((quote.usd_debit || 0) * 100) / 100;
    if (usdDebit <= 0) return res.status(400).json({ success: false, error: "Could not derive the USD equivalent for this sale" });

    // FRAUD GATE (outflow) — crypto liquidation to bank rails is high-risk.
    const fraudResult = await evaluateOutflow({
        flow: "crypto",
        userId,
        walletId: wallet.id,
        amount: settlementAmount,
        currency: "NGN",
        reference: quote.reference,
        ip: (String(req.headers["x-forwarded-for"] || "")).split(",")[0]?.trim() || req.ip || null,
        userAgent: (req.headers["user-agent"] as string) || null,
        deviceId: (req.headers["x-device-id"] as string) || null,
        beneficiary: { accountNumber: String(account_number), bankCode: String(bank_code), accountName: String(account_name) },
        channel: `crypto:sell:${fromAsset}`,
    });
    if (fraudResult.decision === "reject") {
        return res.status(403).json({ success: false, error: fraudRejectReason(fraudResult), code: "FRAUD_REJECTED" });
    }
    if (fraudResult.decision === "hold") {
        return res.status(202).json({
            success: true,
            message: "Sale received but held for a quick security review. Complete verification in the app to release it.",
            code: "FRAUD_HOLD",
            fraud: { decision: "hold", score: fraudResult.score, dueDiligenceId: fraudResult.dueDiligenceId },
        });
    }

    // ---- Debit the stablecoin wallet ----
    if (walletCurrency !== fromAsset) {
        return res.status(400).json({ success: false, error: `Crypto sales debit your ${fromAsset} stablecoin wallet — top it up first.`, code: "STABLECOIN_WALLET_REQUIRED" });
    }
    const debit = await query(
        `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND balance >= $1 AND status = 'active' RETURNING balance`,
        [usdDebit, wallet.id],
    );
    if (debit.rows.length === 0) {
        return res.status(400).json({
            success: false,
            error: `Insufficient ${fromAsset} balance — this sale needs ${usdDebit.toFixed(2)} ${fromAsset}.`,
            code: "INSUFFICIENT_BALANCE",
        });
    }

    const reference = randomReference("CRS");
    const beneficiary = {
        destination_type: "bank",
        country: "NG",
        account_name: String(account_name).trim(),
        account_number: String(account_number).trim(),
        bank_code: String(bank_code).trim(),
    };

    const insert = await query(
        `INSERT INTO crypto_sales
         (user_id, wallet_id, reference, provider, from_asset, to_currency, country, crypto_amount,
          settlement_amount, usd_debit, rate, fee, status, quote_id, beneficiary, provider_response)
         VALUES ($1, $2, $3, $4, $5, 'NGN', 'NG', $6, $7, $8, $9, $10, 'pending', $11, $12::jsonb, '{}'::jsonb)
         RETURNING *`,
        [userId, wallet.id, reference, mode, fromAsset, quote.crypto_amount, settlementAmount, usdDebit,
         quote.rate, quote.fees || 0, quote.quote_id, JSON.stringify(beneficiary)],
    );
    const sale = insert.rows[0];

    await query(
        `INSERT INTO transactions
         (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction, fee)
         VALUES (NULL, $1, $2, $3, 'success', 'debit', $4, 'crypto_sale', $5, 'debit', 0)`,
        [userId, usdDebit, fromAsset, reference, `Crypto sale — ${fromAsset} → ₦${settlementAmount.toLocaleString()} (rate ₦${quote.rate})`, wallet.id],
    );

    const finishOk = async () => {
        await query(`UPDATE crypto_sales SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [sale.id]);
        await createNotification({
            userId,
            title: "Crypto sale completed",
            message: `₦${settlementAmount.toLocaleString()} is on its way to ${beneficiary.account_name}.`,
            type: "transaction",
        }).catch(() => {});
    };
    const finishFail = async (reason: string) => {
        // Refund the stablecoin wallet.
        await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [usdDebit, wallet.id]);
        await query(`UPDATE transactions SET status = 'failed' WHERE reference = $1`, [reference]);
        await query(`UPDATE crypto_sales SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [sale.id, reason]);
    };

    // ---- Beneficiary (optional save, Bitnob) ----
    if (mode === "bitnob" && save_beneficiary) {
        bitnob.createBeneficiary({
            name: `${beneficiary.account_name} • ${bank_code}`,
            type: "bank",
            destination: JSON.stringify({ account_number: beneficiary.account_number, bank_code: beneficiary.bank_code, account_name: beneficiary.account_name }),
        }).catch(() => {});
    }

    if (mode === "simulator") {
        await finishOk();
        return res.json({ success: true, data: { sale: publicSale({ ...sale, status: "completed" }), mode } });
    }

    // ---- Bitnob initialize + finalize ----
    try {
        const init = await bitnob.initializePayout(quote.quote_id, {
            quote_id: quote.quote_id,
            reference,
            payment_reason: "family_support",
            callback_url: process.env.BITNOB_PAYOUT_CALLBACK_URL || undefined,
            beneficiary: beneficiary as any,
        });
        const payout = init?.data?.payout;
        await query(`UPDATE crypto_sales SET payout_id = $2, provider_response = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [sale.id, payout?.id || null, JSON.stringify(init || {})]);
        const fin = await bitnob.finalizePayout(quote.quote_id);
        const finalStatus = String(fin?.data?.payout?.status || "PENDING").toLowerCase();
        if (["completed", "pending", "processing"].includes(finalStatus)) {
            await query(`UPDATE crypto_sales SET status = $2, provider_response = provider_response || $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [sale.id, finalStatus === "completed" ? "completed" : "processing", JSON.stringify({ finalized: fin?.data?.payout?.status })]);
            if (finalStatus === "completed") await finishOk();
        } else {
            await finishFail(`Provider status: ${finalStatus}`);
            return res.status(502).json({ success: false, error: `Payout ${finalStatus} — ${fromAsset} wallet refunded.` });
        }
        const refreshed = await query(`SELECT * FROM crypto_sales WHERE id = $1`, [sale.id]);
        return res.json({ success: true, data: { sale: publicSale(refreshed.rows[0]), mode } });
    } catch (e: any) {
        console.error("[crypto] payout failed:", e?.message);
        await finishFail(e?.message || "Payout failed");
        return res.status(502).json({ success: false, error: `${e?.message || "Payout failed"} — ${fromAsset} wallet refunded.` });
    }
});

/**
 * @swagger
 * /crypto/sales:
 *   get:
 *     summary: The caller's crypto sale history
 *     tags: [CryptoToCash]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/sales", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const rows = await query(
        `SELECT * FROM crypto_sales WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [userId],
    );
    let providerPayouts: any[] = [];
    if (await bitnobLive()) {
        try {
            const p = await bitnob.listPayouts({ limit: 20 });
            providerPayouts = p?.data?.payouts || [];
        } catch { /* local history is enough */ }
    }
    res.json({ success: true, data: { sales: rows.rows.map(publicSale), provider_payouts: providerPayouts } });
});

export default router;
