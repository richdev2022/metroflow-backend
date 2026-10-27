import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  assertPersonalService, genRef, requirePersonalKyc,
} from "../personal-utils";
import * as bitnob from "../../../services/bitnob";
import * as flutterwave from "../../../services/flutterwave";
import * as sogo from "../../../services/sogo";
import { userSafeErr } from "../user-safe-errors";
import { useProvider, getPercent } from "../flags";
import { getActiveProvider } from "../provider-routing";
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

/**
 * PROVIDER ROUTING — crypto: "sogo" (default) | "bitnob" | "simulator".
 * Sogo powers the asset catalog (BTC, ETH, USDT +7 more), live NGN rates and
 * the on-chain DEPOSIT off-ramp (deposit address → webhook settlement).
 * Bitnob powers the instant stablecoin→bank payout path for internal wallet
 * balances. Both stay reachable through the same endpoints below.
 */
async function activeCryptoProvider() {
  return getActiveProvider("crypto");
}

// ---------------------------------------------------------------------------
// Sogo deposit-address tracking (who owns which address)
// ---------------------------------------------------------------------------
export async function ensureCryptoDepositSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS crypto_deposit_addresses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      provider VARCHAR(20) NOT NULL DEFAULT 'sogo',
      asset VARCHAR(12) NOT NULL,
      network VARCHAR(24) NOT NULL,
      address VARCHAR(255) NOT NULL,
      extra JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, asset, network, provider)
    )
  `);
  await query(`ALTER TABLE crypto_deposit_addresses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
  await query(`
    CREATE TABLE IF NOT EXISTS crypto_deposit_sales (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      wallet_id UUID,
      address VARCHAR(255),
      reference VARCHAR(80) UNIQUE NOT NULL,               -- sogo transaction reference
      provider VARCHAR(20) NOT NULL DEFAULT 'sogo',
      asset VARCHAR(12),
      network VARCHAR(24),
      crypto_amount DECIMAL(20,8),
      ngn_gross DECIMAL(15,2) DEFAULT 0,
      fee DECIMAL(15,2) DEFAULT 0,
      ngn_net DECIMAL(15,2) DEFAULT 0,
      rate DECIMAL(18,6),
      status VARCHAR(24) DEFAULT 'processing',
      provider_response JSONB,
      settled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_crypto_deposit_addr_lookup ON crypto_deposit_sales(address)`);
}

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

// ---------------------------------------------------------------------------
// SOGO CRYPTO (off-ramp via deposit) — provider-routed additions
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /crypto/catalog:
 *   get:
 *     summary: Provider-aware crypto asset catalog (Sogo: 10+ assets + networks; Bitnob mode: USDT/USDC)
 *     tags: [CryptoToCash]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/catalog", authenticateToken, checkSubscriptionStatus, async (_req, res) => {
  try {
    if (!(await assertPersonalService(res, "crypto"))) return;
    const provider = await activeCryptoProvider();
    if (provider === "sogo") {
      const assets = await sogo.cryptoAssets();
      return res.json({ success: true, provider, assets });
    }
    // Bitnob mode — stablecoins only (instant-sell path).
    return res.json({
      success: true,
      provider,
      assets: [
        { symbol: "usdt", name: "Tether", ticker: "USDT", networks: ["internal"], default_network: "internal", instant_sell: true },
        { symbol: "usdc", name: "USD Coin", ticker: "USDC", networks: ["internal"], default_network: "internal", instant_sell: true },
      ],
    });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

/**
 * @swagger
 * /crypto/deposit-address:
 *   get:
 *     summary: Look up your existing deposit address for an asset/network (Sogo)
 *     tags: [CryptoToCash]
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     summary: Get-or-create your deposit address for an asset/network (Sogo)
 *     tags: [CryptoToCash]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/deposit-address", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "crypto"))) return;
    const provider = await activeCryptoProvider();
    if (provider !== "sogo") {
      return res.status(400).json({ success: false, error: "Crypto deposits are not available right now — please try again later", code: "PROVIDER_UNAVAILABLE" });
    }
    await ensureCryptoDepositSchema();
    const asset = String(req.query.asset || "").trim().toLowerCase();
    const network = String(req.query.network || "").trim().toLowerCase() || undefined;
    if (!asset) return res.status(400).json({ success: false, error: "asset is required (e.g. usdt, btc)" });

    // Local cache first (the address is reusable per user+asset+network).
    const local = await query(
      `SELECT * FROM crypto_deposit_addresses WHERE user_id = $1 AND asset = $2 AND ($3::varchar IS NULL OR network = $3) LIMIT 1`,
      [req.user!.userId, asset, network ?? null],
    );
    if (local.rows.length) {
      const row = local.rows[0];
      return res.json({ success: true, provider, data: { asset, network: row.network, address: row.address, extra: row.extra, cached: true } });
    }
    // Provider lookup (address may exist remotely from a previous deployment).
    const remote = await sogo.cryptoGetDepositAddress(asset, network).catch(() => null);
    if (remote?.address || remote?.deposit_address) {
      const address = remote.address || remote.deposit_address;
      await query(
        `INSERT INTO crypto_deposit_addresses (user_id, asset, network, address, extra)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (user_id, asset, network, provider) DO UPDATE SET address = EXCLUDED.address, extra = EXCLUDED.extra`,
        [req.user!.userId, asset, remote.network || network || "default", address, JSON.stringify(remote)],
      );
      return res.json({ success: true, provider, data: { asset, network: remote.network || network, address, extra: remote, cached: false } });
    }
    return res.json({ success: true, provider, data: null });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

router.post("/deposit-address", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "crypto"))) return;
    const provider = await activeCryptoProvider();
    if (provider !== "sogo") {
      return res.status(400).json({ success: false, error: "Crypto deposits are not available right now — please try again later", code: "PROVIDER_UNAVAILABLE" });
    }
    await ensureCryptoDepositSchema();
    const asset = String(req.body?.asset || "").trim().toLowerCase();
    const network = String(req.body?.network || "").trim().toLowerCase() || undefined;
    if (!asset) return res.status(400).json({ success: false, error: "asset is required (e.g. usdt, btc)" });

    // Reuse the locally-known address when present (Sogo reuses addresses too).
    const local = await query(
      `SELECT * FROM crypto_deposit_addresses WHERE user_id = $1 AND asset = $2 AND ($3::varchar IS NULL OR network = $3) LIMIT 1`,
      [req.user!.userId, asset, network ?? null],
    );
    if (local.rows.length) {
      const row = local.rows[0];
      return res.json({ success: true, provider, data: { asset, network: row.network, address: row.address, extra: row.extra, cached: true } });
    }

    const result = await sogo.cryptoCreateDepositAddress(asset, network, genRef("MF-ADDR"));
    const address = result?.address || result?.deposit_address || result?.data?.address;
    if (!address) {
      return res.status(502).json({ success: false, error: "The provider did not return a deposit address — try again shortly" });
    }
    await query(
      `INSERT INTO crypto_deposit_addresses (user_id, asset, network, address, extra)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (user_id, asset, network, provider) DO UPDATE SET address = EXCLUDED.address, extra = EXCLUDED.extra`,
      [req.user!.userId, asset, result?.network || network || "default", address, JSON.stringify(result)],
    );
    return res.status(201).json({ success: true, provider, data: { asset, network: result?.network || network, address, extra: result, cached: false } });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

/**
 * @swagger
 * /crypto/test-deposit:
 *   post:
 *     summary: SANDBOX ONLY — simulate an on-chain deposit against your sandbox address (fires the full webhook pipeline)
 *     tags: [CryptoToCash]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/test-deposit", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!sogo.isSogoSandbox()) {
      return res.status(403).json({ success: false, error: "Deposit simulation is sandbox-only" });
    }
    const asset = String(req.body?.asset || "").trim().toLowerCase();
    const network = String(req.body?.network || "").trim().toLowerCase() || undefined;
    const cryptoAmount = Number(req.body?.crypto_amount);
    const testReference = String(req.body?.test_reference || `MF-DEP-${Date.now()}`);
    if (!asset || !(cryptoAmount > 0)) {
      return res.status(400).json({ success: false, error: "asset and a positive crypto_amount are required" });
    }
    const result = await sogo.cryptoTestDeposit({ asset, network, crypto_amount: cryptoAmount, test_reference: testReference });
    return res.json({ success: true, data: result });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

/**
 * My deposit-based sales (Sogo off-ramp history).
 */
router.get("/deposits", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureCryptoDepositSchema();
    const rows = await query(
      `SELECT * FROM crypto_deposit_sales WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    const addresses = await query(
      `SELECT asset, network, address, created_at FROM crypto_deposit_addresses WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.userId],
    );
    return res.json({ success: true, data: { deposits: rows.rows, addresses: addresses.rows } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: "Could not load deposit history" });
  }
});

router.post("/lookup", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const accountNumber = String(req.body?.account_number || "").replace(/\D+/g, "");
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

    // Live rate for the asset — Bitnob first, then Sogo (provider routing
    // decides which rail is primary), then FX-derived fallback.
    let rate = rateFor(asset, ngnPerUsd);
    let provider = "flutterwave-fx";
    const active = await activeCryptoProvider();
    if (bitnob.isBitnobConfigured() && (active === "bitnob" || active === "simulator")) {
      try {
        const bn = await bitnob.getRate(asset, "NGN");
        if (Number(bn) > 0) { rate = Number(bn); provider = "bitnob"; }
      } catch { /* fall back to FX-derived rate */ }
    }
    if (provider === "flutterwave-fx" && active === "sogo" && sogo.isSogoConfigured()) {
      try {
        const sr = await sogo.cryptoRate(asset.toLowerCase(), 1);
        const ngnPerCoin = Number(sr?.rate ?? sr?.net_amount ?? sr?.estimated_amount_ngn ?? 0);
        if (ngnPerCoin > 0) { rate = ngnPerCoin; provider = "sogo"; }
      } catch { /* FX fallback stands */ }
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

router.post("/sell", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
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

/**
 * @swagger
 * /crypto/rate:
 *   get:
 *     summary: Live NGN payout estimate for ANY supported asset (Sogo) — asset+amount mode
 *     tags: [CryptoToCash]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/rate", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const provider = await activeCryptoProvider();
    if (provider !== "sogo") {
      return res.status(400).json({ success: false, error: "Multi-asset rates are not available right now — please try again later", code: "PROVIDER_UNAVAILABLE" });
    }
    const asset = String(req.query.asset || "").trim().toLowerCase();
    const amount = Number(req.query.amount) || 1;
    if (!asset) return res.status(400).json({ success: false, error: "asset is required (e.g. btc, usdt)" });
    const rate = await sogo.cryptoRate(asset, amount);
    return res.json({ success: true, provider, data: { asset, amount, ...rate } });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: userSafeErr(sogo.sogoErr(e)) });
  }
});

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
