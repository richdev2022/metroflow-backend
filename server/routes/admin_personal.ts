import express from "express";
import { query } from "../db";
import { AuthenticatedAdminRequest } from "../middleware/adminAuth";
import { requirePermission } from "../middleware/adminAuth";
import { getSetting, setSetting } from "../services/app-config";
import { getBoostPricing } from "../features/personal/routes/social";

/**
 * ADMIN — Personal app management (mounted under /admin/personal).
 *
 *   GET  /admin/personal/overview                  → KPIs across personal features
 *   GET/PUT /admin/personal/boost-pricing          → boost engine pricing (system_settings)
 *   GET  /admin/personal/boosts?status=            → all boost orders
 *   POST /admin/personal/boosts/:id/pause|resume|cancel
 *   GET  /admin/personal/social/posts?flagged=1    → moderation queue (recent + most reported)
 *   POST /admin/personal/social/posts/:id/remove|restore
 *   GET  /admin/personal/social/polls?status=
 *   POST /admin/personal/social/polls/:id/remove|restore
 *   GET  /admin/personal/live/sessions?status=
 *   POST /admin/personal/live/sessions/:id/end
 *   GET  /admin/personal/marketplace/listings?status=
 *   POST /admin/personal/marketplace/listings/:id/approve|remove|suspend
 *   GET  /admin/personal/marketplace/orders
 *   GET  /admin/personal/giftcards/sell | /buy     → provider trade ledgers
 *   GET/PUT /admin/personal/service-flags          → global personal feature kill-switches
 */

const router = express.Router();

const adminOf = (req: AuthenticatedAdminRequest) => req.admin?.adminId ?? "admin";

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
router.get("/overview", requirePermission("view_dashboard"), async (_req, res) => {
  try {
    const [users, posts, polls, live, listings, orders, boosts, gcSell, gcBuy, crypto] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM users WHERE account_type = 'personal'`),
      query(`SELECT COUNT(*)::int AS n FROM social_posts WHERE status = 'active'`),
      query(`SELECT COUNT(*)::int AS n FROM social_polls WHERE status = 'active'`),
      query(`SELECT COUNT(*)::int AS n FROM live_sessions WHERE status = 'live'`),
      query(`SELECT COUNT(*)::int AS n FROM market_listings WHERE status = 'active'`),
      query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::float AS gmv FROM market_orders WHERE status IN ('paid','shipped','completed')`),
      query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(budget),0)::float AS spend FROM boost_orders WHERE status = 'active'`),
      query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(payout_amount),0)::float AS payout FROM giftcard_sell_trades WHERE status = 'settled'`),
      query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_charged),0)::float AS gmv FROM giftcard_buy_orders WHERE status = 'completed'`),
      query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(settlement_amount),0)::float AS gmv FROM crypto_sales WHERE status = 'completed'`),
    ]);
    res.json({
      success: true,
      data: {
        personal_users: users.rows[0].n,
        posts: posts.rows[0].n,
        polls: polls.rows[0].n,
        live_streams: live.rows[0].n,
        listings: listings.rows[0].n,
        marketplace_orders: orders.rows[0].n,
        marketplace_gmv: orders.rows[0].gmv,
        active_boosts: boosts.rows[0].n,
        boost_spend: boosts.rows[0].spend,
        giftcard_sells_settled: gcSell.rows[0].n,
        giftcard_sell_payout: gcSell.rows[0].payout,
        giftcard_buys: gcBuy.rows[0].n,
        giftcard_buy_gmv: gcBuy.rows[0].gmv,
        crypto_sales: crypto.rows[0].n,
        crypto_gmv: crypto.rows[0].gmv,
      },
    });
  } catch (e: any) {
    console.error("[admin/personal/overview]", e?.message);
    res.status(500).json({ success: false, error: "Could not load personal overview" });
  }
});

// ---------------------------------------------------------------------------
// Boost pricing + orders
// ---------------------------------------------------------------------------
router.get("/boost-pricing", requirePermission("manage_settings"), async (_req, res) => {
  res.json({ success: true, data: await getBoostPricing() });
});

router.put("/boost-pricing", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const body = req.body || {};
    const current = await getBoostPricing();
    const next = {
      ...current,
      ...(body.currency ? { currency: String(body.currency) } : {}),
      ...(body.post ? { post: { ...current.post, ...body.post } } : {}),
      ...(body.listing ? { listing: { ...current.listing, ...body.listing } } : {}),
      ...(body.audience_multiplier ? { audience_multiplier: { ...current.audience_multiplier, ...body.audience_multiplier } } : {}),
      ...(body.engagement_boost_factor != null ? { engagement_boost_factor: Number(body.engagement_boost_factor) } : {}),
    };
    await setSetting("personal_boost_pricing", JSON.stringify(next), "Boost engine pricing for posts + marketplace listings (personal app)");
    res.json({ success: true, data: next });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not save boost pricing" });
  }
});

router.get("/boosts", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const status = String(req.query.status || "");
    const params: any[] = [];
    let where = "TRUE";
    if (status) { params.push(status); where = `b.status = $1`; }
    const r = await query(
      `SELECT b.*, u.name AS user_name, u.email AS user_email,
              CASE b.target_type WHEN 'post' THEN (SELECT body FROM social_posts WHERE id = b.target_id)
                                 ELSE (SELECT name FROM market_listings WHERE id = b.target_id) END AS target_label
       FROM boost_orders b JOIN users u ON u.id = b.user_id
       WHERE ${where} ORDER BY b.created_at DESC LIMIT 200`,
      params,
    );
    res.json({ success: true, data: { boosts: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load boosts" });
  }
});

router.post("/boosts/:id/:action", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    if (!["pause", "resume", "cancel"].includes(String(req.params.action))) return res.status(400).json({ success: false, error: "Unknown action" });
    const status = req.params.action === "pause" ? "paused" : req.params.action === "resume" ? "active" : "cancelled";
    const r = await query(
      `UPDATE boost_orders SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, status`,
      [String(req.params.id), status],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Boost not found" });
    res.json({ success: true, data: r.rows[0] });
  } catch {
    res.status(500).json({ success: false, error: "Could not update boost" });
  }
});

// ---------------------------------------------------------------------------
// Social moderation
// ---------------------------------------------------------------------------
router.get("/social/posts", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const status = String(req.query.status || "active");
    const r = await query(
      `SELECT p.*, u.name AS author_name, u.email AS author_email,
              (SELECT COUNT(*)::int FROM social_reactions r2 WHERE r2.post_id = p.id) AS like_count,
              (SELECT COUNT(*)::int FROM social_comments c WHERE c.post_id = p.id) AS comment_count
       FROM social_posts p JOIN users u ON u.id = p.user_id
       WHERE p.status = $1 ORDER BY p.created_at DESC LIMIT 200`,
      [status],
    );
    res.json({ success: true, data: { posts: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load posts" });
  }
});

router.post("/social/posts/:id/:action", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    if (!["remove", "restore"].includes(String(req.params.action))) return res.status(400).json({ success: false, error: "Unknown action" });
    const status = req.params.action === "remove" ? "removed" : "active";
    const reason = req.params.action === "remove" ? String(req.body?.reason || "Removed by platform moderation").slice(0, 300) : null;
    const r = await query(
      `UPDATE social_posts SET status = $2, removed_reason = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id`,
      [String(req.params.id), status, reason],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Post not found" });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Could not moderate post" });
  }
});

router.get("/social/polls", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const status = String(req.query.status || "active");
    const r = await query(
      `SELECT pl.*, u.name AS author_name, u.email AS author_email
       FROM social_polls pl JOIN users u ON u.id = pl.user_id
       WHERE pl.status = $1 ORDER BY pl.created_at DESC LIMIT 200`,
      [status],
    );
    res.json({ success: true, data: { polls: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load polls" });
  }
});

router.post("/social/polls/:id/:action", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    if (!["remove", "restore"].includes(String(req.params.action))) return res.status(400).json({ success: false, error: "Unknown action" });
    const status = req.params.action === "remove" ? "removed" : "active";
    const r = await query(
      `UPDATE social_polls SET status = $2 WHERE id = $1 RETURNING id`,
      [String(req.params.id), status],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Poll not found" });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Could not moderate poll" });
  }
});

// ---------------------------------------------------------------------------
// Live moderation
// ---------------------------------------------------------------------------
router.get("/live/sessions", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const status = String(req.query.status || "live");
    const r = await query(
      `SELECT l.*, u.name AS host_name, u.email AS host_email
       FROM live_sessions l JOIN users u ON u.id = l.host_id
       WHERE l.status = $1 ORDER BY l.started_at DESC LIMIT 200`,
      [status],
    );
    res.json({ success: true, data: { sessions: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load streams" });
  }
});

router.post("/live/sessions/:id/end", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const r = await query(
      `UPDATE live_sessions SET status = 'removed', ended_at = CURRENT_TIMESTAMP, current_viewers = 0 WHERE id = $1 RETURNING id`,
      [String(req.params.id)],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Stream not found" });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Could not end stream" });
  }
});

// ---------------------------------------------------------------------------
// Marketplace management
// ---------------------------------------------------------------------------
router.get("/marketplace/listings", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const status = String(req.query.status || "active");
    const r = await query(
      `SELECT l.*, u.name AS seller_name, u.email AS seller_email
       FROM market_listings l JOIN users u ON u.id = l.seller_id
       WHERE l.status = $1 ORDER BY l.created_at DESC LIMIT 200`,
      [status],
    );
    res.json({ success: true, data: { listings: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load listings" });
  }
});

router.post("/marketplace/listings/:id/:action", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    if (!["remove", "suspend", "restore"].includes(String(req.params.action))) return res.status(400).json({ success: false, error: "Unknown action" });
    const status = req.params.action === "remove" ? "removed" : req.params.action === "suspend" ? "suspended" : "active";
    const reason = req.params.action !== "restore" ? String(req.body?.reason || `Listing ${req.params.action}d by moderation`).slice(0, 300) : null;
    const r = await query(
      `UPDATE market_listings SET status = $2, removed_reason = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id`,
      [String(req.params.id), status, reason],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Listing not found" });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Could not moderate listing" });
  }
});

router.get("/marketplace/orders", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const r = await query(
      `SELECT o.*, l.name AS listing_name, ub.name AS buyer_name, us.name AS seller_name
       FROM market_orders o
       JOIN market_listings l ON l.id = o.listing_id
       JOIN users ub ON ub.id = o.buyer_id
       JOIN users us ON us.id = o.seller_id
       ORDER BY o.created_at DESC LIMIT 200`,
    );
    res.json({ success: true, data: { orders: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load orders" });
  }
});

// ---------------------------------------------------------------------------
// Gift card trade ledgers
// ---------------------------------------------------------------------------
router.get("/giftcards/sell", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const r = await query(
      `SELECT t.*, u.name AS user_name, u.email AS user_email
       FROM giftcard_sell_trades t JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC LIMIT 200`,
    );
    res.json({ success: true, data: { trades: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load sell trades" });
  }
});

router.get("/giftcards/buy", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const r = await query(
      `SELECT o.*, u.name AS user_name, u.email AS user_email
       FROM giftcard_buy_orders o JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC LIMIT 200`,
    );
    res.json({ success: true, data: { orders: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load buy orders" });
  }
});

// ---------------------------------------------------------------------------
// Personal service flags (global kill-switches)
// ---------------------------------------------------------------------------
router.get("/service-flags", requirePermission("manage_settings"), async (_req, res) => {
  const raw = await getSetting("personal_service_flags", "");
  let flags: Record<string, boolean> = {};
  try { flags = raw ? JSON.parse(raw) : {}; } catch { flags = {}; }
  res.json({ success: true, data: { bills: true, savings: true, giftcards: true, esim: true, virtualcards: true, crypto: true, social: true, live: true, marketplace: true, swap: true, ...flags } });
});

router.put("/service-flags", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const allowed = ["bills", "savings", "giftcards", "esim", "virtualcards", "crypto", "social", "live", "marketplace", "swap"];
    const body = req.body || {};
    const currentRaw = await getSetting("personal_service_flags", "");
    let flags: Record<string, boolean> = {};
    try { flags = currentRaw ? JSON.parse(currentRaw) : {}; } catch { flags = {}; }
    for (const k of allowed) {
      if (typeof body[k] === "boolean") flags[k] = body[k];
    }
    await setSetting("personal_service_flags", JSON.stringify(flags), "Personal app feature kill-switches");
    res.json({ success: true, data: flags });
  } catch {
    res.status(500).json({ success: false, error: "Could not save service flags" });
  }
});

export default router;
