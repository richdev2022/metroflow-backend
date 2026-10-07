import { query } from "./db";

/**
 * Post-initialize migrations + one-off data repairs.
 * Called from initializeDatabase() after the base schema exists.
 * Everything here is idempotent - safe to run on every boot.
 */
export async function runPostInitializeMigrations(): Promise<void> {
  // ---- 1. Schema DDL (tables + columns) -------------------------------
  // EVERY schema-creating migration must run before any data ladder: the
  // pricing ladder below UPDATEs columns owned by the revenue schemas, and
  // running it first crashed every boot with SQLSTATE 42703
  // ("column invoices_enabled of relation pricing_plans does not exist"),
  // which also starved every later migration (invoices/store/recurring/
  // team_roles never got created).
  await ensureAppTables();
  await ensurePayrollVerificationColumns();
  await ensureSystemSettingsDefaults();
  await ensureChatAndAiSchema();
  await ensureChatCallUxSchema();
  await ensureAiLimitsSchema();
  await ensureSupportSchema();
  await ensureCallingSchema();
  await ensureMeetingSchedulingSchema();
  await ensureVapidKeys();
  await ensureSiteGrowthSchema();
  await ensureRevenueFeaturesSchema(); // + payment_links_enabled etc.
  await ensureInvoicesSchema(); // + invoices_enabled etc.
  await ensureStoreSchema(); // + store_enabled etc.
  await ensureRecurringBillingSchema(); // + recurring_enabled etc.
  await ensureTeamRolesSchema(); // + users.role_id
  await ensureAppVersionsSchema(); // mobile app release tracking (update prompts)
  await ensureDisputesSchema(); // transaction dispute lifecycle (customer -> admin)
  await ensureBeneficiariesSchema(); // transfer beneficiaries (recent recipients)

  // ---- 2. Ledger repairs (data, idempotent) ---------------------------
  await ensureLedgerAndVirtualAccountFixes();
  await backfillLedgerHistory();
  await purgeInternalLedgerNoiseRows();
  await sanitizePlaceholderPhoneNumbers();
  await repairTransferReferenceCollisions();
  await ensureParticipantDedupe();
  await ensureRequestLogsSchema();
  await ensureLoginSecurityColumns();

  // ---- 3. Data ladders (gated UPDATEs — always LAST) ------------------
  await ensureBusinessRevenueLadder();
  await ensureBusinessRevenueLadderV2();
  await ensurePlanPricingLadder();
}

/**
 * Transfer beneficiaries — a per-user directory of recent transfer recipients.
 * Populated automatically whenever a user initiates a single transfer and
 * surfaced as one-tap chips inside the transfer form. Auto-save is upsert
 * keyed on (user, bank, account) so repeat transfers refresh last_used_at
 * instead of duplicating rows.
 */
async function ensureBeneficiariesSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS transfer_beneficiaries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      business_id UUID,
      bank_code VARCHAR(20) NOT NULL,
      bank_name VARCHAR(120),
      account_number VARCHAR(20) NOT NULL,
      account_name VARCHAR(160),
      currency VARCHAR(10) DEFAULT 'NGN',
      use_count INTEGER DEFAULT 1,
      last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, bank_code, account_number)
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_beneficiaries_user ON transfer_beneficiaries(user_id, last_used_at DESC)`,
  );
  // Align business_id with businesses.id (VARCHAR(255)) — legacy installs
  // created it as UUID, which breaks the upsert for short business ids.
  const benefBizCol = await query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name = 'transfer_beneficiaries' AND column_name = 'business_id'`,
  );
  if (benefBizCol.rows[0]?.data_type === "uuid") {
    await query(
      `ALTER TABLE transfer_beneficiaries
       ALTER COLUMN business_id TYPE VARCHAR(255) USING business_id::text`,
    );
  }
  // International beneficiaries (USD/GBP/EUR): store the full corridor
  // details so the beneficiary page can prefill an international payout
  // end-to-end (bank, routing/SWIFT, address block) without retyping.
  await query(`
    ALTER TABLE transfer_beneficiaries
      ADD COLUMN IF NOT EXISTS recipient_country VARCHAR(5),
      ADD COLUMN IF NOT EXISTS routing_number VARCHAR(30),
      ADD COLUMN IF NOT EXISTS swift_code VARCHAR(20),
      ADD COLUMN IF NOT EXISTS account_type VARCHAR(20),
      ADD COLUMN IF NOT EXISTS address_line VARCHAR(255),
      ADD COLUMN IF NOT EXISTS city VARCHAR(120),
      ADD COLUMN IF NOT EXISTS state VARCHAR(120),
      ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20),
      ADD COLUMN IF NOT EXISTS is_intl BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS email VARCHAR(160)
  `);
  // IBANs run up to 34 characters — widen the legacy VARCHAR(20) column.
  await query(`ALTER TABLE transfer_beneficiaries ALTER COLUMN account_number TYPE VARCHAR(40)`);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_beneficiaries_user_currency ON transfer_beneficiaries(user_id, currency, last_used_at DESC)`,
  );
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
  // Account type on the intl rails (USD: checking|savings|depository,
  // GBP: personal|corporate) — persisted so beneficiary prefill + provider
  // meta[] survive the queue round-trip.
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS recipient_account_type VARCHAR(20)`);
  await query(`ALTER TABLE transfer_queue ADD COLUMN IF NOT EXISTS recipient_email TEXT`);
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

  // Login attempt audit (feeds the always-on login attempt emails).
  // NOTE: this table also has an audit-style variant created by
  // initializeDatabase() (db.ts) with success/failure_reason instead of
  // status/device_info. Both writer shapes must always work, so include the
  // union of both variants here; db.ts additionally ALTERs the existing
  // table to the same union on every boot.
  await query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255),
      user_id UUID,
      business_id VARCHAR(255),
      status VARCHAR(20), -- success | failed
      ip_address VARCHAR(64),
      user_agent TEXT,
      device_info JSONB,
      success BOOLEAN,
      failure_reason VARCHAR(100),
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
 * EVERY historical movement (previously balances moved silently).
 *
 * ALIGNED WITH THE OWNER-INVARIANT MODEL:
 *  1. Withdrawal (transfer) -> platform ledger CREDIT (the payout hold) +
 *     fee -> revenue ledger. Only rows missing entirely are reconstructed.
 *  2. Wallet funding -> platform ledger DEBIT (the user payout) + fee ->
 *     revenue ledger. The old gross-inflow reconstruction is gone (noise).
 *  3. NO balance-reconciliation rows: the previous version inserted a
 *     'Historical balance reconciliation' row with a Date.now() reference on
 *     EVERY boot while drift persisted — that spam was the top complaint in
 *     the admin ledger. Drift is now logged, never written.
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
        // New model: a withdrawal's platform entry is a CREDIT (the payout
        // hold), written live since the hold-row fix. Backfill one ONLY for
        // historical transfers that carry no platform row at all.
        const exists = await query(
          `SELECT 1 FROM transactions WHERE reference = $1 AND transaction_type = 'platform' LIMIT 1`,
          [t.reference],
        );
        if (exists.rows.length === 0) {
          await query(
            `INSERT INTO transactions
             (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, created_at)
             VALUES ($1, $2, 'success', $3, 'credit', $4, 'platform', $5, 'credit', $6)
           ON CONFLICT (reference) DO NOTHING`,
            [amount, cur, t.reference, t.description || `Platform Wallet Credit for Transfer ${t.reference} (backfill)`, walletId, t.created_at],
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
             VALUES ($1, $2, 'success', $3, 'credit', $4, 'fee', 'credit', $5)
             ON CONFLICT (reference) DO NOTHING`,
            [fee, cur, revRef, "Transfer fee revenue (backfill)", t.created_at],
          );
        }
      }
    }

    // ---- 2. Successful wallet fundings missing their platform-side row ----
    // Owner invariant: a funding event's platform entry is ONE DEBIT of the
    // amount that landed in the user's wallet (fee -> revenue ledger). The
    // old gross-credit + user-debit reconstruction fought that model and was
    // part of the "unwanted transactions" noise.
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

      const exists = await query(
        `SELECT 1 FROM transactions WHERE reference = $1 AND transaction_type = 'platform' LIMIT 1`,
        [ref],
      );
      if (exists.rows.length > 0) continue; // live webhook path already recorded it

      if (walletId && net > 0) {
        await query(
          `INSERT INTO transactions
           (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, payment_provider, created_at)
           VALUES ($1, $2, 'success', $3, 'debit', $4, 'platform', $5, 'debit', $6, $7)
           ON CONFLICT (reference) DO NOTHING`,
          [net, cur, `${ref}-USER-BACKFILL`, "User Wallet Funding (backfill)", walletId, f.payment_provider || null, f.created_at],
        );
      }
      if (fee > 0) {
        await query(
          `INSERT INTO transactions
           (amount, currency, status, reference, type, description, transaction_type, direction, payment_provider, created_at)
           VALUES ($1, $2, 'success', $3, 'credit', $4, 'fee', 'credit', $5, $6)
           ON CONFLICT (reference) DO NOTHING`,
          [fee, cur, `${ref}-FEE-BACKFILL`, "Wallet funding fee revenue (backfill)", f.payment_provider || null, f.created_at],
        );
      }
    }

    // ---- 3. Drift check — LOG ONLY, never write ----
    // The previous version inserted a 'Historical balance reconciliation'
    // adjustment row with a Date.now() reference on every boot while drift
    // persisted, so the ledger filled with reconciliation spam. Report the
    // drift to the logs instead; repairs should be deliberate, not automatic.
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
        console.warn(
          `[migrations] Platform wallet ${w.id} (${w.currency}) drift: balance=${balance} vs recorded=${recorded} (diff=${diff}) — logged only, no auto-reconciliation row written`,
        );
      }
    }

    console.log("[migrations] ledger backfill complete");
  } catch (err: any) {
    console.error(`[migrations] ledger backfill failed [${err?.code || "UNKNOWN"}]: ${err?.message}`);
  }
}

/**
 * PLATFORM LEDGER = mirror of the provider POOL account.
 *
 * Between the first ledger writer and the pool-mirror rework, the writers
 * recorded internal allocation pairs as transaction_type='platform' rows:
 *   - "-USER" / "-MERCHANT" / "-PLATFORM" allocation debits (funding / store /
 *     invoice / payment-link / subscription settlements — internal wallet
 *     credits that never touch the pool),
 *   - fee->revenue mirror rows ("Platform Wallet Debit for Revenue" and its
 *     reversal),
 *   - transfer "hold" credits written at initiation plus their "Reversal of
 *     platform hold" counterparts,
 *   - wallet-internal inflows (bill payments, savings withdrawals, wallet-
 *     charged subscriptions).
 * NONE of these correspond to money moving in/out of the provider pool
 * account, so they made the Platform Ledger history inconsistent and
 * unrecognizable. The writers no longer create them — this one-off purge
 * removes the historical noise. Idempotent, safe on every boot.
 */
async function purgeInternalLedgerNoiseRows(): Promise<void> {
  try {
    const res = await query(
      `DELETE FROM transactions
       WHERE transaction_type = 'platform'
         AND (
              reference LIKE '%-USER'
           OR reference LIKE '%-MERCHANT'
           OR reference LIKE '%-PLATFORM'
           OR description LIKE 'Platform Wallet Debit for Revenue%'
           OR description LIKE 'Platform Wallet Credit (Revenue Reversal)%'
           OR description LIKE 'Platform Wallet Credit for Transfer%'
           OR description LIKE 'Reversal of platform hold%'
           OR description LIKE 'Platform Wallet Debit for Savings Payout%'
           OR description IN (
                'Bill Payment Received',
                'Savings Withdrawal Received',
                'Subscription Charge Collected'
              )
         )`,
    );
    if (res.rowCount && res.rowCount > 0) {
      console.log(`[migrations] purged ${res.rowCount} internal platform-ledger noise rows (pool mirror cleanup)`);
    }
  } catch (err: any) {
    console.error(`[migrations] platform ledger purge failed [${err?.code || "UNKNOWN"}]: ${err?.message}`);
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

/**
 * Plan pricing / limits ladder (admin-adjustable afterwards).
 *
 * The legacy seeds priced plans in USD (Free 0 / Starter 29 / Pro 99) while the
 * subscription charge flow defaults to NGN — meaning every NGN purchase went
 * through a fragile external FX lookup that silently charged the raw USD number
 * in kobo whenever it failed (a "₦29 Pro plan"). This migration moves the
 * seeded tiers to explicit NGN pricing with a coherent limits ladder across
 * every plan-gated surface (team, RTC, MetricAi, Payment Links, Invoices).
 *
 * Idempotent: each UPDATE only matches the legacy USD seed values, so rows an
 * admin has already re-priced are never clobbered on reboot.
 *
 * OPT-IN: this ladder rewrites price, currency, descriptions, feature lists,
 * meeting limits and MetricAi allowances in one sweep. An admin configuring
 * plans via /admin/pricing that keeps the seed price (e.g. USD 29/99) would
 * still match the guards and get overwritten — so the ladder only runs when
 * explicitly requested with APPLY_PLAN_PRICING_LADDER=true. It has never run
 * in production (it 42703-crashed every boot before the ordering fix), and
 * the live plans were configured via the admin panel afterwards.
 */
async function ensurePlanPricingLadder(): Promise<void> {
  if (process.env.APPLY_PLAN_PRICING_LADDER !== "true") {
    console.log("[migrations] plan pricing ladder skipped (opt-in: set APPLY_PLAN_PRICING_LADDER=true to apply)");
    return;
  }
  // ---------- Free Trial ----------
  await query(`
    UPDATE pricing_plans SET
      currency = 'NGN',
      discount = 0,
      description = 'Everything you need to try Metricorex — personal or business.',
      max_team_members = 5,
      max_meeting_duration = 40,
      max_participants = 8,
      max_recording_duration = 0,
      max_recording_storage = 100,
      recording_enabled = FALSE,
      waiting_room_enabled = FALSE,
      breakout_rooms_enabled = FALSE,
      virtual_backgrounds = FALSE,
      live_captions = FALSE,
      metric_ai_chat_daily = 20,
      metric_ai_chat_monthly = 200,
      metric_ai_image_daily = 3,
      metric_ai_image_monthly = 20,
      metric_ai_video_daily = 0,
      metric_ai_video_monthly = 0,
      payment_links_enabled = TRUE,
      max_payment_links = 1,
      payment_link_fee_discount_percent = 0,
      ai_credit_discount_percent = 0,
      invoices_enabled = TRUE,
      max_invoices_per_month = 3,
      invoice_fee_discount_percent = 0,
      features = '["Up to 5 team members", "Tasks, backlog & ideas", "40-min meetings, 8 participants", "MetricAi: 200 chats + 20 images / month", "1 payment link", "3 invoices per month", "Standard collection fees"]'::jsonb
    WHERE name = 'Free Trial' AND price = 0 AND (currency = 'USD' OR currency IS NULL)
  `);

  // ---------- Starter ----------
  await query(`
    UPDATE pricing_plans SET
      currency = 'NGN',
      price = 9900,
      discount = 0,
      description = 'For small teams getting paid and staying organised.',
      max_team_members = 15,
      max_meeting_duration = 120,
      max_participants = 25,
      max_recording_duration = 60,
      max_recording_storage = 2048,
      recording_enabled = TRUE,
      waiting_room_enabled = TRUE,
      breakout_rooms_enabled = FALSE,
      virtual_backgrounds = FALSE,
      live_captions = FALSE,
      metric_ai_chat_daily = 60,
      metric_ai_chat_monthly = 800,
      metric_ai_image_daily = 10,
      metric_ai_image_monthly = 80,
      metric_ai_video_daily = 1,
      metric_ai_video_monthly = 8,
      payment_links_enabled = TRUE,
      max_payment_links = 5,
      payment_link_fee_discount_percent = 0,
      ai_credit_discount_percent = 5,
      invoices_enabled = TRUE,
      max_invoices_per_month = 15,
      invoice_fee_discount_percent = 10,
      features = '["Up to 15 team members", "2-hour meetings, 25 participants, recording", "MetricAi: 800 chats + 80 images / month", "5 payment links", "15 invoices per month", "10% off invoice settlement fees", "5% off MetricAi credit packs", "Email support"]'::jsonb
    WHERE name = 'Starter' AND price = 29 AND (currency = 'USD' OR currency IS NULL)
  `);

  // ---------- Pro ----------
  await query(`
    UPDATE pricing_plans SET
      currency = 'NGN',
      price = 29900,
      discount = 0,
      description = 'Everything Metricorex offers — unlimited team, best fees.',
      max_team_members = 999999,
      max_meeting_duration = 999999,
      max_participants = 200,
      max_recording_duration = 240,
      max_recording_storage = 10240,
      recording_enabled = TRUE,
      waiting_room_enabled = TRUE,
      breakout_rooms_enabled = TRUE,
      virtual_backgrounds = TRUE,
      live_captions = TRUE,
      metric_ai_chat_daily = 200,
      metric_ai_chat_monthly = 3000,
      metric_ai_image_daily = 15,
      metric_ai_image_monthly = 150,
      metric_ai_video_daily = 5,
      metric_ai_video_monthly = 30,
      payment_links_enabled = TRUE,
      max_payment_links = 999999,
      payment_link_fee_discount_percent = 25,
      ai_credit_discount_percent = 10,
      invoices_enabled = TRUE,
      max_invoices_per_month = 999999,
      invoice_fee_discount_percent = 25,
      features = '["Unlimited team members", "Unlimited meeting duration, 200 participants", "Recording, breakout rooms, virtual backgrounds, live captions", "MetricAi: 3000 chats + 150 images + 30 videos / month", "Unlimited payment links", "Unlimited invoices", "25% off payment link & invoice settlement fees", "10% off MetricAi credit packs", "Priority support"]'::jsonb
    WHERE name = 'Pro' AND price = 99 AND (currency = 'USD' OR currency IS NULL)
  `);

  console.log("[migrations] plan pricing/limits ladder applied");
}

/**
 * Smart Invoices — the third revenue feature.
 *
 * Businesses create itemised invoices (line items, tax, due date) and share a
 * public checkout page with their clients. When a client pays through the
 * active payment provider the webhook settles the invoice: the business wallet
 * is credited net of an invoice settlement fee (fee_configurations 'invoice' —
 * 1% capped ₦2,500 by default, reduced by the plan-level
 * invoice_fee_discount_percent) which lands in the platform revenue wallet.
 *
 * Plan configuration (pricing_plans, admin-editable via /admin/pricing):
 *   - invoices_enabled             (feature toggle)
 *   - max_invoices_per_month       (NULL/999999+ = unlimited)
 *   - invoice_fee_discount_percent
 */
async function ensureInvoicesSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL,
      created_by UUID,
      invoice_number VARCHAR(40) UNIQUE NOT NULL,
      client_name VARCHAR(255) NOT NULL,
      client_email VARCHAR(255) NOT NULL,
      client_phone VARCHAR(50),
      currency VARCHAR(3) DEFAULT 'NGN',
      status VARCHAR(20) DEFAULT 'pending', -- draft | pending | paid | cancelled (overdue computed on read)
      due_date DATE,
      notes TEXT,
      tax_percent DECIMAL(5,2) DEFAULT 0,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
      tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL DEFAULT 0,
      amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
      views INTEGER DEFAULT 0,
      paid_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_invoices_business ON invoices(business_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)`);

  await query(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity DECIMAL(12,2) NOT NULL DEFAULT 1,
      unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      position INTEGER DEFAULT 0
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS invoice_payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
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
  await query(`CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id)`);

  // Plan configuration knobs for Smart Invoices
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS invoices_enabled BOOLEAN DEFAULT TRUE`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_invoices_per_month INTEGER DEFAULT 10`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS invoice_fee_discount_percent DECIMAL(5,2) DEFAULT 0`);

  // Invoice settlement fee (percentage with cap), mirroring payment_link.
  // Idempotent: only inserted when the fee type does not exist yet.
  await query(`
    INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
    SELECT 'Invoice Settlement Fee', 'invoice', 'percentage_cap',
           '{"percentage": 1.0, "cap": 2500}'::jsonb, 'NGN'
    WHERE NOT EXISTS (SELECT 1 FROM fee_configurations WHERE fee_type = 'invoice')
  `);

  console.log("[migrations] Smart Invoices schema applied");
}

/**
 * Storefront ("Metroflow Store") — a BUSINESS revenue feature.
 *
 * Businesses list products/services in a shareable storefront (public page
 * /store/:publicId). Customers place orders and pay through the active
 * payment provider's hosted checkout; the webhook credits the business
 * wallet minus an order fee (fee_configurations 'store_order' — 2.5% capped
 * ₦2,500 by default, reduced by the plan-level store_fee_discount_percent).
 * The fee lands in the platform revenue wallet via creditRevenueWallet and
 * every settlement is double-entered through the platform ledger.
 *
 * Plan configuration (pricing_plans, admin-editable via /admin/pricing):
 *   - store_enabled              (feature toggle)
 *   - max_store_products         (NULL/999999+ = unlimited)
 *   - store_fee_discount_percent
 */
async function ensureStoreSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS store_products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL,
      created_by UUID,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      price DECIMAL(15,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      stock INTEGER,
      image_url TEXT,
      status VARCHAR(20) DEFAULT 'active', -- active | paused | draft
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_store_products_business ON store_products(business_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_store_products_status ON store_products(business_id, status)`);

  await query(`
    CREATE TABLE IF NOT EXISTS store_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL,
      order_number VARCHAR(40) UNIQUE NOT NULL,
      checkout_reference VARCHAR(255) UNIQUE NOT NULL,
      customer_name VARCHAR(160) NOT NULL,
      customer_email VARCHAR(200),
      customer_phone VARCHAR(50),
      subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
      fee DECIMAL(15,2) NOT NULL DEFAULT 0,
      net_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      total DECIMAL(15,2) NOT NULL DEFAULT 0,
      currency VARCHAR(3) DEFAULT 'NGN',
      status VARCHAR(20) DEFAULT 'pending', -- pending | paid | fulfilled | cancelled | failed
      payment_provider VARCHAR(40),
      note TEXT,
      paid_at TIMESTAMP,
      fulfilled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_store_orders_business ON store_orders(business_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_store_orders_status ON store_orders(status)`);

  await query(`
    CREATE TABLE IF NOT EXISTS store_order_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
      product_id UUID,
      product_name VARCHAR(160) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price DECIMAL(15,2) NOT NULL,
      amount DECIMAL(15,2) NOT NULL
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_store_order_items_order ON store_order_items(order_id)`);

  // Plan configuration knobs for the Storefront
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS store_enabled BOOLEAN DEFAULT TRUE`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_store_products INTEGER DEFAULT 5`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS store_fee_discount_percent DECIMAL(5,2) DEFAULT 0`);

  // Storefront order fee: 2.5% capped ₦2,500 (idempotent seed).
  await query(`
    INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
    SELECT 'Storefront Order Fee', 'store_order', 'percentage_cap',
           '{"percentage": 2.5, "cap": 2500}'::jsonb, 'NGN'
    WHERE NOT EXISTS (SELECT 1 FROM fee_configurations WHERE fee_type = 'store_order')
  `);

  console.log("[Migrations] Storefront schema applied");
}

/**
 * Recurring Billing (Customer Subscriptions) — a BUSINESS revenue feature.
 *
 * Businesses create subscription plans (daily / weekly / monthly) and share
 * a public subscribe link. Subscribers either auto-pay from their Metroflow
 * wallet (when the subscriber email maps to a platform user, mandate style —
 * charged by the 5-minute cron engine) or pay each cycle through the hosted
 * checkout link emailed to them. Every successful charge credits the
 * merchant wallet minus a platform fee (fee_configurations 'subscription' —
 * 2% capped ₦2,000 by default, reduced by the plan-level
 * subscription_fee_discount_percent) which lands in the platform revenue
 * wallet via creditRevenueWallet.
 *
 * Plan configuration (pricing_plans, admin-editable via /admin/pricing):
 *   - recurring_enabled                   (feature toggle)
 *   - max_subscription_plans              (NULL/999999+ = unlimited)
 *   - subscription_fee_discount_percent
 */
async function ensureRecurringBillingSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS customer_subscription_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL,
      created_by UUID,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      amount DECIMAL(15,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      interval VARCHAR(20) NOT NULL DEFAULT 'monthly', -- daily | weekly | monthly
      status VARCHAR(20) DEFAULT 'active',             -- active | paused
      public_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_csub_plans_business ON customer_subscription_plans(business_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS customer_subscribers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL,
      plan_id UUID NOT NULL REFERENCES customer_subscription_plans(id) ON DELETE CASCADE,
      customer_user_id UUID,
      wallet_id UUID,
      customer_name VARCHAR(160) NOT NULL,
      customer_email VARCHAR(200) NOT NULL,
      customer_phone VARCHAR(50),
      status VARCHAR(20) DEFAULT 'active', -- active | past_due | cancelled
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      next_charge_date DATE,
      last_charged_at TIMESTAMP,
      last_charge_reference VARCHAR(255),
      unsubscribe_token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_csub_subscribers_business ON customer_subscribers(business_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_csub_subscribers_plan ON customer_subscribers(plan_id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_csub_subscribers_plan_email ON customer_subscribers(plan_id, customer_email)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_csub_subscribers_due ON customer_subscribers(next_charge_date) WHERE status = 'active'`);

  await query(`
    CREATE TABLE IF NOT EXISTS subscription_charges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL,
      subscriber_id UUID NOT NULL REFERENCES customer_subscribers(id) ON DELETE CASCADE,
      plan_id UUID NOT NULL,
      reference VARCHAR(255) UNIQUE NOT NULL,
      amount DECIMAL(15,2) NOT NULL,
      fee DECIMAL(15,2) NOT NULL DEFAULT 0,
      net_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      currency VARCHAR(3) DEFAULT 'NGN',
      charge_path VARCHAR(20) NOT NULL DEFAULT 'checkout', -- wallet | checkout
      status VARCHAR(20) DEFAULT 'pending',                -- pending | awaiting_payment | success | failed
      period_start DATE,
      period_end DATE,
      failure_reason TEXT,
      paid_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_sub_charges_subscriber ON subscription_charges(subscriber_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sub_charges_business ON subscription_charges(business_id)`);

  // Plan configuration knobs for Recurring Billing
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS recurring_enabled BOOLEAN DEFAULT TRUE`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_subscription_plans INTEGER DEFAULT 2`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS subscription_fee_discount_percent DECIMAL(5,2) DEFAULT 0`);

  // Subscription charge fee: 2% capped ₦2,000 (idempotent seed).
  await query(`
    INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
    SELECT 'Subscription Charge Fee', 'subscription', 'percentage_cap',
           '{"percentage": 2.0, "cap": 2000}'::jsonb, 'NGN'
    WHERE NOT EXISTS (SELECT 1 FROM fee_configurations WHERE fee_type = 'subscription')
  `);

  console.log("[Migrations] Recurring Billing schema applied");
}

/**
 * Business revenue knob ladder — seeds the Storefront / Recurring Billing
 * knobs per plan and refreshes each plan's feature list:
 *   1. strips the Personal-app bullets (bill payments / savings vaults) —
 *      those features moved out of the business app into the dormant
 *      personal feature folder (server/features/personal);
 *   2. appends the Storefront + Recurring Billing bullets exactly once.
 * Knob UPDATEs are gated on the columns still being at their freshly-added
 * defaults so an admin's later re-pricing is never clobbered.
 */
async function ensureBusinessRevenueLadder(): Promise<void> {
  // ---------- Knobs (gated on untouched defaults) ----------
  await query(`
    UPDATE pricing_plans SET
      store_enabled = TRUE,
      max_store_products = 3,
      store_fee_discount_percent = 0,
      recurring_enabled = TRUE,
      max_subscription_plans = 1,
      subscription_fee_discount_percent = 0
    WHERE name = 'Free Trial' AND (max_store_products IS NULL OR max_store_products = 5)
      AND (max_subscription_plans IS NULL OR max_subscription_plans = 2)
  `);
  await query(`
    UPDATE pricing_plans SET
      store_enabled = TRUE,
      max_store_products = 15,
      store_fee_discount_percent = 10,
      recurring_enabled = TRUE,
      max_subscription_plans = 10,
      subscription_fee_discount_percent = 10
    WHERE name = 'Starter' AND (max_store_products IS NULL OR max_store_products = 5)
      AND (max_subscription_plans IS NULL OR max_subscription_plans = 10)
  `);
  await query(`
    UPDATE pricing_plans SET
      store_enabled = TRUE,
      max_store_products = 999999,
      store_fee_discount_percent = 25,
      recurring_enabled = TRUE,
      max_subscription_plans = 999999,
      subscription_fee_discount_percent = 25
    WHERE name = 'Pro' AND (max_store_products IS NULL OR max_store_products = 5)
      AND (max_subscription_plans IS NULL OR max_subscription_plans = 999999)
  `);

  // ---------- Feature bullets (strip personal, append business once) ----------
  try {
    const plans = await query(`SELECT id, name, max_store_products, max_subscription_plans, features FROM pricing_plans`);
    for (const plan of plans.rows) {
      const features: string[] = Array.isArray(plan.features) ? plan.features : [];
      const next = features.filter(
        (f: string) => !/bill payment/i.test(f) && !/savings vault/i.test(f)
      );
      const hasStore = next.some((f: string) => /storefront/i.test(f));
      const hasRecurring = next.some((f: string) => /recurring billing/i.test(f));
      if (hasStore && hasRecurring) {
        if (next.length !== features.length) {
          await query(`UPDATE pricing_plans SET features = $2::jsonb WHERE id = $1`, [plan.id, JSON.stringify(next)]);
        }
        continue;
      }

      const fmt = (n: any, noun: string) =>
        n == null || Number(n) >= 999999 ? `Unlimited ${noun}` : `${Number(n)} ${noun}${Number(n) === 1 ? "" : "s"}`;
      if (!hasStore) next.push(`${fmt(plan.max_store_products, "storefront product")} with hosted checkout`);
      if (!hasRecurring) next.push(`${fmt(plan.max_subscription_plans, "recurring billing plan")} on any interval`);
      await query(`UPDATE pricing_plans SET features = $2::jsonb WHERE id = $1`, [plan.id, JSON.stringify(next)]);
    }
  } catch (err) {
    console.error("[Migrations] business revenue feature-bullet refresh failed:", err);
  }

  console.log("[Migrations] business revenue knob ladder applied");
}

/**
 * Business revenue knob ladder V2 — a rebalanced, revenue-driven ladder for
 * the Storefront / Recurring Billing knobs plus softer fee caps.
 *
 * Why: the V1 ladder was written defensively small (Free Trial 3 products /
 * 1 subscription plan, Starter 15/10 at 10% fee discounts). The approved
 * monetisation ladder widens the funnel and makes the paid step-ups
 * unmistakable:
 *
 *   Plan         max_store_products  max_subscription_plans  fee discounts
 *   Free Trial    3  -> 5             1  -> 2                 0%
 *   Starter      15  -> 25           10 -> 25                10% -> 15%
 *   Pro          unlimited           unlimited               25% -> 35%
 *
 * Fee caps (fee_configurations, platform-wide):
 *   store_order  2.5% cap ₦2,500 -> 2.5% cap ₦2,000  (competitive with the
 *                ₦2,000 local cap tier used by NGN PSPs for large baskets)
 *   subscription 2.0% cap ₦2,000 -> 2.0% cap ₦1,500  (recurring volume play —
 *                keeps per-charge fees predictable for merchants)
 *
 * Every UPDATE is gated on the exact V1 value so an admin's later re-pricing
 * (via /admin/pricing) is never clobbered on reboot. The plan feature
 * bullets for both surfaces are regenerated to match the new numbers.
 */
async function ensureBusinessRevenueLadderV2(): Promise<void> {
  // ---------- Fee caps (gated on the V1 configs) ----------
  await query(`
    UPDATE fee_configurations
    SET config = '{"percentage": 2.5, "cap": 2000}'::jsonb, updated_at = CURRENT_TIMESTAMP
    WHERE fee_type = 'store_order'
      AND config_type = 'percentage_cap'
      AND config->>'percentage' = '2.5'
      AND config->>'cap' = '2500'
  `);
  await query(`
    UPDATE fee_configurations
    SET config = '{"percentage": 2.0, "cap": 1500}'::jsonb, updated_at = CURRENT_TIMESTAMP
    WHERE fee_type = 'subscription'
      AND config_type = 'percentage_cap'
      AND (config->>'percentage' = '2' OR config->>'percentage' = '2.0')
      AND config->>'cap' = '2000'
  `);

  // ---------- Knobs (gated on the V1 ladder) ----------
  await query(`
    UPDATE pricing_plans SET
      max_store_products = 5,
      store_fee_discount_percent = 0,
      max_subscription_plans = 2,
      subscription_fee_discount_percent = 0
    WHERE name = 'Free Trial'
      AND max_store_products = 3 AND max_subscription_plans = 1
      AND store_fee_discount_percent = 0 AND subscription_fee_discount_percent = 0
  `);
  await query(`
    UPDATE pricing_plans SET
      max_store_products = 25,
      store_fee_discount_percent = 15,
      max_subscription_plans = 25,
      subscription_fee_discount_percent = 15
    WHERE name = 'Starter'
      AND max_store_products = 15 AND max_subscription_plans = 10
      AND store_fee_discount_percent = 10 AND subscription_fee_discount_percent = 10
  `);
  await query(`
    UPDATE pricing_plans SET
      max_store_products = 999999,
      store_fee_discount_percent = 35,
      max_subscription_plans = 999999,
      subscription_fee_discount_percent = 35
    WHERE name = 'Pro'
      AND max_store_products = 999999 AND max_subscription_plans = 999999
      AND store_fee_discount_percent = 25 AND subscription_fee_discount_percent = 25
  `);

  // ---------- Feature bullets (regenerate store/recurring once) ----------
  try {
    const plans = await query(`SELECT id, name, max_store_products, max_subscription_plans, store_fee_discount_percent, subscription_fee_discount_percent, features FROM pricing_plans`);
    for (const plan of plans.rows) {
      const features: string[] = Array.isArray(plan.features) ? plan.features : [];
      const others = features.filter(
        (f: string) => !/storefront/i.test(f) && !/recurring billing/i.test(f)
      );
      const fmt = (n: any, noun: string) =>
        n == null || Number(n) >= 999999 ? `Unlimited ${noun}` : `${Number(n)} ${noun}${Number(n) === 1 ? "" : "s"}`;
      const storeDiscount = Number(plan.store_fee_discount_percent) || 0;
      const subDiscount = Number(plan.subscription_fee_discount_percent) || 0;
      const next = [
        ...others,
        `${fmt(plan.max_store_products, "storefront product")} with hosted checkout` +
          (storeDiscount > 0 ? ` · ${storeDiscount}% off order fees` : ""),
        `${fmt(plan.max_subscription_plans, "recurring billing plan")} on any interval` +
          (subDiscount > 0 ? ` · ${subDiscount}% off subscription fees` : ""),
      ];
      if (JSON.stringify(next) !== JSON.stringify(features)) {
        await query(`UPDATE pricing_plans SET features = $2::jsonb WHERE id = $1`, [plan.id, JSON.stringify(next)]);
      }
    }
  } catch (err) {
    console.error("[Migrations] business revenue V2 feature-bullet refresh failed:", err);
  }

  console.log("[Migrations] business revenue knob ladder V2 applied");
}

/**
 * Business-team Roles & Permissions ("Role Management"):
 *   - team_roles: per-business roles carrying a permissions array (slugs from
 *     config/permissions.ts). Mirrors the platform-admin RBAC.
 *   - users.role_id: the member's assigned custom role (NULL = legacy role
 *     string semantics — owner/admin/manager/member defaults still apply).
 * Idempotent; safe on every boot.
 */
async function ensureTeamRolesSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS team_roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      permissions TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(business_id, name)
    )
  `);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES team_roles(id) ON DELETE SET NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_team_roles_business ON team_roles(business_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id)`);
  // Complete employee information on team members (invite form).
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(120)`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(120)`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_type VARCHAR(40)`);
  // Pre-existing tables (created before is_system existed) must still get the
  // column — the default-role seeding relies on it.
  await query(`ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}'`);
  await query(`ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS description TEXT`);
  // The UNIQUE(business_id, name) is only guaranteed on tables created by the
  // CREATE above; add it defensively for legacy tables (no-op when present).
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname LIKE 'team_roles_business_id_name_key'
          AND conrelid = 'team_roles'::regclass
      ) THEN
        BEGIN
          ALTER TABLE team_roles ADD CONSTRAINT team_roles_business_id_name_key UNIQUE (business_id, name);
        EXCEPTION WHEN others THEN NULL; -- duplicate rows already present
        END;
      END IF;
    END $$;
  `);
}

/**
 * Mobile app releases (drives the in-app "update available" prompt).
 *
 * The mobile app calls GET /api/public/app-updates/check on login / app start
 * with its current version code (build number). The endpoint compares it with
 * the newest ACTIVE row for the platform:
 *   - update_available: latest.version_code > current
 *   - update_required:  latest.force_update OR current < min_supported_version_code
 *     (min_supported is the MAX floor across ALL active rows, so any active
 *     release can raise the floor for older installs)
 *
 * `version_code` is the monotonic build number (flutter --build-number=N →
 * Android versionCode / iOS CFBundleVersion), which is the robust comparison
 * key; version_name (semver string) is display-only.
 *
 * Seeded with the current production baseline (build 13) so the admin panel
 * has a starting row; inserts are ON CONFLICT idempotent.
 */
async function ensureAppVersionsSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS app_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      platform VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android')),
      version_name VARCHAR(32) NOT NULL,
      version_code INTEGER NOT NULL,
      force_update BOOLEAN NOT NULL DEFAULT FALSE,
      min_supported_version_code INTEGER,
      release_notes TEXT,
      store_url TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by UUID,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT app_versions_platform_code_unique UNIQUE (platform, version_code)
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_app_versions_platform_active
     ON app_versions (platform, is_active, version_code DESC)`,
  );
  // Baseline rows for the currently shipping build (idempotent).
  await query(`
    INSERT INTO app_versions (platform, version_name, version_code, release_notes, is_active)
    VALUES
      ('android', '1.0.0', 13, 'Initial tracked release.', TRUE),
      ('ios', '1.0.0', 13, 'Initial tracked release.', TRUE)
    ON CONFLICT (platform, version_code) DO NOTHING
  `);
}

/**
 * Transaction disputes: a customer opens a dispute against a debit
 * (transfer / payment), attaches evidence, and a platform admin investigates
 * and resolves it (reversal with credit-guard, provider recheck, or close).
 * One OPEN dispute per transaction reference is enforced by a partial unique
 * index; resolved/closed disputes free the reference for a new dispute.
 */
async function ensureDisputesSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS transaction_disputes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255) NOT NULL,
      user_id UUID,
      transaction_reference VARCHAR(255) NOT NULL,
      transaction_source VARCHAR(20),            -- 'transfer_queue' | 'transactions'
      category VARCHAR(50) DEFAULT 'other',      -- failed_transfer|unauthorized|double_debit|not_received|amount_mismatch|other
      message TEXT NOT NULL,
      attachment_url TEXT,
      attachment_name VARCHAR(255),
      status VARCHAR(30) DEFAULT 'open',         -- open|under_review|resolved|closed|rejected
      resolution_action VARCHAR(40),             -- reversal|recheck|closed|none
      resolution_note TEXT,
      resolved_by UUID,                          -- platform admin id
      resolved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // businesses.id was migrated to VARCHAR(255) — earlier installs created
  // business_id as UUID, which breaks both the admin list JOIN
  // (varchar = uuid -> 42883) and filing disputes for any business whose id
  // is a short generateBusinessId() string (22P02). Align the column type.
  const disputesBizCol = await query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name = 'transaction_disputes' AND column_name = 'business_id'`,
  );
  if (disputesBizCol.rows[0]?.data_type === "uuid") {
    await query(
      `ALTER TABLE transaction_disputes
       ALTER COLUMN business_id TYPE VARCHAR(255) USING business_id::text`,
    );
  }
  await query(`CREATE INDEX IF NOT EXISTS idx_disputes_business ON transaction_disputes(business_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_disputes_status ON transaction_disputes(status)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_disputes_open_txn
    ON transaction_disputes (transaction_reference)
    WHERE status IN ('open', 'under_review')
  `);
}

/**
 * Some older clients wrote the literal strings 'null' / 'undefined' into
 * users.phone_number (e.g. a form controller that stringified a null value).
 * Those rows poison OTP delivery and profile prefill ("phoneNumber": "null").
 * Idempotent: the UPDATE only matches the placeholder values.
 */
async function sanitizePlaceholderPhoneNumbers(): Promise<void> {
  try {
    const res = await query(
      `UPDATE users SET phone_number = NULL
       WHERE phone_number IS NOT NULL
         AND LOWER(TRIM(phone_number)) IN ('null', 'undefined', 'none', 'n/a')`
    );
    if (res.rowCount && res.rowCount > 0) {
      console.log(`[migrations] sanitized ${res.rowCount} placeholder phone_number value(s) on users`);
    }
  } catch (err: any) {
    console.warn('[migrations] sanitizePlaceholderPhoneNumbers skipped:', err?.message);
  }
}

/**
 * REPAIR for the "debited but no transaction row / never refunded" prod bug.
 *
 * Root cause: the platform-ledger HOLD row was written with the RAW transfer
 * reference BEFORE the user's debit row. transactions.reference is GLOBALLY
 * unique, so the debit-row INSERT (ON CONFLICT (reference) DO NOTHING) was
 * silently swallowed — the wallet was debited with NO debit row, and every
 * reversal path (webhook, monitor sweep, user "reverse now", admin reverse)
 * requires that debit row and silently no-op'd.
 *
 * Repair (idempotent, bounded):
 *   1. platform hold rows that stole a raw transfer reference are renamed to
 *      '<ref>-PLATFORM' (the reference the pipeline now writes),
 *   2. the missing user debit rows are reconstructed for every transfer whose
 *      wallet was debited (evidenced by the hold row),
 *   3. FAILED transfers then carry a debit row, so the existing reconciliation
 *      sweep auto-reverses them (wallet credit + -REFUND rows + push) on its
 *      next pass — the user's stuck money returns without manual action.
 */
async function repairTransferReferenceCollisions(): Promise<void> {
  // 1. Rename colliding platform hold rows.
  try {
    const collisions = await query(
      `SELECT t.id, t.reference
       FROM transactions t
       JOIN transfer_queue q ON q.reference = t.reference
       WHERE t.transaction_type = 'platform'
         AND NOT EXISTS (
           SELECT 1 FROM transactions d
           WHERE d.reference = q.reference AND d.type = 'debit' AND d.transaction_type = 'transfer'
         )
       LIMIT 500`
    );
    for (const row of collisions.rows) {
      try {
        await query(`UPDATE transactions SET reference = $1 WHERE id = $2`, [`${row.reference}-PLATFORM`, row.id]);
      } catch (e: any) {
        // A '-PLATFORM' row already exists for this ref — drop the duplicate hold quietly.
        if (e?.code === '23505') {
          await query(`DELETE FROM transactions WHERE id = $1`, [row.id]).catch(() => {});
        } else {
          console.warn(`[migrations] hold rename failed for ${row.reference}:`, e?.message);
        }
      }
    }
    if (collisions.rows.length > 0) {
      console.log(`[migrations] renamed ${collisions.rows.length} colliding platform hold row(s)`);
    }
  } catch (err: any) {
    console.warn('[migrations] repairTransferReferenceCollisions (rename) skipped:', err?.message);
    return;
  }

  // 2. Reconstruct the missing user debit rows.
  try {
    const res = await query(
      `INSERT INTO transactions
       (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
       SELECT q.business_id,
              COALESCE(q.debit_amount, q.amount),
              COALESCE(q.debit_currency, q.currency, 'NGN'),
              'success',
              q.reference,
              'debit',
              'Transfer to ' || COALESCE(q.recipient_name, 'Account') || ' (reconstructed)',
              'transfer',
              q.wallet_id,
              'debit'
       FROM transfer_queue q
       WHERE q.wallet_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM transactions p
           WHERE p.reference IN (q.reference, q.reference || '-PLATFORM') AND p.transaction_type = 'platform'
         )
         AND NOT EXISTS (
           SELECT 1 FROM transactions d
           WHERE d.reference = q.reference AND d.type = 'debit' AND d.transaction_type = 'transfer'
         )
       ON CONFLICT (reference) DO NOTHING
       RETURNING reference`
    );
    if (res.rows.length > 0) {
      console.log(`[migrations] reconstructed ${res.rows.length} missing transfer debit row(s):`, res.rows.map((r: any) => r.reference).slice(0, 10));
    }
  } catch (err: any) {
    console.warn('[migrations] repairTransferReferenceCollisions (debit rebuild) skipped:', err?.message);
  }
}

/**
 * Call/meeting participant dedupe — the same human joining a call room
 * multiple times (double-tap, double fire, re-join after refresh) used to
 * insert duplicate call_participants / meeting_attendees rows on legacy
 * databases whose tables predate the UNIQUE(call_id, user_id) constraint.
 * This migration (1) collapses existing duplicates keeping the most recent
 * row, and (2) enforces the unique constraint so every future upsert is
 * atomic. Idempotent by construction.
 */
async function ensureParticipantDedupe(): Promise<void> {
  for (const spec of [
    { table: 'call_participants', keyA: 'call_id', keyB: 'user_id', constraint: 'uq_call_participants_call_user' },
    { table: 'meeting_attendees', keyA: 'meeting_id', keyB: 'user_id', constraint: 'uq_meeting_attendees_meeting_user' },
  ] as const) {
    try {
      // 1. Collapse duplicates: keep the newest row per (keyA, keyB).
      await query(
        `DELETE FROM ${spec.table} a
         USING ${spec.table} b
         WHERE a.${spec.keyA} = b.${spec.keyA}
           AND a.${spec.keyB} = b.${spec.keyB}
           AND a.id < b.id`,
      );
      // 2. Enforce the constraint if it (or an equivalent index) is missing.
      const existing = await query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`,
        [spec.constraint, `public.${spec.table}`],
      );
      if (existing.rows.length === 0) {
        await query(
          `ALTER TABLE ${spec.table} ADD CONSTRAINT ${spec.constraint} UNIQUE (${spec.keyA}, ${spec.keyB})`,
        );
        console.log(`[migrations] ${spec.constraint} added`);
      }
    } catch (err: any) {
      // A pre-existing equivalent index under a different name, or a
      // concurrent deploy — never block startup on this repair.
      console.warn(`[migrations] participant dedupe skipped for ${spec.table}:`, err?.message);
    }
  }
}

/**
 * api_request_logs — encrypted at-rest audit trail of EVERY API call (user
 * app AND admin panel). Powers the admin Activity Logs screen: filter by
 * email/phone/name, inspect a single call, decrypt payload/response with
 * the decrypt_request_logs permission. Payloads are stored as AES-256-GCM
 * blobs when PAYLOAD_ENCRYPTION_KEY is set (encrypted=true).
 */
async function ensureRequestLogsSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS api_request_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_type VARCHAR(10) NOT NULL DEFAULT 'anon',
      user_id UUID NULL,
      business_id VARCHAR(255) NULL,
      method VARCHAR(10) NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      ip VARCHAR(80) NULL,
      user_agent TEXT NULL,
      request_payload TEXT NULL,
      response_payload TEXT NULL,
      encrypted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_request_logs_created ON api_request_logs (created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_request_logs_user ON api_request_logs (user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_request_logs_type ON api_request_logs (user_type)`);
}


/**
 * Login lockout escalation columns: failed attempts already live on users
 * (failed_login_attempts / locked_until). This adds the ESCALATION state —
 * lock_count (completed 30-minute lock cycles) and account_blocked (permanent
 * until platform support resolves it).
 */
async function ensureLoginSecurityColumns(): Promise<void> {
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lock_count INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_blocked BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ`);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_blocked ON users (account_blocked) WHERE account_blocked = TRUE`);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_locked ON users (locked_until) WHERE locked_until IS NOT NULL`);
}
