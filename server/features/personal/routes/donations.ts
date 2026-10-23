import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  debitWallet, creditWallet, insertTransaction,
  verifyTransactionPin, assertPersonalService, requirePersonalKyc, genRef,
} from "../personal-utils";
import { creditRevenueWallet } from "../../../services/fees";
import { createNotification } from "../../../services/notifications";
import { uploadMediaBuffer } from "../../../services/media-upload";
import { upload } from "../../../middleware/upload";

/**
 * DONATIONS — fundraising campaigns for the Personal app.
 * Mounted at /donations (all routes require a session).
 *
 * A user creates a fundraiser (title, story, cover, goal, optional deadline).
 * Other users contribute ANY amount from their NGN wallet (PIN-verified,
 * KYC-gated — contributing means selecting/using a wallet). Anyone can browse
 * fundraisers, view details and the donor list, open donor profiles (follow /
 * chat happen on the profile page). The creator redeems the raised amount to
 * their NGN wallet — partial redemptions allowed — and the admin-configured
 * fees land in the platform revenue ledger (creditRevenueWallet).
 *
 * Endpoints:
 *   GET  /donations/settings                      → economics for the composer/donate UI
 *   GET  /donations?status=&category=&q=&mine=1   → browse fundraisers (+ creator info)
 *   POST /donations                               multipart(cover image) | JSON { title, description, cover_url?, category?, goal_amount, deadline? }
 *   GET  /donations/:id                           → detail (+ my_contribution, donors_count)
 *   PATCH /donations/:id                          (creator edits while active)
 *   POST /donations/:id/contribute                { amount, pin, message?, anonymous? }  [KYC]
 *   GET  /donations/:id/contributors              → donor list (anonymous masked)
 *   POST /donations/:id/redeem                    { amount?, pin }  (creator → NGN wallet)  [KYC]
 *   POST /donations/:id/end                       (creator closes early)
 *   GET  /donations/redemptions/mine              → creator's redemption history
 */

const router = express.Router();

// ---------------------------------------------------------------------------
// Economics (admin-managed via /admin/personal/donations/settings)
// ---------------------------------------------------------------------------
export interface DonationSettings {
  currency: string;
  min_donation: number;
  max_donation: number;
  contribution_fee_percent: number;
  contribution_fee_flat: number;
  redemption_fee_percent: number;
  redemption_fee_flat: number;
  redemption_min: number;
  max_active_per_user: number;
}

export const DEFAULT_DONATION_SETTINGS: DonationSettings = {
  currency: "NGN",
  min_donation: 100,
  max_donation: 5000000,
  contribution_fee_percent: 0,
  contribution_fee_flat: 0,
  redemption_fee_percent: 5,
  redemption_fee_flat: 0,
  redemption_min: 1000,
  max_active_per_user: 5,
};

export async function getDonationSettings(): Promise<DonationSettings> {
  try {
    const r = await query(`SELECT value FROM system_settings WHERE key = 'donation_settings' LIMIT 1`);
    if (r.rows[0]?.value) return { ...DEFAULT_DONATION_SETTINGS, ...JSON.parse(r.rows[0].value) };
  } catch { /* defaults */ }
  return DEFAULT_DONATION_SETTINGS;
}

export const DONATION_CATEGORIES = [
  "education", "medical", "emergency", "business", "community", "family", "faith", "other",
] as const;

const CATEGORIES = new Set<string>(DONATION_CATEGORIES);

/** Public shape for a fundraiser row (creator profile joined). */
const DONATION_SELECT = `
  SELECT d.*,
         u.name AS creator_name, u.avatar_url AS creator_avatar,
         LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS creator_username,
         (SELECT COUNT(*)::int FROM donation_contributions c
           WHERE c.donation_id = d.id AND c.status = 'success') AS donors_count
  FROM donations d
  JOIN users u ON u.id = d.creator_id
`;

function num(v: any): number { return Number(v) || 0; }

// ---------------------------------------------------------------------------
// Settings (for composer + donate dialog)
// ---------------------------------------------------------------------------
router.get("/settings", authenticateToken, async (_req: AuthenticatedRequest, res) => {
  try {
    const settings = await getDonationSettings();
    res.json({ success: true, data: { ...settings, categories: DONATION_CATEGORIES } });
  } catch (e: any) {
    console.error("[donations/settings]", e?.message);
    res.status(500).json({ success: false, error: "Could not load donation settings" });
  }
});

// ---------------------------------------------------------------------------
// Browse fundraisers
// ---------------------------------------------------------------------------
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "donations"))) return;
    const userId = req.user!.userId;
    const { status, category, q, mine } = req.query as Record<string, string | undefined>;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 24));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const params: any[] = [];
    const where: string[] = ["TRUE"];
    if (mine === "1") {
      params.push(userId); where.push(`d.creator_id = $${params.length}`);
    } else if (status && ["active", "ended", "suspended"].includes(status)) {
      params.push(status); where.push(`d.status = $${params.length}`);
    } else {
      // Default browse: active first, but creators still see their suspended
      // campaigns so they understand what happened to them.
      where.push(`(d.status = 'active' OR d.creator_id = $1)`);
      params.push(userId);
    }
    if (category && CATEGORIES.has(category)) {
      params.push(category); where.push(`d.category = $${params.length}`);
    }
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim().toLowerCase()}%`);
      where.push(`(LOWER(d.title) LIKE $${params.length} OR LOWER(d.description) LIKE $${params.length})`);
    }

    const rows = await query(
      `${DONATION_SELECT} WHERE ${where.join(" AND ")}
       ORDER BY CASE WHEN d.status = 'active' THEN 0 ELSE 1 END, d.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const totals = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_raised),0)::float AS raised
       FROM donations d WHERE ${where.join(" AND ")}`,
      params,
    );

    // Contributions by the viewer on this page (heart highlight + "You donated" chip)
    const ids = rows.rows.map((r) => r.id);
    let mineMap = new Map<string, { amount: number; times: number }>();
    if (ids.length) {
      const m = await query(
        `SELECT donation_id, COALESCE(SUM(amount),0)::float AS amount, COUNT(*)::int AS times
         FROM donation_contributions WHERE donor_id = $1 AND donation_id = ANY($2::uuid[]) AND status = 'success'
         GROUP BY donation_id`,
        [userId, ids],
      );
      for (const r of m.rows) mineMap.set(r.donation_id, { amount: num(r.amount), times: r.times });
    }

    res.json({
      success: true,
      data: {
        donations: rows.rows.map((d) => ({
          ...d,
          is_creator: d.creator_id === userId,
          my_contribution: mineMap.get(d.id) || null,
          progress: num(d.goal_amount) > 0 ? Math.min(100, Math.round((num(d.amount_raised) / num(d.goal_amount)) * 100)) : 0,
        })),
        total: totals.rows[0]?.n || 0,
        total_raised: totals.rows[0]?.raised || 0,
        categories: DONATION_CATEGORIES,
      },
    });
  } catch (e: any) {
    console.error("[donations/list]", e?.message);
    res.status(500).json({ success: false, error: "Could not load fundraisers" });
  }
});

// ---------------------------------------------------------------------------
// Create a fundraiser (multipart cover image accepted, same pipeline as posts)
// ---------------------------------------------------------------------------
router.post("/", authenticateToken, checkSubscriptionStatus, upload.single("cover"), async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "donations"))) return;
    const userId = req.user!.userId;
    const settings = await getDonationSettings();

    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    const category = CATEGORIES.has(String(req.body?.category)) ? String(req.body.category) : "other";
    const goal = Math.round(num(req.body?.goal_amount) * 100) / 100;
    const deadline = req.body?.deadline ? new Date(req.body.deadline) : null;

    const coverFile = (req as any).file as Express.Multer.File | undefined;
    let coverUrl: string | null = coverFile
      ? (await uploadMediaBuffer({ buffer: coverFile.buffer, originalname: coverFile.originalname, mimeType: coverFile.mimetype, folder: "donation-covers", userId }))?.url || null
      : (String(req.body?.cover_url || "").trim() || null);

    if (title.length < 6 || title.length > 160) {
      return res.status(400).json({ success: false, error: "Title must be between 6 and 160 characters" });
    }
    if (description.length < 30) {
      return res.status(400).json({ success: false, error: "Tell people your story — the description needs at least 30 characters" });
    }
    if (goal < 1000) {
      return res.status(400).json({ success: false, error: "Goal amount must be at least ₦1,000" });
    }
    if (goal > 1000000000) {
      return res.status(400).json({ success: false, error: "Goal amount is too large" });
    }
    if (deadline && (isNaN(deadline.getTime()) || deadline.getTime() < Date.now())) {
      return res.status(400).json({ success: false, error: "Deadline must be a future date" });
    }

    // Cap concurrent active fundraisers per creator (admin-configured).
    const active = await query(
      `SELECT COUNT(*)::int AS n FROM donations WHERE creator_id = $1 AND status = 'active'`,
      [userId],
    );
    if (active.rows[0].n >= (settings.max_active_per_user || 5)) {
      return res.status(400).json({
        success: false,
        code: "ACTIVE_LIMIT",
        error: `You can only run ${settings.max_active_per_user} active fundraisers at a time. End one before starting another.`,
      });
    }

    const created = await query(
      `INSERT INTO donations (creator_id, title, description, cover_url, category, goal_amount, currency, deadline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [userId, title, description, coverUrl, category, goal, settings.currency || "NGN", deadline],
    );
    const d = created.rows[0];
    res.json({ success: true, data: { donation: d, message: "Fundraiser created — share it to start raising" } });
  } catch (e: any) {
    console.error("[donations/create]", e?.message);
    res.status(500).json({ success: false, error: "Could not create fundraiser" });
  }
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
router.get("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const rows = await query(`${DONATION_SELECT} WHERE d.id = $1`, [req.params.id]);
    if (!rows.rows.length) return res.status(404).json({ success: false, error: "Fundraiser not found" });
    const d = rows.rows[0];

    const mine = await query(
      `SELECT COALESCE(SUM(amount),0)::float AS amount, COUNT(*)::int AS times
       FROM donation_contributions WHERE donation_id = $1 AND donor_id = $2 AND status = 'success'`,
      [d.id, userId],
    );
    const redemptions = await query(
      `SELECT id, amount, fee, net_amount, reference, status, created_at
       FROM donation_redemptions WHERE donation_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [d.id],
    );

    res.json({
      success: true,
      data: {
        donation: {
          ...d,
          progress: num(d.goal_amount) > 0 ? Math.min(100, Math.round((num(d.amount_raised) / num(d.goal_amount)) * 100)) : 0,
          my_contribution: { amount: num(mine.rows[0]?.amount), times: mine.rows[0]?.times || 0 },
          is_creator: d.creator_id === userId,
        },
        redemptions: redemptions.rows,
      },
    });
  } catch (e: any) {
    console.error("[donations/detail]", e?.message);
    res.status(500).json({ success: false, error: "Could not load fundraiser" });
  }
});

// ---------------------------------------------------------------------------
// Creator edit (while active)
// ---------------------------------------------------------------------------
router.patch("/:id", authenticateToken, upload.single("cover"), async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const d = await query(`SELECT id, creator_id, status FROM donations WHERE id = $1`, [req.params.id]);
    if (!d.rows.length) return res.status(404).json({ success: false, error: "Fundraiser not found" });
    if (d.rows[0].creator_id !== userId) return res.status(403).json({ success: false, error: "Only the creator can edit this fundraiser" });
    if (d.rows[0].status !== "active") return res.status(400).json({ success: false, error: "Only active fundraisers can be edited" });

    const title = req.body?.title !== undefined ? String(req.body.title).trim() : undefined;
    const description = req.body?.description !== undefined ? String(req.body.description).trim() : undefined;
    const category = req.body?.category !== undefined ? (CATEGORIES.has(String(req.body.category)) ? String(req.body.category) : "other") : undefined;
    const deadline = req.body?.deadline !== undefined ? (req.body.deadline ? new Date(req.body.deadline) : null) : undefined;

    const coverFile = (req as any).file as Express.Multer.File | undefined;
    const coverUrl = coverFile
      ? (await uploadMediaBuffer({ buffer: coverFile.buffer, originalname: coverFile.originalname, mimeType: coverFile.mimetype, folder: "donation-covers", userId }))?.url || null
      : req.body?.cover_url !== undefined ? String(req.body.cover_url).trim() || null : undefined;

    if (title !== undefined && (title.length < 6 || title.length > 160)) {
      return res.status(400).json({ success: false, error: "Title must be between 6 and 160 characters" });
    }
    if (description !== undefined && description.length < 30) {
      return res.status(400).json({ success: false, error: "The description needs at least 30 characters" });
    }
    if (deadline instanceof Date && isNaN(deadline.getTime())) {
      return res.status(400).json({ success: false, error: "Deadline must be a valid date" });
    }

    const upd = await query(
      `UPDATE donations SET
         title = COALESCE($2, title),
         description = COALESCE($3, description),
         cover_url = COALESCE($4, cover_url),
         category = COALESCE($5, category),
         deadline = COALESCE($6, deadline),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [d.rows[0].id, title ?? null, description ?? null, coverUrl ?? null, category ?? null,
       deadline === undefined ? null : deadline],
    );
    res.json({ success: true, data: { donation: upd.rows[0] } });
  } catch (e: any) {
    console.error("[donations/edit]", e?.message);
    res.status(500).json({ success: false, error: "Could not update fundraiser" });
  }
});

// ---------------------------------------------------------------------------
// Contribute — donor pays from their NGN wallet (KYC + PIN verified)
// ---------------------------------------------------------------------------
router.post("/:id/contribute", authenticateToken, requirePersonalKyc(), async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "donations"))) return;
    const userId = req.user!.userId;
    const settings = await getDonationSettings();

    const rows = await query(`${DONATION_SELECT} WHERE d.id = $1`, [req.params.id]);
    if (!rows.rows.length) return res.status(404).json({ success: false, error: "Fundraiser not found" });
    const d = rows.rows[0];
    if (d.creator_id === userId) {
      return res.status(400).json({ success: false, error: "You cannot donate to your own fundraiser", code: "SELF_DONATION" });
    }
    if (d.status !== "active") {
      return res.status(400).json({ success: false, error: "This fundraiser is no longer accepting donations", code: "NOT_ACTIVE" });
    }
    if (d.deadline && new Date(d.deadline) < new Date()) {
      return res.status(400).json({ success: false, error: "This fundraiser has passed its deadline", code: "DEADLINE_PASSED" });
    }

    const amount = Math.round(num(req.body?.amount) * 100) / 100;
    if (amount < (settings.min_donation || 100)) {
      return res.status(400).json({ success: false, code: "BELOW_MIN", error: `Minimum donation is ₦${(settings.min_donation || 100).toLocaleString()}` });
    }
    if (settings.max_donation && amount > settings.max_donation) {
      return res.status(400).json({ success: false, code: "ABOVE_MAX", error: `Maximum donation is ₦${Number(settings.max_donation).toLocaleString()}` });
    }

    const pinCheck = await verifyTransactionPin(req.body?.pin, { userId });
    if (!pinCheck.ok) return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });

    const message = String(req.body?.message || "").trim().slice(0, 280) || null;
    const anonymous = !!req.body?.anonymous;

    const w = await query(
      `SELECT id, balance FROM wallets WHERE user_id = $1 AND UPPER(currency) = 'NGN' AND status = 'active' LIMIT 1`,
      [userId],
    );
    if (!w.rows.length) return res.status(400).json({ success: false, error: "You need an active NGN wallet to donate", code: "NO_WALLET" });
    if (num(w.rows[0].balance) < amount) {
      return res.status(400).json({ success: false, error: "Insufficient NGN wallet balance", code: "INSUFFICIENT_BALANCE" });
    }

    // Contribution fee (admin-configured; default 0 — donors give in full).
    const fee = Math.round((amount * (num(settings.contribution_fee_percent) / 100) + num(settings.contribution_fee_flat)) * 100) / 100;
    const net = Math.max(0, Math.round((amount - fee) * 100) / 100);

    if (!(await debitWallet(w.rows[0].id, amount))) {
      return res.status(400).json({ success: false, error: "Insufficient NGN wallet balance", code: "INSUFFICIENT_BALANCE" });
    }

    const reference = genRef("MF-DN");
    try {
      await query(
        `UPDATE donations SET amount_raised = amount_raised + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [d.id, net],
      );
      await query(
        `INSERT INTO donation_contributions (donation_id, donor_id, amount, fee, net_amount, currency, reference, message, anonymous)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [d.id, userId, amount, fee, net, d.currency || "NGN", reference, message, anonymous],
      );
    } catch (cErr: any) {
      // Never take money without recording the contribution.
      await creditWallet(w.rows[0].id, amount).catch(() => {});
      throw cErr;
    }
    if (fee > 0) {
      await creditRevenueWallet(fee, "NGN", reference, `Donation contribution fee — “${String(d.title).slice(0, 50)}”`, null, undefined, { revenueType: "fee" }).catch(() => {});
    }

    await insertTransaction({
      userId, walletId: w.rows[0].id, reference, type: "debit",
      transactionType: "donation", amount, currency: "NGN", fee,
      description: `Donation — “${String(d.title).slice(0, 60)}”`,
    });

    createNotification({
      businessId: (req.user!.businessId ?? "") as string,
      userId: d.creator_id,
      title: "New donation received",
      message: `${anonymous ? "Someone" : "A supporter"} donated ₦${net.toLocaleString()} to “${String(d.title).slice(0, 40)}”${message ? `: “${message.slice(0, 60)}”` : ""}`,
      type: "donation",
    }).catch(() => {});

    const updated = await query(`SELECT amount_raised, donors_count FROM donations WHERE id = $1`, [d.id]);
    const donors = await query(
      `SELECT COUNT(*)::int AS n FROM donation_contributions WHERE donation_id = $1 AND status = 'success'`,
      [d.id],
    );

    res.json({
      success: true,
      data: {
        contribution: { reference, amount, fee, net_amount: net, anonymous, message },
        donation: {
          amount_raised: num(updated.rows[0]?.amount_raised),
          progress: num(d.goal_amount) > 0 ? Math.min(100, Math.round((num(updated.rows[0]?.amount_raised) / num(d.goal_amount)) * 100)) : 0,
          donors_count: donors.rows[0]?.n || 0,
        },
        message: `You donated ₦${amount.toLocaleString()} to “${String(d.title).slice(0, 40)}”. Thank you!`,
      },
    });
  } catch (e: any) {
    console.error("[donations/contribute]", e?.message);
    res.status(500).json({ success: false, error: "Could not process donation" });
  }
});

// ---------------------------------------------------------------------------
// Donor list (anonymous donors masked; profiles open on the Personal app)
// ---------------------------------------------------------------------------
router.get("/:id/contributors", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = await query(
      `SELECT c.id, c.amount, c.currency, c.message, c.anonymous, c.created_at, c.donor_id,
              CASE WHEN c.anonymous THEN NULL ELSE u.id END AS user_id,
              CASE WHEN c.anonymous THEN 'Anonymous donor' ELSE u.name END AS donor_name,
              CASE WHEN c.anonymous THEN NULL ELSE u.avatar_url END AS donor_avatar,
              CASE WHEN c.anonymous THEN NULL
                   ELSE LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) END AS donor_username
       FROM donation_contributions c
       JOIN users u ON u.id = c.donor_id
       WHERE c.donation_id = $1 AND c.status = 'success'
       ORDER BY c.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [req.params.id],
    );
    const stats = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS total
       FROM donation_contributions WHERE donation_id = $1 AND status = 'success'`,
      [req.params.id],
    );
    res.json({
      success: true,
      data: {
        contributors: rows.rows,
        total: stats.rows[0]?.n || 0,
        total_amount: stats.rows[0]?.total || 0,
      },
    });
  } catch (e: any) {
    console.error("[donations/contributors]", e?.message);
    res.status(500).json({ success: false, error: "Could not load donors" });
  }
});

// ---------------------------------------------------------------------------
// Redeem — creator moves the raised pool to their NGN wallet (KYC + PIN)
// ---------------------------------------------------------------------------
router.post("/:id/redeem", authenticateToken, requirePersonalKyc(), async (req: AuthenticatedRequest, res) => {
  const userId = req.user!.userId;
  try {
    const settings = await getDonationSettings();
    const rows = await query(
      `SELECT id, creator_id, title, status, amount_raised, amount_redeemed, currency
       FROM donations WHERE id = $1`,
      [req.params.id],
    );
    if (!rows.rows.length) return res.status(404).json({ success: false, error: "Fundraiser not found" });
    const d = rows.rows[0];
    if (d.creator_id !== userId) return res.status(403).json({ success: false, error: "Only the creator can redeem donations" });
    if (d.status === "suspended") return res.status(400).json({ success: false, error: "This fundraiser was suspended — contact support", code: "SUSPENDED" });

    const available = Math.max(0, Math.round((num(d.amount_raised) - num(d.amount_redeemed)) * 100) / 100);
    const target = Math.round(num(req.body?.amount) * 100) / 100;
    const redeemAmount = target > 0 ? target : available;
    if (redeemAmount <= 0) {
      return res.status(400).json({ success: false, error: "Nothing to redeem yet — this fundraiser has no donations", code: "EMPTY_POOL" });
    }
    if (redeemAmount > available) {
      return res.status(400).json({ success: false, error: `Only ₦${available.toLocaleString()} is available to redeem`, code: "AMOUNT_EXCEEDS" });
    }
    if (redeemAmount < (settings.redemption_min || 0)) {
      return res.status(400).json({
        success: false, code: "BELOW_MIN",
        error: `Minimum redemption is ₦${Number(settings.redemption_min || 0).toLocaleString()} (available ₦${available.toLocaleString()})`,
      });
    }

    const pinCheck = await verifyTransactionPin(req.body?.pin, { userId });
    if (!pinCheck.ok) return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });

    // Atomic guard: only redeem what the pool actually still holds.
    const upd = await query(
      `UPDATE donations SET amount_redeemed = amount_redeemed + $2, redeemed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND (amount_raised - amount_redeemed) >= $2
       RETURNING amount_raised, amount_redeemed`,
      [d.id, redeemAmount],
    );
    if (!upd.rows.length) {
      return res.status(400).json({ success: false, error: "Pool changed — please retry", code: "POOL_RACE" });
    }

    const fee = Math.round((redeemAmount * (num(settings.redemption_fee_percent) / 100) + num(settings.redemption_fee_flat)) * 100) / 100;
    const net = Math.max(0, Math.round((redeemAmount - fee) * 100) / 100);
    const reference = genRef("MFDR");

    try {
      if (fee > 0) {
        await creditRevenueWallet(fee, "NGN", reference, `Donation redemption fee — “${String(d.title).slice(0, 50)}”`, null, undefined, { revenueType: "fee" });
      }
      const w = await query(
        `SELECT id FROM wallets WHERE user_id = $1 AND UPPER(currency) = 'NGN' AND status = 'active' LIMIT 1`,
        [userId],
      );
      if (!w.rows.length) throw new Error("NO_NGN_WALLET");
      await creditWallet(w.rows[0].id, net);
      await insertTransaction({
        userId, walletId: w.rows[0].id, reference, type: "credit",
        transactionType: "donation_redemption", amount: net, currency: "NGN", fee,
        description: `Donation redemption${fee > 0 ? ` (fee ₦${fee.toLocaleString()})` : ""} — “${String(d.title).slice(0, 50)}”`,
      });
      const rd = await query(
        `INSERT INTO donation_redemptions (donation_id, user_id, amount, fee, net_amount, reference)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
        [d.id, userId, redeemAmount, fee, net, reference],
      );
      return res.json({
        success: true,
        data: {
          redemption: { id: rd.rows[0].id, amount: redeemAmount, fee, net_amount: net, reference, created_at: rd.rows[0].created_at },
          donation: { raised: upd.rows[0].amount_raised, redeemed: upd.rows[0].amount_redeemed },
          message: `₦${net.toLocaleString()} sent to your NGN wallet${fee > 0 ? ` (fee ₦${fee.toLocaleString()})` : ""}`,
        },
      });
    } catch (finErr: any) {
      // Roll the pool back — money must never leave the pool without a payout.
      await query(
        `UPDATE donations SET amount_redeemed = GREATEST(0, amount_redeemed - $2), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [d.id, redeemAmount],
      ).catch(() => {});
      console.error("[donations/redeem] payout failure:", finErr?.message);
      return res.status(500).json({ success: false, error: "Could not complete redemption — please try again" });
    }
  } catch (e: any) {
    console.error("[donations/redeem]", e?.message);
    res.status(500).json({ success: false, error: "Could not redeem donations" });
  }
});

// ---------------------------------------------------------------------------
// Creator ends the fundraiser early
// ---------------------------------------------------------------------------
router.post("/:id/end", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const d = await query(`SELECT id, creator_id, status FROM donations WHERE id = $1`, [req.params.id]);
    if (!d.rows.length) return res.status(404).json({ success: false, error: "Fundraiser not found" });
    if (d.rows[0].creator_id !== userId) return res.status(403).json({ success: false, error: "Only the creator can end this fundraiser" });
    if (d.rows[0].status !== "active") return res.status(400).json({ success: false, error: "This fundraiser is not active" });
    await query(`UPDATE donations SET status = 'ended', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [d.rows[0].id]);
    res.json({ success: true, data: { message: "Fundraiser ended — you can still redeem the raised amount" } });
  } catch (e: any) {
    console.error("[donations/end]", e?.message);
    res.status(500).json({ success: false, error: "Could not end fundraiser" });
  }
});

// ---------------------------------------------------------------------------
// Creator's redemption history
// ---------------------------------------------------------------------------
router.get("/redemptions/mine", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const rows = await query(
      `SELECT r.*, d.title AS donation_title
       FROM donation_redemptions r JOIN donations d ON d.id = r.donation_id
       WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
      [userId],
    );
    res.json({ success: true, data: { redemptions: rows.rows } });
  } catch (e: any) {
    console.error("[donations/redemptions/mine]", e?.message);
    res.status(500).json({ success: false, error: "Could not load redemptions" });
  }
});

export default router;
