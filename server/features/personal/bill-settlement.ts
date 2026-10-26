import { query } from "../../db";
import { creditWallet, insertTransaction } from "./personal-utils";
import { createNotification } from "../../services/notifications";
import * as sogo from "../../services/sogo";
import { getActiveProvider } from "./provider-routing";

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
  created_at: Date | string;
};

const MIN_AGE_MINUTES = Number(process.env.BILL_RECONCILE_MIN_AGE_MINUTES || 10);
const REFUND_AFTER_MINUTES = Number(process.env.BILL_REFUND_AFTER_MINUTES || 30);
const PENDING_REFUND_HOURS = Number(process.env.BILL_PENDING_REFUND_HOURS || 24);
const UNREACHABLE_REFUND_HOURS = Number(process.env.BILL_UNREACHABLE_REFUND_HOURS || 6);

function ageMinutes(bill: BillRow): number {
  return (Date.now() - new Date(bill.created_at as any).getTime()) / 60_000;
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
 * reaper). Credits admin-promo cashback when configured, idempotently.
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

  const amount = Number(bill.amount);
  const details = bill.details || {};

  // Late cashback (admin promo) — only for rows that never got it.
  const cbPercent = Number(details?.cashback_percent || 0);
  if (cbPercent > 0 && bill.wallet_id && !(await hasCashbackLedger(bill.reference))) {
    const cashback = Math.round(((amount * cbPercent) / 100) * 100) / 100;
    if (cashback > 0) {
      try {
        await creditWallet(bill.wallet_id, cashback);
        await insertTransaction({
          userId: bill.user_id, businessId: bill.business_id, walletId: bill.wallet_id,
          reference: `${bill.reference}-CB`, type: "credit", transactionType: "bill_cashback",
          amount: cashback, currency: "NGN",
          description: `Cashback — ${bill.category} bill payment (${cbPercent}%)`,
        });
      } catch (e: any) {
        console.error(`[bill-settlement] cashback credit failed for ${bill.reference}:`, e?.message);
      }
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
 * Refund a processing bill (provider failed / never received / timed out).
 * Idempotent on the ledger: only credits when the debit exists and the
 * refund row does not.
 */
export async function refundBillRow(bill: BillRow, reason: string, providerResponse?: any): Promise<boolean> {
  // Claim the transition first so webhook + reaper + syncs never double-refund.
  const claim = await query(
    `UPDATE bill_transactions
       SET status = 'refunded', failure_reason = $2,
           provider_response = COALESCE($3::jsonb, provider_response),
           settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'processing' RETURNING id`,
    [bill.id, String(reason).slice(0, 500), providerResponse ? JSON.stringify(providerResponse) : null],
  );
  if (claim.rowCount === 0) return false;

  const total = Number(bill.total);
  if (bill.wallet_id && (await hasDebitLedger(bill.reference)) && !(await hasRefundLedger(bill.reference))) {
    try {
      await creditWallet(bill.wallet_id, total);
      await insertTransaction({
        userId: bill.user_id, businessId: bill.business_id, walletId: bill.wallet_id,
        reference: `${bill.reference}-REFUND`, type: "credit", transactionType: "bill_refund",
        amount: total, currency: "NGN",
        description: `Refund — bill payment did not complete (${bill.category})`,
      });
    } catch (e: any) {
      // The row is already claimed 'refunded' — recoverMissedRefunds() will
      // retry the credit until the -REFUND ledger row exists.
      console.error(`[bill-settlement] refund credit failed for ${bill.reference} (will auto-retry):`, e?.message);
    }
  }

  await notify(
    bill,
    "Bill payment refunded",
    `Your ${bill.category} payment of ₦${total.toLocaleString()} could not be completed and has been returned to your wallet. Ref: ${bill.reference}.`,
  );
  return true;
}

/** Ask the provider what happened to a processing bill. */
type Verdict =
  | { kind: "completed"; providerResponse: any }
  | { kind: "failed"; reason: string; providerResponse: any }
  | { kind: "pending" }
  | { kind: "unknown"; transient: boolean; providerResponse?: any };

async function askProvider(bill: BillRow): Promise<Verdict> {
  const provider = bill.provider || (await getActiveProvider("bills"));

  if (provider === "simulator") {
    // Simulator is instant by design — a processing row is just a crash remnant.
    return { kind: "completed", providerResponse: { simulator: true, reconciled: true } };
  }

  if (provider === "flutterwave") {
    // FLW bills settle synchronously in the pay handler. A processing row is
    // a crash remnant — no async outcome will ever arrive.
    return { kind: "unknown", transient: false };
  }

  // Sogo: sandbox never persists or confirms anything — treat as unknown.
  if (sogo.isSogoSandbox()) return { kind: "unknown", transient: false };

  try {
    const remote = await sogo.getTransaction(bill.reference);
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
      // Provider has no record — the dispatch never reached it (crash before
      // send) or it dropped the order. Either way it will never fulfil.
      return { kind: "unknown", transient: false };
    }
    // Network/5xx/429 — do not refund on a transient blip.
    return { kind: "unknown", transient: true, providerResponse: undefined };
  }
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
        // once the crash-window (REFUND_AFTER_MINUTES) has passed.
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
      // sogo live: 404 ⇒ dispatch never landed → refund after the grace
      // window; transient errors ⇒ wait, refund only after hours of silence.
      if (verdict.transient) {
        if (age >= UNREACHABLE_REFUND_HOURS * 60) {
          settled += (await refundBillRow(bill, "Provider unreachable — auto-refunded")) ? 1 : 0;
        }
      } else if (age >= REFUND_AFTER_MINUTES) {
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
        const grace = sandbox || bill.provider === "flutterwave" ? REFUND_AFTER_MINUTES
          : verdict.transient ? UNREACHABLE_REFUND_HOURS * 60 : REFUND_AFTER_MINUTES;
        if (age >= grace) {
          await refundBillRow(
            bill,
            sandbox ? "Provider (Sogo sandbox) never confirmed — auto-refunded"
              : verdict.transient ? "Provider unreachable — auto-refunded"
              : "Provider has no record of this payment — auto-refunded",
          );
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
      console.log(`[bill-settlement] recovered missing refund for ${bill.reference}`);
    }
  } catch (e: any) {
    console.error("[bill-settlement] per-user sweep failed:", e?.message);
  }
}
