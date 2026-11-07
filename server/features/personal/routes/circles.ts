import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import { insertTransaction, creditWallet } from "../personal-utils";
import { createNotification } from "../../../services/notifications";

/**
 * SAVINGS CIRCLES — rotating group savings, the digital ajo/esusu
 * (mounted at /circles, personal users only).
 *
 * A fixed membership (2–15) rotates a pot: every cycle every ACTIVE member
 * auto-pays their slot (contribution_amount) from their NGN wallet and one
 * member — by transparent rotation order — takes the full pot. Starting the
 * circle generates the whole payment calendar up front (one round per
 * member), so everyone sees exactly who collects what and when. Missed
 * payments get a grace window (grace_hours); after that they are marked
 * failed and dent the member's trust score. Admins can explicitly skip a
 * member's slot for a round.
 *
 * Cycle engine: `processDueSavingsCircles()` is idempotent and safe to run
 * concurrently — it is invoked lazily on GET reads and on a 5-minute
 * setInterval in index.ts. Every money move is claimed with a conditional
 * UPDATE (status guard) BEFORE the wallet is touched, so replays and
 * overlapping workers can never double-debit or double-pay a pot.
 *
 * Endpoints:
 *   GET  /circles                          → my circles + pending invites
 *   POST /circles                          → create a circle (creator = admin)
 *   GET  /circles/:id                      → detail: members, calendar, my slot
 *   POST /circles/:id/invite               → admin adds friends (user_ids)
 *   POST /circles/:id/join                 → invited member accepts
 *   POST /circles/:id/decline              → invited member declines
 *   POST /circles/:id/start                → admin locks roster + builds calendar
 *   POST /circles/:id/order                → admin rewrites the payout order
 *   POST /circles/:id/leave                → member exits (forming freely; active winds down)
 *   POST /circles/:id/pay                  → pay my slot for the open round now
 *   POST /circles/:id/run                  → process due rounds (also lazy + interval)
 *   POST /circles/:id/members/:userId/skip → admin skips a member's slot for a round
 */

const router = express.Router();

function num(v: any): number { return Number(v) || 0; }
function money(v: number): number { return Math.round(v * 100) / 100; }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FREQUENCIES = new Set(["weekly", "biweekly", "monthly"]);
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 15;
const TRUST_MAX = 100;

const MEMBER_BASE = `
  SELECT m.id, m.circle_id, m.user_id, m.role, m.position, m.status, m.trust_score,
         m.streak, m.paid_total, m.received_total, m.joined_at, m.created_at,
         u.name AS display_name, u.avatar_url,
         LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS username
    FROM savings_circle_members m
    JOIN users u ON u.id = m.user_id
`;

function trustLabel(score: number): string {
  if (score >= 80) return "trusted";
  if (score >= 50) return "building";
  return "at_risk";
}

function serializeMember(m: any) {
  if (!m) return m;
  const score = Math.max(0, Math.min(TRUST_MAX, Math.round(num(m.trust_score))));
  return {
    ...m,
    trust_score: score,
    trust_label: trustLabel(score),
    paid_total: money(num(m.paid_total)),
    received_total: money(num(m.received_total)),
  };
}

// ---------------------------------------------------------------------------
// Due-date math — the calendar: round 1 is due 24h after start, each next
// round one frequency step later. Computed in JS from the DB clock so the
// whole calendar is deterministic and inspectable.
// ---------------------------------------------------------------------------

function addFrequency(from: Date, frequency: string, steps: number): Date {
  const d = new Date(from.getTime());
  if (frequency === "monthly") d.setUTCMonth(d.getUTCMonth() + steps);
  else d.setUTCDate(d.getUTCDate() + (frequency === "biweekly" ? 14 : 7) * steps);
  return d;
}

async function dbNow(): Promise<Date> {
  const r = await query(`SELECT NOW() AS now`);
  return new Date(r.rows[0]?.now);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeCircle(c: any) {
  if (!c) return c;
  return {
    ...c,
    contribution_amount: money(num(c.contribution_amount)),
  };
}

async function loadCircle(id: string) {
  const r = await query(
    `SELECT c.*, u.name AS creator_name, u.avatar_url AS creator_avatar
       FROM savings_circles c JOIN users u ON u.id = c.creator_id
      WHERE c.id = $1 LIMIT 1`,
    [id],
  );
  return r.rows[0] || null;
}

async function loadMembers(circleId: string) {
  const r = await query(
    `${MEMBER_BASE} WHERE m.circle_id = $1 ORDER BY m.position ASC NULLS LAST, m.created_at ASC`,
    [circleId],
  );
  return r.rows.map(serializeMember);
}

async function loadRounds(circleId: string) {
  const r = await query(
    `SELECT r.*, u.name AS recipient_name, u.avatar_url AS recipient_avatar,
            (SELECT COUNT(*)::int FROM savings_circle_payments p
              WHERE p.round_id = r.id AND p.status = 'paid') AS paid_count,
            (SELECT COUNT(*)::int FROM savings_circle_payments p
              WHERE p.round_id = r.id AND p.status IN ('pending','failed')) AS expected_missing
       FROM savings_circle_rounds r
       JOIN users u ON u.id = r.recipient_id
      WHERE r.circle_id = $1
      ORDER BY r.round_number ASC`,
    [circleId],
  );
  return r.rows.map((x: any) => ({ ...x, collected_amount: money(num(x.collected_amount)) }));
}

async function myMembership(circleId: string, userId: string) {
  const r = await query(
    `SELECT * FROM savings_circle_members WHERE circle_id = $1 AND user_id = $2 LIMIT 1`,
    [circleId, userId],
  );
  return r.rows[0] || null;
}

async function activeMemberCount(circleId: string): Promise<number> {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM savings_circle_members WHERE circle_id = $1 AND status = 'active'`,
    [circleId],
  );
  return r.rows[0]?.n || 0;
}

/** Move a member's trust score (clamped) and optionally reset the streak. */
async function adjustTrust(circleId: string, userId: string, delta: number, resetStreak = false, bumpStreak = false) {
  await query(
    `UPDATE savings_circle_members
        SET trust_score = GREATEST(0, LEAST($3, trust_score + $2)),
            streak = CASE
                       WHEN $4 THEN 0
                       WHEN $5 THEN streak + 1
                       ELSE streak
                     END
      WHERE circle_id = $1 AND user_id = $6`,
    [circleId, delta, TRUST_MAX, resetStreak, bumpStreak, userId],
  );
}

async function notify(opts: { userId: string; type: string; title: string; message: string; actionUrl: string; actionType: string; metadata?: any }) {
  createNotification({
    businessId: "",
    userId: opts.userId,
    type: opts.type,
    title: opts.title,
    message: opts.message,
    actionUrl: opts.actionUrl,
    actionType: opts.actionType,
    metadata: opts.metadata || {},
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// CYCLE ENGINE — auto-pay due rounds, enforce grace, release pots.
// Safe to call concurrently and repeatedly: every mutation is claimed with a
// guarded UPDATE first. Never throws into the caller.
// ---------------------------------------------------------------------------

let engineRunning = false;

export async function processDueSavingsCircles(): Promise<{ processed: number }> {
  if (engineRunning) return { processed: 0 };
  engineRunning = true;
  try {
    const due = await query(
      `SELECT r.id, r.circle_id
         FROM savings_circle_rounds r
         JOIN savings_circles c ON c.id = r.circle_id
        WHERE c.status = 'active' AND r.status = 'collecting' AND r.due_at <= NOW()
        ORDER BY r.due_at ASC
        LIMIT 25`,
    );
    let processed = 0;
    for (const row of due.rows) {
      try {
        await processRound(String(row.id));
        processed++;
      } catch (e: any) {
        console.error(`[circles] processRound ${row.id} failed:`, e?.message);
      }
    }
    return { processed };
  } catch (e: any) {
    console.error("[circles] engine tick failed:", e?.message);
    return { processed: 0 };
  } finally {
    engineRunning = false;
  }
}

/** Fire-and-forget trigger used by GET handlers. */
function kickEngine() {
  processDueSavingsCircles().catch(() => {});
}

/**
 * Process one collecting round whose due date has arrived:
 *   1. auto-debit every still-pending active member (on_time inside grace,
 *      late afterwards);
 *   2. once the grace window passes, mark stragglers failed (trust penalty)
 *      and release the collected pot to the round's recipient;
 *   3. advance the circle to the next round (or complete it).
 */
async function processRound(roundId: string): Promise<void> {
  const r = await query(`SELECT * FROM savings_circle_rounds WHERE id = $1 LIMIT 1`, [roundId]);
  const round = r.rows[0];
  if (!round || round.status !== "collecting") return;

  const circle = await loadCircle(round.circle_id);
  if (!circle || circle.status !== "active") return;

  const now = await dbNow();
  const dueAt = new Date(round.due_at);
  if (dueAt > now) return;
  const graceEnds = new Date(dueAt.getTime() + Math.max(0, Math.round(num(circle.grace_hours))) * 3600_000);
  const graceOver = now >= graceEnds;
  const amount = money(num(circle.contribution_amount));

  // 1. AUTO-PAY — every pending active member gets their slot debited now.
  const pending = await query(
    `SELECT p.id, p.payer_id
       FROM savings_circle_payments p
       JOIN savings_circle_members m ON m.circle_id = p.circle_id AND m.user_id = p.payer_id
      WHERE p.round_id = $1 AND p.status = 'pending' AND m.status = 'active'`,
    [roundId],
  );
  for (const p of pending.rows) {
    await settlePayment(circle, round, String(p.id), String(p.payer_id), amount, graceOver ? "late" : "on_time");
  }

  // 2. GRACE OVER — fail the stragglers, then release the pot.
  if (graceOver) {
    const stragglers = await query(
      `SELECT p.id, p.payer_id, u.name AS payer_name
         FROM savings_circle_payments p
         JOIN users u ON u.id = p.payer_id
        WHERE p.round_id = $1 AND p.status = 'pending'`,
      [roundId],
    );
    for (const s of stragglers.rows) {
      const claim = await query(
        `UPDATE savings_circle_payments SET status = 'failed'
          WHERE id = $1 AND status = 'pending' RETURNING id`,
        [s.id],
      );
      if (claim.rows.length) {
        await adjustTrust(round.circle_id, String(s.payer_id), -15, true);
        await notify({
          userId: String(s.payer_id),
          type: "circle_payment_missed",
          title: "Circle contribution missed",
          message: `Your ₦${amount.toLocaleString()} contribution to "${String(circle.name).slice(0, 60)}" was missed — your trust score took a hit.`,
          actionUrl: "/savings?tab=circles",
          actionType: "view_circle",
          metadata: { circleId: round.circle_id, roundId },
        });
      }
    }
    await releasePot(circle, round);
  }
}

/**
 * Debit one member's slot for a round. Claim (pending → paid) happens BEFORE
 * the wallet debit; any failure refunds and re-opens the claim. Idempotent by
 * the payment row itself — replays lose the status race and stop.
 */
async function settlePayment(
  circle: any,
  round: any,
  paymentId: string,
  payerId: string,
  amount: number,
  timing: "early" | "on_time" | "late",
): Promise<boolean> {
  const walletReference = `CIR-PAY-${paymentId}`.slice(0, 255);
  const claim = await query(
    `UPDATE savings_circle_payments
        SET status = 'paid', timing = $2, paid_at = CURRENT_TIMESTAMP, wallet_reference = $3
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [paymentId, timing, walletReference],
  );
  if (!claim.rows.length) return false;

  let walletId: string | null = null;
  let debited = 0;
  try {
    const w = await query(
      `SELECT id FROM wallets
        WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`,
      [payerId],
    );
    const wallet = w.rows[0];
    if (!wallet) throw new Error("no-ngn-wallet");
    const debit = await query(
      `UPDATE wallets SET balance = balance - $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND balance >= $2 AND status = 'active' RETURNING id`,
      [wallet.id, amount],
    );
    if (!debit.rows.length) throw new Error("insufficient-balance");
    walletId = wallet.id;
    debited = amount;

    await insertTransaction({
      userId: payerId,
      walletId: wallet.id,
      reference: walletReference,
      type: "debit",
      transactionType: "circle_contribution",
      amount,
      currency: "NGN",
      description: `Savings circle — ${String(circle.name).slice(0, 60)} (round ${Math.round(num(round.round_number))})`,
    });

    await query(
      `UPDATE savings_circle_members
          SET paid_total = paid_total + $2, updated_at = CURRENT_TIMESTAMP
        WHERE circle_id = $1 AND user_id = $3`,
      [circle.id, amount, payerId],
    );

    // Trust: on-time builds, late dents slightly.
    if (timing === "on_time" || timing === "early") {
      await adjustTrust(circle.id, payerId, +2, false, true);
    } else {
      await adjustTrust(circle.id, payerId, -5, true);
    }
    return true;
  } catch (e: any) {
    // Refund + release the claim so the engine can retry within grace.
    if (debited > 0 && walletId) {
      await creditWallet(walletId, debited).catch((rErr: any) =>
        console.error("[circles] CRITICAL: wallet refund failed:", rErr?.message));
    }
    await query(
      `UPDATE savings_circle_payments
          SET status = 'pending', timing = NULL, paid_at = NULL, wallet_reference = NULL
        WHERE id = $1 AND wallet_reference = $2`,
      [paymentId, walletReference],
    ).catch(() => {});
    return false;
  }
}

/**
 * Release a round's collected pot to the recipient and advance the circle.
 * The payout is claimed with a status guard so only one worker ever credits.
 */
async function releasePot(circle: any, round: any): Promise<void> {
  const sum = await query(
    `SELECT COALESCE(SUM(amount), 0)::float AS pot
       FROM savings_circle_payments WHERE round_id = $1 AND status = 'paid'`,
    [round.id],
  );
  const pot = money(num(sum.rows[0]?.pot));

  const claim = await query(
    `UPDATE savings_circle_rounds
        SET status = 'paid_out', paid_out_at = CURRENT_TIMESTAMP,
            collected_amount = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'collecting'
      RETURNING id`,
    [round.id, pot],
  );
  if (!claim.rows.length) return; // someone else already released it

  if (pot > 0) {
    let paid = false;
    try {
      const w = await query(
        `SELECT id FROM wallets
          WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active'
          ORDER BY created_at ASC LIMIT 1`,
        [round.recipient_id],
      );
      const wallet = w.rows[0];
      if (wallet) {
        await creditWallet(wallet.id, pot);
        await insertTransaction({
          userId: round.recipient_id,
          walletId: wallet.id,
          reference: `CIR-OUT-${round.id}`.slice(0, 255),
          type: "credit",
          transactionType: "circle_payout",
          amount: pot,
          currency: "NGN",
          description: `Savings circle payout — ${String(circle.name).slice(0, 60)} (round ${Math.round(num(round.round_number))})`,
        });
        await query(
          `UPDATE savings_circle_members
              SET received_total = received_total + $2, updated_at = CURRENT_TIMESTAMP
            WHERE circle_id = $1 AND user_id = $3`,
          [circle.id, pot, round.recipient_id],
        );
        paid = true;
      }
    } catch (e: any) {
      console.error(`[circles] payout credit failed for round ${round.id}:`, e?.message);
      // Re-open the round so the next tick retries the credit.
      await query(
        `UPDATE savings_circle_rounds SET status = 'collecting', paid_out_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [round.id],
      ).catch(() => {});
      return;
    }
    if (paid) {
      await notify({
        userId: String(round.recipient_id),
        type: "circle_payout",
        title: "Circle payout received",
        message: ` ₦${pot.toLocaleString()} from "${String(circle.name).slice(0, 60)}" just landed in your wallet.`,
        actionUrl: "/savings?tab=circles",
        actionType: "view_circle",
        metadata: { circleId: circle.id, roundId: round.id, amount: pot },
      });
    }
  }

  await advanceCircle(circle);
}

/** Move to the next non-cancelled round, or complete the circle. */
async function advanceCircle(circle: any): Promise<void> {
  const next = await query(
    `SELECT id, due_at FROM savings_circle_rounds
      WHERE circle_id = $1 AND round_number > $2 AND status IN ('upcoming','collecting')
      ORDER BY round_number ASC LIMIT 1`,
    [circle.id, Math.round(num(circle.current_round))],
  );
  if (next.rows.length) {
    await query(
      `UPDATE savings_circles
          SET current_round = current_round + 1, next_due_at = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [circle.id, next.rows[0].due_at],
    );
    await query(
      `UPDATE savings_circle_rounds SET status = 'collecting', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'upcoming'`,
      [next.rows[0].id],
    );
  } else {
    await query(
      `UPDATE savings_circles SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [circle.id],
    );
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

// List mine (member/active + invites) — declared BEFORE /:id
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    kickEngine();
    const userId = req.user!.userId;

    const rows = await query(
      `SELECT c.*, m.role AS my_role, m.status AS my_status, m.position AS my_position,
              m.trust_score AS my_trust_score, m.streak AS my_streak,
              u.name AS creator_name,
              (SELECT COUNT(*)::int FROM savings_circle_members x
                WHERE x.circle_id = c.id AND x.status = 'active') AS active_count,
              (SELECT COUNT(*)::int FROM savings_circle_members x
                WHERE x.circle_id = c.id AND x.status IN ('active','invited')) AS member_count,
              nr.recipient_name AS next_recipient_name
         FROM savings_circles c
         JOIN savings_circle_members m ON m.circle_id = c.id AND m.user_id = $1
         JOIN users u ON u.id = c.creator_id
         LEFT JOIN LATERAL (
           SELECT ru.name AS recipient_name
             FROM savings_circle_rounds rr JOIN users ru ON ru.id = rr.recipient_id
            WHERE rr.circle_id = c.id AND rr.status IN ('upcoming','collecting')
            ORDER BY rr.round_number ASC LIMIT 1
         ) nr ON TRUE
        WHERE m.status IN ('active','invited')
        ORDER BY c.created_at DESC LIMIT 100`,
      [userId],
    );

    const circles = rows.rows.filter((r: any) => r.my_status === "active").map((r: any) => {
      const s = serializeCircle(r);
      return {
        ...s,
        my_role: r.my_role,
        my_position: r.my_position,
        my_trust_score: Math.max(0, Math.min(TRUST_MAX, Math.round(num(r.my_trust_score)))),
        my_streak: r.my_streak,
      };
    });
    const invites = rows.rows.filter((r: any) => r.my_status === "invited").map(serializeCircle);

    res.json({ success: true, circles, invites });
  } catch (e: any) {
    console.error("[circles/list]", e?.message);
    res.status(500).json({ success: false, error: "Could not load your circles" });
  }
});

// Create a circle (creator becomes admin + first active member)
router.post("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const name = String(req.body?.name || "").trim();
    const description = String(req.body?.description || "").trim().slice(0, 500) || null;
    const amount = money(num(req.body?.contribution_amount));
    const frequency = FREQUENCIES.has(String(req.body?.frequency)) ? String(req.body.frequency) : "weekly";
    const maxMembers = Math.round(num(req.body?.max_members)) || 10;
    const graceHours = Math.min(72, Math.max(6, Math.round(num(req.body?.grace_hours)) || 48));

    if (name.length < 3 || name.length > 100) {
      return res.status(400).json({ success: false, error: "Circle name must be between 3 and 100 characters" });
    }
    if (!(amount >= 100)) {
      return res.status(400).json({ success: false, error: "Each contribution must be at least ₦100" });
    }
    if (maxMembers < MIN_MEMBERS || maxMembers > MAX_MEMBERS) {
      return res.status(400).json({ success: false, error: `A circle holds between ${MIN_MEMBERS} and ${MAX_MEMBERS} members` });
    }

    const created = await query(
      `INSERT INTO savings_circles (creator_id, name, description, contribution_amount, currency, frequency, max_members, grace_hours, status)
       VALUES ($1,$2,$3,$4,'NGN',$5,$6,$7,'forming') RETURNING *`,
      [userId, name, description, amount, frequency, maxMembers, graceHours],
    );
    const circle = created.rows[0];
    await query(
      `INSERT INTO savings_circle_members (circle_id, user_id, role, status, joined_at)
       VALUES ($1,$2,'admin','active',CURRENT_TIMESTAMP)`,
      [circle.id, userId],
    );

    res.status(201).json({ success: true, circle: serializeCircle(circle) });
  } catch (e: any) {
    console.error("[circles/create]", e?.message);
    res.status(500).json({ success: false, error: "Could not create the circle" });
  }
});

// Detail — members, payment calendar, my slot
router.get("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    kickEngine();
    const userId = req.user!.userId;
    const circle = await loadCircle(req.params.id);
    if (!circle) return res.status(404).json({ success: false, error: "Circle not found" });

    const me = await myMembership(circle.id, userId);
    if (!me) return res.status(403).json({ success: false, error: "You are not part of this circle" });

    const members = await loadMembers(circle.id);
    const rounds = await loadRounds(circle.id);
    const activeCount = await activeMemberCount(circle.id);
    const pot = money(amount(activeCount, circle.contribution_amount));

    // My pending payment for the open round (if any).
    let myPending = null;
    const open = rounds.find((r: any) => r.status === "collecting");
    if (open) {
      const p = await query(
        `SELECT id, amount, status, timing, paid_at FROM savings_circle_payments
          WHERE round_id = $1 AND payer_id = $2 LIMIT 1`,
        [open.id, userId],
      );
      if (p.rows[0] && p.rows[0].status === "pending") myPending = { payment_id: p.rows[0].id, amount: money(num(p.rows[0].amount)), round_id: open.id };
    }

    res.json({
      success: true,
      circle: { ...serializeCircle(circle), active_count: activeCount, pot_per_round: pot },
      members,
      rounds,
      my: {
        membership_id: me.id,
        role: me.role,
        status: me.status,
        position: me.position,
        trust_score: Math.max(0, Math.min(TRUST_MAX, Math.round(num(me.trust_score)))),
        trust_label: trustLabel(num(me.trust_score)),
        streak: me.streak,
        paid_total: money(num(me.paid_total)),
        received_total: money(num(me.received_total)),
        pending_payment: myPending,
      },
    });
  } catch (e: any) {
    console.error("[circles/detail]", e?.message);
    res.status(500).json({ success: false, error: "Could not load the circle" });
  }
});

function amount(activeCount: number, contribution: any): number {
  return activeCount * num(contribution);
}

// Invite friends — admin only, respects max_members
router.post("/:id/invite", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const circle = await loadCircle(req.params.id);
    if (!circle) return res.status(404).json({ success: false, error: "Circle not found" });
    const me = await myMembership(circle.id, userId);
    if (!me || me.role !== "admin") {
      return res.status(403).json({ success: false, error: "Only the circle admin can add members" });
    }
    if (circle.status !== "forming" && circle.status !== "active") {
      return res.status(400).json({ success: false, error: "This circle is closed" });
    }

    const raw = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
    const ids: string[] = [];
    for (const v of raw) {
      const id = String(v || "").trim();
      if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: "Each invite needs a valid user_id" });
      if (id !== userId && !ids.includes(id)) ids.push(id);
    }
    if (!ids.length) return res.status(400).json({ success: false, error: "Pick at least one person to invite" });

    const found = await query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [ids]);
    if (found.rows.length !== ids.length) {
      return res.status(400).json({ success: false, error: "One or more people were not found" });
    }

    const current = await query(
      `SELECT COUNT(*)::int AS n FROM savings_circle_members WHERE circle_id = $1 AND status IN ('active','invited')`,
      [circle.id],
    );
    const room = Math.round(num(circle.max_members)) - (current.rows[0]?.n || 0);
    if (ids.length > room) {
      return res.status(400).json({ success: false, error: `Only ${Math.max(0, room)} slot(s) left in this circle` });
    }

    // Re-invite supersedes a previous left/removed row via ON CONFLICT.
    const inserted = await query(
      `INSERT INTO savings_circle_members (circle_id, user_id, role, status)
       SELECT $1, x.uid, 'member', 'invited'
       FROM UNNEST($2::uuid[]) AS x(uid)
       ON CONFLICT (circle_id, user_id) DO UPDATE
         SET status = 'invited', role = 'member', updated_at = CURRENT_TIMESTAMP
       WHERE savings_circle_members.status IN ('left','removed','invited')
       RETURNING user_id`,
      [circle.id, ids],
    );
    const invitedIds = new Set(inserted.rows.map((r: any) => String(r.user_id)));

    const adminName = (await query(`SELECT name FROM users WHERE id = $1`, [userId])).rows[0]?.name || "Someone";
    for (const u of found.rows) {
      if (!invitedIds.has(String(u.id))) continue;
      await notify({
        userId: String(u.id),
        type: "circle_invite",
        title: "Savings circle invite",
        message: `${adminName} invited you to join "${String(circle.name).slice(0, 60)}" — ₦${money(num(circle.contribution_amount)).toLocaleString()} ${String(circle.frequency)} rotated with the group.`,
        actionUrl: "/savings?tab=circles",
        actionType: "view_circle",
        metadata: { circleId: circle.id },
      });
    }

    res.json({
      success: true,
      invited: invitedIds.size,
      skipped: ids.length - invitedIds.size,
      message: invitedIds.size ? `Invitation sent to ${invitedIds.size} person${invitedIds.size === 1 ? "" : "s"}` : "Those people are already on the roster",
    });
  } catch (e: any) {
    console.error("[circles/invite]", e?.message);
    res.status(500).json({ success: false, error: "Could not send invites" });
  }
});

// Accept an invite
router.post("/:id/join", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const circle = await loadCircle(req.params.id);
    if (!circle) return res.status(404).json({ success: false, error: "Circle not found" });
    if (circle.status !== "forming") {
      return res.status(400).json({ success: false, error: "This circle has already started" });
    }
    const claim = await query(
      `UPDATE savings_circle_members
          SET status = 'active', joined_at = CURRENT_TIMESTAMP
        WHERE circle_id = $1 AND user_id = $2 AND status = 'invited'
        RETURNING id`,
      [circle.id, userId],
    );
    if (!claim.rows.length) {
      return res.status(400).json({ success: false, error: "You have no pending invite for this circle" });
    }

    const name = (await query(`SELECT name FROM users WHERE id = $1`, [userId])).rows[0]?.name || "Someone";
    await notify({
      userId: circle.creator_id,
      type: "circle_joined",
      title: "New circle member",
      message: `${name} joined your circle "${String(circle.name).slice(0, 60)}".`,
      actionUrl: "/savings?tab=circles",
      actionType: "view_circle",
      metadata: { circleId: circle.id },
    });

    res.json({ success: true });
  } catch (e: any) {
    console.error("[circles/join]", e?.message);
    res.status(500).json({ success: false, error: "Could not join the circle" });
  }
});

// Decline an invite
router.post("/:id/decline", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const deleted = await query(
      `DELETE FROM savings_circle_members
        WHERE circle_id = $1 AND user_id = $2 AND status = 'invited' RETURNING id`,
      [req.params.id, userId],
    );
    if (!deleted.rows.length) {
      return res.status(400).json({ success: false, error: "You have no pending invite for this circle" });
    }
    res.json({ success: true });
  } catch (e: any) {
    console.error("[circles/decline]", e?.message);
    res.status(500).json({ success: false, error: "Could not decline the invite" });
  }
});

// Start the circle — lock the roster, assign order, generate the calendar
router.post("/:id/start", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const circle = await loadCircle(req.params.id);
    if (!circle) return res.status(404).json({ success: false, error: "Circle not found" });
    if (circle.creator_id !== userId) {
      return res.status(403).json({ success: false, error: "Only the creator can start the circle" });
    }
    if (circle.status !== "forming") {
      return res.status(400).json({ success: false, error: "This circle has already started" });
    }

    const actives = await query(
      `SELECT user_id FROM savings_circle_members WHERE circle_id = $1 AND status = 'active'`,
      [circle.id],
    );
    const memberIds: string[] = actives.rows.map((r: any) => String(r.user_id));
    if (memberIds.length < MIN_MEMBERS) {
      return res.status(400).json({ success: false, error: `You need at least ${MIN_MEMBERS} active members to start` });
    }

    // Payout order: creator-provided order (validated) or join order.
    let order = memberIds;
    const requested = Array.isArray(req.body?.order) ? req.body.order.map((v: any) => String(v || "").trim()) : null;
    if (requested && requested.length) {
      const valid = requested.filter((id: string) => memberIds.includes(id));
      const missing = memberIds.filter((id: string) => !valid.includes(id));
      order = [...valid, ...missing];
    }

    // Deterministic start: first collection is due 24h from the DB clock.
    const now = await dbNow();
    const firstDue = new Date(now.getTime() + 24 * 3600_000);
    const contribution = money(num(circle.contribution_amount));
    const graceHours = Math.max(6, Math.round(num(circle.grace_hours)) || 48);

    // Claim the start (idempotent under concurrent starts).
    const claim = await query(
      `UPDATE savings_circles
          SET status = 'active', started_at = CURRENT_TIMESTAMP, current_round = 1,
              next_due_at = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'forming'
        RETURNING id`,
      [circle.id, firstDue],
    );
    if (!claim.rows.length) {
      return res.status(400).json({ success: false, error: "This circle has already started" });
    }

    // Assign positions + build the full calendar (one round per member).
    for (let i = 0; i < order.length; i++) {
      await query(
        `UPDATE savings_circle_members SET position = $2 WHERE circle_id = $1 AND user_id = $3`,
        [circle.id, i + 1, order[i]],
      );
    }
    for (let i = 0; i < order.length; i++) {
      const dueAt = addFrequency(firstDue, String(circle.frequency), i);
      const round = await query(
        `INSERT INTO savings_circle_rounds (circle_id, round_number, recipient_id, due_at, status)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (circle_id, round_number) DO NOTHING
         RETURNING id`,
        [circle.id, i + 1, order[i], dueAt, i === 0 ? "collecting" : "upcoming"],
      );
      const roundId = round.rows[0]?.id;
      if (roundId) {
        await query(
          `INSERT INTO savings_circle_payments (circle_id, round_id, payer_id, amount, status)
           SELECT $1, $2, x.uid, $3, 'pending'
           FROM UNNEST($4::uuid[]) AS x(uid)
           ON CONFLICT (round_id, payer_id) DO NOTHING`,
          [circle.id, roundId, contribution, order],
        );
      }
    }

    // Tell everyone the calendar is live.
    for (const id of memberIds) {
      if (id === userId) continue;
      await notify({
        userId: id,
        type: "circle_started",
        title: "Savings circle started",
        message: `"${String(circle.name).slice(0, 60)}" is live — first contribution of ₦${contribution.toLocaleString()} is due ${firstDue.toDateString()}.`,
        actionUrl: "/savings?tab=circles",
        actionType: "view_circle",
        metadata: { circleId: circle.id },
      });
    }

    res.json({ success: true, circle: serializeCircle(await loadCircle(circle.id)), rounds: await loadRounds(circle.id) });
  } catch (e: any) {
    console.error("[circles/start]", e?.message);
    res.status(500).json({ success: false, error: "Could not start the circle" });
  }
});

// Rewrite the payout order (admin, before any round pays out)
router.post("/:id/order", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const circle = await loadCircle(req.params.id);
    if (!circle) return res.status(404).json({ success: false, error: "Circle not found" });
    const me = await myMembership(circle.id, userId);
    if (!me || me.role !== "admin") {
      return res.status(403).json({ success: false, error: "Only the circle admin can change the order" });
    }

    const paidRounds = await query(
      `SELECT 1 FROM savings_circle_rounds WHERE circle_id = $1 AND status = 'paid_out' LIMIT 1`,
      [circle.id],
    );
    if (paidRounds.rows.length) {
      return res.status(400).json({ success: false, error: "The rotation already started — the order is locked" });
    }

    const requested = Array.isArray(req.body?.order) ? req.body.order.map((v: any) => String(v || "").trim()) : [];
    if (!requested.length) return res.status(400).json({ success: false, error: "order must be a list of member user_ids" });

    const actives = await query(
      `SELECT user_id FROM savings_circle_members WHERE circle_id = $1 AND status = 'active'`,
      [circle.id],
    );
    const memberIds = actives.rows.map((r: any) => String(r.user_id));
    const valid = requested.filter((id: string) => memberIds.includes(id));
    const order = [...new Set([...valid, ...memberIds])];

    for (let i = 0; i < order.length; i++) {
      await query(
        `UPDATE savings_circle_members SET position = $2 WHERE circle_id = $1 AND user_id = $3`,
        [circle.id, i + 1, order[i]],
      );
      await query(
        `UPDATE savings_circle_rounds r
            SET recipient_id = $2, updated_at = CURRENT_TIMESTAMP
           FROM savings_circle_members m
          WHERE r.circle_id = $1 AND r.round_number = $3 AND m.circle_id = $1 AND m.user_id = $2`,
        [circle.id, order[i], i + 1],
      );
    }

    res.json({ success: true, rounds: await loadRounds(circle.id) });
  } catch (e: any) {
    console.error("[circles/order]", e?.message);
    res.status(500).json({ success: false, error: "Could not update the payout order" });
  }
});

// Leave — forming: walk away cleanly; active: wind down (future slots cancel)
router.post("/:id/leave", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const circle = await loadCircle(req.params.id);
    if (!circle) return res.status(404).json({ success: false, error: "Circle not found" });
    const me = await myMembership(circle.id, userId);
    if (!me || (me.status !== "active" && me.status !== "invited")) {
      return res.status(400).json({ success: false, error: "You are not an active member of this circle" });
    }
    if (circle.creator_id === userId && circle.status === "forming") {
      // Creator dissolving a forming circle.
      await query(`UPDATE savings_circles SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [circle.id]);
      await query(`UPDATE savings_circle_members SET status = 'left' WHERE circle_id = $1`, [circle.id]);
      return res.json({ success: true, cancelled: true });
    }
    if (circle.creator_id === userId && circle.status === "active") {
      return res.status(400).json({ success: false, error: "The creator cannot leave an active circle — contact support to dissolve it" });
    }

    if (me.status === "invited") {
      await query(`DELETE FROM savings_circle_members WHERE id = $1`, [me.id]);
      return res.json({ success: true });
    }

    await query(
      `UPDATE savings_circle_members SET status = 'left', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [me.id],
    );

    if (circle.status === "active") {
      // Outstanding slots: skip what's open, cancel what's upcoming.
      await query(
        `UPDATE savings_circle_payments p SET status = 'skipped'
          FROM savings_circle_rounds r
         WHERE p.round_id = r.id AND r.circle_id = $1 AND p.payer_id = $2 AND p.status = 'pending'`,
        [circle.id, userId],
      );
      await query(
        `UPDATE savings_circle_rounds SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE circle_id = $1 AND recipient_id = $2 AND status = 'upcoming'`,
        [circle.id, userId],
      );
      // If their slot is the CURRENT round, release whatever is collected now.
      const cur = await query(
        `SELECT id FROM savings_circle_rounds
          WHERE circle_id = $1 AND status = 'collecting' AND recipient_id = $2 LIMIT 1`,
        [circle.id, userId],
      );
      if (cur.rows[0]) await releasePot(circle, cur.rows[0]);
    }

    res.json({ success: true });
  } catch (e: any) {
    console.error("[circles/leave]", e?.message);
    res.status(500).json({ success: false, error: "Could not leave the circle" });
  }
});

// Pay my open-round slot now (early or late within grace)
router.post("/:id/pay", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const circle = await loadCircle(req.params.id);
    if (!circle) return res.status(404).json({ success: false, error: "Circle not found" });
    if (circle.status !== "active") {
      return res.status(400).json({ success: false, error: "This circle is not running" });
    }
    const me = await myMembership(circle.id, userId);
    if (!me || me.status !== "active") {
      return res.status(403).json({ success: false, error: "You are not an active member of this circle" });
    }

    const open = await query(
      `SELECT r.* FROM savings_circle_rounds r
        WHERE r.circle_id = $1 AND r.status = 'collecting'
        ORDER BY r.round_number ASC LIMIT 1`,
      [circle.id],
    );
    const round = open.rows[0];
    if (!round) return res.status(400).json({ success: false, error: "No open round to pay into" });

    const p = await query(
      `SELECT * FROM savings_circle_payments WHERE round_id = $1 AND payer_id = $2 LIMIT 1`,
      [round.id, userId],
    );
    const payment = p.rows[0];
    if (!payment) return res.status(400).json({ success: false, error: "No contribution slot found for you this round" });
    if (payment.status === "paid") return res.status(400).json({ success: false, code: "ALREADY_PAID", error: "Your contribution for this round is already in" });
    if (payment.status !== "pending") {
      return res.status(400).json({ success: false, code: "NOT_PENDING", error: `This slot was ${payment.status}` });
    }

    const now = await dbNow();
    const dueAt = new Date(round.due_at);
    const graceEnds = new Date(dueAt.getTime() + Math.max(0, Math.round(num(circle.grace_hours))) * 3600_000);
    if (now > graceEnds) {
      return res.status(400).json({ success: false, code: "GRACE_OVER", error: "The grace window for this round has closed" });
    }
    const timing: "early" | "on_time" | "late" = now < dueAt ? "early" : "late";

    const ok = await settlePayment(circle, round, payment.id, userId, money(num(payment.amount)), timing);
    if (!ok) {
      const retry = await query(`SELECT status FROM savings_circle_payments WHERE id = $1`, [payment.id]);
      const status = retry.rows[0]?.status;
      if (status === "paid") return res.json({ success: true });
      return res.status(400).json({
        success: false,
        code: "INSUFFICIENT_BALANCE",
        error: "Insufficient NGN wallet balance — top up and try again before the grace window closes",
      });
    }

    // The round may now be fully collected — release early when everyone is in.
    const counts = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
         COUNT(*)::int AS total
         FROM savings_circle_payments WHERE round_id = $1`,
      [round.id],
    );
    const c = counts.rows[0] || {};
    if (c.total > 0 && c.pending === 0 && c.paid === c.total) {
      await releasePot(circle, round);
    }

    const fresh = await loadCircle(circle.id);
    res.json({ success: true, circle: serializeCircle(fresh) });
  } catch (e: any) {
    console.error("[circles/pay]", e?.message);
    res.status(500).json({ success: false, error: "Could not pay your contribution" });
  }
});

// Explicit run trigger (also lazy + 5-min interval)
router.post("/run", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await processDueSavingsCircles();
    res.json({ success: true, processed: result.processed });
  } catch (e: any) {
    console.error("[circles/run]", e?.message);
    res.status(500).json({ success: false, error: "Could not run the cycle engine" });
  }
});

// Admin skip — mark a member's slot for a round as skipped (trust -5)
router.post("/:id/members/:userId/skip", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const circle = await loadCircle(req.params.id);
    if (!circle) return res.status(404).json({ success: false, error: "Circle not found" });
    const me = await myMembership(circle.id, userId);
    if (!me || me.role !== "admin") {
      return res.status(403).json({ success: false, error: "Only the circle admin can skip a slot" });
    }
    const targetId = String(req.params.userId || "");
    if (!UUID_RE.test(targetId)) return res.status(400).json({ success: false, error: "Invalid member" });

    const roundId = req.body?.round_id ? String(req.body.round_id) : null;
    const round = roundId
      ? (await query(`SELECT * FROM savings_circle_rounds WHERE id = $1 AND circle_id = $2 LIMIT 1`, [roundId, circle.id])).rows[0]
      : (await query(`SELECT * FROM savings_circle_rounds WHERE circle_id = $1 AND status = 'collecting' ORDER BY round_number ASC LIMIT 1`, [circle.id])).rows[0];
    if (!round) return res.status(400).json({ success: false, error: "Round not found" });

    const claim = await query(
      `UPDATE savings_circle_payments SET status = 'skipped'
        WHERE round_id = $1 AND payer_id = $2 AND status = 'pending'
        RETURNING id`,
      [round.id, targetId],
    );
    if (!claim.rows.length) {
      return res.status(400).json({ success: false, error: "Nothing to skip for that member this round" });
    }
    await adjustTrust(circle.id, targetId, -5, true);

    // If that clears the round, release it.
    const counts = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending FROM savings_circle_payments WHERE round_id = $1`,
      [round.id],
    );
    if ((counts.rows[0]?.pending || 0) === 0) await releasePot(circle, round);

    res.json({ success: true });
  } catch (e: any) {
    console.error("[circles/skip]", e?.message);
    res.status(500).json({ success: false, error: "Could not skip the slot" });
  }
});

export default router;
