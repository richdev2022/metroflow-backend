import express from "express";
import { loginAdmin } from "../services/admin-auth";
import { authenticateAdmin, requirePermission } from "../middleware/adminAuth";
import { query } from "../db";
import { generateOTP, getOTPExpiry, hashPassword } from "../services/auth";
import { sendEmail } from "../services/email";

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
 *     responses:
 *       200:
 *         description: List of businesses
 */
router.get("/businesses", authenticateAdmin, requirePermission('manage_businesses'), async (req, res) => {
  try {
    const result = await query(`
      SELECT b.*, p.name as plan_name 
      FROM businesses b
      LEFT JOIN pricing_plans p ON b.plan_id = p.id
      ORDER BY b.created_at DESC
    `);
    res.json({ success: true, businesses: result.rows });
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
 *       - in: query
 *         name: perPage
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: businessId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of transactions
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
 *               max_team_members:
 *                 type: integer
 *               trial_days:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Plan created
 */
router.post("/pricing", authenticateAdmin, requirePermission('manage_plans'), async (req, res) => {
  try {
    const { name, description, price, currency, features, max_team_members, trial_days } = req.body;
    await query(
      `INSERT INTO pricing_plans (name, description, price, currency, features, max_team_members, trial_days) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [name, description, price, currency || 'USD', JSON.stringify(features), max_team_members || 5, trial_days || 0]
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
 *               max_team_members:
 *                 type: integer
 *               trial_days:
 *                 type: integer
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
    const { name, description, price, is_active, features, max_team_members, trial_days } = req.body;
    
    // Build dynamic update query
    // For simplicity, updating all fields
    await query(
      `UPDATE pricing_plans SET name=$1, description=$2, price=$3, is_active=$4, features=$5, max_team_members=$6, trial_days=$7, updated_at=CURRENT_TIMESTAMP WHERE id=$8`,
      [name, description, price, is_active, JSON.stringify(features), max_team_members, trial_days, id]
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
 */
router.get("/users", authenticateAdmin, requirePermission('manage_admins'), async (req, res) => {
  try {
    const result = await query(`
      SELECT a.id, a.name, a.email, a.created_at, r.name as role_name, r.id as role_id
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
      `INSERT INTO platform_admins (name, email, password_hash, role_id) VALUES ($1, $2, $3, $4)`,
      [name, email, hashed, roleId]
    );

    // Send email
    await sendEmail(
      email,
      "Admin Access Invitation",
      `You have been invited as an admin. Your temporary password is: ${tempPassword}\nPlease login and change it immediately.`
    );

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
    
    // Protect root super admin
    const targetUser = await query(`SELECT email FROM platform_admins WHERE id = $1`, [id]);
    if (targetUser.rows.length > 0 && targetUser.rows[0].email === 'admin@quantigrate.com') {
        return res.status(403).json({ success: false, error: "Cannot delete root Super Admin" });
    }

    // Prevent deleting self
    if (req.admin?.adminId === id) {
        return res.status(400).json({ success: false, error: "Cannot delete yourself" });
    }

    await query(`DELETE FROM platform_admins WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to delete admin" });
  }
});

export default router;
