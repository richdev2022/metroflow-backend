import express from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { query } from "../db";
import { upload } from "../middleware/upload";
import { uploadMediaBuffer } from "../services/media-upload";

/**
 * FRAUD & COMPLIANCE — user side.
 * Mounted at /fraud (authenticateToken).
 *
 *   GET  /fraud/holds               the user's held items + DD case status
 *   GET  /fraud/due-diligence       the open DD case + form spec
 *   POST /fraud/due-diligence       submit form v1 (JSON answers, optional files)
 *
 * The DD form (v1) fields:
 *   purpose              text (required)
 *   source_of_funds      select + detail (required)
 *   beneficiary_relation select (required)
 *   expected_monthly_volume  number
 *   average_amount       number
 *   occupation           text
 *   attestation          boolean must be true
 *   documents[]          up to 3 files (10 MB each) -> media upload
 */

const router = express.Router();
router.use(authenticateToken);

const DD_FORM_V1 = [
  { key: "purpose", label: "Purpose of the transaction", type: "text", required: true },
  { key: "source_of_funds", label: "Source of funds", type: "select",
    options: ["Salary", "Business revenue", "Gift", "Investment proceeds", "Other"], required: true },
  { key: "source_of_funds_detail", label: "Describe the source of funds", type: "text", required: true },
  { key: "beneficiary_relation", label: "Relationship to the beneficiary", type: "select",
    options: ["Myself", "Family", "Business partner", "Customer", "Other"], required: true },
  { key: "expected_monthly_volume", label: "Expected monthly volume (NGN)", type: "number", required: false },
  { key: "average_amount", label: "Average transaction amount (NGN)", type: "number", required: false },
  { key: "occupation", label: "Occupation / business type", type: "text", required: false },
  { key: "attestation", label: "I confirm the information provided is true and complete", type: "boolean", required: true },
];

/** GET /fraud/holds — held items for the dashboard/wallet banner. */
router.get("/holds", async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const businessId = req.user?.businessId;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const rows = await query(
      `SELECT fc.id AS case_id, fc.transfer_reference, fc.direction, fc.flow, fc.amount, fc.currency,
              fc.status AS case_status, fc.created_at,
              dd.id AS dd_case_id, dd.status AS dd_status, dd.expires_at
         FROM fraud_cases fc
         LEFT JOIN due_diligence_cases dd ON dd.fraud_case_id = fc.id
        WHERE fc.user_id = $1 AND fc.status = 'open'
        ORDER BY fc.created_at DESC LIMIT 20`,
      [userId],
    );
    // For outflows also surface the live transfer state so the UI can show
    // "Under review" until the release lands.
    const out = [];
    for (const r of rows.rows) {
      let transferStatus: string | null = null;
      if (r.transfer_reference) {
        const t = await query(`SELECT status FROM transfer_queue WHERE reference = $1`, [r.transfer_reference]);
        transferStatus = t.rows[0]?.status || null;
      }
      out.push({ ...r, transfer_status: transferStatus });
    }
    return res.json({ success: true, holds: out, count: out.length });
  } catch (error: any) {
    console.error("fraud/holds error:", error?.message);
    return res.status(500).json({ success: false, error: "Failed to load held transactions" });
  }
});

/** GET /fraud/due-diligence — the open case + form spec. */
router.get("/due-diligence", async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const c = await query(
      `SELECT dd.*, fc.transfer_reference, fc.amount, fc.currency, fc.flow
         FROM due_diligence_cases dd
         JOIN fraud_cases fc ON fc.id = dd.fraud_case_id
        WHERE dd.user_id = $1 AND dd.status IN ('pending','submitted','under_review')
        ORDER BY dd.created_at DESC LIMIT 1`,
      [userId],
    );
    const caseRow = c.rows[0] || null;
    let documents: any[] = [];
    if (caseRow) {
      const d = await query(`SELECT id, field_key, file_url, file_name, mime_type, size_bytes FROM due_diligence_documents WHERE case_id = $1`, [caseRow.id]);
      documents = d.rows;
    }
    return res.json({
      success: true,
      case: caseRow,
      form: { schema: "v1", fields: DD_FORM_V1, max_documents: 3, max_file_mb: 10 },
      documents,
    });
  } catch (error: any) {
    console.error("fraud/due-diligence error:", error?.message);
    return res.status(500).json({ success: false, error: "Failed to load due diligence case" });
  }
});

/** POST /fraud/due-diligence — submit form v1 (+ up to 3 document files). */
router.post("/due-diligence", upload.array("documents", 3), async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const c = await query(
      `SELECT * FROM due_diligence_cases
        WHERE user_id = $1 AND status IN ('pending','submitted','under_review')
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [userId],
    );
    const dd = c.rows[0];
    if (!dd) return res.status(404).json({ success: false, error: "No open due diligence case" });
    if (dd.status === "under_review") {
      return res.status(400).json({ success: false, error: "Your submission is already under review" });
    }

    const submission = typeof req.body?.submission === "string"
      ? JSON.parse(req.body.submission)
      : (req.body?.submission || {});

    if (!submission?.purpose || !submission?.source_of_funds || !submission?.beneficiary_relation) {
      return res.status(400).json({ success: false, error: "purpose, source_of_funds and beneficiary_relation are required" });
    }
    if (submission?.attestation !== true && submission?.attestation !== "true") {
      return res.status(400).json({ success: false, error: "You must confirm the attestation" });
    }

    // Store documents (reuse media upload: R2 first)
    const files = (req.files as any[]) || [];
    for (const f of files.slice(0, 3)) {
      if (f.size > 10 * 1024 * 1024) continue;
      try {
        const up = await uploadMediaBuffer({
          buffer: f.buffer,
          originalname: f.originalname,
          mimeType: f.mimetype,
          folder: "due-diligence",
        });
        await query(
          `INSERT INTO due_diligence_documents (case_id, field_key, file_url, file_name, mime_type, size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [dd.id, "supporting_document", up.url, f.originalname, f.mimetype, f.size],
        );
      } catch (e: any) {
        console.warn("DD document upload failed:", e?.message);
      }
    }

    await query(
      `UPDATE due_diligence_cases
         SET submission = $2::jsonb, status = 'under_review', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [dd.id, JSON.stringify(submission)],
    );
    return res.json({ success: true, message: "Submission received — our compliance team will review it shortly" });
  } catch (error: any) {
    console.error("DD submit error:", error?.message);
    return res.status(500).json({ success: false, error: "Failed to submit due diligence form" });
  }
});

export default router;
