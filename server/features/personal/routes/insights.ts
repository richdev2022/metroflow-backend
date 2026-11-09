import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";

/**
 * SMART SPENDING INSIGHTS & BUDGETS (mounted at /insights, personal users
 * only) — auto-categorized analytics over the transactions the user already
 * generates, monthly budget envelopes, week-over-week trends and generated
 * "nudges" (spending spikes, budget alerts, week-over-week moves and a
 * direct bridge into Round-Up).
 *
 * Auto-categorization: every successful NGN debit is bucketed by its
 * transaction_type; bill payments are sub-split by bill_payments.category
 * (airtime / data / tv / electricity / betting) via the shared reference.
 * Round-up debits are SAVINGS, not spend, and are always excluded.
 *
 * All month/week math happens in the DB clock (date_trunc) exactly like the
 * rest of the personal features — no client timezone arithmetic.
 *
 * Endpoints:
 *   GET    /insights/overview?month=YYYY-MM → totals, by_category, weeks, budgets
 *   GET    /insights/nudges                 → generated smart nudges
 *   GET    /insights/trends?weeks=8         → weekly out totals
 *   GET    /insights/budgets                → envelopes + live spend
 *   PUT    /insights/budgets                → upsert one envelope
 *   DELETE /insights/budgets/:id            → remove an envelope
 */

const router = express.Router();

function num(v: any): number { return Number(v) || 0; }
function money(v: number): number { return Math.round(v * 100) / 100; }

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---------------------------------------------------------------------------
// Category taxonomy — keys match budget_envelopes.category
// ---------------------------------------------------------------------------

export const CATEGORY_LABELS: Record<string, string> = {
  airtime: "Airtime",
  data: "Data",
  tv: "TV & Cable",
  electricity: "Electricity",
  betting: "Betting",
  bills: "Bills & Utilities",
  transfers: "Transfers",
  marketplace: "Marketplace",
  giftcards: "Gift Cards",
  crypto: "Crypto",
  virtual_cards: "Virtual Cards",
  esim: "eSIM",
  splits: "Split Bills",
  group_pots: "Group Pots",
  savings_circles: "Savings Circles",
  donations: "Donations",
  boosts: "Boosts",
  live_gifts: "Live Gifts",
  polls: "Polls",
  conversions: "Conversions",
  other: "Other",
};

const BILL_CATEGORIES = new Set(["airtime", "data", "tv", "electricity", "betting"]);

/** Auto-categorisation — maps a personal-ledger transaction_type (+ the
 *  bill_payments.category sub-split for bill payments) to an insight
 *  category key. Exported for unit tests. */
export function categorize(type: string, billCat: string): string {
  switch (type) {
    case "bill":
      return BILL_CATEGORIES.has(billCat) ? billCat : "bills";
    case "transfer":
      return "transfers";
    case "market_order":
      return "marketplace";
    case "giftcard_buy":
    case "rmb_buy":
      return "giftcards";
    case "vcard_fund":
    case "vcard_create":
    case "vcard_terminate":
      return "virtual_cards";
    case "esim_order":
      return "esim";
    case "split_payment":
      return "splits";
    case "pot_contribution":
      return "group_pots";
    case "circle_contribution":
      return "savings_circles";
    case "donation":
      return "donations";
    case "boost":
      return "boosts";
    case "live_gift":
      return "live_gifts";
    case "poll_vote":
      return "polls";
    case "stablecoin_convert":
      return "conversions";
    default:
      if (type.startsWith("crypto") || type.startsWith("stablecoin")) return "crypto";
      return "other";
  }
}

// ---------------------------------------------------------------------------
// Spend bucket aggregation — one GROUP BY per month range, bucketed in JS.
// ---------------------------------------------------------------------------

interface Bucket { [category: string]: { amount: number; count: number } }

async function spendBuckets(userId: string, sinceSql: string, untilSql: string | null): Promise<Bucket> {
  const r = await query(
    `SELECT t.transaction_type AS type, COALESCE(bp.category, 'other') AS bill_cat,
            COALESCE(SUM(t.amount), 0)::float AS amount, COUNT(*)::int AS n
       FROM transactions t
       LEFT JOIN bill_payments bp ON bp.reference = t.reference
      WHERE t.user_id = $1
        AND t.type = 'debit' AND t.status = 'success'
        AND t.currency = 'NGN'
        AND t.transaction_type <> 'roundup'
        AND t.created_at >= ${sinceSql}
        ${untilSql ? `AND t.created_at < ${untilSql}` : ""}
      GROUP BY 1, 2`,
    [userId],
  );
  const bucket: Bucket = {};
  for (const row of r.rows) {
    const cat = categorize(String(row.type), String(row.bill_cat));
    if (!bucket[cat]) bucket[cat] = { amount: 0, count: 0 };
    bucket[cat].amount += num(row.amount);
    bucket[cat].count += num(row.n);
  }
  for (const cat of Object.keys(bucket)) bucket[cat].amount = money(bucket[cat].amount);
  return bucket;
}

function bucketTotal(b: Bucket): number {
  return money(Object.values(b).reduce((s, x) => s + x.amount, 0));
}

function bucketList(b: Bucket) {
  const total = bucketTotal(b) || 1;
  return Object.entries(b)
    .map(([category, v]) => ({
      category,
      label: CATEGORY_LABELS[category] || "Other",
      amount: v.amount,
      count: v.count,
      share: Math.round((v.amount / total) * 1000) / 10,
    }))
    .sort((a, z) => z.amount - a.amount);
}

/** Envelopes joined against a live spend bucket. */
async function loadBudgets(userId: string, spend: Bucket) {
  const r = await query(
    `SELECT id, category, monthly_limit, active, created_at, updated_at
       FROM budget_envelopes WHERE user_id = $1 AND active = TRUE
      ORDER BY created_at ASC`,
    [userId],
  );
  return r.rows.map((row: any) => {
    const limit = money(num(row.monthly_limit));
    const spent = money(spend[String(row.category)]?.amount || 0);
    return {
      id: row.id,
      category: row.category,
      label: CATEGORY_LABELS[String(row.category)] || "Other",
      monthly_limit: limit,
      spent,
      remaining: money(Math.max(0, limit - spent)),
      pct: limit > 0 ? Math.min(999, Math.round((spent / limit) * 100)) : 0,
    };
  });
}

/** Shared ₦ formatter for nudge copy (matches the app's money voice). */
export function naira(v: number): string {
  return `₦${Math.round(v).toLocaleString()}`;
}

/** Shape of a budget envelope the nudge builder consumes. */
export interface BudgetView {
  label: string;
  monthly_limit: number;
  spent: number;
  remaining: number;
  pct: number;
}

export interface Nudge {
  type: string;
  title: string;
  body: string;
}

/** PURE nudge core — spikes, budget alerts and the always-on top-category
 *  context, derived from one month's spend bucket, the per-category trailing
 *  3-month average and the live envelopes. Week-over-week and the Round-Up
 *  bridge stay in the handler because they need extra DB signals.
 *  Thresholds: a spike needs ≥₦2,000 spent AND ≥2× a ≥₦500 trailing average;
 *  envelopes alert at 100% (blown) and 80% (almost gone). */
export function buildCoreNudges(
  thisMonth: Bucket,
  avgByCat: Map<string, number>,
  budgets: BudgetView[],
  thisTotal: number,
): Nudge[] {
  const nudges: Nudge[] = [];

  // 1. Category spikes — "you spent ₦12,400 on airtime — 3× your average".
  const spikes: Array<{ cat: string; amount: number; ratio: number }> = [];
  for (const [cat, v] of Object.entries(thisMonth)) {
    if (v.amount < 2000) continue;
    const avg = avgByCat.get(cat) || 0;
    if (avg >= 500 && v.amount >= avg * 2) {
      spikes.push({ cat, amount: v.amount, ratio: Math.round((v.amount / avg) * 10) / 10 });
    }
  }
  spikes.sort((a, z) => z.amount - a.amount);
  for (const s of spikes.slice(0, 2)) {
    nudges.push({
      type: "spike",
      title: `${CATEGORY_LABELS[s.cat] || "Spending"} is up sharply`,
      body: `You've spent ${naira(s.amount)} on ${(CATEGORY_LABELS[s.cat] || s.cat).toLowerCase()} this month — ${s.ratio}× your monthly average.`,
    });
  }

  // 2. Budget alerts — over and close-to-limit envelopes.
  for (const b of budgets) {
    if (b.monthly_limit <= 0) continue;
    if (b.pct >= 100) {
      nudges.push({
        type: "budget_over",
        title: `${b.label} budget blown`,
        body: `You're at ${b.pct}% of your ${naira(b.monthly_limit)} ${b.label.toLowerCase()} envelope — ${naira(b.spent - b.monthly_limit)} over.`,
      });
    } else if (b.pct >= 80) {
      nudges.push({
        type: "budget_warn",
        title: `${b.label} budget almost gone`,
        body: `${b.pct}% of your ${b.label.toLowerCase()} budget is used — ${naira(b.remaining)} left this month.`,
      });
    }
  }

  // 5. Top category share — always-on context.
  const top = bucketList(thisMonth)[0];
  if (top && thisTotal >= 5000) {
    nudges.push({
      type: "top_category",
      title: `${top.label} leads your spending`,
      body: `${naira(top.amount)} — ${top.share}% of everything you spent this month.`,
    });
  }

  return nudges;
}

// ---------------------------------------------------------------------------
// GET /insights/overview?month=YYYY-MM
// ---------------------------------------------------------------------------

router.get("/overview", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const monthParam = String(req.query.month || "");
    const month = MONTH_RE.test(monthParam) ? monthParam : null;
    const monthStart = month ? `('${month}-01')::date` : `date_trunc('month', CURRENT_DATE)`;

    const spend = await spendBuckets(userId, `${monthStart}`, `${monthStart} + INTERVAL '1 month'`);
    const moneyOut = bucketTotal(spend);

    const io = await query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'credit'), 0)::float AS money_in,
         COALESCE(SUM(amount) FILTER (WHERE type = 'debit'), 0)::float AS money_out
         FROM transactions
        WHERE user_id = $1 AND status = 'success' AND currency = 'NGN'
          AND created_at >= ${monthStart} AND created_at < ${monthStart} + INTERVAL '1 month'`,
      [userId],
    );
    const moneyIn = money(num(io.rows[0]?.money_in));

    // Previous calendar month (for the trend line) — computed in the DB clock.
    const prev = await spendBuckets(
      userId,
      `(${monthStart}) - INTERVAL '1 month'`,
      `${monthStart}`,
    );
    const prevOut = bucketTotal(prev);
    const trendPct = prevOut > 0 ? Math.round(((moneyOut - prevOut) / prevOut) * 100) : null;

    // Week-over-week outflow for the trailing 6 weeks (ending this week).
    const weeks = await query(
      `SELECT date_trunc('week', created_at)::date::text AS week_start,
              COALESCE(SUM(amount), 0)::float AS money_out
         FROM transactions
        WHERE user_id = $1 AND type = 'debit' AND status = 'success'
          AND currency = 'NGN' AND transaction_type <> 'roundup'
          AND created_at >= date_trunc('week', CURRENT_DATE) - make_interval(weeks => 5)
        GROUP BY 1 ORDER BY 1`,
      [userId],
    );

    const budgets = await loadBudgets(userId, spend);

    res.json({
      success: true,
      month: month || undefined,
      money_in: moneyIn,
      money_out: moneyOut,
      net: money(moneyIn - moneyOut),
      prev_month_out: prevOut,
      trend_pct: trendPct,
      by_category: bucketList(spend),
      weeks: weeks.rows.map((w: any) => ({ week_start: w.week_start, money_out: money(num(w.money_out)) })),
      budgets,
    });
  } catch (e: any) {
    console.error("[insights/overview]", e?.message);
    res.status(500).json({ success: false, error: "Could not load your spending insights" });
  }
});

// ---------------------------------------------------------------------------
// GET /insights/nudges — generated smart nudges (spikes, budgets, trend,
// round-up bridge). Best-effort: never 500s for a missing optional signal.
// ---------------------------------------------------------------------------

router.get("/nudges", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;

    const thisMonth = await spendBuckets(userId, `date_trunc('month', CURRENT_DATE)`, null);
    const thisTotal = bucketTotal(thisMonth);

    // Per-category totals for each of the previous 3 calendar months.
    const hist = await query(
      `SELECT date_trunc('month', created_at)::date::text AS m,
              t.transaction_type AS type, COALESCE(bp.category, 'other') AS bill_cat,
              COALESCE(SUM(t.amount), 0)::float AS amount
         FROM transactions t
         LEFT JOIN bill_payments bp ON bp.reference = t.reference
        WHERE t.user_id = $1 AND t.type = 'debit' AND t.status = 'success'
          AND t.currency = 'NGN' AND t.transaction_type <> 'roundup'
          AND t.created_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
          AND t.created_at < date_trunc('month', CURRENT_DATE)
        GROUP BY 1, 2, 3`,
      [userId],
    );
    const byMonthCat = new Map<string, Map<string, number>>();
    for (const row of hist.rows) {
      const cat = categorize(String(row.type), String(row.bill_cat));
      if (!byMonthCat.has(row.m)) byMonthCat.set(row.m, new Map());
      const m = byMonthCat.get(row.m)!;
      m.set(cat, (m.get(cat) || 0) + num(row.amount));
    }
    const avgByCat = new Map<string, number>();
    for (const [, cats] of byMonthCat) {
      for (const [cat, amount] of cats) {
        avgByCat.set(cat, (avgByCat.get(cat) || 0) + amount / 3);
      }
    }

    // 1+2+5. Spikes, budget alerts and top-category context — the pure
    // core (unit-tested); the DB-driven nudges below are appended after.
    const budgets = await loadBudgets(userId, thisMonth);
    const nudges = buildCoreNudges(thisMonth, avgByCat, budgets, thisTotal);

    // 3. Week-over-week move.
    const weeks = await query(
      `SELECT date_trunc('week', created_at)::date::text AS week_start,
              COALESCE(SUM(amount), 0)::float AS out
         FROM transactions
        WHERE user_id = $1 AND type = 'debit' AND status = 'success'
          AND currency = 'NGN' AND transaction_type <> 'roundup'
          AND created_at >= date_trunc('week', CURRENT_DATE) - INTERVAL '1 week'
        GROUP BY 1 ORDER BY 1 DESC`,
      [userId],
    );
    const thisWeek = num(weeks.rows.find((w: any) => w.week_start === weeks.rows[0]?.week_start)?.out);
    const lastWeek = num(weeks.rows[weeks.rows.length - 1]?.out);
    if (lastWeek >= 2000 && thisWeek >= lastWeek * 1.3 && weeks.rows.length === 2) {
      const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
      nudges.push({
        type: "trend_up",
        title: "This week is running hot",
        body: `You've spent ${naira(thisWeek)} this week — ${pct}% more than last week's ${naira(lastWeek)}.`,
      });
    } else if (thisWeek >= 2000 && lastWeek >= 2000 && thisWeek <= lastWeek * 0.7) {
      const pct = Math.round(((lastWeek - thisWeek) / lastWeek) * 100);
      nudges.push({
        type: "trend_down",
        title: "Spending is cooling off",
        body: `${pct}% less than last week — a good moment to push the difference into savings.`,
      });
    }

    // 4. Round-Up bridge — tie insights directly into the savings habit.
    try {
      const settings = await query(
        `SELECT enabled, multiplier, round_to, vault_id FROM roundup_settings WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      const s = settings.rows[0];
      const roundTo = Math.max(1, Math.round(num(s?.round_to)) || 100);
      const multiplier = Math.min(3, Math.max(1, Math.round(num(s?.multiplier)) || 1));
      const potential = await query(
        `SELECT COALESCE(SUM((($2 - (amount::numeric % $2)) % $2)), 0)::float AS pot
           FROM transactions
          WHERE user_id = $1 AND type = 'debit' AND status = 'success'
            AND currency = 'NGN'
            AND created_at >= date_trunc('month', CURRENT_DATE)`,
        [userId, roundTo],
      );
      const pot = money(num(potential.rows[0]?.pot));
      if (pot >= 100) {
        if (s?.enabled === true) {
          let vaultName = "savings goal";
          if (s.vault_id) {
            const v = await query(`SELECT name FROM savings_vaults WHERE id = $1 AND user_id = $2 LIMIT 1`, [s.vault_id, userId]);
            vaultName = String(v.rows[0]?.name || vaultName);
          }
          nudges.push({
            type: "roundup_bridge",
            title: "Boost your round-up",
            body: `Round up ${multiplier >= 3 ? "3×" : `${multiplier + 1}×`} this month to add about ${naira(pot * (multiplier + 1))} to your ${vaultName} goal faster.`,
          });
        } else {
          nudges.push({
            type: "roundup_onboarding",
            title: "Your spare change is slipping away",
            body: `About ${naira(pot)} of round-up change passed through this month. Turn on Round-Up Auto-Save and it lands in a vault instead.`,
          });
        }
      }
    } catch { /* round-up signal is optional */ }

    res.json({ success: true, nudges: nudges.slice(0, 6) });
  } catch (e: any) {
    // Resilience contract: the nudges surface is best-effort — a missing or
    // broken optional signal (no budgets table, no transactions yet, a dead
    // round-up settings row) must NOT 500 the Insights home. Log the error
    // for ops, then return an empty nudge array so the client renders the
    // empty state instead of a hard error.
    console.error("[insights/nudges]", e?.message);
    res.json({ success: true, nudges: [] });
  }
});

// ---------------------------------------------------------------------------
// GET /insights/trends?weeks=8
// ---------------------------------------------------------------------------

router.get("/trends", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const weeks = Math.min(26, Math.max(2, Math.round(num(req.query.weeks)) || 8));
    const r = await query(
      `SELECT date_trunc('week', created_at)::date::text AS week_start,
              COALESCE(SUM(amount) FILTER (WHERE type = 'debit'), 0)::float AS money_out,
              COALESCE(SUM(amount) FILTER (WHERE type = 'credit'), 0)::float AS money_in
         FROM transactions
        WHERE user_id = $1 AND status = 'success' AND currency = 'NGN'
          AND created_at >= date_trunc('week', CURRENT_DATE) - make_interval(weeks => $2)
        GROUP BY 1 ORDER BY 1`,
      [userId, weeks - 1],
    );
    res.json({
      success: true,
      weeks: r.rows.map((w: any) => ({
        week_start: w.week_start,
        money_out: money(num(w.money_out)),
        money_in: money(num(w.money_in)),
      })),
    });
  } catch (e: any) {
    console.error("[insights/trends]", e?.message);
    res.status(500).json({ success: false, error: "Could not load your trends" });
  }
});

// ---------------------------------------------------------------------------
// Budget envelopes — GET / PUT / DELETE
// ---------------------------------------------------------------------------

router.get("/budgets", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const spend = await spendBuckets(userId, `date_trunc('month', CURRENT_DATE)`, null);
    res.json({ success: true, budgets: await loadBudgets(userId, spend) });
  } catch (e: any) {
    console.error("[insights/budgets]", e?.message);
    res.status(500).json({ success: false, error: "Could not load your budgets" });
  }
});

router.put("/budgets", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const category = String(req.body?.category || "").trim();
    const limit = money(num(req.body?.monthly_limit));
    if (!CATEGORY_LABELS[category] || category === "other") {
      return res.status(400).json({ success: false, error: "Pick a valid spending category" });
    }
    if (!(limit >= 0) || limit > 100_000_000) {
      return res.status(400).json({ success: false, error: "Enter a valid monthly limit" });
    }
    const saved = await query(
      `INSERT INTO budget_envelopes (user_id, category, monthly_limit)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, category) DO UPDATE
         SET monthly_limit = $3, active = TRUE, updated_at = CURRENT_TIMESTAMP
       RETURNING id, category, monthly_limit, active`,
      [userId, category, limit],
    );
    const row = saved.rows[0];
    res.json({
      success: true,
      budget: {
        id: row.id,
        category: row.category,
        label: CATEGORY_LABELS[String(row.category)] || "Other",
        monthly_limit: money(num(row.monthly_limit)),
        active: row.active,
      },
    });
  } catch (e: any) {
    console.error("[insights/budgets PUT]", e?.message);
    res.status(500).json({ success: false, error: "Could not save the budget" });
  }
});

router.delete("/budgets/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const deleted = await query(
      `DELETE FROM budget_envelopes WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, userId],
    );
    if (!deleted.rows.length) return res.status(404).json({ success: false, error: "Budget not found" });
    res.json({ success: true });
  } catch (e: any) {
    console.error("[insights/budgets DELETE]", e?.message);
    res.status(500).json({ success: false, error: "Could not delete the budget" });
  }
});

export default router;
