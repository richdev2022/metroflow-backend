import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../middleware/auth";
import { requireTeamPermission } from "../middleware/teamAuth";
import { calculateFee, creditPlatformWallet, debitPlatformWallet, creditRevenueWallet } from "../services/fees";
import { createNotification } from "../services/notifications";
import { getProvider } from "../services/providers/factory";
import { sendEmail } from "../services/email";

const router = express.Router();

/**
 * Recurring Billing (Customer Subscriptions) — a BUSINESS revenue feature.
 *
 * Businesses create subscription plans (daily / weekly / monthly) and share a
 * public subscribe link. Subscribers either auto-pay from their Metroflow
 * wallet (when the subscriber email maps to a platform user with an NGN
 * wallet — charged by the 5-minute cron engine, mandate style) or receive an
 * emailed hosted-checkout link each cycle. Every successful charge credits
 * the merchant wallet minus a platform fee (fee_configurations 'subscription'
 * — 2% capped ₦2,000 by default, reduced by the plan-level
 * subscription_fee_discount_percent) which lands in the platform revenue
 * wallet via creditRevenueWallet.
 *
 * Plan configuration (pricing_plans, admin-editable via /admin/pricing):
 *   - recurring_enabled                   (feature toggle)
 *   - max_subscription_plans              (NULL/999999+ = unlimited)
 *   - subscription_fee_discount_percent
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getPlanConfig(businessId: string) {
    const res = await query(
        `SELECT p.recurring_enabled, p.max_subscription_plans, p.subscription_fee_discount_percent
         FROM businesses b JOIN pricing_plans p ON p.id = b.plan_id
         WHERE b.id = $1`,
        [businessId]
    );
    return res.rows[0] || null;
}

function effectiveFee(baseFee: number, discountPercent: number): number {
    if (!(baseFee > 0)) return 0;
    const reduced = baseFee * (1 - Math.min(Math.max(discountPercent, 0), 100) / 100);
    return Math.max(0, Math.round(reduced * 100) / 100);
}

async function getActiveProviderName(): Promise<string> {
    const res = await query(`SELECT value FROM system_settings WHERE key = 'active_payment_provider' LIMIT 1`);
    return res.rows[0]?.value || process.env.DEFAULT_PAYMENT_PROVIDER || 'flutterwave';
}

function isValidInterval(v: string): boolean {
    return ["daily", "weekly", "monthly"].includes(v);
}

function nextDate(from: Date, interval: string): Date {
    const n = new Date(from);
    if (interval === "monthly") n.setMonth(n.getMonth() + 1);
    else n.setDate(n.getDate() + (interval === "weekly" ? 7 : 1));
    return n;
}

function dateOnly(d: Date | string): string {
    return new Date(d).toISOString().slice(0, 10);
}

function monthlyNormalized(amount: number, interval: string): number {
    if (interval === "daily") return amount * 30;
    if (interval === "weekly") return amount * 4;
    return amount;
}

function randomChargeReference(): string {
    return `SUBC-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/** Resolve the subscriber's chargeable NGN wallet (explicit pick, else their personal NGN wallet). */
async function resolveSubscriberWallet(customerUserId: string | null, walletId: string | null): Promise<any | null> {
    if (!customerUserId) return null;
    if (walletId) {
        const w = await query(`SELECT * FROM wallets WHERE id = $1 AND user_id = $2 AND status = 'active'`, [walletId, customerUserId]);
        if (w.rows[0]) return w.rows[0];
    }
    const def = await query(
        `SELECT * FROM wallets
         WHERE user_id = $1 AND currency = 'NGN' AND status = 'active'
         ORDER BY (business_id IS NULL) DESC, balance DESC LIMIT 1`,
        [customerUserId]
    );
    return def.rows[0] || null;
}

async function findPlatformUserByEmail(email: string): Promise<string | null> {
    const res = await query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) ORDER BY created_at ASC LIMIT 1`, [email]);
    return res.rows[0]?.id || null;
}

async function getMerchantSettlementWallet(businessId: string): Promise<any | null> {
    const res = await query(
        `SELECT id FROM wallets WHERE business_id = $1 ORDER BY (currency = 'NGN') DESC LIMIT 1`,
        [businessId]
    );
    return res.rows[0] || null;
}

async function baseUrlFromEnv(): Promise<string> {
    const base = process.env.APP_BASE_URL || "https://app.metricorex.com";
    return String(base).endsWith("/") ? String(base).slice(0, -1) : String(base);
}

// ---------------------------------------------------------------------------
// Root tag
// ---------------------------------------------------------------------------

/**
 * @openapi
 * tags:
 *   name: Recurring Billing
 *   description: Customer subscriptions — auto-charging recurring plans for
 *     businesses — a revenue feature (charge fee lands in the platform revenue
 *     wallet, plan-configurable via subscription_fee_discount_percent)
 */

// ---------------------------------------------------------------------------
// Merchant endpoints (authenticated)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /recurring/plans:
 *   get:
 *     summary: List the business's subscription plans + stats
 *     tags: [Recurring Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Plans with subscriber counts + MRR estimate
 */
router.get("/plans", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const plans = await query(
            `SELECT p.*, COUNT(s.id) FILTER (WHERE s.status = 'active')::int AS active_subscribers,
                    COUNT(s.id)::int AS total_subscribers
             FROM customer_subscription_plans p
             LEFT JOIN customer_subscribers s ON s.plan_id = p.id
             WHERE p.business_id = $1
             GROUP BY p.id
             ORDER BY p.created_at DESC`,
            [businessId]
        );
        const stats = await query(
            `SELECT
                (SELECT COUNT(*)::int FROM customer_subscription_plans WHERE business_id = $1) AS total_plans,
                (SELECT COUNT(*)::int FROM customer_subscribers WHERE business_id = $1 AND status = 'active') AS active_subscribers,
                (SELECT COUNT(*)::int FROM customer_subscribers WHERE business_id = $1 AND status = 'past_due') AS past_due,
                (SELECT COALESCE(SUM(CASE WHEN s.status = 'active'
                        THEN CASE p2.interval WHEN 'daily' THEN p2.amount * 30 WHEN 'weekly' THEN p2.amount * 4 ELSE p2.amount END
                        ELSE 0 END), 0)
                  FROM customer_subscribers s JOIN customer_subscription_plans p2 ON p2.id = s.plan_id
                  WHERE s.business_id = $1) AS estimated_monthly_revenue,
                (SELECT COALESCE(SUM(fee), 0) FROM subscription_charges WHERE business_id = $1 AND status = 'success') AS total_fees_paid
             `,
            [businessId]
        );
        const plan = await getPlanConfig(businessId);
        res.json({
            success: true,
            plans: plans.rows,
            stats: stats.rows[0],
            billing: {
                enabled: plan ? plan.recurring_enabled !== false : true,
                max_plans: plan?.max_subscription_plans ?? null,
            },
        });
    } catch (error) {
        console.error("List subscription plans error:", error);
        res.status(500).json({ success: false, error: "Failed to load subscription plans" });
    }
});

/**
 * @openapi
 * /recurring/plans:
 *   post:
 *     summary: Create a customer subscription plan (plan-gated)
 *     tags: [Recurring Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, amount, interval]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               amount: { type: number }
 *               interval: { type: string, enum: [daily, weekly, monthly] }
 *     responses:
 *       200:
 *         description: Plan created
 *       403:
 *         description: Recurring billing disabled or plan cap reached (PLAN_UPGRADE_REQUIRED)
 */
router.post("/plans", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_subscriptions"), async (req: AuthenticatedRequest, res) => {
    try {
        const { userId, businessId } = req.user!;
        const { name, description, amount, interval } = req.body || {};

        const planName = String(name || "").trim();
        if (!planName) return res.status(400).json({ success: false, error: "Plan name is required" });
        const planAmount = Math.round(Number(amount) * 100) / 100;
        if (!planAmount || planAmount < 100) {
            return res.status(400).json({ success: false, error: "Amount must be at least ₦100" });
        }
        if (!isValidInterval(String(interval || ""))) {
            return res.status(400).json({ success: false, error: "Interval must be daily, weekly or monthly" });
        }

        const config = await getPlanConfig(businessId);
        if (config && config.recurring_enabled === false) {
            return res.status(403).json({
                success: false,
                error: "Recurring billing is not available on your current plan. Kindly upgrade your plan.",
                code: "PLAN_UPGRADE_REQUIRED",
            });
        }
        if (config?.max_subscription_plans != null && config.max_subscription_plans < 999999) {
            const countRes = await query(
                `SELECT COUNT(*)::int AS c FROM customer_subscription_plans WHERE business_id = $1`,
                [businessId]
            );
            if (countRes.rows[0].c >= config.max_subscription_plans) {
                return res.status(403).json({
                    success: false,
                    error: `Your plan allows up to ${config.max_subscription_plans} subscription plan(s). Kindly upgrade your plan for more.`,
                    code: "PLAN_UPGRADE_REQUIRED",
                });
            }
        }

        const created = await query(
            `INSERT INTO customer_subscription_plans (business_id, created_by, name, description, amount, interval)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [businessId, userId, planName, description ? String(description).trim() : null, planAmount, String(interval)]
        );
        res.json({ success: true, plan: created.rows[0] });
    } catch (error) {
        console.error("Create subscription plan error:", error);
        res.status(500).json({ success: false, error: "Failed to create subscription plan" });
    }
});

/**
 * @openapi
 * /recurring/plans/{id}:
 *   put:
 *     summary: Update a subscription plan (pause/resume, reprice)
 *     tags: [Recurring Billing]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated plan
 */
router.put("/plans/:id", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_subscriptions"), async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const { id } = req.params;
        const { name, description, amount, interval, status } = req.body || {};

        const planAmount = amount != null && amount !== "" ? Math.round(Number(amount) * 100) / 100 : null;
        if (planAmount != null && planAmount < 100) {
            return res.status(400).json({ success: false, error: "Amount must be at least ₦100" });
        }
        const validStatus = ["active", "paused"].includes(status) ? status : null;

        const updated = await query(
            `UPDATE customer_subscription_plans SET
                name = COALESCE($2, name),
                description = COALESCE($3, description),
                amount = COALESCE($4, amount),
                interval = COALESCE($5, interval),
                status = COALESCE($6, status),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND business_id = $7 RETURNING *`,
            [id, name != null ? String(name).trim() : null, description != null ? String(description).trim() : null,
             planAmount, isValidInterval(String(interval || "")) ? String(interval) : null, validStatus, businessId]
        );
        if (updated.rows.length === 0) return res.status(404).json({ success: false, error: "Subscription plan not found" });
        res.json({ success: true, plan: updated.rows[0] });
    } catch (error) {
        console.error("Update subscription plan error:", error);
        res.status(500).json({ success: false, error: "Failed to update subscription plan" });
    }
});

/**
 * @openapi
 * /recurring/plans/{id}:
 *   delete:
 *     summary: Delete a subscription plan (only when it has no subscribers)
 *     tags: [Recurring Billing]
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
 *       400:
 *         description: Plan still has subscribers
 */
router.delete("/plans/:id", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_subscriptions"), async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const { id } = req.params;
        const subRes = await query(`SELECT COUNT(*)::int AS c FROM customer_subscribers WHERE plan_id = $1`, [id]);
        if (subRes.rows[0].c > 0) {
            return res.status(400).json({ success: false, error: "This plan still has subscribers. Cancel them first or pause the plan." });
        }
        const deleted = await query(
            `DELETE FROM customer_subscription_plans WHERE id = $1 AND business_id = $2 RETURNING id`,
            [id, businessId]
        );
        if (deleted.rows.length === 0) return res.status(404).json({ success: false, error: "Subscription plan not found" });
        res.json({ success: true, message: "Subscription plan deleted" });
    } catch (error) {
        console.error("Delete subscription plan error:", error);
        res.status(500).json({ success: false, error: "Failed to delete subscription plan" });
    }
});

/**
 * @openapi
 * /recurring/subscribers:
 *   get:
 *     summary: List subscribers (+ charges stats)
 *     tags: [Recurring Billing]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: plan_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, past_due, cancelled, all] }
 *     responses:
 *       200:
 *         description: Subscribers with plan info + stats
 */
router.get("/subscribers", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const params: unknown[] = [businessId];
        let where = `s.business_id = $1`;
        const planId = String(req.query.plan_id || "").trim();
        if (planId) {
            params.push(planId);
            where += ` AND s.plan_id = $${params.length}`;
        }
        const status = String(req.query.status || "").trim();
        if (status && status !== "all") {
            params.push(status);
            where += ` AND s.status = $${params.length}`;
        }
        const subscribers = await query(
            `SELECT s.*, p.name AS plan_name, p.amount AS plan_amount, p.interval AS plan_interval, p.public_id AS plan_public_id
             FROM customer_subscribers s JOIN customer_subscription_plans p ON p.id = s.plan_id
             WHERE ${where}
             ORDER BY s.created_at DESC LIMIT 200`,
            params
        );
        const stats = await query(
            `SELECT COUNT(*)::int AS total_subscribers,
                    COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0)::int AS active_subscribers,
                    COALESCE(SUM(CASE WHEN status = 'past_due' THEN 1 ELSE 0 END), 0)::int AS past_due,
                    COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0)::int AS cancelled
             FROM customer_subscribers WHERE business_id = $1`,
            [businessId]
        );
        const charges = await query(
            `SELECT COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) AS gross_collected,
                    COALESCE(SUM(CASE WHEN status = 'success' THEN fee ELSE 0 END), 0) AS total_fees,
                    COALESCE(SUM(CASE WHEN status = 'success' THEN net_amount ELSE 0 END), 0) AS net_collected,
                    COUNT(*) FILTER (WHERE status = 'success')::int AS successful_charges
             FROM subscription_charges WHERE business_id = $1`,
            [businessId]
        );
        res.json({ success: true, subscribers: subscribers.rows, stats: stats.rows[0], charges: charges.rows[0] });
    } catch (error) {
        console.error("List subscribers error:", error);
        res.status(500).json({ success: false, error: "Failed to load subscribers" });
    }
});

/**
 * @openapi
 * /recurring/subscribers:
 *   post:
 *     summary: Add a subscriber (merchant-added customer, first charge starts today)
 *     tags: [Recurring Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plan_id, customer_name, customer_email]
 *             properties:
 *               plan_id: { type: string, format: uuid }
 *               customer_name: { type: string }
 *               customer_email: { type: string }
 *               customer_phone: { type: string }
 *     responses:
 *       200:
 *         description: Subscriber added (wallet-charged now, or checkout_url for the first cycle)
 *       400:
 *         description: Invalid plan / already subscribed
 */
router.post("/subscribers", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_subscriptions"), async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const { plan_id, customer_name, customer_email, customer_phone } = req.body || {};

        const customerEmail = String(customer_email || "").trim();
        if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
            return res.status(400).json({ success: false, error: "A valid customer email is required" });
        }
        const customerName = String(customer_name || "").trim();
        if (!customerName) return res.status(400).json({ success: false, error: "Customer name is required" });

        const planRes = await query(
            `SELECT * FROM customer_subscription_plans WHERE id = $1 AND business_id = $2`,
            [plan_id, businessId]
        );
        const plan = planRes.rows[0];
        if (!plan) return res.status(404).json({ success: false, error: "Subscription plan not found" });
        if (plan.status !== "active") return res.status(400).json({ success: false, error: "This plan is paused" });

        const existing = await query(
            `SELECT * FROM customer_subscribers WHERE plan_id = $1 AND LOWER(customer_email) = LOWER($2)`,
            [plan.id, customerEmail]
        );
        if (existing.rows[0] && existing.rows[0].status !== "cancelled") {
            return res.status(400).json({ success: false, error: "This customer is already on this plan" });
        }

        const result = await createSubscriberAndFirstCharge({
            businessId,
            plan,
            customerName,
            customerEmail,
            customerPhone: customer_phone ? String(customer_phone).trim() : null,
            existingSubscriber: existing.rows[0] || null,
        });
        res.json(result);
    } catch (error) {
        console.error("Add subscriber error:", error);
        res.status(500).json({ success: false, error: "Failed to add subscriber" });
    }
});

/**
 * @openapi
 * /recurring/subscribers/{id}:
 *   delete:
 *     summary: Cancel a subscriber (stops future charges)
 *     tags: [Recurring Billing]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cancelled
 */
router.delete("/subscribers/:id", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_subscriptions"), async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const { id } = req.params;
        const updated = await query(
            `UPDATE customer_subscribers SET status = 'cancelled', next_charge_date = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND business_id = $2 RETURNING id`,
            [id, businessId]
        );
        if (updated.rows.length === 0) return res.status(404).json({ success: false, error: "Subscriber not found" });
        res.json({ success: true, message: "Subscriber cancelled" });
    } catch (error) {
        console.error("Cancel subscriber error:", error);
        res.status(500).json({ success: false, error: "Failed to cancel subscriber" });
    }
});

/**
 * @openapi
 * /recurring/subscribers/{id}/reactivate:
 *   post:
 *     summary: Reactivate a past-due or cancelled subscriber (next charge runs today)
 *     tags: [Recurring Billing]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Reactivated
 */
router.post("/subscribers/:id/reactivate", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_subscriptions"), async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const { id } = req.params;
        const updated = await query(
            `UPDATE customer_subscribers
             SET status = 'active', consecutive_failures = 0, next_charge_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND business_id = $2 AND status IN ('past_due', 'cancelled') RETURNING *`,
            [id, businessId]
        );
        if (updated.rows.length === 0) {
            return res.status(400).json({ success: false, error: "Only past-due or cancelled subscribers can be reactivated" });
        }
        res.json({ success: true, subscriber: updated.rows[0] });
    } catch (error) {
        console.error("Reactivate subscriber error:", error);
        res.status(500).json({ success: false, error: "Failed to reactivate subscriber" });
    }
});

/**
 * @openapi
 * /recurring/charges:
 *   get:
 *     summary: List subscription charges (revenue history)
 *     tags: [Recurring Billing]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, awaiting_payment, success, failed, all] }
 *     responses:
 *       200:
 *         description: Charges newest first
 */
router.get("/charges", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const params: unknown[] = [businessId];
        let where = `c.business_id = $1`;
        const status = String(req.query.status || "").trim();
        if (status && status !== "all") {
            params.push(status);
            where += ` AND c.status = $${params.length}`;
        }
        const charges = await query(
            `SELECT c.*, s.customer_name, s.customer_email, p.name AS plan_name, p.interval
             FROM subscription_charges c
             JOIN customer_subscribers s ON s.id = c.subscriber_id
             JOIN customer_subscription_plans p ON p.id = c.plan_id
             WHERE ${where}
             ORDER BY c.created_at DESC LIMIT 200`,
            params
        );
        res.json({ success: true, charges: charges.rows });
    } catch (error) {
        console.error("List charges error:", error);
        res.status(500).json({ success: false, error: "Failed to load charges" });
    }
});

// ---------------------------------------------------------------------------
// Public endpoints (no auth — subscribers)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /recurring/public/plans/{publicId}:
 *   get:
 *     summary: Public subscription plan view (subscribe page)
 *     tags: [Recurring Billing]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: publicId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Plan + merchant payload
 *       404:
 *         description: Plan not found or paused
 */
router.get("/public/plans/:publicId", async (req, res) => {
    try {
        const { publicId } = req.params;
        const planRes = await query(
            `SELECT p.*, b.name AS business_name FROM customer_subscription_plans p
             LEFT JOIN businesses b ON b.id = p.business_id
             WHERE p.public_id = $1`,
            [publicId]
        );
        const plan = planRes.rows[0];
        if (!plan || plan.status !== "active") {
            return res.status(404).json({ success: false, error: "Subscription plan not found" });
        }
        const config = await getPlanConfig(plan.business_id);
        if (config && config.recurring_enabled === false) {
            return res.status(404).json({ success: false, error: "Subscription plan not found" });
        }
        res.json({
            success: true,
            plan: {
                id: plan.id,
                public_id: plan.public_id,
                name: plan.name,
                description: plan.description,
                amount: Number(plan.amount),
                currency: plan.currency || "NGN",
                interval: plan.interval,
            },
            business_name: plan.business_name || "Metricorex Business",
        });
    } catch (error) {
        console.error("Public subscription plan error:", error);
        res.status(500).json({ success: false, error: "Failed to load subscription plan" });
    }
});

/**
 * @openapi
 * /recurring/public/plans/{publicId}/subscribe:
 *   post:
 *     summary: Subscribe to a plan (wallet-charged when the email maps to a Metroflow user, else returns a checkout URL)
 *     tags: [Recurring Billing]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: publicId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customer_name, customer_email]
 *             properties:
 *               customer_name: { type: string }
 *               customer_email: { type: string }
 *               customer_phone: { type: string }
 *     responses:
 *       200:
 *         description: Subscribed (charge succeeded, or checkout_url for the first cycle)
 *       400:
 *         description: Already subscribed / checkout failed
 */
router.post("/public/plans/:publicId/subscribe", async (req, res) => {
    try {
        const { publicId } = req.params;
        const { customer_name, customer_email, customer_phone } = req.body || {};

        const planRes = await query(
            `SELECT p.*, b.name AS business_name FROM customer_subscription_plans p
             LEFT JOIN businesses b ON b.id = p.business_id
             WHERE p.public_id = $1`,
            [publicId]
        );
        const plan = planRes.rows[0];
        if (!plan || plan.status !== "active") {
            return res.status(404).json({ success: false, error: "Subscription plan not found" });
        }
        const config = await getPlanConfig(plan.business_id);
        if (config && config.recurring_enabled === false) {
            return res.status(404).json({ success: false, error: "Subscription plan not found" });
        }

        const customerEmail = String(customer_email || "").trim();
        if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
            return res.status(400).json({ success: false, error: "A valid email is required" });
        }
        const customerName = String(customer_name || "").trim();
        if (!customerName) return res.status(400).json({ success: false, error: "Your name is required" });

        const existing = await query(
            `SELECT * FROM customer_subscribers WHERE plan_id = $1 AND LOWER(customer_email) = LOWER($2)`,
            [plan.id, customerEmail]
        );
        if (existing.rows[0] && existing.rows[0].status !== "cancelled") {
            return res.status(400).json({ success: false, error: "This email is already subscribed to this plan" });
        }

        const result = await createSubscriberAndFirstCharge({
            businessId: plan.business_id,
            plan,
            customerName,
            customerEmail,
            customerPhone: customer_phone ? String(customer_phone).trim() : null,
            existingSubscriber: existing.rows[0] || null,
        });
        res.json(result);
    } catch (error) {
        console.error("Public subscribe error:", error);
        res.status(500).json({ success: false, error: "Failed to subscribe" });
    }
});

/**
 * @openapi
 * /recurring/public/charges/{reference}:
 *   get:
 *     summary: Public charge status (email pay-link landing)
 *     tags: [Recurring Billing]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Charge summary
 *       404:
 *         description: Charge not found
 */
router.get("/public/charges/:reference", async (req, res) => {
    try {
        const { reference } = req.params;
        const chargeRes = await query(
            `SELECT c.reference, c.amount, c.currency, c.status, c.period_start, c.period_end, c.created_at,
                    s.customer_name, s.customer_email, p.name AS plan_name, p.interval,
                    b.name AS business_name
             FROM subscription_charges c
             JOIN customer_subscribers s ON s.id = c.subscriber_id
             JOIN customer_subscription_plans p ON p.id = c.plan_id
             LEFT JOIN businesses b ON b.id = c.business_id
             WHERE c.reference = $1`,
            [reference]
        );
        const charge = chargeRes.rows[0];
        if (!charge) return res.status(404).json({ success: false, error: "Charge not found" });
        res.json({ success: true, charge: { ...charge, amount: Number(charge.amount) } });
    } catch (error) {
        console.error("Public charge status error:", error);
        res.status(500).json({ success: false, error: "Failed to load charge" });
    }
});

/**
 * @openapi
 * /recurring/public/charges/{reference}/pay:
 *   post:
 *     summary: Pay a due subscription charge (returns hosted checkout URL, settled by webhook)
 *     tags: [Recurring Billing]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: checkout_url + reference
 *       400:
 *         description: Charge not payable
 */
router.post("/public/charges/:reference/pay", async (req, res) => {
    try {
        const { reference } = req.params;
        const chargeRes = await query(
            `SELECT c.*, s.customer_name, s.customer_email, p.name AS plan_name
             FROM subscription_charges c
             JOIN customer_subscribers s ON s.id = c.subscriber_id
             JOIN customer_subscription_plans p ON p.id = c.plan_id
             WHERE c.reference = $1`,
            [reference]
        );
        const charge = chargeRes.rows[0];
        if (!charge) return res.status(404).json({ success: false, error: "Charge not found" });
        if (charge.status === "success") {
            return res.status(400).json({ success: false, error: "This charge has already been paid" });
        }
        if (charge.status === "failed" || charge.status === "awaiting_payment") {
            // Re-issue the charge with a fresh reference for a clean checkout
            const newReference = randomChargeReference();
            await query(
                `UPDATE subscription_charges SET reference = $2, status = 'awaiting_payment', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [charge.id, newReference]
            );
            const checkout = await initiateChargeCheckout({
                businessId: charge.business_id,
                reference: newReference,
                amount: Number(charge.amount),
                currency: charge.currency || "NGN",
                customerName: charge.customer_name,
                customerEmail: charge.customer_email,
                planName: charge.plan_name,
                requestedProvider: req.body?.provider || null,
                req,
            });
            if (!checkout.ok) {
                return res.status(checkout.status || 502).json({ success: false, error: checkout.error });
            }
            return res.json({ success: true, checkout_url: checkout.checkoutUrl, reference: newReference, amount: Number(charge.amount) });
        }
        return res.status(400).json({ success: false, error: "This charge is not awaiting payment" });
    } catch (error) {
        console.error("Public charge pay error:", error);
        res.status(500).json({ success: false, error: "Failed to start payment" });
    }
});

/**
 * @openapi
 * /recurring/public/unsubscribe/{token}:
 *   post:
 *     summary: Unsubscribe via the emailed token (no auth)
 *     tags: [Recurring Billing]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cancelled
 *       404:
 *         description: Subscription not found
 */
router.post("/public/unsubscribe/:token", async (req, res) => {
    try {
        const { token } = req.params;
        const updated = await query(
            `UPDATE customer_subscribers SET status = 'cancelled', next_charge_date = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE unsubscribe_token = $1 RETURNING id`,
            [token]
        );
        if (updated.rows.length === 0) return res.status(404).json({ success: false, error: "Subscription not found" });
        res.json({ success: true, message: "You have been unsubscribed." });
    } catch (error) {
        console.error("Public unsubscribe error:", error);
        res.status(500).json({ success: false, error: "Failed to unsubscribe" });
    }
});

// ---------------------------------------------------------------------------
// Charge engine
// ---------------------------------------------------------------------------

interface FirstChargeResult {
    success: boolean;
    message?: string;
    error?: string;
    checkout_url?: string;
    reference?: string;
    status?: number;
    code?: string;
    subscriber_id?: string;
}

/**
 * Shared subscribe path: creates (or reactivates) the subscriber and runs the
 * first charge — wallet path when the email maps to a Metroflow user with an
 * NGN wallet, hosted-checkout path otherwise.
 */
async function createSubscriberAndFirstCharge(opts: {
    businessId: string;
    plan: any;
    customerName: string;
    customerEmail: string;
    customerPhone: string | null;
    existingSubscriber: any | null;
}): Promise<FirstChargeResult> {
    const { businessId, plan, customerName, customerEmail, customerPhone, existingSubscriber } = opts;

    // Link to a platform user when the email matches (enables wallet auto-charge)
    const customerUserId = await findPlatformUserByEmail(customerEmail);
    let walletId: string | null = null;
    if (customerUserId) {
        const wallet = await resolveSubscriberWallet(customerUserId, null);
        walletId = wallet?.id || null;
    }

    let subscriberId: string;
    if (existingSubscriber) {
        const reactivated = await query(
            `UPDATE customer_subscribers
             SET status = 'active', customer_name = $2, customer_phone = $3, consecutive_failures = 0,
                 customer_user_id = $4, wallet_id = $5, next_charge_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING id`,
            [existingSubscriber.id, customerName, customerPhone, customerUserId, walletId]
        );
        subscriberId = reactivated.rows[0].id;
    } else {
        const created = await query(
            `INSERT INTO customer_subscribers
             (business_id, plan_id, customer_user_id, wallet_id, customer_name, customer_email, customer_phone, status, next_charge_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', CURRENT_DATE)
             RETURNING id`,
            [businessId, plan.id, customerUserId, walletId, customerName, customerEmail, customerPhone]
        );
        subscriberId = created.rows[0].id;
    }

    const subscriber = (await query(`SELECT * FROM customer_subscribers WHERE id = $1`, [subscriberId])).rows[0];
    const periodStart = new Date();

    if (customerUserId && walletId) {
        // Wallet path — charge right away
        const outcome = await runWalletCharge({
            subscriber,
            plan,
            periodStart,
        });
        if (outcome.ok) {
            return {
                success: true,
                message: `Subscription active — first charge of ₦${Number(plan.amount).toLocaleString()} succeeded from your Metroflow wallet.`,
                subscriber_id: subscriberId,
            };
        }
        // Wallet charge failed (e.g. insufficient balance) — fall through to checkout
    }

    // Checkout path — queue the first cycle and hand back a hosted checkout URL
    const reference = randomChargeReference();
    const periodEnd = new Date(nextDate(periodStart, plan.interval));
    periodEnd.setDate(periodEnd.getDate() - 1);
    await query(
        `INSERT INTO subscription_charges
         (business_id, subscriber_id, plan_id, reference, amount, currency, charge_path, status, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5, $6, 'checkout', 'awaiting_payment', $7, $8)`,
        [businessId, subscriberId, plan.id, reference, plan.amount, plan.currency || "NGN", dateOnly(periodStart), dateOnly(periodEnd)]
    );

    const settlementWallet = await getMerchantSettlementWallet(businessId);
    if (settlementWallet) {
        await query(
            `INSERT INTO transactions (business_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, payment_provider)
             VALUES ($1, $2, $3, $4, 'pending', 'credit', $5, 'subscription', $6, NULL)`,
            [businessId, plan.amount, plan.currency || "NGN", reference,
             `Subscription ${plan.name} — ${customerName} (first cycle)`, settlementWallet.id]
        );
    }

    const checkout = await initiateChargeCheckout({
        businessId,
        reference,
        amount: Number(plan.amount),
        currency: plan.currency || "NGN",
        customerName,
        customerEmail,
        planName: plan.name,
        requestedProvider: null,
        req: null,
    });
    if (!checkout.ok) {
        return { success: true, message: "Subscription created — we will email you a secure payment link for the first cycle.", subscriber_id: subscriberId };
    }
    return { success: true, checkout_url: checkout.checkoutUrl, reference, subscriber_id: subscriberId };
}

/**
 * Wallet-path charge: debits the subscriber's wallet, credits the merchant net
 * of the subscription fee (fee → revenue wallet), double-entry ledger,
 * notifications. Returns false when the wallet can't cover the charge.
 */
async function runWalletCharge(opts: { subscriber: any; plan: any; periodStart: Date }): Promise<{ ok: boolean }> {
    const { subscriber, plan, periodStart } = opts;
    const amount = Number(plan.amount);
    const currency = plan.currency || "NGN";
    const reference = randomChargeReference();
    const periodEnd = new Date(nextDate(periodStart, plan.interval));
    periodEnd.setDate(periodEnd.getDate() - 1);

    const chargeRes = await query(
        `INSERT INTO subscription_charges
         (business_id, subscriber_id, plan_id, reference, amount, currency, charge_path, status, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5, $6, 'wallet', 'pending', $7, $8) RETURNING id`,
        [subscriber.business_id, subscriber.id, plan.id, reference, amount, currency, dateOnly(periodStart), dateOnly(periodEnd)]
    );
    const chargeId = chargeRes.rows[0].id;

    const wallet = await resolveSubscriberWallet(subscriber.customer_user_id, subscriber.wallet_id);
    if (!wallet) {
        await query(
            `UPDATE subscription_charges SET status = 'failed', failure_reason = 'No chargeable wallet', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [chargeId]
        );
        return { ok: false };
    }

    const debit = await query(
        `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND balance >= $1 AND status = 'active'
         RETURNING balance`,
        [amount, wallet.id]
    );
    if (debit.rows.length === 0) {
        const failures = Number(subscriber.consecutive_failures || 0) + 1;
        const newStatus = failures >= 3 ? "past_due" : "active";
        await query(
            `UPDATE subscription_charges SET status = 'failed', failure_reason = 'Insufficient wallet balance', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [chargeId]
        );
        await query(
            `UPDATE customer_subscribers SET consecutive_failures = $2, status = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [subscriber.id, failures, newStatus]
        );
        try {
            await createNotification({
                businessId: subscriber.business_id,
                userId: subscriber.customer_user_id,
                type: "system",
                title: newStatus === "past_due" ? "Subscription Paused" : "Subscription Charge Failed",
                message:
                    newStatus === "past_due"
                        ? `Your "${plan.name}" subscription was paused after ${failures} failed charges. Contact the merchant to resume.`
                        : `Your "${plan.name}" subscription charge failed (insufficient balance). We'll retry on your next charge date.`,
                actionUrl: "/wallet",
                actionType: "view_wallet",
                metadata: { reference, planName: plan.name, amount },
                isActionable: false,
                expiresInHours: 72,
            });
        } catch (notifErr) {
            console.error("Subscription failure notification failed:", notifErr);
        }
        return { ok: false };
    }

    // Merchant fee + settlement
    const baseFee = await calculateFee(amount, "subscription");
    const planConfig = await getPlanConfig(subscriber.business_id);
    const fee = effectiveFee(baseFee, Number(planConfig?.subscription_fee_discount_percent) || 0);
    const net = Math.max(0, Math.round((amount - fee) * 100) / 100);

    const merchantWallet = await getMerchantSettlementWallet(subscriber.business_id);
    if (!merchantWallet) {
        // Refund the subscriber — merchant has nowhere to receive
        await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [amount, wallet.id]);
        await query(
            `UPDATE subscription_charges SET status = 'failed', failure_reason = 'Merchant settlement wallet missing', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [chargeId]
        );
        return { ok: false };
    }

    await query(
        `UPDATE subscription_charges
         SET status = 'success', fee = $2, net_amount = $3, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [chargeId, fee, net]
    );
    await query(
        `UPDATE customer_subscribers
         SET last_charged_at = CURRENT_TIMESTAMP, last_charge_reference = $2, consecutive_failures = 0, status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [subscriber.id, reference]
    );

    // Ledger rows (subscriber debit + merchant credit)
    await query(
        `INSERT INTO transactions
         (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction)
         VALUES ($1, $2, $3, $4, $5, 'success', 'debit', $6, 'subscription', $7, 'debit')`,
        [wallet.business_id || null, subscriber.customer_user_id, amount, currency, reference,
         `Subscription — ${plan.name} (${plan.interval})`, wallet.id]
    );
    await query(
        `INSERT INTO transactions
         (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee)
         VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'subscription', $6, 'credit', $7)
         ON CONFLICT (reference) DO NOTHING`,
        [subscriber.business_id, net, currency, `${reference}-SETTLED`,
         `Subscription payment received — ${plan.name} (${subscriber.customer_name})`, merchantWallet.id, fee]
    );

    // Double-entry platform ledger: gross in, net out, fee to revenue
    await creditPlatformWallet(amount, currency, reference, "Subscription Charge Collected", "wallet");
    await debitPlatformWallet(net, currency, `${reference}-MERCHANT`, "Platform Wallet Debit for Subscription Settlement", "wallet");
    if (fee > 0) {
        await creditRevenueWallet(fee, currency, reference, "Subscription Charge Fee", "wallet");
    }

    // Notify both sides
    try {
        await createNotification({
            businessId: subscriber.business_id,
            userId: null,
            type: "credit",
            title: "Subscription Payment Received",
            message: `${subscriber.customer_name} paid ${plan.name}: +${net.toLocaleString()} ${currency}${fee > 0 ? ` (fee: ${fee} ${currency})` : ""}`,
            actionUrl: "/subscriptions",
            actionType: "view_subscription",
            metadata: { reference, planName: plan.name, amount, fee, net },
            isActionable: false,
            expiresInHours: 72,
        });
        await createNotification({
            businessId: wallet.business_id || subscriber.business_id,
            userId: subscriber.customer_user_id,
            type: "debit",
            title: "Subscription Charged",
            message: `${plan.name} subscription renewed: -${amount.toLocaleString()} ${currency}`,
            actionUrl: "/wallet",
            actionType: "view_wallet",
            metadata: { reference, planName: plan.name, amount },
            isActionable: false,
            expiresInHours: 72,
        });
    } catch (notifErr) {
        console.error("Subscription notifications failed:", notifErr);
    }
    return { ok: true };
}

/** Hosted-checkout initiation for a queued charge (used by public pay + subscribe flows). */
async function initiateChargeCheckout(opts: {
    businessId: string;
    reference: string;
    amount: number;
    currency: string;
    customerName: string;
    customerEmail: string;
    planName: string;
    requestedProvider: string | null;
    req: any;
}): Promise<{ ok: boolean; checkoutUrl?: string; error?: string; status?: number }> {
    const { businessId, reference, amount, currency, customerEmail, planName, requestedProvider, req } = opts;

    const providerName = requestedProvider || (await getActiveProviderName());
    const provider = getProvider(providerName);
    const origin = req?.get?.("origin") || process.env.APP_BASE_URL || "https://app.metricorex.com";
    const baseUrl = String(origin).endsWith("/") ? String(origin).slice(0, -1) : String(origin);
    const callbackUrl = `${baseUrl}/subscribe/charge/${reference}`;

    try {
        const paymentResponse: any = await provider.initiatePayment({
            email: customerEmail,
            amount: Math.round(amount * 100),
            reference,
            callbackUrl,
            currency,
        });
        const checkoutUrl = paymentResponse?.data?.checkout_url || paymentResponse?.data?.link || paymentResponse?.checkout_url;
        if (!checkoutUrl) return { ok: false, error: "Payment provider did not return a checkout URL" };
        return { ok: true, checkoutUrl };
    } catch (providerError: any) {
        console.error("Subscription checkout initiation failed:", providerError?.message);
        await query(`UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE reference = $1`, [reference]);
        return { ok: false, error: "Could not start the payment. Please try again." };
    }
}

/**
 * Cron entry (runs every 5 minutes from server/index.ts): charges every due
 * active subscription. Idempotent — the next_charge_date claim advances before
 * any money moves, so overlapping ticks never double-charge.
 */
export async function processDueSubscriptionCharges(): Promise<{ processed: number; succeeded: number; failed: number }> {
    const due = await query(
        `SELECT s.*, p.name AS plan_name, p.amount, p.currency, p.interval, p.status AS plan_status
         FROM customer_subscribers s
         JOIN customer_subscription_plans p ON p.id = s.plan_id
         WHERE s.status = 'active' AND p.status = 'active'
           AND s.next_charge_date IS NOT NULL AND s.next_charge_date <= CURRENT_DATE
         LIMIT 200`
    );
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    for (const sub of due.rows) {
        const periodStart = new Date(sub.next_charge_date);
        const claimed = await query(
            `UPDATE customer_subscribers SET next_charge_date = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND next_charge_date = $3 RETURNING id`,
            [sub.id, dateOnly(nextDate(periodStart, sub.interval)), dateOnly(periodStart)]
        );
        if (claimed.rows.length === 0) continue; // another tick claimed it
        processed++;

        const plan = { ...sub, name: sub.plan_name, amount: sub.amount, currency: sub.currency, interval: sub.interval };
        if (sub.customer_user_id && (await resolveSubscriberWallet(sub.customer_user_id, sub.wallet_id))) {
            const outcome = await runWalletCharge({ subscriber: sub, plan, periodStart });
            outcome.ok ? succeeded++ : failed++;
        } else {
            // Checkout path — queue a hosted-checkout charge + email the pay link
            const reference = randomChargeReference();
            const periodEnd = new Date(nextDate(periodStart, sub.interval));
            periodEnd.setDate(periodEnd.getDate() - 1);
            await query(
                `INSERT INTO subscription_charges
                 (business_id, subscriber_id, plan_id, reference, amount, currency, charge_path, status, period_start, period_end)
                 VALUES ($1, $2, $3, $4, $5, $6, 'checkout', 'awaiting_payment', $7, $8)`,
                [sub.business_id, sub.id, sub.plan_id, reference, sub.amount, sub.currency || "NGN", dateOnly(periodStart), dateOnly(periodEnd)]
            );
            const settlementWallet = await getMerchantSettlementWallet(sub.business_id);
            if (settlementWallet) {
                await query(
                    `INSERT INTO transactions (business_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, payment_provider)
                     VALUES ($1, $2, $3, $4, 'pending', 'credit', $5, 'subscription', $6, NULL)`,
                    [sub.business_id, sub.amount, sub.currency || "NGN", reference,
                     `Subscription ${sub.plan_name} — ${sub.customer_name} (cycle ${dateOnly(periodStart)})`, settlementWallet.id]
                );
            }
            try {
                const base = await baseUrlFromEnv();
                const payUrl = `${base}/subscribe/charge/${reference}`;
                const unsubscribeUrl = `${base}/api/recurring/public/unsubscribe/${sub.unsubscribe_token}`;
                await sendEmail(
                    sub.customer_email,
                    sub.customer_name || "there",
                    `Your ${sub.plan_name} subscription payment is due`,
                    `<p>Hi ${sub.customer_name || "there"},</p>
                     <p>Your <strong>${sub.plan_name}</strong> subscription (${sub.interval}) payment of
                     <strong>₦${Number(sub.amount).toLocaleString()}</strong> is due.</p>
                     <p><a href="${payUrl}" style="display:inline-block;background:#4F46E5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">Pay now</a></p>
                     <p>If the button doesn't work, open: ${payUrl}</p>
                     <p style="font-size:12px;color:#888;">Don't want this subscription? <a href="${unsubscribeUrl}">Unsubscribe</a></p>`
                );
            } catch (emailErr) {
                console.error("Subscription pay-link email failed:", emailErr);
            }
            succeeded++; // queued successfully
        }
    }
    return { processed, succeeded, failed };
}

// ---------------------------------------------------------------------------
// Webhook settlement — called by server/routes/webhook.ts when a charge with
// transaction_type 'subscription' succeeds. Idempotent: the charge flips
// awaiting_payment → success exactly once.
// ---------------------------------------------------------------------------

export async function settleSubscriptionCharge(reference: string, providerName: string): Promise<void> {
    const chargeRes = await query(
        `SELECT * FROM subscription_charges WHERE reference = $1 AND status IN ('awaiting_payment', 'pending')`,
        [reference]
    );
    const charge = chargeRes.rows[0];
    if (!charge) return; // already settled or unknown — nothing to do

    const gross = Number(charge.amount);
    const currency = charge.currency || "NGN";

    const baseFee = await calculateFee(gross, "subscription");
    const planConfig = await getPlanConfig(charge.business_id);
    const fee = effectiveFee(baseFee, Number(planConfig?.subscription_fee_discount_percent) || 0);
    const net = Math.max(0, gross - fee);

    const merchantWallet = await getMerchantSettlementWallet(charge.business_id);
    if (!merchantWallet) {
        console.error(`settleSubscriptionCharge: no settlement wallet for business ${charge.business_id} (ref ${reference})`);
        return;
    }

    // Flip the charge FIRST (idempotency gate), then move the money.
    await query(
        `UPDATE subscription_charges
         SET status = 'success', fee = $2, net_amount = $3, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [charge.id, fee, net]
    );
    await query(
        `UPDATE customer_subscribers
         SET last_charged_at = CURRENT_TIMESTAMP, last_charge_reference = $2, consecutive_failures = 0, status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [charge.subscriber_id, reference]
    );

    await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [net, merchantWallet.id]);
    await query(
        `UPDATE transactions SET status = 'success', fee = $2, updated_at = CURRENT_TIMESTAMP WHERE reference = $1`,
        [reference, fee]
    );
    await query(
        `INSERT INTO transactions
         (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider)
         VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'subscription', $6, 'credit', $7, $8)
         ON CONFLICT (reference) DO NOTHING`,
        [charge.business_id, net, currency, `${reference}-SETTLED`,
         `Subscription payment received (net of ${fee} ${currency} fee)`, merchantWallet.id, fee, providerName]
    );

    // Double-entry platform ledger: gross in, net out, fee to revenue
    await creditPlatformWallet(gross, currency, reference, "Subscription Charge Received", providerName);
    await debitPlatformWallet(net, currency, `${reference}-MERCHANT`, "Platform Wallet Debit for Subscription Settlement", providerName);
    if (fee > 0) {
        await creditRevenueWallet(fee, currency, reference, "Subscription Charge Fee", providerName);
    }

    const infoRes = await query(
        `SELECT s.customer_name, p.name AS plan_name FROM customer_subscribers s
         JOIN customer_subscription_plans p ON p.id = s.plan_id WHERE s.id = $1`,
        [charge.subscriber_id]
    );
    try {
        await createNotification({
            businessId: charge.business_id,
            userId: null,
            type: "credit",
            title: "Subscription Payment Received",
            message: `${infoRes.rows[0]?.customer_name || "A subscriber"} paid ${infoRes.rows[0]?.plan_name || "a plan"}: +${net.toLocaleString()} ${currency}${fee > 0 ? ` (fee: ${fee} ${currency})` : ""}`,
            actionUrl: "/subscriptions",
            actionType: "view_subscription",
            metadata: { reference, amount: gross, fee, net },
            isActionable: false,
            expiresInHours: 72,
        });
    } catch (notifErr) {
        console.error("Subscription notification failed:", notifErr);
    }
}

export default router;
