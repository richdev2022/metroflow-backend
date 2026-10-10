/**
 * Business KYC upgrade flow — lets a business move from the
 * 'non_registered' transaction-limit category to 'registered' (Verified).
 *
 * Lifecycle:
 *   1. Owner submits: registration type + business description + documents.
 *   2. Submission lands in `business_kyc_submissions` (status=pending);
 *      admins are emailed (KYC_ADMIN_EMAILS), submitter gets in-app + push.
 *   3. Admin approves → business.registration_category='registered'
 *      (owner emailed + pushed) — or rejects with a reason (owner can resubmit).
 */
import express, { Request, Response } from "express";
import crypto from "crypto";
import { query } from "../db";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { upload } from "../middleware/upload";
import { sendEmail } from "../services/email";
import { sendPushToUsers } from "../services/push";
import { buildEmailFooterHtml } from "../services/email-footer";
import {
  getRegistrationType,
  getRequiredDocuments,
  registrationTypesConfig,
} from "../lib/registration-types";
import { getBusinessLimitInfo } from "../services/transaction-limits";
import { uploadWithFallback } from "../lib/storage";

const router = express.Router();

const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB per document
const MAX_DOCS = 10;

interface DocMeta {
  kind: string;
  label: string;
  url: string;
  filename: string;
  mime: string;
  size: number;
  uploadedAt: string;
}

async function getBusinessRow(businessId: string) {
  const res = await query(
    `SELECT id, name, email, industry,
            COALESCE(registration_category, 'non_registered') AS registration_category,
            requested_registration_category, business_registration_type,
            registration_category_updated_at
       FROM businesses WHERE id = $1 LIMIT 1`,
    [businessId],
  );
  return res.rows[0] || null;
}

/**
 * @swagger
 * /business-kyc/config:
 *   get:
 *     summary: Business KYC upgrade configuration
 *     description: Registration types (with their required document packs) and the transaction limits per category. Public — the upgrade wizard needs it before login checks.
 *     tags: [Business KYC]
 *     responses:
 *       200:
 *         description: Configuration
 */
router.get("/config", async (_req: Request, res: Response) => {
  try {
    const limits = await getBusinessLimitInfo("__config_probe__").catch(() => null);
    res.json({
      success: true,
      data: {
        registrationTypes: registrationTypesConfig(),
        limits: limits
          ? {
              nonRegistered: { singleTransactionLimit: 50000, dailyLimit: 100000, monthlyLimit: 500000 },
              registered: limits.registeredLimits,
            }
          : null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || "Failed to load config" });
  }
});

/**
 * @swagger
 * /business-kyc/status:
 *   get:
 *     summary: Business KYC + transaction-limit status for the caller
 *     tags: [Business KYC]
 *     security:
 *       - bearerAuth: []
 */
router.get("/status", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const business = await getBusinessRow(businessId);
    if (!business) return res.status(404).json({ success: false, error: "Business not found" });

    const submissions = await query(
      `SELECT id, registration_type, registration_type_label, business_description,
              documents, status, admin_notes, reviewed_at, created_at
         FROM business_kyc_submissions
        WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 5`,
      [businessId],
    );

    const latest = submissions.rows[0] || null;
    const limitInfo = await getBusinessLimitInfo(businessId);

    res.json({
      success: true,
      data: {
        business: {
          id: business.id,
          name: business.name,
          registrationCategory: business.registration_category,
          isRegistered: business.registration_category === "registered",
          registrationType: business.business_registration_type || null,
          requestedRegistrationCategory: business.requested_registration_category || null,
          categoryUpdatedAt: business.registration_category_updated_at || null,
        },
        latestSubmission: latest
          ? {
              id: latest.id,
              registrationType: latest.registration_type,
              registrationTypeLabel: latest.registration_type_label,
              businessDescription: latest.business_description,
              documents: (latest.documents || []).map((d: DocMeta) => ({
                kind: d.kind,
                label: d.label,
                url: d.url,
                filename: d.filename,
                mime: d.mime,
                size: d.size,
              })),
              status: latest.status,
              adminNotes: latest.admin_notes || null,
              reviewedAt: latest.reviewed_at,
              createdAt: latest.created_at,
            }
          : null,
        submissionHistory: submissions.rows.map((s: any) => ({
          id: s.id,
          status: s.status,
          registrationTypeLabel: s.registration_type_label,
          createdAt: s.created_at,
          reviewedAt: s.reviewed_at,
          adminNotes: s.admin_notes || null,
        })),
        limits: limitInfo,
        canUpgrade: business.registration_category !== "registered",
      },
    });
  } catch (err: any) {
    console.error("[business-kyc] status error:", err?.message);
    res.status(500).json({ success: false, error: "Failed to load business KYC status" });
  }
});

/**
 * @swagger
 * /business-kyc/submit:
 *   post:
 *     summary: Submit the Business KYC upgrade (documents upload)
 *     description: multipart/form-data — fields registrationType, businessDescription, docKinds (JSON array aligned with the `documents` files).
 *     tags: [Business KYC]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  "/submit",
  authenticateToken,
  upload.array("documents", MAX_DOCS),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.userId;
      const businessId = req.user?.businessId;
      if (!userId || !businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

      const registrationType = String((req.body as any).registrationType || "").trim();
      const businessDescription = String((req.body as any).businessDescription || "").trim();
      let docKinds: string[] = [];
      try {
        const parsed = JSON.parse(String((req.body as any).docKinds || "[]"));
        if (Array.isArray(parsed)) docKinds = parsed.map((k) => String(k));
      } catch {
        /* docKinds missing */
      }

      const type = getRegistrationType(registrationType);
      if (!type) {
        return res.status(400).json({ success: false, error: "Unknown registration type", code: "INVALID_REGISTRATION_TYPE" });
      }
      if (businessDescription.length < 20) {
        return res.status(400).json({
          success: false,
          error: "Please describe your business in at least 20 characters",
          code: "DESCRIPTION_TOO_SHORT",
        });
      }

      const required = getRequiredDocuments(registrationType)!;
      const requiredIds = required.filter((d) => d.required).map((d) => d.id);
      const providedKinds = new Set(docKinds);
      const missing = requiredIds.filter((id) => !providedKinds.has(id));
      if (missing.length) {
        const labelById = new Map(required.map((d) => [d.id, d.label]));
        return res.status(400).json({
          success: false,
          error: `Missing required document(s): ${missing.map((id) => labelById.get(id) || id).join(", ")}`,
          code: "DOCUMENTS_MISSING",
          data: { missing },
        });
      }

      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length !== docKinds.length) {
        return res.status(400).json({
          success: false,
          error: "Each uploaded file needs a matching entry in docKinds (same order)",
          code: "DOCKINDS_MISMATCH",
        });
      }
      const oversized = files.find((f) => f.size > MAX_DOC_BYTES);
      if (oversized) {
        return res.status(400).json({
          success: false,
          error: `${oversized.originalname} is larger than 10MB`,
          code: "FILE_TOO_LARGE",
        });
      }

      // Guard: a pending submission already exists → block duplicates.
      const pending = await query(
        `SELECT id FROM business_kyc_submissions WHERE business_id = $1 AND status = 'pending' LIMIT 1`,
        [businessId],
      );
      if (pending.rows.length) {
        return res.status(409).json({
          success: false,
          error: "A Business KYC submission is already under review",
          code: "SUBMISSION_PENDING",
          data: { submissionId: pending.rows[0].id },
        });
      }

      const labelById = new Map(required.map((d) => [d.id, d.label]));
      const documents: DocMeta[] = [];
      for (const file of files) {
        const kind = docKinds[files.indexOf(file)];
        const ext = file.originalname.includes(".")
          ? file.originalname.split(".").pop()!.toLowerCase()
          : (file.mimetype.split("/")[1] || "bin");
        const key = `kyc/${businessId}/${Date.now()}-${crypto.randomBytes(5).toString("hex")}-${kind}.${ext}`;
        // Resilient upload: R2 first; on R2 failure (revoked token, blip) small
        // docs degrade to data URIs so the submission still lands instead of a
        // raw 500 — only oversized docs 503 when storage is down.
        let url: string;
        try {
          url = await uploadWithFallback(key, file.buffer, file.mimetype);
        } catch (storageErr: any) {
          if (storageErr?.code === "STORAGE_UNAVAILABLE") {
            return res.status(503).json({
              success: false,
              error: storageErr.message,
              code: "STORAGE_UNAVAILABLE",
            });
          }
          throw storageErr;
        }
        documents.push({
          kind,
          label: labelById.get(kind) || kind,
          url,
          filename: file.originalname,
          mime: file.mimetype,
          size: file.size,
          uploadedAt: new Date().toISOString(),
        });
      }

      const submissionId = crypto.randomUUID();
      await query(
        `INSERT INTO business_kyc_submissions
           (id, business_id, user_id, registration_type, registration_type_label,
            business_description, documents, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending')`,
        [
          submissionId,
          businessId,
          userId,
          type.id,
          type.label,
          businessDescription,
          JSON.stringify(documents),
        ],
      );

      await query(
        `UPDATE businesses SET business_registration_type = $2 WHERE id = $1`,
        [businessId, type.id],
      );

      const business = await getBusinessRow(businessId);
      const ownerRes = await query(`SELECT email, name FROM users WHERE id = $1 LIMIT 1`, [userId]);
      const owner = ownerRes.rows[0] || { email: business?.email, name: "Business owner" };

      // Notify admins (email) + confirm to the owner (email + push/in-app).
      const adminEmails = (process.env.KYC_ADMIN_EMAILS || "")
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      const adminHtml = `
        <h2>New Business KYC submission</h2>
        <p><b>${business?.name || businessId}</b> (${businessId}) submitted a Registered-Business upgrade request.</p>
        <ul>
          <li>Registration type: <b>${type.label}</b> (${type.authority})</li>
          <li>Submitted by: ${owner.email}</li>
          <li>Documents: ${documents.map((d) => d.label).join(", ")}</li>
        </ul>
        <p>Description: ${businessDescription.slice(0, 400)}</p>
        <p>Review it in Admin → Business KYC.</p>
        ${buildEmailFooterHtml()}`;
      for (const to of adminEmails) {
        sendEmail(to, "Admin", "New Business KYC submission — Metricorex", adminHtml).catch(() => {});
      }

      const ownerHtml = `
        <h2>We received your Business KYC submission</h2>
        <p>Hi ${owner.name || "there"},</p>
        <p>Your <b>${type.label}</b> verification for <b>${business?.name || "your business"}</b> is now under review.
        We will notify you as soon as an admin reviews it — usually within 24 hours.</p>
        ${buildEmailFooterHtml()}`;
      sendEmail(owner.email, owner.name || "Business owner", "Business KYC received — Metricorex", ownerHtml).catch(() => {});

      sendPushToUsers(
        [{ userId, businessId }],
        {
          title: "Business KYC submitted",
          body: `Your ${type.label} verification is under review. We'll notify you once it's approved.`,
          data: { type: "business-kyc", eventType: "submitted", submissionId },
        },
        { inApp: true, type: "business_kyc", businessId },
      ).catch(() => {});

      res.status(201).json({
        success: true,
        message: "Business KYC submitted — you will be notified once reviewed",
        data: { submissionId, status: "pending" },
      });
    } catch (err: any) {
      // Full forensic line — pm2 error.log must show WHY, not just that it
      // failed (pg code + constraint + stack make support triage one-shot).
      console.error(
        "[business-kyc] submit error:",
        err?.code ? `${err.code} ` : "",
        err?.message,
        "\n",
        err?.stack || "(no stack)",
      );
      res.status(500).json({
        success: false,
        error: "Failed to submit Business KYC",
        // Safe, non-leaking hint so clients can retry intelligently.
        ...(err?.code ? { code: `SUBMIT_FAILED_${String(err.code).replace(/[^A-Z0-9_]/gi, "")}` } : {}),
      });
    }
  },
);

export default router;
