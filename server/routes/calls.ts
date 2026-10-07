import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { logActivity } from "../services/activity";
import { getSocketServer } from "../lib/socket";
import { createNotification } from "../services/notifications";
import { sendEmail, generateCallInvitationEmailHtml } from "../services/email";
import { postCallLogMessage } from "../lib/call-log";
import { resolveSpeakerNames } from "../lib/speaker-names";
import { pushIncomingCall, pushMissedCall, acknowledgeCallPush } from "../lib/call-push";
import { roomManager } from "../lib/roomManager";
import crypto from "crypto";
import {
  buildCallingCredentials,
  computeRemainingSeconds,
  getActiveProviderName,
  resolveProviderForRoom,
} from "../lib/calling/factory";

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

// Helper to build a call link (for responses + emails).
// The final fallback is the PRODUCTION web app: if the VPS env is missing
// CLIENT_URL, every generated invite link used to read http://localhost:8080
// (unreachable for invitees). A production domain default is far safer.
function buildCallLink(callCode: string): string {
  const baseUrl = process.env.CLIENT_URL || process.env.APP_BASE_URL || process.env.APP_URL || 'https://metricorex.com';
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

// Resolve a display name for push payloads (best-effort, never throws).
async function resolveUserName(userId: string | null | undefined): Promise<string> {
  if (!userId) return "Someone";
  try {
    const r = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
    return r.rows[0]?.name || "Someone";
  } catch {
    return "Someone";
  }
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
        c.duration_started_at as "durationStartedAt",
        CASE WHEN c.status IN ('completed','missed','cancelled') AND c.ended_at IS NOT NULL
          THEN GREATEST(0, EXTRACT(EPOCH FROM (c.ended_at - COALESCE(c.duration_started_at, c.started_at, c.created_at)))::int)
          ELSE NULL END AS duration,
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
    const { type, participantIds, isGroupCall, password, waitingRoomEnabled, recordingEnabled, conversationId } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    // Normalize participantIds: clients may send a single id, a JSON string,
    // or ids that are not user UUIDs (e.g. chat participant row ids). Cast the
    // whole array with ::uuid[] would throw 22P02 and bubble up as a 500
    // "Failed to create call", so validate explicitly and 400 instead.
    let rawParticipantIds: unknown = participantIds;
    if (typeof rawParticipantIds === "string") {
      try {
        rawParticipantIds = JSON.parse(rawParticipantIds);
      } catch {
        rawParticipantIds = [rawParticipantIds];
      }
    }
    if (rawParticipantIds != null && !Array.isArray(rawParticipantIds)) {
      rawParticipantIds = [rawParticipantIds];
    }
    const providedParticipantIds = ((rawParticipantIds as any[]) || [])
      .filter((pid): pid is string => typeof pid === "string" && pid.trim().length > 0)
      .map((pid) => pid.trim());
    const invalidParticipantIds = providedParticipantIds.filter((pid) => !isValidUUID(pid));
    if (invalidParticipantIds.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid call participants: one or more participant ids are not valid user ids",
      });
    }

    const uniqueParticipantIds = [...new Set([userId, ...providedParticipantIds])];
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

    // The calling provider is resolved ONCE at creation time and stored on the
    // row, so an admin switching providers later never migrates an in-flight
    // room (the room keeps its original provider until it ends).
    const callingProvider = await getActiveProviderName();

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
        (business_id, type, status, created_by, host_id, call_code, password, is_group_call, waiting_room_enabled, recording_enabled, started_at, ended_at, max_participants, conversation_id, provider)
       VALUES ($1, $2, 'ongoing', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, business_id as "businessId", type, status, started_at as "startedAt", 
                 ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
                 co_host_id as "coHostId", call_code as "callCode", password, is_group_call as "isGroupCall",
                 waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
                 max_participants as "maxParticipants", conversation_id as "conversationId", provider,
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [businessId, type || "video", userId, userId, callCode, password || null, isGroupCall || false, waitingRoomEnabled || false, recordingEnabled || false, now.toISOString(), endedAt ? endedAt.toISOString() : null, planMaxParticipants, conversationId || null, callingProvider],
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

    // Send in-app notifications and emails to invited participants.
    // These are side effects: the call row is already committed, so a failing
    // notification/email must NEVER turn the request into a 500 (the caller
    // would believe the call failed while it is actually live). Best-effort.
    const invitedParticipantIds = (providedParticipantIds).filter((pid: string) => pid !== userId);
    if (invitedParticipantIds.length > 0) {
      try {
        const usersMap = await getBusinessUserIdsForCalls(invitedParticipantIds, businessId);
        const callLink = buildCallLink(call.callCode);

        for (const pid of invitedParticipantIds) {
          try {
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
          } catch (notifyError) {
            console.error(`Create call: failed to notify participant ${pid}:`, notifyError);
          }

          const user = usersMap.get(pid);
          if (user?.email) {
            try {
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
              const emailSent = await sendEmail(user.email, user.name || 'User', `📞 Incoming ${type === 'audio' ? 'Audio' : 'Video'} Call from ${currentUserName}`, emailHtml);
              if (!emailSent) console.error(`Create call: invite email not sent to ${user.email} - share the call link manually: ${callLink}`);
            } catch (emailError) {
              console.error(`Create call: failed to email participant ${pid}:`, emailError);
            }
          }
        }
      } catch (sideEffectError) {
        console.error("Create call: participant notification stage failed (call still created):", sideEffectError);
      }
    }

    // Log activity (best-effort)
    try {
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
    } catch (logError) {
      console.error("Create call: failed to log activity:", logError);
    }

    // Emit socket events (best-effort)
    try {
      const io = getSocketServer();
      if (io) {
        uniqueParticipantIds.forEach(targetId => {
          io.to(`user:${targetId}`).emit("call:created", call);
        });
        // Send invites to participants
        providedParticipantIds?.forEach((targetId: string) => {
          io.to(`user:${targetId}`).emit("call:incoming", {
            callId: call.id,
            callCode: call.callCode,
            roomId: call.id,
            from: userId,
            callerName: currentUserName,
            type: call.type,
            callLink: buildCallLink(call.callCode),
            hasPassword: !!password,
            waitingRoomEnabled: waitingRoomEnabled || false,
          });
        });
      }
    } catch (socketError) {
      console.error("Create call: socket emission failed (call still created):", socketError);
    }

    // Fire-and-forget device push (FCM + Web Push) so callees ring even with
    // the app in the background. Never blocks the response, never the caller.
    if (invitedParticipantIds.length > 0) {
      pushIncomingCall(invitedParticipantIds, {
        callId: call.id,
        callType: call.type,
        callerName: currentUserName,
        callerId: userId,
        callCode: call.callCode,
        conversationId: conversationId || null,
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
 *   get:
 *     summary: Get a call by UUID or call code
 *     tags: [Calls]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Call found
 *       404:
 *         description: Call not found
 */
export const getCallById: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { id } = req.params as { id: string };
    const businessId = req.user?.businessId;

    const baseSelect = `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
              ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
              co_host_id as "coHostId", call_code as "callCode", password, is_group_call as "isGroupCall",
              waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
              created_at as "createdAt", updated_at as "updatedAt",
              duration_started_at as "durationStartedAt",
              CASE WHEN status IN ('completed','missed','cancelled') AND ended_at IS NOT NULL
                THEN GREATEST(0, EXTRACT(EPOCH FROM (ended_at - COALESCE(duration_started_at, started_at, created_at)))::int)
                ELSE NULL END AS duration
       FROM calls`;

    // Resolve by UUID first, then by call code (clients send either).
    // Guard the UUID query so non-UUID params (e.g. /calls/stats) fall
    // through to the code lookup instead of throwing 22P02 -> 500.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let result = UUID_RE.test(id)
      ? await query(`${baseSelect} WHERE id = $1 AND business_id = $2`, [id, businessId])
      : { rows: [] as any[] };
    if (result.rows.length === 0) {
      result = await query(`${baseSelect} WHERE call_code = $1 AND business_id = $2`, [id, businessId]);
    }

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
    console.error("Get call by id error:", error);
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
    const { id } = req.params as { id: string };
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

    // First get the call's actual id (try UUID first if valid, then code).
    // status/conversation_id captured so we can (a) only log a call entry on
    // the FIRST transition to a final state and (b) mirror the log into the
    // chat conversation the call was started from.
    let actualId: string | undefined;
    let previousStatus: string | undefined;
    let linkedConversationId: string | null | undefined;
    if (isValidUUID(id)) {
      const idResult = await query(
        `SELECT id, status, conversation_id FROM calls WHERE id = $1 AND business_id = $2 AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [id, businessId, userId],
      );
      if (idResult.rows.length > 0) {
        actualId = idResult.rows[0].id;
        previousStatus = idResult.rows[0].status;
        linkedConversationId = idResult.rows[0].conversation_id || null;
      }
    }

    if (!actualId) {
      const codeResult = await query(
        `SELECT id, status, conversation_id FROM calls WHERE call_code = $1 AND business_id = $2 AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [id, businessId, userId],
      );
      if (codeResult.rows.length > 0) {
        actualId = codeResult.rows[0].id;
        previousStatus = codeResult.rows[0].status;
        linkedConversationId = codeResult.rows[0].conversation_id || null;
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
        // Only stamp started_at on the FIRST transition to ongoing; re-issuing
        // status=ongoing (e.g. every participant join) must not rewrite history.
        updateFields.push(`started_at = COALESCE(started_at, CURRENT_TIMESTAMP)`);
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
                 created_at as "createdAt", updated_at as "updatedAt",
                 duration_started_at as "durationStartedAt",
                 CASE WHEN status IN ('completed','missed','cancelled') AND ended_at IS NOT NULL
                   THEN GREATEST(0, EXTRACT(EPOCH FROM (ended_at - COALESCE(duration_started_at, started_at, created_at)))::int)
                   ELSE NULL END AS duration`,
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

    // WhatsApp-style call log in chat: when the call FIRST reaches a final
    // state, append a call-log message to the linked conversation (or every
    // direct conversation between the initiator and each participant).
    const FINAL_CALL_STATUSES = ["completed", "missed", "cancelled"];
    if (
      status !== undefined &&
      FINAL_CALL_STATUSES.includes(status) &&
      !FINAL_CALL_STATUSES.includes(previousStatus || "")
    ) {
      // Fire-and-forget: must never block or fail the API response.
      postCallLogMessage({
        businessId,
        senderId: call.createdById || userId,
        conversationId: linkedConversationId || undefined,
        participantIds: participantsResult.rows.map((r: any) => r.userId).filter(Boolean),
        callType: call.type,
        status,
        durationSeconds: call.duration ?? null,
        callCode: call.callCode,
        callId: call.id,
        endedAt: call.endedAt || new Date(),
      }, getSocketServer()).catch((e) => console.error("Call-log insert failed:", e));

      // Missed / cancelled calls: notify the callee side (in-app + push) that
      // they missed a call from this caller.
      if (status === "missed" || status === "cancelled") {
        const calleeIds = participantsResult.rows
          .map((r: any) => r.userId)
          .filter((pid: any) => pid && pid !== call.createdById);
        const callerName = await resolveUserName(call.createdById || userId);
        pushMissedCall(calleeIds, {
          callId: call.id,
          callerName,
          callerId: call.createdById || userId,
          callCode: call.callCode,
          status,
        });
      }
    }

    const io = getSocketServer();
    if (io) {
      // NOTE: clients join `room:{id}` (socket.ts call:join/meeting:join), never
      // `call:{id}` — emitting there is a no-op, so use the live room.
      io.to(`room:${actualId}`).emit("call:updated", call);
      io.to(`meeting:${actualId}`).emit("call:updated", call);
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
    const { id } = req.params as { id: string };
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
    // Race guard: the row was found by the first lookup but vanished before
    // this re-read (deleted mid-join). Reading `callState.status` on an empty
    // result used to throw TypeError -> generic 500 "Failed to join call".
    if (!callState) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
        errorCode: 'call_not_found',
      });
    }
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

    // Atomic upsert: re-joining (double tap, refresh, retry) refreshes the
    // SAME row instead of racing check-then-insert into duplicates.
    // Best-effort: a transient DB hiccup here must not 500 the whole join —
    // the socket join handler admits the user to the room regardless.
    try {
      await query(
        `INSERT INTO call_participants (call_id, user_id, status, joined_at)
         VALUES ($1, $2, $3, CASE WHEN $3 = 'joined' THEN CURRENT_TIMESTAMP END)
         ON CONFLICT (call_id, user_id) DO UPDATE SET
           status = EXCLUDED.status,
           joined_at = CASE WHEN EXCLUDED.status = 'joined' THEN CURRENT_TIMESTAMP ELSE call_participants.joined_at END,
           left_at = NULL`,
        [actualId, userId, effectiveStatus],
      );
    } catch (participantErr: any) {
      console.error("Participant upsert failed (non-fatal):", participantErr?.code || participantErr);
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

    // Provider-specific media credentials for the joining participant
    // (LiveKit JWT minted server-side; mediasoup requires none).
    try {
      const userRes = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
      const provider = await resolveProviderForRoom("call", actualId, (call as any).provider || null);
      call.calling = await buildCallingCredentials(provider, {
        roomType: "call",
        roomId: actualId,
        title: call.callCode || "",
        identity: userId,
        displayName: userRes.rows[0]?.name || "User",
        isHost: joiningAsHost,
        remainingSeconds: computeRemainingSeconds(call.endedAt),
        maxParticipants: call.maxParticipants || null,
      });
    } catch (err) {
      console.error("Failed to build calling credentials for join:", err);
    }

    const io = getSocketServer();
    if (io) {
      // Emit both spellings: camelCase (Flutter) and hyphenated (web).
      // Room name must be `room:{id}` — that is the room sockets actually join.
      io.to(`room:${actualId}`).emit("call:participantJoined", {
        callId: actualId,
        userId,
        status: effectiveStatus,
      });
      io.to(`room:${actualId}`).emit("call:participant-joined", {
        roomId: actualId,
        callId: actualId,
        userId,
        status: effectiveStatus,
      });

      // Belt-and-braces for MOBILE-TO-MOBILE calls: a callee answering via
      // REST (push tap -> accept) must also stop the caller's ringback.
      // Mirror the socket call:accept broadcast to the creator's personal
      // room; the client handler is idempotent (stops ringing when the id
      // matches the outbound call).
      const creatorId = callState.created_by || callState.host_id;
      if (creatorId && creatorId !== userId) {
        io.to(`user:${creatorId}`).emit("call:accepted", {
          callId: actualId,
          call_id: actualId,
          userId,
          status: effectiveStatus,
        });
      }
    }

    const response: ApiResponse<any> = {
      success: true,
      data: call,
    };
    res.json(response);
  } catch (error: any) {
    // Log the REAL failure server-side; never leak internals to clients.
    console.error("Join call error:", error?.stack || error);
    const isDbUniqueConflict =
      error?.code === "23505" ||
      String(error?.message || "").includes("duplicate key");
    const response: ApiResponse<null> = {
      success: false,
      error: isDbUniqueConflict
        ? "Join conflict — please retry"
        : "Failed to join call",
    };
    res.status(isDbUniqueConflict ? 409 : 500).json(response);
  }
};

/**
 * POST /calls/push-ack — delivery receipt for incoming-call pushes.
 * The mobile app fires this as soon as an incoming-call push is rendered
 * (including from the background isolate). It cancels the server-side
 * escalation that would otherwise re-send the call as a VISIBLE tray
 * notification 8s later (OEM launchers silently drop data-only pushes while
 * the app is swiped away — FCM still reports them as delivered).
 * Auth optional-by-design: the background isolate posts fire-and-forget with
 * whatever token it has; callId alone gates a notification resend, which is
 * harmless.
 */
export const pushAckCall: RequestHandler = async (req, res) => {
  try {
    const { callId } = req.body || {};
    if (callId) acknowledgeCallPush(String(callId));
    res.status(204).end();
  } catch {
    res.status(204).end(); // never fail an ack
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
    const { id } = req.params as { id: string };
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
              conversation_id as "conversationId", duration_started_at as "durationStartedAt",
              waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM calls WHERE id = $1 AND business_id = $2`,
      [actualId, businessId],
    );
    if (callResult.rows.length === 0) {
      // Call deleted between the participant update and this lookup
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }
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
      // Emit both spellings: camelCase (Flutter) and hyphenated (web).
      // Room name must be `room:{id}` — that is the room sockets actually join.
      io.to(`room:${actualId}`).emit("call:participantLeft", {
        callId: actualId,
        userId,
      });
      io.to(`room:${actualId}`).emit("call:participant-left", {
        roomId: actualId,
        callId: actualId,
        userId,
      });
    }

    // ===== Finalize the call + WhatsApp-style chat call-log (PERMANENT FIX) =====
    // Mobile and web both end calls via POST /calls/:id/leave. The old flow
    // only wrote a call-log row on the REST updateCall path (host-only), so
    // chats never received call logs. Now:
    //   - 1:1 calls finalize as soon as either side leaves
    //   - group calls finalize when the last 'joined' participant leaves
    //   - duration/status/transcript flags ride on the log like updateCall
    const FINAL_CALL_STATUSES = ["completed", "missed", "cancelled"];
    if (!FINAL_CALL_STATUSES.includes(call.status)) {
      const othersJoined = participantsResult.rows.some(
        (r: any) => r.userId && r.userId !== userId && r.status === "joined",
      );
      const hadConnected =
        !!call.durationStartedAt || !!call.startedAt || call.status === "ongoing";
      const shouldFinalize = call.isGroupCall ? !othersJoined : true;

      if (shouldFinalize) {
        const finalStatus = hadConnected
          ? "completed"
          : call.createdById === userId
            ? "cancelled"
            : "missed";

        const finalizeResult = await query(
          `UPDATE calls
           SET status = $1, ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND status NOT IN ('completed','missed','cancelled')
           RETURNING GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(duration_started_at, started_at, created_at)))::int) AS duration`,
          [finalStatus, actualId],
        );

        if (finalizeResult.rows.length > 0) {
          const durationSeconds = finalizeResult.rows[0]?.duration ?? null;
          call.status = finalStatus;
          call.endedAt = new Date().toISOString();

          // WhatsApp-style chat call-log — same helper the REST updateCall uses.
          postCallLogMessage(
            {
              businessId,
              senderId: call.createdById || userId,
              conversationId: call.conversationId || undefined,
              participantIds: participantsResult.rows
                .map((r: any) => r.userId)
                .filter(Boolean),
              callType: call.type,
              status: finalStatus,
              durationSeconds,
              callCode: call.callCode,
              callId: call.id,
              endedAt: call.endedAt,
            },
            getSocketServer(),
          ).catch((e) => console.error("Call-log insert failed:", e));

          // Missed/cancelled: notify the other side (in-app + push).
          if (finalStatus === "missed" || finalStatus === "cancelled") {
            const calleeIds = participantsResult.rows
              .map((r: any) => r.userId)
              .filter((pid: any) => pid && pid !== (call.createdById || userId));
            const callerName = await resolveUserName(call.createdById || userId);
            pushMissedCall(calleeIds, {
              callId: call.id,
              callerName,
              callerId: call.createdById || userId,
              callCode: call.callCode,
              status: finalStatus,
            });
          }

          // Tell the remaining peer(s) the call ended so their UI closes and
          // they also run their leave path (idempotent — call is already final).
          if (io) {
            io.to(`room:${actualId}`).emit("call:ended", {
              roomId: actualId,
              callId: actualId,
              callCode: call.callCode,
              reason: finalStatus,
            });
            io.to(`room:${actualId}`).emit("call:participantLeft", {
              callId: actualId,
              userId,
            });
            // Participants who never joined the live room (still ringing, or
            // on another route) must hear the end too — personal user rooms.
            const endedReason = finalStatus;
            for (const row of participantsResult.rows) {
              const pid = row?.userId;
              if (pid) {
                io.to(`user:${pid}`).emit("call:ended", {
                  roomId: actualId,
                  callId: actualId,
                  callCode: call.callCode,
                  reason: endedReason,
                });
              }
            }
          }
        }
      }
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
    const { id } = req.params as { id: string };
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
    const { callId } = req.params as { callId: string };
    const { participantIds, emails } = req.body as { participantIds?: string[]; emails?: string[] };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    // Validate participantIds is a non-empty array (emails may substitute)
    const hasParticipantIds = Array.isArray(participantIds) && participantIds.length > 0;
    const hasEmails = Array.isArray(emails) && emails.length > 0;
    if (!hasParticipantIds && !hasEmails) {
      return res.status(400).json({
        success: false,
        error: "participantIds or emails must be a non-empty array",
      });
    }

    // Resolve the call by UUID first, then by call code (business-scoped).
    // Authorization is checked in code below: host/co-host/creator OR any
    // existing participant of the call may invite. Restricting invites to
    // hosts only made the web "Add people" sheet fail with 404 for the
    // callee in every 1:1 call (the exact reported bug).
    let callResult;
    if (isValidUUID(callId)) {
      callResult = await query(
        `SELECT id, type, call_code, status, ended_at, created_by, host_id, co_host_id
         FROM calls
         WHERE id = $1 AND business_id = $2`,
        [callId, businessId],
      );
    }

    // If not found by UUID (or not a UUID), try by call code
    if (!callResult || callResult.rows.length === 0) {
      callResult = await query(
        `SELECT id, type, call_code, status, ended_at, created_by, host_id, co_host_id
         FROM calls
         WHERE call_code = $1 AND business_id = $2`,
        [callId, businessId],
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

    // Never invite into an already-ended call — the invitee would ring and
    // then fail to join with 410 ("Call has already ended").
    const terminalStatuses = ["completed", "missed", "cancelled", "ended"];
    if (
      (call.status && terminalStatuses.includes(String(call.status))) ||
      call.ended_at
    ) {
      return res.status(409).json({
        success: false,
        error: "This call has already ended — participants can no longer be added",
      });
    }

    // Authorization: hosts/co-hosts/creator OR existing call participants.
    const isHost = call.created_by === userId || call.host_id === userId || call.co_host_id === userId;

    // Get existing participants
    const existingParticipantsResult = await query(
      `SELECT user_id FROM call_participants WHERE call_id = $1`,
      [actualCallId],
    );
    const existingUserIds = new Set(existingParticipantsResult.rows.map((row) => row.user_id));

    if (!isHost && !existingUserIds.has(userId)) {
      return res.status(403).json({
        success: false,
        error: "Only participants of this call can invite others",
      });
    }

    // Validate all participantIds belong to the business (team-member path only)
    const uniqueParticipantIds = [...new Set(participantIds || [])];
    // Non-UUID ids (e.g. chat participant row ids) would throw 22P02 inside the
    // SQL `id IN (...)` below -> 500. Reject them with a clear 400 instead.
    const invalidParticipantIds = uniqueParticipantIds.filter((pid) => !isValidUUID(pid));
    if (invalidParticipantIds.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid call participants: one or more participant ids are not valid user ids",
      });
    }
    let validUserIds = new Map<string, CallUserFromDb>();
    if (uniqueParticipantIds.length > 0) {
      validUserIds = await getBusinessUserIdsForCalls(uniqueParticipantIds, businessId);
      if (validUserIds.size !== uniqueParticipantIds.length) {
        return res.status(400).json({
          success: false,
          error: "All participants must belong to this business",
        });
      }
    }

    // Filter out existing participants
    const newParticipantIds = uniqueParticipantIds.filter((id) => !existingUserIds.has(id));

    if (newParticipantIds.length === 0 && !hasEmails) {
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
         ON CONFLICT (call_id, user_id) DO UPDATE SET status = 'invited', left_at = NULL
         RETURNING id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"`,
        [actualCallId, pid],
      );
      // rows can be empty if a concurrent request already inserted — skip
      // side effects for that participant instead of crashing.
      if (!participantResult.rows[0]) continue;
      addedParticipants.push(participantResult.rows[0]);

      // Side effects are best-effort: a failing notification/email must never
      // turn the request into a 500 (the participant row is already inserted).
      try {
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
      } catch (notifyError) {
        console.error(`Add call participants: failed to notify ${pid}:`, notifyError);
      }

      const user = usersMap.get(pid);
      if (user?.email) {
        try {
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
        } catch (emailError) {
          console.error(`Add call participants: failed to email ${user.email}:`, emailError);
        }
      }
    }

    // ===== External email invites (people without accounts) =====
    // Guests join via the public call link (/calls/:code -> guest join), so an
    // account is never required. Every side effect below is best-effort.
    const invitedViaEmail: string[] = [];
    if (hasEmails) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const validEmails = [...new Set((emails as string[])
        .map((e: string) => String(e || '').trim().toLowerCase())
        .filter((e: string) => emailRegex.test(e)))] as string[];

      // Email→team-member lookup FIRST: an email typed into the invite box that
      // belongs to an existing business user becomes a real call participant
      // (roster + notification + invitation email), never a one-off guest.
      const guestEmailsOnly: string[] = [];
      if (validEmails.length > 0) {
        let byEmail = new Map<string, CallUserFromDb>();
        try {
          const usersRes = await query(
            `SELECT id, name, email FROM users WHERE business_id = $1 AND lower(email) = ANY($2::text[])`,
            [businessId, validEmails],
          );
          for (const row of usersRes.rows) byEmail.set(String(row.email).toLowerCase(), row);
        } catch { /* keep every email on the guest path if lookup fails */ }

        for (const email of validEmails) {
          const user = byEmail.get(email);
          if (user && !existingUserIds.has(user.id)) {
            try {
              const inserted = await query(
                `INSERT INTO call_participants (call_id, user_id, status)
                 VALUES ($1, $2, 'invited')
                 RETURNING id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"`,
                [actualCallId, user.id],
              );
              if (inserted.rows.length > 0) {
                existingUserIds.add(user.id);
                newParticipantIds.push(user.id);
                addedParticipants.push(inserted.rows[0]);
                try {
                  await createNotification({
                    businessId: businessId,
                    userId: user.id,
                    type: "call",
                    title: `${currentUserName} added you to a call`,
                    message: `You've been added to a ${callDetails?.type || 'video'} call by ${currentUserName}`,
                    actionUrl: `/calls/${call.call_code}`,
                    actionType: "join_call",
                    metadata: { callId: actualCallId, callCode: call.call_code },
                    isActionable: true,
                    expiresInHours: 1,
                  });
                } catch (notifyError) {
                  console.error(`Add call participants: failed to notify ${email}:`, notifyError);
                }
                if (user.email) {
                  try {
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
                  } catch (emailError) {
                    console.error(`Add call participants: failed to email ${email}:`, emailError);
                  }
                }
                continue;
              }
            } catch (insertError) {
              console.error(`Add call participants: failed to add ${email} as participant:`, insertError);
            }
          }
          guestEmailsOnly.push(email);
        }
      }

      for (const email of guestEmailsOnly) {
        try {
          const emailHtml = generateCallInvitationEmailHtml(
            email.split('@')[0],
            (callDetails?.type || 'video') as 'audio' | 'video',
            new Date(callDetails?.started_at || new Date()),
            call.call_code,
            currentUserName,
            callLink,
            callDetails?.password || null,
            !!callDetails?.waiting_room_enabled
          );
          const sent = await sendEmail(
            email,
            email.split('@')[0],
            `📞 ${currentUserName} invited you to a ${callDetails?.type === 'audio' ? 'Audio' : 'Video'} Call`,
            emailHtml
          );
          if (sent) invitedViaEmail.push(email);
        } catch (emailError) {
          console.error(`Add call participants: failed to email external invitee ${email}:`, emailError);
        }
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
      
      io.to(`room:${actualCallId}`).emit("call:updated", updatedCall);

      // Send invites to new participants
      newParticipantIds.forEach(targetId => {
        io.to(`user:${targetId}`).emit("call:incoming", {
          callId: call.id,
          roomId: call.id,
          from: userId,
          callerName: currentUserName,
          type: callDetails?.type || 'video',
          callCode: call.call_code,
          callLink: callLink,
          hasPassword: !!callDetails?.password,
          waitingRoomEnabled: !!callDetails?.waiting_room_enabled,
        });
      });
    }

    // Fire-and-forget device push for the newly added callees.
    if (newParticipantIds.length > 0) {
      pushIncomingCall(newParticipantIds, {
        callId: actualCallId,
        callType: callDetails?.type || 'video',
        callerName: currentUserName,
        callerId: userId,
        callCode: call.call_code,
        conversationId: null,
      });
    }

    res.json({
      success: true,
      message: [
        newParticipantIds.length > 0 ? `${newParticipantIds.length} participant(s) added` : null,
        invitedViaEmail.length > 0 ? `${invitedViaEmail.length} email invite(s) sent` : null,
      ].filter(Boolean).join(' · ') || 'No new participants added (all were already in the call)',
      data: { added: newParticipantIds, invitedEmails: invitedViaEmail },
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

    // `id = $1` with a non-UUID code (e.g. KJOZ5I) made Postgres throw 22P02
    // ("invalid input syntax for type uuid") -> 500 "Failed to validate call
    // access". Comparing `id::text = $1` instead accepts both call codes and
    // UUIDs without any cast error.
    const result = await query(
      `SELECT id, business_id as "businessId", type, status, started_at as "startedAt", 
              ended_at as "endedAt", call_code as "callCode",
              waiting_room_enabled as "waitingRoomEnabled",
              max_participants as "maxParticipants", host_id as "hostId",
              co_host_id as "coHostId", created_by as "createdById", password,
              recording_enabled as "recordingEnabled", is_group_call as "isGroupCall"
       FROM calls
       WHERE (call_code = $1 OR id::text = $1) AND business_id = $2`,
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

  // Build the invite URL from the configured client origin so links stay valid.
  // Production-safe fallback (see buildCallLink note above).
  const baseUrl = process.env.CLIENT_URL || process.env.APP_BASE_URL || process.env.APP_URL || process.env.CLIENT_APP_URL || 'https://metricorex.com';
  return `${baseUrl}/calls?roomId=${roomId}&token=${token}&userName=${encodedUserName}&isHost=${isHost}&waitingRoom=${waitingRoomParam}&autoJoin=1`;
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

// ==================== GUEST ACCESS ====================
// Guests (no account) join via public call links using a short-lived
// guest token scoped to a single call room.

export const guestJoinCall: RequestHandler = async (req, res) => {
  try {
    const { code } = req.params;
    const { name, password, guestId } = req.body || {};

    if (!code) {
      return res.status(400).json({ success: false, error: "Call code is required" });
    }
    const guestName = (name || "").toString().trim().slice(0, 60);
    if (!guestName) {
      return res.status(400).json({ success: false, error: "Your name is required to join as a guest" });
    }

    // Look up call globally by code (guests are not business-scoped)
    const callRes = await query(
      `SELECT c.id, c.type, c.status, c.call_code, c.password, c.waiting_room_enabled,
              c.max_participants, c.business_id, c.recording_enabled, c.is_group_call,
              u.name AS host_name
       FROM calls c
       LEFT JOIN users u ON c.host_id = u.id
       WHERE c.call_code = $1`,
      [code]
    );

    if (callRes.rows.length === 0) {
      return res.status(404).json({ success: false, errorCode: "CALL_NOT_FOUND", error: "Call not found" });
    }

    const call = callRes.rows[0];

    if (call.status === "cancelled") {
      return res.status(410).json({ success: false, errorCode: "CALL_CANCELLED", error: "This call has been cancelled" });
    }
    if (call.status === "completed" || call.status === "missed") {
      return res.status(410).json({ success: false, errorCode: "CALL_ENDED", error: "This call has already ended" });
    }

    // Password check
    if (call.password && call.password !== password) {
      return res.status(403).json({ success: false, errorCode: "PASSWORD_REQUIRED", error: "Incorrect call password" });
    }

    // Capacity check
    if (call.max_participants) {
      const countRes = await query(
        `SELECT COUNT(*)::int AS joined FROM call_participants WHERE call_id = $1 AND status = 'joined'`,
        [call.id]
      );
      if (countRes.rows[0].joined >= call.max_participants) {
        return res.status(409).json({ success: false, errorCode: "MAX_PARTICIPANTS_REACHED", error: "Call is full" });
      }
    }

    const { generateGuestToken } = await import("../utils/guestTokens");

    // --- Duplicate-join protection -------------------------------------
    // 1) The client replays the guestId it stored for this room, so the
    //    same browser/device keeps ONE identity across refreshes.
    // 2) If another ACTIVE participant in this room already uses the same
    //    display name, adopt its identity instead of minting a twin —
    //    this is what previously let one user appear N times in the room.
    let resolvedGuestId: string | undefined =
      typeof guestId === "string" && guestId.startsWith("guest-") ? guestId : undefined;
    if (!resolvedGuestId) {
      const roster = roomManager.getParticipants(call.id);
      const twin = roster.find(
        (p) => (p.isGuest ?? true) && p.name.toLowerCase() === guestName.toLowerCase(),
      );
      if (twin) resolvedGuestId = twin.id;
    }

    const { token, payload } = generateGuestToken({
      name: guestName,
      scope: "call",
      roomId: call.id,
      businessId: call.business_id,
      ttlMinutes: 6 * 60,
      guestId: resolvedGuestId,
    });

    // Provider-specific media credentials for the guest (LiveKit JWT minted
    // here; mediasoup requires none). Guests never get host grants.
    let calling: unknown;
    try {
      const provider = await resolveProviderForRoom("call", call.id, (call as any).provider || null);
      calling = await buildCallingCredentials(provider, {
        roomType: "call",
        roomId: call.id,
        title: call.call_code || "",
        identity: payload.guestId,
        displayName: guestName,
        isHost: false,
        remainingSeconds: computeRemainingSeconds(call.ended_at),
        maxParticipants: call.max_participants || null,
      });
    } catch (err) {
      console.error("Failed to build guest calling credentials:", err);
    }

    res.json({
      success: true,
      data: {
        call: {
          id: call.id,
          type: call.type,
          callCode: call.call_code,
          status: call.status,
          hostName: call.host_name,
          waitingRoomEnabled: call.waiting_room_enabled,
          recordingEnabled: call.recording_enabled,
          isGroupCall: call.is_group_call,
          hasPassword: Boolean(call.password),
        },
        guestToken: token,
        guestId: payload.guestId,
        guestName,
        roomId: call.id,
        socketRoom: `room:${call.id}`,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
        calling,
      },
    });
  } catch (error) {
    console.error("Guest join call error:", error);
    res.status(500).json({ success: false, error: "Failed to join call as guest" });
  }
};

/**
 * GET /calls/guest/validate/:code (public)
 * Pre-join check for guests opening a call link. Mirrors the meeting
 * guest validate endpoint so clients can preview call info + access state
 * before asking for a name/password.
 */
export const guestValidateCall: RequestHandler = async (req, res) => {
  try {
    const { code } = req.params;
    const { token } = req.query as { token?: string };

    if (!code) {
      return res.status(400).json({ success: false, errorCode: "CALL_NOT_FOUND", error: "Call code is required" });
    }

    // Look up call globally by code (guests are not business-scoped)
    // NOTE: calls has no screen_sharing_enabled column (that's meetings/pricing_plans)
    // — selecting it here caused an unconditional 42703 -> 500 on every guest link.
    const callRes = await query(
      `SELECT c.id, c.type, c.status, c.call_code, c.password, c.waiting_room_enabled,
              c.max_participants, c.recording_enabled, c.is_group_call,
              u.name AS host_name, c.started_at, c.ended_at
       FROM calls c
       LEFT JOIN users u ON c.host_id = u.id
       WHERE c.call_code = $1`,
      [code]
    );

    if (callRes.rows.length === 0) {
      return res.status(404).json({ success: false, errorCode: "CALL_NOT_FOUND", error: "Call not found" });
    }

    const call = callRes.rows[0];

    let accessState = "allowed";
    const reasons: string[] = [];
    if (call.password) {
      accessState = "password_required";
      reasons.push("Password required");
    }
    if (call.status === "cancelled") {
      accessState = "cancelled";
      reasons.push("This call has been cancelled");
    } else if (call.status === "completed" || call.status === "missed") {
      accessState = "ended";
      reasons.push("This call has already ended");
    }

    let inviteValid = true;
    if (token) {
      const tokenRes = await query(
        `SELECT id FROM invitation_tokens WHERE token = $1 AND room_id = $2 AND used = FALSE AND expires_at > NOW()`,
        [token, call.id]
      );
      inviteValid = tokenRes.rows.length > 0;
    }

    res.json({
      success: true,
      data: {
        id: call.id,
        type: call.type,
        callCode: call.call_code,
        status: call.status,
        hostName: call.host_name,
        waitingRoomEnabled: call.waiting_room_enabled,
        recordingEnabled: call.recording_enabled,
        screenSharingEnabled: true,
        isGroupCall: call.is_group_call,
        hasPassword: Boolean(call.password),
        accessState,
        reasons,
        isGuest: true,
        isHost: false,
        inviteValid,
      },
    });
  } catch (error) {
    console.error("Guest validate call error:", error);
    res.status(500).json({ success: false, error: "Failed to validate call link" });
  }
};

// ==================== CALL DETAIL (rich view) ====================

/**
 * Resolve a call row by UUID or call code (no business filter — access is
 * decided by the caller: same business OR call participant).
 */
async function resolveCallRow(idOrCode: string) {
  const baseSelect = `SELECT id, business_id as "businessId", type, status, started_at as "startedAt",
        ended_at as "endedAt", created_by as "createdById", host_id as "hostId",
        co_host_id as "coHostId", call_code as "callCode", password, is_group_call as "isGroupCall",
        waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
        conversation_id as "conversationId", provider,
        created_at as "createdAt", updated_at as "updatedAt",
        duration_started_at as "durationStartedAt",
        CASE WHEN status IN ('completed','missed','cancelled') AND ended_at IS NOT NULL
          THEN GREATEST(0, EXTRACT(EPOCH FROM (ended_at - COALESCE(duration_started_at, started_at, created_at)))::int)
          ELSE NULL END AS duration
   FROM calls`;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (UUID_RE.test(idOrCode)) {
    const r = await query(`${baseSelect} WHERE id = $1`, [idOrCode]);
    if (r.rows[0]) return r.rows[0];
  }
  const byCode = await query(`${baseSelect} WHERE call_code = $1`, [idOrCode]);
  return byCode.rows[0] || null;
}

/** Rich participant rows for the call detail view. */
async function getCallDetailParticipants(callId: string) {
  const result = await query(
    `SELECT cp.id, cp.user_id as "userId", u.name, u.avatar_url as "avatarUrl",
            cp.joined_at as "joinedAt", cp.left_at as "leftAt", cp.status,
            CASE
              WHEN cp.joined_at IS NOT NULL AND cp.left_at IS NOT NULL
                THEN GREATEST(0, EXTRACT(EPOCH FROM (cp.left_at - cp.joined_at))::int)
              WHEN cp.joined_at IS NOT NULL
                THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - cp.joined_at))::int)
              ELSE NULL
            END as "durationSeconds"
     FROM call_participants cp
     LEFT JOIN users u ON u.id = cp.user_id
     WHERE cp.call_id = $1
     ORDER BY cp.joined_at NULLS LAST`,
    [callId],
  );
  return result.rows;
}

/** Call transcripts: captions persisted per room id (meeting_transcripts). */
async function getCallTranscriptStats(callId: string) {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS count,
              EXISTS(SELECT 1 FROM meeting_transcripts WHERE meeting_id = $1) AS has_transcript
       FROM meeting_transcripts WHERE meeting_id = $1`,
      [callId],
    );
    const row = result.rows[0];
    return { hasTranscript: !!row?.has_transcript, transcriptsCount: row?.count || 0 };
  } catch {
    return { hasTranscript: false, transcriptsCount: 0 };
  }
}

/** Direct conversation shared by the call participants (first two), if any. */
async function findSharedDirectConversation(
  businessId: string,
  conversationId: string | null | undefined,
  participantUserIds: string[],
): Promise<string | null> {
  if (conversationId) return conversationId;
  const pair = participantUserIds.filter(Boolean).slice(0, 2);
  if (pair.length !== 2) return null;
  try {
    const result = await query(
      `SELECT cc.id FROM chat_conversations cc
       JOIN chat_participants cp1 ON cp1.conversation_id = cc.id AND cp1.user_id = $1
       JOIN chat_participants cp2 ON cp2.conversation_id = cc.id AND cp2.user_id = $2
       WHERE cc.business_id = $3 AND cc.type = 'direct'
         AND (SELECT COUNT(*) FROM chat_participants cpc WHERE cpc.conversation_id = cc.id) = 2
       LIMIT 1`,
      [pair[0], pair[1], businessId],
    );
    return result.rows[0]?.id || null;
  } catch {
    return null;
  }
}

/**
 * GET /calls/:id — rich call detail.
 * Membership check: call participant OR same business.
 * The payload is a SUPERSET of the legacy GET /calls/:id response: every
 * legacy top-level call field (callLink, participants, duration, ...) is kept
 * while adding the { call, participants, hasTranscript, transcriptsCount,
 * recording, conversationId } envelope used by the new call-detail screens.
 */
export const getCallDetail: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params as { id: string };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const call = await resolveCallRow(id);
    if (!call) {
      return res.status(404).json({ success: false, error: "Call not found" });
    }

    // Membership: same business OR explicit call participant.
    let isParticipant = call.businessId === businessId;
    if (!isParticipant) {
      const membership = await query(
        `SELECT 1 FROM call_participants WHERE call_id = $1 AND user_id = $2 LIMIT 1`,
        [call.id, userId],
      );
      isParticipant = membership.rows.length > 0;
    }
    if (!isParticipant) {
      return res.status(404).json({ success: false, error: "Call not found" });
    }

    const participants = await getCallDetailParticipants(call.id);
    const { hasTranscript, transcriptsCount } = await getCallTranscriptStats(call.id);

    let recording: any = null;
    try {
      const recordingResult = await query(
        `SELECT id, storage_url as "storageUrl", duration, size, status
         FROM recordings WHERE call_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [call.id],
      );
      recording = recordingResult.rows[0] || null;
    } catch { /* recordings table issue must not break the detail view */ }

    const conversationId = await findSharedDirectConversation(
      call.businessId,
      call.conversationId,
      participants.map((p: any) => p.userId),
    );

    // AI notes (summary / key points / decisions / action items) — generated
    // from the persisted transcript when the call ends (best effort).
    let notes: any = null;
    try {
      const notesResult = await query(
        `SELECT summary, key_points as "keyPoints", decisions, action_items as "actionItems",
                important_timestamps as "importantTimestamps", model, generated_at as "generatedAt"
         FROM meeting_notes WHERE meeting_id = $1 LIMIT 1`,
        [call.id],
      );
      notes = notesResult.rows[0] || null;
    } catch { /* notes must not break the detail view */ }

    // Legacy-shaped call object (top level) — delete password like enrichCall.
    const callEnvelope = { ...call };
    enrichCall(callEnvelope);
    enrichCall(call);

    const response: ApiResponse<any> = {
      success: true,
      data: {
        // Legacy top-level fields (backward compatible)
        ...callEnvelope,
        participants,
        // New detail envelope
        call: { ...callEnvelope, participants },
        hasTranscript,
        transcriptsCount,
        recording,
        notes,
        conversationId: conversationId || null,
      },
    };
    res.json(response);
  } catch (error) {
    console.error("Get call detail error:", error);
    res.status(500).json({ success: false, error: "Failed to get call" });
  }
};

/**
 * GET /calls/:id/transcript — transcript segments for a call, ordered
 * ascending. Calls reuse the meeting_transcripts storage keyed by room id;
 * when no transcript pipeline ran for this call the list is simply empty.
 */
export const getCallTranscript: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params as { id: string };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    const call = await resolveCallRow(id);
    if (!call) {
      return res.status(404).json({ success: false, error: "Call not found" });
    }
    let allowed = call.businessId === businessId;
    if (!allowed) {
      const membership = await query(
        `SELECT 1 FROM call_participants WHERE call_id = $1 AND user_id = $2 LIMIT 1`,
        [call.id, userId],
      );
      allowed = membership.rows.length > 0;
    }
    if (!allowed) {
      return res.status(404).json({ success: false, error: "Call not found" });
    }

    let transcripts: any[] = [];
    try {
      const result = await query(
        `SELECT t.id, t.speaker_id as "speakerId", t.speaker_name as "speakerName",
                t.text, t.created_at as "createdAt"
         FROM meeting_transcripts t
         WHERE t.meeting_id = $1
         ORDER BY t.created_at ASC
         LIMIT 2000`,
        [call.id],
      );
      transcripts = await resolveSpeakerNames(result.rows);
    } catch { /* no transcript storage yet — empty list */ }

    const response: ApiResponse<any> = {
      success: true,
      data: { callId: call.id, transcripts },
    };
    res.json(response);
  } catch (error) {
    console.error("Get call transcript error:", error);
    res.status(500).json({ success: false, error: "Failed to load transcript" });
  }
};
