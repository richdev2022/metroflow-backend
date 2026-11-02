import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  debitWallet, creditWallet, insertTransaction,
  assertPersonalService, genRef, requirePersonalKyc,
} from "../personal-utils";
import * as bitnob from "../../../services/bitnob";
import * as bitnobV2 from "../../../services/providers/bitnob";
import { createNotification } from "../../../services/notifications";
import { getSetting } from "../../../services/app-config";

/**
 * VIRTUAL CARDS — REAL Bitnob USD virtual cards (no simulation).
 * Mounted at /virtualcards.
 *
 *   GET    /virtualcards                       → my cards { data: { cards, mode, kyc } }
 *   GET    /virtualcards/provider-status       → provider + KYC + fee config
 *   GET    /virtualcards/kyc-status            → card KYC state for the caller
 *   POST   /virtualcards/kyc                   → submit Bitnob Card KYC
 *   POST   /virtualcards/quote { amount_usd, category? | wallet_id? } → funding breakdown
 *   POST   /virtualcards       { name, amount, category?, card_brand?, contactless?, card_limits? }
 *   POST   /virtualcards/:id/fund      { amount, category? | wallet_id? }
 *   POST   /virtualcards/:id/withdraw  { amount }   → to the USDT stablecoin wallet
 *   PATCH  /virtualcards/:id/contact   { email?, mobile? }
 *   POST   /virtualcards/:id/freeze | /unfreeze
 *   DELETE /virtualcards/:id           { reason }
 *   GET    /virtualcards/:id/secure            → full card details (decrypted when RSA key set)
 *   GET    /virtualcards/:id/transactions      → app ledger + provider txns
 *
 * THE TWO CARD CATEGORIES
 *   · category "usdt" — funded 1:1 from the user's USDT stablecoin wallet
 *     (funding fee only). This is the primary rail: users convert NGN → USDT
 *     on the Convert page (live rate + spread via /crypto/stablecoin/convert)
 *     and the card spends from the Metricorex USDT wallet.
 *   · category "ngn" — funded straight from the NGN wallet at the live
 *     Bitnob USD/NGN rate (or the admin rate override) + funding and
 *     conversion fees.
 *
 * Bitnob requires a verified customer before issuing: we create the Bitnob
 * customer (individual, NGA) from the user's KYC profile, then submit Card
 * KYC (POST /api/cards/kyc) — the approved customer_id feeds Create Card.
 * Amounts cross the wire to Bitnob in MICRO-UNITS (1 USD = 1_000_000); the
 * app ledger stores plain USD.
 */

const router = express.Router();

// ---------------------------------------------------------------------------
// Card pricing knobs (system_settings, admin-managed)
//   virtualcard_issuance_fee_usd        flat USD fee per issued card (default 0)
//   virtualcard_funding_fee_percent     % of every funding amount   (default 1)
//   virtualcard_conversion_fee_percent  % applied when NGN→USD conversion happens (default 0.5)
//   virtualcard_ngn_usd_rate_override   NGN per USD; 0 = use the live provider rate
// ---------------------------------------------------------------------------
async function numSetting(key: string, fallback: number): Promise<number> {
  const raw = await getSetting(key, "");
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function cardFeeConfig() {
  const [issuanceFeeUsd, fundingFeePercent, conversionFeePercent, rateOverride] = await Promise.all([
    numSetting("virtualcard_issuance_fee_usd", 0),
    numSetting("virtualcard_funding_fee_percent", 1),
    numSetting("virtualcard_conversion_fee_percent", 0.5),
    numSetting("virtualcard_ngn_usd_rate_override", 0),
  ]);
  return { issuanceFeeUsd, fundingFeePercent, conversionFeePercent, rateOverride };
}

// ---------------------------------------------------------------------------
// Card KYC plumbing
// ---------------------------------------------------------------------------
type CardKycRow = {
  status: string;
  normalized_status: string | null;
  provider_customer_id: string | null;
  completion_link: string | null;
  rejection: any;
};

async function getCardKyc(userId: string): Promise<CardKycRow | null> {
  const r = await query(
    `SELECT status, normalized_status, provider_customer_id, completion_link, rejection
       FROM virtual_card_kyc WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

function maskIdNumber(value: string): string {
  const v = String(value || "").trim();
  if (v.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
}

/** Extract the customer identity Bitnob wants, from the user's KYC profile. */
async function buildKycCustomer(userId: string) {
  const u = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
  const user = u.rows[0];
  if (!user) throw new bitnob.BitnobError("User not found", "USER_NOT_FOUND", 404);
  let kyc: any = {};
  try { kyc = typeof user.kyc_data === "string" ? JSON.parse(user.kyc_data) : (user.kyc_data || {}); } catch { kyc = {}; }

  const fullName = String(user.name || kyc.firstName || "MetriCorex User");
  const first = String(kyc.firstName || fullName.split(" ")[0] || "MetriCorex").trim();
  const last = String(kyc.lastName || fullName.split(" ").slice(1).join(" ") || "User").trim();
  const email = String(user.email || kyc.email || "").trim();
  const phoneRaw = String(kyc.phoneNumber || user.phone_number || "").replace(/[^\d+]/g, "");
  // Bitnob wants the local number in phone_number and the dial code separately.
  const dialCode = phoneRaw.startsWith("+") ? phoneRaw.slice(0, 4).match(/^\+\d{1,3}$/)?.[0] || "+234" : "+234";
  const localPhone = phoneRaw.replace(/^\+\d{1,3}/, "") || phoneRaw;

  return {
    user,
    email,
    customer: {
      customer_type: "individual" as const,
      first_name: first,
      last_name: last,
      email,
      phone_number: localPhone || undefined,
      dial_code: dialCode,
      // Per product decision: every cardholder is an individual, Nigeria.
      country: "NGA",
      date_of_birth: kyc.dateOfBirth || undefined,
      line1: kyc.address || kyc.line1 || undefined,
      city: kyc.city || undefined,
      state: kyc.state || undefined,
      postal_code: kyc.postalCode || undefined,
    },
  };
}

async function ensureBitnobCustomer(userId: string, userName: string, email: string): Promise<string> {
  // 1) KYC-approved customer id is the authoritative one for card issuing.
  const kyc = await getCardKyc(userId);
  if (kyc?.provider_customer_id) return kyc.provider_customer_id;
  // 2) Any card this user already owns pins their customer.
  const existing = await query(
    `SELECT provider_customer_id FROM virtual_cards WHERE user_id = $1 AND provider_customer_id IS NOT NULL LIMIT 1`,
    [userId],
  );
  if (existing.rows.length) return existing.rows[0].provider_customer_id;
  // 3) Look the customer up by email, then create (individual / NGA).
  try {
    const found = await bitnob.listCustomers(email);
    const cust = found?.data?.content?.[0] || found?.data?.[0] || found?.[0];
    if (cust?.id || cust?.customer_id) return cust.id || cust.customer_id;
  } catch { /* not found → create */ }
  const [firstName, ...rest] = userName.split(" ");
  const created = await bitnob.createCustomer({
    firstName: firstName || "MetriCorex", lastName: rest.join(" ") || "User",
    email, countryCode: "NG",
  });
  const id = created?.data?.id || created?.data?.customer_id || created?.id;
  if (!id) throw new bitnob.BitnobError("Could not register the card customer", "BITNOB_CUSTOMER", 502);
  return id;
}

// ---------------------------------------------------------------------------
// Funding math — one source of truth for create / fund / quote.
//
//   category "usdt" → USDT/USDC/USD wallet, 1:1, funding fee only.
//   category "ngn"  → NGN wallet at the live Bitnob USD/NGN rate (or the
//                     admin override) + funding fee + conversion fee.
// ---------------------------------------------------------------------------
type FundingQuote = {
  walletId: string;
  walletCurrency: string;
  /** Wallet units per 1 USD (1 for stablecoins, NGN/USD rate for NGN). */
  fxRate: number;
  conversionApplied: boolean;
  rateOverridden: boolean;
  /** Amount debited from the wallet (wallet currency), excluding fees. */
  debitAmount: number;
  fundingFeePercent: number;
  fundingFee: number;
  conversionFeePercent: number;
  conversionFee: number;
  /** Flat USD issuance fee, converted into the wallet currency. */
  issuanceFeeUsd: number;
  issuanceFee: number;
  totalFees: number;
  totalDebit: number;
};

async function quoteFunding(wallet: any, amountUsd: number): Promise<FundingQuote> {
  const cfg = await cardFeeConfig();
  const walletCurrency = String(wallet.currency || "NGN").toUpperCase();
  const isStable = walletCurrency === "USDT" || walletCurrency === "USDC" || walletCurrency === "USD";
  let fxRate = 1;
  let conversionApplied = false;
  let rateOverridden = false;
  if (!isStable) {
    if (cfg.rateOverride > 0) {
      fxRate = cfg.rateOverride;
      rateOverridden = true;
    } else {
      const rate = await bitnob.getRate("USD", walletCurrency);
      fxRate = Number(rate) || 0;
    }
    if (!fxRate || fxRate <= 0) {
      throw new bitnob.BitnobError(`Live ${walletCurrency}/USD rate is unavailable — fund from a stablecoin wallet.`, "RATE_UNAVAILABLE", 503);
    }
    conversionApplied = true;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const debitAmount = r2(amountUsd * fxRate);
  const fundingFee = r2((debitAmount * cfg.fundingFeePercent) / 100);
  const conversionFee = conversionApplied ? r2((debitAmount * cfg.conversionFeePercent) / 100) : 0;
  const issuanceFee = r2(cfg.issuanceFeeUsd * fxRate);
  const totalFees = r2(fundingFee + conversionFee + issuanceFee);
  const totalDebit = r2(debitAmount + totalFees);
  return {
    walletId: wallet.id, walletCurrency, fxRate, conversionApplied, rateOverridden,
    debitAmount, fundingFeePercent: cfg.fundingFeePercent, fundingFee,
    conversionFeePercent: cfg.conversionFeePercent, conversionFee,
    issuanceFeeUsd: cfg.issuanceFeeUsd, issuanceFee, totalFees, totalDebit,
  };
}

async function resolveFundingWallet(userId: string, walletId: string | null | undefined, category?: string) {
  if (walletId) {
    const r = await query(
      `SELECT * FROM wallets WHERE id = $1 AND user_id = $2 AND business_id IS NULL AND status = 'active' LIMIT 1`,
      [walletId, userId],
    );
    if (r.rows[0]) return r.rows[0];
  }
  // Category default: "usdt" → USDT → USDC; "ngn" → NGN.
  const wantNgn = String(category || "").toLowerCase() === "ngn";
  const order = wantNgn
    ? `ORDER BY (currency = 'NGN') DESC, (currency = 'USDT') DESC, (currency = 'USDC') DESC, created_at ASC`
    : `ORDER BY (currency = 'USDT') DESC, (currency = 'USDC') DESC, (currency = 'NGN') DESC, created_at ASC`;
  const r = await query(
    `SELECT * FROM wallets WHERE user_id = $1 AND business_id IS NULL AND status = 'active'
      AND UPPER(currency) IN ('USDT','USDC','NGN') ${order} LIMIT 1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

function fundingBreakdown(q: FundingQuote) {
  return {
    wallet_id: q.walletId,
    wallet_currency: q.walletCurrency,
    conversion_applied: q.conversionApplied,
    rate_overridden: q.rateOverridden,
    fx_rate: q.fxRate,
    amount: q.debitAmount,
    issuance_fee: q.issuanceFee,
    funding_fee: q.fundingFee,
    conversion_fee: q.conversionFee,
    total_fees: q.totalFees,
    total: q.totalDebit,
    currency: q.walletCurrency,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "virtualcards"))) return;
    const userId = req.user!.userId;
    const rows = await query(
      `SELECT * FROM virtual_cards WHERE user_id = $1 AND status != 'terminated' AND COALESCE(name,'') <> 'kyc-record' ORDER BY created_at DESC`,
      [userId],
    );
    const kyc = await getCardKyc(userId);
    const cfg = await cardFeeConfig();
    const cards = rows.rows.map((c) => ({
      id: c.id,
      provider: c.provider,
      name: c.name,
      currency: c.currency,
      card_brand: c.card_brand,
      status: c.status,
      category: c.category || "usdt",
      contactless: c.contactless === true,
      masked_pan: c.masked_pan,
      balance: Number(c.balance),
      created_at: c.created_at,
    }));
    res.json({
      success: true,
      data: {
        cards,
        mode: bitnob.isBitnobConfigured() ? "bitnob" : "unconfigured",
        kyc: {
          status: kyc?.status || "not_submitted",
          customer_id: kyc?.provider_customer_id || null,
          completion_link: kyc?.completion_link || null,
          rejection: kyc?.rejection || null,
        },
        fees: {
          issuance_fee_usd: cfg.issuanceFeeUsd,
          funding_fee_percent: cfg.fundingFeePercent,
          conversion_fee_percent: cfg.conversionFeePercent,
          rate_overridden: cfg.rateOverride > 0,
          ngn_usd_rate: cfg.rateOverride > 0 ? cfg.rateOverride : null,
        },
      },
    });
  } catch (e: any) {
    console.error("vcards list error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load cards" });
  }
});

router.get("/provider-status", authenticateToken, async (req: AuthenticatedRequest, res) => {
  const kyc = await getCardKyc(req.user!.userId).catch(() => null);
  const cfg = await cardFeeConfig().catch(() => null);
  res.json({
    success: true,
    data: {
      provider: bitnob.isBitnobConfigured() ? "bitnob" : "unconfigured",
      configured: bitnob.isBitnobConfigured(),
      categories: [
        { key: "usdt", label: "USDT-funded card", description: "Fund 1:1 from your USDT stablecoin wallet — convert NGN on the Convert page first." },
        { key: "ngn", label: "NGN-funded card", description: "Debit your NGN wallet at the live USD rate (admin override applies) with conversion fees." },
      ],
      kyc: {
        status: kyc?.status || "not_submitted",
        customer_id: kyc?.provider_customer_id || null,
        completion_link: kyc?.completion_link || null,
        rejection: kyc?.rejection || null,
      },
      fees: cfg ? {
        issuance_fee_usd: cfg.issuanceFeeUsd,
        funding_fee_percent: cfg.fundingFeePercent,
        conversion_fee_percent: cfg.conversionFeePercent,
        rate_overridden: cfg.rateOverride > 0,
        ngn_usd_rate: cfg.rateOverride > 0 ? cfg.rateOverride : null,
      } : null,
      note: bitnob.isBitnobConfigured() ? null : "Add BITNOB_CLIENT_ID + BITNOB_SECRET_KEY (and whitelist the server IP in Bitnob) to enable cards.",
    },
  });
});

// ---------------------------------------------------------------------------
// Card KYC — GET status / POST submission
// ---------------------------------------------------------------------------
router.get("/kyc-status", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const kyc = await getCardKyc(req.user!.userId);
    const u = await query(`SELECT bvn, nin, bvn_status, nin_status, kyc_status FROM users WHERE id = $1`, [req.user!.userId]);
    const user = u.rows[0] || {};
    const idType = user.nin_status === "verified" ? "nin" : user.bvn_status === "verified" ? "bvn" : user.bvn ? "bvn" : user.nin ? "nin" : null;
    res.json({
      success: true,
      data: {
        status: kyc?.status || "not_submitted",
        normalized_status: kyc?.normalized_status || null,
        provider_customer_id: kyc?.provider_customer_id || null,
        completion_link: kyc?.completion_link || null,
        rejection: kyc?.rejection || null,
        suggested_id_type: idType,
        id_on_file: !!(user.bvn || user.nin),
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load card KYC status" });
  }
});

router.post("/kyc", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const existing = await getCardKyc(userId);
    if (existing?.status === "approved" && existing.provider_customer_id) {
      return res.json({ success: true, data: { status: "approved", customer_id: existing.provider_customer_id, already_verified: true } });
    }

    const {
      id_type, id_number, occupation, employment_status, account_purpose,
      annual_salary, expected_monthly_volume, place_of_birth,
      terms_of_service_accepted, id_front_image, id_back_image,
    } = req.body || {};

    const { user, email, customer } = await buildKycCustomer(userId);
    if (!email) return res.status(400).json({ success: false, error: "A verified email is required for card KYC" });

    // ID falls back to the user's verified BVN / NIN on file.
    const finalIdType = String(id_type || (user.bvn ? "bvn" : user.nin ? "nin" : "")).toLowerCase();
    const finalIdNumber = String(id_number || user.bvn || user.nin || "").trim();
    for (const [k, v] of Object.entries({
      id_type: finalIdType, id_number: finalIdNumber, occupation, employment_status,
      account_purpose, annual_salary, expected_monthly_volume,
    })) {
      if (!v) return res.status(400).json({ success: false, error: `Missing required field: ${k}` });
    }
    if (terms_of_service_accepted !== true) {
      return res.status(400).json({ success: false, error: "You must accept the terms of service to continue" });
    }
    const docTypes = ["passport", "drivers_license", "national_id", "vnin", "voters_card", "ghana_card"];
    if (docTypes.includes(finalIdType) && !id_front_image) {
      return res.status(400).json({ success: false, error: `${finalIdType} requires a photo of the ID front (id_front_image)` });
    }
    if (["bvn", "nin"].includes(finalIdType) && (id_front_image || id_back_image)) {
      return res.status(400).json({ success: false, error: "Do not attach ID images for bvn/nin verification" });
    }

    if (!bitnob.isBitnobConfigured()) {
      return res.status(503).json({ success: false, code: "PROVIDER_UNCONFIGURED", error: "Card issuing is being connected — try again shortly." });
    }

    const result = await bitnobV2.submitCardKyc({
      customer,
      id_type: finalIdType,
      id_number: finalIdNumber,
      occupation: String(occupation).toLowerCase().replace(/\s+/g, "_"),
      employment_status: String(employment_status).toLowerCase(),
      account_purpose: String(account_purpose),
      annual_salary: String(annual_salary),
      expected_monthly_volume: String(expected_monthly_volume),
      place_of_birth: place_of_birth || undefined,
      terms_of_service_accepted: true,
      webhook_url: process.env.API_BASE_URL ? `${process.env.API_BASE_URL.replace(/\/$/, "")}/api/webhook/bitnob` : undefined,
      id_front_image: docTypes.includes(finalIdType) ? id_front_image : undefined,
      id_back_image: finalIdType === "national_id" ? id_back_image : undefined,
    });

    const customerId = result?.data?.customer_id || null;
    const status = String(result?.data?.normalized_status || result?.data?.status || "pending").toLowerCase();
    await query(
      `INSERT INTO virtual_card_kyc
         (user_id, provider, provider_customer_id, status, normalized_status, id_type, id_number_masked,
          occupation, employment_status, account_purpose, annual_salary, expected_monthly_volume,
          place_of_birth, completion_link, provider_response)
       VALUES ($1,'bitnob',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET
         provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, virtual_card_kyc.provider_customer_id),
         status = EXCLUDED.status,
         normalized_status = EXCLUDED.normalized_status,
         id_type = EXCLUDED.id_type,
         id_number_masked = EXCLUDED.id_number_masked,
         occupation = EXCLUDED.occupation,
         employment_status = EXCLUDED.employment_status,
         account_purpose = EXCLUDED.account_purpose,
         annual_salary = EXCLUDED.annual_salary,
         expected_monthly_volume = EXCLUDED.expected_monthly_volume,
         place_of_birth = EXCLUDED.place_of_birth,
         completion_link = EXCLUDED.completion_link,
         provider_response = EXCLUDED.provider_response,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, customerId, status === "complete" ? "approved" : status, result?.data?.normalized_status || null,
       finalIdType, maskIdNumber(finalIdNumber), String(occupation).slice(0, 80), String(employment_status).slice(0, 40),
       String(account_purpose).slice(0, 120), String(annual_salary).slice(0, 30), String(expected_monthly_volume).slice(0, 30),
       place_of_birth ? String(place_of_birth).slice(0, 80) : null, result?.data?.completion_link || null, JSON.stringify(result?.data || {})],
    );

    if (customerId) {
      // Pin the verified customer onto the user's card rows so card creation
      // skips straight to Create Card.
      await query(
        `UPDATE virtual_cards SET provider_customer_id = $2 WHERE user_id = $1 AND provider_customer_id IS NULL`,
        [userId, customerId],
      );
    }
    if (status === "approved") {
      createNotification({
        userId,
        type: "system",
        title: "Card verification approved",
        message: "Your virtual card verification passed — you can create your USD card now.",
      }).catch(() => {});
    }
    res.json({
      success: true,
      data: {
        customer_id: customerId,
        status: status === "complete" ? "approved" : status,
        completion_link: result?.data?.completion_link || null,
      },
    });
  } catch (e: any) {
    const be = bitnob.bitnobErr(e);
    console.error("vcard kyc error:", be.message);
    res.status(be.status || 502).json({ success: false, code: be.code, error: be.message });
  }
});

/** POST /virtualcards/quote { amount_usd, category?, wallet_id? } — full fee breakdown before funding. */
router.post("/quote", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const amountUsd = Math.round(Number(req.body?.amount_usd) * 100) / 100;
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res.status(400).json({ success: false, error: "Enter a valid amount" });
    }
    const wallet = await resolveFundingWallet(userId, req.body?.wallet_id, req.body?.category);
    if (!wallet) return res.status(400).json({ success: false, error: "No active wallet found" });
    const q = await quoteFunding(wallet, amountUsd);
    const balRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [wallet.id]);
    res.json({
      success: true,
      data: {
        ...fundingBreakdown(q),
        amount_usd: amountUsd,
        balance: Number(balRes.rows[0]?.balance || 0),
        sufficient: Number(balRes.rows[0]?.balance || 0) >= q.totalDebit,
      },
    });
  } catch (e: any) {
    res.status(e?.status || 502).json({ success: false, code: e?.code, error: e?.message || "Quote unavailable" });
  }
});

router.post("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "virtualcards"))) return;
    const userId = req.user!.userId;
    const name = String(req.body?.name || "My Card").slice(0, 60);
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const category = String(req.body?.category || "usdt").toLowerCase() === "ngn" ? "ngn" : "usdt";
    const cardBrand = String(req.body?.card_brand || "visa").toLowerCase() === "mastercard" ? "mastercard" : "visa";
    const contactless = req.body?.contactless === true;
    if (!Number.isFinite(amount) || amount < 2) return res.status(400).json({ success: false, error: "Minimum $2 to create a card" });
    if (!bitnob.isBitnobConfigured()) {
      return res.status(503).json({ success: false, code: "PROVIDER_UNCONFIGURED", error: "Card issuing is being connected — try again shortly." });
    }

    // Card KYC gate — Bitnob issues only to verified customers.
    const kyc = await getCardKyc(userId);
    if (!kyc || kyc.status !== "approved" || !kyc.provider_customer_id) {
      return res.status(403).json({
        success: false, code: "CARD_KYC_REQUIRED",
        error: "Verify your identity once to unlock virtual cards",
        data: { kyc_status: kyc?.status || "not_submitted", completion_link: kyc?.completion_link || null },
      });
    }

    const u = await query(`SELECT name, email FROM users WHERE id = $1`, [userId]);
    const userName = u.rows[0]?.name || "MetriCorex User";
    const email = u.rows[0]?.email;

    const wallet = await resolveFundingWallet(userId, req.body?.wallet_id, category);
    if (!wallet) return res.status(400).json({ success: false, error: "An active wallet is required for cards" });
    const q = await quoteFunding(wallet, amount);
    if (Number(wallet.balance) < q.totalDebit) {
      return res.status(400).json({
        success: false, code: "INSUFFICIENT_BALANCE",
        error: `Insufficient ${q.walletCurrency} balance — this card needs ${q.totalDebit.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${q.walletCurrency} (${q.debitAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}${q.conversionApplied ? ` @ ${q.fxRate.toLocaleString()} ${q.walletCurrency}/USD${q.rateOverridden ? " (admin rate)" : ""}` : ""} + ${q.totalFees.toLocaleString(undefined, { maximumFractionDigits: 2 })} fees).`,
      });
    }

    const reference = genRef("MF-VC");
    if (!(await debitWallet(wallet.id, q.totalDebit))) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: `Insufficient ${q.walletCurrency} balance` });
    }
    await insertTransaction({
      userId, walletId: wallet.id, reference, type: "debit", transactionType: "vcard_create",
      amount: q.totalDebit, currency: q.walletCurrency,
      description: `Virtual card funding — ${name}${q.conversionApplied ? ` (@ ${q.fxRate.toLocaleString()} ${q.walletCurrency}/USD)` : ""}`,
    });
    if (q.totalFees > 0) {
      const { creditRevenueWallet } = await import("../../../services/fees");
      creditRevenueWallet(q.totalFees, q.walletCurrency, reference, "Virtual Card Fees (issuance/funding/conversion)", "virtualcards").catch(() => {});
    }

    const pending = await query(
      `INSERT INTO virtual_cards (user_id, provider, name, currency, card_brand, status, balance, wallet_id, reference, category, contactless, provider_customer_id)
       VALUES ($1,'bitnob',$2,'USD',$3,'pending',$4,$5,$6,$7,$8,$9) RETURNING id`,
      [userId, name, cardBrand, amount, wallet.id, reference, category, contactless, kyc.provider_customer_id],
    );
    await query(
      `INSERT INTO virtual_card_transactions (card_id, user_id, type, amount, fee, currency, status, description, reference)
       VALUES ($1,$2,'fund',$3,$4,$5,'success','Initial card funding',$6)`,
      [pending.rows[0].id, userId, amount, q.totalFees, q.walletCurrency, reference],
    );

    try {
      const customerId = await ensureBitnobCustomer(userId, userName, email);
      const created = await bitnob.createCard({
        customerId, name, amountUSD: amount, reference,
        webhookUrl: process.env.API_BASE_URL ? `${process.env.API_BASE_URL.replace(/\/$/, "")}/api/webhook/bitnob` : undefined,
      });
      const card = created?.data || created || {};
      await query(
        `UPDATE virtual_cards SET provider_card_id = $2, provider_customer_id = $3, status = 'active',
           masked_pan = $4, meta = $5::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [pending.rows[0].id, card.id || card.card_id || null, customerId,
         card.masked_pan || card.maskedPan || null, JSON.stringify(card)],
      );
      res.status(201).json({
        success: true,
        data: {
          card_id: pending.rows[0].id, status: "active", category,
          funding: fundingBreakdown(q),
        },
      });
    } catch (e: any) {
      const be = bitnob.bitnobErr(e);
      // Refund the funding on failure
      await creditWallet(wallet.id, q.totalDebit);
      await insertTransaction({
        userId, walletId: wallet.id, reference: `${reference}-REFUND`, type: "credit",
        transactionType: "vcard_refund", amount: q.totalDebit, currency: q.walletCurrency, description: "Refund — card creation failed",
      });
      await query(`UPDATE virtual_cards SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [pending.rows[0].id, be.message]);
      res.status(be.status || 502).json({ success: false, code: be.code, error: be.message });
    }
  } catch (e: any) {
    console.error("vcard create error:", e?.message);
    res.status(e?.status || 500).json({ success: false, code: e?.code, error: e?.message || "Could not create card" });
  }
});

async function ownedCard(userId: string, cardId: string) {
  const r = await query(`SELECT * FROM virtual_cards WHERE id = $1 AND user_id = $2`, [cardId, userId]);
  return r.rows[0] ?? null;
}

router.post("/:id/fund", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const card = await ownedCard(userId, String(req.params.id));
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (!card.provider_card_id) return res.status(400).json({ success: false, error: "Card is still provisioning — try again shortly" });
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "Enter a valid amount" });

    const wallet = await resolveFundingWallet(userId, req.body?.wallet_id, req.body?.category || card.category);
    if (!wallet) return res.status(400).json({ success: false, error: "No active wallet found" });
    const q = await quoteFunding(wallet, amount);
    if (Number(wallet.balance) < q.totalDebit) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: `Insufficient ${q.walletCurrency} balance` });
    }
    const reference = genRef("MF-VF");
    if (!(await debitWallet(wallet.id, q.totalDebit))) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: `Insufficient ${q.walletCurrency} balance` });
    }
    await insertTransaction({
      userId, walletId: wallet.id, reference, type: "debit", transactionType: "vcard_fund",
      amount: q.totalDebit, currency: q.walletCurrency,
      description: `Card top-up — ${card.name}${q.conversionApplied ? ` (@ ${q.fxRate.toLocaleString()} ${q.walletCurrency}/USD)` : ""}`,
    });
    if (q.fundingFee + q.conversionFee > 0) {
      const { creditRevenueWallet } = await import("../../../services/fees");
      creditRevenueWallet(q.fundingFee + q.conversionFee, q.walletCurrency, reference, "Virtual Card Funding Fee", "virtualcards").catch(() => {});
    }
    try {
      await bitnob.cardBalanceOp(card.provider_card_id, "fund", amount, reference);
      await query(`UPDATE virtual_cards SET balance = balance + $2, wallet_id = COALESCE(wallet_id, $3), updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, amount, wallet.id]);
      await query(
        `INSERT INTO virtual_card_transactions (card_id, user_id, type, amount, fee, currency, status, description, reference)
         VALUES ($1,$2,'fund',$3,$4,$5,'success','Card top-up',$6)`,
        [card.id, userId, amount, q.totalFees, q.walletCurrency, reference],
      );
      res.json({
        success: true,
        data: {
          status: "completed", amount,
          funding: fundingBreakdown(q),
        },
      });
    } catch (e: any) {
      await creditWallet(wallet.id, q.totalDebit);
      await insertTransaction({
        userId, walletId: wallet.id, reference: `${reference}-REFUND`, type: "credit",
        transactionType: "vcard_refund", amount: q.totalDebit, currency: q.walletCurrency, description: "Refund — card top-up failed",
      });
      throw e;
    }
  } catch (e: any) {
    const be = e?.code ? e : bitnob.bitnobErr(e);
    console.error("vcard fund error:", be.message);
    res.status(be.status || 500).json({ success: false, code: be.code, error: be.message });
  }
});

router.post("/:id/withdraw", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const card = await ownedCard(userId, String(req.params.id));
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (!card.provider_card_id) return res.status(400).json({ success: false, error: "Card is still provisioning" });
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "Enter a valid amount" });
    if (amount > Number(card.balance)) return res.status(400).json({ success: false, error: "Amount exceeds the card balance" });
    // Withdrawals always land in the USDT stablecoin wallet (the card's rail).
    const walletRes = await query(
      `SELECT id FROM wallets WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) IN ('USDT','USDC') AND status = 'active' ORDER BY (currency = 'USDT') DESC LIMIT 1`,
      [userId],
    );
    if (!walletRes.rows.length) return res.status(400).json({ success: false, error: "USD wallet required" });
    const walletId = walletRes.rows[0].id;
    const reference = genRef("MF-VW");
    try {
      await bitnob.cardBalanceOp(card.provider_card_id, "withdraw", amount, reference);
      await query(`UPDATE virtual_cards SET balance = GREATEST(0, balance - $2), updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, amount]);
      await query(
        `INSERT INTO virtual_card_transactions (card_id, user_id, type, amount, currency, status, description, reference)
         VALUES ($1,$2,'withdraw',$3,'USD','success','Card withdrawal',$4)`,
        [card.id, userId, amount, reference],
      );
      await creditWallet(walletId, amount);
      await insertTransaction({
        userId, walletId, reference, type: "credit", transactionType: "vcard_withdraw",
        amount, currency: "USD", description: `Card withdrawal — ${card.name}`,
      });
      res.json({ success: true, data: { status: "completed", amount } });
    } catch (e: any) {
      const be = bitnob.bitnobErr(e);
      res.status(be.status || 502).json({ success: false, code: be.code, error: be.message });
    }
  } catch (e: any) {
    console.error("vcard withdraw error:", e?.message);
    res.status(500).json({ success: false, error: "Could not withdraw" });
  }
});

/** PATCH /:id/contact — cardholder notification details (email / mobile). */
router.patch("/:id/contact", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const card = await ownedCard(req.user!.userId, String(req.params.id));
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (!card.provider_card_id) return res.status(400).json({ success: false, error: "Card is still provisioning" });
    const email = req.body?.email ? String(req.body.email).trim() : undefined;
    const mobile = req.body?.mobile ? String(req.body.mobile).trim() : undefined;
    if (!email && !mobile) return res.status(400).json({ success: false, error: "Provide an email and/or mobile number" });
    if (!bitnob.isBitnobConfigured()) return res.status(503).json({ success: false, error: "Card provider not configured" });
    const result = await bitnobV2.updateCardContact(card.provider_card_id, { email, mobile });
    res.json({ success: true, data: { updated: true, provider: result?.data || null } });
  } catch (e: any) {
    const be = bitnob.bitnobErr(e);
    res.status(be.status || 502).json({ success: false, code: be.code, error: be.message });
  }
});

router.post("/:id/:action", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    if (!["freeze", "unfreeze"].includes(String(req.params.action))) {
      return res.status(400).json({ success: false, error: "Unknown action" });
    }
    const card = await ownedCard(req.user!.userId, String(req.params.id));
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (!card.provider_card_id) return res.status(400).json({ success: false, error: "Card is still provisioning" });
    const status = req.params.action === "freeze" ? "frozen" : "active";
    if (!bitnob.isBitnobConfigured()) {
      // Local-only state change is still honest for freeze (no money moves).
      await query(`UPDATE virtual_cards SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, status]);
      return res.json({ success: true, data: { status } });
    }
    try {
      await bitnob.setCardStatus(card.provider_card_id, req.params.action === "freeze" ? "frozen" : "active");
      await query(`UPDATE virtual_cards SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, status]);
      res.json({ success: true, data: { status } });
    } catch (e: any) {
      const be = bitnob.bitnobErr(e);
      res.status(be.status || 502).json({ success: false, code: be.code, error: be.message });
    }
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not update card" });
  }
});

router.delete("/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const card = await ownedCard(req.user!.userId, String(req.params.id));
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    const balance = Number(card.balance);
    if (balance > 0 && card.provider_card_id && bitnob.isBitnobConfigured()) {
      // Withdraw remaining balance first.
      try {
        const reference = genRef("MF-VT");
        await bitnob.cardBalanceOp(card.provider_card_id, "withdraw", balance, reference);
        const walletRes = await query(
          `SELECT id FROM wallets WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) IN ('USDT','USDC') AND status = 'active' ORDER BY (currency = 'USDT') DESC LIMIT 1`,
          [req.user!.userId],
        );
        if (walletRes.rows.length) {
          await creditWallet(walletRes.rows[0].id, balance);
          await insertTransaction({
            userId: req.user!.userId, walletId: walletRes.rows[0].id, reference: `${reference}-BAL`,
            type: "credit", transactionType: "vcard_terminate", amount: balance, currency: "USD",
            description: `Card terminated — balance returned`,
          });
        }
      } catch (e: any) {
        const be = bitnob.bitnobErr(e);
        return res.status(be.status || 502).json({ success: false, code: be.code, error: `Could not return the card balance: ${be.message}` });
      }
    }
    if (card.provider_card_id && bitnob.isBitnobConfigured()) {
      try { await bitnob.terminateCard(card.provider_card_id, String(req.body?.reason || "user_requested")); } catch { /* best effort */ }
    }
    await query(
      `UPDATE virtual_cards SET status = 'terminated', balance = 0, terminated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [card.id],
    );
    res.json({ success: true, message: "Card terminated" });
  } catch (e: any) {
    console.error("vcard terminate error:", e?.message);
    res.status(500).json({ success: false, error: "Could not terminate card" });
  }
});

router.get("/:id/secure", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const card = await ownedCard(req.user!.userId, String(req.params.id));
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (!card.provider_card_id) return res.status(400).json({ success: false, error: "Card is still provisioning — check back shortly" });
    if (!bitnob.isBitnobConfigured()) return res.status(503).json({ success: false, error: "Card provider not configured" });

    // Preferred: v2 secure endpoint + local decryption (RSA-OAEP-256 +
    // AES-256-GCM) when BITNOB_RSA_PRIVATE_KEY is registered.
    let d: any = null;
    try {
      const secure: any = await bitnobV2.getCardSecureDetails(card.provider_card_id);
      const enc = secure?.data?.encrypted_details;
      const decrypted = enc ? await bitnobV2.decryptCardSecureDetails(enc) : null;
      d = decrypted || secure?.data || null;
      if (secure?.data?.balance_amount != null) {
        d = { ...(d || {}), balance_amount: secure.data.balance_amount, balance_currency: secure.data.balance_currency };
      }
    } catch { /* fall through to the legacy endpoint */ }
    if (!d) {
      const legacy = await bitnob.cardSecure(card.provider_card_id);
      d = legacy?.data || legacy || {};
    }
    const expiry = d.expiry || (d.expiry_month && d.expiry_year ? `${String(d.expiry_month).padStart(2, "0")}/${String(d.expiry_year).slice(-2)}` : d.expiration || d.expiry_date || null);
    const balanceMinor = Number(d.balance_amount);
    res.json({
      success: true,
      data: {
        card_number: d.card_number || d.pan || d.cardNumber || null,
        expiry,
        cvv: d.cvv || d.cvc || null,
        name: d.name || null,
        balance: Number.isFinite(balanceMinor) && balanceMinor > 1000 ? balanceMinor / (String(d.balance_currency).toUpperCase() === "USD" ? 100 : 100) : (Number(card.balance) || 0),
        note: "Keep these details private.",
      },
    });
  } catch (e: any) {
    const be = bitnob.bitnobErr(e);
    res.status(be.status || 502).json({ success: false, code: be.code, error: be.message });
  }
});

router.get("/:id/transactions", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const card = await ownedCard(req.user!.userId, String(req.params.id));
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const app = await query(
      `SELECT id, type, status, amount, currency, description, created_at FROM virtual_card_transactions
       WHERE card_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [card.id],
    );
    let providerTxns: any[] = [];
    let nextCursor: string | null = null;
    if (card.provider_card_id && bitnob.isBitnobConfigured()) {
      try {
        const tx = cursor
          ? await bitnobV2.getCardTransactions(card.provider_card_id, cursor)
          : await bitnob.cardTransactions(card.provider_card_id);
        providerTxns = tx?.data?.transactions || tx?.data?.content || tx?.data || [];
        nextCursor = tx?.data?.page_info?.next_cursor || null;
      } catch { /* provider txns optional */ }
    }
    res.json({
      success: true,
      data: {
        transactions: app.rows,
        provider_transactions: providerTxns, // micro-units — the client divides by 1e6
        next_cursor: nextCursor,
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load transactions" });
  }
});

export default router;
