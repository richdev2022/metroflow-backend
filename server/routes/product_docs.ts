import { Router, RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus, checkFeaturePermission } from "../middleware/auth";
import { generateProductDocumentation, regenerateProductDocumentation } from "../services/ai";
import { generatePDF } from "../services/pdf";
import { processPendingProductDocJobs } from "../services/productDocJobs";
import { ProductDocumentation, ApiResponse } from "@shared/api";
import { uploadLocal } from "../middleware/uploadLocal";
import fs from "fs";
import path from "path";
import { getStore } from "@netlify/blobs";

const router = Router();

// Generate Product Documentation (async via background job)
router.post("/ideas/:ideaId/documentation", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), (async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /ideas/{ideaId}/documentation:
   *   post:
   *     summary: Generate product documentation for an idea
   *     tags: [Product Documentation]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: ideaId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       201:
   *         description: Documentation generated successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/ProductDocumentation'
   */
  try {
    const { ideaId } = req.params;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    // Fetch Idea
    const ideaResult = await query(
      `SELECT title, description FROM ideas WHERE id = $1 AND business_id = $2`,
      [ideaId, businessId]
    );

    if (ideaResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Idea not found" });
    }

    const { title, description } = ideaResult.rows[0];

    // Create placeholder documentation row with pending status
    const placeholderContent = "Product documentation generation is in progress.";

    const docResult = await query(
      `INSERT INTO product_documentation (business_id, idea_id, title, content, created_by, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [businessId, ideaId, title, placeholderContent, userId]
    );

    const doc = docResult.rows[0];

    // Enqueue background job for AI generation
    await query(
      `INSERT INTO product_documentation_jobs (business_id, user_id, idea_id, doc_id, job_type, status)
       VALUES ($1, $2, $3, $4, 'generate', 'pending')`,
      [businessId, userId, ideaId, doc.id]
    );

    const message = `Your request to generate product documentation for "${title}" is currently in process. You will receive an email notification once it's ready, then you can refresh your app to see the updated documentation.`;

    const response: ApiResponse<ProductDocumentation> = {
      success: true,
      data: doc,
    };

    res.status(202).json({
      ...response,
      message,
    } as any);
  } catch (error) {
    console.error("Generate documentation error:", error);
    res.status(500).json({ success: false, error: "failed to generate document" });
  }
}) as RequestHandler);

// Get all generated Product Documentation for an idea
router.get("/ideas/:ideaId/documentation", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), (async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /ideas/{ideaId}/documentation:
   *   get:
   *     summary: Get all product documentation for an idea
   *     tags: [Product Documentation]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: ideaId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: List of product documentation
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/ProductDocumentation'
   */
  try {
    const { ideaId } = req.params;
    const businessId = req.user?.businessId;

    const result = await query(
      `SELECT * FROM product_documentation WHERE idea_id = $1 AND business_id = $2 ORDER BY created_at DESC`,
      [ideaId, businessId]
    );

    const response: ApiResponse<ProductDocumentation[]> = {
      success: true,
      data: result.rows,
    };

    res.json(response);
  } catch (error) {
    console.error("Get documentation error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch documentation" });
  }
}) as RequestHandler);

// Edit generated product documentation
router.put("/product-documentation/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), uploadLocal.single('logo'), (async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /product-documentation/{id}:
   *   put:
   *     summary: Update product documentation
   *     tags: [Product Documentation]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             properties:
   *               content:
   *                 type: string
   *               logo:
   *                 type: string
   *                 format: binary
   *     responses:
   *       200:
   *         description: Documentation updated
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/ProductDocumentation'
   */
  try {
    const { id } = req.params;
    const { content } = req.body;
    const businessId = req.user?.businessId;
    let logoUrl = req.body.logoUrl;
    if (logoUrl) {
      logoUrl = String(logoUrl).trim().replace(/^`+|`+$/g, "");
    }

    if (req.file) {
        const protocol = req.protocol;
        const host = req.get('host');
        const isLambda = !!process.env.LAMBDA_TASK_ROOT || !!process.env.NETLIFY;
        if (isLambda) {
          const filePath = path.join(isLambda ? path.join("/tmp", "uploads") : path.join(process.cwd(), "uploads"), req.file.filename);
          try {
            const store = getStore("uploads");
            const buffer = fs.readFileSync(filePath);
            const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            await store.set(req.file.filename, ab as any);
            logoUrl = `${protocol}://${host}/uploads/${req.file.filename}`.trim();
          } catch (e) {
            const mime = req.file.mimetype || "application/octet-stream";
            let base64 = "";
            try {
              const buffer = fs.readFileSync(filePath);
              base64 = buffer.toString("base64");
            } catch {}
            logoUrl = `data:${mime};base64,${base64}`;
          } finally {
            try { fs.unlinkSync(filePath); } catch {}
          }
        } else {
          logoUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
          logoUrl = String(logoUrl).trim();
        }
    }

    const result = await query(
      `UPDATE product_documentation 
       SET content = COALESCE($1, content), 
           logo_url = COALESCE($2, logo_url),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND business_id = $4
       RETURNING *`,
      [content, logoUrl, id, businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Documentation not found" });
    }

    const response: ApiResponse<ProductDocumentation> = {
      success: true,
      data: result.rows[0],
    };

    res.json(response);
  } catch (error) {
    console.error("Update documentation error:", error);
    res.status(500).json({ success: false, error: "Failed to update documentation", details: error instanceof Error ? error.message : String(error) });
  }
}) as RequestHandler);

// Delete generated product documentation
router.delete("/product-documentation/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), (async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /product-documentation/{id}:
   *   delete:
   *     summary: Delete product documentation
   *     tags: [Product Documentation]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Documentation deleted
   */
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;

    const result = await query(
      `DELETE FROM product_documentation WHERE id = $1 AND business_id = $2 RETURNING id`,
      [id, businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Documentation not found" });
    }

    res.json({ success: true, message: "Documentation deleted" });
  } catch (error) {
    console.error("Delete documentation error:", error);
    res.status(500).json({ success: false, error: "Failed to delete documentation" });
  }
}) as RequestHandler);

// Regenerate product documentation (async via background job)
router.post("/product-documentation/:id/regenerate", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), (async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /product-documentation/{id}/regenerate:
   *   post:
   *     summary: Regenerate product documentation
   *     tags: [Product Documentation]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - areasOfConcern
   *             properties:
   *               areasOfConcern:
   *                 type: string
   *     responses:
   *       200:
   *         description: Documentation regenerated
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/ProductDocumentation'
   */
  try {
    const { id } = req.params;
    const { areasOfConcern } = req.body;
    const businessId = req.user?.businessId;

    if (!areasOfConcern) {
      return res.status(400).json({ success: false, error: "Areas of concern are required" });
    }

    const docResult = await query(
      `SELECT * FROM product_documentation WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );

    if (docResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Documentation not found" });
    }

    // Mark documentation as pending regeneration
    await query(
      `UPDATE product_documentation 
       SET status = 'pending',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );

    await query(
      `INSERT INTO product_documentation_jobs (business_id, user_id, idea_id, doc_id, job_type, areas_of_concern, status)
       VALUES ($1, $2, $3, $4, 'regenerate', $5, 'pending')`,
      [businessId, req.user?.userId, docResult.rows[0].idea_id, id, areasOfConcern]
    );

    const message = `Your request to regenerate product documentation is currently in process. You will receive an email notification once it's ready, then you can refresh your app to see the updated documentation.`;

    const response: ApiResponse<ProductDocumentation> = {
      success: true,
      data: docResult.rows[0],
    };

    res.status(202).json({
      ...response,
      message,
    } as any);
  } catch (error) {
    console.error("Regenerate documentation error:", error);
    res.status(500).json({ success: false, error: "failed to generate document" });
  }
}) as RequestHandler);

// Download PDF
router.get("/product-documentation/:id/pdf", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), (async (req: AuthenticatedRequest, res) => {
  /**
   * @swagger
   * /product-documentation/{id}/pdf:
   *   get:
   *     summary: Download product documentation as PDF
   *     tags: [Product Documentation]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: PDF file
   *         headers:
   *           Content-Type:
   *             schema:
   *               type: string
   *               example: application/pdf
   *           Content-Disposition:
   *             schema:
   *               type: string
   *               example: inline; filename="New_Idea_Documentation.pdf"
   *           Content-Length:
   *             schema:
   *               type: integer
   *           Accept-Ranges:
   *             schema:
   *               type: string
   *               example: bytes
   *         content:
   *           application/pdf:
   *             schema:
   *               type: string
   *               format: binary
   *       401:
   *         description: Unauthorized
   *       404:
   *         description: Documentation not found
   *       500:
   *         description: Server error
   */
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    const result = await query(
      `SELECT pd.*, u.name as owner_name, b.name as business_name
       FROM product_documentation pd
       LEFT JOIN users u ON pd.created_by = u.id
       LEFT JOIN businesses b ON pd.business_id = b.id
       WHERE pd.id = $1 AND pd.business_id = $2`,
      [id, businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Documentation not found" });
    }

    const doc = result.rows[0];
    const pdfBuffer = await generatePDF(doc, doc.business_name, doc.owner_name);

    res.type('application/pdf');
    res.set({
      "Content-Disposition": `attachment; filename="${doc.title.replace(/\s+/g, "_")}_Documentation.pdf"`,
      "Content-Length": pdfBuffer.length,
      "Accept-Ranges": "bytes",
    });

    res.send(pdfBuffer);
  } catch (error) {
    console.error("Generate PDF error:", error);
    res.status(500).json({ success: false, error: "Failed to generate PDF" });
  }
}) as RequestHandler);

router.post("/internal/jobs/product-docs/process", (async (req: AuthenticatedRequest, res) => {
  try {
    const limit = Number((req.body as any)?.limit) || 3;
    const result = await processPendingProductDocJobs(limit);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Process product doc jobs error:", error);
    res.status(500).json({ success: false, error: "Failed to process jobs" });
  }
}) as RequestHandler);

export default router;
