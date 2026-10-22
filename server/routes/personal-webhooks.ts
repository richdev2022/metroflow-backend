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
        console.warn("[bitnob webhook] signature mismatch");
        return res.status(401).json({ success: false, error: "Invalid webhook signature" });
      }
    } else if (!secret) {
      console.warn("[bitnob webhook] BITNOB_WEBHOOK_SECRET not set — signature NOT verified");
    }

    const payload = asJson(req);
    const event = String(payload?.event || payload?.type || "");
    console.log(`[bitnob webhook] event: ${event || "unknown"}`);

    // ---- Stablecoin lifecycle (deposits + withdrawals + trades) ----
    if (/^deposit\.success$/i.test(event)) {
      await processStablecoinDeposit(payload);
      return res.json({ success: true });
    }
    if (/^transfer\.(success|failed|expired)$/i.test(event)) {
      await finalizeStablecoinWithdrawal(event, payload);
      return res.json({ success: true });
    }
    if (/trade[s]?\.|^order/i.test(event) && (payload?.data?.reference || payload?.data?.order?.reference || payload?.data?.order_id)) {
      // Trading order lifecycle — settle the matching platform conversion.
      const ref = payload?.data?.reference || payload?.data?.order?.reference || payload?.data?.order_id;
      const { settleConversion } = await import("../features/personal/stablecoin");
      await settleConversion(String(ref));
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
    res.json({ success: true });
  } catch (e: any) {
    console.error("[bitnob webhook] error:", e?.message);
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
export async function stablecoinWebhookHandler(req: Request, res: Response) {
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
        console.warn("[bitnob stablecoin webhook] signature mismatch");
        return res.status(401).json({ success: false, error: "Invalid webhook signature" });
      }
    } else if (!secret) {
      console.warn("[bitnob stablecoin webhook] BITNOB_WEBHOOK_SECRET not set — signature NOT verified");
    }
    const payload = asJson(req);
    const event = String(payload?.event || payload?.type || "");
    console.log(`[bitnob stablecoin webhook] event: ${event || "unknown"}`);
    if (/^deposit\.success$/i.test(event)) await processStablecoinDeposit(payload);
    else if (/^transfer\.(success|failed|expired)$/i.test(event)) await finalizeStablecoinWithdrawal(event, payload);
    else console.log(`[bitnob stablecoin webhook] ignored event: ${event}`);
    res.json({ success: true });
  } catch (e: any) {
    console.error("[bitnob stablecoin webhook] error:", e?.message);
    res.status(500).json({ success: false });
  }
}
