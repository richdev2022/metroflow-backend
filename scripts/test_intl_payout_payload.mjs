/**
 * END-TO-END payload test — Flutterwave international payouts (USD / EUR / GBP).
 *
 * Exercises the REAL provider code path (server/services/providers/flutterwave.ts
 * initiateTransfer / verifyTransfer / verifyWebhook) and the REAL corridor
 * validator (server/services/transfer.ts validateIntlBeneficiary) against a
 * local capture server standing in for api.flutterwave.com, then asserts the
 * captured request bodies FIELD BY FIELD against the official international
 * payout documentation samples:
 *
 *   USD meta: account_number, routing_number, swift_code, bank_name,
 *             beneficiary_name, beneficiary_address, beneficiary_country,
 *             email, account_type(checking|depository)
 *   EUR meta: account_number(=IBAN), routing_number(=BIC), swift_code(=BIC),
 *             bank_name, beneficiary_name, beneficiary_country, postal_code,
 *             street_number, street_name, city
 *   GBP meta: same structure as EUR + account_type(personal|corporate),
 *             beneficiary_country "UK"
 *
 * Run:  cd repos/metroflow-backend && npx tsx ../../scripts/test_intl_payout_payload.mjs
 */
import http from "node:http";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// 1. Capture server (stands in for api.flutterwave.com)
// ---------------------------------------------------------------------------
const captured = { transfers: [], gets: [] };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/v3/transfers") {
      const parsed = JSON.parse(body || "{}");
      captured.transfers.push(parsed);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        status: "success",
        message: "Transfer Queued Successfully",
        data: {
          id: 100158907 + captured.transfers.length,
          account_number: "FOREIGN-ACCOUNT",
          bank_code: "FOREIGN-BANK",
          full_name: parsed.beneficiary_name,
          currency: parsed.currency,
          amount: parsed.amount,
          fee: parsed.currency === "USD" ? 35 : 45,
          status: "NEW",
          reference: parsed.reference,
          meta: parsed.meta,
          narration: parsed.narration,
          requires_approval: 0,
          is_approved: 1,
          bank_name: "FA-BANK",
        },
      }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/v3/transfers/")) {
      captured.gets.push(req.url);
      const id = req.url.split("/").pop();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        status: "success",
        message: "Transfer fetched",
        data: {
          id: Number(id),
          currency: "GBP",
          debit_currency: "NGN",
          amount: 500,
          fee: 45,
          status: "SUCCESSFUL",
          reference: "e2e-tsq-ref",
          complete_message: "Successful",
          is_approved: 1,
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ---------------------------------------------------------------------------
// 2. Env BEFORE importing the provider (real payload path — NOT FLW_MOCK)
// ---------------------------------------------------------------------------
process.env.FLW_BASE_URL = `http://127.0.0.1:${port}`;
process.env.FLW_SECRET_KEY = "FLWSECK-TEST-e2e-local-capture";
process.env.DATABASE_URL = "postgres://e2e:e2e@127.0.0.1:5432/e2e_no_db";
process.env.FLW_SECRET_HASH = "e2e-secret-hash";

const { flutterwaveProvider } = await import(
  "/home/z/my-project/repos/metroflow-backend/server/services/providers/flutterwave.ts"
);
const { validateIntlBeneficiary } = await import(
  "/home/z/my-project/repos/metroflow-backend/server/services/transfer.ts"
);

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
};

// ---------------------------------------------------------------------------
// 3. USD payout — doc sample through the REAL provider
// ---------------------------------------------------------------------------
console.log("\nUSD payout (doc sample shape):");
{
  const idx = captured.transfers.length;
  const resp = await flutterwaveProvider.initiateTransfer({
    bankCode: "ACH",
    accountNumber: "09182972BH",
    accountName: "Mark Cuban",
    amount: 50000, // minor units (kobo) — pipeline convention
    transactionReference: "e2e-usd-ref-1",
    remark: "Sample USD Transfer",
    currencyId: "USD",
    sourceCurrency: "NGN",
    bankName: "BANK OF AMERICA, N.A., SAN FRANCISCO, CA",
    swiftCode: "ABJG190",
    routingNumber: "021000021",
    accountType: "checking",
    beneficiaryAddress: "4 Newton",
    beneficiaryCity: "San Francisco",
    beneficiaryState: "CA",
    beneficiaryCountry: "US",
    beneficiaryEmail: "markcuban@example.com",
  });

  check("provider returns the doc 200 shape", () => {
    assert.equal(resp.status, "success");
    assert.equal(resp.message, "Transfer Queued Successfully");
    assert.equal(resp.data.status, "NEW");
    assert.equal(resp.data.reference, "e2e-usd-ref-1");
    assert.equal(resp.data.fee, 35);
  });

  const req = captured.transfers[idx];
  check("top-level doc fields (amount major / narration / currency / beneficiary_name)", () => {
    assert.equal(req.amount, 500);
    assert.equal(req.narration, "Sample USD Transfer");
    assert.equal(req.currency, "USD");
    assert.equal(req.beneficiary_name, "Mark Cuban");
  });
  check("NGN→USD uses payment_instruction (source NGN)", () => {
    assert.deepEqual(req.payment_instruction, {
      source_currency: "NGN",
      destination_currency: "USD",
      amount: { applies_to: "destination_currency", value: 500 },
    });
    assert.equal(req.debit_currency, undefined);
  });
  check("NO top-level account_bank / account_number on intl", () => {
    assert.equal(req.account_bank, undefined);
    assert.equal(req.account_number, undefined);
  });
  check("meta[0] carries EXACTLY the doc USD key set", () => {
    assert.equal(Array.isArray(req.meta), true);
    assert.equal(req.meta.length, 1);
    const keys = Object.keys(req.meta[0]).sort();
    assert.deepEqual(keys, [
      "account_number", "account_type", "bank_name", "beneficiary_address",
      "beneficiary_country", "beneficiary_name", "email", "routing_number", "swift_code",
    ]);
  });
  check("USD meta values (swift uppercase, address composed street+city+state)", () => {
    const m = req.meta[0];
    assert.equal(m.account_number, "09182972BH");
    assert.equal(m.routing_number, "021000021");
    assert.equal(m.swift_code, "ABJG190");
    assert.equal(m.bank_name, "BANK OF AMERICA, N.A., SAN FRANCISCO, CA");
    assert.equal(m.beneficiary_name, "Mark Cuban");
    assert.equal(m.beneficiary_address, "4 Newton, San Francisco, CA");
    assert.equal(m.beneficiary_country, "US");
    assert.equal(m.email, "markcuban@example.com");
    assert.equal(m.account_type, "checking");
  });
}

// ---------------------------------------------------------------------------
// 4. EUR payout — doc sample (IBAN + BIC + European address block)
// ---------------------------------------------------------------------------
console.log("\nEUR payout (doc sample shape):");
{
  const idx = captured.transfers.length;
  await flutterwaveProvider.initiateTransfer({
    bankCode: "SWIFT",
    accountNumber: "DA091983888373BGH",
    accountName: "John Twain",
    amount: 50000,
    transactionReference: "e2e-eur-ref-1",
    remark: "Sample EUR Transfer",
    currencyId: "EUR",
    sourceCurrency: "NGN",
    bankName: "LLOYDS BANK",
    swiftCode: "BECFDE7HKKX",
    routingNumber: "BECFDE7HKKX",
    beneficiaryAddress: "Handelsbank Elsenheimer Str. 31",
    beneficiaryCity: "München",
    beneficiaryPostalCode: "80489",
    beneficiaryCountry: "DE",
  });

  const req = captured.transfers[idx];
  check("meta[0] carries EXACTLY the doc EUR key set", () => {
    const keys = Object.keys(req.meta[0]).sort();
    assert.deepEqual(keys, [
      "account_number", "bank_name", "beneficiary_country", "beneficiary_name",
      "city", "postal_code", "routing_number", "street_name", "street_number", "swift_code",
    ]);
  });
  check("EUR meta values (IBAN, BIC routing+swift, trailing house number split)", () => {
    const m = req.meta[0];
    assert.equal(m.account_number, "DA091983888373BGH");
    assert.equal(m.routing_number, "BECFDE7HKKX");
    assert.equal(m.swift_code, "BECFDE7HKKX");
    assert.equal(m.bank_name, "LLOYDS BANK");
    assert.equal(m.beneficiary_name, "John Twain");
    assert.equal(m.beneficiary_country, "DE");
    assert.equal(m.postal_code, "80489");
    assert.equal(m.street_number, "31");
    assert.equal(m.street_name, "Handelsbank Elsenheimer Str.");
    assert.equal(m.city, "München");
  });
  check("no USD-only fields leak into EUR meta", () => {
    const m = req.meta[0];
    assert.equal(m.account_type, undefined);
    assert.equal(m.email, undefined);
    assert.equal(m.beneficiary_address, undefined);
  });
}

// ---------------------------------------------------------------------------
// 5. GBP payout — doc sample + account_type (personal|corporate) + country "UK"
// ---------------------------------------------------------------------------
console.log("\nGBP payout (doc sample shape):");
{
  const idx = captured.transfers.length;
  await flutterwaveProvider.initiateTransfer({
    bankCode: "SWIFT",
    accountNumber: "DA091983888373BGH",
    accountName: "John Twain",
    amount: 50000,
    transactionReference: "e2e-gbp-ref-1",
    remark: "Sample GBP Transfer",
    currencyId: "GBP",
    sourceCurrency: "NGN",
    bankName: "LLOYDS BANK",
    swiftCode: "BECFDE7HKKX",
    routingNumber: "308463",
    accountType: "corporate",
    beneficiaryAddress: "Handelsbank Elsenheimer Str. 31",
    beneficiaryCity: "London",
    beneficiaryPostalCode: "80489",
    beneficiaryCountry: "GB", // clients send ISO; provider must force "UK"
  });

  const req = captured.transfers[idx];
  check("meta[0] carries EXACTLY the doc GBP key set (+account_type)", () => {
    const keys = Object.keys(req.meta[0]).sort();
    assert.deepEqual(keys, [
      "account_number", "account_type", "bank_name", "beneficiary_country",
      "beneficiary_name", "city", "postal_code", "routing_number",
      "street_name", "street_number", "swift_code",
    ]);
  });
  check("GBP meta values (sort code routing, country forced to UK, corporate)", () => {
    const m = req.meta[0];
    assert.equal(m.account_number, "DA091983888373BGH");
    assert.equal(m.routing_number, "308463");
    assert.equal(m.swift_code, "BECFDE7HKKX");
    assert.equal(m.beneficiary_country, "UK");
    assert.equal(m.account_type, "corporate");
    assert.equal(m.city, "London");
    assert.equal(m.postal_code, "80489");
    assert.equal(m.street_number, "31");
    assert.equal(m.street_name, "Handelsbank Elsenheimer Str.");
  });
}

// ---------------------------------------------------------------------------
// 6. TSQ — verification by stored FLW id hits GET /v3/transfers/{id}
// ---------------------------------------------------------------------------
console.log("\nTSQ (transfer status query):");
{
  const resp = await flutterwaveProvider.verifyTransfer("e2e-tsq-ref", { data: { id: 221084 } });
  check("GET /v3/transfers/{id} called and final status surfaced", () => {
    assert.equal(captured.gets.some((u) => u === "/v3/transfers/221084"), true);
    assert.equal(resp.data.status, "SUCCESSFUL");
    assert.equal(resp.data.debit_currency, "NGN");
  });
}

// ---------------------------------------------------------------------------
// 7. Webhook signature (verif-hash)
// ---------------------------------------------------------------------------
console.log("\nWebhook verification:");
check("matching verif-hash accepted", () => {
  assert.equal(flutterwaveProvider.verifyWebhook({ event: "transfer.completed", data: { id: 1 } }, "e2e-secret-hash"), true);
});
check("wrong / missing verif-hash rejected", () => {
  assert.equal(flutterwaveProvider.verifyWebhook({ event: "transfer.completed", data: { id: 1 } }, "nope"), false);
  assert.equal(flutterwaveProvider.verifyWebhook({ event: "transfer.completed", data: { id: 1 } }, ""), false);
  assert.equal(flutterwaveProvider.verifyWebhook({ event: "transfer.completed", data: { id: 1 } }, undefined), false);
});

// ---------------------------------------------------------------------------
// 8. validateIntlBeneficiary — the pre-debit gate matrix (all new rules)
// ---------------------------------------------------------------------------
console.log("\nValidator matrix (pre-debit gate):");
const V = (cur, d) => validateIntlBeneficiary(cur, d);
const usdBase = {
  routingNumber: "021000021", swiftCode: "CHASUS33", bankName: "JPMorgan Chase",
  accountType: "checking", accountNumber: "09182972BH", beneficiaryAddress: "4 Newton",
  beneficiaryEmail: "mark@example.com",
};
const gbpBase = {
  routingNumber: "308463", swiftCode: "BUKBGB22", bankName: "LLOYDS BANK",
  accountType: "personal", accountNumber: "12345678",
  beneficiaryAddress: "1 High St", beneficiaryPostalCode: "EC1A 1BB",
};
const eurBase = {
  routingNumber: "BECFDE7HKKX", swiftCode: "BECFDE7HKKX", bankName: "LLOYDS BANK",
  accountNumber: "DA091983888373BGH", beneficiaryAddress: "Handelsbank Elsenheimer Str. 31",
  beneficiaryPostalCode: "80489",
};

check("USD complete payload passes", () => assert.deepEqual(V("USD", usdBase), { valid: true }));
check("USD missing swift → SWIFT_CODE_REQUIRED", () => {
  const r = V("USD", { ...usdBase, swiftCode: "" });
  assert.equal(r.valid, false); assert.equal(r.code, "SWIFT_CODE_REQUIRED");
});
check("USD malformed swift → SWIFT_CODE_INVALID", () => {
  const r = V("USD", { ...usdBase, swiftCode: "CHAS1" });
  assert.equal(r.valid, false); assert.equal(r.code, "SWIFT_CODE_INVALID");
});
check("USD bad ABA checksum → ROUTING_NUMBER_CHECKSUM", () => {
  const r = V("USD", { ...usdBase, routingNumber: "021000022" });
  assert.equal(r.valid, false); assert.equal(r.code, "ROUTING_NUMBER_CHECKSUM");
});
check("USD missing email → BENEFICIARY_EMAIL_REQUIRED", () => {
  const r = V("USD", { ...usdBase, beneficiaryEmail: " " });
  assert.equal(r.valid, false); assert.equal(r.code, "BENEFICIARY_EMAIL_REQUIRED");
});
check("USD account_type savings → ACCOUNT_TYPE_INVALID", () => {
  const r = V("USD", { ...usdBase, accountType: "savings" });
  assert.equal(r.valid, false); assert.equal(r.code, "ACCOUNT_TYPE_INVALID");
});
check("USD depository accepted", () => {
  assert.deepEqual(V("USD", { ...usdBase, accountType: "depository" }), { valid: true });
});

check("GBP complete payload (sort code) passes", () => assert.deepEqual(V("GBP", gbpBase), { valid: true }));
check("GBP missing swift → SWIFT_CODE_REQUIRED", () => {
  const r = V("GBP", { ...gbpBase, swiftCode: "" });
  assert.equal(r.valid, false); assert.equal(r.code, "SWIFT_CODE_REQUIRED");
});
check("GBP missing account_type → ACCOUNT_TYPE_REQUIRED", () => {
  const r = V("GBP", { ...gbpBase, accountType: "" });
  assert.equal(r.valid, false); assert.equal(r.code, "ACCOUNT_TYPE_REQUIRED");
});
check("GBP BIC-as-routing accepted", () => {
  assert.deepEqual(V("GBP", { ...gbpBase, routingNumber: "BUKBGB22" }), { valid: true });
});

check("EUR complete payload passes", () => assert.deepEqual(V("EUR", eurBase), { valid: true }));
check("EUR missing routing → ROUTING_NUMBER_INVALID", () => {
  const r = V("EUR", { ...eurBase, routingNumber: "" });
  assert.equal(r.valid, false); assert.equal(r.code, "ROUTING_NUMBER_INVALID");
});
check("EUR digits-only routing → ROUTING_NUMBER_INVALID", () => {
  const r = V("EUR", { ...eurBase, routingNumber: "500105823" });
  assert.equal(r.valid, false); assert.equal(r.code, "ROUTING_NUMBER_INVALID");
});
check("EUR missing swift → SWIFT_CODE_REQUIRED", () => {
  const r = V("EUR", { ...eurBase, swiftCode: "" });
  assert.equal(r.valid, false); assert.equal(r.code, "SWIFT_CODE_REQUIRED");
});
check("EUR missing postal code → POSTAL_CODE_REQUIRED", () => {
  const r = V("EUR", { ...eurBase, beneficiaryPostalCode: "" });
  assert.equal(r.valid, false); assert.equal(r.code, "POSTAL_CODE_REQUIRED");
});
check("NGN short-circuits (domestic rails)", () => {
  assert.deepEqual(V("NGN", {}), { valid: true });
});

// ---------------------------------------------------------------------------
server.close();
console.log(`\n=== E2E RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
