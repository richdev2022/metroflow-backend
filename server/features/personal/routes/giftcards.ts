import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  assertPersonalService, genRef,
} from "../personal-utils";
import { calculateFee, creditRevenueWallet } from "../../../services/fees";
import * as prestmit from "../../../services/prestmit";
import { upload } from "../../../middleware/upload";
import { createNotification } from "../../../services/notifications";

/**
 * GIFT CARDS — REAL Prestmit integration (buy + sell, no simulation).
 * Mounted at /giftcards.
 *
 *   GET  /giftcards/status                        → provider configured?
 *   GET  /giftcards/sell/catalog                  → Prestmit sellable catalog + rates + logos
 *   GET  /giftcards/sell/categories               → brand categories (lookup)
 *   GET  /giftcards/sell/subcategories            → card variants w/ rates (lookup)
 *   GET  /giftcards/sell/countries                → country filters (flags/currencies)
 *   GET  /giftcards/sell/payout-methods           → NAIRA/CEDIS/BITCOINS payout info
 *   GET  /giftcards/sell/history                  → my sell trades
 *   POST /giftcards/sell            (multipart)   → REAL sell trade → Prestmit review
 *   POST /giftcards/sell/:reference/sync          → poll Prestmit; settle or reject
 *   GET  /giftcards/buy/catalog                   → buyable catalog (paginated, searchable)
 *   GET  /giftcards/buy/currencies                → currency filter for the catalog
 *   POST /giftcards/buy/calculate                 → payment calc + stock check
 *   POST /giftcards/buy                           → REAL purchase (debits wallet)
 *   GET  /giftcards/buy/history                   → my purchases
 *   GET  /giftcards/buy/:reference/codes          → card codes after fulfilment
 *
 * Money:
 *   SELL: no upfront charge. When Prestmit approves the trade (webhook or
 *         sync), the user's NGN wallet is credited the payout MINUS our
 *         sell fee percent (admin-configurable); the fee lands in revenue.
 *   BUY:  wallet is debited (Prestmit total + our service fee) before the
 *         Prestmit order; failures auto-refund.
 *
 * NOTE (buy): Prestmit requires the PARTNER ACCOUNT 4-digit PIN — configured
 * via PRESTMIT_ACCOUNT_PIN in the server env.
 */

const router = express.Router();

// ---------------------------------------------------------------------------
// Schema (idempotent)
// ---------------------------------------------------------------------------
export async function ensureGiftcardRoutesSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS giftcard_sell_trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID NOT NULL,
      wallet_id UUID,
      reference VARCHAR(80) UNIQUE NOT NULL,
      provider_reference VARCHAR(80),
      giftcard_id VARCHAR(40),
      giftcard_name VARCHAR(200),
      amount DECIMAL(15,2) NOT NULL,
      rate DECIMAL(12,4),
      payout_amount DECIMAL(15,2) DEFAULT 0,
      payout_method VARCHAR(20) DEFAULT 'NAIRA',
      currency VARCHAR(3) DEFAULT 'NGN',
      status VARCHAR(24) DEFAULT 'pending',
      comments TEXT,
      attachments JSONB,
      rejection_reason TEXT,
      credited_at TIMESTAMP,
      provider_response JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS giftcard_buy_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID NOT NULL,
      wallet_id UUID,
      reference VARCHAR(80) UNIQUE NOT NULL,
      provider_reference VARCHAR(120),
      giftcard_sku VARCHAR(120),
      giftcard_name VARCHAR(200),
      quantity INTEGER DEFAULT 1,
      card_price DECIMAL(15,2),
      fee DECIMAL(15,2) DEFAULT 0,
      total_charged DECIMAL(15,2),
      currency VARCHAR(3) DEFAULT 'NGN',
      payment_method VARCHAR(20) DEFAULT 'NAIRA',
      status VARCHAR(24) DEFAULT 'pending',
      card_codes JSONB,
      failure_reason TEXT,
      refunded_at TIMESTAMP,
      provider_response JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function ensureSchema() {
  await ensureGiftcardRoutesSchema();
}

const uploadCardMedia = upload.array("attachments", 10);

// Our margin on sell payouts / buy orders — admin-editable via the Personal
// Products console (settings giftcard_sell_fee_percent / giftcard_buy_fee_percent).
const SELL_FEE_PERCENT_FALLBACK = 5;
const BUY_FEE_PERCENT_FALLBACK = 5;
async function sellFeePercent(): Promise<number> {
  const { getPercent } = await import("../flags");
  return getPercent("giftcard_sell_fee_percent", SELL_FEE_PERCENT_FALLBACK);
}
async function buyFeePercent(): Promise<number> {
  const { getPercent } = await import("../flags");
  return getPercent("giftcard_buy_fee_percent", BUY_FEE_PERCENT_FALLBACK);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
router.get("/status", authenticateToken, async (_req: AuthenticatedRequest, res) => {
  res.json({
    success: true,
    data: { configured: prestmit.isPrestmitConfigured(), sandbox: prestmit.isPrestmitSandbox() },
  });
});

// ---------------------------------------------------------------------------
// SELL — catalogue + lookups
// ---------------------------------------------------------------------------
router.get("/sell/catalog", authenticateToken, checkSubscriptionStatus, async (_req, res) => {
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    const data = await prestmit.sellRateCalculatorData();
    const subs = data?.sellableGiftcards || [];
    const cats = new Map<number, string>((data?.giftCardCategories || []).map((c: any) => [c.id, c.name]));
    const giftcards = subs
      .filter((s: any) => s?.id != null)
      .map((s: any) => ({
        id: Number(s.id),
        name: String(s.name || `Gift card ${s.id}`),
        category_id: s.category?.id ?? s.category_id ?? null,
        category_name: cats.get(Number(s.category_id ?? s.categoryId ?? -1)) || (s.category?.name ?? undefined),
        image: s.image || s.logo || s.logo_url || s.image_url || s.cardImage || s.picture || null,
        rate: s.rate != null ? Number(s.rate) : null,
        minimum: s.minimum != null ? Number(s.minimum) : null,
        form: s.form || null,
        country: s.country || null,
        terms: s.terms || null,
        currency: s.currency || "USD",
      }));
    res.json({
      success: true,
      giftcards,
      rate_conversions: data?.rateConversions || null,
      payout_methods: data?.sellGiftcardPayoutMethods || null,
    });
  } catch (e: any) {
    console.error("gc sell catalog error:", e?.message);
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

router.get("/sell/categories", authenticateToken, async (_req, res) => {
  try {
    const cats = await prestmit.sellCategories();
    res.json({ success: true, categories: cats });
  } catch (e: any) {
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

router.get("/sell/subcategories", authenticateToken, async (req, res) => {
  try {
    const params: Record<string, any> = {};
    for (const k of ["categoryID", "category_id", "form", "country"]) {
      const v = req.query[k];
      if (v) params[k.replace("category_id", "categoryID")] = String(v);
    }
    const subs = await prestmit.sellSubcategories(params);
    res.json({ success: true, subcategories: subs });
  } catch (e: any) {
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

router.get("/sell/countries", authenticateToken, async (_req, res) => {
  try {
    const countries = await prestmit.sellCountries();
    res.json({ success: true, countries });
  } catch (e: any) {
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

router.get("/sell/payout-methods", authenticateToken, async (_req, res) => {
  try {
    const methods = await prestmit.sellPayoutMethods();
    res.json({ success: true, payout_methods: methods });
  } catch (e: any) {
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

router.post("/sell", authenticateToken, checkSubscriptionStatus, uploadCardMedia, async (req: AuthenticatedRequest, res) => {
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
    for (const f of files.slice(0, 10)) {
      // Prestmit accepts JPG/PNG only — reject anything else up front.
      if (!/^image\/(jpe?g|png)$/i.test(String(f.mimetype))) continue;
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
          .map((s) => ({ filename: s.filename!, buffer: s.buffer!, contentType: s.mime! })),
      });
      if (!result.ok) {
        await query(
          `UPDATE giftcard_sell_trades SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [dbInsert.rows[0].id, result.message || "Sell trade rejected"],
        );
        return res.status(502).json({ success: false, error: result.message || "Sell trade rejected" });
      }
      const trade = result.raw?.trade || result.raw?.data?.trade || {};
      await query(
        `UPDATE giftcard_sell_trades
         SET provider_reference = $2, rate = $3, payout_amount = $4, status = $5,
             provider_response = $6::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [dbInsert.rows[0].id, result.reference || null,
         result.rate != null ? Number(result.rate) : null,
         result.totalAmount != null ? Number(result.totalAmount) : 0,
         String(result.status || "PENDING").toLowerCase(), JSON.stringify(result.raw || result)],
      );
      return res.status(201).json({
        success: true,
        message: "Trade submitted — you'll be paid once it's reviewed.",
        data: { reference: result.reference || reference, status: String(result.status || "pending").toLowerCase() },
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

/**
 * Settle ONE sell trade from live Prestmit state: credit the user wallet
 * (payout minus our sell fee) when Prestmit approves, or mark the trade
 * rejected with Prestmit's reason. Shared by the sync endpoint and the
 * webhook path.
 */
export async function settleSellTradeFromProvider(tradeId: string): Promise<{ updated: boolean; status: string }> {
  const r = await query(`SELECT * FROM giftcard_sell_trades WHERE id = $1`, [tradeId]);
  const trade = r.rows[0];
  if (!trade || trade.status === "settled") return { updated: false, status: trade?.status || "pending" };
  if (!trade.provider_reference) return { updated: false, status: trade.status };

  const remote = await prestmit.sellHistory({ referenceOrID: trade.provider_reference }).catch(() => []);
  const match = Array.isArray(remote) ? remote.find((t: any) => String(t.reference) === String(trade.provider_reference)) : null;
  if (!match) return { updated: false, status: trade.status };

  const pStatus = String(match.status || "").toUpperCase();
  if (pStatus === "SUCCESS" || pStatus === "COMPLETED") {
    if (trade.status === "settled") return { updated: false, status: "settled" };
    const gross = Number(match.totalAmount ?? trade.payout_amount ?? 0);
    const feePct = await sellFeePercent();
    const fee = Math.round(gross * (feePct / 100) * 100) / 100;
    const net = Math.max(0, Math.round((gross - fee) * 100) / 100);
    if (net > 0 && trade.wallet_id) {
      await creditWallet(trade.wallet_id, net);
      await insertTransaction({
        userId: trade.user_id, businessId: trade.business_id, walletId: trade.wallet_id,
        reference: `GCSP-${trade.reference}`, type: "credit", transactionType: "giftcard_sell",
        amount: net, currency: trade.currency || "NGN",
        fee,
        description: `Gift card sale payout — ${trade.giftcard_name || "card"}`,
      });
      if (fee > 0) {
        await creditRevenueWallet(fee, trade.currency || "NGN", `GCSP-${trade.reference}`, "Gift card sell fee", "giftcards").catch(() => {});
      }
    }
    await query(
      `UPDATE giftcard_sell_trades SET status = 'settled', credited_at = CURRENT_TIMESTAMP,
         payout_amount = GREATEST(payout_amount, $2), provider_response = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [trade.id, gross, JSON.stringify(match)],
    );
    try {
      await createNotification({
        businessId: String(trade.business_id || ""),
        userId: String(trade.user_id),
        type: "credit",
        title: "Gift card sale approved",
        message: `₦${net.toLocaleString()} has been credited for your ${trade.giftcard_name || "gift card"} sale.`,
        actionUrl: "/giftcards",
        actionType: "view_transaction",
        metadata: { reference: trade.reference },
        isActionable: false,
        expiresInHours: 168,
      });
    } catch { /* best effort */ }
    return { updated: true, status: "settled" };
  }

  if (["REJECTED", "FAILED", "CANCELLED"].includes(pStatus)) {
    const newStatus = pStatus === "REJECTED" ? "rejected" : pStatus.toLowerCase();
    await query(
      `UPDATE giftcard_sell_trades SET status = $2, rejection_reason = $3,
         provider_response = $4::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [trade.id, newStatus, String(match.rejectionReason || match.comments || "Rejected by review").slice(0, 500), JSON.stringify(match)],
    );
    try {
      await createNotification({
        businessId: String(trade.business_id || ""),
        userId: String(trade.user_id),
        type: "system",
        title: "Gift card sale update",
        message: `Your ${trade.giftcard_name || "gift card"} sale was ${newStatus}. ${match.rejectionReason || ""}`.trim(),
        actionUrl: "/giftcards",
        actionType: "view_transaction",
        metadata: { reference: trade.reference },
        isActionable: false,
        expiresInHours: 168,
      });
    } catch { /* best effort */ }
    return { updated: true, status: newStatus };
  }
  return { updated: false, status: trade.status };
}

router.post("/sell/:reference/sync", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const row = await query(
      `SELECT id FROM giftcard_sell_trades WHERE (reference = $1 OR provider_reference = $1) AND user_id = $2`,
      [req.params.reference, req.user!.userId],
    );
    if (!row.rows.length) return res.status(404).json({ success: false, error: "Trade not found" });
    const result = await settleSellTradeFromProvider(row.rows[0].id);
    const updated = await query(`SELECT status FROM giftcard_sell_trades WHERE id = $1`, [row.rows[0].id]);
    res.json({ success: true, data: { ...result, status: updated.rows[0]?.status || result.status } });
  } catch (e: any) {
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

// ---------------------------------------------------------------------------
// BUY
// ---------------------------------------------------------------------------
router.get("/buy/catalog", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 25, 1), 25);
    const search = String(req.query.search || "").trim().toLowerCase();
    const currencyCode = String(req.query.currencyCode || "").trim().toUpperCase();

    const [cfg, catalogPage] = await Promise.all([
      prestmit.buyConfig().catch(() => null),
      prestmit.fetchBuyableGiftcards({ currencyCode: currencyCode || undefined, page, perPage }),
    ]);
    let cards: any[] = catalogPage?.data || catalogPage?.availableGiftCards || [];
    if (search) {
      cards = cards.filter((c) =>
        String(c.title || "").toLowerCase().includes(search)
        || (c.categories || []).some((x: any) => String(x?.name || "").toLowerCase().includes(search)));
    }
    const meta = catalogPage?.meta || {};
    res.json({
      success: true,
      enabled: cfg ? cfg.enabled !== false : true,
      payment_methods: cfg?.paymentMethods || ["NAIRA", "CEDIS"],
      payment_methods_all: cfg?.paymentMethodsAll || cfg?.paymentMethodsAvailability || null,
      giftcards: cards.map((c: any) => ({
        sku: c.sku,
        upc: c.upc ?? null,
        title: c.title,
        description: c.description || null,
        image: c.imageUrl || c.image || c.logo || c.logo_url || c.image_url || c.picture || null,
        min_price: Number(c.minPrice ?? 0),
        max_price: Number(c.maxPrice ?? 0),
        currency: c.currency?.code || null,
        currency_symbol: c.currency?.symbol || null,
        categories: (c.categories || []).map((x: any) => x.name),
        regions: (c.regions || []).map((x: any) => ({ name: x.name, code: x.code })),
        pre_order: !!c.preOrder,
      })),
      page: meta.current_page ? Number(meta.current_page) : page,
      total: meta.total != null ? Number(meta.total) : cards.length,
      total_pages: meta.last_page ? Number(meta.last_page) : 1,
    });
  } catch (e: any) {
    console.error("gc buy catalog error:", e?.message);
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

router.get("/buy/currencies", authenticateToken, async (_req, res) => {
  try {
    const currencies = await prestmit.buyCurrencies();
    res.json({ success: true, currencies });
  } catch (e: any) {
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

// Contract note: the personal-web client reads the quote from r.data ITSELF
// (no data wrapper) — { partner_total, fee, total, isAvailable }.
router.post("/buy/calculate", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const sku = Number(req.body?.giftCardSKU);
    const price = Number(req.body?.price);
    const quantity = Math.max(1, Number(req.body?.quantity) || 1);
    if (!Number.isFinite(sku) || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, error: "giftCardSKU and a positive price are required" });
    }
    const [q, available] = await Promise.all([
      prestmit.buyCalculate(sku, price, quantity),
      prestmit.buyCheckAvailability(sku, price, quantity).catch(() => true),
    ]);
    const naira = Number(q?.NAIRA ?? q?.totalPaymentAmount ?? 0);
    const feePct = await buyFeePercent();
    const fee = Math.round(naira * (feePct / 100) * 100) / 100;
    const total = Math.round((naira + fee) * 100) / 100;
    res.json({ ...q, partner_total: naira, fee, total, isAvailable: available && q?.isAvailable !== false });
  } catch (e: any) {
    console.error("gc calculate error:", e?.message);
    res.status(502).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

router.post("/buy", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    await ensureSchema();
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

    // Quote → availability → charge
    const [q, available] = await Promise.all([
      prestmit.buyCalculate(sku, price, quantity),
      prestmit.buyCheckAvailability(sku, price, quantity).catch(() => true),
    ]);
    if (!available || q?.isAvailable === false) {
      return res.status(400).json({ success: false, error: "This gift card is currently out of stock" });
    }
    const naira = Number(q?.NAIRA ?? q?.totalPaymentAmount ?? 0);
    const feePct = await buyFeePercent();
    const fee = Math.round(naira * (feePct / 100) * 100) / 100;
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
      if (!result.ok) throw new Error(result.message || "Buy trade rejected");
      const d = result.raw?.data || result.raw || {};
      const status = String(d.status || "PENDING").toLowerCase();
      const codes = status === "completed" ? (d.cardCodes || d.codes || null) : null;
      await query(
        `UPDATE giftcard_buy_orders SET provider_reference = $2, status = $3, provider_response = $4::jsonb,
         card_codes = $5::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [dbInsert.rows[0].id, result.reference || null, status, JSON.stringify(result.raw || result), codes ? JSON.stringify(codes) : null],
      );
      res.status(201).json({
        success: true,
        message: status === "completed" ? "Purchase complete — codes delivered!" : "Order placed — codes arrive as soon as fulfilment completes.",
        data: { reference: result.reference || reference, status },
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
        [dbInsert.rows[0].id, String(providerError?.message || providerError).slice(0, 500)],
      );
      res.status(502).json({ success: false, error: String(providerError?.message || providerError) });
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
        codes = remote?.cardCodes || remote?.codes || (Array.isArray(remote) ? remote : remote?.data || null) || null;
        if (codes) {
          await query(`UPDATE giftcard_buy_orders SET card_codes = $2::jsonb, status = CASE WHEN status != 'completed' THEN 'completed' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [order.id, JSON.stringify(codes)]);
        }
      } catch { /* keep null */ }
    }
    res.json({ success: true, data: { status: order.status, codes } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not fetch card codes" });
  }
});

export default router;
