/**
 * Read-only validation of the inflow-limit SQL against the production DB:
 *  - getBusinessInflowUsage query shape runs clean
 *  - category lookup works for a real business
 *  - no schema surprises (transactions.direction/transaction_type/currency)
 */
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function main() {
  // 1. inflow usage aggregate over ALL businesses (sanity of columns)
  const inflow = await pool.query(`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)::float8 AS used_today,
      COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::float8 AS used_month,
      COUNT(*) AS rows
    FROM transactions
    WHERE direction = 'credit'
      AND status = 'success'
      AND transaction_type = 'wallet_funding'
      AND currency = 'NGN'`);
  console.log("inflow aggregate OK:", JSON.stringify(inflow.rows[0]));

  // 2. business category lookup
  const biz = await pool.query(
    `SELECT id, name, COALESCE(registration_category, 'non_registered') AS category
       FROM businesses WHERE registration_category IS NOT NULL LIMIT 2`);
  console.log("registered categories present:", biz.rows.length, biz.rows.map((r: any) => r.category));

  // 3. transaction_limits table rows
  const limits = await pool.query(`SELECT category, currency, single_transaction_limit, daily_limit, monthly_limit FROM transaction_limits ORDER BY category`);
  console.log("transaction_limits rows:", JSON.stringify(limits.rows));

  // 4. recent failed funding rows (should be none yet — the feature is new)
  const rejected = await pool.query(`SELECT COUNT(*) FROM transactions WHERE status='failed' AND transaction_type='wallet_funding'`);
  console.log("existing rejected funding rows:", rejected.rows[0].count);

  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("VALIDATION FAIL:", e.message);
  process.exit(1);
});
