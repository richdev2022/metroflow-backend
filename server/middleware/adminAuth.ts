import { Request, Response, NextFunction } from "express";
import { verifyAdminToken } from "../services/admin-auth";
import { query } from "../db";

export interface AuthenticatedAdminRequest extends Request {
  admin?: {
    adminId: string;
    role: string;
    roleName?: string;
    isSuperAdmin?: boolean;
    permissions?: string[];
  };
}

export const authenticateAdmin = async (
  req: AuthenticatedAdminRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Access token required",
    });
  }

  const decoded = await verifyAdminToken(token);
  if (!decoded) {
    return res.status(403).json({
      success: false,
      error: "Invalid or expired admin token",
    });
  }

  try {
    // Fetch admin role and permissions
    const result = await query(
      `SELECT 
        a.id, 
        r.name as role_name, 
        r.is_super_admin,
        COALESCE(array_agg(p.slug) FILTER (WHERE p.slug IS NOT NULL), '{}') as permissions
       FROM platform_admins a
       LEFT JOIN admin_roles r ON a.role_id = r.id
       LEFT JOIN admin_role_permissions arp ON r.id = arp.role_id
       LEFT JOIN admin_permissions p ON arp.permission_id = p.id
       WHERE a.id = $1
       GROUP BY a.id, r.id`,
      [decoded.adminId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: "Admin not found" });
    }

    const adminData = result.rows[0];

    req.admin = {
      adminId: decoded.adminId,
      role: 'platform_admin',
      roleName: adminData.role_name,
      isSuperAdmin: adminData.is_super_admin,
      permissions: adminData.permissions
    };

    next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
};

export const requirePermission = (permission: string) => {
  return (req: AuthenticatedAdminRequest, res: Response, next: NextFunction) => {
    if (!req.admin) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    if (req.admin.isSuperAdmin) {
      return next();
    }

    if (req.admin.permissions?.includes(permission)) {
      return next();
    }

    res.status(403).json({ success: false, error: "Insufficient permissions" });
  };
};
