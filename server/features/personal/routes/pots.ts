import express from "express";
import { randomBytes } from "crypto";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import { insertTransaction, creditWallet, requirePersonalKyc } from "../personal-utils";
import { createNotification } from "../../../services/notifications";
import { sendEmail } from "../../../services/email";
import {
  approversOf,
  computeDueForWithdrawal,
  creditSplitPotWallet,
  debitSplitPotWallet,
  ensureSplitPotWallet,
  executeSplitWalletTransfer,
  loadApproverProfiles,
  loadWalletLedger,
  loadWithdrawalHistory,
  normalizeWithdrawalApprovers,
  notifyWithdrawalApprovers,
  openWithdrawalRequest,
  readWithdrawalDestination,
  reconcileWithdrawalRequest,
  serializeWithdrawalRequest,
} from "../split-pot-wallets";

/**
 * GROUP POTS — shared money pots for events, gifts and launches (mounted at
 * /pots, personal users only).
 *
 * Anyone with the link/context contributes ANY amount from their NGN wallet
 * (NO transaction PIN for v1 — social micro-payments). Contributions land in
 * THE POT'S OWN NGN wallet (NOT the creator's account) — the creator moves
 * the money out via the multi-approval withdrawal flow (or the legacy close
 * sweep when no approvers are configured). Everything is NGN; contributions
 * are idempotent by unique reference.
 *
 * Endpoints:
 *   POST /pots                    → open a pot (+ share token, approvers,
 *                                    invited contributors: participants/emails)
 *   PATCH /pots/:id               → creator edits (title/purpose/target/deadline/
 *                                    withdrawalApprovers/withdrawalDueAt + ADD
 *                                    MORE invited contributors — add-only merge)
 *   GET  /pots/mine               → pots I created + pots I contributed to
 *                                    + pots I'm INVITED to (invited[])
 *   GET  /pots/:id                → detail + contributions + progress + wallet
 *                                    + invitees (the creator's invited list)
 *   POST /pots/:id/contribute     → { amount, note? } wallet-funded contribution
 *                                    (lands in the POT's wallet; an invited
 *                                    contributor flips to 'accepted')
 *   POST /pots/:id/withdrawals    → creator bank withdrawal (multi-approval when
 *                                    approvers are set; else immediate)
 *   GET  /pots/:id/withdrawals    → withdrawal history (creator)
 *   POST /pots/:id/close          → creator-only sweep of the collected balance
 *                                    to their NGN wallet (blocked when approvers
 *                                    are set — use the approval flow instead)
 */

const router = express.Router();

function num(v: any): number { return Number(v) || 0; }
function money(v: number): number { return Math.round(v * 100) / 100; }

// Contexts mirror the splits router — the API's direct/group/page PLUS the
// web composer's dinner/trip/gift/rent/other labels (unknown → "direct").
const CONTEXTS = new Set(["direct", "group", "page", "dinner", "trip", "gift", "rent", "other"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const POT_BASE = `
  SELECT p.*, u.name AS creator_name, u.avatar_url AS creator_avatar,
         LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS creator_username
  FROM pots p JOIN users u ON u.id = p.creator_id
`;

function serializePot(p: any) {
  if (!p) return p;
  const target = p.target_amount === null || p.target_amount === undefined ? null : num(p.target_amount);
  const balance = num(p.balance);
  // Web contract (SplitPots PotRow): `total_contributed` drives the raised
  // figure, `percent`/`remaining` drive the progress bar. The API row only
  // carries `balance`, so every pot response previously rendered ₦0 raised
  // and no progress until the detail sheet was opened.
  return {
    ...p,
    target_amount: target,
    balance,
    total_contributed: balance,
    percent: target !== null && target > 0 ? Math.min(100, Math.round((balance / target) * 100)) : 0,
    remaining: target !== null ? Math.max(0, money(target - balance)) : null,
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
// INVITED CONTRIBUTORS — the same invite model the splits router uses:
// `participants` are user ids (registered accounts, notified in-app) and
// `emails` are either registered accounts (join directly) or pending email
// invites (mailed a join link). Sharing the pot link still lets ANYONE
// contribute — invitees are the people the creator EXPLICITLY asked. The
// list is ADD-ONLY: an edit can invite more people, never silently un-invite
// someone who was asked to chip in. A contributor flips to 'accepted'.
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_POT_INVITEES = 50;

interface PotInviteeSet {
  userIds: string[];
  emails: string[]; // unresolved emails only (registered ones became userIds)
}

// Same non-discriminated result shape the splits router's approver check
// uses (the server tsconfig runs strict:false).
interface PotInviteeResult {
  ok: boolean;
  userIds?: string[];
  emails?: string[];
  error?: string;
  usersInvited?: number;
  emailsInvited?: number;
}

async function parsePotInvitees(
  body: any,
  creatorId: string,
  existingUserIds: Set<string>,
  existingEmails: Set<string>,
): Promise<PotInviteeResult> {
  const rawParticipants = Array.isArray(body?.participants) ? body.participants : [];
  const userIds: string[] = [];
  const seen = new Set(existingUserIds);
  seen.add(creatorId); // never invite the creator themself
  for (const p of rawParticipants) {
    const pid = String(typeof p === "string" ? p : p?.user_id || p?.id || "").trim();
    if (!pid) continue;
    if (!UUID_RE.test(pid)) return { ok: false, error: "Each invited contributor needs a valid user id" };
    if (seen.has(pid)) continue;
    seen.add(pid);
    userIds.push(pid);
  }
  const rawEmails = Array.isArray(body?.emails) ? body.emails : [];
  const emails: string[] = [];
  for (const v of rawEmails) {
    const email = String(v || "").trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL_RE.test(email)) {
      return { ok: false, error: `"${email.slice(0, 60)}" is not a valid email address` };
    }
    if (existingEmails.has(email) || emails.includes(email)) continue;
    emails.push(email);
  }
  if (userIds.length + emails.length > MAX_POT_INVITEES) {
    return { ok: false, error: `A pot can have at most ${MAX_POT_INVITEES} invited contributors` };
  }
  return { ok: true, userIds, emails };
}

/** Registered emails become user invites; unknown ones stay email invites. */
async function resolveInviteEmails(
  emails: string[],
  creatorId: string,
  userIds: string[],
): Promise<PotInviteeSet> {
  if (!emails.length) return { userIds, emails: [] };
  const matched = await query(
    `SELECT id, LOWER(email) AS email FROM users WHERE LOWER(email) = ANY($1::text[])`,
    [emails],
  );
  const byEmail = new Map<string, string>(matched.rows.map((r: any) => [String(r.email), String(r.id)]));
  const emailOnly: string[] = [];
  for (const email of emails) {
    const uid = byEmail.get(email);
    if (uid && uid !== creatorId && !userIds.includes(uid)) userIds.push(uid);
    else if (!uid) emailOnly.push(email);
  }
  return { userIds, emails: emailOnly };
}

async function insertPotInvitees(potId: string, invitedBy: string, userIds: string[], emails: string[]) {
  if (userIds.length) {
    await query(
      `INSERT INTO pot_invitees (pot_id, user_id, invited_by, status)
       SELECT $1, x.uid, $2, 'pending' FROM UNNEST($3::uuid[]) AS x(uid)
       ON CONFLICT (pot_id, user_id) DO NOTHING`,
      [potId, invitedBy, userIds],
    );
  }
  if (emails.length) {
    await query(
      `INSERT INTO pot_invitees (pot_id, email, invited_by, status)
       SELECT $1, x.email, $2, 'pending' FROM UNNEST($3::text[]) AS x(email)
       ON CONFLICT (pot_id, email) DO UPDATE
         SET invited_by = EXCLUDED.invited_by, status = 'pending', created_at = CURRENT_TIMESTAMP`,
      [potId, invitedBy, emails],
    );
  }
}

/** In-app + socket invite for the picked users (the email invites get mail). */
async function notifyPotInvitees(pot: any, creatorName: string, userIds: string[]) {
  for (const uid of userIds) {
    createNotification({
      businessId: null,
      userId: uid,
      type: "pot_invite",
      title: "Pot invite",
      message: `${creatorName} invited you to contribute to "${String(pot.title).slice(0, 60)}"`,
      actionUrl: "/splits?tab=pots",
      actionType: "view_pot",
      isActionable: true,
      metadata: { potId: pot.id },
    }).catch(() => {});
  }
}

async function mailPotInvite(pot: any, creatorName: string, email: string) {
  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL || "https://personal.metricorex.com";
  await sendEmail(
    email,
    "There",
    `${creatorName} invited you to a group pot on MetriCorex`,
    `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <h2 style="margin:0 0 12px">"${String(pot.title).slice(0, 80)}"</h2>
      <p style="color:#374151;line-height:1.6">
        ${creatorName} invited you to chip in to the group pot
        ${pot.purpose ? `for <strong>"${String(pot.purpose).slice(0, 80)}"</strong> ` : ""}on MetriCorex.<br/>
        Sign up or sign in with this email to contribute any amount.
      </p>
      <p style="margin:24px 0">
        <a href="${baseUrl}/splits?tab=pots" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open the pot</a>
      </p>
    </div>`,
  );
}

async function loadPotInvitees(potId: string) {
  const r = await query(
    `SELECT i.id, i.user_id, i.email, i.status, i.created_at,
            u.name AS name, u.avatar_url AS avatar_url,
            LOWER(COALESCE(u.username, SPLIT_PART(u.email, '@', 1))) AS username
       FROM pot_invitees i
       LEFT JOIN users u ON u.id = i.user_id
      WHERE i.pot_id = $1
      ORDER BY i.created_at ASC LIMIT 100`,
    [potId],
  );
  return r.rows.map((row: any) => ({
    id: row.id,
    userId: row.user_id || null,
    email: row.user_id ? null : String(row.email || ""),
    status: row.status,
    name: row.name || null,
    avatarUrl: row.avatar_url || null,
    username: row.username || null,
    invitedAt: row.created_at,
  }));
}

async function existingPotInvitees(potId: string) {
  const r = await query(`SELECT user_id, email FROM pot_invitees WHERE pot_id = $1`, [potId]);
  const userIds = new Set<string>(r.rows.filter((x: any) => x.user_id).map((x: any) => String(x.user_id)));
  const emails = new Set<string>(r.rows.filter((x: any) => x.email).map((x: any) => String(x.email).toLowerCase()));
  return { userIds, emails };
}

/** Parse + resolve + persist + notify one invite batch (create AND edit). */
async function processPotInvitees(
  pot: any,
  creatorId: string,
  creatorName: string,
  body: any,
  existingUserIds: Set<string>,
  existingEmails: Set<string>,
): Promise<PotInviteeResult> {
  const parsed = await parsePotInvitees(body, creatorId, existingUserIds, existingEmails);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const resolved = await resolveInviteEmails(parsed.emails || [], creatorId, parsed.userIds || []);
  if (!resolved.userIds.length && !resolved.emails.length) return { ok: true, usersInvited: 0, emailsInvited: 0 };
  await insertPotInvitees(pot.id, creatorId, resolved.userIds, resolved.emails);
  await notifyPotInvitees(pot, creatorName, resolved.userIds);
  for (const email of resolved.emails) {
    await mailPotInvite(pot, creatorName, email).catch((mailErr: any) =>
      console.error("[pots/invite-email]", mailErr?.message));
  }
  return { ok: true, usersInvited: resolved.userIds.length, emailsInvited: resolved.emails.length };
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

    // Withdrawal approvers (multi-approval) + due date — settable at create
    // AND edit. Creator may be included; any distinct existing user ids.
    const approverCheck = await normalizeWithdrawalApprovers(req.body?.withdrawalApprovers);
    if (!approverCheck.ok) {
      return res.status(400).json({ success: false, error: approverCheck.error });
    }
    let withdrawalDueAt: Date | null = null;
    if (req.body?.withdrawalDueAt) {
      withdrawalDueAt = new Date(req.body.withdrawalDueAt);
      if (isNaN(withdrawalDueAt.getTime())) {
        return res.status(400).json({ success: false, error: "withdrawalDueAt must be a valid date" });
      }
    }

    const shareToken = randomBytes(24).toString("hex");
    const created = await query(
      `INSERT INTO pots (creator_id, title, purpose, currency, target_amount, balance, status, context, context_id, share_token, deadline, withdrawal_approvers, withdrawal_due_at)
       VALUES ($1,$2,$3,'NGN',$4,0,'open',$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
      [userId, title, purpose, targetAmount, context, contextId, shareToken, deadline, JSON.stringify(approverCheck.approvers || []), withdrawalDueAt],
    );
    const pot = created.rows[0];

    // Every pot owns its OWN NGN wallet — contributions land HERE (not the
    // creator's account). Lazily backfilled for older pots too.
    await ensureSplitPotWallet("pot", pot.id).catch((wErr: any) =>
      console.error("[pots/create] pot wallet creation failed (will retry lazily):", wErr?.message));

    // Invited contributors (owner request): create AND edit both accept
    // participants + emails. Unknown emails become pending invites that
    // receive the join mail; registered users are notified in-app.
    let invitedUsers = 0;
    let invitedEmails = 0;
    if (req.body?.participants !== undefined || req.body?.emails !== undefined) {
      const creatorRow = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
      const creatorName = creatorRow.rows[0]?.name || "Someone";
      const invited = await processPotInvitees(pot, userId, creatorName, req.body, new Set(), new Set());
      if (!invited.ok) {
        // The pot exists but the invite list was rejected — surface the
        // validation error instead of leaving the creator guessing.
        return res.status(400).json({ success: false, error: invited.error, potId: pot.id });
      }
      invitedUsers = invited.usersInvited || 0;
      invitedEmails = invited.emailsInvited || 0;
    }

    res.status(201).json({
      success: true,
      pot: serializePot(pot),
      withdrawal_approvers: approversOf(pot),
      invitees: await loadPotInvitees(pot.id).catch(() => []),
      ...(invitedUsers + invitedEmails
        ? { message: `${invitedUsers} contributor${invitedUsers === 1 ? "" : "s"} invited${invitedEmails ? ` · ${invitedEmails} email invite${invitedEmails === 1 ? "" : "s"} sent` : ""}` }
        : {}),
    });
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

    // Pots I was INVITED to contribute to (pending + already chipped in) —
    // the invite landing surface, mirroring the splits "invited" list.
    const invitedPots = await query(
      `SELECT p.*, pu.name AS creator_name, pu.avatar_url AS creator_avatar,
              i.status AS invite_status, i.created_at AS invited_at
         FROM pot_invitees i
         JOIN pots p ON p.id = i.pot_id
         JOIN users pu ON pu.id = p.creator_id
        WHERE i.user_id = $1 AND p.creator_id <> $1
        ORDER BY i.created_at DESC LIMIT 100`,
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
      invited: invitedPots.rows.map((r: any) => ({
        ...serializePot(r),
        invite_status: r.invite_status || "pending",
        invited_at: r.invited_at,
      })),
    });
  } catch (e: any) {
    console.error("[pots/mine]", e?.message);
    res.status(500).json({ success: false, error: "Could not load your pots" });
  }
});

// ---------------------------------------------------------------------------
// Detail + contributions + progress + the pot's OWN wallet (auth required;
// open viewing for v1)
// ---------------------------------------------------------------------------
router.get("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    // Guard the ::uuid cast — a malformed id must 404, not 500 (22P02).
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ success: false, error: "Pot not found" });
    }
    const pot = await loadPot(String(req.params.id));
    if (!pot) return res.status(404).json({ success: false, error: "Pot not found" });

    const contributions = await query(
      `SELECT c.id, c.user_id, c.amount, c.currency, c.note, c.created_at,
              u.name AS display_name, u.avatar_url
         FROM pot_contributions c JOIN users u ON u.id = c.user_id
        WHERE c.pot_id = $1
        ORDER BY c.created_at DESC LIMIT 100`,
      [pot.id],
    );

    // The pot's OWN wallet (balance + last-50 ledger) + open withdrawal request
    // + approver profiles + dueForWithdrawal CTA hint (due = withdrawal_due_at,
    // falling back to the pot deadline).
    let wallet: { id: string; balanceNgn: number; currency: string; ledger: any[] } | null = null;
    let openRequest: any | null = null;
    try {
      const w = await ensureSplitPotWallet("pot", pot.id);
      const [bal, ledger] = await Promise.all([
        query(`SELECT balance FROM wallets WHERE id = $1`, [w.walletId]),
        loadWalletLedger(w.walletId, 50),
      ]);
      wallet = { id: w.walletId, balanceNgn: money(num(bal.rows[0]?.balance)), currency: "NGN", ledger };
      openRequest = await openWithdrawalRequest("pot", pot.id);
      if (openRequest?.status === "executing") {
        openRequest = (await reconcileWithdrawalRequest(openRequest)) || openRequest;
      }
    } catch (wErr: any) {
      console.error("[pots/detail] wallet bundle failed:", wErr?.message);
    }
    const dueAt = pot.withdrawal_due_at || pot.deadline || null;
    const approverIds = approversOf(pot);

    res.json({
      success: true,
      pot: serializePot(pot),
      contributions: contributions.rows.map((r: any) => ({ ...r, amount: num(r.amount) })),
      progress: buildProgress(pot),
      wallet,
      withdrawal_approvers: approverIds,
      withdrawalApprovers: await loadApproverProfiles(approverIds).catch(() =>
        approverIds.map((id) => ({ id, name: null, avatarUrl: null, username: null }))),
      pendingWithdrawal: openRequest ? serializeWithdrawalRequest(openRequest) : null,
      dueForWithdrawal: computeDueForWithdrawal(dueAt, wallet?.balanceNgn || 0, !!openRequest),
      invitees: await loadPotInvitees(pot.id).catch(() => []),
    });
  } catch (e: any) {
    console.error("[pots/detail]", e?.message);
    res.status(500).json({ success: false, error: "Could not load the pot" });
  }
});

// ---------------------------------------------------------------------------
// Edit (creator only) — replica of creation for the editable fields, most
// importantly the withdrawal approvers (multi-approval config) + due date.
// ---------------------------------------------------------------------------
router.patch("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ success: false, error: "Pot not found" });
    }
    const pot = await loadPot(String(req.params.id));
    if (!pot) return res.status(404).json({ success: false, error: "Pot not found" });
    if (pot.creator_id !== userId) {
      return res.status(403).json({ success: false, error: "Only the creator can edit this pot" });
    }

    const sets: string[] = [];
    const params: any[] = [];

    if (req.body?.title !== undefined) {
      const title = String(req.body.title || "").trim();
      if (title.length < 3 || title.length > 140) {
        return res.status(400).json({ success: false, error: "Title must be between 3 and 140 characters" });
      }
      params.push(title); sets.push(`title = $${params.length}`);
    }
    if (req.body?.purpose !== undefined) {
      params.push(String(req.body.purpose || "").trim().slice(0, 500) || null);
      sets.push(`purpose = $${params.length}`);
    }
    if (req.body?.target_amount !== undefined) {
      const raw = String(req.body.target_amount).trim();
      const target = raw === "" ? null : money(num(req.body.target_amount));
      if (target !== null && !(target > 0)) {
        return res.status(400).json({ success: false, error: "target_amount must be greater than 0" });
      }
      params.push(target); sets.push(`target_amount = $${params.length}`);
    }
    if (req.body?.deadline !== undefined) {
      if (req.body.deadline === null || req.body.deadline === "") {
        params.push(null); sets.push(`deadline = $${params.length}`);
      } else {
        const d = new Date(req.body.deadline);
        if (isNaN(d.getTime())) return res.status(400).json({ success: false, error: "deadline must be a valid date" });
        params.push(d); sets.push(`deadline = $${params.length}`);
      }
    }
    if (req.body?.withdrawalApprovers !== undefined) {
      const check = await normalizeWithdrawalApprovers(req.body.withdrawalApprovers);
      if (!check.ok) return res.status(400).json({ success: false, error: check.error });
      params.push(JSON.stringify(check.approvers || [])); sets.push(`withdrawal_approvers = $${params.length}::jsonb`);
    }
    if (req.body?.withdrawalDueAt !== undefined) {
      if (req.body.withdrawalDueAt === null || req.body.withdrawalDueAt === "") {
        params.push(null); sets.push(`withdrawal_due_at = $${params.length}`);
      } else {
        const d = new Date(req.body.withdrawalDueAt);
        if (isNaN(d.getTime())) return res.status(400).json({ success: false, error: "withdrawalDueAt must be a valid date" });
        params.push(d); sets.push(`withdrawal_due_at = $${params.length}`);
      }
    }

    // Invite MORE contributors (add-only merge): the same participants +
    // emails payload the create endpoint takes — nobody already invited is
    // re-notified, and the list never silently drops people.
    let invitedUsers = 0;
    let invitedEmails = 0;
    if (req.body?.participants !== undefined || req.body?.emails !== undefined) {
      const existing = await existingPotInvitees(pot.id);
      const creatorRow = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
      const creatorName = creatorRow.rows[0]?.name || "Someone";
      const invited = await processPotInvitees(pot, userId, creatorName, req.body, existing.userIds, existing.emails);
      if (!invited.ok) return res.status(400).json({ success: false, error: invited.error });
      invitedUsers = invited.usersInvited || 0;
      invitedEmails = invited.emailsInvited || 0;
    }

    if (!sets.length && !invitedUsers && !invitedEmails) {
      return res.status(400).json({ success: false, error: "Nothing to update — send title, purpose, target_amount, deadline, withdrawalApprovers, withdrawalDueAt, participants and/or emails" });
    }
    if (sets.length) {
      params.push(pot.id);
      await query(`UPDATE pots SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    }

    const fresh = await loadPot(pot.id);
    res.json({
      success: true,
      pot: serializePot(fresh),
      withdrawal_approvers: approversOf(fresh),
      invitees: await loadPotInvitees(pot.id).catch(() => []),
      ...(invitedUsers + invitedEmails
        ? { message: `${invitedUsers} contributor${invitedUsers === 1 ? "" : "s"} invited${invitedEmails ? ` · ${invitedEmails} email invite${invitedEmails === 1 ? "" : "s"} sent` : ""}` }
        : {}),
    });
  } catch (e: any) {
    console.error("[pots/edit]", e?.message);
    res.status(500).json({ success: false, error: "Could not update the pot" });
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

    // Guard the ::uuid cast — a malformed id must 404, not 500 (22P02).
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ success: false, error: "Pot not found" });
    }
    const pot = await loadPot(String(req.params.id));
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
      // CREDIT THE POT'S OWN WALLET (owner directive): the contribution lands
      // in THIS pot's NGN wallet — NOT the creator's account. Inside the same
      // guard: a failure here refunds the contributor and rolls everything back.
      const potWallet = await ensureSplitPotWallet("pot", pot.id);
      await creditSplitPotWallet({
        walletId: potWallet.walletId,
        ownerType: "pot",
        ownerId: pot.id,
        amount,
        reason: "contribution",
        reference: `${reference}-TO-POT-WALLET`.slice(0, 255),
        metadata: { potId: pot.id, contributorId: userId, contributionReference: reference, creatorId: pot.creator_id },
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

    // An invited contributor who chips in flips to 'accepted' (best-effort —
    // a missed flip never blocks the money).
    await query(
      `UPDATE pot_invitees SET status = 'accepted'
        WHERE pot_id = $1 AND user_id = $2 AND status <> 'accepted'`,
      [pot.id, userId],
    ).catch(() => {});

    // Notify the creator (contributor ≠ creator) + target-crossed celebration.
    if (pot.creator_id !== userId) {
      const me = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
      const contributorName = me.rows[0]?.name || "Someone";
      createNotification({
        businessId: null,
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
          businessId: null,
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
    // Guard the ::uuid cast — a malformed id must 404, not 500 (22P02).
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ success: false, error: "Pot not found" });
    }
    const pot = await loadPot(String(req.params.id));
    if (!pot) return res.status(404).json({ success: false, error: "Pot not found" });
    if (pot.creator_id !== userId) {
      return res.status(403).json({ success: false, error: "Only the creator can close this pot" });
    }
    if (pot.status !== "open") {
      return res.status(400).json({ success: false, error: "This pot is already closed" });
    }

    // MULTI-APPROVAL: a pot with withdrawal approvers must move its money out
    // through the approval flow — closing must not bypass the approvers.
    const approvers = approversOf(pot);
    if (approvers.length) {
      return res.status(409).json({
        success: false,
        code: "APPROVAL_REQUIRED",
        error: "This pot has withdrawal approvers — request a withdrawal instead so they can approve it",
        data: { withdrawal_approvers: approvers },
      });
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

        // Fund the payout from the pot's OWN wallet first (contributions land
        // there since the wallet model); the remainder continues the legacy
        // settlement for contributions made before the pot had a wallet.
        const potWallet = await ensureSplitPotWallet("pot", pot.id);
        const walletBalRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [potWallet.walletId]);
        const walletBalance = money(num(walletBalRes.rows[0]?.balance));
        const fromWallet = Math.min(walletBalance, payout);
        const remainder = money(Math.max(0, payout - fromWallet));
        const closeAttempt = Date.now().toString(36);

        // Track exactly how much reached the creator's wallet so a mid-flight
        // failure can pull every naira back before the close is reverted.
        let credited = 0;
        if (fromWallet > 0) {
          // Per-attempt reference: a retried close (after a compensated failure)
          // is a DISTINCT sweep that must get its own ledger row — a shared
          // deterministic reference would swallow the retry's bookkeeping.
          const sweptRef = `POT-CLOSE-${pot.id}-${closeAttempt}`.slice(0, 255);
          const swept = await debitSplitPotWallet({
            walletId: potWallet.walletId,
            ownerType: "pot",
            ownerId: pot.id,
            amount: fromWallet,
            reason: "pot_close",
            reference: sweptRef,
            metadata: { potId: pot.id, creatorId: userId, payout, fromWallet, remainder },
          });
          if (!swept.ok) throw new Error("Could not debit the pot wallet for the payout");
          try {
            if (remainder > 0) {
              await creditWallet(wallet.id, remainder);
              credited = money(credited + remainder);
            }
            await creditWallet(wallet.id, fromWallet);
            credited = money(credited + fromWallet);
          } catch (creditErr: any) {
            // Compensate BOTH sides before failing — money must never vanish
            // (or double-land) mid-sweep.
            await creditSplitPotWallet({
              walletId: potWallet.walletId,
              ownerType: "pot",
              ownerId: pot.id,
              amount: fromWallet,
              reason: "pot_close",
              reference: `${sweptRef}-REFUND`.slice(0, 255),
              metadata: { potId: pot.id, note: "Payout credit failed — swept back" },
            }).catch((rbErr: any) => console.error("[pots/close] CRITICAL: sweep-back failed:", rbErr?.message));
            if (credited > 0) {
              await query(
                `UPDATE wallets SET balance = GREATEST(0, balance - $1), updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [credited, wallet.id],
              ).catch((pbErr: any) => console.error("[pots/close] CRITICAL: creator pull-back failed:", pbErr?.message));
            }
            throw creditErr;
          }
        } else if (remainder > 0) {
          // Legacy pot (contributions predate the wallet model — the money only
          // ever existed as the pots.balance counter): pay the creator straight
          // from the platform float, exactly like the pre-wallet close did.
          await creditWallet(wallet.id, remainder);
          credited = remainder;
        }
        await insertTransaction({
          userId,
          walletId: wallet.id,
          // Per-attempt reference — a retried close must never collide with the
          // previous attempt's (globally unique) transaction row.
          reference: `POT-PAYOUT-${pot.id}-${closeAttempt}`.slice(0, 255),
          type: "credit",
          transactionType: "pot_payout",
          amount: payout,
          currency: "NGN",
          description: `Group pot payout — ${String(pot.title).slice(0, 80)}`,
        });
      }
      const freshPot = await loadPot(pot.id);
      // `payout` — the web SplitPots close toast reads it
      // (r.data?.payout ?? r.data?.data?.payout ?? ...); without it the toast
      // always showed ₦0.00 even when the wallet credit succeeded.
      return res.json({ success: true, pot: serializePot(freshPot), payout });
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

// ---------------------------------------------------------------------------
// WITHDRAWALS — money leaves THIS pot's own wallet (NGN), never the creator's
// account.
//   POST /:id/withdrawals   → creator requests a bank payout. Approvers set →
//                             withdrawal REQUEST (multi-approval); none set →
//                             executes immediately on the single-transfer rails.
//   GET  /:id/withdrawals   → withdrawal history (creator only — bank details).
// Approve/decline/pending-inbox live on the shared /withdrawals router.
// ---------------------------------------------------------------------------
router.post("/:id/withdrawals", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ success: false, error: "Pot not found" });
    }
    const pot = await loadPot(String(req.params.id));
    if (!pot) return res.status(404).json({ success: false, error: "Pot not found" });
    if (pot.creator_id !== userId) {
      return res.status(403).json({ success: false, error: "Only the creator can withdraw from this pot" });
    }

    const wallet = await ensureSplitPotWallet("pot", pot.id);

    // One open request at a time per pot — but an APPROVED request whose
    // execution died between approval and dispatch is RESUMED here instead of
    // deadlocking the pot behind it.
    const open = await openWithdrawalRequest("pot", pot.id);
    if (open && open.status !== "approved") {
      return res.status(409).json({
        success: false,
        code: "WITHDRAWAL_IN_PROGRESS",
        error: `A withdrawal for this pot is already ${open.status} — it must finish before another can start`,
        data: { request: serializeWithdrawalRequest(open) },
      });
    }

    let request = open;
    if (!open) {
      const amount = money(num(req.body?.amount));
      if (!(amount > 0)) {
        return res.status(400).json({ success: false, error: "amount must be greater than 0" });
      }
      const dest = readWithdrawalDestination(req.body);
      if (!dest.ok) return res.status(400).json({ success: false, error: dest.error });
      if (amount > wallet.balance) {
        return res.status(400).json({
          success: false,
          code: "INSUFFICIENT_BALANCE",
          error: `The pot wallet holds ₦${wallet.balance.toLocaleString()} — you cannot withdraw ₦${amount.toLocaleString()}`,
        });
      }

      const approvers = approversOf(pot);
      const requester = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
      const requesterName = requester.rows[0]?.name || "Someone";
      const d = dest.value;

      const ins = await query(
        `INSERT INTO withdrawal_requests
           (owner_type, owner_id, wallet_id, requested_by, amount, currency, note,
            bank_code, bank_name, account_number, account_name, recipient_code,
            status, approvers, approvals)
         VALUES ('pot',$1,$2,$3,$4,'NGN',$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'[]'::jsonb)
         RETURNING *`,
        [
          pot.id, wallet.walletId, userId, amount, d.note,
          d.bank_code, d.bank_name, d.account_number, d.account_name, d.recipient_code,
          approvers.length ? "pending" : "approved",
          JSON.stringify(approvers),
        ],
      );
      request = ins.rows[0];

      if (approvers.length) {
        // MULTI-APPROVAL: park as a REQUEST and notify every approver.
        await notifyWithdrawalApprovers(request, { ownerName: pot.title, requesterName });
        return res.status(201).json({
          success: true,
          data: {
            request: serializeWithdrawalRequest(request),
            wallet: { id: wallet.walletId, balanceNgn: wallet.balance, currency: "NGN" },
            approvalsRequired: approvers.length,
            message: `Withdrawal request sent to ${approvers.length} approver${approvers.length === 1 ? "" : "s"} — it executes when everyone approves`,
          },
        });
      }
    } else {
      // Resuming a stuck APPROVED request — the stored amount must still fit.
      const resumeAmount = money(num(open.amount));
      if (resumeAmount > wallet.balance) {
        return res.status(400).json({
          success: false,
          code: "INSUFFICIENT_BALANCE",
          error: `The pot wallet now holds ₦${wallet.balance.toLocaleString()} — the pending ₦${resumeAmount.toLocaleString()} withdrawal can no longer be funded`,
        });
      }
    }

    // NO approvers configured (or resuming an approved request) → execute via
    // the single-transfer clone with THIS pot's wallet as the source of funds.
    const executed = await executeSplitWalletTransfer(request, userId, { ownerName: pot.title });
    const balRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [wallet.walletId]);
    return res.status(201).json({
      success: executed.request.status !== "failed",
      data: {
        request: serializeWithdrawalRequest(executed.request),
        wallet: { id: wallet.walletId, balanceNgn: money(num(balRes.rows[0]?.balance)), currency: "NGN" },
        transfer: executed.payout
          ? {
              reference: executed.payout.reference,
              status: executed.payout.status,
              failureReason: executed.payout.failure_reason || null,
            }
          : null,
        message: executed.request.status === "completed"
          ? "Withdrawal completed"
          : executed.request.status === "executing"
            ? "Withdrawal is processing — you'll be notified when it settles"
            : executed.request.failure_reason || "Withdrawal failed — the money is back in the pot wallet",
      },
    });
  } catch (e: any) {
    if (e?.code === "NOT_EXECUTABLE") {
      return res.status(409).json({ success: false, code: e.code, error: e.message });
    }
    console.error("[pots/withdrawals]", e?.message);
    res.status(500).json({ success: false, error: "Could not create the withdrawal" });
  }
});

router.get("/:id/withdrawals", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ success: false, error: "Pot not found" });
    }
    const pot = await loadPot(String(req.params.id));
    if (!pot) return res.status(404).json({ success: false, error: "Pot not found" });
    if (pot.creator_id !== userId) {
      return res.status(403).json({ success: false, error: "Only the creator can view this pot's withdrawals" });
    }

    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const history = await loadWithdrawalHistory("pot", pot.id, limit);
    const wallet = await ensureSplitPotWallet("pot", pot.id);
    const approverIds = approversOf(pot);

    res.json({
      success: true,
      data: {
        withdrawals: history,
        wallet: { id: wallet.walletId, balanceNgn: wallet.balance, currency: "NGN" },
        withdrawal_approvers: approverIds,
        withdrawalApprovers: await loadApproverProfiles(approverIds).catch(() =>
          approverIds.map((id) => ({ id, name: null, avatarUrl: null, username: null }))),
      },
    });
  } catch (e: any) {
    console.error("[pots/withdrawals/history]", e?.message);
    res.status(500).json({ success: false, error: "Could not load withdrawal history" });
  }
});

export default router;
