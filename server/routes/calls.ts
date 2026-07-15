import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { logActivity } from "../services/activity";
import { getSocketServer } from "../lib/socket";
import crypto from "crypto";

// Helper to generate random call code
function generateCallCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function getBusinessUserIds(userIds: string[], businessId: string) {
  if (userIds.length === 0) return new Set<string>();

  const result = await query(
    `SELECT id FROM users WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, userIds],
  );

  return new Set(result.rows.map((row) => row.id));
}

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
    const userId = req.user?.userId;
    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = (page - 1) * limit;

    const countResult = await query(
      `SELECT COUNT(*) as total
       FROM calls c
       WHERE c.business_id = $1
       AND (
         c.created_by = $2
         OR c.host_id = $2
         OR c.co_host_id = $2
         OR EXISTS (
           SELECT 1 FROM call_participants cp
           WHERE cp.call_id = c.id AND cp.user_id = $2
         )
       )`,
      [businessId, userId],
    );
    const total = parseInt(countResult.rows[0].total);

    const result = await query(
      `SELECT 
        c.id, c.business_id as "businessId", c.type, c.status, c.started_at as "startedAt", 
        c.ended_at as "endedAt", c.created_by as "createdById", c.host_id as "hostId",
        c.co_host_id as "coHostId", c.call_code as "callCode", c.is_group_call as "isGroupCall",
        c.waiting_room_enabled as "waitingRoomEnabled", c.recording_enabled as "recordingEnabled",
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
      AND (
        c.created_by = $2
        OR c.host_id = $2
        OR c.co_host_id = $2
        OR EXISTS (
          SELECT 1 FROM call_participants current_cp
          WHERE current_cp.call_id = c.id AND current_cp.user_id = $2
        )
      )
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT $3 OFFSET $4`,
      [businessId, userId, limit, offset],
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
 *     description: Starts an audio or video call.
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
 *               isGroupCall:
 *                 type: boolean
 *                 default: false
 *               password:
 *                 type: string
 *                 nullable: true
 *               waitingRoomEnabled:
 *                 type: boolean
 *                 default: false
 *               recordingEnabled:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       201:
 *         description: Call created successfully
 */
export const createCall: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { type, participantIds, isGroupCall, password, waitingRoomEnabled, recordingEnabled } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const uniqueParticipantIds = [...new Set([userId, ...(participantIds || [])])];
    const validParticipantIds = await getBusinessUserIds(uniqueParticipantIds, businessId);
    if (validParticipantIds.size !== uniqueParticipantIds.length) {
      return res.status(400).json({
        success: false,
        error: "All call participants must belong to this business",
      });
    }

    // Generate unique call code
    let callCode;
    let isUnique = false;
    while (!isUnique) {
      callCode = generateCallCode();
      const check = await query(`SELECT id FROM calls WHERE call_code = $1`, [callCode]);
      if (check.rows.length === 0) {
        isUnique = true;
      }
    }

    const result = await query(
      `INSERT INTO calls 
        (business_id, type, status, created_by, host_id, call_code, password, is_group_call, waiting_room_enabled, recording_enabled)
       VALUES ($1, $2, 'ongoing', $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, business_id as "businessId", type, status, started_at as "startedAt", 
                 ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
                 co_host_id as "coHostId", call_code as "callCode", password, is_group_call as "isGroupCall",
                 waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [businessId, type || "video", userId, userId, callCode, password || null, isGroupCall || false, waitingRoomEnabled || false, recordingEnabled || false],
    );

    const call = result.rows[0];

    // Add participants
    const participants = [];
    for (const pid of uniqueParticipantIds) {
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
        callCode: call.callCode,
        isGroupCall: call.isGroupCall,
        participantIds: uniqueParticipantIds,
      },
    });

    // Emit socket events
    const io = getSocketServer();
    if (io) {
      uniqueParticipantIds.forEach(targetId => {
        io.to(`user:${targetId}`).emit("call:created", call);
      });
      // Send invites to participants
      participantIds?.forEach(targetId => {
        io.to(`user:${targetId}`).emit("call:incoming", {
          callId: call.id,
          from: userId,
          type: call.type,
          callCode: call.callCode,
        });
      });
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
 * /calls/code/{code}:
 *   get:
 *     summary: Get call by code
 *     tags: [Calls]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Call found
 *       404:
 *         description: Call not found
 */
export const getCallByCode: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { code } = req.params;
    const businessId = req.user?.businessId;

    const result = await query(
      `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
              ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
              co_host_id as "coHostId", call_code as "callCode", password, is_group_call as "isGroupCall",
              waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM calls WHERE call_code = $1 AND business_id = $2`,
      [code, businessId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    const call = result.rows[0];
    const participantsResult = await query(
      `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
       FROM call_participants WHERE call_id = $1`,
      [call.id],
    );
    call.participants = participantsResult.rows;

    const response: ApiResponse<any> = {
      success: true,
      data: call,
    };
    res.json(response);
  } catch (error) {
    console.error("Get call by code error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to get call",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /calls/{id}:
 *   put:
 *     summary: Update a call
 *     description: Updates a call status or settings.
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
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [ongoing, completed, missed, cancelled]
 *               waitingRoomEnabled:
 *                 type: boolean
 *               recordingEnabled:
 *                 type: boolean
 *               coHostId:
 *                 type: string
 *                 format: uuid
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

    const { status, waitingRoomEnabled, recordingEnabled, coHostId } = req.body;

    if (coHostId !== undefined && coHostId !== null) {
      const validCoHostIds = await getBusinessUserIds([coHostId], businessId);
      if (!validCoHostIds.has(coHostId)) {
        return res.status(400).json({
          success: false,
          error: "Call co-host must belong to this business",
        });
      }
    }

    let updateFields = [];
    let values = [];
    let paramIndex = 1;

    if (status !== undefined) {
      updateFields.push(`status = $${paramIndex++}`);
      values.push(status);
      if (status === "ongoing") {
        updateFields.push(`started_at = CURRENT_TIMESTAMP`);
      } else if (["completed", "missed", "cancelled"].includes(status)) {
        updateFields.push(`ended_at = CURRENT_TIMESTAMP`);
      }
    }
    if (waitingRoomEnabled !== undefined) {
      updateFields.push(`waiting_room_enabled = $${paramIndex++}`);
      values.push(waitingRoomEnabled);
    }
    if (recordingEnabled !== undefined) {
      updateFields.push(`recording_enabled = $${paramIndex++}`);
      values.push(recordingEnabled);
    }
    if (coHostId !== undefined) {
      updateFields.push(`co_host_id = $${paramIndex++}`);
      values.push(coHostId);
    }
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id, businessId, userId);

    const result = await query(
      `UPDATE calls
       SET ${updateFields.join(", ")}
       WHERE id = $${paramIndex++} AND business_id = $${paramIndex++}
       AND (created_by = $${paramIndex} OR host_id = $${paramIndex} OR co_host_id = $${paramIndex++})
       RETURNING id, business_id as "businessId", type, status, started_at as "startedAt", 
                 ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
                 co_host_id as "coHostId", call_code as "callCode", is_group_call as "isGroupCall",
                 waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
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

    const participantsResult = await query(
      `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
       FROM call_participants WHERE call_id = $1`,
      [id],
    );
    call.participants = participantsResult.rows;

    const io = getSocketServer();
    if (io) {
      io.to(`call:${id}`).emit("call:updated", call);
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
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               password:
 *                 type: string
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
    const { password } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    // Check call exists and password
    const callCheck = await query(
      `SELECT password FROM calls WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );
    if (callCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }
    if (callCheck.rows[0].password && callCheck.rows[0].password !== password) {
      return res.status(403).json({
        success: false,
        error: "Invalid password",
      });
    }

    // Check if participant exists, if not add them
    const existingParticipant = await query(
      `SELECT id FROM call_participants WHERE call_id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (existingParticipant.rows.length === 0) {
      await query(
        `INSERT INTO call_participants (call_id, user_id, status) VALUES ($1, $2, 'joined')`,
        [id, userId],
      );
    } else {
      await query(
        `UPDATE call_participants SET status = 'joined', joined_at = CURRENT_TIMESTAMP WHERE call_id = $1 AND user_id = $2`,
        [id, userId],
      );
    }

    const callResult = await query(
      `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
              ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
              co_host_id as "coHostId", call_code as "callCode", is_group_call as "isGroupCall",
              waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
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

    const participantsResult = await query(
      `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
       FROM call_participants WHERE call_id = $1`,
      [id],
    );
    call.participants = participantsResult.rows;

    const io = getSocketServer();
    if (io) {
      io.to(`call:${id}`).emit("call:participantJoined", {
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

    const callResult = await query(
      `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
              ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
              co_host_id as "coHostId", call_code as "callCode", is_group_call as "isGroupCall",
              waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM calls WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );
    const call = callResult.rows[0];

    const participantsResult = await query(
      `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
       FROM call_participants WHERE call_id = $1`,
      [id],
    );
    call.participants = participantsResult.rows;

    const io = getSocketServer();
    if (io) {
      io.to(`call:${id}`).emit("call:participantLeft", {
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

/**
 * @swagger
 * /calls/{id}:
 *   delete:
 *     summary: Delete a call
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
 *         description: Call deleted successfully
 *       404:
 *         description: Call not found
 */
export const deleteCall: RequestHandler = async (
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

    // Check if call exists
    const callCheck = await query(
      `SELECT id FROM calls
       WHERE id = $1 AND business_id = $2
       AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
      [id, businessId, userId],
    );
    if (callCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    // Delete participants first
    await query(`DELETE FROM call_participants WHERE call_id = $1`, [id]);

    // Delete recordings linked to this call
    await query(`DELETE FROM recordings WHERE call_id = $1`, [id]);

    // Delete call
    await query(`DELETE FROM calls WHERE id = $1 AND business_id = $2`, [
      id,
      businessId,
    ]);

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "delete",
      actionType: "call",
      description: `Deleted call`,
      metadata: {
        callId: id,
      },
    });

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      io.to(`business:${businessId}`).emit("call:deleted", id);
    }

    const response: ApiResponse<null> = {
      success: true,
    };
    res.json(response);
  } catch (error) {
    console.error("Delete call error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to delete call",
    };
    res.status(500).json(response);
  }
};
