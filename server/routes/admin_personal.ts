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
 *   GET  /admin/personal/donations?status=&q=      → all fundraisers + stats
 *   GET/PUT /admin/personal/donations/settings     → donation economics (system_settings)
 *   GET  /admin/personal/donations/:id/contributions → donor drill-down
 *   POST /admin/personal/donations/:id/suspend|activate|end
 *   GET/PUT /admin/personal/service-flags          → global personal feature kill-switches
 */

const router = express.Router();

const adminOf = (req: AuthenticatedAdminRequest) => req.admin?.adminId ?? "admin";

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
router.get("/overview", requirePermission("view_dashboard"), async (_req, res) => {
  try {
    const [users, posts, polls, live, listings, orders, boosts, gcSell, gcBuy, crypto, donations] = await Promise.all([
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
      query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_raised),0)::float AS raised, COALESCE(SUM(amount_redeemed),0)::float AS redeemed FROM donations`),
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
        donations: donations.rows[0].n,
        donations_raised: donations.rows[0].raised,
        donations_redeemed: donations.rows[0].redeemed,
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

// ---------------------------------------------------------------------------
// Post reports — community moderation queue + decisions
//   GET  /admin/personal/social/post-reports?status=pending|actioned|dismissed
//   POST /admin/personal/social/post-reports/:id/decision  { decision, note? }
//     decision: remove_post | dismiss | warn_user
// ---------------------------------------------------------------------------
router.get("/social/post-reports", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const status = String(req.query.status || "pending");
    if (!["pending", "actioned", "dismissed", "all"].includes(status)) {
      return res.status(400).json({ success: false, error: "Unknown status filter" });
    }
    const where = status === "all" ? "TRUE" : `r.status = $1`;
    const params: any[] = status === "all" ? [] : [status];
    const r = await query(
      `SELECT r.id, r.post_id, r.reason, r.details, r.status, r.decision, r.decision_note,
              r.decided_by, r.decided_at, r.created_at,
              p.body AS post_body, p.image_url AS post_image, p.video_url AS post_video,
              p.status AS post_status, p.created_at AS post_created_at,
              author.id AS author_id, author.name AS author_name, author.email AS author_email,
              reporter.id AS reporter_id, reporter.name AS reporter_name,
              (SELECT COUNT(*)::int FROM social_post_reports r2 WHERE r2.post_id = r.post_id) AS report_count
       FROM social_post_reports r
       JOIN social_posts p ON p.id = r.post_id
       JOIN users author ON author.id = p.user_id
       JOIN users reporter ON reporter.id = r.reporter_id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT 200`,
      params,
    );
    const counts = await query(
      `SELECT status, COUNT(*)::int AS n FROM social_post_reports GROUP BY status`,
    );
    res.json({
      success: true,
      data: {
        reports: r.rows,
        counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])),
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load reports" });
  }
});

router.post("/social/post-reports/:id/decision", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const decision = String(req.body?.decision || "");
    const note = String(req.body?.note || "").slice(0, 500);
    if (!["remove_post", "dismiss", "warn_user"].includes(decision)) {
      return res.status(400).json({ success: false, error: "decision must be remove_post | dismiss | warn_user" });
    }
    const report = await query(
      `SELECT r.id, r.post_id, r.status, p.user_id AS author_id, p.status AS post_status
       FROM social_post_reports r JOIN social_posts p ON p.id = r.post_id WHERE r.id = $1`,
      [String(req.params.id)],
    );
    if (!report.rows.length) return res.status(404).json({ success: false, error: "Report not found" });
    const rep = report.rows[0];
    if (rep.status !== "pending") return res.status(400).json({ success: false, error: "This report was already decided" });

    if (decision === "remove_post") {
      await query(
        `UPDATE social_posts SET status = 'removed', removed_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [rep.post_id, note || "Removed after community reports — platform moderation"],
      );
    } else if (decision === "warn_user") {
      // Notify the author with a moderation warning (keep the post up).
      await query(
        `INSERT INTO notifications (user_id, type, title, message, is_actionable, expires_at)
         VALUES ($1, 'moderation', $2, $3, false, NOW() + INTERVAL '30 days')`,
        [
          rep.author_id,
          "Community guidelines warning",
          note || "Your recent post was reported by the community. Please review our community guidelines — repeated violations may lead to removal.",
        ],
      );
    }
    // Decision closes ALL pending reports on the same post (one bad post,
    // many reporters — they all get resolved by this decision).
    const statusMap: Record<string, string> = { remove_post: "actioned", warn_user: "actioned", dismiss: "dismissed" };
    await query(
      `UPDATE social_post_reports
       SET status = $2, decision = $3, decision_note = $4, decided_by = $5, decided_at = CURRENT_TIMESTAMP
       WHERE post_id = $1 AND status = 'pending'`,
      [rep.post_id, statusMap[decision], decision, note || null, adminOf(req)],
    );
    res.json({ success: true, data: { decision } });
  } catch {
    res.status(500).json({ success: false, error: "Could not apply the decision" });
  }
});

router.get("/social/polls", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const status = String(req.query.status || "active");
    const r = await query(
      `SELECT pl.*, u.name AS author_name, u.email AS author_email,
              (SELECT COUNT(*)::int FROM social_poll_votes v WHERE v.poll_id = pl.id) AS vote_count,
              COALESCE((SELECT SUM(v.amount_paid) FROM social_poll_votes v WHERE v.poll_id = pl.id), 0)::float AS pool_collected
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
    const action = String(req.params.action);
    if (!"remove,restore,close".split(",").includes(action)) return res.status(400).json({ success: false, error: "Unknown action" });
    if (action === "close") {
      // Force-mature a paid poll so the creator can withdraw (admin moderation).
      const c = await query(
        `UPDATE social_polls SET status = 'closed', ends_at = LEAST(COALESCE(ends_at, NOW()), NOW()), updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'active' RETURNING id`,
        [String(req.params.id)],
      );
      if (!c.rows.length) return res.status(404).json({ success: false, error: "Poll not found (or already closed)" });
      return res.json({ success: true });
    }
    const status = action === "remove" ? "removed" : "active";
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
// Donations (fundraising) — management + economics
// ---------------------------------------------------------------------------
router.get("/donations", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const { status, q } = req.query as Record<string, string | undefined>;
    const params: any[] = [];
    let where = "TRUE";
    if (status && ["active", "ended", "suspended"].includes(status)) {
      params.push(status); where = `d.status = $1`;
    }
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim().toLowerCase()}%`);
      where += ` AND (LOWER(d.title) LIKE $${params.length} OR LOWER(u.name) LIKE $${params.length} OR LOWER(u.email) LIKE $${params.length})`;
    }
    const [rows, stats] = await Promise.all([
      query(
        `SELECT d.*, u.name AS creator_name, u.email AS creator_email,
                LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS creator_username,
                (SELECT COUNT(*)::int FROM donation_contributions c WHERE c.donation_id = d.id AND c.status = 'success') AS donors_count
         FROM donations d JOIN users u ON u.id = d.creator_id
         WHERE ${where} ORDER BY d.created_at DESC LIMIT 200`,
        params,
      ),
      query(
        `SELECT COUNT(*)::int AS n,
                COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END),0)::int AS active_n,
                COALESCE(SUM(amount_raised),0)::float AS raised,
                COALESCE(SUM(amount_redeemed),0)::float AS redeemed
         FROM donations`,
      ),
    ]);
    res.json({ success: true, data: { donations: rows.rows, stats: stats.rows[0] } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load donations" });
  }
});

router.get("/donations/settings", requirePermission("manage_settings"), async (_req, res) => {
  try {
    const raw = await getSetting("donation_settings", "");
    let settings: Record<string, any> = {};
    try { settings = raw ? JSON.parse(raw) : {}; } catch { settings = {}; }
    res.json({
      success: true,
      data: {
        currency: "NGN", min_donation: 100, max_donation: 5000000,
        contribution_fee_percent: 0, contribution_fee_flat: 0,
        redemption_fee_percent: 5, redemption_fee_flat: 0,
        redemption_min: 1000, max_active_per_user: 5,
        ...settings,
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load donation settings" });
  }
});

router.put("/donations/settings", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const body = req.body || {};
    const numericKeys = [
      "min_donation", "max_donation", "contribution_fee_percent", "contribution_fee_flat",
      "redemption_fee_percent", "redemption_fee_flat", "redemption_min", "max_active_per_user",
    ] as const;
    const raw = await getSetting("donation_settings", "");
    let current: Record<string, any> = {};
    try { current = raw ? JSON.parse(raw) : {}; } catch { current = {}; }
    const next: Record<string, any> = { ...current };
    for (const k of numericKeys) {
      if (body[k] !== undefined && body[k] !== null && body[k] !== "") {
        const n = Number(body[k]);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ success: false, error: `${k} must be a non-negative number` });
        }
        next[k] = Math.round(n * 100) / 100;
      }
    }
    if (next.min_donation != null && next.max_donation != null && next.min_donation > next.max_donation) {
      return res.status(400).json({ success: false, error: "min_donation cannot exceed max_donation" });
    }
    await setSetting("donation_settings", JSON.stringify(next), "Donation economics: contribution bounds + fees (personal app)");
    res.json({ success: true, data: next });
  } catch {
    res.status(500).json({ success: false, error: "Could not save donation settings" });
  }
});

router.get("/donations/:id/contributions", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const r = await query(
      `SELECT c.*, u.name AS donor_name, u.email AS donor_email,
              LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS donor_username
       FROM donation_contributions c JOIN users u ON u.id = c.donor_id
       WHERE c.donation_id = $1 ORDER BY c.created_at DESC LIMIT 200`,
      [req.params.id],
    );
    res.json({ success: true, data: { contributions: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load contributions" });
  }
});

router.post("/donations/:id/:action", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const action = String(req.params.action);
    const map: Record<string, { status?: string; reason?: string }> = {
      suspend: { status: "suspended", reason: String(req.body?.reason || "Suspended by admin") },
      activate: { status: "active" },
      end: { status: "ended" },
    };
    const target = map[action];
    if (!target?.status) return res.status(400).json({ success: false, error: "Unknown action — use suspend | activate | end" });
    const upd = await query(
      `UPDATE donations SET status = $2,
         status_reason = ${target.reason ? "$3" : "status_reason"}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING id, status, status_reason`,
      target.reason ? [req.params.id, target.status, target.reason] : [req.params.id, target.status],
    );
    if (!upd.rows.length) return res.status(404).json({ success: false, error: "Donation not found" });
    res.json({ success: true, data: { donation: upd.rows[0], message: `Fundraiser ${target.status}` } });
  } catch {
    res.status(500).json({ success: false, error: "Could not update donation" });
  }
});

// ---------------------------------------------------------------------------
// Personal service flags (global kill-switches)
// ---------------------------------------------------------------------------
router.get("/service-flags", requirePermission("manage_settings"), async (_req, res) => {
  const raw = await getSetting("personal_service_flags", "");
  let flags: Record<string, boolean> = {};
  try { flags = raw ? JSON.parse(raw) : {}; } catch { flags = {}; }
  res.json({ success: true, data: { bills: true, savings: true, giftcards: true, esim: true, virtualcards: true, crypto: true, social: true, live: true, marketplace: true, swap: true, donations: true, ...flags } });
});

router.put("/service-flags", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const allowed = ["bills", "savings", "giftcards", "esim", "virtualcards", "crypto", "social", "live", "marketplace", "swap", "donations"];
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

// ---------------------------------------------------------------------------
// Account verification badge — pricing + subscriber management
//   GET/PUT /admin/personal/verification-pricing   (system_settings
//       `verification_badge_pricing` = { price, currency, duration_days })
//   GET  /admin/personal/verifications?status=     subscribers + badge state
//   POST /admin/personal/verifications/:userId/grant  { days }  (manual comp)
//   POST /admin/personal/verifications/:userId/revoke
// ---------------------------------------------------------------------------
router.get("/verification-pricing", requirePermission("manage_settings"), async (_req, res) => {
  try {
    const raw = await getSetting("verification_badge_pricing", "");
    const pricing = raw
      ? JSON.parse(raw)
      : { price: 2500, currency: "NGN", duration_days: 30 };
    res.json({ success: true, data: pricing });
  } catch {
    res.status(500).json({ success: false, error: "Could not load verification pricing" });
  }
});

router.put("/verification-pricing", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const price = Math.max(0, Number(req.body?.price));
    const duration_days = Math.max(1, Number(req.body?.duration_days) || 30);
    const currency = String(req.body?.currency || "NGN").toUpperCase();
    if (!Number.isFinite(price)) return res.status(400).json({ success: false, error: "price must be a number" });
    await setSetting(
      "verification_badge_pricing",
      JSON.stringify({ price, currency, duration_days }),
      "Verified badge monthly subscription pricing (personal app)",
    );
    res.json({ success: true, data: { price, currency, duration_days } });
  } catch {
    res.status(500).json({ success: false, error: "Could not save verification pricing" });
  }
});

router.get("/verifications", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const status = String(req.query.status || "active");
    const where = status === "all" ? "u.verified_badge_status != 'none'" : `u.verified_badge_status = $1`;
    const params: any[] = status === "all" ? [] : [status];
    const r = await query(
      `SELECT u.id, u.name, u.email, u.avatar_url, u.verified_badge_status, u.verified_since, u.verified_until,
              (SELECT COUNT(*)::int FROM social_follows f WHERE f.following_id = u.id) AS followers,
              (SELECT COUNT(*)::int FROM social_posts p WHERE p.user_id = u.id AND p.status = 'active') AS posts
       FROM users u WHERE ${where} ORDER BY u.verified_since DESC NULLS LAST LIMIT 200`,
      params,
    );
    const counts = await query(`SELECT verified_badge_status, COUNT(*)::int AS n FROM users GROUP BY verified_badge_status`);
    res.json({
      success: true,
      data: {
        verifications: r.rows,
        counts: Object.fromEntries(counts.rows.map((c) => [c.verified_badge_status, c.n])),
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load verifications" });
  }
});

router.post("/verifications/:userId/:action", requirePermission("manage_settings"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const action = String(req.params.action);
    if (!["grant", "revoke"].includes(action)) return res.status(400).json({ success: false, error: "Unknown action" });
    const userId = String(req.params.userId);
    if (action === "grant") {
      const days = Math.max(1, Number(req.body?.days) || 30);
      const endsAt = new Date(Date.now() + days * 86400000);
      await query(
        `UPDATE users SET verified_badge_status = 'active', verified_since = COALESCE(verified_since, CURRENT_TIMESTAMP), verified_until = $2 WHERE id = $1`,
        [userId, endsAt],
      );
      await query(
        `INSERT INTO verification_subscriptions (user_id, price, currency, duration_days, status, reference, ends_at)
         VALUES ($1, 0, 'NGN', $2, 'active', $3, $4)`,
        [userId, days, `ADMIN-GRANT-${adminOf(req)}`, endsAt],
      );
      return res.json({ success: true, data: { verified_until: endsAt } });
    }
    await query(`UPDATE users SET verified_badge_status = 'revoked', verified_until = NULL WHERE id = $1`, [userId]);
    await query(`UPDATE verification_subscriptions SET status = 'revoked' WHERE user_id = $1 AND status = 'active'`, [userId]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Could not update verification" });
  }
});
