/**
 * User-safe error copy.
 *
 * Provider error envelopes (Sogo/Prestmit/Bitnob/Flutterwave) must NEVER be
 * shown to end users verbatim — they leak provider names, operator guidance
 * (API keys, IP whitelists, sandbox rate limits) and sometimes render as raw
 * objects, which crashed the Personal web app (React error #31).
 *
 * Every personal-route 4xx/5xx error body that embeds a provider message must
 * pass through `userSafeErr()` so the client only ever receives a plain,
 * provider-agnostic string.
 */

const PROVIDER_NAME_RE = /\b(sogo|prestmit|bitnob|flutterwave|monnify|squad)\b/gi;
const OPERATOR_HINT_RE =
  /api key|secret key|_sk_test_|_sk_live_|key_dev_|key_live_|whitelist|sandbox|environment mismatch|base url|SOGO_SECRET_KEY|PRESTMIT_API|BITNOB_|FLUTTERWAVE_SECRET/i;

const GENERIC_PARTNER_DOWN =
  "Our payment partner is temporarily unavailable — please try again in a few minutes.";

/** Coerce anything (string | object | Error) into a plain string. */
export function flattenErr(e: any): string {
  const d = e?.response?.data ?? e;
  let msg: unknown =
    (typeof d === "string" ? d : null) ??
    d?.message ??
    d?.details ??
    (typeof d?.error === "string" ? d.error : d?.error?.message) ??
    e?.message ??
    "Request failed";
  if (d?.errors && typeof d.errors === "object") {
    const first = Object.values(d.errors)[0] as any;
    if (Array.isArray(first) && first.length) msg = String(first[0]);
  }
  if (msg && typeof msg === "object") {
    const nested = msg as { message?: unknown; detail?: unknown };
    msg = nested.message ?? nested.detail ?? GENERIC_PARTNER_DOWN;
  }
  return String(msg ?? GENERIC_PARTNER_DOWN);
}

/**
 * Make a provider-derived error string safe for end users:
 * - operator-only guidance (keys, whitelists, sandbox hints) → generic copy
 * - provider brand names → "our payment partner"
 * - trimmed to 300 chars, single-spaced
 */
export function userSafeErr(msgOrErr: unknown, fallback = GENERIC_PARTNER_DOWN): string {
  const raw = typeof msgOrErr === "string" ? msgOrErr : flattenErr(msgOrErr);
  if (!raw || /object Object/i.test(raw)) return fallback;
  if (OPERATOR_HINT_RE.test(raw)) return GENERIC_PARTNER_DOWN;
  let s = raw.replace(PROVIDER_NAME_RE, "our payment partner");
  s = s.replace(/\b(our payment partner)_sk_(test|live)_\S+/gi, "$1");
  s = s.replace(/\s+/g, " ").trim();
  return (s || fallback).slice(0, 300);
}
