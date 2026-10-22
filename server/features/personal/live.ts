import express from "express";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";
import { createNotification } from "../../services/notifications";
import { evaluateOutflow, fraudRejectReason } from "../../services/fraud";
import { requirePersonalService } from "./flags";
import { debitWallet, creditWallet, insertTransaction } from "./personal-utils";

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
 *
 * Gifting (TikTok-style):
 *   GET  /live/gifts          — the gift catalog (priced in NGN)
 *   POST /live/:id/gifts      — send a gift (debits sender NGN wallet, credits
 *                               the host 1:1, ledgered both sides, fraud-gated)
 *   GET  /live/:id/gifts      — recent gifts + top-sender leaderboard
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
    await query(`
    CREATE TABLE IF NOT EXISTS live_gifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL,
      host_user_id UUID NOT NULL,
      gift_id VARCHAR(40) NOT NULL,
      gift_name VARCHAR(60) NOT NULL,
      gift_icon VARCHAR(16),
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price NUMERIC(14,2) NOT NULL,
      total_amount NUMERIC(14,2) NOT NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'NGN',
      reference VARCHAR(80) UNIQUE NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'completed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_live_gifts_session ON live_gifts(session_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_live_gifts_sender ON live_gifts(sender_id, created_at DESC)`);
}

// ---------------------------------------------------------------------------
// Gift catalog — TikTok-flavoured tiers, priced in NGN. Static in code so the
// tray renders instantly and prices can't drift between app versions; admin
// can kill the whole feature via the Personal Products console.
// ---------------------------------------------------------------------------
const LIVE_GIFTS = [
    { id: "rose", name: "Rose", icon: "🌹", price: 20 },
    { id: "heart", name: "Heart", icon: "❤️", price: 50 },
    { id: "star", name: "Star", icon: "⭐", price: 100 },
    { id: "clap", name: "Applause", icon: "👏", price: 150 },
    { id: "crown", name: "Crown", icon: "👑", price: 250 },
    { id: "ring", name: "Ring", icon: "💍", price: 500 },
    { id: "teddy", name: "Teddy", icon: "🧸", price: 1000 },
    { id: "rocket", name: "Rocket", icon: "🚀", price: 2000 },
    { id: "diamond", name: "Diamond", icon: "💎", price: 5000 },
    { id: "yacht", name: "Yacht", icon: "🛥️", price: 10000 },
] as const;

function findGift(giftId: string) {
    return LIVE_GIFTS.find((g) => g.id === String(giftId || "").trim().toLowerCase());
}

/** Resolve a live session by UUID id OR by its call_code (room UI only knows the code). */
async function resolveLiveSession(idOrCode: string) {
    const key = String(idOrCode || "").trim();
    const r = await query(
        `SELECT * FROM live_sessions WHERE (id::text = $1 OR call_code = $1) AND status = 'live' LIMIT 1`,
        [key],
    );
    return r.rows[0] || null;
}

function generateCallCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 9; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;
}

/**
 * @swagger
 * /live/gifts:
 *   get:
 *     summary: Gift catalog for live streams (NGN-priced)
 *     tags: [Live]
 *     security: [{ bearerAuth: [] }]
 */
// NOTE: declared BEFORE "/:id" so "gifts" is never swallowed as an id.
router.get("/gifts", authenticateToken, checkSubscriptionStatus, (_req: AuthenticatedRequest, res) => {
    res.json({
        success: true,
        data: {
            gifts: LIVE_GIFTS.map((g) => ({ id: g.id, name: g.name, icon: g.icon, price: g.price, currency: "NGN" })),
        },
    });
});

/**
 * @swagger
 * /live/{id}/gifts:
 *   post:
 *     summary: Send a gift to a live stream (debits your NGN wallet, credits the host)
 *     tags: [Live]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/:id/gifts", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const gift = findGift(String(req.body?.gift_id || ""));
    const quantity = Math.floor(Number(req.body?.quantity || 1));
    if (!gift) return res.status(400).json({ success: false, error: "Unknown gift" });
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) {
        return res.status(400).json({ success: false, error: "quantity must be between 1 and 99" });
    }

    const session = await resolveLiveSession(String(req.params.id));
    if (!session) return res.status(404).json({ success: false, error: "Stream not found (or already ended)" });

    const total = Math.round(gift.price * quantity * 100) / 100;
    const reference = `LGFT_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    // FRAUD GATE — gifting is real money leaving the sender's wallet.
    let fraud: Awaited<ReturnType<typeof evaluateOutflow>> | null = null;
    try {
        fraud = await evaluateOutflow({
            flow: "transfer",
            userId,
            walletId: null,
            amount: total,
            currency: "NGN",
            reference,
            ip: (String(req.headers["x-forwarded-for"] || "")).split(",")[0]?.trim() || req.ip || null,
            userAgent: (req.headers["user-agent"] as string) || null,
            deviceId: (req.headers["x-device-id"] as string) || null,
            beneficiary: { accountName: `live:${session.id.slice(0, 8)}`, accountNumber: null, bankCode: null },
            channel: `live:gift:${gift.id}`,
        });
    } catch (e: any) {
        console.error("[live:gifts] fraud engine error (fail-open):", e?.message);
    }
    // `decision` is widened to string on purpose: the early returns below
    // narrow a union-typed const, which breaks the later hold-checks.
    const decision: string = fraud?.decision ?? "allow";
    if (decision === "reject") {
        return res.status(403).json({ success: false, error: fraudRejectReason(fraud!), code: "FRAUD_REJECTED" });
    }
    if (decision === "hold") {
        return res.status(202).json({
            success: true, message: "Gift received but held for a quick security review.",
            code: "FRAUD_HOLD", fraud: { decision: "hold", score: fraud?.score ?? 0, dueDiligenceId: fraud?.dueDiligenceId },
        });
    }

    // Debit the sender's NGN wallet (atomic balance guard), credit the host 1:1.
    const senderWalletRes = await query(
        `SELECT id FROM wallets WHERE user_id = $1 AND UPPER(currency) = 'NGN' AND status = 'active' LIMIT 1`,
        [userId],
    );
    const senderWallet = senderWalletRes.rows[0];
    if (!senderWallet) return res.status(400).json({ success: false, error: "You need an NGN wallet to send gifts" });

    const debited = await debitWallet(senderWallet.id, total);
    if (!debited) {
        return res.status(400).json({
            success: false, code: "INSUFFICIENT_BALANCE",
            error: `Insufficient NGN balance — this gift needs ₦${total.toLocaleString()}.`,
        });
    }

    const hostWalletRes = await query(
        `SELECT id FROM wallets WHERE user_id = $1 AND UPPER(currency) = 'NGN' AND status = 'active' LIMIT 1`,
        [session.host_user_id],
    );
    const hostWallet = hostWalletRes.rows[0];
    if (hostWallet) {
        await creditWallet(hostWallet.id, total);
    }

    try {
        await insertTransaction({
            userId, walletId: senderWallet.id, reference, type: "debit",
            transactionType: "live_gift", amount: total, currency: "NGN",
            description: `Live gift ${gift.icon} ${gift.name} x${quantity} — ${session.title.slice(0, 60)}`,
        });
        if (hostWallet) {
            await insertTransaction({
                userId: session.host_user_id, walletId: hostWallet.id,
                reference: `${reference}-IN`, type: "credit",
                transactionType: "live_gift_receive", amount: total, currency: "NGN",
                description: `Live gift received ${gift.icon} ${gift.name} x${quantity}`,
            });
        }
        const ins = await query(
            `INSERT INTO live_gifts
               (session_id, sender_id, host_user_id, gift_id, gift_name, gift_icon, quantity, unit_price, total_amount, reference, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [session.id, userId, session.host_user_id, gift.id, gift.name, gift.icon, quantity, gift.price, total, reference,
             decision === "hold" ? "held" : "completed"],
        );
        const senderRes = await query(`SELECT COALESCE(NULLIF(name, ''), email, 'Someone') AS name FROM users WHERE id = $1`, [userId]);

        if (decision !== "hold") {
            createNotification({
                userId: session.host_user_id, type: "transaction", title: `${gift.icon} Gift received`,
                message: `${senderRes.rows[0]?.name || "Someone"} sent you ${gift.name} x${quantity} — ₦${total.toLocaleString()}.`,
            }).catch(() => {});
        }

        const balRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [senderWallet.id]);
        res.status(201).json({
            success: true,
            data: {
                gift: { id: gift.id, name: gift.name, icon: gift.icon, quantity, unit_price: gift.price, total_amount: total },
                sender_name: senderRes.rows[0]?.name || "Someone",
                session_id: session.id,
                reference,
                balance: Number(balRes.rows[0]?.balance || 0),
                ...(decision === "hold" ? { held: true, fraud: { score: fraud?.score ?? 0 } } : {}),
            },
        });
    } catch (e: any) {
        // Ledger insert failed — refund the sender so money is never lost.
        console.error("[live:gifts] ledger failed, refunding:", e?.message);
        await creditWallet(senderWallet.id, total).catch(() => {});
        if (hostWallet) await debitWallet(hostWallet.id, total).catch(() => {});
        return res.status(500).json({ success: false, error: "Gift could not be recorded — you were not charged" });
    }
});

/**
 * @swagger
 * /live/{id}/gifts:
 *   get:
 *     summary: Recent gifts for a session + top senders (leaderboard)
 *     tags: [Live]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/:id/gifts", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const key = String(req.params.id || "").trim();
    const sessionRes = await query(
        `SELECT id FROM live_sessions WHERE (id::text = $1 OR call_code = $1) LIMIT 1`,
        [key],
    );
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ success: false, error: "Stream not found" });

    const recent = await query(
        `SELECT g.gift_id, g.gift_name, g.gift_icon, g.quantity, g.total_amount, g.created_at,
                COALESCE(NULLIF(u.name, ''), u.email, 'Someone') AS sender_name, u.avatar_url AS sender_photo
         FROM live_gifts g LEFT JOIN users u ON u.id = g.sender_id
         WHERE g.session_id = $1 AND g.status = 'completed'
         ORDER BY g.created_at DESC LIMIT 30`,
        [session.id],
    );
    const top = await query(
        `SELECT g.sender_id, COALESCE(NULLIF(u.name, ''), u.email, 'Someone') AS sender_name,
                u.avatar_url AS sender_photo, SUM(g.total_amount)::float8 AS total_sent
         FROM live_gifts g LEFT JOIN users u ON u.id = g.sender_id
         WHERE g.session_id = $1 AND g.status = 'completed'
         GROUP BY g.sender_id, u.name, u.email, u.avatar_url
         ORDER BY total_sent DESC LIMIT 5`,
        [session.id],
    );
    const totals = await query(
        `SELECT COALESCE(SUM(total_amount), 0)::float8 AS earned FROM live_gifts WHERE session_id = $1 AND status = 'completed'`,
        [session.id],
    );
    res.json({
        success: true,
        data: {
            recent: recent.rows.map((g: any) => ({ ...g, total_amount: Number(g.total_amount) })),
            top_senders: top.rows.map((t: any) => ({ ...t, total_sent: Number(t.total_sent) })),
            total_earned: Number(totals.rows[0]?.earned) || 0,
        },
    });
});

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
