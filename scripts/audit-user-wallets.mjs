// User-wallet reconciliation audit + repair (the "Samuel ₦190" class of bugs).
//
// WHAT IT DOES
//   For every user (and business) wallet, compares wallets.balance against the
//   ledger sum of its `transactions` rows (credits − debits, counting only
//   status='success' rows — 'failed' rows were reversed, 'held' rows are not
//   yet credited).
//
//   Drift sources this catches:
//     1. Lost VA-funding credits: the old Squad/Monnify webhook path wrote
//        `SET balance = <precomputed>` (non-atomic). Concurrent writes lost
//        increments while BOTH ledger rows inserted (a ₦240 deposit − ₦50 fee
//        = ₦190 credit in the ledger that never reached the balance).
//     2. Transfers debited with NO user debit row (the historical
//        `<ref>-PLATFORM` reference-collision bug in services/transfer.ts) —
//        detected separately via transfer_queue reconstruction below.
//     3. Fees recorded only in the `fee` column (transfers already write a
//        separate -FEE row; bills/esim/giftcards/vcards/swap keep the fee in
//        the principal row — both reconcile correctly here because we sum the
//        principal `amount` which already includes the fee).
//
// REPAIR MODE (--repair):
//   - Step 1: reconstruct missing transfer debit rows (transfer_queue rows
//     whose platform hold exists but the user debit row was swallowed), then
//     recompute.
//   - Step 2: any remaining drift is written as ONE documented adjustment
//     ledger row (direction = sign of drift, transaction_type
//     'ledger_adjustment', reference LEDGER-TRUEUP-<wallet8>-<yyyymmdd>) and
//     the wallet balance is SET to the true ledger sum inside the same
//     transaction (row locked FOR UPDATE).
//
// Usage:
//   DATABASE_URL='postgresql://...' node scripts/audit-user-wallets.mjs
//   DATABASE_URL='postgresql://...' node scripts/audit-user-wallets.mjs --user <uuid>   # single user
//   DATABASE_URL='postgresql://...' node scripts/audit-user-wallets.mjs --repair        # write
//   DATABASE_URL='postgresql://...' node scripts/audit-user-wallets.mjs --repair --user <uuid>
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Client } = require("pg");

const APPLY = process.argv.includes("--repair");
const userIdx = process.argv.indexOf("--user");
const ONLY_USER = userIdx > -1 ? process.argv[userIdx + 1] : null;
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(1); }

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const n2 = (x) => Math.round((parseFloat(x) || 0) * 100) / 100;

// ---------------------------------------------------------------- step 1
// Reconstruct swallowed transfer debit rows (platform hold exists, user
// debit row missing). Insert the missing rows so the ledger tells the truth,
// then the drift computation in step 2 becomes exact.
let reconstructed = 0;
if (APPLY) {
  const q = `
    SELECT tq.id, tq.reference, tq.user_id, tq.business_id, tq.wallet_id,
           tq.amount, tq.fee, tq.currency, tq.status, tq.created_at
    FROM transfer_queue tq
    WHERE EXISTS (SELECT 1 FROM transactions ht
                  WHERE ht.reference = tq.reference || '-PLATFORM')
      AND tq.status = 'success'
      AND NOT EXISTS (SELECT 1 FROM transactions dt
                      WHERE dt.wallet_id = tq.wallet_id
                        AND dt.reference = tq.reference
                        AND dt.direction = 'debit')`;
  const missing = await client.query(q);
  for (const t of missing.rows) {
    const amt = n2(t.amount);
    const fee = n2(t.fee || 0);
    const total = n2(amt + fee);
    try {
      await client.query("BEGIN");
      if (fee > 0) {
        await client.query(
          `INSERT INTO transactions (user_id, business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, created_at, updated_at)
           VALUES ($1,$2,$3,'NGN','success',$4,'debit','Transfer (fee row reconstructed by ledger audit)','fee',$5,'debit',$6,$7, NOW())
           ON CONFLICT (reference) DO NOTHING`,
          [t.user_id, t.business_id, fee, `${t.reference}-FEE`, t.wallet_id, fee, t.created_at],
        );
      }
      await client.query(
        `INSERT INTO transactions (user_id, business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'success',$5,'debit','Transfer (debit row reconstructed by ledger audit)','transfer',$6,'debit',$7,$8, NOW())
         ON CONFLICT (reference) DO NOTHING`,
        [t.user_id, t.business_id, total, t.currency || "NGN", t.reference, t.wallet_id, fee, t.created_at],
      );
      await client.query("COMMIT");
      reconstructed += 1;
      console.log(`  reconstructed missing debit row for transfer ${t.reference} (₦${total})`);
    } catch (e) {
      await client.query("ROLLBACK");
      console.warn(`  ! failed to reconstruct ${t.reference}: ${e.message}`);
    }
  }
  console.log(`Step 1 (reconstruct missing transfer debits): ${reconstructed} row(s)${APPLY ? "" : " [dry-run: not written]"}`);
} else {
  const q = `
    SELECT count(*)::int AS n
    FROM transfer_queue tq
    WHERE EXISTS (SELECT 1 FROM transactions ht WHERE ht.reference = tq.reference || '-PLATFORM')
      AND tq.status = 'success'
      AND NOT EXISTS (SELECT 1 FROM transactions dt
                      WHERE dt.wallet_id = tq.wallet_id AND dt.reference = tq.reference AND dt.direction = 'debit')`;
  const r = await client.query(q);
  console.log(`Step 1 (reconstruct missing transfer debits): ${r.rows[0].n} row(s) need reconstruction [dry-run: not written]`);
}

// ---------------------------------------------------------------- step 2
// Ledger-sum vs balance drift for every wallet.
const params = [];
let where = "";
if (ONLY_USER) { params.push(ONLY_USER); where = "WHERE w.user_id = $1"; }

const wallets = await client.query(
  `SELECT w.id, w.user_id, w.business_id, w.currency, w.balance, w.wallet_type
   FROM wallets w ${where} ORDER BY w.created_at`,
  params,
);

const drifted = [];
for (const w of wallets.rows) {
  const sum = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END), 0) AS ledger_sum,
       COUNT(*)::int AS rows
     FROM transactions
     WHERE wallet_id = $1 AND status = 'success'`,
    [w.id],
  );
  const ledgerSum = n2(sum.rows[0].ledger_sum);
  const balance = n2(w.balance);
  const drift = n2(balance - ledgerSum);
  if (drift !== 0) {
    drifted.push({ ...w, ledgerSum, balance, drift, rows: sum.rows[0].rows });
  }
}

console.log(`\nScanned ${wallets.rows.length} wallet(s); ${drifted.length} drifted.`);

if (drifted.length === 0) {
  console.log("All wallet balances reconcile with their ledgers. ✔");
  await client.end();
  process.exit(0);
}

for (const d of drifted) {
  const owner = d.user_id || d.business_id || "?";
  console.log(
    `  wallet ${d.id} (${d.wallet_type || d.currency}) owner ${owner}\n` +
    `    balance=${d.balance}  ledger_sum=${d.ledgerSum}  drift=${d.drift > 0 ? "+" : ""}${d.drift}`,
  );
}

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --repair to write adjustment rows and true-up balances.");
  await client.end();
  process.exit(0);
}

// ---------------------------------------------------------------- repair
const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
let repaired = 0;
for (const d of drifted) {
  const ref = `LEDGER-TRUEUP-${d.id.slice(0, 8)}-${today}`;
  const dup = await client.query(`SELECT 1 FROM transactions WHERE reference = $1`, [ref]);
  if (dup.rows.length > 0) { console.log(`  skip ${d.id} (already repaired today: ${ref})`); continue; }

  const target = d.ledgerSum; // the ledger is the truth
  const delta = n2(target - d.balance); // signed adjustment to apply to balance

  try {
    await client.query("BEGIN");
    const lock = await client.query(`SELECT balance FROM wallets WHERE id = $1 FOR UPDATE`, [d.id]);
    if (lock.rows.length === 0) { await client.query("ROLLBACK"); continue; }

    if (delta > 0) {
      await client.query(
        `INSERT INTO transactions (user_id, business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
         VALUES ($1,$2,$3,$4,'success',$5,'credit','Balance true-up: credits lost by historical webhook race (audit repair)','ledger_adjustment',$6,'credit')`,
        [d.user_id, d.business_id, delta, d.currency || "NGN", ref, d.id],
      );
    } else {
      await client.query(
        `INSERT INTO transactions (user_id, business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
         VALUES ($1,$2,$3,$4,'success',$5,'debit','Balance true-up: debits missing from ledger (audit repair)','ledger_adjustment',$6,'debit')`,
        [d.user_id, d.business_id, Math.abs(delta), d.currency || "NGN", ref, d.id],
      );
    }

    await client.query(`UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`, [target, d.id]);

    // invariant: ledger sum must now equal balance
    const chk = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0) AS s
       FROM transactions WHERE wallet_id = $1 AND status='success'`, [d.id]);
    if (n2(chk.rows[0].s) !== target) {
      await client.query("ROLLBACK");
      console.warn(`  ! invariant failed for ${d.id}; rolled back`);
      continue;
    }

    await client.query("COMMIT");
    repaired += 1;
    console.log(`  repaired ${d.id}: balance ${d.balance} -> ${target} (${ref})`);

    // backup trail for forensics
    try {
      fs.mkdirSync(path.join(process.cwd(), "backups"), { recursive: true });
      const hist = await client.query(`SELECT * FROM transactions WHERE wallet_id = $1 AND status='success' ORDER BY created_at`, [d.id]);
      fs.writeFileSync(path.join(process.cwd(), "backups", `wallet-${d.id}-${today}.json`), JSON.stringify(hist.rows, null, 2));
    } catch { /* non-fatal */ }
  } catch (e) {
    await client.query("ROLLBACK");
    console.warn(`  ! repair failed for ${d.id}: ${e.message}`);
  }
}

console.log(`\nRepaired ${repaired} wallet(s).`);
await client.end();
