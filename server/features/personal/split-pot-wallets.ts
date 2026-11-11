import { query } from "../../db";
import { processAllPending, verifySingleTransfer } from "../../services/transfer";
import { getActiveTransferProviderName } from "../../services/providers/factory";
import { generateTransactionHash } from "../../services/audit";
import { calculateFee } from "../../services/fees";
import { transferQueue } from "../../lib/queues";
import { sendPushToUsers } from "../../services/push";
import { createNotification } from "../../services/notifications";
import { getSocketServer } from "../../lib/socket";
import { genRef } from "./personal-utils";

/**
 * SPLIT/POT WALLETS + MULTI-APPROVAL WITHDRAWALS — shared core.
 *
 * Every bill split and group pot owns its OWN NGN wallet. The balance lives
 * in the shared `wallets` table as a row with user_id = NULL / business_id =
 * NULL: NULLs never conflict with the per-user unique keys, no personal or
 * business wallet lookup (`WHERE user_id = ...`) can ever grab one, and —
 * decisively — the PROVEN single-transfer pipeline (services/transfer.ts
 * processAllPending) debits `wallets` by id, so a withdrawal from a split/pot
 * wallet rides the EXACT rails the single transfer page uses (same fee, same
 * platform float hold, same provider dispatch, same auto-reversal on failure,
 * same monitor/webhook finalisation). split_pot_wallets maps owner → wallet
 * row; split_pot_wallet_ledger is the feature-level money trail.
 *
 * Withdrawal flow:
 *   creator requests  → approvers set?  → withdrawal_request (pending) + notify
 *                                        each approver; ALL approved → execute
 *                     → none set       → execute immediately
 *   execution         → executeSplitWalletTransfer (clone of the single
 *                        transfer path with the split/pot wallet as source)
 */

export type SplitPotOwnerType = "split" | "pot";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_APPROVERS = 20;
const ACTIVE_REQUEST_STATUSES = ["pending", "approved", "executing"];

function num(v: any): number { return Number(v) || 0; }
function money(v: number): number { return Math.round(v * 100) / 100; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function asObject(v: any): any {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch { return null; }
}

// ---------------------------------------------------------------------------
// WALLETS
// ---------------------------------------------------------------------------

export interface SplitPotWallet {
  walletId: string;
  balance: number;
}

export async function getSplitPotWallet(ownerType: SplitPotOwnerType, ownerId: string): Promise<SplitPotWallet | null> {
  const r = await query(
    `SELECT m.wallet_id, COALESCE(w.balance, 0) AS balance
       FROM split_pot_wallets m LEFT JOIN wallets w ON w.id = m.wallet_id
      WHERE m.owner_type = $1 AND m.owner_id = $2
      LIMIT 1`,
    [ownerType, ownerId],
  );
  if (!r.rows.length) return null;
  return { walletId: String(r.rows[0].wallet_id), balance: money(num(r.rows[0].balance)) };
}

/**
 * Get-or-create the NGN wallet that backs a split/pot. Idempotent — every
 * caller (create, pay, contribute, detail, withdrawals) can call this freely;
 * pre-existing splits/pots get their wallet lazily on first touch.
 */
export async function ensureSplitPotWallet(ownerType: SplitPotOwnerType, ownerId: string): Promise<SplitPotWallet> {
  const existing = await getSplitPotWallet(ownerType, ownerId);
  if (existing) return existing;

  // wallets row (user_id/business_id NULL = split/pot-owned) + mapping row in
  // one statement. A concurrent creator loses the mapping ON CONFLICT and the
  // freshly created zero-balance wallets row is simply orphaned (harmless).
  await query(
    `WITH w AS (
       INSERT INTO wallets (user_id, business_id, balance, currency, status)
       VALUES (NULL::uuid, NULL::uuid, 0, 'NGN', 'active')
       RETURNING id
     )
     INSERT INTO split_pot_wallets (owner_type, owner_id, wallet_id, currency)
     SELECT $1, $2, w.id, 'NGN' FROM w
     ON CONFLICT (owner_type, owner_id) DO NOTHING`,
    [ownerType, ownerId],
  );

  const created = await getSplitPotWallet(ownerType, ownerId);
  if (!created) throw new Error(`Could not create the ${ownerType} wallet`);
  return created;
}

/**
 * Idempotent credit onto a split/pot wallet + feature ledger row. The ledger
 * INSERT (UNIQUE reference) is the claim: only the writer that wins it moves
 * money, so webhook/double-delivery can never double-credit. Throws on DB
 * failure so callers can roll their own money block back.
 */
export async function creditSplitPotWallet(opts: {
  walletId: string;
  ownerType: SplitPotOwnerType;
  ownerId: string;
  amount: number;
  reason: string; // contribution | withdrawal_refund | pot_close_topup | ...
  reference: string;
  metadata?: Record<string, unknown>;
}): Promise<{ applied: boolean; balanceAfter: number }> {
  const amount = money(num(opts.amount));
  if (!(amount > 0)) throw new Error("creditSplitPotWallet: amount must be positive");

  const claim = await query(
    `INSERT INTO split_pot_wallet_ledger
       (wallet_id, owner_type, owner_id, direction, amount, currency, reason, reference, metadata)
     VALUES ($1,$2,$3,'credit',$4,'NGN',$5,$6,$7::jsonb)
     ON CONFLICT (reference) DO NOTHING
     RETURNING id`,
    [opts.walletId, opts.ownerType, opts.ownerId, amount, opts.reason, opts.reference, JSON.stringify(opts.metadata || {})],
  );
  if (!claim.rows.length) {
    const cur = await query(`SELECT balance FROM wallets WHERE id = $1`, [opts.walletId]);
    return { applied: false, balanceAfter: money(num(cur.rows[0]?.balance)) };
  }

  const upd = await query(
    `UPDATE wallets SET balance = balance + $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING balance`,
    [opts.walletId, amount],
  );
  if (!upd.rows.length) throw new Error("creditSplitPotWallet: wallet row disappeared");
  const balanceAfter = money(num(upd.rows[0].balance));
  await query(
    `UPDATE split_pot_wallet_ledger SET balance_after = $2 WHERE reference = $1`,
    [opts.reference, balanceAfter],
  ).catch(() => {});
  return { applied: true, balanceAfter };
}

/** Guarded debit (balance-checked) + ledger row. Returns false when funds are short. */
export async function debitSplitPotWallet(opts: {
  walletId: string;
  ownerType: SplitPotOwnerType;
  ownerId: string;
  amount: number;
  reason: string;
  reference: string;
  metadata?: Record<string, unknown>;
}): Promise<{ ok: boolean; balanceAfter?: number }> {
  const amount = money(num(opts.amount));
  if (!(amount > 0)) return { ok: false };

  // Balance-guarded atomic debit is the gate; the ledger claim (unique ref)
  // then keeps the bookkeeping one-row-per-movement.
  const debit = await query(
    `UPDATE wallets SET balance = balance - $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND balance >= $2 AND status = 'active' RETURNING balance`,
    [opts.walletId, amount],
  );
  if (!debit.rows.length) return { ok: false };
  const balanceAfter = money(num(debit.rows[0].balance));

  const claim = await query(
    `INSERT INTO split_pot_wallet_ledger
       (wallet_id, owner_type, owner_id, direction, amount, currency, reason, reference, balance_after, metadata)
     VALUES ($1,$2,$3,'debit',$4,'NGN',$5,$6,$7,$8::jsonb)
     ON CONFLICT (reference) DO NOTHING
     RETURNING id`,
    [opts.walletId, opts.ownerType, opts.ownerId, amount, opts.reason, opts.reference, balanceAfter, JSON.stringify(opts.metadata || {})],
  ).catch(() => ({ rows: [] as any[] }));

  return { ok: true, balanceAfter };
}

/** Last N ledger entries for a split/pot wallet (detail view). */
export async function loadWalletLedger(walletId: string, limit = 50): Promise<any[]> {
  const r = await query(
    `SELECT id, direction, amount, currency, reason, reference, balance_after, metadata, created_at
       FROM split_pot_wallet_ledger WHERE wallet_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [walletId, Math.min(200, Math.max(1, limit))],
  );
  return r.rows.map((row: any) => ({
    id: row.id,
    direction: row.direction,
    amount: money(num(row.amount)),
    currency: row.currency || "NGN",
    reason: row.reason,
    reference: row.reference,
    balance_after: row.balance_after === null ? null : money(num(row.balance_after)),
    metadata: asObject(row.metadata) || {},
    created_at: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// DESTINATION — exactly the fields the single-transfer path needs
// ---------------------------------------------------------------------------

/** Read + validate the bank destination off a request body (camel/snake case). */
export function readWithdrawalDestination(reqBody: any): {
  ok: boolean;
  value?: {
    bank_code: string; bank_name: string | null; account_number: string;
    account_name: string | null; recipient_code: string | null; note: string | null;
  };
  error?: string;
} {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = reqBody?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  };
  const value = {
    bank_code: pick("bankCode", "bank_code"),
    bank_name: pick("bankName", "bank_name"),
    account_number: pick("accountNumber", "account_number"),
    account_name: pick("accountName", "account_name"),
    recipient_code: pick("recipientCode", "recipient_code"),
    note: pick("note"),
  };
  if (!value.bank_code) return { ok: false, error: "bankCode is required for the withdrawal destination" };
  if (!value.account_number) return { ok: false, error: "accountNumber is required for the withdrawal destination" };
  if (!/^\d{6,20}$/.test(value.account_number)) return { ok: false, error: "accountNumber must be 6–20 digits" };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// APPROVERS CONFIG (create + edit)
// ---------------------------------------------------------------------------

/**
 * Normalize + validate `withdrawalApprovers`: a list of DISTINCT existing user
 * ids (creator optional, stored as given). Empty list = no approvers =
 * withdrawals execute immediately.
 */
export async function normalizeWithdrawalApprovers(raw: unknown): Promise<{ ok: boolean; approvers?: string[]; error?: string }> {
  if (raw === undefined || raw === null) return { ok: true, approvers: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "withdrawalApprovers must be an array of user ids" };
  if (raw.length > MAX_APPROVERS) return { ok: false, error: `A withdrawal can have at most ${MAX_APPROVERS} approvers` };

  const approvers: string[] = [];
  for (const v of raw) {
    const id = String(v || "").trim();
    if (!UUID_RE.test(id)) return { ok: false, error: "Each withdrawal approver must be a valid user id" };
    if (!approvers.includes(id)) approvers.push(id);
  }
  if (!approvers.length) return { ok: true, approvers: [] };

  const found = await query(`SELECT id FROM users WHERE id = ANY($1::uuid[])`, [approvers]);
  if (found.rows.length !== approvers.length) {
    return { ok: false, error: "One or more withdrawal approvers were not found" };
  }
  return { ok: true, approvers };
}

/** Parse the jsonb approver array off a splits/pots row. */
export function approversOf(row: any): string[] {
  const v = asObject(row?.withdrawal_approvers ?? row?.withdrawalApprovers);
  return Array.isArray(v) ? v.map((x: any) => String(x)).filter(Boolean) : [];
}

/**
 * Enrich approver ids with profile info (names/avatars) for the detail views.
 * Order follows the stored config order; missing users degrade to nulls.
 */
export async function loadApproverProfiles(ids: string[]): Promise<Array<{
  id: string; name: string | null; avatarUrl: string | null; username: string | null;
}>> {
  if (!ids.length) return [];
  const r = await query(
    `SELECT id, name, avatar_url,
            LOWER(COALESCE(username, SPLIT_PART(email, '@', 1))) AS username
       FROM users WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map<string, any>(r.rows.map((u: any) => [String(u.id), u]));
  return ids.map((id) => {
    const u = byId.get(String(id));
    return {
      id,
      name: u?.name || null,
      avatarUrl: u?.avatar_url || null,
      username: u?.username || null,
    };
  });
}

// ---------------------------------------------------------------------------
// WITHDRAWAL REQUESTS
// ---------------------------------------------------------------------------

export function serializeWithdrawalRequest(row: any): any {
  if (!row) return row;
  const approvals = Array.isArray(row.approvals) ? row.approvals : (asObject(row.approvals) || []);
  const approvers = Array.isArray(row.approvers) ? row.approvers : (asObject(row.approvers) || []);
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    walletId: row.wallet_id,
    requestedBy: row.requested_by,
    amount: money(num(row.amount)),
    currency: row.currency || "NGN",
    note: row.note || null,
    bankCode: row.bank_code || null,
    bankName: row.bank_name || null,
    accountNumber: row.account_number || null,
    accountName: row.account_name || null,
    recipientCode: row.recipient_code || null,
    status: row.status,
    approvals,
    approvers,
    approvedCount: approvals.filter((a: any) => a?.decision === "approved").length,
    declinedCount: approvals.filter((a: any) => a?.decision === "declined").length,
    approvalsRequired: approvers.length,
    failureReason: row.failure_reason || null,
    transferReference: row.transfer_reference || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadWithdrawalRequest(id: string): Promise<any | null> {
  if (!UUID_RE.test(String(id))) return null;
  const r = await query(`SELECT * FROM withdrawal_requests WHERE id = $1 LIMIT 1`, [String(id)]);
  return r.rows[0] || null;
}

/** The open (pending/approved/executing) request for a split/pot, if any. */
export async function openWithdrawalRequest(ownerType: SplitPotOwnerType, ownerId: string): Promise<any | null> {
  const r = await query(
    `SELECT * FROM withdrawal_requests
      WHERE owner_type = $1 AND owner_id = $2 AND status = ANY($3::varchar[])
      ORDER BY created_at DESC LIMIT 1`,
    [ownerType, ownerId, ACTIVE_REQUEST_STATUSES],
  );
  return r.rows[0] || null;
}

export async function loadWithdrawalHistory(ownerType: SplitPotOwnerType, ownerId: string, limit = 50): Promise<any[]> {
  const r = await query(
    `SELECT * FROM withdrawal_requests WHERE owner_type = $1 AND owner_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [ownerType, ownerId, Math.min(200, Math.max(1, limit))],
  );
  return r.rows.map(serializeWithdrawalRequest);
}

/** "Due for withdrawal" CTA hint: due date passed + wallet funded + nothing in flight. */
export function computeDueForWithdrawal(dueAt: Date | string | null | undefined, walletBalance: number, hasOpenRequest: boolean): boolean {
  if (!dueAt || hasOpenRequest) return false;
  const due = new Date(dueAt);
  if (isNaN(due.getTime())) return false;
  return due.getTime() <= Date.now() && walletBalance > 0;
}

export async function resolveOwnerName(ownerType: SplitPotOwnerType, ownerId: string): Promise<string> {
  try {
    const r = await query(
      ownerType === "split"
        ? `SELECT title FROM splits WHERE id = $1`
        : `SELECT title FROM pots WHERE id = $1`,
      [ownerId],
    );
    return r.rows[0]?.title || (ownerType === "split" ? "Split" : "Pot");
  } catch {
    return ownerType === "split" ? "Split" : "Pot";
  }
}

// ---------------------------------------------------------------------------
// NOTIFICATIONS — push (FCM) + in-app row + socket room emit
// ---------------------------------------------------------------------------

function naira(v: number): string { return `₦${money(num(v)).toLocaleString()}`; }

async function deliverToUser(
  userId: string,
  payload: { title: string; body: string; data: Record<string, any> },
  socketEvent: string,
): Promise<void> {
  // In-app row (businessId stays NULL for personal features — sendPushToUsers
  // only mirrors in-app rows for business pushes, so we write it here).
  createNotification({
    businessId: null,
    userId,
    type: String(payload.data.type || "withdrawal"),
    title: payload.title,
    message: payload.body,
    actionUrl: payload.data.splitType === "pot" ? "/splits?tab=pots" : "/splits",
    actionType: payload.data.splitType === "pot" ? "view_pot" : "view_split",
    metadata: payload.data,
  }).catch(() => {});
  // FCM push (no in-app mirror — the row above already landed).
  sendPushToUsers([{ userId }], { title: payload.title, body: payload.body, data: payload.data }, { inApp: false }).catch(() => {});
  // Socket room emit — live UI updates for anyone with the app open.
  try {
    getSocketServer()?.to(`user:${userId}`).emit(socketEvent, payload.data);
  } catch { /* socket server not up in this process — push still went out */ }
}

export async function notifyWithdrawalApprovers(request: any, ctx: { ownerName: string; requesterName: string }): Promise<void> {
  const approvers = Array.isArray(request.approvers) ? request.approvers : (asObject(request.approvers) || []);
  const data = {
    type: "withdrawal_request",
    splitType: request.owner_type,
    splitId: request.owner_id,
    splitName: ctx.ownerName,
    requestId: request.id,
    amount: money(num(request.amount)),
    requesterName: ctx.requesterName,
  };
  for (const approverId of approvers) {
    await deliverToUser(
      String(approverId),
      {
        title: "Withdrawal approval requested",
        body: `${ctx.requesterName} requests ${naira(request.amount)} from "${ctx.ownerName}" — your approval is needed.`,
        data,
      },
      "withdrawal:request",
    );
  }
}

export async function notifyRequesterWithdrawalOutcome(
  request: any,
  kind: "completed" | "failed" | "declined" | "processing",
  ctx: { ownerName: string; reason?: string | null; declinerName?: string | null; refunded?: boolean },
): Promise<void> {
  const base = {
    requestId: request.id,
    splitType: request.owner_type,
    splitId: request.owner_id,
    splitName: ctx.ownerName,
    amount: money(num(request.amount)),
    transferReference: request.transfer_reference || null,
  };
  if (kind === "completed") {
    await deliverToUser(
      request.requested_by,
      {
        title: "Withdrawal completed",
        body: `${naira(request.amount)} from "${ctx.ownerName}" was sent to ${request.account_name || "the bank account"}.`,
        data: { type: "withdrawal_completed", ...base },
      },
      "withdrawal:completed",
    );
  } else if (kind === "failed") {
    // ctx.refunded === false → the failure happened BEFORE any money left the
    // wallet (e.g. insufficient funds, queueing failed) — don't claim a refund
    // that never happened.
    const tail = ctx.refunded === false
      ? "Nothing left the wallet."
      : `The money is back in the ${request.owner_type} wallet.`;
    await deliverToUser(
      request.requested_by,
      {
        title: "Withdrawal failed",
        body: `${naira(request.amount)} from "${ctx.ownerName}" could not be sent${ctx.reason ? `: ${String(ctx.reason).slice(0, 120)}` : ""}. ${tail}`,
        data: { type: "withdrawal_failed", ...base, failureReason: ctx.reason || null },
      },
      "withdrawal:failed",
    );
  } else if (kind === "declined") {
    await deliverToUser(
      request.requested_by,
      {
        title: "Withdrawal declined",
        body: `${ctx.declinerName || "An approver"} declined the ${naira(request.amount)} withdrawal from "${ctx.ownerName}"${ctx.reason ? `: ${String(ctx.reason).slice(0, 120)}` : ""}.`,
        data: { type: "withdrawal_declined", ...base, reason: ctx.reason || null, declinerName: ctx.declinerName || null },
      },
      "withdrawal:declined",
    );
  } else {
    await deliverToUser(
      request.requested_by,
      {
        title: "Withdrawal processing",
        body: `${naira(request.amount)} from "${ctx.ownerName}" is on its way — we'll confirm shortly.`,
        data: { type: "withdrawal_processing", ...base },
      },
      "withdrawal:processing",
    );
  }
}

// ---------------------------------------------------------------------------
// EXECUTION — CLONE OF THE PROVEN SINGLE-TRANSFER PATH
// (server/routes/transfers.ts POST /single → transfer_queue row + services/
//  transfer.ts processAllPending: wallet debit + platform hold + provider
//  dispatch + auto-reversal; then the same bounded verifySingleTransfer poll.
//  The only difference: wallet_id = the split/pot wallet, source_type marks it.)
// ---------------------------------------------------------------------------

/**
 * Drive an APPROVED withdrawal request through the single-transfer pipeline.
 * Guards: the request must be in 'approved' status — the claim UPDATE is the
 * double-execution gate (a second caller gets nothing), and the pipeline's own
 * pending→processing row claim guards the transfer itself.
 */
export async function executeSplitWalletTransfer(
  request: any,
  actorId: string,
  ctx: { ownerName: string },
): Promise<{ request: any; payout: any | null }> {
  const amount = money(num(request.amount));
  const reference = genRef("SWD");

  // 1. Status-guard claim: only one pass may take an approved request to
  //    executing (concurrent final approvals / retried calls lose here).
  const claim = await query(
    `UPDATE withdrawal_requests
        SET status = 'executing', transfer_reference = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'approved'
      RETURNING *`,
    [request.id, reference],
  );
  if (!claim.rows.length) {
    throw Object.assign(new Error("This withdrawal request is not awaiting execution"), { code: "NOT_EXECUTABLE", statusCode: 409 });
  }
  const claimed = claim.rows[0];

  // 2. Fee — the SAME matrix the single transfer page charges (the wallet is
  //    debited amount + fee by the pipeline). Check the wallet can cover BOTH
  //    up-front so a fee-short wallet fails cleanly instead of failing inside
  //    the pipeline.
  let fee = 0;
  try { fee = await calculateFee(amount, "transfer"); } catch { fee = 0; }
  const balRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [claimed.wallet_id]);
  const walletBalance = money(num(balRes.rows[0]?.balance));
  if (walletBalance < money(amount + fee)) {
    const reason = `Insufficient funds in the ${claimed.owner_type} wallet — it holds ₦${walletBalance.toLocaleString()} but ₦${money(amount + fee).toLocaleString()} (amount + transfer fee) is needed`;
    const failed = await query(
      `UPDATE withdrawal_requests
          SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'executing'
        RETURNING *`,
      [claimed.id, reason],
    );
    const failedRequest = failed.rows[0] || claimed;
    // Nothing was debited — tell the requester the withdrawal died pre-flight.
    await notifyRequesterWithdrawalOutcome(failedRequest, "failed", { ownerName: ctx.ownerName, reason, refunded: false });
    return { request: failedRequest, payout: null };
  }

  // 3. Queue the payout on the SAME rails as the single transfer page.
  let payout: any = null;
  let queueError: any = null;
  try {
    const provider = await getActiveTransferProviderName().catch(() => process.env.DEFAULT_PAYMENT_PROVIDER || "flutterwave");
    const transactionHash = generateTransactionHash(reference, String(amount), String(request.account_number || ""), String(request.bank_code || ""));
    await query(
      `INSERT INTO transfer_queue
         (business_id, reference, recipient_account, recipient_bank, recipient_name,
          amount, currency, remark, source_type, source_id, status, wallet_id,
          payment_provider, fee, transaction_hash, initiated_by, recipient_country)
       VALUES
         (NULL, $1, $2, $3, $4,
          $5, 'NGN', $6, 'split_pot_withdrawal', $7, 'pending', $8,
          $9, $10, $11, $12, 'NG')`,
      [
        reference,
        String(request.account_number || ""),
        String(request.bank_code || ""),
        request.account_name || null,
        amount,
        `Withdrawal from ${request.owner_type} "${String(ctx.ownerName).slice(0, 60)}"`,
        String(request.id),
        claimed.wallet_id,
        provider,
        fee,
        transactionHash,
        actorId,
      ],
    );
    await query(
      `UPDATE withdrawal_requests SET transfer_queue_id = (SELECT id FROM transfer_queue WHERE reference = $2), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [claimed.id, reference],
    ).catch(() => {});

    // 4. Process synchronously — identical to the single transfer route
    //    (debits the split/pot wallet, moves the platform float, dispatches
    //    through the active provider, auto-reverses on immediate failure).
    try {
      await processAllPending(null);
    } catch (e: any) {
      console.error("[split-pot-withdrawals] sync processing error:", e?.message);
    }
    if (transferQueue) {
      try { await transferQueue.add("process-transfers", { businessId: null }); } catch { /* worker fallback */ }
    }

    payout = (await query(`SELECT * FROM transfer_queue WHERE reference = $1`, [reference])).rows[0] || null;
  } catch (e: any) {
    // The queue row never landed (insert failure / DB error) → the pipeline
    // never ran and NOTHING was debited. Fail the request cleanly instead of
    // stranding it in 'executing' forever.
    console.error("[split-pot-withdrawals] payout queueing failed:", e?.message);
    queueError = e;
  }

  if (queueError && !payout) {
    const reason = `The payout could not be queued: ${String(queueError?.message || "unknown error").slice(0, 300)}`;
    const failed = await query(
      `UPDATE withdrawal_requests
          SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'executing'
        RETURNING *`,
      [claimed.id, reason],
    );
    const failedRequest = failed.rows[0] || claimed;
    await notifyRequesterWithdrawalOutcome(failedRequest, "failed", { ownerName: ctx.ownerName, reason, refunded: false });
    return { request: failedRequest, payout: null };
  }

  // 5. Bounded instant-status poll (identical to the single
  //    transfer route: 3 × 4s verifySingleTransfer before answering).
  if (payout && ["pending", "processing", "queued"].includes(payout.status)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(4000);
      try {
        payout = (await query(`SELECT * FROM transfer_queue WHERE reference = $1`, [reference])).rows[0] || payout;
        if (["success", "failed"].includes(payout.status)) break;
        const verified = await verifySingleTransfer(payout, 1);
        if (verified) payout = verified;
        if (["success", "failed"].includes(payout.status)) break;
      } catch (vErr: any) {
        console.error("[split-pot-withdrawals] inline verify poll failed:", vErr?.message);
      }
    }
  }

  // processAllPending records per-transfer failures on the queue row itself
  // (failure_reason), so there is nothing extra to carry into finalize — a
  // still-pending row here simply means "processing", which the monitor/
  // webhook reconcile sweeps finish later.
  const finalized = await finalizeWithdrawalFromPayout(claimed, payout, null);
  return { request: finalized, payout };
}

/**
 * Mirror a transfer_queue outcome onto the withdrawal request.
 *   success    → completed (+ ledger debit row, requester notified)
 *   failed     → failed  (+ refund if the pipeline did not already reverse,
 *                         ledger debit + refund rows, requester notified)
 *   processing → stays executing (money left; webhooks/monitor + reconcile
 *                         sweeps finalize it later — requester told "processing")
 */
export async function finalizeWithdrawalFromPayout(
  request: any,
  payout: any | null,
  syncErrorMessage: string | null = null,
): Promise<any> {
  const reference = request.transfer_reference || payout?.reference || null;
  const amount = money(num(request.amount));
  const ownerName = await resolveOwnerName(request.owner_type, request.owner_id);

  // Did the pipeline actually debit the wallet? (Insufficient-balance /
  // wallet-not-found failures happen BEFORE any debit — no ledger rows then.)
  const debited = reference
    ? (await query(
        `SELECT 1 FROM transactions WHERE reference = $1 AND type = 'debit' LIMIT 1`,
        [reference],
      )).rows.length > 0
    : false;
  const fee = debited && payout ? money(num(payout.fee || 0)) : 0;

  const status = String(payout?.status || "").toLowerCase();

  if (status === "success") {
    if (debited) {
      await debitLedgerRow(request, reference, amount + fee, { fee, note: "Withdrawal sent" });
    }
    const upd = await query(
      `UPDATE withdrawal_requests
          SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'executing'
        RETURNING *`,
      [request.id],
    );
    const fresh = upd.rows[0] || request;
    await notifyRequesterWithdrawalOutcome(fresh, "completed", { ownerName });
    return fresh;
  }

  if (status === "failed") {
    const reason = payout?.failure_reason || syncErrorMessage || "Transfer rejected by the payment provider";
    if (debited) {
      await debitLedgerRow(request, reference, amount + fee, { fee, note: "Withdrawal attempt (reversed)" });
      await ensureWithdrawalRefund(request, reference, amount + fee);
    }
    const upd = await query(
      `UPDATE withdrawal_requests
          SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'executing'
        RETURNING *`,
      [request.id, String(reason).slice(0, 500)],
    );
    const fresh = upd.rows[0] || request;
    await notifyRequesterWithdrawalOutcome(fresh, "failed", { ownerName, reason });
    return fresh;
  }

  if (status === "processing" || status === "pending" || status === "queued") {
    if (debited) {
      await debitLedgerRow(request, reference, amount + fee, { fee, note: "Withdrawal processing" });
    }
    await notifyRequesterWithdrawalOutcome(request, "processing", { ownerName });
    return request; // stays 'executing' — reconcile sweeps finish the story
  }

  // Lost queue row / unknown state — treat as failed and refund what left.
  const reason = syncErrorMessage || "Payout could not be tracked — refunded to the wallet";
  if (debited) {
    await debitLedgerRow(request, reference, amount + fee, { fee, note: "Withdrawal attempt (reversed)" });
    await ensureWithdrawalRefund(request, reference, amount + fee);
  }
  const upd = await query(
    `UPDATE withdrawal_requests
        SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'executing'
      RETURNING *`,
    [request.id, String(reason).slice(0, 500)],
  );
  const fresh = upd.rows[0] || request;
  await notifyRequesterWithdrawalOutcome(fresh, "failed", { ownerName, reason });
  return fresh;
}

/** Feature-ledger debit row for a withdrawal (idempotent by reference). */
async function debitLedgerRow(request: any, reference: string | null, amount: number, meta: Record<string, unknown>): Promise<void> {
  if (!reference || !(amount > 0)) return;
  await query(
    `INSERT INTO split_pot_wallet_ledger
       (wallet_id, owner_type, owner_id, direction, amount, currency, reason, reference, metadata)
     VALUES ($1,$2,$3,'debit',$4,'NGN','withdrawal',$5,$6::jsonb)
     ON CONFLICT (reference) DO NOTHING`,
    [request.wallet_id, request.owner_type, request.owner_id, money(amount), `${reference}-WDR`, JSON.stringify(meta)],
  ).catch(() => {});
}

/**
 * Money-safety net: make sure a FAILED withdrawal's debit is back in the
 * split/pot wallet. The single-transfer pipeline already auto-reverses (its
 * `<ref>-REFUND` transaction row proves it) — only cover the gap when it
 * didn't. Idempotent by ledger reference.
 */
async function ensureWithdrawalRefund(request: any, reference: string, totalDebit: number): Promise<void> {
  try {
    const refunded = (await query(
      `SELECT 1 FROM transactions WHERE reference = $1 AND type = 'credit' LIMIT 1`,
      [`${reference}-REFUND`],
    )).rows.length > 0;
    if (refunded) {
      // Pipeline already restored the wallets balance — just mirror the ledger.
      await query(
        `INSERT INTO split_pot_wallet_ledger
           (wallet_id, owner_type, owner_id, direction, amount, currency, reason, reference, metadata)
         VALUES ($1,$2,$3,'credit',$4,'NGN','withdrawal_refund',$5,$6::jsonb)
         ON CONFLICT (reference) DO NOTHING`,
        [request.wallet_id, request.owner_type, request.owner_id, money(totalDebit), `${reference}-WDR-REFUND`, JSON.stringify({ note: "Auto-reversed by transfer pipeline" })],
      ).catch(() => {});
      return;
    }
    await creditSplitPotWallet({
      walletId: request.wallet_id,
      ownerType: request.owner_type,
      ownerId: request.owner_id,
      amount: totalDebit,
      reason: "withdrawal_refund",
      reference: `${reference}-WDR-REFUND`,
      metadata: { note: "Refund — withdrawal failed" },
    });
  } catch (e: any) {
    console.error("[split-pot-withdrawals] CRITICAL: refund failed:", e?.message);
  }
}

// ---------------------------------------------------------------------------
// RECONCILE — finalize executing requests from their transfer_queue rows
// (called by GET detail/history/pending + the provider webhook finalize).
// ---------------------------------------------------------------------------

export async function reconcileWithdrawalRequest(request: any): Promise<any | null> {
  if (!request || request.status !== "executing" || !request.transfer_reference) return null;
  const payout = (await query(
    `SELECT * FROM transfer_queue WHERE reference = $1 LIMIT 1`,
    [request.transfer_reference],
  )).rows[0] || null;
  if (!payout) return null;
  const status = String(payout.status || "").toLowerCase();
  if (!["success", "failed"].includes(status)) return null;
  return finalizeWithdrawalFromPayout(request, payout, null);
}

export async function syncExecutingWithdrawals(limit = 25): Promise<void> {
  const rows = await query(
    `SELECT * FROM withdrawal_requests WHERE status = 'executing' AND transfer_reference IS NOT NULL
      ORDER BY updated_at ASC LIMIT $1`,
    [Math.min(50, Math.max(1, limit))],
  );
  for (const row of rows.rows) {
    try { await reconcileWithdrawalRequest(row); } catch (e: any) {
      console.error("[split-pot-withdrawals] reconcile failed:", row.id, e?.message);
    }
  }
}

/** Webhook hook: finalize any withdrawal tied to this transfer reference. */
export async function reconcileWithdrawalByTransferReference(reference: string): Promise<void> {
  if (!reference) return;
  try {
    const r = await query(
      `SELECT * FROM withdrawal_requests WHERE transfer_reference = $1 AND status = 'executing' LIMIT 1`,
      [reference],
    );
    if (r.rows[0]) await reconcileWithdrawalRequest(r.rows[0]);
  } catch (e: any) {
    console.error("[split-pot-withdrawals] webhook reconcile failed:", e?.message);
  }
}

// ---------------------------------------------------------------------------
// (The detail bundle itself — wallet + ledger + approvers + open request + due
//  hint — is assembled by each owner route, which adds owner-specific fields
//  like the pot deadline fallback for dueForWithdrawal.)
// ---------------------------------------------------------------------------
