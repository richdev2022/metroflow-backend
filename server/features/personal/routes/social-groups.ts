import express from "express";
import multer from "multer";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken } from "../../../middleware/auth";
import { uploadMediaBuffer } from "../../../services/media-upload";

/**
 * SOCIAL GROUPS & PAGES — Facebook-style communities, end to end.
 *
 * GROUPS: users create public or private groups, members join (private
 * groups require owner/admin approval), every member can post text +
 * photos/videos into the group feed, owners/admins moderate members.
 * PAGES: a user (or business) creates a page, others follow it, the page
 * OWNER posts as the page itself, followers get the page feed.
 *
 * Posts reuse the existing social engine: social_posts gains nullable
 * group_id / page_id columns, so reactions, comments, media carousels,
 * boosts and reports keep working unchanged for group/page posts.
 *
 * Endpoints (mounted at /social):
 *   POST   /social/groups                         create (creator = owner)
 *   GET    /social/groups?scope=mine|discover
 *   GET    /social/groups/:id
 *   PUT    /social/groups/:id                     owner/admin only
 *   DELETE /social/groups/:id                     owner only
 *   POST   /social/groups/:id/cover               multipart 'cover'
 *   POST   /social/groups/:id/join                public = instant, private = pending
 *   POST   /social/groups/:id/leave
 *   GET    /social/groups/:id/members
 *   GET    /social/groups/:id/requests            owner/admin only
 *   POST   /social/groups/:id/members/:uid/approve  owner/admin only
 *   POST   /social/groups/:id/members/:uid/reject   owner/admin only
 *   DELETE /social/groups/:id/members/:uid          owner/admin only (kick)
 *   POST   /social/groups/:id/posts               multipart (members only)
 *   GET    /social/groups/:id/posts
 *
 *   POST   /social/pages                          create
 *   GET    /social/pages?scope=mine|discover
 *   GET    /social/pages/:id
 *   PUT    /social/pages/:id                      owner only
 *   DELETE /social/pages/:id                      owner only
 *   POST   /social/pages/:id/cover                multipart 'cover'
 *   POST   /social/pages/:id/follow
 *   POST   /social/pages/:id/unfollow
 *   GET    /social/pages/:id/followers
 *   POST   /social/pages/:id/posts                owner only (posts AS the page)
 *   GET    /social/pages/:id/posts
 */

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (/^image\/(png|jpe?g|webp|gif|avif|heic|heif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files are allowed for covers"));
  },
} as multer.Options);

const MEDIA_UPLOAD = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Membership = { role: string; status: string } | null;

async function myMembership(groupId: string, userId: string): Promise<Membership> {
  const r = await query(
    `SELECT role, status FROM social_group_members WHERE group_id = $1 AND user_id = $2 LIMIT 1`,
    [groupId, userId],
  );
  return r.rows[0] || null;
}

function groupRoleAtLeast(m: Membership, roles: string[]): boolean {
  return !!m && m.status === "active" && roles.includes(String(m.role));
}

function cleanText(v: any, max: number): string {
  return String(v ?? "").trim().slice(0, max);
}

/** Load a group with the caller's membership context attached. */
async function loadGroup(groupId: string, userId: string) {
  const g = await query(
    `SELECT g.*, u.name AS creator_name, u.avatar_url AS creator_photo
     FROM social_groups g JOIN users u ON u.id = g.creator_id
     WHERE g.id = $1 AND g.status = 'active'`,
    [groupId],
  );
  if (!g.rows.length) return null;
  const group = g.rows[0];
  const m = await myMembership(group.id, userId);
  const isMember = !!m && m.status === "active";
  const canManage = groupRoleAtLeast(m, ["owner", "admin"]);
  return { group, membership: m, isMember, canManage, isOwner: m?.role === "owner" && m?.status === "active" };
}

async function loadPage(pageId: string, userId: string) {
  const p = await query(
    `SELECT p.*, u.name AS owner_name, u.avatar_url AS owner_photo
     FROM social_pages p JOIN users u ON u.id = p.owner_id
     WHERE p.id = $1 AND p.status = 'active'`,
    [pageId],
  );
  if (!p.rows.length) return null;
  const page = p.rows[0];
  const f = await query(
    `SELECT 1 FROM social_page_follows WHERE page_id = $1 AND user_id = $2 LIMIT 1`,
    [pageId, userId],
  );
  const isFollowing = f.rows.length > 0;
  return { page, isFollowing, isOwner: page.owner_id === userId };
}

/**
 * Shared post-creation pipeline for groups/pages — mirrors POST /social/posts
 * (multipart images/videos/posters + ordered carousel + server-side poster
 * extraction) but targets a community container.
 */
async function createCommunityPost(req: AuthenticatedRequest, res: any, opts: { groupId?: string; pageId?: string; authorAsPage?: { id: string; name: string; photo: string | null } }) {
  const userId = req.user!.userId;
  const body = String(req.body?.body ?? "").trim();
  const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
  const imageFiles = files.image || [];
  const videoFiles = files.video || [];
  const posterFiles = files.poster || [];

  let order: string[] = [];
  try {
    const raw = JSON.parse(String(req.body?.media_order || "[]"));
    if (Array.isArray(raw)) order = raw.map((x: any) => String(x)).filter((x: string) => x === "image" || x === "video").slice(0, 10);
  } catch { /* fall back below */ }
  if (order.length === 0) order = [...imageFiles.map(() => "image"), ...videoFiles.map(() => "video")].slice(0, 10);

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
  while (mediaRows.length < MAX_MEDIA && (imageQueue.length || videoQueue.length)) {
    if (imageQueue.length) mediaRows.push({ media_type: "image", url: await uploadOne(imageQueue.shift()!), poster_url: null });
    else if (videoQueue.length) {
      const poster = posterQueue.length ? await uploadOne(posterQueue.shift()!) : null;
      mediaRows.push({ media_type: "video", url: await uploadOne(videoQueue.shift()!), poster_url: poster });
    }
  }

  let imageUrl: string | null = mediaRows.find((m) => m.media_type === "image")?.url || null;
  let videoUrl: string | null = mediaRows.find((m) => m.media_type === "video")?.url || null;
  if (!imageUrl) {
    const firstVideoWithPoster = mediaRows.find((m) => m.media_type === "video" && m.poster_url);
    if (firstVideoWithPoster?.poster_url) imageUrl = firstVideoWithPoster.poster_url;
  }
  if (!body && !mediaRows.length) {
    return res.status(400).json({ success: false, error: "Write something or attach a photo/video" });
  }
  if (body.length > 5000) {
    return res.status(400).json({ success: false, error: "Post is too long (max 5000 characters)" });
  }

  const r = await query(
    `INSERT INTO social_posts (user_id, body, image_url, video_url, audience, group_id, page_id)
     VALUES ($1,$2,$3,$4,'public',$5,$6) RETURNING *`,
    [userId, body, imageUrl, videoUrl, opts.groupId || null, opts.pageId || null],
  );
  const postId = r.rows[0].id;
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

  const author = opts.authorAsPage || { id: userId, name: (await query(`SELECT name, avatar_url FROM users WHERE id = $1`, [userId])).rows[0]?.name, photo: null };
  return res.status(201).json({
    success: true,
    data: {
      post: {
        kind: "post", id: postId,
        group_id: opts.groupId || null, page_id: opts.pageId || null,
        author: { id: author.id, name: author.name, photo: author.photo },
        message: r.rows[0].body, body: r.rows[0].body, content: r.rows[0].body,
        image_url: r.rows[0].image_url, video_url: r.rows[0].video_url,
        media: savedMedia,
        like_count: 0, comment_count: 0, share_count: 0,
        liked_by_me: false, created_at: r.rows[0].created_at,
      },
    },
  });
}

/** Feed-shaped post list for one group or page (reactions/comments/media). */
async function listCommunityPosts(container: { groupId?: string; pageId?: string }, userId: string, limit: number, cursor: Date | null) {
  const where: string[] = [`p.status = 'active'`];
  const params: any[] = [];
  if (container.groupId) { params.push(container.groupId); where.push(`p.group_id = $${params.length}`); }
  if (container.pageId) { params.push(container.pageId); where.push(`p.page_id = $${params.length}`); }
  if (cursor && !isNaN(cursor.getTime())) { params.push(cursor.toISOString()); where.push(`p.created_at < $${params.length}`); }
  params.push(limit + 1);
  const limitIdx = params.length;

  const postsRes = await query(
    `SELECT p.id, p.user_id, p.body, p.image_url, p.video_url, p.created_at,
            u.name AS author_name, u.avatar_url AS author_photo,
            (u.verified_badge_status = 'active' AND (u.verified_until IS NULL OR u.verified_until > NOW())) AS author_verified,
            (SELECT COUNT(*)::int FROM social_reactions r WHERE r.post_id = p.id) AS like_count,
            (SELECT r.type FROM social_reactions r WHERE r.post_id = p.id AND r.user_id = $${container.groupId ? 2 : 2} LIMIT 1) AS my_reaction,
            (SELECT COUNT(*)::int FROM social_comments c WHERE c.post_id = p.id AND c.status = 'active') AS comment_count
     FROM social_posts p
     JOIN users u ON u.id = p.user_id
     WHERE ${where.join(" AND ")}
     ORDER BY p.created_at DESC
     LIMIT $${limitIdx}`,
    params,
  );

  const items = postsRes.rows.slice(0, limit).map((p: any) => ({
    kind: "post",
    id: p.id,
    author: {
      id: p.user_id,
      name: p.author_name,
      photo: p.author_photo,
      is_verified: !!p.author_verified,
    },
    message: p.body,
    body: p.body,
    content: p.body,
    image_url: p.image_url,
    video_url: p.video_url,
    like_count: Number(p.like_count) || 0,
    comment_count: Number(p.comment_count) || 0,
    my_reaction: p.my_reaction || null,
    liked_by_me: !!p.my_reaction,
    created_at: p.created_at,
  }));

  // Media carousels (batched).
  const ids = items.map((i: any) => i.id);
  if (ids.length) {
    try {
      const mediaRes = await query(
        `SELECT post_id, media_type, url, poster_url FROM social_post_media
         WHERE post_id = ANY($1::uuid[]) ORDER BY post_id, position, created_at`,
        [ids],
      );
      const byPost = new Map<string, any[]>();
      for (const row of mediaRes.rows) {
        const list = byPost.get(String(row.post_id)) || [];
        list.push({ media_type: row.media_type, url: row.url, poster_url: row.poster_url || null });
        byPost.set(String(row.post_id), list);
      }
      for (const item of items) {
        item.media = byPost.get(String(item.id)) || [
          item.image_url ? { media_type: "image", url: item.image_url, poster_url: null } : null,
          item.video_url ? { media_type: "video", url: item.video_url, poster_url: null } : null,
        ].filter(Boolean);
      }
    } catch { /* legacy columns still render */ }
  }

  const next = postsRes.rows.length > limit ? postsRes.rows[limit - 1]?.created_at : null;
  return { items, next_cursor: next || null };
}

// ---------------------------------------------------------------------------
// GROUPS
// ---------------------------------------------------------------------------

router.post("/groups", authenticateToken, upload.single("cover"), async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const name = cleanText(req.body?.name, 120);
    const description = cleanText(req.body?.description, 2000);
    const privacy = req.body?.privacy === "private" ? "private" : "public";
    if (!name) return res.status(400).json({ success: false, error: "Group name is required" });

    let coverUrl: string | null = null;
    const cover = (req as any).file;
    if (cover) {
      const up = await uploadMediaBuffer({ buffer: cover.buffer, originalname: cover.originalname, mimeType: cover.mimetype, folder: "social-covers", userId });
      coverUrl = up?.url || null;
    }

    const g = await query(
      `INSERT INTO social_groups (name, description, privacy, cover_url, creator_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, description, privacy, coverUrl, userId],
    );
    await query(
      `INSERT INTO social_group_members (group_id, user_id, role, status) VALUES ($1,$2,'owner','active')`,
      [g.rows[0].id, userId],
    );
    res.status(201).json({ success: true, data: { group: { ...g.rows[0], member_count: 1 }, my_role: "owner" } });
  } catch (e: any) {
    console.error("groups create error:", e?.message);
    res.status(500).json({ success: false, error: "Could not create group" });
  }
});

router.get("/groups", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const scope = String(req.query.scope || "all");

    const base = `SELECT g.*, u.name AS creator_name, u.avatar_url AS creator_photo,
                    (SELECT COUNT(*)::int FROM social_group_members gm WHERE gm.group_id = g.id AND gm.status = 'active') AS member_count,
                    EXISTS (SELECT 1 FROM social_group_members gm2 WHERE gm2.group_id = g.id AND gm2.user_id = $1 AND gm2.status = 'active') AS is_member
                  FROM social_groups g JOIN users u ON u.id = g.creator_id
                  WHERE g.status = 'active'`;

    let rows: any[] = [];
    if (scope === "mine") {
      rows = (await query(`${base} AND EXISTS (SELECT 1 FROM social_group_members gm3 WHERE gm3.group_id = g.id AND gm3.user_id = $1 AND gm3.status = 'active') ORDER BY g.created_at DESC LIMIT 100`, [userId])).rows;
    } else if (scope === "discover") {
      rows = (await query(`${base} AND g.privacy = 'public' AND NOT EXISTS (SELECT 1 FROM social_group_members gm4 WHERE gm4.group_id = g.id AND gm4.user_id = $1 AND gm4.status IN ('active','pending')) ORDER BY member_count DESC, g.created_at DESC LIMIT 100`, [userId])).rows;
    } else {
      rows = (await query(`${base} ORDER BY g.created_at DESC LIMIT 100`, [userId])).rows;
    }
    res.json({ success: true, data: { groups: rows } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load groups" });
  }
});

router.get("/groups/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    const { group, membership, isMember, canManage } = loaded;
    res.json({
      success: true,
      data: {
        group: {
          ...group,
          member_count: Number(group.member_count) || 0,
        },
        viewer: {
          is_member: isMember,
          role: membership?.role || null,
          status: membership?.status || null,
          can_manage: canManage,
          is_owner: loaded.isOwner,
        },
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load group" });
  }
});

router.put("/groups/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (!loaded.canManage) return res.status(403).json({ success: false, error: "Only group admins can update the group" });
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (req.body?.name !== undefined) { updates.push(`name = $${idx++}`); values.push(cleanText(req.body.name, 120)); }
    if (req.body?.description !== undefined) { updates.push(`description = $${idx++}`); values.push(cleanText(req.body.description, 2000)); }
    if (req.body?.privacy !== undefined) { updates.push(`privacy = $${idx++}`); values.push(req.body.privacy === "private" ? "private" : "public"); }
    if (!updates.length) return res.status(400).json({ success: false, error: "Nothing to update" });
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);
    const r = await query(`UPDATE social_groups SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`, values);
    res.json({ success: true, data: { group: r.rows[0] } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not update group" });
  }
});

router.delete("/groups/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (!loaded.isOwner) return res.status(403).json({ success: false, error: "Only the group owner can delete the group" });
    await query(`UPDATE social_groups SET status = 'removed' WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: "Group deleted" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not delete group" });
  }
});

router.post("/groups/:id/cover", authenticateToken, upload.single("cover"), async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (!loaded.canManage) return res.status(403).json({ success: false, error: "Only group admins can change the cover" });
    const cover = (req as any).file;
    if (!cover) return res.status(400).json({ success: false, error: "Attach a cover image" });
    const up = await uploadMediaBuffer({ buffer: cover.buffer, originalname: cover.originalname, mimeType: cover.mimetype, folder: "social-covers", userId: req.user!.userId });
    const r = await query(`UPDATE social_groups SET cover_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING cover_url`, [up?.url || null, req.params.id]);
    res.json({ success: true, data: { cover_url: r.rows[0]?.cover_url } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not upload cover" });
  }
});

router.post("/groups/:id/join", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (loaded.isMember) return res.json({ success: true, message: "Already a member", data: { status: "active" } });
    if (loaded.membership?.status === "pending") return res.json({ success: true, message: "Request already pending", data: { status: "pending" } });
    const status = loaded.group.privacy === "private" ? "pending" : "active";
    await query(
      `INSERT INTO social_group_members (group_id, user_id, role, status) VALUES ($1,$2,'member',$3)
       ON CONFLICT (group_id, user_id) DO UPDATE SET status = $3, joined_at = CURRENT_TIMESTAMP`,
      [req.params.id, req.user!.userId, status],
    );
    if (status === "active") await query(`UPDATE social_groups SET member_count = member_count + 1 WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: status === "active" ? "Joined the group" : "Join request sent — waiting for admin approval", data: { status } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not join group" });
  }
});

router.post("/groups/:id/leave", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (loaded.isOwner) return res.status(400).json({ success: false, error: "Owners cannot leave their own group — delete it instead" });
    const r = await query(`DELETE FROM social_group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active' RETURNING id`, [req.params.id, req.user!.userId]);
    if (r.rows.length) await query(`UPDATE social_groups SET member_count = GREATEST(member_count - 1, 0) WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: r.rows.length ? "You left the group" : "You are not a member" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not leave group" });
  }
});

router.get("/groups/:id/members", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    // Members see members; non-members only see PUBLIC groups' member lists.
    if (!loaded.isMember && loaded.group.privacy !== "public") {
      return res.status(403).json({ success: false, error: "This group is private" });
    }
    const rows = await query(
      `SELECT gm.user_id, gm.role, gm.status, gm.joined_at,
              u.name, u.avatar_url,
              (u.verified_badge_status = 'active' AND (u.verified_until IS NULL OR u.verified_until > NOW())) AS is_verified
       FROM social_group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 AND gm.status = 'active'
       ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, gm.joined_at ASC
       LIMIT 200`,
      [req.params.id],
    );
    res.json({ success: true, data: { members: rows.rows } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load members" });
  }
});

router.get("/groups/:id/requests", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (!loaded.canManage) return res.status(403).json({ success: false, error: "Only group admins can review join requests" });
    const rows = await query(
      `SELECT gm.user_id, gm.joined_at, u.name, u.avatar_url
       FROM social_group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 AND gm.status = 'pending' ORDER BY gm.joined_at ASC LIMIT 100`,
      [req.params.id],
    );
    res.json({ success: true, data: { requests: rows.rows } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load requests" });
  }
});

router.post("/groups/:id/members/:uid/approve", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (!loaded.canManage) return res.status(403).json({ success: false, error: "Only group admins can approve requests" });
    const r = await query(
      `UPDATE social_group_members SET status = 'active' WHERE group_id = $1 AND user_id = $2 AND status = 'pending' RETURNING id`,
      [req.params.id, req.params.uid],
    );
    if (r.rows.length) await query(`UPDATE social_groups SET member_count = member_count + 1 WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: r.rows.length ? "Member approved" : "No pending request" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not approve" });
  }
});

router.post("/groups/:id/members/:uid/reject", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (!loaded.canManage) return res.status(403).json({ success: false, error: "Only group admins can review requests" });
    await query(`DELETE FROM social_group_members WHERE group_id = $1 AND user_id = $2 AND status = 'pending'`, [req.params.id, req.params.uid]);
    res.json({ success: true, message: "Request declined" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not decline" });
  }
});

router.delete("/groups/:id/members/:uid", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (!loaded.canManage) return res.status(403).json({ success: false, error: "Only group admins can remove members" });
    if (req.params.uid === req.user!.userId) return res.status(400).json({ success: false, error: "Use leave instead" });
    const r = await query(
      `DELETE FROM social_group_members WHERE group_id = $1 AND user_id = $2 AND role <> 'owner' AND status = 'active' RETURNING id`,
      [req.params.id, req.params.uid],
    );
    if (r.rows.length) await query(`UPDATE social_groups SET member_count = GREATEST(member_count - 1, 0) WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: r.rows.length ? "Member removed" : "Member not found" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not remove member" });
  }
});

router.post("/groups/:id/posts", authenticateToken, MEDIA_UPLOAD.fields([{ name: "image", maxCount: 10 }, { name: "video", maxCount: 10 }, { name: "poster", maxCount: 10 }]), async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (!loaded.isMember) return res.status(403).json({ success: false, error: "Join the group to post" });
    return await createCommunityPost(req, res, { groupId: String(req.params.id) });
  } catch (e: any) {
    console.error("group post create error:", e?.message);
    return res.status(500).json({ success: false, error: "Could not post" });
  }
});

router.get("/groups/:id/posts", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadGroup(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Group not found" });
    if (loaded.group.privacy === "private" && !loaded.isMember) {
      return res.status(403).json({ success: false, error: "Join this group to see its posts" });
    }
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 20));
    const cursor = req.query.cursor ? new Date(String(req.query.cursor)) : null;
    const { items, next_cursor } = await listCommunityPosts({ groupId: String(req.params.id) }, req.user!.userId, limit, cursor);
    res.json({ success: true, data: { timeline: items, next_cursor } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load group posts" });
  }
});

// ---------------------------------------------------------------------------
// PAGES
// ---------------------------------------------------------------------------

router.post("/pages", authenticateToken, upload.single("cover"), async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const name = cleanText(req.body?.name, 120);
    const category = cleanText(req.body?.category, 80) || "Business";
    const description = cleanText(req.body?.description, 2000);
    if (!name) return res.status(400).json({ success: false, error: "Page name is required" });

    let coverUrl: string | null = null;
    const cover = (req as any).file;
    if (cover) {
      const up = await uploadMediaBuffer({ buffer: cover.buffer, originalname: cover.originalname, mimeType: cover.mimetype, folder: "social-covers", userId });
      coverUrl = up?.url || null;
    }

    const p = await query(
      `INSERT INTO social_pages (name, category, description, cover_url, owner_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, category, description, coverUrl, userId],
    );
    res.status(201).json({ success: true, data: { page: { ...p.rows[0], follower_count: 0 }, is_owner: true } });
  } catch (e: any) {
    console.error("pages create error:", e?.message);
    res.status(500).json({ success: false, error: "Could not create page" });
  }
});

router.get("/pages", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const scope = String(req.query.scope || "all");
    const base = `SELECT p.*, u.name AS owner_name, u.avatar_url AS owner_photo,
                    (SELECT COUNT(*)::int FROM social_page_follows pf WHERE pf.page_id = p.id) AS follower_count,
                    EXISTS (SELECT 1 FROM social_page_follows pf2 WHERE pf2.page_id = p.id AND pf2.user_id = $1) AS is_following
                  FROM social_pages p JOIN users u ON u.id = p.owner_id
                  WHERE p.status = 'active'`;
    let rows: any[] = [];
    if (scope === "mine") {
      rows = (await query(`${base} AND p.owner_id = $1 ORDER BY p.created_at DESC LIMIT 100`, [userId])).rows;
    } else if (scope === "discover") {
      rows = (await query(`${base} AND p.owner_id <> $1 AND NOT EXISTS (SELECT 1 FROM social_page_follows pf3 WHERE pf3.page_id = p.id AND pf3.user_id = $1) ORDER BY follower_count DESC, p.created_at DESC LIMIT 100`, [userId])).rows;
    } else {
      rows = (await query(`${base} ORDER BY p.created_at DESC LIMIT 100`, [userId])).rows;
    }
    res.json({ success: true, data: { pages: rows } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load pages" });
  }
});

router.get("/pages/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadPage(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Page not found" });
    res.json({
      success: true,
      data: {
        page: { ...loaded.page, follower_count: Number(loaded.page.follower_count) || 0 },
        viewer: { is_following: loaded.isFollowing, is_owner: loaded.isOwner },
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load page" });
  }
});

router.put("/pages/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadPage(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Page not found" });
    if (!loaded.isOwner) return res.status(403).json({ success: false, error: "Only the page owner can update the page" });
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (req.body?.name !== undefined) { updates.push(`name = $${idx++}`); values.push(cleanText(req.body.name, 120)); }
    if (req.body?.category !== undefined) { updates.push(`category = $${idx++}`); values.push(cleanText(req.body.category, 80) || "Business"); }
    if (req.body?.description !== undefined) { updates.push(`description = $${idx++}`); values.push(cleanText(req.body.description, 2000)); }
    if (!updates.length) return res.status(400).json({ success: false, error: "Nothing to update" });
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);
    const r = await query(`UPDATE social_pages SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`, values);
    res.json({ success: true, data: { page: r.rows[0] } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not update page" });
  }
});

router.delete("/pages/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadPage(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Page not found" });
    if (!loaded.isOwner) return res.status(403).json({ success: false, error: "Only the page owner can delete the page" });
    await query(`UPDATE social_pages SET status = 'removed' WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: "Page deleted" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not delete page" });
  }
});

router.post("/pages/:id/cover", authenticateToken, upload.single("cover"), async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadPage(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Page not found" });
    if (!loaded.isOwner) return res.status(403).json({ success: false, error: "Only the page owner can change the cover" });
    const cover = (req as any).file;
    if (!cover) return res.status(400).json({ success: false, error: "Attach a cover image" });
    const up = await uploadMediaBuffer({ buffer: cover.buffer, originalname: cover.originalname, mimeType: cover.mimetype, folder: "social-covers", userId: req.user!.userId });
    const r = await query(`UPDATE social_pages SET cover_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING cover_url`, [up?.url || null, req.params.id]);
    res.json({ success: true, data: { cover_url: r.rows[0]?.cover_url } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not upload cover" });
  }
});

router.post("/pages/:id/follow", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadPage(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Page not found" });
    if (loaded.isOwner) return res.status(400).json({ success: false, error: "You already own this page" });
    const r = await query(
      `INSERT INTO social_page_follows (page_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`,
      [req.params.id, req.user!.userId],
    );
    if (r.rows.length) await query(`UPDATE social_pages SET follower_count = follower_count + 1 WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: r.rows.length ? "Following" : "Already following" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not follow page" });
  }
});

router.post("/pages/:id/unfollow", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(`DELETE FROM social_page_follows WHERE page_id = $1 AND user_id = $2 RETURNING id`, [req.params.id, req.user!.userId]);
    if (r.rows.length) await query(`UPDATE social_pages SET follower_count = GREATEST(follower_count - 1, 0) WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: r.rows.length ? "Unfollowed" : "You were not following" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not unfollow page" });
  }
});

router.get("/pages/:id/followers", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadPage(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Page not found" });
    const rows = await query(
      `SELECT u.id AS user_id, u.name, u.avatar_url
       FROM social_page_follows pf JOIN users u ON u.id = pf.user_id
       WHERE pf.page_id = $1 ORDER BY pf.created_at DESC LIMIT 200`,
      [req.params.id],
    );
    res.json({ success: true, data: { followers: rows.rows } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load followers" });
  }
});

router.post("/pages/:id/posts", authenticateToken, MEDIA_UPLOAD.fields([{ name: "image", maxCount: 10 }, { name: "video", maxCount: 10 }, { name: "poster", maxCount: 10 }]), async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadPage(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Page not found" });
    if (!loaded.isOwner) return res.status(403).json({ success: false, error: "Only the page owner can post" });
    return await createCommunityPost(req, res, {
      pageId: String(req.params.id),
      authorAsPage: { id: loaded.page.id, name: loaded.page.name, photo: loaded.page.cover_url || loaded.page.avatar_url || null },
    });
  } catch (e: any) {
    console.error("page post create error:", e?.message);
    return res.status(500).json({ success: false, error: "Could not post" });
  }
});

router.get("/pages/:id/posts", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const loaded = await loadPage(String(req.params.id), req.user!.userId);
    if (!loaded) return res.status(404).json({ success: false, error: "Page not found" });
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 20));
    const cursor = req.query.cursor ? new Date(String(req.query.cursor)) : null;
    const { items, next_cursor } = await listCommunityPosts({ pageId: String(req.params.id) }, req.user!.userId, limit, cursor);
    // Page posts render as the PAGE itself.
    for (const item of items) {
      item.author = { id: loaded.page.id, name: loaded.page.name, photo: loaded.page.cover_url || loaded.page.avatar_url || null };
    }
    res.json({ success: true, data: { timeline: items, next_cursor } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Could not load page posts" });
  }
});

export default router;
