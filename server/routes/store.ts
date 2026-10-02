import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../middleware/auth";
import { requireTeamPermission } from "../middleware/teamAuth";
import { calculateFee, creditPlatformWallet, debitPlatformWallet, creditRevenueWallet } from "../services/fees";
import { createNotification } from "../services/notifications";
import { getProvider } from "../services/providers/factory";

const router = express.Router();

/**
 * Metroflow Storefront — a BUSINESS revenue feature.
 *
 * Businesses list products/services in a shareable storefront. Customers open
 * the public page (/store/public/:businessId on the web), pick quantities and
 * check out through the active payment provider's hosted checkout. The webhook
 * credits the business wallet minus an order fee (fee_configurations
 * 'store_order' — 2.5% capped ₦2,500 by default, reduced by the plan-level
 * store_fee_discount_percent); the fee lands in the platform revenue wallet
 * via creditRevenueWallet and every settlement is double-entered through the
 * platform ledger.
 *
 * Plan configuration (pricing_plans, admin-editable via /admin/pricing):
 *   - store_enabled              (feature toggle)
 *   - max_store_products         (NULL/999999+ = unlimited)
 *   - store_fee_discount_percent
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getPlanConfig(businessId: string) {
    const res = await query(
        `SELECT p.store_enabled, p.max_store_products, p.store_fee_discount_percent
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

// ---------------------------------------------------------------------------
// Root tag
// ---------------------------------------------------------------------------

/**
 * @openapi
 * tags:
 *   name: Storefront
 *   description: Metroflow Store — hosted product checkout for businesses — a
 *     revenue feature (order fee lands in the platform revenue wallet,
 *     plan-configurable via store_fee_discount_percent)
 */

// ---------------------------------------------------------------------------
// Merchant endpoints (authenticated)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /store/products:
 *   get:
 *     summary: List the business's storefront products
 *     tags: [Storefront]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Products + storefront plan state
 */
router.get("/products", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const products = await query(
            `SELECT * FROM store_products WHERE business_id = $1 ORDER BY created_at DESC`,
            [businessId]
        );
        const plan = await getPlanConfig(businessId);
        const count = await query(`SELECT COUNT(*)::int AS c FROM store_products WHERE business_id = $1`, [businessId]);
        res.json({
            success: true,
            products: products.rows,
            store: {
                enabled: plan ? plan.store_enabled !== false : true,
                max_products: plan?.max_store_products ?? null,
                product_count: count.rows[0].c,
            },
        });
    } catch (error) {
        console.error("List store products error:", error);
        res.status(500).json({ success: false, error: "Failed to load products" });
    }
});

/**
 * @openapi
 * /store/products:
 *   post:
 *     summary: Create a storefront product (plan-gated)
 *     tags: [Storefront]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, price]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               price: { type: number }
 *               stock: { type: integer, nullable: true, description: "NULL = unlimited" }
 *               image_url: { type: string }
 *               status: { type: string, enum: [active, paused, draft] }
 *     responses:
 *       200:
 *         description: Product created
 *       403:
 *         description: Storefront disabled or product cap reached (PLAN_UPGRADE_REQUIRED)
 */
router.post("/products", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_store"), async (req: AuthenticatedRequest, res) => {
    try {
        const { userId, businessId } = req.user!;
        const { name, description, price, stock, image_url, status } = req.body || {};

        const productName = String(name || "").trim();
        if (!productName) return res.status(400).json({ success: false, error: "Product name is required" });
        const productPrice = Math.round(Number(price) * 100) / 100;
        if (!productPrice || productPrice < 50) {
            return res.status(400).json({ success: false, error: "Price must be at least ₦50" });
        }
        const stockValue = stock == null || stock === "" ? null : Math.max(0, Math.floor(Number(stock)));
        const validStatus = ["active", "paused", "draft"].includes(status) ? status : "active";

        const plan = await getPlanConfig(businessId);
        if (plan && plan.store_enabled === false) {
            return res.status(403).json({
                success: false,
                error: "The Storefront is not available on your current plan. Kindly upgrade your plan.",
                code: "PLAN_UPGRADE_REQUIRED",
            });
        }
        if (plan?.max_store_products != null && plan.max_store_products < 999999) {
            const countRes = await query(`SELECT COUNT(*)::int AS c FROM store_products WHERE business_id = $1`, [businessId]);
            if (countRes.rows[0].c >= plan.max_store_products) {
                return res.status(403).json({
                    success: false,
                    error: `Your plan allows up to ${plan.max_store_products} storefront product(s). Kindly upgrade your plan for more.`,
                    code: "PLAN_UPGRADE_REQUIRED",
                });
            }
        }

        const created = await query(
            `INSERT INTO store_products (business_id, created_by, name, description, price, stock, image_url, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [businessId, userId, productName, description ? String(description).trim() : null, productPrice, stockValue,
             image_url ? String(image_url).trim() : null, validStatus]
        );
        res.json({ success: true, product: created.rows[0] });
    } catch (error) {
        console.error("Create store product error:", error);
        res.status(500).json({ success: false, error: "Failed to create product" });
    }
});

/**
 * @openapi
 * /store/products/{id}:
 *   put:
 *     summary: Update a storefront product
 *     tags: [Storefront]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated product
 */
router.put("/products/:id", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_store"), async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const { id } = req.params;
        const { name, description, price, stock, image_url, status } = req.body || {};

        const productPrice = price != null && price !== "" ? Math.round(Number(price) * 100) / 100 : null;
        if (productPrice != null && productPrice < 50) {
            return res.status(400).json({ success: false, error: "Price must be at least ₦50" });
        }
        const stockValue = stock == null || stock === "" ? null : Math.max(0, Math.floor(Number(stock)));
        const validStatus = ["active", "paused", "draft"].includes(status) ? status : null;

        const updated = await query(
            `UPDATE store_products SET
                name = COALESCE($2, name),
                description = COALESCE($3, description),
                price = COALESCE($4, price),
                stock = $5,
                image_url = COALESCE($6, image_url),
                status = COALESCE($7, status),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND business_id = $8 RETURNING *`,
            [id, name != null ? String(name).trim() : null, description != null ? String(description).trim() : null,
             productPrice, stockValue, image_url != null ? String(image_url).trim() : null, validStatus, businessId]
        );
        if (updated.rows.length === 0) return res.status(404).json({ success: false, error: "Product not found" });
        res.json({ success: true, product: updated.rows[0] });
    } catch (error) {
        console.error("Update store product error:", error);
        res.status(500).json({ success: false, error: "Failed to update product" });
    }
});

/**
 * @openapi
 * /store/products/{id}:
 *   delete:
 *     summary: Delete a storefront product
 *     tags: [Storefront]
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
 */
router.delete("/products/:id", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_store"), async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const { id } = req.params;
        const deleted = await query(`DELETE FROM store_products WHERE id = $1 AND business_id = $2 RETURNING id`, [id, businessId]);
        if (deleted.rows.length === 0) return res.status(404).json({ success: false, error: "Product not found" });
        res.json({ success: true, message: "Product deleted" });
    } catch (error) {
        console.error("Delete store product error:", error);
        res.status(500).json({ success: false, error: "Failed to delete product" });
    }
});

/**
 * @openapi
 * /store/orders:
 *   get:
 *     summary: List storefront orders + sales stats
 *     tags: [Storefront]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, paid, fulfilled, cancelled, all] }
 *     responses:
 *       200:
 *         description: Orders (with items) + stats
 */
router.get("/orders", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const status = String(req.query.status || "").trim();
        const params: unknown[] = [businessId];
        let where = `o.business_id = $1`;
        if (status && status !== "all") {
            params.push(status);
            where += ` AND o.status = $${params.length}`;
        }
        const orders = await query(
            `SELECT o.* FROM store_orders o WHERE ${where} ORDER BY o.created_at DESC LIMIT 200`,
            params
        );
        const items = await query(
            `SELECT i.* FROM store_order_items i
             JOIN store_orders o ON o.id = i.order_id
             WHERE o.business_id = $1`,
            [businessId]
        );
        const stats = await query(
            `SELECT COUNT(*)::int AS total_orders,
                    COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN 1 ELSE 0 END), 0)::int AS paid_orders,
                    COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending_orders,
                    COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN total ELSE 0 END), 0) AS gross_sales,
                    COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN fee ELSE 0 END), 0) AS total_fees,
                    COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN net_amount ELSE 0 END), 0) AS net_sales
             FROM store_orders WHERE business_id = $1`,
            [businessId]
        );
        const ordersWithItems = orders.rows.map((o: any) => ({
            ...o,
            items: items.rows.filter((i: any) => i.order_id === o.id),
        }));
        res.json({ success: true, orders: ordersWithItems, stats: stats.rows[0] });
    } catch (error) {
        console.error("List store orders error:", error);
        res.status(500).json({ success: false, error: "Failed to load orders" });
    }
});

/**
 * @openapi
 * /store/orders/{id}/fulfil:
 *   post:
 *     summary: Mark a paid order as fulfilled
 *     tags: [Storefront]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Fulfilled order
 *       400:
 *         description: Only paid orders can be fulfilled
 */
router.post("/orders/:id/fulfil", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_store"), async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const { id } = req.params;
        const updated = await query(
            `UPDATE store_orders SET status = 'fulfilled', fulfilled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND business_id = $2 AND status IN ('paid') RETURNING *`,
            [id, businessId]
        );
        if (updated.rows.length === 0) {
            return res.status(400).json({ success: false, error: "Only paid orders can be fulfilled" });
        }
        res.json({ success: true, order: updated.rows[0] });
    } catch (error) {
        console.error("Fulfil store order error:", error);
        res.status(500).json({ success: false, error: "Failed to fulfil order" });
    }
});

/**
 * @openapi
 * /store/orders/{id}/cancel:
 *   post:
 *     summary: Cancel an unpaid order
 *     tags: [Storefront]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cancelled order
 *       400:
 *         description: Only unpaid orders can be cancelled
 */
router.post("/orders/:id/cancel", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_store"), async (req: AuthenticatedRequest, res) => {
    try {
        const { businessId } = req.user!;
        const { id } = req.params;
        const updated = await query(
            `UPDATE store_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND business_id = $2 AND status = 'pending' RETURNING *`,
            [id, businessId]
        );
        if (updated.rows.length === 0) {
            return res.status(400).json({ success: false, error: "Only unpaid orders can be cancelled" });
        }
        res.json({ success: true, order: updated.rows[0] });
    } catch (error) {
        console.error("Cancel store order error:", error);
        res.status(500).json({ success: false, error: "Failed to cancel order" });
    }
});

// ---------------------------------------------------------------------------
// Public endpoints (no auth — customers browsing the storefront)
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /store/public/{businessId}:
 *   get:
 *     summary: Public storefront view (business profile + active products)
 *     tags: [Storefront]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Storefront payload
 *       404:
 *         description: Storefront not found
 */
router.get("/public/:businessId", async (req, res) => {
    try {
        const { businessId } = req.params;
        const bizRes = await query(
            `SELECT b.id, b.name, b.logo_url, b.description,
                    p.store_enabled,
                    CASE WHEN p.store_enabled = FALSE THEN TRUE ELSE FALSE END AS store_disabled
             FROM businesses b
             LEFT JOIN pricing_plans p ON p.id = b.plan_id
             WHERE b.id = $1`,
            [businessId]
        );
        const business = bizRes.rows[0];
        if (!business || business.store_disabled) {
            return res.status(404).json({ success: false, error: "Storefront not found" });
        }
        const products = await query(
            `SELECT id, name, description, price, currency, stock, image_url
             FROM store_products
             WHERE business_id = $1 AND status = 'active'
             ORDER BY created_at DESC`,
            [businessId]
        );
        res.json({
            success: true,
            store: { business_id: business.id, name: business.name, logo_url: business.logo_url || null, description: business.description || null },
            products: products.rows.map((p: any) => ({
                ...p,
                price: Number(p.price),
                sold_out: p.stock != null && Number(p.stock) <= 0,
            })),
        });
    } catch (error) {
        console.error("Public storefront error:", error);
        res.status(500).json({ success: false, error: "Failed to load storefront" });
    }
});

/**
 * @openapi
 * /store/public/{businessId}/checkout:
 *   post:
 *     summary: Place an order and start payment (returns hosted checkout URL, settled by webhook)
 *     tags: [Storefront]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customer_name, items]
 *             properties:
 *               customer_name: { type: string }
 *               customer_email: { type: string }
 *               customer_phone: { type: string }
 *               note: { type: string }
 *               provider: { type: string, description: "Optional provider override" }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [product_id, quantity]
 *                   properties:
 *                     product_id: { type: string, format: uuid }
 *                     quantity: { type: integer, minimum: 1, maximum: 999 }
 *     responses:
 *       200:
 *         description: checkout_url + order reference
 *       400:
 *         description: Invalid items / sold out / checkout failed
 */
router.post("/public/:businessId/checkout", async (req, res) => {
    try {
        const { businessId } = req.params;
        const { customer_name, customer_email, customer_phone, note, provider: requestedProvider, items } = req.body || {};

        const bizRes = await query(
            `SELECT b.id, b.name, p.store_enabled FROM businesses b
             LEFT JOIN pricing_plans p ON p.id = b.plan_id WHERE b.id = $1`,
            [businessId]
        );
        const business = bizRes.rows[0];
        if (!business || business.store_enabled === false) {
            return res.status(404).json({ success: false, error: "Storefront not found" });
        }

        const customerName = String(customer_name || "").trim();
        if (!customerName) return res.status(400).json({ success: false, error: "Your name is required" });
        const email = String(customer_email || "").trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, error: "A valid email is required for your receipt" });
        }

        if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
            return res.status(400).json({ success: false, error: "Add at least one item to your order" });
        }

        // Resolve items against live product rows (prices always come from the DB)
        const resolved: { product_id: string; product_name: string; quantity: number; unit_price: number; amount: number }[] = [];
        for (const item of items) {
            const productId = String(item?.product_id || "");
            const quantity = Math.floor(Number(item?.quantity) || 0);
            if (!productId || quantity < 1 || quantity > 999) {
                return res.status(400).json({ success: false, error: "Invalid item quantity" });
            }
            const prodRes = await query(
                `SELECT id, name, price, stock FROM store_products
                 WHERE id = $1 AND business_id = $2 AND status = 'active'`,
                [productId, businessId]
            );
            const product = prodRes.rows[0];
            if (!product) return res.status(400).json({ success: false, error: "One of the items is no longer available" });
            if (product.stock != null && Number(product.stock) < quantity) {
                return res.status(400).json({ success: false, error: `${product.name} has only ${Number(product.stock)} left in stock` });
            }
            const unitPrice = Number(product.price);
            resolved.push({ product_id: product.id, product_name: product.name, quantity, unit_price: unitPrice, amount: Math.round(unitPrice * quantity * 100) / 100 });
        }

        const subtotal = Math.round(resolved.reduce((sum, i) => sum + i.amount, 0) * 100) / 100;
        if (subtotal < 50) return res.status(400).json({ success: false, error: "Order total must be at least ₦50" });

        // Settlement wallet (NGN first)
        const walletRes = await query(
            `SELECT id FROM wallets WHERE business_id = $1 ORDER BY (currency = 'NGN') DESC LIMIT 1`,
            [businessId]
        );
        if (walletRes.rows.length === 0) {
            return res.status(400).json({ success: false, error: "This store cannot accept payments right now. Please contact the merchant." });
        }

        const currency = "NGN";
        const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        const reference = `STOR-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

        // Pending order + items + pending ledger rows — the webhook settles all
        const orderRes = await query(
            `INSERT INTO store_orders
             (business_id, order_number, checkout_reference, customer_name, customer_email, customer_phone,
              subtotal, total, currency, status, note, payment_provider)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'pending', $9, $10) RETURNING id`,
            [businessId, orderNumber, reference, customerName, email, customer_phone ? String(customer_phone).trim() : null,
             subtotal, currency, note ? String(note).trim() : null, requestedProvider || null]
        );
        const orderId = orderRes.rows[0].id;
        for (const item of resolved) {
            await query(
                `INSERT INTO store_order_items (order_id, product_id, product_name, quantity, unit_price, amount)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [orderId, item.product_id, item.product_name, item.quantity, item.unit_price, item.amount]
            );
        }
        await query(
            `INSERT INTO transactions (business_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, payment_provider)
             VALUES ($1, $2, $3, $4, 'pending', 'credit', $5, 'store_order', $6, $7)`,
            [businessId, subtotal, currency, reference, `Store order ${orderNumber} — ${customerName}`, walletRes.rows[0].id, requestedProvider || null]
        );

        // Hosted checkout via the active payment provider (amount in kobo/minor unit)
        const providerName = requestedProvider || await getActiveProviderName();
        const provider = getProvider(providerName);
        const origin = req.get('origin') || process.env.APP_BASE_URL || 'https://app.metricorex.com';
        const baseUrl = String(origin).endsWith('/') ? String(origin).slice(0, -1) : String(origin);
        const callbackUrl = `${baseUrl}/store/order/${reference}`;

        let paymentResponse: any;
        try {
            paymentResponse = await provider.initiatePayment({
                email,
                amount: Math.round(subtotal * 100),
                reference,
                callbackUrl,
                currency,
            });
        } catch (providerError: any) {
            console.error("Store checkout provider initiation failed:", providerError?.message);
            await query(`UPDATE store_orders SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [orderId]);
            await query(`UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE reference = $1`, [reference]);
            return res.status(502).json({ success: false, error: "Could not start the payment. Please try again." });
        }

        const checkoutUrl = paymentResponse?.data?.checkout_url || paymentResponse?.data?.link || paymentResponse?.checkout_url;
        if (!checkoutUrl) {
            await query(`UPDATE store_orders SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [orderId]);
            await query(`UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE reference = $1`, [reference]);
            return res.status(502).json({ success: false, error: "Payment provider did not return a checkout URL" });
        }

        res.json({ success: true, checkout_url: checkoutUrl, reference, order_number: orderNumber, amount: subtotal, currency });
    } catch (error) {
        console.error("Store checkout error:", error);
        res.status(500).json({ success: false, error: "Failed to place order" });
    }
});

/**
 * @openapi
 * /store/public/order/{reference}:
 *   get:
 *     summary: Public order status (checkout landing page polls this)
 *     tags: [Storefront]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Order summary + status
 *       404:
 *         description: Order not found
 */
router.get("/public/order/:reference", async (req, res) => {
    try {
        const { reference } = req.params;
        const orderRes = await query(
            `SELECT o.order_number, o.customer_name, o.subtotal, o.total, o.currency, o.status, o.created_at,
                    b.name AS business_name
             FROM store_orders o LEFT JOIN businesses b ON b.id = o.business_id
             WHERE o.checkout_reference = $1`,
            [reference]
        );
        const order = orderRes.rows[0];
        if (!order) return res.status(404).json({ success: false, error: "Order not found" });
        const items = await query(
            `SELECT product_name, quantity, unit_price, amount FROM store_order_items i
             JOIN store_orders o ON o.id = i.order_id WHERE o.checkout_reference = $1`,
            [reference]
        );
        res.json({ success: true, order: { ...order, subtotal: Number(order.subtotal), total: Number(order.total) }, items: items.rows });
    } catch (error) {
        console.error("Public order status error:", error);
        res.status(500).json({ success: false, error: "Failed to load order" });
    }
});

// ---------------------------------------------------------------------------
// Webhook settlement — called by server/routes/webhook.ts when a charge with
// transaction_type 'store_order' succeeds. Idempotent: the order flips
// pending → paid exactly once.
// ---------------------------------------------------------------------------

export async function settleStoreOrderPayment(reference: string, providerName: string): Promise<void> {
    const orderRes = await query(
        `SELECT * FROM store_orders WHERE checkout_reference = $1 AND status = 'pending'`,
        [reference]
    );
    const order = orderRes.rows[0];
    if (!order) return; // already settled or unknown — nothing to do

    const gross = Number(order.total);
    const currency = order.currency || 'NGN';

    // Order fee: base config, reduced by the merchant's plan discount
    const baseFee = await calculateFee(gross, 'store_order');
    const plan = await getPlanConfig(order.business_id);
    const fee = effectiveFee(baseFee, Number(plan?.store_fee_discount_percent) || 0);
    const net = Math.max(0, gross - fee);

    // Business settlement wallet (NGN first)
    const walletRes = await query(
        `SELECT id FROM wallets WHERE business_id = $1 ORDER BY (currency = 'NGN') DESC LIMIT 1`,
        [order.business_id]
    );
    if (walletRes.rows.length === 0) {
        console.error(`settleStoreOrderPayment: no settlement wallet for business ${order.business_id} (ref ${reference})`);
        return;
    }
    const walletId = walletRes.rows[0].id;

    // Flip the order FIRST (idempotency gate), then move the money.
    await query(
        `UPDATE store_orders
         SET status = 'paid', fee = $2, net_amount = $3, payment_provider = $4, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [order.id, fee, net, providerName]
    );

    await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [net, walletId]);
    await query(
        `UPDATE transactions SET status = 'success', fee = $2, updated_at = CURRENT_TIMESTAMP WHERE reference = $1`,
        [reference, fee]
    );
    await query(
        `INSERT INTO transactions
         (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider)
         VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'store_order', $6, 'credit', $7, $8)
         ON CONFLICT (reference) DO NOTHING`,
        [order.business_id, net, currency, `${reference}-SETTLED`, `Store order ${order.order_number} received (net of ${fee} ${currency} fee)`, walletId, fee, providerName]
    );

    // Decrement stock for limited-stock products
    await query(
        `UPDATE store_products p SET stock = GREATEST(p.stock - i.quantity, 0), updated_at = CURRENT_TIMESTAMP
         FROM store_order_items i
         WHERE i.order_id = $1 AND p.id = i.product_id AND p.stock IS NOT NULL`,
        [order.id]
    );

    // Double-entry platform ledger: gross in, net out, fee to revenue
    await creditPlatformWallet(gross, currency, reference, 'Storefront Order Payment Received', providerName);
    await debitPlatformWallet(net, currency, `${reference}-MERCHANT`, 'Platform Wallet Debit for Store Order Settlement', providerName);
    if (fee > 0) {
        await creditRevenueWallet(fee, currency, reference, 'Storefront Order Fee', providerName);
    }

    // Notify the merchant
    try {
        await createNotification({
            businessId: order.business_id,
            userId: null,
            type: "credit",
            title: "New Paid Order",
            message: `Order ${order.order_number} from ${order.customer_name}: +${net.toLocaleString()} ${currency}${fee > 0 ? ` (fee: ${fee} ${currency})` : ''}`,
            actionUrl: "/store",
            actionType: "view_order",
            metadata: { reference, orderNumber: order.order_number, amount: gross, fee, net },
            isActionable: false,
            expiresInHours: 72,
        });
    } catch (notifErr) {
        console.error("Store order notification failed:", notifErr);
    }
}

export default router;
