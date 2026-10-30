/**
 * OPS TOOL — correct a bill payment that was refunded while the provider had
 * actually fulfilled it (the 2026-10-30 class: MF-BILL-MVV2PRHWECRO4Y got
 * auto-refunded even though Sogo delivered the airtime and the signed
 * transaction.completed webhook was captured).
 *
 * Runs the SAME correctWrongRefund() engine the webhook uses — atomic claim,
 * balance-guarded wallet re-debit, idempotent `${ref}-REFUND-REVERSAL` debit
 * ledger row, original debit row flipped back to 'success', customer notified.
 *
 * Usage:
 *   npx tsx scripts/correct-bill-refund.ts <MF-BILL-reference>            (dry-run preview)
 *   npx tsx scripts/correct-bill-refund.ts <MF-BILL-reference> --apply    (execute)
 *
 * Requires DATABASE_URL in .env (gitignored). NEVER commit credentials.
 */
import dotenv from "dotenv";
dotenv.config({ override: true, path: ".env" });

if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).startsWith("postgres")) {
  console.error("DATABASE_URL missing or not postgres — refusing to run.");
  process.exit(2);
}

const ref = process.argv[2];
const apply = process.argv.includes("--apply");
if (!ref) {
  console.error("usage: npx tsx scripts/correct-bill-refund.ts <MF-BILL-reference> [--apply]");
  process.exit(2);
}

const { query } = await import("../server/db");
const { correctWrongRefund } = await import("../server/features/personal/bill-settlement");

const rows = await query(`SELECT * FROM bill_transactions WHERE reference = $1 LIMIT 1`, [ref]);
const bill = rows.rows[0];
if (!bill) {
  console.error(`No bill_transactions row for ${ref}`);
  process.exit(1);
}

console.log("== BILL ROW (before) ==");
console.log(JSON.stringify(
  { reference: bill.reference, status: bill.status, amount: bill.amount, fee: bill.fee, total: bill.total,
    provider: bill.provider, provider_reference: bill.provider_reference, failure_reason: bill.failure_reason },
  null, 2,
));

if (bill.status === "completed") {
  console.log("Row is already completed — nothing to correct.");
  process.exit(0);
}

const refundLedger = await query(
  `SELECT reference, amount, created_at FROM transactions WHERE reference = $1 AND type = 'credit' LIMIT 1`,
  [`${ref}-REFUND`],
);
const debitLedger = await query(
  `SELECT reference, amount, status FROM transactions WHERE reference = $1 AND type = 'debit' LIMIT 1`,
  [ref],
);
const walletBefore = await query(`SELECT id, balance, currency FROM wallets WHERE id = $1`, [bill.wallet_id]);

console.log("== EVIDENCE ==");
console.log("refund credit row:", refundLedger.rows[0] ?? "NONE (no refund was issued)");
console.log("original debit row:", debitLedger.rows[0] ?? "NONE (!)");
console.log("wallet before:", walletBefore.rows[0]?.balance, walletBefore.rows[0]?.currency);
console.log("provider evidence:", "live Sogo webhook transaction.completed captured 2026-10-30 (BILL202610301534S35246573)");

if (!apply) {
  console.log("\nDRY RUN — rerun with --apply to execute the correction.");
  process.exit(0);
}

const result = await correctWrongRefund(bill, {
  source: "ops-manual-correction",
  tool: "scripts/correct-bill-refund.ts",
  evidence: "live Sogo webhook transaction.completed captured 2026-10-30 (BILL202610301534S35246573)",
});

const walletAfter = await query(`SELECT balance FROM wallets WHERE id = $1`, [bill.wallet_id]);
const reversalRow = await query(
  `SELECT reference, amount, type, status FROM transactions WHERE reference = $1`,
  [`${ref}-REFUND-REVERSAL`],
);
const after = await query(`SELECT status, failure_reason FROM bill_transactions WHERE id = $1`, [bill.id]);

console.log("== RESULT ==");
console.log(JSON.stringify(result, null, 2));
console.log("wallet after:", walletAfter.rows[0]?.balance);
console.log("reversal ledger row:", reversalRow.rows[0] ?? "NOT CREATED");
console.log("bill row (after):", after.rows[0]);
process.exit(0);
