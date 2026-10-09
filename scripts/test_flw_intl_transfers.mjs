/**
 * Flutterwave USD / GBP / EUR international transfer E2E test.
 *
 * Drives the REAL backend provider (server/services/providers/flutterwave.ts)
 * with the SAME payload-building code the production transfer pipeline uses,
 * against the user's TEST-mode keys, then verifies each transfer via
 * verifyTransfer().
 *
 * Usage (from the backend repo root):
 *   FLW_SECRET_KEY='FLWSECK-...' node scripts/test_flw_intl_transfers.mjs
 *
 * The key is read from (first match wins):
 *   1. $FLW_SECRET_KEY
 *   2. ./\.env (FLW_SECRET_KEY=...)
 *   3. ~/metroflow-backend/.env (droplet layout)
 *
 * TEST-mode notes: NGN transfers settle against special test accounts; the
 * USD/GBP/EUR corridors in test mode usually validate the payload and then
 * report the transfer as FAILED/QUEUED (no real payout). What this script
 * proves is that OUR payloads pass Flutterwave's per-currency validation
 * (meta contracts, street split, payment_instruction fallback) and that
 * transfer creation + verification round-trip works for every corridor.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function loadKeyFromEnvFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const m = raw.match(/^\s*FLW_SECRET_KEY\s*=\s*"?([^"\r\n]+)"?\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

let SECRET =
  process.env.FLW_SECRET_KEY ||
  loadKeyFromEnvFile(path.resolve(process.cwd(), ".env")) ||
  loadKeyFromEnvFile(path.join(os.homedir(), "metroflow-backend", ".env"));

if (!SECRET) {
  console.error(
    "\n✘ FLW_SECRET_KEY not found.\n" +
      "  Pass it explicitly:  FLW_SECRET_KEY='FLWSECK-...' node scripts/test_flw_intl_transfers.mjs\n" +
      "  or run from a directory containing the backend .env (droplet: ~/metroflow-backend).\n"
  );
  process.exit(1);
}
if (!/^FLWSECK/.test(SECRET)) {
  console.error("✘ Refusing to run: FLW_SECRET_KEY does not look like a Flutterwave secret key.");
  process.exit(1);
}
const MODE = SECRET.includes("TEST") ? "TEST" : "LIVE";
console.log(`▶ Flutterwave intl transfer E2E — mode: ${MODE}`);

process.env.FLW_SECRET_KEY = SECRET;

// Load the provider with the real key injected.
const { flutterwaveProvider } = await import(
  path.resolve(process.cwd(), "server/services/providers/flutterwave.ts")
).catch(async () => {
  // tsx-less fallback: compile via tsx import hook if available
  return import("../server/services/providers/flutterwave.ts");
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const results = [];

  // 0. Key sanity: balance endpoint
  try {
    const bal = await flutterwaveProvider.getWalletBalance("NGN");
    console.log(`\n[0] Key valid. NGN balance:`, JSON.stringify(bal?.data || bal));
  } catch (e) {
    console.error(`\n[0] Key/balance check FAILED: ${e.message}`);
    process.exit(1);
  }

  const corridors = [
    {
      ccy: "USD",
      label: "USD (ACH)",
      data: {
        transactionReference: `TEST-INTL-USD-${Date.now()}`,
        amount: 5000, // minor units -> $50.00
        currencyId: "USD",
        sourceCurrency: "NGN",
        bankCode: "", // intl: not sent (meta carries routing)
        accountNumber: "8180816628",
        accountName: "John Doe",
        bankName: "Community Federal Savings Bank",
        routingNumber: "026073150",
        swiftCode: "CMFGUS33XXX",
        accountType: "checking",
        beneficiaryCountry: "US",
        beneficiaryAddress: "123 Main Street",
        beneficiaryCity: "New York",
        beneficiaryState: "NY",
        beneficiaryEmail: "beneficiary@metroflow.app",
        remark: "Metroflow intl payout test (USD)",
      },
    },
    {
      ccy: "GBP",
      label: "GBP (FPS)",
      data: {
        transactionReference: `TEST-INTL-GBP-${Date.now()}`,
        amount: 4000, // minor units -> £40.00
        currencyId: "GBP",
        sourceCurrency: "NGN",
        bankCode: "",
        accountNumber: "31510602",
        accountName: "Jane Smith",
        bankName: "Barclays Bank UK",
        routingNumber: "200000", // sort code
        swiftCode: "BUKBGB22",
        accountType: "personal",
        beneficiaryCountry: "GB",
        beneficiaryAddress: "1 High Street",
        beneficiaryCity: "London",
        beneficiaryPostalCode: "EC1A 1BB",
        remark: "Metroflow intl payout test (GBP)",
      },
    },
    {
      ccy: "EUR",
      label: "EUR (SEPA)",
      data: {
        transactionReference: `TEST-INTL-EUR-${Date.now()}`,
        amount: 4500, // minor units -> €45.00
        currencyId: "EUR",
        sourceCurrency: "NGN",
        bankCode: "",
        accountNumber: "DE89370400440532013000", // IBAN
        accountName: "Hans Mueller",
        bankName: "Commerzbank",
        routingNumber: "COBADEFFXXX", // BIC (dual-BIC contract)
        swiftCode: "COBADEFFXXX",
        beneficiaryCountry: "DE",
        beneficiaryAddress: "Elsenheimer Str. 31",
        beneficiaryCity: "Munich",
        beneficiaryPostalCode: "80687",
        remark: "Metroflow intl payout test (EUR)",
      },
    },
  ];

  for (const corridor of corridors) {
    const { ccy, label, data } = corridor;
    console.log(`\n=== ${label} ===`);
    try {
      const res = await flutterwaveProvider.initiateTransfer(data);
      const ok = res?.status === "success";
      const status = res?.data?.status;
      const flwId = res?.data?.id;
      console.log(
        `create: ${ok ? "ACCEPTED" : "REJECTED"} | transfer status: ${status || "n/a"} | id: ${flwId ?? "n/a"} | ref: ${data.transactionReference}`
      );
      if (!ok) {
        console.log(`  message: ${res?.message || JSON.stringify(res).slice(0, 300)}`);
        results.push({ ccy, ok, status, note: res?.message });
        continue;
      }

      // Verify round-trip
      await sleep(1500);
      let verify = null;
      try {
        verify = await flutterwaveProvider.verifyTransfer(data.transactionReference, res?.data);
        const vStatus = String(verify?.data?.status || "").toUpperCase();
        console.log(
          `verify: ${verify?.status === "success" ? "OK" : "FAILED"} | provider status: ${vStatus} | complete_message: ${verify?.data?.complete_message || "-"}`
        );
        results.push({ ccy, ok: true, status: vStatus, note: verify?.data?.complete_message || "" });
      } catch (ve) {
        console.log(`verify FAILED: ${ve.message}`);
        results.push({ ccy, ok: true, status: "VERIFY_ERR", note: ve.message });
      }
    } catch (e) {
      console.log(`create FAILED: ${e.message}`);
      results.push({ ccy, ok: false, status: "ERROR", note: e.message });
    }
  }

  console.log("\n================ SUMMARY ================");
  for (const r of results) {
    console.log(
      `${r.ok ? "✔" : "✘"} ${r.ccy}: create=${r.ok ? "OK" : "FAILED"} status=${r.status}${r.note ? ` | ${String(r.note).slice(0, 120)}` : ""}`
    );
  }
  console.log(
    "\nNOTE (TEST mode): USD/GBP/EUR payouts typically end FAILED/QUEUED at Flutterwave in test mode —\n" +
      "what matters is that payload VALIDATION passes for every corridor (create accepted = our meta\ncontracts are correct). Live-mode payouts require a funded NGN balance.\n"
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
