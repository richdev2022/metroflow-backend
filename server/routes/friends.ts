import { Router, RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken } from "../middleware/auth";
import { createNotification } from "../services/notifications";

/**
 * FRIENDS — public/private account social graph for the Personal app.
 *
 *   GET    /friends                    → accepted friends (symmetric)
 *   GET    /friends/requests           → { incoming, outgoing } pending
 *   POST   /friends/requests           { user_id } → send a friend request
 *   POST   /friends/requests/:id/accept → accept an incoming request
 *   POST   /friends/requests/:id/decline → decline an incoming request
 *   DELETE /friends/requests/:id        → cancel an outgoing request
 *
 * An ACCEPTED request in EITHER direction = friendship. Private accounts
 * (users.account_privacy = 'private') only accept direct chats from friends —
 * enforced in the chat conversation-create path.
 */

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepted friendship between two users (either direction). */
export async function areFriends(a: string, b: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM friend_requests
      WHERE status = 'accepted'
        AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
      LIMIT 1`,
    [a, b],
  );
  return r.rows.length > 0;
}

/** The viewer's relationship to a set of users: none | pending_out | pending_in | friends. */
export async function friendshipMap(viewerId: string, userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!userIds.length) return map;
  const r = await query(
    `SELECT requester_id, addressee_id, status FROM friend_requests
      WHERE (requester_id = ANY($1::uuid[]) AND addressee_id = $2)
         OR (addressee_id = ANY($1::uuid[]) AND requester_id = $2)`,
    [userIds, viewerId],
  );
  for (const row of r.rows) {
    const other = row.requester_id === viewerId ? row.addressee_id : row.requester_id;
    if (row.status === "accepted") map.set(other, "friends");
    else if (row.status === "pending") map.set(other, row.requester_id === viewerId ? "pending_out" : "pending_in");
  }
  return map;
}

const listFriends: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const r = await query(
      `SELECT u.id, u.name, u.avatar_url, f.responded_at AS friends_since
         FROM friend_requests f
         JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
        WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1)
        ORDER BY u.name ASC LIMIT 500`,
      [userId],
    );
    res.json({ success: true, data: { friends: r.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load friends" });
  }
};

const listRequests: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const incoming = await query(
      `SELECT f.id, f.created_at, u.id AS user_id, u.name, u.avatar_url
         FROM friend_requests f JOIN users u ON u.id = f.requester_id
        WHERE f.addressee_id = $1 AND f.status = 'pending'
        ORDER BY f.created_at DESC LIMIT 100`,
      [userId],
    );
    const outgoing = await query(
      `SELECT f.id, f.created_at, u.id AS user_id, u.name, u.avatar_url
         FROM friend_requests f JOIN users u ON u.id = f.addressee_id
        WHERE f.requester_id = $1 AND f.status = 'pending'
        ORDER BY f.created_at DESC LIMIT 100`,
      [userId],
    );
    res.json({ success: true, data: { incoming: incoming.rows, outgoing: outgoing.rows } });
  } catch {
    res.status(500).json({ success: false, error: "Could not load requests" });
  }
};

const sendRequest: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const target = String(req.body?.user_id || "");
    if (!UUID_RE.test(target)) return res.status(400).json({ success: false, error: "Invalid user" });
    if (target === userId) return res.status(400).json({ success: false, error: "You can't befriend yourself" });

    const targetUser = await query(`SELECT id, name, account_privacy FROM users WHERE id = $1`, [target]);
    if (!targetUser.rows.length) return res.status(404).json({ success: false, error: "User not found" });

    // Existing relationship? (any row in either direction)
    const existing = await query(
      `SELECT id, requester_id, status FROM friend_requests
        WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)
        LIMIT 1`,
      [userId, target],
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.status === "accepted") return res.json({ success: true, data: { status: "friends", request_id: row.id } });
      if (row.status === "pending") {
        // If THEY asked ME, treat my "request" as an accept.
        if (row.requester_id === target) {
          await query(`UPDATE friend_requests SET status = 'accepted', responded_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
          await createNotification({
            userId: target,
            type: "social",
            title: "Friend request accepted",
            message: "You are now friends — you can chat anytime.",
          }).catch(() => {});
          return res.json({ success: true, data: { status: "friends", request_id: row.id } });
        }
        return res.json({ success: true, data: { status: "pending_out", request_id: row.id } });
      }
      // previously declined — reopen as a fresh pending request from me
      await query(
        `UPDATE friend_requests SET requester_id = $1, addressee_id = $2, status = 'pending', created_at = CURRENT_TIMESTAMP, responded_at = NULL WHERE id = $3`,
        [userId, target, row.id],
      );
    } else {
      await query(
        `INSERT INTO friend_requests (requester_id, addressee_id) VALUES ($1, $2)`,
        [userId, target],
      );
    }

    await createNotification({
      userId: target,
      type: "social",
      title: "New friend request",
      message: `${req.user!.name || "Someone"} wants to connect with you.`,
    }).catch(() => {});

    res.status(201).json({ success: true, data: { status: "pending_out" } });
  } catch {
    res.status(500).json({ success: false, error: "Could not send the request" });
  }
};

const respondRequest: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const action = req.path.endsWith("/accept") ? "accept" : "decline";
    const r = await query(
      `SELECT * FROM friend_requests WHERE id = $1 AND addressee_id = $2 AND status = 'pending'`,
      [req.params.id, userId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Request not found" });

    if (action === "accept") {
      await query(`UPDATE friend_requests SET status = 'accepted', responded_at = CURRENT_TIMESTAMP WHERE id = $1`, [r.rows[0].id]);
      await createNotification({
        userId: r.rows[0].requester_id,
        type: "social",
        title: "Friend request accepted",
        message: `${req.user!.name || "Someone"} accepted your friend request — you can chat now.`,
      }).catch(() => {});
      return res.json({ success: true, data: { status: "friends" } });
    }
    await query(`UPDATE friend_requests SET status = 'declined', responded_at = CURRENT_TIMESTAMP WHERE id = $1`, [r.rows[0].id]);
    res.json({ success: true, data: { status: "declined" } });
  } catch {
    res.status(500).json({ success: false, error: "Could not respond to the request" });
  }
};

const cancelRequest: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.userId;
    const r = await query(
      `DELETE FROM friend_requests WHERE id = $1 AND requester_id = $2 AND status = 'pending' RETURNING id`,
      [req.params.id, userId],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Request not found" });
    res.json({ success: true, data: {} });
  } catch {
    res.status(500).json({ success: false, error: "Could not cancel the request" });
  }
};

router.get("/", authenticateToken, listFriends);
router.get("/requests", authenticateToken, listRequests);
router.post("/requests", authenticateToken, sendRequest);
router.post("/requests/:id/accept", authenticateToken, respondRequest);
router.post("/requests/:id/decline", authenticateToken, respondRequest);
router.delete("/requests/:id", authenticateToken, cancelRequest);

export default router;
