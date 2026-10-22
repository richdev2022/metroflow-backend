import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../services/auth";
import { AVAILABLE_PERMISSIONS } from "../config/permissions";

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    businessId: string;
    email?: string;
    name?: string;
  };
}

/**
 * Global augmentation: `authenticateToken` attaches `req.user` at runtime on
 * EVERY route it guards, but several route files (chat, statuses) type their
 * handlers as plain RequestHandler and read `req.user`. Declaring the shape
 * on the core Request interface keeps those files typecheck-clean without
 * importing AuthenticatedRequest everywhere. Optional — unguarded routes see
 * `undefined` exactly as at runtime.
 */
declare module "express-serve-static-core" {
  interface Request {
    user?: AuthenticatedRequest["user"];
  }
}

export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  console.log("authenticateToken middleware called");
  const authHeader = req.headers.authorization;
  console.log("Authorization header:", authHeader);
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN
  console.log("Extracted token:", token);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Access token required",
    });
  }

  const decoded = await verifyToken(token);
  if (!decoded) {
    console.log("Token verification failed");
    return res.status(403).json({
      success: false,
      error: "Invalid or expired token",
    });
  }

  console.log("Token verified successfully, decoded:", decoded);
  req.user = decoded;
  next();
};

import { query } from "../db";

const knownPermissionAliases = new Map<string, string>();
for (const permission of AVAILABLE_PERMISSIONS) {
  knownPermissionAliases.set(permission.id, permission.id);
  knownPermissionAliases.set(permission.name.toLowerCase(), permission.id);
}

const collectPlanPermissionValues = (value: unknown): string[] => {
  if (value === undefined || value === null || value === "") return [];

  if (Array.isArray(value)) {
    return value.flatMap(collectPlanPermissionValues);
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [
      ...collectPlanPermissionValues(record.id),
      ...collectPlanPermissionValues(record.slug),
      ...collectPlanPermissionValues(record.key),
      ...collectPlanPermissionValues(record.name),
    ];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      try {
        return collectPlanPermissionValues(JSON.parse(trimmed));
      } catch {
        // Fall through and treat the value as a plain permission label.
      }
    }

    if (trimmed.includes(",")) {
      return trimmed.split(",").flatMap(collectPlanPermissionValues);
    }

    const canonical = knownPermissionAliases.get(trimmed) || knownPermissionAliases.get(trimmed.toLowerCase());
    return [canonical || trimmed];
  }

  return [];
};

export const normalizePlanPermissions = (...values: unknown[]) => {
  const permissions = new Set<string>();

  for (const value of values) {
    for (const permission of collectPlanPermissionValues(value)) {
      permissions.add(permission);
    }
  }

  return permissions;
};

export const checkTeamLimit = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

    // Get business plan and current team count
    const businessResult = await query(
      `SELECT b.plan_id, p.max_team_members 
       FROM businesses b
       LEFT JOIN pricing_plans p ON b.plan_id = p.id
       WHERE b.id = $1`,
      [businessId]
    );

    if (businessResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Business not found" });
    }

    const { max_team_members } = businessResult.rows[0];
    
    // If max_team_members is null or very large, assume unlimited
    if (!max_team_members || max_team_members > 99999) {
      return next();
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM users WHERE business_id = $1`,
      [businessId]
    );

    const currentCount = parseInt(countResult.rows[0].count);

    if (currentCount >= max_team_members) {
      return res.status(403).json({ 
        success: false, 
        error: "Team member limit reached. Please upgrade your plan." 
      });
    }

    next();
  } catch (error) {
    console.error("Check team limit error:", error);
    res.status(500).json({ success: false, error: "Failed to check plan limits" });
  }
};

export const checkSubscriptionStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const businessId = req.user?.businessId;
    // Skip if no businessId (e.g. platform admin or pre-auth)
    if (!businessId) return next();

    // Skip checks for subscription related endpoints to allow upgrade
    if (req.originalUrl.startsWith('/api/subscription')) {
        return next();
    }

    const businessResult = await query(
      `SELECT b.subscription_status, b.trial_ends_at, p.price, p.trial_days
       FROM businesses b
       LEFT JOIN pricing_plans p ON b.plan_id = p.id
       WHERE b.id = $1`,
      [businessId]
    );

    if (businessResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Business not found" });
    }

    const business = businessResult.rows[0];
    const now = new Date();
    const trialEndsAt = business.trial_ends_at ? new Date(business.trial_ends_at) : null;
    const isFreePlan = parseFloat(business.price) === 0;

    // FREE-FOREVER: the free plan is never hard-blocked at the subscription
    // level. During the trial window the business enjoys ALL plan-gated
    // features (see checkFeaturePermission); after the trial it falls back to
    // the plan's base permission set (free forever). Feature-level permission
    // checks do the restricting — not this gate.
    if (isFreePlan) {
        return next();
    }

    // Check if subscription is explicitly inactive/cancelled (paid plans)
    if (business.subscription_status === 'inactive' || business.subscription_status === 'cancelled') {
         // Maybe they have a grace period or trial?
         // Simplification: if not active and trial expired (or no trial), block.
         if (!trialEndsAt || trialEndsAt < now) {
            return res.status(403).json({
                success: false,
                error: "Your subscription has expired. Please upgrade your plan to continue accessing these features."
            });
         }
    }

    next();
  } catch (error) {
    console.error("Check subscription status error:", error);
    // Fail open or closed? Let's fail open to avoid blocking users on DB errors, but log it.
    next();
  }
};

export const checkFeaturePermission = (requiredPermission: string | string[]) => {
  // Calls were historically gated with "use_chat"; plans in the wild may list
  // either id. Accept ANY of the provided permissions so switching call routes
  // to "use_calls" cannot lock out businesses whose plans only grant "use_chat".
  const requiredList = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user?.businessId;
      if (!businessId) {
         // PERSONAL APP: personal users have no business/plan context and the
         // Personal app is free to use by design — plan gating never applies.
         return next();
      }

      // Get plan permissions. Some admin flows store selectable feature IDs in
      // `features`, so both columns are treated as plan-level access grants.
      // Trial columns: free plans grant trial_permissions on top of the base
      // set while the business is inside its initial trial window.
      const result = await query(
        `SELECT p.permissions, p.features, p.price, p.trial_permissions, b.trial_ends_at
         FROM businesses b
         JOIN pricing_plans p ON b.plan_id = p.id
         WHERE b.id = $1`,
        [businessId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Business plan not found" });
      }

      const permissions = normalizePlanPermissions(result.rows[0].permissions, result.rows[0].features);

      // FREE-FOREVER TRIAL: while a free plan is inside its trial window
      // (trial_ends_at > now) the business gets the plan's trial permissions
      // on top of its base set. An unset/empty trial_permissions (or ["*"])
      // means "everything" — ALL plan-gated features are permitted during the
      // trial ("enjoy all premium features free for 7 days"). After the trial
      // the business falls back to the plan's base permission set.
      const isFreePlan = parseFloat(result.rows[0].price) === 0;
      const trialEndsAt = result.rows[0].trial_ends_at ? new Date(result.rows[0].trial_ends_at) : null;
      if (isFreePlan && trialEndsAt && trialEndsAt > new Date()) {
        const tp = result.rows[0].trial_permissions;
        const trialList = Array.isArray(tp) ? tp.map((v) => String(v)) : null;
        if (!trialList || trialList.length === 0 || trialList.includes("*") || trialList.includes("all")) {
          return next(); // trial unlocks every plan-gated feature
        }
        const trialPerms = normalizePlanPermissions(trialList);
        if (requiredList.some((perm) => trialPerms.has(perm))) {
          return next();
        }
      }

      if (permissions.has("*") || permissions.has("all") || requiredList.some((perm) => permissions.has(perm))) {
        return next();
      }

      return res.status(403).json({
        success: false,
        code: "PLAN_UPGRADE_REQUIRED",
        error: "Kindly upgrade your plan to enjoy this feature."
      });

    } catch (error) {
      console.error("Check feature permission error:", error);
      res.status(500).json({ success: false, error: "Failed to verify feature access" });
    }
  };
};

export const checkKycStatus = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    const businessId = req.user?.businessId;

    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    // Check user KYC status — personal users (businessId NULL) are gated on
    // their own BVN/NIN only; no business context required.
    const userResult = await query(
      `SELECT bvn_status, nin_status FROM users WHERE id = $1`,
      [userId]
    );

    const user = userResult.rows[0];
    const isUserVerified = user?.bvn_status === 'verified' || user?.nin_status === 'verified';

    if (!isUserVerified) {
      return res.status(403).json({
        success: false,
        code: "KYC_REQUIRED",
        error: "KYC verification is required to access this feature. Please complete your KYC verification."
      });
    }

    next();
  } catch (error) {
    console.error("Check KYC status error:", error);
    res.status(500).json({ success: false, error: "Failed to verify KYC status" });
  }
};
