import express from "express";
import { randomBytes } from "crypto";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import { insertTransaction, creditWallet } from "../personal-utils";
import { createNotification } from "../../../services/notifications";

/**
 * SPLIT BILLS — divide an expense across contacts (mounted at /splits,
 * personal users only).
 *
 * The creator lists participants (optionally with explicit shares — omitted
 * shares are split evenly with the last participant absorbing the kobo
 * remainder). Every participant pays their own share from their own NGN
 * wallet — NO transaction PIN for v1 (social micro-payments). The creator
 * sees who has paid; when every non-declined participant has paid, the split
 * settles. All amounts are NGN; every payment is idempotent by its unique
 * paid_reference.
 *
 * Endpoints:
 *   POST /splits                  → create a split + invite participants
 *   GET  /splits/mine             → created by me (+ status counts) + participating
 *   GET  /splits/:id              → detail (creator or participant only)
 *   POST /splits/:id/pay          → pay my share (participant, pending)
 *   POST /splits/:id/decline      → decline my share (participant, pending)
 *   POST /splits/:id/remind       → creator nudges pending participants (1 per 6h)
 */

const router = express.Router();

function num(v: any): number { return Number(v) || 0; }
function money(v: number): number { return Math.round(v * 100) / 100; }

// Contexts: the API's own direct/group/page PLUS the labels the web
// SplitPots composer sends (dinner/trip/gift/rent/other). Unknown values
// still fall back to "direct" — but a web-created "dinner" split no longer
// comes back mangled, so its context chip renders correctly.
const CONTEXTS = new Set(["direct", "group", "page", "dinner", "trip", "gift", "rent", "other"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SPLIT_BASE = `
  SELECT s.*, u.name AS creator_name, u.avatar_url AS creator_avatar,
         LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS creator_username
  FROM splits s JOIN users u ON u.id = s.creator_id
`;

const PARTICIPANT_BASE = `
  SELECT p.id, p.split_id, p.user_id, p.share_amount, p.status, p.paid_at, p.created_at,
         u.name AS display_name, u.avatar_url, LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS username
  FROM split_participants p JOIN users u ON u.id = p.user_id
`;

function serializeSplit(s: any) {
  if (!s) return s;
  return {
    ...s,
    total_amount: num(s.total_amount),
  };
}

function serializeParticipant(p: any) {
  if (!p) return p;
  return { ...p, share_amount: num(p.share_amount) };
}

/** Compute per-participant shares (kobo-exact). */
function computeShares(
  total: number,
  participants: Array<{ user_id: string; share_amount?: number | null }>,
): { shares: number[]; error?: string } {
  const n = participants.length;
  const totalKobo = Math.round(total * 100);
  const anyProvided = participants.some((p) => p.share_amount !== undefined && p.share_amount !== null);

  if (!anyProvided) {
    // Even split — the LAST participant absorbs the kobo remainder.
    const baseKobo = Math.floor(totalKobo / n);
    const lastKobo = totalKobo - baseKobo * (n - 1);
    return { shares: participants.map((_, i) => (i === n - 1 ? lastKobo : baseKobo) / 100) };
  }

  // Mixed / fully-explicit mode: omitted shares evenly divide what's left.
  let providedKobo = 0;
  const omittedIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    const raw = participants[i].share_amount;
    if (raw === undefined || raw === null) {
      omittedIdx.push(i);
    } else {
      const k = Math.round(Number(raw) * 100);
      if (!(k > 0)) return { shares: [], error: "share_amount must be a positive amount" };
      providedKobo += k;
    }
  }
  if (providedKobo > totalKobo) {
    return { shares: [], error: "The shares add up to more than the split total" };
  }
  if (omittedIdx.length === 0 && providedKobo !== totalKobo) {
    return { shares: [], error: "The shares must add up to the split total exactly" };
  }
  const remainingKobo = totalKobo - providedKobo;
  const shares = new Array<number>(n).fill(0);
  if (omittedIdx.length > 0) {
    const baseKobo = Math.floor(remainingKobo / omittedIdx.length);
    omittedIdx.forEach((idx, i) => {
      shares[idx] = (i === omittedIdx.length - 1 ? remainingKobo - baseKobo * (omittedIdx.length - 1) : baseKobo) / 100;
    });
  }
  return { shares };
}

/** True when every non-declined participant has paid (split can settle). */
async function evaluateSettled(splitId: string): Promise<boolean> {
  const r = await query(
    `SELECT COUNT(*) FILTER (WHERE status <> 'declined')::int AS actionable,
            COUNT(*) FILTER (WHERE status = 'paid')::int AS paid
       FROM split_participants WHERE split_id = $1`,
    [splitId],
  );
  const { actionable, paid } = r.rows[0] || {};
  return actionable > 0 && paid === actionable;
}

async function loadSplit(id: string) {
  const r = await query(`${SPLIT_BASE} WHERE s.id = $1 LIMIT 1`, [id]);
  return r.rows[0] || null;
}

async function loadParticipants(splitId: string) {
  const r = await query(`${PARTICIPANT_BASE} WHERE p.split_id = $1 ORDER BY p.created_at ASC`, [splitId]);
  return r.rows.map(serializeParticipant);
}

// ---------------------------------------------------------------------------
// Create a split
// ---------------------------------------------------------------------------
router.post("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim().slice(0, 500) || null;
    const total = money(num(req.body?.total_amount));
    const context = CONTEXTS.has(String(req.body?.context)) ? String(req.body.context) : "direct";
    const contextId = req.body?.context_id ? String(req.body.context_id) : null;

    if (title.length < 3 || title.length > 140) {
      return res.status(400).json({ success: false, error: "Title must be between 3 and 140 characters" });
    }
    if (!(total > 0)) {
      return res.status(400).json({ success: false, error: "total_amount must be greater than 0" });
    }

    const rawParticipants = Array.isArray(req.body?.participants) ? req.body.participants : null;
    if (!rawParticipants || rawParticipants.length === 0) {
      return res.status(400).json({ success: false, error: "At least one participant is required" });
    }
    if (rawParticipants.length > 50) {
      return res.status(400).json({ success: false, error: "A split can have at most 50 participants" });
    }

    // Dedupe by user_id (keep the first share given) + validate shape.
    const seen = new Set<string>();
    const participants: Array<{ user_id: string; share_amount?: number | null }> = [];
    for (const p of rawParticipants) {
      const pid = String(p?.user_id || "").trim();
      if (!UUID_RE.test(pid)) {
        return res.status(400).json({ success: false, error: "Each participant needs a valid user_id" });
      }
      if (seen.has(pid)) continue;
      seen.add(pid);
      participants.push({
        user_id: pid,
        share_amount: p?.share_amount !== undefined && p?.share_amount !== null ? Number(p.share_amount) : null,
      });
    }

    // Users must exist.
    const found = await query(
      `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
      [participants.map((p) => p.user_id)],
    );
    if (found.rows.length !== participants.length) {
      return res.status(400).json({ success: false, error: "One or more participants were not found" });
    }

    // Shares.
    const { shares, error } = computeShares(total, participants);
    if (error) return res.status(400).json({ success: false, error });

    const shareToken = randomBytes(24).toString("hex"); // 48 chars ≤ VARCHAR(64)
    const created = await query(
      `INSERT INTO splits (creator_id, title, description, total_amount, currency, status, context, context_id, share_token)
       VALUES ($1,$2,$3,$4,'NGN','pending',$5,$6,$7) RETURNING *`,
      [userId, title, description, total, context, contextId, shareToken],
    );
    const split = created.rows[0];

    const inserted = await query(
      `INSERT INTO split_participants (split_id, user_id, share_amount, status)
       SELECT $1, x.uid, x.share, 'pending'
       FROM UNNEST($2::uuid[], $3::numeric[]) AS x(uid, share)
       ON CONFLICT (split_id, user_id) DO NOTHING
       RETURNING id`,
      [split.id, participants.map((p) => p.user_id), shares],
    );
    if (inserted.rows.length !== participants.length) {
      // Should be impossible after dedupe — refuse to leave a broken split.
      await query(`DELETE FROM splits WHERE id = $1`, [split.id]);
      return res.status(500).json({ success: false, error: "Could not create the split — please retry" });
    }

    // Invite notifications (skip the creator themself).
    const creatorRow = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
    const creatorName = creatorRow.rows[0]?.name || "Someone";
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.user_id === userId) continue;
      createNotification({
        businessId: null,
        userId: p.user_id,
        type: "split_invite",
        title: "Split request",
        message: `${creatorName} asked you to pay ₦${shares[i].toLocaleString()} for "${title.slice(0, 60)}"`,
        actionUrl: "/splits",
        actionType: "view_split",
        metadata: { splitId: split.id, share: shares[i] },
      }).catch(() => {});
    }

    res.status(201).json({
      success: true,
      split: serializeSplit({ ...split, participants: await loadParticipants(split.id) }),
    });
  } catch (e: any) {
    console.error("[splits/create]", e?.message);
    res.status(500).json({ success: false, error: "Could not create the split" });
  }
});

// ---------------------------------------------------------------------------
// Mine (created + participating) — declared BEFORE /:id
// ---------------------------------------------------------------------------
router.get("/mine", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;

    const created = await query(
      `${SPLIT_BASE}
        WHERE s.creator_id = $1
        ORDER BY s.created_at DESC LIMIT 100`,
      [userId],
    );
    const ids = created.rows.map((r: any) => r.id);
    const countMap = new Map<string, any>();
    if (ids.length) {
      const counts = await query(
        `SELECT split_id,
                COUNT(*)::int AS participants_count,
                COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
                COUNT(*) FILTER (WHERE status = 'declined')::int AS declined_count,
                COALESCE(SUM(share_amount) FILTER (WHERE status = 'paid'), 0)::float AS paid_amount
           FROM split_participants WHERE split_id = ANY($1::uuid[]) GROUP BY split_id`,
        [ids],
      );
      for (const r of counts.rows) countMap.set(r.split_id, r);
    }

    const participating = await query(
      `SELECT s.id, s.creator_id, s.title, s.description, s.total_amount, s.currency, s.status AS split_status,
              s.created_at, pu.name AS creator_name, pu.avatar_url AS creator_avatar,
              p.share_amount, p.status AS my_status, p.paid_at
         FROM split_participants p
         JOIN splits s ON s.id = p.split_id
         JOIN users pu ON pu.id = s.creator_id
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC LIMIT 100`,
      [userId],
    );

    res.json({
      success: true,
      splits: created.rows.map((r: any) => serializeSplit({
        ...r,
        participants_count: countMap.get(r.id)?.participants_count || 0,
        status_counts: {
          paid: countMap.get(r.id)?.paid_count || 0,
          pending: countMap.get(r.id)?.pending_count || 0,
          declined: countMap.get(r.id)?.declined_count || 0,
        },
        paid_amount: countMap.get(r.id)?.paid_amount || 0,
      })),
      participating: participating.rows.map((r: any) => ({
        ...serializeSplit(r),
        my_share_amount: num(r.share_amount),
        // `my_share` — the key the web SplitPots page renders for "your share".
        my_share: num(r.share_amount),
        my_status: r.my_status,
        paid_at: r.paid_at,
      })),
    });
  } catch (e: any) {
    console.error("[splits/mine]", e?.message);
    res.status(500).json({ success: false, error: "Could not load your splits" });
  }
});

// ---------------------------------------------------------------------------
// Detail (creator or participant only)
// ---------------------------------------------------------------------------
router.get("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    // Guard the ::uuid cast — a malformed id must 404, not 500 (22P02).
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ success: false, error: "Split not found" });
    }
    const split = await loadSplit(String(req.params.id));
    if (!split) return res.status(404).json({ success: false, error: "Split not found" });

    const membership = await query(
      `SELECT 1 FROM split_participants WHERE split_id = $1 AND user_id = $2 LIMIT 1`,
      [split.id, userId],
    );
    if (split.creator_id !== userId && !membership.rows.length) {
      return res.status(403).json({ success: false, error: "You do not have access to this split" });
    }

    res.json({
      success: true,
      split: serializeSplit(split),
      participants: await loadParticipants(split.id),
    });
  } catch (e: any) {
    console.error("[splits/detail]", e?.message);
    res.status(500).json({ success: false, error: "Could not load the split" });
  }
});

// ---------------------------------------------------------------------------
// Pay my share — balance-guarded wallet debit, idempotent by paid_reference
// ---------------------------------------------------------------------------
router.post("/:id/pay", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    // Guard the ::uuid cast — a malformed id must 404, not 500 (22P02).
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ success: false, error: "Split not found" });
    }
    const split = await loadSplit(String(req.params.id));
    if (!split) return res.status(404).json({ success: false, error: "Split not found" });
    if (split.status !== "pending") {
      return res.status(400).json({ success: false, code: "NOT_PENDING", error: "This split is no longer open" });
    }

    const pRes = await query(
      `SELECT * FROM split_participants WHERE split_id = $1 AND user_id = $2 LIMIT 1`,
      [split.id, userId],
    );
    const participant = pRes.rows[0];
    if (!participant) return res.status(403).json({ success: false, error: "You are not a participant of this split" });
    if (participant.status === "paid") {
      return res.status(400).json({ success: false, code: "ALREADY_PAID", error: "You have already paid your share" });
    }
    if (participant.status === "declined") {
      return res.status(400).json({ success: false, code: "DECLINED", error: "You declined this split request" });
    }

    const share = money(num(participant.share_amount));

    // Claim the participant row FIRST (guarded) — a concurrent double-pay
    // loses this claim instead of double-debiting the wallet.
    const paidReference = `SPL-PAY-${split.id}-${userId}-${Date.now()}`.slice(0, 255);
    const claim = await query(
      `UPDATE split_participants
          SET status = 'paid', paid_at = CURRENT_TIMESTAMP, paid_reference = $2
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [participant.id, paidReference],
    );
    if (!claim.rows.length) {
      return res.status(409).json({ success: false, code: "ALREADY_SETTLED", error: "Your share was already taken care of" });
    }

    // Money block: wallet lookup → guarded debit → ledger row. Any failure
    // here refunds the debit and releases the claim so the user can retry.
    let walletId: string | null = null;
    let debited = 0;
    try {
      if (share > 0) {
        const w = await query(
          `SELECT id FROM wallets
            WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active'
            ORDER BY created_at ASC LIMIT 1`,
          [userId],
        );
        const wallet = w.rows[0];
        if (!wallet) {
          throw Object.assign(new Error("You need an active NGN wallet to pay your share"), { statusCode: 400 });
        }
        const debit = await query(
          `UPDATE wallets SET balance = balance - $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND balance >= $2 AND status = 'active' RETURNING id`,
          [wallet.id, share],
        );
        if (!debit.rows.length) {
          throw Object.assign(new Error("Insufficient NGN wallet balance"), { statusCode: 400, code: "INSUFFICIENT_BALANCE" });
        }
        walletId = wallet.id;
        debited = share;
        await insertTransaction({
          userId,
          walletId: wallet.id,
          reference: paidReference,
          type: "debit",
          transactionType: "split_payment",
          amount: share,
          currency: "NGN",
          description: `Split payment — ${String(split.title).slice(0, 60)}`,
        });
      }
    } catch (moneyErr: any) {
      // Never take money without recording the payment — refund the debit.
      if (debited > 0 && walletId) {
        await creditWallet(walletId, debited).catch((rErr: any) =>
          console.error("[splits/pay] CRITICAL: wallet refund failed:", rErr?.message));
      }
      // Release the claim so the user can retry.
      await query(
        `UPDATE split_participants SET status = 'pending', paid_at = NULL, paid_reference = NULL
          WHERE id = $1 AND paid_reference = $2`,
        [participant.id, paidReference],
      ).catch(() => {});
      if (moneyErr?.statusCode === 400) {
        return res.status(400).json({ success: false, code: moneyErr?.code, error: moneyErr.message });
      }
      throw moneyErr;
    }

    // The payment is committed from here on — failures below answer 500 but
    // never touch the claim again.

    // Settle the split when every non-declined participant has paid.
    const settled = await evaluateSettled(split.id);
    if (settled) {
      await query(
        `UPDATE splits SET status = 'settled', settled_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'pending'`,
        [split.id],
      );
    }

    // Notify the creator (payer name resolved like every other personal route).
    const me = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
    const payerName = me.rows[0]?.name || "Someone";
    createNotification({
      businessId: null,
      userId: split.creator_id,
      type: settled ? "split_settled" : "split_paid",
      title: settled ? "Split settled" : "Split payment received",
      message: settled
        ? `Everyone has paid "${String(split.title).slice(0, 60)}" — ${payerName}'s ₦${share.toLocaleString()} just landed.`
        : `${payerName} paid ₦${share.toLocaleString()} toward "${String(split.title).slice(0, 60)}"`,
      actionUrl: "/splits",
      actionType: "view_split",
      metadata: { splitId: split.id, payerId: userId, amount: share },
    }).catch(() => {});

    const freshSplit = await loadSplit(split.id);
    const freshParticipant = await query(`${PARTICIPANT_BASE} WHERE p.id = $1`, [participant.id]);

    return res.json({
      success: true,
      split: serializeSplit(freshSplit),
      participant: serializeParticipant(freshParticipant.rows[0]),
    });
  } catch (e: any) {
    console.error("[splits/pay]", e?.message);
    res.status(500).json({ success: false, error: "Could not pay your share" });
  }
});

// ---------------------------------------------------------------------------
// Decline my share
// ---------------------------------------------------------------------------
router.post("/:id/decline", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    // Guard the ::uuid cast — a malformed id must 404, not 500 (22P02).
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ success: false, error: "Split not found" });
    }
    const split = await loadSplit(String(req.params.id));
    if (!split) return res.status(404).json({ success: false, error: "Split not found" });

    const claim = await query(
      `UPDATE split_participants SET status = 'declined'
        WHERE split_id = $1 AND user_id = $2 AND status = 'pending'
        RETURNING id`,
      [split.id, userId],
    );
    if (!claim.rows.length) {
      const existing = await query(
        `SELECT status FROM split_participants WHERE split_id = $1 AND user_id = $2 LIMIT 1`,
        [split.id, userId],
      );
      if (!existing.rows.length) return res.status(403).json({ success: false, error: "You are not a participant of this split" });
      return res.status(400).json({ success: false, error: `You have already ${existing.rows[0].status} this split` });
    }

    // A late decline can complete the split (everyone else already paid).
    const settled = await evaluateSettled(split.id);
    if (settled) {
      await query(
        `UPDATE splits SET status = 'settled', settled_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'pending'`,
        [split.id],
      );
    }

    const me = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
    const declinerName = me.rows[0]?.name || "Someone";
    createNotification({
      businessId: null,
      userId: split.creator_id,
      type: "split_declined",
      title: "Split request declined",
      message: `${declinerName} declined their share of "${String(split.title).slice(0, 60)}"`,
      actionUrl: "/splits",
      actionType: "view_split",
      metadata: { splitId: split.id, userId },
    }).catch(() => {});

    const freshSplit = await loadSplit(split.id);
    const freshParticipant = await query(`${PARTICIPANT_BASE} WHERE p.split_id = $1 AND p.user_id = $2`, [split.id, userId]);

    res.json({
      success: true,
      split: serializeSplit(freshSplit),
      participant: serializeParticipant(freshParticipant.rows[0]),
    });
  } catch (e: any) {
    console.error("[splits/decline]", e?.message);
    res.status(500).json({ success: false, error: "Could not decline the split" });
  }
});

// ---------------------------------------------------------------------------
// Remind pending participants — creator only, max 1 per participant per 6h
// ---------------------------------------------------------------------------
router.post("/:id/remind", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    // Guard the ::uuid cast — a malformed id must 404, not 500 (22P02).
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ success: false, error: "Split not found" });
    }
    const split = await loadSplit(String(req.params.id));
    if (!split) return res.status(404).json({ success: false, error: "Split not found" });
    if (split.creator_id !== userId) {
      return res.status(403).json({ success: false, error: "Only the creator can send reminders" });
    }
    if (split.status !== "pending") {
      return res.status(400).json({ success: false, error: "This split is already settled" });
    }

    const pending = await query(
      `SELECT p.user_id, p.share_amount, u.name AS display_name
         FROM split_participants p JOIN users u ON u.id = p.user_id
        WHERE p.split_id = $1 AND p.status = 'pending'`,
      [split.id],
    );
    if (!pending.rows.length) {
      return res.json({ success: true, reminded: 0, skipped: 0, message: "No pending participants to remind" });
    }

    // Rate limit: max one reminder per participant per 6h for this split.
    const recent = await query(
      `SELECT DISTINCT user_id FROM notifications
        WHERE type = 'split_reminder'
          AND created_at > NOW() - INTERVAL '6 hours'
          AND metadata->>'splitId' = $1
          AND user_id = ANY($2::uuid[])`,
      [split.id, pending.rows.map((r: any) => r.user_id)],
    );
    const throttled = new Set<string>(recent.rows.map((r: any) => r.user_id));

    const creatorName = (await query(`SELECT name FROM users WHERE id = $1`, [userId])).rows[0]?.name || "Someone";
    let reminded = 0;
    for (const p of pending.rows) {
      if (throttled.has(p.user_id)) continue;
      await createNotification({
        businessId: null,
        userId: p.user_id,
        type: "split_reminder",
        title: "Split reminder",
        message: `${creatorName} reminds you to pay ₦${num(p.share_amount).toLocaleString()} for "${String(split.title).slice(0, 60)}"`,
        actionUrl: "/splits",
        actionType: "view_split",
        metadata: { splitId: split.id, splitTitle: split.title },
      }).catch(() => {});
      reminded++;
    }

    res.json({
      success: true,
      reminded,
      skipped: pending.rows.length - reminded,
      message: reminded > 0 ? `Reminder sent to ${reminded} participant${reminded === 1 ? "" : "s"}` : "Reminders were recently sent — try again later",
    });
  } catch (e: any) {
    console.error("[splits/remind]", e?.message);
    res.status(500).json({ success: false, error: "Could not send reminders" });
  }
});

export default router;
