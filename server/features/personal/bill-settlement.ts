import { query, pool } from "../../db";
import { creditWallet, insertTransaction } from "./personal-utils";
import { createNotification } from "../../services/notifications";
import { creditPlatformWallet, creditRevenueWallet, debitRevenueWallet } from "../../services/fees";
import { sendPushToUsers } from "../../services/push";
import * as sogo from "../../services/sogo";
import { getActiveProvider } from "./provider-routing";
import {
  recordBillCompletionLedger,
  accrueBillCashback,
  clawbackBillCashback,
  unwindBillDiscountRevenue,
} from "./bill-ledger";

/**
 * BILL SETTLEMENT ENGINE — money-safe reconciliation for bill payments.
 *
 * Why this exists: a bill row left in 'processing' means the customer's
 * wallet was debited but the provider outcome was never recorded. That can
 * happen when (a) the server process dies mid-provider-call (deploy/PM2
 * restart, crash), (b) the provider fulfils asynchronously and the webhook
 * is missed/unconfigured, or (c) the refund credit itself failed after the
 * row was marked failed. On the production VPS Sogo currently runs in
 * SANDBOX mode, which additionally means NO reconciliation path existed at
 * all: the live-status poll is gated behind !isSogoSandbox(), sandbox never
 * delivers webhooks, and sandbox 404s every lookup — rows stranded forever.
 *
 * This engine is the single settlement path used by:
 *   - the lazy per-user sweep on bill history reads (bills.ts)
 *   - the global 5-minute reaper (server/index.ts cron)
 *   - the Sogo webhook handler (personal-webhooks.ts)
 *
 * MONEY SAFETY RULES (all idempotent):
 *   1. Refunds are ledger-keyed: a refund happens iff a `${reference}-REFUND`
 *      credit row does not exist AND a debit row for the bill reference does.
 *   2. Status transitions are claimed with guarded UPDATEs
 *      (… WHERE id = $1 AND status <> $2) so webhook + reaper + user-triggered
 *      syncs can never double-settle.
 *   3. The provider is ALWAYS asked before a refund is issued (live mode) —
 *      never refund a bill the provider actually fulfilled.
 */

type BillRow = {
  id: string;
  reference: string;
  user_id: string;
  business_id: string | null;
  wallet_id: string | null;
  provider: string;
  category: string;
  amount: string | number;
  fee: string | number;
  total: string | number;
  status: string;
  details: any;
  provider_reference?: string | null;
  settled_at?: Date | string | null;
  created_at: Date | string;
};

const MIN_AGE_MINUTES = Number(process.env.BILL_RECONCILE_MIN_AGE_MINUTES || 10);
const REFUND_AFTER_MINUTES = Number(process.env.BILL_REFUND_AFTER_MINUTES || 30);
const PENDING_REFUND_HOURS = Number(process.env.BILL_PENDING_REFUND_HOURS || 24);

function ageMinutes(bill: BillRow): number {
  return (Date.now() - new Date(bill.created_at as any).getTime()) / 60_000;
}

/**
 * Deduped console alarm for processing bills we refuse to auto-refund.
 * Money-safety: a bill whose provider state is AMBIGUOUS must never be
 * refunded on a timer — the provider may have delivered it (the 2026-10-30
 * incident refunded a delivered airtime bill because a 404 on our fallback
 * reference was misread as "no record"). Rows hold in 'processing' and the
 * operator is alerted once per reference until the row settles.
 */
const alertedUnsettled = new Set<string>();
function alertUnsettled(bill: BillRow, why: string) {
  if (alertedUnsettled.has(bill.reference)) return;
  alertedUnsettled.add(bill.reference);
  if (alertedUnsettled.size > 500) {
    const oldest = alertedUnsettled.values().next().value;
    if (oldest) alertedUnsettled.delete(oldest);
  }
  console.error(
    `[bill-settlement] HOLD — ${bill.reference} left in 'processing': ${why}. ` +
    `Auto-refund REFUSED — the provider may have delivered this bill. ` +
    `Resolution: signed webhook backfill, user-side transaction sync, or admin review.`,
  );
}
function clearUnsettledAlert(reference: string) {
  alertedUnsettled.delete(reference);
}

async function hasDebitLedger(reference: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM transactions WHERE reference = $1 AND type = 'debit' LIMIT 1`,
    [reference],
  );
  return r.rows.length > 0;
}

async function hasRefundLedger(reference: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM transactions WHERE reference = $1 AND type = 'credit' LIMIT 1`,
    [`${reference}-REFUND`],
  );
  return r.rows.length > 0;
}

async function hasCashbackLedger(reference: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM transactions WHERE reference = $1 AND type = 'credit' LIMIT 1`,
    [`${reference}-CB`],
  );
  return r.rows.length > 0;
}

async function notify(bill: BillRow, title: string, message: string) {
  try {
    await createNotification({
      businessId: String(bill.business_id || ""),
      userId: String(bill.user_id),
      type: "system",
      title,
      message,
      actionUrl: "/bills",
      actionType: "view_transaction",
      metadata: { reference: bill.reference },
      isActionable: false,
      expiresInHours: 168,
    });
  } catch { /* best effort */ }
}

/**
 * Mark a processing bill COMPLETED (late confirmation from webhook, poll or
 * reaper). Books the provider/discount/cashback ledgers through the shared
 * bill-ledger engine (cashback accrues to the DEDICATED cashback balance),
 * idempotently.
 */
export async function settleBillCompleted(bill: BillRow, providerResponse: any): Promise<boolean> {
  // Claim first — concurrent settlers lose here.
  const claim = await query(
    `UPDATE bill_transactions
       SET status = 'completed', provider_response = COALESCE($2::jsonb, provider_response),
           settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'processing' RETURNING id`,
    [bill.id, providerResponse ? JSON.stringify(providerResponse) : null],
  );
  if (claim.rowCount === 0) return false;
  clearUnsettledAlert(bill.reference);

  const amount = Number(bill.amount);
  const details = bill.details || {};

  // Vendor charge + discount margin (face − discounted → Revenue ledger).
  const providerTx = providerResponse?.transaction ?? providerResponse;
  await recordBillCompletionLedger(bill, providerTx);

  // Late cashback (admin promo) — only for rows that never got it. Lands in
  // the wallet's DEDICATED cashback balance.
  const cbPercent = Number(details?.cashback_percent || 0);
  if (cbPercent > 0 && bill.wallet_id && !(await hasCashbackLedger(bill.reference))) {
    const cashback = Math.round(((amount * cbPercent) / 100) * 100) / 100;
    if (cashback > 0) {
      await accrueBillCashback(bill, cashback, cbPercent);
    }
  }

  await notify(
    bill,
    "Bill payment successful",
    `Your ${bill.category} payment of ₦${amount.toLocaleString()} was confirmed. Ref: ${bill.reference}.`,
  );
  return true;
}

/**
 * REFUND CORRECTION — a refund was issued while the provider actually
 * fulfilled the bill (an ambiguous dispatch error refunded on a guess, or an
 * old blind-refund row that the webhook reached too late to save). The
 * customer ended up with the service AND their money back; the platform is
 * owed `total`.
 *
 * Webhook-driven: only runs when the provider itself reports COMPLETED.
 * Atomic core (ONE database transaction):
 *   claim bill row (refunded|failed|cancelled → completed) +
 *   guarded wallet re-debit (only when a `-REFUND` credit exists AND the
 *   balance still covers it) + idempotent `${ref}-REFUND-REVERSAL` debit
 *   ledger row + the original debit row flipped back to 'success'.
 * If the wallet can no longer cover the re-debit the whole correction rolls
 * back and support is flagged — a surprise negative balance is worse than a
 * visible pending correction.
 * Non-fatal unwinds after the commit: fee revenue re-earned and promo
 * cashback restored when the reversal had taken them away.
 */
export async function correctWrongRefund(
  bill: BillRow,
  providerResponse: any,
): Promise<{ corrected: boolean; reDebited: boolean; note: string }> {
  const ref = bill.reference;
  const total = Number(bill.total);
  const out = { corrected: false, reDebited: false, note: "" };
  if (!ref || !bill.wallet_id || !(total > 0)) {
    out.note = "missing wallet link or non-positive total";
    return out;
  }

  const refundLedger = await query(
    `SELECT 1 FROM transactions WHERE reference = $1 AND type = 'credit' LIMIT 1`,
    [`${ref}-REFUND`],
  );
  const wasRefunded = refundLedger.rows.length > 0;

  const client = await pool.connect();
  let claimed = false;
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `UPDATE bill_transactions
         SET status = 'completed', provider_response = COALESCE($2::jsonb, provider_response),
             failure_reason = NULL,
             settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = ANY($3::varchar[]) RETURNING id`,
      [bill.id, providerResponse ? JSON.stringify(providerResponse) : null, ["refunded", "failed", "cancelled"]],
    );
    if (claim.rows.length === 0) {
      await client.query("ROLLBACK");
      out.note = "row no longer correctable (already settled)";
      return out;
    }
    if (wasRefunded) {
      const reDebit = await client.query(
        `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND balance >= $1 RETURNING id`,
        [total, bill.wallet_id],
      );
      if (reDebit.rows.length === 0) {
        await client.query("ROLLBACK");
        out.note = "wallet can no longer cover the re-debit — needs support action";
        console.error(`[bill-settlement] refund correction blocked for ${ref}: ${out.note}`);
        await notify(
          bill,
          "Bill correction pending",
          `Provider confirmed your ${bill.category} payment of ₦${total.toLocaleString()} was fulfilled, but the earlier refund has already been spent. Please top up ₦${total.toLocaleString()} or contact support to settle. Ref: ${ref}.`,
        );
        return out;
      }
      await client.query(
        `INSERT INTO transactions
           (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
         VALUES ($1, $2, $3, 'NGN', 'success', $4, 'debit', $5, 'bill_refund_reversal', $6, 'debit')
         ON CONFLICT (reference) DO NOTHING`,
        [
          bill.business_id ?? null,
          bill.user_id ?? null,
          total,
          `${ref}-REFUND-REVERSAL`,
          `Refund correction — ${bill.category} bill ${ref} was fulfilled by the provider; the earlier refund is re-debited`,
          bill.wallet_id,
        ],
      );
      out.reDebited = true;
    }
    // The reversal's display flip must undo too — the original debit is green again.
    await client.query(
      `UPDATE transactions SET status = 'success', updated_at = CURRENT_TIMESTAMP
        WHERE reference = $1 AND type = 'debit' AND status <> 'success'`,
      [ref],
    );
    await client.query("COMMIT");
    claimed = true;
    out.corrected = true;
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (!claimed) return out;

  // ---- Post-commit unwinds (best-effort, idempotent) ---------------------
  if (Number(bill.fee) > 0) {
    try {
      const revDebited = await query(
        `SELECT 1 FROM transactions WHERE reference = $1 AND wallet_id IS NULL LIMIT 1`,
        [`${ref}-REVENUE-DEBIT`],
      );
      if (revDebited.rows.length > 0) {
        await creditRevenueWallet(
          Number(bill.fee),
          "NGN",
          `${ref}-CORRECTION`,
          `Fee re-earned — bill ${ref} confirmed after refund correction`,
          "bills",
        );
      }
    } catch (e: any) {
      console.error(`[bill-settlement] fee re-earn failed for ${ref}:`, e?.message);
    }
  }
  try {
    const cbReversed = await query(
      `SELECT amount FROM transactions WHERE reference = $1 AND type = 'debit' LIMIT 1`,
      [`${ref}-CB-REVERSAL`],
    );
    const cb = cbReversed.rows.length ? Number(cbReversed.rows[0].amount) : 0;
    if (cb > 0 && bill.wallet_id) {
      await creditWallet(bill.wallet_id, cb);
      await insertTransaction({
        userId: bill.user_id, businessId: bill.business_id, walletId: bill.wallet_id,
        reference: `${ref}-CB-REDO`, type: "credit", transactionType: "bill_cashback",
        amount: cb, currency: "NGN",
        description: `Cashback restored — bill ${ref} confirmed after correction`,
      });
    }
  } catch (e: any) {
    console.error(`[bill-settlement] cashback restore failed for ${ref}:`, e?.message);
  }

  // ---- Tell the customer (push + in-app) ---------------------------------
  const pretty = `₦${total.toLocaleString()}`;
  try {
    const walletRes = await query(`SELECT user_id, business_id FROM wallets WHERE id = $1`, [bill.wallet_id]);
    const w = walletRes.rows[0];
    if (w?.user_id) {
      await sendPushToUsers(
        [{ userId: w.user_id, businessId: w.business_id || bill.business_id }],
        {
          title: "Bill Payment Confirmed",
          body: wasRefunded
            ? `Your ${bill.category} payment of ${pretty} was fulfilled by the provider. The earlier refund was corrected (${pretty} re-debited). Ref: ${ref}.`
            : `Your ${bill.category} payment of ${pretty} was fulfilled by the provider. Ref: ${ref}.`,
          data: {
            type: "transaction",
            eventType: "bill_correction",
            reference: ref,
            amount: String(total),
            currency: "NGN",
          },
        },
        { inApp: false, type: "transaction", businessId: w.business_id || bill.business_id },
      ).catch((pushErr: any) => console.error(`[bill-settlement] correction push failed for ${ref}:`, pushErr?.message));
    }
  } catch (e: any) {
    console.error(`[bill-settlement] correction push setup failed for ${ref}:`, e?.message);
  }
  await notify(
    bill,
    "Bill payment confirmed",
    wasRefunded
      ? `Your ${bill.category} payment of ${pretty} was fulfilled by the provider — it is now marked successful. The earlier refund was corrected (${pretty} re-debited). Ref: ${ref}.`
      : `Your ${bill.category} payment of ${pretty} was fulfilled by the provider — it is now marked successful. Ref: ${ref}.`,
  );
  return out;
}

/**
 * Refund a processing bill (provider failed / never received / timed out).
 * Idempotent on the ledger: only credits when the debit exists and the
 * refund row does not. Thin wrapper over reverseBillPayment — every refund
 * (auto or admin) now runs the SAME robust reversal core: claim-first
 * ledger idempotency, platform-vendor re-credit, fee-revenue unwind, the
 * original debit row flipped to 'failed', and push + in-app notification.
 */
export async function refundBillRow(bill: BillRow, reason: string, providerResponse?: any): Promise<boolean> {
  const result = await reverseBillPayment(bill, reason, {
    fromStatuses: ["processing"],
    providerResponse,
    skipProviderCheck: true, // callers (reaper/webhook/sweep) already asked the provider
  });
  return result.reversed;
}

export type BillReverseResult = {
  /** true when THIS call performed the reversal (won the claim) */
  reversed: boolean;
  /** true when a `-REFUND` ledger row already existed (nothing was re-credited) */
  alreadyReversed: boolean;
  /** whether money was actually credited to the wallet in this pass */
  credited: boolean;
  /** what the provider said, when it was asked */
  providerVerified?: "completed" | "failed" | "no-record" | "unverifiable" | "skipped";
  /** non-fatal notes (skipped cashback clawback, etc.) */
  notes: string[];
};

/**
 * ROBUST BILL REVERSAL — the bill-payment mirror of TransferService's
 * reverseFailedTransfer(), with the same guard rails and the same
 * claim-first idempotency contract:
 *
 *   1. The `-REFUND` credit row is the claim gate (INSERT … ON CONFLICT …
 *      RETURNING id) — webhook, reaper, sync and admin clicks can race
 *      freely and only ONE wallet credit can ever happen. The claim row and
 *      the wallet balance credit commit in ONE database transaction, so a
 *      mid-crash retry can neither double-credit nor lose the credit.
 *   2. The provider is asked first (live Sogo): a bill the provider
 *      DELIVERED is never reversed — a hard guard that `force` cannot
 *      override, mirroring "provider reports SUCCESSFUL → refuse". When the
 *      provider state is merely AMBIGUOUS (404 on our fallback reference,
 *      auth failure, outage, still-pending) the reversal is also refused
 *      without `force` — ambiguity is not proof of non-delivery (the
 *      2026-10-30 false refund).
 *   3. Full ledger unwind on reversal:
 *        - platform vendor hold re-credited (`<ref>-VENDOR-REVERSAL`) —
 *          the pay flow debits the platform the moment it dispatches, so a
 *          bill that never completed leaves the pool holding money for a
 *          vendor that was never paid;
 *        - fee revenue reversed (`<ref>-REVENUE-DEBIT`) when it was earned;
 *        - promo cashback clawed back (`<ref>-CB-REVERSAL`) when it was paid
 *          (best-effort — an already-spent cashback never blocks a refund).
 *   4. The original `transactions` debit row flips 'success' → 'failed'
 *      (the display half of reversal: users must not keep a green debit
 *      for money that came back — the exact gap that made the three
 *      refunded Oct-2026 bills look unreversed).
 *   5. The bill row itself lands on 'refunded' via a guarded UPDATE that
 *      never resurrects a completed row unless the caller explicitly
 *      allows it (admin override / provider-reported failure).
 *   6. The customer is TOLD — FCM push + in-app notification, same as
 *      transfer reversals.
 */
export async function reverseBillPayment(
  bill: BillRow,
  reason: string,
  opts: {
    /** statuses allowed to transition to 'refunded' (default: everything except completed) */
    fromStatuses?: string[];
    /** provider payload to store on the row (webhook / poll evidence) */
    providerResponse?: any;
    /** caller already asked the provider (reaper/webhook) — don't ask again */
    skipProviderCheck?: boolean;
    /** admin override: also allow completed rows whose provider state is UNKNOWN (sandbox/simulator) */
    force?: boolean;
    /** provider itself reported the failure — completed rows may then be reversed */
    providerReportedFailure?: boolean;
  } = {},
): Promise<BillReverseResult> {
  const notes: string[] = [];
  const out: BillReverseResult = { reversed: false, alreadyReversed: false, credited: false, notes };

  if (!bill || !bill.reference) { notes.push("no bill row"); return out; }
  if (!bill.wallet_id) { notes.push("bill has no wallet link — nothing to reverse"); return out; }

  const total = Number(bill.total);
  const amount = Number(bill.amount);
  const fee = Number(bill.fee || 0);
  if (!(total > 0)) { notes.push("non-positive total — nothing to reverse"); return out; }
  const ref = bill.reference;

  // ---- 1. Ask the provider before touching money (live Sogo only) -------
  let providerVerified: BillReverseResult["providerVerified"] = "skipped";
  if (!opts.skipProviderCheck && bill.provider === "sogo" && !sogo.isSogoSandbox()) {
    if (!sogo.isSogoConfigured()) {
      providerVerified = "unverifiable"; // cannot ask — never proof of non-delivery
    } else {
      // A 404 only proves "dispatch never landed" when the lookup used
      // Sogo's OWN reference. Our MF-BILL reference is the Idempotency-Key;
      // live Sogo does not index it, so a 404 on the fallback is ambiguous.
      const hasTrustedKey = !!bill.provider_reference && bill.provider_reference !== bill.reference;
      try {
        const remote = await sogo.getTransaction(bill.provider_reference || ref).catch((e: any) => {
          if (e?.response?.status === 404) return null;
          throw e;
        });
        if (remote === null) {
          providerVerified = hasTrustedKey ? "no-record" : "unverifiable";
        } else {
          const tx = remote?.transaction ?? remote;
          const st = sogo.sogoStatus(tx || remote);
          if (["completed", "successful", "success", "delivered"].includes(st)) {
            providerVerified = "completed";
          } else if (["failed", "failure", "refunded", "reversed", "cancelled", "canceled"].includes(st)) {
            providerVerified = "failed";
            opts.providerReportedFailure = true;
          } else {
            providerVerified = "unverifiable"; // provider still working — not proof of anything
          }
        }
      } catch {
        providerVerified = "unverifiable"; // auth failure / outage — never proof of non-delivery
      }
    }
  } else if (opts.skipProviderCheck) {
    providerVerified = "skipped";
  } else {
    // sandbox / simulator / flutterwave-sync path — the provider cannot have
    // delivered a real fulfilment we don't know about.
    providerVerified = bill.provider === "sogo" ? "no-record" : "skipped";
  }
  out.providerVerified = providerVerified;

  // HARD GUARD (mirrors "provider reports SUCCESSFUL → refuse" on transfers):
  // the provider DELIVERED this bill — the money bought something real.
  if (providerVerified === "completed" && !opts.force) {
    notes.push("provider reports the bill was fulfilled — reversal refused");
    return out;
  }
  // AMBIGUITY GUARD: fallback-reference 404 / auth failure / outage /
  // still-pending are NOT proof the bill went unfulfilled. Refuse without an
  // explicit admin force — this is the guard that would have stopped the
  // 2026-10-30 "delivered bill auto-refunded" incident.
  if (providerVerified === "unverifiable" && !opts.force) {
    notes.push("provider state could not be verified — reversal refused (resolve the provider lookup, or retry with force after manual review)");
    return out;
  }

  const fromStatuses = opts.fromStatuses || ["processing", "pending", "failed", "cancelled"];
  if (providerVerified !== "completed" && (opts.force || opts.providerReportedFailure)) {
    fromStatuses.push("completed");
  }
  if (!fromStatuses.includes(String(bill.status))) {
    notes.push(`row status '${bill.status}' is not reversible in this path`);
    return out;
  }

  // ---- 2. Claim + wallet credit in ONE transaction -----------------------
  // The `${ref}-REFUND` ledger row is the idempotency gate. Claiming it and
  // crediting the wallet in the same committed transaction means: crash
  // before commit → nothing happened (retry safe); crash after commit → the
  // refund row exists so no retry can double-credit.
  const debitCheck = await query(
    `SELECT 1 FROM transactions WHERE reference = $1 AND type = 'debit' LIMIT 1`,
    [ref],
  );
  const moneyLeftWallet = debitCheck.rows.length > 0;

  const client = await pool.connect();
  let claimed = false;
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `INSERT INTO transactions
         (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
       VALUES ($1, $2, $3, 'NGN', 'success', $4, 'credit', $5, 'bill_refund', $6, 'credit')
       ON CONFLICT (reference) DO NOTHING RETURNING id`,
      [
        bill.business_id ?? null,
        bill.user_id ?? null,
        total,
        `${ref}-REFUND`,
        `Bill payment reversal — ${bill.category}${reason ? ` (${String(reason).slice(0, 160)})` : ""}`,
        bill.wallet_id,
      ],
    );
    if (claim.rows.length === 0) {
      await client.query("ROLLBACK");
      out.alreadyReversed = true;
      return out;
    }
    if (moneyLeftWallet) {
      await client.query(
        `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [total, bill.wallet_id],
      );
      out.credited = true;
    } else {
      notes.push("no debit ledger row — closing the bill without a wallet credit");
    }
    await client.query("COMMIT");
    claimed = true;
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (!claimed) return out; // unreachable defensively
  clearUnsettledAlert(ref);

  // ---- 3. Ledger unwind (all idempotent by reference) --------------------
  // 3a. Platform vendor hold: the pay flow debits the platform the instant
  //     the order dispatches. If the bill never completed, the pool is
  //     holding money for a vendor that was never paid — give it back.
  if (amount > 0) {
    try {
      const vendorHold = await query(
        `SELECT 1 FROM transactions WHERE reference = $1 AND transaction_type = 'platform' LIMIT 1`,
        [`${ref}-VENDOR`],
      );
      if (vendorHold.rows.length > 0) {
        await creditPlatformWallet(
          amount,
          "NGN",
          `${ref}-VENDOR-REVERSAL`,
          `Reversal of platform vendor debit for uncompleted bill ${ref}`,
          "bills",
        );
      }
    } catch (e: any) {
      console.error(`[bill-settlement] vendor re-credit failed for ${ref}:`, e?.message);
      notes.push("vendor re-credit failed (non-fatal)");
    }
  }

  // 3b. Fee revenue: only earned when the bill completed — reverse iff the
  //     `-REVENUE-CREDIT` row exists.
  if (fee > 0) {
    try {
      const revCredit = await query(
        `SELECT 1 FROM transactions WHERE reference = $1 AND wallet_id IS NULL LIMIT 1`,
        [`${ref}-REVENUE-CREDIT`],
      );
      if (revCredit.rows.length > 0) {
        await debitRevenueWallet(fee, "NGN", ref, `Reversal of bill fee revenue for ${ref}`, "bills");
      }
    } catch (e: any) {
      console.error(`[bill-settlement] fee revenue unwind failed for ${ref}:`, e?.message);
      notes.push("fee revenue unwind failed (non-fatal)");
    }
  }

  // 3c. Promo cashback clawback (completed-bill reversals only): take back
  //     what was credited IF the cashback balance still holds it. Best-effort.
  try {
    await clawbackBillCashback(bill);
  } catch (e: any) {
    console.error(`[bill-settlement] cashback clawback failed for ${ref}:`, e?.message);
    notes.push("cashback clawback failed (non-fatal)");
  }

  // 3d. Discount revenue unwind: the provider's discount was booked as
  //     revenue on completion — take it back when the bill reverses.
  try {
    await unwindBillDiscountRevenue(ref, bill.category);
  } catch (e: any) {
    console.error(`[bill-settlement] discount unwind failed for ${ref}:`, e?.message);
  }

  // ---- 4. Display flip: the original debit must not stay green -----------
  try {
    await query(
      `UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE reference = $1 AND type = 'debit' AND status <> 'failed'`,
      [ref],
    );
  } catch (e: any) {
    console.error(`[bill-settlement] debit display flip failed for ${ref}:`, e?.message);
  }

  // ---- 5. Bill row → 'refunded' (guarded; never resurrects completed) ----
  const upd = await query(
    `UPDATE bill_transactions
       SET status = 'refunded', failure_reason = $2,
           provider_response = COALESCE($3::jsonb, provider_response),
           settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = ANY($4::varchar[]) RETURNING id`,
    [
      bill.id,
      String(reason || "Reversed").slice(0, 500),
      opts.providerResponse ? JSON.stringify(opts.providerResponse) : null,
      fromStatuses,
    ],
  );
  if (upd.rowCount === 0) {
    // Lost the status race to a concurrent settler — the ledger claim still
    // makes the money path idempotent; surface honestly.
    notes.push("row status was settled concurrently");
  }

  // ---- 6. Tell the customer — push + in-app ------------------------------
  const pretty = `₦${total.toLocaleString()}`;
  try {
    const walletRes = await query(`SELECT user_id, business_id FROM wallets WHERE id = $1`, [bill.wallet_id]);
    const w = walletRes.rows[0];
    if (w?.user_id) {
      await sendPushToUsers(
        [{ userId: w.user_id, businessId: w.business_id || bill.business_id }],
        {
          title: "Bill Payment Reversed",
          body: `Your ${bill.category} payment of ${pretty} could not be completed. ${pretty} is back in your wallet. Ref: ${ref}.`,
          data: {
            type: "transaction",
            eventType: "reversal",
            reference: ref,
            amount: String(total),
            currency: "NGN",
            reason: String(reason || "").slice(0, 200),
          },
        },
        { inApp: true, type: "refund", businessId: w.business_id || bill.business_id },
      ).catch((pushErr: any) => console.error(`[bill-settlement] reversal push failed for ${ref}:`, pushErr?.message));
    }
  } catch (e: any) {
    console.error(`[bill-settlement] reversal push setup failed for ${ref}:`, e?.message);
  }
  await notify(bill, "Bill payment refunded",
    `Your ${bill.category} payment of ${pretty} could not be completed and has been returned to your wallet. Ref: ${ref}.`);

  out.reversed = true;
  return out;
}

/**
 * Ask the provider what happened to a processing bill.
 *
 * EVIDENCE RULES (money-safe — a refund needs POSITIVE failure evidence):
 *   - A 404 only proves "dispatch never landed" when the lookup used Sogo's
 *     OWN reference (bill.provider_reference). Live Sogo assigns its own
 *     BILL… reference and does NOT index our MF-BILL… Idempotency-Key, so a
 *     404 against the fallback reference is AMBIGUOUS — the order may be
 *     sitting there under Sogo's own reference. That ambiguity refunds a
 *     DELIVERED bill (the 2026-10-30 incident) — it must never auto-refund.
 *   - 401/403 means the API key is broken: EVERY lookup would fail, so the
 *     answer says nothing about any individual bill. Never auto-refund.
 *   - Network/5xx/429 outages: wait for connectivity; no timed refund.
 */
type Verdict =
  | { kind: "completed"; providerResponse: any }
  | { kind: "failed"; reason: string; providerResponse: any }
  | { kind: "pending" }
  | {
      kind: "unknown";
      transient: boolean;
      providerResponse?: any;
      /** "no-record" = trusted lookup 404; "unverifiable" = ambiguous — never enough to move money */
      trust: "no-record" | "unverifiable";
      why: string;
    };

async function askProvider(bill: BillRow): Promise<Verdict> {
  const provider = bill.provider || (await getActiveProvider("bills"));

  if (provider === "simulator") {
    // Simulator is instant by design — a processing row is just a crash remnant.
    return { kind: "completed", providerResponse: { simulator: true, reconciled: true } };
  }

  if (provider === "flutterwave") {
    // FLW bills settle synchronously in the pay handler. A processing row is
    // a crash remnant — no async outcome will ever arrive.
    return { kind: "unknown", transient: false, trust: "unverifiable", why: "flutterwave settles synchronously — no async outcome expected" };
  }

  // Sogo: sandbox never persists or confirms anything — treat as unknown.
  if (sogo.isSogoSandbox()) return { kind: "unknown", transient: false, trust: "no-record", why: "sogo sandbox cannot confirm" };

  if (!sogo.isSogoConfigured()) {
    return { kind: "unknown", transient: false, trust: "unverifiable", why: "SOGO_SECRET_KEY is not configured — provider cannot be asked" };
  }

  // A trusted lookup key is Sogo's OWN reference, captured from the purchase
  // response or webhook backfill — distinct from our MF-BILL reference.
  const hasTrustedKey = !!bill.provider_reference && bill.provider_reference !== bill.reference;

  try {
    const remote = await sogo.getTransaction(bill.provider_reference || bill.reference);
    const tx = remote?.transaction ?? remote;
    const st = sogo.sogoStatus(tx || remote);
    if (["completed", "successful", "success", "delivered"].includes(st)) {
      return { kind: "completed", providerResponse: remote };
    }
    if (["failed", "failure", "refunded", "reversed", "cancelled", "canceled"].includes(st)) {
      return { kind: "failed", reason: `Provider reported: ${st}`, providerResponse: remote };
    }
    return { kind: "pending" }; // provider still working — be patient
  } catch (e: any) {
    const status = e?.response?.status;
    if (status === 404) {
      if (hasTrustedKey) {
        // Sogo has no transaction under ITS OWN reference — the dispatch
        // never reached it (crash before send) or it dropped the order.
        return { kind: "unknown", transient: false, trust: "no-record", why: "404 on Sogo's own reference" };
      }
      return {
        kind: "unknown", transient: false, trust: "unverifiable",
        why: "404 on the fallback MF-BILL reference — live Sogo does not index it, so this proves nothing",
      };
    }
    if (status === 401 || status === 403) {
      return { kind: "unknown", transient: false, trust: "unverifiable", why: `Sogo rejected the API key (HTTP ${status})` };
    }
    // Network/5xx/429 — an outage says nothing about this bill.
    return { kind: "unknown", transient: true, trust: "unverifiable", why: `provider unreachable (HTTP ${status || "network"})`, providerResponse: undefined };
  }
}

/**
 * Public provider-status probe (used by the pay flow's 3-attempt background
 * confirmation). Same verdict engine the reaper uses.
 */
export async function askProviderForBill(bill: BillRow): Promise<Verdict> {
  return askProvider(bill);
}

/**
 * One reconciliation pass over stale 'processing' bills (ALL users).
 * Called by the 5-minute cron and (per-user) by the history sweep.
 * Returns the number of rows settled.
 */
export async function reconcileProcessingBills(limit = 25): Promise<number> {
  const stale = await query(
    `SELECT * FROM bill_transactions
      WHERE status = 'processing'
        AND created_at < NOW() - ($2::text || ' minutes')::interval
      ORDER BY created_at ASC LIMIT $1`,
    [limit, String(MIN_AGE_MINUTES)],
  );
  let settled = 0;

  for (const bill of stale.rows as BillRow[]) {
    try {
      const age = ageMinutes(bill);
      const verdict = await askProvider(bill);

      if (verdict.kind === "completed") {
        settled += (await settleBillCompleted(bill, verdict.providerResponse)) ? 1 : 0;
        continue;
      }
      if (verdict.kind === "failed") {
        settled += (await refundBillRow(bill, verdict.reason, verdict.providerResponse)) ? 1 : 0;
        continue;
      }

      // pending / unknown — decide by provider class + age
      if (verdict.kind === "pending") {
        if (age >= PENDING_REFUND_HOURS * 60) {
          settled += (await refundBillRow(bill, "Provider did not confirm in time — refunded")) ? 1 : 0;
        }
        continue;
      }

      // unknown:
      const provider = bill.provider || "sogo";
      const sandbox = provider === "sogo" && sogo.isSogoSandbox();
      if (sandbox) {
        // Sandbox can NEVER confirm (all polls 404, no webhooks) — refund
        // once the crash-window (REFUND_AFTER_MINUTES) has passed. Sandbox
        // money is fake, so a timed refund is safe here.
        if (age >= REFUND_AFTER_MINUTES) {
          settled += (await refundBillRow(bill, "Provider (Sogo sandbox) never confirmed — auto-refunded")) ? 1 : 0;
        }
        continue;
      }
      if (provider === "flutterwave") {
        if (age >= REFUND_AFTER_MINUTES) {
          settled += (await refundBillRow(bill, "Provider never confirmed the payment — auto-refunded")) ? 1 : 0;
        }
        continue;
      }
      // Sogo LIVE — money moves ONLY on positive provider evidence:
      //   completed → settled above; failed → refunded above (provider said so);
      //   pending   → 24 h timeout above (provider still says it has not
      //               fulfilled — far beyond any bill delivery SLA);
      //   no-record → 404 on Sogo's OWN reference ⇒ dispatch never landed.
      // Everything else is AMBIGUOUS (fallback-reference 404, auth failure,
      // outage): the bill may have been delivered, so the row HOLDS in
      // 'processing' and the operator is alerted — never auto-refunded.
      if (verdict.trust === "unverifiable") {
        alertUnsettled(bill, verdict.why);
        continue;
      }
      if (verdict.transient) {
        alertUnsettled(bill, verdict.why);
        continue;
      }
      if (age >= REFUND_AFTER_MINUTES) {
        settled += (await refundBillRow(bill, "Provider has no record of this payment — auto-refunded")) ? 1 : 0;
      }
    } catch (e: any) {
      console.error(`[bill-settlement] reconcile failed for ${bill.reference}:`, e?.message);
    }
  }
  return settled;
}

/**
 * Refund-recovery pass: rows already marked failed/refunded/cancelled whose
 * wallet credit never landed (the refund credit crashed after the status
 * claim). Credited iff a debit exists and the -REFUND row does not.
 */
export async function recoverMissedRefunds(limit = 25): Promise<number> {
  const candidates = await query(
    `SELECT * FROM bill_transactions
      WHERE status IN ('failed','refunded','cancelled')
        AND created_at < NOW() - INTERVAL '30 minutes'
      ORDER BY created_at ASC LIMIT 100`,
  );
  let recovered = 0;

  for (const bill of candidates.rows as BillRow[]) {
    if (recovered >= limit) break;
    try {
      if (!bill.wallet_id) continue;
      if (!(await hasDebitLedger(bill.reference))) continue;
      if (await hasRefundLedger(bill.reference)) continue;
      const total = Number(bill.total);
      if (!(total > 0)) continue;
      await creditWallet(bill.wallet_id, total);
      await insertTransaction({
        userId: bill.user_id, businessId: bill.business_id, walletId: bill.wallet_id,
        reference: `${bill.reference}-REFUND`, type: "credit", transactionType: "bill_refund",
        amount: total, currency: "NGN",
        description: `Refund — bill payment did not complete (${bill.category})`,
      });
      await query(
        `UPDATE bill_transactions SET failure_reason = COALESCE(failure_reason,'') || ' (refund auto-recovered)', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [bill.id],
      );
      // Display consistency: the original debit must not stay green.
      await query(
        `UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE reference = $1 AND type = 'debit' AND status <> 'failed'`,
        [bill.reference],
      );
      await notify(
        bill,
        "Bill payment refunded",
        `Your ${bill.category} payment of ₦${total.toLocaleString()} was refunded to your wallet. Ref: ${bill.reference}.`,
      );
      recovered += 1;
      console.log(`[bill-settlement] recovered missing refund for ${bill.reference}`);
    } catch (e: any) {
      console.error(`[bill-settlement] refund recovery failed for ${bill.reference}:`, e?.message);
    }
  }
  return recovered;
}

/**
 * Per-user lazy sweep (history reads): reconcile this user's stale rows so
 * the history page NEVER shows a pending bill older than the refund window.
 */
export async function sweepUserBills(userId: string): Promise<void> {
  try {
    const stale = await query(
      `SELECT * FROM bill_transactions
        WHERE user_id = $1 AND status = 'processing'
          AND created_at < NOW() - ($2::text || ' minutes')::interval
        ORDER BY created_at ASC LIMIT 25`,
      [userId, String(MIN_AGE_MINUTES)],
    );
    for (const bill of stale.rows as BillRow[]) {
      const age = ageMinutes(bill);
      const verdict = await askProvider(bill);
      if (verdict.kind === "completed") { await settleBillCompleted(bill, verdict.providerResponse); continue; }
      if (verdict.kind === "failed") { await refundBillRow(bill, verdict.reason, verdict.providerResponse); continue; }
      if (verdict.kind === "pending" && age >= PENDING_REFUND_HOURS * 60) {
        await refundBillRow(bill, "Provider did not confirm in time — refunded");
        continue;
      }
      if (verdict.kind === "unknown") {
        const sandbox = (bill.provider || "sogo") === "sogo" && sogo.isSogoSandbox();
        if (sandbox || bill.provider === "flutterwave") {
          if (age >= REFUND_AFTER_MINUTES) {
            await refundBillRow(
              bill,
              sandbox ? "Provider (Sogo sandbox) never confirmed — auto-refunded"
                : "Provider never confirmed the payment — auto-refunded",
            );
          }
          continue;
        }
        // Sogo live: ambiguous evidence (fallback-reference 404, auth
        // failure, outage) never auto-refunds — see askProvider's evidence
        // rules. Only a trusted-key 404 refunds after the grace window.
        if (verdict.trust === "unverifiable" || verdict.transient) {
          alertUnsettled(bill, verdict.why);
          continue;
        }
        if (age >= REFUND_AFTER_MINUTES) {
          await refundBillRow(bill, "Provider has no record of this payment — auto-refunded");
        }
      }
    }
    // Also recover any refund credit that failed earlier for this user.
    const broken = await query(
      `SELECT b.* FROM bill_transactions b
        WHERE b.user_id = $1 AND b.status IN ('failed','refunded','cancelled')
          AND b.created_at < NOW() - INTERVAL '30 minutes'
        ORDER BY b.created_at ASC LIMIT 25`,
      [userId],
    );
    for (const bill of broken.rows as BillRow[]) {
      if (!bill.wallet_id) continue;
      if (!(await hasDebitLedger(bill.reference))) continue;
      if (await hasRefundLedger(bill.reference)) continue;
      const total = Number(bill.total);
      if (!(total > 0)) continue;
      await creditWallet(bill.wallet_id, total);
      await insertTransaction({
        userId: bill.user_id, businessId: bill.business_id, walletId: bill.wallet_id,
        reference: `${bill.reference}-REFUND`, type: "credit", transactionType: "bill_refund",
        amount: total, currency: "NGN",
        description: `Refund — bill payment did not complete (${bill.category})`,
      });
      await notify(bill, "Bill payment refunded", `Your ${bill.category} payment of ₦${total.toLocaleString()} was refunded to your wallet. Ref: ${bill.reference}.`);
      // Display consistency: the original debit must not stay green.
      await query(
        `UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE reference = $1 AND type = 'debit' AND status <> 'failed'`,
        [bill.reference],
      );
      console.log(`[bill-settlement] recovered missing refund for ${bill.reference}`);
    }
  } catch (e: any) {
    console.error("[bill-settlement] per-user sweep failed:", e?.message);
  }
}
