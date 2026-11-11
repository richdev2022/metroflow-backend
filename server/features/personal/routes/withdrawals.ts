import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  executeSplitWalletTransfer,
  loadWithdrawalRequest,
  notifyRequesterWithdrawalOutcome,
  resolveOwnerName,
  serializeWithdrawalRequest,
} from "../split-pot-wallets";

/**
 * MULTI-APPROVAL WITHDRAWALS — shared approver surface (mounted at
 * /withdrawals, personal users only).
 *
 * A withdrawal REQUEST created by a split/pot creator is parked in status
 * 'pending' with a snapshot of the approver user ids. Each approver votes
 * ONCE (approve or decline-with-reason); when EVERY approver has approved,
 * the withdrawal EXECUTES through the cloned single-transfer path with the
 * split/pot wallet as the source of funds.
 *
 * Endpoints:
 *   GET  /withdrawals/pending                    → requests awaiting MY approval
 *                                                  (badge / approval inbox)
 *   POST /withdrawals/:requestId/approve         → approver votes yes (one vote each);
 *                                                  final approval triggers execution
 *   POST /withdrawals/:requestId/decline         → approver votes no { reason required }
 */

const router = express.Router();

function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

const REQUEST_BASE = `
  SELECT wr.*, COALESCE(s.title, p.title, wr.owner_id::text) AS owner_name,
         ru.name AS requester_name
    FROM withdrawal_requests wr
    LEFT JOIN splits s ON wr.owner_type = 'split' AND s.id = wr.owner_id
    LEFT JOIN pots p ON wr.owner_type = 'pot' AND p.id = wr.owner_id
    LEFT JOIN users ru ON ru.id = wr.requested_by
`;

// ---------------------------------------------------------------------------
// Approval inbox — requests awaiting MY approval (badges + list)
// ---------------------------------------------------------------------------
router.get("/pending", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const rows = await query(
      `${REQUEST_BASE}
        WHERE wr.status = 'pending'
          AND wr.approvers @> to_jsonb($1::text)
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(wr.approvals) v
             WHERE v->>'approverId' = $1
          )
        ORDER BY wr.created_at DESC
        LIMIT 100`,
      [userId],
    );
    res.json({
      success: true,
      data: {
        count: rows.rows.length,
        withdrawals: rows.rows.map((r: any) => ({
          ...serializeWithdrawalRequest(r),
          ownerName: r.owner_name,
          requesterName: r.requester_name || null,
        })),
      },
    });
  } catch (e: any) {
    console.error("[withdrawals/pending]", e?.message);
    res.status(500).json({ success: false, error: "Could not load pending withdrawals" });
  }
});

// ---------------------------------------------------------------------------
// Approve — approver only, one vote each. Final approval → EXECUTE via the
// cloned single-transfer path (split/pot wallet → bank). No KYC gate here:
// the money moves to the CREATOR's chosen account (the creator passed KYC at
// request time); approvers are a control, and a non-KYC'd approver blocked
// from voting would deadlock the withdrawal with no way out.
// ---------------------------------------------------------------------------
router.post("/:requestId/approve", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const request = await loadWithdrawalRequest(String(req.params.requestId));
    if (!request) {
      return res.status(404).json({ success: false, error: "Withdrawal request not found" });
    }
    if (request.status !== "pending") {
      return res.status(409).json({
        success: false,
        code: "NOT_PENDING",
        error: `This withdrawal request is already ${request.status}`,
        data: { request: serializeWithdrawalRequest(request) },
      });
    }
    const approvers = asArray(request.approvers).map((a: any) => String(a));
    if (!approvers.includes(userId)) {
      return res.status(403).json({ success: false, code: "NOT_AN_APPROVER", error: "You are not an approver for this withdrawal" });
    }
    const already = asArray(request.approvals).find((a: any) => a?.approverId === userId);
    if (already) {
      return res.status(400).json({
        success: false,
        code: "ALREADY_VOTED",
        error: `You already ${already.decision} this withdrawal`,
        data: { request: serializeWithdrawalRequest(request) },
      });
    }

    // Append the vote atomically AND promote the request to 'approved' in the
    // SAME statement when this vote completes the set — the single writer that
    // lands the last approval becomes the executor (concurrent callers lose
    // the status guard and re-read below). Without the in-statement promotion
    // the request would sit in 'pending' while executeSplitWalletTransfer's
    // claim (status = 'approved') could never fire.
    const vote = {
      approverId: userId,
      decision: "approved",
      reason: String(req.body?.note || "").trim().slice(0, 255) || null,
      at: new Date().toISOString(),
    };
    const upd = await query(
      `UPDATE withdrawal_requests
          SET approvals = approvals || $2::jsonb,
              status = CASE WHEN (
                SELECT COUNT(*) FROM jsonb_array_elements(approvals || $2::jsonb) v
                 WHERE v->>'decision' = 'approved'
              ) >= GREATEST(jsonb_array_length(approvers), 1)
                     THEN 'approved' ELSE status END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(approvals) v
             WHERE v->>'approverId' = $3
          )
        RETURNING *`,
      [request.id, JSON.stringify([vote]), userId],
    );
    if (!upd.rows.length) {
      const fresh = await loadWithdrawalRequest(request.id);
      return res.status(409).json({
        success: false,
        code: "VOTE_NOT_RECORDED",
        error: "Your vote could not be recorded — the request may have changed",
        data: { request: fresh ? serializeWithdrawalRequest(fresh) : null },
      });
    }
    const updated = upd.rows[0];
    const approvals = asArray(updated.approvals);
    const approvedCount = approvals.filter((a: any) => a?.decision === "approved").length;
    const ownerName = await resolveOwnerName(updated.owner_type, updated.owner_id);

    if (updated.status !== "approved") {
      // Still collecting votes (the statement promotes only on the last one).
      return res.json({
        success: true,
        data: {
          request: serializeWithdrawalRequest(updated),
          ownerName,
          approvalsRemaining: Math.max(0, approvers.length - approvedCount),
          message: `Approval recorded — ${Math.max(0, approvers.length - approvedCount)} more approver${approvers.length - approvedCount === 1 ? "" : "s"} to go`,
        },
      });
    }

    // ALL approvers approved → EXECUTE (wallet → bank, single-transfer rails).
    // This pass won the in-statement promotion, so the approved→executing
    // claim below belongs to us; a concurrent resume that raced in between
    // surfaces as NOT_EXECUTABLE and is answered with the current state.
    try {
      const executed = await executeSplitWalletTransfer(updated, userId, { ownerName });
      const final = executed.request;
      return res.json({
        success: final.status !== "failed",
        data: {
          request: serializeWithdrawalRequest(final),
          ownerName,
          executed: true,
          transfer: executed.payout
            ? { reference: executed.payout.reference, status: executed.payout.status, failureReason: executed.payout.failure_reason || null }
            : null,
          message: final.status === "completed"
            ? "All approvers approved — the withdrawal was sent"
            : final.status === "executing"
              ? "All approvers approved — the withdrawal is processing"
              : final.failure_reason || "The transfer failed — the money is back in the wallet",
        },
      });
    } catch (execErr: any) {
      if (execErr?.code === "NOT_EXECUTABLE") {
        // Another pass executed it between our vote and this call — return the
        // current state instead of failing.
        const fresh = await loadWithdrawalRequest(request.id);
        return res.json({
          success: true,
          data: {
            request: fresh ? serializeWithdrawalRequest(fresh) : null,
            ownerName,
            executed: true,
            message: "All approvers approved — the withdrawal was already sent",
          },
        });
      }
      throw execErr;
    }
  } catch (e: any) {
    console.error("[withdrawals/approve]", e?.message);
    res.status(500).json({ success: false, error: "Could not record the approval" });
  }
});

// ---------------------------------------------------------------------------
// Decline — approver only, reason REQUIRED. Kills the request (the creator can
// raise a new one).
// ---------------------------------------------------------------------------
router.post("/:requestId/decline", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const request = await loadWithdrawalRequest(String(req.params.requestId));
    if (!request) {
      return res.status(404).json({ success: false, error: "Withdrawal request not found" });
    }
    if (request.status !== "pending") {
      return res.status(409).json({
        success: false,
        code: "NOT_PENDING",
        error: `This withdrawal request is already ${request.status}`,
        data: { request: serializeWithdrawalRequest(request) },
      });
    }
    const approvers = asArray(request.approvers).map((a: any) => String(a));
    if (!approvers.includes(userId)) {
      return res.status(403).json({ success: false, code: "NOT_AN_APPROVER", error: "You are not an approver for this withdrawal" });
    }
    const already = asArray(request.approvals).find((a: any) => a?.approverId === userId);
    if (already) {
      return res.status(400).json({
        success: false,
        code: "ALREADY_VOTED",
        error: `You already ${already.decision} this withdrawal`,
        data: { request: serializeWithdrawalRequest(request) },
      });
    }

    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    if (!reason) {
      return res.status(400).json({ success: false, code: "REASON_REQUIRED", error: "A reason is required to decline a withdrawal" });
    }

    // Record the vote AND flip to declined in ONE guarded write: only the
    // first declining vote wins; concurrent votes lose the claim.
    const vote = { approverId: userId, decision: "declined", reason, at: new Date().toISOString() };
    const upd = await query(
      `UPDATE withdrawal_requests
          SET approvals = approvals || $2::jsonb, status = 'declined',
              failure_reason = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(approvals) v
             WHERE v->>'approverId' = $4
          )
        RETURNING *`,
      [request.id, JSON.stringify([vote]), reason, userId],
    );
    if (!upd.rows.length) {
      const fresh = await loadWithdrawalRequest(request.id);
      return res.status(409).json({
        success: false,
        code: "VOTE_NOT_RECORDED",
        error: "Your vote could not be recorded — the request may have changed",
        data: { request: fresh ? serializeWithdrawalRequest(fresh) : null },
      });
    }
    const updated = upd.rows[0];

    // Notify the requester (push + socket + in-app row).
    const ownerName = await resolveOwnerName(updated.owner_type, updated.owner_id);
    const me = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
    await notifyRequesterWithdrawalOutcome(updated, "declined", { ownerName, reason, declinerName: me.rows[0]?.name || "An approver" });

    res.json({
      success: true,
      data: {
        request: serializeWithdrawalRequest(updated),
        ownerName,
        message: "Withdrawal declined — the creator has been notified",
      },
    });
  } catch (e: any) {
    console.error("[withdrawals/decline]", e?.message);
    res.status(500).json({ success: false, error: "Could not record the decline" });
  }
});

export default router;
