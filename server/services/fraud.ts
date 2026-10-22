import { query } from "../db";
import { createNotification } from "./notifications";
import { sendEmail } from "./email";
import { creditRevenueWallet, debitPlatformWallet } from "./fees";

/**
 * FRAUD ENGINE — rules-based evaluation for every inflow and outflow.
 *
 * Decisions (max action wins; reject > hold > flag > allow):
 *   allow — proceed untouched (an evaluation row is still recorded)
 *   flag  — proceed, open a fraud case for human review
 *   hold  — do NOT move money; open case + auto due-diligence case; user notified
 *   reject— do NOT move money; open case for the audit trail
 *
 * Fail-open with alarm: an engine crash records decision 'system_error' and
 * lets the caller proceed — availability beats false positives.
 *
 * Held flows are marked on their OWN rows:
 *   - outflow transfers: transfer_queue.status = 'held' (never picked up by
 *     processAllPending, wallet never debited)
 *   - inflow funding:    transactions.status = 'held' (creditWalletFunding...
 *     skips the credit; release re-runs the audited credit path)
 */

export type FraudDecision = 'allow' | 'flag' | 'hold' | 'reject';
const DECISION_RANK: Record<FraudDecision, number> = { allow: 0, flag: 1, hold: 2, reject: 3 };

export interface FraudContext {
  direction: 'inflow' | 'outflow';
  flow: string;                    // transfer | bill | giftcard | funding | withdrawal | esim
  userId?: string | null;
  businessId?: string | null;
  walletId?: string | null;
  amount: number;
  currency?: string;
  reference?: string | null;
  transactionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
  beneficiary?: { accountNumber?: string | null; bankCode?: string | null; accountName?: string | null } | null;
  channel?: string | null;
}

export interface FraudResult {
  decision: FraudDecision;
  score: number;
  matched: Array<{ code: string; name: string; action: FraudDecision; weight: number; threshold: any }>;
  evaluationId: string | null;
  caseId: string | null;
  dueDiligenceId: string | null;
}

// ---------------------------------------------------------------------------
// Rule cache (60s) — admin edits apply within a minute, no deploy.
// ---------------------------------------------------------------------------
interface FraudRule { id: string; code: string; name: string; description: string; direction: string; category: string; is_enabled: boolean; action: FraudDecision; threshold: any; weight: number; priority: number; }
let ruleCache: { rules: FraudRule[]; loadedAt: number } | null = null;
const RULE_TTL_MS = 60_000;

async function loadRules(): Promise<FraudRule[]> {
  if (ruleCache && Date.now() - ruleCache.loadedAt < RULE_TTL_MS) return ruleCache.rules;
  try {
    const res = await query(`SELECT * FROM fraud_rules WHERE is_enabled = TRUE ORDER BY priority ASC`);
    const rules = res.rows.map((r: any) => ({ ...r, threshold: r.threshold || {} }));
    ruleCache = { rules, loadedAt: Date.now() };
    return rules;
  } catch (e) {
    console.error('[fraud] rule load failed:', (e as any)?.message);
    return ruleCache?.rules || [];
  }
}
export const invalidateFraudRuleCache = () => { ruleCache = null; };

// ---------------------------------------------------------------------------
// Aggregates (best-effort; any failure simply skips the dependent rules)
// ---------------------------------------------------------------------------
async function pgSafe<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try { return await fn(); } catch (e) { console.warn(`[fraud] aggregate ${label} failed:`, (e as any)?.message?.substring?.(0, 120)); return fallback; }
}

interface Aggregates {
  outCount24h: number; outCount1h: number; outSum24h: number; outSum6h: number;
  inCount24h: number; inSum24h: number; inSum1h: number; inSum6h: number; inDistinctSenders24h: number;
  structuringCount: number; nearLimitCeiling: number;
  nightCount30d: number; meanFunding90d: number; reversalCount90d: number;
  lastFundingAt: string | null; accountCreatedAt: string | null;
  deviceSeen: boolean; ipSeen: boolean; lastSeenAt: string | null;
  beneficiaryIsNew: boolean; beneficiarySenderCount24h: number;
}

async function gatherAggregates(ctx: FraudContext): Promise<Aggregates> {
  const ownerFilter = ctx.businessId ? ['business_id = $1', ctx.businessId] : (ctx.userId ? ['user_id = $1', ctx.userId] : [null as any, null as any]);
  const ownerCol = ownerFilter[0] || 'FALSE';
  const ownerVal: any = ownerFilter[1];
  const ownerIdx = ownerFilter[1] !== undefined && ownerFilter[0] ? 1 : 0;
  const A: Aggregates = {
    outCount24h: 0, outCount1h: 0, outSum24h: 0, outSum6h: 0,
    inCount24h: 0, inSum24h: 0, inSum1h: 0, inSum6h: 0, inDistinctSenders24h: 0,
    structuringCount: 0, nearLimitCeiling: 2000000,
    nightCount30d: 0, meanFunding90d: 0, reversalCount90d: 0,
    lastFundingAt: null, accountCreatedAt: null,
    deviceSeen: false, ipSeen: false, lastSeenAt: null,
    beneficiaryIsNew: false, beneficiarySenderCount24h: 0,
  };

  if (ownerIdx === 0) return A; // no owner — nothing to aggregate

  // Outflow aggregates (debit rows pending through success)
  await pgSafe(async () => {
    const r = await query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS c24,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')  AS c1,
         COALESCE(SUM(amount) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0) AS s24,
         COALESCE(SUM(amount) FILTER (WHERE created_at > NOW() - INTERVAL '6 hours'), 0) AS s6,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'
                           AND amount >= $2 AND amount < $3) AS struct,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'
                           AND EXTRACT(HOUR FROM (created_at AT TIME ZONE 'Africa/Lagos')) < 5) AS night30
       FROM transactions
       WHERE ${ownerCol} AND direction = 'debit'
         AND status IN ('success','processing','pending','held')`,
      [ownerVal, 0.9 * 2000000, 2000000],
    );
    const row = r.rows[0] || {};
    A.outCount24h = parseInt(row.c24 || 0); A.outCount1h = parseInt(row.c1 || 0);
    A.outSum24h = parseFloat(row.s24 || 0); A.outSum6h = parseFloat(row.s6 || 0);
    A.structuringCount = parseInt(row.struct || 0);
    A.nightCount30d = parseInt(row.night30 || 0);
  }, undefined, 'outflow');

  // Inflow aggregates (successful fundings)
  await pgSafe(async () => {
    const r = await query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS c24,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')  AS c1,
         COALESCE(SUM(amount) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0) AS s24,
         COALESCE(SUM(amount) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour'), 0) AS s1,
         COALESCE(SUM(amount) FILTER (WHERE created_at > NOW() - INTERVAL '6 hours'), 0) AS s6,
         COALESCE(AVG(amount) FILTER (WHERE created_at > NOW() - INTERVAL '90 days'), 0) AS mean90,
         MAX(created_at) AS last_at,
         COUNT(*) FILTER (WHERE description ILIKE '%revers%' AND created_at > NOW() - INTERVAL '90 days') AS reversals,
         COUNT(DISTINCT COALESCE(gateway_response->'data'->>'sender_name', reference))
           FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS senders24
       FROM transactions
       WHERE ${ownerCol} AND direction = 'credit' AND transaction_type = 'wallet_funding'
         AND status IN ('success','held')`,
      [ownerVal],
    );
    const row = r.rows[0] || {};
    A.inCount24h = parseInt(row.c24 || 0); A.inSum24h = parseFloat(row.s24 || 0);
    A.inSum1h = parseFloat(row.s1 || 0); A.inSum6h = parseFloat(row.s6 || 0); A.meanFunding90d = parseFloat(row.mean90 || 0);
    A.lastFundingAt = row.last_at || null; A.reversalCount90d = parseInt(row.reversals || 0);
    A.inDistinctSenders24h = parseInt(row.senders24 || 0);
  }, undefined, 'inflow');

  // Account age
  await pgSafe(async () => {
    if (ctx.businessId) {
      const r = await query(`SELECT created_at FROM businesses WHERE id = $1`, [ctx.businessId]);
      A.accountCreatedAt = r.rows[0]?.created_at || null;
    } else if (ctx.userId) {
      const r = await query(`SELECT created_at FROM users WHERE id = $1`, [ctx.userId]);
      A.accountCreatedAt = r.rows[0]?.created_at || null;
    }
  }, undefined, 'account-age');

  // Device / IP familiarity (self-maintained history)
  if (ctx.userId) {
    await pgSafe(async () => {
      if (ctx.deviceId) {
        const r = await query(`SELECT 1 FROM fraud_seen_contexts WHERE user_id = $1 AND kind = 'device' AND value = $2 LIMIT 1`, [ctx.userId, ctx.deviceId]);
        A.deviceSeen = r.rows.length > 0;
      }
      if (ctx.ip) {
        const r = await query(`SELECT 1 FROM fraud_seen_contexts WHERE user_id = $1 AND kind = 'ip' AND value = $2 LIMIT 1`, [ctx.userId, ctx.ip]);
        A.ipSeen = r.rows.length > 0;
      }
      // remember current contexts (first-party history, best effort)
      if (ctx.deviceId) {
        await query(`INSERT INTO fraud_seen_contexts (user_id, kind, value) VALUES ($1,'device',$2) ON CONFLICT DO NOTHING`, [ctx.userId, ctx.deviceId]).catch(() => {});
      }
      if (ctx.ip) {
        await query(`INSERT INTO fraud_seen_contexts (user_id, kind, value) VALUES ($1,'ip',$2) ON CONFLICT DO NOTHING`, [ctx.userId, ctx.ip]).catch(() => {});
      }
    }, undefined, 'device-ip');
  }

  // Beneficiary novelty + collect velocity
  if (ctx.beneficiary?.accountNumber) {
    const acct = String(ctx.beneficiary.accountNumber);
    await pgSafe(async () => {
      const r = await query(
        `SELECT
           COUNT(*) FILTER (WHERE owner_scope = $2 AND owner_id::text = $3) AS known,
           (SELECT COUNT(DISTINCT business_id) FROM transfer_beneficiaries
             WHERE account_number = $1 AND created_at > NOW() - INTERVAL '24 hours') AS senders24
         FROM transfer_beneficiaries WHERE account_number = $1`,
        [acct, ctx.businessId ? 'business' : 'user', String(ctx.businessId || ctx.userId)],
      );
      const row = r.rows[0] || {};
      A.beneficiaryIsNew = parseInt(row.known || 0) === 0;
      A.beneficiarySenderCount24h = parseInt(row.senders24 || 0);
    }, undefined, 'beneficiary');
  }

  return A;
}

// ---------------------------------------------------------------------------
// Rule matchers
// ---------------------------------------------------------------------------
function matchRule(rule: FraudRule, ctx: FraudContext, A: Aggregates): boolean {
  const t = rule.threshold || {};
  const amt = Number(ctx.amount) || 0;
  switch (rule.code) {
    case 'OUT_BLACKLIST':
      return false; // handled directly via isBlacklisted() before matching
    case 'IN_BLACKLIST_FUNDING':
      return false;
    case 'OUT_AMT_LIMIT_HARD': return amt > Number(t.amount || Infinity);
    case 'OUT_AMT_LIMIT_REVIEW': return amt > Number(t.amount || Infinity);
    case 'OUT_VELOCITY_COUNT_1H': return A.outCount1h > Number(t.count ?? 10);
    case 'OUT_VELOCITY_COUNT_24H': return A.outCount24h > Number(t.count ?? 25);
    case 'OUT_VELOCITY_SUM_24H': return A.outSum24h > Number(t.amount ?? Infinity);
    case 'OUT_STRUCTURING': return A.structuringCount >= Number(t.count ?? 3);
    case 'OUT_NIGHT_OWL_LARGE': {
      const hour = new Date().getHours();
      return hour < 5 && amt > Number(t.amount || Infinity) && A.nightCount30d === 0;
    }
    case 'OUT_NEW_BENEFICIARY_LARGE':
      return !!ctx.beneficiary && A.beneficiaryIsNew && amt > Number(t.amount || Infinity);
    case 'OUT_NEW_BENEFICIARY_XLARGE':
      return !!ctx.beneficiary && A.beneficiaryIsNew && amt > Number(t.amount || Infinity);
    case 'OUT_BENEFICIARY_VELOCITY':
      return A.beneficiaryIsNew && A.beneficiarySenderCount24h >= Number(t.senders ?? 3) - 1; // -1: current sender included in count
    case 'OUT_DEVICE_CHANGE_LARGE':
      return !!ctx.userId && amt > Number(t.amount || Infinity) && (!!ctx.deviceId ? !A.deviceSeen : !!ctx.ip && !A.ipSeen);
    case 'OUT_IMPOSSIBLE_TRAVEL':
      return false; // fires only when coordinates provided (see evaluateGeo rule below)
    case 'OUT_MULE_IN_OUT':
      return A.inSum6h > 0 && (A.outSum6h / A.inSum6h) >= Number(t.ratio ?? 0.7) && A.inSum6h > 1000;
    case 'OUT_ACCOUNT_AGE': {
      if (!A.accountCreatedAt) return false;
      const ageH = (Date.now() - new Date(A.accountCreatedAt).getTime()) / 3_600_000;
      return ageH < Number(t.age_hours ?? 24) && A.outSum24h > Number(t.amount || Infinity);
    }
    case 'IN_VELOCITY_COUNT_24H': return A.inCount24h > Number(t.count ?? 30);
    case 'IN_MULE_PATTER': return A.inDistinctSenders24h >= Number(t.senders ?? 5);
    case 'IN_RAPID_PUMP': return A.inSum1h > Number(t.amount || Infinity);
    case 'IN_AMT_ANOMALY':
      return A.meanFunding90d > 0 && amt > Number(t.mean_multiplier ?? 20) * A.meanFunding90d;
    case 'IN_REVERSAL_ABUSE': return A.reversalCount90d >= Number(t.count ?? 2);
    case 'IN_DORMANT_JUMP': {
      if (!A.lastFundingAt || !A.accountCreatedAt) return false;
      const dormantDays = (Date.now() - new Date(A.lastFundingAt).getTime()) / 86_400_000;
      return dormantDays >= Number(t.dormant_days ?? 90) && amt > Number(t.amount || Infinity);
    }
    default:
      return false;
  }
}

async function isBlacklisted(ctx: FraudContext): Promise<boolean> {
  const vals: Array<[string, string]> = [];
  if (ctx.userId) vals.push(['user', String(ctx.userId)]);
  if (ctx.businessId) vals.push(['business', String(ctx.businessId)]);
  if (ctx.ip) vals.push(['ip', String(ctx.ip)]);
  if (ctx.deviceId) vals.push(['device', String(ctx.deviceId)]);
  if (ctx.beneficiary?.accountNumber) vals.push(['bank_account', String(ctx.beneficiary.accountNumber)]);
  if (vals.length === 0) return false;
  try {
    const conditions = vals.map((_, i) => `(type = $${i * 2 + 1} AND value = $${i * 2 + 2})`).join(' OR ');
    const params = vals.flat();
    const r = await query(`SELECT 1 FROM fraud_blacklists WHERE ${conditions} LIMIT 1`, params);
    return r.rows.length > 0;
  } catch (e) {
    console.warn('[fraud] blacklist check failed:', (e as any)?.message?.substring?.(0, 120));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Recording + cases
// ---------------------------------------------------------------------------
async function recordEvaluation(ctx: FraudContext, decision: string, score: number,
                                matched: FraudResult['matched']): Promise<string | null> {
  try {
    const r = await query(
      `INSERT INTO fraud_evaluations
        (transaction_id, transfer_reference, direction, flow, user_id, business_id, wallet_id,
         amount, currency, context, score, decision, matched_rules)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb) RETURNING id`,
      [ctx.transactionId || null, ctx.reference || null, ctx.direction, ctx.flow,
       ctx.userId || null, ctx.businessId || null, ctx.walletId || null,
       ctx.amount, ctx.currency || 'NGN',
       JSON.stringify({ ip: ctx.ip, userAgent: ctx.userAgent, deviceId: ctx.deviceId,
                        beneficiary: ctx.beneficiary, channel: ctx.channel }),
       score, decision, JSON.stringify(matched)],
    );
    return r.rows[0]?.id || null;
  } catch (e) {
    console.error('[fraud] evaluation record failed:', (e as any)?.message);
    return null;
  }
}

async function openCase(ctx: FraudContext, evaluationId: string | null, matched: FraudResult['matched'],
                        requireDueDiligence: boolean): Promise<{ caseId: string | null; ddId: string | null }> {
  let caseId: string | null = null;
  let ddId: string | null = null;
  try {
    const r = await query(
      `INSERT INTO fraud_cases
        (evaluation_id, transaction_id, transfer_reference, direction, flow, user_id, business_id,
         amount, currency, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open') RETURNING id`,
      [evaluationId, ctx.transactionId || null, ctx.reference || null, ctx.direction, ctx.flow,
       ctx.userId || null, ctx.businessId || null, ctx.amount, ctx.currency || 'NGN'],
    );
    caseId = r.rows[0]?.id || null;

    if (caseId && requireDueDiligence) {
      const expires = new Date(Date.now() + 14 * 86_400_000);
      const dd = await query(
        `INSERT INTO due_diligence_cases (fraud_case_id, user_id, business_id, status, expires_at)
         VALUES ($1,$2,$3,'pending',$4) RETURNING id`,
        [caseId, ctx.userId || null, ctx.businessId || null, expires],
      );
      ddId = dd.rows[0]?.id || null;
      if (ddId && caseId) {
        await query(`UPDATE fraud_cases SET due_diligence_id = $1 WHERE id = $2`, [ddId, caseId]);
      }
    }
  } catch (e) {
    console.error('[fraud] case opening failed:', (e as any)?.message);
  }

  // Notify the user (best-effort, never blocks the flow)
  if (ctx.userId && (ctx.businessId || ctx.userId)) {
    try {
      const amountStr = `${ctx.currency || 'NGN'} ${Number(ctx.amount).toLocaleString()}`;
      if (requireDueDiligence) {
        await createNotification({
          businessId: String(ctx.businessId || ''),
          userId: String(ctx.userId),
          type: 'fraud_hold',
          title: 'Transaction under review',
          message: `A ${ctx.flow.replace('_', ' ')} of ${amountStr} is on hold for a quick security check. Complete verification to release it.`,
          actionUrl: '/due-diligence',
          actionType: 'due_diligence',
          isActionable: true,
          expiresInHours: 336,
        });
        const u = await query(`SELECT email, name FROM users WHERE id = $1`, [ctx.userId]);
        const to = u.rows[0]?.email;
        if (to) {
          const { sendEmail: sendMail, generateBroadcastEmailHtml } = await import('./email');
          const html = generateBroadcastEmailHtml(
            u.rows[0]?.name || 'there',
            'Action required: verify a held transaction',
            `A ${ctx.flow.replace('_', ' ')} of ${amountStr} is on hold for a quick security check. ` +
            `Please open the app and complete the short verification form so we can release it.`,
          );
          await sendMail({
            sender: { name: 'Metricorex', email: 'no-reply@metricorex.com' },
            to: [{ email: to, name: u.rows[0]?.name || 'there' }],
            subject: 'Action required: verify a held transaction',
            htmlContent: html,
          });
        }
      }
    } catch (e) {
      console.warn('[fraud] user notification failed:', (e as any)?.message?.substring?.(0, 140));
    }
  }

  return { caseId, ddId };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function evaluate(ctx: FraudContext): Promise<FraudResult> {
  const empty: FraudResult = { decision: 'allow', score: 0, matched: [], evaluationId: null, caseId: null, dueDiligenceId: null };
  try {
    const rules = await loadRules();
    if (rules.length === 0) return empty;

    // Blacklist short-circuit (reject outflow / hold inflow)
    if (await isBlacklisted(ctx)) {
      const code = ctx.direction === 'outflow' ? 'OUT_BLACKLIST' : 'IN_BLACKLIST_FUNDING';
      const rule = rules.find((r) => r.code === code);
      const matched = [{
        code, name: rule?.name || 'Blacklist', action: (rule?.action || (ctx.direction === 'outflow' ? 'reject' : 'hold')) as FraudDecision,
        weight: rule?.weight ?? 100, threshold: { reason: 'blacklist hit' },
      }];
      const decision: FraudDecision = ctx.direction === 'outflow' ? 'reject' : 'hold';
      const evaluationId = await recordEvaluation(ctx, decision, matched[0].weight, matched);
      const { caseId, ddId } = await openCase(ctx, evaluationId, matched, decision === 'hold');
      return { decision, score: matched[0].weight, matched, evaluationId, caseId, dueDiligenceId: ddId };
    }

    const A = await gatherAggregates(ctx);
    const direction = ctx.direction;
    const matched: FraudResult['matched'] = [];
    let score = 0;
    let decision: FraudDecision = 'allow';

    for (const rule of rules) {
      if (rule.direction !== direction && rule.direction !== 'both') continue;
      if (!matchRule(rule, ctx, A)) continue;
      const m = { code: rule.code, name: rule.name, action: rule.action, weight: rule.weight, threshold: rule.threshold };
      matched.push(m);
      score += rule.weight || 0;
      if (DECISION_RANK[rule.action] > DECISION_RANK[decision]) decision = rule.action;
    }
    score = Math.min(score, 100);

    const evaluationId = await recordEvaluation(ctx, decision, score, matched);
    let caseId: string | null = null;
    let ddId: string | null = null;
    if (decision === 'flag' || decision === 'hold' || decision === 'reject') {
      const opened = await openCase(ctx, evaluationId, matched, decision === 'hold');
      caseId = opened.caseId;
      ddId = opened.ddId;
    }
    return { decision, score, matched, evaluationId, caseId, dueDiligenceId: ddId };
  } catch (e) {
    console.error('[fraud] evaluate crashed (fail-open):', (e as any)?.message);
    const evaluationId = await recordEvaluation(ctx, 'system_error', 0, []);
    return { ...empty, decision: 'allow', evaluationId };
  }
}

export const evaluateOutflow = (ctx: Omit<FraudContext, 'direction'>): Promise<FraudResult> =>
  evaluate({ ...ctx, direction: 'outflow' });
export const evaluateInflow = (ctx: Omit<FraudContext, 'direction'>): Promise<FraudResult> =>
  evaluate({ ...ctx, direction: 'inflow' });

/** Build the standard 403-style reason a caller may return to its client. */
export const fraudRejectReason = (r: FraudResult): string =>
  `Transaction declined by our security system (${r.matched.map((m) => m.code).join(', ') || 'risk policy'}). ` +
  `If you believe this is a mistake, contact support.`;

/**
 * INFLOW GATE for wallet funding — call at every funding credit site BEFORE
 * the balance increment. Returns true to proceed with the credit, false when
 * the funding was held/rejected (the transaction row is parked as 'held' and
 * a reviewer later releases it via releaseHeldFunding or rejects it).
 * Fail-open: an engine crash never blocks a legitimate funding.
 */
export async function gateFundingInflow(opts: {
  transaction: any;           // transactions row (id, amount, currency, wallet_id, business_id, user_id, reference)
  provider: string;           // flutterwave | monnify | squad
  source: string;             // checkout | virtual_account | verify
}): Promise<boolean> {
  try {
    const t: any = opts.transaction || {};
    if (!t || t.status === 'success') return true; // already credited — nothing to gate
    let walletOwner: any = {};
    if (t.wallet_id) {
      const w = await query(`SELECT user_id, business_id FROM wallets WHERE id = $1`, [t.wallet_id]);
      walletOwner = w.rows[0] || {};
    }
    const fraud = await evaluateInflow({
      flow: 'funding',
      userId: t.user_id || walletOwner.user_id || null,
      businessId: t.business_id || walletOwner.business_id || null,
      walletId: t.wallet_id || null,
      amount: parseFloat(t.amount),
      currency: String(t.currency || 'NGN').toUpperCase(),
      reference: t.reference || null,
      transactionId: t.id || null,
      channel: `${opts.provider}:${opts.source}`,
    });
    if (fraud.decision === 'hold' || fraud.decision === 'reject') {
      // Park as held — the money has NOT been credited. A reviewer releases
      // (audited credit via releaseHeldFunding) or rejects (row fails).
      if (t.id) {
        await query(`UPDATE transactions SET status='held', updated_at=NOW() WHERE id=$1 AND status <> 'success'`, [t.id]);
      }
      console.log(`[fraud] funding ${t.reference} ${fraud.decision === 'reject' ? 'REJECTED' : 'HELD'} by ${fraud.matched.map((m) => m.code).join(',') || 'policy'}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error('[fraud] inflow gate crashed (fail-open):', e?.message);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Case decisions (admin)
// ---------------------------------------------------------------------------
export async function releaseFraudCase(caseId: string, adminId: string, notes: string): Promise<{ ok: boolean; message: string }> {
  const c = await query(`SELECT * FROM fraud_cases WHERE id = $1 FOR UPDATE`, [caseId]);
  const fc = c.rows[0];
  if (!fc) return { ok: false, message: 'Fraud case not found' };
  if (fc.status !== 'open' && fc.status !== 'escalated') return { ok: false, message: `Case is ${fc.status}, only open/escalated cases can be released` };

  // 1) Outflow transfer hold → re-queue for the normal payout pipeline
  if (fc.transfer_reference) {
    const t = await query(
      `UPDATE transfer_queue SET status = 'pending', failure_reason = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE reference = $1 AND status = 'held' RETURNING business_id`,
      [fc.transfer_reference],
    );
    if (t.rows.length > 0 && t.rows[0].business_id) {
      const { processAllPending } = await import('./transfer');
      processAllPending(t.rows[0].business_id).catch(() => {});
    }
  }

  // 2) Inflow funding hold → audited credit
  if (fc.direction === 'inflow' && fc.transaction_id) {
    const released = await releaseHeldFunding(fc.transaction_id, adminId, notes);
    if (!released.ok) return released;
  }

  await query(
    `UPDATE fraud_cases SET status='released', decision_notes=$2, decided_by=$3, decided_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [caseId, notes || 'Released by compliance', adminId],
  );
  // Close the linked DD case if any (release implies approval)
  await query(
    `UPDATE due_diligence_cases SET status='approved', reviewed_by=$2, reviewed_at=CURRENT_TIMESTAMP,
       review_notes=COALESCE(NULLIF($3,''), review_notes), updated_at=CURRENT_TIMESTAMP
     WHERE fraud_case_id=$1 AND status IN ('pending','submitted','under_review')`,
    [caseId, adminId, notes || ''],
  );
  return { ok: true, message: 'Case released' };
}

export async function rejectFraudCase(caseId: string, adminId: string, notes: string,
                                      blacklistValue?: { type: string; value: string } | null): Promise<{ ok: boolean; message: string }> {
  const c = await query(`SELECT * FROM fraud_cases WHERE id = $1 FOR UPDATE`, [caseId]);
  const fc = c.rows[0];
  if (!fc) return { ok: false, message: 'Fraud case not found' };
  if (fc.status !== 'open' && fc.status !== 'escalated') return { ok: false, message: `Case is ${fc.status}, only open/escalated cases can be rejected` };

  if (fc.transfer_reference) {
    await query(
      `UPDATE transfer_queue SET status='failed',
         failure_reason = COALESCE(failure_reason, '') || 'fraud_hold_rejected: ' || $2, updated_at=CURRENT_TIMESTAMP
       WHERE reference=$1 AND status='held'`,
      [fc.transfer_reference, (notes || 'Rejected by compliance').substring(0, 400)],
    );
  }
  if (fc.direction === 'inflow' && fc.transaction_id) {
    await query(
      `UPDATE transactions SET status='failed', updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND status='held'`,
      [fc.transaction_id],
    );
  }
  if (blacklistValue?.value) {
    await query(
      `INSERT INTO fraud_blacklists (type, value, reason, created_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (type, value) DO NOTHING`,
      [blacklistValue.type, blacklistValue.value, notes || 'Added during fraud case rejection', adminId],
    );
  }
  await query(
    `UPDATE fraud_cases SET status='rejected', decision_notes=$2, decided_by=$3, decided_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [caseId, notes || 'Rejected by compliance', adminId],
  );
  await query(
    `UPDATE due_diligence_cases SET status='rejected', reviewed_by=$2, reviewed_at=CURRENT_TIMESTAMP,
       review_notes=COALESCE(NULLIF($3,''), review_notes), updated_at=CURRENT_TIMESTAMP
     WHERE fraud_case_id=$1 AND status IN ('pending','submitted','under_review')`,
    [caseId, adminId, notes || ''],
  );
  return { ok: true, message: 'Case rejected' };
}

export async function escalateFraudCase(caseId: string, adminId: string, notes: string): Promise<{ ok: boolean; message: string }> {
  const r = await query(
    `UPDATE fraud_cases SET status='escalated', decision_notes=COALESCE(NULLIF($2,''), decision_notes),
       assigned_admin=$3, updated_at=CURRENT_TIMESTAMP
     WHERE id=$1 AND status IN ('open','escalated') RETURNING id`,
    [caseId, notes || '', adminId],
  );
  return r.rows.length > 0 ? { ok: true, message: 'Case escalated' } : { ok: false, message: 'Case not found or not open' };
}

/**
 * Audited credit for a held inflow — replicates the webhook credit path
 * (transaction success + settlement + wallet credit + fee revenue + platform
 * ledger debit) with the same idempotency guards.
 */
export async function releaseHeldFunding(transactionId: string, adminId: string, notes: string): Promise<{ ok: boolean; message: string }> {
  const t = await query(`SELECT * FROM transactions WHERE id = $1 FOR UPDATE`, [transactionId]);
  const txn = t.rows[0];
  if (!txn) return { ok: false, message: 'Held transaction not found' };
  if (txn.status !== 'held') return { ok: false, message: `Transaction is ${txn.status}, only held transactions can be released` };

  try {
    await query(`UPDATE transactions SET status='success', updated_at=NOW() WHERE id=$1`, [txn.id]);
    const settlementRes = await query(`SELECT id FROM settlements WHERE transaction_id = $1`, [txn.id]);
    if (settlementRes.rows.length === 0) {
      await query(
        `INSERT INTO settlements (transaction_id, business_id, user_id, amount, status) VALUES ($1,$2,$3,$4,'settled')`,
        [txn.id, txn.business_id, txn.user_id, txn.amount],
      );
    }
    if (txn.wallet_id) {
      await query(`UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2`, [txn.amount, txn.wallet_id]);
    }
    const fee = parseFloat(txn.fee || 0);
    if (fee > 0) {
      try {
        await creditRevenueWallet(fee, 'NGN', txn.reference, 'Wallet Funding Fee (released)', txn.payment_provider || 'flutterwave');
      } catch (feeErr: any) {
        console.warn('[fraud] release fee revenue credit skipped:', feeErr?.message?.substring?.(0, 140));
      }
    }
    try {
      await debitPlatformWallet(parseFloat(txn.amount), txn.currency || 'NGN', `${txn.reference}-PLATFORM`,
        'User Wallet Funding (released)', txn.payment_provider || 'flutterwave');
    } catch (ledgerErr: any) {
      console.warn('[fraud] release platform ledger debit failed:', ledgerErr?.message?.substring?.(0, 140));
    }
    console.log(`[fraud] held funding ${txn.reference} released by admin ${adminId}: ${notes || '(no notes)'}`);
    return { ok: true, message: 'Funding released and wallet credited' };
  } catch (e: any) {
    console.error('[fraud] releaseHeldFunding failed:', e?.message);
    return { ok: false, message: 'Release failed; transaction remains held' };
  }
}

// ---------------------------------------------------------------------------
// Due-diligence cron — reminders + expiry auto-reject
// ---------------------------------------------------------------------------
export async function processDueDiligenceCron(): Promise<void> {
  try {
    // 1) Remind pending cases older than 72h without a recent reminder
    const remind = await query(
      `UPDATE due_diligence_cases SET reminder_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE status = 'pending' AND auto_opened_at < NOW() - INTERVAL '72 hours'
         AND (reminder_sent_at IS NULL OR reminder_sent_at < NOW() - INTERVAL '72 hours')
       RETURNING id, user_id`,
    );
    for (const row of remind.rows) {
      try {
        const w = await query(`SELECT business_id FROM users WHERE id = $1`, [row.user_id]);
        const businessId = w.rows[0]?.business_id;
        if (businessId) {
          await createNotification({
            businessId: String(businessId),
            userId: String(row.user_id),
            type: 'fraud_hold_reminder',
            title: 'Verification reminder',
            message: 'A held transaction is still awaiting your verification. Complete the short form to release it.',
            actionUrl: '/due-diligence',
            actionType: 'due_diligence',
            isActionable: true,
            expiresInHours: 336,
          });
        }
      } catch { /* best effort */ }
    }

    // 2) Expire stale cases (14 days) — auto-reject linked holds
    const expired = await query(
      `UPDATE due_diligence_cases SET status='expired', updated_at=CURRENT_TIMESTAMP
       WHERE status IN ('pending','submitted','under_review') AND expires_at < NOW()
       RETURNING id, fraud_case_id`,
    );
    for (const row of expired.rows) {
      if (!row.fraud_case_id) continue;
      const fc = await query(`SELECT * FROM fraud_cases WHERE id = $1`, [row.fraud_case_id]);
      const fraudCase = fc.rows[0];
      if (!fraudCase) continue;
      if (fraudCase.transfer_reference) {
        await query(
          `UPDATE transfer_queue SET status='failed',
             failure_reason = COALESCE(failure_reason,'') || 'fraud_hold_expired: verification not completed in time',
             updated_at = CURRENT_TIMESTAMP
           WHERE reference=$1 AND status='held'`,
          [fraudCase.transfer_reference],
        );
      }
      if (fraudCase.direction === 'inflow' && fraudCase.transaction_id) {
        await query(`UPDATE transactions SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND status='held'`, [fraudCase.transaction_id]);
      }
      await query(
        `UPDATE fraud_cases SET status='expired', decision_notes='Verification window lapsed (14 days)', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [row.fraud_case_id],
      );
    }
  } catch (e) {
    console.error('[fraud] DD cron failed:', (e as any)?.message);
  }
}
