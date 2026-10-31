import express from "express";
import { query } from "../db";
import { logAuditEvent } from "../services/audit";
import { authenticateAdmin, requirePermission } from "../middleware/adminAuth";
import * as prestmit from "../services/prestmit";
import { getPercent } from "../features/personal/flags";

/**
 * ADMIN — Prestmit partner account management (mounted at /api/admin/personal/prestmit).
 *
 * The Prestmit wallet is PLATFORM money: the partner balance, bank accounts
 * and payouts all live on the Prestmit console. This surface exposes them to
 * the admin panel with real API calls (no simulation):
 *
 *   GET  /wallet            balance + service availability + commissions
 *   GET  /banks/ng          Nigerian banks lookup
 *   GET  /banks/gh          Ghanaian banks lookup
 *   GET  /bank-accounts     naira + cedis bank accounts
 *   POST /bank-accounts     add naira (or cedis) account
 *   DELETE /bank-accounts/:wallet/:id
 *   GET  /withdrawals       withdrawal history (+receipt via /withdrawals/:id/receipt)
 *   GET  /withdrawals/:id/receipt
 *   POST /withdrawals       create a withdrawal to a registered bank account
 *   GET  /trades/sell       partner-level sell history (reconciliation)
 *   GET  /trades/buy        partner-level buy history (reconciliation)
 *   GET  /config            giftcard pricing knobs (sell/buy fee percent, spread)
 *   PUT  /config            write pricing knobs
 */

const router = express.Router();

router.use(authenticateAdmin);
router.use(requirePermission("manage_settings"));

function unwrap(e: any): never {
  const err: any = new Error(prestmit.prestmitErr(e));
  err.status = e?.response?.status === 401 ? 502 : 400;
  throw err;
}

/**
 * Read endpoints NEVER 400/500 on provider or configuration problems — the
 * deployed admin UI maps over the array fields (trades/banks/...) and a
 * non-2xx or non-array payload used to crash the whole screen with
 * "(intermediate value).map is not a function". Instead every read answers
 * 200 with STABLE array fields plus explicit status flags:
 *   configured:false            → credentials not set (empty arrays)
 *   degraded:true + error       → provider call failed (empty arrays + hint)
 * so the console can render an actionable banner instead of crashing.
 */
async function safeArray<T>(fn: () => Promise<T[]>): Promise<{ items: T[]; degraded: boolean; error: string | null }> {
  if (!prestmit.isPrestmitConfigured()) return { items: [], degraded: false, error: null };
  try {
    return { items: await fn(), degraded: false, error: null };
  } catch (e: any) {
    return { items: [], degraded: true, error: prestmit.prestmitErr(e) };
  }
}

// ---------------------------------------------------------------------------
// Wallet / account
// ---------------------------------------------------------------------------
router.get("/wallet", async (_req, res) => {
  try {
    const [user, availability, commissions, naira, cedis] = await Promise.all([
      prestmit.userInfo().catch((e) => ({ error: prestmit.prestmitErr(e) })),
      prestmit.serviceAvailability().catch((e) => ({ error: prestmit.prestmitErr(e) })),
      prestmit.commissionsAndFees().catch((e) => ({ error: prestmit.prestmitErr(e) })),
      prestmit.walletDetails("NAIRA").catch((e) => ({ error: prestmit.prestmitErr(e) })),
      prestmit.walletDetails("CEDIS").catch(() => null),
    ]);
    res.json({
      success: true,
      data: {
        configured: prestmit.isPrestmitConfigured(),
        sandbox: prestmit.isPrestmitSandbox(),
        key_kind: prestmit.prestmitKeyKind(),
        provider_host: prestmit.prestmitBaseUrl(),
        user: user?.error ? null : user,
        user_error: user?.error || null,
        availability,
        commissions,
        naira_wallet: naira?.error ? null : naira,
        cedis_wallet: cedis?.error ? null : cedis,
      },
    });
  } catch (e: any) {
    res.status(502).json({ success: false, error: e?.message || "Prestmit wallet unavailable" });
  }
});

// ---------------------------------------------------------------------------
// Banks + bank accounts
// ---------------------------------------------------------------------------
router.get("/banks/ng", async (_req, res) => {
  const { items, degraded, error } = await safeArray(() => prestmit.nigerianBanks());
  res.json({ success: true, configured: prestmit.isPrestmitConfigured(), degraded, error, banks: items });
});

router.get("/banks/gh", async (req, res) => {
  const { items, degraded, error } = await safeArray(() =>
    prestmit.ghanaianBanks(req.query.type ? String(req.query.type) : undefined),
  );
  res.json({ success: true, configured: prestmit.isPrestmitConfigured(), degraded, error, banks: items });
});

router.get("/bank-accounts", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const configured = prestmit.isPrestmitConfigured();
    const [naira, cedis] = configured
      ? await Promise.all([
          prestmit.nairaBankAccounts(page).catch((e) => ({ error: prestmit.prestmitErr(e) })),
          prestmit.cedisBankAccounts(page).catch((e) => ({ error: prestmit.prestmitErr(e) })),
        ])
      : [null, null];
    res.json({ success: true, configured, degraded: !!(naira as any)?.error, error: (naira as any)?.error || null, data: { naira, cedis } });
  } catch (e: any) {
    res.status(200).json({ success: true, configured: prestmit.isPrestmitConfigured(), degraded: true, error: e?.message, data: { naira: null, cedis: null } });
  }
});

router.post("/bank-accounts", async (req, res) => {
  try {
    const wallet = String(req.body?.wallet || "NAIRA").toUpperCase();
    const payload = { ...req.body };
    delete payload.wallet;
    const result = wallet === "CEDIS"
      ? await prestmit.addCedisBankAccount(payload)
      : await prestmit.addNairaBankAccount(payload);
    await logAuditEvent({ action: "prestmit.bank_account.added", newValues: { wallet } }).catch(() => {});
    res.json({ success: true, data: result?.data || result });
  } catch (e) {
    res.status(400).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

router.delete("/bank-accounts/:wallet/:id", async (req, res) => {
  try {
    const wallet = String(req.params.wallet).toUpperCase();
    const result = wallet === "CEDIS"
      ? await prestmit.removeCedisBankAccount(req.params.id)
      : await prestmit.removeNairaBankAccount(req.params.id);
    await logAuditEvent({ action: "prestmit.bank_account.removed", newValues: { wallet, id: req.params.id } }).catch(() => {});
    res.json({ success: true, data: result?.data || result });
  } catch (e) {
    res.status(400).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

// ---------------------------------------------------------------------------
// Withdrawals (payouts to registered bank accounts)
// ---------------------------------------------------------------------------
router.get("/withdrawals", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const wallet = req.query.wallet ? (String(req.query.wallet).toUpperCase() as "NAIRA" | "CEDIS") : undefined;
  const { items, degraded, error } = await safeArray(() => prestmit.withdrawalHistory(page, wallet) as Promise<any[]>);
  res.json({ success: true, configured: prestmit.isPrestmitConfigured(), degraded, error, data: { data: items } });
});

router.get("/withdrawals/:id/receipt", async (req, res) => {
  try {
    res.json({ success: true, data: await prestmit.withdrawalReceipt(req.params.id) });
  } catch (e) {
    res.status(400).json({ success: false, error: prestmit.prestmitErr(e) });
  }
});

router.post("/withdrawals", async (req, res) => {
  try {
    const result = await prestmit.createWithdrawal({ ...(req.body || {}) }).catch((e) => unwrap(e));
    await logAuditEvent({ action: "prestmit.withdrawal.created", newValues: { amount: req.body?.amount, wallet: req.body?.wallet } }).catch(() => {});
    res.json({ success: true, data: result?.data || result });
  } catch (e: any) {
    res.status(e?.status || 400).json({ success: false, error: e?.message || prestmit.prestmitErr(e) });
  }
});

// ---------------------------------------------------------------------------
// Partner-level trade history (reconciliation)
// ---------------------------------------------------------------------------
router.get("/trades/sell", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const { items, degraded, error } = await safeArray(() => prestmit.sellHistory({ page }) as Promise<any[]>);
  res.json({ success: true, configured: prestmit.isPrestmitConfigured(), degraded, error, trades: items });
});

router.get("/trades/buy", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const { items, degraded, error } = await safeArray(() => prestmit.buyHistory({ page }) as Promise<any[]>);
  res.json({ success: true, configured: prestmit.isPrestmitConfigured(), degraded, error, trades: items });
});

// ---------------------------------------------------------------------------
// Giftcard pricing configuration (markup / fees)
// ---------------------------------------------------------------------------
router.get("/config", async (_req, res) => {
  try {
    const sellFee = await getPercent("giftcard_sell_fee_percent", 5);
    const buyFee = await getPercent("giftcard_buy_fee_percent", 5);
    let commissions: any = null;
    try { commissions = await prestmit.commissionsAndFees(); } catch { /* provider optional */ }
    res.json({
      success: true,
      data: {
        giftcard_sell_fee_percent: sellFee,
        giftcard_buy_fee_percent: buyFee,
        provider_commissions: commissions,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.put("/config", async (req, res) => {
  try {
    const { setPercent } = await import("../features/personal/flags");
    const body = req.body || {};
    const written: Record<string, number> = {};
    if (body.giftcard_sell_fee_percent != null) {
      await setPercent("giftcard_sell_fee_percent", Number(body.giftcard_sell_fee_percent), 5, 50);
      written.giftcard_sell_fee_percent = Number(body.giftcard_sell_fee_percent);
    }
    if (body.giftcard_buy_fee_percent != null) {
      await setPercent("giftcard_buy_fee_percent", Number(body.giftcard_buy_fee_percent), 5, 50);
      written.giftcard_buy_fee_percent = Number(body.giftcard_buy_fee_percent);
    }
    await logAuditEvent({ action: "prestmit.config.updated", newValues: written }).catch(() => {});
    res.json({ success: true, data: written });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message });
  }
});

export default router;
