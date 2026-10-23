import express, { RequestHandler } from "express";
import { query } from "../db";

const router = express.Router();

/**
 * WhatsApp-style STATUS (24h stories) for Metricorex chat.
 *
 * A status is a text card (with a background colour) and/or an image posted
 * by a member. VISIBILITY IS PLATFORM-WIDE: every active Metricorex user can
 * see every live status (chat itself is already cross-workspace), with one
 * exception — users who blocked each other never see each other's stories.
 * Members can view, LIKE and REPOST a status, reply to it in the poster's
 * DM, and the POSTER sees the like count + who liked. Rows are purged
 * lazily on every read (expires_at < NOW()), so nothing outlives the 24h
 * window.
 */

const STATUS_TTL_HOURS = 24;
const BG_COLORS = [
  "#1E3A8A", "#7C2D12", "#065F46", "#4C1D95", "#9D174D",
  "#0E7490", "#B45309", "#374151", "#B91C1C", "#1D4ED8",
] as const;

function purgeExpired(): void {
  // Fire-and-forget: every read sweeps the 24h window.
  query(`DELETE FROM chat_statuses WHERE expires_at < NOW()`).catch(() => {});
  query(
    `DELETE FROM chat_status_views WHERE status_id NOT IN (SELECT id FROM chat_statuses)`,
  ).catch(() => {});
  query(
    `DELETE FROM chat_status_likes WHERE status_id NOT IN (SELECT id FROM chat_statuses)`,
  ).catch(() => {});
}

/**
 * @swagger
 * tags:
 *   name: Statuses
 *   description: WhatsApp-style 24h status (stories) for chat
 */

/**
 * @swagger
 * /statuses:
 *   get:
 *     summary: Active statuses for the caller's workspace (+ viewer context)
 *     tags: [Statuses]
 *     security:
 *       - bearerAuth: []
 */
export const getStatuses: RequestHandler = async (req, res) => {
  purgeExpired();
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    // Visibility = PLATFORM-WIDE (fixes "users cannot view each other's
    // status posts"): the old same-business + shared-chat-conversation
    // scoping hid stories from colleagues in other workspaces and from
    // same-business users whose token carried a different workspace. The
    // only suppression is the block list — either direction hides the pair
    // from each other's rail.
    const rows = await query(
      `SELECT s.id, s.user_id as "userId", u.name as "authorName", u.avatar_url as "authorAvatar",
              s.content, s.media_url as "mediaUrl", s.media_type as "mediaType",
              s.background_color as "backgroundColor",
              s.reposted_from as "repostedFrom", s.repost_author as "repostAuthor",
              s.created_at as "createdAt", s.expires_at as "expiresAt",
              (s.user_id = $1) as "isMine",
              (SELECT COUNT(*)::int FROM chat_status_views v WHERE v.status_id = s.id) as "viewsCount",
              EXISTS (SELECT 1 FROM chat_status_views v WHERE v.status_id = s.id AND v.viewer_id = $1) as "viewed",
              (SELECT COUNT(*)::int FROM chat_status_likes l WHERE l.status_id = s.id) as "likesCount",
              EXISTS (SELECT 1 FROM chat_status_likes l WHERE l.status_id = s.id AND l.user_id = $1) as "liked"
         FROM chat_statuses s
         JOIN users u ON u.id = s.user_id
        WHERE s.expires_at > NOW()
          AND u.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
             WHERE (b.blocker_id = $1 AND b.blocked_id = s.user_id)
                OR (b.blocker_id = s.user_id AND b.blocked_id = $1)
          )
        ORDER BY (s.user_id = $1) DESC, s.created_at DESC
        LIMIT 200`,
      [userId],
    );

    res.json({ success: true, data: { statuses: rows.rows } });
  } catch (error) {
    console.error("List statuses error:", error);
    res.status(500).json({ success: false, error: "Failed to load statuses" });
  }
};

/**
 * @swagger
 * /statuses:
 *   post:
 *     summary: Post a status (text card and/or image), lasts 24h
 *     tags: [Statuses]
 *     security:
 *       - bearerAuth: []
 */
export const createStatus: RequestHandler = async (req, res) => {
  purgeExpired();
  try {
    const businessId = req.user?.businessId || null;
    const userId = req.user?.userId;
    // Personal users (business_id NULL) can post statuses too — the column is
    // nullable and visibility is platform-wide with block-list suppression.
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const content = String(req.body?.content || "").trim();
    const mediaUrl = typeof req.body?.mediaUrl === "string" ? req.body.mediaUrl.trim() : "";
    const mediaType = String(req.body?.mediaType || (mediaUrl ? "image" : "")).toLowerCase();
    let backgroundColor = String(req.body?.backgroundColor || "").trim();
    if (!BG_COLORS.includes(backgroundColor as any)) backgroundColor = BG_COLORS[0];

    if (!content && !mediaUrl) {
      return res.status(400).json({ success: false, error: "Write something or attach an image" });
    }
    if (content.length > 700) {
      return res.status(400).json({ success: false, error: "Status text is too long (max 700 characters)" });
    }
    if (mediaUrl && !/^https?:\/\//i.test(mediaUrl) && !mediaUrl.startsWith("/")) {
      return res.status(400).json({ success: false, error: "Invalid media URL" });
    }

    // Daily cap: statuses are transient — 20 posts per user per day keeps
    // the rail usable without a dedicated moderation surface.
    const count = await query(
      `SELECT COUNT(*)::int AS n FROM chat_statuses
        WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId],
    );
    if ((count.rows[0]?.n ?? 0) >= 20) {
      return res.status(400).json({ success: false, error: "You've posted a lot of statuses today — try again later" });
    }

    const inserted = await query(
      `INSERT INTO chat_statuses (user_id, business_id, content, media_url, media_type, background_color, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '${STATUS_TTL_HOURS} hours')
       RETURNING id, created_at as "createdAt", expires_at as "expiresAt"`,
      [userId, businessId, content || null, mediaUrl || null, mediaUrl ? (mediaType === "video" ? "video" : "image") : null, backgroundColor],
    );

    res.status(201).json({ success: true, message: "Status posted", data: inserted.rows[0] });
  } catch (error) {
    console.error("Create status error:", error);
    res.status(500).json({ success: false, error: "Failed to post the status" });
  }
};

/**
 * @swagger
 * /statuses/:id:
 *   delete:
 *     summary: Delete your own status
 *     tags: [Statuses]
 *     security:
 *       - bearerAuth: []
 */
export const deleteStatus: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });
    const id = String(req.params.id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(404).json({ success: false, error: "Status not found" });
    }
    const result = await query(`DELETE FROM chat_statuses WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!result.rowCount) return res.status(404).json({ success: false, error: "Status not found" });
    res.json({ success: true, message: "Status deleted" });
  } catch (error) {
    console.error("Delete status error:", error);
    res.status(500).json({ success: false, error: "Failed to delete the status" });
  }
};

/**
 * @swagger
 * /statuses/:id/view:
 *   post:
 *     summary: Record a view (idempotent)
 *     tags: [Statuses]
 *     security:
 *       - bearerAuth: []
 */
export const viewStatus: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });
    const id = String(req.params.id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(404).json({ success: false, error: "Status not found" });
    }
    await query(
      `INSERT INTO chat_status_views (status_id, viewer_id) VALUES ($1, $2)
       ON CONFLICT (status_id, viewer_id) DO NOTHING`,
      [id, userId],
    );
    const count = await query(
      `SELECT COUNT(*)::int AS n FROM chat_status_views WHERE status_id = $1`,
      [id],
    );
    res.json({ success: true, data: { viewsCount: count.rows[0]?.n ?? 0 } });
  } catch (error) {
    console.error("View status error:", error);
    res.status(500).json({ success: false, error: "Failed to record the view" });
  }
};

/**
 * @swagger
 * /statuses/:id/like:
 *   post:
 *     summary: Toggle a like on a status
 *     tags: [Statuses]
 *     security:
 *       - bearerAuth: []
 */
export const likeStatus: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });
    const id = String(req.params.id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(404).json({ success: false, error: "Status not found" });
    }
    const existing = await query(
      `SELECT 1 FROM chat_status_likes WHERE status_id = $1 AND user_id = $2`,
      [id, userId],
    );
    let liked: boolean;
    if (existing.rows.length > 0) {
      await query(`DELETE FROM chat_status_likes WHERE status_id = $1 AND user_id = $2`, [id, userId]);
      liked = false;
    } else {
      await query(
        `INSERT INTO chat_status_likes (status_id, user_id) VALUES ($1, $2)
         ON CONFLICT (status_id, user_id) DO NOTHING`,
        [id, userId],
      );
      liked = true;
    }
    const count = await query(
      `SELECT COUNT(*)::int AS n FROM chat_status_likes WHERE status_id = $1`,
      [id],
    );
    res.json({ success: true, data: { liked, likesCount: count.rows[0]?.n ?? 0 } });
  } catch (error) {
    console.error("Like status error:", error);
    res.status(500).json({ success: false, error: "Failed to update the like" });
  }
};

/**
 * @swagger
 * /statuses/:id/likes:
 *   get:
 *     summary: Who liked a status (poster only)
 *     tags: [Statuses]
 *     security:
 *       - bearerAuth: []
 */
export const getStatusLikes: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });
    const id = String(req.params.id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(404).json({ success: false, error: "Status not found" });
    }
    const owner = await query(`SELECT user_id FROM chat_statuses WHERE id = $1`, [id]);
    if (!owner.rows.length) return res.status(404).json({ success: false, error: "Status not found" });
    if (owner.rows[0].user_id !== userId) {
      return res.status(403).json({ success: false, error: "Only the poster can see who liked" });
    }
    const rows = await query(
      `SELECT l.user_id as "userId", u.name, u.avatar_url as "avatar", l.liked_at as "likedAt"
         FROM chat_status_likes l JOIN users u ON u.id = l.user_id
        WHERE l.status_id = $1 ORDER BY l.liked_at DESC LIMIT 100`,
      [id],
    );
    res.json({ success: true, data: { likes: rows.rows } });
  } catch (error) {
    console.error("Status likes error:", error);
    res.status(500).json({ success: false, error: "Failed to load the likes" });
  }
};

/**
 * @swagger
 * /statuses/:id/repost:
 *   post:
 *     summary: Repost a status to your own rail (attributed)
 *     tags: [Statuses]
 *     security:
 *       - bearerAuth: []
 */
export const repostStatus: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });
    const id = String(req.params.id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(404).json({ success: false, error: "Status not found" });
    }
    // Same platform-wide visibility predicate as the list endpoint.
    const original = await query(
      `SELECT s.id, s.content, s.media_url as "mediaUrl", s.media_type as "mediaType",
              s.background_color as "backgroundColor", s.user_id, u.name as "authorName"
         FROM chat_statuses s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > NOW()
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = s.user_id)
                OR (b.blocker_id = s.user_id AND b.blocked_id = $2)
          )`,
      [id, userId],
    );
    if (!original.rows.length) return res.status(404).json({ success: false, error: "Status not found" });
    const o = original.rows[0];
    if (o.user_id === userId) {
      return res.status(400).json({ success: false, error: "This is your own status" });
    }

    const inserted = await query(
      `INSERT INTO chat_statuses
         (user_id, business_id, content, media_url, media_type, background_color,
          reposted_from, repost_author, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '${STATUS_TTL_HOURS} hours')
       RETURNING id, created_at as "createdAt", expires_at as "expiresAt"`,
      [userId, req.user?.businessId || null, o.content, o.mediaUrl, o.mediaType, o.backgroundColor, o.id, o.authorName],
    );

    res.status(201).json({
      success: true,
      message: "Status reposted",
      data: { ...inserted.rows[0], repostedFrom: o.id, repostAuthor: o.authorName },
    });
  } catch (error) {
    console.error("Repost status error:", error);
    res.status(500).json({ success: false, error: "Failed to repost the status" });
  }
};

/**
 * PROFILE STORIES (social surface) — the SAME 24h statuses, exposed for the
 * personal-app profile pages (/u/:username and /profile) without the chat
 * feature gate. `getUserStatuses` returns ONE author's active stories so the
 * profile avatar can show the ring + open the viewer directly.
 */
export const getUserStatuses: RequestHandler = async (req, res) => {
  purgeExpired();
  try {
    const viewerId = req.user?.userId;
    if (!viewerId) return res.status(401).json({ success: false, error: "Unauthorized" });
    const key = String(req.params.key || "").trim();
    if (!key) return res.status(400).json({ success: false, error: "User required" });

    const target = await query(
      `SELECT id FROM users
        WHERE (id::text = $1 AND $1 ~ '^[0-9a-f-]{36}$')
           OR (username IS NOT NULL AND LOWER(username) = LOWER($1))
           OR LOWER(SPLIT_PART(email, '@', 1)) = LOWER($1)
        ORDER BY (id::text = $1) DESC
        LIMIT 1`,
      [key],
    );
    const authorId = target.rows[0]?.id;
    if (!authorId) return res.status(404).json({ success: false, error: "User not found" });

    // Blocked pairs never see each other's stories (same rule as the rail).
    const blocked = await query(
      `SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
      [viewerId, authorId],
    );
    if (blocked.rows.length > 0) return res.json({ success: true, data: { statuses: [] } });

    const rows = await query(
      `SELECT s.id, s.user_id as "userId", u.name as "authorName", u.avatar_url as "authorAvatar",
              s.content, s.media_url as "mediaUrl", s.media_type as "mediaType",
              s.background_color as "backgroundColor",
              s.reposted_from as "repostedFrom", s.repost_author as "repostAuthor",
              s.created_at as "createdAt", s.expires_at as "expiresAt",
              (s.user_id = $1) as "isMine",
              (SELECT COUNT(*)::int FROM chat_status_views v WHERE v.status_id = s.id) as "viewsCount",
              EXISTS (SELECT 1 FROM chat_status_views v WHERE v.status_id = s.id AND v.viewer_id = $1) as "viewed",
              (SELECT COUNT(*)::int FROM chat_status_likes l WHERE l.status_id = s.id) as "likesCount",
              EXISTS (SELECT 1 FROM chat_status_likes l WHERE l.status_id = s.id AND l.user_id = $1) as "liked"
         FROM chat_statuses s
         JOIN users u ON u.id = s.user_id
        WHERE s.expires_at > NOW() AND s.user_id = $2 AND u.status = 'active'
        ORDER BY s.created_at ASC
        LIMIT 50`,
      [viewerId, authorId],
    );
    res.json({ success: true, data: { statuses: rows.rows } });
  } catch (error) {
    console.error("User statuses error:", error);
    res.status(500).json({ success: false, error: "Failed to load statuses" });
  }
};
export default router;
