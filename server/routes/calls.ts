import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { logActivity } from "../services/activity";
import { getSocketServer } from "../lib/socket";

/**
 * @swagger
 * /calls:
 *   get:
 *     summary: Get calls
 *     description: Returns paginated calls for the authenticated user's business.
 *     tags: [Calls]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Calls fetched successfully
 */
export const getCalls: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "Business ID not found",
      });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = (page - 1) * limit;

    const countResult = await query(
      `SELECT COUNT(*) as total FROM calls WHERE business_id = $1`,
      [businessId],
    );
    const total = parseInt(countResult.rows[0].total);

    const result = await query(
      `SELECT 
        c.id, c.business_id as "businessId", c.type, c.status, c.started_at as "startedAt", 
        c.ended_at as "endedAt", c.created_by as "createdById", c.jitsi_room_id as "jitsiRoomId",
        c.created_at as "createdAt", c.updated_at as "updatedAt",
        json_agg(json_build_object(
          'id', cp.id,
          'userId', cp.user_id,
          'status', cp.status,
          'joinedAt', cp.joined_at,
          'leftAt', cp.left_at
        )) FILTER (WHERE cp.id IS NOT NULL) as participants
      FROM calls c
      LEFT JOIN call_participants cp ON c.id = cp.call_id
      WHERE c.business_id = $1
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT $2 OFFSET $3`,
      [businessId, limit, offset],
    );

    const response: ApiResponse<{ calls: any[]; total: number }> = {
      success: true,
      data: { calls: result.rows, total },
    };
    res.json(response);
  } catch (error) {
    console.error("Get calls error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to fetch calls",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /calls:
 *   post:
 *     summary: Create a call
 *     description: Starts an audio or video call and creates a Jitsi room ID.
 *     tags: [Calls]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [audio, video]
 *                 default: video
 *               participantIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       201:
 *         description: Call created successfully
 */
export const createCall: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { type, participantIds } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    // Generate unique room id
    const jitsiRoomId = `call-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const result = await query(
      `INSERT INTO calls 
        (business_id, type, status, created_by, jitsi_room_id)
       VALUES ($1, $2, 'ongoing', $3, $4)
       RETURNING id, business_id as "businessId", type, status, started_at as "startedAt", 
                 ended_at as "endedAt", created_by as "createdById", jitsi_room_id as "jitsiRoomId",
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [businessId, type || "video", userId, jitsiRoomId],
    );

    const call = result.rows[0];

    // Add participants
    const allParticipantIds = [userId, ...(participantIds || [])];
    const participants = [];
    for (const pid of allParticipantIds) {
      const participantResult = await query(
        `INSERT INTO call_participants (call_id, user_id, status)
         VALUES ($1, $2, $3)
         RETURNING id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"`,
        [call.id, pid, pid === userId ? "joined" : "invited"],
      );
      participants.push(participantResult.rows[0]);
    }

    call.participants = participants;

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "create",
      actionType: "call",
      description: `Started a ${call.type} call`,
      metadata: {
        type: call.type,
        jitsiRoomId: call.jitsiRoomId,
        participantIds: allParticipantIds,
      },
    });

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      io.to(`business:${businessId}`).emit("call:created", call);
    }

    const response: ApiResponse<any> = {
      success: true,
      data: call,
    };
    res.status(201).json(response);
  } catch (error) {
    console.error("Create call error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to create call",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /calls/{id}:
 *   put:
 *     summary: Update a call
 *     description: Updates a call status.
 *     tags: [Calls]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [ongoing, completed, missed]
 *     responses:
 *       200:
 *         description: Call updated successfully
 *       404:
 *         description: Call not found
 */
export const updateCall: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const { status } = req.body;

    let updateFields = [];
    let values = [];
    let paramIndex = 1;

    if (status === "ongoing") {
      updateFields.push(`started_at = CURRENT_TIMESTAMP`);
    } else if (status === "completed" || status === "missed") {
      updateFields.push(`ended_at = CURRENT_TIMESTAMP`);
    }
    updateFields.push(`status = $${paramIndex++}`);
    values.push(status);
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id, businessId);

    const result = await query(
      `UPDATE calls
       SET ${updateFields.join(", ")}
       WHERE id = $${paramIndex++} AND business_id = $${paramIndex++}
       RETURNING id, business_id as "businessId", type, status, started_at as "startedAt", 
                 ended_at as "endedAt", created_by as "createdById", jitsi_room_id as "jitsiRoomId",
                 created_at as "createdAt", updated_at as "updatedAt"`,
      values,
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    const call = result.rows[0];

    // Get participants
    const participantsResult = await query(
      `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
       FROM call_participants WHERE call_id = $1`,
      [id],
    );
    call.participants = participantsResult.rows;

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      io.to(`business:${businessId}`).emit("call:updated", call);
    }

    const response: ApiResponse<any> = {
      success: true,
      data: call,
    };
    res.json(response);
  } catch (error) {
    console.error("Update call error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to update call",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /calls/{id}/join:
 *   post:
 *     summary: Join a call
 *     tags: [Calls]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Joined call successfully
 *       404:
 *         description: Call not found
 */
export const joinCall: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    await query(
      `UPDATE call_participants
       SET status = 'joined', joined_at = CURRENT_TIMESTAMP
       WHERE call_id = $1 AND user_id = $2`,
      [id, userId],
    );

    // Get updated call
    const callResult = await query(
      `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
              ended_at as "endedAt", created_by as "createdById", jitsi_room_id as "jitsiRoomId",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM calls WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );

    if (callResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    const call = callResult.rows[0];

    // Get participants
    const participantsResult = await query(
      `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
       FROM call_participants WHERE call_id = $1`,
      [id],
    );
    call.participants = participantsResult.rows;

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      io.to(`business:${businessId}`).emit("call:participantJoined", {
        callId: id,
        userId,
      });
    }

    const response: ApiResponse<any> = {
      success: true,
      data: call,
    };
    res.json(response);
  } catch (error) {
    console.error("Join call error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to join call",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /calls/{id}/leave:
 *   post:
 *     summary: Leave a call
 *     tags: [Calls]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Left call successfully
 *       404:
 *         description: Call not found
 */
export const leaveCall: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    await query(
      `UPDATE call_participants
       SET status = 'left', left_at = CURRENT_TIMESTAMP
       WHERE call_id = $1 AND user_id = $2`,
      [id, userId],
    );

    // Get updated call
    const callResult = await query(
      `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
              ended_at as "endedAt", created_by as "createdById", jitsi_room_id as "jitsiRoomId",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM calls WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );

    if (callResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    const call = callResult.rows[0];

    // Get participants
    const participantsResult = await query(
      `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
       FROM call_participants WHERE call_id = $1`,
      [id],
    );
    call.participants = participantsResult.rows;

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      io.to(`business:${businessId}`).emit("call:participantLeft", {
        callId: id,
        userId,
      });
    }

    const response: ApiResponse<any> = {
      success: true,
      data: call,
    };
    res.json(response);
  } catch (error) {
    console.error("Leave call error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to leave call",
    };
    res.status(500).json(response);
  }
};
