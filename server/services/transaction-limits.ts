/**
 * Transaction limits per business registration category.
 *
 * Every business starts as 'non_registered' (regardless of what was chosen at
 * signup). Completing the Business KYC upgrade flow and being approved moves
 * the business to 'registered' and unlocks the higher tier.
 *
 * Limits live in the `transaction_limits` table so admins can tune them live
 * (GET/PUT /api/admin/transaction-limits). Enforcement points:
 *   - POST /api/transfers/single  (NGN only — intl corridors keep their own limits)
 *   - POST /api/transfers/bulk    (NGN only, aggregate of item amounts)
 */
import { query } from "../db";

export type RegistrationCategory = "non_registered" | "registered";

export interface CategoryLimits {
  category: RegistrationCategory;
  currency: string;
  singleTransactionLimit: number;
  dailyLimit: number;
  monthlyLimit: number;
}

export interface LimitUsage {
  usedToday: number;
  usedThisMonth: number;
}

export interface LimitCheckResult {
  ok: boolean;
  code?: "SINGLE_LIMIT_EXCEEDED" | "DAILY_LIMIT_EXCEEDED" | "MONTHLY_LIMIT_EXCEEDED";
  error?: string;
  data?: {
    limitType: "single" | "daily" | "monthly";
    limit: number;
    amount: number;
    usedToday: number;
    usedThisMonth: number;
    category: RegistrationCategory;
    currency: string;
    upgradeHint: boolean;
  };
}

const DEFAULTS: Record<RegistrationCategory, Omit<CategoryLimits, "category">> = {
  non_registered: {
    currency: "NGN",
    singleTransactionLimit: 50_000,
    dailyLimit: 100_000,
    monthlyLimit: 500_000,
  },
  registered: {
    currency: "NGN",
    singleTransactionLimit: 5_000_000,
    dailyLimit: 10_000_000,
    monthlyLimit: 50_000_000,
  },
};

export async function getCategoryLimits(category: RegistrationCategory): Promise<CategoryLimits> {
  try {
    const res = await query(
      `SELECT category, currency, single_transaction_limit, daily_limit, monthly_limit
         FROM transaction_limits WHERE category = $1 LIMIT 1`,
      [category],
    );
    const row: any = res.rows[0];
    if (!row) return { category, ...DEFAULTS[category] };
    return {
      category,
      currency: row.currency || "NGN",
      singleTransactionLimit: Number(row.single_transaction_limit),
      dailyLimit: Number(row.daily_limit),
      monthlyLimit: Number(row.monthly_limit),
    };
  } catch (err: any) {
    console.error("[transaction-limits] failed to load limits, using defaults:", err?.message);
    return { category, ...DEFAULTS[category] };
  }
}

export async function getAllCategoryLimits(): Promise<CategoryLimits[]> {
  const out: CategoryLimits[] = [];
  for (const category of ["non_registered", "registered"] as RegistrationCategory[]) {
    out.push(await getCategoryLimits(category));
  }
  return out;
}

export async function getBusinessCategory(businessId: string | null | undefined): Promise<RegistrationCategory> {
  if (!businessId) return "non_registered";
  try {
    const res = await query(
      `SELECT COALESCE(registration_category, 'non_registered') AS category
         FROM businesses WHERE id = $1 LIMIT 1`,
      [businessId],
    );
    const category = res.rows[0]?.category;
    return category === "registered" ? "registered" : "non_registered";
  } catch {
    return "non_registered";
  }
}

/** Successful NGN debit volume for the business today / this calendar month. */
export async function getBusinessUsage(businessId: string): Promise<LimitUsage> {
  try {
    const res = await query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)::float8 AS used_today,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::float8 AS used_month
       FROM transactions
       WHERE business_id = $1
         AND direction = 'debit'
         AND status = 'success'
         AND transaction_type = 'transfer'
         AND currency = 'NGN'`,
      [businessId],
    );
    const row: any = res.rows[0] || {};
    return { usedToday: Number(row.used_today || 0), usedThisMonth: Number(row.used_month || 0) };
  } catch (err: any) {
    console.error("[transaction-limits] usage query failed:", err?.message);
    return { usedToday: 0, usedThisMonth: 0 };
  }
}

/**
 * Enforce the category limits for a proposed debit of `amount` (NGN).
 * `amounts` may be a single amount or a list (bulk = sum of items).
 */
export async function enforceTransactionLimits(
  businessId: string,
  amounts: number | number[],
  options: { currency?: string } = {},
): Promise<LimitCheckResult> {
  const currency = (options.currency || "NGN").toUpperCase();
  // Only NGN corridors are governed by registration-category limits; intl
  // corridors already enforce their own payout limits.
  if (currency !== "NGN") return { ok: true };

  const list = (Array.isArray(amounts) ? amounts : [amounts]).map((n) => Number(n) || 0);
  const singleMax = list.length ? Math.max(...list) : 0;
  const total = list.reduce((a, b) => a + b, 0);

  const category = await getBusinessCategory(businessId);
  const limits = await getCategoryLimits(category);
  const usage = await getBusinessUsage(businessId);

  const buildFail = (
    limitType: "single" | "daily" | "monthly",
    code: LimitCheckResult["code"],
    message: string,
  ): LimitCheckResult => ({
    ok: false,
    code,
    error: message,
    data: {
      limitType,
      limit:
        limitType === "single"
          ? limits.singleTransactionLimit
          : limitType === "daily"
            ? limits.dailyLimit
            : limits.monthlyLimit,
      amount: limitType === "single" ? singleMax : total,
      usedToday: usage.usedToday,
      usedThisMonth: usage.usedThisMonth,
      category,
      currency: limits.currency,
      upgradeHint: category === "non_registered",
    },
  });

  const fmt = (n: number) =>
    `${limits.currency} ${Number(n).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;

  if (singleMax > limits.singleTransactionLimit) {
    return buildFail(
      "single",
      "SINGLE_LIMIT_EXCEEDED",
      `Your ${category === "registered" ? "Registered Business" : "Non-Registered Business"} limit is ${fmt(limits.singleTransactionLimit)} per transaction. This transfer of ${fmt(singleMax)} exceeds it.`,
    );
  }
  if (usage.usedToday + total > limits.dailyLimit) {
    return buildFail(
      "daily",
      "DAILY_LIMIT_EXCEEDED",
      `Your ${category === "registered" ? "Registered Business" : "Non-Registered Business"} daily limit is ${fmt(limits.dailyLimit)} (used ${fmt(usage.usedToday)} today). This would bring you to ${fmt(usage.usedToday + total)}.`,
    );
  }
  if (usage.usedThisMonth + total > limits.monthlyLimit) {
    return buildFail(
      "monthly",
      "MONTHLY_LIMIT_EXCEEDED",
      `Your ${category === "registered" ? "Registered Business" : "Non-Registered Business"} monthly limit is ${fmt(limits.monthlyLimit)} (used ${fmt(usage.usedThisMonth)} this month). Upgrade your business registration to unlock higher limits.`,
    );
  }

  return { ok: true };
}

/** Dashboard payload: current tier + limits + live usage. */
export async function getBusinessLimitInfo(businessId: string) {
  const category = await getBusinessCategory(businessId);
  const limits = await getCategoryLimits(category);
  const usage = await getBusinessUsage(businessId);
  const target = await getCategoryLimits("registered");
  return {
    category,
    isRegistered: category === "registered",
    currency: limits.currency,
    limits: {
      singleTransactionLimit: limits.singleTransactionLimit,
      dailyLimit: limits.dailyLimit,
      monthlyLimit: limits.monthlyLimit,
    },
    usage: {
      usedToday: usage.usedToday,
      usedThisMonth: usage.usedThisMonth,
      remainingToday: Math.max(0, limits.dailyLimit - usage.usedToday),
      remainingThisMonth: Math.max(0, limits.monthlyLimit - usage.usedThisMonth),
    },
    registeredLimits: {
      singleTransactionLimit: target.singleTransactionLimit,
      dailyLimit: target.dailyLimit,
      monthlyLimit: target.monthlyLimit,
    },
  };
}
