import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  assertPersonalService, genRef,
} from "../personal-utils";
import { calculateFee } from "../../../services/fees";
import * as prestmit from "../../../services/prestmit";
import { upload } from "../../../middleware/upload";
import { createNotification } from "../../../services/notifications";

/**
 * GIFT CARDS — REAL Prestmit integration (buy + sell, no simulation).
 * Mounted at /giftcards.
 *
 *   GET  /giftcards/sell/catalog                  → Prestmit sellable catalog + rates
 *   GET  /giftcards/sell/history                  → my sell trades (live state)
 *   POST /giftcards/sell            (multipart)   → REAL sell trade → Prestmit review
 *   GET  /giftcards/buy/catalog                   → Prestmit buyable catalog
 *   POST /giftcards/buy/calculate                 → payment calc (NAIRA totals)
 *   POST /giftcards/buy                           → REAL purchase (debits wallet)
 *   GET  /giftcards/buy/history                   → my purchases
 *   GET  /giftcards/buy/:reference/codes          → card codes after fulfilment
 *
 * Money:
 *   SELL: no upfront charge. When Prestmit approves the trade, the webhook
 *         credits the user's NGN wallet with the trade payout.
 *   BUY:  wallet is debited (payment total + our service fee) before the
 *         Prestmit order; failures auto-refund.
 *
 * NOTE (buy): Prestmit requires the PARTNER ACCOUNT 4-digit PIN — configured
 * via PRESTMIT_ACCOUNT_PIN in the server env.
 */

const router = express.Router();

interface SellCatalogRow {
  id: number;
  name: string;
  category_name?: string;
  image?: string | null;
  rate?: number | null;
  minimum?: number | null;
  currency?: string | null;
}

// ---------------------------------------------------------------------------
// SELL
// ---------------------------------------------------------------------------
router.get("/sell/catalog", authenticateToken, checkSubscriptionStatus, async (_req, res) => {
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    const data = await prestmit.sellRateCalculatorData();
    const subs = data?.sellableGiftcards || [];
    const cats = new Map<number, string>((data?.giftCardCategories || []).map((c: any) => [c.id, c.name]));
    const giftcards: SellCatalogRow[] = subs
      .filter((s: any) => s?.id != null)
      .map((s: any) => ({
        id: Number(s.id),
        name: String(s.name || `Gift card ${s.id}`),
        category_name: cats.get(Number(s.category_id ?? s.categoryId ?? -1)) || (s.category?.name ?? undefined),
        image: s.image || s.logo || null,
        rate: s.rate != null ? Number(s.rate) : null,
        minimum: s.minimum != null ? Number(s.minimum) : null,
        currency: s.currency || "USD",
      }));
    res.json({ success: true, giftcards });
  } catch (e: any) {
    console.error("gc sell catalog error:", e?.message);
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

router.get("/sell/history", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const rows = await query(
      `SELECT * FROM giftcard_sell_trades WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    const trades = rows.rows.map((t) => ({
      id: t.id,
      giftcard_name: t.giftcard_name,
      giftcard_id: t.giftcard_id,
      reference: t.provider_reference || t.reference,
      amount: Number(t.amount),
      rate: t.rate != null ? Number(t.rate) : null,
      payout_amount: Number(t.payout_amount),
      payout_method: t.payout_method,
      status: t.status,
      comments: t.comments,
      rejection_reason: t.rejection_reason,
      attachments: t.attachments,
      created_at: t.created_at,
    }));
    res.json({ success: true, trades });
  } catch (e: any) {
    console.error("gc sell history error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load your trades" });
  }
});

router.post("/sell", authenticateToken, checkSubscriptionStatus, upload.array("attachments", 5), async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    const userId = req.user!.userId;
    const giftcardId = Number(req.body?.giftcard_id);
    const amount = Number(req.body?.amount);
    const payoutMethod = String(req.body?.payout_method || "NAIRA").toUpperCase();
    const comments = req.body?.comments ? String(req.body.comments).slice(0, 1000) : undefined;
    if (!Number.isFinite(giftcardId) || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: "giftcard_id and a positive amount are required" });
    }

    // Resolve wallet up-front: the NGN (or fallback) personal wallet receives the payout.
    const wallet = await query(
      `SELECT id FROM wallets WHERE user_id = $1 AND business_id IS NULL AND status = 'active'
       ORDER BY CASE WHEN currency = 'NGN' THEN 0 ELSE 1 END LIMIT 1`,
      [userId],
    );
    if (!wallet.rows.length) return res.status(400).json({ success: false, error: "No active personal wallet found" });
    const walletId = wallet.rows[0].id;

    // Upload card photos to our storage, then attach to the Prestmit call.
    const files = (req.files as any[]) || [];
    const stored: Array<{ url: string; buffer?: Buffer; mime?: string; filename?: string }> = [];
    for (const f of files.slice(0, 5)) {
      try {
        const up = await (await import("../../../services/media-upload")).uploadMediaBuffer({
          buffer: f.buffer, originalname: f.originalname, mimeType: f.mimetype, folder: "giftcards", userId,
        });
        stored.push({ url: up.url, buffer: f.buffer, mime: f.mimetype, filename: f.originalname });
      } catch (e: any) {
        console.warn("giftcard attachment upload failed:", e?.message);
      }
    }
    if (!stored.length && !comments) {
      return res.status(400).json({ success: false, error: "Attach a photo of the gift card or paste the eCode" });
    }

    const reference = genRef("MF-GCS");
    const nameLookup = await prestmit.sellRateCalculatorData().catch(() => null);
    const gc = (nameLookup?.sellableGiftcards || []).find((s: any) => Number(s.id) === giftcardId);

    const dbInsert = await query(
      `INSERT INTO giftcard_sell_trades
         (user_id, wallet_id, reference, giftcard_id, giftcard_name, amount, payout_method,
          status, comments, attachments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9::jsonb) RETURNING *`,
      [userId, walletId, reference, String(giftcardId), gc?.name || `Gift card ${giftcardId}`, amount, payoutMethod,
       comments || null, JSON.stringify(stored.map((s) => s.url))],
    );

    try {
      const result = await prestmit.createSellTrade({
        giftcardId,
        amount,
        payoutMethod,
        comments: comments || "Submitted via MetriCorex",
        uniqueIdentifier: reference,
        attachments: stored
          .filter((s) => s.buffer)
          .map((s) => ({ filename: s.filename!, buffer: s.buffer!, mime: s.mime! })),
      });
      const trade = result?.trade || {};
      await query(
        `UPDATE giftcard_sell_trades
         SET provider_reference = $2, rate = $3, payout_amount = $4, status = $5,
             provider_response = $6::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [dbInsert.rows[0].id, trade.reference || null,
         trade.rate != null ? Number(trade.rate) : null,
         trade.totalAmount != null ? Number(trade.totalAmount) : 0,
         String(trade.status || "PENDING").toLowerCase(), JSON.stringify(result)],
      );
      return res.status(201).json({
        success: true,
        message: "Trade submitted — you'll be paid once it's reviewed.",
        data: { reference: trade.reference || reference, status: String(trade.status || "pending").toLowerCase() },
      });
    } catch (providerError: any) {
      await query(
        `UPDATE giftcard_sell_trades SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [dbInsert.rows[0].id, prestmit.prestmitErr(providerError)],
      );
      return res.status(502).json({ success: false, error: prestmit.prestmitErr(providerError) });
    }
  } catch (e: any) {
    console.error("gc sell error:", e?.message);
    res.status(500).json({ success: false, error: "Could not submit trade" });
  }
});

// ---------------------------------------------------------------------------
// BUY
// ---------------------------------------------------------------------------
router.get("/buy/catalog", authenticateToken, checkSubscriptionStatus, async (_req, res) => {
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    const cfg = await prestmit.buyConfig();
    res.json({
      success: true,
      enabled: cfg?.enabled !== false,
      payment_methods: cfg?.paymentMethods || ["NAIRA"],
      giftcards: (cfg?.availableGiftCards || []).map((c: any) => ({
        sku: c.sku,
        title: c.title,
        min_price: Number(c.minPrice ?? 0),
        max_price: Number(c.maxPrice ?? 0),
        currency: c.currency?.code || null,
        currency_symbol: c.currency?.symbol || null,
        categories: (c.categories || []).map((x: any) => x.name),
        pre_order: !!c.preOrder,
      })),
    });
  } catch (e: any) {
    console.error("gc buy catalog error:", e?.message);
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

// Contract note: the personal-web client reads the quote from r.data ITSELF
// (no data wrapper) — { partner_total, fee, total }.
router.post("/buy/calculate", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const sku = Number(req.body?.giftCardSKU);
    const price = Number(req.body?.price);
    const quantity = Math.max(1, Number(req.body?.quantity) || 1);
    if (!Number.isFinite(sku) || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, error: "giftCardSKU and a positive price are required" });
    }
    const q = await prestmit.buyCalculate(sku, price, quantity);
    const naira = Number(q?.NAIRA ?? q?.totalPaymentAmount ?? 0);
    const fee = await calculateFee(naira, "giftcard_buy");
    const total = Math.round((naira + fee) * 100) / 100;
    res.json({ ...q, partner_total: naira, fee, total, isAvailable: q?.isAvailable !== false });
  } catch (e: any) {
    console.error("gc calculate error:", e?.message);
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

router.post("/buy", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    const userId = req.user!.userId;
    const sku = Number(req.body?.giftCardSKU);
    const price = Number(req.body?.price);
    const quantity = Math.max(1, Number(req.body?.quantity) || 1);
    const giftcardName = String(req.body?.giftcard_name || `SKU ${sku}`).slice(0, 160);
    if (!Number.isFinite(sku) || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, error: "giftCardSKU and a positive price are required" });
    }
    const accountPin = process.env.PRESTMIT_ACCOUNT_PIN || "";
    if (!accountPin) {
      return res.status(503).json({
        success: false,
        code: "PRESTMIT_PIN_MISSING",
        error: "Gift card purchases are being set up — the partner account PIN is not configured yet. Please try again shortly.",
      });
    }
    const wallet = await getOwnedWallet(String(req.body?.wallet_id || ""), userId, req.user!.businessId ?? null);
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
    if (wallet.currency !== "NGN") {
      return res.status(400).json({ success: false, error: "Gift card purchases are charged in NGN — use your Naira wallet." });
    }

    // Quote → charge
    const q = await prestmit.buyCalculate(sku, price, quantity);
    if (q?.isAvailable === false) {
      return res.status(400).json({ success: false, error: "This gift card is currently out of stock" });
    }
    const naira = Number(q?.NAIRA ?? q?.totalPaymentAmount ?? 0);
    const fee = await calculateFee(naira, "giftcard_buy");
    const total = Math.round((naira + fee) * 100) / 100;
    if (Number(wallet.balance) < total) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: `You need ₦${total.toLocaleString()} for this purchase` });
    }

    const reference = genRef("MF-GCB");
    if (!(await debitWallet(wallet.id, total))) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: "Insufficient wallet balance" });
    }
    await insertTransaction({
      userId, businessId: wallet.business_id, walletId: wallet.id, reference,
      type: "debit", transactionType: "giftcard_buy", amount: total, currency: wallet.currency,
      fee, description: `Gift card purchase — ${giftcardName} ×${quantity}`,
    });

    const dbInsert = await query(
      `INSERT INTO giftcard_buy_orders
         (user_id, wallet_id, reference, giftcard_sku, giftcard_name, quantity, card_price, fee, total_charged,
          currency, payment_method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'NAIRA','pending') RETURNING id`,
      [userId, wallet.id, reference, String(sku), giftcardName, quantity, price, fee, total, wallet.currency],
    );
    try {
      const result = await prestmit.createBuyTrade({
        giftCardSKU: sku, price, quantity, paymentMethod: "NAIRA",
        accountPin, uniqueIdentifier: reference,
      });
      const d = result?.data || result || {};
      const status = String(d.status || "PENDING").toLowerCase();
      await query(
        `UPDATE giftcard_buy_orders SET provider_reference = $2, status = $3, provider_response = $4::jsonb,
         card_codes = CASE WHEN $5::jsonb IS NULL THEN NULL ELSE $5::jsonb END, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [dbInsert.rows[0].id, d.reference || null, status, JSON.stringify(result),
         status === "completed" ? JSON.stringify(d.cardCodes || d.codes || null) : null],
      );
      if (status === "completed") {
        await query(`UPDATE giftcard_buy_orders SET card_codes = COALESCE(card_codes, $2::jsonb) WHERE id = $1`,
          [dbInsert.rows[0].id, JSON.stringify(d.cardCodes || d.codes || null)]);
      }
      res.status(201).json({
        success: true,
        message: status === "completed" ? "Purchase complete — codes delivered!" : "Order placed — codes arrive as soon as fulfilment completes.",
        data: { reference: d.reference || reference, status },
      });
    } catch (providerError: any) {
      // Auto-refund
      await creditWallet(wallet.id, total);
      await insertTransaction({
        userId, businessId: wallet.business_id, walletId: wallet.id,
        reference: `${reference}-REFUND`, type: "credit", transactionType: "giftcard_buy_refund",
        amount: total, currency: wallet.currency, description: `Refund — gift card order failed`,
      });
      await query(
        `UPDATE giftcard_buy_orders SET status = 'failed', failure_reason = $2, refunded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [dbInsert.rows[0].id, prestmit.prestmitErr(providerError)],
      );
      res.status(502).json({ success: false, error: prestmit.prestmitErr(providerError) });
    }
  } catch (e: any) {
    console.error("gc buy error:", e?.message);
    res.status(500).json({ success: false, error: "Could not complete purchase" });
  }
});

router.get("/buy/history", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const rows = await query(
      `SELECT * FROM giftcard_buy_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    const orders = rows.rows.map((o) => ({
      id: o.id,
      giftcard_name: o.giftcard_name,
      giftcard_sku: o.giftcard_sku,
      quantity: Number(o.quantity),
      reference: o.provider_reference || o.reference,
      total_charged: Number(o.total_charged),
      status: o.status,
      created_at: o.created_at,
    }));
    res.json({ success: true, orders });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load orders" });
  }
});

router.get("/buy/:reference/codes", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const row = await query(
      `SELECT * FROM giftcard_buy_orders WHERE (provider_reference = $1 OR reference = $1) AND user_id = $2`,
      [req.params.reference, req.user!.userId],
    );
    if (!row.rows.length) return res.status(404).json({ success: false, error: "Order not found" });
    const order = row.rows[0];
    let codes = order.card_codes;
    if (!codes && order.provider_reference && order.status !== "failed") {
      try {
        const remote = await prestmit.fetchCardCodes(order.provider_reference);
        codes = remote?.data?.cardCodes || remote?.data?.codes || remote?.data || null;
        if (codes) {
          await query(`UPDATE giftcard_buy_orders SET card_codes = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [order.id, JSON.stringify(codes)]);
        }
      } catch { /* keep null */ }
    }
    res.json({ success: true, data: { status: order.status, codes } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not fetch card codes" });
  }
});

export default router;
