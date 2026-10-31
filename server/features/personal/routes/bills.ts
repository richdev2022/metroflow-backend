import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  assertPersonalService, genRef, requirePersonalKyc, verifyTransactionPin,
  creditCashbackBalance, debitCashbackBalance, getCashbackBalance,
} from "../personal-utils";
import { calculateFee, creditRevenueWallet } from "../../../services/fees";
import { createNotification } from "../../../services/notifications";
import * as sogo from "../../../services/sogo";
import { userSafeErr } from "../user-safe-errors";
import * as flwBills from "../flutterwave-bills";
import { getActiveProvider, providerLabel } from "../provider-routing";
import { getBillPricingRule, applyBillPricing, round2, getBillPricingMap, BILL_CATEGORIES } from "../bill-pricing";
import { sweepUserBills } from "../bill-settlement";
import { holdVendorForBill, recordBillCompletionLedger, accrueBillCashback } from "../bill-ledger";

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
// 3-ATTEMPT BACKGROUND CONFIRMATION (TSQ)
// ---------------------------------------------------------------------------
// When the provider answers a purchase with processing/pending, the user
// STILL sees the success page — we keep verifying in the background:
//   attempt 1 at ~8s, attempt 2 at ~25s, attempt 3 at ~60s.
// Each attempt queries the provider (same engine the reaper uses):
//   completed → settleBillCompleted (cashback + vendor/discount ledgers)
//   failed/refunded/cancelled → refundBillRow (money back)
// If all 3 attempts are inconclusive, the row legitimately stays
// 'processing' and the 5-minute reaper + webhook keep watching it.
const billConfirmTimers = new Set<NodeJS.Timeout>();

function scheduleBillConfirmation(
  billId: string,
  reference: string,
  providerRef: string | null,
  category: string,
  amount: number,
): void {
  const delays = [8_000, 25_000, 60_000];
  const runAttempt = async (attempt: number) => {
    try {
      const row = await query(`SELECT * FROM bill_transactions WHERE id = $1 LIMIT 1`, [billId]);
      const bill = row.rows[0];
      if (!bill || bill.status !== "processing") return; // already settled elsewhere
      const { settleBillCompleted, refundBillRow, askProviderForBill } = await import("../bill-settlement");
      const verdict = await askProviderForBill(bill);
      if (verdict.kind === "completed") {
        await settleBillCompleted(bill, verdict.providerResponse);
        console.log(`[bills] confirmation attempt ${attempt}: ${reference} COMPLETED`);
      } else if (verdict.kind === "failed") {
        await refundBillRow(bill, verdict.reason, verdict.providerResponse);
        console.log(`[bills] confirmation attempt ${attempt}: ${reference} FAILED — refunded`);
      } else if (attempt >= delays.length) {
        console.log(`[bills] confirmation exhausted for ${reference} — staying processing for reaper/webhook`);
      } else {
        console.log(`[bills] confirmation attempt ${attempt}: ${reference} still ${verdict.kind}`);
      }
    } catch (e: any) {
      console.error(`[bills] confirmation attempt ${attempt} failed for ${reference}:`, e?.message);
    }
  };
  delays.forEach((ms, idx) => {
    const t = setTimeout(() => {
      billConfirmTimers.delete(t);
      void runAttempt(idx + 1);
    }, ms);
    billConfirmTimers.add(t);
    t.unref?.();
  });
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
    // Admin-set promotions ride alongside the provider's wholesale rates so
    // clients can badge categories with "X% off" / "Y% cashback".
    const adminRules = await getBillPricingMap();
    if (provider === "sogo") {
      const rates = await sogo.billsDiscountRates();
      return res.json({ success: true, provider, rates, admin_rules: adminRules });
    }
    return res.json({ success: true, provider, rates: {}, admin_rules: adminRules });
  } catch (e: any) {
    // Informational read — degrade gracefully instead of failing the hub
    // (the provider may not expose discounts on every environment).
    console.warn("[bills] discount-rates unavailable:", e?.message);
    let adminRules: Record<string, unknown> = {};
    try { adminRules = await getBillPricingMap(); } catch { /* degrade */ }
    return res.json({ success: true, provider: await getActiveProvider("bills"), rates: {}, admin_rules: adminRules, warning: "Discount rates are not available right now" });
  }
});

// PROMOTIONS + FEE preview — what the customer will ACTUALLY be charged.
// The web Bills page used to hardcode a ₦50 estimated fee in its summary
// while the API charged whatever fee_configurations held (admin-set 0) —
// this endpoint is the single source of truth for pre-payment display.
router.get("/pricing", authenticateToken, checkSubscriptionStatus, async (_req, res) => {
  try {
    const fee = await billFee();
    const rules = await getBillPricingMap();
    return res.json({
      success: true,
      data: {
        fee,
        currency: "NGN",
        categories: BILL_CATEGORIES,
        rules,
      },
    });
  } catch (e: any) {
    console.error("[bills] pricing error:", e?.message);
    return res.json({ success: true, data: { fee: 0, currency: "NGN", categories: BILL_CATEGORIES, rules: {} } });
  }
});

// ---------------------------------------------------------------------------
// CASHBACK — balance, live preview and rules for the Airtime/Data screens.
// ---------------------------------------------------------------------------
// GET /bills/cashback            → my cashback balance + per-category rules
// GET /bills/cashback/preview?category=airtime&amount=500
//                                → exact cashback this purchase would earn
router.get("/cashback", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const wallets = await query(
      `SELECT id, COALESCE(cashback_balance, 0) AS cashback_balance FROM wallets
        WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`,
      [userId],
    );
    const rules = await getBillPricingMap();
    const activeRules = Object.fromEntries(
      Object.entries(rules).filter(([, r]) => r.enabled && (r.cashback_percent > 0 || r.discount_percent > 0)),
    );
    return res.json({
      success: true,
      data: {
        cashback_balance: Number(wallets.rows[0]?.cashback_balance || 0),
        currency: "NGN",
        rules: activeRules,
      },
    });
  } catch (e: any) {
    console.error("[bills] cashback summary error:", e?.message);
    return res.json({ success: true, data: { cashback_balance: 0, currency: "NGN", rules: {} } });
  }
});

// GET /bills/cashback/history?page=1&limit=20
//   → paginated cashback activity for the paying wallet (earned / reversed /
//     spent on bills) — powers the Rewards page history list.
router.get("/cashback/history", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    // Same NGN personal wallet the cashback balance lives on (mirrors /cashback).
    const wallets = await query(
      `SELECT id, COALESCE(cashback_balance, 0) AS cashback_balance FROM wallets
        WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`,
      [userId],
    );
    const walletId = wallets.rows[0]?.id || null;
    if (!walletId) {
      return res.json({ success: true, data: { items: [], page, limit, total: 0, pages: 0, cashback_balance: 0, currency: "NGN" } });
    }

    // Activity = cashback earned (bill_cashback credits), reversals, and the
    // part of a bill payment that was covered by the cashback balance (the
    // bill debit row narrates it as "(₦X cashback used)").
    const countRes = await query(
      `SELECT COUNT(*)::int AS total
         FROM transactions
        WHERE wallet_id = $1
          AND (
            transaction_type IN ('bill_cashback', 'bill_cashback_reversal')
            OR (transaction_type = 'bill' AND description LIKE '%cashback used%')
          )`,
      [walletId],
    );
    const total = Number(countRes.rows[0]?.total || 0);
    const itemsRes = await query(
      `SELECT id, reference, type, amount, currency, description, transaction_type, status, created_at
         FROM transactions
        WHERE wallet_id = $1
          AND (
            transaction_type IN ('bill_cashback', 'bill_cashback_reversal')
            OR (transaction_type = 'bill' AND description LIKE '%cashback used%')
          )
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [walletId, limit, offset],
    );

    return res.json({
      success: true,
      data: {
        items: itemsRes.rows,
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        cashback_balance: Number(wallets.rows[0]?.cashback_balance || 0),
        currency: "NGN",
      },
    });
  } catch (e: any) {
    console.error("[bills] cashback history error:", e?.message);
    return res.status(500).json({ success: false, error: "Could not load cashback history" });
  }
});

router.get("/cashback/preview", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const category = String(req.query.category || "").toLowerCase();
    const amount = Number(req.query.amount);
    if (!BILL_CATEGORIES.includes(category as any)) {
      return res.status(400).json({ success: false, error: `category must be one of: ${BILL_CATEGORIES.join(", ")}` });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: "amount must be a positive number" });
    }
    const rule = await getBillPricingRule(category);
    const pricing = applyBillPricing(amount, await billFee(), rule);
    return res.json({
      success: true,
      data: {
        category,
        amount: round2(amount),
        cashback: pricing.cashback,
        cashback_percent: rule?.enabled ? Number(rule.cashback_percent) || 0 : 0,
        cashback_cap: rule?.enabled ? Number(rule.cashback_cap) || 0 : 0,
        discount: pricing.discount,
        fee: await billFee(),
        total: pricing.total,
        currency: "NGN",
      },
    });
  } catch (e: any) {
    console.error("[bills] cashback preview error:", e?.message);
    return res.status(500).json({ success: false, error: "Could not compute cashback preview" });
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
  // Hoisted so the handler-level catch can run money-safety recovery on a
  // stranded debit (see catch below).
  let billId: string | null = null;
  let wallet: any = null;
  let total = 0;
  let reference = "";
  let category: BillCategory = "" as BillCategory;
  let userId = "";
  try {
    if (!(await assertPersonalService(res, "bills"))) return;
    await ensureBillTransactionsSchema();
    userId = req.user!.userId;
    const businessId = req.user!.businessId ?? null;

    category = String(req.body?.category || "").toLowerCase() as BillCategory;
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
        amount = Math.round(Number(b.amount) * 100) / 100;
        if (b.plan_name) details.plan_name = String(b.plan_name).slice(0, 120);
        if (b.ported === true) details.ported = true;
        if (!providerSlug || !customerRef || !details.variation_code) {
          return res.status(400).json({ success: false, error: "network, phone and variation_code are required" });
        }
        if (!(amount > 0)) {
          // PRODUCTION BUG FIX: data purchases used to dispatch with amount 0 —
          // the user was never debited while the provider still fulfilled the
          // plan (₦50 airtel data, Oct-31). The plan's price is MANDATORY.
          return res.status(400).json({ success: false, error: "amount is required — select a data plan first" });
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

    // PROMOTIONS: admin-set per-category discount/cashback (bill_pricing_rules).
    // The customer pays `face value - discount + fee`; the provider is still
    // paid the full face value — the platform absorbs the promo as growth cost.
    // Cashback is credited back to the wallet after a successful payment.
    const pricingRule = await getBillPricingRule(category);
    const fee = await billFee();
    const pricing = applyBillPricing(amount, fee, pricingRule);
    total = pricing.total;
    if (pricing.discount > 0) {
      details.discount_amount = pricing.discount;
      details.discount_percent = pricingRule!.discount_percent;
    }
    if (pricing.cashback > 0) {
      details.cashback_percent = pricingRule!.cashback_percent;
    }

    // ---- Wallet (NGN) + guarded debit ------------------------------------
    // Empty-string wallet_id used to reach getOwnedWallet as "" → Postgres
    // uuid cast error → 500 before any fallback could run. Normalize here.
    // NOTE: assigns the HOISTED handler-level `wallet` — the old `let wallet`
    // shadow inside this try block left the catch-block money-recovery blind
    // (it saw wallet === null and never refunded a stranded debit).
    const requestedWalletId = String(b.wallet_id || "").trim();
    wallet = requestedWalletId
      ? await getOwnedWallet(requestedWalletId, userId, businessId)
      : null;
    if (!wallet) {
      const fallback = await query(
        `SELECT id, business_id, balance, currency FROM wallets
          WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active'
          ORDER BY created_at ASC LIMIT 1`,
        [userId],
      );
      if (!fallback.rows.length) return res.status(404).json({ success: false, error: "No active NGN wallet found" });
      wallet = fallback.rows[0] as typeof wallet;
    }
    if (String(wallet.currency || "NGN").toUpperCase() !== "NGN") {
      return res.status(400).json({ success: false, error: "Bill payments are charged in NGN — use your Naira wallet." });
    }
    reference = genRef("MF-BILL");

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
    billId = insert.rows[0].id;

    // MONEY SAFETY: the row status is settled FIRST (guarded claim), then the
    // refund credit runs — a failed credit can no longer strand the row in
    // 'processing'. If the credit throws, failure_reason is marked so the
    // bill-settlement reaper retries the credit until the -REFUND ledger row
    // exists (recoverMissedRefunds / sweepUserBills).
    // The whole body is guarded: a transient DB blip inside fail() used to
    // bubble into the handler catch and return a bare 500 AFTER the provider
    // had already accepted the order (Log 89f5e37b) — the reaper then had to
    // pick up the pieces. Fail() failures are logged and survived instead.
    const fail = async (status: string, message: string, refund = false) => {
      try {
        await query(
          `UPDATE bill_transactions SET status = $2, failure_reason = $3, provider = $4,
             provider_response = $5::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status = 'processing'`,
          [billId, status, String(message).slice(0, 500), provider, JSON.stringify(refund ? { refund_pending: refund } : {})],
        );
        if (refund && (wallet as any)?.id) {
          try {
            // Give back whatever the customer actually paid (cashback part
            // returns to the cashback balance, the rest to the main balance).
            const cashbackUsed = Number(details.cashback_used || 0);
            if (cashbackUsed > 0) {
              await creditCashbackBalance((wallet as any).id, cashbackUsed);
            }
            const mainRefund = Math.max(0, Math.round((total - cashbackUsed) * 100) / 100);
            if (mainRefund > 0) await creditWallet((wallet as any).id, mainRefund);
            await insertTransaction({
              userId, businessId: (wallet as any).business_id, walletId: (wallet as any).id,
              reference: `${reference}-REFUND`, type: "credit", transactionType: "bill_refund",
              amount: total, currency: "NGN", description: `Refund — bill payment failed (${category})`,
            });
          } catch (refundErr: any) {
            console.error("[bills] fail() refund credit failed — reaper will retry:", refundErr?.message);
            await query(
              `UPDATE bill_transactions SET failure_reason = failure_reason || ' (AUTO-REFUND PENDING)' WHERE id = $1`,
              [billId],
            ).catch(() => {});
          }
        }
      } catch (failErr: any) {
        // Never let a settlement write fail the request — the reaper/webhook
        // will still reconcile this row (it is the same engine).
        console.error("[bills] fail() status write failed (reaper will reconcile):", failErr?.message);
      }
    };

    // ---- Resolve provider + fulfil ----------------------------------------
    const provider = await getActiveProvider("bills");
    await query(`UPDATE bill_transactions SET provider = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [billId, provider]);

    // PAY FROM CASHBACK: when use_cashback is set, draw the cashback balance
    // FIRST and only debit the main wallet for the remainder — the platform
    // always holds the full `total` before the provider is called.
    const useCashback = req.body?.use_cashback === true || req.body?.use_cashback === "true";
    let cashbackUsed = 0;
    let mainDebit = total;
    if (useCashback && total > 0) {
      cashbackUsed = await debitCashbackBalance((wallet as any).id, total);
      mainDebit = Math.max(0, Math.round((total - cashbackUsed) * 100) / 100);
      if (cashbackUsed > 0) {
        details.cashback_used = cashbackUsed;
        // MONEY SAFETY: persist the cashback split IMMEDIATELY — before the
        // main debit, ledger insert and provider dispatch. If the process
        // dies anywhere in the next steps, every refund path (fail(), catch
        // recovery, reaper) reads details.cashback_used from the DB row; a
        // lost split used to refund `total` to the main balance while the
        // cashback balance had already been drawn down.
        await query(
          `UPDATE bill_transactions SET details = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [billId, JSON.stringify(details)],
        ).catch(() => {});
      }
    }

    const debitOk = mainDebit === 0 || (await debitWallet((wallet as any).id, mainDebit));
    if (!debitOk) {
      // Restore the cashback we tried to take — nothing has happened yet.
      if (cashbackUsed > 0) await creditCashbackBalance((wallet as any).id, cashbackUsed).catch(() => {});
      await fail("failed", "Insufficient wallet balance");
      return res.status(400).json({
        success: false, code: "INSUFFICIENT_BALANCE",
        error: `You need ₦${total.toLocaleString()} for this bill (₦${amount.toLocaleString()}${pricing.discount > 0 ? ` - ₦${pricing.discount.toLocaleString()} discount` : ""} + ₦${fee.toLocaleString()} fee)${cashbackUsed > 0 ? ` — your cashback balance covered ₦${cashbackUsed.toLocaleString()}` : ""}.`,
      });
    }
    // MONEY SAFETY: the wallet is now debited (cashback + main). The ledger
    // insert MUST never be the reason money vanishes — if it fails, refund
    // immediately instead of bubbling a 500 with the debit stranded.
    try {
      await insertTransaction({
        userId, businessId: (wallet as any).business_id, walletId: (wallet as any).id,
        reference, type: "debit", transactionType: "bill",
        amount: total, currency: "NGN", fee,
        description: `Bill payment — ${category}${providerSlug ? ` (${providerSlug.toUpperCase()})` : ""}${customerRef ? ` — ${customerRef}` : ""}${cashbackUsed > 0 ? ` (₦${cashbackUsed.toLocaleString()} cashback used)` : ""}`,
      });
    } catch (ledgerErr: any) {
      console.error("[bills] debit ledger insert failed — refunding:", ledgerErr?.message);
      await fail("failed", "Could not record the bill payment — refunded", true);
      return res.status(500).json({ success: false, error: "Could not complete the bill payment — your wallet has been refunded." });
    }

    // MONEY SAFETY (owner rule): secure the platform's own funds BEFORE the
    // provider consumes float — the operational wallet is debited the face
    // value now; the settlement engine releases/reconciles it on the outcome.
    await holdVendorForBill(reference, amount, category);

    let status = "completed";
    let providerRef: string | null = null;
    let providerResponse: any = {};
    let delivered: any = null;

    // Stamp the dispatch instant — if the process dies mid-provider-call the
    // reconciliation engine can tell "dispatched, outcome unknown" from
    // "never dispatched" (provider 404 vs response parse failure).
    // MONEY SAFETY: the marker is PERSISTED BEFORE the provider call, so the
    // handler-level catch can see "money left for the provider" even if this
    // process dies a millisecond from now. A crash after this point must
    // NEVER auto-refund — only the provider's own verdict may settle the row.
    details.dispatched_at = new Date().toISOString();
    // Persist BEFORE the provider call — the stamp is only useful for crash
    // forensics if it survives the crash itself.
    await query(
      `UPDATE bill_transactions SET details = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [billId, JSON.stringify(details)],
    );

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
        // MONEY SAFETY: only refund when Sogo DEFINITIVELY rejected the order
        // (4xx). Timeouts / 5xx / network errors are AMBIGUOUS — the provider
        // may have fulfilled the bill anyway (that is exactly how "successful
        // bill + refunded wallet" happened before). Ambiguous failures leave
        // the row 'processing': the Sogo webhook and the settlement reaper
        // ask the provider and settle the truth.
        if (sogo.isAmbiguousProviderError(e)) {
          console.error("[bills] sogo dispatch outcome unknown — leaving row for reconciliation:", sogo.sogoErr(e));
          await query(
            `UPDATE bill_transactions
               SET failure_reason = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status = 'processing'`,
            [billId, `Dispatch outcome unknown (${String(sogo.sogoErr(e)).slice(0, 180)}) — awaiting provider webhook/reconciliation`.slice(0, 500)],
          ).catch(() => {});
          return res.status(202).json({
            success: true,
            pending: true,
            provider,
            message: "Payment received — the provider is fulfilling this bill. Track it in your history.",
            data: { reference, status: "processing" },
          });
        }
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

    // PROVIDER LEDGER: book the vendor's discounted charge + the margin the
    // platform made (face − discounted → Revenue ledger) + accrue promo
    // cashback into the DEDICATED cashback balance. All idempotent.
    if (status === "completed") {
      await recordBillCompletionLedger(
        { reference, category, amount, user_id: userId, business_id: (wallet as any).business_id, wallet_id: (wallet as any).id },
        providerResponse?.transaction ?? providerResponse,
      );
    }

    // CASHBACK (admin-set promotions): credit X% of the face value (capped)
    // into the wallet's cashback balance with its own ledger entry, funded by
    // an immediate debit on the PLATFORM REVENUE ledger (see bill-ledger.ts).
    // Best-effort — a failed cashback must never fail an already-completed
    // bill payment; the row's details keep the rule so support can replay it.
    if (status === "completed" && pricing.cashback > 0) {
      const ok = await accrueBillCashback(
        { reference, category, amount, user_id: userId, business_id: (wallet as any).business_id, wallet_id: (wallet as any).id },
        pricing.cashback,
        pricingRule?.cashback_percent ?? 0,
      );
      if (ok) details.cashback_amount = pricing.cashback;
    }

    // MONEY SAFETY: this UPDATE is the settlement moment. A client-side
    // timeout here can leave the row COMMITTED server-side while the handler
    // sees a thrown error — re-read before doing anything drastic, and never
    // turn a post-dispatch hiccup into a refund (the provider already has the
    // money and the customer is already served).
    let updated: { rows: any[] };
    try {
      updated = await query(
        `UPDATE bill_transactions
           SET status = $2, provider_reference = $3, provider_response = $4::jsonb, details = $5::jsonb,
               settled_at = CASE WHEN $2 IN ('completed','failed','refunded','cancelled') THEN CURRENT_TIMESTAMP ELSE settled_at END,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [billId, status, providerRef, JSON.stringify(providerResponse), JSON.stringify(details)],
      );
    } catch (settleErr: any) {
      console.error("[bills] settlement UPDATE failed — re-reading row state:", settleErr?.message);
      const re = await query(`SELECT * FROM bill_transactions WHERE id = $1`, [billId]).catch(() => null);
      const row = re?.rows?.[0];
      if (row && ["completed", "failed", "refunded", "cancelled"].includes(String(row.status))) {
        updated = re as { rows: any[] }; // committed server-side after all — respond normally
      } else {
        // Genuinely unsettled: the provider call already went out, so the
        // webhook / settlement engine / background confirmation will land the
        // outcome. Never 500-refund here.
        return res.status(202).json({
          success: true,
          pending: true,
          provider,
          message: "Payment received — the provider is fulfilling this bill. Track it in your history.",
          data: { reference, status: "processing" },
        });
      }
    }

    if (status === "completed") {
      const promoBits: string[] = [];
      if (pricing.discount > 0) promoBits.push(`₦${pricing.discount.toLocaleString()} discount applied`);
      if (details.cashback_amount > 0) promoBits.push(`₦${details.cashback_amount.toLocaleString()} cashback credited`);
      createNotification({
        businessId: String((wallet as any).business_id || businessId || ""),
        userId,
        type: "system",
        title: "Bill payment successful",
        message: `Your ${category} payment of ₦${amount.toLocaleString()} was successful. Ref: ${reference}.${promoBits.length ? ` ${promoBits.join(". ")}.` : ""}`,
        actionUrl: "/bills",
        actionType: "view_transaction",
        metadata: { reference },
        isActionable: false,
        expiresInHours: 168,
      }).catch(() => {});
    }

    // PROVIDER-SAYS-PROCESSING → 3-ATTEMPT CONFIRMATION: show the success
    // page immediately; the webhook OR these background TSQ retries resolve
    // the true outcome. Only after all three fail does the row legitimately
    // stay 'processing' for the user to re-confirm (history/sync/reaper).
    if (status !== "completed") {
      scheduleBillConfirmation(billId!, reference, providerRef, category, amount);
    }

    return res.status(201).json({
      success: true,
      provider,
      message: status === "completed"
        ? "Bill payment successful"
        : "Payment received — we are confirming your bill with the provider right now. You will get an update any moment.",
      data: { transaction: publicRow(updated.rows[0]) },
    });
  } catch (e: any) {
    console.error("[bills] pay error:", e?.message);
    // MONEY SAFETY: recovery is decided by DISPATCH STATE, not by optimism.
    //   - Provider call never went out (no persisted dispatched_at) → the
    //     debit is stranded; refund it here (safe — nothing was bought).
    //   - Provider call DID go out → the money belongs to the provider now;
    //     NEVER auto-refund on a guess. Leave the row 'processing' for the
    //     webhook + settlement reaper, and answer 202 (accepted, pending).
    //     This is the fix for "bill successful to the recipient yet the API
    //     500'd and the wallet was refunded".
    let dispatched = false;
    try {
      if (billId && wallet?.id) {
        const existing = await query(`SELECT status, details FROM bill_transactions WHERE id = $1`, [billId]);
        const row = existing.rows[0];
        dispatched = !!(row?.details?.dispatched_at);
        if (row?.status === 'processing' && !dispatched) {
          await creditWallet(wallet.id, total);
          await insertTransaction({
            userId, businessId: wallet.business_id, walletId: wallet.id,
            reference: `${reference}-REFUND`, type: "credit", transactionType: "bill_refund",
            amount: total, currency: "NGN", description: `Refund — bill payment failed (${category})`,
          }).catch(() => {});
          await query(
            `UPDATE bill_transactions SET status = 'refunded', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'processing'`,
            [billId, String(e?.message || 'handler error (pre-dispatch)').slice(0, 500)],
          );
        } else if (row?.status === 'processing' && dispatched) {
          await query(
            `UPDATE bill_transactions SET failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'processing'`,
            [billId, `Handler error after dispatch — left in processing for provider reconciliation (${String(e?.message || 'unknown').slice(0, 150)})`.slice(0, 500)],
          );
        }
        // Rows already settled (completed/failed/refunded) need no recovery.
      }
    } catch (sweepErr: any) {
      console.error("[bills] pay error recovery failed:", sweepErr?.message);
    }
    if (dispatched) {
      return res.status(202).json({
        success: true,
        pending: true,
        message: "Payment received — the provider is fulfilling this bill. Track it in your history.",
        data: { reference, status: "processing" },
      });
    }
    return res.status(500).json({ success: false, error: "Could not complete the bill payment" });
  }
});

// ---------------------------------------------------------------------------
// History + detail + sync
// ---------------------------------------------------------------------------
// MONEY SAFETY: lazily settle this user's abandoned "processing" bills on
// history reads. Delegates to the shared settlement engine (bill-settlement.ts)
// which asks the PROVIDER before refunding — the old blind 60-minute refund
// could double-give when the provider had actually fulfilled the bill. The
// same engine runs globally on a 5-minute cron (server/index.ts), so pending
// bills settle even if the user never opens history again.
async function sweepStaleProcessingBills(userId: string) {
  await sweepUserBills(userId);
}

router.get("/history", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureBillTransactionsSchema();
    await sweepStaleProcessingBills(req.user!.userId);
    const rows = await query(
      `SELECT * FROM bill_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    return res.json({ success: true, transactions: rows.rows.map(publicRow) });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: "Could not load bill history" });
  }
});

// LEGACY ALIAS: the Personal mobile app has always polled GET /bills for its
// history screen — that path no longer exists on the unified router (only
// /bills/history), so the app's bill history silently failed. Serve it.
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureBillTransactionsSchema();
    await sweepStaleProcessingBills(req.user!.userId);
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
    // not persist transactions and always 404s here). MONEY SAFETY: a status
    // flip discovered here MUST move money through the settlement engine —
    // the old inline UPDATE flipped the status without booking the
    // vendor/discount/cashback ledgers or refunding a failed bill, so a
    // failed bill looked "failed" to the user while the debit stayed stranded.
    if (tx.status === "processing" && tx.provider === "sogo" && !sogo.isSogoSandbox()) {
      try {
        const remote = await sogo.getTransaction(tx.provider_reference || tx.reference);
        const remoteTx = remote?.transaction || remote;
        const mapped = normalizeStatus(sogo.sogoStatus(remoteTx));
        if (mapped && mapped !== tx.status) {
          const settled = await settleFromProviderReport(tx, mapped, remote);
          const re = await query(`SELECT * FROM bill_transactions WHERE id = $1`, [tx.id]);
          return res.json({ success: true, data: { transaction: publicRow(re.rows[0] || tx), updated: settled } });
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
    if (mapped && mapped !== tx.status) {
      const settled = await settleFromProviderReport(tx, mapped, remote);
      // The engine may have already claimed the row (e.g. to 'refunded') —
      // re-read instead of echoing the stale pre-sync status.
      const reread = await query(`SELECT * FROM bill_transactions WHERE id = $1`, [tx.id]);
      const row = reread.rows[0] || tx;
      return res.json({ success: true, data: { transaction: publicRow(row), updated: settled } });
    }
    return res.json({ success: true, data: { transaction: publicRow(tx), updated: false } });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

/**
 * SHARED SETTLEMENT ROUTER — every path that discovers the provider's verdict
 * (user poll, user sync, webhook, reaper) lands here so money ALWAYS moves
 * through the same idempotent engine:
 *   completed            → settleBillCompleted (vendor true-up, discount
 *                          revenue, late promo cashback) while 'processing';
 *                          correctWrongRefund for rows already refunded/failed
 *   failed/refunded/cxl  → refundBillRow, or reverseBillPayment when the row
 *                          had already been marked completed
 * Returns true when the row actually settled (vs. racing another settler).
 */
async function settleFromProviderReport(tx: any, mapped: string, remote: any): Promise<boolean> {
  const engine = await import("../bill-settlement");
  const remoteTx = remote?.transaction || remote;
  if (mapped === "completed") {
    if (tx.status === "processing") {
      // Claim-claim: settleBillCompleted is idempotent (status = 'processing'
      // guard) and books ALL completion ledgers; false just means another
      // settler won the race.
      return engine.settleBillCompleted(tx as any, remote);
    }
    // A refunded/failed/cancelled row the provider later completed — the
    // refund-correction engine re-debits idempotently (wallet permitting).
    await engine.correctWrongRefund(tx as any, remote);
    return true;
  }
  if (["refunded", "failed", "cancelled"].includes(mapped)) {
    if (tx.status === "completed") {
      // The provider failed a bill we had marked completed — provider
      // evidence, so the completed row may be reversed.
      await engine.reverseBillPayment(
        tx as any,
        `Provider reported: ${mapped}`,
        { providerResponse: remote, skipProviderCheck: true, providerReportedFailure: true },
      );
      return true;
    }
    await engine.refundBillRow(tx as any, `Provider reported: ${mapped}`, remoteTx);
    return true;
  }
  // processing/pending → nothing to settle.
  return false;
}

export default router;
