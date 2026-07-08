import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkFeaturePermission, normalizePlanPermissions } from "../middleware/auth";
import { query } from "../db";

vi.mock("../db", () => ({
  query: vi.fn(),
}));

describe("normalizePlanPermissions", () => {
  it("normalizes plan access from permissions and features", () => {
    const permissions = normalizePlanPermissions(
      ["manage_tasks", { id: "use_chat" }],
      JSON.stringify([{ slug: "use_calls" }, { name: "Use Meetings" }]),
      "Export Data"
    );

    expect(permissions.has("manage_tasks")).toBe(true);
    expect(permissions.has("use_chat")).toBe(true);
    expect(permissions.has("use_calls")).toBe(true);
    expect(permissions.has("use_meetings")).toBe(true);
    expect(permissions.has("export_data")).toBe(true);
  });

  it("supports comma-separated permissions", () => {
    const permissions = normalizePlanPermissions("manage_finance, view_ranking");

    expect(permissions.has("manage_finance")).toBe(true);
    expect(permissions.has("view_ranking")).toBe(true);
  });
});

describe("checkFeaturePermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeResponse = () =>
    ({
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }) as any;

  it("allows access when the business plan grants the feature through permissions", async () => {
    (query as any).mockResolvedValueOnce({
      rows: [{ permissions: ["use_chat"], features: [] }],
    });

    const req = { user: { businessId: "business-id" } } as any;
    const res = makeResponse();
    const next = vi.fn();

    await checkFeaturePermission("use_chat")(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows access when the admin UI stores the grant in features", async () => {
    (query as any).mockResolvedValueOnce({
      rows: [{ permissions: [], features: [{ name: "Use Calls" }] }],
    });

    const req = { user: { businessId: "business-id" } } as any;
    const res = makeResponse();
    const next = vi.fn();

    await checkFeaturePermission("use_calls")(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks access when the plan does not grant the feature", async () => {
    (query as any).mockResolvedValueOnce({
      rows: [{ permissions: ["manage_tasks"], features: [] }],
    });

    const req = { user: { businessId: "business-id" } } as any;
    const res = makeResponse();
    const next = vi.fn();

    await checkFeaturePermission("use_calls")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Kindly upgrade your plan to enjoy this feature.",
    });
  });
});
