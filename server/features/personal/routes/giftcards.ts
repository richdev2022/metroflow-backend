import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  assertPersonalService, genRef, requirePersonalKyc,
} from "../personal-utils";
import { calculateFee, creditRevenueWallet } from "../../../services/fees";
import * as prestmit from "../../../services/prestmit";
import * as sogo from "../../../services/sogo";
import { userSafeErr } from "../user-safe-errors";
import { getActiveProvider } from "../provider-routing";
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

/**
 * PROVIDER ROUTING — giftcards: "sogo" (default) | "prestmit" | "simulator".
 * Every endpoint below dispatches on this; the frontend contract is stable
 * across providers. Sogo catalog entries use string ids (slug / product_id),
 * Prestmit entries keep numeric ids — `giftcard_id` / `giftCardSKU` are
 * passed through opaquely and validated per active provider.
 */
async function activeGiftcardProvider() {
  return getActiveProvider("giftcards");
}


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
  // Provider column (sogo | prestmit) — idempotent backfill for rows created
  // before routing existed.
  await query(`ALTER TABLE giftcard_sell_trades ADD COLUMN IF NOT EXISTS provider VARCHAR(20)`);
  await query(`ALTER TABLE giftcard_buy_orders ADD COLUMN IF NOT EXISTS provider VARCHAR(20)`);
  await query(`UPDATE giftcard_sell_trades SET provider = 'prestmit' WHERE provider IS NULL`);
  await query(`UPDATE giftcard_buy_orders SET provider = 'prestmit' WHERE provider IS NULL`);
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
  const provider = await activeGiftcardProvider();
  res.json({
    success: true,
    data: {
      provider,
      configured:
        provider === "sogo" ? sogo.isSogoConfigured()
        : provider === "prestmit" ? prestmit.isPrestmitConfigured()
        : true,
      prestmit: {
        configured: prestmit.isPrestmitConfigured(),
        sandbox: prestmit.isPrestmitSandbox(),
        key_kind: prestmit.prestmitKeyKind(),
        provider_host: prestmit.prestmitBaseUrl(),
      },
      sogo: sogo.sandboxInfo(),
    },
  });
});

// ---------------------------------------------------------------------------
// SELL — catalogue + lookups
// ---------------------------------------------------------------------------

/**
 * Normalize the Sogo sell catalog (brands) into the unified giftcard entry
 * shape: { id, provider, name, image, country_code, currency, card_types,
 * sub_types, min_amount, max_amount, rate_ngn (ecode NGN rate), form }.
 */
function normalizeSogoSellEntry(entry: any): any {
  const countries = Array.isArray(entry.countries) ? entry.countries : [];
  const first = countries[0] || {};
  // ecode NGN rate for the brand's first country/currency — display hint only.
  let rateNgn: number | null = null;
  try {
    const cur = String(first.currency || "USD");
    const rateEntry = entry?.__rates?.[cur] || null;
    if (rateEntry) rateNgn = typeof rateEntry.ecode === "object" ? Number(rateEntry.ecode?.NGN) : Number(rateEntry.ecode) || null;
  } catch { /* display hint only */ }
  return {
    id: String(entry.slug || ""),
    provider: "sogo",
    name: String(entry.name || entry.slug || "Gift card"),
    image: entry.logo_url || null,
    country_code: first.code || null,
    country_label: first.label || null,
    currency: first.currency || "USD",
    countries,
    card_types: entry.card_types || [],
    sub_types: entry.sub_types || [],
    min_amount: entry.min_amount != null ? Number(entry.min_amount) : null,
    max_amount: entry.max_amount != null ? Number(entry.max_amount) : null,
    rate_ngn: rateNgn,
    form: "code",
    terms: entry.redeem_instruction?.concise || null,
  };
}

router.get("/sell/catalog", authenticateToken, checkSubscriptionStatus, async (_req, res) => {
  const provider = await activeGiftcardProvider();
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    if (provider === "sogo") {
      const [catalog, rates] = await Promise.all([
        sogo.giftcardSellCatalog(),
        sogo.giftcardSellRates().catch(() => null),
      ]);
      const rateBySlug = new Map<string, any>();
      for (const r of Array.isArray(rates) ? rates : []) rateBySlug.set(String(r.slug), r.rates || r);
      const giftcards = (catalog || []).map((entry: any) =>
        normalizeSogoSellEntry({ ...entry, __rates: rateBySlug.get(String(entry.slug)) }));
      return res.json({ success: true, provider, giftcards });
    }
    // Prestmit (legacy shape preserved)
    const data = await prestmit.sellRateCalculatorData();
    const subs = data?.sellableGiftcards || [];
    const cats = new Map<number, string>((data?.giftCardCategories || []).map((c: any) => [c.id, c.name]));
    const giftcards = subs
      .filter((s: any) => s?.id != null)
      .map((s: any) => ({
        id: Number(s.id),
        provider: "prestmit",
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
      provider,
      giftcards,
      rate_conversions: data?.rateConversions || null,
      payout_methods: data?.sellGiftcardPayoutMethods || null,
    });
  } catch (e: any) {
    console.error("gc sell catalog error:", e?.message);
    res.status(502).json({ success: false, error: userSafeErr(provider === "prestmit" ? prestmit.prestmitErr(e) : sogo.sogoErr(e)) });
  }
});

router.get("/sell/categories", authenticateToken, async (_req, res) => {
  try {
    const cats = await prestmit.sellCategories();
    res.json({ success: true, categories: cats });
  } catch (e: any) {
    res.status(502).json({ success: false, error: userSafeErr(prestmit.prestmitErr(e)) });
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
    res.status(502).json({ success: false, error: userSafeErr(prestmit.prestmitErr(e)) });
  }
});

router.get("/sell/countries", authenticateToken, async (_req, res) => {
  try {
    const provider = await activeGiftcardProvider();
    if (provider === "sogo") {
      const catalog = await sogo.giftcardSellCatalog();
      const seen = new Map<string, any>();
      for (const brand of catalog || []) {
        for (const c of brand.countries || []) {
          if (c?.code && !seen.has(String(c.code))) {
            seen.set(String(c.code), { code: c.code, label: c.label || c.code, currency: c.currency || null });
          }
        }
      }
      return res.json({ success: true, provider, countries: Array.from(seen.values()) });
    }
    const countries = await prestmit.sellCountries();
    res.json({ success: true, provider, countries });
  } catch (e: any) {
    res.status(502).json({ success: false, error: userSafeErr(prestmit.prestmitErr(e)) });
  }
});

router.get("/sell/payout-methods", authenticateToken, async (_req, res) => {
  try {
    const methods = await prestmit.sellPayoutMethods();
    res.json({ success: true, payout_methods: methods });
  } catch (e: any) {
    res.status(502).json({ success: false, error: userSafeErr(prestmit.prestmitErr(e)) });
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

router.post("/sell", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, uploadCardMedia, async (req: AuthenticatedRequest, res) => {
  const provider = await activeGiftcardProvider();
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    const userId = req.user!.userId;
    const amount = Number(req.body?.amount);
    const payoutMethod = String(req.body?.payout_method || "NAIRA").toUpperCase();
    const comments = req.body?.comments ? String(req.body.comments).slice(0, 1000) : undefined;
    const rawId = String(req.body?.giftcard_id || "").trim();
    if (!rawId || !Number.isFinite(amount) || amount <= 0) {
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

    // Upload card photos to our storage, then attach to the provider call.
    const files = (req.files as any[]) || [];
    const stored: Array<{ url: string; buffer?: Buffer; mime?: string; filename?: string }> = [];
    for (const f of files.slice(0, 10)) {
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

    const reference = genRef("MF-GCS");
    let giftcardName = `Gift card ${rawId}`;

    if (provider === "sogo") {
      // ---- SOGO SELL (slug-based; ecode needs the code text, physical needs images) ----
      const cardType = String(req.body?.card_type || "").toLowerCase() === "physical" ? "physical" : "ecode";
      const cardCountry = String(req.body?.card_country || "").trim().toUpperCase();
      const cardCurrency = String(req.body?.card_currency || "").trim().toUpperCase();
      const subType = req.body?.sub_type ? String(req.body.sub_type).trim() : undefined;
      const ecode = req.body?.additional_info ? String(req.body.additional_info).trim() : undefined;
      const images = stored.filter((s) => s.buffer);
      if (!cardCountry || !cardCurrency) {
        return res.status(400).json({ success: false, error: "card_country and card_currency are required (from the card's catalog entry)" });
      }
      if (cardType === "ecode" && !ecode) {
        return res.status(400).json({ success: false, error: "additional_info (the e-code text) is required for e-code cards" });
      }
      if (cardType === "physical" && images.length === 0) {
        return res.status(400).json({ success: false, error: "Attach 1-5 photos of the physical card (and receipt when available)" });
      }

      const catalog = await sogo.giftcardSellCatalog().catch(() => []);
      const brand = (catalog || []).find((c: any) => String(c.slug) === rawId);
      if (!brand) {
        return res.status(400).json({ success: false, error: `Unknown gift card brand "${rawId}" — refresh the catalog and try again` });
      }
      giftcardName = String(brand.name || rawId);

      const dbInsert = await query(
        `INSERT INTO giftcard_sell_trades
           (user_id, wallet_id, reference, provider, giftcard_id, giftcard_name, amount, payout_method,
            status, comments, attachments)
         VALUES ($1,$2,$3,'sogo',$4,$5,$6,$7,'pending',$8,$9::jsonb) RETURNING *`,
        [userId, walletId, reference, rawId, giftcardName, amount, payoutMethod,
         comments || null, JSON.stringify(stored.map((s) => s.url))],
      );

      try {
        const result = await sogo.giftcardSell({
          slug: rawId,
          card_country: cardCountry,
          card_type: cardType as "ecode" | "physical",
          sub_type: subType,
          card_currency: cardCurrency,
          card_amount: amount,
          additional_info: ecode,
          images: cardType === "physical"
            ? images.map((s) => ({ buffer: s.buffer!, filename: s.filename!, contentType: s.mime }))
            : undefined,
          payout_currency: "NGN",
          reference,
        });
        const tx = result?.transaction || result || {};
        const status = sogo.sogoStatus(tx) || "pending";
        await query(
          `UPDATE giftcard_sell_trades
           SET provider_reference = $2, status = $3, provider_response = $4::jsonb, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [dbInsert.rows[0].id, sogo.sogoReference(result) || reference, status, JSON.stringify(result)],
        );
        return res.status(201).json({
          success: true,
          provider,
          message: "Trade submitted — you'll be paid once it's reviewed.",
          data: { reference: tx.reference || reference, status },
        });
      } catch (providerError: any) {
        await query(
          `UPDATE giftcard_sell_trades SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [dbInsert.rows[0].id, sogo.sogoErr(providerError)],
        );
        return res.status(502).json({ success: false, error: sogo.sogoErr(providerError) });
      }
    }

    // ---- PRESTMIT SELL (numeric ids) -------------------------------------
    const giftcardId = Number(rawId);
    if (!Number.isFinite(giftcardId)) {
      return res.status(400).json({ success: false, error: "giftcard_id must be the numeric catalog id for the active provider" });
    }
    if (!stored.length && !comments) {
      return res.status(400).json({ success: false, error: "Attach a photo of the gift card or paste the eCode" });
    }

    const nameLookup = await prestmit.sellRateCalculatorData().catch(() => null);
    const gc = (nameLookup?.sellableGiftcards || []).find((s: any) => Number(s.id) === giftcardId);
    giftcardName = gc?.name || giftcardName;

    const dbInsert = await query(
      `INSERT INTO giftcard_sell_trades
         (user_id, wallet_id, reference, provider, giftcard_id, giftcard_name, amount, payout_method,
          status, comments, attachments)
       VALUES ($1,$2,$3,'prestmit',$4,$5,$6,$7,'pending',$8,$9::jsonb) RETURNING *`,
      [userId, walletId, reference, String(giftcardId), giftcardName, amount, payoutMethod,
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
        provider,
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
 * Settle ONE sell trade from live PROVIDER state: credit the user wallet
 * (payout minus our sell fee) when the provider approves, or mark the trade
 * rejected with the provider's reason. Shared by the sync endpoint and the
 * webhook path. Dispatches on trade.provider (sogo | prestmit).
 */
export async function settleSellTradeFromProvider(tradeId: string): Promise<{ updated: boolean; status: string }> {
  const r = await query(`SELECT * FROM giftcard_sell_trades WHERE id = $1`, [tradeId]);
  const trade = r.rows[0];
  if (!trade || trade.status === "settled") return { updated: false, status: trade?.status || "pending" };
  if (!trade.provider_reference) return { updated: false, status: trade.status };

  // ---- SOGO: transaction-status settlement -----------------------------
  if ((trade.provider || "prestmit") === "sogo") {
    const remote = await sogo.getTransaction(trade.provider_reference).catch(() => null);
    if (!remote) return { updated: false, status: trade.status };
    const pStatus = sogo.sogoStatus(remote?.transaction || remote);
    if (pStatus === "completed") {
      const gross = Number(remote?.payout_amount ?? remote?.amount ?? trade.payout_amount ?? 0);
      const feePct = await sellFeePercent();
      const fee = Math.round(gross * (feePct / 100) * 100) / 100;
      const net = Math.max(0, Math.round((gross - fee) * 100) / 100);
      if (net > 0 && trade.wallet_id) {
        await creditWallet(trade.wallet_id, net);
        await insertTransaction({
          userId: trade.user_id, businessId: trade.business_id, walletId: trade.wallet_id,
          reference: `GCSP-${trade.reference}`, type: "credit", transactionType: "giftcard_sell",
          amount: net, currency: trade.currency || "NGN", fee,
          description: `Gift card sale payout — ${trade.giftcard_name || "card"}`,
        });
        if (fee > 0) {
          await creditRevenueWallet(fee, trade.currency || "NGN", `GCSP-${trade.reference}`, "Gift card sell fee", "giftcards").catch(() => {});
        }
      }
      await query(
        `UPDATE giftcard_sell_trades SET status = 'settled', credited_at = CURRENT_TIMESTAMP,
           payout_amount = GREATEST(payout_amount, $2), provider_response = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [trade.id, gross, JSON.stringify(remote)],
      );
      try {
        await createNotification({
          businessId: String(trade.business_id || ""), userId: String(trade.user_id),
          type: "credit", title: "Gift card sale approved",
          message: `₦${net.toLocaleString()} has been credited for your ${trade.giftcard_name || "gift card"} sale.`,
          actionUrl: "/giftcards", actionType: "view_transaction",
          metadata: { reference: trade.reference }, isActionable: false, expiresInHours: 168,
        });
      } catch { /* best effort */ }
      return { updated: true, status: "settled" };
    }
    if (pStatus === "cancelled" || pStatus === "failed") {
      await query(
        `UPDATE giftcard_sell_trades SET status = $2, rejection_reason = $3,
           provider_response = $4::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [trade.id, pStatus === "cancelled" ? "rejected" : "failed",
         String(remote?.failure_reason || remote?.reason || "Rejected by review").slice(0, 500), JSON.stringify(remote)],
      );
      try {
        await createNotification({
          businessId: String(trade.business_id || ""), userId: String(trade.user_id),
          type: "system", title: "Gift card sale update",
          message: `Your ${trade.giftcard_name || "gift card"} sale was not completed. ${remote?.failure_reason || ""}`.trim(),
          actionUrl: "/giftcards", actionType: "view_transaction",
          metadata: { reference: trade.reference }, isActionable: false, expiresInHours: 168,
        });
      } catch { /* best effort */ }
      return { updated: true, status: pStatus === "cancelled" ? "rejected" : "failed" };
    }
    return { updated: false, status: trade.status };
  }

  // ---- PRESTMIT: sell-history settlement --------------------------------
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
    const tradeRow = await query(`SELECT provider FROM giftcard_sell_trades WHERE id = $1`, [row.rows[0].id]);
    const provider = tradeRow.rows[0]?.provider || "prestmit";
    if (provider === "sogo" && sogo.isSogoSandbox()) {
      // Sandbox does not persist transactions — status lives in the create
      // response / webhook only.
      const cur = await query(`SELECT status FROM giftcard_sell_trades WHERE id = $1`, [row.rows[0].id]);
      return res.json({ success: true, data: { updated: false, status: cur.rows[0]?.status || "pending" } });
    }
    const result = await settleSellTradeFromProvider(row.rows[0].id);
    const updated = await query(`SELECT status FROM giftcard_sell_trades WHERE id = $1`, [row.rows[0].id]);
    res.json({ success: true, data: { ...result, status: updated.rows[0]?.status || result.status } });
  } catch (e: any) {
    res.status(502).json({ success: false, error: userSafeErr(prestmit.prestmitErr(e)) });
  }
});

// ---------------------------------------------------------------------------
// BUY
// ---------------------------------------------------------------------------
router.get("/buy/catalog", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  const provider = await activeGiftcardProvider();
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 25, 1), 25);
    const search = String(req.query.search || "").trim().toLowerCase();
    const countryFilter = String(req.query.countryCode || req.query.currencyCode || "").trim().toUpperCase();

    if (provider === "sogo") {
      // Sogo REQUIRES country_code on /buy/products — fan out across the
      // country list (bounded) when no filter is supplied, then merge.
      const raw = await sogo.giftcardBuyProducts({
        country_code: countryFilter || undefined,
        search: search || undefined,
        page,
      });
      let products: any[] = Array.isArray(raw) ? raw : (raw?.data || raw?.products || []);
      if (search) {
        products = products.filter((p) =>
          String(p.product_name || p.brand_name || "").toLowerCase().includes(search)
          || String(p.category_name || "").toLowerCase().includes(search));
      }
      const giftcards = products.map((p: any) => ({
        sku: String(p.product_id),
        provider: "sogo",
        title: p.product_name || p.brand_name || `Product ${p.product_id}`,
        brand: p.brand_name || null,
        description: p.redeem_instruction?.concise || null,
        image: (p.logo_urls || [])[0] || null,
        min_price: p.min_recipient_denomination != null ? Number(p.min_recipient_denomination) : (p.fixed_recipient_denominations?.[0] != null ? Number(p.fixed_recipient_denominations[0]) : 0),
        max_price: p.max_recipient_denomination != null ? Number(p.max_recipient_denomination) : (p.fixed_recipient_denominations?.slice(-1)?.[0] != null ? Number(p.fixed_recipient_denominations.slice(-1)[0]) : 0),
        denomination_type: p.denomination_type || null,
        denominations: p.fixed_recipient_denominations || [],
        currency: p.currency_code || "USD",
        category: p.category_name || null,
        country_code: p.country_code || null,
        country_name: p.country_name || null,
        country_flag_url: p.country_flag_url || null,
      }));
      return res.json({
        success: true,
        provider,
        enabled: true,
        payment_methods: ["NAIRA"],
        giftcards,
        page,
        total: giftcards.length,
        total_pages: 1,
      });
    }

    // ---- Prestmit (legacy shape preserved) --------------------------------
    const [cfg, catalogPage] = await Promise.all([
      prestmit.buyConfig().catch(() => null),
      prestmit.fetchBuyableGiftcards({ currencyCode: countryFilter || undefined, page, perPage }),
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
      provider,
      enabled: cfg ? cfg.enabled !== false : true,
      payment_methods: cfg?.paymentMethods || ["NAIRA", "CEDIS"],
      payment_methods_all: cfg?.paymentMethodsAll || cfg?.paymentMethodsAvailability || null,
      giftcards: cards.map((c: any) => ({
        sku: c.sku,
        provider: "prestmit",
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
    res.status(502).json({ success: false, error: userSafeErr(provider === "prestmit" ? prestmit.prestmitErr(e) : sogo.sogoErr(e)) });
  }
});

router.get("/buy/currencies", authenticateToken, async (_req, res) => {
  const provider = await activeGiftcardProvider();
  try {
    if (provider === "sogo") {
      const countries = await sogo.giftcardBuyCountries();
      const currencies = Array.from(new Set((countries || []).map((c: any) => c.currency_code).filter(Boolean)));
      return res.json({ success: true, provider, currencies, countries });
    }
    const currencies = await prestmit.buyCurrencies();
    res.json({ success: true, provider, currencies });
  } catch (e: any) {
    res.status(502).json({ success: false, error: userSafeErr(provider === "prestmit" ? prestmit.prestmitErr(e) : sogo.sogoErr(e)) });
  }
});

// Contract note: the personal-web client reads the quote from r.data ITSELF
// (no data wrapper) — { partner_total, fee, total, isAvailable }.
router.post("/buy/calculate", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  const provider = await activeGiftcardProvider();
  try {
    const sku = String(req.body?.giftCardSKU || "").trim();
    const price = Number(req.body?.price);
    const quantity = Math.max(1, Number(req.body?.quantity) || 1);
    if (!sku || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, error: "giftCardSKU and a positive price are required" });
    }
    let naira = 0;
    let available = true;
    let raw: any = null;
    if (provider === "sogo") {
      raw = await sogo.giftcardBuyCalculate(Number(sku), price, quantity);
      naira = Number(raw?.total_price_ngn ?? 0);
    } else {
      const [q, ok] = await Promise.all([
        prestmit.buyCalculate(Number(sku), price, quantity),
        prestmit.buyCheckAvailability(Number(sku), price, quantity).catch(() => true),
      ]);
      raw = q;
      naira = Number(q?.NAIRA ?? q?.totalPaymentAmount ?? 0);
      available = ok && q?.isAvailable !== false;
    }
    const feePct = await buyFeePercent();
    const fee = Math.round(naira * (feePct / 100) * 100) / 100;
    const total = Math.round((naira + fee) * 100) / 100;
    res.json({ ...raw, partner_total: naira, fee, total, isAvailable: available && raw?.isAvailable !== false });
  } catch (e: any) {
    console.error("gc calculate error:", e?.message);
    res.status(502).json({ success: false, error: userSafeErr(provider === "prestmit" ? prestmit.prestmitErr(e) : sogo.sogoErr(e)) });
  }
});

router.post("/buy", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  const provider = await activeGiftcardProvider();
  try {
    if (!(await assertPersonalService(res, "giftcards"))) return;
    await ensureSchema();
    const userId = req.user!.userId;
    const sku = String(req.body?.giftCardSKU || "").trim();
    const price = Number(req.body?.price);
    const quantity = Math.max(1, Number(req.body?.quantity) || 1);
    const giftcardName = String(req.body?.giftcard_name || `SKU ${sku}`).slice(0, 160);
    if (!sku || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, error: "giftCardSKU and a positive price are required" });
    }

    const wallet = await getOwnedWallet(String(req.body?.wallet_id || ""), userId, req.user!.businessId ?? null);
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
    if (wallet.currency !== "NGN") {
      return res.status(400).json({ success: false, error: "Gift card purchases are charged in NGN — use your Naira wallet." });
    }

    // ---- Quote + fee (exact provider total — never trust client math) ----
    let partnerTotal = 0;
    if (provider === "sogo") {
      const q = await sogo.giftcardBuyCalculate(Number(sku), price, quantity);
      partnerTotal = Number(q?.total_price_ngn ?? 0);
    } else if (provider === "prestmit") {
      const [q, ok] = await Promise.all([
        prestmit.buyCalculate(Number(sku), price, quantity),
        prestmit.buyCheckAvailability(Number(sku), price, quantity).catch(() => true),
      ]);
      if (!ok || q?.isAvailable === false) {
        return res.status(400).json({ success: false, error: "This gift card is currently out of stock" });
      }
      partnerTotal = Number(q?.NAIRA ?? q?.totalPaymentAmount ?? 0);
    } else {
      // simulator — FX-ish estimate
      partnerTotal = Math.round(price * quantity * 1550);
    }
    if (!(partnerTotal > 0)) {
      return res.status(400).json({ success: false, error: "Could not price this order — check the card and try again" });
    }
    const feePct = await buyFeePercent();
    const fee = Math.round(partnerTotal * (feePct / 100) * 100) / 100;
    const total = Math.round((partnerTotal + fee) * 100) / 100;
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
         (user_id, wallet_id, reference, provider, giftcard_sku, giftcard_name, quantity, card_price, fee, total_charged,
          currency, payment_method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'NAIRA','pending') RETURNING id`,
      [userId, wallet.id, reference, provider, String(sku), giftcardName, quantity, price, fee, total, wallet.currency],
    );
    const orderId = dbInsert.rows[0].id;

    const refundAndFail = async (message: string) => {
      await creditWallet(wallet.id, total);
      await insertTransaction({
        userId, businessId: wallet.business_id, walletId: wallet.id,
        reference: `${reference}-REFUND`, type: "credit", transactionType: "giftcard_buy_refund",
        amount: total, currency: wallet.currency, description: `Refund — gift card order failed`,
      });
      await query(
        `UPDATE giftcard_buy_orders SET status = 'failed', failure_reason = $2, refunded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [orderId, String(message).slice(0, 500)],
      );
    };

    try {
      if (provider === "sogo") {
        // Slippage guard: expected_amount_ngn = the exact calculate total.
        const result = await sogo.giftcardBuy({
          product_id: Number(sku), amount: price, quantity,
          expected_amount_ngn: partnerTotal, reference,
        });
        const d = result?.transaction || result || {};
        const status = sogo.sogoStatus(d) || "processing";
        const mapped = ["completed", "processing", "refunded", "cancelled", "failed"].includes(status) ? status : "processing";
        const codes = mapped === "completed" ? (d.gift_card_codes || d.codes || null) : null;
        await query(
          `UPDATE giftcard_buy_orders SET provider_reference = $2, status = $3, provider_response = $4::jsonb,
           card_codes = $5::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [orderId, d.reference || reference, mapped, JSON.stringify(result), codes ? JSON.stringify(codes) : null],
        );
        if (mapped === "refunded" || mapped === "cancelled" || mapped === "failed") {
          await refundAndFail(String(d.failure_reason || "The partner rejected this order"));
          return res.status(502).json({ success: false, error: `${d.failure_reason || "The partner rejected this order"} — your wallet has been refunded.` });
        }
        if (fee > 0) creditRevenueWallet(fee, "NGN", reference, "Gift card buy fee", "giftcards").catch(() => {});
        return res.status(201).json({
          success: true,
          provider,
          message: mapped === "completed" ? "Purchase complete — codes delivered!" : "Order placed — codes arrive as soon as fulfilment completes.",
          data: { reference: d.reference || reference, status: mapped },
        });
      }

      if (provider === "prestmit") {
        const accountPin = process.env.PRESTMIT_ACCOUNT_PIN || "";
        if (!accountPin) {
          await refundAndFail("Prestmit account PIN not configured");
          return res.status(503).json({
            success: false, code: "PRESTMIT_PIN_MISSING",
            error: "Gift card purchases are being set up — the partner account PIN is not configured yet. Your wallet has been refunded.",
          });
        }
        const result = await prestmit.createBuyTrade({
          giftCardSKU: Number(sku), price, quantity, paymentMethod: "NAIRA",
          accountPin, uniqueIdentifier: reference,
        });
        if (!result.ok) throw new Error(result.message || "Buy trade rejected");
        const d = result.raw?.data || result.raw || {};
        const status = String(d.status || "PENDING").toLowerCase();
        const codes = status === "completed" ? (d.cardCodes || d.codes || null) : null;
        await query(
          `UPDATE giftcard_buy_orders SET provider_reference = $2, status = $3, provider_response = $4::jsonb,
           card_codes = $5::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [orderId, result.reference || null, status, JSON.stringify(result.raw || result), codes ? JSON.stringify(codes) : null],
        );
        if (fee > 0) creditRevenueWallet(fee, "NGN", reference, "Gift card buy fee", "giftcards").catch(() => {});
        return res.status(201).json({
          success: true,
          provider,
          message: status === "completed" ? "Purchase complete — codes delivered!" : "Order placed — codes arrive as soon as fulfilment completes.",
          data: { reference: result.reference || reference, status },
        });
      }

      // ---- SIMULATOR ----
      const codes = [{ code: `SIM-${Date.now()}`, pin: "1234", serial: `SIMSERIAL-${reference}` }];
      await query(
        `UPDATE giftcard_buy_orders SET provider_reference = $2, status = 'completed', provider_response = $3::jsonb,
         card_codes = $4::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [orderId, `SIM-${reference}`, JSON.stringify({ simulator: true }), JSON.stringify(codes)],
      );
      if (fee > 0) creditRevenueWallet(fee, "NGN", reference, "Gift card buy fee", "giftcards").catch(() => {});
      return res.status(201).json({
        success: true, provider,
        message: "Purchase complete — codes delivered!",
        data: { reference, status: "completed" },
      });
    } catch (providerError: any) {
      await refundAndFail(providerError?.message || providerError);
      return res.status(502).json({ success: false, error: String(providerError?.message || providerError) });
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
        if ((order.provider || "prestmit") === "sogo") {
          // Sogo never leaks codes in webhooks — fetch via the Transactions API.
          const remote = await sogo.getTransaction(order.provider_reference);
          codes = remote?.gift_card_codes || remote?.codes || null;
          if (codes) {
            await query(
              `UPDATE giftcard_buy_orders SET card_codes = $2::jsonb, status = CASE WHEN status != 'completed' THEN 'completed' ELSE status END, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [order.id, JSON.stringify(codes)],
            );
          }
        } else {
          const remote = await prestmit.fetchCardCodes(order.provider_reference);
          codes = remote?.cardCodes || remote?.codes || (Array.isArray(remote) ? remote : remote?.data || null) || null;
          if (codes) {
            await query(`UPDATE giftcard_buy_orders SET card_codes = $2::jsonb, status = CASE WHEN status != 'completed' THEN 'completed' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [order.id, JSON.stringify(codes)]);
          }
        }
      } catch { /* keep null */ }
    }
    res.json({ success: true, data: { status: order.status, codes } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not fetch card codes" });
  }
});

/**
 * Background sweep for SOGO giftcard orders (called from the index.ts
 * poller): settle sell trades (credit wallets on completion) and pull codes
 * for completed buy orders. Safe to run concurrently — every write is
 * guarded by status transitions.
 */
export async function processSogoGiftcardSync(): Promise<void> {
  if (!sogo.isSogoConfigured() || sogo.isSogoSandbox()) return;
  try {
    const sells = await query(
      `SELECT id FROM giftcard_sell_trades WHERE provider = 'sogo' AND status IN ('pending','processing') ORDER BY created_at ASC LIMIT 25`,
    );
    for (const t of sells.rows) {
      await settleSellTradeFromProvider(t.id).catch(() => {});
    }
    const buys = await query(
      `SELECT id, provider_reference, status FROM giftcard_buy_orders WHERE provider = 'sogo' AND status IN ('pending','processing') ORDER BY created_at ASC LIMIT 25`,
    );
    for (const b of buys.rows) {
      try {
        const remote = await sogo.getTransaction(b.provider_reference);
        const status = sogo.sogoStatus(remote?.transaction || remote);
        const codes = remote?.gift_card_codes || remote?.codes || null;
        if (status === "completed" || codes) {
          await query(
            `UPDATE giftcard_buy_orders SET status = 'completed', card_codes = COALESCE($2::jsonb, card_codes), settled_at = CURRENT_TIMESTAMP, provider_response = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [b.id, codes ? JSON.stringify(codes) : null, JSON.stringify(remote)],
          );
        } else if (["refunded", "cancelled", "failed"].includes(status)) {
          const o = await query(`SELECT * FROM giftcard_buy_orders WHERE id = $1`, [b.id]);
          if (o.rows[0] && o.rows[0].status !== "failed") {
            await creditWallet(o.rows[0].wallet_id, Number(o.rows[0].total_charged));
            await insertTransaction({
              userId: o.rows[0].user_id, businessId: o.rows[0].business_id, walletId: o.rows[0].wallet_id,
              reference: `${o.rows[0].reference}-REFUND`, type: "credit", transactionType: "giftcard_buy_refund",
              amount: Number(o.rows[0].total_charged), currency: o.rows[0].currency,
              description: "Refund — gift card order failed",
            });
            await query(
              `UPDATE giftcard_buy_orders SET status = 'failed', failure_reason = $2, refunded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [b.id, String(remote?.failure_reason || status).slice(0, 500)],
            );
          }
        }
      } catch { /* still unfulfilled — retry next sweep */ }
    }
  } catch (e: any) {
    console.warn("[giftcards] sogo sync failed:", e?.message);
  }
}

export default router;
