import express from "express";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";
import { calculateFee, creditPlatformWallet, debitPlatformWallet, creditRevenueWallet } from "../../services/fees";
import { createNotification } from "../../services/notifications";
import { verifyPassword } from "../../services/auth";
import { fulfilBill, isBillsProviderConfigured } from "./bills-provider";

const router = express.Router();

/**
 * Bills Hub — the fourth REVENUE feature (daily-use).
 *
 * Users pay airtime, data, TV, electricity and betting top-ups straight from
 * any of their wallets (personal or business). Every bill is charged
 * amount + convenience fee (fee_configurations 'bill' — ₦50 flat by default,
 * reduced by the plan-level bill_fee_discount_percent); the fee lands in the
 * platform revenue wallet via creditRevenueWallet and every payment is
 * double-entered through the platform ledger. Fulfilment is delegated to the
 * pluggable bills provider (services/bills-provider.ts); when none is
 * configured the built-in simulator settles instantly.
 *
 * Plan configuration (pricing_plans, admin-editable via /admin/pricing):
 *   - bills_enabled               (feature toggle)
 *   - max_bills_per_day           (NULL/999999+ = unlimited)
 *   - bill_fee_discount_percent
 */

// ---------------------------------------------------------------------------
// Service catalog (Nigeria-first, provider-agnostic codes)
// ---------------------------------------------------------------------------

interface BillPlan {
    code: string;
    name: string;
    amount: number;
    validity?: string;
}
interface BillProvider {
    code: string;
    name: string;
    category: string;
    /** customer reference label shown in UIs */
    refLabel: string;
    /** ref validation regex source string */
    refPattern?: string;
    refExample?: string;
    /** fixed-price plans (data bundles / TV packages) */
    plans?: BillPlan[];
    /** electricity disco token flow */
    requiresAmount?: boolean;
}

const PROVIDERS: BillProvider[] = [
    // ---- Airtime ----
    { code: "mtn", name: "MTN Airtime", category: "airtime", refLabel: "Phone number", refPattern: "^0[789][01]\\d{8}$", refExample: "08031234567" },
    { code: "airtel", name: "Airtel Airtime", category: "airtime", refLabel: "Phone number", refPattern: "^0[789][01]\\d{8}$", refExample: "08021234567" },
    { code: "glo", name: "Glo Airtime", category: "airtime", refLabel: "Phone number", refPattern: "^0[789][01]\\d{8}$", refExample: "08051234567" },
    { code: "9mobile", name: "9mobile Airtime", category: "airtime", refLabel: "Phone number", refPattern: "^0[789][01]\\d{8}$", refExample: "08091234567" },
    // ---- Data ----
    {
        code: "mtn-data", name: "MTN Data", category: "data", refLabel: "Phone number", refPattern: "^0[789][01]\\d{8}$",
        plans: [
            { code: "mtn-1gb", name: "1 GB", amount: 350, validity: "30 days" },
            { code: "mtn-2gb", name: "2 GB", amount: 650, validity: "30 days" },
            { code: "mtn-5gb", name: "5 GB", amount: 1500, validity: "30 days" },
            { code: "mtn-10gb", name: "10 GB", amount: 3000, validity: "30 days" },
        ],
    },
    {
        code: "airtel-data", name: "Airtel Data", category: "data", refLabel: "Phone number", refPattern: "^0[789][01]\\d{8}$",
        plans: [
            { code: "airtel-1gb", name: "1 GB", amount: 400, validity: "30 days" },
            { code: "airtel-3gb", name: "3 GB", amount: 1000, validity: "30 days" },
            { code: "airtel-10gb", name: "10 GB", amount: 3000, validity: "30 days" },
        ],
    },
    {
        code: "glo-data", name: "Glo Data", category: "data", refLabel: "Phone number", refPattern: "^0[789][01]\\d{8}$",
        plans: [
            { code: "glo-1gb", name: "1 GB", amount: 350, validity: "30 days" },
            { code: "glo-5gb", name: "5 GB", amount: 1600, validity: "30 days" },
        ],
    },
    {
        code: "9mobile-data", name: "9mobile Data", category: "data", refLabel: "Phone number", refPattern: "^0[789][01]\\d{8}$",
        plans: [
            { code: "9mobile-1gb", name: "1 GB", amount: 500, validity: "30 days" },
            { code: "9mobile-3gb", name: "3 GB", amount: 1200, validity: "30 days" },
        ],
    },
    // ---- TV ----
    {
        code: "dstv", name: "DStv", category: "tv", refLabel: "Smartcard number", refPattern: "^\\d{10,12}$",
        plans: [
            { code: "dstv-padi", name: "Padi", amount: 4400 },
            { code: "dstv-yanga", name: "Yanga", amount: 6000 },
            { code: "dstv-confam", name: "Confam", amount: 11000 },
            { code: "dstv-compact", name: "Compact", amount: 19000 },
            { code: "dstv-premium", name: "Premium", amount: 44500 },
        ],
    },
    {
        code: "gotv", name: "GOtv", category: "tv", refLabel: "IUC number", refPattern: "^\\d{10,12}$",
        plans: [
            { code: "gotv-smallie", name: "Smallie", amount: 1900 },
            { code: "gotv-jinja", name: "Jinja", amount: 3900 },
            { code: "gotv-jolli", name: "Jolli", amount: 5800 },
            { code: "gotv-max", name: "Max", amount: 8500 },
        ],
    },
    {
        code: "startimes", name: "StarTimes", category: "tv", refLabel: "Smartcard number", refPattern: "^\\d{10,12}$",
        plans: [
            { code: "startimes-nova", name: "Nova", amount: 1900 },
            { code: "startimes-basic", name: "Basic", amount: 3200 },
            { code: "startimes-smart", name: "Smart", amount: 4800 },
            { code: "startimes-classic", name: "Classic", amount: 6000 },
        ],
    },
    // ---- Electricity ----
    { code: "ikedc", name: "Ikeja Electric (IKEDC)", category: "electricity", refLabel: "Meter number", refPattern: "^\\d{6,15}$" },
    { code: "ekedc", name: "Eko Electric (EKEDC)", category: "electricity", refLabel: "Meter number", refPattern: "^\\d{6,15}$" },
    { code: "aedc", name: "Abuja Electric (AEDC)", category: "electricity", refLabel: "Meter number", refPattern: "^\\d{6,15}$" },
    { code: "phed", name: "Port Harcourt Electric (PHED)", category: "electricity", refLabel: "Meter number", refPattern: "^\\d{6,15}$" },
    { code: "kedco", name: "Kano Electric (KEDCO)", category: "electricity", refLabel: "Meter number", refPattern: "^\\d{6,15}$" },
    { code: "jed", name: "Jos Electric (JED)", category: "electricity", refLabel: "Meter number", refPattern: "^\\d{6,15}$" },
    { code: "kaedco", name: "Kaduna Electric (KAEDCO)", category: "electricity", refLabel: "Meter number", refPattern: "^\\d{6,15}$" },
    { code: "eedc", name: "Enugu Electric (EEDC)", category: "electricity", refLabel: "Meter number", refPattern: "^\\d{6,15}$" },
    // ---- Betting ----
    { code: "bet9ja", name: "Bet9ja", category: "betting", refLabel: "User ID", refPattern: "^[A-Za-z0-9\\-]{3,40}$" },
    { code: "sportybet", name: "SportyBet", category: "betting", refLabel: "Phone number", refPattern: "^0[789][01]\\d{8}$" },
    { code: "betking", name: "BetKing", category: "betting", refLabel: "User ID", refPattern: "^[A-Za-z0-9\\-]{3,40}$" },
    { code: "1xbet", name: "1xBet", category: "betting", refLabel: "Account ID", refPattern: "^[A-Za-z0-9\\-]{3,40}$" },
];

const BILL_MIN_AMOUNT = 50;
const BILL_MAX_AMOUNT = 500_000;

function findProvider(code: string): BillProvider | undefined {
    return PROVIDERS.find((p) => p.code === String(code).toLowerCase());
}

function getPlanConfig(businessId: string) {
    return query(
        `SELECT p.bills_enabled, p.max_bills_per_day, p.bill_fee_discount_percent
         FROM businesses b JOIN pricing_plans p ON p.id = b.plan_id
         WHERE b.id = $1`,
        [businessId]
    ).then((r) => r.rows[0] || null);
}

function effectiveFee(baseFee: number, discountPercent: number): number {
    if (!(baseFee > 0)) return 0;
    const reduced = baseFee * (1 - Math.min(Math.max(discountPercent, 0), 100) / 100);
    return Math.max(0, Math.round(reduced * 100) / 100);
}

function randomReference(): string {
    return `BILL-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

// ---------------------------------------------------------------------------
// Catalog endpoints
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /bills/catalog:
 *   get:
 *     summary: Bills service catalog (airtime, data, TV, electricity, betting providers + plans)
 *     tags: [Bills]
 *     security: []
 *     responses:
 *       200:
 *         description: Catalog with all providers, plans and configured provider mode
 */
router.get("/catalog", async (_req, res) => {
    res.json({
        success: true,
        liveProvider: isBillsProviderConfigured(),
        categories: ["airtime", "data", "tv", "electricity", "betting"],
        providers: PROVIDERS,
    });
});

// ---------------------------------------------------------------------------
// Authenticated endpoints
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /bills:
 *   get:
 *     summary: List the caller's bill payments (history)
 *     tags: [Bills]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, success, failed, all] }
 *       - in: query
 *         name: category
 *         schema: { type: string, enum: [airtime, data, tv, electricity, betting] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *     responses:
 *       200:
 *         description: Bill payment history (newest first)
 */
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { userId, businessId } = req.user!;
        const params: unknown[] = [];
        let where = `(b.user_id = $1 OR b.business_id = $2)`;
        params.push(userId, businessId || null);

        const status = String(req.query.status || "").trim();
        if (status && status !== "all") {
            params.push(status);
            where += ` AND b.status = $${params.length}`;
        }
        const category = String(req.query.category || "").trim();
        if (category && category !== "all") {
            params.push(category);
            where += ` AND b.category = $${params.length}`;
        }
        const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);

        const history = await query(
            `SELECT b.*, w.currency AS wallet_currency
             FROM bill_payments b LEFT JOIN wallets w ON w.id = b.wallet_id
             WHERE ${where}
             ORDER BY b.created_at DESC
             LIMIT ${limit}`,
            params
        );
        const stats = await query(
            `SELECT COUNT(*)::int AS total_count,
                    COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) AS total_spent,
                    COALESCE(SUM(CASE WHEN status = 'success' THEN fee ELSE 0 END), 0) AS total_fees
             FROM bill_payments b
             WHERE (b.user_id = $1 OR b.business_id = $2)`,
            [userId, businessId || null]
        );
        res.json({ success: true, bills: history.rows, stats: stats.rows[0] });
    } catch (error) {
        console.error("List bills error:", error);
        res.status(500).json({ success: false, error: "Failed to load bill payments" });
    }
});

/**
 * @openapi
 * /bills/pay:
 *   post:
 *     summary: Pay a bill (airtime, data, TV, electricity or betting) from a wallet
 *     tags: [Bills]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [category, provider_code, customer_ref, wallet_id, amount, pin]
 *             properties:
 *               category:
 *                 type: string
 *                 enum: [airtime, data, tv, electricity, betting]
 *               provider_code:
 *                 type: string
 *                 example: mtn | dstv | ikedc | bet9ja
 *               plan_code:
 *                 type: string
 *                 description: Required for data and TV (fixed-price plans)
 *               customer_ref:
 *                 type: string
 *                 description: Phone number, smartcard/IUC, meter number or betting user ID
 *               customer_phone:
 *                 type: string
 *                 description: Optional contact phone for receipts
 *               wallet_id:
 *                 type: string
 *                 format: uuid
 *               amount:
 *                 type: number
 *                 description: Required when the provider has no fixed plan (airtime, electricity, betting)
 *               pin:
 *                 type: string
 *                 description: Transaction PIN (same PIN verified for transfers)
 *     responses:
 *       200:
 *         description: Bill paid and fulfilled
 *       400:
 *         description: Validation failed / invalid PIN / plan cap reached
 *       403:
 *         description: Bills disabled on the current plan (PLAN_UPGRADE_REQUIRED)
 */
router.post("/pay", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { userId, businessId } = req.user!;
        const {
            category, provider_code, plan_code, customer_ref, customer_phone,
            wallet_id, amount, pin,
        } = req.body || {};

        // ---- Validate catalog + payload ----
        const provider = findProvider(String(provider_code || ""));
        if (!provider || provider.category !== category) {
            return res.status(400).json({ success: false, error: "Unknown service. Pick a valid bill provider." });
        }
        const customerRef = String(customer_ref || "").trim();
        if (!customerRef) {
            return res.status(400).json({ success: false, error: `${provider.refLabel} is required` });
        }
        if (provider.refPattern && !new RegExp(provider.refPattern).test(customerRef)) {
            return res.status(400).json({ success: false, error: `Invalid ${provider.refLabel.toLowerCase()}` });
        }

        // ---- Amount resolution (fixed plan vs free amount) ----
        let billAmount = 0;
        let planName: string | null = null;
        if (provider.plans?.length) {
            const plan = provider.plans.find((p) => p.code === String(plan_code || ""));
            if (!plan) {
                return res.status(400).json({
                    success: false,
                    error: `Choose a ${provider.name} package`,
                    plans: provider.plans,
                });
            }
            billAmount = plan.amount;
            planName = plan.name;
        } else {
            billAmount = Math.round(Number(amount) * 100) / 100;
        }
        if (!billAmount || billAmount < BILL_MIN_AMOUNT || billAmount > BILL_MAX_AMOUNT) {
            return res.status(400).json({
                success: false,
                error: `Amount must be between ₦${BILL_MIN_AMOUNT.toLocaleString()} and ₦${BILL_MAX_AMOUNT.toLocaleString()}`,
            });
        }

        // ---- Transaction PIN (same gate as transfers) ----
        if (!pin) {
            return res.status(400).json({ success: false, error: "Transaction PIN is required" });
        }
        const pinRes = await query(`SELECT transaction_pin_hash FROM businesses WHERE id = $1`, [businessId]);
        const business = pinRes.rows[0];
        if (!business?.transaction_pin_hash) {
            return res.status(400).json({
                success: false,
                error: "Transaction PIN not set. Please create one first.",
                code: "PIN_NOT_SET",
            });
        }
        const pinValid = await verifyPassword(String(pin), business.transaction_pin_hash);
        if (!pinValid) {
            return res.status(400).json({ success: false, error: "Invalid transaction PIN" });
        }

        // ---- Plan gating ----
        const plan = await getPlanConfig(businessId);
        if (plan && plan.bills_enabled === false) {
            return res.status(403).json({
                success: false,
                error: "Bill payments are not available on your current plan. Kindly upgrade your plan.",
                code: "PLAN_UPGRADE_REQUIRED",
            });
        }
        if (plan?.max_bills_per_day != null && plan.max_bills_per_day < 999999) {
            const countRes = await query(
                `SELECT COUNT(*)::int AS c FROM bill_payments
                 WHERE (business_id = $1 OR user_id = $2) AND created_at >= date_trunc('day', CURRENT_DATE)`,
                [businessId, userId]
            );
            if (countRes.rows[0].c >= plan.max_bills_per_day) {
                return res.status(403).json({
                    success: false,
                    error: `Your plan allows up to ${plan.max_bills_per_day} bill payment(s) per day. Kindly upgrade your plan for a higher limit.`,
                    code: "PLAN_UPGRADE_REQUIRED",
                });
            }
        }

        // ---- Wallet (must belong to the caller) ----
        const walletRes = await query(
            `SELECT * FROM wallets WHERE id = $1 AND (business_id = $2 OR user_id = $3)`,
            [wallet_id, businessId || null, userId]
        );
        const wallet = walletRes.rows[0];
        if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
        if (wallet.status !== "active") return res.status(400).json({ success: false, error: "Wallet is not active" });

        // ---- Fee + total ----
        const baseFee = await calculateFee(billAmount, "bill");
        const fee = effectiveFee(baseFee, Number(plan?.bill_fee_discount_percent) || 0);
        const total = Math.round((billAmount + fee) * 100) / 100;

        const debit = await query(
            `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND balance >= $1 AND status = 'active'
             RETURNING balance`,
            [total, wallet.id]
        );
        if (debit.rows.length === 0) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. This bill needs ₦${total.toLocaleString()} (₦${billAmount.toLocaleString()} + ₦${fee.toLocaleString()} fee).`,
                code: "INSUFFICIENT_BALANCE",
            });
        }

        // ---- Ledger rows ----
        const reference = randomReference();
        const owningBusinessId: string | null = (wallet.business_id as string) || null; // wallet decides personal vs business
        const insertRes = await query(
            `INSERT INTO bill_payments
             (business_id, user_id, wallet_id, reference, category, provider_code, provider_name,
              plan_code, plan_name, customer_ref, customer_phone, amount, fee, total, currency, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')
             RETURNING *`,
            [
                owningBusinessId, userId, wallet.id, reference, provider.category, provider.code, provider.name,
                plan_code || null, planName, customerRef, customer_phone ? String(customer_phone).trim() : null,
                billAmount, fee, total, wallet.currency || "NGN",
            ]
        );
        const bill = insertRes.rows[0];

        await query(
            `INSERT INTO transactions
             (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction, fee)
             VALUES ($1, $2, $3, $4, $5, 'success', 'debit', $6, 'bill', $7, 'debit', $8)`,
            [
                owningBusinessId, userId, total, wallet.currency || "NGN", reference,
                `${provider.name}${planName ? ` (${planName})` : ""} — ${customerRef}`,
                wallet.id, fee,
            ]
        );

        // Double-entry platform ledger: value in, payout out, fee to revenue.
        await creditPlatformWallet(total, wallet.currency || "NGN", reference, "Bill Payment Received", "bills");
        await debitPlatformWallet(billAmount, wallet.currency || "NGN", `${reference}-VENDOR`, "Platform Wallet Debit for Bill Settlement", "bills");
        if (fee > 0) {
            await creditRevenueWallet(fee, wallet.currency || "NGN", reference, "Bill Payment Convenience Fee", "bills");
        }

        // ---- Fulfil via the bills provider (simulator when unconfigured) ----
        const fulfilment = await fulfilBill({
            reference,
            category: provider.category,
            providerCode: provider.code,
            planCode: plan_code || null,
            amount: billAmount,
            customerRef,
            customerPhone: customer_phone || null,
        });

        const finalStatus = fulfilment.ok ? "success" : "failed";
        await query(
            `UPDATE bill_payments
             SET status = $2, fulfilment_mode = $3, provider_reference = $4,
                 provider_response = $5::jsonb, failure_reason = $6, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [
                bill.id, finalStatus, fulfilment.mode, fulfilment.providerReference || null,
                JSON.stringify(fulfilment), fulfilment.ok ? null : fulfilment.message || "Fulfilment failed",
            ]
        );

        // Refund on fulfilment failure (wallet is credited back instantly).
        if (!fulfilment.ok) {
            await query(
                `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [total, wallet.id]
            );
            await query(
                `INSERT INTO transactions
                 (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction)
                 VALUES ($1, $2, $3, $4, $5, 'success', 'credit', $6, 'bill_refund', $7, 'credit')`,
                [
                    owningBusinessId, userId, total, wallet.currency || "NGN", `${reference}-REFUND`,
                    `Bill payment refund — ${provider.name} (${customerRef})`, wallet.id,
                ]
            );
        }

        // ---- Notification ----
        try {
            await createNotification({
                businessId: owningBusinessId || businessId,
                userId,
                type: finalStatus === "success" ? "debit" : "system",
                title: finalStatus === "success" ? "Bill Payment Successful" : "Bill Payment Failed",
                message:
                    finalStatus === "success"
                        ? `${provider.name}${planName ? ` (${planName})` : ""} for ${customerRef}: -${total.toLocaleString()} ${wallet.currency || "NGN"} (fee: ${fee})`
                        : `${provider.name} payment failed and was refunded: ${fulfilment.message || "contact support"}`,
                actionUrl: "/bills",
                actionType: "view_bill",
                metadata: { reference, category: provider.category, amount: billAmount, fee, total },
                isActionable: false,
                expiresInHours: 72,
            });
        } catch (notifErr) {
            console.error("Bill notification failed:", notifErr);
        }

        const updated = await query(`SELECT * FROM bill_payments WHERE id = $1`, [bill.id]);
        res.json({
            success: finalStatus === "success",
            bill: updated.rows[0],
            message: finalStatus === "success"
                ? `${provider.name} payment successful`
                : `Payment failed and refunded: ${fulfilment.message || "please try again"}`,
        });
    } catch (error) {
        console.error("Pay bill error:", error);
        res.status(500).json({ success: false, error: "Failed to process bill payment" });
    }
});

/**
 * @openapi
 * /bills/{id}:
 *   get:
 *     summary: Bill payment detail
 *     tags: [Bills]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Bill payment record
 *       404:
 *         description: Not found
 */
router.get("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const { userId, businessId } = req.user!;
        const billRes = await query(
            `SELECT * FROM bill_payments WHERE id = $1 AND (user_id = $2 OR business_id = $3)`,
            [id, userId, businessId || null]
        );
        if (billRes.rows.length === 0) return res.status(404).json({ success: false, error: "Bill payment not found" });
        res.json({ success: true, bill: billRes.rows[0] });
    } catch (error) {
        console.error("Bill detail error:", error);
        res.status(500).json({ success: false, error: "Failed to load bill payment" });
    }
});

export default router;
