import express from "express";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";
import { verifyTransactionPin } from "./personal-utils";
import { calculateFee, debitPlatformWallet, creditRevenueWallet } from "../../services/fees";
import { createNotification } from "../../services/notifications";
import {
    getBillCategories, createBillPayment, validateBillCustomer, getBillPaymentByReference,
    billerLogo, isFlutterwaveConfigured, flwErr,
} from "../../services/flutterwave";

const router = express.Router();

/**
 * Bills Hub — the fourth REVENUE feature (daily-use). REAL Flutterwave
 * bill payments for EVERY category Flutterwave offers: airtime, mobile
 * data, cable TV (DStv/GOtv/StarTimes), electricity (all Discos),
 * internet/ISP (Smile, Spectranet, Swift, ipNX) plus tolls/tax/shipping
 * (LCC, FIRS, DHL). Nothing is hardcoded and nothing is simulated.
 *
 * Catalog model (v2): the legacy /bill-categories rows carry BOTH a
 * biller-level `name` ("MTN DATA BUNDLE") and an item-level
 * `biller_name`/`item_code` ("MTN 1.5GB data bundle"). Grouping by the
 * biller-level name yields a clean provider list whose fixed-price items
 * become selectable plans; variable-amount billers (airtime, meters,
 * betting) take a free amount. Every provider ships with a logo tile.
 *
 * Money: wallet debit (amount + convenience fee from fee_configurations
 * 'bill', reduced by plan bill_fee_discount_percent) → Flutterwave bill
 * payment (documented path-style endpoint, legacy fallback) → status
 * sync (webhook + pull). Pending payments stay pending until the
 * provider confirms via webhook; only hard failures refund instantly.
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
    code: string;       // Flutterwave item_code (payment `type` for fixed items)
    name: string;
    amount: number;
    validity?: string;
    /** set when a merged provider carries plans from a sibling biller_code */
    biller_code?: string;
}
interface BillProvider {
    code: string;           // Flutterwave biller_code
    name: string;           // biller-level name ("MTN DATA BUNDLE")
    display_name: string;   // prettified ("MTN Data")
    category: string;
    refLabel: string;       // customer reference label shown in UIs
    refPattern?: string;
    refExample?: string;
    /** fixed-price plans (data bundles / TV packages / ISP bundles) */
    plans?: BillPlan[];
    /** electricity disco token flow / free-amount airtime */
    requiresAmount?: boolean;
    logo: string;
}

const flwCache: { at: number; providers: BillProvider[] } = { at: 0, providers: [] };
const FLW_CATALOG_TTL = 10 * 60 * 1000;

function classifyBillItem(name: string): string {
    const n = name.toLowerCase();
    if (/(bet9ja|sporty|bet\b|betting|nairabet|betway|1xbet|msport)/.test(n)) return "betting";
    if (/(dstv|gotv|startimes|topstar|tv|cable|dish|multichoice)/.test(n)) return "tv";
    if (/(electric|disco|ikedc|ekedc|aedc|jedc|kedco|phed|ibedc|kaedco|tcn|power|prepaid|postpaid|meter|eedc)/.test(n)) return "electricity";
    if (/(smile|spectranet|swift|ipnx|internet|fibre|fiber|broadband)/.test(n)) return "internet";
    if (/(airtime|vtu|hynet|\bat\d+|mtn\b|glo\b|airtel\b|9mobile\b)/.test(n) && !/data/.test(n)) return "airtime";
    if (/(\d+\s*(gb|mb)|data|sme|corporate gsm|gifting)/.test(n)) return "data";
    return "other";
}

function prettifyName(name: string, category: string): string {
    const s = String(name || "").trim();
    if (!s) return "Service";
    const title = s
        .toLowerCase()
        .replace(/\bdata bundle\b/, "Data")
        .replace(/\bnigeria\b/, "")
        .replace(/\bvtu\b/, "Airtime")
        .replace(/\belectricity bills\b/, "Electricity")
        .replace(/\bdisco\b/, "Disco")
        .replace(/\bsubscription payments?\b/, "Subscription")
        .replace(/\bpayment(s)?\b/, "")
        .replace(/\blimited\b/, "")
        .replace(/\s+/g, " ")
        .trim();
    return title
        .split(" ")
        .filter(Boolean)
        .map((w) => (/^(mtn|9mobile|ipnx|lcc|firs|dhl|smile|swift|gotv|dstv|bet9ja|jvri|vtu)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
        .join(" ") || category;
}

function refLabelFor(category: string, labelName?: string): string {
    const l = String(labelName || "").trim();
    if (l && !/^customer$/i.test(l)) return l.replace(/\bnumber\b/i, "number").replace(/^./, (c) => c.toUpperCase());
    switch (category) {
        case "airtime": case "data": return "Phone number";
        case "tv": return "Smartcard / IUC number";
        case "electricity": return "Meter number";
        case "betting": return "Customer ID";
        case "internet": return "Account number";
        default: return "Customer reference";
    }
}

function refPatternFor(category: string): string | undefined {
    if (category === "airtime" || category === "data") return "^0[789][01]\\d{8}$";
    return undefined;
}

/**
 * DYNAMIC catalog — fetched live from the Flutterwave bill categories
 * (cached 10 min). Groups rows by the biller-level `name` so data bundles
 * land under their network provider and TV packages under their brand.
 */
async function loadProviders(): Promise<BillProvider[]> {
    const now = Date.now();
    if (flwCache.providers.length && now - flwCache.at < FLW_CATALOG_TTL) return flwCache.providers;
    const items = await getBillCategories("NG");
    const byName = new Map<string, BillProvider & { _label: string }>();
    for (const it of items) {
        const billerName = String(it.name || it.biller_name || "").trim();
        const code = String(it.biller_code || "").toUpperCase();
        if (!billerName || !code) continue;
        const itemLabel = String(it.label_name || "").trim();
        const category = classifyBillItem(`${billerName} ${it.biller_name || ""} ${it.short_name || ""}`);
        const key = `${billerName}::${code}`;
        let p = byName.get(key);
        if (!p) {
            p = {
                code, name: billerName, display_name: prettifyName(billerName, category), category,
                refLabel: refLabelFor(category, itemLabel), refPattern: refPatternFor(category),
                plans: [], requiresAmount: false, _label: itemLabel,
                logo: billerLogo(billerName, code),
            };
            byName.set(key, p);
        }
        const fixed = it.is_amount_fixed === true || (Number(it.amount) || 0) > 0;
        if (fixed) {
            p.plans = p.plans || [];
            if (!p.plans.some((x) => x.code === String(it.item_code)) && p.plans.length < 60) {
                p.plans.push({
                    code: String(it.item_code || it.short_name).slice(0, 40),
                    name: (it.short_name || it.biller_name || "Bundle").trim(),
                    amount: Number(it.amount) || 0,
                });
            }
        } else {
            p.requiresAmount = true;
        }
        if (itemLabel && !p._label) p._label = itemLabel;
    }
    const providers = [...byName.values()].map(({ _label, ...p }) => {
        // Plans sorted by price; providers without plans are free-amount.
        p.plans?.sort((a, b) => a.amount - b.amount);
        if (p.plans?.length) p.requiresAmount = p.requiresAmount || false;
        else p.requiresAmount = true;
        if (_label) p.refLabel = refLabelFor(p.category, _label);
        return p as BillProvider;
    });
    // Merge duplicates that share a display name + category ("DSTV" and
    // "DSTV Payment", the two ipNX rows, FIRS/…) into one provider.
    const merged = new Map<string, BillProvider>();
    for (const p of providers) {
        const key = `${p.display_name.toUpperCase()}::${p.category}`;
        const existing = merged.get(key);
        if (!existing) {
            merged.set(key, p);
            continue;
        }
        const plans = [...(existing.plans || []), ...(p.plans || [])].filter(
            (x, i, arr) => arr.findIndex((y) => y.code === x.code) === i,
        );
        plans.sort((a, b) => a.amount - b.amount);
        existing.plans = plans.length ? plans : undefined;
        existing.requiresAmount = existing.requiresAmount || p.requiresAmount || !plans.length;
        // Tag plans that came from a different biller_code so /pay can use
        // the right biller for the path-style payment endpoint.
        if (p.code !== existing.code) {
            for (const plan of plans) {
                if (plan.biller_code === undefined) plan.biller_code = p.code;
            }
        }
    }
    const finalProviders = [...merged.values()];
    flwCache.providers = finalProviders;
    flwCache.at = now;
    return finalProviders;
}

function findProvider(providers: BillProvider[], code: string): BillProvider | undefined {
    const c = String(code || "").toUpperCase();
    return providers.find((p) => p.code.toUpperCase() === c)
        || providers.find((p) => p.display_name.toUpperCase() === c);
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
// Schema additions (electricity tokens etc.) — idempotent
// ---------------------------------------------------------------------------
export async function ensureBillsSchema(): Promise<void> {
    await query(`ALTER TABLE bill_payments ADD COLUMN IF NOT EXISTS recharge_token TEXT`);
    await query(`ALTER TABLE bill_payments ADD COLUMN IF NOT EXISTS item_code VARCHAR(60)`);
}

// ---------------------------------------------------------------------------
// Catalog endpoints
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /bills/catalog:
 *   get:
 *     summary: Bills service catalog — every Flutterwave biller with plans and logos
 *     tags: [Bills]
 *     security: []
 *     responses:
 *       200:
 *         description: Catalog with all providers (airtime, data, tv, electricity, internet, other), plans, ref labels and logos
 */
router.get("/catalog", async (_req, res) => {
    try {
        const providers = await loadProviders();
        const categories = [...new Set(providers.map((p) => p.category))];
        res.json({
            success: true,
            liveProvider: isFlutterwaveConfigured(),
            categories,
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
 * /bills/validate:
 *   post:
 *     summary: Validate a bill customer (meter number, smartcard, phone, account)
 *     tags: [Bills]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider_code, customer_ref]
 *             properties:
 *               provider_code:
 *                 type: string
 *                 example: BIL119
 *               item_code:
 *                 type: string
 *                 description: Required when the provider has fixed plans (the chosen plan code)
 *               customer_ref:
 *                 type: string
 *                 description: Meter number / smartcard / phone / account id
 *     responses:
 *       200:
 *         description: Validation result (ok + customer name or a readable error)
 */
router.post("/validate", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const allProviders = await loadProviders();
        const provider = findProvider(allProviders, String(req.body?.provider_code || ""));
        if (!provider) return res.status(400).json({ success: false, error: "Unknown service. Pick a valid bill provider." });
        const customer = String(req.body?.customer_ref || "").trim();
        if (!customer) return res.status(400).json({ success: false, error: `${provider.refLabel} is required` });
        // Validation needs an item identifier: the chosen plan's item_code for
        // fixed-price billers, the biller_code itself for free-amount billers.
        let itemCode = String(req.body?.item_code || "").trim();
        if (!itemCode && provider.plans?.length) itemCode = provider.plans[0].code;
        const result = await validateBillCustomer(itemCode || provider.code, customer);
        res.json({
            success: true,
            ok: result.ok,
            error: result.error || null,
            customer_name: result.info?.name || null,
            info: result.info || null,
        });
    } catch (e: any) {
        res.status(502).json({ success: false, error: flwErr(e) });
    }
});

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
 *         schema: { type: string, enum: [airtime, data, tv, electricity, internet, other, all] }
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
 *     summary: Pay a bill (airtime, data, TV, electricity, internet, tolls/tax) from a wallet
 *     tags: [Bills]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [category, provider_code, customer_ref, wallet_id, pin]
 *             properties:
 *               category:
 *                 type: string
 *                 enum: [airtime, data, tv, electricity, internet, betting, other]
 *               provider_code:
 *                 type: string
 *                 example: BIL104
 *               plan_code:
 *                 type: string
 *                 description: Required for fixed-price billers (data/TV/ISP bundles) — the plan's item_code
 *               customer_ref:
 *                 type: string
 *                 description: Phone number, smartcard/IUC, meter number or customer id
 *               customer_phone:
 *                 type: string
 *                 description: Optional contact phone for receipts
 *               wallet_id:
 *                 type: string
 *                 format: uuid
 *               amount:
 *                 type: number
 *                 description: Required when the provider has no fixed plan
 *               pin:
 *                 type: string
 *                 description: Transaction PIN (same PIN verified for transfers)
 *     responses:
 *       200:
 *         description: Bill paid (or queued pending provider confirmation)
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
        let itemCode: string | null = null;
        let planBiller: string | null = null;
        if (provider.plans?.length) {
            const plan = provider.plans.find((p) => p.code === String(plan_code || ""));
            if (!plan) {
                return res.status(400).json({
                    success: false,
                    error: `Choose a ${provider.display_name || provider.name} package`,
                    plans: provider.plans,
                });
            }
            billAmount = plan.amount;
            planName = plan.name;
            itemCode = plan.code;
            planBiller = plan.biller_code || provider.code;
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
              plan_code, plan_name, item_code, customer_ref, customer_phone, amount, fee, total, currency, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending')
             RETURNING *`,
            [
                owningBusinessId, userId, wallet.id, reference, provider.category, provider.code, provider.display_name || provider.name,
                itemCode, planName, itemCode, customerRef, customer_phone ? String(customer_phone).trim() : null,
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
                `${provider.display_name || provider.name}${planName ? ` (${planName})` : ""} — ${customerRef}`,
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
        const fulfilment = await createBillPayment({
            billerCode: planBiller || provider.code,
            itemCode: itemCode || undefined,
            customer: customerRef,
            amount: billAmount,
            reference,
            country: "NG",
            callbackUrl: process.env.API_BASE_URL ? `${String(process.env.API_BASE_URL).replace(/\/$/, "")}/api/webhook` : undefined,
        });

        const providerStatus = String(fulfilment.raw?.data?.status || fulfilment.raw?.data?.code || "").toUpperCase();
        const pendingStatuses = ["PENDING", "PROCESSING", "IN_PROGRESS", "QUEUED"];
        const isPending = fulfilment.ok && (fulfilment.pending === true || pendingStatuses.includes(providerStatus));
        const rechargeToken = fulfilment.raw?.data?.recharge_token || null;
        const finalStatus = !fulfilment.ok ? "failed" : isPending ? "pending" : "success";

        await query(
            `UPDATE bill_payments
             SET status = $2, fulfilment_mode = 'provider', provider_reference = $3,
                 provider_response = $4::jsonb, failure_reason = $5,
                 recharge_token = $6, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [
                bill.id, finalStatus, fulfilment.provider_reference || null,
                JSON.stringify(fulfilment), fulfilment.ok ? null : fulfilment.error || "Fulfilment failed",
                rechargeToken,
            ]
        );

        // Refund ONLY on a hard failure. Pending bills stay pending — the
        // webhook (or the status poll) settles or refunds them later.
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
                    `Bill payment refund — ${provider.display_name || provider.name} (${customerRef})`, wallet.id,
                ]
            );
        }

        // ---- Notification ----
        try {
            await createNotification({
                businessId: owningBusinessId || businessId,
                userId,
                type: finalStatus === "success" ? "debit" : finalStatus === "pending" ? "system" : "system",
                title:
                    finalStatus === "success" ? "Bill Payment Successful"
                    : finalStatus === "pending" ? "Bill Payment Processing"
                    : "Bill Payment Failed",
                message:
                    finalStatus === "success"
                        ? `${provider.display_name || provider.name}${planName ? ` (${planName})` : ""} for ${customerRef}: -${total.toLocaleString()} ${wallet.currency || "NGN"} (fee: ${fee})`
                        : finalStatus === "pending"
                          ? `${provider.display_name || provider.name} payment is processing — we'll confirm shortly.`
                          : `${provider.display_name || provider.name} payment failed and was refunded: ${fulfilment.error || "contact support"}`,
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
            success: finalStatus !== "failed",
            pending: finalStatus === "pending",
            bill: updated.rows[0],
            message:
                finalStatus === "success"
                    ? `${provider.display_name || provider.name} payment successful`
                    : finalStatus === "pending"
                      ? "Payment is processing — you'll be notified as soon as the provider confirms."
                      : `Payment failed and refunded: ${fulfilment.error || "please try again"}`,
        });
    } catch (error) {
        console.error("Pay bill error:", error);
        res.status(500).json({ success: false, error: "Failed to process bill payment" });
    }
});

/**
 * @openapi
 * /bills/{id}/sync:
 *   post:
 *     summary: Pull the latest status of a pending bill payment from Flutterwave
 *     tags: [Bills]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Refreshed bill payment record (settles or refunds when the provider resolved it)
 */
router.post("/:id/sync", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { userId, businessId } = req.user!;
        const billRes = await query(
            `SELECT * FROM bill_payments WHERE (id::text = $1 OR reference = $1) AND (user_id = $2 OR business_id = $3)`,
            [req.params.id, userId, businessId || null]
        );
        const bill = billRes.rows[0];
        if (!bill) return res.status(404).json({ success: false, error: "Bill payment not found" });
        if (bill.status !== "pending") return res.json({ success: true, bill, changed: false });

        const remote = bill.provider_reference
            ? await getBillPaymentByReference(bill.reference)
            : null;
        const remoteStatus = String(remote?.status || "").toUpperCase();
        if (!remote || !remoteStatus) return res.json({ success: true, bill, changed: false });

        let finalStatus: string | null = null;
        if (["SUCCESSFUL", "SUCCESS", "COMPLETED", "DELIVERED"].includes(remoteStatus)) finalStatus = "success";
        else if (["FAILED", "REJECTED", "REVERSED"].includes(remoteStatus)) finalStatus = "failed";
        if (!finalStatus) return res.json({ success: true, bill, changed: false });

        const total = Number(bill.total);
        await query(
            `UPDATE bill_payments SET status = $2, provider_response = $3::jsonb,
                recharge_token = COALESCE($4, recharge_token), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [bill.id, finalStatus, JSON.stringify(remote), remote?.recharge_token || null]
        );
        if (finalStatus === "failed") {
            await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [total, bill.wallet_id]);
            await query(
                `INSERT INTO transactions
                 (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction)
                 VALUES ($1, $2, $3, $4, $5, 'success', 'credit', $6, 'bill_refund', $7, 'credit')`,
                [bill.business_id, bill.user_id, total, bill.currency || "NGN", `${bill.reference}-REFUND`,
                 `Bill payment refund — ${bill.provider_name} (${bill.customer_ref})`, bill.wallet_id]
            );
        }
        const updated = await query(`SELECT * FROM bill_payments WHERE id = $1`, [bill.id]);
        res.json({ success: true, bill: updated.rows[0], changed: true, status: finalStatus });
    } catch (e: any) {
        res.status(500).json({ success: false, error: "Could not sync bill status" });
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
            `SELECT * FROM bill_payments WHERE (id::text = $1 OR reference = $1) AND (user_id = $2 OR business_id = $3)`,
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
