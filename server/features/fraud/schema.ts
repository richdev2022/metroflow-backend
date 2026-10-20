import { query } from "../../db";

/**
 * FRAUD & COMPLIANCE — idempotent DDL + seeded rule catalogue.
 *
 * Tables:
 *   fraud_rules         admin-tunable rule definitions (action/thresholds/weights)
 *   fraud_evaluations   audit trail — one row per evaluation, even for 'allow'
 *   fraud_cases         human worklist raised for flag/hold/reject-review decisions
 *   fraud_blacklists    block lists (user | business | device | ip | bank_account | phone)
 *   due_diligence_cases auto-raised for holds; user submits evidence; compliance decides
 *   due_diligence_documents evidence files attached to a DD case
 *
 * Money movement is NEVER tracked here — held flows are marked on their own
 * rows (transfer_queue.status='held' / transactions.status='held'). This
 * module only decides and records.
 */
export async function ensureFraudSchema(): Promise<void> {
  // ---------- Rules catalogue ----------
  await query(`
    CREATE TABLE IF NOT EXISTS fraud_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code VARCHAR(80) UNIQUE NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      direction VARCHAR(10) NOT NULL DEFAULT 'outflow',  -- inflow | outflow | both
      category VARCHAR(40) NOT NULL,                     -- velocity|amount|device|geo|blacklist|mule|account|beneficiary|schedule|structuring
      is_enabled BOOLEAN DEFAULT TRUE,
      action VARCHAR(10) NOT NULL DEFAULT 'flag',        -- allow|flag|hold|reject
      threshold JSONB,
      weight INTEGER DEFAULT 10,
      priority INTEGER DEFAULT 100,                      -- lower = evaluated first
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_fraud_rules_direction ON fraud_rules(direction, is_enabled)`);

  // ---------- Evaluations (audit trail) ----------
  await query(`
    CREATE TABLE IF NOT EXISTS fraud_evaluations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_id UUID,
      transfer_reference VARCHAR(255),
      direction VARCHAR(10) NOT NULL,
      flow VARCHAR(40) NOT NULL,                         -- transfer|bill|giftcard|funding|withdrawal|esim
      user_id UUID,
      business_id VARCHAR(255),
      wallet_id UUID,
      amount DECIMAL(15,2),
      currency VARCHAR(3) DEFAULT 'NGN',
      context JSONB,
      score INTEGER DEFAULT 0,
      decision VARCHAR(10) NOT NULL,                     -- allow|flag|hold|reject|system_error
      matched_rules JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_fraud_eval_tx ON fraud_evaluations(transaction_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_fraud_eval_ref ON fraud_evaluations(transfer_reference)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_fraud_eval_decision ON fraud_evaluations(decision, created_at)`);

  // ---------- Cases (human worklist) ----------
  await query(`
    CREATE TABLE IF NOT EXISTS fraud_cases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id UUID,
      transaction_id UUID,
      transfer_reference VARCHAR(255),
      direction VARCHAR(10),
      flow VARCHAR(40),
      user_id UUID,
      business_id VARCHAR(255),
      amount DECIMAL(15,2),
      currency VARCHAR(3) DEFAULT 'NGN',
      status VARCHAR(20) DEFAULT 'open',                 -- open|released|rejected|escalated|expired|closed
      decision_notes TEXT,
      assigned_admin UUID,
      decided_by UUID,
      decided_at TIMESTAMP,
      due_diligence_id UUID,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_fraud_cases_status ON fraud_cases(status, created_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_fraud_cases_ref ON fraud_cases(transfer_reference)`);

  // ---------- Blacklists ----------
  await query(`
    CREATE TABLE IF NOT EXISTS fraud_blacklists (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type VARCHAR(20) NOT NULL,
      value VARCHAR(255) NOT NULL,
      reason TEXT,
      created_by UUID,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (type, value)
    )
  `);

  // ---------- Due diligence ----------
  await query(`
    CREATE TABLE IF NOT EXISTS due_diligence_cases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      fraud_case_id UUID,
      user_id UUID NOT NULL,
      business_id VARCHAR(255),
      status VARCHAR(20) DEFAULT 'pending',              -- pending|submitted|under_review|approved|rejected|expired
      form_schema VARCHAR(20) DEFAULT 'v1',
      submission JSONB,
      reviewed_by UUID,
      reviewed_at TIMESTAMP,
      review_notes TEXT,
      reminder_sent_at TIMESTAMP,
      auto_opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_dd_cases_user ON due_diligence_cases(user_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dd_cases_status ON due_diligence_cases(status, expires_at)`);

  await query(`
    CREATE TABLE IF NOT EXISTS due_diligence_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      case_id UUID NOT NULL,
      field_key VARCHAR(80) NOT NULL,
      file_url TEXT NOT NULL,
      file_name VARCHAR(255),
      mime_type VARCHAR(120),
      size_bytes BIGINT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_dd_docs_case ON due_diligence_documents(case_id)`);

  // Held-funding release needs to find held transactions quickly.
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_status_held ON transactions(status) WHERE status = 'held'`);
  await query(`CREATE INDEX IF NOT EXISTS idx_transfer_queue_status_held ON transfer_queue(status) WHERE status = 'held'`);

  // Device / IP familiarity history (self-maintained by the engine on every
  // evaluation) — powers OUT_DEVICE_CHANGE_LARGE.
  await query(`
    CREATE TABLE IF NOT EXISTS fraud_seen_contexts (
      user_id UUID NOT NULL,
      kind VARCHAR(10) NOT NULL,                 -- device | ip
      value VARCHAR(255) NOT NULL,
      first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, kind, value)
    )
  `);

  // ---------- Admin permissions (fraud + compliance) ----------
  await query(`
    INSERT INTO admin_permissions (slug, name, description)
    VALUES
      ('manage_fraud', 'Fraud Management', 'Configure fraud rules, manage blacklists and decide flagged / held transaction cases'),
      ('manage_compliance', 'Compliance / Due Diligence', 'Review and decide customer due-diligence submissions')
    ON CONFLICT (slug) DO NOTHING
  `);

  // ---------- Seed default rules ----------
  await seedDefaultRules();
}

const DEFAULT_RULES: Array<{
  code: string; name: string; description: string; direction: string; category: string;
  action: string; threshold: any; weight: number; priority: number;
}> = [
  // ── Hard limits / blacklists first (priority lowest = first) ──
  { code: 'OUT_BLACKLIST', name: 'Blacklisted beneficiary / device / IP',
    description: 'The beneficiary bank account, device, IP or user appears on a fraud blacklist.',
    direction: 'outflow', category: 'blacklist', action: 'reject',
    threshold: {}, weight: 100, priority: 1 },
  { code: 'OUT_AMT_LIMIT_HARD', name: 'Single outflow hard ceiling',
    description: 'A single outflow above this amount is auto-rejected before any money moves.',
    direction: 'outflow', category: 'amount', action: 'reject',
    threshold: { amount: 5000000 }, weight: 90, priority: 2 },
  { code: 'IN_BLACKLIST_FUNDING', name: 'Blacklisted funding source',
    description: 'Funding from a blacklisted sender account / device / IP is frozen for review.',
    direction: 'inflow', category: 'blacklist', action: 'hold',
    threshold: {}, weight: 100, priority: 1 },
  { code: 'OUT_STRUCTURING', name: 'Structuring / smurfing pattern',
    description: 'Three or more outflows within 24h each between 90-100% of the review ceiling.',
    direction: 'outflow', category: 'structuring',
    action: 'reject', threshold: { count: 3, near_limit_ratio: 0.9 }, weight: 80, priority: 3 },

  // ── Velocity ──
  { code: 'OUT_VELOCITY_COUNT_1H', name: 'Outflow count velocity (1h)',
    description: 'More than N debits in the last hour.', direction: 'outflow', category: 'velocity',
    action: 'flag', threshold: { count: 10 }, weight: 15, priority: 10 },
  { code: 'OUT_VELOCITY_COUNT_24H', name: 'Outflow count velocity (24h)',
    description: 'More than N debits in 24 hours.', direction: 'outflow', category: 'velocity',
    action: 'flag', threshold: { count: 25 }, weight: 15, priority: 11 },
  { code: 'OUT_VELOCITY_SUM_24H', name: 'Outflow sum velocity (24h)',
    description: '24-hour outflow total above X.', direction: 'outflow', category: 'velocity',
    action: 'hold', threshold: { amount: 10000000 }, weight: 40, priority: 12 },
  { code: 'IN_VELOCITY_COUNT_24H', name: 'Funding count velocity (24h)',
    description: 'More than N funding transactions in 24 hours.', direction: 'inflow', category: 'velocity',
    action: 'flag', threshold: { count: 30 }, weight: 15, priority: 10 },

  // ── Beneficiary risk ──
  { code: 'OUT_NEW_BENEFICIARY_LARGE', name: 'First payment to beneficiary (large)',
    description: 'First transfer to this beneficiary above X.', direction: 'outflow', category: 'beneficiary',
    action: 'flag', threshold: { amount: 500000 }, weight: 20, priority: 20 },
  { code: 'OUT_NEW_BENEFICIARY_XLARGE', name: 'First payment to beneficiary (extra large)',
    description: 'First transfer to this beneficiary above XL — held for verification.',
    direction: 'outflow', category: 'beneficiary', action: 'hold',
    threshold: { amount: 2000000 }, weight: 45, priority: 21 },
  { code: 'OUT_BENEFICIARY_VELOCITY', name: 'Beneficiary collect velocity',
    description: 'Same new beneficiary receiving from N or more distinct senders in 24h.',
    direction: 'outflow', category: 'beneficiary', action: 'reject',
    threshold: { senders: 3 }, weight: 85, priority: 22 },

  // ── Device / geo ──
  { code: 'OUT_DEVICE_CHANGE_LARGE', name: 'Large outflow from new device/IP',
    description: 'Amount above X from a device or IP never seen on the account.',
    direction: 'outflow', category: 'device', action: 'hold',
    threshold: { amount: 1000000 }, weight: 45, priority: 30 },
  { code: 'OUT_IMPOSSIBLE_TRAVEL', name: 'Impossible travel',
    description: 'Last login geo and current request geo imply faster than flight.',
    direction: 'outflow', category: 'geo', action: 'hold',
    threshold: { max_kmh: 900 }, weight: 50, priority: 31 },

  // ── Mule patterns ──
  { code: 'OUT_MULE_IN_OUT', name: 'Rapid in-then-out (mule pattern)',
    description: 'Most of recently credited funds leaving within the window.',
    direction: 'outflow', category: 'mule', action: 'hold',
    threshold: { ratio: 0.7, window_hours: 6 }, weight: 55, priority: 40 },
  { code: 'IN_MULE_PATTER', name: 'Many-into-one funding pattern',
    description: 'N or more distinct senders funding the same wallet in 24h.',
    direction: 'inflow', category: 'mule', action: 'flag',
    threshold: { senders: 5 }, weight: 25, priority: 40 },
  { code: 'IN_RAPID_PUMP', name: 'Rapid multi-channel pump',
    description: 'Wallet funded above X within one hour across 3+ channels.',
    direction: 'inflow', category: 'mule', action: 'hold',
    threshold: { amount: 5000000, channels: 3 }, weight: 50, priority: 41 },

  // ── Account profile ──
  { code: 'OUT_ACCOUNT_AGE', name: 'Young account, high volume',
    description: 'Account under 24h old with 24h outflow sum above X.',
    direction: 'outflow', category: 'account', action: 'hold',
    threshold: { amount: 200000, age_hours: 24 }, weight: 50, priority: 50 },
  { code: 'IN_REVERSAL_ABUSE', name: 'Repeated funding reversals',
    description: 'Two or more charged-back / reversed fundings in 90 days.',
    direction: 'inflow', category: 'account', action: 'hold',
    threshold: { count: 2 }, weight: 60, priority: 51 },
  { code: 'IN_DORMANT_JUMP', name: 'Dormant account sudden activity',
    description: 'Dormant 90+ day account suddenly funds above X.',
    direction: 'inflow', category: 'account', action: 'flag',
    threshold: { amount: 1000000, dormant_days: 90 }, weight: 25, priority: 52 },

  // ── Amount anomalies / schedule ──
  { code: 'IN_AMT_ANOMALY', name: 'Funding amount anomaly',
    description: 'Amount far above the user 90-day mean funding.',
    direction: 'inflow', category: 'amount', action: 'flag',
    threshold: { mean_multiplier: 20 }, weight: 20, priority: 60 },
  { code: 'OUT_NIGHT_OWL_LARGE', name: 'Large night-time outflow',
    description: 'Amount above X between 00:00-04:59 with no recent night activity.',
    direction: 'outflow', category: 'schedule', action: 'flag',
    threshold: { amount: 1000000 }, weight: 20, priority: 61 },
  { code: 'OUT_AMT_LIMIT_REVIEW', name: 'Single outflow review ceiling',
    description: 'A single outflow above this amount is flagged for review.',
    direction: 'outflow', category: 'amount', action: 'flag',
    threshold: { amount: 2000000 }, weight: 20, priority: 70 },
];

async function seedDefaultRules(): Promise<void> {
  for (const r of DEFAULT_RULES) {
    await query(
      `INSERT INTO fraud_rules (code, name, description, direction, category, action, threshold, weight, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       ON CONFLICT (code) DO NOTHING`,
      [r.code, r.name, r.description, r.direction, r.category, r.action,
       JSON.stringify(r.threshold), r.weight, r.priority],
    );
  }
}
