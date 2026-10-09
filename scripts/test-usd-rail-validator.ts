/**
 * Behavior test for the rail-conditional USD validator (ACH vs SWIFT)
 * plus regression checks for GBP/EUR. Run: npx tsx scripts/test-usd-rail-validator.ts
 */
import { validateIntlBeneficiary } from "../server/services/transfer";

const validAba = "021000021"; // checksum-valid (JPMorgan Chase test routing)
const validSwift = "CHASUS33";
let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name, JSON.stringify(extra ?? "")); }
}
const base = {
  routingNumber: validAba,
  bankName: "JPMorgan Chase Bank",
  accountNumber: "000123456789",
  accountType: "checking",
  beneficiaryAddress: "1 Main St",
  beneficiaryEmail: "ben@example.com",
};

console.log("USD ACH rail (explicit):");
let r = validateIntlBeneficiary("USD", { ...base, bankCode: "ACH" });
check("no swift -> valid", r.valid === true, r);

console.log("USD rail omitted (legacy clients):");
r = validateIntlBeneficiary("USD", { ...base });
check("absent rail defaults ACH -> valid", r.valid === true, r);

console.log("USD ACH with optional valid swift:");
r = validateIntlBeneficiary("USD", { ...base, bankCode: "ACH", swiftCode: validSwift });
check("valid swift accepted", r.valid === true, r);

console.log("USD ACH with INVALID swift:");
r = validateIntlBeneficiary("USD", { ...base, bankCode: "ACH", swiftCode: "X1" });
check("invalid swift rejected", r.valid === false && r.code === "SWIFT_CODE_INVALID", r);

console.log("USD SWIFT rail:");
r = validateIntlBeneficiary("USD", { ...base, bankCode: "SWIFT" });
check("missing swift -> SWIFT_CODE_REQUIRED", r.valid === false && r.code === "SWIFT_CODE_REQUIRED", r);
r = validateIntlBeneficiary("USD", { ...base, bankCode: "SWIFT", swiftCode: validSwift });
check("swift present -> valid", r.valid === true, r);

console.log("USD ABA checksum still enforced:");
r = validateIntlBeneficiary("USD", { ...base, bankCode: "ACH", routingNumber: "021000022" });
check("bad checksum -> ROUTING_NUMBER_CHECKSUM", r.valid === false && r.code === "ROUTING_NUMBER_CHECKSUM", r);

console.log("GBP regression (swift still required):");
r = validateIntlBeneficiary("GBP", {
  routingNumber: "200000", bankName: "Barclays", accountNumber: "12345678",
  accountType: "personal", beneficiaryPostalCode: "E1 6AN", beneficiaryAddress: "1 High St",
});
check("GBP no swift -> SWIFT_CODE_REQUIRED", r.valid === false && r.code === "SWIFT_CODE_REQUIRED", r);

console.log("EUR regression (swift still required):");
r = validateIntlBeneficiary("EUR", {
  routingNumber: "DEUTDEFF", swiftCode: "", bankName: "Deutsche Bank",
  accountNumber: "DE89370400440532013000", accountType: "personal",
  beneficiaryPostalCode: "60311", beneficiaryAddress: "1 Zeil",
});
check("EUR no swift -> SWIFT_CODE_REQUIRED", r.valid === false && r.code === "SWIFT_CODE_REQUIRED", r);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
