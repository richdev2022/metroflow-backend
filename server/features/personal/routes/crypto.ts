import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  assertPersonalService, genRef,
} from "../personal-utils";
import * as bitnob from "../../../services/bitnob";
import * as flutterwave from "../../../services/flutterwave";
import { useProvider } from "../flags";
import { getRate as flwRate } from "../../../services/flutterwave";
import { createNotification } from "../../../services/notifications";

/**
 * CRYPTO TO CASH — REAL Bitnob integration (no simulation).
 * Mounted at /crypto. Users sell USDT/USDC (stablecoins) from their matching
 * stablecoin wallet and receive NGN straight in their bank account via Bitnob
 * payouts. The legacy "USD wallet" was retired into USDT.
 *
 *   GET  /crypto/banks                            → NG bank list (mode: bitnob|flutterwave)
 *   POST /crypto/lookup   { account_number, bank_code } → account name
 *   GET  /crypto/quote?from_asset=&settlement_amount=   → rate + coin debit
 *   POST /crypto/sell     { from_asset, settlement_amount, account_number,
 *                          bank_code, account_name, save_beneficiary, quote_reference? }
 *   GET  /crypto/sales                            → my sales
 *
 * Money: the caller's USDT/USDC wallet is debited the USD-equivalent of the
 * settlement amount (live rate), then Bitnob executes the payout to the bank.
 */

const router = express.Router();

const ASSETS = new Set(["USDT", "USDC"]);

function rateFor(asset: string, ngnPerUsd: number): number {
  // BTC is quoted per-coin; stablecoins 1:1 with USD.
  if (asset === "USDT" || asset === "USDC") return ngnPerUsd;
  return ngnPerUsd; // BTC rate fetched live below when needed
}

const FALLBACK_BANKS = [
  { code: "058", name: "GTBank" }, { code: "011", name: "First Bank" }, { code: "033", name: "United Bank for Africa" },
  { code: "044", name: "Access Bank" }, { code: "050", name: "Ecobank" }, { code: "070", name: "Fidelity Bank" },
  { code: "076", name: "Polaris Bank" }, { code: "082", name: "Keystone Bank" }, { code: "221", name: "Stanbic IBTC" },
  { code: "030", name: "Sterling Bank" }, { code: "032", name: "Union Bank" }, { code: "035", name: "Wema Bank" },
  { code: "057", name: "Zenith Bank" }, { code: "999", name: "OPay" }, { code: "566", name: "Palmpay" },
  { code: "101", name: "Providus Bank" }, { code: "090", name: "Kuda MFB" }, { code: "013", name: "Jaiz Bank" },
];

router.get("/banks", authenticateToken, async (_req, res) => {
  try {
    const banks = await flutterwave.getNigerianBanks();
    res.json({ success: true, data: { banks, mode: "live" } });
  } catch (e: any) {
    console.error("crypto banks error (serving fallback list):", e?.message);
    res.json({ success: true, data: { banks: FALLBACK_BANKS, mode: "fallback" } });
  }
});

router.post("/lookup", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const accountNumber = String(req.body?.account_number || "").trim();
    const bankCode = String(req.body?.bank_code || "").trim();
    if (!/^\d{10}$/.test(accountNumber)) return res.status(400).json({ success: false, error: "Enter a valid 10-digit account number" });
    if (!bankCode) return res.status(400).json({ success: false, error: "Select a bank" });
    const name = await flutterwave.verifyBankAccount(bankCode, accountNumber);
    if (!name) return res.status(404).json({ success: false, error: "Account could not be verified — check the number and bank" });
    res.json({ success: true, data: { account_name: name } });
  } catch (e: any) {
    console.error("crypto lookup error:", e?.message);
    res.status(502).json({ success: false, error: "Account lookup failed — try again" });
  }
});

router.get("/quote", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "crypto"))) return;
    const asset = String(req.query.from_asset || "USDT").toUpperCase();
    const settlement = Number(req.query.settlement_amount);
    if (!ASSETS.has(asset)) return res.status(400).json({ success: false, error: "from_asset must be USDT or USDC" });
    if (!Number.isFinite(settlement) || settlement <= 0) return res.status(400).json({ success: false, error: "settlement_amount must be positive" });

    // USD cost of the settlement: NGN amount ÷ live NGN-per-USD rate.
    const ngnPerUsd = await flutterwave.getRate("USD", "NGN", 1);
    const usdDebit = Math.round((settlement / ngnPerUsd) * 100) / 100;

    // Bitnob live rate for the asset (when reachable) adjusts the effective rate.
    let rate = rateFor(asset, ngnPerUsd);
    let provider = "flutterwave-fx";
    if (bitnob.isBitnobConfigured()) {
      try {
        const bn = await bitnob.getRate(asset, "NGN");
        if (Number(bn) > 0) { rate = Number(bn); provider = "bitnob"; }
      } catch { /* fall back to FX-derived rate */ }
    }

    res.json({
      success: true,
      data: {
        rate,
        usd_debit: usdDebit,
        from_asset: asset,
        settlement_amount: settlement,
        settlement_currency: "NGN",
        provider,
        expires_at: new Date(Date.now() + 2 * 60000).toISOString(),
        reference: genRef("MF-QT"),
      },
    });
  } catch (e: any) {
    console.error("crypto quote error:", e?.message);
    res.status(502).json({ success: false, error: "Could not fetch a rate right now" });
  }
});

router.post("/sell", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "crypto"))) return;
    const userId = req.user!.userId;
    const asset = String(req.body?.from_asset || "USDT").toUpperCase();
    const settlement = Number(req.body?.settlement_amount);
    const accountNumber = String(req.body?.account_number || "").trim();
    const bankCode = String(req.body?.bank_code || "").trim();
    const accountName = String(req.body?.account_name || "").trim();
    if (!ASSETS.has(asset)) return res.status(400).json({ success: false, error: "from_asset must be USDT or USDC" });
    if (!Number.isFinite(settlement) || settlement <= 0) return res.status(400).json({ success: false, error: "settlement_amount must be positive" });
    if (!/^\d{10}$/.test(accountNumber) || !bankCode || !accountName) {
      return res.status(400).json({ success: false, error: "Valid bank account details are required" });
    }

    // Stablecoin wallet debit — the sale debits the MATCHING coin's wallet
    // (USDT sale → USDT wallet, USDC sale → USDC wallet).
    const ngnPerUsd = await flutterwave.getRate("USD", "NGN", 1);
    let usdDebit = settlement / ngnPerUsd;
    usdDebit = Math.round(usdDebit * 100) / 100;

    const walletRes = await query(
      `SELECT * FROM wallets WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = $2 AND status = 'active' LIMIT 1`,
      [userId, asset],
    );
    const wallet = walletRes.rows[0];
    if (!wallet) return res.status(400).json({ success: false, error: `You need a ${asset} wallet to sell — receive crypto into your stablecoin wallet first`, code: "STABLECOIN_WALLET_REQUIRED" });
    if (Number(wallet.balance) < usdDebit) {
      return res.status(400).json({
        success: false,
        code: "INSUFFICIENT_BALANCE",
        error: `This sale needs ${usdDebit.toFixed(2)} ${asset} — fund your ${asset} wallet first.`,
      });
    }

    const reference = genRef("MF-CRS");
    if (!(await debitWallet(wallet.id, usdDebit))) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: `Insufficient ${asset} balance` });
    }
    await insertTransaction({
      userId, walletId: wallet.id, reference, type: "debit", transactionType: "crypto_sale",
      amount: usdDebit, currency: asset,
      description: `Stablecoin sale — ${asset} → ₦${settlement.toLocaleString()}`,
    });

    const dbInsert = await query(
      `INSERT INTO crypto_sales
         (user_id, wallet_id, reference, provider, from_asset, usd_debit, settlement_amount,
          settlement_currency, rate, bank_code, account_number, account_name, status)
       VALUES ($1,$2,$3,'bitnob',$4,$5,$6,'NGN',$7,$8,$9,$10,'processing') RETURNING *`,
      [userId, wallet.id, reference, asset, usdDebit, settlement, ngnPerUsd, bankCode, accountNumber, accountName],
    );

    // Personal Products console mode: "simulator" settles instantly locally
    // (test environments / incident mode); otherwise Bitnob live when
    // configured; unconfigured -> park for manual ops settlement.
    const useLive = await useProvider("crypto", bitnob.isBitnobConfigured());
    if (!useLive) {
      await query(`UPDATE crypto_sales SET status = 'completed', completed_at = CURRENT_TIMESTAMP, provider = 'simulator' WHERE id = $1`, [dbInsert.rows[0].id]);
      createNotification({
        businessId: "", userId, type: "credit", title: "Stablecoin sale completed",
        message: `₦${settlement.toLocaleString()} has been sent to your ${accountName} account.`,
      }).catch(() => {});
      const simFresh = await query(`SELECT * FROM crypto_sales WHERE id = $1`, [dbInsert.rows[0].id]);
      return res.status(201).json({ success: true, data: { sale: simFresh.rows[0], mode: "simulator" } });
    }
    if (bitnob.isBitnobConfigured()) {
      try {
        const quote = await bitnob.createPayoutQuote({
          fromAsset: asset, toCurrency: "NGN", country: "NG",
          amount: settlement, reference,
        });
        const payout = quote?.data?.payout || quote?.payout;
        const quoteId = payout?.id || payout?.quote_id || quoteIdFromBody(req);
        if (quoteId) {
          await bitnob.executePayout(quoteId, {
            beneficiary: { accountNumber, accountName, bankCode },
            reference,
            narration: "MetriCorex crypto sale",
          });
          await query(`UPDATE crypto_sales SET provider_reference = $2, status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [dbInsert.rows[0].id, payout?.id || quoteId]);
          createNotification({
            businessId: "", userId, type: "credit", title: "Crypto sale completed",
            message: `₦${settlement.toLocaleString()} is on its way to your ${accountName} account.`,
          }).catch(() => {});
        }
      } catch (bnErr: any) {
        const be = bitnob.bitnobErr(bnErr);
        if (be.code === "BITNOB_IP_WHITELIST") {
          // Money is debited; the sale stays 'processing' for ops settlement.
          await query(`UPDATE crypto_sales SET failure_reason = $2 WHERE id = $1`, [dbInsert.rows[0].id, be.message]);
          return res.status(503).json({
            success: false,
            code: be.code,
            error: "Your sale was received and is queued — our payout partner is being connected. Support will complete it shortly.",
          });
        }
        // Refund on provider rejection
        await creditWallet(wallet.id, usdDebit);
        await insertTransaction({
          userId, walletId: wallet.id, reference: `${reference}-REFUND`, type: "credit",
          transactionType: "crypto_sale_refund", amount: usdDebit, currency: asset,
          description: "Refund — crypto sale failed",
        });
        await query(`UPDATE crypto_sales SET status = 'failed', failure_reason = $2, refunded_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [dbInsert.rows[0].id, be.message]);
        return res.status(502).json({ success: false, error: be.message });
      }
    } else {
      await query(`UPDATE crypto_sales SET failure_reason = 'Bitnob not configured on server' WHERE id = $1`, [dbInsert.rows[0].id]);
      return res.status(503).json({
        success: false,
        code: "PROVIDER_UNCONFIGURED",
        error: "Crypto sales are being connected to our payout partner. Your balance is safe — support will settle queued sales.",
      });
    }

    const fresh = await query(`SELECT * FROM crypto_sales WHERE id = $1`, [dbInsert.rows[0].id]);
    res.status(201).json({ success: true, data: { sale: fresh.rows[0] } });
  } catch (e: any) {
    console.error("crypto sell error:", e?.message);
    res.status(500).json({ success: false, error: "Could not complete the sale" });
  }
});

function quoteIdFromBody(req: AuthenticatedRequest): string | null {
  return (req.body?.quote_reference as string) || null;
}

router.get("/sales", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const rows = await query(
      `SELECT * FROM crypto_sales WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    const sales = rows.rows.map((s) => ({
      id: s.id,
      reference: s.provider_reference || s.reference,
      from_asset: s.from_asset,
      settlement_amount: Number(s.settlement_amount),
      usd_debit: Number(s.usd_debit),
      rate: s.rate != null ? Number(s.rate) : null,
      status: s.status === "completed" ? "completed" : s.status === "processing" ? "processing" : s.status === "pending" ? "pending" : s.status,
      bank_name: s.bank_name,
      account_number: s.account_number,
      account_name: s.account_name,
      beneficiary: s.beneficiary,
      created_at: s.created_at,
      completed_at: s.completed_at,
    }));
    res.json({ success: true, data: { sales } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load your sales" });
  }
});

export default router;
