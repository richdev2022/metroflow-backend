import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  editMessage,
  deleteMessage,
  sendMessage,
  getParticipants,
  BLOCK_ERROR_BLOCKED,
  BLOCK_ERROR_BLOCKER,
} from "../routes/chat";
import { blockUser, listBlocked } from "../routes/blocks";
import { query } from "../db";

vi.mock("../db", () => ({
  query: vi.fn(),
}));

const emit = vi.fn();
const to = vi.fn(() => ({ emit }));

vi.mock("../lib/socket", () => ({
  getSocketServer: vi.fn(() => ({ to, emit })),
}));

vi.mock("../services/activity", () => ({
  logActivity: vi.fn(),
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

// Standard query mock sequences used by every message-level handler:
// 1) membership check, 2) message lookup.
const mockMembership = () => (query as any).mockResolvedValueOnce({ rows: [{ id: "conv-1" }] });

describe("editMessage permission rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseMessage = (overrides: Record<string, unknown> = {}) => ({
    id: "message-1",
    conversationId: "conv-1",
    senderId: "user-id",
    content: "hello",
    messageType: "text",
    createdAt: new Date(),
    editedAt: null,
    deletedForEveryone: false,
    senderName: "Requester",
    ...overrides,
  });

  it("rejects edits from anyone who is not the sender (403)", async () => {
    mockMembership();
    (query as any).mockResolvedValueOnce({
      rows: [baseMessage({ senderId: "someone-else" })],
    });

    const res = makeResponse();
    await editMessage(
      authenticatedRequest({
        params: { conversationId: "conv-1", messageId: "message-1" },
        body: { content: "edited" },
      }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Only the sender can edit this message" });
  });

  it("rejects edits older than 24 hours (403)", async () => {
    mockMembership();
    (query as any).mockResolvedValueOnce({
      rows: [baseMessage({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })],
    });

    const res = makeResponse();
    await editMessage(
      authenticatedRequest({
        params: { conversationId: "conv-1", messageId: "message-1" },
        body: { content: "edited" },
      }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Messages can only be edited within 24 hours",
    });
  });

  it("rejects edits of call-log messages (403)", async () => {
    mockMembership();
    (query as any).mockResolvedValueOnce({
      rows: [baseMessage({ messageType: "call-log" })],
    });

    const res = makeResponse();
    await editMessage(
      authenticatedRequest({
        params: { conversationId: "conv-1", messageId: "message-1" },
        body: { content: "edited" },
      }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Call log messages cannot be edited" });
  });

  it("edits within the window and broadcasts message:updated", async () => {
    mockMembership();
    (query as any).mockResolvedValueOnce({ rows: [baseMessage()] });
    (query as any).mockResolvedValueOnce({
      rows: [
        baseMessage({
          content: "edited text",
          editedAt: new Date(),
        }),
      ],
    });

    const res = makeResponse();
    await editMessage(
      authenticatedRequest({
        params: { conversationId: "conv-1", messageId: "message-1" },
        body: { content: "  edited text  " },
      }),
      res,
      vi.fn(),
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(to).toHaveBeenCalledWith("conversation:conv-1");
    expect(emit).toHaveBeenCalledWith(
      "message:updated",
      expect.objectContaining({
        conversationId: "conv-1",
        message: expect.objectContaining({ content: "edited text" }),
      }),
    );
    const updateSql = (query as any).mock.calls[2][0];
    expect(updateSql).toContain("edited_at = CURRENT_TIMESTAMP");
  });
});

describe("deleteMessage scopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseMessage = (overrides: Record<string, unknown> = {}) => ({
    id: "message-1",
    conversationId: "conv-1",
    senderId: "user-id",
    content: "hello",
    messageType: "text",
    createdAt: new Date(),
    deletedForEveryone: false,
    senderName: "Requester",
    ...overrides,
  });

  it("refuses delete-for-everyone from non-senders (403)", async () => {
    mockMembership();
    (query as any).mockResolvedValueOnce({
      rows: [baseMessage({ senderId: "someone-else" })],
    });

    const res = makeResponse();
    await deleteMessage(
      authenticatedRequest({
        params: { conversationId: "conv-1", messageId: "message-1" },
        query: { scope: "everyone" },
      }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Only the sender can delete this message for everyone",
    });
  });

  it("refuses delete-for-everyone on call-log messages (403)", async () => {
    mockMembership();
    (query as any).mockResolvedValueOnce({
      rows: [baseMessage({ messageType: "call-log" })],
    });

    const res = makeResponse();
    await deleteMessage(
      authenticatedRequest({
        params: { conversationId: "conv-1", messageId: "message-1" },
        query: { scope: "everyone" },
      }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Call log messages cannot be deleted for everyone",
    });
  });

  it("tombstones for everyone and broadcasts message:updated", async () => {
    mockMembership();
    (query as any).mockResolvedValueOnce({ rows: [baseMessage()] });
    (query as any).mockResolvedValueOnce({
      rows: [baseMessage({ content: null, deletedForEveryone: true })],
    });

    const res = makeResponse();
    await deleteMessage(
      authenticatedRequest({
        params: { conversationId: "conv-1", messageId: "message-1" },
        query: { scope: "everyone" },
      }),
      res,
      vi.fn(),
    );

    const updateSql = (query as any).mock.calls[2][0];
    expect(updateSql).toContain("deleted_for_everyone = TRUE");
    expect(updateSql).toContain("content = NULL");
    expect(emit).toHaveBeenCalledWith(
      "message:updated",
      expect.objectContaining({
        conversationId: "conv-1",
        message: expect.objectContaining({ deletedForEveryone: true, content: null }),
      }),
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("delete-for-me appends the requester without broadcasting", async () => {
    mockMembership();
    (query as any).mockResolvedValueOnce({ rows: [baseMessage()] });
    (query as any).mockResolvedValueOnce({ rows: [] });

    const res = makeResponse();
    await deleteMessage(
      authenticatedRequest({
        params: { conversationId: "conv-1", messageId: "message-1" },
        query: { scope: "me" },
      }),
      res,
      vi.fn(),
    );

    const updateSql = (query as any).mock.calls[2][0];
    expect(updateSql).toContain("ARRAY_APPEND");
    expect(updateSql).toContain("deleted_for");
    // No broadcast for scope=me
    expect(emit).not.toHaveBeenCalledWith("message:updated", expect.anything());
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { id: "message-1", conversationId: "conv-1", deletedForMe: true },
    });
  });
});

describe("block enforcement on sendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sendMessageRequest = (overrides: Record<string, unknown> = {}) =>
    authenticatedRequest({
      params: { conversationId: "conv-1" },
      body: { content: "hello there" },
      ...overrides,
    });

  it("blocks the blocker with a specific error", async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ id: "conv-1" }] }) // membership
      .mockResolvedValueOnce({ rows: [{ type: "direct", userId: "other-id" }] }) // other participant
      .mockResolvedValueOnce({ rows: [{ blockerId: "user-id" }] }); // requester blocked the contact

    const res = makeResponse();
    await sendMessage(sendMessageRequest(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: BLOCK_ERROR_BLOCKER });
    expect((query as any).mock.calls[2][0]).toContain("user_blocks");
  });

  it("blocks the blocked party with a specific error", async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ id: "conv-1" }] })
      .mockResolvedValueOnce({ rows: [{ type: "direct", userId: "other-id" }] })
      .mockResolvedValueOnce({ rows: [{ blockerId: "other-id" }] }); // contact blocked the requester

    const res = makeResponse();
    await sendMessage(sendMessageRequest(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: BLOCK_ERROR_BLOCKED });
  });

  it("does not enforce blocks on group conversations", async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ id: "conv-1" }] })
      .mockResolvedValueOnce({ rows: [{ type: "group", userId: "other-id" }] })
      // sendMessage continues: message insert
      .mockResolvedValueOnce({
        rows: [{ id: "message-1", conversationId: "conv-1", senderId: "user-id", createdAt: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [{ name: "Requester" }] })
      .mockResolvedValueOnce({ rows: [] }) // conversation updated_at
      .mockResolvedValueOnce({ rows: [] }) // last_read_at
      .mockResolvedValueOnce({ rows: [{ userId: "other-id" }] }) // participants
      .mockResolvedValueOnce({ rows: [{ name: null, type: "group" }] }); // notification payload

    const res = makeResponse();
    await sendMessage(sendMessageRequest(), res, vi.fn());

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("rejects replyToId pointing at a message in another conversation (400)", async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ id: "conv-1" }] })
      .mockResolvedValueOnce({ rows: [{ type: "direct", userId: "other-id" }] })
      .mockResolvedValueOnce({ rows: [] }) // no block either way
      .mockResolvedValueOnce({ rows: [] }); // replyToId not in this conversation

    const res = makeResponse();
    await sendMessage(
      sendMessageRequest({ body: { content: "hello", replyToId: "11111111-1111-1111-1111-111111111111" } }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "replyToId must reference a message in the same conversation",
    });
  });
});

describe("getParticipants payload shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns role/presence/lastSeen/joinedAt per participant", async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ id: "conv-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            userId: "user-id",
            name: "Requester",
            avatarUrl: null,
            role: "admin",
            presenceStatus: "online",
            lastSeenAt: new Date("2026-02-01T10:00:00Z"),
            joinedAt: new Date("2026-01-01T10:00:00Z"),
          },
          {
            userId: "other-id",
            name: "Other",
            avatarUrl: "http://avatar",
            role: "member",
            presenceStatus: "offline",
            lastSeenAt: new Date("2026-01-31T09:00:00Z"),
            joinedAt: new Date("2026-01-01T10:00:00Z"),
          },
        ],
      });

    const res = makeResponse();
    await getParticipants(
      authenticatedRequest({ params: { conversationId: "conv-1" } }),
      res,
      vi.fn(),
    );

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        participants: [
          expect.objectContaining({
            userId: "user-id",
            name: "Requester",
            role: "admin",
            presenceStatus: "online",
            lastSeenAt: expect.anything(),
            joinedAt: expect.anything(),
          }),
          expect.objectContaining({
            userId: "other-id",
            role: "member",
            presenceStatus: "offline",
          }),
        ],
      },
    });
  });
});

describe("blocks route", () => {
  const SELF_UUID = "11111111-1111-1111-1111-111111111111";
  const OTHER_UUID = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to block yourself (400)", async () => {
    const res = makeResponse();
    await blockUser(
      authenticatedRequest({
        user: { businessId: "business-id", userId: SELF_UUID },
        params: { userId: SELF_UUID },
      }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "You cannot block yourself" });
  });

  it("returns 409 when the contact is already blocked", async () => {
    (query as any)
      .mockResolvedValueOnce({ rows: [{ id: OTHER_UUID, name: "Other" }] }) // target lookup
      .mockResolvedValueOnce({ rows: [] }); // ON CONFLICT DO NOTHING

    const res = makeResponse();
    await blockUser(
      authenticatedRequest({ params: { userId: OTHER_UUID } }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Contact is already blocked" });
  });

  it("lists blocked contacts with names", async () => {
    (query as any).mockResolvedValueOnce({
      rows: [{ id: "block-1", userId: OTHER_UUID, name: "Other", avatarUrl: null, blockedAt: new Date() }],
    });

    const res = makeResponse();
    await listBlocked(authenticatedRequest(), res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        blocked: [
          expect.objectContaining({ userId: OTHER_UUID, name: "Other" }),
        ],
      },
    });
    expect((query as any).mock.calls[0][0]).toContain("blocker_id = $1");
  });
});
