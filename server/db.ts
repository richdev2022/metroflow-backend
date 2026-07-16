import { Pool } from "pg";
import { hashPassword } from "./services/auth";

console.log("Initializing DB Pool...");

const parseIntegerEnv = (name: string, fallback: number) => {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBooleanEnv = (name: string, fallback = false) => {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const databaseUrl = process.env.DATABASE_URL;
const isServerless = Boolean(process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT);
const databaseHost = (() => {
  if (!databaseUrl) {
    return "";
  }

  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return "";
  }
})();
const isLocalDatabase = ["localhost", "127.0.0.1", "::1"].includes(databaseHost);
const usesNeon = databaseHost.includes("neon.tech");
const sslDisabled = databaseUrl?.includes("sslmode=disable") || process.env.PGSSLMODE === "disable";
const shouldUseSsl = !sslDisabled && !isLocalDatabase;
const defaultPoolMax = isServerless ? 1 : usesNeon ? 5 : 10;
const defaultConnectionTimeout = usesNeon ? 60000 : 30000;
const defaultIdleTimeout = usesNeon ? 30000 : 10000;
const channelBindingRequired = databaseUrl?.includes("channel_binding=require");

console.log("DB Pool config", {
  host: databaseHost || "not configured",
  ssl: shouldUseSsl,
  channelBinding: channelBindingRequired,
  poolMax: parseIntegerEnv("PGPOOL_MAX", defaultPoolMax),
  connectionTimeoutMs: parseIntegerEnv("PG_CONNECTION_TIMEOUT_MS", defaultConnectionTimeout),
  idleTimeoutMs: parseIntegerEnv("PG_IDLE_TIMEOUT_MS", defaultIdleTimeout),
});

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: shouldUseSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: parseIntegerEnv("PG_CONNECTION_TIMEOUT_MS", defaultConnectionTimeout),
  idleTimeoutMillis: parseIntegerEnv("PG_IDLE_TIMEOUT_MS", defaultIdleTimeout),
  max: parseIntegerEnv("PGPOOL_MAX", defaultPoolMax),
  maxUses: parseIntegerEnv("PG_MAX_USES", 750),
  keepAlive: true,
  keepAliveInitialDelayMillis: parseIntegerEnv("PG_KEEPALIVE_INITIAL_DELAY_MS", 10000),
  enableChannelBinding: channelBindingRequired,
});

// Add error handler to prevent server crash on idle client errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  // Don't exit process, just log. The pool will discard the client.
});

// Retry logic for transient errors (like DNS/Connection timeouts)
const MAX_RETRIES = parseIntegerEnv("DB_MAX_RETRIES", 3);
const RETRY_DELAY = parseIntegerEnv("DB_RETRY_DELAY_MS", 1000);
const RETRY_WRITES = parseBooleanEnv("DB_RETRY_WRITES", false);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const isTransientDatabaseError = (error: any) => {
  return error.code === 'ENOTFOUND' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNRESET' ||
    error.code === 'ECONNREFUSED' ||
    error.message?.includes('timeout') ||
    error.message?.includes('Connection terminated') ||
    error.message?.includes('Client has encountered a connection error');
};

const canRetryQuery = (text: string) => {
  if (RETRY_WRITES) {
    return true;
  }

  const normalized = text.trim().toLowerCase();
  return normalized.startsWith('select') ||
    normalized.startsWith('show') ||
    normalized.startsWith('with') ||
    normalized.startsWith('create table if not exists') ||
    normalized.startsWith('create index if not exists') ||
    normalized.startsWith('create extension if not exists') ||
    normalized.startsWith('alter table');
};

const getRetryDelay = (attempt: number) => RETRY_DELAY * attempt;

async function fixUuidIdDefaults(tableNames: string[]) {
  for (const tableName of tableNames) {
    if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }

    try {
      await query(`ALTER TABLE ${tableName} ALTER COLUMN id SET DEFAULT gen_random_uuid()`);

      const nullIdRows = await query(`SELECT * FROM ${tableName} WHERE id IS NULL`);
      if (nullIdRows.rows.length > 0) {
        await query(`UPDATE ${tableName} SET id = gen_random_uuid() WHERE id IS NULL`);
        console.log(`Fixed ${nullIdRows.rows.length} rows with null ids in ${tableName}`);
      }
    } catch (error) {
      console.log(`Could not fix id column on ${tableName}:`, error.message);
    }
  }
}

async function fixExistingUuidIdDefaults() {
  try {
    const result = await query(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'id'
        AND udt_name = 'uuid'
    `);

    await fixUuidIdDefaults(result.rows.map((row) => row.table_name));
  } catch (error) {
    console.log('Could not repair existing UUID id defaults:', error.message);
  }
}

async function ensureBaseSchemaTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS businesses (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      industry VARCHAR(255),
      logo_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
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

  await query(`
    CREATE TABLE IF NOT EXISTS ideas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      status VARCHAR(50) DEFAULT 'under_review',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export async function query(text: string, params?: unknown[]) {
  const start = Date.now();
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      // Only log slow queries or mutations to reduce noise
      if (duration > 1000 || !text.trim().toLowerCase().startsWith('select')) {
         console.log("Executed query", { text: text.substring(0, 50) + '...', duration, rows: res.rowCount });
      }
      return res;
    } catch (error: any) {
      lastError = error;
      const isTransient = isTransientDatabaseError(error);
      const shouldRetry = isTransient && canRetryQuery(text) && attempt < MAX_RETRIES;
      
      if (shouldRetry) {
        const delay = getRetryDelay(attempt);
        console.warn(`Database query failed (Attempt ${attempt}/${MAX_RETRIES}). Retrying in ${delay}ms... Error: ${error.message}`);
        await sleep(delay);
        continue;
      }
      
      console.error("Database error:", error);
      throw error;
    }
  }
  throw lastError;
}

export async function initializeDatabase() {
  try {
    try {
      await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    } catch (error) {
      console.log('Could not enable pgcrypto extension:', error.message);
    }

    await fixExistingUuidIdDefaults();

    // Create platform_admins table
    await query(`
      CREATE TABLE IF NOT EXISTS platform_admins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add status column if not exists (migration)
    await query(`ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'`);

    // Fix id column for existing platform_admins table
    try {
      await query(`ALTER TABLE platform_admins ALTER COLUMN id SET DEFAULT gen_random_uuid()`);

      const nullIdRows = await query(`SELECT * FROM platform_admins WHERE id IS NULL`);
      if (nullIdRows.rows.length > 0) {
        await query(`UPDATE platform_admins SET id = gen_random_uuid() WHERE id IS NULL`);
        console.log(`Fixed ${nullIdRows.rows.length} rows with null ids in platform_admins`);
      }
    } catch (error) {
      console.log('Could not fix id column on platform_admins:', error.message);
    }

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
        duration VARCHAR(20) DEFAULT 'monthly',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Fix id column for existing pricing_plans table
    try {
      // Set default for id column
      await query(`ALTER TABLE pricing_plans ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
      
      // Update any existing rows with null ids
      const nullIdRows = await query(`SELECT * FROM pricing_plans WHERE id IS NULL`);
      if (nullIdRows.rows.length > 0) {
        await query(`UPDATE pricing_plans SET id = gen_random_uuid() WHERE id IS NULL`);
        console.log(`Fixed ${nullIdRows.rows.length} rows with null ids in pricing_plans`);
      }
    } catch (error) {
      console.log('Could not fix id column on pricing_plans:', error.message);
    }

    // Add columns if they don't exist (for migration)
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_team_members INTEGER DEFAULT 5`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 7`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '[]'`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS duration VARCHAR(20) DEFAULT 'monthly'`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS discount DECIMAL(10, 2) DEFAULT 0`);

    await ensureBaseSchemaTables();

    // Add plan_id and subscription_status to businesses
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES pricing_plans(id)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'active'`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP`);
    
    // Add columns for recurring payments
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS card_token VARCHAR(255)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMP`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_used_days INTEGER DEFAULT 0`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_start_date TIMESTAMP`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_manual_subscription BOOLEAN DEFAULT FALSE`);

    // Add payroll configuration columns to businesses
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS salary_interval VARCHAR(20) DEFAULT 'monthly'`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS salary_custom_date TIMESTAMP`);
    
    // Add transaction PIN and OTP toggle columns
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS transaction_pin_hash VARCHAR(255)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS otp_enabled BOOLEAN DEFAULT TRUE`);

    // Create transactions table
    await query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) REFERENCES businesses(id),
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

    // Create settlements table
    await query(`
      CREATE TABLE IF NOT EXISTS settlements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID REFERENCES transactions(id),
        business_id VARCHAR(255) REFERENCES businesses(id),
        user_id UUID REFERENCES users(id),
        amount DECIMAL(12, 2) NOT NULL,
        currency VARCHAR(3) DEFAULT 'NGN',
        status VARCHAR(50) DEFAULT 'pending', -- pending, settled, failed
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed default pricing plans if not exists
    const plansCheck = await query(`SELECT * FROM pricing_plans`);
    if (plansCheck.rows.length === 0) {
      await query(`
        INSERT INTO pricing_plans (name, description, price, features, max_team_members, trial_days, permissions)
        VALUES 
        ('Free Trial', '7-day free trial with limited features', 0, '["Basic Analytics", "Up to 5 Team Members"]', 5, 7, '["view_dashboard", "manage_tasks", "manage_team", "use_meetings", "use_chat", "use_calls", "rtc.audio_call", "rtc.video_call", "rtc.instant_meeting", "rtc.schedule_meeting", "rtc.recording", "rtc.screen_share", "rtc.chat", "rtc.raise_hand", "rtc.waiting_room", "rtc.join_by_code", "rtc.join_by_link"]'),
        ('Starter', 'Perfect for small teams', 29, '["Advanced Analytics", "Up to 20 Team Members", "Email Support"]', 20, 0, '["view_dashboard", "manage_tasks", "manage_team", "view_activity", "use_meetings", "use_chat", "use_calls", "rtc.audio_call", "rtc.video_call", "rtc.group_call", "rtc.instant_meeting", "rtc.schedule_meeting", "rtc.recording", "rtc.screen_share", "rtc.chat", "rtc.raise_hand", "rtc.waiting_room", "rtc.host_controls", "rtc.co_host", "rtc.meeting_password", "rtc.join_by_code", "rtc.join_by_link", "rtc.allow_guest_join"]'),
        ('Pro', 'For growing businesses', 99, '["All Features", "Unlimited Team Members", "Priority Support"]', 999999, 0, '["view_dashboard", "manage_tasks", "manage_team", "manage_epics", "manage_ideas", "view_activity", "export_data", "view_ranking", "manage_finance", "use_meetings", "use_chat", "use_calls", "rtc.audio_call", "rtc.video_call", "rtc.group_call", "rtc.instant_meeting", "rtc.schedule_meeting", "rtc.recording", "rtc.screen_share", "rtc.file_share", "rtc.chat", "rtc.raise_hand", "rtc.waiting_room", "rtc.breakout_room", "rtc.host_controls", "rtc.co_host", "rtc.meeting_password", "rtc.join_by_code", "rtc.join_by_link", "rtc.allow_guest_join", "rtc.max_meeting_duration", "rtc.max_participants", "rtc.max_recording_storage", "rtc.max_recording_duration", "rtc.analytics"]')
      `);
      console.log('Seeded default pricing plans');
    } else {
      // Update existing plans with permissions
      await query(`
        UPDATE pricing_plans 
        SET permissions = '["view_dashboard", "manage_tasks", "manage_team", "use_meetings", "use_chat", "use_calls", "rtc.audio_call", "rtc.video_call", "rtc.instant_meeting", "rtc.schedule_meeting", "rtc.recording", "rtc.screen_share", "rtc.chat", "rtc.raise_hand", "rtc.waiting_room", "rtc.join_by_code", "rtc.join_by_link"]'
        WHERE name = 'Free Trial'
      `);
      await query(`
        UPDATE pricing_plans 
        SET permissions = '["view_dashboard", "manage_tasks", "manage_team", "view_activity", "use_meetings", "use_chat", "use_calls", "rtc.audio_call", "rtc.video_call", "rtc.group_call", "rtc.instant_meeting", "rtc.schedule_meeting", "rtc.recording", "rtc.screen_share", "rtc.chat", "rtc.raise_hand", "rtc.waiting_room", "rtc.host_controls", "rtc.co_host", "rtc.meeting_password", "rtc.join_by_code", "rtc.join_by_link", "rtc.allow_guest_join"]'
        WHERE name = 'Starter'
      `);
      await query(`
        UPDATE pricing_plans 
        SET permissions = '["view_dashboard", "manage_tasks", "manage_team", "manage_epics", "manage_ideas", "view_activity", "export_data", "view_ranking", "manage_finance", "use_meetings", "use_chat", "use_calls", "rtc.audio_call", "rtc.video_call", "rtc.group_call", "rtc.instant_meeting", "rtc.schedule_meeting", "rtc.recording", "rtc.screen_share", "rtc.file_share", "rtc.chat", "rtc.raise_hand", "rtc.waiting_room", "rtc.breakout_room", "rtc.host_controls", "rtc.co_host", "rtc.meeting_password", "rtc.join_by_code", "rtc.join_by_link", "rtc.allow_guest_join", "rtc.max_meeting_duration", "rtc.max_participants", "rtc.max_recording_storage", "rtc.max_recording_duration", "rtc.analytics"]'
        WHERE name = 'Pro'
      `);
      console.log('Updated existing pricing plans with permissions');
    }

    // Add RTC limit and toggle columns to pricing_plans
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_meeting_duration INT`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_participants INT`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_recording_duration INT`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_recording_storage INT`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS waiting_room_enabled BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS recording_enabled BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS screen_sharing_enabled BOOLEAN DEFAULT TRUE`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS breakout_rooms_enabled BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS virtual_backgrounds BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS live_captions BOOLEAN DEFAULT FALSE`);

    // Seed default platform admin if not exists
    const adminCheck = await query(`SELECT * FROM platform_admins WHERE email = $1`, ['sunday@metricorex.com']);
    if (adminCheck.rows.length === 0) {
      const hashedPassword = await hashPassword('Password@123');
      await query(
        `INSERT INTO platform_admins (email, password_hash, name) VALUES ($1, $2, $3)`,
        ['sunday@metricorex.com', hashedPassword, 'Super Admin']
      );
      console.log('Seeded default platform admin');
    }

    // Create businesses table
    await query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        industry VARCHAR(255),
        logo_url TEXT,
        owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add owner_id to businesses if not exists
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL`);

    // Add KYC columns to businesses
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(50) DEFAULT 'pending'`);

    await query(`
      CREATE TABLE IF NOT EXISTS product_documentation (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) REFERENCES businesses(id),
        idea_id UUID REFERENCES ideas(id),
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        logo_url TEXT,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(50) DEFAULT 'completed'
      )
    `);

    await query(`ALTER TABLE product_documentation ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'completed'`);

    await query(`
      CREATE TABLE IF NOT EXISTS product_documentation_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) REFERENCES businesses(id),
        user_id UUID REFERENCES users(id),
        idea_id UUID REFERENCES ideas(id),
        doc_id UUID REFERENCES product_documentation(id),
        job_type VARCHAR(50) NOT NULL,
        areas_of_concern TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS proof_of_address_url TEXT`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_country VARCHAR(100)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_state VARCHAR(100)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_city VARCHAR(100)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_street VARCHAR(255)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_house_number VARCHAR(50)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cac_number VARCHAR(50)`);

    // Create users table (replaces old developers table concept)
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
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
    
    // Add columns to users if they don't exist
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS salary_amount DECIMAL(15, 2) DEFAULT 0`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS salary_currency VARCHAR(3) DEFAULT 'NGN'`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS contract_start_date TIMESTAMP`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(50) DEFAULT 'pending'`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);

    // Add bank details and salary columns to users
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_code VARCHAR(10)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number VARCHAR(20)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_name VARCHAR(255)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS salary_amount DECIMAL(12, 2) DEFAULT 0`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS salary_currency VARCHAR(3) DEFAULT 'NGN'`);

    // Create tasks table with new fields
    await query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
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

    } catch (error) {
      console.error("Migration for task_assignments foreign key constraint failed:", error);
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

    // Migration: Fix nullable user references after the dependent tables exist.
    try {
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
      console.error("Migration for attachments/comments foreign key constraints failed:", error);
    }

    // Create epics table
    await query(`
      CREATE TABLE IF NOT EXISTS epics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
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
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id),
        task_id UUID REFERENCES tasks(id),
        user_id UUID NOT NULL REFERENCES users(id),
        action VARCHAR(50) NOT NULL,
        action_type VARCHAR(255),
        description TEXT,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create wallets table
    await query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) REFERENCES businesses(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        balance DECIMAL(15, 2) DEFAULT 0.00,
        currency VARCHAR(3) DEFAULT 'NGN',
        status VARCHAR(50) DEFAULT 'active', -- active, frozen
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(business_id),
        UNIQUE(user_id)
      )
    `);

    // Add columns if table exists (for existing deployments)
    await query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS virtual_account_number VARCHAR(20)`);
    await query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS bank_code VARCHAR(10)`);
    await query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS account_name VARCHAR(255)`);
    await query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS customer_identifier VARCHAR(255)`);
    await query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS beneficiary_account VARCHAR(20)`);
    await query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50)`);
    await query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS provider_metadata JSONB`);

    // Create virtual_accounts table (multiple VAs per wallet, one per provider)
    await query(`
      CREATE TABLE IF NOT EXISTS virtual_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
        payment_provider VARCHAR(50) NOT NULL,
        virtual_account_number VARCHAR(20),
        bank_code VARCHAR(10),
        account_name VARCHAR(255),
        customer_identifier VARCHAR(255),
        beneficiary_account VARCHAR(20),
        provider_metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(wallet_id, payment_provider)
      )
    `);

    // Add virtual_accounts table columns (for existing deployments)
    try {
        await query(`ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE`);
    } catch (error) {
        console.warn("Could not add wallet_id column to virtual_accounts (it may already exist):", error);
    }
    try {
        await query(`ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50)`);
    } catch (error) {
        console.warn("Could not add payment_provider column to virtual_accounts (it may already exist):", error);
    }
    await query(`ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS virtual_account_number VARCHAR(20)`);
    await query(`ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS bank_code VARCHAR(10)`);
    await query(`ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS account_name VARCHAR(255)`);
    await query(`ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS customer_identifier VARCHAR(255)`);
    await query(`ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS beneficiary_account VARCHAR(20)`);
    await query(`ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS provider_metadata JSONB`);

    await fixUuidIdDefaults([
      'transactions',
      'settlements',
      'product_documentation',
      'product_documentation_jobs',
      'users',
      'tasks',
      'task_assignments',
      'attachments',
      'comments',
      'epics',
      'activity_logs',
      'wallets',
      'virtual_accounts'
    ]);
    
    // Try to add unique constraint, ignore error if it already exists
    try {
        const checkConstraint = await query(`
            SELECT 1 FROM pg_constraint 
            WHERE conname = 'virtual_accounts_wallet_provider_key'
        `);
        
        if (checkConstraint.rows.length === 0) {
            await query(`ALTER TABLE virtual_accounts ADD CONSTRAINT virtual_accounts_wallet_provider_key UNIQUE(wallet_id, payment_provider)`);
        }
    } catch (error) {
        console.warn("Could not add unique constraint to virtual_accounts:", error);
    }
    
    // Migrate existing virtual accounts from wallets to virtual_accounts table
    try {
        console.log("Migrating existing virtual accounts from wallets to virtual_accounts table...");
        const walletsRes = await query(`
            SELECT id, virtual_account_number, bank_code, account_name, customer_identifier, 
                   beneficiary_account, payment_provider, provider_metadata
            FROM wallets
            WHERE virtual_account_number IS NOT NULL
        `);
        
        for (const wallet of walletsRes.rows) {
            const provider = wallet.payment_provider || 'squad';
            // Check if VA already exists for this provider
            const existingVaRes = await query(
                `SELECT id FROM virtual_accounts WHERE wallet_id = $1 AND payment_provider = $2`,
                [wallet.id, provider]
            );
            
            if (existingVaRes.rows.length === 0) {
                // Insert VA into virtual_accounts
                await query(`
                    INSERT INTO virtual_accounts 
                    (wallet_id, payment_provider, virtual_account_number, bank_code, account_name, 
                     customer_identifier, beneficiary_account, provider_metadata)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [
                    wallet.id, 
                    provider, 
                    wallet.virtual_account_number, 
                    wallet.bank_code, 
                    wallet.account_name, 
                    wallet.customer_identifier, 
                    wallet.beneficiary_account, 
                    wallet.provider_metadata
                ]);
                console.log(`Migrated VA for wallet ${wallet.id} to virtual_accounts table`);
            } else {
                console.log(`VA already exists for wallet ${wallet.id} and provider ${provider}, skipping`);
            }
        }
        console.log("Virtual accounts migration completed");
    } catch (error) {
        console.warn("Failed to migrate existing virtual accounts:", error);
    }
    
    // Add wallet_id to transactions
    await query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS wallet_id UUID REFERENCES wallets(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS direction VARCHAR(10) DEFAULT 'credit'`); // credit, debit
    await query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fee NUMERIC(20, 2) DEFAULT 0`);


    // Add KYC columns to users
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bvn VARCHAR(20)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nin VARCHAR(20)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) DEFAULT 'none'`); // none, pending_otp, verified, rejected
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bvn_status VARCHAR(20) DEFAULT 'pending'`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nin_status VARCHAR(20) DEFAULT 'pending'`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_data JSONB`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_hash VARCHAR(255)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_type VARCHAR(20)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(45)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_user_agent TEXT`);
    
    // Create audit logs table
    await query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) REFERENCES businesses(id),
        user_id UUID REFERENCES users(id),
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50),
        entity_id VARCHAR(255),
        old_values JSONB,
        new_values JSONB,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create login attempts table
    await query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        success BOOLEAN NOT NULL,
        failure_reason VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await fixUuidIdDefaults(['audit_logs', 'login_attempts']);
    
    // Create indexes for security tables
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_business_id ON audit_logs(business_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_created_at ON login_attempts(created_at DESC)`);

    // Add KYC columns to businesses
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) DEFAULT 'none'`); // none, pending, verified, rejected
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS proof_of_address TEXT`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS proof_of_address_url TEXT`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_country VARCHAR(100)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_state VARCHAR(100)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_city VARCHAR(100)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_street VARCHAR(255)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_house_number VARCHAR(50)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'NGN'`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS temp_phone VARCHAR(20)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS temp_email VARCHAR(255)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS otp_code VARCHAR(6)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP`);
    
    // Add columns for pending subscription changes
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pending_subscription_change VARCHAR(50)`); // 'cancel', 'downgrade'
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pending_plan_id UUID REFERENCES pricing_plans(id)`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS active_payment_provider VARCHAR(50) DEFAULT 'squad'`);

    // Create ideas table
    await query(`
      CREATE TABLE IF NOT EXISTS ideas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
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

    // Create payment_cards table
    await query(`
      CREATE TABLE IF NOT EXISTS payment_cards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        token_id VARCHAR(255) NOT NULL,
        last4 VARCHAR(4),
        card_type VARCHAR(50),
        exp_month VARCHAR(2),
        exp_year VARCHAR(4),
        is_active BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create squad_webhooks table
    await query(`
      CREATE TABLE IF NOT EXISTS squad_webhooks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type VARCHAR(255),
        payload JSONB,
        status VARCHAR(50) DEFAULT 'processed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create transfer_queue table
    await query(`
      CREATE TABLE IF NOT EXISTS transfer_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) REFERENCES businesses(id),
        reference VARCHAR(255) UNIQUE NOT NULL,
        recipient_account VARCHAR(50) NOT NULL,
        recipient_bank VARCHAR(10) NOT NULL,
        recipient_name VARCHAR(255),
        amount DECIMAL(12, 2) NOT NULL,
        currency VARCHAR(3) DEFAULT 'NGN',
        remark TEXT,
        status VARCHAR(50) DEFAULT 'pending', -- pending, success, failed, processing
        failure_reason TEXT,
        source_type VARCHAR(50), -- sprint, task, salary
        source_id VARCHAR(255),
        meta_data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add security columns to transfer_queue
    await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS transaction_hash VARCHAR(64)`);
    await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS initiated_by UUID REFERENCES users(id)`);

    await fixUuidIdDefaults([
      'ideas',
      'admin_permissions',
      'admin_roles',
      'payment_cards',
      'squad_webhooks',
      'transfer_queue'
    ]);

    // Add provider column to squad_webhooks
    await query(`ALTER TABLE squad_webhooks ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'squad'`);

    // Add transaction_type to transactions table
    await query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transaction_type VARCHAR(50) DEFAULT 'subscription'`); // subscription, card_validation

    // Add role_id to platform_admins
    await query(`ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES admin_roles(id) ON DELETE SET NULL`);

    // Add currency to businesses
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'NGN'`);

    // Add currency to tasks
    await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'NGN'`);

    // Create payroll_adjustments table
    await query(`
      CREATE TABLE IF NOT EXISTS payroll_adjustments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL, -- bonus, deduction
        amount DECIMAL(12, 2) NOT NULL,
        currency VARCHAR(3) DEFAULT 'NGN',
        reason TEXT,
        status VARCHAR(50) DEFAULT 'pending', -- pending, processed, cancelled
        transfer_id UUID REFERENCES transfer_queue(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP
      )
    `);

    await fixUuidIdDefaults(['payroll_adjustments']);

    // Ensure currency column exists in payroll_adjustments (for migration if table existed)
    await query(`ALTER TABLE payroll_adjustments ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'NGN'`);

    // Add wallet_id to transfer_queue
    await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS wallet_id UUID REFERENCES wallets(id)`);

    // Add provider columns to support multiple payment providers
    await query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50) DEFAULT 'squad'`);
    await query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS provider_metadata JSONB`);
    await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50) DEFAULT 'squad'`);
    await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS provider_metadata JSONB`);
    await query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50) DEFAULT 'squad'`);
    await query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider_metadata JSONB`);
    await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS otp_preference VARCHAR(20) DEFAULT 'email'`);

    // Create fee configuration and revenue wallet tables used by admin finance endpoints.
    await query(`
      CREATE TABLE IF NOT EXISTS fee_configurations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        fee_type VARCHAR(50) NOT NULL,
        config_type VARCHAR(50) NOT NULL,
        config JSONB NOT NULL,
        currency VARCHAR(3) DEFAULT 'NGN',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS platform_wallet (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        balance NUMERIC(20, 2) DEFAULT 0,
        currency VARCHAR(3) DEFAULT 'NGN',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_fee_configurations_fee_type ON fee_configurations(fee_type)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_platform_wallet_currency ON platform_wallet(currency)`);

    const platformWalletCheck = await query(`SELECT id FROM platform_wallet WHERE currency = 'NGN' LIMIT 1`);
    if (platformWalletCheck.rows.length === 0) {
      await query(`INSERT INTO platform_wallet (balance, currency) VALUES (0, 'NGN')`);
    }

    const defaultFees = [
      {
        name: 'Standard Transfer Fee',
        fee_type: 'transfer',
        config_type: 'range',
        config: {
          ranges: [
            { min: 0, max: 5000, fee: 10 },
            { min: 5001, max: 50000, fee: 25 },
            { min: 50001, max: 999999999, fee: 50 }
          ]
        }
      },
      {
        name: 'Card Funding Fee',
        fee_type: 'funding_card',
        config_type: 'percentage_cap',
        config: { percentage: 1.5, cap: 2000 }
      },
      {
        name: 'Account Funding Fee',
        fee_type: 'funding_account',
        config_type: 'flat',
        config: { amount: 50 }
      },
      {
        name: 'OTP SMS Fee',
        fee_type: 'otp_sms',
        config_type: 'flat',
        config: { amount: 4 }
      },
      {
        name: 'Stamp Duty',
        fee_type: 'stamp_duty',
        config_type: 'flat_conditional',
        config: {
          conditions: [
            { operator: '>=', threshold: 10000, fee: 50 }
          ]
        }
      }
    ];

    for (const fee of defaultFees) {
      const feeCheck = await query(`SELECT id FROM fee_configurations WHERE fee_type = $1 LIMIT 1`, [fee.fee_type]);
      if (feeCheck.rows.length === 0) {
        await query(
          `INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
           VALUES ($1, $2, $3, $4, 'NGN')`,
          [fee.name, fee.fee_type, fee.config_type, fee.config]
        );
      }
    }

    await fixUuidIdDefaults(['fee_configurations', 'platform_wallet']);

    // Seed Admin Permissions
    const permissions = [
      { slug: 'view_dashboard', name: 'View Dashboard', description: 'Access to view dashboard stats and charts' },
      { slug: 'manage_businesses', name: 'Manage Businesses', description: 'Access to view and manage businesses' },
      { slug: 'manage_users', name: 'Manage Users', description: 'Access to view and manage platform users' },
      { slug: 'manage_admins', name: 'Manage Admins', description: 'Access to create, invite and manage other admins' },
      { slug: 'manage_roles', name: 'Manage Roles', description: 'Access to create and manage admin roles' },
      { slug: 'manage_plans', name: 'Manage Plans', description: 'Access to manage pricing plans' },
      { slug: 'manage_finance', name: 'Manage Finance', description: 'Access to manage platform fees and finance settings' },
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
      await query(
        `UPDATE admin_roles 
         SET is_super_admin = TRUE, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND is_super_admin = FALSE`,
        [superAdminRoleId]
      );
    }

    // Keep the Super Admin role fully hydrated when new permissions are added later.
    const allPermissions = await query(`SELECT id FROM admin_permissions`);
    for (const perm of allPermissions.rows) {
      await query(
        `INSERT INTO admin_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [superAdminRoleId, perm.id]
      );
    }

    // Assign Super Admin Role to default/root admin users created before roles existed.
    await query(
      `UPDATE platform_admins 
       SET role_id = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE role_id IS NULL 
         AND LOWER(email) = ANY($2::text[])`,
      [superAdminRoleId, ['sunday@metricorex.com', 'admin@quantigrate.com']]
    );

    // Create system_settings table
    await query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT,
        description TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create user_sessions table for token idle timeout
    await query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        token VARCHAR(255) NOT NULL UNIQUE,
        last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await fixUuidIdDefaults(['user_sessions']);
    
    // Fix existing user_sessions rows with null last_activity_at
    await query(`
      UPDATE user_sessions 
      SET last_activity_at = CURRENT_TIMESTAMP 
      WHERE last_activity_at IS NULL
    `);
    console.log("Fixed user_sessions rows with null last_activity_at");

    // Insert default card verification amount if not exists
    await query(`
      INSERT INTO system_settings (key, value, description)
      VALUES ('card_verification_amount', '100', 'Amount charged for card verification in Naira')
      ON CONFLICT (key) DO NOTHING
    `);

    // Add missing columns to transactions table
    await query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type VARCHAR(50)`);
    await query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description TEXT`);

    // Create task_statuses table to store custom task statuses per business
    await query(`
      CREATE TABLE IF NOT EXISTS task_statuses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        color VARCHAR(50),
        is_default BOOLEAN DEFAULT FALSE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(business_id, name)
      )
    `);

    await fixUuidIdDefaults(['task_statuses']);

    // Create communication tables used by meetings, chat, and calls routes.
    await query(`
      CREATE TABLE IF NOT EXISTS meetings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        timezone VARCHAR(100) NOT NULL,
        created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        host_id UUID REFERENCES users(id) ON DELETE SET NULL,
        co_host_id UUID REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(50) DEFAULT 'scheduled',
        meeting_code VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        is_instant BOOLEAN DEFAULT FALSE,
        max_participants INTEGER,
        waiting_room_enabled BOOLEAN DEFAULT FALSE,
        recording_enabled BOOLEAN DEFAULT FALSE,
        screen_sharing_enabled BOOLEAN DEFAULT TRUE,
        meeting_url TEXT,
        google_event_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add missing columns to meetings table if it already existed
    await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS host_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS co_host_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_code VARCHAR(255) UNIQUE`);
    await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS password VARCHAR(255)`);
    await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS is_instant BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS max_participants INTEGER`);
    await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS waiting_room_enabled BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_enabled BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS screen_sharing_enabled BOOLEAN DEFAULT TRUE`);

    await query(`
      CREATE TABLE IF NOT EXISTS meeting_attendees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(50) DEFAULT 'invited',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(meeting_id, user_id)
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS meeting_reminders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        minutes INTEGER NOT NULL,
        sent BOOLEAN DEFAULT FALSE,
        sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name VARCHAR(255),
        type VARCHAR(50) DEFAULT 'direct',
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS chat_participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(conversation_id, user_id)
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT,
        attachment_url TEXT,
        attachment_type VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS calls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL,
        started_at TIMESTAMP,
        ended_at TIMESTAMP,
        created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        host_id UUID REFERENCES users(id) ON DELETE SET NULL,
        co_host_id UUID REFERENCES users(id) ON DELETE SET NULL,
        call_code VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        is_group_call BOOLEAN DEFAULT FALSE,
        max_participants INTEGER,
        waiting_room_enabled BOOLEAN DEFAULT FALSE,
        recording_enabled BOOLEAN DEFAULT FALSE,
        jitsi_room_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add missing columns to calls table if it already existed
    await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS host_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS co_host_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_code VARCHAR(255) UNIQUE`);
    await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS password VARCHAR(255)`);
    await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS is_group_call BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS max_participants INTEGER`);
    await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS waiting_room_enabled BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_enabled BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS jitsi_room_id VARCHAR(255)`);
    // Make jitsi_room_id nullable (in case it was originally NOT NULL)
    await query(`ALTER TABLE calls ALTER COLUMN jitsi_room_id DROP NOT NULL`);

    await query(`
      CREATE TABLE IF NOT EXISTS call_participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMP,
        left_at TIMESTAMP,
        status VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(call_id, user_id)
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS recordings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE,
        call_id UUID REFERENCES calls(id) ON DELETE CASCADE,
        recorded_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        storage_url TEXT,
        duration INTEGER,
        status VARCHAR(50),
        size INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        action_url TEXT,
        action_type VARCHAR(50),
        metadata JSONB,
        is_read BOOLEAN DEFAULT FALSE,
        is_actionable BOOLEAN DEFAULT FALSE,
        action_taken VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
        token VARCHAR(255) NOT NULL UNIQUE,
        last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await fixUuidIdDefaults(['recordings', 'notifications', 'admin_sessions']);

    await query(`CREATE INDEX IF NOT EXISTS idx_meetings_business_id ON meetings(business_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_chat_conversations_business_id ON chat_conversations(business_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_calls_business_id ON calls(business_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_recordings_business_id ON recordings(business_id)`);

    await fixUuidIdDefaults([
      'meetings',
      'meeting_attendees',
      'meeting_reminders',
      'chat_conversations',
      'chat_participants',
      'chat_messages',
      'calls',
      'call_participants',
      'recordings'
    ]);

    // Seed default statuses for existing businesses
    const defaultStatuses = [
      { name: 'pending', color: '#6b7280', is_default: true },
      { name: 'in_progress', color: '#3b82f6', is_default: true },
      { name: 'completed', color: '#10b981', is_default: true }
    ];

    // Get all businesses
    const businessesResult = await query(`SELECT id FROM businesses`);
    for (const business of businessesResult.rows) {
      for (const status of defaultStatuses) {
        await query(
          `INSERT INTO task_statuses (business_id, name, color, is_default, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (business_id, name) DO NOTHING`,
          [business.id, status.name, status.color, status.is_default, defaultStatuses.indexOf(status)]
        );
      }
    }

    await fixExistingUuidIdDefaults();

    console.log("Database tables initialized successfully");
  } catch (error) {
    console.error("Failed to initialize database:", error);
    throw error;
  }
}

export default pool;
