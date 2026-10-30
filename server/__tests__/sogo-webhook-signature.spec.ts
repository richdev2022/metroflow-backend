import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

/**
 * SOGO WEBHOOK SIGNATURE — the Swagger-UI debugging session (2026-10-31).
 *
 * The operator executed POST /api/webhook/sogo from Swagger UI and got a
 * bare 401 "Invalid webhook signature" with no way to tell WHICH of these
 * was true:
 *   1. the header value wasn't an HMAC of the body at all (placeholder hex);
 *   2. the header value was a valid HMAC but WITHOUT the documented
 *      "sha256=" prefix — the old verifier compared the full string
 *      "sha256=<hex>" and could therefore NEVER match a bare hex header;
 *   3. the server had NO SOGO_WEBHOOK_SECRET configured — every signature
 *      fails, and the 401 made it look like a client-side mistake.
 *
 * These tests pin the fixed behavior: prefix-optional + case-insensitive
 * verification (timing-safe), and a distinct 503 when the signing secret is
 * not configured so the operator immediately knows it's a server env fix.
 */

vi.mock("../db", () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock("../services/prestmit", () => ({ verifyPrestmitWebhook: vi.fn() }));
vi.mock("../services/notifications", () => ({ createNotification: vi.fn(async () => ({})) }));
vi.mock("../services/providers/bitnob", () => ({}));
vi.mock("../features/personal/personal-utils", () => ({
  creditWallet: vi.fn(async () => ({})),
  insertTransaction: vi.fn(async () => ({})),
}));
vi.mock("../features/personal/flags", () => ({
  getPercent: vi.fn(async (_k: string, fallback: number) => fallback),
}));

import { sogoWebhookHandler } from "../routes/personal-webhooks";
import { verifySogoWebhook, sogoWebhookSecretConfigured } from "../services/sogo";

const SECRET = "whsec_unit_test_123";
const BODY = JSON.stringify({ event: "ping", data: { reference: "ping-1" } });
const BODY_BYTES = Buffer.from(BODY, "utf8");

const sign = (body: Buffer | string = BODY_BYTES, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(body as any).digest("hex");

function makeRes() {
  return {
    statusCode: 0,
    body: null as any,
    status(c: number) { this.statusCode = c; return this; },
    // express: res.json() without a prior res.status() responds 200.
    json(b: any) { if (!this.statusCode) this.statusCode = 200; this.body = b; return this; },
  };
}

function makeReq(raw: Buffer, signature?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-sogo-signature-256"] = signature;
  return { headers, body: JSON.parse(raw.toString("utf8")), rawBody: raw } as any;
}

const OLD_ENV = process.env;

beforeEach(() => {
  process.env = { ...OLD_ENV };
  process.env.SOGO_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  process.env = OLD_ENV;
});

describe("verifySogoWebhook — signature format", () => {
  it("accepts the documented 'sha256=<hex>' form", () => {
    expect(verifySogoWebhook(BODY_BYTES, `sha256=${sign()}`)).toBe(true);
  });

  it("accepts a BARE hex digest (Swagger UI / curl drop the prefix)", () => {
    expect(verifySogoWebhook(BODY_BYTES, sign())).toBe(true);
  });

  it("accepts UPPERCASE hex, with and without the prefix", () => {
    const hex = sign().toUpperCase();
    expect(verifySogoWebhook(BODY_BYTES, hex)).toBe(true);
    expect(verifySogoWebhook(BODY_BYTES, `SHA256=${hex}`)).toBe(true);
  });

  it("accepts surrounding whitespace around the header value", () => {
    expect(verifySogoWebhook(BODY_BYTES, `  ${sign()}  `)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(verifySogoWebhook(BODY_BYTES, sign(BODY_BYTES, "another-secret"))).toBe(false);
  });

  it("rejects a signature computed over different bytes (re-serialized JSON)", () => {
    const other = JSON.stringify({ data: { reference: "ping-1" }, event: "ping" });
    expect(verifySogoWebhook(BODY_BYTES, sign(Buffer.from(other, "utf8")))).toBe(false);
  });

  it("rejects non-hex garbage, short digests and the secret itself", () => {
    expect(verifySogoWebhook(BODY_BYTES, SECRET)).toBe(false);
    expect(verifySogoWebhook(BODY_BYTES, "deadbeef")).toBe(false);
    expect(verifySogoWebhook(BODY_BYTES, "z".repeat(64))).toBe(false);
    expect(verifySogoWebhook(BODY_BYTES, "sha256=not-a-digest")).toBe(false);
  });

  it("rejects a missing signature and a missing secret (fail closed)", () => {
    expect(verifySogoWebhook(BODY_BYTES, "")).toBe(false);
    expect(verifySogoWebhook(BODY_BYTES, null)).toBe(false);
    delete process.env.SOGO_WEBHOOK_SECRET;
    expect(verifySogoWebhook(BODY_BYTES, `sha256=${sign()}`)).toBe(false);
    expect(sogoWebhookSecretConfigured()).toBe(false);
  });
});

describe("sogoWebhookHandler — operator-facing status codes", () => {
  it("200 for a ping signed with the documented 'sha256=' form", async () => {
    const res = makeRes();
    await sogoWebhookHandler(makeReq(BODY_BYTES, `sha256=${sign()}`), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("200 for a ping signed with a BARE hex digest", async () => {
    const res = makeRes();
    await sogoWebhookHandler(makeReq(BODY_BYTES, sign()), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("401 with a clear error for a wrong signature", async () => {
    const res = makeRes();
    await sogoWebhookHandler(makeReq(BODY_BYTES, `sha256=${"ab".repeat(32)}`), res as any);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("Invalid webhook signature");
  });

  it("401 when the signature header is missing entirely", async () => {
    const res = makeRes();
    await sogoWebhookHandler(makeReq(BODY_BYTES, undefined), res as any);
    expect(res.statusCode).toBe(401);
  });

  it("503 with an explicit message when SOGO_WEBHOOK_SECRET is not configured — NOT a misleading 401", async () => {
    delete process.env.SOGO_WEBHOOK_SECRET;
    const res = makeRes();
    await sogoWebhookHandler(makeReq(BODY_BYTES, `sha256=${sign()}`), res as any);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe("Webhook secret not configured");
  });
});
