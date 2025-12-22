import { describe, it, expect, vi, beforeEach } from "vitest";
import { acceptInvite, verifyInviteToken } from "../routes/team";
import { query } from "../db";

// Mock the query function
vi.mock("../db", () => ({
  query: vi.fn(),
}));

describe("acceptInvite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should accept a valid invite", async () => {
    const mockUser = {
      id: "user-id",
      inviteExpiresAt: new Date(Date.now() + 10000).toISOString(),
    };

    (query as any)
      .mockResolvedValueOnce({ rows: [mockUser] }) // SELECT user
      .mockResolvedValueOnce({ rows: [{ id: "user-id" }] }); // UPDATE user

    const req = {
      params: { token: "valid-token" },
      body: { password: "password123" },
    } as any;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    await acceptInvite(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { id: "user-id" },
    });
  });

  it("should reject invalid token", async () => {
    (query as any).mockResolvedValueOnce({ rows: [] });

    const req = {
      params: { token: "invalid-token" },
      body: { password: "password123" },
    } as any;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    await acceptInvite(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Invalid or expired invite token",
    });
  });

  it("should reject expired token", async () => {
    const mockUser = {
      id: "user-id",
      inviteExpiresAt: new Date(Date.now() - 10000).toISOString(),
    };

    (query as any).mockResolvedValueOnce({ rows: [mockUser] });

    const req = {
      params: { token: "expired-token" },
      body: { password: "password123" },
    } as any;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    await acceptInvite(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Invite token has expired",
    });
  });

  it("should reject password too short", async () => {
    const req = {
      params: { token: "valid-token" },
      body: { password: "123" },
    } as any;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    await acceptInvite(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Password must be at least 6 characters",
    });
  });
});

describe("verifyInviteToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should verify a valid token", async () => {
    const mockUser = {
      id: "user-id",
      inviteExpiresAt: new Date(Date.now() + 10000).toISOString(),
    };

    (query as any).mockResolvedValueOnce({ rows: [mockUser] });

    const req = {
      params: { token: "valid-token" },
    } as any;

    const res = {
      json: vi.fn(),
    } as any;

    await verifyInviteToken(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: "Token is valid",
    });
  });

  it("should reject invalid token", async () => {
    (query as any).mockResolvedValueOnce({ rows: [] });

    const req = {
      params: { token: "invalid-token" },
    } as any;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    await verifyInviteToken(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Invalid invitation token",
    });
  });

  it("should reject expired token", async () => {
    const mockUser = {
      id: "user-id",
      inviteExpiresAt: new Date(Date.now() - 10000).toISOString(),
    };

    (query as any).mockResolvedValueOnce({ rows: [mockUser] });

    const req = {
      params: { token: "expired-token" },
    } as any;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    await verifyInviteToken(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Invitation token has expired",
    });
  });

  it("should reject missing token", async () => {
    const req = {
      params: {},
    } as any;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    await verifyInviteToken(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Invite token is missing",
    });
  });
});
