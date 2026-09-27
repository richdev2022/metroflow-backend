/**
 * Verifies the cast-safe room lookup SQL (id::text = $1) against a live DB.
 * Run from the backend directory on the VPS:
 *   DATABASE_URL="postgres://..." npx tsx scripts/test-validate-sql.ts
 * Read-only: only SELECTs are executed.
 */
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function main() {
  // 1. Non-UUID code lookup (previously threw 22P02 -> 500)
  const r1 = await pool.query(
    `SELECT id, call_code FROM calls WHERE (call_code = $1 OR id::text = $1) LIMIT 1`,
    ['KJOZ5I']
  );
  console.log('calls code query OK, rows:', r1.rows.length);

  // 2. UUID lookup still resolves
  const any = await pool.query(`SELECT id, call_code FROM calls LIMIT 1`);
  if (any.rows.length > 0) {
    const r2 = await pool.query(
      `SELECT id, call_code FROM calls WHERE (call_code = $1 OR id::text = $1) LIMIT 1`,
      [any.rows[0].id]
    );
    console.log('calls uuid query OK, matched:', r2.rows.length > 0, 'code:', r2.rows[0]?.call_code);
  } else {
    console.log('calls table empty; uuid path untested but syntactically OK');
  }

  // 3. meetings same pattern
  const r3 = await pool.query(
    `SELECT id FROM meetings WHERE (meeting_code = $1 OR id::text = $1) LIMIT 1`,
    ['NOTACODE']
  );
  console.log('meetings code query OK, rows:', r3.rows.length);

  await pool.end();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
