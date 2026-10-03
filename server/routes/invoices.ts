import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../middleware/auth";
import { requireTeamPermission } from "../middleware/teamAuth";
import { getProvider } from "../services/providers/factory";
import { calculateFee, creditPlatformWallet, creditRevenueWallet } from "../services/fees";
import { createNotification } from "../services/notifications";

const router = express.Router();

/**
 * Smart Invoices ("Get Paid" suite) — a REVENUE feature.
 *
 * Businesses create itemised invoices (line items, tax %, due date, notes)
 * and share a public checkout page (`/invoices/:id/pay`) with their clients.
 * Clients pay through the active payment provider's hosted checkout; the
 * webhook credits the business wallet minus a settlement fee
 * (fee_configurations 'invoice' — 1% capped ₦2,500 by default, reduced by the
 * business's plan-level invoice_fee_discount_percent). The fee lands in the
 * platform revenue wallet via creditRevenueWallet.
 *
 * Plan configuration (pricing_plans, admin-editable via /admin/pricing):
 *   - invoices_enabled             (feature toggle)
 *   - max_invoices_per_month       (NULL/999999+ = unlimited)
 *   - invoice_fee_discount_percent
 *
 * Lifecycle: draft → pending → paid | cancelled. "Overdue" is computed on
 * read (pending && due_date < today) — no cron required.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getPlanConfig(businessId: string) {
    const res = await query(
        `SELECT p.invoices_enabled, p.max_invoices_per_month, p.invoice_fee_discount_percent
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

const INVOICE_NUMBER_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomInvoiceNumber(): string {
    let out = "";
    for (let i = 0; i < 6; i++) out += INVOICE_NUMBER_ALPHABET[Math.floor(Math.random() * INVOICE_NUMBER_ALPHABET.length)];
    return `INV-${new Date().getFullYear()}-${out}`;
}

interface ItemInput {
    description?: string;
    quantity?: number | string;
    unit_price?: number | string;
}

/** Normalize + validate line items; returns null when the payload is unusable. */
function normalizeItems(raw: unknown): { description: string; quantity: number; unit_price: number; amount: number }[] | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const items: { description: string; quantity: number; unit_price: number; amount: number }[] = [];
    for (const item of raw as ItemInput[]) {
        const description = String(item?.description || "").trim();
        const quantity = Math.max(0, Number(item?.quantity ?? 1));
        const unitPrice = Math.max(0, Number(item?.unit_price ?? 0));
        if (!description) return null;
        if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return null;
        items.push({
            description,
            quantity: Math.round(quantity * 100) / 100,
            unit_price: Math.round(unitPrice * 100) / 100,
            amount: Math.round(quantity * unitPrice * 100) / 100,
        });
    }
    return items;
}

function computeTotals(items: { amount: number }[], taxPercent: number) {
    const subtotal = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    const taxAmount = Math.round(subtotal * Math.max(0, Math.min(taxPercent, 100)) / 100 * 100) / 100;
    const total = Math.round((subtotal + taxAmount) * 100) / 100;
    return { subtotal, taxAmount, total };
}

// ---------------------------------------------------------------------------
// Authenticated endpoints (invoice owners)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * tags:
 *   name: Smart Invoices
 *   description: Itemised invoices with public checkout pages — a revenue feature
 *     (settlement fee lands in the platform revenue wallet, plan-configurable)
 */

/**
 * @openapi
 * /invoices:
 *   get:
 *     summary: List the business's invoices with payment stats
 *     tags: [Smart Invoices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [draft, pending, paid, cancelled, overdue, all] }
 *     responses:
 *       200:
 *         description: Invoices (newest first)
 */
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const status = String(req.query.status || "").trim();

        const params: unknown[] = [businessId];
        let where = `i.business_id = $1`;
        if (status === 'overdue') {
            where += ` AND i.status = 'pending' AND i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE`;
        } else if (status && status !== 'all') {
            params.push(status);
            where += ` AND i.status = $${params.length}`;
        }

        const invoicesRes = await query(
            `SELECT i.*,
                    COALESCE((SELECT COUNT(*)::int FROM invoice_items it WHERE it.invoice_id = i.id), 0) AS item_count,
                    COALESCE((SELECT SUM(q.amount) FROM invoice_payments q WHERE q.invoice_id = i.id AND q.status = 'success'), 0) AS total_paid
             FROM invoices i
             WHERE ${where}
             ORDER BY i.created_at DESC
             LIMIT 200`,
            params
        );
        res.json({ success: true, invoices: invoicesRes.rows });
    } catch (error) {
        console.error("List invoices error:", error);
        res.status(500).json({ success: false, error: "Failed to load invoices" });
    }
});

/**
 * Create an invoice. Body: client_name, client_email, client_phone?, items[],
 * tax_percent?, due_date?, notes?, status? ('pending' default | 'draft').
 * Totals are always recomputed server-side from the line items.
 *
 * @openapi
 * /invoices:
 *   post:
 *     summary: Create an invoice (line items + tax + due date, plan-gated)
 *     tags: [Smart Invoices]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [client_name, client_email, items]
 *             properties:
 *               client_name: { type: string }
 *               client_email: { type: string }
 *               client_phone: { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     description: { type: string }
 *                     quantity: { type: number }
 *                     unit_price: { type: number }
 *               tax_percent: { type: number }
 *               due_date: { type: string, format: date }
 *               notes: { type: string }
 *               status: { type: string, enum: [pending, draft] }
 *     responses:
 *       200:
 *         description: Created invoice (invoice_number returned)
 *       403:
 *         description: Monthly quota reached or feature disabled (PLAN_UPGRADE_REQUIRED)
 */
router.post("/", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_invoices"), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const userId = req.user!.userId;
        const { client_name, client_email, client_phone, items, tax_percent, due_date, notes, status } = req.body || {};

        if (!client_name || !String(client_name).trim()) {
            return res.status(400).json({ success: false, error: "Client name is required" });
        }
        if (!client_email || !String(client_email).trim()) {
            return res.status(400).json({ success: false, error: "Client email is required" });
        }
        const normalizedItems = normalizeItems(items);
        if (!normalizedItems) {
            return res.status(400).json({ success: false, error: "Add at least one line item with a description" });
        }

        // Plan gating
        const plan = await getPlanConfig(businessId);
        if (plan && plan.invoices_enabled === false) {
            return res.status(403).json({
                success: false,
                error: "Invoices are not available on your current plan. Kindly upgrade your plan.",
                code: "PLAN_UPGRADE_REQUIRED",
            });
        }
        if (plan?.max_invoices_per_month != null && plan.max_invoices_per_month < 999999) {
            const countRes = await query(
                `SELECT COUNT(*)::int AS c FROM invoices
                 WHERE business_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)`,
                [businessId]
            );
            if (countRes.rows[0].c >= plan.max_invoices_per_month) {
                return res.status(403).json({
                    success: false,
                    error: `Your plan allows up to ${plan.max_invoices_per_month} invoice(s) per month. Kindly upgrade your plan to create more.`,
                    code: "PLAN_UPGRADE_REQUIRED",
                });
            }
        }

        const taxPercent = Math.max(0, Math.min(Number(tax_percent) || 0, 100));
        const { subtotal, taxAmount, total } = computeTotals(normalizedItems, taxPercent);
        const invoiceStatus = status === 'draft' ? 'draft' : 'pending';
        const dueDate = due_date ? String(due_date).slice(0, 10) : null;

        // Unique invoice number with retries
        let invoiceNumber = randomInvoiceNumber();
        for (let i = 0; i < 5; i++) {
            const exists = await query(`SELECT 1 FROM invoices WHERE invoice_number = $1`, [invoiceNumber]);
            if (exists.rows.length === 0) break;
            invoiceNumber = randomInvoiceNumber();
        }

        const insertRes = await query(
            `INSERT INTO invoices
             (business_id, created_by, invoice_number, client_name, client_email, client_phone, status, due_date, notes, tax_percent, subtotal, tax_amount, total)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING *`,
            [
                businessId, userId, invoiceNumber, String(client_name).trim(), String(client_email).trim(),
                client_phone ? String(client_phone).trim() : null, invoiceStatus, dueDate,
                notes ? String(notes).trim() : null, taxPercent, subtotal, taxAmount, total,
            ]
        );
        const invoice = insertRes.rows[0];

        const itemRows = normalizedItems.map((i, idx) =>
            query(
                `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, position)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [invoice.id, i.description, i.quantity, i.unit_price, i.amount, idx]
            )
        );
        await Promise.all(itemRows);

        res.json({ success: true, invoice });
    } catch (error) {
        console.error("Create invoice error:", error);
        res.status(500).json({ success: false, error: "Failed to create invoice" });
    }
});

/**
 * @openapi
 * /invoices/{id}:
 *   get:
 *     summary: Invoice detail (owner) — line items + payment history
 *     tags: [Smart Invoices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Invoice, items and payments
 *       404:
 *         description: Invoice not found
 */
router.get("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const businessId = req.user!.businessId;
        const invoiceRes = await query(
            `SELECT * FROM invoices WHERE id = $1 AND business_id = $2`,
            [id, businessId]
        );
        const invoice = invoiceRes.rows[0];
        if (!invoice) return res.status(404).json({ success: false, error: "Invoice not found" });

        const itemsRes = await query(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY position ASC`, [id]);
        const paymentsRes = await query(`SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY created_at DESC`, [id]);
        res.json({ success: true, invoice, items: itemsRes.rows, payments: paymentsRes.rows });
    } catch (error) {
        console.error("Invoice detail error:", error);
        res.status(500).json({ success: false, error: "Failed to load invoice" });
    }
});

/**
 * @openapi
 * /invoices/{id}:
 *   put:
 *     summary: Edit a draft/pending invoice that has not received any payment
 *     tags: [Smart Invoices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated invoice
 *       400:
 *         description: Paid invoices cannot be edited
 */
router.put("/:id", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_invoices"), async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const businessId = req.user!.businessId;
        const { client_name, client_email, client_phone, items, tax_percent, due_date, notes, status } = req.body || {};

        const invoiceRes = await query(`SELECT * FROM invoices WHERE id = $1 AND business_id = $2`, [id, businessId]);
        const invoice = invoiceRes.rows[0];
        if (!invoice) return res.status(404).json({ success: false, error: "Invoice not found" });
        if (!['draft', 'pending'].includes(invoice.status)) {
            return res.status(400).json({ success: false, error: `A ${invoice.status} invoice can no longer be edited` });
        }

        const paidRes = await query(
            `SELECT COUNT(*)::int AS c FROM invoice_payments WHERE invoice_id = $1 AND status = 'success'`,
            [id]
        );
        if (paidRes.rows[0].c > 0) {
            return res.status(400).json({ success: false, error: "This invoice has already been paid and cannot be edited" });
        }

        const nextStatus = status === 'draft' ? 'draft' : status === 'pending' ? 'pending' : invoice.status;

        let subtotal = Number(invoice.subtotal);
        let taxAmount = Number(invoice.tax_amount);
        let total = Number(invoice.total);
        let taxPercent = Number(invoice.tax_percent);

        if (Array.isArray(items) && items.length > 0) {
            const normalizedItems = normalizeItems(items);
            if (!normalizedItems) {
                return res.status(400).json({ success: false, error: "Every line item needs a description, quantity and unit price" });
            }
            taxPercent = tax_percent != null ? Math.max(0, Math.min(Number(tax_percent) || 0, 100)) : taxPercent;
            const totals = computeTotals(normalizedItems, taxPercent);
            subtotal = totals.subtotal; taxAmount = totals.taxAmount; total = totals.total;

            await query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
            await Promise.all(normalizedItems.map((i, idx) =>
                query(
                    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, position)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [id, i.description, i.quantity, i.unit_price, i.amount, idx]
                )
            ));
        }

        const updated = await query(
            `UPDATE invoices SET
                client_name = COALESCE($2, client_name),
                client_email = COALESCE($3, client_email),
                client_phone = COALESCE($4, client_phone),
                status = $5,
                due_date = COALESCE($6, due_date),
                notes = COALESCE($7, notes),
                tax_percent = $8,
                subtotal = $9,
                tax_amount = $10,
                total = $11,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING *`,
            [
                id,
                client_name != null ? String(client_name).trim() : null,
                client_email != null ? String(client_email).trim() : null,
                client_phone != null ? String(client_phone).trim() : null,
                nextStatus,
                due_date != null ? String(due_date).slice(0, 10) : null,
                notes != null ? String(notes).trim() : null,
                taxPercent, subtotal, taxAmount, total,
            ]
        );
        res.json({ success: true, invoice: updated.rows[0] });
    } catch (error) {
        console.error("Update invoice error:", error);
        res.status(500).json({ success: false, error: "Failed to update invoice" });
    }
});

/**
 * @openapi
 * /invoices/{id}:
 *   delete:
 *     summary: Delete an invoice (only when nothing has been paid against it)
 *     tags: [Smart Invoices]
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
 *         description: Paid invoices cannot be deleted
 */
router.delete("/:id", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_invoices"), async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const businessId = req.user!.businessId;
        const invoiceRes = await query(`SELECT id, status FROM invoices WHERE id = $1 AND business_id = $2`, [id, businessId]);
        const invoice = invoiceRes.rows[0];
        if (!invoice) return res.status(404).json({ success: false, error: "Invoice not found" });

        const paidRes = await query(
            `SELECT COUNT(*)::int AS c FROM invoice_payments WHERE invoice_id = $1 AND status = 'success'`,
            [id]
        );
        if (paidRes.rows[0].c > 0 || invoice.status === 'paid') {
            return res.status(400).json({ success: false, error: "Paid invoices cannot be deleted" });
        }

        await query(`DELETE FROM invoices WHERE id = $1`, [id]);
        res.json({ success: true, message: "Invoice deleted" });
    } catch (error) {
        console.error("Delete invoice error:", error);
        res.status(500).json({ success: false, error: "Failed to delete invoice" });
    }
});

/**
 * @openapi
 * /invoices/{id}/cancel:
 *   post:
 *     summary: Cancel an unpaid invoice
 *     tags: [Smart Invoices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cancelled invoice
 *       400:
 *         description: Only unpaid invoices can be cancelled
 */
router.post("/:id/cancel", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_invoices"), async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const businessId = req.user!.businessId;
        const updated = await query(
            `UPDATE invoices SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND business_id = $2 AND status IN ('draft', 'pending')
             RETURNING *`,
            [id, businessId]
        );
        if (updated.rows.length === 0) {
            return res.status(400).json({ success: false, error: "Only unpaid invoices can be cancelled" });
        }
        res.json({ success: true, invoice: updated.rows[0] });
    } catch (error) {
        console.error("Cancel invoice error:", error);
        res.status(500).json({ success: false, error: "Failed to cancel invoice" });
    }
});

// ---------------------------------------------------------------------------
// Public endpoints (no auth — clients paying an invoice)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /invoices/public/{id}:
 *   get:
 *     summary: Public invoice view (no auth — the client sees items, totals, due date)
 *     tags: [Smart Invoices]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Public invoice payload
 *       404:
 *         description: Invoice not found
 */
router.get("/public/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const invoiceRes = await query(`SELECT * FROM invoices WHERE id = $1`, [id]);
        const invoice = invoiceRes.rows[0];
        if (!invoice || invoice.status === 'draft' || invoice.status === 'cancelled') {
            return res.status(404).json({ success: false, error: "Invoice not found" });
        }

        const bizRes = await query(`SELECT name FROM businesses WHERE id = $1`, [invoice.business_id]);
        const itemsRes = await query(`SELECT description, quantity, unit_price, amount FROM invoice_items WHERE invoice_id = $1 ORDER BY position ASC`, [id]);

        // Fire-and-forget view counter
        query(`UPDATE invoices SET views = views + 1 WHERE id = $1`, [invoice.id]).catch(() => {});

        const effectiveStatus =
            invoice.status === 'pending' && invoice.due_date && new Date(invoice.due_date) < new Date(new Date().toDateString())
                ? 'overdue'
                : invoice.status;

        res.json({
            success: true,
            invoice: {
                id: invoice.id,
                invoice_number: invoice.invoice_number,
                client_name: invoice.client_name,
                client_email: invoice.client_email,
                status: effectiveStatus,
                due_date: invoice.due_date,
                notes: invoice.notes,
                tax_percent: Number(invoice.tax_percent) || 0,
                subtotal: Number(invoice.subtotal) || 0,
                tax_amount: Number(invoice.tax_amount) || 0,
                total: Number(invoice.total) || 0,
                currency: invoice.currency || 'NGN',
                amount_paid: Number(invoice.amount_paid) || 0,
            },
            items: itemsRes.rows.map((i: any) => ({
                description: i.description,
                quantity: Number(i.quantity),
                unit_price: Number(i.unit_price),
                amount: Number(i.amount),
            })),
            business_name: bizRes.rows[0]?.name || "Metricorex Business",
        });
    } catch (error) {
        console.error("Public invoice view error:", error);
        res.status(500).json({ success: false, error: "Failed to load invoice" });
    }
});

/**
 * Initiate a client payment: creates the pending payment record + pending
 * transaction (transaction_type 'invoice') and returns the provider's hosted
 * checkout URL. The amount is always the server-computed invoice total.
 *
 * @openapi
 * /invoices/public/{id}/initiate:
 *   post:
 *     summary: Initiate a client payment (returns hosted checkout URL, settled by webhook)
 *     tags: [Smart Invoices]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               payer_name: { type: string }
 *               payer_email: { type: string }
 *               provider: { type: string, description: "Optional provider override" }
 *     responses:
 *       200:
 *         description: checkout_url + reference
 *       400:
 *         description: Invoice already paid / no amount due
 *       404:
 *         description: Invoice not found
 */
router.post("/public/:id/initiate", async (req, res) => {
    try {
        const { id } = req.params;
        const { payer_name, payer_email, provider: requestedProvider } = req.body || {};

        const invoiceRes = await query(`SELECT * FROM invoices WHERE id = $1`, [id]);
        const invoice = invoiceRes.rows[0];
        if (!invoice || invoice.status === 'draft' || invoice.status === 'cancelled') {
            return res.status(404).json({ success: false, error: "Invoice not found" });
        }
        if (invoice.status === 'paid') {
            return res.status(400).json({ success: false, error: "This invoice has already been paid" });
        }

        const payAmount = Number(invoice.total);
        if (!payAmount || payAmount <= 0) {
            return res.status(400).json({ success: false, error: "This invoice has no amount due" });
        }

        const email = String(payer_email || invoice.client_email || "").trim();
        if (!email) {
            return res.status(400).json({ success: false, error: "Payer email is required" });
        }

        // Business settlement wallet (NGN first) for crediting on settlement
        const walletRes = await query(
            `SELECT id FROM wallets WHERE business_id = $1 ORDER BY (currency = 'NGN') DESC LIMIT 1`,
            [invoice.business_id]
        );
        if (walletRes.rows.length === 0) {
            return res.status(400).json({ success: false, error: "This business has no settlement wallet yet. Please contact the merchant." });
        }

        const currency = (invoice.currency || 'NGN').toUpperCase();
        const reference = `INVP-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

        // Pending ledger rows — the webhook settles both
        await query(
            `INSERT INTO invoice_payments
             (invoice_id, business_id, transaction_reference, payer_name, payer_email, amount, fee, net_amount, currency, status, payment_provider)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $6, $7, 'pending', $8)`,
            [invoice.id, invoice.business_id, reference, payer_name || invoice.client_name || null, email, payAmount, currency, requestedProvider || null]
        );
        await query(
            `INSERT INTO transactions (business_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, payment_provider)
             VALUES ($1, $2, $3, $4, 'pending', 'credit', $5, 'invoice', $6, $7)`,
            [invoice.business_id, payAmount, currency, reference, `Invoice ${invoice.invoice_number} — ${invoice.client_name}`, walletRes.rows[0].id, requestedProvider || null]
        );

        // Hosted checkout via the active payment provider (amount in kobo/minor unit)
        const providerName = requestedProvider || await getActiveProviderName();
        const provider = getProvider(providerName);
        const origin = req.get('origin') || process.env.APP_BASE_URL || 'https://app.metricorex.com';
        const baseUrl = String(origin).endsWith('/') ? String(origin).slice(0, -1) : String(origin);
        const callbackUrl = `${baseUrl}/invoices/${invoice.id}/pay`;

        let paymentResponse: any;
        try {
            paymentResponse = await provider.initiatePayment({
                email,
                amount: Math.round(payAmount * 100),
                reference,
                callbackUrl,
                currency,
            });
        } catch (providerError: any) {
            console.error("Invoice provider initiation failed:", providerError?.message);
            await query(`UPDATE invoice_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE transaction_reference = $1`, [reference]);
            await query(`UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE reference = $1`, [reference]);
            return res.status(502).json({ success: false, error: "Could not start the payment. Please try again." });
        }

        const checkoutUrl = paymentResponse?.data?.checkout_url || paymentResponse?.data?.link || paymentResponse?.checkout_url;
        if (!checkoutUrl) {
            await query(`UPDATE invoice_payments SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE transaction_reference = $1`, [reference]);
            await query(`UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE reference = $1`, [reference]);
            return res.status(502).json({ success: false, error: "Payment provider did not return a checkout URL" });
        }

        res.json({ success: true, checkout_url: checkoutUrl, reference, amount: payAmount, currency });
    } catch (error) {
        console.error("Invoice initiate error:", error);
        res.status(500).json({ success: false, error: "Failed to initiate payment" });
    }
});

async function getActiveProviderName(): Promise<string> {
    const res = await query(`SELECT value FROM system_settings WHERE key = 'active_payment_provider' LIMIT 1`);
    return res.rows[0]?.value || process.env.DEFAULT_PAYMENT_PROVIDER || 'flutterwave';
}

// ---------------------------------------------------------------------------
// Webhook settlement — called by server/routes/webhook.ts when a charge with
// transaction_type 'invoice' succeeds. Idempotent: the payment row flips
// pending → success exactly once.
// ---------------------------------------------------------------------------

export async function settleInvoicePayment(reference: string, providerName: string): Promise<void> {
    const paymentRes = await query(
        `SELECT * FROM invoice_payments
         WHERE transaction_reference = $1 AND status = 'pending'`,
        [reference]
    );
    const payment = paymentRes.rows[0];
    if (!payment) return; // already settled or unknown — nothing to do

    const gross = Number(payment.amount);
    const currency = payment.currency || 'NGN';

    // Settlement fee: base config, reduced by the merchant's plan discount
    const baseFee = await calculateFee(gross, 'invoice');
    const plan = await getPlanConfig(payment.business_id);
    const fee = effectiveFee(gross, baseFee, Number(plan?.invoice_fee_discount_percent) || 0);
    const net = Math.max(0, gross - fee);

    // Business settlement wallet (NGN first)
    const walletRes = await query(
        `SELECT id FROM wallets WHERE business_id = $1 ORDER BY (currency = 'NGN') DESC LIMIT 1`,
        [payment.business_id]
    );
    if (walletRes.rows.length === 0) {
        console.error(`settleInvoicePayment: no settlement wallet for business ${payment.business_id} (ref ${reference})`);
        return;
    }
    const walletId = walletRes.rows[0].id;

    // Flip the payment row FIRST (idempotency gate), then move the money.
    await query(
        `UPDATE invoice_payments
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
         VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'invoice', $6, 'credit', $7, $8)
         ON CONFLICT (reference) DO NOTHING`,
        [payment.business_id, net, currency, `${reference}-SETTLED`, `Invoice payment received (net of ${fee} ${currency} fee)`, walletId, fee, providerName]
    );

    // Mark the invoice paid
    const invoiceUpdate = await query(
        `UPDATE invoices
         SET status = 'paid', amount_paid = amount_paid + $2, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status IN ('draft', 'pending')
         RETURNING invoice_number, client_name, created_by`,
        [payment.invoice_id, gross]
    );

    // Pool ledger: the client's gateway payment IS a real pool inflow.
    // The merchant settlement is an internal wallet credit (no pool movement).
    await creditPlatformWallet(gross, currency, reference, 'Invoice Client Payment Received', providerName);
    if (fee > 0) {
        await creditRevenueWallet(fee, currency, reference, 'Invoice Settlement Fee', providerName);
    }

    // Notify the merchant
    const invoiceInfo = invoiceUpdate.rows[0];
    try {
        await createNotification({
            businessId: payment.business_id,
            userId: invoiceInfo?.created_by || null,
            type: "credit",
            title: "Invoice Paid",
            message: `Invoice ${invoiceInfo?.invoice_number || ''}${invoiceInfo?.client_name ? ` from ${invoiceInfo.client_name}` : ''} was paid: +${net.toLocaleString()} ${currency}${fee > 0 ? ` (fee: ${fee} ${currency})` : ''}`,
            actionUrl: "/invoices",
            actionType: "view_invoice",
            metadata: { reference, amount: gross, fee, net, invoiceId: payment.invoice_id },
            isActionable: false,
            expiresInHours: 72,
        });
    } catch (notifErr) {
        console.error("Invoice notification failed:", notifErr);
    }
}

export default router;
