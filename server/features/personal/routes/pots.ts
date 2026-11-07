import express from "express";
import { randomBytes } from "crypto";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import { insertTransaction, creditWallet } from "../personal-utils";
import { createNotification } from "../../../services/notifications";

/**
 * GROUP POTS — shared money pots for events, gifts and launches (mounted at
 * /pots, personal users only).
 *
 * Anyone with the link/context contributes ANY amount from their NGN wallet
 * (NO transaction PIN for v1 — social micro-payments). The creator closes the
 * pot and the collected balance pays out to their NGN wallet. Everything is
 * NGN; contributions are idempotent by unique reference.
 *
 * Endpoints:
 *   POST /pots                 → open a pot (+ share token)
 *   GET  /pots/mine            → pots I created + pots I contributed to
 *   GET  /pots/:id             → detail + contributions + progress
 *   POST /pots/:id/contribute  → { amount, note? } wallet-funded contribution
 *   POST /pots/:id/close       → creator-only payout to their NGN wallet
 */

const router = express.Router();

function num(v: any): number { return Number(v) || 0; }
function money(v: number): number { return Math.round(v * 100) / 100; }

const CONTEXTS = new Set(["direct", "group", "page"]);

const POT_BASE = `
  SELECT p.*, u.name AS creator_name, u.avatar_url AS creator_avatar,
         LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS creator_username
  FROM pots p JOIN users u ON u.id = p.creator_id
`;

function serializePot(p: any) {
  if (!p) return p;
  return {
    ...p,
    target_amount: p.target_amount === null || p.target_amount === undefined ? null : num(p.target_amount),
    balance: num(p.balance),
  };
}

async function loadPot(id: string) {
  const r = await query(`${POT_BASE} WHERE p.id = $1 LIMIT 1`, [id]);
  return r.rows[0] || null;
}

function buildProgress(pot: any) {
  const target = pot.target_amount === null || pot.target_amount === undefined ? null : num(pot.target_amount);
  const balance = num(pot.balance);
  if (target === null) return { percent: 0, remaining: null };
  return {
    percent: target > 0 ? Math.min(100, Math.round((balance / target) * 100)) : 0,
    remaining: Math.max(0, money(target - balance)),
  };
}

// ---------------------------------------------------------------------------
// Open a pot
// ---------------------------------------------------------------------------
router.post("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const title = String(req.body?.title || "").trim();
    const purpose = String(req.body?.purpose || "").trim().slice(0, 500) || null;
    const context = CONTEXTS.has(String(req.body?.context)) ? String(req.body.context) : "direct";
    const contextId = req.body?.context_id ? String(req.body.context_id) : null;

    if (title.length < 3 || title.length > 140) {
      return res.status(400).json({ success: false, error: "Title must be between 3 and 140 characters" });
    }

    let targetAmount: number | null = null;
    if (req.body?.target_amount !== undefined && req.body?.target_amount !== null && req.body.target_amount !== "") {
      targetAmount = money(num(req.body.target_amount));
      if (!(targetAmount > 0)) {
        return res.status(400).json({ success: false, error: "target_amount must be greater than 0" });
      }
    }

    let deadline: Date | null = null;
    if (req.body?.deadline) {
      deadline = new Date(req.body.deadline);
      if (isNaN(deadline.getTime())) {
        return res.status(400).json({ success: false, error: "deadline must be a valid date" });
      }
    }

    const shareToken = randomBytes(24).toString("hex");
    const created = await query(
      `INSERT INTO pots (creator_id, title, purpose, currency, target_amount, balance, status, context, context_id, share_token, deadline)
       VALUES ($1,$2,$3,'NGN',$4,0,'open',$5,$6,$7,$8) RETURNING *`,
      [userId, title, purpose, targetAmount, context, contextId, shareToken, deadline],
    );

    res.status(201).json({ success: true, pot: serializePot(created.rows[0]) });
  } catch (e: any) {
    console.error("[pots/create]", e?.message);
    res.status(500).json({ success: false, error: "Could not create the pot" });
  }
});

// ---------------------------------------------------------------------------
// Mine (created + contributing) — declared BEFORE /:id
// ---------------------------------------------------------------------------
router.get("/mine", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;

    const created = await query(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM pot_contributions c WHERE c.pot_id = p.id) AS contributions_count,
              (SELECT COUNT(DISTINCT c.user_id)::int FROM pot_contributions c WHERE c.pot_id = p.id) AS contributors_count
         FROM pots p WHERE p.creator_id = $1
        ORDER BY p.created_at DESC LIMIT 100`,
      [userId],
    );

    const contributing = await query(
      `SELECT p.*, pu.name AS creator_name, pu.avatar_url AS creator_avatar,
              c.my_amount, c.my_contributions
         FROM (
           SELECT pot_id, COALESCE(SUM(amount), 0)::float AS my_amount, COUNT(*)::int AS my_contributions
             FROM pot_contributions WHERE user_id = $1 GROUP BY pot_id
         ) c
         JOIN pots p ON p.id = c.pot_id
         JOIN users pu ON pu.id = p.creator_id
        ORDER BY p.created_at DESC LIMIT 100`,
      [userId],
    );

    res.json({
      success: true,
      pots: created.rows.map(serializePot),
      contributing: contributing.rows.map((r: any) => ({
        ...serializePot(r),
        my_amount: num(r.my_amount),
        my_contributions: r.my_contributions,
      })),
    });
  } catch (e: any) {
    console.error("[pots/mine]", e?.message);
    res.status(500).json({ success: false, error: "Could not load your pots" });
  }
});

// ---------------------------------------------------------------------------
// Detail + contributions + progress (auth required; open viewing for v1)
// ---------------------------------------------------------------------------
router.get("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const pot = await loadPot(req.params.id);
    if (!pot) return res.status(404).json({ success: false, error: "Pot not found" });

    const contributions = await query(
      `SELECT c.id, c.user_id, c.amount, c.currency, c.note, c.created_at,
              u.name AS display_name, u.avatar_url
         FROM pot_contributions c JOIN users u ON u.id = c.user_id
        WHERE c.pot_id = $1
        ORDER BY c.created_at DESC LIMIT 100`,
      [pot.id],
    );

    res.json({
      success: true,
      pot: serializePot(pot),
      contributions: contributions.rows.map((r: any) => ({ ...r, amount: num(r.amount) })),
      progress: buildProgress(pot),
    });
  } catch (e: any) {
    console.error("[pots/detail]", e?.message);
    res.status(500).json({ success: false, error: "Could not load the pot" });
  }
});

// ---------------------------------------------------------------------------
// Contribute — balance-guarded wallet debit, idempotent contribution reference
// ---------------------------------------------------------------------------
router.post("/:id/contribute", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const amount = money(num(req.body?.amount));
    const note = String(req.body?.note || "").trim().slice(0, 255) || null;

    if (!(amount > 0)) {
      return res.status(400).json({ success: false, error: "amount must be greater than 0" });
    }

    const pot = await loadPot(req.params.id);
    if (!pot) return res.status(404).json({ success: false, error: "Pot not found" });
    if (pot.status !== "open") {
      return res.status(400).json({ success: false, code: "POT_CLOSED", error: "This pot is closed" });
    }

    const w = await query(
      `SELECT id FROM wallets
        WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`,
      [userId],
    );
    const wallet = w.rows[0];
    if (!wallet) {
      return res.status(400).json({ success: false, code: "NO_WALLET", error: "You need an active NGN wallet to contribute" });
    }

    const balanceBefore = num(pot.balance);
    const reference = `POT-C-${pot.id}-${userId}-${Date.now()}`.slice(0, 255);

    // Balance-guarded debit first.
    const debit = await query(
      `UPDATE wallets SET balance = balance - $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND balance >= $2 AND status = 'active' RETURNING id`,
      [wallet.id, amount],
    );
    if (!debit.rows.length) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: "Insufficient NGN wallet balance" });
    }

    let contribution: any;
    try {
      // Guarded pot credit — the pot can close between our read and this write.
      const upd = await query(
        `UPDATE pots SET balance = balance + $2 WHERE id = $1 AND status = 'open' RETURNING balance`,
        [pot.id, amount],
      );
      if (!upd.rows.length) {
        throw Object.assign(new Error("POT_CLOSED"), { potClosed: true });
      }
      const balanceAfter = num(upd.rows[0].balance);
      const ins = await query(
        `INSERT INTO pot_contributions (pot_id, user_id, amount, currency, note, reference, balance_after)
         VALUES ($1,$2,$3,'NGN',$4,$5,$6) RETURNING *`,
        [pot.id, userId, amount, note, reference, balanceAfter],
      );
      contribution = { ...ins.rows[0], amount: num(ins.rows[0].amount) };
      // Wallet-facing ledger row — inside the guard: a failure here rolls the
      // whole contribution back instead of stranding an unrecorded debit.
      await insertTransaction({
        userId,
        walletId: wallet.id,
        reference,
        type: "debit",
        transactionType: "pot_contribution",
        amount,
        currency: "NGN",
        description: `Group pot contribution — ${String(pot.title).slice(0, 60)}`,
      });
    } catch (cErr: any) {
      // Never take money without recording the contribution.
      if (cErr?.potClosed) {
        await creditWallet(wallet.id, amount).catch(() => {});
        return res.status(400).json({ success: false, code: "POT_CLOSED", error: "This pot just closed — your wallet was refunded" });
      }
      console.error("[pots/contribute] record failed — refunding:", cErr?.message);
      await creditWallet(wallet.id, amount).catch((e: any) =>
        console.error("[pots/contribute] CRITICAL: wallet refund failed:", e?.message));
      await query(`UPDATE pots SET balance = GREATEST(0, balance - $2) WHERE id = $1`, [pot.id, amount]).catch(() => {});
      await query(`DELETE FROM pot_contributions WHERE pot_id = $1 AND reference = $2`, [pot.id, reference]).catch(() => {});
      throw cErr;
    }

    const balanceAfter = num((await query(`SELECT balance FROM pots WHERE id = $1`, [pot.id])).rows[0]?.balance);

    // Notify the creator (contributor ≠ creator) + target-crossed celebration.
    if (pot.creator_id !== userId) {
      const me = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
      const contributorName = me.rows[0]?.name || "Someone";
      createNotification({
        businessId: (req.user!.businessId ?? "") as string,
        userId: pot.creator_id,
        type: "pot_contribution",
        title: "New pot contribution",
        message: `${contributorName} added ₦${amount.toLocaleString()} to "${String(pot.title).slice(0, 60)}"${note ? `: “${note.slice(0, 60)}”` : ""}`,
        actionUrl: "/splits?tab=pots",
        actionType: "view_pot",
        metadata: { potId: pot.id, contributorId: userId, amount },
      }).catch(() => {});
    }
    if (pot.target_amount !== null && pot.target_amount !== undefined) {
      const target = num(pot.target_amount);
      if (balanceBefore < target && balanceAfter >= target) {
        createNotification({
          businessId: (req.user!.businessId ?? "") as string,
          userId: pot.creator_id,
          type: "pot_target",
          title: "Pot target reached 🎉",
          message: `"${String(pot.title).slice(0, 60)}" hit its ₦${target.toLocaleString()} target — close it to move ₦${balanceAfter.toLocaleString()} to your wallet.`,
          actionUrl: "/splits?tab=pots",
          actionType: "view_pot",
          metadata: { potId: pot.id, balance: balanceAfter },
        }).catch(() => {});
      }
    }

    const freshPot = await loadPot(pot.id);
    res.status(201).json({
      success: true,
      pot: serializePot(freshPot),
      contribution,
    });
  } catch (e: any) {
    console.error("[pots/contribute]", e?.message);
    res.status(500).json({ success: false, error: "Could not contribute to the pot" });
  }
});

// ---------------------------------------------------------------------------
// Close — creator-only payout of the collected balance to their NGN wallet
// ---------------------------------------------------------------------------
router.post("/:id/close", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const pot = await loadPot(req.params.id);
    if (!pot) return res.status(404).json({ success: false, error: "Pot not found" });
    if (pot.creator_id !== userId) {
      return res.status(403).json({ success: false, error: "Only the creator can close this pot" });
    }
    if (pot.status !== "open") {
      return res.status(400).json({ success: false, error: "This pot is already closed" });
    }

    // Claim the pot first (guarded) — a concurrent close loses here.
    const claim = await query(
      `UPDATE pots SET status = 'closed', closed_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'open' RETURNING *`,
      [pot.id],
    );
    if (!claim.rows.length) {
      return res.status(400).json({ success: false, error: "This pot is already closed" });
    }

    const payout = money(num(claim.rows[0].balance));
    try {
      if (payout > 0) {
        const w = await query(
          `SELECT id FROM wallets
            WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active'
            ORDER BY created_at ASC LIMIT 1`,
          [userId],
        );
        const wallet = w.rows[0];
        if (!wallet) throw new Error("NO_NGN_WALLET");

        await creditWallet(wallet.id, payout);
        await insertTransaction({
          userId,
          walletId: wallet.id,
          reference: `POT-PAYOUT-${pot.id}`.slice(0, 255),
          type: "credit",
          transactionType: "pot_payout",
          amount: payout,
          currency: "NGN",
          description: `Group pot payout — ${String(pot.title).slice(0, 80)}`,
        });
      }
      const freshPot = await loadPot(pot.id);
      return res.json({ success: true, pot: serializePot(freshPot) });
    } catch (payoutErr: any) {
      // Revert the close — money must never be stranded in a closed pot.
      await query(
        `UPDATE pots SET status = 'open', closed_at = NULL WHERE id = $1 AND status = 'closed'`,
        [pot.id],
      ).catch(() => {});
      console.error("[pots/close] payout failure:", payoutErr?.message);
      return res.status(500).json({ success: false, error: "Could not pay out the pot — please try again" });
    }
  } catch (e: any) {
    console.error("[pots/close]", e?.message);
    res.status(500).json({ success: false, error: "Could not close the pot" });
  }
});

export default router;
