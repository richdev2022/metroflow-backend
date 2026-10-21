import express from "express";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";

const router = express.Router();

/**
 * Social (Personal) — feed posts with likes + comments, and interactive
 * polls. Separate from the chat "stories" (statuses): the feed is the
 * evergreen timeline — post updates, share moments, react and comment,
 * run polls and settle debates.
 *
 * Tables (see ensureSocialSchema): feed_posts, feed_likes, feed_comments,
 * polls, poll_votes.
 */

export async function ensureSocialSchema(): Promise<void> {
    await query(`
    CREATE TABLE IF NOT EXISTS feed_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      body TEXT NOT NULL,
      image_url TEXT,
      like_count INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_feed_posts_recent ON feed_posts(created_at DESC)`);

    await query(`
    CREATE TABLE IF NOT EXISTS feed_likes (
      post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, user_id)
    )
  `);

    await query(`
    CREATE TABLE IF NOT EXISTS feed_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_feed_comments_post ON feed_comments(post_id, created_at ASC)`);

    await query(`
    CREATE TABLE IF NOT EXISTS polls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      question TEXT NOT NULL,
      options JSONB NOT NULL,                 -- [{ text, vote_count }]
      ends_at TIMESTAMP,
      status VARCHAR(12) DEFAULT 'open',      -- open | closed
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_polls_recent ON polls(created_at DESC)`);

    await query(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      option_index INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (poll_id, user_id)
    )
  `);
}

function authorFields(alias = "u"): string {
    return `
    ${alias}.id AS author_id,
    COALESCE(${alias}.first_name || ' ' || ${alias}.last_name, ${alias}.full_name, ${alias}.username, 'Member') AS author_name,
    ${alias}.profile_photo_url AS author_photo,
    ${alias}.username AS author_username`;
}

/**
 * @swagger
 * tags:
 *   name: Social
 *   description: Personal social feed (posts, likes, comments) and polls
 */

/**
 * @swagger
 * /social/feed:
 *   get:
 *     summary: The personal timeline — feed posts and active polls, newest first
 *     tags: [Social]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/feed", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const params: any[] = [userId];
    let postWhere = "";
    if (before && !Number.isNaN(before.getTime())) {
        params.push(before.toISOString());
        postWhere = `AND p.created_at < $${params.length}`;
    }

    const postsRes = await query(
        `SELECT p.*, ${authorFields("u")},
            EXISTS (SELECT 1 FROM feed_likes fl WHERE fl.post_id = p.id AND fl.user_id = $1) AS liked_by_me
         FROM feed_posts p JOIN users u ON u.id = p.user_id
         WHERE TRUE ${postWhere}
         ORDER BY p.created_at DESC LIMIT 30`,
        params,
    );

    const pollsRes = await query(
        `SELECT pl.*, ${authorFields("u")},
            (SELECT COUNT(*)::int FROM poll_votes pv WHERE pv.poll_id = pl.id) AS total_votes,
            (SELECT pv2.option_index FROM poll_votes pv2 WHERE pv2.poll_id = pl.id AND pv2.user_id = $1 LIMIT 1) AS my_vote
         FROM polls pl JOIN users u ON u.id = pl.user_id
         ORDER BY pl.created_at DESC LIMIT 15`,
        params,
    );

    // Merge into one timeline.
    type Item = { kind: "post" | "poll"; at: string; data: any };
    const timeline: Item[] = [
        ...postsRes.rows.map((p: any) => ({ kind: "post" as const, at: new Date(p.created_at).toISOString(), data: p })),
        ...pollsRes.rows.map((p: any) => ({ kind: "poll" as const, at: new Date(p.created_at).toISOString(), data: p })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));

    res.json({
        success: true,
        data: {
            timeline: timeline.slice(0, 40).map((t) => ({
                kind: t.kind,
                id: t.data.id,
                author: {
                    id: t.data.author_id,
                    name: t.data.author_name,
                    photo: t.data.author_photo,
                    username: t.data.author_username,
                },
                body: t.data.body ?? t.data.question,
                image_url: t.data.image_url || null,
                like_count: Number(t.data.like_count) || 0,
                comment_count: Number(t.data.comment_count) || 0,
                liked_by_me: Boolean(t.data.liked_by_me),
                options: t.data.options || undefined,
                ends_at: t.data.ends_at || null,
                status: t.data.status || undefined,
                total_votes: t.data.total_votes ?? undefined,
                my_vote: t.data.my_vote ?? undefined,
                created_at: t.at,
            })),
        },
    });
});

/**
 * @swagger
 * /social/posts:
 *   post:
 *     summary: Create a feed post
 *     tags: [Social]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/posts", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const body = String(req.body?.body || "").trim();
    const imageUrl = req.body?.image_url ? String(req.body.image_url).trim() : null;
    if (!body && !imageUrl) return res.status(400).json({ success: false, error: "Post cannot be empty" });
    if (body.length > 2000) return res.status(400).json({ success: false, error: "Post is too long (2000 chars max)" });

    const insert = await query(
        `INSERT INTO feed_posts (user_id, body, image_url) VALUES ($1, $2, $3) RETURNING *`,
        [userId, body || "📷", imageUrl],
    );
    res.status(201).json({ success: true, data: { post: insert.rows[0] } });
});

/**
 * @swagger
 * /social/posts/{id}:
 *   delete:
 *     summary: Delete your own feed post
 *     tags: [Social]
 *     security: [{ bearerAuth: [] }]
 */
router.delete("/posts/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const del = await query(`DELETE FROM feed_posts WHERE id = $1 AND user_id = $2 RETURNING id`, [String(req.params.id), userId]);
    if (del.rows.length === 0) return res.status(404).json({ success: false, error: "Post not found (or not yours)" });
    res.json({ success: true });
});

/**
 * @swagger
 * /social/posts/{id}/like:
 *   post:
 *     summary: Like / unlike a post
 *     tags: [Social]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/posts/:id/like", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const postId = String(req.params.id);
    const postRes = await query(`SELECT id FROM feed_posts WHERE id = $1`, [postId]);
    if (postRes.rows.length === 0) return res.status(404).json({ success: false, error: "Post not found" });

    const existing = await query(`SELECT 1 FROM feed_likes WHERE post_id = $1 AND user_id = $2`, [postId, userId]);
    let liked: boolean;
    if (existing.rows.length > 0) {
        await query(`DELETE FROM feed_likes WHERE post_id = $1 AND user_id = $2`, [postId, userId]);
        await query(`UPDATE feed_posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1`, [postId]);
        liked = false;
    } else {
        await query(`INSERT INTO feed_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [postId, userId]);
        await query(`UPDATE feed_posts SET like_count = like_count + 1 WHERE id = $1`, [postId]);
        liked = true;
    }
    const count = await query(`SELECT like_count FROM feed_posts WHERE id = $1`, [postId]);
    res.json({ success: true, data: { liked, like_count: Number(count.rows[0]?.like_count || 0) } });
});

/**
 * @swagger
 * /social/posts/{id}/comments:
 *   get:
 *     summary: List comments on a post
 *     tags: [Social]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/posts/:id/comments", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const rows = await query(
        `SELECT c.*, ${authorFields("u")}
         FROM feed_comments c JOIN users u ON u.id = c.user_id
         WHERE c.post_id = $1 ORDER BY c.created_at ASC LIMIT 200`,
        [String(req.params.id)],
    );
    res.json({
        success: true,
        data: {
            comments: rows.rows.map((c: any) => ({
                id: c.id,
                author: { id: c.author_id, name: c.author_name, photo: c.author_photo, username: c.author_username },
                body: c.body,
                created_at: c.created_at,
            })),
        },
    });
});

/**
 * @swagger
 * /social/posts/{id}/comments:
 *   post:
 *     summary: Comment on a post
 *     tags: [Social]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/posts/:id/comments", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const postId = String(req.params.id);
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ success: false, error: "Comment cannot be empty" });
    if (body.length > 1000) return res.status(400).json({ success: false, error: "Comment too long" });

    const postRes = await query(`SELECT id FROM feed_posts WHERE id = $1`, [postId]);
    if (postRes.rows.length === 0) return res.status(404).json({ success: false, error: "Post not found" });

    const insert = await query(
        `INSERT INTO feed_comments (post_id, user_id, body) VALUES ($1, $2, $3) RETURNING *`,
        [postId, userId, body],
    );
    await query(`UPDATE feed_posts SET comment_count = comment_count + 1 WHERE id = $1`, [postId]);
    res.status(201).json({ success: true, data: { comment: insert.rows[0] } });
});

/**
 * @swagger
 * /social/polls:
 *   post:
 *     summary: Create a poll (2-6 options, optional ends_at)
 *     tags: [Social]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/polls", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const question = String(req.body?.question || "").trim();
    const rawOptions = Array.isArray(req.body?.options) ? req.body.options : [];
    const options = rawOptions.map((o: any) => String(o).trim()).filter(Boolean).slice(0, 6);
    const endsAt = req.body?.ends_at ? new Date(String(req.body.ends_at)) : null;

    if (!question) return res.status(400).json({ success: false, error: "Poll question is required" });
    if (options.length < 2) return res.status(400).json({ success: false, error: "A poll needs at least 2 options" });
    if (endsAt && Number.isNaN(endsAt.getTime())) return res.status(400).json({ success: false, error: "ends_at is invalid" });

    const insert = await query(
        `INSERT INTO polls (user_id, question, options, ends_at)
         VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
        [userId, question, JSON.stringify(options.map((text: string) => ({ text, vote_count: 0 }))),
         endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt.toISOString() : null],
    );
    res.status(201).json({ success: true, data: { poll: insert.rows[0] } });
});

/**
 * @swagger
 * /social/polls/{id}/vote:
 *   post:
 *     summary: Vote (or change your vote) on a poll
 *     tags: [Social]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/polls/:id/vote", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const pollId = String(req.params.id);
    const optionIndex = Number(req.body?.option_index);

    const pollRes = await query(`SELECT * FROM polls WHERE id = $1`, [pollId]);
    const poll = pollRes.rows[0];
    if (!poll) return res.status(404).json({ success: false, error: "Poll not found" });

    const options = Array.isArray(poll.options) ? poll.options : JSON.parse(poll.options || "[]");
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
        return res.status(400).json({ success: false, error: "option_index is out of range" });
    }
    if (poll.status === "closed" || (poll.ends_at && new Date(poll.ends_at).getTime() < Date.now())) {
        return res.status(400).json({ success: false, error: "This poll has closed" });
    }

    // One vote per user; switching decrements the old option.
    const existing = await query(`SELECT option_index FROM poll_votes WHERE poll_id = $1 AND user_id = $2`, [pollId, userId]);
    if (existing.rows.length > 0 && existing.rows[0].option_index === optionIndex) {
        return res.json({ success: true, data: { poll_id: pollId, option_index: optionIndex, changed: false } });
    }
    if (existing.rows.length > 0) {
        const oldIdx = existing.rows[0].option_index;
        await query(`UPDATE polls SET options = jsonb_set(options, ARRAY[$2::text[], 'vote_count'],
                     (GREATEST(COALESCE((options->$2::text->>'vote_count')::int, 0) - 1, 0))::text::jsonb)
                     WHERE id = $1`, [pollId, [String(oldIdx)]]);
        await query(`UPDATE poll_votes SET option_index = $2, created_at = CURRENT_TIMESTAMP WHERE poll_id = $1 AND user_id = $3`, [pollId, optionIndex, userId]);
    } else {
        await query(`INSERT INTO poll_votes (poll_id, user_id, option_index) VALUES ($1, $2, $3)`, [pollId, userId, optionIndex]);
    }
    await query(`UPDATE polls SET options = jsonb_set(options, ARRAY[$2::text[], 'vote_count'],
                 (COALESCE((options->$2::text->>'vote_count')::int, 0) + 1)::text::jsonb)
                 WHERE id = $1`, [pollId, [String(optionIndex)]]);

    const refreshed = await query(`SELECT * FROM polls WHERE id = $1`, [pollId]);
    res.json({ success: true, data: { poll: refreshed.rows[0], my_vote: optionIndex } });
});

export default router;
