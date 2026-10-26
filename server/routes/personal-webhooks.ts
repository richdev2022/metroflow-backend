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
       owner.asset, owner.network, Number(tx.crypto_amount || tx.amount || 0) || null, JSON.stringify(tx)],
    );
    sale = insert.rows[0];
  }
  if (!sale) {
    console.warn("[sogo webhook] crypto deposit without match:", tx?.reference);
    return;
  }
  if (sale.status === "completed") return; // idempotent

  const gross = Number(tx?.payout_amount ?? tx?.net_amount ?? tx?.amount ?? sale.ngn_gross ?? 0);
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
  const { sogoStatus } = await import("../services/sogo");
  const reference = String(tx?.reference || "");
  if (!reference) return;
  const rows = await query(`SELECT * FROM bill_transactions WHERE reference = $1 OR provider_reference = $1 LIMIT 1`, [reference]);
  const bill = rows.rows[0];
  if (!bill) return;
  const status = sogoStatus(tx);
  const mapped = ["completed", "failed", "refunded", "cancelled"].includes(status) ? status : "processing";
  if (mapped === bill.status) return;
  // IDEMPOTENCY: claim the status transition FIRST (guarded update), then
  // refund. The old credit-first order meant a failed refund insert kept the
  // bill 'processing' and every Sogo retry re-credited the wallet forever.
  const claim = await query(
    `UPDATE bill_transactions SET status = $2, provider_response = $3::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status <> $2`,
    [bill.id, mapped, JSON.stringify(tx)],
  );
  if (claim.rowCount === 0) return; // someone else already settled this bill
  if (mapped === "refunded" || mapped === "failed" || mapped === "cancelled") {
    // Provider-side refund → return the customer's money.
    await creditUserWallet(bill.user_id, bill.wallet_id, Number(bill.total), `${bill.reference}-REFUND`, "Refund — bill payment reversed", bill.business_id);
  }
}

async function handleSogoGiftcardBuy(tx: any) {
  const { sogoStatus } = await import("../services/sogo");
  const reference = String(tx?.reference || "");
  if (!reference) return;
  const rows = await query(`SELECT * FROM giftcard_buy_orders WHERE provider = 'sogo' AND (reference = $1 OR provider_reference = $1) LIMIT 1`, [reference]);
  const order = rows.rows[0];
  if (!order) return;
  const status = sogoStatus(tx);
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
  const { sogoStatus } = await import("../services/sogo");
  const status = sogoStatus(tx);
  if (status === "completed") {
    const gross = Number(tx?.payout_amount ?? tx?.amount ?? 0);
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
  const { sogoStatus } = await import("../services/sogo");
  const status = sogoStatus(tx);
  const mapped = ["completed", "refunded", "cancelled", "failed"].includes(status) ? status : null;
  if (!mapped || mapped === order.status) return;
  if (mapped === "refunded" || mapped === "cancelled" || mapped === "failed") {
    await creditUserWallet(order.user_id, order.wallet_id, Number(order.ngn_total), `${order.reference}-REFUND`, "Refund — RMB order failed", order.business_id);
  }
  await query(
    `UPDATE rmb_orders SET status = $2, provider_response = $3::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [order.id, mapped, JSON.stringify(tx)],
  );
}

export async function sogoWebhookHandler(req: Request, res: Response) {
  try {
    const raw = rawBody(req);
    const signature = (req.headers["x-sogo-signature-256"] as string) || "";
    if (!verifySogoWebhook(raw, signature)) {
      console.warn("[sogo webhook] signature verification failed");
      return res.status(401).json({ success: false, error: "Invalid webhook signature" });
    }
    const payload = asJson(req);
    const event = String(payload?.event || "");
    const tx = payload?.data?.object || payload?.data || {};
    console.log(`[sogo webhook] event: ${event || "unknown"} ref=${tx?.reference || "n/a"}`);
    if (event === "ping") return res.json({ success: true });
    if (!["transaction.completed", "transaction.failed", "transaction.cancelled", "transaction.refunded"].includes(event)) {
      return res.json({ success: true });
    }
    const type = String(tx?.type || "").toLowerCase();
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
    return res.json({ success: true });
  } catch (e: any) {
    console.error("[sogo webhook] error:", e?.message);
    return res.status(500).json({ success: false });
  }
}
