import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../services/auth";

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    businessId: string;
  };
}

export const authenticateToken = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Access token required",
    });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({
      success: false,
      error: "Invalid or expired token",
    });
  }

  req.user = decoded;
  next();
};

import { query } from "../db";

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

    // Check if subscription is explicitly inactive/cancelled
    if (business.subscription_status === 'inactive' || business.subscription_status === 'cancelled') {
         // Allow if trial is still valid? 
         // Usually inactive means manually cancelled or payment failed.
         // If it's a free plan, 'inactive' might mean trial expired.
         
         // If trial date exists and is in future, maybe allow? 
         // But prompt says "After expiration for Free Plan".
         
         if (isFreePlan && trialEndsAt && trialEndsAt < now) {
             return res.status(403).json({
                 success: false,
                 error: "Your subscription has expired. Please upgrade your plan to continue accessing these features."
             });
         }
         
         // For paid plans that are inactive/cancelled
         if (!isFreePlan && business.subscription_status !== 'active') {
             // Maybe they have a grace period or trial?
             // Simplification: if not active and trial expired (or no trial), block.
             if (!trialEndsAt || trialEndsAt < now) {
                return res.status(403).json({
                    success: false,
                    error: "Your subscription has expired. Please upgrade your plan to continue accessing these features."
                });
             }
         }
    }
    
    // Check if Active but Trial Expired (specifically for Free Plan which might stay 'active' until we check dates)
    if (isFreePlan && trialEndsAt && trialEndsAt < now) {
        return res.status(403).json({
            success: false,
            error: "Your subscription has expired. Please upgrade your plan to continue accessing these features."
        });
    }

    next();
  } catch (error) {
    console.error("Check subscription status error:", error);
    // Fail open or closed? Let's fail open to avoid blocking users on DB errors, but log it.
    next();
  }
};

export const checkFeaturePermission = (requiredPermission: string) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user?.businessId;
      if (!businessId) {
         // If no business context (maybe individual user or admin?), decide policy.
         // Assuming this middleware is used for business-scoped features.
         return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      // Get plan permissions
      const result = await query(
        `SELECT p.permissions 
         FROM businesses b
         JOIN pricing_plans p ON b.plan_id = p.id
         WHERE b.id = $1`,
        [businessId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Business plan not found" });
      }

      const permissions = result.rows[0].permissions || [];
      
      // Check if permissions includes the required one
      // The permissions column is JSONB, pg driver parses it to array if it's a JSON array
      if (Array.isArray(permissions) && permissions.includes(requiredPermission)) {
        return next();
      }

      return res.status(403).json({ 
        success: false, 
        error: "Kindly upgrade your plan to enjoy this feature." 
      });

    } catch (error) {
      console.error("Check feature permission error:", error);
      res.status(500).json({ success: false, error: "Failed to verify feature access" });
    }
  };
};
