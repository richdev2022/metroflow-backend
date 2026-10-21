import express from "express";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";
import { verifyTransactionPin } from "./personal-utils";
import { calculateFee, debitPlatformWallet, creditRevenueWallet } from "../../services/fees";
import { createNotification } from "../../services/notifications";
import { getBillCategories, payBill as flwPayBill, isFlutterwaveConfigured } from "../../services/flutterwave";

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

/**
 * DYNAMIC catalog — fetched live from Flutterwave bill categories (cached).
 * Nothing is hardcoded: airtime/data/TV/electricity/betting providers and
 * their plans all come from the provider API on every cold load.
 */
const flwCache: { at: number; providers: BillProvider[] } = { at: 0, providers: [] };
const FLW_CATALOG_TTL = 10 * 60 * 1000;

function classifyBillItem(name: string): string {
    const n = name.toLowerCase();
    if (/(bet9ja|sporty|bet\b|betting|nairabet|betway|1xbet|msport)/.test(n)) return "betting";
    if (/(dstv|gotv|startimes|topstar|tv|cable|dish)/.test(n)) return "tv";
    if (/(electric|disco|ikedc|ekedc|aedc|jedc|kedco|phed|ibedc|kaedco|tcn|power|prepaid|postpaid|meter)/.test(n)) return "electricity";
    if (/(airtime|\bat\d+)/.test(n)) return "airtime";
    if (/(\d+\s*(gb|mb)|data|sme|corporate gsm|gifting)/.test(n)) return "data";
    return "other";
}

function refLabelFor(category: string): string {
    switch (category) {
        case "airtime": case "data": return "Phone number";
        case "tv": return "Smartcard / IUC number";
        case "electricity": return "Meter number";
        case "betting": return "Customer ID";
        default: return "Customer reference";
    }
}

function refPatternFor(category: string): string | undefined {
    if (category === "airtime" || category === "data") return "^0[789][01]\\d{8}$";
    return undefined;
}

async function loadProviders(): Promise<BillProvider[]> {
    const now = Date.now();
    if (flwCache.providers.length && now - flwCache.at < FLW_CATALOG_TTL) return flwCache.providers;
    const items = await getBillCategories("NG");
    const byCode = new Map<string, BillProvider & { _fixed: boolean }>();
    for (const it of items) {
        const category = classifyBillItem(`${it.biller_name} ${it.short_name}`);
        if (category === "other") continue;
        const code = String(it.biller_code || "").toUpperCase();
        if (!code) continue;
        let p = byCode.get(code);
        if (!p) {
            p = {
                code, name: (it.biller_name || code).trim(), category,
                refLabel: refLabelFor(category), refPattern: refPatternFor(category),
                plans: [], _fixed: false,
            };
            byCode.set(code, p);
        }
        const fixed = it.is_amount_fixed === true || (it.amount ?? 0) > 0;
        if (fixed && (category === "data" || category === "tv")) {
            p.plans = p.plans || [];
            if (p.plans.length < 40) {
                p.plans.push({
                    code: String(it.item_code || it.short_name).slice(0, 40),
                    name: (it.short_name || it.biller_name || "Bundle").trim(),
                    amount: Number(it.amount) || 0,
                });
            }
        } else {
            p.requiresAmount = true;
        }
    }
    const providers = [...byCode.values()];
    flwCache.providers = providers;
    flwCache.at = now;
    return providers;
}

function findProvider(providers: BillProvider[], code: string): BillProvider | undefined {
    const c = String(code || "").toUpperCase();
    return providers.find((p) => p.code.toUpperCase() === c);
}

const BILL_MIN_AMOUNT = 50;
const BILL_MAX_AMOUNT = 500_000;

function getPlanConfig(businessId: string | null | undefined) {
    if (!businessId) return Promise.resolve(null); // personal users: no plan gating
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
    try {
        const providers = await loadProviders();
        res.json({
            success: true,
            liveProvider: isFlutterwaveConfigured(),
            categories: ["airtime", "data", "tv", "electricity", "betting"],
            providers,
        });
    } catch (e: any) {
        console.error("Bills catalog load failed:", e?.message);
        res.status(503).json({
            success: false,
            liveProvider: false,
            error: "Bill catalog is temporarily unavailable — please retry in a moment.",
        });
    }
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
        const allProviders = await loadProviders();
        const provider = findProvider(allProviders, String(provider_code || ""));
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

        // ---- Transaction PIN (wallet decides personal vs business hash) ----
        // NOTE: the wallet must be resolved BEFORE the PIN check now.
        const walletPre = await query(
            `SELECT * FROM wallets WHERE id = $1 AND (business_id = $2 OR user_id = $3)`,
            [wallet_id, businessId || null, userId]
        );
        const walletPreRow = walletPre.rows[0];
        if (!walletPreRow) return res.status(404).json({ success: false, error: "Wallet not found" });
        const pinCheck = await verifyTransactionPin(
            typeof pin === "string" ? pin : undefined,
            { userId, businessId: businessId || null, wallet: walletPreRow }
        );
        if (!pinCheck.ok) {
            return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });
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

        // ---- Wallet (already resolved for the PIN gate) ----
        const wallet = walletPreRow;
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

        // Pool ledger: the ONLY real pool movement for a wallet-funded bill is
        // the vendor settlement (platform pays the bill provider). The wallet
        // debit itself is internal — no "Bill Payment Received" inflow row.
        await debitPlatformWallet(billAmount, wallet.currency || "NGN", `${reference}-VENDOR`, "Platform Wallet Debit for Bill Settlement", "bills");
        if (fee > 0) {
            await creditRevenueWallet(fee, wallet.currency || "NGN", reference, "Bill Payment Convenience Fee", "bills");
        }

        // ---- Fulfil via Flutterwave bills (REAL payment — no simulation) ----
        const flwType = plan_code || provider.code; // fixed-price items use item_code, free-amount use biller_code
        const fulfilmentRaw = await flwPayBill({
            reference,
            customer: customerRef,
            amount: billAmount,
            type: flwType,
        });
        const fulfilment = {
            ok: fulfilmentRaw.ok,
            mode: "provider" as const,
            providerReference: fulfilmentRaw.provider_reference || null,
            message: fulfilmentRaw.error,
            raw: fulfilmentRaw.raw,
        };

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
