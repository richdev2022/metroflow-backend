import express, { RequestHandler } from "express";
import { authenticateAdmin, requirePermission } from "../middleware/adminAuth";
import { query } from "../db";
import { reverseFailedTransfer } from "../services/transfer";
import { verifySingleTransfer } from "../services/transfer";
import { sendDisputeCustomerUpdate, sendDisputeAdminAlert } from "../services/email";
import { sendPushToUsers } from "../services/push";
import { resolveDisputeTransaction, getDisputeAdminEmails, notifyDisputeCustomer } from "./disputes";

/**
 * Transaction dispute lifecycle — platform admin side.
 * Mounted at /admin/disputes (authenticateAdmin + manage_finance).
 *
 *   GET  /admin/disputes                 list (filter: status, search, page)
 *   GET  /admin/disputes/:id             detail incl. transaction snapshot
 *   POST /admin/disputes/:id/status      move status (open|under_review|resolved|closed|rejected)
 *   POST /admin/disputes/:id/reverse     trigger reversal — GUARDED: only failed,
 *                                        not-yet-credited transfers can be reversed
 *   POST /admin/disputes/:id/recheck     re-query the provider (credit recheck)
 *   POST /admin/disputes/:id/close       close with a resolution note
 *
 * Every action emails + pushes the customer; new disputes already email the
 * admin desk (see routes/disputes.ts).
 */

const router = express.Router();

router.use(authenticateAdmin);

const DISPUTE_STATUSES = ["open", "under_review", "resolved", "closed", "rejected"];

async function loadDispute(id: string) {
  const rows = await query(`SELECT * FROM transaction_disputes WHERE id = $1`, [id]);
  return rows.rows[0] || null;
}

async function markResolved(
  disputeId: string,
  adminId: string,
  action: string,
  note: string,
  status = "resolved",
) {
  await query(
    `UPDATE transaction_disputes
     SET status = $2, resolution_action = $3, resolution_note = $4,
         resolved_by = $5, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [disputeId, status, action, note, adminId],
  );
}

async function alertAdminDesk(subject: string, body: string): Promise<void> {
  const { emails } = await getDisputeAdminEmails();
  for (const adminEmail of emails) {
    await sendDisputeAdminAlert(adminEmail, "Dispute Desk", {
      customerName: "",
      reference: "",
      message: body,
      status: "under_review",
    }).catch(() => {});
  }
  await query(
    `INSERT INTO admin_notifications (type, title, body) VALUES ($1, $2, $3)`,
    ["dispute_update", subject, body],
  ).catch(() => {});
}

/** GET /admin/disputes?status=&search=&page=&limit= */
const listDisputes: RequestHandler = async (req, res) => {
  try {
    const status = String(req.query.status || "").trim();
    const search = String(req.query.search || "").trim();
    const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
    const limit = Math.min(parseInt(String(req.query.limit || "25"), 10) || 25, 100);
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: any[] = [];
    if (status && DISPUTE_STATUSES.includes(status)) {
      params.push(status);
      where.push(`d.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(
        `(d.transaction_reference ILIKE $${params.length} OR b.name ILIKE $${params.length})`,
      );
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countRes = await query(
      `SELECT COUNT(*)::int AS total
       FROM transaction_disputes d
       LEFT JOIN businesses b ON b.id = d.business_id
       ${whereSql}`,
      params,
    );
    params.push(limit, offset);
    const rows = await query(
      `SELECT d.*, b.name AS business_name, u.name AS filed_by_name, u.email AS filed_by_email
       FROM transaction_disputes d
       LEFT JOIN businesses b ON b.id = d.business_id
       LEFT JOIN users u ON u.id = d.user_id
       ${whereSql}
       ORDER BY d.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({
      success: true,
      data: rows.rows,
      pagination: {
        page,
        limit,
        total: countRes.rows[0]?.total || 0,
        totalPages: Math.max(Math.ceil((countRes.rows[0]?.total || 0) / limit), 1),
      },
    });
  } catch (err) {
    console.error("[admin/disputes] list failed:", err);
    res.status(500).json({ success: false, error: "Failed to load disputes" });
  }
};

/** GET /admin/disputes/:id */
const getDispute: RequestHandler = async (req, res) => {
  try {
    const dispute = await loadDispute(req.params.id);
    if (!dispute) {
      res.status(404).json({ success: false, error: "Dispute not found" });
      return;
    }
    const resolved = await resolveDisputeTransaction(
      dispute.transaction_reference,
      dispute.business_id,
    );
    const business = await query(`SELECT name, email FROM businesses WHERE id = $1`, [
      dispute.business_id,
    ]);
    const filer = dispute.user_id
      ? await query(`SELECT name, email FROM users WHERE id = $1`, [dispute.user_id])
      : { rows: [null] };
    res.json({
      success: true,
      data: {
        ...dispute,
        business: business.rows[0] || null,
        filedBy: filer.rows[0] || null,
        transaction: resolved
          ? {
              source: resolved.source,
              amount: resolved.amount,
              currency: resolved.currency,
              status: resolved.status,
              description: resolved.description,
              recipient: resolved.txn.recipient_name
                ? {
                    name: resolved.txn.recipient_name,
                    accountNumber: resolved.txn.recipient_account,
                    bankCode: resolved.txn.recipient_bank,
                    bankName: resolved.txn.recipient_bank_name,
                  }
                : null,
              failureReason: resolved.txn.failure_reason || null,
              provider: resolved.txn.payment_provider || null,
              createdAt: resolved.txn.created_at,
            }
          : null,
      },
    });
  } catch (err) {
    console.error("[admin/disputes] detail failed:", err);
    res.status(500).json({ success: false, error: "Failed to load dispute" });
  }
};

/** POST /admin/disputes/:id/status { status, note } */
const updateStatus: RequestHandler = async (req, res) => {
  try {
    const { status, note } = (req.body || {}) as { status?: string; note?: string };
    if (!status || !DISPUTE_STATUSES.includes(status)) {
      res.status(400).json({ success: false, error: "Invalid status" });
      return;
    }
    const dispute = await loadDispute(req.params.id);
    if (!dispute) {
      res.status(404).json({ success: false, error: "Dispute not found" });
      return;
    }
    const resolved = resolveDisputeTransaction
      ? await resolveDisputeTransaction(dispute.transaction_reference, dispute.business_id)
      : null;
    const adminId = (req as any).admin?.adminId || null;
    await query(
      `UPDATE transaction_disputes
       SET status = $2, resolution_note = COALESCE($3, resolution_note),
           resolved_by = $4,
           resolved_at = CASE WHEN $2 IN ('resolved','closed','rejected') THEN CURRENT_TIMESTAMP ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [dispute.id, status, note || null, adminId],
    );
    const updated = await loadDispute(dispute.id);

    const labels: Record<string, string> = {
      under_review: "Your dispute is now under review",
      resolved: "Your dispute has been resolved",
      closed: "Your dispute has been closed",
      rejected: "Your dispute was not upheld",
      open: "Your dispute was reopened",
    };
    await notifyDisputeCustomer(
      dispute,
      "Dispute update",
      `${labels[status] || "Your dispute was updated"} — reference ${dispute.transaction_reference}${note ? `. Note: ${note}` : ""}`,
      status,
    );
    const filer = dispute.user_id
      ? await query(`SELECT email, name FROM users WHERE id = $1`, [dispute.user_id])
      : { rows: [null] };
    if (filer.rows[0]?.email) {
      await sendDisputeCustomerUpdate(filer.rows[0].email, {
        customerName: filer.rows[0].name || "Customer",
        reference: dispute.transaction_reference,
        amount: resolved?.amount,
        currency: resolved?.currency,
        status,
        note: note || undefined,
        message: dispute.message,
      }).catch(() => {});
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("[admin/disputes] status update failed:", err);
    res.status(500).json({ success: false, error: "Failed to update dispute" });
  }
};

/**
 * POST /admin/disputes/:id/reverse
 * Trigger a reversal. GUARD RAIL (per spec): the system re-checks that the
 * transaction has NOT already been credited/refunded before reversing, and
 * only FAILED transfers are eligible — a successful transfer can never be
 * reversed from here.
 */
const reverseDispute: RequestHandler = async (req, res) => {
  try {
    const dispute = await loadDispute(req.params.id);
    if (!dispute) {
      res.status(404).json({ success: false, error: "Dispute not found" });
      return;
    }
    if (!["open", "under_review"].includes(dispute.status)) {
      res.status(409).json({
        success: false,
        error: `Dispute is already ${dispute.status} — reopen it before taking action`,
      });
      return;
    }

    const resolved = await resolveDisputeTransaction(
      dispute.transaction_reference,
      dispute.business_id,
    );
    if (!resolved || resolved.source !== "transfer_queue") {
      res.status(409).json({
        success: false,
        error: "Only disputed transfers can be reversed (this transaction has no transfer record)",
      });
      return;
    }
    const transfer = resolved.txn;

    if (transfer.status === "success") {
      res.status(409).json({
        success: false,
        error:
          "Provider reports this transfer as SUCCESSFUL — it cannot be reversed. Use Recheck (credit) or close the dispute instead.",
      });
      return;
    }
    if (!["failed"].includes(transfer.status)) {
      res.status(409).json({
        success: false,
        error:
          "Transfer is still " + transfer.status + " — run Recheck first until it reaches a final state",
      });
      return;
    }

    const credited = await reverseFailedTransfer(
      transfer,
      `Dispute ${dispute.id}: ${(req.body?.note || "admin-approved reversal").slice(0, 200)}`,
    );
    if (!credited) {
      res.status(409).json({
        success: false,
        error:
          "Reversal blocked: the customer was already credited for this transaction, or no debit exists to reverse",
      });
      return;
    }

    const note =
      req.body?.note ||
      "Reversal triggered from dispute — funds returned to the customer wallet";
    const adminId = (req as any).admin?.adminId || null;
    await markResolved(dispute.id, adminId, "reversal", note);

    const updated = await loadDispute(dispute.id);
    await notifyDisputeCustomer(
      dispute,
      "Reversal completed",
      `Your disputed transfer ${dispute.transaction_reference} has been reversed and the full amount returned to your wallet.`,
      "resolved",
    );
    const filer = dispute.user_id
      ? await query(`SELECT email, name FROM users WHERE id = $1`, [dispute.user_id])
      : { rows: [null] };
    if (filer.rows[0]?.email) {
      await sendDisputeCustomerUpdate(filer.rows[0].email, {
        customerName: filer.rows[0].name || "Customer",
        reference: dispute.transaction_reference,
        amount: resolved.amount,
        currency: resolved.currency,
        status: "resolved",
        actionLabel: "Reversal triggered — funds returned to wallet",
        note,
        message: dispute.message,
      }).catch(() => {});
    }
    await alertAdminDesk(
      `Dispute reversed: ${dispute.transaction_reference}`,
      `Admin triggered reversal for ${resolved.currency} ${resolved.amount} — customer credited.`,
    );

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("[admin/disputes] reverse failed:", err);
    res.status(500).json({ success: false, error: "Failed to reverse transaction" });
  }
};

/**
 * POST /admin/disputes/:id/recheck
 * Re-verify the disputed transfer directly with the payment provider (the
 * "credit recheck"): if the provider now reports success the wallet gets its
 * credit path; if it reports failure the transfer is failed + auto-refunded
 * (verifySingleTransfer handles both, idempotently).
 */
const recheckDispute: RequestHandler = async (req, res) => {
  try {
    const dispute = await loadDispute(req.params.id);
    if (!dispute) {
      res.status(404).json({ success: false, error: "Dispute not found" });
      return;
    }
    const resolved = await resolveDisputeTransaction(
      dispute.transaction_reference,
      dispute.business_id,
    );
    if (!resolved || resolved.source !== "transfer_queue") {
      res.status(409).json({
        success: false,
        error: "Recheck is available for transfers only",
      });
      return;
    }

    let outcome: string;
    let updatedTransfer = resolved.txn;
    if (["success", "failed"].includes(resolved.txn.status)) {
      outcome = resolved.txn.status;
    } else {
      try {
        const verified = await verifySingleTransfer(resolved.txn, 2);
        updatedTransfer = verified || (await query(
          `SELECT * FROM transfer_queue WHERE id = $1`,
          [resolved.txn.id],
        )).rows[0];
        outcome = updatedTransfer?.status || "processing";
      } catch (vErr) {
        console.error("[admin/disputes] recheck verify failed:", vErr);
        outcome = "processing";
      }
    }

    // Reflect the recheck in the dispute record (keep it under_review unless
    // the transfer reached a final state AND the admin wants auto-resolve).
    let note = req.body?.note || null;
    const adminId = (req as any).admin?.adminId || null;
    if (outcome === "success") {
      note = note || "Provider recheck confirmed the transfer was successful.";
      await markResolved(dispute.id, adminId, "recheck", note);
    } else if (outcome === "failed") {
      note =
        note ||
        "Provider recheck confirmed the transfer failed — the amount was automatically returned to the wallet.";
      await markResolved(dispute.id, adminId, "recheck", note);
    } else {
      await query(
        `UPDATE transaction_disputes
         SET status = 'under_review', resolution_note = COALESCE($2, resolution_note),
             resolution_action = 'recheck', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [dispute.id, note || `Provider recheck run — still ${outcome}`],
      );
    }
    const updated = await loadDispute(dispute.id);

    const outcomeCopy: Record<string, string> = {
      success: "Our provider confirmed the transaction was successful — no credit is due.",
      failed:
        "Our provider confirmed the transaction failed — the full amount has been returned to your wallet automatically.",
      processing:
        "The provider is still processing this transaction. We will keep monitoring it and update you.",
    };
    await notifyDisputeCustomer(
      dispute,
      "Dispute recheck complete",
      `${outcomeCopy[outcome] || "We re-checked your transaction with the provider."} (Reference ${dispute.transaction_reference})`,
      outcome === "processing" ? "under_review" : "resolved",
    );
    const filer = dispute.user_id
      ? await query(`SELECT email, name FROM users WHERE id = $1`, [dispute.user_id])
      : { rows: [null] };
    if (filer.rows[0]?.email) {
      await sendDisputeCustomerUpdate(filer.rows[0].email, {
        customerName: filer.rows[0].name || "Customer",
        reference: dispute.transaction_reference,
        amount: resolved.amount,
        currency: resolved.currency,
        status: outcome === "processing" ? "under_review" : "resolved",
        actionLabel:
          outcome === "failed"
            ? "Provider recheck — auto-reversal applied"
            : outcome === "success"
              ? "Provider recheck — transaction confirmed successful"
              : "Provider recheck — still processing",
        note: note || undefined,
        message: dispute.message,
      }).catch(() => {});
    }
    await alertAdminDesk(
      `Dispute rechecked: ${dispute.transaction_reference}`,
      `Provider recheck outcome: ${outcome}.`,
    );

    res.json({
      success: true,
      data: { dispute: updated, transactionStatus: outcome },
    });
  } catch (err) {
    console.error("[admin/disputes] recheck failed:", err);
    res.status(500).json({ success: false, error: "Failed to recheck transaction" });
  }
};

/** POST /admin/disputes/:id/close { note } */
const closeDispute: RequestHandler = async (req, res) => {
  try {
    const dispute = await loadDispute(req.params.id);
    if (!dispute) {
      res.status(404).json({ success: false, error: "Dispute not found" });
      return;
    }
    const note = req.body?.note || "Dispute closed by admin.";
    const action = String(req.body?.resolution || "closed") === "rejected" ? "closed" : "closed";
    const status = String(req.body?.resolution) === "rejected" ? "rejected" : "closed";
    const adminId = (req as any).admin?.adminId || null;
    await markResolved(dispute.id, adminId, action, note, status);

    const updated = await loadDispute(dispute.id);
    await notifyDisputeCustomer(
      dispute,
      status === "rejected" ? "Dispute not upheld" : "Dispute closed",
      `Your dispute for ${dispute.transaction_reference} has been ${status === "rejected" ? "reviewed and not upheld" : "closed"}.${note ? ` Note: ${note}` : ""}`,
      status,
    );
    const filer = dispute.user_id
      ? await query(`SELECT email, name FROM users WHERE id = $1`, [dispute.user_id])
      : { rows: [null] };
    if (filer.rows[0]?.email) {
      await sendDisputeCustomerUpdate(filer.rows[0].email, {
        customerName: filer.rows[0].name || "Customer",
        reference: dispute.transaction_reference,
        status,
        note,
        message: dispute.message,
      }).catch(() => {});
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("[admin/disputes] close failed:", err);
    res.status(500).json({ success: false, error: "Failed to close dispute" });
  }
};

router.get("/", requirePermission("manage_finance"), listDisputes);
router.get("/:id", requirePermission("manage_finance"), getDispute);
router.post("/:id/status", requirePermission("manage_finance"), updateStatus);
router.post("/:id/reverse", requirePermission("manage_finance"), reverseDispute);
router.post("/:id/recheck", requirePermission("manage_finance"), recheckDispute);
router.post("/:id/close", requirePermission("manage_finance"), closeDispute);

export default router;
