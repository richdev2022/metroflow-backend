import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  verifyTransactionPin, assertPersonalService, genRef, requirePersonalKyc,
} from "../personal-utils";
import { calculateFee, creditRevenueWallet } from "../../../services/fees";
import { uploadMediaBuffer } from "../../../services/media-upload";
import { upload } from "../../../middleware/upload";
import { createNotification } from "../../../services/notifications";
import { getBoostPricing, estimateReach, getActiveBoostMap } from "./social";

/**
 * MARKETPLACE — Facebook-Marketplace-style buying + selling (mounted at
 * /store/marketplace to keep the personal-web contract).
 *
 *   GET    /store/marketplace?q=&category=&cursor=&limit=   → boosted-ranked wall
 *   GET    /store/marketplace/categories                    → sidebar counts
 *   POST   /store/marketplace                (multipart images 1..10) → create listing
 *   GET    /store/marketplace/mine           → my listings (+stats)
 *   GET    /store/marketplace/:id            → detail (view counted)
 *   PUT    /store/marketplace/:id            → edit own listing
 *   DELETE /store/marketplace/:id            → remove own listing
 *   POST   /store/marketplace/:id/save | DELETE /store/marketplace/:id/save
 *   GET    /store/marketplace/saves          → my saved listings
 *   POST   /store/marketplace/:id/buy        { quantity?, delivery_address?, delivery_phone?, pin, wallet_id }
 *   GET    /store/marketplace/orders         → my purchases
 *   GET    /store/marketplace/sales          → my sales
 *   POST   /store/marketplace/orders/:id/confirm  → seller ships / buyer confirms receipt
 *   POST   /store/marketplace/orders/:id/cancel   → cancel (refund buyer if paid)
 *   POST   /store/marketplace/:id/boost      { budget, duration_days, audience?, pin, wallet_id }
 *
 * BUY FLOW (escrow-lite): buyer pays (unit×qty + fee) → order 'paid' → seller
 * delivers → buyer confirms → seller wallet credited (unit×qty minus platform
 * fee share) → order 'completed'. Admin can refund at any point.
 */

const router = express.Router();

export const MARKET_CATEGORIES = [
  "electronics", "phones_tablets", "fashion", "home_kitchen", "beauty",
  "health", "sports", "toys_games", "automotive", "property", "services", "other",
];

function mapListingRow(l: any, boost?: any, saved = false) {
  return {
    id: l.id,
    name: l.name,
    description: l.description,
    category: l.category,
    condition: l.condition,
    price: Number(l.price),
    currency: l.currency,
    negotiable: l.negotiable,
    location_text: l.location_text,
    stock: l.stock === null ? null : Number(l.stock),
    brand: l.brand || null,
    model: l.model || null,
    warranty_note: l.warranty_note || null,
    pickup_ok: l.pickup_ok !== false,
    delivery_ok: l.delivery_ok === true,
    delivery_fee: l.delivery_fee != null ? Number(l.delivery_fee) : 0,
    image_url: (l.images || [])[0] || null,
    images: l.images || [],
    sold_out: l.status === "sold" || (l.stock !== null && Number(l.stock) <= 0),
    status: l.status,
    view_count: Number(l.view_count) || 0,
    save_count: Number(l.save_count) || 0,
    boosted: !!boost,
    boost_ends_at: boost?.ends_at ?? null,
    saved,
    seller: { id: l.seller_id, name: l.seller_name, photo: l.seller_photo, logo_url: l.seller_photo },
    created_at: l.created_at,
  };
}

// ---------------------------------------------------------------------------
// Wall
// ---------------------------------------------------------------------------
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "marketplace"))) return;
    const userId = req.user!.userId;
    const limit = Math.min(40, Math.max(1, Number(req.query.limit) || 24));
    const cursor = req.query.cursor ? new Date(String(req.query.cursor)) : null;
    const q = String(req.query.q || "").trim();
    const category = String(req.query.category || "").trim();

    const params: any[] = [userId, limit + 1];
    let where = `l.status = 'active'`;
    let idx = 3;
    if (q) { params.push(`%${q}%`); where += ` AND (l.name ILIKE $${idx} OR l.description ILIKE $${idx})`; idx++; }
    if (category && MARKET_CATEGORIES.includes(category)) { params.push(category); where += ` AND l.category = $${idx++}`; }
    if (cursor && !isNaN(cursor.getTime())) { params.push(cursor.toISOString()); where += ` AND l.created_at < $${idx++}`; }

    const r = await query(
      `SELECT l.*, u.name AS seller_name, u.avatar_url AS seller_photo,
              EXISTS(SELECT 1 FROM market_saves s WHERE s.listing_id = l.id AND s.user_id = $1) AS saved_by_me
       FROM market_listings l JOIN users u ON u.id = l.seller_id
       WHERE ${where}
       ORDER BY l.created_at DESC
       LIMIT $2`,
      params,
    );

    const rows = r.rows.slice(0, limit);
    const boosts = await getActiveBoostMap("listing", rows.map((x) => x.id));

    // Boost-aware ranking inside the page: boosted first (by remaining reach),
    // then newest. (Full-relevance scoring lives in the boost engine.)
    const ranked = [...rows].sort((a, b) => {
      const ba = boosts.get(a.id), bb = boosts.get(b.id);
      if (!!ba !== !!bb) return ba ? -1 : 1;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    for (const row of ranked) {
      if (boosts.has(row.id)) {
        await query(
          `UPDATE boost_orders SET impressions = impressions + 1, updated_at = CURRENT_TIMESTAMP
           WHERE target_type = 'listing' AND target_id = $1 AND status = 'active' AND ends_at > NOW()`,
          [row.id],
        );
      }
    }

    res.json({
      success: true,
      data: {
        products: ranked.map((l) => mapListingRow(l, boosts.get(l.id), l.saved_by_me)),
        next_cursor: r.rows.length > limit ? ranked[ranked.length - 1]?.created_at : null,
        categories: MARKET_CATEGORIES,
      },
      products: ranked.map((l) => mapListingRow(l, boosts.get(l.id), l.saved_by_me)),
    });
  } catch (e: any) {
    console.error("marketplace wall error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load marketplace" });
  }
});

router.get("/categories", authenticateToken, async (_req, res) => {
  try {
    const r = await query(
      `SELECT category, COUNT(*)::int AS n FROM market_listings WHERE status = 'active' GROUP BY category`,
    );
    res.json({ success: true, data: { categories: MARKET_CATEGORIES, counts: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load categories" });
  }
});

// ---------------------------------------------------------------------------
// Create / mine / detail / edit / delete
// ---------------------------------------------------------------------------
// Multer field contract: the WEB historically sends files under "media" and
// the personal MOBILE app under "images". Upload.array("images") rejects the
// other name with LIMIT_UNEXPECTED_FILE ("Unexpected file field" — Sentry
// aea8b1cb, POST /api/store/marketplace), which surfaced as a generic
// "Internet service error" in the mobile sell sheet. Accept BOTH names (10
// files each) and merge below.
const marketUpload = upload.fields([
  { name: "images", maxCount: 10 },
  { name: "media", maxCount: 10 },
]);

router.post("/", authenticateToken, checkSubscriptionStatus, marketUpload, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "marketplace"))) return;
    const userId = req.user!.userId;
    const name = String(req.body?.name || "").trim();
    const description = req.body?.description ? String(req.body.description).slice(0, 4000) : null;
    const category = MARKET_CATEGORIES.includes(String(req.body?.category)) ? String(req.body.category) : "other";
    const condition = ["new", "like_new", "used_good", "used_fair"].includes(String(req.body?.condition)) ? String(req.body.condition) : "used_good";
    const price = Math.round(Number(req.body?.price) * 100) / 100;
    const currency = ["NGN", "USD"].includes(String(req.body?.currency)) ? String(req.body.currency) : "NGN";
    const negotiable = String(req.body?.negotiable ?? "true") !== "false";
    const locationText = req.body?.location_text ? String(req.body.location_text).slice(0, 160) : null;
    const stockRaw = req.body?.stock;
    const stock = stockRaw === "" || stockRaw === undefined || stockRaw === null ? null : Math.max(0, Number(stockRaw));
    // Richer item details (buyer-facing).
    const brand = req.body?.brand ? String(req.body.brand).slice(0, 80) : null;
    const model = req.body?.model ? String(req.body.model).slice(0, 80) : null;
    const warrantyNote = req.body?.warranty_note ? String(req.body.warranty_note).slice(0, 200) : null;
    const pickupOk = String(req.body?.pickup_ok ?? "true") !== "false";
    const deliveryOk = String(req.body?.delivery_ok ?? "false") === "true";
    const deliveryFeeRaw = Number(req.body?.delivery_fee);
    const deliveryFee = Number.isFinite(deliveryFeeRaw) && deliveryFeeRaw > 0 ? Math.round(deliveryFeeRaw * 100) / 100 : 0;

    if (!name) return res.status(400).json({ success: false, error: "Give your item a name" });
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ success: false, error: "Set a valid price" });
    if (price > 100000000) return res.status(400).json({ success: false, error: "Price too high" });

    // upload.fields() yields an OBJECT keyed by field name; the legacy
    // .array() shape was a flat array. Normalize both here.
    const rawFiles = req.files as
      | unknown
      | { [field: string]: Express.Multer.File[] };
    const files: Express.Multer.File[] = Array.isArray(rawFiles)
      ? (rawFiles as Express.Multer.File[])
      : [
          ...((rawFiles as { [field: string]: Express.Multer.File[] })
            ?.images ?? []),
          ...((rawFiles as { [field: string]: Express.Multer.File[] })
            ?.media ?? []),
        ];
    const images: string[] = [];
    for (const f of files.slice(0, 10)) {
      try {
        const up = await uploadMediaBuffer({ buffer: f.buffer, originalname: f.originalname, mimeType: f.mimetype, folder: "marketplace", userId });
        if (up?.url) images.push(up.url);
      } catch (e: any) {
        console.warn("marketplace image upload failed:", e?.message);
      }
    }

    const r = await query(
      `INSERT INTO market_listings
         (seller_id, name, description, category, condition, price, currency, negotiable,
          location_text, stock, images, brand, model, warranty_note, pickup_ok, delivery_ok, delivery_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [userId, name, description, category, condition, price, currency, negotiable, locationText, stock, JSON.stringify(images),
       brand, model, warrantyNote, pickupOk, deliveryOk, deliveryFee],
    );
    res.status(201).json({ success: true, data: { listing: mapListingRow({ ...r.rows[0], seller_name: req.user!.name, seller_photo: null }) } });
  } catch (e: any) {
    console.error("marketplace create error:", e?.message);
    res.status(500).json({ success: false, error: "Could not create listing" });
  }
});

router.get("/mine", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `SELECT l.*, NULL::text AS seller_name, NULL::text AS seller_photo
       FROM market_listings l WHERE l.seller_id = $1 ORDER BY l.created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    const stats = await query(
      `SELECT COUNT(*)::int AS listings,
              COALESCE(SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END), 0)::int AS sold
       FROM market_listings WHERE seller_id = $1`,
      [req.user!.userId],
    );
    res.json({ success: true, data: { listings: r.rows.map((l) => mapListingRow(l)), stats: stats.rows[0] } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load your listings" });
  }
});

router.get("/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `SELECT l.*, u.name AS seller_name, u.avatar_url AS seller_photo
       FROM market_listings l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`,
      [req.params.id],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Listing not found" });
    const row = r.rows[0];
    const mine = row.seller_id === req.user!.userId;
    if (!mine && row.status === "removed") return res.status(404).json({ success: false, error: "Listing not found" });
    if (!mine) await query(`UPDATE market_listings SET view_count = view_count + 1 WHERE id = $1`, [row.id]);
    const saved = await query(`SELECT 1 FROM market_saves WHERE listing_id = $1 AND user_id = $2`, [row.id, req.user!.userId]);
    const boosts = await getActiveBoostMap("listing", [row.id]);
    res.json({ success: true, data: { listing: mapListingRow(row, boosts.get(row.id), !!saved.rows.length) } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load listing" });
  }
});

router.put("/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const own = await query(`SELECT id FROM market_listings WHERE id = $1 AND seller_id = $2`, [req.params.id, req.user!.userId]);
    if (!own.rows.length) return res.status(404).json({ success: false, error: "Listing not found (or not yours)" });
    const b = req.body || {};
    const deliveryFeeNum = Number(b.delivery_fee);
    await query(
      `UPDATE market_listings SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         category = COALESCE($4, category),
         price = COALESCE($5, price),
         location_text = COALESCE($6, location_text),
         stock = COALESCE($7, stock),
         status = COALESCE($8, status),
         brand = COALESCE($9, brand),
         model = COALESCE($10, model),
         warranty_note = COALESCE($11, warranty_note),
         pickup_ok = COALESCE($12, pickup_ok),
         delivery_ok = COALESCE($13, delivery_ok),
         delivery_fee = COALESCE($14, delivery_fee),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        req.params.id,
        b.name ? String(b.name).slice(0, 160) : null,
        b.description !== undefined ? (b.description ? String(b.description).slice(0, 4000) : null) : null,
        MARKET_CATEGORIES.includes(b.category) ? b.category : null,
        Number.isFinite(Number(b.price)) && Number(b.price) > 0 ? Number(b.price) : null,
        b.location_text !== undefined ? (b.location_text ? String(b.location_text).slice(0, 160) : null) : null,
        b.stock !== undefined && b.stock !== null && b.stock !== "" ? Math.max(0, Number(b.stock)) : null,
        ["active", "sold"].includes(b.status) ? b.status : null,
        b.brand ? String(b.brand).slice(0, 80) : null,
        b.model ? String(b.model).slice(0, 80) : null,
        b.warranty_note ? String(b.warranty_note).slice(0, 200) : null,
        typeof b.pickup_ok === "boolean" ? b.pickup_ok : (b.pickup_ok === "true" ? true : b.pickup_ok === "false" ? false : null),
        typeof b.delivery_ok === "boolean" ? b.delivery_ok : (b.delivery_ok === "true" ? true : b.delivery_ok === "false" ? false : null),
        Number.isFinite(deliveryFeeNum) && deliveryFeeNum >= 0 ? Math.round(deliveryFeeNum * 100) / 100 : null,
      ],
    );
    res.json({ success: true, message: "Listing updated" });
  } catch {
    res.status(500).json({ success: false, error: "Could not update listing" });
  }
});

router.delete("/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `DELETE FROM market_listings WHERE id = $1 AND seller_id = $2 RETURNING id`,
      [req.params.id, req.user!.userId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Listing not found (or not yours)" });
    res.json({ success: true, message: "Listing removed" });
  } catch {
    res.status(500).json({ success: false, error: "Could not remove listing" });
  }
});

// ---------------------------------------------------------------------------
// Saves
// ---------------------------------------------------------------------------
router.post("/:id/save", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `INSERT INTO market_saves (listing_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`,
      [req.params.id, req.user!.userId],
    );
    if (r.rows.length) await query(`UPDATE market_listings SET save_count = save_count + 1 WHERE id = $1`, [req.params.id]);
    res.json({ success: true, data: { saved: true } });
  } catch {
    res.status(500).json({ success: false, error: "Could not save listing" });
  }
});

router.delete("/:id/save", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `DELETE FROM market_saves WHERE listing_id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user!.userId],
    );
    if (r.rows.length) await query(`UPDATE market_listings SET save_count = GREATEST(0, save_count - 1) WHERE id = $1`, [req.params.id]);
    res.json({ success: true, data: { saved: false } });
  } catch {
    res.status(500).json({ success: false, error: "Could not unsave listing" });
  }
});

router.get("/saves/all", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `SELECT l.*, u.name AS seller_name, u.avatar_url AS seller_photo, TRUE AS saved_by_me
       FROM market_saves s
       JOIN market_listings l ON l.id = s.listing_id
       JOIN users u ON u.id = l.seller_id
       WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    res.json({ success: true, data: { listings: r.rows.map((l) => mapListingRow(l)) } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load saved listings" });
  }
});

// ---------------------------------------------------------------------------
// Buy (escrow-lite)
// ---------------------------------------------------------------------------
router.post("/:id/buy", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { pin, wallet_id, delivery_address, delivery_phone } = req.body || {};
    const listing = await query(`SELECT * FROM market_listings WHERE id = $1`, [req.params.id]);
    const l = listing.rows[0];
    if (!l || l.status !== "active") return res.status(404).json({ success: false, error: "Listing is no longer available" });
    if (l.seller_id === userId) return res.status(400).json({ success: false, error: "You can't buy your own listing" });
    const quantity = Math.max(1, Number(req.body?.quantity) || 1);
    if (l.stock !== null && quantity > Number(l.stock)) {
      return res.status(400).json({ success: false, error: `Only ${l.stock} left in stock` });
    }
    const wallet = await getOwnedWallet(String(wallet_id || ""), userId, req.user!.businessId ?? null);
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
    if (wallet.currency !== l.currency) {
      return res.status(400).json({ success: false, error: `This listing is priced in ${l.currency} — pay from your ${l.currency} wallet` });
    }
    const pinCheck = await verifyTransactionPin(pin, { userId, businessId: req.user!.businessId ?? null, wallet });
    if (!pinCheck.ok) return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });

    const fee = await calculateFee(Number(l.price) * quantity, "marketplace");
    const total = Math.round((Number(l.price) * quantity + fee) * 100) / 100;
    const reference = genRef("MF-MKT");
    if (!(await debitWallet(wallet.id, total))) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: "Insufficient wallet balance" });
    }
    await insertTransaction({
      userId, businessId: wallet.business_id, walletId: wallet.id, reference,
      type: "debit", transactionType: "market_order", amount: total, currency: wallet.currency,
      fee, description: `Marketplace purchase — ${l.name}${quantity > 1 ? ` ×${quantity}` : ""}`,
    });
    const r = await query(
      `INSERT INTO market_orders
         (reference, listing_id, buyer_id, seller_id, wallet_id, quantity, unit_price, fee, total, currency,
          delivery_address, delivery_phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'paid') RETURNING *`,
      [reference, l.id, userId, l.seller_id, wallet.id, quantity, l.price, fee, total, l.currency,
       delivery_address ? String(delivery_address).slice(0, 500) : null,
       delivery_phone ? String(delivery_phone).slice(0, 50) : null],
    );
    if (l.stock !== null) {
      await query(
        `UPDATE market_listings SET stock = GREATEST(0, stock - $2),
         status = CASE WHEN stock - $2 <= 0 THEN 'sold' ELSE status END WHERE id = $1`,
        [l.id, quantity],
      );
    }
    createNotification({
      businessId: (req.user!.businessId ?? "") as string,
      userId: l.seller_id,
      title: "New sale!",
      message: `Your listing "${l.name}" was purchased. Ship it and confirm the order to get paid.`,
      type: "marketplace",
    }).catch(() => {});
    res.status(201).json({ success: true, data: { order: r.rows[0], listing: { id: l.id, name: l.name } } });
  } catch (e: any) {
    console.error("marketplace buy error:", e?.message);
    res.status(500).json({ success: false, error: "Could not complete purchase" });
  }
});

router.get("/orders/mine", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `SELECT o.*, l.name AS listing_name, l.images AS listing_images, u.name AS seller_name
       FROM market_orders o
       JOIN market_listings l ON l.id = o.listing_id
       JOIN users u ON u.id = o.seller_id
       WHERE o.buyer_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    res.json({ success: true, data: { orders: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load orders" });
  }
});

router.get("/sales/mine", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `SELECT o.*, l.name AS listing_name, l.images AS listing_images, u.name AS buyer_name
       FROM market_orders o
       JOIN market_listings l ON l.id = o.listing_id
       JOIN users u ON u.id = o.buyer_id
       WHERE o.seller_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    res.json({ success: true, data: { sales: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load sales" });
  }
});

router.post("/orders/:id/confirm", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const o = await query(`SELECT * FROM market_orders WHERE id = $1`, [req.params.id]);
    const order = o.rows[0];
    if (!order) return res.status(404).json({ success: false, error: "Order not found" });

    const isBuyer = order.buyer_id === userId;
    const isSeller = order.seller_id === userId;
    if (!isBuyer && !isSeller) return res.status(403).json({ success: false, error: "Not your order" });

    // Seller confirms dispatch (paid → shipped); buyer confirms receipt (shipped|paid → completed + payout).
    if (isSeller && order.status === "paid") {
      await query(`UPDATE market_orders SET status = 'shipped', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [order.id]);
      createNotification({ businessId: "", userId: order.buyer_id, title: "Your order is on the way", message: `Order ${order.reference} was marked shipped by the seller.`, type: "marketplace" }).catch(() => {});
      return res.json({ success: true, data: { status: "shipped" }, message: "Marked as shipped — the buyer will confirm receipt to release payment." });
    }
    if (isBuyer && (order.status === "shipped" || order.status === "paid")) {
      // Release funds to the seller: unit×qty (platform keeps the buyer-side fee).
      const payout = Math.round(Number(order.unit_price) * order.quantity * 100) / 100;
      const sellerWallet = await query(
        `SELECT id FROM wallets WHERE user_id = $1 AND business_id IS NULL AND currency = $2 AND status = 'active'
         ORDER BY CASE WHEN currency = 'NGN' THEN 0 ELSE 1 END LIMIT 1`,
        [order.seller_id, order.currency],
      );
      let credited = false;
      if (sellerWallet.rows.length) {
        await creditWallet(sellerWallet.rows[0].id, payout);
        await insertTransaction({
          userId: order.seller_id, walletId: sellerWallet.rows[0].id,
          reference: `${order.reference}-PAYOUT`, type: "credit", transactionType: "market_payout",
          amount: payout, currency: order.currency, description: `Marketplace sale payout — order ${order.reference}`,
        });
        credited = true;
      }
      await query(
        `UPDATE market_orders SET status = 'completed', payment_released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [order.id],
      );
      if (credited) {
        createNotification({ businessId: "", userId: order.seller_id, title: "Payment released", message: `₦${payout.toLocaleString()} for order ${order.reference} has been credited to your wallet.`, type: "marketplace" }).catch(() => {});
      }
      return res.json({ success: true, data: { status: "completed", credited }, message: credited ? "Order completed — seller paid." : "Order completed. Seller has no active wallet yet — support will settle manually." });
    }
    return res.status(400).json({ success: false, error: `Cannot confirm an order in status '${order.status}'` });
  } catch (e: any) {
    console.error("order confirm error:", e?.message);
    res.status(500).json({ success: false, error: "Could not confirm order" });
  }
});

router.post("/orders/:id/cancel", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const o = await query(`SELECT * FROM market_orders WHERE id = $1`, [req.params.id]);
    const order = o.rows[0];
    if (!order) return res.status(404).json({ success: false, error: "Order not found" });
    const isBuyer = order.buyer_id === userId;
    const isSeller = order.seller_id === userId;
    if (!isBuyer && !isSeller) return res.status(403).json({ success: false, error: "Not your order" });
    if (!["paid", "shipped"].includes(order.status)) {
      return res.status(400).json({ success: false, error: `Cannot cancel an order in status '${order.status}'` });
    }
    // Refund the buyer in full (fee included) — escrow not yet released.
    const refund = await creditWallet(order.wallet_id, Number(order.total));
    void refund;
    await insertTransaction({
      userId: order.buyer_id, walletId: order.wallet_id,
      reference: `${order.reference}-REFUND`, type: "credit", transactionType: "market_refund",
      amount: order.total, currency: order.currency, description: `Refund for cancelled order ${order.reference}`,
    });
    await query(
      `UPDATE market_orders SET status = 'refunded', cancelled_reason = $2, refunded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [order.id, String(req.body?.reason || (isBuyer ? "Cancelled by buyer" : "Cancelled by seller")).slice(0, 300)],
    );
    // Restore stock
    const l = await query(`SELECT stock FROM market_listings WHERE id = $1`, [order.listing_id]);
    if (l.rows[0]?.stock !== null) {
      await query(`UPDATE market_listings SET stock = stock + $2, status = CASE WHEN status = 'sold' AND stock + $2 > 0 THEN 'active' ELSE status END WHERE id = $1`, [order.listing_id, order.quantity]);
    }
    createNotification({ businessId: "", userId: isBuyer ? order.seller_id : order.buyer_id, title: "Order cancelled", message: `Order ${order.reference} was cancelled${isBuyer ? " by the buyer" : " by the seller"}. The buyer has been refunded.`, type: "marketplace" }).catch(() => {});
    res.json({ success: true, data: { status: "refunded" }, message: "Order cancelled — buyer refunded." });
  } catch (e: any) {
    console.error("order cancel error:", e?.message);
    res.status(500).json({ success: false, error: "Could not cancel order" });
  }
});

// ---------------------------------------------------------------------------
// Listing boost (same engine as posts)
// ---------------------------------------------------------------------------
router.post("/:id/boost", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { budget, duration_days, audience, pin, wallet_id } = req.body || {};
    const listing = await query(`SELECT id, seller_id FROM market_listings WHERE id = $1`, [req.params.id]);
    const l = listing.rows[0];
    if (!l) return res.status(404).json({ success: false, error: "Listing not found" });
    if (l.seller_id !== userId) return res.status(403).json({ success: false, error: "You can only boost your own listings" });
    const pricing = await getBoostPricing();
    const cfg = pricing.listing;
    const budgetN = Math.round(Number(budget));
    const days = Number(duration_days);
    if (!Number.isFinite(budgetN) || budgetN < cfg.min_budget || budgetN > cfg.max_budget) {
      return res.status(400).json({ success: false, error: `Budget must be between ₦${cfg.min_budget.toLocaleString()} and ₦${cfg.max_budget.toLocaleString()}` });
    }
    if (!Number.isFinite(days) || !cfg.allowed_durations.includes(days)) {
      return res.status(400).json({ success: false, error: `Duration must be one of: ${cfg.allowed_durations.join(", ")} day(s)` });
    }
    const wallet = await getOwnedWallet(String(wallet_id || ""), userId, req.user!.businessId ?? null);
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
    const pinCheck = await verifyTransactionPin(pin, { userId, businessId: req.user!.businessId ?? null, wallet });
    if (!pinCheck.ok) return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });
    const estimated = estimateReach(pricing, "listing", budgetN, days, audience);
    const reference = genRef("MF-MB");
    if (!(await debitWallet(wallet.id, budgetN))) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: "Insufficient wallet balance" });
    }
    await insertTransaction({
      userId, businessId: wallet.business_id, walletId: wallet.id, reference,
      type: "debit", transactionType: "boost", amount: budgetN, currency: wallet.currency,
      fee: 0, description: `Listing boost — ${days}d (~${estimated.toLocaleString()} reach)`,
    });
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + days * 86400000);
    const r = await query(
      `INSERT INTO boost_orders
         (user_id, target_type, target_id, wallet_id, reference, budget, duration_days, daily_budget,
          audience, pricing_snapshot, estimated_reach, status, starts_at, ends_at)
       VALUES ($1,'listing',$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,'active',$11,$12) RETURNING *`,
      [userId, req.params.id, wallet.id, reference, budgetN, days,
       Math.round((budgetN / days) * 100) / 100, JSON.stringify(audience || {}),
       JSON.stringify({ ...cfg, kind: "listing" }), estimated, startsAt, endsAt],
    );
    res.status(201).json({ success: true, data: { boost: { ...r.rows[0], estimated_reach: estimated } } });
  } catch (e: any) {
    console.error("listing boost error:", e?.message);
    res.status(500).json({ success: false, error: "Could not start boost" });
  }
});

export default router;
