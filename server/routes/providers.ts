
import express from "express";
import {
  getProvider,
  getAvailableProviders,
  getActiveProviderName,
  getProviderConfigStatus,
} from "../services/providers/factory";

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
router.get("/list", async (req, res) => {
  try {
    const activeProvider = await getActiveProviderName();
    res.json({
      success: true,
      data: {
        providers: getAvailableProviders(),
        defaultProvider: activeProvider,
        activeProvider,
        configStatus: getProviderConfigStatus(),
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /providers/checkout-config:
 *   get:
 *     summary: Get client-side checkout configuration for the active provider
 *     description: >
 *       Public endpoint. Returns the client-side configuration the web/mobile
 *       apps need to launch checkout with the active provider. For Flutterwave
 *       this includes the PUBLIC key (used by inline checkout v3.js and the
 *       mobile SDKs). Secret keys are never returned.
 *     tags: [Providers]
 *     responses:
 *       200:
 *         description: Checkout config for the active provider
 */
router.get("/checkout-config", async (req, res) => {
  try {
    const activeProvider = await getActiveProviderName();

    if (activeProvider === "flutterwave") {
      const { getFlutterwavePublicKey } = await import("../services/providers/flutterwave");
      const publicKey = getFlutterwavePublicKey();
      if (!publicKey) {
        return res.status(503).json({
          success: false,
          error: "Flutterwave is active but FLW_PUBLIC_KEY is not configured on the server",
        });
      }
      return res.json({
        success: true,
        data: { provider: "flutterwave", publicKey },
      });
    }

    // Squad/Monnify use server-side hosted checkout only - no client key needed
    return res.json({
      success: true,
      data: { provider: activeProvider, publicKey: null },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
