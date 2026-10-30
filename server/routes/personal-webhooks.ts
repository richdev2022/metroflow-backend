import express from "express";
import { Request, Response } from "express";
import { query } from "../db";
import { verifyPrestmitWebhook } from "../services/prestmit";
import { creditWallet, insertTransaction } from "../features/personal/personal-utils";
import { createNotification } from "../services/notifications";
import * as bitnob from "../services/providers/bitnob";

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
  // Prefer the exact request bytes captured by express.json(verify) — webhook
  // signatures are computed over the raw payload, NOT a re-stringified object.
  const raw = (req as any).rawBody;
  if (Buffer.isBuffer(raw) && raw.length > 0) return raw;
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

// ===========================================================================
// Webhook notification log — every personal webhook (accepted AND
// signature-rejected) is recorded into squad_webhooks so the Admin Console
// "Webhooks" screen shows ONE unified feed across squad / monnify /
// flutterwave / prestmit / bitnob / stablecoin / sogo. Logging must never
// break webhook processing, so every failure is swallowed with a warn.
// ===========================================================================

const WEBHOOK_LOG_STATUSES = ["processed", "duplicate", "ignored", "rejected", "failed"] as const;
type WebhookLogStatus = (typeof WEBHOOK_LOG_STATUSES)[number];

async function logWebhookEvent(input: {
  provider: string;
  eventType?: string | null;
  reference?: string | null;
  payload?: any;
  status?: WebhookLogStatus;
  signatureValid?: boolean | null;
  error?: string | null;
}): Promise<void> {
  try {
    const reference = String(input.reference || "").slice(0, 160) || null;
    await query(
      `INSERT INTO squad_webhooks (event_type, payload, status, provider, reference, signature_valid, error)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)`,
      [
        String(input.eventType || "unknown").slice(0, 160),
        JSON.stringify(input.payload ?? {}),
        WEBHOOK_LOG_STATUSES.includes((input.status || "processed") as WebhookLogStatus) ? input.status || "processed" : "processed",
        String(input.provider || "unknown").slice(0, 40),
        reference,
        input.signatureValid === undefined ? null : input.signatureValid,
        input.error ? String(input.error).slice(0, 2000) : null,
      ],
    );
  } catch (e: any) {
    console.warn(`[webhook log] failed to record ${input.provider} event:`, e?.message);
  }
}

/** Best-effort business reference from any provider payload shape. */
function webhookReference(payload: any): string | null {
  const d = payload?.data || {};
  const ref =
    d.reference || d.tx_ref || d.transactionReference || d.reference_number ||
    d.uniqueIdentifier || d.unique_identifier || d.hash || d.tx_hash ||
    d.transactionId || d.transaction_id || d.order_id ||
    payload?.reference || payload?.event_id || payload?.id ||
    d.address || d.deposit_address || null;
  return ref ? String(ref) : null;
}

async function handleSellApproved(payload: any) {
  const uniqueId = payload?.data?.uniqueIdentifier || payload?.uniqueIdentifier;
  const reference = payload?.data?.reference || payload?.reference;
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
  if (!trade.provider_reference && reference) {
    await query(`UPDATE giftcard_sell_trades SET provider_reference = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [trade.id, String(reference)]);
  }
  const { settleSellTradeFromProvider } = await import("../features/personal/routes/giftcards");
  const result = await settleSellTradeFromProvider(trade.id).catch((e) => ({ updated: false, status: "pending", error: e?.message }));
  if (!result.updated && (result as any).error) console.warn("[prestmit webhook] settle failed:", (result as any).error);
}

async function handleSellRejected(payload: any) {
  const uniqueId = payload?.data?.uniqueIdentifier || payload?.uniqueIdentifier;
  const reference = payload?.data?.reference || payload?.reference;
  const reason = payload?.data?.rejectionReason || payload?.data?.reason || "Rejected by review";
  const r = await query(
    `SELECT id, status FROM giftcard_sell_trades WHERE (reference = $1 OR provider_reference = $1) LIMIT 1`,
    [uniqueId || reference].filter(Boolean),
  );
  const trade = r.rows[0];
  if (!trade) {
    console.warn("[prestmit webhook] sell rejected for unknown trade:", uniqueId || reference);
    return;
  }
  if (trade.status !== "settled") {
    await query(
      `UPDATE giftcard_sell_trades SET status = 'rejected', rejection_reason = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [trade.id, String(reason).slice(0, 500)],
    );
  }
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
    // Try to attach the delivered codes immediately (best effort).
    let codes = null;
    if (order.provider_reference) {
      try {
        const { fetchCardCodes } = await import("../services/prestmit");
        const remote = await fetchCardCodes(order.provider_reference);
        codes = remote?.cardCodes || remote?.codes || (Array.isArray(remote) ? remote : remote?.data || null) || null;
      } catch { /* codes arrive later via the codes endpoint */ }
    }
    await query(
      `UPDATE giftcard_buy_orders
       SET status = 'completed',
           card_codes = COALESCE($2::jsonb, card_codes),
           provider_reference = COALESCE(NULLIF($3, ''), provider_reference),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status != 'completed'`,
      [order.id, codes ? JSON.stringify(codes) : null, String(reference || "")],
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

/**
 * withdrawal-request.* — payouts from the PARTNER Prestmit wallet (platform
 * money, not a user wallet). Recorded for reconciliation + admin visibility.
 */
async function handlePrestmitWithdrawal(payload: any, approved: boolean) {
  const d = payload?.data || {};
  const amount = Number(d.amount || 0);
  const wallet = String(d.wallet || "NAIRA");
  console.log(`[prestmit webhook] withdrawal ${approved ? "approved" : "rejected"}: ${amount} ${wallet} — ${d.rejectReason || "ok"}`);
}

/**
 * @swagger
 * /webhook/prestmit:
 *   post:
 *     summary: Prestmit webhook (gift card trades + withdrawals)
 *     description: >
 *       Public callback for Prestmit gift-card outcomes — sell approved /
 *       rejected (user trade settlement), buy outcomes (order codes) and
 *       withdrawal approved / rejected (partner-wallet payouts, reconciliation
 *       only). Signature-verified against the captured raw request body.
 *     tags: [Webhooks]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               event:
 *                 type: string
 *                 description: "Prestmit event name"
 *               data:
 *                 type: object
 *                 description: "Trade/order payload incl. uniqueId or reference"
 *     responses:
 *       200:
 *         description: Event processed (or logged for an unknown reference)
 *       401:
 *         description: Invalid webhook signature
 */
export async function prestmitWebhookHandler(req: Request, res: Response) {
  let payload: any = null;
  let event = "";
  let signatureValid: boolean | null = true;
  try {
    const raw = rawBody(req);
    const signature = req.headers["x-prestmit-signature"] as string | undefined;
    if (!verifyPrestmitWebhook(raw, signature)) {
      signatureValid = false;
      payload = asJson(req);
      console.warn("[prestmit webhook] signature verification failed");
      await logWebhookEvent({ provider: "prestmit", eventType: String(payload?.event || payload?.type || "unknown"), payload, status: "rejected", signatureValid, error: "Invalid webhook signature" });
      return res.status(401).json({ success: false, error: "Invalid webhook signature" });
    }
    payload = asJson(req);
    event = String(payload?.event || payload?.type || "");
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
      case "withdrawal-request.approved":
      case "withdrawal-request.cedis.approved":
        await handlePrestmitWithdrawal(payload, true);
        break;
      case "withdrawal-request.rejected":
      case "withdrawal-request.cedis.rejected":
        await handlePrestmitWithdrawal(payload, false);
        break;
      default:
        console.log("[prestmit webhook] unhandled event:", event);
    }
    await logWebhookEvent({
      provider: "prestmit",
      eventType: event || "unknown",
      reference: webhookReference(payload),
      payload,
      status: "processed",
      signatureValid,
    });
    res.json({ success: true });
  } catch (e: any) {
    console.error("[prestmit webhook] error:", e?.message);
    await logWebhookEvent({ provider: "prestmit", eventType: event || "unknown", payload, status: "failed", signatureValid, error: e?.message });
    res.status(500).json({ success: false });
  }
}

/**
 * @swagger
 * /webhook/bitnob:
 *   post:
 *     summary: Bitnob webhook (deposits, withdrawals, transfers)
 *     description: >
 *       Public callback for Bitnob events. Signed with the
 *       `x-bitnob-signature` header (HMAC-SHA512 hex over the raw body,
 *       shared secret `BITNOB_WEBHOOK_SECRET`) and de-duplicated by event id.
 *       `deposit.success` events are matched by deposit address and credited
 *       to the owning user's wallet.
 *     tags: [Webhooks]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               event:
 *                 type: string
 *                 description: "e.g. deposit.success, transfer.completed"
 *               data:
 *                 type: object
 *                 description: "Bitnob event payload"
 *     responses:
 *       200:
 *         description: Event processed / de-duplicated / acknowledged
 *       401:
 *         description: Invalid webhook signature
 */
export async function bitnobWebhookHandler(req: Request, res: Response) {
  let payload: any = null;
  let event = "";
  let signatureValid: boolean | null = null; // null = unverified (no secret configured)
  try {
    // Bitnob signs webhooks with a shared secret (BITNOB_WEBHOOK_SECRET).
    // Stablecoin webhooks: x-bitnob-signature = HMAC-SHA512 hex over the raw
    // body; the legacy card API used HMAC-SHA256 — accept either (never both
    // passing with the WRONG secret, the secret itself is the trust root).
    const raw = rawBody(req);
    const secret = process.env.BITNOB_WEBHOOK_SECRET || "";
    const signature = ((req.headers["x-bitnob-signature"] as string) || "").trim();
    if (secret && signature) {
      const crypto = await import("crypto");
      const sha512 = crypto.createHmac("sha512", secret).update(raw).digest("hex");
      const sha256 = crypto.createHmac("sha256", secret).update(raw).digest("hex");
      const sha512b64 = crypto.createHmac("sha512", secret).update(raw).digest("base64");
      const sha256b64 = crypto.createHmac("sha256", secret).update(raw).digest("base64");
      const sig = signature.replace(/^sha(512|256)=/i, "");
      const ok = [sha512, sha256, sha512b64, sha256b64].some((h) => {
        if (sig.length !== h.length) return false; // length-guard BEFORE timingSafeEqual
        try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(sig)); } catch { return false; }
      });
      if (!ok) {
        signatureValid = false;
        payload = asJson(req);
        console.warn("[bitnob webhook] signature mismatch");
        await logWebhookEvent({ provider: "bitnob", eventType: String(payload?.event || payload?.type || "unknown"), payload, status: "rejected", signatureValid, error: "Invalid webhook signature" });
        return res.status(401).json({ success: false, error: "Invalid webhook signature" });
      }
      signatureValid = true;
    } else if (!secret) {
      console.warn("[bitnob webhook] BITNOB_WEBHOOK_SECRET not set — signature NOT verified");
    }

    payload = asJson(req);
    event = String(payload?.event || payload?.type || "");
    console.log(`[bitnob webhook] event: ${event || "unknown"}`);
    let outcome: WebhookLogStatus = "processed";

    // ---- Stablecoin lifecycle (deposits + withdrawals + trades) ----
    if (/^deposit\.success$/i.test(event)) {
      const r = await processStablecoinDeposit(payload);
      if (r.action === "duplicate") outcome = "duplicate";
      await logWebhookEvent({ provider: "bitnob", eventType: event || "unknown", reference: webhookReference(payload), payload, status: outcome, signatureValid });
      return res.json({ success: true });
    }
    if (/^transfer\.(success|failed|expired)$/i.test(event)) {
      await finalizeStablecoinWithdrawal(event, payload);
      await logWebhookEvent({ provider: "bitnob", eventType: event || "unknown", reference: webhookReference(payload), payload, status: outcome, signatureValid });
      return res.json({ success: true });
    }
    if (/trade[s]?\.|^order/i.test(event) && (payload?.data?.reference || payload?.data?.order?.reference || payload?.data?.order_id)) {
      // Trading order lifecycle — settle the matching platform conversion.
      const ref = payload?.data?.reference || payload?.data?.order?.reference || payload?.data?.order_id;
      const { settleConversion } = await import("../features/personal/stablecoin");
      await settleConversion(String(ref));
      await logWebhookEvent({ provider: "bitnob", eventType: event || "unknown", reference: webhookReference(payload), payload, status: outcome, signatureValid });
      return res.json({ success: true });
    }

    // ---- Virtual-card lifecycle (card-ready, transaction events) ----
    const data = payload?.data || {};
    const cardId = data.cardId || data.card_id;
    if (cardId) {
      const r = await query(`SELECT id, user_id FROM virtual_cards WHERE provider_card_id = $1 LIMIT 1`, [String(cardId)]);
      if (r.rows.length) {
        const card = r.rows[0];
        if (/card-ready/i.test(event)) {
          await query(`UPDATE virtual_cards SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id]);
        } else if (data.balanceAmount != null || data.balance_amount != null) {
          const micro = Number(data.balanceAmount ?? data.balance_amount ?? 0);
          await query(`UPDATE virtual_cards SET balance = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, micro / 1_000_000]);
        }
        // Card spend/refund events → mirror into the wallet history so the
        // user sees every card transaction under the funding wallet's
        // (stablecoin/NGN) transaction history, not only inside the card.
        const spendAmountMicro = Number(data.amount ?? data.cardChargeAmount ?? data.transactionAmount ?? 0);
        const providerTxId = String(data.transactionId || data.id || data.reference || "");
        if (!/card-ready/i.test(event) && spendAmountMicro > 0 && providerTxId) {
          const ok = await claimEvent("bitnob", `cardtx:${providerTxId}`, event || "card.transaction", payload);
          if (ok) {
            const spendUsd = spendAmountMicro > 10_000 ? spendAmountMicro / 1_000_000 : spendAmountMicro; // micro-units guard
            const isCredit = /credit|refund|reversal/i.test(event) || String(data.type || "").toLowerCase() === "credit";
            const walletRes = await query(`SELECT id, currency FROM wallets WHERE id = (SELECT wallet_id FROM virtual_cards WHERE id = $1) LIMIT 1`, [card.id]);
            const fw = walletRes.rows[0];
            if (fw) {
              const cur = String(fw.currency || "NGN").toUpperCase();
              let walletAmount = Math.round(spendUsd * 100) / 100;
              if (cur !== "USD" && cur !== "USDT" && cur !== "USDC") {
                try {
                  const conv = await bitnob.convertAmount("USD", cur, spendUsd);
                  walletAmount = Math.round((Number(conv?.data?.to_amount || conv?.data?.rate_used) || 0) * 100) / 100;
                } catch { walletAmount = 0; }
              }
              if (walletAmount > 0) {
                const ref = `VCT-${providerTxId}`.slice(0, 80);
                await query(
                  `INSERT INTO transactions
                     (user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction)
                   VALUES ($1, $2, $3, $4, 'success', $5, $6, $7, $8, $5)
                   ON CONFLICT (reference) DO NOTHING`,
                  [card.user_id, walletAmount, cur, ref, isCredit ? "credit" : "debit",
                   `Virtual card ${isCredit ? "refund" : "transaction"} — ${String(data.merchantName || data.description || "card spend")}`.slice(0, 240),
                   isCredit ? "vcard_refund" : "vcard_spend", fw.id],
                );
                await query(
                  `INSERT INTO virtual_card_transactions (card_id, user_id, type, amount, currency, status, provider_reference, description, reference)
                   VALUES ($1,$2,$3,$4,'USD','completed',$5,$6,$7)
                   ON CONFLICT (reference) DO NOTHING`,
                  [card.id, card.user_id, isCredit ? "refund" : "spend", spendUsd, providerTxId,
                   String(data.merchantName || data.description || "Card transaction"), ref],
                ).catch(() => {});
              }
            }
          }
        }
      }
    }
    await logWebhookEvent({ provider: "bitnob", eventType: event || "unknown", reference: webhookReference(payload), payload, status: outcome, signatureValid });
    res.json({ success: true });
  } catch (e: any) {
    console.error("[bitnob webhook] error:", e?.message);
    await logWebhookEvent({ provider: "bitnob", eventType: event || "unknown", payload, status: "failed", signatureValid, error: e?.message });
    res.status(500).json({ success: false });
  }
}

// ===========================================================================
// Stablecoin deposits + withdrawals (deposit.success / transfer.*)
// ===========================================================================

/** Amount-unit policy: Bitnob balances are 6-decimal base units; deposits are
 *  documented in token units. BITNOB_DEPOSIT_AMOUNT_MODE resolves ambiguity:
 *  base (trust payload) | micro (divide by 1e6) | auto (heuristic, default). */
function depositAmount(raw: any): number {
  const mode = (process.env.BITNOB_DEPOSIT_AMOUNT_MODE || "auto").toLowerCase();
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (mode === "micro") return n / 1e6;
  if (mode === "base") return n;
  // auto: an integer ≥ 1e6 with no formatted companion is almost certainly
  // 6-decimal base units (1 USDT = 1_000_000). Token-unit amounts are small or fractional.
  if (Number.isInteger(n) && n >= 1_000_000) return n / 1e6;
  return n;
}

/** Replay-proof event de-duplication. Returns false when already processed. */
async function claimEvent(provider: string, eventId: string, eventType: string, payload: any): Promise<boolean> {
  try {
    const r = await query(
      `INSERT INTO provider_webhook_events (provider, event_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      [provider, eventId.slice(0, 160), eventType.slice(0, 80), JSON.stringify(payload ?? {})],
    );
    return r.rows.length > 0;
  } catch {
    // Ledger unavailable — fall back to per-event advisory only.
    return true;
  }
}

async function getUserStableWalletRaw(userId: string, currency: string): Promise<any> {
  const r = await query(
    `SELECT * FROM wallets WHERE user_id = $1 AND UPPER(currency) = $2 AND status = 'active' LIMIT 1`,
    [userId, currency],
  );
  if (r.rows.length) return r.rows[0];
  const created = await query(
    `INSERT INTO wallets (user_id, balance, currency, status) VALUES ($1, 0, $2, 'active')
     ON CONFLICT (user_id, currency) DO UPDATE SET status = 'active' RETURNING *`,
    [userId, currency],
  );
  return created.rows[0];
}

/**
 * deposit.success — credit the depositing user's stablecoin wallet.
 * Fraud ladder: event dedup → address binding → currency/chain match →
 * minimum amount → server-side transaction cross-check → idempotent credit.
 */
async function processStablecoinDeposit(payload: any): Promise<{ ok: boolean; action: string }> {
  const d = payload?.data || payload || {};
  const eventId = String(payload?.event_id || payload?.id || d?.event_id || d?.id || d?.hash || `dep-${Date.now()}`);
  const address = String(d?.address || d?.to_address || d?.wallet_address || "").trim();
  const chain = String(d?.chain || d?.network || "").toLowerCase().trim();
  const currency = String(d?.currency || d?.asset || d?.token || "").toUpperCase().trim();
  const hash = String(d?.hash || d?.tx_hash || d?.transaction_hash || "").trim();
  const amount = depositAmount(d?.amount ?? d?.amount_formatted ?? d?.value);

  if (!address || !amount || !currency) {
    console.warn("[bitnob webhook] deposit.success with incomplete data:", JSON.stringify(payload).slice(0, 300));
    return { ok: false, action: "incomplete_payload" };
  }

  // 1) Replay-proof de-duplication.
  if (!(await claimEvent("bitnob", `deposit:${eventId}`, "deposit.success", payload))) {
    console.log(`[bitnob webhook] duplicate deposit event ignored: ${eventId}`);
    return { ok: true, action: "duplicate" };
  }

  // 2) Address binding — only addresses WE issued may credit a user.
  const addrRows = await query(
    `SELECT * FROM stablecoin_addresses WHERE address = $1 LIMIT 2`,
    [address],
  );
  const addr = addrRows.rows.find((a: any) => !chain || String(a.chain).toLowerCase() === chain) || addrRows.rows[0];
  if (!addr) {
    console.warn(`[bitnob webhook] deposit to UNKNOWN address ${address} (${currency} ${amount}) — needs ops review`);
    await query(
      `INSERT INTO stablecoin_deposits (currency, chain, address, amount, tx_hash, event_id, status, rejection_reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'rejected', $7)`,
      [currency, chain, address, amount, hash || null, `deposit:${eventId}`.slice(0, 160), "Unknown deposit address — funds not attributable to a user"],
    ).catch(() => {});
    return { ok: false, action: "unknown_address" };
  }

  // Record the deposit attempt (UNIQUE event_id makes this idempotent too).
  const ins = await query(
    `INSERT INTO stablecoin_deposits (user_id, address_id, currency, chain, address, amount, tx_hash, event_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     ON CONFLICT (event_id) DO NOTHING RETURNING *`,
    [addr.user_id, addr.id, currency, chain, address, amount, hash || null, `deposit:${eventId}`.slice(0, 160)],
  );
  if (!ins.rows.length) return { ok: true, action: "duplicate" };
  const deposit = ins.rows[0];

  const reject = async (reason: string): Promise<{ ok: boolean; action: string }> => {
    await query(
      `UPDATE stablecoin_deposits SET status = 'rejected', rejection_reason = $2, credited_at = NULL WHERE id = $1`,
      [deposit.id, reason],
    );
    createNotification({
      userId: addr.user_id, type: "system", title: "Deposit could not be credited",
      message: `A ${currency} deposit of ${amount} to your ${chain} address needs manual review (${reason}). Support has been notified.`,
    }).catch(() => {});
    console.warn(`[bitnob webhook] deposit ${eventId} rejected: ${reason}`);
    return { ok: false, action: `rejected:${reason.slice(0, 60)}` };
  };

  // 3) Currency must match the address coin (mixed-up network protection).
  if (String(addr.currency).toUpperCase() !== currency) {
    return reject(`Currency mismatch — address is for ${addr.currency}, deposit was ${currency}`);
  }

  // 4) Minimum deposit (Bitnob rejects < $1; we keep the same floor).
  if (amount < 1) {
    return reject(`Below minimum deposit ($1)`);
  }

  // 5) Server-side transaction cross-check (defence-in-depth against spoofed
  //    payloads; signature verification remains the primary gate).
  const verification: any = { checked: false };
  if (bitnob.isBitnobConfigured() && hash) {
    try {
      const t = await bitnob.getTransaction(hash);
      const tx = t?.data || {};
      const txAmount = depositAmount(tx.amount ?? tx.amount_formatted ?? tx.value);
      const txCurrency = String(tx.currency || tx.asset || currency).toUpperCase();
      const txAddress = String(tx.address || tx.to_address || address);
      const txStatus = String(tx.status || tx.state || "success").toLowerCase();
      verification.checked = true;
      verification.tx_status = txStatus;
      verification.amount_match = Math.abs(txAmount - amount) < 1e-6 || txAmount === 0; // 0 = amount field absent in tx record
      verification.currency_match = txCurrency === currency;
      verification.address_match = txAddress.toLowerCase() === address.toLowerCase();
      if (verification.amount_match === false || verification.currency_match === false || verification.address_match === false) {
        await query(
          `UPDATE stablecoin_deposits SET verification = $2::jsonb WHERE id = $1`,
          [deposit.id, JSON.stringify(verification)],
        );
        return reject("Provider transaction check failed (amount/currency/address mismatch)");
      }
      if (["failed", "reversed"].includes(txStatus)) {
        await query(
          `UPDATE stablecoin_deposits SET verification = $2::jsonb WHERE id = $1`,
          [deposit.id, JSON.stringify(verification)],
        );
        return reject(`Provider reports transaction ${txStatus}`);
      }
    } catch (e: any) {
      // Transaction not indexed YET (confirmations pending) — credit anyway;
      // Bitnob only fires deposit.success after its own confirmation threshold.
      verification.checked = false;
      verification.note = `lookup unavailable: ${String(e?.message || "").slice(0, 120)}`;
    }
  }

  // 6) Idempotent credit (ledger reference is unique → double delivery can't
  //    double-credit even if dedup was bypassed).
  const wallet = await getUserStableWalletRaw(addr.user_id, currency);
  const ledgerRef = `DEP-${eventId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 70);
  await creditWallet(wallet.id, amount);
  await insertTransaction({
    userId: addr.user_id, walletId: wallet.id, reference: ledgerRef, type: "credit",
    transactionType: "stablecoin_deposit", amount, currency,
    description: `Stablecoin deposit — ${currency} ${amount} via ${chain}${hash ? ` (${hash.slice(0, 10)}…)` : ""}`,
  });
  await query(
    `UPDATE stablecoin_deposits SET status = 'credited', credited_at = CURRENT_TIMESTAMP, verification = $2::jsonb WHERE id = $1`,
    [deposit.id, JSON.stringify(verification)],
  );
  createNotification({
    userId: addr.user_id, type: "credit", title: "Stablecoin deposit received",
    message: `${currency} ${amount} has been credited to your wallet${hash ? ` (tx ${hash.slice(0, 10)}…)` : ""}.`,
  }).catch(() => {});
  console.log(`[bitnob webhook] credited ${currency} ${amount} to user ${addr.user_id} (${chain})`);
  return { ok: true, action: "credited" };
}

/** transfer.success / transfer.failed — finalize stablecoin withdrawals. */
async function finalizeStablecoinWithdrawal(event: string, payload: any): Promise<void> {
  const d = payload?.data || {};
  const reference = String(d?.reference || d?.provider_reference || "").trim();
  if (!reference) return;
  const r = await query(
    `SELECT * FROM stablecoin_withdrawals WHERE reference = $1 OR provider_reference = $1 LIMIT 1`,
    [reference],
  );
  const wd = r.rows[0];
  if (!wd) {
    console.warn(`[bitnob webhook] ${event} for unknown withdrawal ${reference}`);
    return;
  }
  if (wd.status === "completed" || wd.status === "failed") return; // idempotent

  if (/success/i.test(event)) {
    await query(
      `UPDATE stablecoin_withdrawals SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [wd.id],
    );
    createNotification({
      userId: wd.user_id, type: "transaction", title: "Withdrawal completed",
      message: `${wd.currency} ${Number(wd.amount)} was delivered to your ${wd.chain} address.`,
    }).catch(() => {});
  } else {
    // Refund the wallet (the debit happened at initiation).
    const wallet = await getUserStableWalletRaw(wd.user_id, wd.currency);
    await creditWallet(wallet.id, Number(wd.amount));
    await insertTransaction({
      userId: wd.user_id, walletId: wallet.id, reference: `${wd.reference}-RF`, type: "credit",
      transactionType: "stablecoin_withdrawal_refund", amount: Number(wd.amount), currency: wd.currency,
      description: "Stablecoin withdrawal failed — refunded in full",
    });
    await query(
      `UPDATE stablecoin_withdrawals SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [wd.id, `Provider event: ${event}`],
    );
    createNotification({
      userId: wd.user_id, type: "system", title: "Withdrawal failed — refunded",
      message: `Your ${wd.currency} ${Number(wd.amount)} withdrawal could not be delivered and has been refunded in full.`,
    }).catch(() => {});
  }
}

/**
 * Dedicated stablecoin webhook endpoint (POST /webhook/bitnob/stablecoin).
 * Same verification ladder as the general handler, but ONLY stablecoin events
 * are processed — anything else is acknowledged and ignored.
 */
/**
 * @swagger
 * /webhook/bitnob/stablecoin:
 *   post:
 *     summary: Bitnob stablecoin webhook (USDT/USDC deposits + withdrawals)
 *     description: >
 *       Dedicated stablecoin callback — stricter verification than the legacy
 *       Bitnob webhook: HMAC-SHA512/256 signature, per-event de-duplication
 *       and strict deposit-address binding before any wallet credit.
 *     tags: [Webhooks]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               event:
 *                 type: string
 *                 description: "deposit.success / transfer.*"
 *               data:
 *                 type: object
 *                 description: "Deposit/withdrawal payload (address, amount, chain)"
 *     responses:
 *       200:
 *         description: Event processed or de-duplicated
 *       401:
 *         description: Invalid webhook signature
 */
export async function stablecoinWebhookHandler(req: Request, res: Response) {
  let payload: any = null;
  let event = "";
  let signatureValid: boolean | null = null; // null = unverified (no secret configured)
  try {
    const raw = rawBody(req);
    const secret = process.env.BITNOB_WEBHOOK_SECRET || "";
    const signature = ((req.headers["x-bitnob-signature"] as string) || "").trim();
    if (secret && signature) {
      const crypto = await import("crypto");
      const sha512 = crypto.createHmac("sha512", secret).update(raw).digest("hex");
      const sha256 = crypto.createHmac("sha256", secret).update(raw).digest("hex");
      const sha512b64 = crypto.createHmac("sha512", secret).update(raw).digest("base64");
      const sha256b64 = crypto.createHmac("sha256", secret).update(raw).digest("base64");
      const sig = signature.replace(/^sha(512|256)=/i, "");
      const ok = [sha512, sha256, sha512b64, sha256b64].some((h) => {
        if (sig.length !== h.length) return false; // length-guard BEFORE timingSafeEqual
        try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(sig)); } catch { return false; }
      });
      if (!ok) {
        signatureValid = false;
        payload = asJson(req);
        console.warn("[bitnob stablecoin webhook] signature mismatch");
        await logWebhookEvent({ provider: "stablecoin", eventType: String(payload?.event || payload?.type || "unknown"), payload, status: "rejected", signatureValid, error: "Invalid webhook signature" });
        return res.status(401).json({ success: false, error: "Invalid webhook signature" });
      }
      signatureValid = true;
    } else if (!secret) {
      console.warn("[bitnob stablecoin webhook] BITNOB_WEBHOOK_SECRET not set — signature NOT verified");
    }
    payload = asJson(req);
    event = String(payload?.event || payload?.type || "");
    console.log(`[bitnob stablecoin webhook] event: ${event || "unknown"}`);
    let outcome: WebhookLogStatus = "processed";
    if (/^deposit\.success$/i.test(event)) {
      const r = await processStablecoinDeposit(payload);
      if (r.action === "duplicate") outcome = "duplicate";
    } else if (/^transfer\.(success|failed|expired)$/i.test(event)) {
      await finalizeStablecoinWithdrawal(event, payload);
    } else {
      console.log(`[bitnob stablecoin webhook] ignored event: ${event}`);
      outcome = "ignored";
    }
    await logWebhookEvent({ provider: "stablecoin", eventType: event || "unknown", reference: webhookReference(payload), payload, status: outcome, signatureValid });
    res.json({ success: true });
  } catch (e: any) {
    console.error("[bitnob stablecoin webhook] error:", e?.message);
    await logWebhookEvent({ provider: "stablecoin", eventType: event || "unknown", payload, status: "failed", signatureValid, error: e?.message });
    res.status(500).json({ success: false });
  }
}

// ===========================================================================
// SOGO WEBHOOKS — transaction.completed | failed | cancelled | refunded | ping
//   Headers: X-Sogo-Signature-256 = "sha256=" + HMAC_SHA256(rawBody, secret)
//   Every Sogo write we make carries OUR reference as the Idempotency-Key, so
//   webhook data.object.reference reconciles 1:1 with our tables.
//
//   type=buy_giftcard   → codes via GET /transactions/{ref}; mark completed
//   type=sell_giftcard  → credit wallet payout − our sell fee (settled)
//   type=bill_payment   → status + provider-side refund handling
//   type=rmb / buy_rmb  → status + wallet refund on cancelled/refunded
//   crypto deposits     → matched by deposit address (no pre-existing ref) —
//                         NGN settles to our Sogo wallet; we credit the user.
// ===========================================================================

import { verifySogoWebhook } from "../services/sogo";
import * as sogo from "../services/sogo";
import { getPercent } from "../features/personal/flags";

async function creditUserWallet(userId: string | null, walletId: string | null, amount: number, reference: string, description: string, businessId?: string | null) {
  if (!walletId || !(amount > 0)) return;
  await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [amount, walletId]);
  await insertTransaction({
    userId, businessId: businessId ?? null, walletId,
    reference, type: "credit", transactionType: "sogo_credit",
    amount, currency: "NGN", description,
  });
}

async function handleSogoCryptoDeposit(tx: any) {
  // Match by deposit address (metadata.deposit_address || deposit_address),
  // falling back to a pre-recorded sale row keyed by reference.
  const address = String(
    tx?.metadata?.deposit_address || tx?.deposit_address || tx?.address || "",
  );
  let sale = null;
  if (tx?.reference) {
    const byRef = await query(`SELECT * FROM crypto_deposit_sales WHERE reference = $1 LIMIT 1`, [String(tx.reference)]);
    sale = byRef.rows[0] || null;
  }
  if (!sale && address) {
    const byAddr = await query(
      `SELECT * FROM crypto_deposit_sales WHERE address = $1 AND status = 'processing' ORDER BY created_at ASC LIMIT 1`,
      [address],
    );
    sale = byAddr.rows[0] || null;
  }
  if (!sale && address) {
    // First deposit on a known address — resolve the owner and open a row.
    const addr = await query(`SELECT * FROM crypto_deposit_addresses WHERE address = $1 LIMIT 1`, [address]);
    if (!addr.rows.length) {
      console.warn("[sogo webhook] deposit for unknown address:", address);
      return;
    }
    const owner = addr.rows[0];
    const wallet = await query(
      `SELECT id, business_id FROM wallets WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
      [owner.user_id],
    );
    const insert = await query(
      `INSERT INTO crypto_deposit_sales
         (user_id, wallet_id, address, reference, provider, asset, network, crypto_amount, status, provider_response)
       VALUES ($1,$2,$3,$4,'sogo',$5,$6,$7,'processing',$8::jsonb) RETURNING *`,
      [owner.user_id, wallet.rows[0]?.id || null, address, String(tx.reference || `SO-${Date.now()}`),
       owner.asset, owner.network, sogo.sogoAmount(tx.crypto_amount) || sogo.sogoAmount(tx.amount) || null, JSON.stringify(tx)],
    );
    sale = insert.rows[0];
  }
  if (!sale) {
    console.warn("[sogo webhook] crypto deposit without match:", tx?.reference);
    return;
  }
  if (sale.status === "completed") return; // idempotent

  const gross = sogo.sogoAmount(tx?.payout_amount) || sogo.sogoAmount(tx?.net_amount) ||
    sogo.sogoAmount(tx?.amount) || Number(sale.ngn_gross || 0);
  const spreadPct = await getPercent("crypto_spread_percent", 1);
  const fee = Math.round(gross * (spreadPct / 100) * 100) / 100;
  const net = Math.max(0, Math.round((gross - fee) * 100) / 100);

  await creditUserWallet(sale.user_id, sale.wallet_id, net, `SOGO-DEP-${sale.reference}`, `Crypto deposit credit — ${sale.asset || ""} ${sale.crypto_amount || ""}`.trim());
  await query(
    `UPDATE crypto_deposit_sales SET status = 'completed', ngn_gross = $2, fee = $3, ngn_net = $4,
       rate = COALESCE($5, rate), provider_response = $6::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [sale.id, gross, fee, net, tx?.rate ?? null, JSON.stringify(tx)],
  );
  try {
    await createNotification({
      businessId: "", userId: String(sale.user_id), type: "credit",
      title: "Crypto deposit settled",
      message: `₦${net.toLocaleString()} has been credited to your wallet from your ${sale.asset || "crypto"} deposit.`,
      actionUrl: "/crypto", actionType: "view_transaction",
      metadata: { reference: sale.reference }, isActionable: false, expiresInHours: 720,
    });
  } catch { /* best effort */ }
}

async function handleSogoBillPayment(tx: any) {
  const { settleBillCompleted, refundBillRow } = await import("../features/personal/bill-settlement");
  const sogoRef = String(tx?.reference || "");
  if (!sogoRef) return;

  // ---- 1. Direct match -------------------------------------------------
  // Sogo echoes OUR reference when the purchase flow recorded it, and
  // provider_reference holds Sogo's own BILL… reference once captured.
  const rows = await query(
    `SELECT * FROM bill_transactions WHERE reference = $1 OR provider_reference = $1 LIMIT 1`,
    [sogoRef],
  );
  let bill = rows.rows[0] || null;

  // ---- 2. Backfill reconciliation ---------------------------------------
  // LIVE Sogo assigns its OWN reference (BILL…) and never echoes our
  // Idempotency-Key in webhooks. When the purchase response never landed
  // (timeout / process death mid-call) provider_reference is NULL and the
  // direct match misses — the exact production incident of 2026-10-30.
  // Reconcile by the event's bill signature: amount + customer ref + category
  // + creation window around the provider transaction, then CLAIM the match
  // by storing the provider reference so retries/replays hit path 1.
  if (!bill) {
    bill = await backfillSogoBill(sogoRef, tx);
  }
  if (!bill) {
    console.warn("[sogo webhook] bill payment for unknown reference:", sogoRef);
    return;
  }

  // ---- 3. Normalize Sogo's status vocabulary ----------------------------
  // Live events say "successful" / "delivered" / "failure" / "canceled" (and
  // status itself is a {value, is_final} object) — the old strict
  // ["completed","failed",…] equality mapped ALL of those to "processing".
  let mapped = sogo.normalizeSogoStatus(sogo.sogoStatus(tx));

  // ---- 4. Reconfirm with the provider before moving money ---------------
  // The webhook is signed evidence; the lookup is belt-and-braces. When the
  // API is unreachable / has no record we still trust the signed webhook.
  // On a CONTRADICTION (webhook says completed, provider says failed — or
  // vice versa) we refuse to settle and leave the row for the reaper +
  // support instead of acting on conflicting evidence.
  if (["completed", "failed", "refunded", "cancelled"].includes(mapped) && bill.provider === "sogo" && !sogo.isSogoSandbox()) {
    const remoteStatus = await reconfirmSogoBillStatus(sogoRef);
    if (remoteStatus && remoteStatus !== mapped && ["completed", "failed", "refunded", "cancelled"].includes(remoteStatus)) {
      console.error(`[sogo webhook] reconfirm mismatch for ${sogoRef}: webhook=${mapped} provider=${remoteStatus} — leaving for reconciliation`);
      await query(
        `UPDATE bill_transactions SET provider_response = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [bill.id, JSON.stringify({ webhook: tx, reconfirm: remoteStatus, conflict: true })],
      );
      return;
    }
  }

  if (mapped === bill.status && mapped !== "processing") return; // idempotent
  // Settlement runs through the shared engine (claim-first guarded UPDATEs,
  // ledger-idempotent refunds, cashback on late completion, notifications).
  if (mapped === "completed") {
    await settleBillCompleted(bill, tx);
  } else if (["refunded", "failed", "cancelled"].includes(mapped)) {
    await refundBillRow(bill, `Provider reported: ${mapped}`, tx);
  } else {
    // Still processing provider-side — keep local state untouched but record
    // the latest webhook payload for support forensics.
    await query(
      `UPDATE bill_transactions SET provider_response = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'processing'`,
      [bill.id, JSON.stringify(tx)],
    );
  }
}

/**
 * Reconfirm a bill webhook against GET /transactions/{reference} (short
 * timeout — webhooks must answer fast). Returns the normalized provider
 * status, or null when the API is unreachable / has no record (in which case
 * the signed webhook remains the evidence of record).
 */
async function reconfirmSogoBillStatus(sogoRef: string): Promise<string | null> {
  try {
    const remote = await sogo.getTransaction(sogoRef, 10_000);
    const rtx = remote?.transaction ?? remote;
    const st = sogo.normalizeSogoStatus(sogo.sogoStatus(rtx || remote));
    return st === "processing" ? null : st;
  } catch {
    return null;
  }
}

/**
 * Find the bill_transactions row a live Sogo webhook belongs to when no
 * reference match exists, by matching the event's bill signature. Only rows
 * that are still 'processing' with a NULL provider_reference are eligible,
 * and the match is claimed by storing Sogo's reference. Conservative: no
 * unique, confident match → no guess (the reaper/support handle it instead).
 */
async function backfillSogoBill(sogoRef: string, tx: any): Promise<any | null> {
  try {
    const meta = tx?.metadata || {};
    const faceValue = sogo.sogoAmount(meta.face_value);
    const eventAmount = sogo.sogoAmount(tx?.amount);
    const amounts = [faceValue, eventAmount].filter((n) => n > 0);
    if (!amounts.length) return null;

    const customer = String(
      meta.phone_number || meta.customer_ref || meta.meter_number ||
        meta.smartcard_number || meta.account_id || "",
    ).trim();

    // Category hint from metadata.bill_type ("Airtime", "Cable TV", …).
    const billType = String(meta.bill_type || "").toLowerCase();
    const categoryHint = ["airtime", "data", "electricity", "cable", "education", "epin", "betting"]
      .find((c) => billType.startsWith(c)) || null;

    // Creation window around the provider transaction timestamp (clock skew
    // observed: Sogo's created_at can precede our row by a few hundred ms).
    const tsRaw = String(tx?.timestamps?.created_at || tx?.created_at || "");
    const ts = tsRaw ? new Date(tsRaw) : null;
    const windowFrom = ts && !isNaN(ts.getTime())
      ? new Date(ts.getTime() - 10 * 60_000)
      : new Date(Date.now() - 24 * 3600_000);
    const windowTo = ts && !isNaN(ts.getTime())
      ? new Date(ts.getTime() + 10 * 60_000)
      : new Date(Date.now() + 5 * 60_000);

    const params: any[] = [windowFrom.toISOString(), windowTo.toISOString()];
    const conds = [
      `provider = 'sogo'`, `status = 'processing'`,
      `(provider_reference IS NULL OR provider_reference = '')`,
      `created_at >= $1::timestamptz`, `created_at <= $2::timestamptz`,
    ];
    // amount: match the bill face value OR the charged total (discount/fee).
    params.push(amounts);
    conds.push(`(amount = ANY($${params.length}::numeric[]) OR total = ANY($${params.length}::numeric[]))`);
    if (customer) {
      params.push(customer);
      conds.push(`customer_ref = $${params.length}`);
    }
    if (categoryHint) {
      params.push(categoryHint);
      conds.push(`category = $${params.length}`);
    }

    const rows = await query(
      `SELECT * FROM bill_transactions WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT 5`,
      params,
    );
    if (rows.rows.length !== 1) {
      if (rows.rows.length > 1) console.warn(`[sogo webhook] backfill for ${sogoRef}: ${rows.rows.length} ambiguous candidates — skipping`);
      return null;
    }
    const claim = await query(
      `UPDATE bill_transactions SET provider_reference = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND (provider_reference IS NULL OR provider_reference = '') RETURNING *`,
      [rows.rows[0].id, sogoRef],
    );
    if (claim.rows[0]) {
      console.log(`[sogo webhook] backfilled ${rows.rows[0].reference} ← Sogo ${sogoRef}`);
      return claim.rows[0];
    }
    return null;
  } catch (e: any) {
    console.warn("[sogo webhook] backfill match failed:", e?.message);
    return null;
  }
}

async function handleSogoGiftcardBuy(tx: any) {
  const reference = String(tx?.reference || "");
  if (!reference) return;
  const rows = await query(`SELECT * FROM giftcard_buy_orders WHERE provider = 'sogo' AND (reference = $1 OR provider_reference = $1) LIMIT 1`, [reference]);
  const order = rows.rows[0];
  if (!order) return;
  const status = sogo.normalizeSogoStatus(sogo.sogoStatus(tx));
  if (status === "completed") {
    let codes = order.card_codes;
    if (!codes) {
      const { getTransaction } = await import("../services/sogo");
      const remote = await getTransaction(reference).catch(() => null);
      codes = remote?.gift_card_codes || remote?.codes || null;
    }
    await query(
      `UPDATE giftcard_buy_orders SET status = 'completed', card_codes = COALESCE($2::jsonb, card_codes), provider_response = $3::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [order.id, codes ? JSON.stringify(codes) : null, JSON.stringify(tx)],
    );
    try {
      await createNotification({
        businessId: String(order.business_id || ""), userId: String(order.user_id),
        type: "system", title: "Your gift card is ready",
        message: `Your ${order.giftcard_name || "gift card"} purchase has arrived. Open the app to view the code.`,
        actionUrl: "/giftcards", actionType: "view_transaction",
        metadata: { reference: order.reference }, isActionable: true, expiresInHours: 720,
      });
    } catch { /* best effort */ }
  } else if (["refunded", "cancelled", "failed"].includes(status)) {
    if (order.status !== "failed") {
      await creditUserWallet(order.user_id, order.wallet_id, Number(order.total_charged), `${order.reference}-REFUND`, "Refund — gift card order failed", order.business_id);
      await query(
        `UPDATE giftcard_buy_orders SET status = 'failed', failure_reason = $2, refunded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [order.id, String(tx?.failure_reason || status).slice(0, 500)],
      );
    }
  } else {
    await query(`UPDATE giftcard_buy_orders SET status = $2, provider_response = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [order.id, status === "processing" ? "processing" : order.status, JSON.stringify(tx)]);
  }
}

async function handleSogoGiftcardSell(tx: any) {
  const reference = String(tx?.reference || "");
  if (!reference) return;
  const rows = await query(
    `SELECT * FROM giftcard_sell_trades WHERE provider = 'sogo' AND (reference = $1 OR provider_reference = $1) LIMIT 1`,
    [reference],
  );
  const trade = rows.rows[0];
  if (!trade || trade.status === "settled") return;
  const status = sogo.normalizeSogoStatus(sogo.sogoStatus(tx));
  if (status === "completed") {
    const gross = sogo.sogoAmount(tx?.payout_amount) || sogo.sogoAmount(tx?.amount) || 0;
    const feePct = await getPercent("giftcard_sell_fee_percent", 5);
    const fee = Math.round(gross * (feePct / 100) * 100) / 100;
    const net = Math.max(0, Math.round((gross - fee) * 100) / 100);
    await creditUserWallet(trade.user_id, trade.wallet_id, net, `GCSP-${trade.reference}`, `Gift card sale payout — ${trade.giftcard_name || "card"}`, trade.business_id);
    await query(
      `UPDATE giftcard_sell_trades SET status = 'settled', credited_at = CURRENT_TIMESTAMP,
         payout_amount = GREATEST(payout_amount, $2), provider_response = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [trade.id, gross, JSON.stringify(tx)],
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
  } else if (["cancelled", "failed"].includes(status)) {
    await query(
      `UPDATE giftcard_sell_trades SET status = $2, rejection_reason = $3, provider_response = $4::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [trade.id, status === "cancelled" ? "rejected" : "failed",
       String(tx?.failure_reason || "Rejected by review").slice(0, 500), JSON.stringify(tx)],
    );
  }
}

async function handleSogoRmb(tx: any) {
  const reference = String(tx?.reference || "");
  if (!reference) return;
  const rows = await query(`SELECT * FROM rmb_orders WHERE reference = $1 OR provider_reference = $1 LIMIT 1`, [reference]);
  const order = rows.rows[0];
  if (!order) return;
  const mapped = sogo.normalizeSogoStatus(sogo.sogoStatus(tx));
  if (!["completed", "refunded", "cancelled", "failed"].includes(mapped)) return;
  if (mapped === order.status) return; // idempotent
  if (mapped === "refunded" || mapped === "cancelled" || mapped === "failed") {
    await creditUserWallet(order.user_id, order.wallet_id, Number(order.ngn_total), `${order.reference}-REFUND`, "Refund — RMB order failed", order.business_id);
  }
  await query(
    `UPDATE rmb_orders SET status = $2, provider_response = $3::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [order.id, mapped, JSON.stringify(tx)],
  );
}

/**
 * @swagger
 * /webhook/sogo:
 *   post:
 *     summary: Sogo partner webhook (bills, gift cards, RMB, crypto deposits)
 *     description: |
 *       Public callback for the Sogo provider. Signature-verified with the
 *       `X-Sogo-Signature-256` header — `sha256=` + HMAC-SHA256 hex digest of
 *       the RAW request body keyed by `SOGO_WEBHOOK_SECRET` (timing-safe).
 *       Settlement is idempotent per reference.
 *
 *       Events: `ping` (handshake probe — replies `{ success: true }`),
 *       `transaction.completed`, `transaction.failed`,
 *       `transaction.cancelled`, `transaction.refunded`. Any other event is
 *       acknowledged and ignored.
 *
 *       Routing by `data.type`:
 *       - crypto deposit — matched by `metadata.deposit_address` /
 *         `deposit_address` (or a pre-recorded sale by `reference`); NGN is
 *         settled to the Sogo wallet and the user's wallet is credited net
 *         of the configured crypto spread.
 *       - giftcard + buy — codes fetched via GET /transactions/{ref}; order
 *         completed.
 *       - giftcard (sell) — wallet credited with payout minus sell fee.
 *       - rmb — order status mapped; wallet refund on cancelled/refunded.
 *       - anything else — treated as a bill payment status update (with
 *         provider-side refund handling).
 *     tags: [Webhooks]
 *     security: []
 *     parameters:
 *       - in: header
 *         name: X-Sogo-Signature-256
 *         required: true
 *         schema:
 *           type: string
 *         description: '"sha256=" + HMAC-SHA256 hex of the raw body (SOGO_WEBHOOK_SECRET)'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [event, data]
 *             properties:
 *               event:
 *                 type: string
 *                 enum: [ping, transaction.completed, transaction.failed, transaction.cancelled, transaction.refunded]
 *               data:
 *                 type: object
 *                 description: "Sogo transaction object (data.object or data)"
 *                 properties:
 *                   reference:
 *                     type: string
 *                   type:
 *                     type: string
 *                     description: "bill_payment | buy_giftcard | sell_giftcard | rmb | crypto deposit (fuzzy-matched)"
 *                   amount:
 *                     type: number
 *                   crypto_amount:
 *                     type: number
 *                   payout_amount:
 *                     type: number
 *                     description: "Net NGN payout used for crypto-deposit settlement"
 *                   net_amount:
 *                     type: number
 *                   rate:
 *                     type: number
 *                   metadata:
 *                     type: object
 *                     properties:
 *                       deposit_address:
 *                         type: string
 *                       deposit_tx_hash:
 *                         type: string
 *     responses:
 *       200:
 *         description: Event acknowledged and processed (or intentionally ignored)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       401:
 *         description: Invalid or missing webhook signature
 *       500:
 *         description: Processing error (event should be retried by the provider)
 */
/** Event names Sogo actually delivers for transaction outcomes. */
const SOGO_EVENTS = ["transaction.completed", "transaction.failed", "transaction.cancelled", "transaction.refunded"] as const;

/**
 * Event-processing core, shared by the HTTP webhook and the admin replay
 * endpoint (which re-drives a stored squad_webhooks payload — e.g. an event
 * that was dropped by an earlier handler bug and already ACKed 200, so Sogo
 * will never resend it). Returns how the event was dispositioned.
 */
export async function processSogoEvent(payload: any): Promise<"processed" | "ignored"> {
  const event = String(payload?.event || "");
  const tx = sogo.sogoTx(payload); // FIX: data.object is a discriminator string in live webhooks
  console.log(`[sogo webhook] event: ${event || "unknown"} ref=${tx?.reference || "n/a"}`);
  if (event === "ping") return "processed";
  if (!SOGO_EVENTS.includes(event as any)) return "ignored";
  const type = sogo.sogoType(tx); // FIX: type arrives as {value, is_credit}
  // Crypto deposits carry a deposit hash + address and no bill/giftcard type.
  if (type.includes("crypto") || tx?.metadata?.deposit_tx_hash || type.includes("deposit")) {
    await handleSogoCryptoDeposit(tx);
  } else if (type.includes("gift") && type.includes("buy")) {
    await handleSogoGiftcardBuy(tx);
  } else if (type.includes("gift")) {
    await handleSogoGiftcardSell(tx);
  } else if (type.includes("rmb")) {
    await handleSogoRmb(tx);
  } else {
    await handleSogoBillPayment(tx);
  }
  return "processed";
}

export async function sogoWebhookHandler(req: Request, res: Response) {
  let payload: any = null;
  let event = "";
  let signatureValid: boolean | null = true;
  try {
    const raw = rawBody(req);
    const signature = (req.headers["x-sogo-signature-256"] as string) || "";
    // Fail closed on a missing signing secret, but answer 503 — NOT 401.
    // With no secret configured EVERY signature fails, and a 401 would send
    // the operator debugging their own signature when the fix is a server
    // env change (SOGO_WEBHOOK_SECRET).
    if (!sogo.sogoWebhookSecretConfigured()) {
      console.error("[sogo webhook] SOGO_WEBHOOK_SECRET is not configured on this server — rejecting (fail-closed). Every webhook will 503 until the secret is set in the server env.");
      payload = asJson(req);
      signatureValid = false;
      await logWebhookEvent({ provider: "sogo", eventType: String(payload?.event || "unknown"), payload, status: "rejected", signatureValid, error: "SOGO_WEBHOOK_SECRET not configured on server" });
      return res.status(503).json({ success: false, error: "Webhook secret not configured" });
    }
    if (!verifySogoWebhook(raw, signature)) {
      signatureValid = false;
      payload = asJson(req);
      console.warn("[sogo webhook] signature verification failed");
      await logWebhookEvent({ provider: "sogo", eventType: String(payload?.event || "unknown"), payload, status: "rejected", signatureValid, error: "Invalid webhook signature" });
      return res.status(401).json({ success: false, error: "Invalid webhook signature" });
    }
    payload = asJson(req);
    event = String(payload?.event || "");
    const tx = sogo.sogoTx(payload);
    if (event === "ping") {
      await logWebhookEvent({ provider: "sogo", eventType: "ping", reference: tx?.reference || null, payload, status: "processed", signatureValid });
      return res.json({ success: true });
    }
    if (!SOGO_EVENTS.includes(event as any)) {
      await logWebhookEvent({ provider: "sogo", eventType: event || "unknown", reference: tx?.reference || null, payload, status: "ignored", signatureValid });
      return res.json({ success: true });
    }
    const outcome = await processSogoEvent(payload);
    await logWebhookEvent({ provider: "sogo", eventType: event || "unknown", reference: tx?.reference || null, payload, status: outcome, signatureValid });
    return res.json({ success: true });
  } catch (e: any) {
    console.error("[sogo webhook] error:", e?.message);
    await logWebhookEvent({ provider: "sogo", eventType: event || "unknown", payload, status: "failed", signatureValid, error: e?.message });
    return res.status(500).json({ success: false });
  }
}
