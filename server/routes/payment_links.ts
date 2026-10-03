import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../middleware/auth";
import { requireTeamPermission } from "../middleware/teamAuth";
import { getProvider } from "../services/providers/factory";
import { calculateFee, creditPlatformWallet, creditRevenueWallet } from "../services/fees";
import { createNotification } from "../services/notifications";

const router = express.Router();

/**
 * Payment Links ("Get Paid") — a REVENUE feature.
 *
 * Businesses create shareable payment links (fixed or open amount). Customers
 * pay through the active payment provider's hosted checkout; the webhook
 * credits the business wallet minus a collection fee (fee_configurations
 * 'payment_link' — 1.5% capped ₦2,000 by default, reduced by the business's
 * plan-level payment_link_fee_discount_percent). The fee lands in the
 * platform revenue wallet via creditRevenueWallet.
 *
 * Plan configuration (pricing_plans, admin-editable):
 *   - payment_links_enabled           (feature toggle)
 *   - max_payment_links               (NULL/999999+ = unlimited)
 *   - payment_link_fee_discount_percent
 */

const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function randomSlug(len = 8): string {
    let out = "";
    for (let i = 0; i < len; i++) out += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
    return out;
}

async function getPlanConfig(businessId: string) {
    const res = await query(
        `SELECT p.payment_links_enabled, p.max_payment_links, p.payment_link_fee_discount_percent
         FROM businesses b JOIN pricing_plans p ON p.id = b.plan_id
         WHERE b.id = $1`,
        [businessId]
    );
    return res.rows[0] || null;
}

function effectiveFee(gross: number, baseFee: number, discountPercent: number): number {
    if (!(baseFee > 0)) return 0;
    const reduced = baseFee * (1 - Math.min(Math.max(discountPercent, 0), 100) / 100);
    return Math.max(0, Math.round(reduced * 100) / 100);
}

// ---------------------------------------------------------------------------
// Authenticated endpoints (link owners)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * tags:
 *   name: Payment Links
 *   description: Shareable checkout links for businesses — a revenue feature
 *     (collection fee lands in the platform revenue wallet, plan-configurable)
 */

/**
 * @openapi
 * /payment-links:
 *   get:
 *     summary: List the business's payment links with payment stats
 *     tags: [Payment Links]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Payment links (newest first)
 */
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const linksRes = await query(
            `SELECT l.*,
                    COALESCE((SELECT COUNT(*)::int FROM payment_link_payments q
                              WHERE q.link_id = l.id AND q.status = 'success'), 0) AS successful_payments,
                    COALESCE((SELECT SUM(q.net_amount) FROM payment_link_payments q
                              WHERE q.link_id = l.id AND q.status = 'success'), 0) AS total_collected
             FROM payment_links l
             WHERE l.business_id = $1
             ORDER BY l.created_at DESC`,
            [businessId]
        );
        res.json({ success: true, links: linksRes.rows });
    } catch (error) {
        console.error("List payment links error:", error);
        res.status(500).json({ success: false, error: "Failed to load payment links" });
    }
});

/**
 * @openapi
 * /payment-links:
 *   post:
 *     summary: Create a payment link (fixed or custom amount, plan-gated)
 *     tags: [Payment Links]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string }
 *               description: { type: string }
 *               amount: { type: number, description: "Required unless allow_custom_amount is true" }
 *               currency: { type: string, default: NGN }
 *               allow_custom_amount: { type: boolean }
 *     responses:
 *       200:
 *         description: Created link (shareable slug returned)
 *       403:
 *         description: Plan limit reached or feature disabled (PLAN_UPGRADE_REQUIRED)
 */
router.post("/", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_payment_links"), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const userId = req.user!.userId;
        const { title, description, amount, currency, allow_custom_amount } = req.body || {};

        if (!title || !String(title).trim()) {
            return res.status(400).json({ success: false, error: "Title is required" });
        }

        // Plan gating
        const plan = await getPlanConfig(businessId);
        if (plan && plan.payment_links_enabled === false) {
            return res.status(403).json({
                success: false,
                error: "Payment Links are not available on your current plan. Kindly upgrade your plan.",
                code: "PLAN_UPGRADE_REQUIRED",
            });
        }
        if (plan?.max_payment_links != null && plan.max_payment_links < 999999) {
            const countRes = await query(`SELECT COUNT(*)::int AS c FROM payment_links WHERE business_id = $1`, [businessId]);
            if (countRes.rows[0].c >= plan.max_payment_links) {
                return res.status(403).json({
                    success: false,
                    error: `Your plan allows up to ${plan.max_payment_links} payment link(s). Kindly upgrade your plan to create more.`,
                    code: "PLAN_UPGRADE_REQUIRED",
                });
            }
        }

        const parsedAmount = amount != null && Number(amount) > 0 ? Number(amount) : null;
        const isCustom = allow_custom_amount === true;
        if (!parsedAmount && !isCustom) {
            return res.status(400).json({ success: false, error: "Provide a fixed amount or enable 'let customer choose amount'" });
        }

        // Unique slug with retries
        let slug = randomSlug();
        for (let i = 0; i < 5; i++) {
            const exists = await query(`SELECT 1 FROM payment_links WHERE slug = $1`, [slug]);
            if (exists.rows.length === 0) break;
            slug = randomSlug(i >= 2 ? 10 : 8);
        }

        const insertRes = await query(
            `INSERT INTO payment_links (business_id, created_by, slug, title, description, amount, currency, allow_custom_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [businessId, userId, slug, String(title).trim(), description || null, parsedAmount, currency || 'NGN', isCustom]
        );

        res.json({ success: true, link: insertRes.rows[0] });
    } catch (error) {
        console.error("Create payment link error:", error);
        res.status(500).json({ success: false, error: "Failed to create payment link" });
    }
});

/**
 * @openapi
 * /payment-links/{id}:
 *   put:
 *     summary: Update a payment link (title, description, amount, custom-amount, active state)
 *     tags: [Payment Links]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated link
 *       404:
 *         description: Link not found
 */
router.put("/:id", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_payment_links"), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { id } = req.params;
        const { title, description, amount, currency, allow_custom_amount, is_active } = req.body || {};

        const linkRes = await query(`SELECT * FROM payment_links WHERE id = $1 AND business_id = $2`, [id, businessId]);
        if (linkRes.rows.length === 0) return res.status(404).json({ success: false, error: "Payment link not found" });

        const updated = await query(
            `UPDATE payment_links SET
                title = COALESCE($2, title),
                description = COALESCE($3, description),
                amount = COALESCE($4, amount),
                currency = COALESCE($5, currency),
                allow_custom_amount = COALESCE($6, allow_custom_amount),
                is_active = COALESCE($7, is_active),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING *`,
            [id, title || null, description ?? null, amount != null && Number(amount) > 0 ? Number(amount) : null,
             currency || null, allow_custom_amount ?? null, is_active ?? null]
        );

        res.json({ success: true, link: updated.rows[0] });
    } catch (error) {
        console.error("Update payment link error:", error);
        res.status(500).json({ success: false, error: "Failed to update payment link" });
    }
});

/**
 * @openapi
 * /payment-links/{id}:
 *   delete:
 *     summary: Delete a payment link
 *     tags: [Payment Links]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Link not found
 */
router.delete("/:id", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_payment_links"), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { id } = req.params;
        const delRes = await query(`DELETE FROM payment_links WHERE id = $1 AND business_id = $2 RETURNING id`, [id, businessId]);
        if (delRes.rows.length === 0) return res.status(404).json({ success: false, error: "Payment link not found" });
        res.json({ success: true, message: "Payment link deleted" });
    } catch (error) {
        console.error("Delete payment link error:", error);
        res.status(500).json({ success: false, error: "Failed to delete payment link" });
    }
});

/**
 * @openapi
 * /payment-links/{id}/payments:
 *   get:
 *     summary: List payments received through a link
 *     tags: [Payment Links]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Link payments (newest first)
 *       404:
 *         description: Link not found
 */
router.get("/:id/payments", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { id } = req.params;
        const linkRes = await query(`SELECT id FROM payment_links WHERE id = $1 AND business_id = $2`, [id, businessId]);
        if (linkRes.rows.length === 0) return res.status(404).json({ success: false, error: "Payment link not found" });

        const paymentsRes = await query(
            `SELECT * FROM payment_link_payments WHERE link_id = $1 ORDER BY created_at DESC LIMIT 200`,
            [id]
        );
        res.json({ success: true, payments: paymentsRes.rows });
    } catch (error) {
        console.error("Payment link payments error:", error);
        res.status(500).json({ success: false, error: "Failed to load link payments" });
    }
});

// ---------------------------------------------------------------------------
// Public endpoints (no auth — customers paying a link)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /payment-links/public/{slug}:
 *   get:
 *     summary: Public payment link view (no auth — customer checkout)
 *     tags: [Payment Links]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Link details + business name
 *       404:
 *         description: Link not found or inactive
 */
router.get("/public/:slug", async (req, res) => {
    try {
        const { slug } = req.params;
        const linkRes = await query(`SELECT * FROM payment_links WHERE slug = $1`, [slug]);
        const link = linkRes.rows[0];
        if (!link || !link.is_active) {
            return res.status(404).json({ success: false, error: "Payment link not found or inactive" });
        }

        // Business display info
        const bizRes = await query(`SELECT name FROM businesses WHERE id = $1`, [link.business_id]);

        // Fire-and-forget view counter
        query(`UPDATE payment_links SET views = views + 1 WHERE id = $1`, [link.id]).catch(() => {});

        res.json({
            success: true,
            link: {
                slug: link.slug,
                title: link.title,
                description: link.description,
                amount: link.amount != null ? Number(link.amount) : null,
                currency: link.currency || 'NGN',
                allow_custom_amount: link.allow_custom_amount === true,
            },
            business_name: bizRes.rows[0]?.name || "Metricorex Business",
        });
    } catch (error) {
        console.error("Public payment link error:", error);
        res.status(500).json({ success: false, error: "Failed to load payment link" });
    }
});

/**
 * Initiate a customer payment: creates the pending payment record + pending
 * transaction and returns the provider's hosted checkout URL.
 */
/**
 * @openapi
 * /payment-links/public/{slug}/initiate:
 *   post:
 *     summary: Initiate a customer payment (returns hosted checkout URL, settled by webhook)
 *     tags: [Payment Links]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [payer_email]
 *             properties:
 *               amount: { type: number, description: "Required for custom-amount links" }
 *               payer_name: { type: string }
 *               payer_email: { type: string }
 *               provider: { type: string, description: "Optional provider override" }
 *     responses:
 *       200:
 *         description: checkout_url + reference
 *       404:
 *         description: Link not found or inactive
 *       502:
 *         description: Provider initiation failed
 */
router.post("/public/:slug/initiate", async (req, res) => {
    try {
        const { slug } = req.params;
        const { amount, payer_name, payer_email, provider: requestedProvider } = req.body || {};

        const linkRes = await query(`SELECT * FROM payment_links WHERE slug = $1`, [slug]);
        const link = linkRes.rows[0];
        if (!link || !link.is_active) {
            return res.status(404).json({ success: false, error: "Payment link not found or inactive" });
        }

        const currency = (link.currency || 'NGN').toUpperCase();
        let payAmount: number;
        if (link.allow_custom_amount === true) {
            payAmount = Number(amount);
        } else {
            payAmount = Number(link.amount);
        }
        if (!payAmount || payAmount <= 0) {
            return res.status(400).json({ success: false, error: "A valid payment amount is required" });
        }
        if (!payer_email || !String(payer_email).trim()) {
            return res.status(400).json({ success: false, error: "Payer email is required" });
        }

        // Find the business's chargeable (NGN-first) wallet for crediting later
        const walletRes = await query(
            `SELECT id FROM wallets WHERE business_id = $1 ORDER BY (currency = 'NGN') DESC LIMIT 1`,
            [link.business_id]
        );
        if (walletRes.rows.length === 0) {
            return res.status(400).json({ success: false, error: "This business has no settlement wallet yet. Please contact the merchant." });
        }

        const reference = `PL-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

        // Pending ledger rows — the webhook settles both
        await query(
            `INSERT INTO payment_link_payments
             (link_id, business_id, transaction_reference, payer_name, payer_email, amount, fee, net_amount, currency, status, payment_provider)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $6, $7, 'pending', $8)`,
            [link.id, link.business_id, reference, payer_name || null, String(payer_email).trim(), payAmount, currency, requestedProvider || null]
        );
        await query(
            `INSERT INTO transactions (business_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, payment_provider)
             VALUES ($1, $2, $3, $4, 'pending', 'credit', $5, 'payment_link', $6, $7)`,
            [link.business_id, payAmount, currency, reference, `Payment Link: ${link.title}`, walletRes.rows[0].id, requestedProvider || null]
        );

        // Hosted checkout via the active payment provider (amount in kobo/minor unit)
        const providerName = requestedProvider || await getActiveProviderName();
        const provider = getProvider(providerName);
        const origin = req.get('origin') || process.env.APP_BASE_URL || 'https://app.metricorex.com';
        const baseUrl = String(origin).endsWith('/') ? String(origin).slice(0, -1) : String(origin);
        const callbackUrl = `${baseUrl}/pay/${link.slug}`;

        let paymentResponse: any;
        try {
            paymentResponse = await provider.initiatePayment({
                email: String(payer_email).trim(),
                amount: Math.round(payAmount * 100),
                reference,
                callbackUrl,
                currency,
            });
        } catch (providerError: any) {
            console.error("Payment link provider initiation failed:", providerError?.message);
            await query(`UPDATE payment_link_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE transaction_reference = $1`, [reference]);
            await query(`UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE reference = $1`, [reference]);
            return res.status(502).json({ success: false, error: "Could not start the payment. Please try again." });
        }

        const checkoutUrl = paymentResponse?.data?.checkout_url || paymentResponse?.data?.link || paymentResponse?.checkout_url;
        if (!checkoutUrl) {
            await query(`UPDATE payment_link_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE transaction_reference = $1`, [reference]);
            await query(`UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE reference = $1`, [reference]);
            return res.status(502).json({ success: false, error: "Payment provider did not return a checkout URL" });
        }

        res.json({ success: true, checkout_url: checkoutUrl, reference, amount: payAmount, currency });
    } catch (error) {
        console.error("Payment link initiate error:", error);
        res.status(500).json({ success: false, error: "Failed to initiate payment" });
    }
});

async function getActiveProviderName(): Promise<string> {
    const res = await query(`SELECT value FROM system_settings WHERE key = 'active_payment_provider' LIMIT 1`);
    return res.rows[0]?.value || process.env.DEFAULT_PAYMENT_PROVIDER || 'flutterwave';
}

// ---------------------------------------------------------------------------
// Webhook settlement — called by server/routes/webhook.ts when a charge with
// transaction_type 'payment_link' succeeds. Idempotent: the payment row flips
// pending → success exactly once.
// ---------------------------------------------------------------------------

export async function settlePaymentLinkPayment(reference: string, providerName: string): Promise<void> {
    const paymentRes = await query(
        `SELECT * FROM payment_link_payments
         WHERE transaction_reference = $1 AND status = 'pending'`,
        [reference]
    );
    const payment = paymentRes.rows[0];
    if (!payment) return; // already settled or unknown — nothing to do

    const gross = Number(payment.amount);
    const currency = payment.currency || 'NGN';

    // Collection fee: base config, reduced by the merchant's plan discount
    const baseFee = await calculateFee(gross, 'payment_link');
    const plan = await getPlanConfig(payment.business_id);
    const fee = effectiveFee(gross, baseFee, Number(plan?.payment_link_fee_discount_percent) || 0);
    const net = Math.max(0, gross - fee);

    // Business settlement wallet (NGN first)
    const walletRes = await query(
        `SELECT id FROM wallets WHERE business_id = $1 ORDER BY (currency = 'NGN') DESC LIMIT 1`,
        [payment.business_id]
    );
    if (walletRes.rows.length === 0) {
        console.error(`settlePaymentLinkPayment: no settlement wallet for business ${payment.business_id} (ref ${reference})`);
        return;
    }
    const walletId = walletRes.rows[0].id;

    // Flip the payment row FIRST (idempotency gate), then move the money.
    await query(
        `UPDATE payment_link_payments
         SET status = 'success', fee = $2, net_amount = $3, payment_provider = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [payment.id, fee, net, providerName]
    );

    await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [net, walletId]);
    await query(
        `UPDATE transactions
         SET status = 'success', fee = $2, updated_at = CURRENT_TIMESTAMP
         WHERE reference = $1`,
        [reference, fee]
    );
    await query(
        `INSERT INTO transactions
         (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider)
         VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'payment_link', $6, 'credit', $7, $8)
         ON CONFLICT (reference) DO NOTHING`,
        [payment.business_id, net, currency, `${reference}-SETTLED`, `Payment Link collection (net of ${fee} ${currency} fee)`, walletId, fee, providerName]
    );

    // Pool ledger: the customer's gateway payment IS a real pool inflow.
    // The merchant settlement is an internal wallet credit (no pool movement).
    await creditPlatformWallet(gross, currency, reference, 'Payment Link Customer Payment Received', providerName);
    if (fee > 0) {
        await creditRevenueWallet(fee, currency, reference, 'Payment Link Collection Fee', providerName);
    }

    // Notify the merchant
    const linkRes = await query(`SELECT title, created_by FROM payment_links WHERE id = $1`, [payment.link_id]);
    const link = linkRes.rows[0];
    try {
        await createNotification({
            businessId: payment.business_id,
            userId: link?.created_by || null,
            type: "credit",
            title: "New Payment Received",
            message: `You received ${net.toLocaleString()} ${currency}${fee > 0 ? ` (fee: ${fee} ${currency})` : ''}${payment.payer_name ? ` from ${payment.payer_name}` : ''} via "${link?.title || 'Payment Link'}"`,
            actionUrl: "/payment-links",
            actionType: "view_payment_link",
            metadata: { reference, amount: gross, fee, net, linkId: payment.link_id },
            isActionable: false,
            expiresInHours: 72,
        });
    } catch (notifErr) {
        console.error("Payment link notification failed:", notifErr);
    }
}

export default router;
