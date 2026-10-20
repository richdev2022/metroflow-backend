import express from "express";
import { query } from "../db";
import { isMaintenanceMode, getSetting } from "../services/app-config";
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
// Mobile app update check (public — called by the Flutter app on login and
// app start, with or without a session). Compares the caller's version code
// (build number) against the newest ACTIVE release row for the platform.
// NEVER returns 5xx to the client on data problems: the mobile side treats
// any failure as "no update" and stays silent, so a soft success response
// keeps old app builds fully functional even before the table exists.
// ---------------------------------------------------------------------------

/** Semver-ish compare of "1.2.3" strings; returns >0 if a > b, 0 if equal. */
function compareVersionNames(a: string, b: string): number {
  const pa = String(a || "").trim().split(/[.\-+_]/).map((s) => parseInt(s, 10) || 0);
  const pb = String(b || "").trim().split(/[.\-+_]/).map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * @swagger
 * /public/app-updates/check:
 *   get:
 *     summary: Check whether a newer mobile app release is available
 *     tags: [Public]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: platform
 *         schema: { type: string, enum: [ios, android] }
 *       - in: query
 *         name: current_version_code
 *         schema: { type: integer }
 *       - in: query
 *         name: current_version_name
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Update availability + release metadata (always 200)
 */
/**
 * GET /public/app-links
 * Mobile app download links configured by admins (system_settings), with a
 * fallback to the latest active release store_url per platform. Consumed by
 * the marketing site "Download our mobile app" sections and the web meeting
 * interstitial. No sensitive data is exposed.
 */
router.get("/app-links", async (req, res) => {
  try {
    let [appStoreUrl, playStoreUrl] = await Promise.all([
      getSetting("app_store_url"),
      getSetting("play_store_url"),
    ]);

    // Fallback: per-platform store_url from the newest active app release.
    if (!appStoreUrl || !playStoreUrl) {
      try {
        const relRes = await query(
          `SELECT platform, store_url FROM app_versions
           WHERE is_active = TRUE AND store_url IS NOT NULL AND store_url <> ''
           ORDER BY version_code DESC`,
        );
        for (const row of relRes.rows) {
          if (!appStoreUrl && row.platform === "ios" && /^https?:\/\//i.test(row.store_url)) {
            appStoreUrl = row.store_url;
          }
          if (!playStoreUrl && row.platform === "android" && /^(https?:\/\/|market:\/\/)/i.test(row.store_url)) {
            playStoreUrl = row.store_url;
          }
        }
      } catch { /* app_versions may not exist yet — settings only is fine */ }
    }

    // Direct-APK download (site fallback when the Play Store is unavailable).
    // Exposed from the newest active android release that carries an APK.
    let apkUrl: string | null = null;
    let apkVersionName: string | null = null;
    let apkVersionCode: number | null = null;
    let apkSizeBytes: number | null = null;
    try {
      const apkRes = await query(
        `SELECT apk_url, apk_size_bytes, version_name, version_code FROM app_versions
          WHERE platform = 'android' AND is_active = TRUE AND apk_url IS NOT NULL
          ORDER BY version_code DESC LIMIT 1`,
      );
      if (apkRes.rows.length > 0) {
        apkUrl = apkRes.rows[0].apk_url;
        apkSizeBytes = apkRes.rows[0].apk_size_bytes ? parseInt(apkRes.rows[0].apk_size_bytes, 10) : null;
        apkVersionName = apkRes.rows[0].version_name || null;
        apkVersionCode = apkRes.rows[0].version_code || null;
      }
    } catch { /* apk columns may not exist yet */ }

    res.json({
      success: true,
      data: {
        app_store_url: appStoreUrl || null,
        play_store_url: playStoreUrl || null,
        apk_url: apkUrl,
        apk_version_name: apkVersionName,
        apk_version_code: apkVersionCode,
        apk_size_bytes: apkSizeBytes,
      },
    });
  } catch (error: any) {
    console.error("Public app-links error:", error.message);
    res.json({ success: true, data: { app_store_url: null, play_store_url: null, apk_url: null } });
  }
});

/**
 * GET /public/app-flags
 * Public app-availability toggles (admin-controlled, no PII). The marketing
 * site swaps the wishlist section for real app CTAs based on these flags;
 * the apps themselves also gate personal/business-only features on them.
 */
router.get("/app-flags", async (_req, res) => {
  try {
    const [businessEnabled, personalEnabled] = await Promise.all([
      getSetting("business_app_enabled", "true"),
      getSetting("personal_app_enabled", "false"),
    ]);
    res.set("Cache-Control", "public, max-age=60");
    res.json({
      success: true,
      data: {
        business_app_enabled: String(businessEnabled || "true").toLowerCase() !== "false",
        personal_app_enabled: String(personalEnabled || "false").toLowerCase() === "true",
      },
    });
  } catch (error: any) {
    console.error("Public app-flags error:", error.message);
    res.json({ success: true, data: { business_app_enabled: true, personal_app_enabled: false } });
  }
});

router.get("/app-updates/check", async (req, res) => {
  const platform = String(req.query.platform || "android").toLowerCase().trim();
  const currentVersionName = String(req.query.current_version_name || "").trim();
  const currentVersionCodeRaw = parseInt(String(req.query.current_version_code || ""), 10);
  const hasCode = Number.isFinite(currentVersionCodeRaw) && currentVersionCodeRaw > 0;

  const noUpdate = {
    update_available: false,
    update_required: false,
    force_update: false,
    platform,
    current: { version_name: currentVersionName || null, version_code: hasCode ? currentVersionCodeRaw : null },
    latest: null as Record<string, unknown> | null,
    min_supported_version_code: null as number | null,
  };

  try {
    if (platform !== "ios" && platform !== "android") {
      return res.status(400).json({ success: false, error: "platform must be 'ios' or 'android'" });
    }

    let latest: Record<string, any> | null = null;
    let minSupported: number | null = null;
    try {
      const latestRes = await query(
        `SELECT id, platform, version_name, version_code, force_update,
                min_supported_version_code, release_notes, store_url, created_at, updated_at
         FROM app_versions
         WHERE platform = $1 AND is_active = TRUE
         ORDER BY version_code DESC
         LIMIT 1`,
        [platform],
      );
      latest = latestRes.rows[0] || null;
      const minRes = await query(
        `SELECT MAX(min_supported_version_code) AS min_code
         FROM app_versions
         WHERE platform = $1 AND is_active = TRUE AND min_supported_version_code IS NOT NULL`,
        [platform],
      );
      minSupported = minRes.rows[0]?.min_code != null ? Number(minRes.rows[0].min_code) : null;
    } catch (tableErr: any) {
      // app_versions not migrated yet — behave as "no update" (never block clients).
      console.error("Public app-updates/check schema error:", tableErr.message);
      return res.json({ success: true, data: noUpdate });
    }

    if (!latest) {
      return res.json({ success: true, data: noUpdate });
    }

    // Primary comparison: monotonic integer version code (build number).
    // Fallback: semver-ish compare of the names when the caller has no code.
    let updateAvailable = false;
    if (hasCode) {
      updateAvailable = Number(latest.version_code) > currentVersionCodeRaw;
    } else if (currentVersionName) {
      updateAvailable = compareVersionNames(latest.version_name, currentVersionName) > 0;
    }

    const belowFloor = hasCode && minSupported != null && currentVersionCodeRaw < minSupported;
    const updateRequired = updateAvailable && (latest.force_update === true || belowFloor === true);

    return res.json({
      success: true,
      data: {
        update_available: updateAvailable,
        update_required: updateRequired,
        force_update: updateRequired,
        platform,
        current: {
          version_name: currentVersionName || null,
          version_code: hasCode ? currentVersionCodeRaw : null,
        },
        latest: {
          id: latest.id,
          version_name: latest.version_name,
          version_code: Number(latest.version_code),
          force_update: latest.force_update === true,
          release_notes: latest.release_notes || null,
          store_url: latest.store_url || null,
          updated_at: latest.updated_at,
        },
        min_supported_version_code: minSupported,
      },
    });
  } catch (error: any) {
    console.error("Public app-updates/check error:", error.message);
    // Soft-success keeps every client silent instead of erroring.
    res.json({ success: true, data: noUpdate });
  }
});

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

// ---------------------------------------------------------------------------
// Account deletion requests (GDPR erasure flow) — used by the marketing site
// at metricorex.com/delete-account. Unauthenticated by design; the flow is
// protected by email confirmation + rate limiting instead. The response is
// deliberately generic (anti-enumeration): it never reveals whether the
// address has an account.
// ---------------------------------------------------------------------------
import {
  createDeletionRequest,
  confirmDeletionRequest,
  isRateLimited,
} from "../lib/account-deletion";

const clientIp = (req: express.Request): string =>
  (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
  req.socket.remoteAddress ||
  "unknown";

router.post("/account-deletion/request", async (req, res) => {
  try {
    const ip = clientIp(req);
    if (isRateLimited(`adr:${ip}`, 5, 10 * 60 * 1000)) {
      return res.status(429).json({ success: false, error: "Too many requests — try again later." });
    }
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
    if (!email) {
      return res.status(400).json({ success: false, error: "email is required" });
    }
    const result = await createDeletionRequest(email, reason, ip);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: "Please provide a valid email address." });
    }
    // Same message for known and unknown addresses (no account enumeration).
    res.json({
      success: true,
      message: "If an account exists for this address, a confirmation email has been sent.",
    });
  } catch (error: any) {
    console.error("Account deletion request error:", error?.message || error);
    res.status(500).json({ success: false, error: "Could not process the request" });
  }
});

router.post("/account-deletion/confirm", async (req, res) => {
  try {
    const ip = clientIp(req);
    if (isRateLimited(`adc:${ip}`, 20, 10 * 60 * 1000)) {
      return res.status(429).json({ success: false, error: "Too many requests — try again later." });
    }
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const result = await confirmDeletionRequest(token);
    if (!result.ok) {
      const friendly: Record<string, string> = {
        invalid_token: "This confirmation link is invalid.",
        expired: "This confirmation link has expired — please submit the request again.",
      };
      const generic = result.error?.startsWith("already_")
        ? "This request was already confirmed."
        : undefined;
      return res.status(400).json({
        success: false,
        error: friendly[result.error || ""] || generic || "This confirmation link is invalid or the request was already processed.",
      });
    }
    res.json({
      success: true,
      message: "Request confirmed. Our team will process your account deletion.",
    });
  } catch (error: any) {
    console.error("Account deletion confirm error:", error?.message || error);
    res.status(500).json({ success: false, error: "Could not confirm the request" });
  }
});

export default router;
