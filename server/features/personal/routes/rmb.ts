import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  assertPersonalService, genRef, requirePersonalKyc, verifyTransactionPin,
} from "../personal-utils";
import { getPercent } from "../flags";
import { getActiveProvider } from "../provider-routing";
import { creditRevenueWallet } from "../../../services/fees";
import { createNotification } from "../../../services/notifications";
import { upload } from "../../../middleware/upload";
import * as sogo from "../../../services/sogo";

/**
 * RMB PURCHASE — buy Chinese Yuan (CNY) with naira, delivered to Alipay,
 * WeChat Pay or Chinese bank accounts. Mounted at /rmb.
 *
 * Powered by the Sogo RMB API (routed — provider routing decides sogo vs
 * simulator; there is no second live RMB provider today):
 *   GET  /rmb/status                  → provider + rate snapshot
 *   GET  /rmb/rates                   → live ₦/¥ rates per channel + tiers
 *   POST /rmb/calculate               → exact NGN cost for a CNY amount
 *   POST /rmb/buy  (multipart)        → place order (QR code for Alipay/WeChat)
 *   GET  /rmb/orders                  → my orders
 *   GET  /rmb/orders/:reference       → order detail + live status sync
 *
 * Money: NGN wallet debit = rmb_amount × rate + service fee
 * (rmb_fee_percent, admin knob, default 1%). Provider refund webhooks auto-
 * credit the wallet back.
 *
 * Sandbox outcome control (docs): the last 4 chars of recipient_identifier
 * decide — *0000 refunded (+ webhook), *9999 stuck processing, anything else
 * completed (+ webhook). Published success id: recipient1234.
 */

const router = express.Router();

export async function ensureRmbSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS rmb_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID NOT NULL,
      wallet_id UUID,
      reference VARCHAR(80) UNIQUE NOT NULL,
      provider VARCHAR(20) NOT NULL DEFAULT 'sogo',
      provider_reference VARCHAR(120),
      channel VARCHAR(12) NOT NULL,                       -- alipay|wechat|bank
      account_type VARCHAR(12),                           -- nigerian|chinese
      rmb_amount DECIMAL(15,2) NOT NULL,
      ngn_rate DECIMAL(18,4),
      ngn_gross DECIMAL(15,2) NOT NULL,
      fee DECIMAL(15,2) DEFAULT 0,
      ngn_total DECIMAL(15,2) NOT NULL,
      recipient_name VARCHAR(160),
      recipient_identifier VARCHAR(120),
      recipient_bank_name VARCHAR(120),
      description TEXT,
      qr_url TEXT,
      status VARCHAR(24) DEFAULT 'processing',            -- processing|completed|refunded|cancelled|failed
      failure_reason TEXT,
      provider_response JSONB,
      settled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_rmb_orders_user ON rmb_orders(user_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_rmb_orders_status ON rmb_orders(status)`);
}

function publicRow(r: any) {
  return {
    id: r.id,
    reference: r.reference,
    provider: r.provider,
    channel: r.channel,
    account_type: r.account_type,
    rmb_amount: Number(r.rmb_amount),
    ngn_rate: r.ngn_rate != null ? Number(r.ngn_rate) : null,
    ngn_gross: Number(r.ngn_gross),
    fee: Number(r.fee),
    ngn_total: Number(r.ngn_total),
    recipient_name: r.recipient_name,
    recipient_identifier: r.recipient_identifier,
    recipient_bank_name: r.recipient_bank_name,
    description: r.description,
    qr_url: r.qr_url,
    status: r.status,
    failure_reason: r.failure_reason,
    created_at: r.created_at,
    settled_at: r.settled_at,
  };
}

async function rmbFeePercent(): Promise<number> {
  return getPercent("rmb_fee_percent", 1, 50);
}

router.get("/status", authenticateToken, async (_req, res) => {
  const provider = await getActiveProvider("rmb");
  const live = provider === "sogo";
  res.json({
    success: true,
    data: {
      provider,
      provider_label: live ? "Sogo" : "Sandbox mode",
      sogo: sogo.sandboxInfo(),
      fee_percent: await rmbFeePercent(),
    },
  });
});

/** Live ₦/¥ rates per channel + account type + volume tier. */
router.get("/rates", authenticateToken, checkSubscriptionStatus, async (_req, res) => {
  try {
    if (!(await assertPersonalService(res, "rmb" as any))) return;
    const live = (await getActiveProvider("rmb")) === "sogo";
    if (live) {
      const rates = await sogo.rmbRates();
      return res.json({ success: true, provider: "sogo", rates });
    }
    return res.json({
      success: true,
      provider: "simulator",
      rates: {
        channels: [
          { channel: "alipay", name: "Alipay", is_available: true, account_types: [
            { type: "nigerian", name: "Nigerian (Personal)", is_available: true, rates: [{ min_rmb: 0, max_rmb: 1000, ngn_per_rmb: 214 }, { min_rmb: 1000, max_rmb: 10000, ngn_per_rmb: 212 }, { min_rmb: 10000, max_rmb: null, ngn_per_rmb: 210 }] },
            { type: "chinese", name: "Chinese (Supplier)", is_available: true, rates: [{ min_rmb: 0, max_rmb: 1000, ngn_per_rmb: 214 }, { min_rmb: 1000, max_rmb: 10000, ngn_per_rmb: 212 }, { min_rmb: 10000, max_rmb: null, ngn_per_rmb: 210 }] },
          ] },
          { channel: "wechat", name: "WeChat Pay", is_available: true, account_types: [
            { type: "nigerian", name: "Nigerian WeChat Pay", is_available: true, rates: [{ min_rmb: 0, max_rmb: 1000, ngn_per_rmb: 214 }, { min_rmb: 1000, max_rmb: 10000, ngn_per_rmb: 212 }, { min_rmb: 10000, max_rmb: null, ngn_per_rmb: 210 }] },
            { type: "chinese", name: "Chinese supplier account", is_available: true, rates: [{ min_rmb: 0, max_rmb: 1000, ngn_per_rmb: 214 }, { min_rmb: 1000, max_rmb: 10000, ngn_per_rmb: 212 }, { min_rmb: 10000, max_rmb: null, ngn_per_rmb: 210 }] },
          ] },
          { channel: "bank", name: "Chinese Bank Account", is_available: true, account_types: [
            { type: "chinese", name: "Chinese bank account", is_available: true, rates: [{ min_rmb: 0, max_rmb: 1000, ngn_per_rmb: 213 }, { min_rmb: 1000, max_rmb: 10000, ngn_per_rmb: 211 }, { min_rmb: 10000, max_rmb: null, ngn_per_rmb: 209 }] },
          ] },
        ],
        simulator: true,
      },
    });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: sogo.sogoErr(e) });
  }
});

/** Exact NGN cost for a desired CNY amount on a channel/account type. */
router.post("/calculate", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const channel = String(req.body?.channel || "").toLowerCase();
    const accountType = String(req.body?.account_type || "nigerian").toLowerCase();
    const rmbAmount = Number(req.body?.rmb_amount);
    if (!["alipay", "wechat", "bank"].includes(channel) || !(rmbAmount > 0)) {
      return res.status(400).json({ success: false, error: "channel (alipay/wechat/bank) and a positive rmb_amount are required" });
    }
    const provider = (await getActiveProvider("rmb")) === "sogo" ? "sogo" : "simulator";
    let rate = 0;
    if (provider === "sogo") {
      const rates = await sogo.rmbRates();
      const ch = (rates?.channels || []).find((c: any) => c.channel === channel);
      const acct = (ch?.account_types || []).find((a: any) => a.type === accountType) || ch?.account_types?.[0];
      const tier = (acct?.rates || []).find((t: any) =>
        rmbAmount >= Number(t.min_rmb) && (t.max_rmb == null || rmbAmount < Number(t.max_rmb)));
      rate = Number(tier?.ngn_per_rmb || acct?.rates?.[acct.rates.length - 1]?.ngn_per_rmb || 0);
    } else {
      rate = channel === "bank" ? 210 : 211;
    }
    if (!(rate > 0)) return res.status(502).json({ success: false, error: "No live rate available for this channel right now" });
    const feePct = await rmbFeePercent();
    const gross = Math.round(rmbAmount * rate * 100) / 100;
    const fee = Math.round(gross * (feePct / 100) * 100) / 100;
    return res.json({
      success: true,
      provider,
      data: {
        channel, account_type: accountType, rmb_amount: rmbAmount,
        rate, ngn_gross: gross, fee, total: Math.round((gross + fee) * 100) / 100,
        currency: "NGN", expires_at: new Date(Date.now() + 3 * 60_000).toISOString(),
      },
    });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: sogo.sogoErr(e) });
  }
});

/** Place an RMB buy order (multipart — QR image for alipay/wechat). */
router.post("/buy", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, upload.single("qr_code"), async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "rmb" as any))) return;
    await ensureRmbSchema();
    const userId = req.user!.userId;
    const businessId = req.user!.businessId ?? null;
    const b = req.body || {};
    const channel = String(b.channel || "").toLowerCase();
    const accountType = String(b.account_type || "nigerian").toLowerCase();
    const rmbAmount = Math.round(Number(b.rmb_amount) * 100) / 100;
    const recipientName = String(b.recipient_name || "").trim();
    const description = String(b.description || "").trim();
    if (!["alipay", "wechat", "bank"].includes(channel)) {
      return res.status(400).json({ success: false, error: "channel must be alipay, wechat or bank" });
    }
    if (!(rmbAmount > 0)) return res.status(400).json({ success: false, error: "rmb_amount must be positive" });
    if (!recipientName) return res.status(400).json({ success: false, error: "recipient_name is required" });
    if (description.length < 5) return res.status(400).json({ success: false, error: "description is required (min 5 chars) — what is this payment for?" });

    const qrFile = req.file as any;
    if ((channel === "alipay" || channel === "wechat") && !qrFile) {
      return res.status(400).json({ success: false, error: "A photo of the recipient's receive QR code is required for Alipay and WeChat Pay orders" });
    }
    if (channel === "bank") {
      if (!b.recipient_bank_name || !b.recipient_bank_account_number) {
        return res.status(400).json({ success: false, error: "recipient_bank_name and recipient_bank_account_number are required for bank transfers" });
      }
    }
    const pinCheck = await verifyTransactionPin(b.pin, { userId, businessId });
    if (!pinCheck.ok) return res.status(400).json({ success: false, code: pinCheck.code, error: pinCheck.error });

    // ---- Wallet + cost -----------------------------------------------------
    let wallet = await getOwnedWallet(String(b.wallet_id || ""), userId, businessId);
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
    if (String((wallet as any).currency || "NGN").toUpperCase() !== "NGN") {
      return res.status(400).json({ success: false, error: "RMB purchases are charged in NGN — use your Naira wallet." });
    }

    const provider = (await getActiveProvider("rmb")) === "sogo" ? "sogo" : "simulator";
    let rate = 0;
    if (provider === "sogo") {
      const rates = await sogo.rmbRates();
      const ch = (rates?.channels || []).find((c: any) => c.channel === channel);
      const acct = (ch?.account_types || []).find((a: any) => a.type === accountType) || ch?.account_types?.[0];
      const tier = (acct?.rates || []).find((t: any) =>
        rmbAmount >= Number(t.min_rmb) && (t.max_rmb == null || rmbAmount < Number(t.max_rmb)));
      rate = Number(tier?.ngn_per_rmb || 0);
    } else {
      rate = channel === "bank" ? 210 : 211;
    }
    if (!(rate > 0)) return res.status(502).json({ success: false, error: "No live rate available right now — try again shortly." });

    const feePct = await rmbFeePercent();
    const gross = Math.round(rmbAmount * rate * 100) / 100;
    const fee = Math.round(gross * (feePct / 100) * 100) / 100;
    const total = Math.round((gross + fee) * 100) / 100;

    const reference = genRef("MF-RMB");
    if (!(await debitWallet((wallet as any).id, total))) {
      return res.status(400).json({
        success: false, code: "INSUFFICIENT_BALANCE",
        error: `You need ₦${total.toLocaleString()} for this order (¥${rmbAmount.toLocaleString()} at ₦${rate} + ₦${fee.toLocaleString()} fee).`,
      });
    }
    await insertTransaction({
      userId, businessId: (wallet as any).business_id, walletId: (wallet as any).id,
      reference, type: "debit", transactionType: "rmb_buy",
      amount: total, currency: "NGN", fee,
      description: `RMB purchase — ¥${rmbAmount.toLocaleString()} via ${channel} for ${recipientName}`,
    });

    // QR upload (best effort — stored for support/reconciliation).
    let qrUrl: string | null = null;
    if (qrFile) {
      try {
        const { uploadMediaBuffer } = await import("../../../services/media-upload");
        const up = await uploadMediaBuffer({
          buffer: qrFile.buffer, originalname: qrFile.originalname || "qr.jpg",
          mimeType: qrFile.mimetype || "image/jpeg", folder: "rmb", userId,
        });
        qrUrl = up.url;
      } catch (e: any) {
        console.warn("[rmb] qr upload failed:", e?.message);
      }
    }

    const insert = await query(
      `INSERT INTO rmb_orders
         (business_id, user_id, wallet_id, reference, provider, channel, account_type,
          rmb_amount, ngn_rate, ngn_gross, fee, ngn_total, recipient_name,
          recipient_identifier, recipient_bank_name, description, qr_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'processing') RETURNING *`,
      [(wallet as any).business_id || businessId || null, userId, (wallet as any).id, reference, provider,
       channel, accountType, rmbAmount, rate, gross, fee, total, recipientName,
       String(b.recipient_identifier || "").trim() || null,
       String(b.recipient_bank_name || "").trim() || null, description, qrUrl],
    );
    const order = insert.rows[0];

    const refundAndFail = async (message: string, status = "failed") => {
      await creditWallet((wallet as any).id, total);
      await insertTransaction({
        userId, businessId: (wallet as any).business_id, walletId: (wallet as any).id,
        reference: `${reference}-REFUND`, type: "credit", transactionType: "rmb_buy_refund",
        amount: total, currency: "NGN", description: "Refund — RMB order failed",
      });
      await query(
        `UPDATE rmb_orders SET status = $2, failure_reason = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [order.id, status, String(message).slice(0, 500)],
      );
    };

    if (provider === "simulator") {
      await query(
        `UPDATE rmb_orders SET status = 'completed', provider_reference = $2, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [order.id, `SIM-${reference}`],
      );
      createNotification({
        businessId: String((wallet as any).business_id || businessId || ""), userId,
        type: "system", title: "RMB delivered",
        message: `¥${rmbAmount.toLocaleString()} has been delivered to ${recipientName} via ${channel}.`,
        actionUrl: "/rmb", actionType: "view_transaction", metadata: { reference }, isActionable: false, expiresInHours: 168,
      }).catch(() => {});
      const fresh = await query(`SELECT * FROM rmb_orders WHERE id = $1`, [order.id]);
      if (fee > 0) creditRevenueWallet(fee, "NGN", reference, "RMB purchase fee", "rmb").catch(() => {});
      return res.status(201).json({ success: true, provider, data: { order: publicRow(fresh.rows[0]) } });
    }

    try {
      const result = await sogo.rmbBuy({
        channel: channel as "alipay" | "wechat" | "bank",
        alipay_account_type: channel === "alipay" ? (accountType as "nigerian" | "chinese") : undefined,
        wechat_account_type: channel === "wechat" ? (accountType as "nigerian" | "chinese") : undefined,
        rmb_amount: rmbAmount,
        recipient_name: recipientName,
        recipient_identifier: String(b.recipient_identifier || "").trim() || undefined,
        recipient_bank_name: String(b.recipient_bank_name || "").trim() || undefined,
        recipient_bank_account_number: String(b.recipient_bank_account_number || "").trim() || undefined,
        description,
        qr_code: qrFile ? { buffer: qrFile.buffer, filename: qrFile.originalname || "qr.jpg", contentType: qrFile.mimetype } : null,
        reference,
      });
      const tx = result?.transaction || result || {};
      const status = sogo.sogoStatus(tx) || "processing";
      const mapped = ["completed", "processing", "refunded", "cancelled", "failed"].includes(status) ? status : "processing";
      await query(
        `UPDATE rmb_orders SET provider_reference = $2, provider_response = $3::jsonb, status = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [order.id, sogo.sogoReference(result) || reference, JSON.stringify(result), mapped],
      );
      if (mapped === "refunded" || mapped === "cancelled" || mapped === "failed") {
        await creditWallet((wallet as any).id, total);
        await insertTransaction({
          userId, businessId: (wallet as any).business_id, walletId: (wallet as any).id,
          reference: `${reference}-REFUND`, type: "credit", transactionType: "rmb_buy_refund",
          amount: total, currency: "NGN", description: "Refund — RMB order failed",
        });
        await query(`UPDATE rmb_orders SET status = $2, failure_reason = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [order.id, mapped, String(tx.failure_reason || "Order rejected by the RMB partner").slice(0, 500)]);
        return res.status(502).json({ success: false, error: `${tx.failure_reason || "The RMB partner rejected this order"} — your wallet has been refunded.` });
      }
      if (fee > 0) creditRevenueWallet(fee, "NGN", reference, "RMB purchase fee", "rmb").catch(() => {});
      const fresh = await query(`SELECT * FROM rmb_orders WHERE id = $1`, [order.id]);
      return res.status(201).json({
        success: true, provider,
        message: "Order placed — the yuan is on its way. Track progress in your orders.",
        data: { order: publicRow(fresh.rows[0]) },
      });
    } catch (e: any) {
      await refundAndFail(sogo.sogoErr(e));
      return res.status(502).json({ success: false, error: `${sogo.sogoErr(e)} — your wallet has been refunded.` });
    }
  } catch (e: any) {
    console.error("[rmb] buy error:", e?.message);
    return res.status(500).json({ success: false, error: "Could not place the RMB order" });
  }
});

router.get("/orders", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureRmbSchema();
    const rows = await query(
      `SELECT * FROM rmb_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    return res.json({ success: true, orders: rows.rows.map(publicRow) });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: "Could not load RMB orders" });
  }
});

router.get("/orders/:reference", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureRmbSchema();
    const rows = await query(
      `SELECT * FROM rmb_orders WHERE reference = $1 AND user_id = $2`,
      [req.params.reference, req.user!.userId],
    );
    if (!rows.rows.length) return res.status(404).json({ success: false, error: "Order not found" });
    let order = rows.rows[0];

    // Live status sync for unsettled orders (sandbox doesn't persist).
    if (order.status === "processing" && order.provider === "sogo" && !sogo.isSogoSandbox()) {
      const remote = await sogo.getTransaction(order.provider_reference || order.reference).catch(() => null);
      if (remote) {
        const status = sogo.sogoStatus(remote?.transaction || remote);
        const mapped = ["completed", "refunded", "cancelled", "failed"].includes(status) ? status : null;
        if (mapped && mapped !== order.status) {
          if (mapped === "refunded" || mapped === "cancelled" || mapped === "failed") {
            await creditWallet(order.wallet_id, Number(order.ngn_total));
            await insertTransaction({
              userId: order.user_id, businessId: order.business_id, walletId: order.wallet_id,
              reference: `${order.reference}-REFUND`, type: "credit", transactionType: "rmb_buy_refund",
              amount: Number(order.ngn_total), currency: "NGN", description: "Refund — RMB order failed",
            });
          }
          const upd = await query(
            `UPDATE rmb_orders SET status = $2, provider_response = $3::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
            [order.id, mapped, JSON.stringify(remote)],
          );
          order = upd.rows[0];
        }
      }
    }
    return res.json({ success: true, data: { order: publicRow(order) } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: "Could not load the order" });
  }
});

export default router;
