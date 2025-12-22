import { Pool } from "pg";
import { hashPassword } from "./services/auth";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

export async function query(text: string, params?: unknown[]) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log("Executed query", { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error("Database error:", error);
    throw error;
  }
}

export async function initializeDatabase() {
  try {
    // Create platform_admins table
    await query(`
      CREATE TABLE IF NOT EXISTS platform_admins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create pricing_plans table
    await query(`
      CREATE TABLE IF NOT EXISTS pricing_plans (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        currency VARCHAR(3) DEFAULT 'USD',
        features JSONB,
        max_team_members INTEGER DEFAULT 5,
        trial_days INTEGER DEFAULT 7,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add columns if they don't exist (for migration)
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_team_members INTEGER DEFAULT 5`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 7`);

    // Add plan_id and subscription_status to businesses
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES pricing_plans(id)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'active'`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP`);
    
    // Add columns for recurring payments
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS card_token VARCHAR(255)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMP`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_used_days INTEGER DEFAULT 0`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_start_date TIMESTAMP`);

    // Create transactions table
    await query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        plan_id UUID REFERENCES pricing_plans(id),
        amount DECIMAL(12, 2) NOT NULL,
        currency VARCHAR(3) DEFAULT 'NGN',
        reference VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'pending', -- pending, success, failed
        gateway_response JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed default pricing plans if not exists
    const plansCheck = await query(`SELECT * FROM pricing_plans`);
    if (plansCheck.rows.length === 0) {
      await query(`
        INSERT INTO pricing_plans (name, description, price, features, max_team_members, trial_days)
        VALUES 
        ('Free Trial', '7-day free trial with limited features', 0, '["Basic Analytics", "Up to 5 Team Members"]', 5, 7),
        ('Starter', 'Perfect for small teams', 29, '["Advanced Analytics", "Up to 20 Team Members", "Email Support"]', 20, 0),
        ('Pro', 'For growing businesses', 99, '["All Features", "Unlimited Team Members", "Priority Support"]', 999999, 0)
      `);
      console.log('Seeded default pricing plans');
    }

    // Seed default platform admin if not exists
    const adminCheck = await query(`SELECT * FROM platform_admins WHERE email = $1`, ['admin@quantigrate.com']);
    if (adminCheck.rows.length === 0) {
      const hashedPassword = hashPassword('admin@123');
      await query(
        `INSERT INTO platform_admins (email, password_hash, name) VALUES ($1, $2, $3)`,
        ['admin@quantigrate.com', hashedPassword, 'Super Admin']
      );
      console.log('Seeded default platform admin');
    }

    // Create businesses table
    await query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        industry VARCHAR(255),
        logo_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create users table (replaces old developers table concept)
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255),
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'member',
        status VARCHAR(50) DEFAULT 'active',
        otp_code VARCHAR(6),
        otp_expires_at TIMESTAMP,
        email_verified BOOLEAN DEFAULT FALSE,
        verified_at TIMESTAMP,
        invite_token VARCHAR(255),
        invite_expires_at TIMESTAMP,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(business_id, email)
      )
    `);

    // Create tasks table with new fields
    await query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        created_by UUID NOT NULL REFERENCES users(id),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        epic VARCHAR(255),
        sprint VARCHAR(255),
        target_value DECIMAL(10, 2) NOT NULL,
        accomplished_value DECIMAL(10, 2) DEFAULT 0,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        due_date DATE,
        status VARCHAR(50) DEFAULT 'pending',
        is_overdue BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add epic and sprint columns if they don't exist (for existing databases)
    await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS epic VARCHAR(255)`);
    await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sprint VARCHAR(255)`);
    await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS images JSONB`);

    // Remove frequency column if it exists (migration)
    await query(`ALTER TABLE tasks DROP COLUMN IF EXISTS frequency`);

    // Migrate 'developer' role to 'member'
    await query(`UPDATE users SET role = 'member' WHERE role = 'developer'`);

    // Create task assignments
    await query(`
      CREATE TABLE IF NOT EXISTS task_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(task_id, user_id)
      )
    `);

    // Migration: Fix task_assignments foreign key constraint to allow user deletion
    // We wrap this in a try-catch to avoid issues if the constraint doesn't exist or other schema mismatches
    try {
      await query(`ALTER TABLE task_assignments ALTER COLUMN assigned_by DROP NOT NULL`);
      await query(`ALTER TABLE task_assignments DROP CONSTRAINT IF EXISTS task_assignments_assigned_by_fkey`);
      await query(`ALTER TABLE task_assignments ADD CONSTRAINT task_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL`);

      // Migration for attachments
      await query(`ALTER TABLE attachments ALTER COLUMN uploaded_by DROP NOT NULL`);
      await query(`ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_uploaded_by_fkey`);
      await query(`ALTER TABLE attachments ADD CONSTRAINT attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL`);

      // Migration for comments
      await query(`ALTER TABLE comments ALTER COLUMN user_id DROP NOT NULL`);
      await query(`ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_user_id_fkey`);
      await query(`ALTER TABLE comments ADD CONSTRAINT comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL`);

      // Migration for Epic comments
      await query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS epic_name VARCHAR(255)`);
      await query(`ALTER TABLE comments ALTER COLUMN task_id DROP NOT NULL`);
    } catch (error) {
      console.error("Migration for foreign key constraints failed:", error);
    }

    // Create attachments table
    await query(`
      CREATE TABLE IF NOT EXISTS attachments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_type VARCHAR(50),
        file_size INTEGER,
        file_url TEXT NOT NULL,
        is_image BOOLEAN DEFAULT FALSE,
        uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create comments table with threading support
    await query(`
      CREATE TABLE IF NOT EXISTS comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        parent_comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        mentions JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create epics table
    await query(`
      CREATE TABLE IF NOT EXISTS epics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(business_id, name)
      )
    `);

    // Add epic_id to tasks table
    await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS epic_id UUID REFERENCES epics(id) ON DELETE SET NULL`);

    // Add likes column to comments
    await query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS likes JSONB DEFAULT '[]'`);
    
    // Add epic_id to comments if not exists (to link comments to specific epic records, though name is also used)
    await query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS epic_id UUID REFERENCES epics(id) ON DELETE CASCADE`);

    // Create activity log for email notifications
    await query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id),
        task_id UUID REFERENCES tasks(id),
        user_id UUID NOT NULL REFERENCES users(id),
        action VARCHAR(50) NOT NULL,
        action_type VARCHAR(255),
        description TEXT,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create ideas table
    await query(`
      CREATE TABLE IF NOT EXISTS ideas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'under_review',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create admin permissions table
    await query(`
      CREATE TABLE IF NOT EXISTS admin_permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create admin roles table
    await query(`
      CREATE TABLE IF NOT EXISTS admin_roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) UNIQUE NOT NULL,
        description TEXT,
        is_super_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create admin role permissions mapping
    await query(`
      CREATE TABLE IF NOT EXISTS admin_role_permissions (
        role_id UUID REFERENCES admin_roles(id) ON DELETE CASCADE,
        permission_id UUID REFERENCES admin_permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      )
    `);

    // Add role_id to platform_admins
    await query(`ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES admin_roles(id) ON DELETE SET NULL`);

    // Seed Admin Permissions
    const permissions = [
      { slug: 'view_dashboard', name: 'View Dashboard', description: 'Access to view dashboard stats and charts' },
      { slug: 'manage_businesses', name: 'Manage Businesses', description: 'Access to view and manage businesses' },
      { slug: 'manage_users', name: 'Manage Users', description: 'Access to view and manage platform users' },
      { slug: 'manage_admins', name: 'Manage Admins', description: 'Access to create, invite and manage other admins' },
      { slug: 'manage_roles', name: 'Manage Roles', description: 'Access to create and manage admin roles' },
      { slug: 'manage_plans', name: 'Manage Plans', description: 'Access to manage pricing plans' },
    ];

    for (const perm of permissions) {
      await query(
        `INSERT INTO admin_permissions (slug, name, description) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (slug) DO NOTHING`,
        [perm.slug, perm.name, perm.description]
      );
    }

    // Seed Super Admin Role
    const superAdminRoleCheck = await query(`SELECT * FROM admin_roles WHERE name = 'Super Admin'`);
    let superAdminRoleId;

    if (superAdminRoleCheck.rows.length === 0) {
      const roleRes = await query(
        `INSERT INTO admin_roles (name, description, is_super_admin) 
         VALUES ($1, $2, $3) RETURNING id`,
        ['Super Admin', 'Full access to all features', true]
      );
      superAdminRoleId = roleRes.rows[0].id;
      console.log('Seeded Super Admin role');
      
      // Assign all permissions to Super Admin role
      const allPermissions = await query(`SELECT id FROM admin_permissions`);
      for (const perm of allPermissions.rows) {
        await query(
          `INSERT INTO admin_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [superAdminRoleId, perm.id]
        );
      }
    } else {
      superAdminRoleId = superAdminRoleCheck.rows[0].id;
    }

    // Assign Super Admin Role to existing Super Admin user
    await query(
      `UPDATE platform_admins SET role_id = $1 WHERE email = 'admin@quantigrate.com' AND role_id IS NULL`,
      [superAdminRoleId]
    );

    console.log("Database tables initialized successfully");
  } catch (error) {
    console.error("Failed to initialize database:", error);
    // Don't throw error to prevent server from crashing
  }
}

export default pool;
