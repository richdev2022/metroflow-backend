
import express from "express";
import { getProvider, getAvailableProviders } from "../services/providers/factory";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Providers
 *   description: Payment provider management endpoints
 */

/**
 * @swagger
 * /providers/requirements:
 *   get:
 *     summary: Get requirements for the active/default provider or a specific provider
 *     tags: [Providers]
 *     parameters:
 *       - in: query
 *         name: provider
 *         schema:
 *           type: string
 *         description: Specific provider to get requirements for (defaults to DEFAULT_PAYMENT_PROVIDER)
 *     responses:
 *       200:
 *         description: Provider requirements
 */
router.get("/requirements", (req, res) => {
  try {
    const providerName = req.query.provider as string | undefined;
    const provider = getProvider(providerName);
    const requirements = provider.getRequirements();

    res.json({
      success: true,
      data: {
        provider: provider.name,
        ...requirements,
      },
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /providers/list:
 *   get:
 *     summary: Get list of available payment providers
 *     tags: [Providers]
 *     responses:
 *       200:
 *         description: List of providers
 */
router.get("/list", (req, res) => {
  res.json({
    success: true,
    data: {
      providers: getAvailableProviders(),
      defaultProvider: process.env.DEFAULT_PAYMENT_PROVIDER || "squad",
    },
  });
});

export default router;
