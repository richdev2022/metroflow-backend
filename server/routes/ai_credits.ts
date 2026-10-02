import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../middleware/auth";
import { resolveFeeWallet, creditRevenueWallet } from "../services/fees";
import { getAiCreditBalance } from "../lib/ai-usage";

const router = express.Router();

/**
 * MetricAi Credit Packs — one-time AI usage top-ups.
 *
 * A pack purchase debits the buyer's wallet (personal or business), credits
 * the platform revenue wallet and increments the user's credit balance.
 * Credits are consumed automatically by the MetricAi usage limiter
 * (server/lib/ai-usage.ts) whenever the plan's daily/monthly allowance is
 * exhausted — see tryConsumeAiUsageWithCredits / assertWithinAiUsageWithCredits.
 *
 * Pricing is admin-configurable (ai_credit_packs) with a per-plan discount
 * (pricing_plans.ai_credit_discount_percent, editable via /admin/pricing).
 */

function genReference(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/** Public (authed) pack catalogue + the buyer's current balance. */
router.get("/packs", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const packsRes = await query(
            `SELECT id, name, credits, price, currency, sort_order
             FROM ai_credit_packs WHERE is_active = true
             ORDER BY sort_order ASC, price ASC`
        );

        // Per-plan discount for the buyer's business (if any)
        let discountPercent = 0;
        const businessId = req.user?.businessId;
        if (businessId) {
            const planRes = await query(
                `SELECT p.ai_credit_discount_percent
                 FROM businesses b JOIN pricing_plans p ON p.id = b.plan_id
                 WHERE b.id = $1`,
                [businessId]
            );
            discountPercent = Number(planRes.rows[0]?.ai_credit_discount_percent) || 0;
        }

        const packs = packsRes.rows.map((p: any) => {
            const price = Number(p.price);
            const discounted = Math.max(0, Math.round(price * (1 - discountPercent / 100)));
            return {
                ...p,
                price,
                discount_percent: discountPercent,
                discounted_price: discounted,
                savings: price - discounted,
            };
        });

        const balance = await getAiCreditBalance(userId);
        res.json({ success: true, packs, balance });
    } catch (error) {
        console.error("List AI credit packs error:", error);
        res.status(500).json({ success: false, error: "Failed to load credit packs" });
    }
});

router.get("/balance", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const balance = await getAiCreditBalance(req.user!.userId);
        res.json({ success: true, ...balance });
    } catch (error) {
        console.error("AI credit balance error:", error);
        res.status(500).json({ success: false, error: "Failed to load credit balance" });
    }
});

router.get("/purchases", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const res2 = await query(
            `SELECT id, pack_name, credits, amount, currency, status, reference, created_at
             FROM ai_credit_purchases
             WHERE user_id = $1 AND status IN ('success', 'failed')
             ORDER BY created_at DESC LIMIT 50`,
            [userId]
        );
        res.json({ success: true, purchases: res2.rows });
    } catch (error) {
        console.error("AI credit purchases error:", error);
        res.status(500).json({ success: false, error: "Failed to load purchase history" });
    }
});

/**
 * Purchase a credit pack. Charged from the best available wallet (business
 * first, then personal) — the same resolver used for OTP fees. Atomic credit
 * grant; revenue lands in the platform revenue wallet.
 */
router.post("/purchase", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user?.businessId || null;
        const { pack_id, wallet_id } = req.body || {};

        if (!pack_id) return res.status(400).json({ success: false, error: "pack_id is required" });

        const packRes = await query(
            `SELECT * FROM ai_credit_packs WHERE id = $1 AND is_active = true`,
            [pack_id]
        );
        const pack = packRes.rows[0];
        if (!pack) return res.status(404).json({ success: false, error: "Credit pack not found" });

        // Apply plan discount
        let price = Number(pack.price);
        if (businessId) {
            const planRes = await query(
                `SELECT p.ai_credit_discount_percent
                 FROM businesses b JOIN pricing_plans p ON p.id = b.plan_id
                 WHERE b.id = $1`,
                [businessId]
            );
            const discount = Number(planRes.rows[0]?.ai_credit_discount_percent) || 0;
            if (discount > 0) price = Math.max(0, Math.round(price * (1 - discount / 100)));
        }

        // Resolve a chargeable wallet (explicit wallet_id wins)
        const wallet = await resolveFeeWallet(businessId, userId, wallet_id || null);
        if (!wallet) {
            return res.status(400).json({ success: false, error: "No wallet found to charge. Please fund a wallet first." });
        }
        if (parseFloat(wallet.balance) < price) {
            return res.status(400).json({ success: false, error: `Insufficient wallet balance. This pack costs ${price} ${wallet.currency}.` });
        }

        const reference = genReference("AI-CREDIT");

        // Debit the buyer's wallet
        await query(
            `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [price, wallet.id]
        );
        await query(
            `INSERT INTO transactions
             (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee)
             VALUES ($1, $2, $3, 'success', $4, 'debit', $5, 'purchase', $6, 'debit', 0)`,
            [businessId, price, wallet.currency, reference, `MetricAi Credit Pack — ${pack.name} (${pack.credits} credits)`, wallet.id]
        );
        await creditRevenueWallet(price, wallet.currency, reference, `MetricAi Credit Pack — ${pack.name} (revenue)`);

        // Grant credits atomically
        await query(
            `INSERT INTO ai_credit_balances (user_id, business_id, balance)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE
             SET balance = ai_credit_balances.balance + $3,
                 business_id = $2,
                 updated_at = CURRENT_TIMESTAMP`,
            [userId, businessId, pack.credits]
        );
        await query(
            `INSERT INTO ai_credit_purchases
             (user_id, business_id, pack_id, pack_name, credits, amount, currency, status, reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'success', $8)`,
            [userId, businessId, pack.id, pack.name, pack.credits, price, wallet.currency, reference]
        );

        const balance = await getAiCreditBalance(userId);
        res.json({
            success: true,
            message: `${pack.credits} MetricAi credits added`,
            credits_added: pack.credits,
            amount_charged: price,
            currency: wallet.currency,
            balance,
        });
    } catch (error) {
        console.error("AI credit purchase error:", error);
        res.status(500).json({ success: false, error: "Failed to purchase credit pack" });
    }
});

export default router;
