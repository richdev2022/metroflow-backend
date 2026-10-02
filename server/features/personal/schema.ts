import { query } from "../../db";

/**
 * PERSONAL APP — schema for the dormant personal-only revenue features
 * (Bills Hub + Savings Vaults).
 *
 * These features belong to the upcoming Personal Metricorex app, NOT the
 * current business app. They are kept here fully intact so the personal app
 * can be switched on later without rewriting anything. Nothing in this file
 * runs on boot of the business backend.
 *
 * To activate when the personal app commences:
 *   1. Call ensurePersonalSchema() from runPostInitializeMigrations()
 *      (server/migrations.ts).
 *   2. Mount the routers in server/index.ts:
 *        import billsRouter from "./features/personal/bills";
 *        import savingsRouter from "./features/personal/savings";
 *        mainRouter.use("/bills", billsRouter);
 *        mainRouter.use("/savings", savingsRouter);
 *   3. Re-add the savings auto-save cron (every 5 minutes) that imports
 *      processDueAutoSaves from ./features/personal/savings.
 *   4. Surface the personal plan knobs (bills_enabled, max_bills_per_day,
 *      bill_fee_discount_percent, savings_enabled, max_savings_vaults,
 *      savings_break_fee_discount_percent) in the admin pricing UI.
 *
 * Note: the pricing_plans columns were already added to production databases
 * while these features briefly lived in the business app; they are harmless
 * there and will simply be used again by the personal app.
 */

export async function ensurePersonalSchema(): Promise<void> {
  // ---------- Bills Hub ----------
  await query(`
    CREATE TABLE IF NOT EXISTS bill_payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID,
      wallet_id UUID NOT NULL,
      reference VARCHAR(255) UNIQUE NOT NULL,
      category VARCHAR(30) NOT NULL, -- airtime | data | tv | electricity | betting
      provider_code VARCHAR(60) NOT NULL, -- e.g. mtn, dstv, ikedc
      provider_name VARCHAR(120),
      plan_code VARCHAR(60),         -- data/TV plan code when applicable
      plan_name VARCHAR(160),
      customer_ref VARCHAR(160) NOT NULL, -- phone | smartcard | meter | user id
      customer_phone VARCHAR(50),
      amount DECIMAL(12,2) NOT NULL,
      fee DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      status VARCHAR(20) DEFAULT 'pending', -- pending | success | failed | refunded
      fulfilment_mode VARCHAR(20),   -- provider | simulated
      provider_reference VARCHAR(120),
      provider_response JSONB,
      failure_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_bill_payments_business ON bill_payments(business_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bill_payments_user ON bill_payments(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bill_payments_status ON bill_payments(status)`);

  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS bills_enabled BOOLEAN DEFAULT TRUE`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_bills_per_day INTEGER DEFAULT 3`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS bill_fee_discount_percent DECIMAL(5,2) DEFAULT 0`);

  await query(`
    INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
    SELECT 'Bill Payment Convenience Fee', 'bill', 'flat',
           '{"amount": 50}'::jsonb, 'NGN'
    WHERE NOT EXISTS (SELECT 1 FROM fee_configurations WHERE fee_type = 'bill')
  `);

  // ---------- Savings Vaults ----------
  await query(`
    CREATE TABLE IF NOT EXISTS savings_vaults (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID,
      name VARCHAR(120) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      balance DECIMAL(15,2) NOT NULL DEFAULT 0,
      goal_amount DECIMAL(15,2),
      target_date DATE,
      status VARCHAR(20) DEFAULT 'active', -- active | paused | closed
      auto_save_enabled BOOLEAN DEFAULT FALSE,
      auto_save_amount DECIMAL(12,2),
      auto_save_frequency VARCHAR(20),     -- daily | weekly | monthly
      auto_save_wallet_id UUID,
      auto_save_next_run TIMESTAMP,
      auto_save_last_run TIMESTAMP,
      auto_save_failures INTEGER DEFAULT 0,
      withdrawn_at TIMESTAMP,
      total_deposited DECIMAL(15,2) NOT NULL DEFAULT 0,
      total_withdrawn DECIMAL(15,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_savings_vaults_business ON savings_vaults(business_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_savings_vaults_user ON savings_vaults(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_savings_vaults_autosave ON savings_vaults(auto_save_next_run) WHERE auto_save_enabled = TRUE AND status = 'active'`);

  await query(`
    CREATE TABLE IF NOT EXISTS savings_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vault_id UUID NOT NULL REFERENCES savings_vaults(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,   -- deposit | withdrawal | auto_save | break_fee
      amount DECIMAL(15,2) NOT NULL,
      fee DECIMAL(15,2) NOT NULL DEFAULT 0,
      balance_after DECIMAL(15,2) NOT NULL,
      wallet_id UUID,
      reference VARCHAR(255) UNIQUE,
      status VARCHAR(20) DEFAULT 'success',
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_savings_transactions_vault ON savings_transactions(vault_id)`);

  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS savings_enabled BOOLEAN DEFAULT TRUE`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_savings_vaults INTEGER DEFAULT 1`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS savings_break_fee_discount_percent DECIMAL(5,2) DEFAULT 0`);

  await query(`
    INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
    SELECT 'Savings Early Withdrawal Fee', 'savings_break', 'percentage_cap',
           '{"percentage": 2.0, "cap": 5000}'::jsonb, 'NGN'
    WHERE NOT EXISTS (SELECT 1 FROM fee_configurations WHERE fee_type = 'savings_break')
  `);

  console.log("[Migrations] Personal (Bills Hub + Savings Vaults) schema applied");
}
