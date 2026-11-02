/**
 * Bitnob sandbox E2E — full virtual-card lifecycle against the Bitnob API.
 *
 * Talks to Bitnob DIRECTLY through the production client
 * (`server/services/providers/bitnob.ts` — the exact module the express
 * feature layer `server/features/personal/virtualcards.ts` uses), so the
 * HMAC signing, paths, micro-units and envelope handling under test are the
 * real integration code. The express server is NOT booted.
 *
 * REQUIRED env (script SKIPS with exit 0 when absent — CI never fails):
 *   BITNOB_CLIENT_ID    dashboard Client ID → `X-Auth-Client` header
 *   BITNOB_SECRET_KEY   HMAC-SHA256 signing secret (legacy alias: BITNOB_API_KEY)
 *
 * OPTIONAL env:
 *   BITNOB_BASE_URL            provider base URL. Default: https://sandboxapi.bitnob.co
 *                              (sandbox default). Set BITNOB_ENV=production (or this var)
 *                              to target https://api.bitnob.com. A trailing "/api" is
 *                              stripped automatically (paths already include /api/...).
 *   BITNOB_ENV                 "production" | "sandbox" (default sandbox here)
 *   BITNOB_ALLOW_INSECURE_TLS  "1" always tolerates TLS errors; on the sandbox host
 *                              (mismatched certificate upstream) insecure is the
 *                              DEFAULT — set "0" to force strict verification.
 *   BITNOB_WEBHOOK_URL         forwarded to card creation, as the feature does
 *   BITNOB_E2E_CUSTOMER_EMAIL  customer email (default bitnob-sandbox-e2e@metricorex.test
 *                              — deterministic, so re-runs reuse the same customer)
 *   BITNOB_E2E_CARD_AMOUNT_USD card creation amount (default 5)
 *   BITNOB_E2E_FUND_AMOUNT_USD fund step amount (default 2)
 *   BITNOB_E2E_RUN_KYC         "1" = also submit POST /api/cards/kyc before creating
 *                              the card (Bitnob may require approved KYC on the
 *                              customer before issuing — the feature gates on it)
 *   BITNOB_E2E_KEEP_CARD       "1" = skip the terminate-card cleanup step
 *
 * Lifecycle exercised (each step logs PASS/FAIL/SKIP with a masked summary):
 *   (a)  GET  /api/balances                    — sanity ping / auth check
 *   (b)  POST /api/customers (+ GET fallback)  — create/ensure card customer
 *        GET  /api/customers/:id               — customer readable
 *   (c)  POST /api/cards/kyc                   — optional, only with BITNOB_E2E_RUN_KYC=1
 *   (d)  POST /api/cards                       — create USD virtual card
 *   (e)  POST /api/cards/:id/balance           — fund (type: "fund", micro-units)
 *   (f)  GET  /api/cards/:id                   — card details + balance
 *   (g)  POST /api/cards/:id/status (frozen)   — freeze
 *        POST /api/cards/:id/status (active)   — unfreeze (re-verified via (f))
 *   (h)  GET  /api/cards/:id/transactions      — list card transactions
 *   (i)  DELETE /api/cards/:id                 — terminate (cleanup, best-effort even
 *                                                 when earlier steps fail)
 *   GET /api/cards/:id/secure exists in the integration but is intentionally NOT
 *   called here (it returns full card credentials — never logged by this script).
 *
 * Sandbox quirks handled: 2xx envelopes may be `{status:true,data:…}` (classic)
 * or `{success:true,data:…}` (newer) — both parsed; a 2xx body with
 * `status:false` / `success:false` is treated as a failure.
 *
 * Run: pnpm test:bitnob-sandbox   (tsx scripts/bitnob-sandbox-e2e.ts)
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(HERE, "..", ".env") });

type StepState = "PASS" | "FAIL" | "SKIP";
const results: { step: string; state: StepState; detail: string }[] = [];

function step(name: string, state: StepState, detail = "") {
  results.push({ step: name, state, detail });
  console.log(`${state} — ${name}${detail ? ` :: ${detail}` : ""}`);
}

/** Never print secrets/PANs: truncate + mask long digit runs. */
function brief(value: any): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value ?? {});
  } catch {
    s = String(value);
  }
  return s.replace(/\d{9,}/g, (m) => `${m.slice(0, 4)}***`).slice(0, 300);
}

/** Whitelisted-field summary of a response object (defends against unknown shapes). */
function summarize(obj: any, fields: string[]): string {
  if (obj == null || typeof obj !== "object") return brief(obj);
  const picked: Record<string, any> = {};
  for (const f of fields) {
    const v = f.split(".").reduce((acc: any, k: string) => (acc == null ? acc : acc[k]), obj);
    if (v !== undefined && v !== null) picked[f.replace(/\./g, "_")] = v;
  }
  return brief(picked);
}

/** Bitnob envelopes: `{status:true,data}` (classic) or `{success:true,data}` (newer). */
function envelopeOk(env: any): boolean {
  if (env == null || typeof env !== "object") return false;
  return env.success !== false && env.status !== false;
}

function pickData(env: any): any {
  if (env && typeof env === "object" && "data" in env) return env.data;
  return env;
}

function errSummary(e: any): string {
  const status = e?.status ?? e?.response?.status;
  const body = e?.payload ?? e?.response?.data ?? e?.message;
  return `HTTP ${status ?? "?"} ${brief(body)}`;
}

async function main() {
  // ---- 1. Config + CI-safe skip -------------------------------------------------
  const clientId = process.env.BITNOB_CLIENT_ID || "";
  const secretKey = process.env.BITNOB_SECRET_KEY || process.env.BITNOB_API_KEY || "";
  const missing: string[] = [];
  if (!clientId) missing.push("BITNOB_CLIENT_ID");
  if (!secretKey) missing.push("BITNOB_SECRET_KEY (or legacy BITNOB_API_KEY)");
  if (missing.length) {
    console.log(
      `skipped: missing env (${missing.join(", ")}) — Bitnob sandbox E2E needs Bitnob credentials; nothing was run (CI-safe, exit 0)`,
    );
    return;
  }

  // Sandbox by default; BITNOB_ENV=production or an explicit BITNOB_BASE_URL wins.
  const prodDefault = process.env.BITNOB_ENV === "production";
  const baseUrl = (process.env.BITNOB_BASE_URL || (prodDefault ? "https://api.bitnob.com" : "https://sandboxapi.bitnob.co"))
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");
  // The provider client computes BASE_URL from env at import time — set it here.
  process.env.BITNOB_BASE_URL = baseUrl;
  const isSandbox = !/api\.bitnob\.com$/.test(baseUrl);
  // Sandbox host serves a mismatched TLS certificate upstream (see
  // INTEGRATIONS_ENV.md) — tolerate it by default on sandbox, like
  // BITNOB_ALLOW_INSECURE_TLS=1 does for the axios client.
  const allowInsecure = process.env.BITNOB_ALLOW_INSECURE_TLS === "1" || (isSandbox && process.env.BITNOB_ALLOW_INSECURE_TLS !== "0");
  if (allowInsecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const customerEmail = process.env.BITNOB_E2E_CUSTOMER_EMAIL || "bitnob-sandbox-e2e@metricorex.test";
  const cardUsd = Number(process.env.BITNOB_E2E_CARD_AMOUNT_USD || 5) || 5;
  const fundUsd = Number(process.env.BITNOB_E2E_FUND_AMOUNT_USD || 2) || 2;
  const runKyc = process.env.BITNOB_E2E_RUN_KYC === "1";
  const keepCard = process.env.BITNOB_E2E_KEEP_CARD === "1";
  const webhookUrl = process.env.BITNOB_WEBHOOK_URL || undefined;

  console.log(
    `bitnob sandbox e2e — base=${baseUrl} sandbox=${isSandbox} tls_strict=${!allowInsecure} ` +
      `client=${clientId.slice(0, 6)}… key=${secretKey.slice(0, 6)}……${secretKey.slice(-4)} run=${runId}`,
  );

  // Import AFTER env defaulting: the provider client reads BITNOB_BASE_URL at module load.
  const bitnob = await import("../server/services/providers/bitnob");

  // ---- 2. Cleanup bookkeeping (card is always terminated, even on failure) ------
  let customerId: string | null = null;
  let cardId: string | null = null;
  let terminateAttempted = false;

  async function terminateCleanup(trigger: string) {
    if (!cardId || terminateAttempted || keepCard) return;
    terminateAttempted = true;
    const t0 = Date.now();
    try {
      const res = await bitnob.terminateCard(cardId, "e2e-cleanup");
      if (!envelopeOk(res)) throw new Error(`envelope not ok: ${brief(res)}`);
      step("terminate card (cleanup)", "PASS", `trigger=${trigger} card=${cardId} ${Date.now() - t0}ms ${summarize(pickData(res), ["card.status", "status", "message"])}`);
    } catch (e: any) {
      step("terminate card (cleanup)", "FAIL", `trigger=${trigger} ${errSummary(e)}`);
    }
  }

  // `lifecycle:` label — the sanity step can abort the run with `break`, which
  // still executes the finally (terminate/cleanup reporting) and, unlike a
  // return, keeps control flowing into the summary + exit-code block below.
  lifecycle: try {
    // ---- (a) Sanity ping: GET /api/balances ------------------------------------
    {
      const t0 = Date.now();
      try {
        const res = await bitnob.getBalances();
        if (!envelopeOk(res)) throw new Error(`envelope not ok: ${brief(res)}`);
        const data = pickData(res);
        const rows = Array.isArray(data) ? data : data?.balances || data?.data || data?.content;
        const currencies = Array.isArray(rows) ? rows.map((b: any) => b?.currency || b?.asset).filter(Boolean) : null;
        step(
          "sanity: GET /api/balances",
          "PASS",
          `${Date.now() - t0}ms ${currencies?.length ? `currencies=${currencies.join(",")}` : brief(data)}`,
        );
      } catch (e: any) {
        step("sanity: GET /api/balances", "FAIL", errSummary(e));
        if (/whitelist/i.test(String(e?.payload?.detail || e?.payload?.message || e?.message))) {
          console.log("hint: whitelist this machine's egress IP in the Bitnob dashboard (API Keys → IP whitelist), see INTEGRATIONS_ENV.md");
        }
        for (const name of ["create/ensure customer", "card KYC (optional)", "create USD virtual card", "fund card", "card details", "freeze card", "unfreeze card", "card transactions"]) {
          step(name, "SKIP", "aborted: provider unreachable (sanity ping failed)");
        }
        break lifecycle; // finally below still runs — summary + exit code still printed
      }
    }

    // ---- (b) Create/ensure card customer ---------------------------------------
    {
      const t0 = Date.now();
      try {
        const res = await bitnob.createCustomer({
          email: customerEmail,
          first_name: "E2E",
          last_name: `Sandbox ${runId}`,
          customer_type: "individual",
          reference: `E2ECUST_${runId}`,
        });
        if (!envelopeOk(res)) throw new Error(`envelope not ok: ${brief(res)}`);
        customerId = pickData(res)?.id || pickData(res)?.customer_id || null;
        step("create/ensure customer", "PASS", `${Date.now() - t0}ms ${summarize(pickData(res), ["id", "email", "status"])}`);
      } catch (e: any) {
        // Customer may already exist (deterministic email) — list by email, like
        // getBitnobCustomerId() does in the feature layer.
        try {
          const list = pickData(await bitnob.listCustomers({ email: customerEmail }));
          const found = list?.customers?.[0] || (Array.isArray(list) ? list[0] : null) || list?.content?.[0] || null;
          if (found?.id) {
            customerId = found.id;
            step("create/ensure customer", "PASS", `${Date.now() - t0}ms already exists id=${customerId} email=${customerEmail}`);
          } else {
            step("create/ensure customer", "FAIL", errSummary(e));
          }
        } catch (e2: any) {
          step("create/ensure customer", "FAIL", `${errSummary(e)} | list-fallback: ${errSummary(e2)}`);
        }
      }
    }

    // ---- (c) Optional card KYC (POST /api/cards/kyc) ---------------------------
    if (runKyc) {
      const t0 = Date.now();
      try {
        const res = await bitnob.submitCardKyc({
          customer: { email: customerEmail, first_name: "E2E", last_name: "Sandbox" },
          id_type: process.env.BITNOB_E2E_KYC_ID_TYPE || "nin",
          id_number: process.env.BITNOB_E2E_KYC_ID_NUMBER || String(10000000000 + (Date.now() % 8999999999)),
          occupation: "software_engineer",
          employment_status: "employed",
          account_purpose: "other",
          annual_salary: "60000",
          expected_monthly_volume: "5000",
          terms_of_service_accepted: true,
          webhook_url: webhookUrl,
        });
        if (!envelopeOk(res)) throw new Error(`envelope not ok: ${brief(res)}`);
        const kdata = pickData(res);
        customerId = kdata?.customer_id || kdata?.id || customerId;
        step("card KYC (optional)", "PASS", `${Date.now() - t0}ms customer=${customerId || "?"} ${summarize(kdata, ["status", "normalized_status", "completion_link"])}`);
      } catch (e: any) {
        step("card KYC (optional)", "FAIL", `${errSummary(e)} — card creation may be rejected without approved KYC`);
      }
    } else {
      step("card KYC (optional)", "SKIP", "not requested — set BITNOB_E2E_RUN_KYC=1 to submit POST /api/cards/kyc");
    }

    // ---- (d) Create USD virtual card -------------------------------------------
    {
      const t0 = Date.now();
      if (!customerId) {
        step("create USD virtual card", "SKIP", "no customer id (previous step failed)");
      } else {
        try {
          const res = await bitnob.createCard({
            customer_id: customerId,
            amount: bitnob.toMicros(cardUsd),
            currency: "USD",
            card_brand: "visa",
            name: `E2E Sandbox ${runId}`,
            contactless_payment: false,
            reference: `E2ECARD_${runId}`,
            webhook_url: webhookUrl,
          });
          if (!envelopeOk(res)) throw new Error(`envelope not ok: ${brief(res)}`);
          const card = pickData(res)?.card || pickData(res) || {};
          cardId = card?.id || card?.card_id || null;
          step("create USD virtual card", cardId ? "PASS" : "FAIL", `${Date.now() - t0}ms ${summarize(card, ["id", "status", "created_status", "masked_pan", "currency"])}`);
        } catch (e: any) {
          step("create USD virtual card", "FAIL", errSummary(e));
          if (/kyc|verif|identity/i.test(String(e?.payload?.message || e?.message))) {
            console.log("hint: provider wants approved KYC on the customer — re-run with BITNOB_E2E_RUN_KYC=1 (sandbox) or complete KYC in the dashboard");
          }
        }
      }
    }

    // ---- (e) Fund card (POST /api/cards/:id/balance, type "fund") --------------
    {
      const t0 = Date.now();
      if (!cardId) {
        step("fund card", "SKIP", "no card id (create failed)");
      } else {
        try {
          const res = await bitnob.fundOrWithdrawCard(cardId, {
            amount: bitnob.toMicros(fundUsd),
            type: "fund",
            reference: `E2EFUND_${runId}`,
          });
          if (!envelopeOk(res)) throw new Error(`envelope not ok: ${brief(res)}`);
          const tx = pickData(res)?.transaction;
          step("fund card", "PASS", `${Date.now() - t0}ms amount=+$${fundUsd.toFixed(2)} ${summarize(tx, ["id", "status", "amount"])}`);
        } catch (e: any) {
          step("fund card", "FAIL", errSummary(e));
        }
      }
    }

    // ---- (f) Fetch card details (GET /api/cards/:id) ---------------------------
    let liveStatus: string | null = null;
    {
      const t0 = Date.now();
      if (!cardId) {
        step("card details", "SKIP", "no card id (create failed)");
      } else {
        try {
          const res = await bitnob.getCard(cardId);
          if (!envelopeOk(res)) throw new Error(`envelope not ok: ${brief(res)}`);
          const card = pickData(res)?.card || pickData(res) || {};
          liveStatus = card?.status ?? null;
          const balanceUsd = bitnob.fromMicros(card?.balance_amount ?? "0");
          step(
            "card details",
            "PASS",
            `${Date.now() - t0}ms ${summarize(card, ["id", "status", "created_status", "masked_pan", "currency", "card_brand"])} balance_usd=${balanceUsd}`,
          );
        } catch (e: any) {
          step("card details", "FAIL", errSummary(e));
        }
      }
    }

    // ---- (f2) Freeze then unfreeze (POST /api/cards/:id/status) ----------------
    for (const next of ["frozen", "active"] as const) {
      const t0 = Date.now();
      const label = next === "frozen" ? "freeze card" : "unfreeze card";
      if (!cardId) {
        step(label, "SKIP", "no card id (create failed)");
        continue;
      }
      try {
        const res = await bitnob.setCardStatus(cardId, next);
        if (!envelopeOk(res)) throw new Error(`envelope not ok: ${brief(res)}`);
        let detail = `${Date.now() - t0}ms status→${next}`;
        if (next === "active") {
          try {
            const check = pickData(await bitnob.getCard(cardId));
            const card = check?.card || check || {};
            detail += ` verified=${card?.status ?? "?"}${liveStatus && card?.status && card.status !== liveStatus ? ` (was ${liveStatus})` : ""}`;
          } catch {
            detail += " (verify read failed — op envelope was ok)";
          }
        }
        step(label, "PASS", detail);
      } catch (e: any) {
        step(label, "FAIL", errSummary(e));
      }
    }

    // ---- (g) Card transactions (GET /api/cards/:id/transactions) ---------------
    {
      const t0 = Date.now();
      if (!cardId) {
        step("card transactions", "SKIP", "no card id (create failed)");
      } else {
        try {
          const res = await bitnob.getCardTransactions(cardId);
          if (!envelopeOk(res)) throw new Error(`envelope not ok: ${brief(res)}`);
          const data = pickData(res);
          const rows = Array.isArray(data) ? data : data?.transactions || data?.data || data?.content || [];
          step(
            "card transactions",
            "PASS",
            `${Date.now() - t0}ms count=${rows.length}${rows.length ? ` first=${summarize(rows[0], ["id", "type", "status", "amount"])}` : ""}${data?.cursor ? ` cursor=${data.cursor}` : ""}`,
          );
        } catch (e: any) {
          step("card transactions", "FAIL", errSummary(e));
        }
      }
    }
  } finally {
    // ---- (h) Terminate card (cleanup) — best-effort even after failures --------
    if (keepCard && cardId) {
      step("terminate card (cleanup)", "SKIP", `BITNOB_E2E_KEEP_CARD=1 — card ${cardId} left alive`);
    } else if (!cardId) {
      step("terminate card (cleanup)", "SKIP", "no card id (create failed)");
    } else {
      await terminateCleanup("lifecycle-end");
    }
  }

  // ---- 3. Summary ----------------------------------------------------------------
  console.log("\n== Bitnob sandbox E2E summary ==");
  for (const r of results) console.log(`${r.state} — ${r.step}${r.detail ? ` :: ${r.detail}` : ""}`);
  const fails = results.filter((r) => r.state === "FAIL").length;
  const passes = results.filter((r) => r.state === "PASS").length;
  const skips = results.filter((r) => r.state === "SKIP").length;
  console.log(`OVERALL: ${fails ? "FAIL" : "PASS"} (${passes} pass, ${fails} fail, ${skips} skipped) — base=${baseUrl} run=${runId}`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("BITNOB-SANDBOX-E2E CRASHED:", e?.message || e);
  process.exit(1);
});
