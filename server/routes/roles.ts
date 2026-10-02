import express, { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest, checkSubscriptionStatus } from "../middleware/auth";
import { authenticateToken } from "../middleware/auth";
import {
  requireTeamPermission,
  withTeamAccess,
  ALL_PERMISSION_IDS,
  DEFAULT_MANAGER_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  TeamAccess,
} from "../middleware/teamAuth";
import { AVAILABLE_PERMISSIONS } from "../config/permissions";
import { ApiResponse } from "@shared/api";

/**
 * Business-team Roles & Permissions ("Role Management").
 *
 * Mirrors the platform-admin RBAC (admin_roles / admin_role_permissions +
 * RoleManagement.tsx) but scoped per business:
 *   - GET    /permissions        -> the selectable permission catalog
 *   - GET    /roles/me           -> the CALLING member's resolved role+permissions
 *   - GET    /roles              -> the business's roles (+ member counts)
 *   - POST   /roles              -> create a role with a permission set
 *   - PUT    /roles/:id          -> rename / rewrite permissions
 *   - DELETE /roles/:id          -> delete (members fall back to their legacy role)
 * Invite flow: POST /team/invite accepts `roleId`; PUT /team/:id/role accepts
 * `roleId` to (re)assign. Enforcement lives in middleware/teamAuth.ts and is
 * wired on the mutating endpoints across the API.
 */

const router = express.Router();

router.use(authenticateToken, checkSubscriptionStatus, withTeamAccess);

const slugOk = (s: string) => AVAILABLE_PERMISSIONS.some((p) => p.id === s);

const sanitizePermissions = (input: unknown): string[] => {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw === "string" && slugOk(raw.trim())) seen.add(raw.trim());
  }
  return [...seen];
};

/**
 * @swagger
 * /roles/permissions:
 *   get:
 *     summary: The selectable permission catalog (for the role editor)
 *     tags: [Team Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Permission catalog
 */
export const getPermissionCatalog: RequestHandler = async (_req, res) => {
  const response: ApiResponse<any> = {
    success: true,
    data: { permissions: AVAILABLE_PERMISSIONS },
  };
  res.json(response);
};

/**
 * @swagger
 * /roles/me:
 *   get:
 *     summary: The calling member's resolved role and permission list
 *     tags: [Team Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Role label + resolved permissions (['*'] for owner/admin)
 */
export const getMyRole: RequestHandler = async (req, res) => {
  const access = (req as any).teamAccess as TeamAccess | null;
  if (!access) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  const isSuper = access.isSuper;
  const permissions = isSuper ? ALL_PERMISSION_IDS : access.permissions;
  const response: ApiResponse<any> = {
    success: true,
    data: {
      role: access.roleLabel,
      roleId: access.roleId,
      isOwner: access.isOwner,
      isSuper,
      // '*' means "everything" (owner/admin); the UI renders a full-access badge.
      permissions,
      wildcard: isSuper,
      defaults: {
        manager: DEFAULT_MANAGER_PERMISSIONS,
        member: DEFAULT_MEMBER_PERMISSIONS,
      },
    },
  };
  res.json(response);
};

/**
 * @swagger
 * /roles:
 *   get:
 *     summary: List the business's roles with member counts
 *     tags: [Team Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Roles list
 */
export const getRoles: RequestHandler = async (req, res) => {
  try {
    const businessId = (req as AuthenticatedRequest).user?.businessId;
    if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const result = await query(
      `SELECT r.id, r.name, r.description, r.is_system, r.permissions,
              r.created_at AS "createdAt", r.updated_at AS "updatedAt",
              (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS "memberCount"
         FROM team_roles r
        WHERE r.business_id = $1
        ORDER BY r.created_at ASC`,
      [businessId]
    );

    const response: ApiResponse<any> = { success: true, data: { roles: result.rows } };
    res.json(response);
  } catch (error) {
    console.error("List roles error:", error);
    res.status(500).json({ success: false, error: "Failed to load roles" });
  }
};

/**
 * @swagger
 * /roles:
 *   post:
 *     summary: Create a role
 *     tags: [Team Roles]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               permissions: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: Role created
 */
export const createRole: RequestHandler = async (req, res) => {
  try {
    const businessId = (req as AuthenticatedRequest).user?.businessId;
    if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const name = String(req.body?.name || "").trim();
    const description = String(req.body?.description || "").trim() || null;
    const permissions = sanitizePermissions(req.body?.permissions);
    if (!name) return res.status(400).json({ success: false, error: "Role name is required" });
    if (name.length > 100) {
      return res.status(400).json({ success: false, error: "Role name is too long (max 100 characters)" });
    }

    const dupe = await query(
      `SELECT id FROM team_roles WHERE business_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
      [businessId, name]
    );
    if (dupe.rows.length > 0) {
      return res.status(409).json({ success: false, error: `A role named "${name}" already exists` });
    }

    const created = await query(
      `INSERT INTO team_roles (business_id, name, description, permissions)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, is_system, permissions,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [businessId, name, description, permissions]
    );

    res.status(201).json({ success: true, data: { role: created.rows[0] }, message: `Role "${name}" created` });
  } catch (error) {
    console.error("Create role error:", error);
    res.status(500).json({ success: false, error: "Failed to create role" });
  }
};

/**
 * @swagger
 * /roles/{id}:
 *   put:
 *     summary: Update a role (name, description, permissions)
 *     tags: [Team Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Updated role
 */
export const updateRole: RequestHandler = async (req, res) => {
  try {
    const businessId = (req as AuthenticatedRequest).user?.businessId;
    const roleId = String(req.params.id || "");
    if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const existing = await query(
      `SELECT id, name, is_system FROM team_roles WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [roleId, businessId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Role not found" });
    }

    const name =
      req.body?.name === undefined ? undefined : String(req.body.name || "").trim();
    const description =
      req.body?.description === undefined ? undefined : String(req.body.description || "").trim() || null;
    const permissions =
      req.body?.permissions === undefined ? undefined : sanitizePermissions(req.body.permissions);

    if (name !== undefined && !name) {
      return res.status(400).json({ success: false, error: "Role name is required" });
    }
    if (name !== undefined && name.length > 100) {
      return res.status(400).json({ success: false, error: "Role name is too long (max 100 characters)" });
    }

    const updated = await query(
      `UPDATE team_roles SET
         name = COALESCE($3, name),
         description = COALESCE($4, description),
         permissions = COALESCE($5, permissions),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND business_id = $2
       RETURNING id, name, description, is_system, permissions,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [roleId, businessId, name ?? null, description ?? null, permissions ?? null]
    );

    res.json({
      success: true,
      data: { role: updated.rows[0] },
      message: "Role updated",
    });
  } catch (error) {
    console.error("Update role error:", error);
    res.status(500).json({ success: false, error: "Failed to update role" });
  }
};

/**
 * @swagger
 * /roles/{id}:
 *   delete:
 *     summary: Delete a role (assigned members fall back to their legacy role)
 *     tags: [Team Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Deleted
 */
export const deleteRole: RequestHandler = async (req, res) => {
  try {
    const businessId = (req as AuthenticatedRequest).user?.businessId;
    const roleId = String(req.params.id || "");
    if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const deleted = await query(
      `DELETE FROM team_roles WHERE id = $1 AND business_id = $2 RETURNING name`,
      [roleId, businessId]
    );
    if (deleted.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Role not found" });
    }

    res.json({
      success: true,
      data: { deleted: true },
      message: `Role "${deleted.rows[0].name}" deleted — members using it fall back to their default role`,
    });
  } catch (error) {
    console.error("Delete role error:", error);
    res.status(500).json({ success: false, error: "Failed to delete role" });
  }
};

// Authenticated, plan-checked base is applied via router.use above; the
// mutating endpoints additionally require the manage_team member permission.
router.get("/permissions", getPermissionCatalog);
router.get("/me", getMyRole);
router.get("/", getRoles);
router.post("/", requireTeamPermission("manage_team"), createRole);
router.put("/:id", requireTeamPermission("manage_team"), updateRole);
router.delete("/:id", requireTeamPermission("manage_team"), deleteRole);

export default router;
