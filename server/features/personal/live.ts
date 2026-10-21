import express from "express";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";
import { createNotification } from "../../services/notifications";
import { requirePersonalService } from "./flags";

const router = express.Router();
// Personal Products console kill-switch for live streaming.
router.use(requirePersonalService("live"));

/**
 * Live (Personal) — one-tap live streaming for your followers.
 *
 * Reuses the PROVEN calls infrastructure: every live session backs onto a
 * real call room (calls table, type 'live', status 'ongoing'), so WebRTC
 * tokens, the call room UI, participant roster and chat all work through the
 * existing /calls + /rtc paths. This router adds the discoverability layer:
 *
 *   POST /live            — go live (title) → creates the session + call room
 *   GET  /live            — active sessions (the "Live now" wall)
 *   POST /live/:id/join   — record the viewer + return the callCode to join
 *   POST /live/:id/end    — host ends the stream
 *   POST /live/:id/leave  — viewer heartbeat/leave (keeps viewer_count honest)
 */

export async function ensureLiveSchema(): Promise<void> {
    await query(`
    CREATE TABLE IF NOT EXISTS live_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      host_user_id UUID NOT NULL,
      call_id UUID,
      call_code VARCHAR(24),
      title VARCHAR(160) NOT NULL,
      status VARCHAR(12) DEFAULT 'live',        -- live | ended
      viewer_count INTEGER DEFAULT 0,
      peak_viewers INTEGER DEFAULT 0,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ended_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_live_sessions_status ON live_sessions(status, started_at DESC)`);
    await query(`
    CREATE TABLE IF NOT EXISTS live_viewers (
      session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      left_at TIMESTAMP,
      PRIMARY KEY (session_id, user_id)
    )`);
}

function generateCallCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 9; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;
}

/**
 * @swagger
 * tags:
 *   name: Live
 *   description: One-tap live streaming (sessions backed by call rooms)
 */

/**
 * @swagger
 * /live:
 *   get:
 *     summary: Live-now wall — active sessions with host + viewer counts
 *     tags: [Live]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/", authenticateToken, checkSubscriptionStatus, async (_req: AuthenticatedRequest, res) => {
    const rows = await query(
        `SELECT l.*, u.id AS host_id,
                COALESCE(NULLIF(u.name, ''), u.email, 'Host') AS host_name,
                u.avatar_url AS host_photo, SPLIT_PART(u.email, '@', 1) AS host_username
         FROM live_sessions l JOIN users u ON u.id = l.host_user_id
         WHERE l.status = 'live'
         ORDER BY l.viewer_count DESC, l.started_at DESC LIMIT 50`,
    );
    res.json({
        success: true,
        data: {
            sessions: rows.rows.map((s: any) => ({
                id: s.id,
                title: s.title,
                call_code: s.call_code,
                viewer_count: Number(s.viewer_count) || 0,
                started_at: s.started_at,
                host: { id: s.host_id, name: s.host_name, photo: s.host_photo, username: s.host_username },
            })),
        },
    });
});

/**
 * @swagger
 * /live:
 *   post:
 *     summary: Go live — creates a live session backed by a real call room
 *     tags: [Live]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ success: false, error: "Give your stream a title" });
    if (title.length > 160) return res.status(400).json({ success: false, error: "Title too long (160 max)" });

    // One concurrent stream per host.
    const existing = await query(
        `SELECT id FROM live_sessions WHERE host_user_id = $1 AND status = 'live' LIMIT 1`,
        [userId],
    );
    if (existing.rows[0]) {
        return res.status(400).json({ success: false, error: "You are already live. End that stream first.", code: "ALREADY_LIVE" });
    }

    // Create the underlying call room (same shape as calls.ts createCall).
    let callCode = generateCallCode();
    for (let i = 0; i < 5; i++) {
        const check = await query(`SELECT id FROM calls WHERE call_code = $1`, [callCode]);
        if (check.rows.length === 0) break;
        callCode = generateCallCode();
    }
    const callRes = await query(
        `INSERT INTO calls
          (business_id, type, status, created_by, host_id, call_code, is_group_call, waiting_room_enabled,
           recording_enabled, started_at, max_participants, provider)
         VALUES (NULL, 'live', 'ongoing', $1, $1, $2, TRUE, FALSE, FALSE, NOW(), 500, 'livekit')
         RETURNING id, call_code as "callCode"`,
        [userId, callCode],
    );
    const call = callRes.rows[0];

    const insert = await query(
        `INSERT INTO live_sessions (host_user_id, call_id, call_code, title)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [userId, call.id, call.callCode, title],
    );
    res.status(201).json({
        success: true,
        data: {
            session: insert.rows[0],
            call: { id: call.id, callCode: call.callCode },
            // The host opens the standard call room with this code to broadcast.
            broadcast_url: `/join-call?code=${encodeURIComponent(call.callCode)}&host=1`,
        },
    });
});

/**
 * @swagger
 * /live/{id}/join:
 *   post:
 *     summary: Join a live session as a viewer — returns the callCode for the room
 *     tags: [Live]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/:id/join", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const sessionRes = await query(`SELECT * FROM live_sessions WHERE id = $1 AND status = 'live'`, [String(req.params.id)]);
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ success: false, error: "Stream not found (or already ended)" });

    await query(
        `INSERT INTO live_viewers (session_id, user_id) VALUES ($1, $2)
         ON CONFLICT (session_id, user_id) DO UPDATE SET left_at = NULL`,
        [session.id, userId],
    );
    const upd = await query(
        `UPDATE live_sessions SET
           viewer_count = (SELECT COUNT(*) FROM live_viewers WHERE session_id = $1 AND left_at IS NULL),
           peak_viewers = GREATEST(peak_viewers, (SELECT COUNT(*) FROM live_viewers WHERE session_id = $1 AND left_at IS NULL))
         WHERE id = $1 RETURNING viewer_count`,
        [session.id],
    );

    res.json({
        success: true,
        data: {
            call_code: session.call_code,
            // Native clients join the underlying call room directly via the
            // standard /calls/:id/join flow (web uses the watch_url instead).
            call_id: session.call_id,
            title: session.title,
            viewer_count: Number(upd.rows[0]?.viewer_count) || 1,
            watch_url: `/join-call?code=${encodeURIComponent(session.call_code)}&watch=1`,
        },
    });
});

/**
 * @swagger
 * /live/{id}/leave:
 *   post:
 *     summary: Leave a live session (viewer)
 *     tags: [Live]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/:id/leave", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    await query(
        `UPDATE live_viewers SET left_at = CURRENT_TIMESTAMP WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [String(req.params.id), userId],
    );
    await query(
        `UPDATE live_sessions SET viewer_count = GREATEST((SELECT COUNT(*) FROM live_viewers WHERE session_id = $1 AND left_at IS NULL), 0) WHERE id = $1`,
        [String(req.params.id)],
    );
    res.json({ success: true });
});

/**
 * @swagger
 * /live/{id}/end:
 *   post:
 *     summary: End your live stream (host only)
 *     tags: [Live]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/:id/end", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const sessionRes = await query(`SELECT * FROM live_sessions WHERE id = $1 AND host_user_id = $2 AND status = 'live'`, [String(req.params.id), userId]);
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ success: false, error: "Your active stream was not found" });

    await query(
        `UPDATE live_sessions SET status = 'ended', ended_at = CURRENT_TIMESTAMP,
           viewer_count = (SELECT COUNT(*) FROM live_viewers WHERE session_id = $1 AND left_at IS NULL)
         WHERE id = $1`,
        [session.id],
    );
    if (session.call_id) {
        await query(
            `UPDATE calls SET status = 'ended', ended_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'ongoing'`,
            [session.call_id],
        ).catch(() => {});
    }
    res.json({ success: true, data: { peak_viewers: Number(session.peak_viewers) || 0 } });
});

export default router;
