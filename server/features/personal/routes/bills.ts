import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  assertPersonalService, genRef, requirePersonalKyc, verifyTransactionPin,
} from "../personal-utils";
import { calculateFee, creditRevenueWallet } from "../../../services/fees";
import { createNotification } from "../../../services/notifications";
import * as sogo from "../../../services/sogo";
import { userSafeErr } from "../user-safe-errors";
import * as flwBills from "../flutterwave-bills";
import { getActiveProvider, providerLabel } from "../provider-routing";

/**
 * BILLS HUB — UNIFIED multi-provider bill payments (MetriCorex Personal).
 * Mounted at /bills (replaces the dormant single-provider router).
 *
 * The frontend talks ONLY to these endpoints; the PROVIDER ROUTING layer
 * (personal_provider_routing, default "sogo") decides who fulfils each
 * request. Switching providers never changes this API surface.
 *
 * Providers:
 *   sogo        — full 7-category VTU integration (airtime, data,
 *                 electricity ×12 DisCos, cable TV, education JAMB/WAEC,
 *                 ePIN, betting ×14 platforms) + verify-before-you-pay.
 *   flutterwave — classic v3 bridge (bill-categories + POST /bills).
 *   simulator   — instant local settlement (sandbox / incident mode).
 *
 *   GET  /bills/status                          → routing + configured state
 *   GET  /bills/catalog?type=                   → all categories + providers
 *   GET  /bills/data-plans?network=             → data variation codes
 *   GET  /bills/cable-packages?provider=        → DStv/GoTV/StarTimes packages
 *   GET  /bills/education-plans                 → JAMB/WAEC plans
 *   GET  /bills/discount-rates                  → per-category discounts
 *   GET  /bills/epin-stock                      → ePIN availability matrix
 *   GET  /bills/epin/vouchers/:id/image         → WebP voucher image (binary)
 *   POST /bills/verify-meter                    → electricity customer lookup
 *   POST /bills/verify-smartcard                → cable subscriber lookup
 *   POST /bills/verify-jamb                     → JAMB profile lookup
 *   POST /bills/verify-betting                  → betting account lookup
 *   POST /bills/pay                             → UNIFIED purchase (all categories)
 *   GET  /bills/history                         → my bill payments
 *   GET  /bills/transactions/:reference         → detail + tokens/codes
 *   POST /bills/transactions/:reference/sync    → poll provider, settle refund
 *
 * Money: wallet debit = amount + fee (fee_configurations 'bill', ₦50 flat by
 * default, plan-discounted). Fee lands in the platform revenue wallet. Every
 * payment is double-entered through the transactions ledger. Failures after
 * debit auto-refund the wallet.
 */

const router = express.Router();

// ---------------------------------------------------------------------------
// Schema (idempotent)
// ---------------------------------------------------------------------------
export async function ensureBillTransactionsSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS bill_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID NOT NULL,
      wallet_id UUID,
      reference VARCHAR(80) UNIQUE NOT NULL,
      provider VARCHAR(20) NOT NULL DEFAULT 'sogo',       -- sogo|flutterwave|simulator
      provider_reference VARCHAR(120),
      category VARCHAR(24) NOT NULL,                      -- airtime|data|electricity|cable|education|epin|betting
      provider_slug VARCHAR(40),
      customer_ref VARCHAR(120),                          -- phone | meter | smartcard | profile | betting id
      amount DECIMAL(15,2) NOT NULL,
      fee DECIMAL(15,2) DEFAULT 0,
      total DECIMAL(15,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      status VARCHAR(24) DEFAULT 'processing',            -- processing|completed|failed|refunded|cancelled
      details JSONB,                                      -- plan/variation/network + delivered tokens/codes
      failure_reason TEXT,
      provider_response JSONB,
      settled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_bill_tx_user ON bill_transactions(user_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bill_tx_status ON bill_transactions(status, category)`);
}

const CATEGORIES = ["airtime", "data", "electricity", "cable", "education", "epin", "betting"] as const;
type BillCategory = (typeof CATEGORIES)[number];

function normalizeStatus(raw: any): string {
  const s = String(raw || "").toLowerCase();
  if (["completed", "successful", "success", "delivered"].includes(s)) return "completed";
  if (["processing", "pending", "initiated", "ongoing"].includes(s)) return "processing";
  if (["failed", "failure"].includes(s)) return "failed";
  if (["refunded", "reversed"].includes(s)) return "refunded";
  if (["cancelled", "canceled"].includes(s)) return "cancelled";
  return "processing";
}

function publicRow(r: any) {
  return {
    id: r.id,
    reference: r.reference,
    provider: r.provider,
    category: r.category,
    provider_slug: r.provider_slug,
    customer_ref: r.customer_ref,
    amount: Number(r.amount),
    fee: Number(r.fee),
    total: Number(r.total),
    currency: r.currency || "NGN",
    status: r.status,
    details: r.details || null,
    failure_reason: r.failure_reason,
    created_at: r.created_at,
    settled_at: r.settled_at,
  };
}

async function billFee(): Promise<number> {
  try {
    return await calculateFee(0, "bill"); // flat fee — amount-independent
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Status / catalogue
// ---------------------------------------------------------------------------
router.get("/status", authenticateToken, async (_req, res) => {
  const provider = await getActiveProvider("bills");
  res.json({
    success: true,
    data: {
      provider,
      provider_label: providerLabel("bills", provider),
      sogo: sogo.sandboxInfo(),
      flutterwave: { configured: flwBills.isFlutterwaveBillsConfigured() },
    },
  });
});

router.get("/catalog", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  try {
    if (!(await assertPersonalService(res, "bills"))) return;
    const type = String(req.query.type || "").trim() || undefined;
    const provider = await getActiveProvider("bills");

    if (provider === "sogo") {
      const catalog = await sogo.billsCatalog(type);
      return res.json({
        success: true,
        provider,
        categories: Array.isArray(catalog) ? catalog : (catalog as any)?.types || [],
      });
    }
    if (provider === "flutterwave") {
      const cats = await flwBills.getBillCategories();
      return res.json({ success: true, provider, categories: cats });
    }
    // Simulator — static 7-category catalog.
    return res.json({
      success: true,
      provider,
      categories: [
        { type: "airtime", name: "Airtime", providers: [
          { slug: "mtn", name: "MTN Nigeria", label: "MTN" }, { slug: "airtel", name: "Airtel Nigeria", label: "Airtel" },
          { slug: "glo", name: "Globacom", label: "Glo" }, { slug: "t2mobile", name: "T2mobile Nigeria", label: "T2mobile" }] },
        { type: "data", name: "Data", providers: [
          { slug: "mtn", name: "MTN Nigeria", label: "MTN" }, { slug: "airtel", name: "Airtel Nigeria", label: "Airtel" },
          { slug: "glo", name: "Globacom", label: "Glo" }, { slug: "smile", name: "Smile Communications", label: "Smile" }] },
        { type: "electricity", name: "Electricity", providers: [
          { slug: "aedc", name: "Abuja Electricity", label: "AEDC" }, { slug: "ikedc", name: "Ikeja Electric", label: "IKEDC" },
          { slug: "ekedc", name: "Eko Electricity", label: "EKEDC" }, { slug: "phed", name: "Port Harcourt Electricity", label: "PHED" }] },
        { type: "cable", name: "Cable TV", providers: [
          { slug: "dstv", name: "DStv", label: "DStv" }, { slug: "gotv", name: "GoTV", label: "GoTV" },
          { slug: "startimes", name: "StarTimes", label: "StarTimes" }] },
        { type: "education", name: "Education", providers: [
          { slug: "jamb", name: "JAMB", label: "JAMB" }, { slug: "waec", name: "WAEC", label: "WAEC" }] },
        { type: "epin", name: "ePIN Printing", providers: [
          { slug: "mtn", name: "MTN", label: "MTN" }, { slug: "airtel", name: "Airtel", label: "Airtel" },
          { slug: "glo", name: "Glo", label: "Glo" }, { slug: "t2mobile", name: "T2mobile", label: "T2mobile" }] },
        { type: "betting", name: "Betting", providers: [
          { slug: "bet9ja", name: "Bet9ja", label: "Bet9ja" }, { slug: "sportybet", name: "SportyBet", label: "SportyBet" },
          { slug: "betway", name: "Betway", label: "Betway" }, { slug: "1xbet", name: "1xBet", label: "1xBet" }] },
      ],
    });
  } catch (e: any) {
    console.error("[bills] catalog error:", e?.message);
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

router.get("/data-plans", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  try {
    const network = String(req.query.network || "").trim() || undefined;
    const provider = await getActiveProvider("bills");
    if (provider === "sogo") {
      const plans = await sogo.billsDataPlans(network);
      return res.json({ success: true, provider, plans });
    }
    // FLW/simulator: derive from the flat item list (fixed-amount data items).
    const items = await flwBills.getBillItems();
    const plans = items.filter((i: any) => i.__category === "DATA" && (!network || String(i.short_name || "").toLowerCase().includes(network)));
    return res.json({ success: true, provider, plans });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

router.get("/cable-packages", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  try {
    const providerSlug = String(req.query.provider || "").trim() || undefined;
    const provider = await getActiveProvider("bills");
    if (provider === "sogo") {
      const packages = await sogo.billsCablePackages(providerSlug);
      return res.json({ success: true, provider, packages });
    }
    const items = await flwBills.getBillItems();
    const packages = items.filter((i: any) => i.__category === "CABLEBILLS");
    return res.json({ success: true, provider, packages });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

router.get("/education-plans", authenticateToken, checkSubscriptionStatus, async (_req, res) => {
  try {
    const provider = await getActiveProvider("bills");
    if (provider === "sogo") {
      const plans = await sogo.billsEducationPlans();
      return res.json({ success: true, provider, plans });
    }
    const items = await flwBills.getBillItems();
    return res.json({ success: true, provider, plans: items.filter((i: any) => i.__category === "MORE") });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

router.get("/discount-rates", authenticateToken, checkSubscriptionStatus, async (_req, res) => {
  try {
    const provider = await getActiveProvider("bills");
    if (provider === "sogo") {
      const rates = await sogo.billsDiscountRates();
      return res.json({ success: true, provider, rates });
    }
    return res.json({ success: true, provider, rates: {} });
  } catch (e: any) {
    // Informational read — degrade gracefully instead of failing the hub
    // (the provider may not expose discounts on every environment).
    console.warn("[bills] discount-rates unavailable:", e?.message);
    return res.json({ success: true, provider: await getActiveProvider("bills"), rates: {}, warning: "Discount rates are not available right now" });
  }
});

router.get("/epin-stock", authenticateToken, checkSubscriptionStatus, async (_req, res) => {
  try {
    const provider = await getActiveProvider("bills");
    if (provider === "sogo") {
      const stock = await sogo.billsEpinStock();
      return res.json({ success: true, provider, stock });
    }
    return res.json({ success: true, provider, stock: {} });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

router.get("/epin/vouchers/:id/image", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  try {
    const buffer = await sogo.billsEpinVoucherImage(String(req.params.id));
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Content-Disposition", `inline; filename="voucher-${req.params.id}.webp"`);
    return res.send(buffer);
  } catch (e: any) {
    return res.status(e?.response?.status || 502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

// ---------------------------------------------------------------------------
// Verification endpoints (no charge)
// ---------------------------------------------------------------------------
router.post("/verify-meter", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  try {
    const { disco_slug, meter_number, meter_type } = req.body || {};
    if (!disco_slug || !meter_number || !meter_type) {
      return res.status(400).json({ success: false, error: "disco_slug, meter_number and meter_type are required" });
    }
    const provider = await getActiveProvider("bills");
    if (provider === "sogo") {
      const data = await sogo.verifyElectricityMeter(String(disco_slug), String(meter_number).trim(), meter_type === "postpaid" ? "postpaid" : "prepaid");
      return res.json({ success: true, provider, data });
    }
    return res.json({ success: true, provider, data: { verified: false, message: "Verification is unavailable on the active provider — the payment will confirm the meter." } });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

router.post("/verify-smartcard", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  try {
    const { provider: cableProvider, smartcard_number } = req.body || {};
    if (!cableProvider || !smartcard_number) {
      return res.status(400).json({ success: false, error: "provider and smartcard_number are required" });
    }
    const active = await getActiveProvider("bills");
    if (active === "sogo") {
      const data = await sogo.verifyCableSmartcard(String(cableProvider), String(smartcard_number).trim());
      return res.json({ success: true, provider: active, data });
    }
    return res.json({ success: true, provider: active, data: { verified: false, message: "Verification is unavailable on the active provider — the payment will confirm the smartcard." } });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

router.post("/verify-jamb", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  try {
    const { profile_id, variation_code } = req.body || {};
    if (!profile_id) return res.status(400).json({ success: false, error: "profile_id is required" });
    const active = await getActiveProvider("bills");
    if (active === "sogo") {
      const data = await sogo.verifyJambProfile(String(profile_id).trim(), variation_code ? String(variation_code).trim() : undefined);
      return res.json({ success: true, provider: active, data });
    }
    return res.json({ success: true, provider: active, data: { verified: false, message: "Verification is unavailable on the active provider — the payment will confirm the profile." } });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

router.post("/verify-betting", authenticateToken, checkSubscriptionStatus, async (req, res) => {
  try {
    const { provider: betProvider, account_id } = req.body || {};
    if (!betProvider || !account_id) {
      return res.status(400).json({ success: false, error: "provider and account_id are required" });
    }
    const active = await getActiveProvider("bills");
    if (active === "sogo") {
      const data = await sogo.verifyBettingAccount(String(betProvider), String(account_id).trim());
      return res.json({ success: true, provider: active, data });
    }
    return res.json({ success: true, provider: active, data: { verified: false, message: "Verification is unavailable on the active provider — the payment will confirm the account." } });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

// ---------------------------------------------------------------------------
// UNIFIED PURCHASE — all 7 categories through one endpoint
// ---------------------------------------------------------------------------
router.post("/pay", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "bills"))) return;
    await ensureBillTransactionsSchema();
    const userId = req.user!.userId;
    const businessId = req.user!.businessId ?? null;

    const category = String(req.body?.category || "").toLowerCase() as BillCategory;
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: `category must be one of: ${CATEGORIES.join(", ")}` });
    }

    const pinCheck = await verifyTransactionPin(req.body?.pin, { userId, businessId });
    if (!pinCheck.ok) {
      return res.status(400).json({ success: false, code: pinCheck.code, error: pinCheck.error });
    }

    // ---- Extract + validate per-category parameters -----------------------
    const b = req.body || {};
    let providerSlug = "";
    let customerRef = "";
    let amount = 0;                 // bill amount (fee added on top)
    const details: Record<string, any> = {};

    switch (category) {
      case "airtime": {
        providerSlug = String(b.network || "").trim().toLowerCase();
        customerRef = String(b.phone || "").trim();
        amount = Math.round(Number(b.amount) * 100) / 100;
        if (b.ported === true) details.ported = true;
        if (!providerSlug || !/^0[789][01]\d{8}$|^\+234[789][01]\d{8}$/.test(customerRef)) {
          return res.status(400).json({ success: false, error: "network and a valid Nigerian phone number are required" });
        }
        if (!(amount >= 50 && amount <= 50000)) {
          return res.status(400).json({ success: false, error: "airtime amount must be between ₦50 and ₦50,000" });
        }
        break;
      }
      case "data": {
        providerSlug = String(b.network || "").trim().toLowerCase();
        customerRef = String(b.phone || "").trim();
        details.variation_code = String(b.variation_code || "").trim();
        if (b.ported === true) details.ported = true;
        if (!providerSlug || !customerRef || !details.variation_code) {
          return res.status(400).json({ success: false, error: "network, phone and variation_code are required" });
        }
        break;
      }
      case "electricity": {
        providerSlug = String(b.disco_slug || "").trim().toLowerCase();
        customerRef = String(b.meter_number || "").trim();
        details.meter_type = b.meter_type === "postpaid" ? "postpaid" : "prepaid";
        amount = Math.round(Number(b.amount) * 100) / 100;
        if (!providerSlug || !customerRef || !(amount > 0)) {
          return res.status(400).json({ success: false, error: "disco_slug, meter_number and amount are required" });
        }
        break;
      }
      case "cable": {
        providerSlug = String(b.provider || "").trim().toLowerCase();
        customerRef = String(b.smartcard_number || "").trim();
        details.subscription_type = b.subscription_type === "change" ? "change" : "renew";
        details.variation_code = String(b.variation_code || "").trim();
        amount = Math.round(Number(b.amount) * 100) / 100;
        if (!providerSlug || !customerRef || !details.variation_code || !(amount > 0)) {
          return res.status(400).json({ success: false, error: "provider, smartcard_number, variation_code and amount are required" });
        }
        break;
      }
      case "education": {
        providerSlug = String(b.provider || "").trim().toLowerCase();
        details.variation_code = String(b.variation_code || "").trim();
        amount = Math.round(Number(b.amount) * 100) / 100;
        if (b.profile_id) details.profile_id = String(b.profile_id).trim();
        if (b.service_type) details.service_type = String(b.service_type).trim();
        if (!providerSlug || !details.variation_code || !(amount > 0)) {
          return res.status(400).json({ success: false, error: "provider, variation_code and amount are required" });
        }
        break;
      }
      case "epin": {
        providerSlug = String(b.network || "").trim().toLowerCase();
        details.denomination = Math.round(Number(b.denomination));
        details.quantity = Math.max(1, Math.min(5, Math.round(Number(b.quantity) || 1)));
        amount = details.denomination * 10 * details.quantity; // 10 vouchers per pack
        if (!providerSlug || ![100, 200, 500, 1000].includes(details.denomination)) {
          return res.status(400).json({ success: false, error: "network and denomination (100/200/500/1000) are required" });
        }
        break;
      }
      case "betting": {
        providerSlug = String(b.provider || "").trim().toLowerCase();
        customerRef = String(b.account_id || "").trim();
        amount = Math.round(Number(b.amount) * 100) / 100;
        if (!providerSlug || !customerRef || !(amount > 0)) {
          return res.status(400).json({ success: false, error: "provider, account_id and amount are required" });
        }
        break;
      }
    }

    const fee = await billFee();
    const total = Math.round((amount + fee) * 100) / 100;

    // ---- Wallet (NGN) + guarded debit ------------------------------------
    const wallet = await getOwnedWallet(String(b.wallet_id || ""), userId, businessId);
    if (!wallet) {
      const fallback = await query(
        `SELECT id, business_id, balance, currency FROM wallets
          WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active'
          ORDER BY created_at ASC LIMIT 1`,
        [userId],
      );
      if (!fallback.rows.length) return res.status(404).json({ success: false, error: "No active NGN wallet found" });
      (wallet as any) = fallback.rows[0];
    }
    if (String(wallet.currency || "NGN").toUpperCase() !== "NGN") {
      return res.status(400).json({ success: false, error: "Bill payments are charged in NGN — use your Naira wallet." });
    }
    const reference = genRef("MF-BILL");

    const insert = await query(
      `INSERT INTO bill_transactions
         (business_id, user_id, wallet_id, reference, provider, category, provider_slug,
          customer_ref, amount, fee, total, currency, status, details)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,'NGN','processing',$11::jsonb)
       RETURNING id`,
      // provider filled in after resolution — store 'pending' placeholder, update below
      [(wallet as any).business_id || businessId || null, userId, (wallet as any).id, reference,
       category, providerSlug, customerRef, amount, fee, total, JSON.stringify(details)],
    );
    const billId = insert.rows[0].id;

    const fail = async (status: string, message: string, refund = false) => {
      if (refund) {
        await creditWallet((wallet as any).id, total);
        await insertTransaction({
          userId, businessId: (wallet as any).business_id, walletId: (wallet as any).id,
          reference: `${reference}-REFUND`, type: "credit", transactionType: "bill_refund",
          amount: total, currency: "NGN", description: `Refund — bill payment failed (${category})`,
        });
      }
      await query(
        `UPDATE bill_transactions SET status = $2, failure_reason = $3, provider = $4,
           provider_response = $5::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [billId, status, String(message).slice(0, 500), provider, JSON.stringify(refund ? { refunded: true } : {})],
      );
    };

    // ---- Resolve provider + fulfil ----------------------------------------
    const provider = await getActiveProvider("bills");
    await query(`UPDATE bill_transactions SET provider = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [billId, provider]);

    const debitOk = await debitWallet((wallet as any).id, total);
    if (!debitOk) {
      await fail("failed", "Insufficient wallet balance");
      return res.status(400).json({
        success: false, code: "INSUFFICIENT_BALANCE",
        error: `You need ₦${total.toLocaleString()} for this bill (₦${amount.toLocaleString()} + ₦${fee.toLocaleString()} fee).`,
      });
    }
    await insertTransaction({
      userId, businessId: (wallet as any).business_id, walletId: (wallet as any).id,
      reference, type: "debit", transactionType: "bill",
      amount: total, currency: "NGN", fee,
      description: `Bill payment — ${category}${providerSlug ? ` (${providerSlug.toUpperCase()})` : ""}${customerRef ? ` — ${customerRef}` : ""}`,
    });

    let status = "completed";
    let providerRef: string | null = null;
    let providerResponse: any = {};
    let delivered: any = null;

    if (provider === "sogo") {
      const input = { reference, ...details } as any;
      try {
        switch (category) {
          case "airtime": providerResponse = await sogo.buyAirtime({ network: providerSlug, phone: customerRef, amount, ported: details.ported, reference }); break;
          case "data": providerResponse = await sogo.buyData({ network: providerSlug, phone: customerRef, variation_code: details.variation_code, ported: details.ported, reference }); break;
          case "electricity": providerResponse = await sogo.payElectricity({ disco_slug: providerSlug, meter_number: customerRef, meter_type: details.meter_type, amount, reference }); break;
          case "cable": providerResponse = await sogo.payCableTv({ provider: providerSlug, smartcard_number: customerRef, subscription_type: details.subscription_type, variation_code: details.variation_code, amount, reference }); break;
          case "education": providerResponse = await sogo.payEducation({ provider: providerSlug, variation_code: details.variation_code, amount, profile_id: details.profile_id, service_type: details.service_type, reference }); break;
          case "epin": providerResponse = await sogo.buyEpin({ network: providerSlug, denomination: details.denomination, quantity: details.quantity, reference }); break;
          case "betting": providerResponse = await sogo.fundBetting({ provider: providerSlug, account_id: customerRef, amount, reference }); break;
        }
        const tx = (providerResponse?.transaction ?? providerResponse) || {};
        status = normalizeStatus(sogo.sogoStatus(tx) || sogo.sogoStatus(providerResponse));
        providerRef = sogo.sogoReference(providerResponse) || reference;
        // Delivered assets ride in the response (electricity tokens, exam
        // pins, ePINs) when the provider includes them synchronously.
        delivered = tx.token || tx.tokens || tx.epin_cards || tx.pin || tx.voucher || providerResponse?.token || null;
        if (delivered) details.delivered = delivered;
      } catch (e: any) {
        await fail("failed", sogo.sogoErr(e), true);
        return res.status(502).json({ success: false, error: `${userSafeErr(sogo.sogoErr(e))} — your wallet has been refunded.` });
      }
    } else if (provider === "flutterwave") {
      const result = await flwBills.payBill({
        reference,
        category: category.toUpperCase(),
        billerCode: b.biller_code || null,
        itemCode: b.item_code || details.variation_code || null,
        customer: customerRef,
        amount,
        narration: `MetriCorex bill — ${category}`,
        meta: { category, wallet_id: (wallet as any).id, user_id: userId },
      });
      providerResponse = result.raw || { message: result.message };
      if (!result.ok) {
        await fail("failed", result.message || "Flutterwave bill payment failed", true);
        return res.status(502).json({ success: false, error: `${result.message} — your wallet has been refunded.` });
      }
      status = "completed";
      providerRef = result.providerReference || reference;
    } else {
      // SIMULATOR — instant success.
      status = "completed";
      providerRef = `SIM-${reference}`;
      delivered = category === "electricity"
        ? { token: `SIM-TOKEN-${Date.now()}` }
        : category === "epin"
          ? { epin_cards: [{ network: providerSlug, denomination: details.denomination, pins: Array.from({ length: 10 }, (_, i) => `SIM${Date.now()}${i}`) }] }
          : null;
      if (delivered) details.delivered = delivered;
      providerResponse = { simulator: true };
    }

    if (status === "completed" && fee > 0) {
      await creditRevenueWallet(fee, "NGN", reference, "Bill payment convenience fee", "bills").catch(() => {});
    }

    const updated = await query(
      `UPDATE bill_transactions
         SET status = $2, provider_reference = $3, provider_response = $4::jsonb, details = $5::jsonb,
             settled_at = CASE WHEN $2 IN ('completed','failed','refunded','cancelled') THEN CURRENT_TIMESTAMP ELSE settled_at END,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [billId, status, providerRef, JSON.stringify(providerResponse), JSON.stringify(details)],
    );

    if (status === "completed") {
      createNotification({
        businessId: String((wallet as any).business_id || businessId || ""),
        userId,
        type: "system",
        title: "Bill payment successful",
        message: `Your ${category} payment of ₦${amount.toLocaleString()} was successful. Ref: ${reference}.`,
        actionUrl: "/bills",
        actionType: "view_transaction",
        metadata: { reference },
        isActionable: false,
        expiresInHours: 168,
      }).catch(() => {});
    }

    return res.status(201).json({
      success: true,
      provider,
      message: status === "completed"
        ? "Bill payment successful"
        : "Payment received — the provider is fulfilling this bill. Track it in your history.",
      data: { transaction: publicRow(updated.rows[0]) },
    });
  } catch (e: any) {
    console.error("[bills] pay error:", e?.message);
    return res.status(500).json({ success: false, error: "Could not complete the bill payment" });
  }
});

// ---------------------------------------------------------------------------
// History + detail + sync
// ---------------------------------------------------------------------------
router.get("/history", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureBillTransactionsSchema();
    const rows = await query(
      `SELECT * FROM bill_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    return res.json({ success: true, transactions: rows.rows.map(publicRow) });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: "Could not load bill history" });
  }
});

router.get("/transactions/:reference", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureBillTransactionsSchema();
    const rows = await query(
      `SELECT * FROM bill_transactions WHERE reference = $1 AND user_id = $2`,
      [req.params.reference, req.user!.userId],
    );
    if (!rows.rows.length) return res.status(404).json({ success: false, error: "Transaction not found" });
    const tx = rows.rows[0];

    // Poll the provider for unsettled transactions (live only — sandbox does
    // not persist transactions and always 404s here).
    if (tx.status === "processing" && tx.provider === "sogo" && !sogo.isSogoSandbox()) {
      try {
        const remote = await sogo.getTransaction(tx.reference);
        const mapped = normalizeStatus(sogo.sogoStatus(remote?.transaction || remote));
        if (mapped !== tx.status) {
          const upd = await query(`UPDATE bill_transactions SET status = $2, provider_response = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [tx.id, mapped, JSON.stringify(remote)]);
          return res.json({ success: true, data: { transaction: publicRow(upd.rows[0]) } });
        }
      } catch { /* keep local state */ }
    }
    return res.json({ success: true, data: { transaction: publicRow(tx) } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: "Could not load transaction" });
  }
});

router.post("/transactions/:reference/sync", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureBillTransactionsSchema();
    const rows = await query(
      `SELECT * FROM bill_transactions WHERE reference = $1 AND user_id = $2`,
      [req.params.reference, req.user!.userId],
    );
    if (!rows.rows.length) return res.status(404).json({ success: false, error: "Transaction not found" });
    const tx = rows.rows[0];
    if (tx.provider !== "sogo") return res.json({ success: true, data: { transaction: publicRow(tx), updated: false } });

    const remote = await sogo.getTransaction(tx.provider_reference || tx.reference).catch(() => null);
    if (!remote) return res.json({ success: true, data: { transaction: publicRow(tx), updated: false } });

    const mapped = normalizeStatus(sogo.sogoStatus(remote?.transaction || remote));
    if (mapped !== tx.status) {
      // Provider-side refunds must return the money we debited.
      if (mapped === "refunded" || mapped === "failed" || mapped === "cancelled") {
        await creditWallet(tx.wallet_id, Number(tx.total));
        await insertTransaction({
          userId: tx.user_id, businessId: tx.business_id, walletId: tx.wallet_id,
          reference: `${tx.reference}-REFUND`, type: "credit", transactionType: "bill_refund",
          amount: Number(tx.total), currency: "NGN", description: `Refund — bill payment ${mapped}`,
        });
      }
      const upd = await query(
        `UPDATE bill_transactions SET status = $2, provider_response = $3::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
        [tx.id, mapped, JSON.stringify(remote)],
      );
      return res.json({ success: true, data: { transaction: publicRow(upd.rows[0]), updated: true } });
    }
    return res.json({ success: true, data: { transaction: publicRow(tx), updated: false } });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

export default router;
