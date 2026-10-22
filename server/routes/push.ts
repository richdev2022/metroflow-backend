import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { getVapidPublicKey } from "../services/webPush";

/**
 * Web Push (VAPID) subscription management for browsers.
 *
 * Clients (service worker + PushManager) subscribe with the public key from
 * GET /push/vapid-public-key and register the subscription here. The backend
 * then delivers incoming-call rings to browsers via web-push even when the
 * tab is closed.
 */

/**
 * @swagger
 * /push/subscribe:
 *   post:
 *     summary: Register a Web Push (VAPID) subscription for the authenticated user
 *     tags: [Push]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [endpoint, keys]
 *             properties:
 *               endpoint:
 *                 type: string
 *                 format: uri
 *               keys:
 *                 type: object
 *                 properties:
 *                   p256dh: { type: string }
 *                   auth: { type: string }
 *               userAgent:
 *                 type: string
 *     responses:
 *       200:
 *         description: Subscription saved (upsert by endpoint)
 */
export const subscribePush: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    // Accept BOTH wire shapes: the flat { endpoint, keys, userAgent } and the
    // nested { subscription: { endpoint, keys, ... } } that PushManager
    // subscribers naturally send (subscription.toJSON() wrapped). The first
    // production deploy only understood the flat shape and answered 400 to
    // every real browser client.
    const body = (req.body || {}) as Record<string, any>;
    const sub =
      body.subscription && typeof body.subscription === "object"
        ? (body.subscription as Record<string, any>)
        : body;
    const endpoint = sub.endpoint;
    const keys = sub.keys;
    const userAgent = sub.userAgent || body.userAgent;
    const p256dh = keys?.p256dh;
    const auth = keys?.auth;
    if (!endpoint || typeof endpoint !== "string" || !p256dh || !auth) {
      return res.status(400).json({
        success: false,
        error: "endpoint and keys.p256dh/keys.auth are required",
      });
    }

    // Upsert by endpoint: a browser re-subscribing (new keys, renewed push
    // subscription, same device switching accounts) must not duplicate rows.
    await query(
      `INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh_key, auth_key, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         p256dh_key = EXCLUDED.p256dh_key,
         auth_key = EXCLUDED.auth_key,
         user_agent = EXCLUDED.user_agent`,
      [userId, endpoint, String(p256dh), String(auth), userAgent || null],
    );

    const response: ApiResponse<{ subscribed: boolean }> = {
      success: true,
      data: { subscribed: true },
    };
    res.json(response);
  } catch (error) {
    console.error("Push subscribe error:", error);
    res.status(500).json({ success: false, error: "Failed to save push subscription" });
  }
};

/**
 * @swagger
 * /push/unsubscribe:
 *   post:
 *     summary: Remove a Web Push subscription (by endpoint) for the authenticated user
 *     tags: [Push]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               endpoint: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Subscription removed (or nothing to remove)
 */
export const unsubscribePush: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    // Accept flat { endpoint } AND nested { subscription: { endpoint } }.
    const body = (req.body || {}) as Record<string, any>;
    const sub =
      body.subscription && typeof body.subscription === "object"
        ? (body.subscription as Record<string, any>)
        : body;
    const endpoint = sub.endpoint;
    if (!endpoint || typeof endpoint !== "string") {
      return res.status(400).json({ success: false, error: "endpoint is required" });
    }

    await query(
      `DELETE FROM web_push_subscriptions WHERE endpoint = $1 AND user_id = $2`,
      [endpoint, userId],
    );

    const response: ApiResponse<{ subscribed: boolean }> = {
      success: true,
      data: { subscribed: false },
    };
    res.json(response);
  } catch (error) {
    console.error("Push unsubscribe error:", error);
    res.status(500).json({ success: false, error: "Failed to remove push subscription" });
  }
};

/**
 * @swagger
 * /push/vapid-public-key:
 *   get:
 *     summary: Web Push VAPID public key (for PushManager.subscribe)
 *     tags: [Push]
 *     responses:
 *       200:
 *         description: VAPID public key (or publicKey null when Web Push is unavailable)
 */
export const getVapidPublicKeyEndpoint: RequestHandler = async (_req, res) => {
  try {
    const publicKey = await getVapidPublicKey();
    const response: ApiResponse<{ publicKey: string | null }> = {
      success: true,
      data: { publicKey: publicKey || null },
    };
    res.json(response);
  } catch (error) {
    console.error("Get VAPID public key error:", error);
    res.json({ success: true, data: { publicKey: null } });
  }
};
