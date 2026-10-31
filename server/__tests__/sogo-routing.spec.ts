import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SOGO PROVIDER ROUTING + WEBHOOK — offline unit tests.
 *
 * Covers the routing layer contract that the frontend depends on:
 *   - default active provider per service = "sogo" (SOGO active by default)
 *   - admin toggle respected (personal_provider_routing setting)
 *   - fail-over when the active provider's env config is missing
 *   - Sogo webhook signature verification (HMAC-SHA256, timing-safe)
 *   - Sogo base-URL auto-routing by key prefix (sandbox vs live)
 *
 * No network access — settings + db are mocked.
 */

vi.mock("../db", () => ({ query: vi.fn(async () => ({ rows: [] })) }));

const settingsMock: Record<string, string> = {};
vi.mock("../services/app-config", () => ({
  getSetting: vi.fn(async (key: string, _fallback: string) => settingsMock[key] ?? ""),
}));

import { query } from "../db";
import {
  ROUTABLE_SERVICES,
  SERVICE_PROVIDERS,
  getActiveProvider,
  isProviderConfigured,
  setActiveProvider,
  getRoutingStatus,
} from "../features/personal/provider-routing";
import { verifySogoWebhook, sogoIdempotencyKey, isSogoSandbox, sogoKeyKind } from "../services/sogo";
import crypto from "crypto";

const OLD_ENV = process.env;

beforeEach(() => {
  process.env = { ...OLD_ENV };
  delete process.env.SOGO_SECRET_KEY;
  delete process.env.SOGO_BASE_URL;
  delete process.env.SOGO_WEBHOOK_SECRET;
  delete process.env.PRESTMIT_API_KEY;
  delete process.env.PRESTMIT_API_SECRET;
  delete process.env.BITNOB_SECRET_KEY;
  delete process.env.BITNOB_CLIENT_ID;
  delete process.env.FLW_SECRET_KEY;
  delete process.env.FLUTTERWAVE_SECRET_KEY;
  for (const k of Object.keys(settingsMock)) delete settingsMock[k];
  (query as any).mockClear?.();
});

describe("provider routing", () => {
  it("exposes the three routable services with sogo available for each", () => {
    expect(ROUTABLE_SERVICES).toEqual(["bills", "giftcards", "crypto", "rmb"]);
    expect(SERVICE_PROVIDERS.bills).toContain("sogo");
    expect(SERVICE_PROVIDERS.giftcards).toEqual(["sogo", "prestmit", "simulator"]);
    expect(SERVICE_PROVIDERS.crypto).toEqual(["sogo", "bitnob", "simulator"]);
  });

  it("defaults EVERY service to sogo (Sogo active by default) when configured", async () => {
    process.env.SOGO_SECRET_KEY = "sogo_sk_test_x";
    for (const svc of ROUTABLE_SERVICES) {
      expect(await getActiveProvider(svc)).toBe("sogo");
    }
  });

  it("respects the admin toggle (personal_provider_routing)", async () => {
    process.env.SOGO_SECRET_KEY = "sogo_sk_test_x";
    settingsMock.personal_provider_routing = JSON.stringify({ crypto: "simulator" });
    expect(await getActiveProvider("crypto")).toBe("simulator");
    expect(await getActiveProvider("bills")).toBe("sogo");
  });

  it("fails over to a configured provider when the active one is unconfigured", async () => {
    // No SOGO key → sogo unconfigured; FLW configured → bills fails over to flutterwave.
    process.env.FLUTTERWAVE_SECRET_KEY = "FLWSECK-xxx";
    expect(await getActiveProvider("bills")).toBe("flutterwave");
    // Nothing configured at all → simulator keeps the product alive.
    expect(await getActiveProvider("giftcards")).toBe("simulator");
    expect(await getActiveProvider("crypto")).toBe("simulator");
  });

  it("isProviderConfigured reflects env truth per provider", () => {
    process.env.SOGO_SECRET_KEY = "sogo_sk_test_x";
    expect(isProviderConfigured("bills", "sogo")).toBe(true);
    expect(isProviderConfigured("giftcards", "sogo")).toBe(true);
    expect(isProviderConfigured("crypto", "bitnob")).toBe(false);
    expect(isProviderConfigured("bills", "simulator")).toBe(true);
  });

  it("setActiveProvider persists through system_settings and validates input", async () => {
    process.env.SOGO_SECRET_KEY = "sogo_sk_test_x";
    await setActiveProvider("giftcards", "prestmit");
    const call = (query as any).mock.calls.find((c: any[]) => String(c[0]).includes("personal_provider_routing"));
    expect(call).toBeTruthy();
    const written = JSON.parse(call[1][0]);
    expect(written.giftcards).toBe("prestmit");
    await expect(setActiveProvider("giftcards" as any, "bitnob" as any)).rejects.toThrow(/supports providers/);
  });

  it("getRoutingStatus returns the full routing table with configured flags", async () => {
    process.env.SOGO_SECRET_KEY = "sogo_sk_test_x";
    const status = await getRoutingStatus();
    expect(status.routing.bills).toBe("sogo");
    expect(status.routing.giftcards).toBe("sogo");
    expect(status.routing.crypto).toBe("sogo");
    for (const svc of ROUTABLE_SERVICES) {
      expect(status.providers[svc].some((p) => p.active && p.id === "sogo")).toBe(true);
    }
  });
});

describe("sogo client config", () => {
  it("auto-routes the base URL by key prefix", () => {
    process.env.SOGO_SECRET_KEY = "sogo_sk_test_abc";
    expect(sogoKeyKind()).toBe("sandbox");
    expect(isSogoSandbox()).toBe(true);

    process.env.SOGO_SECRET_KEY = "sogo_sk_live_abc";
    expect(sogoKeyKind()).toBe("live");
    expect(isSogoSandbox()).toBe(false);
  });

  it("passes caller references through as Idempotency-Keys and UUIDs otherwise", () => {
    expect(sogoIdempotencyKey("MF-BILL-ABC123")).toBe("MF-BILL-ABC123");
    const generated = sogoIdempotencyKey("");
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("verifies webhook signatures (HMAC-SHA256) and rejects forgeries", () => {
    process.env.SOGO_WEBHOOK_SECRET = "whsec_test";
    const body = JSON.stringify({ id: "evt_1", event: "transaction.completed", data: { object: { reference: "MF-BILL-1", status: "completed" } } });
    const sig = "sha256=" + crypto.createHmac("sha256", "whsec_test").update(body).digest("hex");
    expect(verifySogoWebhook(Buffer.from(body), sig)).toBe(true);
    expect(verifySogoWebhook(Buffer.from(body), "sha256=" + "0".repeat(64))).toBe(false);
    expect(verifySogoWebhook(Buffer.from(body), undefined)).toBe(false);
    // No secret configured → fail closed.
    delete process.env.SOGO_WEBHOOK_SECRET;
    expect(verifySogoWebhook(Buffer.from(body), sig)).toBe(false);
  });
});
