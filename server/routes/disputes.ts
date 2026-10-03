import express, { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { upload } from "../middleware/upload";
import { uploadMediaBuffer } from "../services/media-upload";
import { sendDisputeAdminAlert, sendDisputeCustomerUpdate } from "../services/email";
import { sendPushToUsers } from "../services/push";

/**
 * Transaction disputes (customer side).
 *
 * POST   /disputes        — file a dispute (optional attachment upload)
 * GET    /disputes/mine   — list my business's disputes
 * GET    /disputes/:id    — dispute detail (business-scoped)
 *
 * Admin endpoints live in routes/admin_disputes.ts (mounted under /admin).
 */

const router = express.Router();

const DISPUTE_CATEGORIES = [
  "failed_transfer",
  "unauthorized",
  "double_debit",
  "not_received",
  "amount_mismatch",
  "other",
];

interface ResolvedTxn {
  source: "transfer_queue" | "transactions";
  txn: any;
  amount: string;
  currency: string;
  status: string;
  description: string;
}

/** Find a business-owned transaction by reference across both ledgers. */
export async function resolveDisputeTransaction(
  reference: string,
  businessId: string,
): Promise<ResolvedTxn | null> {
  const tq = await query(
    `SELECT * FROM transfer_queue WHERE reference = $1 AND business_id = $2 LIMIT 1`,
    [reference, businessId],
  );
  if (tq.rows[0]) {
    const t = tq.rows[0];
    return {
      source: "transfer_queue",
      txn: t,
      amount: t.amount,
      currency: t.currency || "NGN",
      status: t.status,
      description: `Transfer to ${t.recipient_name || t.recipient_account || "account"}`,
    };
  }
  const tx = await query(
    `SELECT * FROM transactions WHERE reference = $1 AND business_id = $2 LIMIT 1`,
    [reference, businessId],
  );
  if (tx.rows[0]) {
    const t = tx.rows[0];
    return {
      source: "transactions",
      txn: t,
      amount: t.amount,
      currency: t.currency || "NGN",
      status: t.status,
      description: t.description || t.transaction_type || "Transaction",
    };
  }
  return null;
}

/** Email inboxes that receive new-dispute alerts (first config wins). */
export function disputeAdminEmails(): string[] {
  const raw =
    process.env.DISPUTE_ADMIN_EMAILS ||
    process.env.KYC_ADMIN_EMAILS ||
    process.env.SUPPORT_ALERT_EMAIL ||
    process.env.ADMIN_ALERT_EMAIL ||
    "";
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Notify the customer on every dispute lifecycle event (push + in-app). */
export async function notifyDisputeCustomer(
  dispute: any,
  headline: string,
  bodyText: string,
  extraStatus?: string,
): Promise<void> {
  try {
    await sendPushToUsers(
      [{ userId: dispute.user_id, businessId: dispute.business_id }],
      {
        title: headline,
        body: bodyText,
        data: {
          type: "dispute-update",
          disputeId: dispute.id,
          reference: dispute.transaction_reference,
          status: extraStatus || dispute.status,
        },
      },
      { inApp: true, type: "dispute_update", businessId: dispute.business_id },
    );
  } catch (err) {
    console.error("[disputes] customer notify failed (non-fatal):", err);
  }
}

const fileDispute: RequestHandler = async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const businessId = authReq.user?.businessId;
    const userId = authReq.user?.userId;
    if (!businessId || !userId) {
      res.status(401).json({ success: false, error: "Authentication required" });
      return;
    }

    const { reference, category, message } = (req.body || {}) as {
      reference?: string;
      category?: string;
      message?: string;
    };

    if (!reference || typeof reference !== "string") {
      res.status(400).json({ success: false, error: "Transaction reference is required" });
      return;
    }
    const trimmedMessage = String(message || "").trim();
    if (trimmedMessage.length < 10) {
      res.status(400).json({
        success: false,
        error: "Please describe the issue (at least 10 characters)",
      });
      return;
    }
    const safeCategory = DISPUTE_CATEGORIES.includes(String(category))
      ? String(category)
      : "other";

    const resolved = await resolveDisputeTransaction(reference.trim(), businessId);
    if (!resolved) {
      res.status(404).json({
        success: false,
        error: "Transaction not found for your account",
      });
      return;
    }
    if (["credit", "refund"].includes(String(resolved.txn.type || "").toLowerCase())) {
      res.status(400).json({
        success: false,
        error: "Only outgoing (debit) transactions can be disputed",
      });
      return;
    }

    // Attachment (optional): image or PDF, <= 10MB.
    let attachmentUrl: string | null = null;
    let attachmentName: string | null = null;
    const file = (req as any).file;
    if (file?.buffer) {
      if (file.size > 10 * 1024 * 1024) {
        res.status(400).json({ success: false, error: "Attachment must be 10MB or smaller" });
        return;
      }
      const allowed = /jpeg|jpg|png|pdf/i.test(file.mimetype) ||
        /jpeg|jpg|png|pdf$/i.test(file.originalname || "");
      if (!allowed) {
        res.status(400).json({ success: false, error: "Attachment must be an image or PDF" });
        return;
      }
      try {
        const media = await uploadMediaBuffer({
          buffer: file.buffer,
          originalname: file.originalname || "dispute-attachment",
          mimeType: file.mimetype || "application/octet-stream",
          folder: "disputes",
          businessId,
          userId,
        });
        attachmentUrl = media.url;
        attachmentName = file.originalname || media.filename || null;
      } catch (upErr) {
        console.error("[disputes] attachment upload failed:", upErr);
        res.status(500).json({ success: false, error: "Failed to store attachment" });
        return;
      }
    }

    const insert = await query(
      `INSERT INTO transaction_disputes
        (business_id, user_id, transaction_reference, transaction_source, category, message, attachment_url, attachment_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')
       RETURNING *`,
      [
        businessId,
        userId,
        reference.trim(),
        resolved.source,
        safeCategory,
        trimmedMessage,
        attachmentUrl,
        attachmentName,
      ],
    ).catch((err: any) => {
      if (err?.code === "23505") {
        // partial unique index uq_disputes_open_txn
        throw Object.assign(new Error("An open dispute already exists for this transaction"), {
          statusCode: 409,
        });
      }
      throw err;
    });

    const dispute = insert.rows[0];

    // 1) Confirm to the customer (in-app + push + email).
    await notifyDisputeCustomer(
      dispute,
      "Dispute received",
      `We received your dispute for ${reference}. Our team will investigate and update you.`,
    );
    try {
      const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [userId]);
      if (userRes.rows[0]?.email) {
        await sendDisputeCustomerUpdate(userRes.rows[0].email, {
          customerName: userRes.rows[0].name || "Customer",
          reference: reference.trim(),
          amount: resolved.amount,
          currency: resolved.currency,
          category: safeCategory,
          status: "open",
          message: trimmedMessage,
        });
      }
    } catch (mailErr) {
      console.error("[disputes] customer email failed (non-fatal):", mailErr);
    }

    // 2) Alert the admin desk (email + admin notification feed).
    try {
      const businessRes = await query(`SELECT name FROM businesses WHERE id = $1`, [businessId]);
      const businessName = businessRes.rows[0]?.name || "A customer";
      const admins = disputeAdminEmails();
      for (const adminEmail of admins) {
        await sendDisputeAdminAlert(adminEmail, businessName, {
          customerName: businessName,
          reference: reference.trim(),
          amount: resolved.amount,
          currency: resolved.currency,
          category: safeCategory,
          status: "open",
          message: trimmedMessage,
        }).catch(() => {});
      }
      await query(
        `INSERT INTO admin_notifications (type, title, body)
         VALUES ($1, $2, $3)`,
        [
          "dispute_new",
          `New dispute: ${reference.trim()}`,
          `${businessName} disputed ${resolved.currency} ${resolved.amount} — ${safeCategory.replace(/_/g, " ")}`,
        ],
      ).catch(() => {});
    } catch (adminErr) {
      console.error("[disputes] admin alert failed (non-fatal):", adminErr);
    }

    res.status(201).json({ success: true, data: dispute });
  } catch (err: any) {
    const status = err?.statusCode || 500;
    res.status(status).json({
      success: false,
      error: status === 409 ? err.message : "Failed to file dispute",
    });
  }
};

const listMyDisputes: RequestHandler = async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const businessId = authReq.user?.businessId;
    if (!businessId) {
      res.status(401).json({ success: false, error: "Authentication required" });
      return;
    }
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 100);
    const rows = await query(
      `SELECT * FROM transaction_disputes WHERE business_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [businessId, limit],
    );
    res.json({ success: true, data: rows.rows });
  } catch (err) {
    console.error("[disputes] list mine failed:", err);
    res.status(500).json({ success: false, error: "Failed to load disputes" });
  }
};

const getMyDispute: RequestHandler = async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const businessId = authReq.user?.businessId;
    if (!businessId) {
      res.status(401).json({ success: false, error: "Authentication required" });
      return;
    }
    const rows = await query(
      `SELECT * FROM transaction_disputes WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId],
    );
    if (rows.rows.length === 0) {
      res.status(404).json({ success: false, error: "Dispute not found" });
      return;
    }
    res.json({ success: true, data: rows.rows[0] });
  } catch (err) {
    console.error("[disputes] detail failed:", err);
    res.status(500).json({ success: false, error: "Failed to load dispute" });
  }
};

router.post("/", upload.single("attachment"), fileDispute);
router.get("/mine", listMyDisputes);
router.get("/:id", getMyDispute);

export default router;
