/**
 * KYC IDENTITY MAPPING — Bitnob card-KYC customer built from the user's
 * verified BVN/NIN record.
 *
 * WHY THIS EXISTS: `users.kyc_data` stores the RAW Prembly verification
 * envelope — `{ status, detail, data, bvn_data | nin_data, dsvi, … }` — and
 * the two providers use DIFFERENT key styles:
 *
 *   BVN  (camelCase) : firstName / lastName / middleName / dateOfBirth /
 *                      residentialAddress / stateOfResidence / stateOfOrigin /
 *                      lgaOfResidence / lgaOfOrigin / phoneNumber1
 *   NIN  (lowercase) : firstname / middlename / surname / birthdate /
 *                      residence_address / residence_state / residence_town /
 *                      residence_lga / birthstate / birthlga / telephoneno
 *
 * The old buildKycCustomer read `kyc.firstName` / `kyc.dateOfBirth` /
 * `kyc.address` straight off the ENVELOPE — every key undefined, so every
 * Bitnob customer was built from the account display name with NO date of
 * birth, address or phone. Bitnob requires DOB + address (YYYY-MM-DD) and
 * "the name and date of birth must match the BVN record exactly" — so card
 * KYC could never pass. These helpers read the real identity block instead.
 */

export type KycIdentity = {
  firstName: string;
  lastName: string;
  email: string;
  /** Local number without dial code / trunk zero — Bitnob wants "8034567890". */
  phoneLocal: string;
  /** Dial code with "+" — Bitnob wants "+234". */
  dialCode: string;
  /** YYYY-MM-DD parsed from the ID record when possible. */
  dob?: string;
  address?: string;
  city?: string;
  state?: string;
  /** Raw record gender ("Male" / "male" / "F" …) — providers normalize it. */
  gender?: string;
};

/** First non-empty, trimmed string among the candidates. */
export function pickStr(...vals: unknown[]): string {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

/**
 * Normalize the ID record's DOB to Bitnob's required "YYYY-MM-DD".
 * Handles the observed Prembly formats:
 *   BVN  dateOfBirth "22-Oct-1998"   NIN birthdate "22-05-1999"
 * plus ISO "1998-10-22", "22/10/1998" and generic Date-parseable values.
 */
export function normalizeDob(...vals: unknown[]): string | undefined {
  const s = pickStr(...vals);
  if (!s) return undefined;
  // 22-Oct-1998 | 22-10-1998 | 22.10.1998 | 22 10 1998
  const dmy = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9}|\d{1,2})[-/. ](\d{4})$/);
  if (dmy) {
    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const mm = /^\d+$/.test(dmy[2])
      ? dmy[2].padStart(2, "0")
      : months[dmy[2].slice(0, 3).toLowerCase()];
    if (mm && Number(mm) >= 1 && Number(mm) <= 12) {
      return `${dmy[3]}-${mm}-${dmy[1].padStart(2, "0")}`;
    }
  }
  // ISO date / timestamp → the date part.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return undefined;
}

/**
 * Extract the cardholder identity from a `users` row. `user.kyc_data` may be
 * a jsonb object or a JSON string; the identity lives in the FIRST populated
 * block among `data` (latest verification), `nin_data`, `bvn_data`, or the
 * envelope itself (legacy normalized objects keep working).
 */
export function kycIdentity(user: any): KycIdentity {
  let raw: any = user?.kyc_data;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  const blocks = [raw?.data, raw?.nin_data, raw?.bvn_data, raw]
    .filter((b) => b && typeof b === "object" && !Array.isArray(b));

  // Look each field up across all blocks (first hit wins), accepting both
  // providers' key styles.
  const id = (...keys: string[]): string => {
    for (const b of blocks) for (const k of keys) {
      const v = pickStr(b?.[k]);
      if (v) return v;
    }
    return "";
  };

  const firstName = id("firstname", "firstName", "first_name");
  const middleName = id("middlename", "middleName", "middle_name");
  const lastName = id("surname", "lastName", "lastname", "last_name");
  const fullName = pickStr(user?.name);

  // Bitnob compares the submitted name against the ID record — the record's
  // own names always win; the display name is only a cosmetic fallback.
  const first = (firstName + (middleName ? ` ${middleName}` : ""))
    || fullName.split(" ")[0] || "MetriCorex";
  const last = lastName
    || (fullName.split(" ").slice(1).join(" ") || fullName.split(" ")[0]) || "User";

  // Phone — the record saves the local format ("0803…"); Bitnob wants the
  // dial code separate and the local number WITHOUT the trunk zero.
  let phoneRaw = id("telephoneno", "phoneNumber1", "phoneNumber", "phone_number")
    || pickStr(user?.phone_number);
  phoneRaw = phoneRaw.replace(/[^\d+]/g, "");
  let dialCode = "+234";
  let local = phoneRaw;
  if (phoneRaw.startsWith("+")) {
    dialCode = phoneRaw.slice(0, 4).match(/^\+\d{1,3}$/)?.[0] || "+234";
    local = phoneRaw.slice(dialCode.length);
  } else if (phoneRaw.startsWith("234") && phoneRaw.length >= 13) {
    local = phoneRaw.slice(3);
  }
  local = local.replace(/^0+/, "");

  return {
    firstName: first,
    lastName: last,
    email: pickStr(user?.email) || id("email"),
    phoneLocal: local,
    dialCode,
    dob: normalizeDob(id("birthdate", "dateOfBirth", "date_of_birth", "birthDate", "dob")),
    address: id("residence_address", "residentialAddress", "address", "line1") || undefined,
    city: id("residence_town", "residence_lga", "birthlga", "lgaOfResidence", "lgaOfOrigin", "city") || undefined,
    state: id("residence_state", "birthstate", "stateOfResidence", "stateOfOrigin", "state") || undefined,
    gender: id("gender", "sex") || undefined,
    // NOTE: `nok_postalcode` is the NEXT-OF-KIN's postal code — deliberately
    // not used as the cardholder's. Prembly carries no user postal code.
  };
}
