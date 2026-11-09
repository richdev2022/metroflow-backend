import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";

/**
 * GIFT CARDS — TRANSACTION-PIN ENFORCEMENT (money-safety regression).
 *
 * Pre-patch: `POST /giftcards/buy` (and `POST /giftcards/sell`) only ran the
 * KYC gate; the `pin` field the web (client/features/personal/GiftCards.tsx)
 * and mobile (giftcards_screen.dart) clients sent was silently dropped. A
 * hijacked session could drain the wallet buying gift cards without the PIN.
 *
 * Patch: both routes now call `verifyTransactionPin(req.body?.pin, { userId })`
 * — the same helper as /crypto/sell + /bills/pay — and short-circuit with the
 * helper's `code`/`error` when verification fails.
 *
 * These tests pin the money-safety invariant: with the helper rejecting, the
 * routes MUST respond with the helper's `code` (PIN_REQUIRED / PIN_NOT_SET /
 * INVALID_PIN) and MUST NOT proceed to wallet debit / provider trade.
 */

// --- Mocks (must run BEFORE importing the router so the module graph uses them) ---

// vi.hoisted lifts the mock spies ABOVE vi.mock's hoisted factory calls so
// they're already initialized when the factory bodies run.
const { queryMock, verifyTransactionPinMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  verifyTransactionPinMock: vi.fn(),
}));

vi.mock("../db", () => ({ query: queryMock, pool: { connect: vi.fn() } }));

// Auth: bypass JWT and attach a fake user; subscription check is a no-op.
vi.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => {
    _req.user = { userId: "u-1", businessId: "" as any, email: "u@x.test", name: "U" };
    next();
  },
  checkSubscriptionStatus: (_req: any, _res: any, next: any) => next(),
  AuthenticatedRequest: class {},
}));

// Personal helpers: spy on verifyTransactionPin so we can flip its result per
// test. assertPersonalService stays truthful (returns true). requirePersonalKyc
// returns a no-op middleware (KYC presumed verified).
vi.mock("../features/personal/personal-utils", () => ({
  verifyTransactionPin: verifyTransactionPinMock,
  assertPersonalService: vi.fn(async () => true),
  requirePersonalKyc: () => (_req: any, _res: any, next: any) => next(),
  getOwnedWallet: vi.fn(async () => null),
  debitWallet: vi.fn(async () => false),
  creditWallet: vi.fn(async () => ({})),
  insertTransaction: vi.fn(async () => ({})),
  genRef: (p: string) => `${p}-TEST-${Date.now()}`,
}));

vi.mock("../services/fees", () => ({
  calculateFee: vi.fn(),
  creditRevenueWallet: vi.fn(),
}));
vi.mock("../services/prestmit", () => ({
  prestmitErr: (e: any) => String(e?.message || e),
  isPrestmitConfigured: () => false,
  isPrestmitSandbox: () => true,
  prestmitKeyKind: () => "missing",
  prestmitBaseUrl: () => "",
  buyCalculate: vi.fn(),
  buyCheckAvailability: vi.fn(),
}));
vi.mock("../services/sogo", () => ({
  sogoErr: (e: any) => String(e?.message || e),
  isSogoConfigured: () => false,
  isSogoSandbox: () => true,
  sandboxInfo: () => ({ sandbox: true }),
  sogoStatus: () => "processing",
  sogoReference: () => null,
  sogoType: () => "bill_payment",
  giftcardBuyCalculate: vi.fn(),
  giftcardBuy: vi.fn(),
  giftcardSell: vi.fn(),
  giftcardSellCatalog: vi.fn(async () => []),
  giftcardSellRates: vi.fn(async () => []),
  getTransaction: vi.fn(),
}));
vi.mock("../features/personal/user-safe-errors", () => ({ userSafeErr: (e: any) => String(e?.message || e) }));
vi.mock("../features/personal/provider-routing", () => ({
  getActiveProvider: vi.fn(async () => "simulator"),
  isProviderConfigured: () => true,
  setActiveProvider: vi.fn(),
  getRoutingStatus: vi.fn(),
  ROUTABLE_SERVICES: ["bills", "giftcards", "crypto", "rmb"],
  SERVICE_PROVIDERS: { giftcards: ["simulator"] },
}));
vi.mock("../middleware/upload", () => ({
  upload: { array: () => (_req: any, _res: any, next: any) => next(), fields: () => (_req: any, _res: any, next: any) => next(), single: () => (_req: any, _res: any, next: any) => next() },
}));
vi.mock("../services/notifications", () => ({ createNotification: vi.fn() }));
vi.mock("../features/personal/routes/roundup", () => ({ maybeApplyRoundUp: vi.fn() }));

import router from "../features/personal/routes/giftcards";

// --- Minimal Express app + http server helper ---

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use("/", router);
  return app;
}

async function call(app: express.Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  } finally {
    server.close();
  }
}

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every DB query returns empty rows so KYC / schema / wallet probes
  // do not short-circuit the route before the PIN check fires.
  queryMock.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /giftcards/buy — transaction PIN enforcement", () => {
  it("rejects with PIN_REQUIRED when verifyTransactionPin fails (no pin sent)", async () => {
    verifyTransactionPinMock.mockResolvedValueOnce({
      ok: false, code: "PIN_REQUIRED", error: "Transaction PIN is required",
    });
    const r = await call(buildApp(), "POST", "/buy", {
      giftCardSKU: "sku-1", price: 10, quantity: 1,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: "PIN_REQUIRED" });
    // The route MUST have invoked the helper (this is the regression pin).
    expect(verifyTransactionPinMock).toHaveBeenCalledTimes(1);
    expect(verifyTransactionPinMock).toHaveBeenCalledWith(undefined, { userId: "u-1" });
  });

  it("rejects with the helper's code on a wrong PIN (INVALID_PIN)", async () => {
    verifyTransactionPinMock.mockResolvedValueOnce({
      ok: false, code: "INVALID_PIN", error: "Incorrect transaction PIN",
    });
    const r = await call(buildApp(), "POST", "/buy", {
      giftCardSKU: "sku-1", price: 10, pin: "0000",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: "INVALID_PIN" });
    expect(verifyTransactionPinMock).toHaveBeenCalledWith("0000", { userId: "u-1" });
  });

  it("forwards the supplied pin verbatim to the helper", async () => {
    verifyTransactionPinMock.mockResolvedValueOnce({ ok: false, code: "PIN_NOT_SET", error: "x" });
    await call(buildApp(), "POST", "/buy", { giftCardSKU: "s", price: 5, pin: "4829" });
    expect(verifyTransactionPinMock).toHaveBeenLastCalledWith("4829", { userId: "u-1" });
  });
});

describe("POST /giftcards/sell — transaction PIN enforcement", () => {
  it("rejects with PIN_REQUIRED when verifyTransactionPin fails (no pin sent)", async () => {
    verifyTransactionPinMock.mockResolvedValueOnce({
      ok: false, code: "PIN_REQUIRED", error: "Transaction PIN is required",
    });
    const r = await call(buildApp(), "POST", "/sell", {
      giftcard_id: "amazon", amount: 50,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: "PIN_REQUIRED" });
    expect(verifyTransactionPinMock).toHaveBeenCalledTimes(1);
  });
});
