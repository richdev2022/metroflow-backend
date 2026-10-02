import { query } from "./db";

/**
 * Post-initialize migrations + one-off data repairs.
 * Called from initializeDatabase() after the base schema exists.
 * Everything here is idempotent - safe to run on every boot.
 */
export async function runPostInitializeMigrations(): Promise<void> {
  await ensureAppTables();
  await ensurePayrollVerificationColumns();
  await ensureSystemSettingsDefaults();
  await ensureChatAndAiSchema();
  await ensureChatCallUxSchema();
  await ensureAiLimitsSchema();
  await ensureSupportSchema();
  await ensureLedgerAndVirtualAccountFixes();
  await backfillLedgerHistory();
  await ensureCallingSchema();
  await ensureMeetingSchedulingSchema();
  await ensureVapidKeys();
  await ensureSiteGrowthSchema();
  await ensureRevenueFeaturesSchema();
}

/**
 * Revenue features:
 *  1. Payment Links ("Get Paid") — shareable checkout links for businesses;
 *     every successful customer payment credits the business wallet minus a
 *     configurable collection fee that lands in the platform revenue wallet.
 *  2. MetricAi Credit Packs — one-time credit top-ups for MetricAi usage,
 *     purchasable from the wallet when a plan's AI allowance runs out.
 * Both are plan-configurable (pricing_plans columns below, admin-editable).
 */
async function ensureRevenueFeaturesSchema(): Promise<void> {
  // ---------- Payment Links ----------
  await query(`
    CREATE TABLE IF NOT EXISTS payment_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL,
      created_by UUID,
      slug VARCHAR(80) UNIQUE NOT NULL,
      title VARCHAR(140) NOT NULL,
      description TEXT,
      amount DECIMAL(12,2),
      currency VARCHAR(3) DEFAULT 'NGN',
      allow_custom_amount BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      views INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_payment_links_business ON payment_links(business_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS payment_link_payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      link_id UUID NOT NULL REFERENCES payment_links(id) ON DELETE CASCADE,
      business_id VARCHAR(255) NOT NULL,
      transaction_reference VARCHAR(255) UNIQUE NOT NULL,
      payer_name VARCHAR(255),
      payer_email VARCHAR(255),
      amount DECIMAL(12,2) NOT NULL,
      fee DECIMAL(12,2) DEFAULT 0,
      net_amount DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      status VARCHAR(20) DEFAULT 'pending',
      payment_provider VARCHAR(30),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_plp_link ON payment_link_payments(link_id)`);

  // Plan configuration knobs for Payment Links
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS payment_links_enabled BOOLEAN DEFAULT TRUE`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_payment_links INTEGER DEFAULT 3`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS payment_link_fee_discount_percent DECIMAL(5,2) DEFAULT 0`);

  // Collection fee config (percentage with cap), mirroring funding_card.
  // Idempotent: only inserted when the fee type does not exist yet.
  await query(`
    INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
    SELECT 'Payment Link Collection Fee', 'payment_link', 'percentage_cap',
           '{"percentage": 1.5, "cap": 2000}'::jsonb, 'NGN'
    WHERE NOT EXISTS (SELECT 1 FROM fee_configurations WHERE fee_type = 'payment_link')
  `);

  // ---------- MetricAi Credit Packs ----------
  await query(`
    CREATE TABLE IF NOT EXISTS ai_credit_packs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      credits INTEGER NOT NULL,
      price DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      is_active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ai_credit_balances (
      user_id UUID PRIMARY KEY,
      business_id VARCHAR(255),
      balance INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ai_credit_purchases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      business_id VARCHAR(255),
      pack_id UUID,
      pack_name VARCHAR(100),
      credits INTEGER NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      status VARCHAR(20) DEFAULT 'success',
      reference VARCHAR(255) UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ai_credit_purchases_user ON ai_credit_purchases(user_id, created_at)`);

  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS ai_credit_discount_percent DECIMAL(5,2) DEFAULT 0`);

  // Starter credit packs (skipped when the table already has rows)
  await query(`
    INSERT INTO ai_credit_packs (name, credits, price, currency, sort_order)
    SELECT * FROM (VALUES
      ('Starter Pack', 100, 2000, 'NGN', 1),
      ('Business Pack', 500, 8000, 'NGN', 2),
      ('Scale Pack', 1500, 20000, 'NGN', 3)
    ) AS v(name, credits, price, currency, sort_order)
    WHERE NOT EXISTS (SELECT 1 FROM ai_credit_packs)
  `);

  console.log("[migrations] Revenue features (payment links + AI credit packs) schema applied");
}

/**
 * Site growth tables: marketing-site wishlist entries, email subscribers
 * (per-category, e.g. monthly product updates) and the campaign send history.
 * Backs the public /public/wishlist + /public/subscribe endpoints and the
 * admin "Growth" pages (wishlist list, subscriber manager, campaign sender).
 */
async function ensureSiteGrowthSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS site_wishlist_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255),
      email VARCHAR(320) NOT NULL,
      features JSONB DEFAULT '[]'::jsonb,
      note TEXT,
      source VARCHAR(60) DEFAULT 'website',
      welcome_email_sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_site_wishlist_email ON site_wishlist_entries (LOWER(email))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_site_wishlist_created ON site_wishlist_entries (created_at DESC)`);

  await query(`
    CREATE TABLE IF NOT EXISTS site_subscribers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255),
      email VARCHAR(320) NOT NULL,
      categories TEXT[] DEFAULT '{}',
      source VARCHAR(60) DEFAULT 'website',
      is_active BOOLEAN DEFAULT TRUE,
      welcome_email_sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_site_subscribers_email ON site_subscribers (LOWER(email))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_site_subscribers_active ON site_subscribers (is_active, created_at DESC)`);

  await query(`
    CREATE TABLE IF NOT EXISTS site_email_campaigns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category VARCHAR(60) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body_html TEXT NOT NULL,
      recipients_count INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      created_by UUID,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_site_campaigns_created ON site_email_campaigns (created_at DESC)`);

  // Permission gating the admin Growth pages (wishlist + subscribers + campaigns)
  await query(`
    INSERT INTO admin_permissions (slug, name, description)
    VALUES ('manage_growth', 'Wishlist & Email Notifications', 'View wishlist entries, manage email subscribers and send email notifications per category')
    ON CONFLICT (slug) DO NOTHING
  `);
}

/**
 * Ledger + virtual account repairs:
 *  1. virtual_accounts.is_active — selected by the admin VA list endpoint but
 *     never added to pre-existing tables (admin list returned 500).
 *  2. transactions.payment_provider DEFAULT 'squad' — every platform ledger
 *     row inserted without an explicit provider silently became 'squad',
 *     mislabelling Flutterwave/Monnify movements. Drop the default and
 *     backfill the true provider from the reference prefix.
 */
async function ensureLedgerAndVirtualAccountFixes(): Promise<void> {
  // 1. Admin VA list requires va.is_active
  await query(`ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);
  await query(`UPDATE virtual_accounts SET is_active = TRUE WHERE is_active IS NULL`);

  // 2. No silent provider default: rows without an explicit provider must be
  //    NULL, never 'squad'.
  await query(`ALTER TABLE transactions ALTER COLUMN payment_provider DROP DEFAULT`);

  // 3. Backfill the real provider from the reference prefix on rows that were
  //    mislabelled by the old default (or never tagged).
  await query(
    `UPDATE transactions SET payment_provider = 'flutterwave'
     WHERE reference LIKE 'FLW-%' AND (payment_provider IS NULL OR payment_provider NOT IN ('flutterwave'))`,
  );
  await query(
    `UPDATE transactions SET payment_provider = 'monnify'
     WHERE (reference LIKE 'MNFY%' OR reference LIKE 'monnify-%')
       AND (payment_provider IS NULL OR payment_provider NOT IN ('monnify'))`,
  );
  await query(
    `UPDATE transactions SET payment_provider = 'squad'
     WHERE (reference LIKE 'SB-%' OR reference LIKE 'squad-%' OR reference LIKE 'SQUAD%')
       AND payment_provider IS NULL`,
  );
  console.log("[migrations] ledger + virtual account fixes applied");
}

/**
 * Chat attachments (WhatsApp-style), call logs in chat and MetricAi history.
 */
async function ensureChatAndAiSchema(): Promise<void> {
  // Rich attachments: original filename + size + explicit message kind
  await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255)`);
  await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_size INTEGER`);
  await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'text'`);
  await query(`UPDATE chat_messages SET message_type = 'text' WHERE message_type IS NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created ON chat_messages(conversation_id, created_at DESC)`);

  // Calls created from a chat conversation link back to it so the ended/missed
  // call appears in that conversation's transcript.
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS conversation_id UUID`);

  // MetricAi (GLM-powered assistant) per-user chat history
  await query(`
    CREATE TABLE IF NOT EXISTS ai_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      business_id VARCHAR(255),
      role VARCHAR(12) NOT NULL,             -- 'user' | 'assistant'
      content TEXT,                          -- text content (NULL for image-only replies)
      image_url TEXT,                        -- generated image (assistant)
      model VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ai_messages_user_created ON ai_messages(user_id, created_at)`);
  // MetricAi generated videos land in the same history stream
  await query(`ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS video_url TEXT`);
  await query(`ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS video_cover_url TEXT`);

  // MetricAi text-to-video async jobs (CogVideoX is an upstream async API:
  // create -> poll minutes later). Jobs persist so a restart never orphans one.
  await query(`
    CREATE TABLE IF NOT EXISTS metric_ai_video_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      business_id VARCHAR(255),
      prompt TEXT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'processing',  -- processing|success|failed
      video_url TEXT,
      cover_url TEXT,
      model VARCHAR(64),
      upstream_base TEXT,
      upstream_job_id TEXT,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_video_jobs_user_created ON metric_ai_video_jobs(user_id, created_at)`);

  // Plan-gated access: admin enables MetricAi per pricing plan
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS metric_ai_enabled BOOLEAN DEFAULT FALSE`);
  // MetricAi ships with every plan: it runs on a free GLM tier and is a core
  // product surface (site widget, webapp, unauthenticated pages). The gate
  // stays in the schema so paid-only AI features can be toggled later.
  await query(`UPDATE pricing_plans SET metric_ai_enabled = TRUE WHERE metric_ai_enabled IS DISTINCT FROM TRUE`);

  // task_statuses UNIQUE(business_id, name) is required by the board's
  // `INSERT ... ON CONFLICT (business_id, name)` — but tables created before
  // that constraint was added to the CREATE never gained it (CREATE TABLE IF
  // NOT EXISTS is a no-op on existing tables). Force it via a unique index.
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS task_statuses_business_name_uq ON task_statuses (business_id, name)`,
  );

  // International payout beneficiary details (Flutterwave beneficiary_* params
  // are mandatory on USD/GBP/EUR rails: address, city, postal code, country).
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS recipient_address TEXT`);
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS recipient_city TEXT`);
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS recipient_state TEXT`);
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS recipient_postal_code TEXT`);
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS recipient_country VARCHAR(2)`);
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS recipient_bank_name TEXT`);
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS recipient_swift_code TEXT`);
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS recipient_routing_number TEXT`);
  // Ledger backfill reads transfer_queue.description (see backfillLedgerHistory)
  // but the column was never part of the CREATE — boot-time backfill errored.
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS description TEXT`);
}

/**
 * MetricAi per-plan usage limits (admin-configurable) + per-user counters +
 * user attachment columns (pasted/attached images & videos in MetricAi chat).
 */
async function ensureAiLimitsSchema(): Promise<void> {
  // Six limit columns on pricing_plans (NULL = unlimited). Admin edits them via
  // /admin/ai/limits; each plan row carries its own values.
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS metric_ai_chat_daily INTEGER`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS metric_ai_chat_monthly INTEGER`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS metric_ai_image_daily INTEGER`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS metric_ai_image_monthly INTEGER`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS metric_ai_video_daily INTEGER`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS metric_ai_video_monthly INTEGER`);

  // Sensible starter limits for every plan that has none yet (protects the free
  // GLM quota from runaway usage; admins tune per plan afterwards).
  await query(`UPDATE pricing_plans SET metric_ai_chat_daily = 200 WHERE metric_ai_chat_daily IS NULL`);
  await query(`UPDATE pricing_plans SET metric_ai_chat_monthly = 3000 WHERE metric_ai_chat_monthly IS NULL`);
  await query(`UPDATE pricing_plans SET metric_ai_image_daily = 15 WHERE metric_ai_image_daily IS NULL`);
  await query(`UPDATE pricing_plans SET metric_ai_image_monthly = 150 WHERE metric_ai_image_monthly IS NULL`);
  await query(`UPDATE pricing_plans SET metric_ai_video_daily = 5 WHERE metric_ai_video_daily IS NULL`);
  await query(`UPDATE pricing_plans SET metric_ai_video_monthly = 30 WHERE metric_ai_video_monthly IS NULL`);

  // Per-user per-feature daily counters (monthly usage = SUM over the month).
  await query(`
    CREATE TABLE IF NOT EXISTS metric_ai_usage (
      user_id UUID NOT NULL,
      business_id VARCHAR(255),
      feature VARCHAR(10) NOT NULL,          -- chat | image | video
      day DATE NOT NULL,                     -- UTC day bucket
      month CHAR(7) NOT NULL,                -- UTC month bucket (YYYY-MM)
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, feature, day)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_metric_ai_usage_month ON metric_ai_usage(user_id, feature, month)`);

  // MetricAi chat: user attachments (image paste / attach, video attach).
  // image_url stays reserved for GENERATED images (assistant messages).
  await query(`ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS attachment_url TEXT`);
  await query(`ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(20)`);

  console.log("[migrations] MetricAi limits + attachments schema applied");
}

/**
 * Customer Support desk: MetricAi -> human handoff conversations, agent chat
 * and admin in-app notifications (support alerts + MetricAi activity).
 */
async function ensureSupportSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS support_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID,
      guest_name VARCHAR(255),
      guest_email VARCHAR(255),
      channel VARCHAR(30) DEFAULT 'metric_ai',   -- metric_ai | webapp_widget | website_widget | mobile
      subject VARCHAR(255),
      status VARCHAR(20) DEFAULT 'open',         -- open | pending | resolved | closed
      access_key VARCHAR(80),                    -- lets guests (website visitors) poll/reply safely
      assigned_agent_id UUID,
      last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_message_preview TEXT,
      unread_for_agent INTEGER DEFAULT 0,
      unread_for_customer INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_support_conv_status ON support_conversations(status, last_message_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_support_conv_user ON support_conversations(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_support_conv_agent ON support_conversations(assigned_agent_id)`);
  await query(`ALTER TABLE support_conversations ADD COLUMN IF NOT EXISTS access_key VARCHAR(80)`);
  await query(`ALTER TABLE support_conversations ADD COLUMN IF NOT EXISTS assigned_agent_id UUID`);
  await query(`ALTER TABLE support_conversations ADD COLUMN IF NOT EXISTS unread_for_agent INTEGER DEFAULT 0`);
  await query(`ALTER TABLE support_conversations ADD COLUMN IF NOT EXISTS unread_for_customer INTEGER DEFAULT 0`);

  await query(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
      sender_type VARCHAR(12) NOT NULL,          -- customer | agent | system | ai
      sender_id VARCHAR(255),
      sender_name VARCHAR(255),
      body TEXT NOT NULL,
      meta JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_support_msg_conv ON support_messages(conversation_id, created_at)`);

  // In-app notifications for the admin console (support inbox + MetricAi activity)
  await query(`
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id UUID,                             -- NULL = visible to every support agent / super admin
      type VARCHAR(40) NOT NULL,                 -- support_new_conversation | support_new_message | metric_ai_activity
      title VARCHAR(255) NOT NULL,
      body TEXT,
      conversation_id UUID,
      dedupe_key VARCHAR(120),
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_admin_notifications_unread ON admin_notifications(is_read, created_at DESC)`);
  await query(`ALTER TABLE admin_notifications ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(120)`);
  await query(`ALTER TABLE admin_notifications ADD COLUMN IF NOT EXISTS conversation_id UUID`);

  // Permission that gates the Support dashboard (assignable to any admin role)
  await query(`
    INSERT INTO admin_permissions (slug, name, description)
    VALUES ('support', 'Customer Support', 'Access the support inbox and chat with customers')
    ON CONFLICT (slug) DO NOTHING
  `);
}

/**
 * Announcements (admin broadcast ticker) + indexes.
 */
async function ensureAppTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) REFERENCES businesses(id) ON DELETE CASCADE,
      title VARCHAR(255),
      message TEXT NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_by UUID,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS business_id VARCHAR(255) REFERENCES businesses(id) ON DELETE CASCADE`);
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS title VARCHAR(255)`);
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_by UUID`);
  await query(`CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, created_at DESC)`);

  // Device registry for push notifications (FCM tokens) + login-attempt emails
  await query(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      business_id VARCHAR(255),
      fcm_token TEXT UNIQUE,
      platform VARCHAR(20),
      device_name VARCHAR(255),
      app_version VARCHAR(50),
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id)`);

  // Login attempt audit (feeds the always-on login attempt emails)
  await query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255),
      user_id UUID,
      business_id VARCHAR(255),
      status VARCHAR(20) NOT NULL, -- success | failed
      ip_address VARCHAR(64),
      user_agent TEXT,
      device_info JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, created_at DESC)`);
}

/**
 * Employee (user) recipient verification + international payout details.
 * NGN recipients: bank_code + account_number + account_name (existing columns).
 * USD recipients: bank_name + swift/routing + account_number + beneficiary address fields.
 */
async function ensurePayrollVerificationColumns(): Promise<void> {
  const cols: string[] = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'unverified'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_account_name VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_error TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_country VARCHAR(5) DEFAULT 'NG'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS swift_code VARCHAR(50)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS routing_number VARCHAR(50)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS beneficiary_address TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS beneficiary_city VARCHAR(120)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS beneficiary_country VARCHAR(5)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS payroll_currency VARCHAR(3)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(120)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(120)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30)`,
  ];
  for (const c of cols) {
    await query(c);
  }
  await query(`CREATE INDEX IF NOT EXISTS idx_users_verification_status ON users(verification_status)`);
  await query(`UPDATE users SET verification_status = 'unverified' WHERE verification_status IS NULL`);

  // International payouts: transfer_queue.amount holds the DESTINATION-currency
  // amount sent to the provider; debit_amount/debit_currency hold the
  // source-currency amount actually debited from the user's wallet.
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS debit_amount DECIMAL(20, 2)`);
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS debit_currency VARCHAR(3)`);

  // Per-business time format preference (12h / 24h) alongside timezone
  await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS time_format VARCHAR(5) DEFAULT '24h'`);

  // Biometric unlock credentials. The client unlocks the stored token with the
  // platform biometric API (fingerprint / Face ID); the server only ever sees
  // the long-lived biometric token (hashed at rest).
  await query(`
    CREATE TABLE IF NOT EXISTS biometric_credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      token_hash VARCHAR(255) NOT NULL,
      platform VARCHAR(20),
      device_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP,
      revoked_at TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_biometric_user ON biometric_credentials(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_biometric_token ON biometric_credentials(token_hash)`);
}

async function ensureSystemSettingsDefaults(): Promise<void> {
  const defaults: Array<[string, string, string]> = [
    ["maintenance_mode", "off", "When 'on', user apps show a maintenance screen"],
    ["intl_transfer_markup_percent", "0", "Markup % added on top of the live FX rate for international payouts"],
    ["intl_transfer_fee_percent", "0", "Fee % charged on international payouts (goes to revenue ledger)"],
    ["intl_transfer_fee_flat", "0", "Flat fee charged on international payouts (source currency)"],
    ["active_transfer_provider", "", "Active payout provider override (empty = global payment provider)"],
  ];
  for (const [key, value, description] of defaults) {
    await query(
      `INSERT INTO system_settings (key, value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, value, description],
    );
  }
}

const PLATFORM_SUCCESS_STATES = ["successful", "success", "completed", "paid"];

/**
 * Backfill ledger history so the admin Platform Wallet / Revenue Wallet show
 * EVERY historical movement (previously balances moved silently):
 *  1. For every final-successful transfer: ensure a platform debit row
 *     (main amount) + a revenue credit row (fee) exist.
 *  2. For every subscription/fee transaction missing a revenue-side mirror
 *     row, create one.
 *  3. Reconcile: compare each internal platform wallet balance against the
 *     sum of its recorded rows and insert a balancing adjustment row.
 */
async function backfillLedgerHistory(): Promise<void> {
  try {
    // ---- 1. Platform debits + revenue credits from successful transfers ----
    const transfersRes = await query(
      `SELECT id, reference, amount, fee, currency, status, description, created_at
       FROM transfer_queue
       WHERE status = ANY($1)
         AND reference NOT LIKE 'BULK-%'
       ORDER BY created_at ASC`,
      [PLATFORM_SUCCESS_STATES],
    );

    // Resolve the platform (operational) wallet per currency lazily
    const platformWalletCache = new Map<string, string>();
    const getPlatformWallet = async (currency: string): Promise<string | null> => {
      const cur = currency || "NGN";
      if (platformWalletCache.has(cur)) return platformWalletCache.get(cur)!;
      const res = await query(
        `SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL AND currency = $1 LIMIT 1`,
        [cur],
      );
      if (res.rows.length === 0) return null;
      platformWalletCache.set(cur, res.rows[0].id);
      return res.rows[0].id;
    };

    for (const t of transfersRes.rows) {
      const walletId = await getPlatformWallet(t.currency || "NGN");
      const amount = Number(t.amount) || 0;
      const fee = Number(t.fee) || 0;
      const cur = t.currency || "NGN";

      if (walletId && amount > 0) {
        const exists = await query(
          `SELECT 1 FROM transactions WHERE reference = $1 AND transaction_type = 'platform' AND type = 'debit' LIMIT 1`,
          [t.reference],
        );
        if (exists.rows.length === 0) {
          await query(
            `INSERT INTO transactions
             (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, created_at)
             VALUES ($1, $2, 'success', $3, 'debit', $4, 'platform', $5, 'debit', $6)`,
            [amount, cur, t.reference, t.description || "Transfer platform debit (backfill)", walletId, t.created_at],
          );
        }
      }

      if (fee > 0) {
        const revRef = `${t.reference}-FEE`;
        const revExists = await query(
          `SELECT 1 FROM transactions WHERE reference = $1 AND transaction_type = 'fee' AND type = 'credit' AND wallet_id IS NULL LIMIT 1`,
          [revRef],
        );
        if (revExists.rows.length === 0) {
          await query(
            `INSERT INTO transactions
             (amount, currency, status, reference, type, description, transaction_type, direction, created_at)
             VALUES ($1, $2, 'success', $3, 'credit', $4, 'fee', 'credit', $5)`,
            [fee, cur, revRef, "Transfer fee revenue (backfill)", t.created_at],
          );
        }
      }
    }

    // ---- 2. Subscription payments mirrored into revenue ledger ----
    // Subscription payments are platform revenue even if historical rows
    // carried a wallet_id. Mirror any that lack a wallet_id-NULL revenue row.
    const subRes = await query(
      `SELECT id, reference, amount, currency, description, created_at
       FROM transactions
       WHERE transaction_type = 'subscription' AND status = 'success'
         AND (wallet_id IS NULL OR wallet_id IN (SELECT id FROM wallets WHERE business_id IS NOT NULL OR user_id IS NOT NULL))
       ORDER BY created_at ASC`,
    );
    for (const s of subRes.rows) {
      const revRef = s.reference ? `${s.reference}-REVENUE-BACKFILL` : `revenue-backfill-${s.id}`;
      const revExists = await query(
        `SELECT 1 FROM transactions WHERE reference = $1 AND transaction_type = 'subscription' AND wallet_id IS NULL LIMIT 1`,
        [revRef],
      );
      if (revExists.rows.length === 0) {
        await query(
          `INSERT INTO transactions
           (amount, currency, status, reference, type, description, transaction_type, direction, created_at)
           VALUES ($1, $2, 'success', $3, 'credit', $4, 'subscription', 'credit', $5)`,
          [Number(s.amount) || 0, s.currency || "NGN", revRef, s.description || "Subscription revenue (backfill)", s.created_at],
        );
      }
    }

    // ---- 3. Successful wallet fundings missing their platform-side rows ----
    // The card-funding settlement historically wrote ONLY a wallet_id-attached
    // fee row: the admin Platform Ledger showed no gross inflow / user payout,
    // and the fee was invisible to the Revenue Ledger (wallet_id NOT NULL).
    // Reconstruct the full double-entry for every successful funding that has
    // no platform credit row yet (the VA webhook flow already writes them).
    const fundingsRes = await query(
      `SELECT id, reference, amount, fee, currency, description, created_at, payment_provider
       FROM transactions
       WHERE transaction_type = 'wallet_funding' AND status = 'success'
       ORDER BY created_at ASC`,
    );
    for (const f of fundingsRes.rows) {
      const ref = f.reference;
      if (!ref) continue;
      const cur = f.currency || "NGN";
      const walletId = await getPlatformWallet(cur);
      const net = Number(f.amount) || 0;
      const fee = Number(f.fee) || 0;
      const gross = Math.round((net + fee) * 100) / 100;

      const grossExists = await query(
        `SELECT 1 FROM transactions WHERE reference = $1 AND transaction_type = 'platform' AND type = 'credit' LIMIT 1`,
        [ref],
      );
      if (grossExists.rows.length > 0) continue; // webhook path already recorded the full flow

      if (walletId && gross > 0) {
        await query(
          `INSERT INTO transactions
           (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, payment_provider, created_at)
           VALUES ($1, $2, 'success', $3, 'credit', $4, 'platform', $5, 'credit', $6, $7)`,
          [gross, cur, ref, f.description || "Customer Wallet Funding Received (backfill)", walletId, f.payment_provider || null, f.created_at],
        );
      }
      if (walletId && net > 0) {
        await query(
          `INSERT INTO transactions
           (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, payment_provider, created_at)
           VALUES ($1, $2, 'success', $3, 'debit', $4, 'platform', $5, 'debit', $6, $7)`,
          [net, cur, `${ref}-USER-BACKFILL`, "Platform Wallet Debit for User Funding (backfill)", walletId, f.payment_provider || null, f.created_at],
        );
      }
      if (fee > 0) {
        await query(
          `INSERT INTO transactions
           (amount, currency, status, reference, type, description, transaction_type, direction, payment_provider, created_at)
           VALUES ($1, $2, 'success', $3, 'credit', $4, 'fee', 'credit', $5, $6)`,
          [fee, cur, `${ref}-FEE-BACKFILL`, "Wallet funding fee revenue (backfill)", f.payment_provider || null, f.created_at],
        );
      }
    }

    // ---- 4. Reconcile internal platform wallet balances ----
    const internalWallets = await query(
      `SELECT id, currency, balance FROM wallets WHERE business_id IS NULL AND user_id IS NULL`,
    );
    for (const w of internalWallets.rows) {
      const sumRes = await query(
        `SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS recorded
         FROM transactions
         WHERE wallet_id = $1 AND transaction_type = 'platform' AND status = 'success'`,
        [w.id],
      );
      const recorded = Number(sumRes.rows[0]?.recorded) || 0;
      const balance = Number(w.balance) || 0;
      const diff = Math.round((balance - recorded) * 100) / 100;
      if (Math.abs(diff) >= 0.01) {
        const direction = diff > 0 ? "credit" : "debit";
        await query(
          `INSERT INTO transactions
           (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
           VALUES ($1, $2, 'success', $3, $4, 'Historical balance reconciliation', 'platform', $5, $6)`,
          [Math.abs(diff), w.currency || "NGN", `platform-reconcile-${w.id}-${Date.now()}`, direction, w.id, direction],
        );
      }
    }

    console.log("[migrations] ledger backfill complete");
  } catch (err: any) {
    console.error(`[migrations] ledger backfill failed [${err?.code || "UNKNOWN"}]: ${err?.message}`);
  }
}

/**
 * Calling provider architecture (LiveKit + MediaSoup):
 *  1. `provider` column on calls/meetings — the media provider a room was
 *     created with (a session never migrates providers mid-flight).
 *  2. `meeting_transcripts` — persisted caption segments (provider-agnostic;
 *     the backend relays captions over Socket.IO no matter which provider
 *     carries the audio).
 *  3. `meeting_notes` — AI summary / key points / decisions / action items.
 * Everything idempotent, safe on every boot.
 */
async function ensureCallingSchema(): Promise<void> {
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider VARCHAR(20)`);
  await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS provider VARCHAR(20)`);

  await query(`
    CREATE TABLE IF NOT EXISTS meeting_transcripts (
      id UUID PRIMARY KEY,
      meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      speaker_id VARCHAR(200),
      speaker_name VARCHAR(120),
      text TEXT NOT NULL,
      language VARCHAR(20),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_meeting ON meeting_transcripts(meeting_id, created_at)`);

  await query(`
    CREATE TABLE IF NOT EXISTS meeting_notes (
      id UUID PRIMARY KEY,
      meeting_id UUID NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
      summary TEXT,
      key_points JSONB DEFAULT '[]'::jsonb,
      decisions JSONB DEFAULT '[]'::jsonb,
      action_items JSONB DEFAULT '[]'::jsonb,
      important_timestamps JSONB DEFAULT '[]'::jsonb,
      model VARCHAR(100),
      generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Server-side (Egress) recording columns on the shared recordings table.
  await query(`ALTER TABLE recordings ADD COLUMN IF NOT EXISTS egress_id TEXT`);
  await query(`ALTER TABLE recordings ADD COLUMN IF NOT EXISTS provider VARCHAR(20)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_recordings_egress ON recordings(egress_id) WHERE egress_id IS NOT NULL`);

  // Default for the admin-selected calling provider (LiveKit is the default;
  // the factory also falls back to it when the setting is absent).
  await query(`
    INSERT INTO system_settings (key, value, description)
    VALUES ('calling_provider', 'livekit', 'Globally active calling provider for calls & meetings (managed by platform admins)')
    ON CONFLICT (key) DO NOTHING
  `);

  console.log("[migrations] calling provider schema applied");
}

/**
 * Chat social features (WhatsApp-style UX):
 *  1. chat_messages — edits (edited_at), delete-for-me/everyone tombstones
 *     (deleted_for / deleted_for_everyone) and replies (reply_to_id).
 *  2. chat_participants.role — 'admin' | 'member'; group creators become admins.
 *  3. users.last_seen_at (+ presence_status) — online/offline + "last seen" chips.
 *  4. user_blocks — block contact enforcement for direct conversations.
 *  5. web_push_subscriptions — Web Push (VAPID) endpoints for browsers.
 * Everything idempotent, safe on every boot.
 */
async function ensureChatCallUxSchema(): Promise<void> {
  // --- chat_messages: edit / delete / reply ---
  await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`);
  await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_for_everyone BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_for UUID[] NOT NULL DEFAULT '{}'`);
  await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_reply_to ON chat_messages(reply_to_id)`);
  // Forwarding: WhatsApp-style "Forwarded" label on messages copied into
  // another conversation via the multi-select forward flow.
  await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS forwarded BOOLEAN DEFAULT FALSE`);

  // --- chat_participants: role ('admin' | 'member') ---
  await query(`ALTER TABLE chat_participants ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'member'`);
  // One-time backfill (idempotent by construction): the creator of a GROUP
  // conversation is its admin. Direct conversations keep everyone as 'member'.
  await query(
    `UPDATE chat_participants cp
     SET role = 'admin'
     FROM chat_conversations cc
     WHERE cp.conversation_id = cc.id
       AND cc.type <> 'direct'
       AND cc.created_by = cp.user_id
       AND cp.role <> 'admin'`,
  );

  // --- users: last seen + presence (chat list chips, WhatsApp-style) ---
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_status VARCHAR(20) DEFAULT 'offline'`);

  // --- user_blocks: contact blocking for direct conversations ---
  // NOTE: business_id intentionally mirrors the rest of the schema
  // (VARCHAR(255) referencing businesses.id) instead of UUID — every existing
  // table stores business ids that way.
  await query(`
    CREATE TABLE IF NOT EXISTS user_blocks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL,
      blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(blocker_id, blocked_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id)`);

  // --- web_push_subscriptions: browser Web Push (VAPID) endpoints ---
  await query(`
    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh_key TEXT NOT NULL,
      auth_key TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user ON web_push_subscriptions(user_id)`);

  console.log("[migrations] chat social features schema applied");
}

/**
 * Web Push (VAPID) keys: prefer env (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY),
 * fall back to system_settings, otherwise generate once and persist so
 * restarts keep the same keys (subscriptions are bound to the public key).
 * Non-fatal: Web Push is an enhancement, never a boot blocker.
 */
async function ensureVapidKeys(): Promise<void> {
  try {
    const { ensureVapidKeys: bootstrap } = await import("./services/webPush");
    await bootstrap();
  } catch (err: any) {
    console.error(`[migrations] VAPID key bootstrap skipped: ${err?.message || err}`);
  }
}

/**
 * Google-style meeting scheduling schema:
 *  1. meetings.recurrence_rule        — JSON string describing the series
 *                                        { frequency, interval, customDays?, endDate?, count? }
 *  2. meetings.recurrence_parent_id   — links each occurrence to the series head
 *  3. meetings.occurrence_index       — 0 for the series head
 *  4. meeting_guests                  — external (non-team) participants by email
 *  5. meeting_reminders.remind_at     — absolute timestamp the per-minute cron
 *                                       fires on (push + email reminder)
 */
async function ensureMeetingSchedulingSchema(): Promise<void> {
  await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recurrence_rule TEXT`);
  await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recurrence_parent_id UUID`);
  await query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS occurrence_index INTEGER`);

  await query(`
    CREATE TABLE IF NOT EXISTS meeting_guests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT,
      status TEXT DEFAULT 'invited',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(meeting_id, email)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_meeting_guests_meeting ON meeting_guests(meeting_id)`);

  // Absolute fire time for the reminder cron (the legacy `minutes` column is
  // kept for compatibility — remind_at is authoritative).
  await query(`ALTER TABLE meeting_reminders ADD COLUMN IF NOT EXISTS remind_at TIMESTAMPTZ`);
  await query(`CREATE INDEX IF NOT EXISTS idx_meeting_reminders_due ON meeting_reminders (remind_at) WHERE sent = FALSE`);

  console.log("[migrations] meeting scheduling schema applied");
}
