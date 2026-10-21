import express from "express";
import { Request, Response } from "express";
import { query } from "../db";
import { verifyPrestmitWebhook } from "../services/prestmit";
import { creditWallet, insertTransaction } from "../features/personal/personal-utils";
import { createNotification } from "../services/notifications";

/**
 * Provider webhooks for the Personal app (public paths; verified signatures).
 *
 *  POST /webhook/prestmit — gift card trade outcomes.
 *      Headers: x-prestmit-signature = base64(HMAC_SHA256(PRESTMIT_WEBHOOK_SIGNING_KEY, raw body))
 *      Events: giftcard-trade.sell.approved | giftcard-trade.sell.rejected |
 *              giftcard-trade.buy.approved  | giftcard-trade.buy.rejected
 *
 *      sell.approved  → credit the user's NGN wallet with the payout.
 *      sell.rejected  → mark rejected (nothing to refund — nothing was charged).
 *      buy.approved   → mark completed (codes already fetched/attached).
 *      buy.rejected   → refund the buyer's wallet.
 */

function rawBody(req: Request): Buffer {
  // express.raw + verify would also work; this path is mounted with express.raw
  // in index.ts — body already treated as Buffer.
  return Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
}

function asJson(req: Request): any {
  try {
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
    return req.body ?? {};
  } catch {
    return {};
  }
}

async function handleSellApproved(payload: any) {
  const uniqueId = payload?.data?.uniqueIdentifier || payload?.uniqueIdentifier;
  const reference = payload?.data?.reference || payload?.reference;
  const payout = Number(payload?.data?.totalAmount ?? payload?.data?.payoutTotal ?? 0);
  const r = await query(
    `SELECT * FROM giftcard_sell_trades WHERE (reference = $1 OR provider_reference = $1) LIMIT 1`,
    [uniqueId || reference].filter(Boolean),
  );
  const trade = r.rows[0];
  if (!trade) {
    console.warn("[prestmit webhook] sell approved for unknown trade:", uniqueId || reference);
    return;
  }
  if (trade.status === "settled") return; // idempotent
  if (payout > 0 && trade.wallet_id) {
    await creditWallet(trade.wallet_id, payout);
    await insertTransaction({
      userId: trade.user_id, walletId: trade.wallet_id,
      reference: `GCSP-${trade.reference}`, type: "credit", transactionType: "giftcard_sell",
      amount: payout, currency: trade.currency || "NGN",
      description: `Gift card sale approved — ${trade.giftcard_name || ""}`.trim(),
    });
  }
  await query(
    `UPDATE giftcard_sell_trades SET status = 'settled', credited_at = CURRENT_TIMESTAMP,
       payout_amount = GREATEST(payout_amount, $2), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [trade.id, payout],
  );
  createNotification({
    businessId: "", userId: trade.user_id, type: "credit", title: "Gift card sale approved",
    message: `₦${payout.toLocaleString()} has been credited for your ${trade.giftcard_name || "gift card"} sale.`,
  }).catch(() => {});
}

async function handleSellRejected(payload: any) {
  const uniqueId = payload?.data?.uniqueIdentifier || payload?.uniqueIdentifier;
  const reference = payload?.data?.reference || payload?.reference;
  const reason = payload?.data?.rejectionReason || payload?.data?.reason || "Rejected by review";
  await query(
    `UPDATE giftcard_sell_trades SET status = 'rejected', rejection_reason = $2, updated_at = CURRENT_TIMESTAMP
     WHERE (reference = $1 OR provider_reference = $1) AND status NOT IN ('settled','rejected')`,
    [uniqueId || reference, String(reason).slice(0, 500)],
  );
}

async function handleBuyOutcome(payload: any, approved: boolean) {
  const uniqueId = payload?.data?.uniqueIdentifier || payload?.uniqueIdentifier;
  const reference = payload?.data?.reference || payload?.reference;
  const r = await query(
    `SELECT * FROM giftcard_buy_orders WHERE (reference = $1 OR provider_reference = $1) LIMIT 1`,
    [uniqueId || reference].filter(Boolean),
  );
  const order = r.rows[0];
  if (!order) {
    console.warn("[prestmit webhook] buy outcome for unknown order:", uniqueId || reference);
    return;
  }
  if (approved) {
    await query(
      `UPDATE giftcard_buy_orders SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status != 'completed'`,
      [order.id],
    );
    createNotification({
      businessId: "", userId: order.user_id, type: "system", title: "Gift card delivered",
      message: `Your ${order.giftcard_name || "gift card"} order is ready — open Gift Cards to view the codes.`,
    }).catch(() => {});
  } else {
    // Refund
    if (order.status !== "failed" && order.status !== "refunded") {
      await creditWallet(order.wallet_id, Number(order.total_charged));
      await insertTransaction({
        userId: order.user_id, walletId: order.wallet_id,
        reference: `${order.reference}-REFUND`, type: "credit", transactionType: "giftcard_buy_refund",
        amount: Number(order.total_charged), currency: order.currency || "NGN",
        description: "Refund — gift card order rejected",
      });
      await query(
        `UPDATE giftcard_buy_orders SET status = 'refunded', refunded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [order.id],
      );
      createNotification({
        businessId: "", userId: order.user_id, type: "system", title: "Gift card order refunded",
        message: "The order was rejected and your wallet has been refunded in full.",
      }).catch(() => {});
    }
  }
}

export async function prestmitWebhookHandler(req: Request, res: Response) {
  try {
    const raw = rawBody(req);
    const signature = req.headers["x-prestmit-signature"] as string | undefined;
    if (!verifyPrestmitWebhook(raw, signature)) {
      return res.status(401).json({ success: false, error: "Invalid webhook signature" });
    }
    const payload = asJson(req);
    const event = String(payload?.event || payload?.type || "");
    console.log(`[prestmit webhook] ${event}`);
    switch (event) {
      case "giftcard-trade.sell.approved":
        await handleSellApproved(payload);
        break;
      case "giftcard-trade.sell.rejected":
        await handleSellRejected(payload);
        break;
      case "giftcard-trade.buy.approved":
        await handleBuyOutcome(payload, true);
        break;
      case "giftcard-trade.buy.rejected":
        await handleBuyOutcome(payload, false);
        break;
      default:
        console.log("[prestmit webhook] unhandled event:", event);
    }
    res.json({ success: true });
  } catch (e: any) {
    console.error("[prestmit webhook] error:", e?.message);
    res.status(500).json({ success: false });
  }
}

export async function bitnobWebhookHandler(req: Request, res: Response) {
  try {
    // Bitnob signs webhooks with a shared secret (BITNOB_WEBHOOK_SECRET);
    // signature header: x-bitnob-signature (HMAC-SHA256 hex of the raw body).
    const raw = rawBody(req);
    const secret = process.env.BITNOB_WEBHOOK_SECRET || "";
    const signature = (req.headers["x-bitnob-signature"] as string | undefined) || "";
    if (secret && signature) {
      const crypto = await import("crypto");
      const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
      if (expected !== signature) {
        return res.status(401).json({ success: false, error: "Invalid webhook signature" });
      }
    }
    const payload = asJson(req);
    console.log("[bitnob webhook] event:", payload?.event || payload?.type || "unknown");
    // Virtual-card lifecycle webhooks (card-ready, transaction events) update
    // the local mirror when the provider id matches a card we issued.
    const data = payload?.data || {};
    const cardId = data.cardId || data.card_id;
    if (cardId) {
      const r = await query(`SELECT id, user_id FROM virtual_cards WHERE provider_card_id = $1 LIMIT 1`, [String(cardId)]);
      if (r.rows.length) {
        if (/card-ready/i.test(String(payload?.event || payload?.type || ""))) {
          await query(`UPDATE virtual_cards SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [r.rows[0].id]);
        } else if (data.balanceAmount != null || data.balance_amount != null) {
          const micro = Number(data.balanceAmount ?? data.balance_amount ?? 0);
          await query(`UPDATE virtual_cards SET balance = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [r.rows[0].id, micro / 1_000_000]);
        }
      }
    }
    res.json({ success: true });
  } catch (e: any) {
    console.error("[bitnob webhook] error:", e?.message);
    res.status(500).json({ success: false });
  }
}
