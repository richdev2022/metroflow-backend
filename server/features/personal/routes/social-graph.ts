import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken } from "../../../middleware/auth";
import { createNotification } from "../../../services/notifications";
import { assertPersonalService } from "../personal-utils";

/**
 * SOCIAL GRAPH — TikTok-style follow system + shareable public profiles.
 * Mounted at /social (see index.ts: mainRouter.use("/social", ...) — this
 * router is merged into the same mount as routes/social.ts, all paths here
 * are prefixed /users + /follow to stay out of its namespace).
 *
 *   POST   /social/users/:id/follow        → follow (private → follow request)
 *   DELETE /social/users/:id/follow        → unfollow (or cancel pending request)
 *   GET    /social/users/:id               → public profile (stats + posts grid)
 *   GET    /social/users/:id/followers     → follower list
 *   GET    /social/users/:id/following     → following list
 *   GET    /social/follow/requests         → my incoming follow requests (private accts)
 *   POST   /social/follow/requests/:id/accept
 *   POST   /social/follow/requests/:id/decline
 *
 * Relationship semantics (TikTok):
 *   • Public account  → follow is INSTANT.
 *   • Private account → follow creates a REQUEST the target accepts/declines;
 *                       their posts stay locked until accepted.
 *   • "follows_me" on the profile powers the FOLLOW-BACK button.
 *   • Likes stat = total reactions across the user's posts.
 */

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_CARD = `
  u.id, u.name, u.avatar_url, COALESCE(u.account_privacy, 'public') AS account_privacy,
  LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS username,
  LEFT(COALESCE(u.bio, ''), 160) AS bio,
  (u.verified_badge_status = 'active' AND u.verified_until > NOW()) AS is_verified
`;

async function userByIdOrUsername(key: string) {
  const k = String(key || "").trim();
  if (UUID_RE.test(k)) {
    const r = await query(`SELECT ${USER_CARD} FROM users u WHERE u.id = $1 LIMIT 1`, [k]);
    return r.rows[0] ?? null;
  }
  // Shareable handle: stored username (case-insensitive) or the email local-part.
  const r = await query(
    `SELECT ${USER_CARD} FROM users u
      WHERE (u.username IS NOT NULL AND LOWER(u.username) = LOWER($1))
         OR LOWER(SPLIT_PART(u.email, '@', 1)) = LOWER($1)
      ORDER BY (SELECT COUNT(*) FROM social_follows f WHERE f.following_id = u.id) DESC
      LIMIT 1`,
    [k],
  );
  return r.rows[0] ?? null;
}

async function isFollowing(follower: string, following: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM social_follows WHERE follower_id = $1 AND following_id = $2 LIMIT 1`,
    [follower, following],
  );
  return r.rows.length > 0;
}

async function followerCount(userId: string): Promise<number> {
  const r = await query(`SELECT COUNT(*)::int AS c FROM social_follows WHERE following_id = $1`, [userId]);
  return Number(r.rows[0]?.c) || 0;
}

// ---------------------------------------------------------------------------
// Public profile — powers /u/:username (other people) AND /profile (self)
// ---------------------------------------------------------------------------
router.get("/users/:key", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "social"))) return;
    const viewerId = req.user!.userId;
    const user = await userByIdOrUsername(String(req.params.key));
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const isSelf = user.id === viewerId;

    const [followers, following, likes, posts] = await Promise.all([
      followerCount(user.id),
      query(`SELECT COUNT(*)::int AS c FROM social_follows WHERE follower_id = $1`, [user.id]).then((r) => Number(r.rows[0]?.c) || 0),
      query(
        `SELECT COUNT(*)::int AS c FROM social_reactions r JOIN social_posts p ON p.id = r.post_id
          WHERE p.user_id = $1 AND p.status = 'active'`,
        [user.id],
      ).then((r) => Number(r.rows[0]?.c) || 0),
      query(`SELECT COUNT(*)::int AS c FROM social_posts WHERE user_id = $1 AND status = 'active'`, [user.id]).then((r) => Number(r.rows[0]?.c) || 0),
    ]);

    // Relationship (TikTok semantics)
    const [iFollow, followsMe, pendingOut] = await Promise.all([
      isFollowing(viewerId, user.id),
      isFollowing(user.id, viewerId),
      query(
        `SELECT id FROM social_follow_requests WHERE requester_id = $1 AND target_id = $2 AND status = 'pending' LIMIT 1`,
        [viewerId, user.id],
      ).then((r) => r.rows[0]?.id ?? null),
    ]);

    const isPrivate = user.account_privacy === "private";
    const canViewPosts = isSelf || !isPrivate || iFollow;

    let posts_grid: any[] = [];
    if (canViewPosts) {
      const grid = await query(
        `SELECT p.id, p.body, p.image_url, p.video_url, p.audience, p.created_at,
                (SELECT COUNT(*)::int FROM social_reactions r WHERE r.post_id = p.id) AS like_count,
                (SELECT COUNT(*)::int FROM social_comments c WHERE c.post_id = p.id AND c.status = 'active') AS comment_count,
                (SELECT COUNT(*)::int FROM social_reactions r WHERE r.post_id = p.id AND r.user_id = $2) AS my_like,
                EXISTS (SELECT 1 FROM boost_orders b WHERE b.target_type = 'post' AND b.target_id = p.id
                        AND b.status = 'active' AND b.ends_at > NOW()) AS boosted
           FROM social_posts p
          WHERE p.user_id = $1 AND p.status = 'active'
          ORDER BY p.created_at DESC LIMIT 60`,
        [user.id, viewerId],
      );
      // Multi-media: attach ordered carousels + a media_count for the grid's
      // "stack" badge (falls back to the legacy single columns).
      let mediaMap = new Map<string, Array<{ media_type: string; url: string; poster_url: string | null }>>();
      if (grid.rows.length) {
        try {
          const gm = await query(
            `SELECT post_id, media_type, url, poster_url FROM social_post_media
             WHERE post_id = ANY($1::uuid[]) ORDER BY post_id, position, created_at`,
            [grid.rows.map((r: any) => r.id)],
          );
          for (const row of gm.rows) {
            const list = mediaMap.get(String(row.post_id)) || [];
            list.push({ media_type: row.media_type, url: row.url, poster_url: row.poster_url || null });
            mediaMap.set(String(row.post_id), list);
          }
        } catch { mediaMap = new Map(); /* pre-upgrade posts render from legacy columns */ }
      }
      posts_grid = grid.rows.map((p: any) => {
        const media = mediaMap.get(String(p.id)) || [
          p.image_url ? { media_type: "image", url: p.image_url, poster_url: null } : null,
          p.video_url ? { media_type: "video", url: p.video_url, poster_url: null } : null,
        ].filter(Boolean);
        return { ...p, media, media_count: media.length };
      });
    }

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          avatar_url: user.avatar_url,
          username: user.username,
          bio: user.bio ?? "",
          account_privacy: user.account_privacy,
        },
        stats: { followers, following, likes, posts },
        relationship: {
          is_self: isSelf,
          following: iFollow,
          followed_by: followsMe, // they follow me → show "Follow back"
          pending_request_id: pendingOut,
          friends: iFollow && followsMe,
        },
        is_private: isPrivate,
        can_view_posts: canViewPosts,
        posts: posts_grid,
      },
    });
  } catch (e: any) {
    console.error("social profile error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load profile" });
  }
});

// ---------------------------------------------------------------------------
// Follow / unfollow
// ---------------------------------------------------------------------------
router.post("/users/:id/follow", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "social"))) return;
    const userId = req.user!.userId;
    const target = String(req.params.id || "");
    if (!UUID_RE.test(target)) return res.status(400).json({ success: false, error: "Invalid user" });
    if (target === userId) return res.status(400).json({ success: false, error: "You can't follow yourself" });

    const targetRes = await query(`SELECT id, name, COALESCE(account_privacy, 'public') AS account_privacy FROM users WHERE id = $1`, [target]);
    const targetUser = targetRes.rows[0];
    if (!targetUser) return res.status(404).json({ success: false, error: "User not found" });

    // Idempotent happy path
    if (await isFollowing(userId, target)) {
      return res.json({ success: true, data: { status: "following" } });
    }

    if (targetUser.account_privacy === "private") {
      // Private: upsert a follow REQUEST (unless already following via an
      // earlier accept — checked above).
      const existing = await query(
        `SELECT id, status FROM social_follow_requests WHERE requester_id = $1 AND target_id = $2 LIMIT 1`,
        [userId, target],
      );
      if (existing.rows[0]?.status === "pending") {
        return res.json({ success: true, data: { status: "requested" } });
      }
      if (existing.rows[0]) {
        await query(
          `UPDATE social_follow_requests SET status = 'pending', created_at = CURRENT_TIMESTAMP, responded_at = NULL WHERE id = $1`,
          [existing.rows[0].id],
        );
      } else {
        await query(`INSERT INTO social_follow_requests (requester_id, target_id) VALUES ($1, $2)`, [userId, target]);
      }
      await createNotification({
        userId: target,
        type: "social",
        title: "New follow request",
        message: `${req.user!.name || "Someone"} requested to follow you.`,
      }).catch(() => {});
      return res.status(201).json({ success: true, data: { status: "requested" } });
    }

    // Public: instant follow.
    await query(
      `INSERT INTO social_follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, target],
    );
    await createNotification({
      userId: target,
      type: "social",
      title: "New follower",
      message: `${req.user!.name || "Someone"} started following you.`,
    }).catch(() => {});
    res.status(201).json({ success: true, data: { status: "following" } });
  } catch (e: any) {
    console.error("follow error:", e?.message);
    res.status(500).json({ success: false, error: "Could not follow this user" });
  }
});

router.delete("/users/:id/follow", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const target = String(req.params.id || "");
    if (!UUID_RE.test(target)) return res.status(400).json({ success: false, error: "Invalid user" });
    await query(`DELETE FROM social_follows WHERE follower_id = $1 AND following_id = $2`, [userId, target]);
    // Also retract a pending follow request to the same user.
    await query(`DELETE FROM social_follow_requests WHERE requester_id = $1 AND target_id = $2 AND status = 'pending'`, [userId, target]);
    res.json({ success: true, data: { status: "not_following" } });
  } catch {
    res.status(500).json({ success: false, error: "Could not unfollow" });
  }
});

// ---------------------------------------------------------------------------
// Followers / following lists
// ---------------------------------------------------------------------------
const listGraph = (column: "follower_id" | "following_id") =>
  async (req: AuthenticatedRequest, res: any) => {
    try {
      const target = String(req.params.id || "");
      if (!UUID_RE.test(target)) return res.status(400).json({ success: false, error: "Invalid user" });
      const viewerId = req.user!.userId;
      const otherColumn = column === "follower_id" ? "following_id" : "follower_id";
      const rows = await query(
        `SELECT u.id, u.name, u.avatar_url, LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS username,
                f.created_at AS followed_at,
                EXISTS (SELECT 1 FROM social_follows m WHERE m.follower_id = $2 AND m.following_id = u.id) AS viewer_follows,
                EXISTS (SELECT 1 FROM social_follows m WHERE m.following_id = $2 AND m.follower_id = u.id) AS follows_viewer
           FROM social_follows f JOIN users u ON u.id = f.${otherColumn}
          WHERE f.${column} = $1
          ORDER BY f.created_at DESC LIMIT 200`,
        [target, viewerId],
      );
      res.json({ success: true, data: { users: rows.rows } });
    } catch {
      res.status(500).json({ success: false, error: "Could not load list" });
    }
  };

router.get("/users/:id/followers", authenticateToken, listGraph("following_id"));
router.get("/users/:id/following", authenticateToken, listGraph("follower_id"));

// ---------------------------------------------------------------------------
// Follow requests (private accounts)
// ---------------------------------------------------------------------------
router.get("/follow/requests", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const incoming = await query(
      `SELECT r.id, r.created_at, u.id AS user_id, u.name, u.avatar_url,
              LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS username
         FROM social_follow_requests r JOIN users u ON u.id = r.requester_id
        WHERE r.target_id = $1 AND r.status = 'pending'
        ORDER BY r.created_at DESC LIMIT 100`,
      [userId],
    );
    res.json({ success: true, data: { incoming: incoming.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load follow requests" });
  }
});

router.post("/follow/requests/:id/accept", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const r = await query(
      `SELECT * FROM social_follow_requests WHERE id = $1 AND target_id = $2 AND status = 'pending'`,
      [req.params.id, userId],
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, error: "Request not found" });
    const req0 = r.rows[0];
    await query(`UPDATE social_follow_requests SET status = 'accepted', responded_at = CURRENT_TIMESTAMP WHERE id = $1`, [req0.id]);
    await query(`INSERT INTO social_follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req0.requester_id, userId]);
    await createNotification({
      userId: req0.requester_id,
      type: "social",
      title: "Follow request accepted",
      message: `${req.user!.name || "Someone"} accepted your follow request.`,
    }).catch(() => {});
    res.json({ success: true, data: { status: "accepted" } });
  } catch {
    res.status(500).json({ success: false, error: "Could not accept the request" });
  }
});

router.post("/follow/requests/:id/decline", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const r = await query(
      `UPDATE social_follow_requests SET status = 'declined', responded_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND target_id = $2 AND status = 'pending' RETURNING id`,
      [req.params.id, userId],
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, error: "Request not found" });
    res.json({ success: true, data: { status: "declined" } });
  } catch {
    res.status(500).json({ success: false, error: "Could not decline the request" });
  }
});

export default router;
