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