import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteTeamMember } from "../routes/team";
import { query } from "../db";

// Mock the query function
vi.mock("../db", () => ({
  query: vi.fn(),
}));

// Mock logActivity since it is called in deleteTeamMember
vi.mock("../services/activity", () => ({
  logActivity: vi.fn(),
}));

describe("deleteTeamMember", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should delete a team member and reassign related records", async () => {
    const mockTeamMember = {
      id: "member-id",
      name: "John Doe",
      email: "john@example.com",
      role: "member",
    };

    const mockAdmin = {
      userId: "admin-id",
      businessId: "business-id",
    };

    const req = {
      params: { id: "member-id" },
      user: mockAdmin,
    } as any;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    // Mock query responses in order
    (query as any)
      // 1. Get team member info
      .mockResolvedValueOnce({ rows: [mockTeamMember] })
      // 2. Unassign from task_assignments (DELETE)
      .mockResolvedValueOnce({})
      // 3. Reassign tasks created_by (UPDATE)
      .mockResolvedValueOnce({})
      // 4. Reassign task_assignments assigned_by (UPDATE)
      .mockResolvedValueOnce({})
      // 5. Reassign comments (UPDATE)
      .mockResolvedValueOnce({})
      // 6. Reassign attachments (UPDATE)
      .mockResolvedValueOnce({})
      // 7. Reassign activity logs (UPDATE)
      .mockResolvedValueOnce({})
      // 8. Delete user (DELETE)
      .mockResolvedValueOnce({ rowCount: 1 });

    await deleteTeamMember(req, res, vi.fn());

    // Verify all queries were called with correct params
    expect(query).toHaveBeenCalledTimes(8);
    
    // Check specific queries for our fix
    // 5. Reassign comments
    expect(query).toHaveBeenNthCalledWith(5, 
      expect.stringContaining("UPDATE comments SET user_id = $1 WHERE user_id = $2"),
      [mockAdmin.userId, mockTeamMember.id]
    );

    // 6. Reassign attachments
    expect(query).toHaveBeenNthCalledWith(6, 
      expect.stringContaining("UPDATE attachments SET uploaded_by = $1 WHERE uploaded_by = $2"),
      [mockAdmin.userId, mockTeamMember.id]
    );

    // 7. Reassign activity logs
    expect(query).toHaveBeenNthCalledWith(7, 
      expect.stringContaining("UPDATE activity_logs SET user_id = $1 WHERE user_id = $2"),
      [mockAdmin.userId, mockTeamMember.id]
    );

    expect(res.json).toHaveBeenCalledWith({
      success: true,
    });
  });

  it("should return 404 if team member not found", async () => {
    const mockAdmin = {
      userId: "admin-id",
      businessId: "business-id",
    };

    const req = {
      params: { id: "non-existent-id" },
      user: mockAdmin,
    } as any;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    // Mock query response for get team member
    (query as any).mockResolvedValueOnce({ rows: [] });

    await deleteTeamMember(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Team member not found",
    });
  });
});
