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
  await backfillLedgerHistory();
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

    // ---- 3. Reconcile internal platform wallet balances ----
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
