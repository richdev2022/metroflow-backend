/* Probe Sogo sandbox for exact response shapes (paced < 10 req/min) */
import * as sogo from "../server/services/sogo";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const catalog = await sogo.billsCatalog();
  console.log("=== CATALOG (full JSON) ===");
  console.log(JSON.stringify(catalog, null, 1).slice(0, 4000));
  await sleep(7500);
  const epin = await sogo.billsEpinStock();
  console.log("=== EPIN STOCK ===");
  console.log(JSON.stringify(epin, null, 1).slice(0, 1200));
  process.exit(0);
}
main().catch((e) => { console.error("ERR:", sogo.sogoErr(e)); process.exit(1); });
