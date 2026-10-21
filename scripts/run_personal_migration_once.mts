/** One-off: apply the Personal schema (idempotent) without booting servers. */
import "dotenv/config";
import { pool } from "../server/db";
import { ensurePersonalSchema } from "../server/features/personal/schema";

async function main() {
  await ensurePersonalSchema();
  console.log("PERSONAL-SCHEMA-MIGRATION-COMPLETE");
  await pool.end();
}
main().catch((e) => { console.error("MIGRATION-FAILED:", e?.message); process.exit(1); });
