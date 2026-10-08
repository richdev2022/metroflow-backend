// One-time (idempotent) platform-ledger true-up repair.
//
// Makes the platform-typed ledger sum equal the wallets.balance column for
// every internal (operational) wallet by writing ONE documented adjustment
// row per drifted wallet. LEDGER-ONLY: never touches wallets.balance (the
// balance column is the operational truth; all live writers already keep
// balance and ledger in sync — this only settles historical damage).
//
// Usage:
//   DATABASE_URL='postgresql://...' node repair-platform-ledger-trueup.mjs           # dry run
//   DATABASE_URL='postgresql://...' node repair-platform-ledger-trueup.mjs --apply   # write
//
// Safety:
//   - dry run by default; --apply required to write
//   - per-wallet backup of ALL its transaction rows -> backups/ JSON (apply mode)
//   - wallet row locked FOR UPDATE inside the transaction
//   - post-insert invariant asserted (sum == balance) before COMMIT, else ROLLBACK
//   - idempotent by reference (PLATFORM-LEDGER-TRUEUP-<wallet8>-<yyyymmdd>)
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(1); }

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const n = (v) => Number(v) || 0;
const fmt = (v) => n(v).toLocaleString("en-US", { minimumFractionDigits: 2 });
const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, "");

const walletsRes = await client.query(
  `SELECT id, currency, balance FROM wallets WHERE business_id IS NULL AND user_id IS NULL`,
);

const targets = [];
for (const w of walletsRes.rows) {
  const sumRes = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS recorded
     FROM transactions
     WHERE wallet_id = $1 AND transaction_type = 'platform' AND status = 'success'`,
    [w.id],
  );
  const recorded = n(sumRes.rows[0].recorded);
  const balance = n(w.balance);
  const diff = Math.round((balance - recorded) * 100) / 100;
  targets.push({ wallet: w, recorded, balance, diff });
  console.log(`wallet ${w.id} (${w.currency}): balance=${fmt(balance)} recorded=${fmt(recorded)} diff=${fmt(diff)}`);
}

const drifted = targets.filter((t) => Math.abs(t.diff) >= 0.01);
if (drifted.length === 0) {
  console.log("\nAll internal wallets clean — nothing to do.");
  await client.end();
  process.exit(0);
}

if (APPLY) {
  const backupDir = process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `pre-trueup-${dateTag}-${Date.now()}.json`);
  const backup = {};
  for (const t of drifted) {
    const rows = await client.query(
      `SELECT * FROM transactions WHERE wallet_id = $1 ORDER BY created_at ASC`,
      [t.wallet.id],
    );
    backup[t.wallet.id] = rows.rows;
  }
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  console.log(`\nbackup written: ${backupFile}`);
}

console.log(APPLY ? "\n--- APPLY MODE ---" : "\n--- DRY RUN (no writes) ---");

let failures = 0;
for (const t of drifted) {
  const { wallet, diff } = t;
  const reference = `PLATFORM-LEDGER-TRUEUP-${wallet.id.slice(0, 8)}-${dateTag}`;
  const type = diff > 0 ? "credit" : "debit";
  const description = "Platform ledger true-up (one-time forensic repair — pre-ledger inflows & legacy adjustments)";

  try {
    await client.query("BEGIN");
    // Serialize against concurrent balance writers on this wallet.
    await client.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [wallet.id]);

    const already = await client.query(`SELECT id FROM transactions WHERE reference = $1 LIMIT 1`, [reference]);
    if (already.rows.length > 0) {
      console.log(`${wallet.id}: true-up row ${reference} already exists — skipping (idempotent)`);
      await client.query("ROLLBACK");
      continue;
    }

    if (APPLY) {
      await client.query(
        `INSERT INTO transactions
         (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, created_at)
         VALUES ($1, $2, 'success', $3, $4, $5, 'platform', $6, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (reference) DO NOTHING`,
        [Math.abs(diff), wallet.currency, reference, type, description, wallet.id],
      );

      const verify = await client.query(
        `SELECT
           (SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0)
              FROM transactions
             WHERE wallet_id = $1 AND transaction_type = 'platform' AND status = 'success') AS recorded,
           (SELECT balance FROM wallets WHERE id = $1) AS balance`,
        [wallet.id],
      );
      const recordedAfter = n(verify.rows[0].recorded);
      const balanceAfter = n(verify.rows[0].balance);
      if (Math.abs(recordedAfter - balanceAfter) >= 0.005) {
        throw new Error(`post-check failed: recorded=${recordedAfter} balance=${balanceAfter}`);
      }
      console.log(`${wallet.id}: inserted ${type} ${fmt(Math.abs(diff))} (${reference}); recorded=${fmt(recordedAfter)} == balance=${fmt(balanceAfter)} ✓`);
    } else {
      console.log(`${wallet.id}: WOULD insert ${type} ${fmt(Math.abs(diff))} (${reference})`);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    failures++;
    console.error(`${wallet.id}: FAILED [${err?.code || "UNKNOWN"}]: ${err?.message}`);
  }
}

await client.end();
if (failures > 0) { console.error(`\n${failures} wallet(s) failed — inspect above.`); process.exit(1); }
console.log(APPLY ? "\nDone. Re-run the drift check on next boot — it must stay silent." : "\nDry run complete. Re-run with --apply to write.");
