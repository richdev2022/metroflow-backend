import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { logActivity } from "../services/activity";
import { getSocketServer } from "../lib/socket";
import { createNotification } from "../services/notifications";
import { sendEmail, generateCallInvitationEmailHtml } from "../services/email";
import crypto from "crypto";

interface CallUserFromDb {
  id: string;
  name: string | null;
  email: string | null;
}

async function getBusinessUserIdsForCalls(userIds: string[], businessId: string): Promise<Map<string, CallUserFromDb>> {
  if (userIds.length === 0) return new Map<string, CallUserFromDb>();

  const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',');
  const result = await query(
    `SELECT id, name, email FROM users WHERE business_id = $1 AND id IN (${placeholders})`,
    [businessId, ...userIds],
  );

  return new Map<string, CallUserFromDb>(result.rows.map((row: CallUserFromDb) => [row.id, row]));
}

// Helper to check if string is valid UUID v4
function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

// Helper to generate random call code
function generateCallCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Helper to build a call link (for responses + emails)
function buildCallLink(callCode: string): string {
  const baseUrl = process.env.CLIENT_URL || process.env.APP_BASE_URL || process.env.APP_URL || 'http://localhost:8080';
  return `${baseUrl}/calls/${callCode}`;
}

// Helper to attach callLink + normalized flags to a call object
function enrichCall(call: any): any {
  if (!call) return call;
  call.callLink = buildCallLink(call.callCode || call.call_code);
  call.hasPassword = !!call.password;
  // Do NOT leak the actual password back to callers
  if (call.password) {
    delete call.password;
  }
  return call;
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

    const calls = result.rows.map(enrichCall);
    const response: ApiResponse<{ calls: any[]; total: number }> = {
      success: true,
      data: { calls, total },
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

    const planResult = await query(
      `SELECT pp.max_meeting_duration as "maxMeetingDuration", pp.max_participants as "planMaxParticipants"
       FROM businesses b 
       LEFT JOIN pricing_plans pp ON b.plan_id = pp.id 
       WHERE b.id = $1`,
      [businessId]
    );
    const planMaxMeetingDuration = planResult.rows[0]?.maxMeetingDuration || null;
    const planMaxParticipants = planResult.rows[0]?.planMaxParticipants || null;

    const now = new Date();
    const endedAt = null;

    if (planMaxParticipants && uniqueParticipantIds.length > planMaxParticipants) {
      return res.status(400).json({
        success: false,
        error: `Plan allows maximum ${planMaxParticipants} participants per call`,
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
        (business_id, type, status, created_by, host_id, call_code, password, is_group_call, waiting_room_enabled, recording_enabled, started_at, ended_at, max_participants)
       VALUES ($1, $2, 'ongoing', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, business_id as "businessId", type, status, started_at as "startedAt", 
                 ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
                 co_host_id as "coHostId", call_code as "callCode", password, is_group_call as "isGroupCall",
                 waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
                 max_participants as "maxParticipants",
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [businessId, type || "video", userId, userId, callCode, password || null, isGroupCall || false, waitingRoomEnabled || false, recordingEnabled || false, now.toISOString(), endedAt ? endedAt.toISOString() : null, planMaxParticipants],
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
    call.maxMeetingDuration = planMaxMeetingDuration;
    enrichCall(call);

    // Fetch current user name for notifications
    const currentUserResult = await query(
      `SELECT name FROM users WHERE id = $1`,
      [userId]
    );
    const currentUserName = currentUserResult.rows[0]?.name || 'Someone';

    // Send in-app notifications and emails to invited participants
    const invitedParticipantIds = (participantIds || []).filter((pid: string) => pid !== userId);
    if (invitedParticipantIds.length > 0) {
      const usersMap = await getBusinessUserIdsForCalls(invitedParticipantIds, businessId);
      const callLink = buildCallLink(call.callCode);

      for (const pid of invitedParticipantIds) {
        await createNotification({
          businessId: businessId,
          userId: pid,
          type: "call",
          title: `${currentUserName} is calling`,
          message: `You have an incoming ${type || 'video'} call from ${currentUserName}`,
          actionUrl: `/calls/${call.callCode}`,
          actionType: "join_call",
          metadata: { callId: call.id, callCode: call.callCode },
          isActionable: true,
          expiresInHours: 1,
        });

        const user = usersMap.get(pid);
        if (user?.email) {
          const emailHtml = generateCallInvitationEmailHtml(
            user.name || 'User',
            (type || 'video') as 'audio' | 'video',
            new Date(call.startedAt),
            call.callCode,
            currentUserName,
            callLink,
            password || null,
            waitingRoomEnabled || false
          );
          await sendEmail(user.email, user.name || 'User', `📞 Incoming ${type === 'audio' ? 'Audio' : 'Video'} Call from ${currentUserName}`, emailHtml);
        }
      }
    }

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
      participantIds?.forEach((targetId: string) => {
        io.to(`user:${targetId}`).emit("call:incoming", {
          callId: call.id,
          from: userId,
          type: call.type,
          callCode: call.callCode,
          callLink: buildCallLink(call.callCode),
          hasPassword: !!password,
          waitingRoomEnabled: waitingRoomEnabled || false,
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
    enrichCall(call);

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

    // First get the call's actual id (try UUID first if valid, then code)
    let actualId: string | undefined;
    if (isValidUUID(id)) {
      const idResult = await query(
        `SELECT id FROM calls WHERE id = $1 AND business_id = $2 AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [id, businessId, userId],
      );
      if (idResult.rows.length > 0) {
        actualId = idResult.rows[0].id;
      }
    }

    if (!actualId) {
      const codeResult = await query(
        `SELECT id FROM calls WHERE call_code = $1 AND business_id = $2 AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [id, businessId, userId],
      );
      if (codeResult.rows.length > 0) {
        actualId = codeResult.rows[0].id;
      }
    }

    if (!actualId) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
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
    values.push(actualId, businessId, userId);

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
      [actualId],
    );
    call.participants = participantsResult.rows;
    enrichCall(call);

    const io = getSocketServer();
    if (io) {
      io.to(`call:${actualId}`).emit("call:updated", call);
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

    let actualId: string | undefined;
    if (isValidUUID(id)) {
      const idResult = await query(
        `SELECT id, password, status, started_at, ended_at, waiting_room_enabled, max_participants, host_id, co_host_id, created_by
         FROM calls WHERE id = $1 AND business_id = $2`,
        [id, businessId],
      );
      if (idResult.rows.length > 0) {
        actualId = idResult.rows[0].id;
      }
    }

    if (!actualId) {
      const codeResult = await query(
        `SELECT id, password, status, started_at, ended_at, waiting_room_enabled, max_participants, host_id, co_host_id, created_by
         FROM calls WHERE call_code = $1 AND business_id = $2`,
        [id, businessId],
      );
      if (codeResult.rows.length > 0) {
        actualId = codeResult.rows[0].id;
      }
    }

    if (!actualId) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
        errorCode: 'call_not_found',
      });
    }

    const lookupCol = isValidUUID(id) ? 'id' : 'call_code';
    const validationResult = await query(
      `SELECT id, password, status, started_at, ended_at, waiting_room_enabled, max_participants, host_id, co_host_id, created_by
       FROM calls WHERE ${lookupCol} = $1 AND business_id = $2`,
      [id, businessId],
    );
    const callState = validationResult.rows[0];
    const now = new Date();

    if (callState.status === 'cancelled') {
      return res.status(410).json({
        success: false,
        error: "Call has been cancelled",
        errorCode: 'call_cancelled',
      });
    }
    if (callState.status === 'completed' || callState.status === 'missed') {
      return res.status(410).json({
        success: false,
        error: "Call has already ended",
        errorCode: 'call_completed',
      });
    }
    if (callState.ended_at && new Date(callState.ended_at) < now) {
      return res.status(410).json({
        success: false,
        error: "Call is no longer active",
        errorCode: 'call_ended',
      });
    }

    if (callState.password && callState.password !== password) {
      return res.status(403).json({
        success: false,
        error: "Invalid password",
        errorCode: 'invalid_password',
        data: { hasPassword: true },
      });
    }

    const isHost =
      callState.host_id === userId ||
      callState.co_host_id === userId ||
      callState.created_by === userId;

    if (!isHost && callState.max_participants) {
      const countRes = await query(
        `SELECT COUNT(*) FROM call_participants WHERE call_id = $1 AND status = 'joined'`,
        [actualId],
      );
      const countJoined = parseInt(countRes.rows[0].count);
      if (countJoined >= callState.max_participants) {
        return res.status(409).json({
          success: false,
          error: "Call is at maximum capacity",
          errorCode: 'max_participants_reached',
          data: { maxParticipants: callState.max_participants },
        });
      }
    }

    const joiningAsHost = isHost;
    const useWaitingRoom = !!callState.waiting_room_enabled && !joiningAsHost;
    const effectiveStatus = useWaitingRoom ? 'waiting' : 'joined';

    const existingParticipant = await query(
      `SELECT id FROM call_participants WHERE call_id = $1 AND user_id = $2`,
      [actualId, userId],
    );
    if (existingParticipant.rows.length === 0) {
      await query(
        `INSERT INTO call_participants (call_id, user_id, status) VALUES ($1, $2, $3)`,
        [actualId, userId, effectiveStatus],
      );
    } else if (effectiveStatus === 'joined') {
      await query(
        `UPDATE call_participants SET status = $1, joined_at = CURRENT_TIMESTAMP WHERE call_id = $2 AND user_id = $3`,
        [effectiveStatus, actualId, userId],
      );
    } else {
      await query(
        `UPDATE call_participants SET status = $1 WHERE call_id = $2 AND user_id = $3`,
        [effectiveStatus, actualId, userId],
      );
    }

    const callResult = await query(
      `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
              ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
              co_host_id as "coHostId", call_code as "callCode", password, is_group_call as "isGroupCall",
              waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
              max_participants as "maxParticipants",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM calls WHERE id = $1 AND business_id = $2`,
      [actualId, businessId],
    );
    if (callResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    const call = callResult.rows[0];

    const planResult = await query(
      `SELECT pp.max_meeting_duration as "maxMeetingDuration"
       FROM businesses b 
       LEFT JOIN pricing_plans pp ON b.plan_id = pp.id 
       WHERE b.id = $1`,
      [businessId]
    );
    call.maxMeetingDuration = planResult.rows[0]?.maxMeetingDuration || null;

    const participantsResult = await query(
      `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
       FROM call_participants WHERE call_id = $1`,
      [actualId],
    );
    call.participants = participantsResult.rows;
    enrichCall(call);

    call.inWaitingRoom = useWaitingRoom;
    call.isHost = joiningAsHost;

    const io = getSocketServer();
    if (io) {
      io.to(`call:${actualId}`).emit("call:participantJoined", {
        callId: actualId,
        userId,
        status: effectiveStatus,
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

    // First get the actual call id (try UUID first if valid, then code)
    let actualId: string | undefined;
    if (isValidUUID(id)) {
      const idResult = await query(
        `SELECT id FROM calls WHERE id = $1 AND business_id = $2`,
        [id, businessId],
      );
      if (idResult.rows.length > 0) {
        actualId = idResult.rows[0].id;
      }
    }

    if (!actualId) {
      const codeResult = await query(
        `SELECT id FROM calls WHERE call_code = $1 AND business_id = $2`,
        [id, businessId],
      );
      if (codeResult.rows.length > 0) {
        actualId = codeResult.rows[0].id;
      }
    }

    if (!actualId) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    await query(
      `UPDATE call_participants
       SET status = 'left', left_at = CURRENT_TIMESTAMP
       WHERE call_id = $1 AND user_id = $2`,
      [actualId, userId],
    );

    const callResult = await query(
      `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
              ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
              co_host_id as "coHostId", call_code as "callCode", is_group_call as "isGroupCall",
              waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM calls WHERE id = $1 AND business_id = $2`,
      [actualId, businessId],
    );
    const call = callResult.rows[0];

    const participantsResult = await query(
      `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
       FROM call_participants WHERE call_id = $1`,
      [actualId],
    );
    call.participants = participantsResult.rows;
    enrichCall(call);

    const io = getSocketServer();
    if (io) {
      io.to(`call:${actualId}`).emit("call:participantLeft", {
        callId: actualId,
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

    // Check if call exists (try UUID first if valid, then code)
    let actualId: string | undefined;
    if (isValidUUID(id)) {
      const idResult = await query(
        `SELECT id FROM calls
         WHERE id = $1 AND business_id = $2
         AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [id, businessId, userId],
      );
      if (idResult.rows.length > 0) {
        actualId = idResult.rows[0].id;
      }
    }

    if (!actualId) {
      const codeResult = await query(
        `SELECT id FROM calls
         WHERE call_code = $1 AND business_id = $2
         AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [id, businessId, userId],
      );
      if (codeResult.rows.length > 0) {
        actualId = codeResult.rows[0].id;
      }
    }

    if (!actualId) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    // Delete participants first
    await query(`DELETE FROM call_participants WHERE call_id = $1`, [actualId]);

    // Delete recordings linked to this call
    await query(`DELETE FROM recordings WHERE call_id = $1`, [actualId]);

    // Delete call
    await query(`DELETE FROM calls WHERE id = $1 AND business_id = $2`, [
      actualId,
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
        callId: actualId,
      },
    });

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      io.to(`business:${businessId}`).emit("call:deleted", actualId);
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

export const addCallParticipants: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { callId } = req.params;
    const { participantIds } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    // Validate participantIds is a non-empty array
    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "participantIds must be a non-empty array",
      });
    }

    // Check if call exists and user has permission
    let callResult;
    if (isValidUUID(callId)) {
      callResult = await query(
        `SELECT id, type, call_code FROM calls
         WHERE id = $1 AND business_id = $2
         AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [callId, businessId, userId],
      );
    }

    // If not found by UUID (or not a UUID), try by call code
    if (!callResult || callResult.rows.length === 0) {
      callResult = await query(
        `SELECT id, type, call_code FROM calls
         WHERE call_code = $1 AND business_id = $2
         AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [callId, businessId, userId],
      );
    }

    if (callResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    const call = callResult.rows[0];
    const actualCallId = call.id; // Use actual UUID

    // Get existing participants
    const existingParticipantsResult = await query(
      `SELECT user_id FROM call_participants WHERE call_id = $1`,
      [actualCallId],
    );
    const existingUserIds = new Set(existingParticipantsResult.rows.map((row) => row.user_id));

    // Validate all participantIds belong to the business
    const uniqueParticipantIds = [...new Set(participantIds)];
    const validUserIds = await getBusinessUserIds(uniqueParticipantIds, businessId);
    if (validUserIds.size !== uniqueParticipantIds.length) {
      return res.status(400).json({
        success: false,
        error: "All participants must belong to this business",
      });
    }

    // Filter out existing participants
    const newParticipantIds = uniqueParticipantIds.filter((id) => !existingUserIds.has(id));

    if (newParticipantIds.length === 0) {
      return res.json({
        success: true,
        message: "No new participants added (all were already in the call)",
        data: { added: [] },
      });
    }

    // Add new participants
    const addedParticipants = [];

    const currentUserResult = await query(
      `SELECT name FROM users WHERE id = $1`,
      [userId]
    );
    const currentUserName = currentUserResult.rows[0]?.name || 'Someone';
    const fullCallDetails = await query(
      `SELECT type, started_at, password, waiting_room_enabled FROM calls WHERE id = $1`,
      [actualCallId]
    );
    const callDetails = fullCallDetails.rows[0];
    const usersMap = await getBusinessUserIdsForCalls(newParticipantIds, businessId);
    const callLink = buildCallLink(call.call_code);

    for (const pid of newParticipantIds) {
      const participantResult = await query(
        `INSERT INTO call_participants (call_id, user_id, status)
         VALUES ($1, $2, 'invited')
         RETURNING id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"`,
        [actualCallId, pid],
      );
      addedParticipants.push(participantResult.rows[0]);

      await createNotification({
        businessId: businessId,
        userId: pid,
        type: "call",
        title: `${currentUserName} added you to a call`,
        message: `You've been added to a ${callDetails?.type || 'video'} call by ${currentUserName}`,
        actionUrl: `/calls/${call.call_code}`,
        actionType: "join_call",
        metadata: { callId: actualCallId, callCode: call.call_code },
        isActionable: true,
        expiresInHours: 1,
      });

      const user = usersMap.get(pid);
      if (user?.email) {
        const emailHtml = generateCallInvitationEmailHtml(
          user.name || 'User',
          (callDetails?.type || 'video') as 'audio' | 'video',
          new Date(callDetails?.started_at || new Date()),
          call.call_code,
          currentUserName,
          callLink,
          callDetails?.password || null,
          !!callDetails?.waiting_room_enabled
        );
        await sendEmail(user.email, user.name || 'User', `📞 You've been added to a Call by ${currentUserName}`, emailHtml);
      }
    }

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "update",
      actionType: "call",
      description: `Added participants to call`,
      metadata: {
        callId: actualCallId,
        addedParticipantIds: newParticipantIds,
      },
    });

    // Emit socket events
    const io = getSocketServer();
    if (io) {
      const updatedCallResult = await query(
        `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
                ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
                co_host_id as "coHostId", call_code as "callCode", password, is_group_call as "isGroupCall",
                waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
                max_participants as "maxParticipants",
                created_at as "createdAt", updated_at as "updatedAt"
         FROM calls WHERE id = $1`,
        [actualCallId],
      );
      const updatedCall = updatedCallResult.rows[0];
      const participantsResult = await query(
        `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
         FROM call_participants WHERE call_id = $1`,
        [actualCallId],
      );
      updatedCall.participants = participantsResult.rows;
      enrichCall(updatedCall);
      
      io.to(`call:${actualCallId}`).emit("call:updated", updatedCall);

      // Send invites to new participants
      newParticipantIds.forEach(targetId => {
        io.to(`user:${targetId}`).emit("call:incoming", {
          callId: call.id,
          from: userId,
          type: callDetails?.type || 'video',
          callCode: call.call_code,
          callLink: callLink,
          hasPassword: !!callDetails?.password,
          waitingRoomEnabled: !!callDetails?.waiting_room_enabled,
        });
      });
    }

    res.json({
      success: true,
      message: `${newParticipantIds.length} participant(s) added`,
      data: { added: newParticipantIds },
    });
  } catch (error) {
    console.error("Add call participants error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to add participants",
    });
  }
};

/**
 * Pre-validation endpoint — what the frontend calls when a user clicks a call link.
 * Returns: call state, security flags (password/waiting room), status info — without
 * requiring a password unless one is set. The password itself is NEVER returned.
 */
export const validateCallAccess: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { code } = req.params;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const result = await query(
      `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
              ended_at as "endedAt", call_code as "callCode",
              waiting_room_enabled as "waitingRoomEnabled",
              max_participants as "maxParticipants", host_id as "hostId",
              co_host_id as "coHostId", created_by as "createdById", password,
              recording_enabled as "recordingEnabled", is_group_call as "isGroupCall"
       FROM calls
       WHERE (call_code = $1 OR id = $1) AND business_id = $2`,
      [code, businessId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
        errorCode: 'call_not_found',
      });
    }

    const raw = result.rows[0];
    const now = new Date();
    const isHost =
      raw.hostId === userId ||
      raw.coHostId === userId ||
      raw.createdById === userId;

    const hasPassword = !!raw.password;
    delete raw.password;

    let accessState: 'allowed' | 'password_required' | 'waiting_room' | 'ended' | 'cancelled' | 'completed' | 'missed' | 'full' = 'allowed';
    const reasons: string[] = [];

    if (raw.status === 'cancelled') {
      accessState = 'cancelled';
      reasons.push('Call has been cancelled');
    } else if (raw.status === 'completed' || raw.status === 'missed') {
      accessState = 'completed';
      reasons.push('Call has already ended');
    } else if (raw.endedAt && new Date(raw.endedAt) < now) {
      accessState = 'ended';
      reasons.push('Call is no longer active');
    }

    if (accessState === 'allowed' && hasPassword) {
      accessState = 'password_required';
      reasons.push('This call requires a password to join');
    }
    if (accessState !== 'password_required' && !isHost && raw.waitingRoomEnabled) {
      accessState = 'waiting_room';
      reasons.push('This call has waiting room enabled. You will be admitted by the host.');
    }

    let joinedCount = 0;
    let maxParticipants = raw.maxParticipants;
    if (!isHost && raw.maxParticipants) {
      const countRes = await query(
        `SELECT COUNT(*) FROM call_participants WHERE call_id = $1 AND status = 'joined'`,
        [raw.id],
      );
      joinedCount = parseInt(countRes.rows[0].count);
      if (accessState === 'allowed' || accessState === 'password_required' || accessState === 'waiting_room') {
        if (joinedCount >= raw.maxParticipants) {
          accessState = 'full';
          reasons.push('Call is currently at maximum capacity');
        }
      }
    }

    const callLink = buildCallLink(raw.callCode);

    const response: ApiResponse<any> = {
      success: true,
      data: {
        id: raw.id,
        type: raw.type,
        status: raw.status,
        startedAt: raw.startedAt,
        endedAt: raw.endedAt,
        callCode: raw.callCode,
        callLink,
        isGroupCall: raw.isGroupCall,
        waitingRoomEnabled: raw.waitingRoomEnabled,
        recordingEnabled: raw.recordingEnabled,
        maxParticipants,
        currentParticipants: joinedCount,
        hasPassword,
        isHost,
        accessState,
        reasons,
      },
    };
    res.json(response);
  } catch (error) {
    console.error("Validate call access error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to validate call access",
    });
  }
};

// Helper function to generate invite link
async function generateInviteLink(
  roomId: string,
  participantName: string,
  isHost: boolean,
  waitingRoomEnabled: boolean
): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  
  // Save token to database (expires in 24 hours)
  await query(
    `INSERT INTO invitation_tokens (token, room_id, expires_at, used) VALUES ($1, $2, NOW() + INTERVAL '24 hours', FALSE)`,
    [token, roomId]
  );

  const encodedUserName = encodeURIComponent(participantName);
  const waitingRoomParam = (!isHost && waitingRoomEnabled) ? 'true' : 'false';

  return `https://myapp.com/call?roomId=${roomId}&token=${token}&userName=${encodedUserName}&isHost=${isHost}&waitingRoom=${waitingRoomParam}`;
}

// Generate invite link endpoint
export const generateCallInvite: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { roomId, participantName, isHost, waitingRoomEnabled } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    if (!roomId || !participantName) {
      return res.status(400).json({
        success: false,
        error: "roomId and participantName are required",
      });
    }

    const inviteLink = await generateInviteLink(
      roomId,
      participantName,
      isHost || false,
      waitingRoomEnabled || false
    );

    res.json({
      success: true,
      data: { inviteLink },
    });
  } catch (error) {
    console.error("Generate call invite error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to generate invite link",
    });
  }
};
