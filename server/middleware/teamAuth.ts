import { Request, Response, NextFunction } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "./auth";
import { AVAILABLE_PERMISSIONS } from "../config/permissions";

/**
 * Per-member Role & Permission enforcement (business teams).
 *
 * Mirrors the platform-admin RBAC (middleware/adminAuth.ts) but scoped to a
 * business workspace:
 *   - `team_roles` rows belong to a business and carry a permissions array
 *     (slugs from config/permissions.ts AVAILABLE_PERMISSIONS).
 *   - `users.role_id` references the member's custom role. Members whose
 *     `role_id` is NULL fall back to sensible defaults derived from their
 *     legacy `role` string ('owner'/'admin' -> everything, 'manager' ->
 *     DEFAULT_MANAGER_PERMISSIONS, 'member' -> DEFAULT_MEMBER_PERMISSIONS)
 *     so nothing changes for existing teams until an admin assigns roles.
 *   - The business owner always has full access ("*" wildcard).
 */

export const ALL_PERMISSION_IDS = AVAILABLE_PERMISSIONS.map((p) => p.id);

// Members on legacy 'manager' role: everything except team management.
export const DEFAULT_MANAGER_PERMISSIONS: string[] = ALL_PERMISSION_IDS.filter(
  (id) => id !== "manage_team"
);

// Members on legacy 'member' role: day-to-day work + communication, no money
// movement, no team management, no analytics/export.
export const DEFAULT_MEMBER_PERMISSIONS: string[] = [
  "view_dashboard",
  "manage_tasks",
  "manage_epics",
  "manage_ideas",
  "use_meetings",
  "use_chat",
  "use_calls",
  "view_ranking",
  "rtc.audio_call",
  "rtc.video_call",
  "rtc.chat",
  "rtc.file_share",
  "rtc.screen_share",
  "rtc.raise_hand",
  "rtc.join_by_code",
  "rtc.join_by_link",
];

export interface TeamAccess {
  userId: string;
  businessId: string;
  isOwner: boolean;
  /** owner or legacy 'admin' — bypasses every permission check */
  isSuper: boolean;
  roleId: string | null;
  roleLabel: string;
  /** resolved permission slugs; ['*'] when super */
  permissions: string[];
}

export async function loadTeamAccess(req: AuthenticatedRequest): Promise<TeamAccess | null> {
  const userId = req.user?.userId;
  const businessId = req.user?.businessId;
  if (!userId || !businessId) return null;

  const result = await query(
    `SELECT u.role,
            u.role_id,
            tr.name  AS role_name,
            tr.permissions AS role_permissions,
            (b.owner_id = u.id) AS is_owner
       FROM users u
       JOIN businesses b ON b.id = u.business_id
       LEFT JOIN team_roles tr ON tr.id = u.role_id
      WHERE u.id = $1 AND u.business_id = $2
      LIMIT 1`,
    [userId, businessId]
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const isOwner = row.is_owner === true || row.role === "owner";
  const isSuper = isOwner || row.role === "admin";

  let permissions: string[];
  let roleLabel: string;
  if (isSuper) {
    permissions = ["*"];
    roleLabel = isOwner ? "Owner" : "Admin";
  } else if (row.role_id && Array.isArray(row.role_permissions)) {
    permissions = row.role_permissions;
    roleLabel = row.role_name || row.role;
  } else if (row.role === "manager") {
    permissions = DEFAULT_MANAGER_PERMISSIONS;
    roleLabel = "Manager";
  } else {
    permissions = DEFAULT_MEMBER_PERMISSIONS;
    roleLabel = "Member";
  }

  return {
    userId,
    businessId,
    isOwner,
    isSuper,
    roleId: row.role_id || null,
    roleLabel,
    permissions,
  };
}

/**
 * Route middleware: allow only members whose resolved permissions include ANY
 * of the required slugs. The owner/admin passes everything.
 *
 * NOTE: unlike the plan-level gates (fail-open on DB errors so outages never
 * lock whole workspaces out), permission enforcement fails CLOSED — a broken
 * permission lookup must never silently grant access.
 */
export const requireTeamPermission = (...needed: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const access = await loadTeamAccess(req as AuthenticatedRequest);
      if (!access) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
      (req as any).teamAccess = access;

      if (access.isSuper || needed.length === 0) return next();
      if (needed.some((p) => access.permissions.includes(p))) return next();

      return res.status(403).json({
        success: false,
        code: "INSUFFICIENT_TEAM_PERMISSION",
        error: `Your role ("${access.roleLabel}") doesn't include the permission needed for this action. Ask your workspace admin to update your role.`,
        data: { needed, role: access.roleLabel, permissions: access.permissions },
      });
    } catch (error) {
      console.error("Team permission check error:", error);
      return res.status(500).json({ success: false, error: "Failed to verify your permissions" });
    }
  };
};

/** Attach team access (if any) without blocking — used by read-only listing endpoints. */
export const withTeamAccess = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    (req as any).teamAccess = await loadTeamAccess(req as AuthenticatedRequest);
  } catch (error) {
    console.error("Team access load error:", error);
  }
  next();
};
