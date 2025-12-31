import express from "express";
import { authenticateToken } from "../middleware/auth";
import { getAllFees } from "../services/fees";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Fees
 *   description: Fee information for users
 */

/**
 * @swagger
 * /fees:
 *   get:
 *     summary: View applicable fees
 *     tags: [Fees]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of fees
 */
router.get("/", authenticateToken, async (req, res) => {
    try {
        const fees = await getAllFees();
        // Maybe filter or process for user view if needed?
        // For now, just return all active configs so UI can display them.
        res.json({ success: true, data: fees });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch fees" });
    }
});

export default router;
