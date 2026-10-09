// Module hooks for the push smoke test: stub the DB layer so the platform
// lookup works (ios/android split) without a real Postgres. Registered via
// scripts/register-push-stub.mjs.
const STUB_SOURCE = `
const platformOf = (t) => String(t).includes("-ios-") ? "ios" : "android";
export const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
export async function query(text, params) {
  const t = String(text || "");
  if (t.includes("FROM user_devices WHERE fcm_token = ANY")) {
    const tokens = Array.isArray(params?.[0]) ? params[0] : [];
    return { rows: tokens.map((tok) => ({ fcm_token: tok, platform: platformOf(tok) })), rowCount: tokens.length };
  }
  if (t.includes("SELECT created_at, last_seen_at FROM user_devices")) {
    const now = new Date().toISOString();
    return { rows: [{ created_at: now, last_seen_at: now }], rowCount: 1 };
  }
  if (t.includes("DELETE FROM user_devices")) return { rows: [], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
export default { query, pool };
`;

export async function load(url, context, next) {
  let pathname = "";
  try { pathname = new URL(url).pathname; } catch {}
  if (pathname.endsWith("/server/db.ts") || pathname.endsWith("/server/db")) {
    return { format: "module", source: STUB_SOURCE, shortCircuit: true };
  }
  return next(url, context);
}
