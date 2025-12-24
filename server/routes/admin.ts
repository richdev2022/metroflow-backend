import express from "express";
import { loginAdmin } from "../services/admin-auth";
import { authenticateAdmin, requirePermission, AuthenticatedAdminRequest } from "../middleware/adminAuth";
import { query } from "../db";
import { generateOTP, getOTPExpiry, hashPassword } from "../services/auth";
import { sendEmail, generateAdminInviteEmailHtml } from "../services/email";
import { AVAILABLE_PERMISSIONS } from "../config/permissions";

import * as XLSX from "xlsx";
import { generateBusinessId } from "../utils/idGenerator";

const router = express.Router();

// Admin Login
router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await loginAdmin(email, password);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(401).json({ success: false, error: error.message });
  }
});

// Admin Forgot Password
/**
 * @swagger
 * /admin/auth/forgot-password:
 *   post:
 *     summary: Admin forgot password
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Reset instructions sent
 */
router.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const adminCheck = await query(`SELECT * FROM platform_admins WHERE email = $1`, [email]);
    
    if (adminCheck.rows.length > 0) {
      // In a real app, generate a reset token and send email
      // For now, we'll simulate it by logging
      console.log(`Password reset requested for admin: ${email}`);
      
      // Example email sending logic (commented out as email service might need config)
      /*
      const otp = generateOTP();
      await query(`UPDATE platform_admins SET reset_token = $1, reset_expires = $2 WHERE email = $3`, 
        [otp, getOTPExpiry(), email]);
      await sendEmail(email, "Reset Password", `Your reset code is: ${otp}`);
      */
    }
    
    // Always return success to prevent email enumeration
    res.json({ success: true, message: "If account exists, reset instructions sent." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to process request" });
  }
});

// Dashboard Stats
/**
 * @swagger
 * /admin/dashboard/stats:
 *   get:
 *     summary: Get dashboard statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stats:
 *                   type: object
 *                   properties:
 *                     totalBusinesses:
 *                       type: integer
 *                     totalUsers:
 *                       type: integer
 *                     activeBusinesses:
 *                       type: integer
 *                     totalRevenue:
 *                       type: integer
 */
router.get("/dashboard/stats", authenticateAdmin, requirePermission('view_dashboard'), async (req, res) => {
  try {
    const businessesCount = await query(`SELECT COUNT(*) FROM businesses`);
    const usersCount = await query(`SELECT COUNT(*) FROM users`);
    const activeBusinesses = await query(`SELECT COUNT(*) FROM businesses WHERE subscription_status = 'active'`);
    
    // Real revenue aggregation
    const revenue = await query(`SELECT SUM(amount) as sum FROM transactions WHERE status = 'success'`);

    res.json({
      success: true,
      stats: {
        totalBusinesses: parseInt(businessesCount.rows[0].count),
        totalUsers: parseInt(usersCount.rows[0].count),
        activeBusinesses: parseInt(activeBusinesses.rows[0].count),
        totalRevenue: parseInt(revenue.rows[0].sum || '0')
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch stats" });
  }
});

// Dashboard Charts
/**
 * @swagger
 * /admin/dashboard/charts:
 *   get:
 *     summary: Get dashboard charts data
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Chart data
 */
router.get("/dashboard/charts", authenticateAdmin, requirePermission('view_dashboard'), async (req, res) => {
  try {
    // 1. Revenue Over Time (Last 6 months)
    const revenueRes = await query(`
      SELECT 
        to_char(d, 'Mon') as name, 
        COALESCE(SUM(t.amount), 0) as revenue 
      FROM generate_series(
        date_trunc('month', NOW() - INTERVAL '5 months'), 
        date_trunc('month', NOW()), 
        '1 month'::interval
      ) d
      LEFT JOIN transactions t ON date_trunc('month', t.created_at) = d AND t.status = 'success'
      GROUP BY d
      ORDER BY d ASC
    `);

    // 2. Business Growth (Last 6 months)
    const growthRes = await query(`
      SELECT 
        to_char(d, 'Mon') as name, 
        COUNT(b.id) as businesses 
      FROM generate_series(
        date_trunc('month', NOW() - INTERVAL '5 months'), 
        date_trunc('month', NOW()), 
        '1 month'::interval
      ) d
      LEFT JOIN businesses b ON date_trunc('month', b.created_at) = d
      GROUP BY d
      ORDER BY d ASC
    `);

    // Format data to ensure integer values for chart
    const revenueData = revenueRes.rows.map(row => ({
      name: row.name,
      revenue: parseInt(row.revenue)
    }));

    const businessGrowthData = growthRes.rows.map(row => ({
      name: row.name,
      businesses: parseInt(row.businesses)
    }));

    res.json({
      success: true,
      charts: {
        revenueData,
        businessGrowthData
      }
    });
  } catch (error) {
    console.error("Failed to fetch charts data:", error);
    res.status(500).json({ success: false, error: "Failed to fetch charts data" });
  }
});

// Businesses Management
/**
 * @swagger
 * /admin/businesses:
 *   get:
 *     summary: Get all businesses
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: planId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of businesses
 */
router.get("/businesses", authenticateAdmin, requirePermission('manage_businesses'), async (req, res) => {
  try {
    const { page = 1, limit = 10, search, status, planId } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let queryStr = `
      SELECT b.*, p.name as plan_name 
      FROM businesses b
      LEFT JOIN pricing_plans p ON b.plan_id = p.id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramCount = 1;

    if (search) {
      queryStr += ` AND (b.name ILIKE $${paramCount} OR b.email ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    if (status) {
      queryStr += ` AND b.subscription_status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (planId) {
      queryStr += ` AND b.plan_id = $${paramCount}`;
      params.push(planId);
      paramCount++;
    }

    // Count query
    const countQuery = `SELECT COUNT(*) FROM (${queryStr}) as count_table`;
    const countRes = await query(countQuery, params);
    const total = parseInt(countRes.rows[0].count);

    queryStr += ` ORDER BY b.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await query(queryStr, params);

    res.json({
      success: true,
      businesses: result.rows,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch businesses" });
  }
});

/**
 * @swagger
 * /admin/businesses/{id}/team:
 *   get:
 *     summary: Get business team members
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: List of team members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 team:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get("/businesses/:id/team", authenticateAdmin, requirePermission('manage_businesses'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(`
      SELECT id, name, email, role, status, last_login, created_at
      FROM users
      WHERE business_id = $1
      ORDER BY created_at DESC
    `, [id]);
    res.json({ success: true, team: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch team members" });
  }
});

// Admin Transactions View
/**
 * @swagger
 * /admin/transactions:
 *   get:
 *     summary: Get all transactions
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number
 *       - in: query
 *         name: perPage
 *         schema:
 *           type: integer
 *         description: Items per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by transaction status
 *       - in: query
 *         name: businessId
 *         schema:
 *           type: string
 *         description: Filter by business ID
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by start date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by end date (YYYY-MM-DD)
 *       - in: query
 *         name: reference
 *         schema:
 *           type: string
 *         description: Search by transaction reference
 *     responses:
 *       200:
 *         description: List of transactions with pagination
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transactions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       amount:
 *                         type: number
 *                       currency:
 *                         type: string
 *                       status:
 *                         type: string
 *                       reference:
 *                         type: string
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                       business_name:
 *                         type: string
 *                       plan_name:
 *                         type: string
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     perPage:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 */
router.get("/transactions", authenticateAdmin, requirePermission('view_dashboard'), async (req, res) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const perPage = parseInt(req.query.perPage as string) || 50;
        const offset = (page - 1) * perPage;

        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;
        const reference = req.query.reference as string;
        const status = req.query.status as string;
        const businessId = req.query.businessId as string;

        // Build query
        // Join with businesses to show who paid
        let queryText = `
            SELECT t.*, b.name as business_name, b.email as business_email, p.name as plan_name 
            FROM transactions t
            LEFT JOIN businesses b ON t.business_id = b.id
            LEFT JOIN pricing_plans p ON t.plan_id = p.id
            WHERE 1=1
        `;
        const queryParams: any[] = [];
        let paramIndex = 1;

        if (businessId) {
            queryText += ` AND t.business_id = $${paramIndex}`;
            queryParams.push(businessId);
            paramIndex++;
        }

        if (startDate) {
            queryText += ` AND t.created_at >= $${paramIndex}`;
            queryParams.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            const endDateTime = new Date(endDate);
            endDateTime.setHours(23, 59, 59, 999);
            queryText += ` AND t.created_at <= $${paramIndex}`;
            queryParams.push(endDateTime.toISOString());
            paramIndex++;
        }

        if (reference) {
            queryText += ` AND t.reference ILIKE $${paramIndex}`;
            queryParams.push(`%${reference}%`);
            paramIndex++;
        }

        if (status) {
            queryText += ` AND t.status = $${paramIndex}`;
            queryParams.push(status);
            paramIndex++;
        }

        // Count total
        // Simple count query (ignoring joins if not filtering by joined columns, but for safety we include them)
        const whereClause = queryText.substring(queryText.indexOf("WHERE"));
        const countResult = await query(`SELECT COUNT(*) FROM transactions t ${whereClause}`, queryParams);
        const total = parseInt(countResult.rows[0].count);

        // Sorting and Pagination
        queryText += ` ORDER BY t.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        queryParams.push(perPage, offset);

        const result = await query(queryText, queryParams);

        res.json({ 
            success: true, 
            transactions: result.rows,
            pagination: {
                total,
                page,
                perPage,
                totalPages: Math.ceil(total / perPage)
            }
        });

    } catch (error) {
        console.error("Admin transactions error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch transactions" });
    }
});

/**
 * @swagger
 * /admin/businesses/{id}/status:
 *   put:
 *     summary: Update business status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Status updated
 */
router.put("/businesses/:id/status", authenticateAdmin, requirePermission('manage_businesses'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'active', 'inactive'
    await query(`UPDATE businesses SET subscription_status = $1 WHERE id = $2`, [status, id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to update business status" });
  }
});

// Plan Features (Permissions)
/**
 * @swagger
 * /admin/features:
 *   get:
 *     summary: Get all available plan features/permissions
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available features
 */
router.get("/features", authenticateAdmin, requirePermission('manage_plans'), async (req, res) => {
  res.json({ success: true, features: AVAILABLE_PERMISSIONS });
});

// Pricing Plans
/**
 * @swagger
 * /admin/pricing:
 *   get:
 *     summary: Get all pricing plans
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of pricing plans
 */
router.get("/pricing", authenticateAdmin, requirePermission('manage_plans'), async (req, res) => {
  try {
    const result = await query(`SELECT * FROM pricing_plans ORDER BY price ASC`);
    res.json({ success: true, plans: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch pricing plans" });
  }
});

/**
 * @swagger
 * /admin/pricing:
 *   post:
 *     summary: Create a pricing plan
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - price
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *               currency:
 *                 type: string
 *               features:
 *                 type: array
 *                 items:
 *                   type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *               max_team_members:
 *                 type: integer
 *               trial_days:
 *                 type: integer
 *               duration:
 *                 type: string
 *                 enum: [monthly, yearly]
 *     responses:
 *       200:
 *         description: Plan created
 */
router.post("/pricing", authenticateAdmin, requirePermission('manage_plans'), async (req, res) => {
  try {
    const { name, description, price, currency, features, permissions, max_team_members, trial_days, duration } = req.body;
    await query(
      `INSERT INTO pricing_plans (name, description, price, currency, features, permissions, max_team_members, trial_days, duration) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [name, description, price, currency || 'USD', JSON.stringify(features), JSON.stringify(permissions || []), max_team_members || 5, trial_days || 0, duration || 'monthly']
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to create pricing plan" });
  }
});

/**
 * @swagger
 * /admin/pricing/{id}:
 *   put:
 *     summary: Update a pricing plan
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *               is_active:
 *                 type: boolean
 *               features:
 *                 type: array
 *                 items:
 *                   type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *               max_team_members:
 *                 type: integer
 *               trial_days:
 *                 type: integer
 *               duration:
 *                 type: string
 *                 enum: [monthly, yearly]
 *     responses:
 *       200:
 *         description: Plan updated
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.put("/pricing/:id", authenticateAdmin, requirePermission('manage_plans'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, is_active, features, permissions, max_team_members, trial_days, duration } = req.body;
    
    // Build dynamic update query
    // For simplicity, updating all fields
    await query(
      `UPDATE pricing_plans SET name=$1, description=$2, price=$3, is_active=$4, features=$5, permissions=$6, max_team_members=$7, trial_days=$8, duration=$9, updated_at=CURRENT_TIMESTAMP WHERE id=$10`,
      [name, description, price, is_active, JSON.stringify(features), JSON.stringify(permissions || []), max_team_members, trial_days, duration || 'monthly', id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to update pricing plan" });
  }
});

// RBAC: Permissions Management
/**
 * @swagger
 * /admin/permissions:
 *   get:
 *     summary: Get all available permissions
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of permissions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 permissions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       slug:
 *                         type: string
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 */
router.get("/permissions", authenticateAdmin, requirePermission('manage_roles'), async (req, res) => {
  try {
    const result = await query(`SELECT * FROM admin_permissions ORDER BY name ASC`);
    res.json({ success: true, permissions: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch permissions" });
  }
});

// RBAC: Roles Management
/**
 * @swagger
 * /admin/roles:
 *   get:
 *     summary: Get all admin roles
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of roles with permissions
 */
router.get("/roles", authenticateAdmin, requirePermission('manage_roles'), async (req, res) => {
  try {
    // Get roles with their permission slugs
    const result = await query(`
      SELECT r.*, 
             COALESCE(array_agg(p.slug) FILTER (WHERE p.slug IS NOT NULL), '{}') as permissions
      FROM admin_roles r
      LEFT JOIN admin_role_permissions arp ON r.id = arp.role_id
      LEFT JOIN admin_permissions p ON arp.permission_id = p.id
      GROUP BY r.id
      ORDER BY r.name ASC
    `);
    res.json({ success: true, roles: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch roles" });
  }
});

/**
 * @swagger
 * /admin/roles:
 *   post:
 *     summary: Create a new admin role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of permission slugs
 *     responses:
 *       200:
 *         description: Role created
 */
router.post("/roles", authenticateAdmin, requirePermission('manage_roles'), async (req, res) => {
  try {
    const { name, description, permissions } = req.body; // permissions is array of slugs

    // Start transaction (simple version without explicit BEGIN/COMMIT for now, but careful order)
    // 1. Create Role
    const roleRes = await query(
      `INSERT INTO admin_roles (name, description) VALUES ($1, $2) RETURNING id`,
      [name, description]
    );
    const roleId = roleRes.rows[0].id;

    // 2. Map Permissions
    if (permissions && Array.isArray(permissions) && permissions.length > 0) {
      // Get IDs for these slugs
      // This assumes frontend sends slugs. Alternatively frontend can send IDs.
      // Let's assume slugs as they are more readable in API.
      const permIdsRes = await query(`SELECT id FROM admin_permissions WHERE slug = ANY($1)`, [permissions]);
      
      for (const row of permIdsRes.rows) {
        await query(
          `INSERT INTO admin_role_permissions (role_id, permission_id) VALUES ($1, $2)`,
          [roleId, row.id]
        );
      }
    }

    res.json({ success: true, roleId });
  } catch (error) {
    console.error("Create role error:", error);
    res.status(500).json({ success: false, error: "Failed to create role" });
  }
});

/**
 * @swagger
 * /admin/roles/{id}:
 *   put:
 *     summary: Update an admin role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Role updated
 */
router.put("/roles/:id", authenticateAdmin, requirePermission('manage_roles'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, permissions } = req.body;

    // Check if super admin
    const check = await query(`SELECT is_super_admin FROM admin_roles WHERE id = $1`, [id]);
    if (check.rows.length > 0 && check.rows[0].is_super_admin) {
       return res.status(403).json({ success: false, error: "Cannot modify Super Admin role" });
    }

    await query(
      `UPDATE admin_roles SET name = $1, description = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [name, description, id]
    );

    // Update permissions: Delete old, Insert new
    await query(`DELETE FROM admin_role_permissions WHERE role_id = $1`, [id]);

    if (permissions && Array.isArray(permissions) && permissions.length > 0) {
      const permIdsRes = await query(`SELECT id FROM admin_permissions WHERE slug = ANY($1)`, [permissions]);
      for (const row of permIdsRes.rows) {
        await query(
          `INSERT INTO admin_role_permissions (role_id, permission_id) VALUES ($1, $2)`,
          [id, row.id]
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to update role" });
  }
});

/**
 * @swagger
 * /admin/roles/{id}:
 *   delete:
 *     summary: Delete an admin role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Role deleted
 */
router.delete("/roles/:id", authenticateAdmin, requirePermission('manage_roles'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if super admin
    const check = await query(`SELECT is_super_admin FROM admin_roles WHERE id = $1`, [id]);
    if (check.rows.length > 0 && check.rows[0].is_super_admin) {
       return res.status(403).json({ success: false, error: "Cannot delete Super Admin role" });
    }

    // Check if assigned to any user
    const userCheck = await query(`SELECT COUNT(*) FROM platform_admins WHERE role_id = $1`, [id]);
    if (parseInt(userCheck.rows[0].count) > 0) {
      return res.status(400).json({ success: false, error: "Cannot delete role assigned to users" });
    }

    await query(`DELETE FROM admin_roles WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to delete role" });
  }
});

// RBAC: Admin Users Management
/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: Get all admin users
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of admin users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 admins:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       name:
 *                         type: string
 *                       email:
 *                         type: string
 *                       status:
 *                         type: string
 *                       role_name:
 *                         type: string
 *                       role_id:
 *                         type: string
 *                         format: uuid
 *                       created_at:
 *                         type: string
 *                         format: date-time
 */
router.get("/users", authenticateAdmin, requirePermission('manage_admins'), async (req, res) => {
  try {
    const result = await query(`
      SELECT a.id, a.name, a.email, a.status, a.created_at, r.name as role_name, r.id as role_id
      FROM platform_admins a
      LEFT JOIN admin_roles r ON a.role_id = r.id
      ORDER BY a.created_at DESC
    `);
    res.json({ success: true, admins: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch admins" });
  }
});

/**
 * @swagger
 * /admin/users/invite:
 *   post:
 *     summary: Invite a new admin user
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - roleId
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               roleId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Admin invited successfully
 */
router.post("/users/invite", authenticateAdmin, requirePermission('manage_admins'), async (req, res) => {
  try {
    const { name, email, roleId } = req.body;

    // Check if exists
    const check = await query(`SELECT id FROM platform_admins WHERE email = $1`, [email]);
    if (check.rows.length > 0) {
      return res.status(400).json({ success: false, error: "Admin with this email already exists" });
    }

    // Create temp password
    const tempPassword = Math.random().toString(36).slice(-8);
    const hashed = hashPassword(tempPassword);

    await query(
      `INSERT INTO platform_admins (name, email, password_hash, role_id, status) VALUES ($1, $2, $3, $4, 'pending_invite')`,
      [name, email, hashed, roleId]
    );

    // Send email
    let baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;

    // If no env var, try to infer from request origin (useful for dev/ngrok)
    if (!baseUrl && req.get('origin')) {
      baseUrl = req.get('origin');
    }

    if (!baseUrl) {
      baseUrl = 'http://localhost:5173';
    }

    const loginLink = baseUrl.includes('/login') ? baseUrl : `${baseUrl}/login`;
    const emailHtml = generateAdminInviteEmailHtml(name, email, tempPassword, loginLink);

    const emailSent = await sendEmail(
      email,
      name,
      "Admin Access Invitation",
      emailHtml
    );

    if (!emailSent) {
      console.error("Failed to send admin invite email to", email);
      return res.status(500).json({ success: false, error: "Admin created but failed to send invitation email" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Invite admin error:", error);
    res.status(500).json({ success: false, error: "Failed to invite admin" });
  }
});

/**
 * @swagger
 * /admin/users/{id}:
 *   put:
 *     summary: Update an admin user's role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - roleId
 *             properties:
 *               roleId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Admin updated
 */
router.put("/users/:id", authenticateAdmin, requirePermission('manage_admins'), async (req, res) => {
  try {
    const { id } = req.params;
    const { roleId } = req.body;

    // Prevent modifying Super Admin user if not Super Admin? 
    // Generally, only Super Admins have 'manage_admins' permission usually, or we can enforce that.
    
    // Check target user
    const targetUser = await query(`SELECT email FROM platform_admins WHERE id = $1`, [id]);
    if (targetUser.rows.length > 0 && targetUser.rows[0].email === 'admin@quantigrate.com') {
        // Protect the main super admin
        return res.status(403).json({ success: false, error: "Cannot modify root Super Admin" });
    }

    await query(`UPDATE platform_admins SET role_id = $1 WHERE id = $2`, [roleId, id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to update admin" });
  }
});

/**
 * @swagger
 * /admin/users/{id}/status:
 *   put:
 *     summary: Update an admin user's status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [active, inactive, pending_invite]
 *     responses:
 *       200:
 *         description: Admin status updated
 */
router.put("/users/:id/status", authenticateAdmin, requirePermission('manage_admins'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate status
    if (!['active', 'inactive', 'pending_invite'].includes(status)) {
        return res.status(400).json({ success: false, error: "Invalid status" });
    }

    // Protect root super admin
    const targetUser = await query(`SELECT email FROM platform_admins WHERE id = $1`, [id]);
    if (targetUser.rows.length > 0 && targetUser.rows[0].email === 'admin@quantigrate.com') {
        return res.status(403).json({ success: false, error: "Cannot modify root Super Admin status" });
    }

    await query(`UPDATE platform_admins SET status = $1 WHERE id = $2`, [status, id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to update admin status" });
  }
});

/**
 * @swagger
 * /admin/users/{id}:
 *   delete:
 *     summary: Delete an admin user
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Admin deleted
 */
router.delete("/users/:id", authenticateAdmin, requirePermission('manage_admins'), async (req, res) => {
  try {
    const { id } = req.params;
    const adminReq = req as AuthenticatedAdminRequest;
    
    // Protect root super admin
    const targetUser = await query(`SELECT email FROM platform_admins WHERE id = $1`, [id]);
    if (targetUser.rows.length > 0 && targetUser.rows[0].email === 'admin@quantigrate.com') {
        return res.status(403).json({ success: false, error: "Cannot delete root Super Admin" });
    }

    // Prevent deleting self
    if (adminReq.admin?.adminId === id) {
        return res.status(400).json({ success: false, error: "Cannot delete yourself" });
    }

    await query(`DELETE FROM platform_admins WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to delete admin" });
  }
});

// System Settings
/**
 * @swagger
 * /admin/settings/card-verification-amount:
 *   get:
 *     summary: Get card verification amount
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Card verification amount
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 amount:
 *                   type: integer
 */
router.get("/settings/card-verification-amount", authenticateAdmin, async (req, res) => {
    try {
        const result = await query(`SELECT value FROM system_settings WHERE key = 'card_verification_amount'`);
        const amount = result.rows.length > 0 ? parseInt(result.rows[0].value) : 100;
        res.json({ success: true, amount });
    } catch (error) {
        console.error("Error fetching card verification amount:", error);
        res.status(500).json({ success: false, error: "Failed to fetch settings" });
    }
});

/**
 * @swagger
 * /admin/settings/card-verification-amount:
 *   put:
 *     summary: Update card verification amount
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Settings updated
 */
router.put("/settings/card-verification-amount", authenticateAdmin, async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || isNaN(amount) || amount < 50) {
            return res.status(400).json({ success: false, error: "Invalid amount. Minimum is 50." });
        }
        
        await query(
            `INSERT INTO system_settings (key, value, description) 
             VALUES ('card_verification_amount', $1, 'Amount charged for card verification in Naira')
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
            [amount.toString()]
        );
        
        res.json({ success: true, message: "Card verification amount updated" });
    } catch (error) {
        console.error("Error updating card verification amount:", error);
        res.status(500).json({ success: false, error: "Failed to update settings" });
    }
});

// Helper for CSV download
const sendCSV = (res: any, data: any[], filename: string) => {
    const ws = XLSX.utils.json_to_sheet(data);
    const csv = XLSX.utils.sheet_to_csv(ws);
    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
};

// Webhook Notifications
/**
 * @swagger
 * /admin/webhooks:
 *   get:
 *     summary: Get webhook notifications
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: provider
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Webhook notifications
 */
router.get("/webhooks", authenticateAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 10, provider, status, startDate, endDate, search } = req.query;
        const offset = (Number(page) - 1) * Number(limit);
        
        let queryStr = `SELECT * FROM squad_webhooks WHERE 1=1`;
        const params: any[] = [];
        let paramCount = 1;

        if (provider) {
            queryStr += ` AND provider = $${paramCount}`;
            params.push(provider);
            paramCount++;
        }

        if (status) {
            queryStr += ` AND status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (startDate) {
            queryStr += ` AND created_at >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
        }

        if (endDate) {
            queryStr += ` AND created_at <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
        }

        if (search) {
            queryStr += ` AND payload::text ILIKE $${paramCount}`;
            params.push(`%${search}%`);
            paramCount++;
        }

        const countQuery = `SELECT COUNT(*) FROM (${queryStr}) as count_table`;
        const countRes = await query(countQuery, params);
        const total = parseInt(countRes.rows[0].count);

        queryStr += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(limit, offset);

        const result = await query(queryStr, params);

        res.json({
            success: true,
            webhooks: result.rows,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (error) {
        console.error("Get webhooks error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch webhooks" });
    }
});

// Export Transactions (Admin)
/**
 * @swagger
 * /admin/reports/transactions/export:
 *   get:
 *     summary: Export transactions to CSV
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: End date (YYYY-MM-DD)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Transaction status
 */
router.get("/reports/transactions/export", authenticateAdmin, async (req, res) => {
    try {
        const { startDate, endDate, status } = req.query;
        let queryStr = `
            SELECT t.*, b.name as business_name, b.email as business_email, p.name as plan_name
            FROM transactions t
            LEFT JOIN businesses b ON t.business_id = b.id
            LEFT JOIN pricing_plans p ON t.plan_id = p.id
            WHERE 1=1
        `;
        const params: any[] = [];
        let paramCount = 1;

        if (startDate) {
            queryStr += ` AND t.created_at >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
        }
        if (endDate) {
            queryStr += ` AND t.created_at <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
        }
        if (status) {
            queryStr += ` AND t.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        queryStr += ` ORDER BY t.created_at DESC`;
        const result = await query(queryStr, params);

        sendCSV(res, result.rows, `transactions_admin_${Date.now()}.csv`);
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to export transactions" });
    }
});

// Export Business Users (Admin)
/**
 * @swagger
 * /admin/reports/businesses/export:
 *   get:
 *     summary: Export businesses to CSV
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: End date (YYYY-MM-DD)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Subscription status
 */
router.get("/reports/businesses/export", authenticateAdmin, async (req, res) => {
    try {
        const { startDate, endDate, status } = req.query;
        let queryStr = `
            SELECT b.*, p.name as plan_name
            FROM businesses b
            LEFT JOIN pricing_plans p ON b.plan_id = p.id
            WHERE 1=1
        `;
        const params: any[] = [];
        let paramCount = 1;

        if (startDate) {
            queryStr += ` AND b.created_at >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
        }
        if (endDate) {
            queryStr += ` AND b.created_at <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
        }
        if (status) {
            queryStr += ` AND b.subscription_status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        queryStr += ` ORDER BY b.created_at DESC`;
        const result = await query(queryStr, params);

        sendCSV(res, result.rows, `businesses_admin_${Date.now()}.csv`);
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to export businesses" });
    }
});

// Migration: Recreate Business IDs
/**
 * @swagger
 * /admin/migrate-business-ids:
 *   post:
 *     summary: Recreate all business IDs to updated format
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.post("/migrate-business-ids", authenticateAdmin, requirePermission('manage_businesses'), async (req, res) => {
    try {
        // 1. Fetch all businesses
        const businesses = await query(`SELECT id, name FROM businesses`);
        
        // 2. Prepare tables for Cascade Update
        const tables = ['users', 'tasks', 'transactions', 'epics', 'activity_logs', 'ideas', 'payment_cards'];
        
        for (const table of tables) {
            // Drop existing FK and Add with ON UPDATE CASCADE
            try {
                // Drop by standard name guess
                await query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_business_id_fkey`);
                // Re-add
                await query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE ON UPDATE CASCADE`);
            } catch (err) {
                console.log(`Failed to update constraint for ${table}:`, err);
            }
        }

        let updatedCount = 0;
        const errors = [];

        // 3. Update IDs
        for (const business of businesses.rows) {
            const oldId = business.id;
            const newId = generateBusinessId(business.name);
            
            if (oldId !== newId) {
                try {
                    // Check if newId exists
                    const check = await query(`SELECT id FROM businesses WHERE id = $1`, [newId]);
                    if (check.rows.length > 0) {
                        console.log(`ID collision for ${business.name}: ${newId}`);
                        continue;
                    }

                    await query(`UPDATE businesses SET id = $1 WHERE id = $2`, [newId, oldId]);
                    updatedCount++;
                } catch (err: any) {
                    errors.push({ id: oldId, name: business.name, error: err.message });
                }
            }
        }

        res.json({ success: true, message: `Updated ${updatedCount} businesses`, errors });
    } catch (error) {
        console.error("Migration error:", error);
        res.status(500).json({ success: false, error: "Failed to migrate business IDs" });
    }
});

/**
 * @swagger
 * /admin/subscription/manual-upgrade:
 *   post:
 *     summary: Manually upgrade a business plan (No expiry)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessId
 *               - planId
 *             properties:
 *               businessId:
 *                 type: string
 *               planId:
 *                 type: string
 */
router.post("/subscription/manual-upgrade", authenticateAdmin, requirePermission('manage_plans'), async (req, res) => {
    try {
        const { businessId, planId } = req.body;

        if (!businessId || !planId) {
            return res.status(400).json({ success: false, error: "Business ID and Plan ID are required" });
        }

        // Verify plan exists
        const planCheck = await query(`SELECT id, name FROM pricing_plans WHERE id = $1`, [planId]);
        if (planCheck.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Plan not found" });
        }

        // Update business
        // Set next_billing_date to NULL (Never expires)
        // Set is_manual_subscription to TRUE
        await query(
            `UPDATE businesses 
             SET plan_id = $1, 
                 subscription_status = 'active', 
                 next_billing_date = NULL, 
                 is_manual_subscription = TRUE,
                 updated_at = NOW() 
             WHERE id = $2`,
            [planId, businessId]
        );

        res.json({ success: true, message: `Business upgraded to ${planCheck.rows[0].name} (Manual)` });
    } catch (error) {
        console.error("Manual upgrade error:", error);
        res.status(500).json({ success: false, error: "Failed to upgrade business" });
    }
});

/**
 * @swagger
 * /admin/subscription/manual-upgrade/revoke:
 *   post:
 *     summary: Revoke manual upgrade and revert to Free/Inactive
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessId
 *             properties:
 *               businessId:
 *                 type: string
 */
router.post("/subscription/manual-upgrade/revoke", authenticateAdmin, requirePermission('manage_plans'), async (req, res) => {
    try {
        const { businessId } = req.body;

        if (!businessId) {
            return res.status(400).json({ success: false, error: "Business ID is required" });
        }

        // Find Free Plan
        const freePlan = await query(`SELECT id FROM pricing_plans WHERE price = 0 LIMIT 1`);
        let targetPlanId = null;
        let status = 'inactive';

        if (freePlan.rows.length > 0) {
            targetPlanId = freePlan.rows[0].id;
            status = 'active';
        }

        // Revert business
        await query(
            `UPDATE businesses 
             SET plan_id = $1, 
                 subscription_status = $2, 
                 next_billing_date = NOW(), 
                 is_manual_subscription = FALSE,
                 updated_at = NOW() 
             WHERE id = $3`,
            [targetPlanId, status, businessId]
        );

        res.json({ success: true, message: "Manual upgrade revoked" });
    } catch (error) {
        console.error("Revoke upgrade error:", error);
        res.status(500).json({ success: false, error: "Failed to revoke upgrade" });
    }
});

export default router;
