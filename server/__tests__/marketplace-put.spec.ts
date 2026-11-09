import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";

/**
 * MARKETPLACE PUT — image merge regression.
 *
 * Pre-patch: `PUT /store/marketplace/:id` did NOT accept multipart form data
 * and never touched the `images` JSONB column. Sellers on mobile had to
 * delete + re-create a listing just to change photos.
 *
 * Patch: the PUT route now uses the same `marketUpload` multer middleware as
 * POST (fields `images` | `media`, ≤10 each). On edit:
 *   · new uploads are normalized to image URLs via `uploadMediaBuffer` and
 *     appended to the existing `images` array (de-duplicated, capped at 10);
 *   · `req.body.remove_images` (JSON array of URLs, as a parsed array OR a
 *     JSON-encoded string for multipart) is subtracted FIRST;
 *   · the `images` column is written ONLY when files were uploaded OR
 *     remove_images was provided — the legacy text-only edit path stays
 *     byte-for-byte identical (no images column in the UPDATE).
 *
 * These tests pin the merge + the "no images write when nothing changed"
 * invariant using JSON bodies (the remove_images path needs no multipart).
 */

const { queryMock, uploadMediaBufferMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  uploadMediaBufferMock: vi.fn(),
}));

vi.mock("../db", () => ({ query: queryMock, pool: { connect: vi.fn() } }));

// Auth: bypass JWT and attach a fake user; subscription check is a no-op.
vi.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => {
    _req.user = { userId: "seller-1", businessId: "" as any, email: "s@x.test", name: "S" };
    next();
  },
  checkSubscriptionStatus: (_req: any, _res: any, next: any) => next(),
  AuthenticatedRequest: class {},
}));

vi.mock("../features/personal/personal-utils", () => ({
  verifyTransactionPin: vi.fn(),
  assertPersonalService: vi.fn(async () => true),
  requirePersonalKyc: () => (_req: any, _res: any, next: any) => next(),
  getOwnedWallet: vi.fn(),
  debitWallet: vi.fn(),
  creditWallet: vi.fn(),
  insertTransaction: vi.fn(),
  genRef: (p: string) => `${p}-TEST`,
}));
vi.mock("../services/fees", () => ({ calculateFee: vi.fn(), creditRevenueWallet: vi.fn() }));
vi.mock("../services/media-upload", () => ({ uploadMediaBuffer: uploadMediaBufferMock }));
// multer is a no-op pass-through; the tests exercise the JSON-only path.
vi.mock("../middleware/upload", () => ({
  upload: {
    fields: () => (_req: any, _res: any, next: any) => { _req.files = []; next(); },
    array: () => (_req: any, _res: any, next: any) => next(),
    single: () => (_req: any, _res: any, next: any) => next(),
  },
}));
vi.mock("../services/notifications", () => ({ createNotification: vi.fn() }));
vi.mock("../features/personal/routes/social", () => ({
  getBoostPricing: vi.fn(),
  estimateReach: vi.fn(),
  getActiveBoostMap: vi.fn(async () => new Map()),
}));
vi.mock("../features/personal/routes/roundup", () => ({ maybeApplyRoundUp: vi.fn() }));

import router from "../features/personal/routes/marketplace";

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

/** SQL/param pairs captured by the db mock. */
type SqlCall = { sql: string; params: any[] };
function captureSql(): SqlCall[] {
  const calls: SqlCall[] = [];
  queryMock.mockImplementation(async (sql: string, params?: any[]) => {
    calls.push({ sql, params: params || [] });
    return { rows: [], rowCount: 0 };
  });
  return calls;
}

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PUT /:id — text-only edit (no regression)", () => {
  it("returns 200 and does NOT touch the images column when no files / no remove_images", async () => {
    // Ownership probe returns one row.
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ id: "l-1", images: ["https://x/a.png", "https://x/b.png"] }],
      rowCount: 1,
    }));
    // UPDATE returns nothing.
    queryMock.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    const r = await call(buildApp(), "PUT", "/l-1", {
      name: "New name", price: 2500,
    });

    expect(r.status).toBe(200);
    // Find the UPDATE call.
    const calls = queryMock.mock.calls.map(([sql, p]: any) => ({ sql, params: p }));
    const updateCall = calls.find((c: any) => /UPDATE market_listings/i.test(c.sql));
    expect(updateCall).toBeTruthy();
    // CRITICAL: the images column is NOT in the SET clause.
    expect(/images\s*=\s*\$/.test(updateCall!.sql)).toBe(false);
    // The existing images are echoed back in the response data.
    expect(r.body).toMatchObject({ success: true, data: { images: ["https://x/a.png", "https://x/b.png"] } });
  });
});

describe("PUT /:id — remove_images subtracts URLs from the listing", () => {
  it("writes images = existing − remove_images (JSON array body)", async () => {
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ id: "l-2", images: ["https://x/a.png", "https://x/b.png", "https://x/c.png"] }],
      rowCount: 1,
    }));
    const calls = captureSql();

    const r = await call(buildApp(), "PUT", "/l-2", {
      name: "Edited",
      remove_images: ["https://x/a.png", "https://x/b.png"],
    });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      success: true,
      data: { images: ["https://x/c.png"] },
    });

    const updateCall = calls.find((c) => /UPDATE market_listings/i.test(c.sql));
    expect(updateCall).toBeTruthy();
    // CRITICAL: the images column IS in the SET clause this time.
    expect(/images\s*=\s*\$\d+::jsonb/.test(updateCall!.sql)).toBe(true);
    // The merged payload (one remaining URL) is the LAST bound param.
    const lastParam = updateCall!.params[updateCall!.params.length - 1];
    expect(lastParam).toBe(JSON.stringify(["https://x/c.png"]));
  });

  it("accepts remove_images as a JSON-encoded string (multipart shape)", async () => {
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ id: "l-3", images: ["https://x/keep.png", "https://x/drop.png"] }],
      rowCount: 1,
    }));
    const calls = captureSql();

    const r = await call(buildApp(), "PUT", "/l-3", {
      remove_images: JSON.stringify(["https://x/drop.png"]),
    });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, data: { images: ["https://x/keep.png"] } });
    const updateCall = calls.find((c) => /UPDATE market_listings/i.test(c.sql));
    expect(/images\s*=\s*\$\d+::jsonb/.test(updateCall!.sql)).toBe(true);
    const lastParam = updateCall!.params[updateCall!.params.length - 1];
    expect(lastParam).toBe(JSON.stringify(["https://x/keep.png"]));
  });

  it("silently ignores a malformed remove_images payload (no images column write)", async () => {
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ id: "l-4", images: ["https://x/a.png"] }],
      rowCount: 1,
    }));
    const calls = captureSql();

    const r = await call(buildApp(), "PUT", "/l-4", {
      remove_images: "not-json{",
    });

    expect(r.status).toBe(200);
    const updateCall = calls.find((c) => /UPDATE market_listings/i.test(c.sql));
    expect(updateCall).toBeTruthy();
    // Malformed payload → shouldWriteImages stays false → no images clause.
    expect(/images\s*=\s*\$/.test(updateCall!.sql)).toBe(false);
  });
});

describe("PUT /:id — not found / not owned", () => {
  it("returns 404 when the seller does not own the listing", async () => {
    queryMock.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    const r = await call(buildApp(), "PUT", "/someone-elses", { name: "x" });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, error: /not yours/i });
  });
});
