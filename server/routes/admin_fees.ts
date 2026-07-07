import express from "express";
import { authenticateAdmin, requirePermission } from "../middleware/adminAuth";
import { createFee, deleteFee, getAllFees, updateFee } from "../services/fees";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Admin Fees
 *   description: Fee management for admins
 */

/**
 * @swagger
 * /admin/fees:
 *   get:
 *     summary: List all fee configurations
 *     tags: [Admin Fees]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of fees
 */
router.get("/", authenticateAdmin, requirePermission('manage_finance'), async (req, res) => {
    try {
        const fees = await getAllFees();
        res.json({ success: true, data: fees });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch fees" });
    }
});

/**
 * @swagger
 * /admin/fees:
 *   post:
 *     summary: Create a fee configuration
 *     tags: [Admin Fees]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - fee_type
 *               - config_type
 *               - config
 *             properties:
 *               name:
 *                 type: string
 *               fee_type:
 *                 type: string
 *                 enum: [funding_card, funding_account, transfer, otp, otp_sms, otp_whatsapp, stamp_duty]
 *               config_type:
 *                 type: string
 *                 enum: [percentage_cap, flat, flat_conditional, range]
 *               config:
 *                 type: object
 *               currency:
 *                 type: string
 *     responses:
 *       200:
 *         description: Fee created
 */
router.post("/", authenticateAdmin, requirePermission('manage_finance'), async (req, res) => {
    try {
        const fee = await createFee(req.body);
        res.json({ success: true, data: fee });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Failed to create fee" });
    }
});

/**
 * @swagger
 * /admin/fees/{id}:
 *   put:
 *     summary: Update a fee configuration
 *     tags: [Admin Fees]
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
 *             properties:
 *               name:
 *                 type: string
 *               fee_type:
 *                 type: string
 *               config_type:
 *                 type: string
 *               config:
 *                 type: object
 *               currency:
 *                 type: string
 *     responses:
 *       200:
 *         description: Fee updated
 */
router.put("/:id", authenticateAdmin, requirePermission('manage_finance'), async (req, res) => {
    try {
        const fee = await updateFee(req.params.id, req.body);
        res.json({ success: true, data: fee });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to update fee" });
    }
});

/**
 * @swagger
 * /admin/fees/{id}:
 *   delete:
 *     summary: Delete a fee configuration
 *     tags: [Admin Fees]
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
 *         description: Fee deleted
 */
router.delete("/:id", authenticateAdmin, requirePermission('manage_finance'), async (req, res) => {
    try {
        await deleteFee(req.params.id);
        res.json({ success: true, message: "Fee deleted" });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to delete fee" });
    }
});

export default router;
