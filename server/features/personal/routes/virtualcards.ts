import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  assertPersonalService, genRef,
} from "../personal-utils";
import * as bitnob from "../../../services/bitnob";
import { createNotification } from "../../../services/notifications";

/**
 * VIRTUAL CARDS — REAL Bitnob USD virtual cards (no simulation).
 * Mounted at /virtualcards.
 *
 *   GET    /virtualcards                       → my cards { data: { cards, mode } }
 *   GET    /virtualcards/provider-status       → provider readiness
 *   POST   /virtualcards       { name?, amount } → issue + fund a card
 *   POST   /virtualcards/:id/fund      { amount }  → top up from USD wallet
 *   POST   /virtualcards/:id/withdraw  { amount }  → withdraw to USD wallet
 *   POST   /virtualcards/:id/freeze | /unfreeze
 *   DELETE /virtualcards/:id           { reason }
 *   GET    /virtualcards/:id/secure            → full card details
 *   GET    /virtualcards/:id/transactions      → app ledger + provider txns (micro-units)
 *
 * Bitnob cards require a KYC'd customer — we create the Bitnob customer from
 * the user's KYC profile on first card. Amounts cross the wire to Bitnob in
 * MICRO-UNITS (1 USD = 1_000_000); the app ledger stores plain USD.
 */

const router = express.Router();

async function ensureBitnobCustomer(userId: string, userName: string, email: string): Promise<string> {
  const existing = await query(
    `SELECT provider_customer_id FROM virtual_cards WHERE user_id = $1 AND provider_customer_id IS NOT NULL LIMIT 1`,
    [userId],
  );
  if (existing.rows.length) return existing.rows[0].provider_customer_id;
  // Look up by email first, then create.
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
// The user picks ANY of their active personal wallets:
//   · Stablecoin wallet (USDT / USDC) → 1:1 USD. Fee only, NO conversion rate.
//   · NGN wallet → live Bitnob USD rate applied + the funding fee.
// ---------------------------------------------------------------------------
type FundingQuote = {
  walletId: string;
  walletCurrency: string;
  /** Wallet units per 1 USD (1 for stablecoins, live NGN/USD rate for NGN). */
  fxRate: number;
  conversionApplied: boolean;
  /** Amount debited from the wallet (wallet currency), excluding the fee. */
  debitAmount: number;
  feePercent: number;
  fee: number;
  totalDebit: number;
};

async function fundingFeePercent(): Promise<number> {
  const { getPercent } = await import("../flags");
  return getPercent("virtualcard_funding_fee_percent", 1);
}

async function quoteFunding(wallet: any, amountUsd: number): Promise<FundingQuote> {
  const walletCurrency = String(wallet.currency || "NGN").toUpperCase();
  const isStable = walletCurrency === "USDT" || walletCurrency === "USDC" || walletCurrency === "USD";
  let fxRate = 1;
  let conversionApplied = false;
  if (!isStable) {
    // Live Bitnob rate (wallet currency per 1 USD). No hardcoded fallback —
    // we refuse instead of guessing (same policy as the transfer rails).
    const rate = await bitnob.getRate("USD", walletCurrency);
    fxRate = Number(rate) || 0;
    if (!fxRate || fxRate <= 0) {
      throw new bitnob.BitnobError(`Live ${walletCurrency}/USD rate is unavailable — fund from a stablecoin wallet.`, "RATE_UNAVAILABLE", 503);
    }
    conversionApplied = true;
  }
  const debitAmount = Math.round(amountUsd * fxRate * 100) / 100;
  const feePercent = await fundingFeePercent();
  const fee = Math.round(debitAmount * feePercent) / 100;
  const totalDebit = Math.round((debitAmount + fee) * 100) / 100;
  return { walletId: wallet.id, walletCurrency, fxRate, conversionApplied, debitAmount, feePercent, fee, totalDebit };
}

async function resolveFundingWallet(userId: string, walletId: string | null | undefined) {
  if (walletId) {
    const r = await query(
      `SELECT * FROM wallets WHERE id = $1 AND user_id = $2 AND business_id IS NULL AND status = 'active' LIMIT 1`,
      [walletId, userId],
    );
    if (r.rows[0]) return r.rows[0];
  }
  // Default: USDT → USDC → NGN — stablecoin first (fee-only funding is cheapest).
  const r = await query(
    `SELECT * FROM wallets WHERE user_id = $1 AND business_id IS NULL AND status = 'active'
      AND UPPER(currency) IN ('USDT','USDC','NGN')
     ORDER BY (currency = 'USDT') DESC, (currency = 'USDC') DESC, (currency = 'NGN') DESC, created_at ASC
     LIMIT 1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "virtualcards"))) return;
    const rows = await query(
      `SELECT * FROM virtual_cards WHERE user_id = $1 AND status != 'terminated' ORDER BY created_at DESC`,
      [req.user!.userId],
    );
    const cards = rows.rows.map((c) => ({
      id: c.id,
      provider: c.provider,
      name: c.name,
      currency: c.currency,
      card_brand: c.card_brand,
      status: c.status,
      masked_pan: c.masked_pan,
      balance: Number(c.balance),
      created_at: c.created_at,
    }));
    res.json({ success: true, data: { cards, mode: bitnob.isBitnobConfigured() ? "bitnob" : "unconfigured" } });
  } catch (e: any) {
    console.error("vcards list error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load cards" });
  }
});

router.get("/provider-status", authenticateToken, async (_req, res) => {
  res.json({
    success: true,
    data: {
      provider: bitnob.isBitnobConfigured() ? "bitnob" : "unconfigured",
      configured: bitnob.isBitnobConfigured(),
      note: bitnob.isBitnobConfigured() ? null : "Add BITNOB_API_KEY + BITNOB_CLIENT_ID (and whitelist the server IP in Bitnob) to enable cards.",
    },
  });
});

/** POST /virtualcards/quote { amount_usd, wallet_id? } — show rate + fees before funding. */
router.post("/quote", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const amountUsd = Math.round(Number(req.body?.amount_usd) * 100) / 100;
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res.status(400).json({ success: false, error: "Enter a valid amount" });
    }
    const wallet = await resolveFundingWallet(userId, req.body?.wallet_id);
    if (!wallet) return res.status(400).json({ success: false, error: "No active wallet found" });
    const q = await quoteFunding(wallet, amountUsd);
    const balRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [wallet.id]);
    res.json({
      success: true,
      data: {
        wallet_id: q.walletId,
        wallet_currency: q.walletCurrency,
        conversion_applied: q.conversionApplied,
        fx_rate: q.fxRate,
        amount: q.debitAmount,
        fee: q.fee,
        fee_percent: q.feePercent,
        total: q.totalDebit,
        currency: q.walletCurrency,
        balance: Number(balRes.rows[0]?.balance || 0),
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
    if (!Number.isFinite(amount) || amount < 2) return res.status(400).json({ success: false, error: "Minimum $2 to create a card" });
    if (!bitnob.isBitnobConfigured()) {
      return res.status(503).json({ success: false, code: "PROVIDER_UNCONFIGURED", error: "Card issuing is being connected — try again shortly." });
    }

    const u = await query(`SELECT name, email, avatar_url FROM users WHERE id = $1`, [userId]);
    const userName = u.rows[0]?.name || "MetriCorex User";
    const email = u.rows[0]?.email;

    // Wallet selection: the caller picks any active personal wallet (NGN,
    // USDT, USDC). Stablecoin funds 1:1 (fee only); NGN converts at the live
    // Bitnob rate with the funding fee applied on top.
    const wallet = await resolveFundingWallet(userId, req.body?.wallet_id);
    if (!wallet) return res.status(400).json({ success: false, error: "An active wallet is required for cards" });
    const q = await quoteFunding(wallet, amount);
    if (Number(wallet.balance) < q.totalDebit) {
      return res.status(400).json({
        success: false, code: "INSUFFICIENT_BALANCE",
        error: `Insufficient ${q.walletCurrency} balance — this card needs ${q.totalDebit.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${q.walletCurrency} (${q.debitAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}${q.conversionApplied ? ` @ ${q.fxRate.toLocaleString()} ${q.walletCurrency}/USD` : ""} + ${q.fee.toLocaleString(undefined, { maximumFractionDigits: 2 })} fee).`,
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
    if (q.fee > 0) {
      const { creditRevenueWallet } = await import("../../../services/fees");
      creditRevenueWallet(q.fee, q.walletCurrency, reference, "Virtual Card Funding Fee", "virtualcards").catch(() => {});
    }

    const pending = await query(
      `INSERT INTO virtual_cards (user_id, provider, name, currency, card_brand, status, balance, wallet_id)
       VALUES ($1,'bitnob',$2,'USD','visa','pending',$3,$4) RETURNING id`,
      [userId, name, amount, wallet.id],
    );
    await query(
      `INSERT INTO virtual_card_transactions (card_id, user_id, type, amount, fee, currency, status, description, reference)
       VALUES ($1,$2,'fund',$3,$4,$5,'success','Initial card funding',$6)`,
      [pending.rows[0].id, userId, amount, q.fee, q.walletCurrency, reference],
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
          card_id: pending.rows[0].id, status: "active",
          funding: { currency: q.walletCurrency, amount: q.debitAmount, fee: q.fee, total: q.totalDebit, fx_rate: q.fxRate, conversion_applied: q.conversionApplied },
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

router.post("/:id/fund", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const card = await ownedCard(userId, String(req.params.id));
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (!card.provider_card_id) return res.status(400).json({ success: false, error: "Card is still provisioning — try again shortly" });
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "Enter a valid amount" });

    // Wallet selection: caller picks any active personal wallet. Stablecoin
    // funds 1:1 (fee only, no conversion); NGN converts at the live Bitnob
    // rate with the funding fee on top.
    const wallet = await resolveFundingWallet(userId, req.body?.wallet_id);
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
    if (q.fee > 0) {
      const { creditRevenueWallet } = await import("../../../services/fees");
      creditRevenueWallet(q.fee, q.walletCurrency, reference, "Virtual Card Funding Fee", "virtualcards").catch(() => {});
    }
    try {
      await bitnob.cardBalanceOp(card.provider_card_id, "fund", amount, reference);
      await query(`UPDATE virtual_cards SET balance = balance + $2, wallet_id = COALESCE(wallet_id, $3), updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, amount, wallet.id]);
      await query(
        `INSERT INTO virtual_card_transactions (card_id, user_id, type, amount, fee, currency, status, description, reference)
         VALUES ($1,$2,'fund',$3,$4,$5,'success','Card top-up',$6)`,
        [card.id, userId, amount, q.fee, q.walletCurrency, reference],
      );
      res.json({
        success: true,
        data: {
          status: "completed", amount,
          funding: { currency: q.walletCurrency, amount: q.debitAmount, fee: q.fee, total: q.totalDebit, fx_rate: q.fxRate, conversion_applied: q.conversionApplied },
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

router.post("/:id/withdraw", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const card = await ownedCard(userId, String(req.params.id));
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (!card.provider_card_id) return res.status(400).json({ success: false, error: "Card is still provisioning" });
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "Enter a valid amount" });
    if (amount > Number(card.balance)) return res.status(400).json({ success: false, error: "Amount exceeds the card balance" });
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
    const secure = await bitnob.cardSecure(card.provider_card_id);
    const d = secure?.data || secure || {};
    res.json({
      success: true,
      data: {
        card_number: d.card_number || d.pan || d.cardNumber || null,
        expiry: d.expiry || d.expiration || d.expiry_date || null,
        cvv: d.cvv || d.cvc || null,
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
    const app = await query(
      `SELECT id, type, status, amount, currency, description, created_at FROM virtual_card_transactions
       WHERE card_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [card.id],
    );
    let providerTxns: any[] = [];
    if (card.provider_card_id && bitnob.isBitnobConfigured()) {
      try {
        const tx = await bitnob.cardTransactions(card.provider_card_id);
        providerTxns = tx?.data?.content || tx?.data || [];
      } catch { /* provider txns optional */ }
    }
    res.json({
      success: true,
      data: {
        transactions: app.rows,
        provider_transactions: providerTxns, // micro-units — the client divides by 1e6
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load transactions" });
  }
});

export default router;
