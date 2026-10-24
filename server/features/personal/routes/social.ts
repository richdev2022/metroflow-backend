import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction,
  verifyTransactionPin, assertPersonalService, genRef, requirePersonalKyc, isPersonalKycVerified,
} from "../personal-utils";
import { calculateFee, creditRevenueWallet } from "../../../services/fees";
import { uploadMediaBuffer } from "../../../services/media-upload";
import { extractVideoPosterFrame } from "../../../services/video-thumbnail";
import { upload } from "../../../middleware/upload";
import { createNotification } from "../../../services/notifications";
import { friendshipMap } from "../../../routes/friends";
import { getSetting } from "../../../services/app-config";

/**
 * SOCIAL — Facebook-style feed + robust polls + post boost engine.
 * Mounted at /social (all routes require a session; feed works for both
 * personal and business users — the social graph is user-scoped).
 *
 * Endpoints (contracts the Personal web + mobile clients consume):
 *   GET    /social/feed?filter=all|posts|polls|me|video|photo|text&cursor=&limit=
 *   POST   /social/posts                     { body, audience? } | multipart(image)
 *   GET    /social/posts/:id
 *   DELETE /social/posts/:id
 *   POST   /social/posts/:id/react           { type: like|love|haha|wow|sad|angry }
 *   POST   /social/posts/:id/like            (legacy single-like → toggles 'like')
 *   GET    /social/posts/:id/comments
 *   POST   /social/posts/:id/comments        { body, parent_id? }
 *   DELETE /social/comments/:id
 *   POST   /social/posts/:id/share
 *   POST   /social/polls                     { question, options[], allow_multiple?, duration_hours?, hide_results_until_closed?, poll_type?: free|paid, vote_price? }
 *   GET    /social/polls/pricing             (paid-poll economics for composer UI)
 *   POST   /social/polls/:id/vote            { option_index | option_indexes[] , pin? } — paid polls debit the NGN wallet
 *   POST   /social/polls/:id/withdraw        (paid-poll creator withdraws the pool → NGN wallet; fee → revenue ledger)
 *   GET    /social/vote-pocket               (creator's aggregate vote-pocket balance + withdrawal history)
 *   POST   /social/polls/:id/close           (author closes early)
 *   POST   /social/posts/:id/boost           { budget, duration_days, audience?, pin, wallet_id }
 *   GET    /social/boosts/mine
 *   POST   /social/boosts/:id/pause | resume
 *   GET    /social/collections                       (saved-post collections + counts + covers)
 *   POST   /social/collections                       { name }
 *   PATCH  /social/collections/:id                   { name }
 *   DELETE /social/collections/:id
 *   GET    /social/collections/:id/posts             (feed-shaped saved posts)
 *   GET    /social/posts/:id/save-state              { saved, collection_ids }
 *   POST   /social/posts/:id/save                    { collection_ids?, collection_name? }
 *   DELETE /social/posts/:id/save                    { collection_id? } (omit = remove everywhere)
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

// ---------------------------------------------------------------------------
// Poll economics (admin-managed via GET/PUT /admin/settings/poll)
// ---------------------------------------------------------------------------
export interface PollSettings {
  currency: string;
  default_vote_price: number;
  min_vote_price: number;
  max_vote_price: number;
  withdrawal_fee_percent: number;
  withdrawal_fee_flat: number;
  withdrawal_min: number;
}

export const DEFAULT_POLL_SETTINGS: PollSettings = {
  currency: "NGN",
  default_vote_price: 100,
  min_vote_price: 20,
  max_vote_price: 100000,
  withdrawal_fee_percent: 10,
  withdrawal_fee_flat: 0,
  withdrawal_min: 500,
};

export async function getPollSettings(): Promise<PollSettings> {
  try {
    const r = await query(`SELECT value FROM system_settings WHERE key = 'poll_settings' LIMIT 1`);
    if (r.rows[0]?.value) return { ...DEFAULT_POLL_SETTINGS, ...JSON.parse(r.rows[0].value) };
  } catch { /* defaults */ }
  return DEFAULT_POLL_SETTINGS;
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
 * FEED RANKING ALGORITHM (organic + paid + personalized):
 *   score = engagement_score × recency_decay × personalization + boost_priority
 *   engagement_score = likes×1 + comments×3 + shares×5 (+ reaction weight)
 *   recency_decay    = 100 / (hours_since_post + 2)
 *   personalization  = author affinity (viewer's recent interactions) ×
 *                      follow bonus × rich-media bonus — the "niche engine":
 *                      the more a viewer engages with an author or format,
 *                      the more of that niche the feed serves (Facebook-style).
 *   boost_priority   = 1000 × remaining_reach_ratio  (paid placement dominates
 *                      until its estimated reach is served, then decays)
 * A light diversity pass demotes runs of 3+ posts from the same author.
 */
function rankFeed(
  rows: any[],
  boosts: Map<string, any>,
  ctx?: { affinity?: Map<string, number>; followed?: Set<string> },
): any[] {
  const now = Date.now();
  const affinity = ctx?.affinity;
  const followed = ctx?.followed;
  const scored = rows.map((row) => {
    const hours = Math.max(0, (now - new Date(row.created_at).getTime()) / 3600000);
    const likes = Number(row.like_count) || 0;
    const comments = Number(row.comment_count) || 0;
    const shares = Number(row.share_count) || 0;
    const engagement = likes * 1 + comments * 3 + shares * 5;
    let organic = (engagement + 1) * (100 / (hours + 2));

    // ---- Personalization (niche recognition) ----
    const authorId = String(row.user_id ?? row.author?.id ?? "");
    if (affinity && affinity.size) {
      const hits = affinity.get(authorId) || 0;
      if (hits > 0) {
        // 1 interaction ×1.15 → 4+ interactions ×1.60 (saturating).
        organic *= 1 + 0.15 * Math.min(4, hits);
      }
    }
    if (followed?.has(authorId)) organic *= 1.2;
    // Rich media earns a small organic edge (video > photo > text).
    if (row.video_url) organic *= 1.15;
    else if (row.image_url) organic *= 1.05;

    const boost = boosts.get(row.id);
    let boostPriority = 0;
    if (boost) {
      const served = Number(boost.impressions) || 0;
      const planned = Number(boost.estimated_reach) || 1;
      const remaining = Math.max(0, 1 - served / planned);
      boostPriority = 1000 * remaining + 100; // floor keeps it above fresh organic
    }
    return { ...row, _score: organic + boostPriority, _authorId: authorId, boost: boost ? { active: true, ends_at: boost.ends_at } : undefined };
  });

  scored.sort((a, b) => b._score - a._score);

  // ---- Diversity pass: no 3-in-a-row from one author (demote the 3rd) ----
  const out: any[] = [];
  const recent = new Map<string, number>(); // authorId → index of their 2nd-most-recent appearance
  for (const item of scored) {
    const aid = item._authorId as string;
    const lastIdx = recent.get(aid);
    if (lastIdx !== undefined && out.length - lastIdx <= 1) {
      // Author already occupies the previous slot — push one slot down if possible.
      const nextDifferent = out.findIndex((x, i) => i > lastIdx && (x._authorId as string) !== aid);
      if (nextDifferent !== -1) {
        out.splice(nextDifferent, 0, item);
        recent.set(aid, nextDifferent);
        continue;
      }
    }
    out.push(item);
    recent.set(aid, out.length - 1);
  }

  return out.map(({ _score, _authorId, ...rest }) => rest);
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
      `SELECT p.id, p.user_id, p.body, p.image_url, p.video_url, p.audience, p.share_count, p.created_at,
              u.name AS author_name, u.avatar_url AS author_photo,
              COALESCE(u.account_privacy, 'public') AS account_privacy,
              (u.verified_badge_status = 'active' AND (u.verified_until IS NULL OR u.verified_until > NOW())) AS author_verified,
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

    // Ordered media carousels for this page — one batched query, grouped per
    // post. Older posts (created before the multi-media upgrade) have no rows
    // here and fall back to their legacy image_url/video_url columns.
    const mediaByPost = new Map<string, Array<{ media_type: string; url: string; poster_url: string | null }>>();
    if (postIds.length) {
      try {
        const mediaRes = await query(
          `SELECT post_id, media_type, url, poster_url FROM social_post_media
           WHERE post_id = ANY($1::uuid[]) ORDER BY post_id, position, created_at`,
          [postIds],
        );
        for (const row of mediaRes.rows) {
          const list = mediaByPost.get(String(row.post_id)) || [];
          list.push({ media_type: row.media_type, url: row.url, poster_url: row.poster_url || null });
          mediaByPost.set(String(row.post_id), list);
        }
      } catch { /* table may not exist yet on a cold deploy — legacy columns still render */ }
    }

    // Privacy + friendship context per author — drives the feed's "Message" vs
    // "Add friend" action (public = chat, private = request first).
    const authorIds = [...new Set(postsRes.rows.map((r) => r.user_id))] as string[];
    const fMap = await friendshipMap(userId, authorIds);

    // Follow context per author — so the feed's Follow/Following button
    // reflects reality after a refresh instead of resetting to "Follow".
    const followSet = new Set<string>();
    if (authorIds.length) {
      const followRes = await query(
        `SELECT following_id FROM social_follows WHERE follower_id = $1 AND following_id = ANY($2::uuid[])`,
        [userId, authorIds],
      );
      for (const row of followRes.rows) followSet.add(String(row.following_id));
    }

    // Niche affinity — authors the viewer reacted to or commented on in the
    // last 30 days (weight = interaction count). This powers the personalized
    // ranking: the feed learns WHOSE content this viewer engages with and
    // serves more of that niche.
    let affinity = new Map<string, number>();
    try {
      const affRes = await query(
        `SELECT author_id, SUM(n)::int AS hits FROM (
           SELECT p.user_id AS author_id, COUNT(*)::int AS n
           FROM social_reactions r JOIN social_posts p ON p.id = r.post_id
           WHERE r.user_id = $1 AND r.created_at >= NOW() - INTERVAL '30 days'
           GROUP BY p.user_id
           UNION ALL
           SELECT p.user_id AS author_id, COUNT(*)::int AS n
           FROM social_comments c JOIN social_posts p ON p.id = c.post_id
           WHERE c.user_id = $1 AND c.status = 'active' AND c.created_at >= NOW() - INTERVAL '30 days'
           GROUP BY p.user_id
         ) t GROUP BY author_id`,
        [userId],
      );
      for (const row of affRes.rows) affinity.set(String(row.author_id), Number(row.hits) || 0);
    } catch { /* affinity is best-effort — ranking still works without it */ }

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
          poll_type: pl.poll_type || "free",
          vote_price: Number(pl.vote_price) || 0,
          pool_earned: Number(pl.pool_earned) || 0,
          pool_withdrawn: Number(pl.pool_withdrawn) || 0,
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
          is_verified: !!p.author_verified,
          friendship_status: fMap.get(p.user_id) || "none",
          // "none" | "following" — seeded from social_follows on load so the
          // UI shows Following (with an Unfollow action) for accounts the
          // viewer already follows.
          viewer_follow_status: p.user_id === userId ? "self" : followSet.has(String(p.user_id)) ? "following" : "none",
        },
        message: poll ? poll.question : p.body,
        // `body`/`content` aliases — clients read item.body for text posts; the
        // missing alias is exactly why text-only posts rendered blank.
        body: p.body,
        content: p.body,
        image_url: poll ? poll.options?.find((o: any) => o.image_url)?.image_url ?? p.image_url : p.image_url,
        video_url: p.video_url || null,
        // Ordered multi-media carousel — synthesized from the legacy columns
        // for posts created before social_post_media existed.
        media: mediaByPost.get(String(p.id)) || [
          p.image_url ? { media_type: "image", url: p.image_url, poster_url: null } : null,
          p.video_url ? { media_type: "video", url: p.video_url, poster_url: null } : null,
        ].filter(Boolean),
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
          poll_type: poll.poll_type,
          vote_price: poll.vote_price,
          pool_earned: poll.pool_earned,
          pool_withdrawn: poll.pool_withdrawn,
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

    // MEDIA-TYPE FILTERS — viewers can slice the feed down to just videos,
    // just photos, or just text-only posts (TikTok/Instagram-style tabs).
    const hasVideo = (i: any) =>
      (i.media || []).some((m: any) => m.media_type === "video") || !!i.video_url;
    const hasImage = (i: any) =>
      (i.media || []).some((m: any) => m.media_type === "image") || !!i.image_url;
    if (filter === "video") items = items.filter((i) => i.kind === "post" && hasVideo(i));
    if (filter === "photo") items = items.filter((i) => i.kind === "post" && !hasVideo(i) && hasImage(i));
    if (filter === "text") items = items.filter((i) => i.kind === "post" && !hasVideo(i) && !hasImage(i));

    // Bookmark state for this page — the card shows a filled bookmark when
    // the viewer saved the post to one of their collections.
    try {
      const savedMap = await savedStateForPosts(userId, postIds);
      items = items.map((i) => ({ ...i, saved_collection_ids: savedMap.get(String(i.id)) || [] }));
    } catch { /* cosmetic */ }

    items = rankFeed(items, boosts, { affinity, followed: followSet });

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
router.post("/posts", authenticateToken, checkSubscriptionStatus, upload.fields([{ name: "image", maxCount: 10 }, { name: "video", maxCount: 10 }, { name: "poster", maxCount: 10 }]), async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "social"))) return;
    const userId = req.user!.userId;
    const body = String(req.body?.body ?? "").trim();
    const audience = ["public", "followers"].includes(req.body?.audience) ? req.body.audience : "public";
    const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
    const imageFiles = files.image || [];
    const videoFiles = files.video || [];
    // Poster frames — captured client-side per video (canvas snapshot), in the
    // same order as the videos were appended.
    const posterFiles = files.poster || [];
    // Ordered media sequence. The composer sends `media_order` (JSON array of
    // "image"|"video") so mixed carousels render in the user's chosen order;
    // when absent (old clients) fall back to images-then-videos.
    let order: string[] = [];
    try {
      const raw = JSON.parse(String(req.body?.media_order || "[]"));
      if (Array.isArray(raw)) order = raw.map((x: any) => String(x)).filter((x: string) => x === "image" || x === "video").slice(0, 10);
    } catch { /* malformed order — fall back below */ }
    if (order.length === 0) order = [...imageFiles.map(() => "image"), ...videoFiles.map(() => "video")].slice(0, 10);

    // Upload every media file (cap 10 per post), then walk the requested
    // order to build the carousel sequence. Videos consume their poster
    // frames in the same order the composer appended them.
    const MAX_MEDIA = 10;
    const imageQueue = [...imageFiles];
    const videoQueue = [...videoFiles];
    const posterQueue = [...posterFiles];
    const uploadOne = async (f: Express.Multer.File) =>
      (await uploadMediaBuffer({ buffer: f.buffer, originalname: f.originalname, mimeType: f.mimetype, folder: "social-media", userId }))?.url || null;

    type MediaRow = { media_type: "image" | "video"; url: string | null; poster_url: string | null };
    const mediaRows: MediaRow[] = [];
    for (const kind of order) {
      if (mediaRows.length >= MAX_MEDIA) break;
      if (kind === "image" && imageQueue.length) {
        mediaRows.push({ media_type: "image", url: await uploadOne(imageQueue.shift()!), poster_url: null });
      } else if (kind === "video" && videoQueue.length) {
        const poster = posterQueue.length ? await uploadOne(posterQueue.shift()!) : null;
        mediaRows.push({ media_type: "video", url: await uploadOne(videoQueue.shift()!), poster_url: poster });
      }
    }
    // Leftover files when media_order was absent/short (cap respected).
    while (mediaRows.length < MAX_MEDIA && (imageQueue.length || videoQueue.length)) {
      if (imageQueue.length) mediaRows.push({ media_type: "image", url: await uploadOne(imageQueue.shift()!), poster_url: null });
      else if (videoQueue.length) {
        const poster = posterQueue.length ? await uploadOne(posterQueue.shift()!) : null;
        mediaRows.push({ media_type: "video", url: await uploadOne(videoQueue.shift()!), poster_url: poster });
      }
    }

    // Server-side poster fill — any video that arrived WITHOUT a client-captured
    // frame (old clients, mobile app, failed canvas capture) gets a thumbnail
    // extracted on the host with ffmpeg. Best-effort per video: a missing
    // binary or an exotic codec degrades to the no-poster path and never fails
    // the post. Keeps og:image/feed thumbnails real for EVERY video post.
    // Pair video rows with their original buffers in upload order.
    {
      const videoRowIdx: number[] = [];
      mediaRows.forEach((m, i) => { if (m.media_type === "video") videoRowIdx.push(i); });
      for (let v = 0; v < videoRowIdx.length && v < videoFiles.length; v++) {
        const row = mediaRows[videoRowIdx[v]];
        if (row.poster_url) continue; // client already supplied a poster
        try {
          const frame = await extractVideoPosterFrame(videoFiles[v].buffer, { maxWidth: 720 });
          if (frame) {
            const up = await uploadMediaBuffer({
              buffer: frame,
              originalname: `poster-${v}.jpg`,
              mimeType: "image/jpeg",
              folder: "social-media",
              userId,
            });
            if (up?.url) row.poster_url = up.url;
          }
        } catch (err: any) {
          console.warn("social/posts server-side poster extraction skipped:", err?.message);
        }
      }
    }

    // Back-compat columns: first image / first video also land on social_posts
    // so OG share previews, profile grids and older clients keep working.
    let imageUrl: string | null = mediaRows.find((m) => m.media_type === "image")?.url || null;
    let videoUrl: string | null = mediaRows.find((m) => m.media_type === "video")?.url || null;
    // Video-only post with no client poster? Mirror the server-extracted
    // poster to image_url too so legacy og:image consumers always get a real
    // preview instead of a blank share card.
    if (!imageUrl) {
      const firstVideoWithPoster = mediaRows.find((m) => m.media_type === "video" && m.poster_url);
      if (firstVideoWithPoster?.poster_url) imageUrl = firstVideoWithPoster.poster_url;
    }
    if (!mediaRows.length) {
      // Legacy single-file shape (image_url / video_url body fields).
      if (req.body?.image_url) imageUrl = String(req.body.image_url).slice(0, 500);
      if (req.body?.video_url) videoUrl = String(req.body.video_url).slice(0, 500);
      if (imageUrl) mediaRows.push({ media_type: "image", url: imageUrl, poster_url: null });
      if (videoUrl) mediaRows.push({ media_type: "video", url: videoUrl, poster_url: null });
    }
    if (!body && !mediaRows.length) return res.status(400).json({ success: false, error: "Write something or attach a photo/video" });
    if (body.length > 5000) return res.status(400).json({ success: false, error: "Post is too long (max 5000 characters)" });

    const r = await query(
      `INSERT INTO social_posts (user_id, body, image_url, video_url, audience) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, body, imageUrl, videoUrl, audience],
    );
    const postId = r.rows[0].id;
    // Persist the ordered carousel (best-effort — a media-row failure must not
    // fail the post, the back-compat columns already carry the first media).
    const savedMedia: Array<{ media_type: string; url: string | null; poster_url: string | null }> = [];
    for (let i = 0; i < mediaRows.length; i++) {
      const m = mediaRows[i];
      if (!m.url) continue;
      await query(
        `INSERT INTO social_post_media (post_id, media_type, url, poster_url, position) VALUES ($1,$2,$3,$4,$5)`,
        [postId, m.media_type, m.url, m.poster_url, i],
      ).catch(() => {});
      savedMedia.push({ media_type: m.media_type, url: m.url, poster_url: m.poster_url });
    }
    const u = await query(`SELECT name, avatar_url FROM users WHERE id = $1`, [userId]);
    return res.status(201).json({
      success: true,
      data: {
        post: {
          kind: "post", id: postId, author: { id: userId, name: u.rows[0]?.name, photo: u.rows[0]?.avatar_url },
          message: r.rows[0].body, body: r.rows[0].body, content: r.rows[0].body,
          image_url: r.rows[0].image_url, video_url: r.rows[0].video_url,
          media: savedMedia,
          like_count: 0, comment_count: 0,
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
    // Ordered media carousel (falls back to the legacy columns when empty).
    const m = await query(
      `SELECT media_type, url, poster_url FROM social_post_media WHERE post_id = $1 ORDER BY position, created_at`,
      [req.params.id],
    );
    const post = p.rows[0];
    post.media = m.rows.length
      ? m.rows
      : [post.image_url ? { media_type: "image", url: post.image_url, poster_url: null } : null,
         post.video_url ? { media_type: "video", url: post.video_url, poster_url: null } : null].filter(Boolean);
    res.json({ success: true, data: { post } });
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
// Saved posts — Facebook-style collections. Users file posts into named
// folders ("Videos", "Photos", or anything they create) and browse them from
// the Saved page. Membership is idempotent per (collection, post).
// ---------------------------------------------------------------------------

const MAX_COLLECTIONS_PER_USER = 50;

/** Shape saved posts exactly like feed items (media carousel + poll payloads). */
async function shapeSavedPosts(userId: string, postIds: string[]) {
  if (!postIds.length) return [];
  const postsRes = await query(
    `SELECT p.id, p.user_id, p.body, p.image_url, p.video_url, p.audience, p.share_count, p.created_at,
            u.name AS author_name, u.avatar_url AS author_photo,
            COALESCE(u.account_privacy, 'public') AS account_privacy,
            (u.verified_badge_status = 'active' AND (u.verified_until IS NULL OR u.verified_until > NOW())) AS author_verified,
            (SELECT COUNT(*)::int FROM social_reactions r WHERE r.post_id = p.id) AS like_count,
            (SELECT r.type FROM social_reactions r WHERE r.post_id = p.id AND r.user_id = $1 LIMIT 1) AS my_reaction,
            (SELECT COUNT(*)::int FROM social_comments c WHERE c.post_id = p.id AND c.status = 'active') AS comment_count,
            (SELECT COUNT(*)::int FROM social_polls pl WHERE pl.post_id = p.id AND pl.status = 'active') AS has_poll
     FROM social_posts p
     JOIN users u ON u.id = p.user_id
     WHERE p.id = ANY($2::uuid[]) AND p.status = 'active'`,
    [userId, postIds],
  );
  const ids = postsRes.rows.map((r) => r.id);

  const mediaByPost = new Map<string, Array<{ media_type: string; url: string; poster_url: string | null }>>();
  if (ids.length) {
    try {
      const mediaRes = await query(
        `SELECT post_id, media_type, url, poster_url FROM social_post_media
         WHERE post_id = ANY($1::uuid[]) ORDER BY post_id, position, created_at`,
        [ids],
      );
      for (const row of mediaRes.rows) {
        const list = mediaByPost.get(String(row.post_id)) || [];
        list.push({ media_type: row.media_type, url: row.url, poster_url: row.poster_url || null });
        mediaByPost.set(String(row.post_id), list);
      }
    } catch { /* legacy columns still render */ }
  }

  const pollsByPost = new Map<string, any>();
  if (ids.length) {
    try {
      const pollsRes = await query(
        `SELECT pl.*, u.name AS poll_author FROM social_polls pl JOIN users u ON u.id = pl.user_id
         WHERE pl.post_id = ANY($1::uuid[]) AND pl.status != 'removed'`,
        [ids],
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
          options: options.map((o: any) => ({
            index: o.index,
            text: o.text,
            image_url: o.image_url ?? null,
            vote_count: votesRes.rows.find((v) => v.option_index === o.index)?.votes || 0,
          })),
          allow_multiple: pl.allow_multiple,
          hide_results_until_closed: pl.hide_results_until_closed,
          ends_at: pl.ends_at,
          poll_type: pl.poll_type || "free",
          vote_price: Number(pl.vote_price) || 0,
          status: pl.status === "active" && pl.ends_at && new Date(pl.ends_at) < new Date() ? "closed" : pl.status,
          total_votes: total,
          my_vote: myVotes.rows.length ? myVotes.rows.map((m) => m.option_index) : null,
          created_at: pl.created_at,
          author: { id: pl.user_id, name: pl.poll_author },
        });
      }
    } catch { /* polls are optional in saved views */ }
  }

  const byId = new Map(
    postsRes.rows.map((p) => {
      const poll = pollsByPost.get(p.id);
      return [String(p.id), {
        kind: poll ? "poll" : "post",
        id: p.id,
        poll_id: poll?.id,
        author: {
          id: p.user_id,
          name: p.author_name,
          photo: p.author_photo,
          username: null,
          is_private: p.account_privacy === "private",
          is_verified: !!p.author_verified,
          friendship_status: "none",
          viewer_follow_status: p.user_id === userId ? "self" : "none",
        },
        message: poll ? poll.question : p.body,
        body: p.body,
        content: p.body,
        image_url: poll ? poll.options?.find((o: any) => o.image_url)?.image_url ?? p.image_url : p.image_url,
        video_url: p.video_url || null,
        media: mediaByPost.get(String(p.id)) || [
          p.image_url ? { media_type: "image", url: p.image_url, poster_url: null } : null,
          p.video_url ? { media_type: "video", url: p.video_url, poster_url: null } : null,
        ].filter(Boolean),
        audience: p.audience,
        like_count: Number(p.like_count) || 0,
        comment_count: Number(p.comment_count) || 0,
        share_count: Number(p.share_count) || 0,
        my_reaction: p.my_reaction || null,
        liked_by_me: !!p.my_reaction,
        ...(poll ? { poll, poll_question: poll.question, poll_type: poll.poll_type, status: poll.status, total_votes: poll.total_votes, my_vote: poll.my_vote } : {}),
        created_at: p.created_at,
      }];
    }),
  );
  // Preserve the caller's (saved_at DESC) ordering.
  return postIds.map((id) => byId.get(String(id))).filter(Boolean);
}

/** The viewer's collection memberships for a batch of posts (bookmark state). */
async function savedStateForPosts(userId: string, postIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!postIds.length) return out;
  try {
    const r = await query(
      `SELECT i.post_id, i.collection_id
       FROM social_post_collection_items i
       JOIN social_post_collections c ON c.id = i.collection_id
       WHERE c.user_id = $1 AND i.post_id = ANY($2::uuid[])`,
      [userId, postIds],
    );
    for (const row of r.rows) {
      const list = out.get(String(row.post_id)) || [];
      list.push(String(row.collection_id));
      out.set(String(row.post_id), list);
    }
  } catch { /* table may still be migrating on a cold deploy */ }
  return out;
}

// List the viewer's collections (with per-collection counts + cover thumbs).
router.get("/collections", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const cols = await query(
      `SELECT c.id, c.name, c.created_at, c.updated_at,
              (SELECT COUNT(*)::int FROM social_post_collection_items i WHERE i.collection_id = c.id) AS post_count,
              (SELECT m.url FROM social_post_collection_items i
                 JOIN social_post_media m ON m.post_id = i.post_id
                 WHERE i.collection_id = c.id
                 ORDER BY i.saved_at DESC, m.position ASC LIMIT 1) AS cover_url,
              (SELECT p.image_url FROM social_post_collection_items i
                 JOIN social_posts p ON p.id = i.post_id
                 WHERE i.collection_id = c.id
                 ORDER BY i.saved_at DESC LIMIT 1) AS cover_fallback
       FROM social_post_collections c
       WHERE c.user_id = $1
       ORDER BY c.updated_at DESC`,
      [userId],
    );
    const collections = cols.rows.map((c) => ({
      id: c.id,
      name: c.name,
      post_count: Number(c.post_count) || 0,
      cover_url: c.cover_url || c.cover_fallback || null,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
    res.json({ success: true, data: { collections } });
  } catch (e: any) {
    console.error("social/collections error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load your collections" });
  }
});

// Create a collection ("folder").
router.post("/collections", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const name = String(req.body?.name || "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ success: false, error: "Give the collection a name" });
    const countRes = await query(`SELECT COUNT(*)::int AS n FROM social_post_collections WHERE user_id = $1`, [userId]);
    if (Number(countRes.rows[0]?.n) >= MAX_COLLECTIONS_PER_USER) {
      return res.status(400).json({ success: false, error: "You've reached the collection limit (50)" });
    }
    const ins = await query(
      `INSERT INTO social_post_collections (user_id, name) VALUES ($1, $2)
       ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
       RETURNING id, name, created_at`,
      [userId, name],
    );
    res.json({ success: true, data: { collection: ins.rows[0] } });
  } catch {
    res.status(500).json({ success: false, error: "Could not create the collection" });
  }
});

// Rename a collection.
router.patch("/collections/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const name = String(req.body?.name || "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ success: false, error: "Give the collection a name" });
    const r = await query(
      `UPDATE social_post_collections SET name = $2, updated_at = NOW()
       WHERE id = $1 AND user_id = $3 RETURNING id, name`,
      [req.params.id, name, req.user!.userId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Collection not found" });
    res.json({ success: true, data: { collection: r.rows[0] } });
  } catch {
    res.status(500).json({ success: false, error: "Could not rename the collection" });
  }
});

// Delete a collection (saved posts themselves are untouched).
router.delete("/collections/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `DELETE FROM social_post_collections WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user!.userId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Collection not found" });
    res.json({ success: true, message: "Collection deleted" });
  } catch {
    res.status(500).json({ success: false, error: "Could not delete the collection" });
  }
});

// Posts inside one collection — feed-shaped so the feed renderer works as-is.
router.get("/collections/:id/posts", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const owned = await query(
      `SELECT id FROM social_post_collections WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId],
    );
    if (!owned.rows.length) return res.status(404).json({ success: false, error: "Collection not found" });
    const itemsRes = await query(
      `SELECT post_id FROM social_post_collection_items WHERE collection_id = $1 ORDER BY saved_at DESC LIMIT $2`,
      [req.params.id, limit],
    );
    const postIds = itemsRes.rows.map((r) => r.post_id);
    const posts = await shapeSavedPosts(userId, postIds);
    const state = await savedStateForPosts(userId, postIds);
    const withState = posts.map((p: any) => ({ ...p, saved_collection_ids: state.get(String(p.id)) || [req.params.id] }));
    res.json({ success: true, data: { posts: withState } });
  } catch (e: any) {
    console.error("social/collections/:id/posts error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load the collection" });
  }
});

// Bookmark state for one post — drives the save sheet's pre-checked rows.
router.get("/posts/:id/save-state", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const postId = String(req.params.id);
    const state = await savedStateForPosts(req.user!.userId, [postId]);
    const collectionIds = state.get(postId) || [];
    res.json({ success: true, data: { saved: collectionIds.length > 0, collection_ids: collectionIds } });
  } catch {
    res.json({ success: true, data: { saved: false, collection_ids: [] } });
  }
});

// Save a post into one or more collections (create-on-the-fly supported).
router.post("/posts/:id/save", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const postId = String(req.params.id);
    const postRes = await query(`SELECT id FROM social_posts WHERE id = $1 AND status = 'active'`, [postId]);
    if (!postRes.rows.length) return res.status(404).json({ success: false, error: "Post not found" });

    const collectionIds = new Set<string>(
      Array.isArray(req.body?.collection_ids) ? req.body.collection_ids.map(String) : [],
    );
    const newName = String(req.body?.collection_name || "").trim().slice(0, 60);
    if (newName) {
      const ins = await query(
        `INSERT INTO social_post_collections (user_id, name) VALUES ($1, $2)
         ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [userId, newName],
      );
      if (ins.rows[0]?.id) collectionIds.add(String(ins.rows[0].id));
    }
    if (!collectionIds.size) {
      return res.status(400).json({ success: false, error: "Pick at least one collection" });
    }
    for (const cid of collectionIds) {
      await query(
        `INSERT INTO social_post_collection_items (collection_id, post_id)
         SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM social_post_collections WHERE id = $1 AND user_id = $3)
         ON CONFLICT (collection_id, post_id) DO NOTHING`,
        [cid, postId, userId],
      );
    }
    await query(
      `UPDATE social_post_collections SET updated_at = NOW() WHERE id = ANY($1::uuid[])`,
      [[...collectionIds]],
    );
    const state = await savedStateForPosts(userId, [postId]);
    res.json({
      success: true,
      message: "Post saved",
      data: { saved: true, collection_ids: state.get(postId) || [...collectionIds] },
    });
  } catch (e: any) {
    console.error("social/posts/:id/save error:", e?.message);
    res.status(500).json({ success: false, error: "Could not save the post" });
  }
});

// Unsave — from one collection (collection_id) or everywhere.
router.delete("/posts/:id/save", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const postId = String(req.params.id);
    const collectionId = req.body?.collection_id ? String(req.body.collection_id) : null;
    if (collectionId) {
      await query(
        `DELETE FROM social_post_collection_items i
         USING social_post_collections c
         WHERE i.collection_id = c.id AND c.user_id = $1 AND i.post_id = $2 AND i.collection_id = $3`,
        [userId, postId, collectionId],
      );
    } else {
      await query(
        `DELETE FROM social_post_collection_items i
         USING social_post_collections c
         WHERE i.collection_id = c.id AND c.user_id = $1 AND i.post_id = $2`,
        [userId, postId],
      );
    }
    const state = await savedStateForPosts(userId, [postId]);
    const collectionIds = state.get(postId) || [];
    res.json({ success: true, message: "Removed", data: { saved: collectionIds.length > 0, collection_ids: collectionIds } });
  } catch {
    res.status(500).json({ success: false, error: "Could not update the saved post" });
  }
});

// ---------------------------------------------------------------------------
// Report a post — feeds the admin moderation queue end-to-end
// ---------------------------------------------------------------------------
const REPORT_REASONS = new Set([
  "spam", "harassment", "hate_speech", "violence", "nudity",
  "misinformation", "scam", "self_harm", "other",
]);

router.post("/posts/:id/report", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const reason = String(req.body?.reason || "").trim();
    const details = String(req.body?.details || "").trim().slice(0, 1000);
    if (!REPORT_REASONS.has(reason)) {
      return res.status(400).json({ success: false, error: "Pick a reason for the report" });
    }
    const post = await query(`SELECT id FROM social_posts WHERE id = $1 AND status = 'active'`, [req.params.id]);
    if (!post.rows.length) return res.status(404).json({ success: false, error: "Post not found" });

    // One report per user per post (re-reporting just updates reason/details).
    const existing = await query(
      `SELECT id, status FROM social_post_reports WHERE post_id = $1 AND reporter_id = $2`,
      [req.params.id, userId],
    );
    if (existing.rows.length) {
      if (existing.rows[0].status === "pending") {
        await query(`UPDATE social_post_reports SET reason = $2, details = $3 WHERE id = $1`, [existing.rows[0].id, reason, details || null]);
        return res.json({ success: true, message: "Thanks — your report is already with our moderation team." });
      }
      return res.json({ success: true, message: "You already reported this post — our team has reviewed it." });
    }
    await query(
      `INSERT INTO social_post_reports (post_id, reporter_id, reason, details) VALUES ($1, $2, $3, $4)`,
      [req.params.id, userId, reason, details || null],
    );
    res.json({ success: true, message: "Report received — our moderation team will review it shortly." });
  } catch {
    res.status(500).json({ success: false, error: "Could not submit the report" });
  }
});

// Has the viewer already reported this post? (UI shows "Reported" state.)
router.get("/posts/:id/report-status", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `SELECT status FROM social_post_reports WHERE post_id = $1 AND reporter_id = $2 LIMIT 1`,
      [req.params.id, req.user!.userId],
    );
    res.json({ success: true, data: { reported: r.rows.length > 0, status: r.rows[0]?.status || null } });
  } catch {
    res.json({ success: true, data: { reported: false, status: null } });
  }
});

// ---------------------------------------------------------------------------
// Post view tracking — powers profile / video analytics
// ---------------------------------------------------------------------------
router.post("/posts/:id/view", async (req, res) => {
  try {
    // Best-effort viewer identity (optional auth — public posts are trackable
    // anonymously; logged-in viewers power "unique viewers" analytics).
    const viewerId: string | null = (req as any).user?.userId || null;
    const source = ["feed", "deep_link", "share", "boost"].includes(String(req.body?.source)) ? String(req.body.source) : "feed";
    // Skip self-views — authors never inflate their own analytics.
    const authorRow = await query(`SELECT user_id FROM social_posts WHERE id = $1 AND status = 'active'`, [req.params.id]);
    if (authorRow.rows.length && viewerId && String(authorRow.rows[0].user_id) === String(viewerId)) {
      return res.json({ success: true, skipped: true });
    }
    await query(
      `INSERT INTO social_post_views (post_id, author_id, viewer_id, source)
       SELECT p.id, p.user_id, $2, $3 FROM social_posts p WHERE p.id = $1 AND p.status = 'active'`,
      [req.params.id, viewerId, source],
    );
    await query(`UPDATE social_posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch {
    res.json({ success: true }); // never break the client over analytics
  }
});

// ---------------------------------------------------------------------------
// Analytics — profile-level + per-post (own content only)
// ---------------------------------------------------------------------------
router.get("/analytics/overview", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 28));
    const since = new Date(Date.now() - days * 86400000);

    const [totals, daily, top, engage] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS views, COUNT(DISTINCT viewer_id)::int AS unique_viewers
         FROM social_post_views WHERE author_id = $1 AND viewed_at >= $2`,
        [userId, since],
      ),
      query(
        `SELECT day::text, COUNT(*)::int AS views,
                COUNT(DISTINCT viewer_id)::int AS unique_viewers
         FROM social_post_views WHERE author_id = $1 AND viewed_at >= $2
         GROUP BY day ORDER BY day`,
        [userId, since],
      ),
      query(
        `SELECT p.id, p.body, p.image_url, p.video_url, p.created_at,
                COALESCE(p.view_count,0) AS view_count,
                (SELECT COUNT(*)::int FROM social_reactions r WHERE r.post_id = p.id) AS like_count,
                (SELECT COUNT(*)::int FROM social_comments c WHERE c.post_id = p.id AND c.status = 'active') AS comment_count,
                p.share_count
         FROM social_posts p WHERE p.user_id = $1 AND p.status = 'active'
         ORDER BY COALESCE(p.view_count,0) DESC, p.created_at DESC LIMIT 10`,
        [userId],
      ),
      query(
        `SELECT COUNT(*)::int AS posts,
           COALESCE(SUM((SELECT COUNT(*) FROM social_reactions r WHERE r.post_id = p.id)),0)::int AS likes,
           COALESCE(SUM((SELECT COUNT(*) FROM social_comments c WHERE c.post_id = p.id AND c.status = 'active')),0)::int AS comments,
           COALESCE(SUM(p.share_count),0)::int AS shares,
           COALESCE(SUM(COALESCE(p.view_count,0)),0)::int AS views
         FROM social_posts p WHERE p.user_id = $1 AND p.status = 'active' AND p.created_at >= $2`,
        [userId, since],
      ),
    ]);

    const e = engage.rows[0] || { posts: 0, likes: 0, comments: 0, shares: 0, views: 0 };
    const interactions = Number(e.likes) + Number(e.comments) + Number(e.shares);
    res.json({
      success: true,
      data: {
        window_days: days,
        totals: {
          views: Number(totals.rows[0]?.views || 0),
          unique_viewers: Number(totals.rows[0]?.unique_viewers || 0),
          posts: Number(e.posts || 0),
          likes: Number(e.likes || 0),
          comments: Number(e.comments || 0),
          shares: Number(e.shares || 0),
          engagement_rate: Number(e.views) > 0 ? Math.round((interactions / Number(e.views)) * 1000) / 10 : 0,
        },
        daily: daily.rows.map((d) => ({ day: d.day, views: Number(d.views), unique_viewers: Number(d.unique_viewers) })),
        top_posts: top.rows,
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load analytics" });
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
    const userId = req.user!.userId;
    const postRow = await query(`SELECT user_id FROM social_posts WHERE id = $1`, [req.params.id]);
    const isPostAuthor = !!postRow.rows.length && postRow.rows[0].user_id === userId;
    const r = await query(
      `SELECT c.id, c.post_id, c.parent_id, c.user_id, c.body, c.like_count, c.status, c.created_at,
              u.name AS author_name, u.avatar_url AS author_photo,
              EXISTS (SELECT 1 FROM social_comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = $2) AS liked_by_me
       FROM social_comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = $1 AND c.status = 'active'
       ORDER BY c.created_at ASC`,
      [req.params.id, userId],
    );
    const isAdmin = req.user!.businessId === "platform_admin";
    const comments = r.rows.map((c) => ({
      id: c.id, post_id: c.post_id, parent_id: c.parent_id ?? null,
      author: { id: c.user_id, name: c.author_name, photo: c.author_photo },
      // `body`/`content` aliases — the web client reads comment.body; shipping
      // only `message` made every comment render as username-only.
      message: c.body, body: c.body, content: c.body,
      like_count: c.like_count, liked_by_me: !!c.liked_by_me,
      // Edit = your own comment. Delete = your own comment, any comment on
      // your post, or platform admin.
      can_edit: c.user_id === userId,
      can_delete: c.user_id === userId || isPostAuthor || isAdmin,
      created_at: c.created_at,
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
      body, message: body, content: body, like_count: 0, created_at: r.rows[0].created_at,
    };
    res.status(201).json({ success: true, data: { comment }, comment });
  } catch (e: any) {
    console.error("comment create error:", e?.message);
    res.status(500).json({ success: false, error: "Could not comment" });
  }
});

router.delete("/comments/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    // Rules: you can delete YOUR OWN comment; the POST AUTHOR can delete any
    // comment on their post; platform admins can delete anything. Deleting a
    // comment also removes its replies (recursive descendants) so no orphaned
    // reply chains linger in the thread tree.
    const isAdmin = req.user!.businessId === "platform_admin";
    const row = await query(
      `SELECT c.id, c.user_id, p.user_id AS post_author_id
       FROM social_comments c
       JOIN social_posts p ON p.id = c.post_id
       WHERE c.id = $1 LIMIT 1`,
      [req.params.id],
    );
    if (!row.rows.length) return res.status(404).json({ success: false, error: "Comment not found" });
    const { user_id, post_author_id } = row.rows[0];
    const allowed = user_id === req.user!.userId || post_author_id === req.user!.userId || isAdmin;
    if (!allowed) return res.status(403).json({ success: false, error: "You can only delete your own comments" });
    // Recursive descendants (replies of replies included).
    await query(
      `WITH RECURSIVE tree AS (
         SELECT id FROM social_comments WHERE id = $1
         UNION ALL
         SELECT c.id FROM social_comments c JOIN tree t ON c.parent_id = t.id
       )
       DELETE FROM social_comments WHERE id IN (SELECT id FROM tree)`,
      [req.params.id],
    );
    res.json({ success: true, message: "Comment deleted" });
  } catch {
    res.status(500).json({ success: false, error: "Could not delete comment" });
  }
});

// ---------------------------------------------------------------------------
// Comment edit + comment likes
// ---------------------------------------------------------------------------
router.patch("/comments/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ success: false, error: "Comment cannot be empty" });
    if (body.length > 2000) return res.status(400).json({ success: false, error: "Comment too long" });
    const r = await query(
      `UPDATE social_comments SET body = $1 WHERE id = $2 AND user_id = $3 AND status = 'active' RETURNING id, post_id, parent_id, body, like_count, created_at`,
      [body, req.params.id, req.user!.userId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Comment not found (or not yours)" });
    const c = r.rows[0];
    res.json({
      success: true,
      data: { comment: { id: c.id, post_id: c.post_id, parent_id: c.parent_id ?? null, body: c.body, message: c.body, content: c.body, like_count: c.like_count, created_at: c.created_at, updated: true } },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not edit comment" });
  }
});

// Toggle a like on a comment OR reply (same endpoint — replies are comments).
router.post("/comments/:id/like", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const c = await query(`SELECT id, user_id FROM social_comments WHERE id = $1 AND status = 'active'`, [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ success: false, error: "Comment not found" });
    const existing = await query(
      `SELECT id FROM social_comment_likes WHERE comment_id = $1 AND user_id = $2`,
      [req.params.id, userId],
    );
    let liked: boolean;
    if (existing.rows.length) {
      await query(`DELETE FROM social_comment_likes WHERE id = $1`, [existing.rows[0].id]);
      await query(`UPDATE social_comments SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1`, [req.params.id]);
      liked = false;
    } else {
      await query(`INSERT INTO social_comment_likes (comment_id, user_id) VALUES ($1, $2)`, [req.params.id, userId]);
      await query(`UPDATE social_comments SET like_count = like_count + 1 WHERE id = $1`, [req.params.id]);
      liked = true;
      if (c.rows[0].user_id !== userId) {
        createNotification({
          businessId: (req.user!.businessId ?? "") as string,
          userId: c.rows[0].user_id,
          title: "New like",
          message: "Someone liked your comment",
          type: "social",
        }).catch(() => {});
      }
    }
    const cnt = await query(`SELECT like_count FROM social_comments WHERE id = $1`, [req.params.id]);
    res.json({ success: true, data: { liked_by_me: liked, like_count: cnt.rows[0]?.like_count ?? 0 } });
  } catch {
    res.status(500).json({ success: false, error: "Could not like the comment" });
  }
});

// ---------------------------------------------------------------------------
// Post edit — author only
// ---------------------------------------------------------------------------
router.patch("/posts/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const body = String(req.body?.body ?? "").trim();
    const hasBody = req.body?.body !== undefined;
    if (hasBody && !body) return res.status(400).json({ success: false, error: "Post cannot be empty" });
    if (body.length > 5000) return res.status(400).json({ success: false, error: "Post too long" });
    const r = await query(
      `UPDATE social_posts SET
         body = CASE WHEN $2 THEN $3 ELSE body END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $4 AND status = 'active'
       RETURNING id, body, image_url, video_url, updated_at`,
      [req.params.id, hasBody, body, req.user!.userId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Post not found (or not yours)" });
    res.json({ success: true, data: { post: r.rows[0] }, post: r.rows[0] });
  } catch {
    res.status(500).json({ success: false, error: "Could not edit post" });
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

/**
 * GET /social/share/post/:id — PUBLIC link-preview endpoint.
 *
 * WhatsApp / Telegram / X / iMessage scrape the shared URL server-side and
 * render its Open Graph tags. The app is an auth-gated SPA, so sharing
 * `/post/:id` produced the fallback SEO logo instead of the post media.
 * This endpoint returns a tiny HTML page whose og:* tags point at the POST's
 * own photo/video thumbnail (plus a meta-refresh + JS redirect into the app
 * for humans), so chats show the actual post media as the share thumbnail.
 * No auth by design — link previewers are anonymous.
 */
router.get("/share/post/:id", async (req, res) => {
  try {
    const r = await query(
      `SELECT p.id, p.body, p.image_url, p.video_url, p.created_at, u.name AS author_name, u.avatar_url AS author_photo
       FROM social_posts p JOIN users u ON u.id = p.user_id
       WHERE p.id = $1 AND p.status = 'active' LIMIT 1`,
      [req.params.id],
    );
    if (!r.rows.length) return res.status(404).send("<html><body><p>Post not found</p></body></html>");
    const p = r.rows[0];

    // Multi-media posts: the ordered carousel is the best thumbnail source —
    // first image wins, else the first video's captured poster frame.
    let ogMediaImage = "";
    let ogMediaVideo = "";
    try {
      const m = await query(
        `SELECT media_type, url, poster_url FROM social_post_media WHERE post_id = $1 ORDER BY position, created_at LIMIT 10`,
        [req.params.id],
      );
      ogMediaImage = String(m.rows.find((x) => x.media_type === "image")?.url || m.rows.find((x) => x.poster_url)?.poster_url || "");
      ogMediaVideo = String(m.rows.find((x) => x.media_type === "video")?.url || "");
    } catch { /* pre-upgrade post — legacy columns below */ }

    const host = `https://${req.headers.host || "api.metricorex.com"}`;
    const appUrl = process.env.PERSONAL_SITE_URL || "https://personal.metricorex.com";
    const apiOrigin = String(
      process.env.API_PUBLIC_BASE_URL || process.env.APP_BASE_URL || host,
    ).replace(/\/$/, "");
    // Stored post media can be:
    //   1. a full https URL          → use as-is
    //   2. a root-relative path      → prefix the API origin
    //      ("/uploads/x.jpg", "/files/<key>")
    //   3. a bare R2 object KEY      → "/files/<key>" then the origin — this is
    //      the shape that previously produced "https://host/bare-key" and
    //      broken share thumbnails for R2-backed posts.
    const abs = (u?: string | null) => {
      if (!u) return "";
      const s = String(u).trim();
      if (!s) return "";
      if (/^https?:\/\//i.test(s)) return s;
      if (/^uploads\//i.test(s)) return `${apiOrigin}/uploads/${s.slice("uploads/".length)}`;
      if (s.startsWith("/")) return `${apiOrigin}${s}`;
      return `${apiOrigin}/files/${s}`;
    };
    const image = ogMediaImage || abs(p.image_url) || abs(p.author_photo);
    const video = ogMediaVideo || abs(p.video_url);
    // Video posts: some scrapers only render images — reuse the poster image
    // when present, otherwise point og:image at the video (WhatsApp falls
    // back to a frame) and ship the og:video tag for the ones that honor it.
    const ogImage = image || video;
    const excerpt = String(p.body || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const title = `${p.author_name || "Someone"} on MetriCorex`;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const target = `${appUrl}/post/${p.id}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(`<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<meta property="og:type" content="${video ? "video.other" : "article"}" />
<meta property="og:site_name" content="MetriCorex" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(excerpt || "Check this out on MetriCorex")}" />
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}" />\n<meta property="og:image:secure_url" content="${esc(ogImage)}" />\n<meta property="og:image:width" content="1200" />\n<meta property="og:image:height" content="630" />` : ""}
${video ? `<meta property="og:video" content="${esc(video)}" />\n<meta property="og:video:secure_url" content="${esc(video)}" />` : ""}
<meta name="twitter:card" content="${video && !image ? "player" : "summary_large_image"}" />
${ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}" />` : ""}
<meta http-equiv="refresh" content="0;url=${esc(target)}" />
</head><body>
<script>window.location.replace(${JSON.stringify(target)});</script>
<noscript><p>Opening MetriCorex… <a href="${esc(target)}">Continue</a></p></noscript>
</body></html>`);
  } catch {
    res.status(500).send("<html><body><p>Preview unavailable</p></body></html>");
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

    // Free vs paid: paid polls charge each voter `vote_price` from their NGN
    // wallet into the poll pool; the creator withdraws at maturity (fee →
    // revenue ledger). Paid polls are single-choice and votes are final.
    const settings = await getPollSettings();
    const pollType = req.body?.poll_type === "paid" ? "paid" : "free";
    let votePrice = 0;
    if (pollType === "paid") {
      votePrice = Math.round(Number(req.body?.vote_price ?? settings.default_vote_price) * 100) / 100;
      if (!Number.isFinite(votePrice) || votePrice < settings.min_vote_price || votePrice > settings.max_vote_price) {
        return res.status(400).json({
          success: false,
          error: `Vote price must be between ₦${settings.min_vote_price.toLocaleString()} and ₦${settings.max_vote_price.toLocaleString()}`,
          code: "INVALID_VOTE_PRICE",
        });
      }
    }

    // A poll is a post whose body carries the question — keeps one feed model.
    const post = await query(
      `INSERT INTO social_posts (user_id, body, audience) VALUES ($1, $2, 'public') RETURNING id, created_at`,
      [userId, question],
    );
    const r = await query(
      `INSERT INTO social_polls (post_id, user_id, question, options, allow_multiple, hide_results_until_closed, ends_at, poll_type, vote_price)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING *`,
      [post.rows[0].id, userId, question, JSON.stringify(options), allowMultiple && pollType === "free", hideResults, endsAt, pollType, votePrice],
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

    // ---- PAID POLLS: ₦ vote_price per vote, debited from the voter's NGN
    // wallet into the poll pool. Single choice, votes are FINAL (no toggle,
    // no refund, one vote per user). PIN-verified like every money flow.
    if ((p.poll_type || "free") === "paid") {
      // Voting with a wallet = selecting/using a wallet → KYC must be done.
      // (Free polls stay open to everyone — no KYC gate on this branch.)
      if (!(await isPersonalKycVerified(userId))) {
        return res.status(403).json({
          success: false, code: "KYC_REQUIRED",
          error: "KYC verification is required to vote on paid polls. Please complete your KYC verification.",
        });
      }
      const already = await query(`SELECT id FROM social_poll_votes WHERE poll_id = $1 AND user_id = $2 LIMIT 1`, [p.id, userId]);
      if (already.rows.length) {
        return res.status(400).json({ success: false, error: "You have already voted on this paid poll", code: "ALREADY_VOTED" });
      }
      if (p.user_id === userId) {
        return res.status(400).json({ success: false, error: "You cannot vote on your own paid poll", code: "SELF_VOTE" });
      }
      const pinCheck = await verifyTransactionPin(req.body?.pin, { userId });
      if (!pinCheck.ok) {
        return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });
      }
      const w = await query(
        `SELECT id, balance, currency FROM wallets WHERE user_id = $1 AND UPPER(currency) = 'NGN' AND status = 'active' LIMIT 1`,
        [userId],
      );
      if (!w.rows.length) return res.status(400).json({ success: false, error: "You need an active NGN wallet to vote on paid polls", code: "NO_WALLET" });
      const price = Number(p.vote_price) || 0;
      if (Number(w.rows[0].balance) < price) {
        return res.status(400).json({ success: false, error: "Insufficient NGN wallet balance to vote", code: "INSUFFICIENT_BALANCE" });
      }
      if (!(await debitWallet(w.rows[0].id, price))) {
        return res.status(400).json({ success: false, error: "Insufficient NGN wallet balance to vote", code: "INSUFFICIENT_BALANCE" });
      }
      try {
        await query(
          `UPDATE social_polls SET pool_earned = pool_earned + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [p.id, price],
        );
        await query(
          `INSERT INTO social_poll_votes (poll_id, user_id, option_index, amount_paid) VALUES ($1,$2,$3,$4)`,
          [p.id, userId, valid[0], price],
        );
      } catch (voteErr: any) {
        // Roll the wallet debit back — never take money without recording the vote.
        await creditWallet(w.rows[0].id, price).catch(() => {});
        throw voteErr;
      }
      const reference = genRef("MF-PV");
      await insertTransaction({
        userId, walletId: w.rows[0].id, reference, type: "debit",
        transactionType: "poll_vote", amount: price, currency: "NGN",
        description: `Paid poll vote — “${String(p.question).slice(0, 60)}”`,
      });
      if (p.user_id !== userId) {
        createNotification({
          businessId: (req.user!.businessId ?? "") as string,
          userId: p.user_id,
          title: "New paid vote",
          message: `Someone voted on your paid poll (+₦${price.toLocaleString()} to your Vote Pocket)`,
          type: "social",
        }).catch(() => {});
      }
      const votesRes = await query(
        `SELECT option_index, COUNT(*)::int AS votes FROM social_poll_votes WHERE poll_id = $1 GROUP BY option_index`,
        [p.id],
      );
      const mine = await query(`SELECT option_index FROM social_poll_votes WHERE poll_id = $1 AND user_id = $2`, [p.id, userId]);
      const pool = await query(`SELECT pool_earned FROM social_polls WHERE id = $1`, [p.id]);
      return res.json({
        success: true,
        data: {
          total_votes: votesRes.rows.reduce((a, v) => a + v.votes, 0),
          results: (p.options || []).map((o: any, i: number) => ({
            index: i, text: o.text, vote_count: votesRes.rows.find((v) => v.option_index === i)?.votes || 0,
          })),
          my_votes: mine.rows.map((m) => m.option_index),
          charged: price,
          pool_earned: Number(pool.rows[0]?.pool_earned) || 0,
        },
      });
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
// Paid-poll economics — pricing read, pool withdrawal, aggregate pocket
// ---------------------------------------------------------------------------
router.get("/polls/pricing", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await getPollSettings();
    res.json({ success: true, data: s });
  } catch {
    res.status(500).json({ success: false, error: "Could not load poll pricing" });
  }
});

// Creator withdraws a matured paid poll's pool to their NGN wallet. The
// admin-configured fee is deducted here and posted to the platform revenue
// ledger (creditRevenueWallet) so it shows in the admin Revenue history.
router.post("/polls/:id/withdraw", authenticateToken, requirePersonalKyc(), async (req: AuthenticatedRequest, res) => {
  const userId = req.user!.userId;
  try {
    const settings = await getPollSettings();
    const poll = await query(
      `SELECT id, user_id, question, poll_type, pool_earned, pool_withdrawn, ends_at, status
       FROM social_polls WHERE id = $1`,
      [req.params.id],
    );
    if (!poll.rows.length) return res.status(404).json({ success: false, error: "Poll not found" });
    const p = poll.rows[0];
    if (p.user_id !== userId) return res.status(403).json({ success: false, error: "You can only withdraw your own polls" });
    if ((p.poll_type || "free") !== "paid") return res.status(400).json({ success: false, error: "Only paid polls carry a withdrawable pool", code: "NOT_PAID" });

    // Maturity: closed by the creator, past its ends_at, or (never-scheduled)
    // closed manually — an open, unexpired poll is still collecting votes.
    const matured = p.status === "closed" || (p.ends_at && new Date(p.ends_at) < new Date());
    if (!matured) {
      return res.status(400).json({ success: false, error: "This poll hasn't matured yet — close it or wait for its end time", code: "NOT_MATURED" });
    }

    const amount = Math.round(Number(req.body?.amount ?? 0) * 100) / 100;
    const available = Math.max(0, (Number(p.pool_earned) || 0) - (Number(p.pool_withdrawn) || 0));
    const target = amount > 0 ? amount : available;
    if (target <= 0) return res.status(400).json({ success: false, error: "Nothing to withdraw yet — this pool is empty", code: "EMPTY_POOL" });
    if (target < settings.withdrawal_min) {
      return res.status(400).json({
        success: false, code: "BELOW_MIN",
        error: `Minimum withdrawal is ₦${settings.withdrawal_min.toLocaleString()} (available ₦${available.toLocaleString()})`,
      });
    }

    const pinCheck = await verifyTransactionPin(req.body?.pin, { userId });
    if (!pinCheck.ok) return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });

    // Atomic guard: only withdraw what the pool actually still holds.
    const upd = await query(
      `UPDATE social_polls
          SET pool_withdrawn = pool_withdrawn + $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND (pool_earned - pool_withdrawn) >= $2
        RETURNING pool_earned, pool_withdrawn`,
      [p.id, target],
    );
    if (!upd.rows.length) {
      return res.status(400).json({ success: false, error: "Pool changed — please retry", code: "POOL_RACE" });
    }

    const fee = Math.round((target * (Number(settings.withdrawal_fee_percent) || 0) / 100
      + (Number(settings.withdrawal_fee_flat) || 0)) * 100) / 100;
    const net = Math.max(0, Math.round((target - fee) * 100) / 100);
    const reference = genRef("PPLWD");

    try {
      // The withdrawal fee is admin revenue — land it in the revenue ledger.
      if (fee > 0) {
        await creditRevenueWallet(fee, "NGN", reference, `Poll withdrawal fee — “${String(p.question).slice(0, 50)}”`, null, undefined, { revenueType: "fee" });
      }
      const w = await query(
        `SELECT id FROM wallets WHERE user_id = $1 AND UPPER(currency) = 'NGN' AND status = 'active' LIMIT 1`,
        [userId],
      );
      if (!w.rows.length) throw new Error("NO_NGN_WALLET");
      await creditWallet(w.rows[0].id, net);
      await insertTransaction({
        userId, walletId: w.rows[0].id, reference, type: "credit",
        transactionType: "poll_withdrawal", amount: net, currency: "NGN",
        description: `Poll earnings withdrawal${fee > 0 ? ` (fee ₦${fee.toLocaleString()})` : ""}`,
      });
      const wd = await query(
        `INSERT INTO poll_withdrawals (poll_id, user_id, amount, fee, net_amount, reference)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
        [p.id, userId, target, fee, net, reference],
      );
      return res.json({
        success: true,
        data: {
          withdrawal: { id: wd.rows[0].id, amount: target, fee, net_amount: net, reference, created_at: wd.rows[0].created_at },
          pool: { earned: upd.rows[0].pool_earned, withdrawn: upd.rows[0].pool_withdrawn },
          message: `₦${net.toLocaleString()} sent to your NGN wallet${fee > 0 ? ` (fee ₦${fee.toLocaleString()})` : ""}`,
        },
      });
    } catch (finErr: any) {
      // Roll the pool back — money must never leave the pool without a payout.
      await query(
        `UPDATE social_polls SET pool_withdrawn = GREATEST(0, pool_withdrawn - $2), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [p.id, target],
      ).catch(() => {});
      console.error("poll withdraw error:", finErr?.message);
      return res.status(500).json({ success: false, error: "Could not complete withdrawal — please try again" });
    }
  } catch (e: any) {
    console.error("poll withdraw error:", e?.message);
    res.status(500).json({ success: false, error: "Could not withdraw poll earnings" });
  }
});

// Aggregate Vote Pocket across all of the creator's paid polls.
router.get("/vote-pocket", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const settings = await getPollSettings();
    const totals = await query(
      `SELECT COALESCE(SUM(pool_earned),0)::float AS total_earned,
              COALESCE(SUM(pool_withdrawn),0)::float AS total_withdrawn
       FROM social_polls WHERE user_id = $1 AND poll_type = 'paid'`,
      [userId],
    );
    const withdrawals = await query(
      `SELECT w.id, w.poll_id, w.amount, w.fee, w.net_amount, w.reference, w.status, w.created_at,
              p.question AS poll_question
       FROM poll_withdrawals w JOIN social_polls p ON p.id = w.poll_id
       WHERE w.user_id = $1 ORDER BY w.created_at DESC LIMIT 20`,
      [userId],
    );
    const pools = await query(
      `SELECT id, post_id, question, vote_price, pool_earned, pool_withdrawn, status, ends_at, created_at,
              (SELECT COUNT(*)::int FROM social_poll_votes v WHERE v.poll_id = social_polls.id) AS total_votes
       FROM social_polls
       WHERE user_id = $1 AND poll_type = 'paid' AND status != 'removed'
       ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    const earned = Number(totals.rows[0]?.total_earned) || 0;
    const withdrawn = Number(totals.rows[0]?.total_withdrawn) || 0;
    res.json({
      success: true,
      data: {
        balance: Math.max(0, Math.round((earned - withdrawn) * 100) / 100),
        total_earned: earned,
        total_withdrawn: withdrawn,
        currency: settings.currency,
        fees: {
          withdrawal_fee_percent: settings.withdrawal_fee_percent,
          withdrawal_fee_flat: settings.withdrawal_fee_flat,
          withdrawal_min: settings.withdrawal_min,
        },
        pools: pools.rows.map((r) => ({
          ...r,
          pool_earned: Number(r.pool_earned) || 0,
          pool_withdrawn: Number(r.pool_withdrawn) || 0,
          withdrawable: Math.max(0, (Number(r.pool_earned) || 0) - (Number(r.pool_withdrawn) || 0)),
          matured: r.status === "closed" || (r.ends_at && new Date(r.ends_at) < new Date()),
        })),
        withdrawals: withdrawals.rows,
      },
    });
  } catch (e: any) {
    console.error("vote-pocket error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load vote pocket" });
  }
});

// ---------------------------------------------------------------------------
// POST BOOST — wallet-funded paid placement
// ---------------------------------------------------------------------------
router.post("/posts/:id/boost", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
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

// ---------------------------------------------------------------------------
// ACCOUNT VERIFICATION BADGE — monthly subscription with auto-evaluated
// criteria. Pricing is admin-controlled (system_settings
// `verification_badge_pricing` = { price, currency, duration_days }).
//   GET  /social/verification/status   → criteria checklist + pricing + sub
//   POST /social/verification/subscribe { pin, wallet_id }
// Badge exposure: users.verified_badge_status + verified_until; is_verified
// is computed (active AND verified_until > NOW()) wherever users are served.
// ---------------------------------------------------------------------------

export interface VerificationPricing {
  price: number;
  currency: string;
  duration_days: number;
}

const DEFAULT_VERIFICATION_PRICING: VerificationPricing = {
  price: 2500,
  currency: "NGN",
  duration_days: 30,
};

export async function getVerificationPricing(): Promise<VerificationPricing> {
  try {
    const raw = await getSetting("verification_badge_pricing", "");
    if (raw) {
      const p = JSON.parse(raw);
      return {
        price: Math.max(0, Number(p.price) || DEFAULT_VERIFICATION_PRICING.price),
        currency: String(p.currency || DEFAULT_VERIFICATION_PRICING.currency),
        duration_days: Math.max(1, Number(p.duration_days) || DEFAULT_VERIFICATION_PRICING.duration_days),
      };
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_VERIFICATION_PRICING;
}

/** Evaluate every eligibility criterion for the badge. */
export async function evaluateVerificationCriteria(userId: string): Promise<Array<{ key: string; label: string; passed: boolean; detail: string }>> {
  const MIN_FOLLOWERS = 50;
  const MIN_POSTS = 5;
  const MIN_AGE_DAYS = 30;

  const [u, followers, posts, violations] = await Promise.all([
    query(
      `SELECT kyc_status, phone_verified, avatar_url, bio, username, created_at FROM users WHERE id = $1`,
      [userId],
    ),
    query(`SELECT COUNT(*)::int AS n FROM social_follows WHERE following_id = $1`, [userId]),
    query(`SELECT COUNT(*)::int AS n FROM social_posts WHERE user_id = $1 AND status = 'active'`, [userId]),
    query(
      `SELECT COUNT(*)::int AS n FROM social_post_reports r
       JOIN social_posts p ON p.id = r.post_id
       WHERE p.user_id = $1 AND r.status = 'actioned' AND r.decision IN ('remove_post') AND r.decided_at >= NOW() - INTERVAL '90 days'`,
      [userId],
    ),
  ]);

  const row = u.rows[0] || {};
  const bio = String(row.bio || "").trim();
  const username = String(row.username || "").trim();
  const avatar = String(row.avatar_url || "").trim();
  const profileScore = [avatar, bio.length >= 20, username].filter(Boolean).length;
  const ageDays = row.created_at ? Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400000) : 0;

  return [
    { key: "kyc", label: "Identity verified (KYC)", passed: String(row.kyc_status) === "verified", detail: String(row.kyc_status) === "verified" ? "Your identity is verified" : "Complete KYC in the app to verify your identity" },
    { key: "phone", label: "Phone number verified", passed: row.phone_verified === true, detail: row.phone_verified ? "Phone verified" : "Verify your phone number in Account settings" },
    { key: "profile", label: "Complete profile (photo, bio, username)", passed: profileScore === 3, detail: `${profileScore}/3 done — ${!avatar ? "add a photo, " : ""}${bio.length < 20 ? "write a longer bio, " : ""}${!username ? "set a username" : ""}`.replace(/, $/, "") || "Profile complete" },
    { key: "age", label: `Account at least ${MIN_AGE_DAYS} days old`, passed: ageDays >= MIN_AGE_DAYS, detail: `${ageDays} day${ageDays === 1 ? "" : "s"} so far` },
    { key: "followers", label: `At least ${MIN_FOLLOWERS} followers`, passed: Number(followers.rows[0]?.n) >= MIN_FOLLOWERS, detail: `${Number(followers.rows[0]?.n) || 0}/${MIN_FOLLOWERS} followers` },
    { key: "posts", label: `At least ${MIN_POSTS} posts`, passed: Number(posts.rows[0]?.n) >= MIN_POSTS, detail: `${Number(posts.rows[0]?.n) || 0}/${MIN_POSTS} active posts` },
    { key: "standing", label: "Good standing (no removed posts in 90 days)", passed: Number(violations.rows[0]?.n) === 0, detail: Number(violations.rows[0]?.n) === 0 ? "No moderation actions against you" : "Recent content was removed after community reports" },
  ];
}

router.get("/verification/status", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const [pricing, criteria, subRows, badgeRow] = await Promise.all([
      getVerificationPricing(),
      evaluateVerificationCriteria(userId),
      query(
        `SELECT * FROM verification_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId],
      ),
      query(`SELECT verified_badge_status, verified_until, verified_badge_source FROM users WHERE id = $1`, [userId]),
    ]);

    // Lazy expiry — a stale 'active' badge past its end date flips to expired.
    // Criteria-earned badges (verified_badge_source = 'criteria') have NO end
    // date and never expire here.
    const until = badgeRow.rows[0]?.verified_until ? new Date(badgeRow.rows[0].verified_until) : null;
    let badge = String(badgeRow.rows[0]?.verified_badge_status || "none");
    if (badge === "active" && until && until.getTime() < Date.now()) {
      await query(`UPDATE users SET verified_badge_status = 'expired' WHERE id = $1`, [userId]);
      await query(`UPDATE verification_subscriptions SET status = 'expired' WHERE user_id = $1 AND status = 'active'`, [userId]);
      badge = "expired";
    }
    const activeBadge = badge === "active" && (!until || until.getTime() > Date.now());
    const daysLeft = activeBadge && until ? Math.max(0, Math.ceil((until.getTime() - Date.now()) / 86400000)) : 0;

    res.json({
      success: true,
      data: {
        pricing,
        criteria,
        eligible: criteria.every((c) => c.passed),
        badge: activeBadge ? "active" : badge,
        verified_until: activeBadge ? until : null,
        days_left: daysLeft,
        subscription: subRows.rows[0]
          ? {
              status: subRows.rows[0].status,
              price: Number(subRows.rows[0].price),
              currency: subRows.rows[0].currency,
              duration_days: subRows.rows[0].duration_days,
              starts_at: subRows.rows[0].starts_at,
              ends_at: subRows.rows[0].ends_at,
            }
          : null,
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load verification status" });
  }
});

router.post("/verification/subscribe", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { pin, wallet_id } = req.body || {};
    const pricing = await getVerificationPricing();

    // All criteria must pass — no paying around the checklist.
    const criteria = await evaluateVerificationCriteria(userId);
    if (!criteria.every((c) => c.passed)) {
      return res.status(400).json({
        success: false,
        code: "CRITERIA_NOT_MET",
        error: "You don't meet all the verification criteria yet",
        data: { criteria },
      });
    }

    const wallet = await getOwnedWallet(String(wallet_id || ""), userId, req.user!.businessId ?? null);
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
    const price = Math.round(pricing.price * 100) / 100;
    if (Number(wallet.balance) < price) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: `Insufficient balance — the badge costs ${pricing.currency === "NGN" ? "₦" : ""}${price.toLocaleString()}/${pricing.duration_days} days` });
    }
    const pinCheck = await verifyTransactionPin(pin, { userId, businessId: req.user!.businessId ?? null, wallet });
    if (!pinCheck.ok) {
      return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });
    }

    const reference = genRef("MF-VFY");
    if (!(await debitWallet(wallet.id, price))) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: "Insufficient wallet balance" });
    }
    await insertTransaction({
      userId, businessId: wallet.business_id, walletId: wallet.id, reference,
      type: "debit", transactionType: "verification_badge", amount: price, currency: wallet.currency,
      fee: 0, description: `Verified badge — ${pricing.duration_days} day subscription`,
    });
    await creditRevenueWallet(price, wallet.currency, reference, `Verified badge subscription — revenue`);

    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + pricing.duration_days * 86400000);
    await query(
      `INSERT INTO verification_subscriptions (user_id, price, currency, duration_days, status, reference, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)`,
      [userId, price, wallet.currency, pricing.duration_days, reference, startsAt, endsAt],
    );
    await query(
      `UPDATE users SET verified_badge_status = 'active', verified_badge_source = 'subscription', verified_since = CURRENT_TIMESTAMP, verified_until = $2 WHERE id = $1`,
      [userId, endsAt],
    );
    createNotification({
      businessId: (req.user!.businessId ?? "") as string,
      userId,
      type: "verification",
      title: "You're verified ✓",
      message: `Your verified badge is active for the next ${pricing.duration_days} days. Thank you for keeping your account in good standing!`,
    }).catch(() => {});

    res.json({ success: true, data: { verified_until: endsAt, days_left: pricing.duration_days } });
  } catch (e: any) {
    console.error("verification subscribe error:", e?.message);
    res.status(500).json({ success: false, error: "Could not subscribe to the verified badge" });
  }
});
