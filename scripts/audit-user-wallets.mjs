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
//     recompute. The reconstructed MAIN row carries the PRINCIPAL and the
//     separate <ref>-FEE row carries the fee (mirroring services/transfer.ts).
//   - Step 2: the invariant restored is wallets.balance == Σ(success rows).
//     Two drift directions, two different repairs:
//       · balance < ledger_sum (the "Samuel ₦190" webhook race): the credit
//         rows already exist in the ledger but the old non-atomic balance
//         write lost the increment — the repair APPLIES the recorded
//         movement (SET balance = ledger_sum). No adjustment row: adding a
//         credit row would double-count a credit the ledger already has.
//       · balance > ledger_sum (movement with no ledger row): ONE documented
//         credit ledger_adjustment row (reference
//         LEDGER-TRUEUP-<wallet8>-<yyyymmdd>) is written so the ledger
//         explains the balance; the balance itself is unchanged.
//     Both paths re-verify the invariant inside the transaction before
//     committing, and dump the full ledger to backups/ for forensics.
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
      // The live transfer path debits amount+fee from the balance but writes
      // the MAIN row with the PRINCIPAL only (services/transfer.ts L1096: the
      // separate <ref>-FEE row carries the fee). Mirroring that shape here —
      // main row = principal, fee row = fee — keeps Σ rows == balance.
      // (The old code wrote the main row as amt+fee AND a fee row, which
      // double-counted the fee and made every reconstruction drift by +fee.)
      await client.query(
        `INSERT INTO transactions (user_id, business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'success',$5,'debit','Transfer (debit row reconstructed by ledger audit)','transfer',$6,'debit',$7,$8, NOW())
         ON CONFLICT (reference) DO NOTHING`,
        [t.user_id, t.business_id, amt, t.currency || "NGN", t.reference, t.wallet_id, fee, t.created_at],
      );
      await client.query("COMMIT");
      reconstructed += 1;
      console.log(`  reconstructed missing debit row for transfer ${t.reference} (₦${n2(amt + fee)} = principal ${amt} + fee ${fee})`);
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
// THE LEDGER IS THE TRUTH, and the invariant we restore is
//   wallets.balance == Σ(successful ledger rows for the wallet).
// Two drift directions, two DIFFERENT repairs (the old code applied the SAME
// insert-and-set to both, which double-counted one side and tripped its own
// invariant check — every --repair rolled back and repaired nothing):
//
//   balance < ledger_sum  (Samuel's case): the credit rows ALREADY exist in
//     the ledger (₦240 deposit − ₦50 fee) but the old non-atomic webhook
//     `SET balance = <precomputed>` lost the balance increment. Adding
//     ANOTHER credit row would double-count; the correct repair is to APPLY
//     the already-recorded movement: SET balance = ledger_sum. No new row —
//     the audit trail is the backup JSON + this log.
//
//   balance > ledger_sum: the balance moved without a ledger row explaining
//     it (step 1 already reconstructed every transfer_queue-backed debit).
//     Document the movement with ONE credit ledger_adjustment row of
//     (balance − ledger_sum); the balance itself is CORRECT and unchanged —
//     after the insert the ledger explains it exactly.
const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
let repaired = 0;
for (const d of drifted) {
  try {
    await client.query("BEGIN");
    const lock = await client.query(`SELECT balance FROM wallets WHERE id = $1 FOR UPDATE`, [d.id]);
    if (lock.rows.length === 0) { await client.query("ROLLBACK"); continue; }

    // Re-read under the row lock — the pre-scan numbers may be stale.
    const live = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END), 0) AS ledger_sum
       FROM transactions WHERE wallet_id = $1 AND status = 'success'`,
      [d.id],
    );
    const balance = n2(lock.rows[0].balance);
    const ledgerSum = n2(live.rows[0].ledger_sum);
    const drift = n2(balance - ledgerSum);
    if (drift === 0) {
      await client.query("COMMIT"); // fixed by a concurrent repair — nothing to do
      console.log(`  skip ${d.id} (no longer drifted under lock)`);
      continue;
    }

    if (drift < 0) {
      // balance < ledger_sum: recorded-but-unapplied credits (the webhook
      // race). Apply them — no adjustment row, the rows already exist.
      await client.query(`UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`, [ledgerSum, d.id]);
      console.log(`  repairing ${d.id}: balance ${balance} -> ${ledgerSum} (recorded-but-unapplied credits applied; ledger rows already present, no adjustment row written)`);
    } else {
      // balance > ledger_sum: unrecorded inflow. One documented credit row.
      const delta = drift;
      const ref = `LEDGER-TRUEUP-${d.id.slice(0, 8)}-${today}`;
      const dup = await client.query(`SELECT 1 FROM transactions WHERE reference = $1`, [ref]);
      if (dup.rows.length > 0) {
        await client.query("ROLLBACK");
        console.log(`  skip ${d.id} (already repaired today: ${ref})`);
        continue;
      }
      await client.query(
        `INSERT INTO transactions (user_id, business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
         VALUES ($1,$2,$3,$4,'success',$5,'credit','Balance true-up: balance movement with no ledger row, documented by ledger audit (audit repair)','ledger_adjustment',$6,'credit')`,
        [d.user_id, d.business_id, delta, d.currency || "NGN", ref, d.id],
      );
      // Balance is already correct — the ledger now explains it.
      console.log(`  repairing ${d.id}: documented unrecorded inflow of +${delta} (balance ${balance} unchanged, ledger now sums to it; ${ref})`);
    }

    // invariant: ledger sum must now equal balance — verified INSIDE the
    // transaction, BEFORE the commit.
    const chk = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0) AS s
       FROM transactions WHERE wallet_id = $1 AND status='success'`, [d.id]);
    const finalBalance = drift < 0 ? ledgerSum : balance;
    if (n2(chk.rows[0].s) !== finalBalance) {
      await client.query("ROLLBACK");
      console.warn(`  ! invariant failed for ${d.id}; rolled back`);
      continue;
    }

    await client.query("COMMIT");
    repaired += 1;

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
