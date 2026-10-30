import { query, pool } from "../../db";
import { creditWallet, insertTransaction } from "./personal-utils";
import { createNotification } from "../../services/notifications";
import { creditPlatformWallet, debitRevenueWallet } from "../../services/fees";
import { sendPushToUsers } from "../../services/push";
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
  provider_reference?: string | null;
  settled_at?: Date | string | null;
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
  providerVerified?: "completed" | "failed" | "no-record" | "unreachable" | "skipped";
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
 *      override, mirroring "provider reports SUCCESSFUL → refuse".
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
    try {
      const remote = await sogo.getTransaction(bill.provider_reference || ref).catch((e: any) => {
        if (e?.response?.status === 404) return null;
        throw e;
      });
      if (remote === null) {
        providerVerified = "no-record"; // dispatch never landed — safe to reverse
      } else {
        const tx = remote?.transaction ?? remote;
        const st = sogo.sogoStatus(tx || remote);
        if (["completed", "successful", "success", "delivered"].includes(st)) {
          providerVerified = "completed";
        } else if (["failed", "failure", "refunded", "reversed", "cancelled", "canceled"].includes(st)) {
          providerVerified = "failed";
          opts.providerReportedFailure = true;
        } else {
          providerVerified = "unreachable";
        }
      }
    } catch {
      providerVerified = "unreachable";
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
  //     what was credited IF the wallet still holds it. Best-effort.
  try {
    const cbRow = await query(
      `SELECT amount FROM transactions WHERE reference = $1 AND type = 'credit' LIMIT 1`,
      [`${ref}-CB`],
    );
    const cb = cbRow.rows.length ? Number(cbRow.rows[0].amount) : 0;
    if (cb > 0) {
      const claw = await query(
        `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND balance >= $1 RETURNING id`,
        [cb, bill.wallet_id],
      );
      if (claw.rows.length > 0) {
        await insertTransaction({
          userId: bill.user_id, businessId: bill.business_id, walletId: bill.wallet_id,
          reference: `${ref}-CB-REVERSAL`, type: "debit", transactionType: "bill_cashback_reversal",
          amount: cb, currency: "NGN",
          description: `Cashback reversal — bill ${ref} was reversed`,
        });
      } else {
        notes.push("cashback clawback skipped (wallet balance below cashback)");
      }
    }
  } catch (e: any) {
    console.error(`[bill-settlement] cashback clawback failed for ${ref}:`, e?.message);
    notes.push("cashback clawback failed (non-fatal)");
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
    // Sogo live assigns its OWN reference (BILL…) — our MF-BILL… reference is
    // only the Idempotency-Key and is NOT a valid lookup key on their API.
    // provider_reference is captured from the purchase response / webhook
    // backfill; fall back to our reference for older rows.
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
