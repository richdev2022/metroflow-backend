// Module hooks for the funding-limits smoke test: stub the DB layer,
// push/email/notifications services and the provider factory so the REAL
// transaction-limits + funding-limits modules can be exercised without
// Postgres or external APIs. Registered via register-funding-hooks.mjs
// (must be imported AFTER tsx so its hook short-circuits first — LIFO).
const STUBS = {
  "server/db.ts": `
export async function query(text, params) {
  const s = String(text || "").toLowerCase();
  if (s.includes("from transaction_limits")) {
    const cat = params?.[0];
    const row = cat === "registered"
      ? { category: "registered", currency: "NGN", single_transaction_limit: 5000000, daily_limit: 10000000, monthly_limit: 50000000 }
      : { category: "non_registered", currency: "NGN", single_transaction_limit: 50000, daily_limit: 100000, monthly_limit: 500000 };
    return { rows: [row], rowCount: 1 };
  }
  if (s.includes("registration_category")) {
    return { rows: [{ category: globalThis.__bizCategory || "non_registered" }], rowCount: 1 };
  }
  if (s.includes("sum(amount) filter") && s.includes("direction = 'debit'")) {
    return { rows: [{ used_today: globalThis.__outUsedToday || 0, used_month: globalThis.__outUsedMonth || 0 }], rowCount: 1 };
  }
  if (s.includes("sum(amount) filter") && s.includes("direction = 'credit'")) {
    return { rows: [{ used_today: globalThis.__inUsedToday || 0, used_month: globalThis.__inUsedMonth || 0 }], rowCount: 1 };
  }
  if (s.includes("insert into transactions") && s.includes("returning id")) {
    return { rows: [{ id: "txn-failed-new" }], rowCount: 1 };
  }
  if (s.includes("update transactions") && s.includes("returning id")) {
    return { rows: [{ id: globalThis.__existingTxnId || "txn-pending-1" }], rowCount: 1 };
  }
  if (s.includes("from users where id")) {
    return { rows: globalThis.__noOwner ? [] : [{ id: "user-1", name: "Test Owner", email: "owner@test.dev", business_id: "biz-1" }], rowCount: globalThis.__noOwner ? 0 : 1 };
  }
  if (s.includes("from user_devices")) {
    return { rows: [{ fcm_token: "TOKEN_OK_1" }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}
export const pool = { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) };
export default { query, pool };
`,
  "services/push.ts": `
export async function sendPushToUsers(users, payload, options = {}) {
  globalThis.__pushCalls = globalThis.__pushCalls || [];
  globalThis.__pushCalls.push({ users, payload, options });
  return { sent: 1, failed: 0, users: 1 };
}
export async function sendPushToAll() { return { sent: 0, failed: 0, users: 0 }; }
export function isPushConfigured() { return true; }
export function pushDeliveryMode() { return "http-v1"; }
export function getPushServiceAccountDiagnostics() { return { ok: true }; }
`,
  "services/email.ts": `
export async function sendEmail(to, name, subject, html) {
  globalThis.__emailCalls = globalThis.__emailCalls || [];
  globalThis.__emailCalls.push({ to, name, subject });
  return { ok: true };
}
export function generateTransactionAlertEmailHtml() { return ""; }
`,
  "services/email-footer.ts": `
export function buildEmailFooterHtml() { return "<footer/>"; }
`,
  "services/notifications.ts": `
export async function createNotification(options) {
  globalThis.__notifCalls = globalThis.__notifCalls || [];
  globalThis.__notifCalls.push(options);
  return { id: "notif-1" };
}
`,
  "services/providers/factory.ts": `
export function getProvider(name) {
  globalThis.__providerRequested = name;
  const impl = globalThis.__providerImpl;
  if (!impl) return { name };
  return { name, refundPayment: impl };
}
export async function resolveProvider() { return { name: "stub" }; }
export function getActiveProviderName() { return "stub"; }
export function getAvailableProviders() { return ["stub"]; }
`,
};

export async function load(url, context, next) {
  let pathname = "";
  try { pathname = new URL(url).pathname; } catch {}
  for (const [suffix, source] of Object.entries(STUBS)) {
    if (pathname.endsWith(suffix)) {
      return { format: "module", source, shortCircuit: true };
    }
  }
  return next(url, context);
}
