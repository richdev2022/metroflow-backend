import express from "express";
import multer from "multer";
import crypto from "crypto";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";
import { calculateFee, debitPlatformWallet, creditRevenueWallet } from "../../services/fees";
import { createNotification } from "../../services/notifications";
import { verifyPassword } from "../../services/auth";
import { verifyTransactionPin } from "../../lib/transaction-pin";
import { evaluateOutflow, evaluateInflow } from "../../services/fraud";
import {
    isPrestmitConfigured,
    sellCategories,
    sellSubcategories,
    sellRateCalculatorData,
    createSellTrade,
    buyConfig,
    buyCalculatePayment,
    createBuyTrade,
    buyFetchCodes,
} from "./prestmit";

/**
 * GIFT CARD TRADING (Prestmit partner API) — MetriCorex Personal.
 * Mounted at /giftcards.
 *
 *   SELL: user submits card + media -> Prestmit trade created -> when
 *         Prestmit confirms (status SUCCESS), the user's wallet is credited
 *         the payout minus our convenience fee (auto or via admin sync).
 *   BUY:  user pays from wallet (amount = Prestmit total + fee) -> Prestmit
 *         order created -> codes fetched once fulfilled and stored/emailed.
 *
 *   GET  /giftcards/status                 provider configured?
 *   GET  /giftcards/sell/catalog           categories + giftcards (live)
 *   GET  /giftcards/sell/rates             rate calculator data (live)
 *   POST /giftcards/sell                   create sell trade (multipart, <=5 images)
 *   GET  /giftcards/sell/history           user's sell trades
 *   POST /giftcards/sell/:reference/sync   poll Prestmit + settle if SUCCESS
 *   GET  /giftcards/buy/config             buy catalog (live)
 *   POST /giftcards/buy/calculate          exact payment for SKU+price+qty
 *   POST /giftcards/buy                    create buy order (wallet debit + fee)
 *   GET  /giftcards/buy/history            user's buy orders
 *   GET  /giftcards/buy/:reference         order detail + codes (polls Prestmit)
 *
 * Fraud: sell = inflow evaluation (card fraud), buy = outflow evaluation.
 */

import { requirePersonalService } from "./flags";

const router = express.Router();
// Personal Products console kill-switch for gift card trading.
router.use(requirePersonalService("giftcards"));

// ---------------------------------------------------------------------------
// Schema (idempotent)
// ---------------------------------------------------------------------------
export async function ensureGiftcardSchema(): Promise<void> {
    await query(`
    CREATE TABLE IF NOT EXISTS gift_card_trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID NOT NULL,
      wallet_id UUID,
      direction VARCHAR(6) NOT NULL,               -- sell | buy
      reference VARCHAR(80) UNIQUE NOT NULL,       -- OUR reference
      prestmit_reference VARCHAR(80),
      giftcard_id INTEGER,
      giftcard_sku VARCHAR(120),
      giftcard_name VARCHAR(200),
      quantity INTEGER DEFAULT 1,
      card_amount DECIMAL(15,2),                   -- face value (sell) / unit price (buy)
      rate DECIMAL(12,4),
      fee DECIMAL(15,2) DEFAULT 0,
      payout_amount DECIMAL(15,2),                 -- credited to wallet (sell)
      total_charged DECIMAL(15,2),                 -- debited from wallet (buy)
      currency VARCHAR(3) DEFAULT 'NGN',
      payout_method VARCHAR(20) DEFAULT 'NAIRA',
      status VARCHAR(24) DEFAULT 'pending',        -- pending|processing|successful|failed|rejected|cancelled
      codes JSONB,
      attachments JSONB,
      failure_reason TEXT,
      provider_response JSONB,
      settled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_giftcard_trades_user ON gift_card_trades(user_id, direction, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_giftcard_trades_status ON gift_card_trades(status, direction)`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uploadCardMedia = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },        // 10 MB per card image
}).array("attachments", 5);

function randomReference(prefix: string): string {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`.toUpperCase();
}

// Our margin on sell payouts / buy orders — admin-editable via the Personal
// Products console (settings giftcard_sell_fee_percent / giftcard_buy_fee_percent).
const SELL_FEE_PERCENT = 5;    // fallback when no admin override exists
const BUY_FEE_PERCENT = 5;     // fallback when no admin override exists
async function sellFeePercent(): Promise<number> {
    const { getPercent } = await import("./flags");
    return getPercent("giftcard_sell_fee_percent", SELL_FEE_PERCENT);
}
async function buyFeePercent(): Promise<number> {
    const { getPercent } = await import("./flags");
    return getPercent("giftcard_buy_fee_percent", BUY_FEE_PERCENT);
}

async function ensureSchema() {
    await ensureGiftcardSchema();
}

/** Sync ONE sell trade with Prestmit; settle SUCCESS into the user wallet. */
export async function syncSellTrade(trade: any, _adminId?: string): Promise<{ updated: boolean; status: string }> {
    if (!trade?.prestmit_reference) return { updated: false, status: trade?.status || "pending" };
    try {
        const { sellHistory } = await import("./prestmit");
        const history = await sellHistory({ uniqueIdentifier: trade.reference });
        const match = Array.isArray(history)
            ? history.find((t: any) => t.reference === trade.prestmit_reference || t.uniqueIdentifier === trade.reference)
            : null;
        if (!match) return { updated: false, status: trade.status };

        const pStatus = String(match.status || "").toUpperCase();
        if (pStatus === "SUCCESS" && trade.status !== "successful") {
            // Credit the payout (stored at creation) to the user's wallet.
            const payout = parseFloat(trade.payout_amount || 0);
            if (payout > 0 && trade.wallet_id) {
                await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [payout, trade.wallet_id]);
                await query(
                    `INSERT INTO transactions
                     (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction)
                     VALUES ($1, $2, $3, $4, $5, 'success', 'credit', $6, 'giftcard_sell', $7, 'credit')`,
                    [trade.business_id, trade.user_id, payout, trade.currency || "NGN",
                     `${trade.reference}-PAYOUT`, `Gift card sale payout — ${trade.giftcard_name || "card"}`, trade.wallet_id],
                );
            }
            await query(
                `UPDATE gift_card_trades SET status = 'successful', settled_at = CURRENT_TIMESTAMP,
                   provider_response = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [trade.id, JSON.stringify(match)],
            );
            try {
                await createNotification({
                    businessId: String(trade.business_id || ""),
                    userId: String(trade.user_id),
                    type: "credit",
                    title: "Gift card sale confirmed",
                    message: `Your ${trade.giftcard_name || "gift card"} sale was confirmed. ₦${payout.toLocaleString()} has been added to your wallet.`,
                    actionUrl: "/giftcards",
                    actionType: "view_transaction",
                    metadata: { reference: trade.reference },
                    isActionable: false,
                    expiresInHours: 168,
                });
            } catch { /* best effort */ }
            return { updated: true, status: "successful" };
        }
        if (pStatus === "FAILED" || pStatus === "REJECTED" || pStatus === "CANCELLED") {
            const newStatus = pStatus === "REJECTED" ? "rejected" : pStatus.toLowerCase();
            await query(
                `UPDATE gift_card_trades SET status = $2, failure_reason = $3,
                   provider_response = $4::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [trade.id, newStatus, match.rejectionReason || match.comments || null, JSON.stringify(match)],
            );
            try {
                await createNotification({
                    businessId: String(trade.business_id || ""),
                    userId: String(trade.user_id),
                    type: "system",
                    title: "Gift card sale update",
                    message: `Your ${trade.giftcard_name || "gift card"} sale was ${newStatus}. ${match.rejectionReason || ""}`.trim(),
                    actionUrl: "/giftcards",
                    actionType: "view_transaction",
                    metadata: { reference: trade.reference },
                    isActionable: false,
                    expiresInHours: 168,
                });
            } catch { /* best effort */ }
            return { updated: true, status: newStatus };
        }
        if (pStatus === "PENDING" || pStatus === "PROCESSING") {
            if (trade.status !== "processing" && pStatus === "PROCESSING") {
                await query(`UPDATE gift_card_trades SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [trade.id]);
                return { updated: true, status: "processing" };
            }
        }
        return { updated: false, status: trade.status };
    } catch (e: any) {
        console.warn("[giftcards] syncSellTrade failed:", e?.message?.substring?.(0, 160));
        return { updated: false, status: trade?.status || "pending" };
    }
}

/** Background sweep: poll unsettled sell trades + unfulfilled buy orders. */
export async function processGiftcardSyncCron(): Promise<void> {
    if (!isPrestmitConfigured()) return;
    try {
        const pendingSells = await query(
            `SELECT * FROM gift_card_trades WHERE direction = 'sell' AND status IN ('pending','processing') ORDER BY created_at ASC LIMIT 25`,
        );
        for (const t of pendingSells.rows) {
            await syncSellTrade(t);
        }
        const buys = await query(
            `SELECT * FROM gift_card_trades WHERE direction = 'buy' AND status IN ('pending','processing') ORDER BY created_at ASC LIMIT 25`,
        );
        for (const t of buys.rows) {
            try {
                const codes = await buyFetchCodes(t.prestmit_reference);
                const codeList = codes?.codes || codes?.cards || null;
                if (codeList) {
                    await query(
                        `UPDATE gift_card_trades SET status = 'successful', codes = $2::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                        [t.id, JSON.stringify(codeList)],
                    );
                    try {
                        await createNotification({
                            businessId: String(t.business_id || ""),
                            userId: String(t.user_id),
                            type: "system",
                            title: "Your gift card is ready",
                            message: `Your ${t.giftcard_name || "gift card"} purchase has arrived. Open the app to view the code.`,
                            actionUrl: "/giftcards",
                            actionType: "view_transaction",
                            metadata: { reference: t.reference },
                            isActionable: true,
                            expiresInHours: 720,
                        });
                    } catch { /* best effort */ }
                }
            } catch { /* still unfulfilled — retry next sweep */ }
        }
    } catch (e: any) {
        console.warn("[giftcards] sync cron failed:", e?.message);
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.get("/status", async (_req, res) => {
    res.json({ success: true, configured: isPrestmitConfigured(), provider: "prestmit" });
});

// ── SELL ──
router.get("/sell/catalog", async (_req, res) => {
    try {
        if (!isPrestmitConfigured()) return res.status(503).json({ success: false, error: "Gift card trading is coming soon", code: "PROVIDER_UNCONFIGURED" });
        const [categories, subcategories] = await Promise.all([sellCategories(), sellSubcategories()]);
        return res.json({ success: true, categories, giftcards: subcategories });
    } catch (e: any) {
        return res.status(502).json({ success: false, error: e?.message || "Failed to load catalog" });
    }
});

router.get("/sell/rates", async (_req, res) => {
    try {
        if (!isPrestmitConfigured()) return res.status(503).json({ success: false, error: "Gift card trading is coming soon", code: "PROVIDER_UNCONFIGURED" });
        const data = await sellRateCalculatorData();
        return res.json({ success: true, data });
    } catch (e: any) {
        return res.status(502).json({ success: false, error: e?.message || "Failed to load rates" });
    }
});

router.post("/sell", authenticateToken, checkSubscriptionStatus, uploadCardMedia, async (req: AuthenticatedRequest, res) => {
    try {
        await ensureSchema();
        const { userId, businessId } = req.user!;
        if (!isPrestmitConfigured()) return res.status(503).json({ success: false, error: "Gift card trading is coming soon", code: "PROVIDER_UNCONFIGURED" });

        const giftcardId = parseInt(String(req.body?.giftcard_id || ""), 10);
        const amount = Math.round(Number(req.body?.amount) * 100) / 100;
        const payoutMethod = String(req.body?.payout_method || "NAIRA").toUpperCase();
        const comments = req.body?.comments ? String(req.body.comments).substring(0, 500) : null;
        const files = (req.files as any[]) || [];
        if (!giftcardId) return res.status(400).json({ success: false, error: "giftcard_id is required" });
        if (!amount || amount <= 0) return res.status(400).json({ success: false, error: "amount is required" });
        if (files.length === 0) return res.status(400).json({ success: false, error: "Attach at least one photo of the gift card" });

        // FRAUD GATE (inflow — card trade value flowing TO us)
        const fraudResult = await evaluateInflow({
            flow: "giftcard",
            userId, businessId,
            amount,
            currency: "NGN",
            ip: (String(req.headers["x-forwarded-for"] || "")).split(",")[0]?.trim() || req.ip || null,
            userAgent: (req.headers["user-agent"] as string) || null,
            deviceId: (req.headers["x-device-id"] as string) || null,
            beneficiary: { accountName: `giftcard:${giftcardId}` },
            channel: "prestmit:sell",
        });
        if (fraudResult.decision === "hold" || fraudResult.decision === "reject") {
            return res.status(403).json({
                success: false,
                error: fraudResult.decision === "reject"
                    ? "This trade was declined by our security system."
                    : "This trade is on hold for a quick security review.",
                code: "FRAUD_HOLD",
            });
        }

        const reference = randomReference("GCS");
        const feePercent = await sellFeePercent();
        const trade = await createSellTrade({
            giftcardId,
            amount,
            payoutMethod,
            comments,
            uniqueIdentifier: reference,
            attachments: files.map((f) => ({ buffer: f.buffer, filename: f.originalname, contentType: f.mimetype })),
        });
        if (!trade.ok) {
            return res.status(400).json({ success: false, error: trade.message || "Trade rejected by the gift card partner" });
        }

        // Expected payout: partner total minus our fee — recomputed at
        // settlement with the ACTUAL partner total; the stored value is the
        // estimate from the create response when available.
        const partnerTotal = Number(trade.totalAmount || 0);
        const estimatedPayout = Math.round(partnerTotal * (1 - feePercent / 100) * 100) / 100;

        // Wallet for the eventual payout (personal or business wallet — NGN)
        const walletRes = await query(
            `SELECT id, business_id FROM wallets
              WHERE (business_id = $1 OR user_id = $2) AND UPPER(currency) = 'NGN' AND status = 'active'
              ORDER BY business_id NULLS LAST, created_at ASC LIMIT 1`,
            [businessId || null, userId],
        );
        const wallet = walletRes.rows[0];

        const insertRes = await query(
            `INSERT INTO gift_card_trades
             (business_id, user_id, wallet_id, direction, reference, prestmit_reference, giftcard_id,
              giftcard_name, card_amount, rate, fee, payout_amount, currency, payout_method, status, attachments, provider_response)
             VALUES ($1,$2,$3,'sell',$4,$5,$6,$7,$8,$9,$10,$11,'NGN',$12,'pending',$13::jsonb,$14::jsonb) RETURNING *`,
            [wallet?.business_id || businessId || null, userId, wallet?.id || null, reference, trade.reference,
             giftcardId, trade.raw?.trade?.category?.name || null, amount, trade.rate ?? null,
             Math.round(partnerTotal * feePercent / 100 * 100) / 100, estimatedPayout, payoutMethod,
             JSON.stringify(files.map((f) => f.originalname)), JSON.stringify({ estimate: true })],
        );
        const row = insertRes.rows[0];

        try {
            await createNotification({
                businessId: String(wallet?.business_id || businessId || ""),
                userId: String(userId),
                type: "system",
                title: "Gift card received",
                message: `Your ${row.giftcard_name || "gift card"} trade (${reference}) is being reviewed. You'll be credited ₦${estimatedPayout.toLocaleString()} once confirmed.`,
                actionUrl: "/giftcards",
                actionType: "view_transaction",
                metadata: { reference },
                isActionable: false,
                expiresInHours: 336,
            });
        } catch { /* best effort */ }

        return res.json({ success: true, trade: row, message: "Trade submitted — we'll credit your wallet once the card is confirmed" });
    } catch (error: any) {
        console.error("Giftcard sell error:", error?.message);
        return res.status(500).json({ success: false, error: "Failed to submit gift card trade" });
    }
});

router.get("/sell/history", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        await ensureSchema();
        const rows = await query(
            `SELECT id, reference, prestmit_reference, giftcard_name, card_amount, rate, fee, payout_amount,
                    status, failure_reason, created_at, settled_at
               FROM gift_card_trades WHERE user_id = $1 AND direction = 'sell'
              ORDER BY created_at DESC LIMIT 100`,
            [req.user!.userId],
        );
        return res.json({ success: true, trades: rows.rows });
    } catch (e: any) {
        return res.status(500).json({ success: false, error: "Failed to load sell history" });
    }
});

router.post("/sell/:reference/sync", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        await ensureSchema();
        const rows = await query(
            `SELECT * FROM gift_card_trades WHERE reference = $1 AND user_id = $2 AND direction = 'sell'`,
            [String(req.params.reference), req.user!.userId],
        );
        if (rows.rows.length === 0) return res.status(404).json({ success: false, error: "Trade not found" });
        const result = await syncSellTrade(rows.rows[0]);
        const updated = await query(`SELECT * FROM gift_card_trades WHERE id = $1`, [rows.rows[0].id]);
        return res.json({ success: true, updated: result.updated, trade: updated.rows[0] });
    } catch (e: any) {
        return res.status(500).json({ success: false, error: "Sync failed" });
    }
});

// ── BUY ──
router.get("/buy/config", async (_req, res) => {
    try {
        if (!isPrestmitConfigured()) return res.status(503).json({ success: false, error: "Gift card trading is coming soon", code: "PROVIDER_UNCONFIGURED" });
        const cfg = await buyConfig();
        return res.json({ success: true, data: cfg, buy_fee_percent: await buyFeePercent() });
    } catch (e: any) {
        return res.status(502).json({ success: false, error: e?.message || "Failed to load buy catalog" });
    }
});

router.post("/buy/calculate", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { giftCardSKU, price, quantity } = req.body || {};
        if (!giftCardSKU || !price || !quantity) return res.status(400).json({ success: false, error: "giftCardSKU, price and quantity are required" });
        const calc = await buyCalculatePayment({ giftCardSKU: String(giftCardSKU), price: Number(price), quantity: parseInt(String(quantity), 10) });
        const partnerTotal = Number(calc?.totalAmount ?? calc?.amount ?? 0);
        const ourFee = Math.round(partnerTotal * (await buyFeePercent()) / 100 * 100) / 100;
        return res.json({
            success: true,
            partner_total: partnerTotal,
            fee: ourFee,
            total: Math.round((partnerTotal + ourFee) * 100) / 100,
            currency: "NGN",
            raw: calc,
        });
    } catch (e: any) {
        return res.status(502).json({ success: false, error: e?.message || "Calculation failed" });
    }
});

router.post("/buy", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        await ensureSchema();
        const { userId, businessId } = req.user!;
        if (!isPrestmitConfigured()) return res.status(503).json({ success: false, error: "Gift card trading is coming soon", code: "PROVIDER_UNCONFIGURED" });

        const { giftCardSKU, price, quantity, wallet_id, pin, giftcard_name } = req.body || {};
        const qty = Math.max(1, parseInt(String(quantity || 1), 10));
        if (!giftCardSKU || !price) return res.status(400).json({ success: false, error: "giftCardSKU and price are required" });

        if (!pin) return res.status(400).json({ success: false, error: "Transaction PIN is required" });
        // PER-USER PIN: caller's own hash first, legacy business hash fallback.
        const pinCheck = await verifyTransactionPin(String(pin), { userId, businessId });
        if (!pinCheck.ok) {
            return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });
        }

        // Exact partner total (never trust the client's math)
        const calc = await buyCalculatePayment({ giftCardSKU: String(giftCardSKU), price: Number(price), quantity: qty });
        const partnerTotal = Number(calc?.totalAmount ?? calc?.amount ?? 0);
        if (!(partnerTotal > 0)) return res.status(400).json({ success: false, error: "Could not price this order — check the card and try again" });
        const fee = Math.round(partnerTotal * (await buyFeePercent()) / 100 * 100) / 100;
        const total = Math.round((partnerTotal + fee) * 100) / 100;

        // FRAUD GATE (outflow)
        const fraudResult = await evaluateOutflow({
            flow: "giftcard",
            userId, businessId, walletId: wallet_id || null,
            amount: total,
            currency: "NGN",
            ip: (String(req.headers["x-forwarded-for"] || "")).split(",")[0]?.trim() || req.ip || null,
            userAgent: (req.headers["user-agent"] as string) || null,
            deviceId: (req.headers["x-device-id"] as string) || null,
            beneficiary: { accountName: `prestmit-buy:${giftCardSKU}` },
            channel: "prestmit:buy",
        });
        if (fraudResult.decision === "reject") {
            return res.status(403).json({ success: false, error: "This order was declined by our security system.", code: "FRAUD_REJECTED" });
        }
        if (fraudResult.decision === "hold") {
            return res.status(202).json({
                success: true,
                message: "Order received but held for a quick security review. Complete verification in the app to release it.",
                code: "FRAUD_HOLD",
                fraud: { decision: "hold", dueDiligenceId: fraudResult.dueDiligenceId },
            });
        }

        // Wallet + debit
        const walletRes = await query(
            `SELECT * FROM wallets WHERE id = $1 AND (business_id = $2 OR user_id = $3)`,
            [wallet_id, businessId || null, userId],
        );
        const wallet = walletRes.rows[0];
        if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
        if (String(wallet.currency || "NGN").toUpperCase() !== "NGN") {
            return res.status(400).json({ success: false, error: "Gift card purchases are charged in NGN. Select your NGN wallet." });
        }
        const debit = await query(
            `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND balance >= $1 AND status = 'active' RETURNING balance`,
            [total, wallet.id],
        );
        if (debit.rows.length === 0) {
            return res.status(400).json({ success: false, error: `Insufficient balance. This order costs ₦${total.toLocaleString()} (card ₦${partnerTotal.toLocaleString()} + fee ₦${fee.toLocaleString()}).`, code: "INSUFFICIENT_BALANCE" });
        }

        const reference = randomReference("GCB");
        const owningBusinessId: string | null = (wallet.business_id as string) || null;
        const order = await createBuyTrade({
            giftCardSKU: String(giftCardSKU),
            quantity: qty,
            price: Number(price),
            paymentMethod: "NAIRA",
            uniqueIdentifier: reference,
        });
        if (!order.ok) {
            // refund instantly — the partner refused the order
            await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [total, wallet.id]);
            return res.status(400).json({ success: false, error: order.message || "Order rejected by the gift card partner" });
        }

        await query(
            `INSERT INTO gift_card_trades
             (business_id, user_id, wallet_id, direction, reference, prestmit_reference, giftcard_sku,
              giftcard_name, quantity, card_amount, fee, total_charged, currency, status)
             VALUES ($1,$2,$3,'buy',$4,$5,$6,$7,$8,$9,$10,$11,'NGN','pending') RETURNING *`,
            [owningBusinessId, userId, wallet.id, reference, order.reference, String(giftCardSKU),
             giftcard_name || null, qty, Number(price), fee, total],
        );
        await query(
            `INSERT INTO transactions
             (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction, fee)
             VALUES ($1, $2, $3, 'NGN', $4, 'success', 'debit', $5, 'giftcard_buy', $6, 'debit', $7)`,
            [owningBusinessId, userId, total, reference,
             `Gift card purchase — ${giftcard_name || giftCardSKU} ×${qty}`, wallet.id, fee],
        );
        await debitPlatformWallet(partnerTotal, "NGN", `${reference}-VENDOR`, "Platform Wallet Debit for Gift Card Purchase", "prestmit");
        if (fee > 0) await creditRevenueWallet(fee, "NGN", reference, "Gift Card Purchase Fee", "prestmit");

        return res.json({
            success: true,
            message: "Order placed — your code will appear here as soon as the card is delivered",
            reference,
        });
    } catch (error: any) {
        console.error("Giftcard buy error:", error?.message);
        return res.status(500).json({ success: false, error: "Failed to place gift card order" });
    }
});

router.get("/buy/history", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        await ensureSchema();
        const rows = await query(
            `SELECT id, reference, prestmit_reference, giftcard_name, giftcard_sku, quantity, card_amount,
                    fee, total_charged, status, codes, created_at, settled_at
               FROM gift_card_trades WHERE user_id = $1 AND direction = 'buy'
              ORDER BY created_at DESC LIMIT 100`,
            [req.user!.userId],
        );
        return res.json({ success: true, orders: rows.rows });
    } catch (e: any) {
        return res.status(500).json({ success: false, error: "Failed to load buy history" });
    }
});

router.get("/buy/:reference", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        await ensureSchema();
        const rows = await query(
            `SELECT * FROM gift_card_trades WHERE reference = $1 AND user_id = $2 AND direction = 'buy'`,
            [String(req.params.reference), req.user!.userId],
        );
        if (rows.rows.length === 0) return res.status(404).json({ success: false, error: "Order not found" });
        let trade = rows.rows[0];
        if (trade.status === "pending" || trade.status === "processing") {
            try {
                const codes = await buyFetchCodes(trade.prestmit_reference);
                const codeList = codes?.codes || codes?.cards || null;
                if (codeList) {
                    await query(
                        `UPDATE gift_card_trades SET status = 'successful', codes = $2::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                        [trade.id, JSON.stringify(codeList)],
                    );
                    trade = { ...trade, status: "successful", codes: codeList };
                }
            } catch { /* not fulfilled yet */ }
        }
        return res.json({ success: true, order: trade });
    } catch (e: any) {
        return res.status(500).json({ success: false, error: "Failed to load order" });
    }
});

export default router;
