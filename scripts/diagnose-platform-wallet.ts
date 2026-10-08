/**
 * Forensic diagnostic: platform (operational) wallet ledger vs balance.
 *
 * READ-ONLY — prints breakdowns and a verdict, writes NOTHING.
 *
 * Run on the server:   npx tsx scripts/diagnose-platform-wallet.ts
 *
 * Answers:
 *  1. What does the drift check compute (platform-typed sum) vs the balance?
 *  2. Which deterministic damage classes exist (mis-typed funding debits,
 *     backfill duplicate twins, legacy revenue-mirror rows)?
 *  3. Does the reconciliation in server/migrations.ts (reconcilePlatformLedger,
 *     runs at boot) fully explain / clear the drift, or is there a residual?
 *
 * Interpretation:
 *  - "recorded (platform)" == wallets.balance        -> ledger healthy
 *  - mis-typed + duplicate sums ~= drift             -> boot reconciliation will clear it
 *  - anything else shows up in "residual by description" -> paste that section back
 */
import dotenv from "dotenv";
dotenv.config();

const { pool } = await import("../server/db");

const money = (n: number) => n.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const internal = await pool.query(
    `SELECT id, currency, balance FROM wallets WHERE business_id IS NULL AND user_id IS NULL ORDER BY currency`,
  );
  console.log(`\n=== Internal (platform operational) wallets: ${internal.rows.length} ===`);

  for (const w of internal.rows) {
    const balance = Number(w.balance) || 0;

    const byType = await pool.query(
      `SELECT transaction_type, type,
              COUNT(*)::int AS n,
              COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS signed
       FROM transactions
       WHERE wallet_id = $1 AND status = 'success'
       GROUP BY transaction_type, type
       ORDER BY transaction_type, type`,
      [w.id],
    );

    const sumOf = (t: string) =>
      byType.rows.filter(r => r.transaction_type === t).reduce((a, r) => a + Number(r.signed), 0);
    const sAll = byType.rows.reduce((a, r) => a + Number(r.signed), 0);
    const sPlatform = sumOf("platform");

    const drift = Math.round((balance - sPlatform) * 100) / 100;
    const driftAll = Math.round((balance - sAll) * 100) / 100;

    console.log(`\n--- wallet ${w.id} (${w.currency}) ---`);
    console.log(`balance column                     : ${money(balance)}`);
    console.log(`recorded (platform-typed only)     : ${money(sPlatform)}   <- what the drift check compares`);
    console.log(`recorded (ALL transaction types)   : ${money(sAll)}`);
    console.log(`DRIFT (balance - platform sum)     : ${money(drift)}`);
    console.log(`DRIFT vs all-types sum             : ${money(driftAll)}`);

    console.log(`\nby (transaction_type, type):`);
    for (const r of byType.rows) {
      console.log(`  ${String(r.transaction_type).padEnd(18)} ${String(r.type).padEnd(8)} n=${String(r.n).padStart(5)}  signed=${money(Number(r.signed))}`);
    }

    // --- damage class 1: mis-typed funding debits (should be 'platform') ---
    const mistyped = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE wallet_id = $1 AND status = 'success'
         AND transaction_type = 'wallet_funding' AND type = 'debit' AND direction = 'debit'`,
      [w.id],
    );
    console.log(`\nmis-typed funding debits (wallet_funding on internal wallet): n=${mistyped.rows[0].n} sum=${money(Number(mistyped.rows[0].total))}`);

    // --- damage class 2: backfill duplicate twins ---
    const dups = await pool.query(
      `WITH ranked AS (
         SELECT id, reference, description, amount, type, created_at,
                regexp_replace(reference, '(-PLATFORM|-USER-BACKFILL)$', '') AS base_ref,
                ROW_NUMBER() OVER (
                  PARTITION BY wallet_id, regexp_replace(reference, '(-PLATFORM|-USER-BACKFILL)$', '')
                  ORDER BY (description LIKE '%(backfill)%') ASC, created_at ASC, id ASC
                ) AS rn,
                COUNT(*) OVER (PARTITION BY wallet_id, regexp_replace(reference, '(-PLATFORM|-USER-BACKFILL)$', '')) AS grp
         FROM transactions
         WHERE transaction_type = 'platform' AND wallet_id = $1 AND status = 'success'
       )
       SELECT base_ref, grp, reference, description, amount, type, created_at
       FROM ranked WHERE grp > 1 ORDER BY base_ref, rn LIMIT 40`,
      [w.id],
    );
    const dupCount = await pool.query(
      `SELECT COUNT(*)::int - COUNT(DISTINCT regexp_replace(reference, '(-PLATFORM|-USER-BACKFILL)$', '')) AS extra
       FROM transactions
       WHERE transaction_type = 'platform' AND wallet_id = $1 AND status = 'success'`,
      [w.id],
    );
    console.log(`duplicate backfill rows (extra beyond one per event)     : ${dupCount.rows[0].extra}`);
    if (dups.rows.length > 0) {
      console.log(`sample duplicates (keep non-backfill, delete the rest):`);
      for (const r of dups.rows.slice(0, 12)) {
        console.log(`  [${r.base_ref}] ${r.reference}  ${r.type} ${money(Number(r.amount))}  ${String(r.description).substring(0, 60)}  ${r.created_at?.toISOString?.() || r.created_at}`);
      }
    }

    // --- damage class 3: legacy revenue-mirror debits on the pool ledger ---
    const mirror = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE wallet_id = $1 AND status = 'success'
         AND transaction_type = 'platform' AND type = 'debit'
         AND (description ILIKE '%revenue%' OR description ILIKE '%fee%')`,
      [w.id],
    );
    console.log(`legacy revenue/fee-mirror debits on pool ledger          : n=${mirror.rows[0].n} sum=${money(Number(mirror.rows[0].total))}`);

    // --- residual: platform rows that are none of the known classes ---
    const residual = await pool.query(
      `SELECT description, type, COUNT(*)::int AS n, SUM(amount) AS total
       FROM transactions
       WHERE wallet_id = $1 AND status = 'success' AND transaction_type = 'platform'
       GROUP BY description, type
       ORDER BY ABS(SUM(amount)) DESC
       LIMIT 25`,
      [w.id],
    );
    console.log(`\nplatform ledger by description (top 25):`);
    for (const r of residual.rows) {
      console.log(`  ${String(r.type).padEnd(8)} n=${String(r.n).padStart(5)}  total=${money(Number(r.total)).padStart(14)}  ${String(r.description).substring(0, 70)}`);
    }

    // --- verdict ---
    console.log(`\nVERDICT for ${w.currency}:`);
    if (Math.abs(drift) < 0.01) {
      console.log(`  Ledger healthy — no drift. Nothing to do.`);
    } else {
      const explained =
        Number(mistyped.rows[0].n) === 0 &&
        Number(dupCount.rows[0].extra) === 0 &&
        Math.abs(Number(mirror.rows[0].total)) < Math.abs(drift) * 0.999 &&
        Math.abs(Number(mirror.rows[0].total)) > 0;
      console.log(`  drift=${money(drift)} | mis-typed=${Number(mistyped.rows[0].n)} row(s), duplicate=${dupCount.rows[0].extra} row(s), legacy-mirror=${money(Number(mirror.rows[0].total))}`);
      console.log(`  -> run the deployed boot once (reconcilePlatformLedger re-types + dedupes), then re-run this script.`);
      console.log(`  -> if drift persists after boot, paste the "platform ledger by description" section above back for analysis.`);
      void explained;
    }
  }

  console.log(`\n(read-only — nothing was written)\n`);
  await pool.end();
}

main().catch(err => {
  console.error("diagnostic failed:", err?.message || err);
  process.exit(1);
});
