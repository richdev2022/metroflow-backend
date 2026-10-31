import { query } from "../../db";

/**
 * Legacy bills-hub schema additions (electricity recharge tokens, FLW item
 * codes) — idempotent. Kept as its own module after the legacy unmounted FLW
 * bills router was retired so the boot migration no longer pulls the whole
 * dead router into the bundle.
 */
export async function ensureBillsSchema(): Promise<void> {
  await query(`ALTER TABLE bill_payments ADD COLUMN IF NOT EXISTS recharge_token TEXT`);
  await query(`ALTER TABLE bill_payments ADD COLUMN IF NOT EXISTS item_code VARCHAR(60)`);
}
