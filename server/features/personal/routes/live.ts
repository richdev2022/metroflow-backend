import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import { assertPersonalService, genRef, debitWallet, creditWallet, insertTransaction, verifyTransactionPin, requirePersonalKyc } from "../personal-utils";
import { evaluateOutflow, fraudRejectReason } from "../../../services/fraud";
import { createNotification } from "../../../services/notifications";
import { upload } from "../../../middleware/upload";
import { uploadMediaBuffer } from "../../../services/media-upload";
import { sendPushToUsers } from "../../../services/push";

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
 *   GET  /live/gifts                → gift catalog (NGN-priced tiers)
 *   POST /live/:id/gifts            { gift_id, quantity } → send a gift (debits your
 *                                    NGN wallet, credits the host 1:1, fraud-gated,
 *                                    ledgered both sides, refund-on-ledger-failure)
 *   GET  /live/:id/gifts            → recent gifts + top-sender leaderboard + earnings
 *   POST /live/:id/vod              (multipart video[, poster]) → save the room recording
 *                                   as a replay (host/co-host; the client composites
 *                                   the stream onto a canvas + mixes audio and uploads
 *                                   it via MediaRecorder when recording stops)
 *   GET  /live/:id/vod              → the session's replay (latest) + clip chapters
 *   GET  /live/replays              → recent replays across sessions (live wall)
 *   POST /live/vods/:vodId/view     → count a replay view
 *   POST /live/:id/invite           { user_ids } → push-invite Metricorex users to
 *                                   the stream (deep-links straight into the room)
 *
 * Categories mirror TikTok: general, chat, talent, music, dance, food,
 * fashion, gaming, sports, education, business, faith, comedy.
 */

const router = express.Router();

const CATEGORIES = ["general", "chat", "talent", "music", "dance", "food", "fashion", "gaming", "sports", "education", "business", "faith", "comedy"];
const EMOJIS = new Set(["heart", "fire", "clap", "laugh", "wow", "sad", "party", "star", "money", "100"]);

const isCohost = (session: any, userId: string) =>
  Array.isArray(session.cohost_ids) && session.cohost_ids.includes(userId);

const isModerator = (session: any, userId: string) =>
  Array.isArray(session.moderator_ids) && session.moderator_ids.includes(userId);

/** Host + assigned moderators manage the room (approve guests, drop, moderate). */
const canModerate = (session: any, userId: string) =>
  session.host_id === userId || isModerator(session, userId);

async function sessionById(id: string) {
  // Accepts a UUID id OR the call_code (the watch page only knows the code,
  // e.g. /live/watch?code=LIVE-XXXX). `id::text = $1` keeps the UUID match
  // cast-safe — comparing a raw code against the UUID column makes Postgres
  // throw "invalid input syntax for type uuid" and the endpoint 500s with
  // "Could not join the stream".
  const r = await query(
    `SELECT l.*, u.name AS host_name, u.avatar_url AS host_photo
     FROM live_sessions l JOIN users u ON u.id = l.host_id
     WHERE (l.id::text = $1 OR l.call_code = $1) LIMIT 1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/**
 * Every live stream is backed by a real row in `calls` (type='live'). The call
 * room stack (socket room resolution, media credentials, participants) only
 * resolves rooms that exist in `calls`/`meetings` — without this row the
 * socket `call:join` for the LIVE- code fails with "Call or meeting not found"
 * and viewers get no media even though the REST join succeeded.
 * Idempotent: returns the existing call id when the row is already there.
 */
async function ensureLiveCallRow(session: { call_code: string; host_id: string; started_at?: string | Date | null }): Promise<string | null> {
  try {
    const existing = await query(`SELECT id FROM calls WHERE call_code = $1 LIMIT 1`, [session.call_code]);
    if (existing.rows.length) return existing.rows[0].id;
    const hostRes = await query(`SELECT business_id FROM users WHERE id = $1 LIMIT 1`, [session.host_id]);
    const businessId = hostRes.rows[0]?.business_id;
    if (!businessId) return null;
    const ins = await query(
      `INSERT INTO calls (business_id, type, status, created_by, host_id, call_code, is_group_call, started_at, provider)
       VALUES ($1, 'live', 'ongoing', $2, $2, $3, TRUE, COALESCE($4::timestamptz, NOW()), NULL)
       ON CONFLICT (call_code) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [businessId, session.host_id, session.call_code, session.started_at ?? null],
    );
    return ins.rows[0]?.id ?? null;
  } catch (e: any) {
    // Never block the join on the backing row — the room can still open via
    // the ad-hoc path; log so ops can spot a broken sequence.
    console.error("[live] ensureLiveCallRow failed:", e?.message);
    return null;
  }
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
    const callId = await ensureLiveCallRow(r.rows[0]);
    return res.status(201).json({
      success: true,
      data: {
        session: r.rows[0],
        call_id: callId,
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
// VOD replays — wall + view counting. Registered BEFORE GET /:id so Express
// does not swallow "/replays" as a session id.
// ---------------------------------------------------------------------------
router.get("/replays", authenticateToken, checkSubscriptionStatus, async (_req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "live"))) return;
    const r = await query(
      `SELECT v.id, v.url, v.poster_url, v.duration_seconds, v.view_count, v.created_at,
              s.id AS session_id, s.title, s.category, s.call_code, s.host_id, s.total_views,
              u.name AS host_name, u.avatar_url AS host_photo
         FROM live_vods v
         JOIN live_sessions s ON s.id = v.session_id
         JOIN users u ON u.id = v.host_id
        ORDER BY v.created_at DESC
        LIMIT 30`,
    );
    res.json({
      success: true,
      data: {
        replays: r.rows.map((v: any) => ({
          id: v.id,
          url: v.url,
          poster_url: v.poster_url,
          duration_seconds: Number(v.duration_seconds) || 0,
          view_count: Number(v.view_count) || 0,
          created_at: v.created_at,
          session: {
            id: v.session_id, title: v.title, category: v.category,
            call_code: v.call_code, host_id: v.host_id, total_views: Number(v.total_views) || 0,
            host_name: v.host_name, host_photo: v.host_photo,
          },
        })),
      },
    });
  } catch (e: any) {
    console.error("live replays error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load replays" });
  }
});

router.post("/vods/:vodId/view", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const vodId = String(req.params.vodId || "");
    if (!/^[0-9a-f-]{36}$/i.test(vodId)) return res.status(400).json({ success: false, error: "Invalid replay" });
    const r = await query(
      `UPDATE live_vods SET view_count = view_count + 1 WHERE id = $1 RETURNING view_count`,
      [vodId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Replay not found" });
    res.json({ success: true, data: { view_count: Number(r.rows[0].view_count) || 0 } });
  } catch {
    res.status(500).json({ success: false, error: "Could not count the view" });
  }
});

// ---------------------------------------------------------------------------
// Gifting — TikTok-style. Catalog is static in code so the tray renders
// instantly; the ADMIN sets per-gift price overrides + all livestream fees
// via system_settings ('live_settings'). Prices are NGN.
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

interface LiveSettings {
  currency: string;
  gift_prices: Record<string, number>;
  gift_commission_percent: number;
  withdrawal_fee_percent: number;
  withdrawal_fee_flat: number;
  withdrawal_min: number;
  battle_duration_seconds: number;
  battle_multiplier: number;
  /** Points a viewer earns their side per battle cheer tap (default 1). */
  battle_cheer_weight: number;
}

const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  currency: "NGN",
  gift_prices: {},
  gift_commission_percent: 0,
  withdrawal_fee_percent: 0,
  withdrawal_fee_flat: 0,
  withdrawal_min: 1000,
  battle_duration_seconds: 300,
  battle_multiplier: 2,
  battle_cheer_weight: 1,
};

/** Admin-configurable livestream economics (fees, gift prices, battle defaults). */
export async function getLiveSettings(): Promise<LiveSettings> {
  try {
    const r = await query(`SELECT value FROM system_settings WHERE key = 'live_settings' LIMIT 1`);
    if (r.rows[0]?.value) return { ...DEFAULT_LIVE_SETTINGS, ...JSON.parse(r.rows[0].value) };
  } catch { /* defaults */ }
  return DEFAULT_LIVE_SETTINGS;
}

function findGift(giftId: string, settings?: LiveSettings) {
  const g = LIVE_GIFTS.find((x) => x.id === String(giftId || "").trim().toLowerCase());
  if (!g) return null;
  const override = settings?.gift_prices?.[g.id];
  return { ...g, price: Number.isFinite(override) && Number(override) >= 0 ? Math.round(Number(override) * 100) / 100 : g.price };
}

/** Resolve a live session by UUID id OR by its call_code (the room UI only knows the code). */
async function resolveLiveSession(idOrCode: string, includeEnded = false) {
  const key = String(idOrCode || "").trim();
  const r = await query(
    `SELECT * FROM live_sessions WHERE (id::text = $1 OR call_code = $1)${includeEnded ? "" : " AND status = 'live'"} LIMIT 1`,
    [key],
  );
  return r.rows[0] ?? null;
}

router.get("/gifts", authenticateToken, async (_req: AuthenticatedRequest, res) => {
  const settings = await getLiveSettings();
  res.json({
    success: true,
    data: {
      gifts: LIVE_GIFTS.map((g) => {
        const priced = findGift(g.id, settings)!;
        return { id: priced.id, name: priced.name, icon: priced.icon, price: priced.price, currency: settings.currency || "NGN" };
      }),
      battle: { duration_seconds: settings.battle_duration_seconds, multiplier: settings.battle_multiplier },
    },
  });
});

// NOTE: pocket routes are declared BEFORE "/:id" so "pocket" is never
// swallowed as a session id.
router.get("/pocket", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const settings = await getLiveSettings();
    await query(
      `INSERT INTO live_gift_pockets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const pocket = await query(
      `SELECT total_earned, total_withdrawn, updated_at FROM live_gift_pockets WHERE user_id = $1`,
      [userId],
    );
    const earned = Number(pocket.rows[0]?.total_earned) || 0;
    const withdrawn = Number(pocket.rows[0]?.total_withdrawn) || 0;
    const withdrawals = await query(
      `SELECT id, amount, fee, net_amount, reference, status, created_at
         FROM live_pocket_withdrawals WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [userId],
    );
    const perSession = await query(
      `SELECT l.id AS session_id, l.title, l.call_code, l.started_at, l.ended_at,
              COALESCE(SUM(g.host_amount), 0)::float8 AS earned, COUNT(g.id)::int AS gift_count
         FROM live_gifts g JOIN live_sessions l ON l.id = g.session_id
        WHERE g.host_user_id = $1 AND g.status = 'completed'
        GROUP BY l.id, l.title, l.call_code, l.started_at, l.ended_at
        ORDER BY MAX(g.created_at) DESC LIMIT 10`,
      [userId],
    );
    const pct = Number(settings.withdrawal_fee_percent) || 0;
    const flat = Number(settings.withdrawal_fee_flat) || 0;
    res.json({
      success: true,
      data: {
        balance: Math.max(0, Math.round((earned - withdrawn) * 100) / 100),
        total_earned: earned,
        total_withdrawn: withdrawn,
        currency: settings.currency || "NGN",
        fees: {
          withdrawal_fee_percent: pct,
          withdrawal_fee_flat: flat,
          withdrawal_min: Number(settings.withdrawal_min) || 0,
          example: pct + flat > 0
            ? Math.round((0.01 * pct + flat) * 100) / 100
            : 0,
        },
        withdrawals: withdrawals.rows.map((w: any) => ({ ...w, amount: Number(w.amount), fee: Number(w.fee), net_amount: Number(w.net_amount) })),
        sessions: perSession.rows.map((s: any) => ({ ...s, earned: Number(s.earned) })),
      },
    });
  } catch (e: any) {
    console.error("live pocket error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load gift pocket" });
  }
});

router.post("/pocket/withdraw", authenticateToken, requirePersonalKyc(), async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const settings = await getLiveSettings();
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const min = Number(settings.withdrawal_min) || 0;
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: "Enter a valid withdrawal amount" });
    }
    if (amount < min) {
      return res.status(400).json({ success: false, code: "BELOW_MIN", error: `Minimum withdrawal is ₦${min.toLocaleString()}.` });
    }

    const pinCheck = await verifyTransactionPin(req.body?.pin, { userId });
    if (!pinCheck.ok) {
      return res.status(pinCheck.code === "PIN_REQUIRED" || pinCheck.code === "INVALID_PIN" ? 400 : 403)
        .json({ success: false, code: pinCheck.code, error: pinCheck.error });
    }

    // Atomic guard: only withdraw what the pocket actually holds.
    const upd = await query(
      `UPDATE live_gift_pockets
          SET total_withdrawn = total_withdrawn + $2, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND (total_earned - total_withdrawn) >= $2
        RETURNING total_earned, total_withdrawn`,
      [userId, amount],
    );
    if (!upd.rows[0]) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_POCKET", error: "Not enough earnings in your gift pocket" });
    }

    const fee = Math.round((amount * (Number(settings.withdrawal_fee_percent) || 0) / 100 + (Number(settings.withdrawal_fee_flat) || 0)) * 100) / 100;
    const net = Math.round((amount - fee) * 100) / 100;
    if (net <= 0) {
      await query(`UPDATE live_gift_pockets SET total_withdrawn = GREATEST(0, total_withdrawn - $2) WHERE user_id = $1`, [userId, amount]);
      return res.status(400).json({ success: false, error: "Fee exceeds the withdrawal amount — try a larger amount" });
    }
    const reference = genRef("LPWD");

    try {
      const walletRes = await query(
        `SELECT id FROM wallets WHERE user_id = $1 AND UPPER(currency) = 'NGN' AND status = 'active' LIMIT 1`,
        [userId],
      );
      const wallet = walletRes.rows[0];
      if (!wallet) throw new Error("No active NGN wallet");

      await creditWallet(wallet.id, net);
      await insertTransaction({
        userId, walletId: wallet.id, reference, type: "credit",
        transactionType: "live_pocket_withdrawal", amount: net, currency: "NGN",
        description: `Livestream gift earnings withdrawal${fee > 0 ? ` (fee ₦${fee.toLocaleString()})` : ""}`,
      });
      const wd = await query(
        `INSERT INTO live_pocket_withdrawals (user_id, amount, fee, net_amount, reference)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [userId, amount, fee, net, reference],
      );
      createNotification({
        userId, type: "transaction", title: "Gift earnings withdrawn",
        message: `₦${net.toLocaleString()} added to your NGN wallet${fee > 0 ? ` (fee ₦${fee.toLocaleString()})` : ""}.`,
      }).catch(() => {});
      res.status(201).json({
        success: true,
        data: {
          withdrawal: { id: wd.rows[0].id, amount, fee, net_amount: net, reference, created_at: wd.rows[0].created_at },
          pocket_balance: Math.max(0, Math.round((Number(upd.rows[0].total_earned) - Number(upd.rows[0].total_withdrawn)) * 100) / 100),
        },
        message: `₦${net.toLocaleString()} sent to your NGN wallet`,
      });
    } catch (e: any) {
      // Roll the pocket back — the money must never leave without landing.
      await query(`UPDATE live_gift_pockets SET total_withdrawn = GREATEST(0, total_withdrawn - $2) WHERE user_id = $1`, [userId, amount]).catch(() => {});
      console.error("live pocket withdraw failed:", e?.message);
      res.status(500).json({ success: false, error: "Withdrawal failed — your earnings are safe in the pocket" });
    }
  } catch (e: any) {
    console.error("live pocket withdraw error:", e?.message);
    res.status(500).json({ success: false, error: "Could not withdraw" });
  }
});

router.post("/:id/gifts", authenticateToken, requirePersonalKyc(), async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "live"))) return;
    const userId = req.user!.userId;
    const settings = await getLiveSettings();
    const gift = findGift(String(req.body?.gift_id || ""), settings);
    const quantity = Math.floor(Number(req.body?.quantity || 1));
    if (!gift) return res.status(400).json({ success: false, error: "Unknown gift" });
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) {
      return res.status(400).json({ success: false, error: "quantity must be between 1 and 99" });
    }
    const session = await resolveLiveSession(String(req.params.id));
    if (!session) return res.status(404).json({ success: false, error: "Stream not found (or already ended)" });
    if (session.host_id === userId) return res.status(400).json({ success: false, error: "You cannot gift your own stream" });

    const total = Math.round(gift.price * quantity * 100) / 100;
    // Admin-configured platform commission on gifts; the net lands in the
    // host's LIVESTREAM GIFT POCKET (not their wallet) — streamers withdraw
    // from the pocket to their NGN wallet (withdrawal fee applies there).
    const commission = Math.round(total * (Number(settings.gift_commission_percent) || 0)) / 100;
    const hostAmount = Math.max(0, Math.round((total - commission) * 100) / 100);
    const reference = genRef("LGFT");

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
    // Widened to string on purpose: early returns below narrow the union type.
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

    // Credit the HOST'S GIFT POCKET (atomic upsert). The host's withdrawable
    // balance = total_earned - total_withdrawn on this row.
    await query(
      `INSERT INTO live_gift_pockets (user_id, total_earned)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
          SET total_earned = live_gift_pockets.total_earned + $2,
              updated_at = CURRENT_TIMESTAMP`,
      [session.host_id, hostAmount],
    );

    // BATTLE SCORING — gifts sent to a streamer mid-battle count toward their
    // side at the configured multiplier ("x2 gifting points").
    let battleScored: { battle_id: string; side: "a" | "b"; points: number } | null = null;
    try {
      const battleRes = await query(
        `SELECT id, session_a_id, session_b_id FROM live_battles
          WHERE status = 'active' AND ends_at > NOW()
            AND (session_a_id = $1 OR session_b_id = $1)
          LIMIT 1`,
        [session.id],
      ).catch(() => ({ rows: [] as any[] }));
      const battle = battleRes.rows[0];
      if (battle) {
        const points = Math.round(total * (Number(settings.battle_multiplier) || 1) * 100) / 100;
        const side: "a" | "b" = battle.session_a_id === session.id ? "a" : "b";
        await query(
          `UPDATE live_battles SET score_${side} = score_${side} + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [battle.id, points],
        );
        battleScored = { battle_id: battle.id, side, points };
      }
    } catch (e: any) {
      console.error("[live:gifts] battle scoring skipped:", e?.message);
    }

    try {
      await insertTransaction({
        userId, walletId: senderWallet.id, reference, type: "debit",
        transactionType: "live_gift", amount: total, currency: "NGN",
        description: `Live gift ${gift.icon} ${gift.name} x${quantity} — ${String(session.title || "Live").slice(0, 60)}`,
      });
      const ins = await query(
        `INSERT INTO live_gifts
           (session_id, sender_id, host_user_id, gift_id, gift_name, gift_icon, quantity, unit_price, total_amount, commission_amount, host_amount, reference, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [session.id, userId, session.host_id, gift.id, gift.name, gift.icon, quantity, gift.price, total, commission, hostAmount, reference,
         decision === "hold" ? "held" : "completed"],
      );
      await query(`UPDATE live_sessions SET gift_count = gift_count + $2 WHERE id = $1`, [session.id, quantity]);
      const senderRes = await query(`SELECT COALESCE(NULLIF(name, ''), email, 'Someone') AS name FROM users WHERE id = $1`, [userId]);

      if (decision !== "hold") {
        createNotification({
          userId: session.host_id, type: "transaction", title: `${gift.icon} Gift received`,
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
          ...(battleScored ? { battle: battleScored } : {}),
          ...(decision === "hold" ? { held: true, fraud: { score: fraud?.score ?? 0 } } : {}),
        },
      });
    } catch (e: any) {
      // Ledger insert failed — refund the sender and claw the pocket credit
      // back so money is never lost or double-counted.
      console.error("[live:gifts] ledger failed, refunding:", e?.message);
      await creditWallet(senderWallet.id, total).catch(() => {});
      await query(
        `UPDATE live_gift_pockets SET total_earned = GREATEST(0, total_earned - $2) WHERE user_id = $1`,
        [session.host_id, hostAmount],
      ).catch(() => {});
      if (battleScored) {
        await query(
          `UPDATE live_battles SET score_${battleScored.side} = GREATEST(0, score_${battleScored.side} - $2) WHERE id = $1`,
          [battleScored.battle_id, battleScored.points],
        ).catch(() => {});
      }
      return res.status(500).json({ success: false, error: "Gift could not be recorded — you were not charged" });
    }
  } catch (e: any) {
    console.error("[live:gifts] send failed:", e?.message);
    res.status(500).json({ success: false, error: "Could not send gift" });
  }
});

router.get("/:id/gifts", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const session = await resolveLiveSession(String(req.params.id), true);
    if (!session) return res.status(404).json({ success: false, error: "Stream not found" });
    const recent = await query(
      `SELECT g.id, g.gift_id, g.gift_name, g.gift_icon, g.quantity, g.total_amount, g.created_at,
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
  } catch {
    res.status(500).json({ success: false, error: "Could not load gifts" });
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
    // Guarantee the backing `calls` row exists (also repairs sessions created
    // before the backing-row fix) and hand the call id to the watch page so it
    // can mint media credentials via POST /calls/:id/join.
    const callId = await ensureLiveCallRow(s);
    res.json({
      success: true,
      data: { watch_url: `/join-call?code=${s.call_code}&watch=1`, call_id: callId, session: s },
    });
  } catch (e: any) {
    console.error("live join error:", e?.message);
    res.status(500).json({ success: false, error: "Could not join the stream" });
  }
});

router.post("/:id/leave", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    // Resolve by UUID or call_code so a stale client holding the code still
    // decrements the viewer count instead of hitting a UUID cast error.
    const s = await sessionById(String(req.params.id));
    if (!s) return res.json({ success: true });
    const r = await query(
      `UPDATE live_viewers SET left_at = CURRENT_TIMESTAMP
       WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING id`,
      [s.id, req.user!.userId],
    );
    if (r.rows.length) await bumpViewers(s.id, -1);
    // Stage exit — a co-host leaving the room gives the stage slot back.
    if (s.host_id !== req.user!.userId && isCohost(s, req.user!.userId)) {
      await removeCohost(s.id, s.cohost_ids, req.user!.userId).catch(() => {});
    }
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
       WHERE id = $1 RETURNING id, call_code, peak_viewers, total_views, reaction_count`,
      [s.id],
    );
    await query(`UPDATE live_viewers SET left_at = CURRENT_TIMESTAMP WHERE session_id = $1 AND left_at IS NULL`, [s.id]);
    // Close the backing call room so it no longer resolves as an active call.
    await query(
      `UPDATE calls SET status = 'completed', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE call_code = $1 AND status <> 'completed'`,
      [s.call_code],
    ).catch(() => {});
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
    // Resolve by UUID or call_code first — comparing a code against the UUID
    // session_id column directly makes Postgres throw a cast error.
    const s = await sessionById(String(req.params.id));
    if (!s) return res.json({ success: true, data: { messages: [] } });
    const sinceId = req.query.since_id ? String(req.query.since_id) : null;
    const params: any[] = [s.id];
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

// ---------------------------------------------------------------------------
// Tap-to-like — the room UI batches screen taps (max 10 per call) and fires
// this every ~1.2s while the viewer keeps tapping. The running total rides
// back on every session detail poll (SELECT * includes like_count).
// Per-user token bucket keeps a single client from inflating the counter.
// ---------------------------------------------------------------------------
const likeBuckets = new Map<string, { tokens: number; last: number }>();
const LIKE_CAPACITY = 90;          // burst allowance
const LIKE_REFILL_PER_SEC = 15;    // sustained rate
function takeLikeTokens(key: string, wanted: number): number {
  const now = Date.now();
  const b = likeBuckets.get(key) || { tokens: LIKE_CAPACITY, last: now };
  b.tokens = Math.min(LIKE_CAPACITY, b.tokens + ((now - b.last) / 1000) * LIKE_REFILL_PER_SEC);
  b.last = now;
  const granted = Math.max(0, Math.min(Math.floor(wanted), Math.floor(b.tokens)));
  b.tokens -= granted;
  likeBuckets.set(key, b);
  if (likeBuckets.size > 5000) likeBuckets.clear(); // bound memory on long uptimes
  return granted;
}

router.post("/:id/likes", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await resolveLiveSession(String(req.params.id));
    if (!s || s.status !== "live") return res.status(404).json({ success: false, error: "Stream not live" });
    const wanted = Math.floor(Number(req.body?.count) || 1);
    const granted = takeLikeTokens(`${req.user!.userId}:${s.id}`, Math.min(Math.max(wanted, 1), 10));
    if (granted <= 0) {
      return res.json({ success: true, data: { like_count: Number(s.like_count || 0), throttled: true } });
    }
    const r = await query(
      `UPDATE live_sessions SET like_count = like_count + $2 WHERE id = $1 RETURNING like_count`,
      [s.id, granted],
    );
    res.json({ success: true, data: { like_count: Number(r.rows[0]?.like_count || 0), counted: granted } });
  } catch {
    res.status(500).json({ success: false, error: "Could not register likes" });
  }
});

router.get("/:id/reactions", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.json({ success: true, data: { reactions: [] } });
    const minutes = Math.min(10, Math.max(1, Number(req.query.minutes) || 2));
    const r = await query(
      `SELECT emoji, COUNT(*)::int AS n FROM live_reactions
       WHERE session_id = $1 AND created_at > NOW() - ($2 || ' minutes')::INTERVAL
       GROUP BY emoji`,
      [s.id, minutes],
    );
    res.json({ success: true, data: { reactions: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load reactions" });
  }
});

// ---------------------------------------------------------------------------
// Clip highlights — "bookmark this moment" (TikTok-style)
// ---------------------------------------------------------------------------
//   POST   /live/:id/clips       { label? } → host/cohost/moderator saves a
//                                highlight at the CURRENT stream timestamp
//   GET    /live/:id/clips       → ordered highlight list (any viewer)
//   DELETE /live/clips/:clipId   → creator or host removes one
router.post("/:id/clips", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (!canModerate(s, req.user!.userId)) {
      return res.status(403).json({ success: false, error: "Only the host or moderators can clip moments" });
    }
    const label = String(req.body?.label || "").slice(0, 120);
    const startedAt = s.started_at ? new Date(s.started_at).getTime() : Date.now();
    const offsetSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const r = await query(
      `INSERT INTO live_clips (session_id, created_by, label, offset_seconds)
       VALUES ($1, $2, $3, $4)
       RETURNING id, session_id, created_by, label, offset_seconds, created_at`,
      [s.id, req.user!.userId, label, offsetSeconds],
    );
    res.status(201).json({
      success: true,
      data: {
        clip: {
          ...r.rows[0],
          creator_name: s.host_name === req.user!.name ? s.host_name : req.user!.name,
        },
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not save the highlight" });
  }
});

router.get("/:id/clips", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.json({ success: true, data: { clips: [] } });
    const r = await query(
      `SELECT c.id, c.label, c.offset_seconds, c.created_at, c.created_by,
              u.name AS creator_name, u.avatar_url AS creator_photo
       FROM live_clips c LEFT JOIN users u ON u.id = c.created_by
       WHERE c.session_id = $1
       ORDER BY c.offset_seconds ASC, c.created_at ASC
       LIMIT 100`,
      [s.id],
    );
    res.json({ success: true, data: { clips: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load highlights" });
  }
});

router.delete("/clips/:clipId", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const clipId = String(req.params.clipId || "");
    const r = await query(
      `SELECT c.*, l.host_id FROM live_clips c
       JOIN live_sessions l ON l.id = c.session_id
       WHERE c.id::text = $1 LIMIT 1`,
      [clipId],
    );
    const clip = r.rows[0];
    if (!clip) return res.status(404).json({ success: false, error: "Highlight not found" });
    if (clip.created_by !== req.user!.userId && clip.host_id !== req.user!.userId) {
      return res.status(403).json({ success: false, error: "Only the creator or the host can remove a highlight" });
    }
    await query(`DELETE FROM live_clips WHERE id::text = $1`, [clipId]);
    res.json({ success: true, data: { removed: clipId } });
  } catch {
    res.status(500).json({ success: false, error: "Could not remove the highlight" });
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
    if (!canModerate(s, req.user!.userId)) {
      return res.status(403).json({ success: false, error: "Only the host or a moderator can moderate" });
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

// ---------------------------------------------------------------------------
// MODERATORS — the host assigns trusted viewers to help run the room.
// Moderators can approve/decline stage requests, drop guests, remove messages
// and ban viewers. Host-only: assigning/removing moderators, co-hosts, ending.
// ---------------------------------------------------------------------------

router.post("/:id/moderator", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (s.host_id !== req.user!.userId) return res.status(403).json({ success: false, error: "Only the host can assign moderators" });
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ success: false, error: "user_id is required" });
    if (user_id === s.host_id) return res.status(400).json({ success: false, error: "The host does not need a moderator badge" });
    const mods = Array.isArray(s.moderator_ids) ? s.moderator_ids : [];
    if (mods.includes(user_id)) return res.json({ success: true, data: { moderator_ids: mods } });
    if (mods.length >= 10) return res.status(400).json({ success: false, error: "Maximum 10 moderators per stream" });
    const next = [...mods, user_id];
    await query(`UPDATE live_sessions SET moderator_ids = $2::jsonb WHERE id = $1`, [s.id, JSON.stringify(next)]);
    createNotification({
      businessId: "", userId: user_id,
      title: "You are now a moderator",
      message: `You were assigned as a moderator on "${s.title}".`,
      type: "social",
    }).catch(() => {});
    res.json({ success: true, data: { moderator_ids: next } });
  } catch {
    res.status(500).json({ success: false, error: "Could not assign moderator" });
  }
});

router.delete("/:id/moderator/:userId", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (s.host_id !== req.user!.userId) return res.status(403).json({ success: false, error: "Only the host manages moderators" });
    const mods = (Array.isArray(s.moderator_ids) ? s.moderator_ids : []).filter((x: string) => x !== req.params.userId);
    await query(`UPDATE live_sessions SET moderator_ids = $2::jsonb WHERE id = $1`, [s.id, JSON.stringify(mods)]);
    res.json({ success: true, data: { moderator_ids: mods } });
  } catch {
    res.status(500).json({ success: false, error: "Could not remove moderator" });
  }
});

/**
 * POST /:id/guests/:userId/drop — host/moderator removes a stage guest.
 * Demotes the guest to viewer (cohost_ids) AND cancels their join-request
 * rows, so the guest's own 4s status poll flips out of "approved" and their
 * client stops publishing — otherwise the dropped guest would still look
 * on-stage to themselves.
 */
router.post("/:id/guests/:userId/drop", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (!canModerate(s, req.user!.userId)) return res.status(403).json({ success: false, error: "Only the host or a moderator can drop guests" });
    const targetUser = String(req.params.userId);
    if (targetUser === s.host_id) return res.status(400).json({ success: false, error: "The host cannot be dropped" });
    const cohosts = await removeCohost(s.id, s.cohost_ids, targetUser);
    await query(
      `UPDATE live_join_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE session_id = $1 AND user_id = $2 AND status IN ('pending','approved')`,
      [s.id, targetUser],
    );
    res.json({ success: true, data: { cohost_ids: cohosts, dropped: targetUser } });
  } catch {
    res.status(500).json({ success: false, error: "Could not drop the guest" });
  }
});

/** POST /:id/stage/exit — a stage guest leaves the stage themselves. */
router.post("/:id/stage/exit", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    const cohosts = await removeCohost(s.id, s.cohost_ids, req.user!.userId);
    await query(
      `UPDATE live_join_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE session_id = $1 AND user_id = $2 AND status IN ('pending','approved')`,
      [s.id, req.user!.userId],
    );
    res.json({ success: true, data: { cohost_ids: cohosts, is_stage: false } });
  } catch {
    res.status(500).json({ success: false, error: "Could not leave the stage" });
  }
});

// ---------------------------------------------------------------------------
// RAISE HAND — "bring me on stage". A viewer requests to join the broadcast;
// the host approves (viewer lands in cohost_ids → publishing unlocks) or
// declines. Role-aware polling endpoints — no socket infra required: the
// viewer polls their own request status, the host polls the pending queue.
// ---------------------------------------------------------------------------

/** Add a user to the session's cohost list (cap shared with manual invites). */
async function addCohost(sessionId: string, current: any, userId: string): Promise<string[]> {
  const cohosts = Array.isArray(current) ? current : [];
  if (cohosts.includes(userId)) return cohosts;
  const next = [...cohosts, userId];
  await query(`UPDATE live_sessions SET cohost_ids = $2::jsonb WHERE id = $1`, [sessionId, JSON.stringify(next)]);
  return next;
}

/** Remove a user from the session's cohost list (stage exit). */
async function removeCohost(sessionId: string, current: any, userId: string): Promise<string[]> {
  const next = (Array.isArray(current) ? current : []).filter((x: string) => x !== userId);
  await query(`UPDATE live_sessions SET cohost_ids = $2::jsonb WHERE id = $1`, [sessionId, JSON.stringify(next)]);
  return next;
}

// Viewer raises (or re-raises after a decline) / no-ops when already pending.
router.post("/:id/join-requests", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s || s.status !== "live") return res.status(404).json({ success: false, error: "This stream is not live" });
    const userId = req.user!.userId;
    if (s.host_id === userId) return res.status(400).json({ success: false, error: "You are the host of this stream" });
    const cohosts = Array.isArray(s.cohost_ids) ? s.cohost_ids : [];
    if (cohosts.includes(userId)) return res.json({ success: true, data: { status: "approved", is_stage: true } });
    if (cohosts.length >= 5) return res.status(400).json({ success: false, error: "The stage is full right now (5 guests max)" });

    const existing = await query(
      `SELECT id, status FROM live_join_requests WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
      [s.id, userId],
    );
    if (!existing.rows.length) {
      const ins = await query(
        `INSERT INTO live_join_requests (session_id, user_id) VALUES ($1, $2) RETURNING id, status, created_at`,
        [s.id, userId],
      );
      return res.json({ success: true, data: { request: ins.rows[0], status: ins.rows[0].status } });
    }
    const row = existing.rows[0];
    if (row.status === "pending") return res.json({ success: true, data: { request: row, status: "pending" } });
    if (row.status === "approved") return res.json({ success: true, data: { status: "approved", is_stage: true } });
    // declined / cancelled — re-raise
    const up = await query(
      `UPDATE live_join_requests SET status = 'pending', responded_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING id, status, created_at`,
      [row.id],
    );
    res.json({ success: true, data: { request: up.rows[0], status: up.rows[0].status } });
  } catch {
    res.status(500).json({ success: false, error: "Could not raise your hand" });
  }
});

// Role-aware list — HOST: pending queue (with profiles); VIEWER: own status.
router.get("/:id/join-requests", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    const userId = req.user!.userId;
    const cohosts = Array.isArray(s.cohost_ids) ? s.cohost_ids : [];
    const imHost = s.host_id === userId;

    if (imHost) {
      const pending = await query(
        `SELECT r.id, r.user_id, r.created_at, u.name, u.avatar_url AS photo
         FROM live_join_requests r JOIN users u ON u.id = r.user_id
         WHERE r.session_id = $1 AND r.status = 'pending'
         ORDER BY r.created_at ASC LIMIT 30`,
        [s.id],
      );
      return res.json({
        success: true,
        data: {
          pending: pending.rows,
          pending_count: pending.rows.length,
          stage: cohosts,
          stage_count: cohosts.length,
          moderators: Array.isArray(s.moderator_ids) ? s.moderator_ids : [],
        },
      });
    }

    const mine = await query(
      `SELECT id, status, created_at, responded_at FROM live_join_requests
       WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
      [s.id, userId],
    );
    const row = mine.rows[0] ?? null;
    // A request can be approved while the user has no pending row (manual
    // co-host invite) — surface stage membership either way. A cancelled
    // request reads as "none" so the client can cleanly re-raise.
    const raw = cohosts.includes(userId) ? "approved" : row?.status ?? "none";
    const status = raw === "cancelled" ? "none" : raw;
    res.json({
      success: true,
      data: {
        mine: row,
        status,
        is_stage: cohosts.includes(userId),
        is_moderator: isModerator(s, userId),
        moderators: Array.isArray(s.moderator_ids) ? s.moderator_ids : [],
      },
    });
  } catch {
    res.status(500).json({ success: false, error: "Could not load join requests" });
  }
});

// Viewer cancels their own pending request.
router.delete("/:id/join-requests", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    await query(
      `UPDATE live_join_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE session_id = $1 AND user_id = $2 AND status = 'pending'`,
      [s.id, req.user!.userId],
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Could not cancel the request" });
  }
});

// Host responds — approve brings the viewer ON STAGE (cohost_ids → media
// publishing unlocks on the client), decline flips the row so the viewer's
// next poll settles immediately. NOTE: Express 5 (path-to-regexp v8) rejects
// `:param(regex)` routes at REGISTRATION time, so approve/decline are two
// explicit paths instead of `:action(approve|decline)`.
const respondToJoinRequest = (action: "approve" | "decline") =>
  async (req: AuthenticatedRequest, res: any) => {
    try {
      const s = await sessionById(String(req.params.id));
      if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
      if (!canModerate(s, req.user!.userId)) return res.status(403).json({ success: false, error: "Only the host or a moderator can respond to requests" });
      const r = await query(
        `UPDATE live_join_requests SET status = $2, responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND session_id = $1 AND status = 'pending' RETURNING id, user_id, status`,
        [s.id, action === "approve" ? "approved" : "declined", req.params.rid],
      );
      if (!r.rows.length) return res.status(404).json({ success: false, error: "Request is no longer pending" });
      let cohost_ids = Array.isArray(s.cohost_ids) ? s.cohost_ids : [];
      if (action === "approve") {
        if (cohost_ids.length >= 5) return res.status(400).json({ success: false, error: "The stage is full right now (5 guests max)" });
        cohost_ids = await addCohost(s.id, cohost_ids, r.rows[0].user_id);
      }
      res.json({ success: true, data: { request: r.rows[0], cohost_ids } });
    } catch {
      res.status(500).json({ success: false, error: "Could not respond to the request" });
    }
  };

router.post("/:id/join-requests/:rid/approve", authenticateToken, respondToJoinRequest("approve"));
router.post("/:id/join-requests/:rid/decline", authenticateToken, respondToJoinRequest("decline"));

// ---------------------------------------------------------------------------
// PK BATTLES — TikTok-style LIVE battles. Two live streamers link their
// sessions; every gift a viewer sends to either stream mid-battle counts as
// points for that side (multiplier applied). Highest score when the clock
// hits zero wins. Win counts are lifetime (across all battles).
// ---------------------------------------------------------------------------

/** Finalize battles whose clock expired (lazy scheduler — no timers needed). */
async function finalizeExpiredBattles() {
  try {
    await query(
      `UPDATE live_battles
          SET status = 'ended',
              winner = CASE WHEN score_a > score_b THEN 'a'
                            WHEN score_b > score_a THEN 'b'
                            ELSE 'tie' END,
              updated_at = CURRENT_TIMESTAMP
        WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= NOW()`,
    );
  } catch (e: any) {
    console.error("[live:battles] finalize error:", e?.message);
  }
}

async function battleWinsFor(hostId: string): Promise<number> {
  const r = await query(
    `SELECT COUNT(*)::int AS c FROM live_battles
      WHERE status = 'ended' AND ((winner = 'a' AND host_a_id = $1) OR (winner = 'b' AND host_b_id = $1))`,
    [hostId],
  );
  return Number(r.rows[0]?.c) || 0;
}

function decorateBattle(b: any, viewerId: string) {
  const iAmA = b.host_a_id === viewerId;
  const nowActive = b.status === "active";
  const secondsLeft = nowActive && b.ends_at
    ? Math.max(0, Math.round((new Date(b.ends_at).getTime() - Date.now()) / 1000))
    : 0;
  return {
    id: b.id,
    status: b.status,
    duration_seconds: b.duration_seconds,
    started_at: b.started_at,
    ends_at: b.ends_at,
    seconds_left: secondsLeft,
    scores: { a: Number(b.score_a) || 0, b: Number(b.score_b) || 0 },
    winner: b.winner,
    my_side: iAmA ? "a" : "b",
    host_a: b.host_a_name ? { id: b.host_a_id, name: b.host_a_name, photo: b.host_a_photo } : undefined,
    host_b: b.host_b_name ? { id: b.host_b_id, name: b.host_b_name, photo: b.host_b_photo } : undefined,
  };
}

const BATTLE_SELECT = `
  SELECT b.*, u_a.name AS host_a_name, u_a.avatar_url AS host_a_photo,
         u_b.name AS host_b_name, u_b.avatar_url AS host_b_photo
    FROM live_battles b
    JOIN users u_a ON u_a.id = b.host_a_id
    LEFT JOIN users u_b ON u_b.id = b.host_b_id`;

/** Invite another live streamer to a PK battle (host only). */
router.post("/:id/battle", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    await finalizeExpiredBattles();
    const userId = req.user!.userId;
    const settings = await getLiveSettings();
    const mine = await sessionById(String(req.params.id));
    if (!mine) return res.status(404).json({ success: false, error: "Stream not found" });
    if (mine.host_id !== userId) return res.status(403).json({ success: false, error: "Only the host can start a battle" });
    if (mine.status !== "live") return res.status(400).json({ success: false, error: "Your stream is not live" });

    const opponent = await resolveLiveSession(String(req.body?.opponent_session_id || req.body?.opponent || ""));
    if (!opponent) return res.status(404).json({ success: false, error: "Opponent stream not found (or not live)" });
    if (opponent.host_id === userId) return res.status(400).json({ success: false, error: "You can't battle yourself" });

    // One pending/active battle per session at a time.
    const clash = await query(
      `SELECT id FROM live_battles
        WHERE status IN ('pending', 'active')
          AND (session_a_id IN ($1, $2) OR session_b_id IN ($1, $2))
        LIMIT 1`,
      [mine.id, opponent.id],
    );
    if (clash.rows[0]) return res.status(400).json({ success: false, error: "One of the streams is already in a battle", code: "ALREADY_IN_BATTLE" });

    const duration = Math.min(3600, Math.max(60, Number(req.body?.duration_seconds) || settings.battle_duration_seconds));
    // ONE canonical row binds BOTH sessions from the start: side A = initiator,
    // side B = opponent. Accept flips it active; gift scoring updates score_a
    // or score_b based on which session the gift landed on.
    const ins = await query(
      `INSERT INTO live_battles (session_a_id, session_b_id, host_a_id, host_b_id, duration_seconds)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [mine.id, opponent.id, userId, opponent.host_id, duration],
    );

    createNotification({
      userId: opponent.host_id, type: "social", title: "⚔️ Battle invite",
      message: `${req.user!.name || "A streamer"} challenged you to a LIVE battle — open your studio to accept.`,
    }).catch(() => {});

    const full = await query(`${BATTLE_SELECT} WHERE b.id = $1`, [ins.rows[0].id]);
    res.status(201).json({ success: true, data: { battle: decorateBattle(full.rows[0], userId) } });
  } catch (e: any) {
    console.error("battle invite error:", e?.message);
    res.status(500).json({ success: false, error: "Could not create the battle" });
  }
});

/** Battle state for a session (any viewer can poll — powers the PK HUD). */
router.get("/:id/battle", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    await finalizeExpiredBattles();
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    const r = await query(
      `${BATTLE_SELECT}
        WHERE (b.session_a_id = $1 OR b.session_b_id = $1)
          AND b.status IN ('pending', 'active', 'ended')
        ORDER BY b.created_at DESC LIMIT 1`,
      [s.id],
    );
    if (!r.rows[0]) return res.json({ success: true, data: { battle: null } });
    const b = r.rows[0];
    const wins = await Promise.all([battleWinsFor(b.host_a_id), b.host_b_id ? battleWinsFor(b.host_b_id) : Promise.resolve(0)]);
    res.json({
      success: true,
      data: {
        battle: {
          ...decorateBattle(b, req.user!.userId),
          wins: { a: wins[0], b: wins[1] },
          i_am_host_a: b.host_a_id === req.user!.userId,
          i_am_host_b: b.host_b_id === req.user!.userId,
          can_accept: b.status === "pending" && b.host_b_id === req.user!.userId,
        },
      },
    });
  } catch (e: any) {
    console.error("battle state error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load the battle" });
  }
});

// BATTLE CHEER — viewers tap their favourite streamer's side and the points
// ticker climbs. Each tap is worth `battle_cheer_weight` points (default 1);
// gifts remain the heavyweight scorer (total × battle_multiplier). The tap
// layer batches up to 10 taps per call; a per-user token bucket stops a
// single client from farming the scoreboard.
const cheerBuckets = new Map<string, { tokens: number; last: number }>();
const CHEER_CAPACITY = 60;
const CHEER_REFILL_PER_SEC = 8;
function takeCheerTokens(key: string, wanted: number): number {
  const now = Date.now();
  const b = cheerBuckets.get(key) || { tokens: CHEER_CAPACITY, last: now };
  b.tokens = Math.min(CHEER_CAPACITY, b.tokens + ((now - b.last) / 1000) * CHEER_REFILL_PER_SEC);
  b.last = now;
  const granted = Math.max(0, Math.min(Math.floor(wanted), Math.floor(b.tokens)));
  b.tokens -= granted;
  cheerBuckets.set(key, b);
  if (cheerBuckets.size > 5000) cheerBuckets.clear();
  return granted;
}

router.post("/battles/:id/cheer", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    await finalizeExpiredBattles();
    const userId = req.user!.userId;
    const side = String(req.body?.side) === "b" ? "b" : String(req.body?.side) === "a" ? "a" : null;
    if (!side) return res.status(400).json({ success: false, error: "side must be 'a' or 'b'" });
    const wanted = Math.floor(Number(req.body?.count) || 1);
    const granted = takeCheerTokens(`${userId}:${req.params.id}`, Math.min(Math.max(wanted, 1), 10));
    if (granted <= 0) {
      return res.json({ success: true, data: { throttled: true } });
    }
    const b = (
      await query(
        `SELECT id, session_a_id, session_b_id, host_a_id, host_b_id, status, ends_at, score_a, score_b
         FROM live_battles WHERE id = $1::uuid LIMIT 1`,
        [String(req.params.id)],
      )
    ).rows[0];
    if (!b || b.status !== "active") return res.status(404).json({ success: false, error: "Battle is not active" });
    if (b.ends_at && new Date(b.ends_at).getTime() <= Date.now()) {
      return res.status(400).json({ success: false, error: "Battle is not active" });
    }
    // A streamer cannot pump their own side (matches the gifting self-block);
    // they CAN cheer the opponent — keeps 2-account testing and rival banter alive.
    const ownSide = b.host_a_id === userId ? "a" : b.host_b_id === userId ? "b" : null;
    if (ownSide === side) {
      return res.status(400).json({ success: false, error: "You cannot cheer your own side — your fans do that!" });
    }
    const settings = await getLiveSettings();
    const weight = Math.max(0, Number(settings.battle_cheer_weight) || 1);
    const points = Math.round(granted * weight * 100) / 100;
    const scoreCol = side === "a" ? "score_a" : "score_b";
    const r = await query(
      `UPDATE live_battles SET ${scoreCol} = ${scoreCol} + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING score_a, score_b`,
      [b.id, points],
    );
    res.json({
      success: true,
      data: {
        side, counted: granted, points,
        scores: { a: Number(r.rows[0]?.score_a || 0), b: Number(r.rows[0]?.score_b || 0) },
      },
    });
  } catch (e: any) {
    console.error("battle cheer error:", e?.message);
    res.status(500).json({ success: false, error: "Could not register the cheer" });
  }
});

router.post("/battles/:id/accept", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    await finalizeExpiredBattles();
    const userId = req.user!.userId;
    const r = await query(`SELECT * FROM live_battles WHERE id = $1 AND status = 'pending'`, [req.params.id]);
    const battle = r.rows[0];
    if (!battle) return res.status(404).json({ success: false, error: "Battle invite not found" });

    // The accepting side is whoever was invited via the notification — we
    // resolve their CURRENT live session to bind as side B.
    const mine = await query(`SELECT * FROM live_sessions WHERE host_id = $1 AND status = 'live' ORDER BY started_at DESC LIMIT 1`, [userId]);
    if (!mine.rows[0]) return res.status(400).json({ success: false, error: "Go live first to accept a battle" });

    const upd = await query(
      `UPDATE live_battles
          SET session_b_id = $2, host_b_id = $3, status = 'active',
              started_at = CURRENT_TIMESTAMP, ends_at = CURRENT_TIMESTAMP + (duration_seconds || ' seconds')::INTERVAL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [battle.id, mine.rows[0].id, userId],
    );
    if (!upd.rows[0]) return res.status(400).json({ success: false, error: "Battle is no longer pending" });

    createNotification({
      userId: battle.host_a_id, type: "social", title: "⚔️ Battle started",
      message: `${req.user!.name || "Your opponent"} accepted — the battle is LIVE. Gifts now score points!`,
    }).catch(() => {});
    const full = await query(`${BATTLE_SELECT} WHERE b.id = $1`, [battle.id]);
    res.json({ success: true, data: { battle: decorateBattle(full.rows[0], userId) } });
  } catch (e: any) {
    console.error("battle accept error:", e?.message);
    res.status(500).json({ success: false, error: "Could not accept the battle" });
  }
});

router.post("/battles/:id/decline", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `UPDATE live_battles SET status = 'declined', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'pending' RETURNING host_a_id`,
      [req.params.id],
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, error: "Battle invite not found" });
    createNotification({ userId: r.rows[0].host_a_id, type: "social", title: "Battle declined", message: "Your battle invite was declined." }).catch(() => {});
    res.json({ success: true, data: { status: "declined" } });
  } catch {
    res.status(500).json({ success: false, error: "Could not decline the battle" });
  }
});

router.post("/battles/:id/cancel", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const r = await query(
      `UPDATE live_battles SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND host_a_id = $2 AND status = 'pending' RETURNING id`,
      [req.params.id, req.user!.userId],
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, error: "Battle invite not found" });
    res.json({ success: true, data: { status: "cancelled" } });
  } catch {
    res.status(500).json({ success: false, error: "Could not cancel the battle" });
  }
});

/** Battleable opponents — other LIVE hosts (powers the battle invite picker). */
router.get("/battles/opponents", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    await finalizeExpiredBattles();
    const rows = await query(
      `SELECT l.id AS session_id, l.call_code, l.title, l.category, l.current_viewers, l.started_at,
              u.id AS host_id, u.name AS host_name, u.avatar_url AS host_photo,
              EXISTS (SELECT 1 FROM live_battles b WHERE b.status IN ('pending','active')
                      AND (b.session_a_id = l.id OR b.session_b_id = l.id)) AS in_battle
         FROM live_sessions l JOIN users u ON u.id = l.host_id
        WHERE l.status = 'live' AND l.host_id <> $1
        ORDER BY l.current_viewers DESC LIMIT 30`,
      [req.user!.userId],
    );
    res.json({ success: true, data: { opponents: rows.rows } });
  } catch (e: any) {
    console.error("battle opponents error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load opponents" });
  }
});

// ---------------------------------------------------------------------------
// VIEWER RANKINGS — TikTok "Top viewers" + "Guardian" tabs.
//   Top viewers: ranked by cumulative watch time on this session.
//   Guardian:    ranked by gift value sent this session; #1 is the Guardian.
// ---------------------------------------------------------------------------
router.get("/:id/rankings", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });

    const topViewers = await query(
      `SELECT v.user_id, COALESCE(NULLIF(u.name, ''), u.email, 'Viewer') AS name, u.avatar_url AS photo,
              SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(v.left_at, NOW()), COALESCE($2::timestamptz, NOW())) - v.joined_at))))::int AS watch_seconds
         FROM live_viewers v LEFT JOIN users u ON u.id = v.user_id
        WHERE v.session_id = $1
        GROUP BY v.user_id, u.name, u.email, u.avatar_url
        ORDER BY watch_seconds DESC
        LIMIT 20`,
      [s.id, s.ended_at ?? null],
    );
    const topGifters = await query(
      `SELECT g.sender_id, COALESCE(NULLIF(u.name, ''), u.email, 'Viewer') AS name, u.avatar_url AS photo,
              SUM(g.total_amount)::float8 AS total_sent, COUNT(*)::int AS gift_count
         FROM live_gifts g LEFT JOIN users u ON u.id = g.sender_id
        WHERE g.session_id = $1 AND g.status = 'completed'
        GROUP BY g.sender_id, u.name, u.email, u.avatar_url
        ORDER BY total_sent DESC
        LIMIT 20`,
      [s.id],
    );
    res.json({
      success: true,
      data: {
        top_viewers: topViewers.rows.map((v: any) => ({ ...v, watch_seconds: Number(v.watch_seconds) || 0 })),
        top_gifters: topGifters.rows.map((g: any) => ({ ...g, total_sent: Number(g.total_sent) })),
        guardian: topGifters.rows[0]
          ? { ...topGifters.rows[0], total_sent: Number(topGifters.rows[0].total_sent) }
          : null,
      },
    });
  } catch (e: any) {
    console.error("rankings error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load rankings" });
  }
});

// ---------------------------------------------------------------------------
// VOD replay — the host client records the composed room (canvas video + mixed
// audio) and uploads the file here. Same storage chain as chat media
// (R2 → Cloudinary → local), so replays stream from permanent public URLs.
// ---------------------------------------------------------------------------
router.post("/:id/vod", authenticateToken, upload.fields([{ name: "video", maxCount: 1 }, { name: "poster", maxCount: 1 }]), async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (s.host_id !== req.user!.userId && !isCohost(s, req.user!.userId)) {
      return res.status(403).json({ success: false, error: "Only the host can save the replay" });
    }
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const videoFile = files?.video?.[0];
    if (!videoFile || !videoFile.buffer?.length) {
      return res.status(400).json({ success: false, error: "No recording attached" });
    }
    if (videoFile.size > 500 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: "Recording too large (max 500MB)" });
    }
    const durationSeconds = Math.max(0, Math.min(24 * 3600, Math.round(Number(req.body?.duration_seconds) || 0)));

    const stored = await uploadMediaBuffer({
      buffer: videoFile.buffer,
      originalname: videoFile.originalname || `vod-${s.call_code}.webm`,
      mimeType: videoFile.mimetype || "video/webm",
      folder: "live-vods",
      userId: req.user!.userId,
    });

    let posterUrl: string | null = null;
    const posterFile = files?.poster?.[0];
    if (posterFile?.buffer?.length) {
      const posterStored = await uploadMediaBuffer({
        buffer: posterFile.buffer,
        originalname: posterFile.originalname || `vod-${s.call_code}.jpg`,
        mimeType: posterFile.mimetype || "image/jpeg",
        folder: "live-vods",
        userId: req.user!.userId,
      }).catch(() => null);
      posterUrl = posterStored?.url || null;
    }

    const ins = await query(
      `INSERT INTO live_vods (session_id, host_id, url, poster_url, duration_seconds, size_bytes, mime_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [s.id, s.host_id, stored.url, posterUrl, durationSeconds, videoFile.size, stored.mimeType],
    );

    res.status(201).json({
      success: true,
      data: {
        vod: {
          id: ins.rows[0].id,
          url: stored.url,
          poster_url: posterUrl,
          duration_seconds: durationSeconds,
          view_count: 0,
          created_at: ins.rows[0].created_at,
        },
      },
    });
  } catch (e: any) {
    console.error("live vod upload error:", e?.message);
    res.status(500).json({ success: false, error: "Could not save the replay" });
  }
});

router.get("/:id/vod", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    const [vodR, clipR] = await Promise.all([
      query(
        `SELECT id, url, poster_url, duration_seconds, view_count, created_at
           FROM live_vods WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [s.id],
      ),
      query(
        `SELECT id, label, offset_seconds, created_by FROM live_clips WHERE session_id = $1 ORDER BY offset_seconds ASC LIMIT 100`,
        [s.id],
      ),
    ]);
    const vod = vodR.rows[0]
      ? {
          id: vodR.rows[0].id,
          url: vodR.rows[0].url,
          poster_url: vodR.rows[0].poster_url,
          duration_seconds: Number(vodR.rows[0].duration_seconds) || 0,
          view_count: Number(vodR.rows[0].view_count) || 0,
          created_at: vodR.rows[0].created_at,
        }
      : null;
    res.json({
      success: true,
      data: {
        vod,
        clips: clipR.rows.map((c: any) => ({ id: c.id, label: c.label, offset_seconds: Number(c.offset_seconds) || 0 })),
      },
    });
  } catch (e: any) {
    console.error("live vod fetch error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load the replay" });
  }
});

// ---------------------------------------------------------------------------
// Invite — push-notify Metricorex users with a deep link straight into the
// room. Any viewer can invite (TikTok share semantics); capped per request.
// ---------------------------------------------------------------------------
router.post("/:id/invite", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    if (s.status !== "live") return res.status(400).json({ success: false, error: "This stream is not live anymore" });

    const raw = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
    const selfId = req.user!.userId;
    const ids = Array.from(new Set(raw.map((x: any) => String(x || "").trim()).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)))).slice(0, 25);
    if (!ids.length) return res.status(400).json({ success: false, error: "Pick at least one person to invite" });

    // Only real users — silently skip deleted accounts, yourself, and the host
    // (the host is already here).
    const users = await query(
      `SELECT id, name FROM users WHERE id = ANY($1::uuid[]) AND id <> $2 AND id <> $3`,
      [ids, selfId, s.host_id],
    );
    const targets = users.rows.map((u: any) => ({ userId: u.id }));

    const senderName = req.user!.name || "Someone";
    const deepLink = `/live?join=${s.id}`;
    if (targets.length) {
      await sendPushToUsers(
        targets,
        {
          title: `${senderName} invited you to a live stream`,
          body: `${s.host_name || "A streamer"} is LIVE: ${String(s.title).slice(0, 80)}`,
          data: {
            type: "live_invite",
            url: deepLink,
            session_id: s.id,
            live_code: s.call_code,
            host: s.host_name || "",
            sender: senderName,
          },
        },
        { inApp: true, type: "live_invite" },
      );
    }

    res.status(201).json({
      success: true,
      data: { invited: targets.length, skipped: ids.length - targets.length },
    });
  } catch (e: any) {
    console.error("live invite error:", e?.message);
    res.status(500).json({ success: false, error: "Could not send the invites" });
  }
});

// ---------------------------------------------------------------------------
// STREAM LOG / DETAIL — the full activity record for a session. Powers the
// post-stream summary page (host) and the public stream recap (viewers).
// ---------------------------------------------------------------------------
router.get("/:id/detail", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    await finalizeExpiredBattles();
    const s = await sessionById(String(req.params.id));
    if (!s) return res.status(404).json({ success: false, error: "Stream not found" });
    const viewerId = req.user!.userId;
    const isHost = s.host_id === viewerId;

    const durationSeconds = Math.max(0, Math.round(
      ((s.ended_at ? new Date(s.ended_at).getTime() : Date.now()) - new Date(s.started_at).getTime()) / 1000,
    ));

    const [recent, topGifters, totals, viewers, reactions, chatCount, battleRows] = await Promise.all([
      query(
        `SELECT g.id, g.gift_id, g.gift_name, g.gift_icon, g.quantity, g.total_amount, g.created_at,
                COALESCE(NULLIF(u.name, ''), u.email, 'Someone') AS sender_name, u.avatar_url AS sender_photo
           FROM live_gifts g LEFT JOIN users u ON u.id = g.sender_id
          WHERE g.session_id = $1 AND g.status = 'completed'
          ORDER BY g.created_at DESC LIMIT 50`,
        [s.id],
      ),
      query(
        `SELECT g.sender_id, COALESCE(NULLIF(u.name, ''), u.email, 'Someone') AS name, u.avatar_url AS photo,
                SUM(g.total_amount)::float8 AS total_sent, COUNT(*)::int AS gift_count
           FROM live_gifts g LEFT JOIN users u ON u.id = g.sender_id
          WHERE g.session_id = $1 AND g.status = 'completed'
          GROUP BY g.sender_id, u.name, u.email, u.avatar_url
          ORDER BY total_sent DESC LIMIT 10`,
        [s.id],
      ),
      query(
        `SELECT COALESCE(SUM(total_amount), 0)::float8 AS gift_value,
                COALESCE(SUM(commission_amount), 0)::float8 AS commission,
                COALESCE(SUM(host_amount), 0)::float8 AS host_net,
                COUNT(*)::int AS gift_events
           FROM live_gifts WHERE session_id = $1 AND status = 'completed'`,
        [s.id],
      ),
      query(
        `SELECT COUNT(DISTINCT user_id)::int AS unique_viewers FROM live_viewers WHERE session_id = $1`,
        [s.id],
      ),
      query(`SELECT COUNT(*)::int AS c FROM live_reactions WHERE session_id = $1`, [s.id]),
      query(`SELECT COUNT(*)::int AS c FROM live_messages WHERE session_id = $1`, [s.id]),
      query(
        `${BATTLE_SELECT} WHERE b.session_a_id = $1 OR b.session_b_id = $1 ORDER BY b.created_at DESC LIMIT 5`,
        [s.id],
      ),
    ]);

    const t = totals.rows[0] || {};
    const battles = battleRows.rows.map((b: any) => decorateBattle(b, viewerId));

    res.json({
      success: true,
      data: {
        session: {
          id: s.id, title: s.title, description: s.description, category: s.category,
          call_code: s.call_code, status: s.status, started_at: s.started_at, ended_at: s.ended_at,
          duration_seconds: durationSeconds,
          peak_viewers: Number(s.peak_viewers) || 0, current_viewers: Number(s.current_viewers) || 0,
          total_views: Number(s.total_views) || 0, reaction_count: Number(s.reaction_count) || 0,
          gift_count: Number(s.gift_count) || 0,
        },
        host: { id: s.host_id, name: s.host_name, photo: s.host_photo },
        is_host: isHost,
        stats: {
          unique_viewers: Number(viewers.rows[0]?.unique_viewers) || 0,
          reaction_count: Number(reactions.rows[0]?.c) || 0,
          message_count: Number(chatCount.rows[0]?.c) || 0,
          gift_value: Number(t.gift_value) || 0,
          gift_events: Number(t.gift_events) || 0,
          // Money detail is host-only (platform commission is not public info).
          ...(isHost ? { commission: Number(t.commission) || 0, host_net: Number(t.host_net) || 0 } : {}),
        },
        gifts: recent.rows.map((g: any) => ({ ...g, total_amount: Number(g.total_amount) })),
        top_gifters: topGifters.rows.map((g: any) => ({ ...g, total_sent: Number(g.total_sent) })),
        battles,
      },
    });
  } catch (e: any) {
    console.error("live detail error:", e?.message);
    res.status(500).json({ success: false, error: "Could not load the stream detail" });
  }
});

export default router;
