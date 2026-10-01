import express from "express";
import { query } from "../db";
import { isMaintenanceMode } from "../services/app-config";
import { postPublicMetricAiAsk } from "./ai";

/**
 * Public (unauthenticated) app configuration endpoint.
 * User apps poll this to know whether to show the maintenance screen and to
 * render the announcement ticker. No sensitive data is exposed.
 */
const router = express.Router();

/**
 * @swagger
 * /public/app-config:
 *   get:
 *     summary: Public app configuration (maintenance mode + active announcement)
 *     tags: [Public]
 *     security: []
 *     responses:
 *       200:
 *         description: Maintenance flag + latest active announcement
 */
router.get("/app-config", async (req, res) => {
  try {
    const maintenance = await isMaintenanceMode();

    let announcement: { id: string; title: string | null; message: string; updated_at: string } | null = null;
    try {
      const annRes = await query(
        `SELECT id, title, message, updated_at FROM announcements
         WHERE is_active = TRUE AND business_id IS NULL
         ORDER BY updated_at DESC LIMIT 1`,
      );
      if (annRes.rows.length > 0) {
        const row = annRes.rows[0];
        announcement = {
          id: row.id,
          title: row.title || null,
          message: row.message,
          updated_at: row.updated_at,
        };
      }
    } catch {
      // announcements table may not exist yet - ignore
    }

    res.json({
      success: true,
      data: {
        maintenance_mode: maintenance,
        announcement,
      },
    });
  } catch (error: any) {
    console.error("Public app-config error:", error.message);
    res.json({ success: true, data: { maintenance_mode: false, announcement: null } });
  }
});

// Public "Ask MetricAi" — help/support chat for ANY visitor (website widget).
// Sessions + rate limiting are handled inside the handler.
router.post("/metric-ai/ask", postPublicMetricAiAsk as any);

// ---------------------------------------------------------------------------
// Site growth (marketing site): wishlist + email subscriptions.
// Public (no auth) — consumed by metricorex.com forms. Email sending happens
// inline; failures never break the signup (the record is already persisted).
// ---------------------------------------------------------------------------

import {
  addToWishlist,
  addSubscriber,
  isValidEmail,
  SUBSCRIBER_CATEGORIES,
} from "../services/siteGrowth";

/**
 * @swagger
 * /public/wishlist:
 *   post:
 *     summary: Join the MetriCorex Personal wishlist
 *     tags: [Public]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               email: { type: string }
 *               features: { type: array, items: { type: string } }
 *               note: { type: string }
 *               productUpdates: { type: boolean }
 *     responses:
 *       200:
 *         description: Wishlist entry stored; confirmation email queued
 */
router.post("/wishlist", async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || "").trim();
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: "Please enter a valid email address" });
    }

    const entry = await addToWishlist({
      name: body.name,
      email,
      features: body.features,
      note: body.note,
      source: body.source || "website_personal",
    });

    // Wishlist joiners may opt into the monthly product-updates digest too.
    let subscribedUpdates = false;
    if (body.productUpdates === true) {
      try {
        await addSubscriber({
          name: body.name,
          email,
          categories: ["product_updates", "wishlist"],
          source: "website_personal",
        });
        subscribedUpdates = true;
      } catch (e: any) {
        console.error("Wishlist -> subscriber upsert failed:", e.message);
      }
    }

    res.json({
      success: true,
      message: "You're on the wishlist! Check your inbox for a confirmation email.",
      data: { id: entry.id, isNew: entry.isNew, emailSent: entry.emailSent, subscribedUpdates },
    });
  } catch (error: any) {
    console.error("Public wishlist error:", error.message);
    res.status(400).json({ success: false, error: error.message || "Could not join the wishlist" });
  }
});

/**
 * @swagger
 * /public/subscribe:
 *   post:
 *     summary: Subscribe to email categories (e.g. monthly product updates)
 *     tags: [Public]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               email: { type: string }
 *               categories: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Subscriber stored; welcome email queued
 */
router.post("/subscribe", async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || "").trim();
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: "Please enter a valid email address" });
    }

    const result = await addSubscriber({
      name: body.name,
      email,
      categories: body.categories,
      source: body.source || "website",
    });

    res.json({
      success: true,
      message: "Subscribed! Check your inbox for a welcome email.",
      data: { id: result.id, isNew: result.isNew, categories: result.categories, emailSent: result.emailSent },
    });
  } catch (error: any) {
    console.error("Public subscribe error:", error.message);
    res.status(400).json({ success: false, error: error.message || "Could not subscribe" });
  }
});

/** Public list of subscriber categories (so the site can render accurate copy). */
router.get("/subscribe/categories", (_req, res) => {
  res.json({ success: true, data: SUBSCRIBER_CATEGORIES });
});

export default router;
