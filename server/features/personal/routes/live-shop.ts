import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  genRef, requirePersonalKyc,
} from "../personal-utils";
import { calculateFee } from "../../../services/fees";
import { createNotification } from "../../../services/notifications";
import { getSocketServer } from "../../../lib/socket";

/**
 * LIVE SHOPPING — TikTok-style in-stream product rail + one-tap wallet
 * checkout (mounted at /live, AFTER personalLiveRouter; the /:id/shop/*
 * subpaths never collide with the live room routes).
 *
 *   GET  /live/:id/shop                        → shop rail (viewers see pinned
 *                                                items, the host sees all)
 *   POST /live/:id/shop/:listingId/pin         { pin: true|false } (host only —
 *                                                snapshots the listing price)
 *   POST /live/:id/shop/:listingId/buy         { quantity? } (viewer instant
 *                                                checkout — mirrors the
 *                                                marketplace escrow-lite money
 *                                                path, order status 'paid')
 *   GET  /live/:id/shop/sales                  → host dashboard (per-item
 *                                                sold_count/revenue/commission
 *                                                + session totals)
 *
 * MONEY PATH (mirrors marketplace.ts POST /:id/buy):
 *   calculateFee(subtotal, "marketplace") → balance-guarded debitWallet →
 *   insertTransaction(debit, transactionType "market_order") → market_orders
 *   INSERT (reference `LIVE-ORD-…`, live_session_id, status 'paid') → stock
 *   decrement. The host additionally earns a 2% commission on the subtotal
 *   (wallet credit + `LIVE-COMM-<orderRef>` transactions row) and the
 *   live_shop_items row accumulates sold_count/revenue/commission.
 *
 * REAL-TIME: room broadcasts reuse the exact live:gift delivery pattern
 * (resolve the backing calls row by call_code, emit to `room:<callId>`):
 *   - `live:shop_updated` { session_id, session_code, items }  on pin/unpin
 *   - `live:shop_sold`    { session_id, session_code, item_id,
 *                           sold_count, listing_title }         on purchase
 * Every emit is fail-soft — a socket hiccup can never fail a pin or purchase.
 */

/** Host commission on live-shop sales (2% of the order subtotal). */
const LIVE_SHOP_COMMISSION_PERCENT = 2;

/** Human money formatter (₦ for naira, ISO code suffix otherwise). */
function fmtMoney(amount: number, currency: string): string {
  const n = (Math.round(amount * 100) / 100).toLocaleString();
  return String(currency).toUpperCase() === "NGN" ? `₦${n}` : `${n} ${currency}`;
}

/**
 * Resolve a live session by UUID id OR by its call_code (the watch page and
 * room UI only know the code) — same contract as live.ts sessionById, but
 * WITHOUT the status='live' filter: the shop must stay reachable for the host
 * dashboard and post-stream order lookups, and the contract only demands the
 * session exist in live_sessions.
 */
async function sessionById(id: string) {
  const r = await query(
    `SELECT * FROM live_sessions WHERE (id::text = $1 OR call_code = $1) LIMIT 1`,
    [String(id || "").trim()],
  );
  return r.rows[0] ?? null;
}

/**
 * Room broadcast — EXACTLY the live:gift delivery pattern from live.ts:
 * resolve the backing `calls` row by call_code (the WebRTC room stack keys
 * rooms on calls.id) and emit to `room:<callId>`, falling back to the raw
 * call_code when the backing row is missing. Never throws — a socket problem
 * must not break a pin or a purchase.
 */
function emitToLiveRoom(session: { id: string; call_code: string }, event: string, payload: Record<string, unknown>): void {
  try {
    const io = getSocketServer();
    if (!io) return;
    query(`SELECT id FROM calls WHERE call_code = $1 LIMIT 1`, [session.call_code])
      .then((callRow: any) => {
        const roomId = callRow.rows[0]?.id || session.call_code;
        io.to(`room:${roomId}`).emit(event, payload);
      })
      .catch((e: any) => console.error(`[live-shop] ${event} room lookup skipped:`, e?.message));
  } catch (e: any) {
    console.error(`[live-shop] ${event} socket emit skipped:`, e?.message);
  }
}

/** Contract shape for a shop item (the `withMoney` extra fields power /sales). */
function mapShopItem(r: any, withMoney = false) {
  const item: Record<string, unknown> = {
    id: r.id,
    listing: {
      id: r.listing_id,
      title: r.listing_name,
      price: Number(r.listing_price),
      currency: r.listing_currency,
      images: r.listing_images || [],
    },
    price_snapshot: Number(r.price_snapshot),
    currency: r.currency,
    sold_count: Number(r.sold_count) || 0,
    pinned: r.pinned === true,
  };
  if (withMoney) {
    item.revenue = Number(r.revenue) || 0;
    item.commission = Number(r.commission) || 0;
  }
  return item;
}

/** Load a session's shop items joined with their listings. */
async function loadShopItems(sessionId: string, pinnedOnly: boolean) {
  const r = await query(
    `SELECT li.id, li.listing_id, li.price_snapshot, li.currency, li.sold_count,
            li.pinned, li.revenue, li.commission,
            l.name AS listing_name, l.price AS listing_price,
            l.currency AS listing_currency, l.images AS listing_images
       FROM live_shop_items li
       JOIN market_listings l ON l.id = li.listing_id
      WHERE li.session_id = $1 AND ($2::boolean = FALSE OR li.pinned = TRUE)
      ORDER BY li.pinned DESC, li.pinned_at DESC NULLS LAST, li.created_at ASC`,
    [sessionId, pinnedOnly],
  );
  return r.rows;
}

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /live/:id/shop — the in-stream rail. Viewers get pinned items only;
// the host gets every item they pinned for that session. Sessions with no
// shop simply return an empty items array.
// ---------------------------------------------------------------------------
router.get("/:id/shop", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const session = await sessionById(String(req.params.id));
    if (!session) return res.status(404).json({ success: false, error: "Stream not found" });
    const isHost = session.host_id === req.user!.userId;
    const rows = await loadShopItems(session.id, !isHost);
    res.json({
      success: true,
      items: rows.map((r: any) => mapShopItem(r)),
      host_id: session.host_id,
    });
  } catch (e: any) {
    console.error("live shop error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load the live shop" });
  }
});

// ---------------------------------------------------------------------------
// POST /live/:id/shop/:listingId/pin — HOST ONLY. pin:true upserts the item
// with a fresh price snapshot (the listing price at pin time — the price
// viewers will actually be charged); pin:false unpins (no row → no-op).
// The room gets `live:shop_updated` with the viewer-visible rail.
// ---------------------------------------------------------------------------
router.post("/:id/shop/:listingId/pin", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const rawPin = req.body?.pin;
    if (typeof rawPin !== "boolean" && rawPin !== "true" && rawPin !== "false") {
      return res.status(400).json({ success: false, error: "pin (true|false) is required" });
    }
    const wantPinned = rawPin === true || rawPin === "true";

    const session = await sessionById(String(req.params.id));
    if (!session) return res.status(404).json({ success: false, error: "Stream not found" });
    if (session.host_id !== userId) {
      return res.status(403).json({ success: false, error: "Only the host can manage the live shop" });
    }

    const listingRes = await query(`SELECT * FROM market_listings WHERE id = $1`, [req.params.listingId]);
    const l = listingRes.rows[0];
    if (!l) return res.status(404).json({ success: false, error: "Listing not found" });
    if (l.seller_id !== session.host_id) {
      return res.status(403).json({ success: false, error: "You can only pin your own listings" });
    }

    const priceSnapshot = Math.round(Number(l.price) * 100) / 100;
    if (wantPinned) {
      await query(
        `INSERT INTO live_shop_items (session_id, host_id, listing_id, price_snapshot, currency, pinned)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (session_id, listing_id) DO UPDATE
            SET pinned = TRUE,
                price_snapshot = EXCLUDED.price_snapshot,
                currency = EXCLUDED.currency,
                pinned_at = CURRENT_TIMESTAMP`,
        [session.id, session.host_id, l.id, priceSnapshot, l.currency || "NGN"],
      );
    } else {
      // Unpin: only touch an existing row — never create unpinned rows.
      await query(
        `UPDATE live_shop_items SET pinned = FALSE WHERE session_id = $1 AND listing_id = $2`,
        [session.id, l.id],
      );
    }

    // Broadcast the viewer-visible rail (pinned items) — same room pattern as live:gift.
    const rows = await loadShopItems(session.id, true);
    emitToLiveRoom(session, "live:shop_updated", {
      session_id: session.id,
      session_code: session.call_code,
      items: rows.map((r: any) => mapShopItem(r)),
    });

    res.json({
      success: true,
      pinned: wantPinned,
      items: rows.map((r: any) => mapShopItem(r, true)),
      host_id: session.host_id,
    });
  } catch (e: any) {
    console.error("live shop pin error:", e?.message);
    res.status(500).json({ success: false, error: "Could not update the live shop" });
  }
});

// ---------------------------------------------------------------------------
// POST /live/:id/shop/:listingId/buy — viewer instant checkout. Money path
// mirrors marketplace.ts POST /:id/buy exactly (balance-guarded debit at
// unit×qty, calculateFee(..., "marketplace"), market_orders INSERT with
// status 'paid', stock decrement) plus live attribution (live_session_id)
// and the host's 2% commission. No PIN: live-shop checkout is one tap, the
// same trust level as live gifting.
// ---------------------------------------------------------------------------
router.post("/:id/shop/:listingId/buy", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  const userId = req.user!.userId;
  try {
    const session = await sessionById(String(req.params.id));
    if (!session) return res.status(404).json({ success: false, error: "Stream not found" });

    // The pinned shop item + its listing, in one read.
    const itemRes = await query(
      `SELECT li.id, li.session_id, li.host_id, li.listing_id, li.price_snapshot,
              li.currency, li.pinned, li.sold_count,
              l.name, l.price, l.currency AS listing_currency, l.stock, l.status, l.seller_id
         FROM live_shop_items li
         JOIN market_listings l ON l.id = li.listing_id
        WHERE li.session_id = $1 AND li.listing_id = $2
        LIMIT 1`,
      [session.id, req.params.listingId],
    );
    const item = itemRes.rows[0];
    if (!item || !item.pinned) {
      return res.status(404).json({ success: false, error: "This item is not available in the live shop" });
    }
    // Same listing guards as the marketplace buy path.
    if (item.status !== "active") {
      return res.status(404).json({ success: false, error: "Listing is no longer available" });
    }
    if (item.seller_id === userId) {
      return res.status(400).json({ success: false, error: "You can't buy your own listing" });
    }
    const quantity = Math.max(1, Number(req.body?.quantity) || 1);
    if (item.stock !== null && quantity > Number(item.stock)) {
      return res.status(400).json({ success: false, error: `Only ${item.stock} left in stock` });
    }

    // Viewers pay the PINNED price (the snapshot the rail displayed), not a
    // silently re-priced listing — re-pinning refreshes the snapshot.
    const unitPrice = Number(item.price_snapshot) > 0 ? Number(item.price_snapshot) : Number(item.price);
    const currency = item.currency || item.listing_currency || "NGN";
    const subtotal = Math.round(unitPrice * quantity * 100) / 100;

    // Wallet: explicit wallet_id wins; otherwise the caller's own active
    // wallet in the listing currency (personal first, business fallback).
    let wallet: any = null;
    if (req.body?.wallet_id) {
      wallet = await getOwnedWallet(String(req.body.wallet_id), userId, req.user!.businessId ?? null);
      if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
    } else {
      const walletRes = await query(
        `SELECT id, user_id, business_id, balance, currency, status
           FROM wallets
          WHERE status = 'active' AND UPPER(currency) = $2
            AND (user_id = $1 OR ($3::varchar IS NOT NULL AND business_id = $3))
          ORDER BY CASE WHEN user_id = $1 THEN 0 ELSE 1 END
          LIMIT 1`,
        [userId, currency.toUpperCase(), req.user!.businessId ?? null],
      );
      wallet = walletRes.rows[0] ?? null;
    }
    if (!wallet) {
      return res.status(400).json({ success: false, error: `You need a ${currency} wallet to buy in this live shop` });
    }
    if (String(wallet.currency).toUpperCase() !== String(currency).toUpperCase()) {
      return res.status(400).json({ success: false, error: `This item is priced in ${currency} — pay from your ${currency} wallet` });
    }

    // --- Money path (mirrors marketplace.ts POST /:id/buy) ------------------
    const fee = await calculateFee(subtotal, "marketplace");
    const total = Math.round((subtotal + fee) * 100) / 100;
    const reference = genRef("LIVE-ORD");
    if (!(await debitWallet(wallet.id, total))) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: "Insufficient wallet balance" });
    }

    try {
      await insertTransaction({
        userId, businessId: wallet.business_id, walletId: wallet.id, reference,
        type: "debit", transactionType: "market_order", amount: total, currency: wallet.currency,
        fee, description: `Live shop purchase — ${item.name}${quantity > 1 ? ` ×${quantity}` : ""}`,
      });
      const orderRes = await query(
        `INSERT INTO market_orders
           (reference, listing_id, buyer_id, seller_id, wallet_id, quantity, unit_price, fee, total, currency,
            status, live_session_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paid',$11) RETURNING *`,
        [reference, item.listing_id, userId, item.seller_id, wallet.id, quantity, unitPrice, fee, total, currency,
         session.id],
      );

      // Stock decrement — identical to the marketplace buy path.
      if (item.stock !== null) {
        try {
          await query(
            `UPDATE market_listings SET stock = GREATEST(0, stock - $2),
             status = CASE WHEN stock - $2 <= 0 THEN 'sold' ELSE status END WHERE id = $1`,
            [item.listing_id, quantity],
          );
        } catch (stockErr: any) {
          console.error("[live-shop] stock decrement skipped:", stockErr?.message);
        }
      }

      // HOST COMMISSION — 2% of the subtotal, credited to the host's wallet in
      // the order currency (the NGN wallet for NGN listings) with a
      // `LIVE-COMM-<orderRef>` ledger row. The commission is EARNED the moment
      // the order is paid, so the live_shop_items stats below are written even
      // if the wallet credit itself fails (logged for reconciliation) — the
      // buyer's completed order is never unwound by a host-side hiccup.
      const commission = Math.round(subtotal * (LIVE_SHOP_COMMISSION_PERCENT / 100) * 100) / 100;
      if (commission > 0) {
        try {
          const hostWalletRes = await query(
            `SELECT id FROM wallets WHERE user_id = $1 AND UPPER(currency) = $2 AND status = 'active' LIMIT 1`,
            [session.host_id, currency.toUpperCase()],
          );
          const hostWallet = hostWalletRes.rows[0];
          if (hostWallet) {
            await creditWallet(hostWallet.id, commission);
            await insertTransaction({
              userId: session.host_id, businessId: null, walletId: hostWallet.id,
              reference: `LIVE-COMM-${reference}`, type: "credit",
              transactionType: "live_shop_commission", amount: commission, currency,
              description: `Live shopping commission — ${item.name}`,
            });
          } else {
            console.error(`[live-shop] host ${session.host_id} has no active ${currency} wallet — commission ₦${commission} recorded on the shop item only (order ${reference})`);
          }
        } catch (commErr: any) {
          console.error(`[live-shop] commission credit failed for order ${reference}:`, commErr?.message);
        }
      }

      // Shop item stats: sold_count += qty, revenue += subtotal, commission += comm.
      let soldCount = Number(item.sold_count) + quantity;
      try {
        const statsRes = await query(
          `UPDATE live_shop_items
              SET sold_count = sold_count + $2,
                  revenue = revenue + $3,
                  commission = commission + $4
            WHERE id = $1
            RETURNING sold_count`,
          [item.id, quantity, subtotal, commission],
        );
        if (statsRes.rows[0]) soldCount = Number(statsRes.rows[0].sold_count);
      } catch (statsErr: any) {
        console.error(`[live-shop] stats update failed for order ${reference}:`, statsErr?.message);
      }

      // Host push/notification.
      createNotification({
        userId: session.host_id,
        type: "live_sale",
        title: "🛍️ Sold during your live!",
        message: `${item.name}${quantity > 1 ? ` ×${quantity}` : ""} just sold for ${fmtMoney(subtotal, currency)} — your commission: ${fmtMoney(commission, currency)}.`,
        actionUrl: "/live",
      }).catch(() => {});

      // Real-time room broadcast (same delivery pattern as live:gift).
      emitToLiveRoom(session, "live:shop_sold", {
        session_id: session.id,
        session_code: session.call_code,
        item_id: item.id,
        sold_count: soldCount,
        listing_title: item.name,
      });

      res.status(201).json({
        success: true,
        order: { reference: orderRes.rows[0]?.reference || reference, total, currency },
        message: "Purchase complete — check your orders",
      });
    } catch (e: any) {
      // Ledger/order insert failed — refund the buyer so money is never lost
      // without an order (same compensation as the live gift path).
      console.error("[live-shop] buy failed, refunding buyer:", e?.message);
      await creditWallet(wallet.id, total).catch(() => {});
      if (e?.code === "23505") {
        return res.status(409).json({ success: false, error: "Duplicate purchase — please try again" });
      }
      return res.status(500).json({ success: false, error: "Could not complete purchase — you were not charged" });
    }
  } catch (e: any) {
    console.error("live shop buy error:", e?.message);
    res.status(500).json({ success: false, error: "Could not complete purchase" });
  }
});

// ---------------------------------------------------------------------------
// GET /live/:id/shop/sales — HOST ONLY dashboard: every item with its
// sold_count/revenue/commission plus session-wide totals.
// ---------------------------------------------------------------------------
router.get("/:id/shop/sales", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const session = await sessionById(String(req.params.id));
    if (!session) return res.status(404).json({ success: false, error: "Stream not found" });
    if (session.host_id !== req.user!.userId) {
      return res.status(403).json({ success: false, error: "Only the host can view shop sales" });
    }
    const rows = await loadShopItems(session.id, false);
    const totalsRes = await query(
      `SELECT COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(commission), 0) AS commission
         FROM live_shop_items WHERE session_id = $1`,
      [session.id],
    );
    const ordersRes = await query(
      `SELECT COUNT(*)::int AS orders FROM market_orders WHERE live_session_id = $1`,
      [session.id],
    );
    res.json({
      success: true,
      items: rows.map((r: any) => mapShopItem(r, true)),
      totals: {
        revenue: Number(totalsRes.rows[0]?.revenue) || 0,
        commission: Number(totalsRes.rows[0]?.commission) || 0,
        orders: Number(ordersRes.rows[0]?.orders) || 0,
      },
      host_id: session.host_id,
    });
  } catch (e: any) {
    console.error("live shop sales error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load shop sales" });
  }
});

export default router;
