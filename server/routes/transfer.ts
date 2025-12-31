import express from "express";
import { authenticateToken, checkSubscriptionStatus, AuthenticatedRequest } from "../middleware/auth";
import { createBulkTransfers, processTransfer } from "../services/transfer";
import { accountLookup } from "../services/squad";
import { query } from "../db";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Transfers
 *   description: Transfer management and payout
 */

/**
 * @swagger
 * /api/transfers/account-lookup:
 *   post:
 *     summary: Lookup account details
 *     tags: [Transfers]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - bank_code
 *               - account_number
 *             properties:
 *               bank_code:
 *                 type: string
 *               account_number:
 *                 type: string
 *     responses:
 *       200:
 *         description: Account details
 *       400:
 *         description: Bad request
 */
router.post("/account-lookup", authenticateToken, async (req, res) => {
  try {
    const { bank_code, account_number } = req.body;
    if (!bank_code || !account_number) {
      return res.status(400).json({ message: "Bank code and account number are required" });
    }
    const data = await accountLookup(bank_code, account_number);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @swagger
 * /api/transfers/bulk:
 *   post:
 *     summary: Initiate bulk transfer
 *     tags: [Transfers]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - transfers
 *             properties:
 *               transfers:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - recipient_account
 *                     - recipient_bank
 *                     - recipient_name
 *                     - amount
 *                   properties:
 *                     recipient_account:
 *                       type: string
 *                     recipient_bank:
 *                       type: string
 *                     recipient_name:
 *                       type: string
 *                     amount:
 *                       type: number
 *                     remark:
 *                       type: string
 *                     source_type:
 *                       type: string
 *                     source_id:
 *                       type: string
 *     responses:
 *       200:
 *         description: Transfers queued
 */
router.post("/bulk", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const { transfers } = req.body;
    const businessId = req.user!.businessId;

    if (!Array.isArray(transfers) || transfers.length === 0) {
      return res.status(400).json({ message: "Transfers array is required" });
    }

    const result = await createBulkTransfers(businessId, transfers);
    res.json({ message: "Transfers queued successfully", data: result });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @swagger
 * /api/transfers:
 *   get:
 *     summary: Get transfer history
 *     tags: [Transfers]
 *     responses:
 *       200:
 *         description: List of transfers
 */
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const result = await query(
      `SELECT * FROM transfer_queue WHERE business_id = $1 ORDER BY created_at DESC`,
      [businessId]
    );
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @swagger
 * /api/transfers/{id}/retry:
 *   post:
 *     summary: Retry a failed transfer
 *     tags: [Transfers]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Transfer retried
 */
router.post("/:id/retry", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const businessId = req.user!.businessId;

    // Verify ownership
    const check = await query(`SELECT * FROM transfer_queue WHERE id = $1 AND business_id = $2`, [id, businessId]);
    if (check.rows.length === 0) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    const result = await processTransfer(id);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
