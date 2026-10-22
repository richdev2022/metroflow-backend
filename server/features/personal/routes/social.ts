import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  verifyTransactionPin, assertPersonalService, genRef,
} from "../personal-utils";
import { calculateFee } from "../../../services/fees";
import { uploadMediaBuffer } from "../../../services/media-upload";
import { upload } from "../../../middleware/upload";
import { createNotification } from "../../../services/notifications";
import { friendshipMap } from "../../../routes/friends";

/**
 * SOCIAL — Facebook-style feed + robust polls + post boost engine.
 * Mounted at /social (all routes require a session; feed works for both
 * personal and business users — the social graph is user-scoped).
 *
 * Endpoints (contracts the Personal web + mobile clients consume):
 *   GET    /social/feed?filter=all|posts|polls|me&cursor=&limit=
 *   POST   /social/posts                     { body, audience? } | multipart(image)
 *   GET    /social/posts/:id
 *   DELETE /social/posts/:id
 *   POST   /social/posts/:id/react           { type: like|love|haha|wow|sad|angry }
 *   POST   /social/posts/:id/like            (legacy single-like → toggles 'like')
 *   GET    /social/posts/:id/comments
 *   POST   /social/posts/:id/comments        { body, parent_id? }
 *   DELETE /social/comments/:id
 *   POST   /social/posts/:id/share
 *   POST   /social/polls                     { question, options[], allow_multiple?, duration_hours?, hide_results_until_closed? }
 *   POST   /social/polls/:id/vote            { option_index | option_indexes[] }
 *   POST   /social/polls/:id/close           (author closes early)
 *   POST   /social/posts/:id/boost           { budget, duration_days, audience?, pin, wallet_id }
 *   GET    /social/boosts/mine
 *   POST   /social/boosts/:id/pause | resume
 */

const router = express.Router();

const REACTION_TYPES = new Set(["like", "love", "haha", "wow", "sad", "angry"]);

// ---------------------------------------------------------------------------
// Boost pricing engine (system_settings-driven; admin manages everything)
// ---------------------------------------------------------------------------
interface BoostPricing {
  currency: string;
  post: { price_per_1000: number; min_budget: number; max_budget: number; allowed_durations: number[] };
  listing: { price_per_1000: number; min_budget: number; max_budget: number; allowed_durations: number[] };
  audience_multiplier: Record<string, number>;
  engagement_boost_factor: number;
}

const DEFAULT_PRICING: BoostPricing = {
  currency: "NGN",
  post: { price_per_1000: 250, min_budget: 500, max_budget: 200000, allowed_durations: [1, 3, 7, 14] },
  listing: { price_per_1000: 200, min_budget: 300, max_budget: 100000, allowed_durations: [1, 3, 7, 14] },
  audience_multiplier: { national: 1.0, state: 0.65, city: 0.5 },
  engagement_boost_factor: 1.35,
};

export async function getBoostPricing(): Promise<BoostPricing> {
  try {
    const r = await query(`SELECT value FROM system_settings WHERE key = 'personal_boost_pricing' LIMIT 1`);
    if (r.rows[0]?.value) return { ...DEFAULT_PRICING, ...JSON.parse(r.rows[0].value) };
  } catch { /* defaults */ }
  return DEFAULT_PRICING;
}

/** Deterministic reach estimate: budget ÷ (price per 1k) × 1000, tapered by
 *  duration (longer runs saturate) and audience scope. */
export function estimateReach(pricing: BoostPricing, kind: "post" | "listing", budget: number, days: number, audience?: any): number {
  const cfg = kind === "post" ? pricing.post : pricing.listing;
  const perDay = budget / Math.max(1, days);
  // Saturation: daily spend beyond 4× price_per_1000 hits diminishing returns.
  const dailyCap = cfg.price_per_1000 * 4;
  const effectivePerDay = Math.min(perDay, dailyCap + (perDay - dailyCap) * 0.6);
  const base = (effectivePerDay / cfg.price_per_1000) * 1000;
  const scope = String(audience?.scope || "national");
  const mult = pricing.audience_multiplier[scope] ?? 1.0;
  const durationTaper = days >= 7 ? 0.92 : days >= 3 ? 0.96 : 1.0;
  return Math.max(50, Math.round(base * mult * durationTaper));
}

export async function getActiveBoostMap(targetType: "post" | "listing", ids: string[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  if (!ids.length) return map;
  const r = await query(
    `SELECT DISTINCT ON (target_id) target_id, id, budget, daily_budget, estimated_reach,
            impressions, clicks, ends_at, status
     FROM boost_orders
     WHERE target_type = $1 AND target_id = ANY($2::uuid[])
       AND status = 'active' AND ends_at > NOW()
     ORDER BY target_id, ends_at DESC NULLS LAST`,
    [targetType, ids],
  );
  for (const row of r.rows) map.set(row.target_id, row);
  return map;
}

/**
 * FEED RANKING ALGORITHM (organic + paid):
 *   score = engagement_score × recency_decay + boost_priority
 *   engagement_score = likes×1 + comments×3 + shares×5 (+ reaction weight)
 *   recency_decay    = 100 / (hours_since_post + 2)
 *   boost_priority   = 1000 × remaining_reach_ratio  (paid placement dominates
 *                      until its estimated reach is served, then decays)
 * Boosted items additionally surface at the top of the first page.
 */
function rankFeed(rows: any[], boosts: Map<string, any>): any[] {
  const now = Date.now();
  return rows
    .map((row) => {
      const hours = Math.max(0, (now - new Date(row.created_at).getTime()) / 3600000);
      const likes = Number(row.like_count) || 0;
      const comments = Number(row.comment_count) || 0;
      const shares = Number(row.share_count) || 0;
      const engagement = likes * 1 + comments * 3 + shares * 5;
      const organic = (engagement + 1) * (100 / (hours + 2));
      const boost = boosts.get(row.id);
      let boostPriority = 0;
      if (boost) {
        const served = Number(boost.impressions) || 0;
        const planned = Number(boost.estimated_reach) || 1;
        const remaining = Math.max(0, 1 - served / planned);
        boostPriority = 1000 * remaining + 100; // floor keeps it above fresh organic
      }
      return { ...row, _score: organic + boostPriority, boost: boost ? { active: true, ends_at: boost.ends_at } : undefined };
    })
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Boost pricing — public (authed) read so client dialogs render the CURRENT
// admin-configured packages (budget presets, durations, per-1000 price)
// instead of hardcoded values that drift from the admin console.
// ---------------------------------------------------------------------------
router.get("/boost-pricing", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "social"))) return;
    const pricing = await getBoostPricing();
    // Convenience: client-ready budget presets anchored to min/max budget.
    const presets = (kind: "post" | "listing") => {
      const cfg = kind === "post" ? pricing.post : pricing.listing;
      const raw = [500, 1000, 2000, 5000, 10000];
      return raw
        .filter((b) => b >= cfg.min_budget && b <= cfg.max_budget)
        .map((budget) => ({
          budget,
          days: cfg.allowed_durations[1] ?? cfg.allowed_durations[0] ?? 3,
          estimated_reach: estimateReach(pricing, kind, budget, cfg.allowed_durations[1] ?? cfg.allowed_durations[0] ?? 3),
        }));
    };
    res.json({
      success: true,
      data: {
        currency: pricing.currency,
        post: pricing.post,
        listing: pricing.listing,
        audience_multiplier: pricing.audience_multiplier,
        engagement_boost_factor: pricing.engagement_boost_factor,
        presets: { post: presets("post"), listing: presets("listing") },
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load boost pricing" });
  }
});

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------
router.get("/feed", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "social"))) return;
    const userId = req.user!.userId;
    const filter = String(req.query.filter || "all");
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 20));
    const cursor = req.query.cursor ? new Date(String(req.query.cursor)) : null;

    // Posts + polls are anchored on social_posts (polls attach via post_id).
    // Params: $1 = userId (reaction subquery + optional "me" filter),
    //         $2 = limit+1 (hasMore probe), $3 = cursor (when supplied).
    let where = `p.status = 'active'`;
    const params: any[] = [userId, limit + 1];
    if (filter === "me") where += ` AND p.user_id = $1`;
    if (cursor && !isNaN(cursor.getTime())) { where += ` AND p.created_at < $3`; params.push(cursor.toISOString()); }

    const postsRes = await query(
      `SELECT p.id, p.user_id, p.body, p.image_url, p.audience, p.share_count, p.created_at,
              u.name AS author_name, u.avatar_url AS author_photo,
              COALESCE(u.account_privacy, 'public') AS account_privacy,
              (SELECT COUNT(*)::int FROM social_reactions r WHERE r.post_id = p.id) AS like_count,
              (SELECT r.type FROM social_reactions r WHERE r.post_id = p.id AND r.user_id = $1 LIMIT 1) AS my_reaction,
              (SELECT COUNT(*)::int FROM social_comments c WHERE c.post_id = p.id AND c.status = 'active') AS comment_count,
              (SELECT COUNT(*)::int FROM social_polls pl WHERE pl.post_id = p.id AND pl.status = 'active') AS has_poll
       FROM social_posts p
       JOIN users u ON u.id = p.user_id
       WHERE ${where}
       ORDER BY p.created_at DESC
       LIMIT $2`,
      params,
    );

    const postIds = postsRes.rows.map((r) => r.id);
    const boosts = await getActiveBoostMap("post", postIds);

    // Privacy + friendship context per author — drives the feed's "Message" vs
    // "Add friend" action (public = chat, private = request first).
    const authorIds = [...new Set(postsRes.rows.map((r) => r.user_id))] as string[];
    const fMap = await friendshipMap(userId, authorIds);

    // Poll payloads for posts that carry one
    let pollsByPost = new Map<string, any>();
    if (postIds.length) {
      const pollsRes = await query(
        `SELECT pl.*, u.name AS poll_author FROM social_polls pl JOIN users u ON u.id = pl.user_id
         WHERE pl.post_id = ANY($1::uuid[]) AND pl.status != 'removed'`,
        [postIds],
      );
      for (const pl of pollsRes.rows) {
        const options = (pl.options || []).map((o: any, i: number) => ({ ...o, index: i }));
        const votesRes = await query(
          `SELECT option_index, COUNT(*)::int AS votes FROM social_poll_votes WHERE poll_id = $1 GROUP BY option_index`,
          [pl.id],
        );
        const myVotes = await query(
          `SELECT option_index FROM social_poll_votes WHERE poll_id = $1 AND user_id = $2`,
          [pl.id, userId],
        );
        const total = votesRes.rows.reduce((a, v) => a + v.votes, 0);
        pollsByPost.set(pl.post_id, {
          kind: "poll",
          id: pl.id,
          post_id: pl.post_id,
          question: pl.question,
          options: options.map((o: any) => {
            const votes = votesRes.rows.find((v) => v.option_index === o.index)?.votes || 0;
            return { index: o.index, text: o.text, image_url: o.image_url ?? null, vote_count: votes };
          }),
          allow_multiple: pl.allow_multiple,
          hide_results_until_closed: pl.hide_results_until_closed,
          ends_at: pl.ends_at,
          status: pl.status === "active" && pl.ends_at && new Date(pl.ends_at) < new Date() ? "closed" : pl.status,
          total_votes: total,
          my_vote: myVotes.rows.length ? myVotes.rows.map((m) => m.option_index) : null,
          created_at: pl.created_at,
          author: { id: pl.user_id, name: pl.poll_author },
        });
      }
    }

    let items = postsRes.rows.map((p) => {
      const poll = pollsByPost.get(p.id);
      return {
        kind: poll ? "poll" : "post",
        id: p.id,
        poll_id: poll?.id,
        author: {
          id: p.user_id,
          name: p.author_name,
          photo: p.author_photo,
          username: null,
          is_private: p.account_privacy === "private",
          friendship_status: fMap.get(p.user_id) || "none",
        },
        message: poll ? poll.question : p.body,
        image_url: poll ? poll.options?.find((o: any) => o.image_url)?.image_url ?? p.image_url : p.image_url,
        audience: p.audience,
        like_count: Number(p.like_count) || 0,
        comment_count: Number(p.comment_count) || 0,
        share_count: Number(p.share_count) || 0,
        my_reaction: p.my_reaction || null,
        liked_by_me: !!p.my_reaction,
        ...(poll ? {
          poll_question: poll.question,
          poll_options: poll.options.map((o: any) => ({ text: o.text, vote_count: o.vote_count })),
          allow_multiple: poll.allow_multiple,
          ends_at: poll.ends_at,
          status: poll.status,
          total_votes: poll.total_votes,
          my_vote: poll.my_vote,
          poll: poll,
        } : {}),
        created_at: p.created_at,
      };
    });

    if (filter === "polls") items = items.filter((i) => i.kind === "poll");
    if (filter === "posts") items = items.filter((i) => i.kind === "post");

    items = rankFeed(items, boosts);

    // Impression accounting for active boosts surfaced in this page (throttled
    // by only counting the first N boosted rows per request).
    const boostedShown = items.filter((i) => i.boost?.active).slice(0, 10);
    for (const b of boostedShown) {
      await query(
        `UPDATE boost_orders SET impressions = impressions + 1, updated_at = CURRENT_TIMESTAMP
         WHERE target_type = 'post' AND target_id = $1 AND status = 'active' AND ends_at > NOW()`,
        [b.id],
      );
    }

    const hasMore = items.length > limit;
    return res.json({
      success: true,
      data: {
        timeline: items.slice(0, limit),
        next_cursor: hasMore ? items[limit - 1]?.created_at : null,
      },
      // legacy flat shape for older clients
      timeline: items.slice(0, limit),
    });
  } catch (error: any) {
    console.error("social/feed error:", error?.message);
    return res.status(500).json({ success: false, error: "Could not load your feed" });
  }
});

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------
router.post("/posts", authenticateToken, checkSubscriptionStatus, upload.single("image"), async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "social"))) return;
    const userId = req.user!.userId;
    const body = String(req.body?.body ?? "").trim();
    const audience = ["public", "followers"].includes(req.body?.audience) ? req.body.audience : "public";
    let imageUrl: string | null = null;
    if (req.file) {
      const up = await uploadMediaBuffer({ buffer: req.file.buffer, originalname: req.file.originalname, mimeType: req.file.mimetype, folder: "social-media", userId });
      imageUrl = up?.url || null;
    } else if (req.body?.image_url) {
      imageUrl = String(req.body.image_url).slice(0, 500);
    }
    if (!body && !imageUrl) return res.status(400).json({ success: false, error: "Write something or attach a photo" });
    if (body.length > 5000) return res.status(400).json({ success: false, error: "Post is too long (max 5000 characters)" });

    const r = await query(
      `INSERT INTO social_posts (user_id, body, image_url, audience) VALUES ($1,$2,$3,$4) RETURNING *`,
      [userId, body, imageUrl, audience],
    );
    const u = await query(`SELECT name, avatar_url FROM users WHERE id = $1`, [userId]);
    return res.status(201).json({
      success: true,
      data: {
        post: {
          kind: "post", id: r.rows[0].id, author: { id: userId, name: u.rows[0]?.name, photo: u.rows[0]?.avatar_url },
          message: r.rows[0].body, image_url: r.rows[0].image_url, like_count: 0, comment_count: 0,
          share_count: 0, liked_by_me: false, created_at: r.rows[0].created_at,
        },
      },
    });
  } catch (error: any) {
    console.error("social/posts create error:", error?.message);
    return res.status(500).json({ success: false, error: "Could not post" });
  }
});

router.get("/posts/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const p = await query(
      `SELECT p.*, u.name AS author_name, u.avatar_url AS author_photo,
              (SELECT COUNT(*)::int FROM social_reactions r WHERE r.post_id = p.id) AS like_count,
              (SELECT r.type FROM social_reactions r WHERE r.post_id = p.id AND r.user_id = $2 LIMIT 1) AS my_reaction
       FROM social_posts p JOIN users u ON u.id = p.user_id WHERE p.id = $1`,
      [req.params.id, userId],
    );
    if (!p.rows.length) return res.status(404).json({ success: false, error: "Post not found" });
    res.json({ success: true, data: { post: p.rows[0] } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load post" });
  }
});

router.delete("/posts/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `DELETE FROM social_posts WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user!.userId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Post not found (or not yours)" });
    res.json({ success: true, message: "Post deleted" });
  } catch {
    res.status(500).json({ success: false, error: "Could not delete post" });
  }
});

// ---------------------------------------------------------------------------
// Reactions (Facebook-style six)
// ---------------------------------------------------------------------------
router.post("/posts/:id/react", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const type = String(req.body?.type || "like");
    if (!REACTION_TYPES.has(type)) return res.status(400).json({ success: false, error: "Unknown reaction" });
    const post = await query(`SELECT id, user_id FROM social_posts WHERE id = $1 AND status = 'active'`, [req.params.id]);
    if (!post.rows.length) return res.status(404).json({ success: false, error: "Post not found" });

    const existing = await query(
      `SELECT id, type FROM social_reactions WHERE post_id = $1 AND user_id = $2`,
      [req.params.id, userId],
    );
    let myReaction: string | null = null;
    if (existing.rows.length && existing.rows[0].type === type) {
      await query(`DELETE FROM social_reactions WHERE id = $1`, [existing.rows[0].id]);
    } else if (existing.rows.length) {
      await query(`UPDATE social_reactions SET type = $1 WHERE id = $2`, [type, existing.rows[0].id]);
      myReaction = type;
    } else {
      await query(`INSERT INTO social_reactions (post_id, user_id, type) VALUES ($1,$2,$3)`, [req.params.id, userId, type]);
      myReaction = type;
      if (post.rows[0].user_id !== userId) {
        createNotification({
          businessId: (req.user!.businessId ?? "") as string,
          userId: post.rows[0].user_id,
          title: "New reaction",
          message: `Someone reacted ${type} to your post`,
          type: "social",
        }).catch(() => {});
      }
    }
    const counts = await query(
      `SELECT type, COUNT(*)::int AS n FROM social_reactions WHERE post_id = $1 GROUP BY type`,
      [req.params.id],
    );
    const byType: Record<string, number> = {};
    for (const c of counts.rows) byType[c.type] = c.n;
    return res.json({
      success: true,
      data: {
        my_reaction: myReaction,
        like_count: Object.values(byType).reduce((a, b) => a + b, 0),
        reactions_by_type: byType,
      },
    });
  } catch (e: any) {
    console.error("react error:", e?.message);
    res.status(500).json({ success: false, error: "Could not react" });
  }
});

// Legacy single-like kept working (personal web v1 uses it)
router.post("/posts/:id/like", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const post = await query(`SELECT id FROM social_posts WHERE id = $1 AND status = 'active'`, [req.params.id]);
    if (!post.rows.length) return res.status(404).json({ success: false, error: "Post not found" });
    const existing = await query(
      `SELECT id FROM social_reactions WHERE post_id = $1 AND user_id = $2`,
      [req.params.id, userId],
    );
    let liked: boolean;
    if (existing.rows.length) {
      await query(`DELETE FROM social_reactions WHERE id = $1`, [existing.rows[0].id]);
      liked = false;
    } else {
      await query(`INSERT INTO social_reactions (post_id, user_id, type) VALUES ($1,$2,'like')`, [req.params.id, userId]);
      liked = true;
    }
    const c = await query(`SELECT COUNT(*)::int AS n FROM social_reactions WHERE post_id = $1`, [req.params.id]);
    res.json({ success: true, data: { liked_by_me: liked, like_count: c.rows[0].n }, liked_by_me: liked, like_count: c.rows[0].n });
  } catch {
    res.status(500).json({ success: false, error: "Could not like" });
  }
});

// ---------------------------------------------------------------------------
// Comments (with replies)
// ---------------------------------------------------------------------------
router.get("/posts/:id/comments", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `SELECT c.id, c.post_id, c.parent_id, c.user_id, c.body, c.like_count, c.status, c.created_at,
              u.name AS author_name, u.avatar_url AS author_photo
       FROM social_comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = $1 AND c.status = 'active'
       ORDER BY c.created_at ASC`,
      [req.params.id],
    );
    const comments = r.rows.map((c) => ({
      id: c.id, post_id: c.post_id, parent_id: c.parent_id ?? null,
      author: { id: c.user_id, name: c.author_name, photo: c.author_photo },
      message: c.body, like_count: c.like_count, created_at: c.created_at,
    }));
    res.json({ success: true, data: { comments }, comments });
  } catch {
    res.status(500).json({ success: false, error: "Could not load comments" });
  }
});

router.post("/posts/:id/comments", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ success: false, error: "Comment cannot be empty" });
    if (body.length > 2000) return res.status(400).json({ success: false, error: "Comment too long" });
    const post = await query(`SELECT id, user_id FROM social_posts WHERE id = $1 AND status = 'active'`, [req.params.id]);
    if (!post.rows.length) return res.status(404).json({ success: false, error: "Post not found" });
    let parentId: string | null = null;
    if (req.body?.parent_id) {
      const pr = await query(`SELECT id FROM social_comments WHERE id = $1 AND post_id = $2`, [req.body.parent_id, req.params.id]);
      if (pr.rows.length) parentId = req.body.parent_id;
    }
    const r = await query(
      `INSERT INTO social_comments (post_id, user_id, parent_id, body) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, userId, parentId, body],
    );
    if (post.rows[0].user_id !== userId) {
      createNotification({
        businessId: (req.user!.businessId ?? "") as string,
        userId: post.rows[0].user_id,
        title: "New comment",
        message: body.slice(0, 80),
        type: "social",
      }).catch(() => {});
    }
    const u = await query(`SELECT name, avatar_url FROM users WHERE id = $1`, [userId]);
    const comment = {
      id: r.rows[0].id, post_id: req.params.id, parent_id: parentId,
      author: { id: userId, name: u.rows[0]?.name, photo: u.rows[0]?.avatar_url },
      body, like_count: 0, created_at: r.rows[0].created_at,
    };
    res.status(201).json({ success: true, data: { comment }, comment });
  } catch (e: any) {
    console.error("comment create error:", e?.message);
    res.status(500).json({ success: false, error: "Could not comment" });
  }
});

router.delete("/comments/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `DELETE FROM social_comments WHERE id = $1 AND (user_id = $2 OR $3 = ANY(ARRAY['platform_admin'])) RETURNING id`,
      [req.params.id, req.user!.userId, req.user!.businessId ?? ""],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Comment not found (or not yours)" });
    res.json({ success: true, message: "Comment deleted" });
  } catch {
    res.status(500).json({ success: false, error: "Could not delete comment" });
  }
});

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------
router.post("/posts/:id/share", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `UPDATE social_posts SET share_count = share_count + 1 WHERE id = $1 AND status = 'active' RETURNING share_count`,
      [req.params.id],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Post not found" });
    res.json({ success: true, data: { share_count: r.rows[0].share_count } });
  } catch {
    res.status(500).json({ success: false, error: "Could not record share" });
  }
});

// ---------------------------------------------------------------------------
// Robust polls
// ---------------------------------------------------------------------------
router.post("/polls", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "social"))) return;
    const userId = req.user!.userId;
    const question = String(req.body?.question || "").trim();
    const optionsRaw = Array.isArray(req.body?.options) ? req.body.options : [];
    const options = optionsRaw
      .map((o: any) => (typeof o === "string" ? { text: String(o).trim() } : { text: String(o?.text || "").trim(), image_url: o?.image_url || null }))
      .filter((o: any) => o.text.length > 0);
    if (!question) return res.status(400).json({ success: false, error: "Poll needs a question" });
    if (options.length < 2 || options.length > 10) {
      return res.status(400).json({ success: false, error: "A poll needs between 2 and 10 options" });
    }
    const allowMultiple = !!req.body?.allow_multiple;
    const hideResults = !!req.body?.hide_results_until_closed;
    let endsAt: Date | null = null;
    const hours = Number(req.body?.duration_hours ?? req.body?.duration_days ? Number(req.body.duration_days) * 24 : undefined);
    const hoursArg = Number(req.body?.duration_hours);
    if (Number.isFinite(hoursArg) && hoursArg > 0) {
      endsAt = new Date(Date.now() + Math.min(24 * 30, hoursArg) * 3600000);
    }

    // A poll is a post whose body carries the question — keeps one feed model.
    const post = await query(
      `INSERT INTO social_posts (user_id, body, audience) VALUES ($1, $2, 'public') RETURNING id, created_at`,
      [userId, question],
    );
    const r = await query(
      `INSERT INTO social_polls (post_id, user_id, question, options, allow_multiple, hide_results_until_closed, ends_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,
      [post.rows[0].id, userId, question, JSON.stringify(options), allowMultiple, hideResults, endsAt],
    );
    res.status(201).json({ success: true, data: { poll: r.rows[0], post_id: post.rows[0].id } });
  } catch (e: any) {
    console.error("poll create error:", e?.message);
    res.status(500).json({ success: false, error: "Could not create poll" });
  }
});

router.post("/polls/:id/vote", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const poll = await query(`SELECT * FROM social_polls WHERE id = $1 AND status = 'active'`, [req.params.id]);
    if (!poll.rows.length) return res.status(404).json({ success: false, error: "Poll not found or closed" });
    const p = poll.rows[0];
    if (p.ends_at && new Date(p.ends_at) < new Date()) {
      return res.status(400).json({ success: false, error: "This poll has closed", code: "POLL_CLOSED" });
    }
    const maxOptions = (p.options || []).length - 1;
    const indexes = Array.isArray(req.body?.option_indexes)
      ? req.body.option_indexes.map((n: any) => Number(n))
      : [Number(req.body?.option_index ?? -1)];
    const valid = indexes.filter((n: number) => Number.isInteger(n) && n >= 0 && n <= maxOptions);
    if (!valid.length) return res.status(400).json({ success: false, error: "Pick a valid option" });
    if (!p.allow_multiple && valid.length > 1) {
      return res.status(400).json({ success: false, error: "This poll allows one choice only" });
    }

    if (p.allow_multiple) {
      // Additive: new choices are added; re-sending a choice removes it (toggle).
      for (const idx of valid) {
        const existing = await query(
          `SELECT id FROM social_poll_votes WHERE poll_id = $1 AND user_id = $2 AND option_index = $3`,
          [p.id, userId, idx],
        );
        if (existing.rows.length) {
          await query(`DELETE FROM social_poll_votes WHERE id = $1`, [existing.rows[0].id]);
        } else {
          await query(
            `INSERT INTO social_poll_votes (poll_id, user_id, option_index) VALUES ($1,$2,$3)
             ON CONFLICT (poll_id, user_id, option_index) DO NOTHING`,
            [p.id, userId, idx],
          );
        }
      }
    } else {
      // Single choice: revocable — voting again for the same option removes it;
      // voting for another option moves the vote.
      const existing = await query(
        `SELECT id, option_index FROM social_poll_votes WHERE poll_id = $1 AND user_id = $2`,
        [p.id, userId],
      );
      const same = existing.rows.find((e) => e.option_index === valid[0]);
      if (same) {
        await query(`DELETE FROM social_poll_votes WHERE id = $1`, [same.id]);
      } else if (existing.rows.length) {
        await query(`UPDATE social_poll_votes SET option_index = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [valid[0], existing.rows[0].id]);
      } else {
        await query(
          `INSERT INTO social_poll_votes (poll_id, user_id, option_index) VALUES ($1,$2,$3)`,
          [p.id, userId, valid[0]],
        );
      }
    }

    const votesRes = await query(
      `SELECT option_index, COUNT(*)::int AS votes FROM social_poll_votes WHERE poll_id = $1 GROUP BY option_index`,
      [p.id],
    );
    const mine = await query(`SELECT option_index FROM social_poll_votes WHERE poll_id = $1 AND user_id = $2`, [p.id, userId]);
    const total = votesRes.rows.reduce((a, v) => a + v.votes, 0);
    return res.json({
      success: true,
      data: {
        total_votes: total,
        results: (p.options || []).map((o: any, i: number) => ({
          index: i, text: o.text, vote_count: votesRes.rows.find((v) => v.option_index === i)?.votes || 0,
        })),
        my_votes: mine.rows.map((m) => m.option_index),
      },
    });
  } catch (e: any) {
    console.error("poll vote error:", e?.message);
    res.status(500).json({ success: false, error: "Vote failed" });
  }
});

router.post("/polls/:id/close", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `UPDATE social_polls SET status = 'closed', ends_at = LEAST(COALESCE(ends_at, NOW()), NOW())
       WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id`,
      [req.params.id, req.user!.userId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Poll not found (or not yours / already closed)" });
    res.json({ success: true, message: "Poll closed" });
  } catch {
    res.status(500).json({ success: false, error: "Could not close poll" });
  }
});

// ---------------------------------------------------------------------------
// POST BOOST — wallet-funded paid placement
// ---------------------------------------------------------------------------
router.post("/posts/:id/boost", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { budget, duration_days, audience, pin, wallet_id } = req.body || {};
    const post = await query(`SELECT id, user_id FROM social_posts WHERE id = $1 AND status = 'active'`, [req.params.id]);
    if (!post.rows.length) return res.status(404).json({ success: false, error: "Post not found" });
    if (post.rows[0].user_id !== userId) {
      return res.status(403).json({ success: false, error: "You can only boost your own posts" });
    }
    const pricing = await getBoostPricing();
    const cfg = pricing.post;
    const budgetN = Math.round(Number(budget));
    const days = Number(duration_days);
    if (!Number.isFinite(budgetN) || budgetN < cfg.min_budget || budgetN > cfg.max_budget) {
      return res.status(400).json({
        success: false,
        error: `Budget must be between ₦${cfg.min_budget.toLocaleString()} and ₦${cfg.max_budget.toLocaleString()}`,
      });
    }
    if (!Number.isFinite(days) || !cfg.allowed_durations.includes(days)) {
      return res.status(400).json({ success: false, error: `Duration must be one of: ${cfg.allowed_durations.join(", ")} day(s)` });
    }
    const wallet = await getOwnedWallet(String(wallet_id || ""), userId, req.user!.businessId ?? null);
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
    const pinCheck = await verifyTransactionPin(pin, { userId, businessId: req.user!.businessId ?? null, wallet });
    if (!pinCheck.ok) {
      return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });
    }
    const fee = await calculateFee(budgetN, "boost");
    const total = budgetN + fee;
    if (Number(wallet.balance) < total) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: "Insufficient wallet balance for this boost" });
    }
    const estimated = estimateReach(pricing, "post", budgetN, days, audience);
    const reference = genRef("MF-BST");
    if (!(await debitWallet(wallet.id, total))) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: "Insufficient wallet balance" });
    }
    await insertTransaction({
      userId, businessId: wallet.business_id, walletId: wallet.id, reference,
      type: "debit", transactionType: "boost", amount: total, currency: wallet.currency,
      fee, description: `Post boost (${days}d, ~${estimated.toLocaleString()} reach)`,
    });
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + days * 86400000);
    const r = await query(
      `INSERT INTO boost_orders
         (user_id, target_type, target_id, wallet_id, reference, budget, duration_days, daily_budget,
          audience, pricing_snapshot, estimated_reach, status, starts_at, ends_at)
       VALUES ($1,'post',$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,'active',$11,$12) RETURNING *`,
      [
        userId, req.params.id, wallet.id, reference, budgetN, days,
        Math.round((budgetN / days) * 100) / 100, JSON.stringify(audience || {}),
        JSON.stringify({ ...cfg, kind: "post" }), estimated, startsAt, endsAt,
      ],
    );
    res.status(201).json({
      success: true,
      data: {
        boost: { ...r.rows[0], estimated_reach: estimated },
        message: `Boost live — estimated reach ~${estimated.toLocaleString()} people over ${days} day(s)`,
      },
    });
  } catch (e: any) {
    console.error("boost error:", e?.message);
    res.status(500).json({ success: false, error: "Could not start boost" });
  }
});

router.get("/boosts/mine", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `SELECT b.*, CASE b.target_type WHEN 'post' THEN (SELECT body FROM social_posts WHERE id = b.target_id)
                                         ELSE (SELECT name FROM market_listings WHERE id = b.target_id) END AS target_label
       FROM boost_orders b WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    res.json({ success: true, data: { boosts: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load boosts" });
  }
});

router.post("/boosts/:id/:action", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    if (!["pause", "resume"].includes(String(req.params.action))) {
      return res.status(400).json({ success: false, error: "Unknown action" });
    }
    const action = req.params.action === "pause" ? "paused" : "active";
    const r = await query(
      `UPDATE boost_orders SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3 AND status IN ('active','paused') RETURNING status`,
      [action, req.params.id, req.user!.userId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Boost not found" });
    res.json({ success: true, data: { status: r.rows[0].status } });
  } catch {
    res.status(500).json({ success: false, error: "Could not update boost" });
  }
});

export default router;
