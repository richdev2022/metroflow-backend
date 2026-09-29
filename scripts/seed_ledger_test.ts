/**
 * Seed legacy-format ledger data + test admin, then verify the admin
 * revenue/history, wallet/history, virtual-accounts list and clear endpoints
 * behave correctly against a mixed-generation ledger.
 *
 * Run against a throwaway DB only.
 *   DATABASE_URL=... npx tsx scripts/seed_ledger_test.ts
 */
import bcrypt from "bcryptjs";
import { query, pool } from "../server/db";

async function main() {
  // 1. Super admin role + admin (requirePermission resolves via admin_roles.is_super_admin)
  const hash = await bcrypt.hash("TestAdmin!123", 10);
  await query(
    `INSERT INTO admin_roles (name, description, is_super_admin)
     SELECT 'Ledger Test Super Admin', 'test role', TRUE
     WHERE NOT EXISTS (SELECT 1 FROM admin_roles WHERE name = 'Ledger Test Super Admin')`,
  );
  const roleRes = await query(`SELECT id FROM admin_roles WHERE name = 'Ledger Test Super Admin'`);
  const roleId = roleRes.rows[0].id;
  await query(
    `INSERT INTO platform_admins (name, email, password_hash, status, role_id)
     SELECT 'Test Super Admin', 'ledger-admin@test.local', $1, 'active', $2::uuid
     WHERE NOT EXISTS (SELECT 1 FROM platform_admins WHERE email = 'ledger-admin@test.local')`,
    [hash, roleId],
  );
  await query(
    `UPDATE platform_admins SET password_hash = $1, status = 'active', role_id = $2::uuid
     WHERE email = 'ledger-admin@test.local'`,
    [hash, roleId],
  );

  // 2. Platform (internal) wallet
  const pw = await query(
    `INSERT INTO wallets (balance, currency, status)
     SELECT 0, 'NGN', 'active'
     WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE business_id IS NULL AND user_id IS NULL)
     RETURNING id`,
  );
  const platformWalletId =
    pw.rows[0]?.id ||
    (await query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL LIMIT 1`)).rows[0].id;

  // 3. A customer user + wallet (users.business_id is NOT NULL)
  const biz = await query(
    `INSERT INTO businesses (id, name, email)
     SELECT 'ledger-test-biz', 'Ledger Test Biz', 'ledger-biz@test.local'
     WHERE NOT EXISTS (SELECT 1 FROM businesses WHERE email = 'ledger-biz@test.local')`,
  );
  const bizId =
    biz.rows[0]?.id ||
    (await query(`SELECT id FROM businesses WHERE email = 'ledger-biz@test.local'`)).rows[0].id;
  await query(
    `INSERT INTO users (business_id, name, email, password_hash, status)
     SELECT $2::varchar, 'Ledger Test User', 'ledger-user@test.local', $1, 'active'
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'ledger-user@test.local')`,
    [hash, bizId],
  );
  const user = await query(`SELECT id FROM users WHERE email = 'ledger-user@test.local'`);
  const userId = user.rows[0].id;
  const uw = await query(
    `INSERT INTO wallets (user_id, balance, currency, status)
     SELECT $1, 0, 'NGN', 'active'
     WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE user_id = $1)
     RETURNING id`,
    [userId],
  );
  const userWalletId =
    uw.rows[0]?.id ||
    (await query(`SELECT id FROM wallets WHERE user_id = $1 LIMIT 1`, [userId])).rows[0].id;

  // 4. Legacy-generation ledger rows (pre-refactor writer)
  //    a. 'revenue' row on the platform wallet with FLW reference (exactly the
  //       production sample the user reported)
  await query(
    `INSERT INTO transactions
       (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, payment_provider)
     SELECT 50.00, 'NGN', 'success', 'FLW-VA-2097975288-REVENUE', 'debit',
            'Platform Wallet Debit for Revenue', 'revenue', $1, 'debit', 'squad'
     WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE reference = 'FLW-VA-2097975288-REVENUE')`,
    [platformWalletId],
  );
  //    b. legacy user-side main funding row (Flutterwave, user wallet)
  await query(
    `INSERT INTO transactions
       (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider)
     SELECT NULL, $1, 10000.00, 'NGN', 'success', 'FLW-VA-2097975288', 'credit',
            'Wallet Funding via Flutterwave Virtual Account', 'wallet_funding', $2, 'credit', 50.00, 'flutterwave'
     WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE reference = 'FLW-VA-2097975288')`,
    [userId, userWalletId],
  );

  // 5. Legacy mislabelled row (FLW reference carrying the old squad default)
  await query(
    `INSERT INTO transactions
       (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, payment_provider)
     SELECT 25.00, 'NGN', 'success', 'FLW-TX-777-USER', 'debit',
            'Platform Wallet Debit for User Funding', 'platform', $1, 'debit', 'squad'
     WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE reference = 'FLW-TX-777-USER')`,
    [platformWalletId],
  );

  // 6. Virtual accounts (one squad + one flutterwave)
  for (const provider of ['squad', 'flutterwave']) {
    await query(
      `INSERT INTO virtual_accounts (wallet_id, payment_provider, virtual_account_number, bank_code, account_name, customer_identifier, is_active)
       SELECT $1::uuid, $2::varchar, $3::varchar, $4::varchar, 'Ledger Test User', $5::varchar, TRUE
       WHERE NOT EXISTS (SELECT 1 FROM virtual_accounts WHERE wallet_id = $1::uuid AND payment_provider = $2::varchar)`,
      [userWalletId, provider, provider === 'squad' ? '1002345678' : '9012345678', provider === 'squad' ? '090' : '999', `cust-${provider}`],
    );
  }

  console.log('SEED OK', { platformWalletId, userWalletId });
  await pool.end();
}

main().catch(async (e) => {
  console.error('SEED FAILED:', e);
  await pool.end();
  process.exit(1);
});
