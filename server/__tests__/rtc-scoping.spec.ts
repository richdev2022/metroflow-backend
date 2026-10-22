import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCalls } from "../routes/calls";
import { getMeetings } from "../routes/meetings";
import { getRecordings } from "../routes/recordings";
import { getConversationMessages } from "../routes/chat";
import { query } from "../db";

vi.mock("../db", () => ({
  query: vi.fn(),
}));

vi.mock("../services/activity", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../lib/socket", () => ({
  getSocketServer: vi.fn(() => null),
}));

const makeResponse = () =>
  ({
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  }) as any;

const authenticatedRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    user: { businessId: "business-id", userId: "user-id" },
    query: {},
    params: {},
    body: {},
    ...overrides,
  }) as any;

describe("RTC and chat member scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes call history to calls involving the authenticated user", async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await getCalls(authenticatedRequest(), makeResponse(), vi.fn());

    const countSql = (query as any).mock.calls[0][0];
    const listSql = (query as any).mock.calls[1][0];

    expect(countSql).toContain("EXISTS");
    expect(countSql).toContain("call_participants");
    expect((query as any).mock.calls[0][1]).toEqual(["business-id", "user-id"]);
    expect(listSql).toContain("current_cp");
    expect((query as any).mock.calls[1][1]).toEqual(["business-id", "user-id", 10, 0]);
  });

  it("scopes meeting history to meetings involving the authenticated user", async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await getMeetings(authenticatedRequest(), makeResponse(), vi.fn());

    const countSql = (query as any).mock.calls[0][0];
    const listSql = (query as any).mock.calls[1][0];

    expect(countSql).toContain("meeting_attendees");
    expect((query as any).mock.calls[0][1]).toEqual(["business-id", "user-id"]);
    expect(listSql).toContain("current_ma");
    expect((query as any).mock.calls[1][1]).toEqual(["business-id", "user-id", 10, 0]);
  });

  it("scopes recording history through recorder, meeting, or call membership", async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await getRecordings(authenticatedRequest(), makeResponse(), vi.fn());

    const countSql = (query as any).mock.calls[0][0];
    const listSql = (query as any).mock.calls[1][0];

    expect(countSql).toContain("r.recorded_by = $2");
    expect(countSql).toContain("meeting_attendees");
    expect(countSql).toContain("call_participants");
    expect((query as any).mock.calls[0][1]).toEqual(["business-id", "user-id"]);
    expect(listSql).toContain("LEFT JOIN meetings");
    expect((query as any).mock.calls[1][1]).toEqual(["business-id", "user-id", 10, 0]);
  });

  it("does not return messages for conversations outside the user's membership", async () => {
    (query as any).mockResolvedValueOnce({ rows: [] });

    const res = makeResponse();
    await getConversationMessages(
      authenticatedRequest({ params: { conversationId: "conversation-id" } }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Conversation not found",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
