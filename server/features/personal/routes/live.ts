import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import { assertPersonalService, genRef } from "../personal-utils";

/**
 * LIVE — TikTok-style one-tap live streaming (rides the proven call-room
 * WebRTC stack; each stream is a broadcast call room).
 *
 *   POST /live                      { title, category?, description? } → host session
 *   GET  /live                      → live wall (active sessions + viewer counts)
 *   GET  /live/mine                 → my sessions (live + ended, with stats)
 *   GET  /live/:id                  → session detail (host sees moderation data)
 *   POST /live/:id/join             → join as viewer (returns watch_url)
 *   POST /live/:id/leave            → leave as viewer
 *   POST /live/:id/end              → host (or co-host) ends the stream
 *   POST /live/:id/chat             { body } → live chat message
 *   GET  /live/:id/chat?since_id=   → chat tail (polling)
 *   POST /live/:id/react            { emoji } → reaction stream
 *   GET  /live/:id/reactions?since= → reaction tail (polling)
 *   POST /live/:id/pin              { message_id | body } → pin a comment (host/cohost)
 *   POST /live/:id/slow-mode        { seconds } → host/cohost slow mode
 *   POST /live/:id/moderate         { action: remove_message|ban_viewer, target_id }
 *   POST /live/:id/cohost           { user_id } → invite co-host (host only)
 *   DELETE /live/:id/cohost/:userId → remove co-host (host only)
 *   POST /live/:id/gift             { amount, pin, wallet_id } → send a gift to the host
 *
 * Categories mirror TikTok: general, chat, talent, music, dance, food,
 * fashion, gaming, sports, education, business, faith, comedy.
 */

const router = express.Router();

const CATEGORIES = ["general", "chat", "talent", "music", "dance", "food", "fashion", "gaming", "sports", "education", "business", "faith", "comedy"];
const EMOJIS = new Set(["heart", "fire", "clap", "laugh", "wow", "sad", "party", "star", "money", "100"]);

const isCohost = (session: any, userId: string) =>
  Array.isArray(session.cohost_ids) && session.cohost_ids.includes(userId);

async function sessionById(id: string) {
  const r = await query(
    `SELECT l.*, u.name AS host_name, u.avatar_url AS host_photo
     FROM live_sessions l JOIN users u ON u.id = l.host_id WHERE l.id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function bumpViewers(sessionId: string, delta: number) {
  await query(
    `UPDATE live_sessions
     SET current_viewers = GREATEST(0, current_viewers + $2),
         peak_viewers = GREATEST(peak_viewers, current_viewers + $2)
     WHERE id = $1`,
    [sessionId, delta],
  );
}

// ---------------------------------------------------------------------------
// Create / wall / mine
// ---------------------------------------------------------------------------
router.post("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "live"))) return;
    const userId = req.user!.userId;
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ success: false, error: "Give your stream a title" });
    if (title.length > 160) return res.status(400).json({ success: false, error: "Title too long (max 160)" });
    const category = CATEGORIES.includes(String(req.body?.category)) ? String(req.body.category) : "general";
    const description = req.body?.description ? String(req.body.description).slice(0, 500) : null;

    // One active stream per host.
    const existing = await query(
      `SELECT id, call_code FROM live_sessions WHERE host_id = $1 AND status = 'live'`,
      [userId],
    );
    if (existing.rows.length) {
      return res.json({
        success: true,
        data: {
          session: existing.rows[0],
          broadcast_url: `/join-call?code=${existing.rows[0].call_code}&broadcast=1`,
          message: "You are already live — reopening your stream.",
        },
      });
    }
    const callCode = genRef("LIVE").slice(0, 16).toUpperCase();
    const r = await query(
      `INSERT INTO live_sessions (host_id, title, description, category, call_code)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, title, description, category, callCode],
    );
    return res.status(201).json({
      success: true,
      data: {
        session: r.rows[0],
        broadcast_url: `/join-call?code=${callCode}&broadcast=1`,
        message: "You are LIVE",
      },
    });
  } catch (e: any) {
    console.error("live create error:", e?.message);
    res.status(500).json({ success: false, error: "Could not go live" });
  }
});

router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "live"))) return;
    const category = String(req.query.category || "");
    const params: any[] = [];
    let where = `l.status = 'live'`;
    if (category && CATEGORIES.includes(category)) { params.push(category); where += ` AND l.category = $${params.length}`; }
    const r = await query(
      `SELECT l.id, l.title, l.description, l.category, l.call_code, l.current_viewers,
              l.peak_viewers, l.total_views, l.reaction_count, l.started_at, l.host_id,
              u.name AS host_name, u.avatar_url AS host_photo
       FROM live_sessions l JOIN users u ON u.id = l.host_id
       WHERE ${where}
       ORDER BY l.current_viewers DESC, l.started_at DESC
       LIMIT 60`,
      params,
    );
    res.json({ success: true, data: { sessions: r.rows, categories: CATEGORIES } });
  } catch (e: any) {
    console.error("live wall error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load live sessions" });
  }
});

router.get("/mine", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `SELECT * FROM live_sessions WHERE host_id = $1 ORDER BY started_at DESC LIMIT 50`,
      [req.user!.userId],
    );
    res.json({ success: true, data: { sessions: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load your streams" });
  }
});

// ---------------------------------------------------------------------------
// Session detail / join / leave / end
// ---------------------------------------------------------------------------
router.get("/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    const imHost = s.host_id === req.user!.userId || isCohost(s, req.user!.userId);
    const viewers = imHost
      ? await query(
          `SELECT v.user_id, v.joined_at, u.name, u.avatar_url
           FROM live_viewers v JOIN users u ON u.id = v.user_id
           WHERE v.session_id = $1 AND v.left_at IS NULL ORDER BY v.joined_at DESC LIMIT 100`,
          [s.id],
        )
      : [];
    res.json({
      success: true,
      data: {
        session: {
          ...s,
          is_host: imHost,
          watch_url: `/join-call?code=${s.call_code}&watch=1`,
          broadcast_url: `/join-call?code=${s.call_code}&broadcast=1`,
        },
        viewers: viewers.rows,
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load stream" });
  }
});

router.post("/:id/join", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s || s.status !== "live") return res.status(404).json({ success: false, error: "This stream is not live" });
    const userId = req.user!.userId;
    if (s.host_id !== userId) {
      await query(
        `INSERT INTO live_viewers (session_id, user_id) VALUES ($1,$2)
         ON CONFLICT (session_id, user_id) DO UPDATE SET left_at = NULL, joined_at = CURRENT_TIMESTAMP`,
        [s.id, userId],
      );
      bumpViewers(s.id, 1).catch(() => {});
      await query(`UPDATE live_sessions SET total_views = total_views + 1 WHERE id = $1`, [s.id]);
    }
    res.json({
      success: true,
      data: { watch_url: `/join-call?code=${s.call_code}&watch=1`, session: s },
    });
  } catch (e: any) {
    console.error("live join error:", e?.message);
    res.status(500).json({ success: false, error: "Could not join the stream" });
  }
});

router.post("/:id/leave", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `UPDATE live_viewers SET left_at = CURRENT_TIMESTAMP
       WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING id`,
      [req.params.id, req.user!.userId],
    );
    if (r.rows.length) await bumpViewers(String(req.params.id), -1);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Could not leave stream" });
  }
});

router.post("/:id/end", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (s.host_id !== req.user!.userId && !isCohost(s, req.user!.userId)) {
      return res.status(403).json({ success: false, error: "Only the host can end this stream" });
    }
    const r = await query(
      `UPDATE live_sessions SET status = 'ended', ended_at = CURRENT_TIMESTAMP, current_viewers = 0
       WHERE id = $1 RETURNING peak_viewers, total_views, reaction_count`,
      [req.params.id],
    );
    await query(`UPDATE live_viewers SET left_at = CURRENT_TIMESTAMP WHERE session_id = $1 AND left_at IS NULL`, [req.params.id]);
    res.json({ success: true, data: { summary: r.rows[0] } });
  } catch {
    res.status(500).json({ success: false, error: "Could not end the stream" });
  }
});

// ---------------------------------------------------------------------------
// Live chat
// ---------------------------------------------------------------------------
router.post("/:id/chat", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s || s.status !== "live") return res.status(404).json({ success: false, error: "Stream not live" });
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ success: false, error: "Message is empty" });
    if (body.length > 300) return res.status(400).json({ success: false, error: "Message too long (max 300)" });
    // Slow mode
    if (s.slow_mode_seconds > 0 && !isCohost(s, req.user!.userId) && s.host_id !== req.user!.userId) {
      const last = await query(
        `SELECT created_at FROM live_messages WHERE session_id = $1 AND user_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [s.id, req.user!.userId],
      );
      if (last.rows.length) {
        const waitMs = s.slow_mode_seconds * 1000 - (Date.now() - new Date(last.rows[0].created_at).getTime());
        if (waitMs > 0) {
          return res.status(429).json({ success: false, error: `Slow mode — wait ${Math.ceil(waitMs / 1000)}s`, code: "SLOW_MODE" });
        }
      }
    }
    const r = await query(
      `INSERT INTO live_messages (session_id, user_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [s.id, req.user!.userId, body],
    );
    const u = await query(`SELECT name, avatar_url FROM users WHERE id = $1`, [req.user!.userId]);
    res.status(201).json({
      success: true,
      data: {
        message: {
          id: r.rows[0].id, session_id: s.id, user_id: req.user!.userId, body,
          is_pinned: false, created_at: r.rows[0].created_at,
          author: { id: req.user!.userId, name: u.rows[0]?.name, photo: u.rows[0]?.avatar_url },
        },
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not send message" });
  }
});

router.get("/:id/chat", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const sinceId = req.query.since_id ? String(req.query.since_id) : null;
    const params: any[] = [req.params.id];
    let where = `m.session_id = $1 AND m.is_removed = FALSE`;
    if (sinceId && /^[0-9a-f-]{36}$/i.test(sinceId)) {
      params.push(sinceId);
      where += ` AND m.created_at > (SELECT created_at FROM live_messages WHERE id = $2)`;
    }
    const r = await query(
      `SELECT m.id, m.user_id, m.body, m.is_pinned, m.created_at, u.name AS author_name, u.avatar_url AS author_photo
       FROM live_messages m JOIN users u ON u.id = m.user_id
       WHERE ${where} ORDER BY m.created_at ASC LIMIT 200`,
      params,
    );
    res.json({
      success: true,
      data: {
        messages: r.rows.map((m) => ({
          id: m.id, body: m.body, is_pinned: m.is_pinned, created_at: m.created_at,
          author: { id: m.user_id, name: m.author_name, photo: m.author_photo },
        })),
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load chat" });
  }
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------
router.post("/:id/react", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s || s.status !== "live") return res.status(404).json({ success: false, error: "Stream not live" });
    const emoji = EMOJIS.has(String(req.body?.emoji)) ? String(req.body.emoji) : "heart";
    await query(`INSERT INTO live_reactions (session_id, user_id, emoji) VALUES ($1,$2,$3)`, [s.id, req.user!.userId, emoji]);
    await query(`UPDATE live_sessions SET reaction_count = reaction_count + 1 WHERE id = $1`, [s.id]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Could not react" });
  }
});

router.get("/:id/reactions", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const minutes = Math.min(10, Math.max(1, Number(req.query.minutes) || 2));
    const r = await query(
      `SELECT emoji, COUNT(*)::int AS n FROM live_reactions
       WHERE session_id = $1 AND created_at > NOW() - ($2 || ' minutes')::INTERVAL
       GROUP BY emoji`,
      [req.params.id, minutes],
    );
    res.json({ success: true, data: { reactions: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load reactions" });
  }
});

// ---------------------------------------------------------------------------
// Host tools: pin, slow mode, moderation, co-host
// ---------------------------------------------------------------------------
router.post("/:id/pin", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (s.host_id !== req.user!.userId && !isCohost(s, req.user!.userId)) {
      return res.status(403).json({ success: false, error: "Only the host can pin messages" });
    }
    let pinned = null;
    if (req.body?.message_id) {
      const r = await query(
        `UPDATE live_messages SET is_pinned = TRUE WHERE id = $1 AND session_id = $2 RETURNING body`,
        [req.body.message_id, s.id],
      );
      pinned = r.rows[0]?.body || null;
    } else if (req.body?.body) {
      pinned = String(req.body.body).slice(0, 200);
    }
    await query(`UPDATE live_sessions SET pinned_message = $2 WHERE id = $1`, [s.id, pinned]);
    res.json({ success: true, data: { pinned_message: pinned } });
  } catch {
    res.status(500).json({ success: false, error: "Could not pin" });
  }
});

router.post("/:id/slow-mode", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (s.host_id !== req.user!.userId) return res.status(403).json({ success: false, error: "Only the host controls slow mode" });
    const seconds = Math.min(300, Math.max(0, Number(req.body?.seconds) || 0));
    await query(`UPDATE live_sessions SET slow_mode_seconds = $2 WHERE id = $1`, [s.id, seconds]);
    res.json({ success: true, data: { slow_mode_seconds: seconds } });
  } catch {
    res.status(500).json({ success: false, error: "Could not set slow mode" });
  }
});

router.post("/:id/moderate", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (s.host_id !== req.user!.userId && !isCohost(s, req.user!.userId)) {
      return res.status(403).json({ success: false, error: "Only the host can moderate" });
    }
    const action = String(req.body?.action);
    const target = String(req.body?.target_id || "");
    if (action === "remove_message" && target) {
      await query(`UPDATE live_messages SET is_removed = TRUE WHERE id = $1 AND session_id = $2`, [target, s.id]);
      return res.json({ success: true, message: "Message removed" });
    }
    if (action === "ban_viewer" && target) {
      await query(`UPDATE live_viewers SET left_at = CURRENT_TIMESTAMP WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL`, [s.id, target]);
      await bumpViewers(s.id, -1);
      return res.json({ success: true, message: "Viewer removed from the stream" });
    }
    return res.status(400).json({ success: false, error: "Unknown moderation action" });
  } catch {
    res.status(500).json({ success: false, error: "Moderation failed" });
  }
});

router.post("/:id/cohost", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (s.host_id !== req.user!.userId) return res.status(403).json({ success: false, error: "Only the host can invite co-hosts" });
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ success: false, error: "user_id is required" });
    const cohosts = Array.isArray(s.cohost_ids) ? s.cohost_ids : [];
    if (cohosts.includes(user_id)) return res.json({ success: true, data: { cohost_ids: cohosts } });
    if (cohosts.length >= 5) return res.status(400).json({ success: false, error: "Maximum 5 co-hosts per stream" });
    const next = [...cohosts, user_id];
    await query(`UPDATE live_sessions SET cohost_ids = $2::jsonb WHERE id = $1`, [s.id, JSON.stringify(next)]);
    res.json({ success: true, data: { cohost_ids: next } });
  } catch {
    res.status(500).json({ success: false, error: "Could not add co-host" });
  }
});

router.delete("/:id/cohost/:userId", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (s.host_id !== req.user!.userId) return res.status(403).json({ success: false, error: "Only the host manages co-hosts" });
    const cohosts = (Array.isArray(s.cohost_ids) ? s.cohost_ids : []).filter((x: string) => x !== req.params.userId);
    await query(`UPDATE live_sessions SET cohost_ids = $2::jsonb WHERE id = $1`, [s.id, JSON.stringify(cohosts)]);
    res.json({ success: true, data: { cohost_ids: cohosts } });
  } catch {
    res.status(500).json({ success: false, error: "Could not remove co-host" });
  }
});

export default router;
