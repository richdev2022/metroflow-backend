import crypto from "crypto";
import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { logActivity } from "../services/activity";
import { getSocketServer } from "../lib/socket";
import { createNotification } from "../services/notifications";
import { sendEmail, generateMeetingInvitationEmailHtml } from "../services/email";
import {
  buildCallingCredentials,
  computeRemainingSeconds,
  getActiveProviderName,
  resolveProviderForRoom,
} from "../lib/calling/factory";
import { generateMeetingNotes, hasSummarizableTranscript } from "../lib/meeting-notes";

// Helper to check if string is valid UUID v4
function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

// Helper to generate random meeting code
function generateMeetingCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Helper to build a meeting link (for responses + emails)
// Production-safe fallback: if CLIENT_URL is unset on the VPS, links used to
// read http://localhost:8080 and were unreachable for invitees.
function buildMeetingLink(meetingCode: string): string {
  const baseUrl = process.env.CLIENT_URL || process.env.APP_BASE_URL || process.env.APP_URL || 'https://metricorex.com';
  return `${baseUrl}/meetings/${meetingCode}`;
}

// Helper to attach meetingLink + normalized flags to a meeting object
function enrichMeeting(meeting: any): any {
  if (!meeting) return meeting;
  meeting.meetingLink = buildMeetingLink(meeting.meetingCode || meeting.meeting_code);
  meeting.hasPassword = !!meeting.password;
  // Do NOT leak the actual password back to callers — we already have hasPassword flag
  if (meeting.password) {
    delete meeting.password;
  }
  return meeting;
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
 * /meetings:
 *   get:
 *     summary: Get meetings
 *     description: Returns paginated meetings for the authenticated user's business.
 *     tags: [Meetings]
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
 *         description: Meetings fetched successfully
 */
export const getMeetings: RequestHandler = async (
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
       FROM meetings m
       WHERE m.business_id = $1
       AND (
         m.created_by = $2
         OR m.host_id = $2
         OR m.co_host_id = $2
         OR EXISTS (
           SELECT 1 FROM meeting_attendees ma
           WHERE ma.meeting_id = m.id AND ma.user_id = $2
         )
       )`,
      [businessId, userId],
    );
    const total = parseInt(countResult.rows[0].total);

    const result = await query(
      `SELECT 
        m.id, m.title, m.description, m.start_time as "startTime", m.end_time as "endTime", 
        m.timezone, m.created_by as "createdById", m.host_id as "hostId", m.co_host_id as "coHostId",
        m.status, m.meeting_code as "meetingCode", m.is_instant as "isInstant", m.password,
        m.max_participants as "maxParticipants", m.waiting_room_enabled as "waitingRoomEnabled",
        m.recording_enabled as "recordingEnabled", m.screen_sharing_enabled as "screenSharingEnabled",
        m.google_event_id as "googleEventId", m.created_at as "createdAt", m.updated_at as "updatedAt",
        json_agg(json_build_object(
          'id', ma.id,
          'userId', ma.user_id,
          'status', ma.status
        )) FILTER (WHERE ma.id IS NOT NULL) as attendees
      FROM meetings m
      LEFT JOIN meeting_attendees ma ON m.id = ma.meeting_id
      WHERE m.business_id = $1
      AND (
        m.created_by = $2
        OR m.host_id = $2
        OR m.co_host_id = $2
        OR EXISTS (
          SELECT 1 FROM meeting_attendees current_ma
          WHERE current_ma.meeting_id = m.id AND current_ma.user_id = $2
        )
      )
      GROUP BY m.id
      ORDER BY m.start_time DESC
      LIMIT $3 OFFSET $4`,
      [businessId, userId, limit, offset],
    );

    const meetings = result.rows.map(enrichMeeting);
    const response: ApiResponse<{ meetings: any[]; total: number }> = {
      success: true,
      data: { meetings, total },
    };
    res.json(response);
  } catch (error) {
    console.error("Get meetings error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to fetch meetings",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /meetings:
 *   post:
 *     summary: Create a meeting
 *     description: Creates a meeting.
 *     tags: [Meetings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - startTime
 *               - endTime
 *               - timezone
 *             properties:
 *               title:
 *                 type: string
 *                 example: Sprint Planning
 *               description:
 *                 type: string
 *                 example: Weekly sprint planning
 *               startTime:
 *                 type: string
 *                 format: date-time
 *                 example: 2024-01-01T10:00:00.000Z
 *               endTime:
 *                 type: string
 *                 format: date-time
 *                 example: 2024-01-01T11:00:00.000Z
 *               timezone:
 *                 type: string
 *                 example: UTC
 *               isInstant:
 *                 type: boolean
 *                 default: false
 *               attendeeIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *               password:
 *                 type: string
 *                 nullable: true
 *               maxParticipants:
 *                 type: integer
 *                 nullable: true
 *               waitingRoomEnabled:
 *                 type: boolean
 *                 default: false
 *               recordingEnabled:
 *                 type: boolean
 *                 default: false
 *               screenSharingEnabled:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       201:
 *         description: Meeting created successfully
 */
export const createMeeting: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { title, description, startTime, endTime, timezone, isInstant, attendeeIds, password, maxParticipants, waitingRoomEnabled, recordingEnabled, screenSharingEnabled } =
      req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    // Validate required fields up-front — a missing title or startTime would
    // otherwise die in Postgres (NOT NULL violation) or Date parsing
    // (RangeError) and surface as an unhelpful 500.
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ success: false, error: "Meeting title is required" });
    }
    if (!isInstant && !startTime) {
      return res.status(400).json({ success: false, error: "Meeting start time is required" });
    }
    if (startTime && isNaN(new Date(startTime).getTime())) {
      return res.status(400).json({ success: false, error: "Invalid meeting start time" });
    }
    if (!isInstant && endTime && isNaN(new Date(endTime).getTime())) {
      return res.status(400).json({ success: false, error: "Invalid meeting end time" });
    }

    const uniqueAttendeeIds = Array.from(new Set<string>(attendeeIds || []));
    const validAttendeeIds = await getBusinessUserIds(uniqueAttendeeIds, businessId);
    if (validAttendeeIds.size !== uniqueAttendeeIds.length) {
      return res.status(400).json({
        success: false,
        error: "All meeting attendees must belong to this business",
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

    // Calling provider resolved once at creation (see calls.ts — the room stays
    // on this provider for its whole lifetime even if the admin switches later).
    const callingProvider = await getActiveProviderName();

    const now = new Date();
    let finalStartTime: Date;
    let finalEndTime: Date | null;

    if (isInstant) {
      finalStartTime = now;
      // meetings.end_time is NOT NULL — instant meetings used to insert NULL and
      // fail with 23502 ("Failed to create meeting"). Default to one hour (or
      // the plan limit, whichever is shorter); the room countdown can extend it.
      const instantDurationMinutes = planMaxMeetingDuration ? Math.min(60, planMaxMeetingDuration) : 60;
      finalEndTime = new Date(now.getTime() + instantDurationMinutes * 60000);
    } else {
      finalStartTime = new Date(startTime);
      finalEndTime = endTime ? new Date(endTime) : new Date(finalStartTime.getTime() + 60 * 60000);
      if (isNaN(finalStartTime.getTime())) {
        return res.status(400).json({ success: false, error: "Invalid meeting start time" });
      }
      if (isNaN(finalEndTime.getTime())) {
        return res.status(400).json({ success: false, error: "Invalid meeting end time" });
      }

      if (planMaxMeetingDuration) {
        const maxAllowedEnd = new Date(finalStartTime.getTime() + planMaxMeetingDuration * 60000);
        if (finalEndTime > maxAllowedEnd) {
          finalEndTime = maxAllowedEnd;
        }
      }
    }

    let effectiveMaxParticipants = maxParticipants || null;
    if (planMaxParticipants) {
      if (!effectiveMaxParticipants || effectiveMaxParticipants > planMaxParticipants) {
        effectiveMaxParticipants = planMaxParticipants;
      }
    }

    // Generate unique meeting code
    let meetingCode;
    let isUnique = false;
    while (!isUnique) {
      meetingCode = generateMeetingCode();
      const check = await query(`SELECT id FROM meetings WHERE meeting_code = $1`, [meetingCode]);
      if (check.rows.length === 0) {
        isUnique = true;
      }
    }

    const result = await query(
      `INSERT INTO meetings 
        (business_id, title, description, start_time, end_time, timezone, created_by, host_id, meeting_code, 
         is_instant, password, max_participants, waiting_room_enabled, recording_enabled, screen_sharing_enabled, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id, title, description, start_time as "startTime", end_time as "endTime", 
                 timezone, created_by as "createdById", host_id as "hostId", co_host_id as "coHostId",
                 status, meeting_code as "meetingCode", is_instant as "isInstant", password,
                 max_participants as "maxParticipants", waiting_room_enabled as "waitingRoomEnabled",
                 recording_enabled as "recordingEnabled", screen_sharing_enabled as "screenSharingEnabled",
                 google_event_id as "googleEventId", provider, created_at as "createdAt", updated_at as "updatedAt"`,
      [
        businessId,
        title,
        description || null,
        finalStartTime.toISOString(),
        finalEndTime ? finalEndTime.toISOString() : null,
        timezone || 'UTC',
        userId,
        userId,
        meetingCode,
        isInstant || false,
        password || null,
        effectiveMaxParticipants,
        waitingRoomEnabled || false,
        recordingEnabled || false,
        screenSharingEnabled !== undefined ? screenSharingEnabled : true,
        callingProvider,
      ],
    );

    const meeting = result.rows[0];

    // Add attendees - deduplicate IDs to avoid unique constraint violation
    const attendees = [];
    if (uniqueAttendeeIds.length > 0) {
      // Fetch all attendee details first
      const placeholders = uniqueAttendeeIds.map((_, i) => `$${i + 1}`).join(',');
      const usersResult = await query(
        `SELECT id, name, email FROM users WHERE id IN (${placeholders})`,
        uniqueAttendeeIds
      );
      interface UserFromDb {
        id: string;
        name: string | null;
        email: string | null;
      }
      const usersMap = new Map<string, UserFromDb>(usersResult.rows.map((user: UserFromDb) => [user.id, user]));

      // Fetch the current user's details to get their name
      const currentUserResult = await query(
        `SELECT name FROM users WHERE id = $1`,
        [userId]
      );
      const currentUserName = currentUserResult.rows[0]?.name;

      for (const attendeeId of uniqueAttendeeIds) {
        const attendeeResult = await query(
          `INSERT INTO meeting_attendees (meeting_id, user_id)
           VALUES ($1, $2)
           RETURNING id, user_id as "userId", status`,
          [meeting.id, attendeeId],
        );
        attendees.push(attendeeResult.rows[0]);

        // Send in-app notification to the attendee
        await createNotification({
          businessId: businessId!,
          userId: attendeeId,
          type: "meeting",
          title: "Meeting Invitation",
          message: `${currentUserName || "Someone"} invited you to a meeting: ${title}`,
          actionUrl: `/meetings/${meeting.meetingCode}`,
          actionType: "view_meeting",
          metadata: { meetingId: meeting.id, meetingCode: meeting.meetingCode },
          isActionable: false,
          expiresInHours: 24,
        });

        // Send email invitation (include password + waiting room notices)
        const user = usersMap.get(attendeeId);
        if (user?.email) {
          const meetingLink = buildMeetingLink(meeting.meetingCode);
          const emailHtml = generateMeetingInvitationEmailHtml(
            user.name || 'User',
            title,
            description || null,
            finalStartTime,
            finalEndTime || new Date(finalStartTime.getTime() + 60 * 60000),
            meeting.meetingCode,
            currentUserName || 'Someone',
            meetingLink,
            password || null,
            waitingRoomEnabled || false
          );
          await sendEmail(user.email, user.name || 'User', `Meeting Invitation: ${title}`, emailHtml);
        }
      }
    }

    meeting.attendees = attendees;
    meeting.maxMeetingDuration = planMaxMeetingDuration;
    enrichMeeting(meeting);

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "create",
      actionType: "meeting",
      description: `Created meeting: ${meeting.title}`,
      metadata: {
        title: meeting.title,
        meetingCode: meeting.meetingCode,
        attendeeIds: uniqueAttendeeIds,
      },
    });

    // Emit socket event (meeting already enriched above with meetingLink + hasPassword)
    const io = getSocketServer();
    if (io) {
      [...new Set([userId, ...uniqueAttendeeIds])].forEach(targetId => {
        io.to(`user:${targetId}`).emit("meeting:created", meeting);
      });
    }

    const response: ApiResponse<any> = {
      success: true,
      data: meeting,
    };
    res.status(201).json(response);
  } catch (error) {
    console.error("Create meeting error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to create meeting",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /meetings/code/{code}:
 *   get:
 *     summary: Get meeting by code
 *     tags: [Meetings]
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
 *         description: Meeting found
 *       404:
 *         description: Meeting not found
 */
export const getMeetingByCode: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { code } = req.params;
    const businessId = req.user?.businessId;

    const result = await query(
      `SELECT id, title, description, start_time as "startTime", end_time as "endTime", 
              timezone, created_by as "createdById", host_id as "hostId", co_host_id as "coHostId",
              status, meeting_code as "meetingCode", is_instant as "isInstant", password,
              max_participants as "maxParticipants", waiting_room_enabled as "waitingRoomEnabled",
              recording_enabled as "recordingEnabled", screen_sharing_enabled as "screenSharingEnabled",
              google_event_id as "googleEventId", created_at as "createdAt", updated_at as "updatedAt"
       FROM meetings WHERE meeting_code = $1 AND business_id = $2`,
      [code, businessId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
      });
    }

    const meeting = result.rows[0];
    const attendeeResult = await query(
      `SELECT id, user_id as "userId", status FROM meeting_attendees WHERE meeting_id = $1`,
      [meeting.id],
    );
    meeting.attendees = attendeeResult.rows;
    enrichMeeting(meeting);

    const response: ApiResponse<any> = {
      success: true,
      data: meeting,
    };
    res.json(response);
  } catch (error) {
    console.error("Get meeting by code error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to get meeting",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /meetings/{id}:
 *   get:
 *     summary: Get a meeting by UUID or meeting code
 *     tags: [Meetings]
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
 *         description: Meeting found
 *       404:
 *         description: Meeting not found
 */
export const getMeetingById: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { id } = req.params as { id: string };
    const businessId = req.user?.businessId;

    // Only treat the param as a UUID when it actually looks like one -
    // otherwise Postgres throws 22P02 (invalid uuid input) and the route
    // would 500 on non-UUID paths like /meetings/stats.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // Resolve by UUID first, then by meeting code (clients send either)
    let result = UUID_RE.test(id)
      ? await query(
      `SELECT id, title, description, start_time as "startTime", end_time as "endTime",
              timezone, created_by as "createdById", host_id as "hostId", co_host_id as "coHostId",
              status, meeting_code as "meetingCode", is_instant as "isInstant", password,
              max_participants as "maxParticipants", waiting_room_enabled as "waitingRoomEnabled",
              recording_enabled as "recordingEnabled", screen_sharing_enabled as "screenSharingEnabled",
              google_event_id as "googleEventId", created_at as "createdAt", updated_at as "updatedAt"
       FROM meetings WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    )
      : { rows: [] as any[] };

    if (result.rows.length === 0) {
      result = await query(
        `SELECT id, title, description, start_time as "startTime", end_time as "endTime", 
                timezone, created_by as "createdById", host_id as "hostId", co_host_id as "coHostId",
                status, meeting_code as "meetingCode", is_instant as "isInstant", password,
                max_participants as "maxParticipants", waiting_room_enabled as "waitingRoomEnabled",
                recording_enabled as "recordingEnabled", screen_sharing_enabled as "screenSharingEnabled",
                google_event_id as "googleEventId", created_at as "createdAt", updated_at as "updatedAt"
         FROM meetings WHERE meeting_code = $1 AND business_id = $2`,
        [id, businessId],
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
      });
    }

    const meeting = result.rows[0];
    const attendeeResult = await query(
      `SELECT id, user_id as "userId", status FROM meeting_attendees WHERE meeting_id = $1`,
      [meeting.id],
    );
    meeting.attendees = attendeeResult.rows;
    enrichMeeting(meeting);

    const response: ApiResponse<any> = {
      success: true,
      data: meeting,
    };
    res.json(response);
  } catch (error) {
    console.error("Get meeting by id error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to get meeting",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /meetings/{id}:
 *   put:
 *     summary: Update a meeting
 *     tags: [Meetings]
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
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               startTime:
 *                 type: string
 *                 format: date-time
 *               endTime:
 *                 type: string
 *                 format: date-time
 *               timezone:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [scheduled, cancelled, completed, ongoing]
 *               attendeeIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *               password:
 *                 type: string
 *               maxParticipants:
 *                 type: integer
 *               waitingRoomEnabled:
 *                 type: boolean
 *               recordingEnabled:
 *                 type: boolean
 *               screenSharingEnabled:
 *                 type: boolean
 *               coHostId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Meeting updated successfully
 *       404:
 *         description: Meeting not found
 */
export const updateMeeting: RequestHandler = async (
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

    const {
      title,
      description,
      startTime,
      endTime,
      timezone,
      status,
      attendeeIds,
      password,
      maxParticipants,
      waitingRoomEnabled,
      recordingEnabled,
      screenSharingEnabled,
      coHostId,
    } = req.body;

    if (attendeeIds !== undefined) {
      const uniqueAttendeeIds = Array.from(new Set<string>(attendeeIds || []));
      const validAttendeeIds = await getBusinessUserIds(uniqueAttendeeIds, businessId);
      if (validAttendeeIds.size !== uniqueAttendeeIds.length) {
        return res.status(400).json({
          success: false,
          error: "All meeting attendees must belong to this business",
        });
      }
    }

    if (coHostId !== undefined && coHostId !== null) {
      const validCoHostIds = await getBusinessUserIds([coHostId], businessId);
      if (!validCoHostIds.has(coHostId)) {
        return res.status(400).json({
          success: false,
          error: "Meeting co-host must belong to this business",
        });
      }
    }

    // First get the meeting's actual id (try UUID first if valid, then code)
    let actualId: string | undefined;
    if (isValidUUID(id)) {
      const idResult = await query(
        `SELECT id FROM meetings WHERE id = $1 AND business_id = $2 AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [id, businessId, userId],
      );
      if (idResult.rows.length > 0) {
        actualId = idResult.rows[0].id;
      }
    }

    if (!actualId) {
      const codeResult = await query(
        `SELECT id FROM meetings WHERE meeting_code = $1 AND business_id = $2 AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [id, businessId, userId],
      );
      if (codeResult.rows.length > 0) {
        actualId = codeResult.rows[0].id;
      }
    }

    if (!actualId) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
      });
    }

    const result = await query(
      `UPDATE meetings
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           start_time = COALESCE($3, start_time),
           end_time = COALESCE($4, end_time),
           timezone = COALESCE($5, timezone),
           status = COALESCE($6, status),
           password = COALESCE($7, password),
           max_participants = COALESCE($8, max_participants),
           waiting_room_enabled = COALESCE($9, waiting_room_enabled),
           recording_enabled = COALESCE($10, recording_enabled),
           screen_sharing_enabled = COALESCE($11, screen_sharing_enabled),
           co_host_id = COALESCE($12, co_host_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $13 AND business_id = $14
       AND (created_by = $15 OR host_id = $15 OR co_host_id = $15)
       RETURNING id, title, description, start_time as "startTime", end_time as "endTime", 
                 timezone, created_by as "createdById", host_id as "hostId", co_host_id as "coHostId",
                 status, meeting_code as "meetingCode", is_instant as "isInstant", password,
                 max_participants as "maxParticipants", waiting_room_enabled as "waitingRoomEnabled",
                 recording_enabled as "recordingEnabled", screen_sharing_enabled as "screenSharingEnabled",
                 google_event_id as "googleEventId", created_at as "createdAt", updated_at as "updatedAt"`,
      [
        title,
        description,
        startTime ? new Date(startTime).toISOString() : null,
        endTime ? new Date(endTime).toISOString() : null,
        timezone,
        status,
        password,
        maxParticipants,
        waitingRoomEnabled,
        recordingEnabled,
        screenSharingEnabled,
        coHostId,
        actualId,
        businessId,
        userId,
      ],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
      });
    }

    const meeting = result.rows[0];

    // Update attendees if provided
    if (attendeeIds !== undefined) {
      await query(`DELETE FROM meeting_attendees WHERE meeting_id = $1`, [actualId]);
      const attendees = [];
      if (attendeeIds.length > 0) {
        const uniqueAttendeeIds = Array.from(new Set<string>(attendeeIds));
        for (const attendeeId of uniqueAttendeeIds) {
          const attendeeResult = await query(
            `INSERT INTO meeting_attendees (meeting_id, user_id)
             VALUES ($1, $2)
             RETURNING id, user_id as "userId", status`,
            [actualId, attendeeId],
          );
          attendees.push(attendeeResult.rows[0]);
        }
      }
      meeting.attendees = attendees;
    } else {
      // Get existing attendees
      const attendeeResult = await query(
        `SELECT id, user_id as "userId", status FROM meeting_attendees WHERE meeting_id = $1`,
        [actualId],
      );
      meeting.attendees = attendeeResult.rows;
    }
    enrichMeeting(meeting);

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "update",
      actionType: "meeting",
      description: `Updated meeting: ${meeting.title}`,
      metadata: {
        title: meeting.title,
        attendeeIds: attendeeIds || [],
      },
    });

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      io.to(`business:${businessId}`).emit("meeting:updated", meeting);
    }

    const response: ApiResponse<any> = {
      success: true,
      data: meeting,
    };
    res.json(response);
  } catch (error) {
    console.error("Update meeting error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to update meeting",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /meetings/{id}:
 *   delete:
 *     summary: Delete a meeting
 *     tags: [Meetings]
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
 *         description: Meeting deleted successfully
 *       404:
 *         description: Meeting not found
 */
export const deleteMeeting: RequestHandler = async (
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

    // Get meeting info first (try UUID first if valid, then code)
    let actualId: string | undefined;
    let meetingTitle: string | undefined;

    if (isValidUUID(id)) {
      const idResult = await query(
        `SELECT id, title FROM meetings
         WHERE id = $1 AND business_id = $2
         AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [id, businessId, userId],
      );
      if (idResult.rows.length > 0) {
        actualId = idResult.rows[0].id;
        meetingTitle = idResult.rows[0].title;
      }
    }

    if (!actualId) {
      const codeResult = await query(
        `SELECT id, title FROM meetings
         WHERE meeting_code = $1 AND business_id = $2
         AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [id, businessId, userId],
      );
      if (codeResult.rows.length > 0) {
        actualId = codeResult.rows[0].id;
        meetingTitle = codeResult.rows[0].title;
      }
    }

    if (!actualId || !meetingTitle) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
      });
    }

    // Delete attendees first
    await query(`DELETE FROM meeting_attendees WHERE meeting_id = $1`, [actualId]);

    // Delete reminders
    await query(`DELETE FROM meeting_reminders WHERE meeting_id = $1`, [actualId]);

    // Delete meeting
    await query(`DELETE FROM meetings WHERE id = $1 AND business_id = $2`, [
      actualId,
      businessId,
    ]);

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "delete",
      actionType: "meeting",
      description: `Deleted meeting: ${meetingTitle}`,
      metadata: {
        title: meetingTitle,
      },
    });

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      io.to(`business:${businessId}`).emit("meeting:deleted", id);
    }

    const response: ApiResponse<null> = {
      success: true,
    };
    res.json(response);
  } catch (error) {
    console.error("Delete meeting error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to delete meeting",
    };
    res.status(500).json(response);
  }
};

export const addMeetingParticipants: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { meetingId } = req.params as { meetingId: string };
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

    // Check if meeting exists by UUID or by meeting code
    let meetingResult;
    if (isValidUUID(meetingId)) {
      meetingResult = await query(
        `SELECT id, title, start_time, end_time, meeting_code FROM meetings
         WHERE id = $1 AND business_id = $2
         AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [meetingId, businessId, userId],
      );
    }

    // If not found by UUID (or not a UUID), try by meeting code
    if (!meetingResult || meetingResult.rows.length === 0) {
      meetingResult = await query(
        `SELECT id, title, start_time, end_time, meeting_code FROM meetings
         WHERE meeting_code = $1 AND business_id = $2
         AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
        [meetingId, businessId, userId],
      );
    }

    if (meetingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
      });
    }

    const meeting = meetingResult.rows[0];
    const actualMeetingId = meeting.id; // Use the actual UUID

    // Get existing attendees
    const existingAttendeesResult = await query(
      `SELECT user_id FROM meeting_attendees WHERE meeting_id = $1`,
      [actualMeetingId],
    );
    const existingUserIds = new Set(existingAttendeesResult.rows.map((row) => row.user_id));

    // Validate all participantIds belong to the business (team-member path only)
    const uniqueParticipantIds = Array.from(new Set(participantIds || []));
    if (uniqueParticipantIds.length > 0) {
      const validUserIds = await getBusinessUserIds(uniqueParticipantIds, businessId);
      if (validUserIds.size !== uniqueParticipantIds.length) {
        return res.status(400).json({
          success: false,
          error: "All participants must belong to this business",
        });
      }
    }

    // Filter out existing attendees
    const newParticipantIds = uniqueParticipantIds.filter((id) => !existingUserIds.has(id));

    if (newParticipantIds.length === 0 && !hasEmails) {
      return res.json({
        success: true,
        message: "No new participants added (all were already in the meeting)",
        data: { added: [] },
      });
    }

    // Bulk insert new attendees
    const addedAttendees = [];
    const currentUserResult = await query(
      `SELECT name FROM users WHERE id = $1`,
      [userId],
    );
    const currentUserName = currentUserResult.rows[0]?.name || 'Someone';
    const fullMeetingResult = await query(
      `SELECT password, waiting_room_enabled FROM meetings WHERE id = $1`,
      [actualMeetingId],
    );
    const fullMeeting = fullMeetingResult.rows[0];
    const meetingLink = buildMeetingLink(meeting.meeting_code || '');

    for (const attendeeId of newParticipantIds) {
      const attendeeResult = await query(
        `INSERT INTO meeting_attendees (meeting_id, user_id)
         VALUES ($1, $2)
         RETURNING id, user_id as "userId", status`,
        [actualMeetingId, attendeeId],
      );
      addedAttendees.push(attendeeResult.rows[0]);

      // Side effects are best-effort: failing notification/email must never
      // turn the request into a 500 (the attendee row is already inserted).
      try {
        await createNotification({
          businessId: businessId,
          userId: attendeeId,
          type: "meeting",
          title: "Meeting Invitation",
          message: `You've been invited to a meeting: ${meeting.title}`,
          actionUrl: `/meetings/${meeting.meeting_code}`,
          actionType: "view_meeting",
          metadata: { meetingId: actualMeetingId },
          isActionable: false,
          expiresInHours: 24,
        });
      } catch (notifyError) {
        console.error(`Add meeting participants: failed to notify ${attendeeId}:`, notifyError);
      }

      // Send email invitation
      try {
        const userResult = await query(
          `SELECT name, email FROM users WHERE id = $1`,
          [attendeeId],
        );
        const user = userResult.rows[0];
        if (user?.email) {
          const emailHtml = generateMeetingInvitationEmailHtml(
            user.name || 'User',
            meeting.title,
            null,
            new Date(meeting.start_time),
            new Date(meeting.end_time),
            meeting.meeting_code || '',
            currentUserName,
            meetingLink,
            fullMeeting?.password || null,
            !!fullMeeting?.waiting_room_enabled
          );
          await sendEmail(user.email, user.name || 'User', `Meeting Invitation: ${meeting.title}`, emailHtml);
        }
      } catch (emailError) {
        console.error(`Add meeting participants: failed to email invitee ${attendeeId}:`, emailError);
      }
    }

    // ===== External email invites (people without accounts) =====
    // Guests join via the public meeting link (/meetings/:code -> guest join).
    const invitedViaEmail: string[] = [];
    if (hasEmails) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const validEmails = [...new Set((emails as string[])
        .map((e: string) => String(e || '').trim().toLowerCase())
        .filter((e: string) => emailRegex.test(e)))] as string[];

      for (const email of validEmails) {
        try {
          const emailHtml = generateMeetingInvitationEmailHtml(
            email.split('@')[0],
            meeting.title,
            null,
            new Date(meeting.start_time),
            new Date(meeting.end_time),
            meeting.meeting_code || '',
            currentUserName,
            meetingLink,
            fullMeeting?.password || null,
            !!fullMeeting?.waiting_room_enabled
          );
          const sent = await sendEmail(
            email,
            email.split('@')[0],
            `${currentUserName} invited you to a meeting: ${meeting.title}`,
            emailHtml
          );
          if (sent) invitedViaEmail.push(email);
        } catch (emailError) {
          console.error(`Add meeting participants: failed to email external invitee ${email}:`, emailError);
        }
      }
    }

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "update",
      actionType: "meeting",
      description: `Added participants to meeting: ${meeting.title}`,
      metadata: {
        title: meeting.title,
        addedParticipantIds: newParticipantIds,
      },
    });

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      const updatedMeetingResult = await query(
        `SELECT m.id, m.title, m.description, m.start_time as "startTime", m.end_time as "endTime",
                m.timezone, m.created_by as "createdById", m.host_id as "hostId", m.co_host_id as "coHostId",
                m.status, m.meeting_code as "meetingCode", m.is_instant as "isInstant", m.password,
                m.max_participants as "maxParticipants", m.waiting_room_enabled as "waitingRoomEnabled",
                m.recording_enabled as "recordingEnabled", m.screen_sharing_enabled as "screenSharingEnabled",
                m.google_event_id as "googleEventId", m.created_at as "createdAt", m.updated_at as "updatedAt"
         FROM meetings m WHERE m.id = $1`,
        [actualMeetingId],
      );
      const updatedMeeting = updatedMeetingResult.rows[0];
      const attendeeResult = await query(
        `SELECT id, user_id as "userId", status FROM meeting_attendees WHERE meeting_id = $1`,
        [actualMeetingId],
      );
      updatedMeeting.attendees = attendeeResult.rows;
      enrichMeeting(updatedMeeting);
      io.to(`business:${businessId}`).emit("meeting:updated", updatedMeeting);
    }

    res.json({
      success: true,
      message: [
        newParticipantIds.length > 0 ? `${newParticipantIds.length} participant(s) added` : null,
        invitedViaEmail.length > 0 ? `${invitedViaEmail.length} email invite(s) sent` : null,
      ].filter(Boolean).join(' · ') || 'No new participants added (all were already in the meeting)',
      data: { added: newParticipantIds, invitedEmails: invitedViaEmail },
    });
  } catch (error) {
    console.error("Add meeting participants error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to add participants",
    });
  }
};

export const joinMeeting: RequestHandler = async (
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

    // Resolve the meeting: own business first (id, then code), then a
    // cross-business fallback for hosts/co-hosts/invited attendees whose
    // account context differs from the meeting owner's business (the strict
    // business_id filter used to 404 "Meeting not found" on legitimate joins).
    const JOIN_LOOKUP_COLS = `id, business_id, password, status, start_time, end_time, is_instant, waiting_room_enabled, max_participants, host_id, co_host_id, created_by`;
    const isUuid = isValidUUID(id);
    const codeKey = isUuid ? null : id.trim().toUpperCase();

    let meetingState: any = undefined;
    if (isUuid) {
      meetingState = (
        await query(
          `SELECT ${JOIN_LOOKUP_COLS} FROM meetings WHERE id = $1 AND business_id = $2`,
          [id, businessId],
        )
      ).rows[0];
    }
    if (!meetingState && codeKey) {
      meetingState = (
        await query(
          `SELECT ${JOIN_LOOKUP_COLS} FROM meetings WHERE meeting_code = $1 AND business_id = $2`,
          [codeKey, businessId],
        )
      ).rows[0];
    }
    if (!meetingState) {
      // Cross-business fallback: global lookup, allowed ONLY for the
      // host/co-host/creator or an already-invited attendee of that meeting.
      const candidate = (
        isUuid
          ? await query(`SELECT ${JOIN_LOOKUP_COLS} FROM meetings WHERE id = $1`, [id])
          : await query(`SELECT ${JOIN_LOOKUP_COLS} FROM meetings WHERE meeting_code = $1`, [codeKey])
      ).rows[0];
      if (candidate) {
        const attendeeRow = await query(
          `SELECT 1 FROM meeting_attendees WHERE meeting_id = $1 AND user_id = $2 LIMIT 1`,
          [candidate.id, userId],
        );
        if (
          candidate.host_id === userId ||
          candidate.co_host_id === userId ||
          candidate.created_by === userId ||
          attendeeRow.rows.length > 0
        ) {
          meetingState = candidate;
        }
      }
    }

    if (!meetingState) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
        errorCode: "meeting_not_found",
      });
    }

    const actualId: string = meetingState.id;
    const now = new Date();

    // 1) Status validation
    if (meetingState.status === 'cancelled') {
      return res.status(410).json({
        success: false,
        error: "Meeting has been cancelled",
        errorCode: 'meeting_cancelled',
      });
    }
    if (meetingState.status === 'completed') {
      return res.status(410).json({
        success: false,
        error: "Meeting has already ended",
        errorCode: 'meeting_completed',
      });
    }

    // 2) Password validation — hosts/co-hosts/creators are NEVER prompted
    //    for their own meeting (the join UI doesn't even show them a password
    //    field, so requiring one made host joins fail with "Invalid password").
    const isHost =
      meetingState.host_id === userId ||
      meetingState.co_host_id === userId ||
      meetingState.created_by === userId;
    if (!isHost && meetingState.password && meetingState.password !== password) {
      return res.status(403).json({
        success: false,
        error: "Invalid password",
        errorCode: 'invalid_password',
        data: { hasPassword: true },
      });
    }

    // 3) Timing validation (non-instant meetings)
    let earlyJoin = false;
    if (!meetingState.is_instant && meetingState.end_time) {
      if (new Date(meetingState.end_time) < now) {
        return res.status(410).json({
          success: false,
          error: "Meeting is no longer active (end time has passed)",
          errorCode: 'meeting_ended',
        });
      }
      // Allow up to 15 minutes early; otherwise let user know it's early but permit with flag
      const startTime = new Date(meetingState.start_time);
      const fifteenMinBefore = new Date(startTime.getTime() - 15 * 60 * 1000);
      if (now < fifteenMinBefore) {
        earlyJoin = true;
      }
    }

    // 4) Max participants check (host/co-host/created-by can always join)
    if (!isHost && meetingState.max_participants) {
      const countRes = await query(
        `SELECT COUNT(*) FROM meeting_attendees WHERE meeting_id = $1 AND status = 'joined'`,
        [actualId],
      );
      const countJoined = parseInt(countRes.rows[0].count);
      if (countJoined >= meetingState.max_participants) {
        return res.status(409).json({
          success: false,
          error: "Meeting is at maximum capacity",
          errorCode: 'max_participants_reached',
          data: { maxParticipants: meetingState.max_participants },
        });
      }
    }

    // 5) Add/update the attendee. If waiting room is enabled AND user is NOT host -> status = waiting
    const joiningAsHost = isHost;
    const useWaitingRoom = !!meetingState.waiting_room_enabled && !joiningAsHost;
    const effectiveStatus = useWaitingRoom ? 'waiting' : 'joined';

    const existingAttendee = await query(
      `SELECT id FROM meeting_attendees WHERE meeting_id = $1 AND user_id = $2`,
      [actualId, userId],
    );
    if (existingAttendee.rows.length === 0) {
      await query(
        `INSERT INTO meeting_attendees (meeting_id, user_id, status) VALUES ($1, $2, $3)`,
        [actualId, userId, effectiveStatus],
      );
    } else if (effectiveStatus === 'joined') {
      await query(
        `UPDATE meeting_attendees SET status = $1, joined_at = CURRENT_TIMESTAMP WHERE meeting_id = $2 AND user_id = $3`,
        [effectiveStatus, actualId, userId],
      );
    } else {
      await query(
        `UPDATE meeting_attendees SET status = $1 WHERE meeting_id = $2 AND user_id = $3`,
        [effectiveStatus, actualId, userId],
      );
    }

    // Return the full meeting object with enrichment + access flags
    const meetingResult = await query(
      `SELECT id, business_id as "businessId", title, description, status, start_time as "startTime", 
              end_time as "endTime", timezone, created_by as "createdById", host_id as "hostId",
              co_host_id as "coHostId", meeting_code as "meetingCode", password, is_instant as "isInstant",
              waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
              screen_sharing_enabled as "screenSharingEnabled", max_participants as "maxParticipants",
              google_event_id as "googleEventId", provider, created_at as "createdAt", updated_at as "updatedAt"
       FROM meetings WHERE id = $1`,
      [actualId],
    );
    if (meetingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
        errorCode: "meeting_not_found",
      });
    }

    const meeting = meetingResult.rows[0];

    const planResult = await query(
      `SELECT pp.max_meeting_duration as "maxMeetingDuration"
       FROM businesses b 
       LEFT JOIN pricing_plans pp ON b.plan_id = pp.id 
       WHERE b.id = $1`,
      [meeting.businessId || businessId]
    );
    meeting.maxMeetingDuration = planResult.rows[0]?.maxMeetingDuration || null;

    const attendeesResult = await query(
      `SELECT id, user_id as "userId", status, joined_at as "joinedAt"
       FROM meeting_attendees WHERE meeting_id = $1`,
      [actualId],
    );
    meeting.attendees = attendeesResult.rows;
    enrichMeeting(meeting);

    // Attach access flags for the frontend to handle
    meeting.earlyJoin = earlyJoin;
    meeting.inWaitingRoom = useWaitingRoom;
    meeting.isHost = joiningAsHost;

    // Provider-specific media credentials for the joining participant
    // (LiveKit JWT minted server-side; mediasoup requires none).
    try {
      const userRes = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
      const provider = await resolveProviderForRoom("meeting", actualId, (meeting as any).provider || null);
      meeting.calling = await buildCallingCredentials(provider, {
        roomType: "meeting",
        roomId: actualId,
        title: meeting.title || "",
        identity: userId,
        displayName: userRes.rows[0]?.name || "User",
        isHost: joiningAsHost,
        remainingSeconds: computeRemainingSeconds(meeting.endTime),
        maxParticipants: meeting.maxParticipants || null,
      });
    } catch (err) {
      console.error("Failed to build meeting calling credentials:", err);
    }

    const response: ApiResponse<any> = {
      success: true,
      data: meeting,
    };
    res.json(response);
  } catch (error) {
    console.error("Join meeting error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to join meeting",
    };
    res.status(500).json(response);
  }
};

/**
 * Leave a meeting (REST counterpart of POST /calls/:id/leave).
 * Marks the current user's attendee row as 'left' and broadcasts to the room.
 * Called by both the web app and the mobile app when leaving the meeting room.
 */
export const leaveMeeting: RequestHandler = async (
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

    let actualId: string | undefined;
    if (isValidUUID(id)) {
      const idResult = await query(
        `SELECT id FROM meetings WHERE id = $1 AND business_id = $2`,
        [id, businessId],
      );
      if (idResult.rows.length > 0) {
        actualId = idResult.rows[0].id;
      }
    }

    if (!actualId) {
      const codeResult = await query(
        `SELECT id FROM meetings WHERE meeting_code = $1 AND business_id = $2`,
        [id, businessId],
      );
      if (codeResult.rows.length > 0) {
        actualId = codeResult.rows[0].id;
      }
    }

    if (!actualId) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
      });
    }

    await query(
      `UPDATE meeting_attendees
       SET status = 'left', left_at = CURRENT_TIMESTAMP
       WHERE meeting_id = $1 AND user_id = $2`,
      [actualId, userId],
    );

    const meetingResult = await query(
      `SELECT id, business_id as "businessId", title, description, status, start_time as "startTime",
              end_time as "endTime", timezone, created_by as "createdById", host_id as "hostId",
              co_host_id as "coHostId", meeting_code as "meetingCode", password, is_instant as "isInstant",
              waiting_room_enabled as "waitingRoomEnabled", recording_enabled as "recordingEnabled",
              screen_sharing_enabled as "screenSharingEnabled", max_participants as "maxParticipants",
              google_event_id as "googleEventId", created_at as "createdAt", updated_at as "updatedAt"
       FROM meetings WHERE id = $1 AND business_id = $2`,
      [actualId, businessId],
    );
    const meeting = meetingResult.rows[0];

    if (meeting) {
      const attendeesResult = await query(
        `SELECT id, user_id as "userId", status, joined_at as "joinedAt", left_at as "leftAt"
         FROM meeting_attendees WHERE meeting_id = $1`,
        [actualId],
      );
      meeting.attendees = attendeesResult.rows;
      enrichMeeting(meeting);
    }

    const io = getSocketServer();
    if (io) {
      // Emit both spellings: camelCase (Flutter) and hyphenated (web)
      io.to(`meeting:${actualId}`).emit("meeting:participantLeft", {
        meetingId: actualId,
        userId,
      });
      io.to(`room:${actualId}`).emit("meeting:participantLeft", {
        meetingId: actualId,
        userId,
      });
      io.to(`meeting:${actualId}`).emit("meeting:participant-left", {
        meetingId: actualId,
        roomId: actualId,
        userId,
      });
      io.to(`room:${actualId}`).emit("meeting:participant-left", {
        meetingId: actualId,
        roomId: actualId,
        userId,
      });
    }

    const response: ApiResponse<any> = {
      success: true,
      data: meeting,
    };
    res.json(response);
  } catch (error) {
    console.error("Leave meeting error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to leave meeting",
    };
    res.status(500).json(response);
  }
};

/**
 * Pre-validation endpoint — what the frontend calls when a user clicks a meeting link.
 * Returns: meeting state, security flags (password/waiting room), status, timing info — without
 * requiring a password unless one is set. The password itself is NEVER returned.
 */
export const validateMeetingAccess: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const code = String(req.params.code || "");
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const VALIDATE_COLS = `id, business_id, title, description, status, start_time as "startTime", 
            end_time as "endTime", timezone, meeting_code as "meetingCode",
            is_instant as "isInstant", waiting_room_enabled as "waitingRoomEnabled",
            max_participants as "maxParticipants", host_id as "hostId",
            co_host_id as "coHostId", created_by as "createdById", password,
            recording_enabled as "recordingEnabled", screen_sharing_enabled as "screenSharingEnabled"`;
    const isUuidCode = isValidUUID(code);
    const codeKey = isUuidCode ? null : code.trim().toUpperCase();

    let raw: any = undefined;
    // Own business first (code or id)
    raw = (
      await query(
        `SELECT ${VALIDATE_COLS}
         FROM meetings
         WHERE (meeting_code = $1 OR id::text = $1) AND business_id = $2`,
        [code, businessId],
      )
    ).rows[0];
    if (!raw) {
      // Cross-business fallback: hosts/co-hosts/creators and already-invited
      // attendees may open meeting links whose business differs from theirs.
      const candidate = (
        isUuidCode
          ? await query(`SELECT ${VALIDATE_COLS} FROM meetings WHERE id::text = $1`, [code])
          : await query(`SELECT ${VALIDATE_COLS} FROM meetings WHERE meeting_code = $1`, [codeKey])
      ).rows[0];
      if (candidate) {
        const attendeeRow = await query(
          `SELECT 1 FROM meeting_attendees WHERE meeting_id = $1 AND user_id = $2 LIMIT 1`,
          [candidate.id, userId],
        );
        if (
          candidate.hostId === userId ||
          candidate.coHostId === userId ||
          candidate.createdById === userId ||
          attendeeRow.rows.length > 0
        ) {
          raw = candidate;
        }
      }
    }

    if (!raw) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
        errorCode: 'meeting_not_found',
      });
    }

    const now = new Date();
    const isHost =
      raw.hostId === userId ||
      raw.coHostId === userId ||
      raw.createdById === userId;

    // Security: strip real password, keep hasPassword flag
    const hasPassword = !!raw.password;
    delete raw.password;

    // Compute access state
    let accessState: 'allowed' | 'password_required' | 'waiting_room' | 'not_started' | 'ended' | 'cancelled' | 'completed' | 'full' = 'allowed';
    const reasons: string[] = [];

    if (raw.status === 'cancelled') {
      accessState = 'cancelled';
      reasons.push('Meeting has been cancelled');
    } else if (raw.status === 'completed') {
      accessState = 'completed';
      reasons.push('Meeting has been completed');
    } else if (raw.endTime && new Date(raw.endTime) < now) {
      accessState = 'ended';
      reasons.push('Meeting end time has passed');
    } else if (!raw.isInstant && raw.startTime) {
      const startTime = new Date(raw.startTime);
      const fifteenMinBefore = new Date(startTime.getTime() - 15 * 60 * 1000);
      if (now < fifteenMinBefore) {
        accessState = 'not_started';
        reasons.push(`Meeting hasn't started yet (starts in ${Math.ceil((startTime.getTime() - now.getTime()) / 60000)} min)`);
      }
    }

    if (accessState === 'allowed' && hasPassword && !isHost) {
      accessState = 'password_required';
      reasons.push('This meeting requires a password to join');
    }
    if (accessState !== 'password_required' && !isHost && raw.waitingRoomEnabled) {
      accessState = 'waiting_room';
      reasons.push('This meeting has waiting room enabled. You will be admitted by the host.');
    }

    // Max participants capacity check
    let joinedCount = 0;
    let maxParticipants = raw.maxParticipants;
    if (!isHost && raw.maxParticipants) {
      const countRes = await query(
        `SELECT COUNT(*) FROM meeting_attendees WHERE meeting_id = $1 AND status = 'joined'`,
        [raw.id],
      );
      joinedCount = parseInt(countRes.rows[0].count);
      if (accessState === 'allowed' || accessState === 'password_required' || accessState === 'waiting_room') {
        if (joinedCount >= raw.maxParticipants) {
          accessState = 'full';
          reasons.push('Meeting is currently at maximum capacity');
        }
      }
    }

    const meetingLink = buildMeetingLink(raw.meetingCode);

    const response: ApiResponse<any> = {
      success: true,
      data: {
        id: raw.id,
        title: raw.title,
        description: raw.description,
        status: raw.status,
        startTime: raw.startTime,
        endTime: raw.endTime,
        timezone: raw.timezone,
        meetingCode: raw.meetingCode,
        meetingLink,
        isInstant: raw.isInstant,
        waitingRoomEnabled: raw.waitingRoomEnabled,
        recordingEnabled: raw.recordingEnabled,
        screenSharingEnabled: raw.screenSharingEnabled,
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
    console.error("Validate meeting access error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to validate meeting access",
    });
  }
};

/**
 * @swagger
 * /meetings/guest/validate/{code}:
 *   get:
 *     summary: Validate guest access to a meeting (public - no auth required)
 *     description: Lets a guest (or any user) check whether a meeting code exists and whether they can join. Used by the join-by-link experience.
 *     tags: [Meetings]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: token
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional invitation token for private meetings
 *     responses:
 *       200:
 *         description: Meeting access validation result
 */
export const guestValidateMeeting: RequestHandler = async (req, res) => {
  try {
    const { code } = req.params;
    const inviteToken = (req.query.token as string) || null;

    // NOTE: intentionally NOT scoped to a business - guests join cross-business by code
    const result = await query(
      `SELECT id, title, description, status, start_time as "startTime",
              end_time as "endTime", timezone, meeting_code as "meetingCode",
              is_instant as "isInstant", waiting_room_enabled as "waitingRoomEnabled",
              max_participants as "maxParticipants", host_id as "hostId",
              co_host_id as "coHostId", created_by as "createdById", password,
              recording_enabled as "recordingEnabled", screen_sharing_enabled as "screenSharingEnabled"
       FROM meetings
       WHERE meeting_code = $1 OR id::text = $1`,
      [code],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
        errorCode: "meeting_not_found",
      });
    }

    const raw = result.rows[0];
    const now = new Date();

    // If an invite token was provided, check whether it is still usable
    let inviteValid = false;
    if (inviteToken) {
      const tokenRes = await query(
        `SELECT 1 FROM invitation_tokens
         WHERE token = $1 AND room_id = $2 AND used = FALSE AND expires_at > NOW()`,
        [inviteToken, raw.id],
      );
      inviteValid = tokenRes.rows.length > 0;
    }

    const hasPassword = !!raw.password;

    let accessState:
      | "allowed"
      | "password_required"
      | "waiting_room"
      | "not_started"
      | "ended"
      | "cancelled"
      | "completed"
      | "full" = "allowed";
    const reasons: string[] = [];

    if (raw.status === "cancelled") {
      accessState = "cancelled";
      reasons.push("Meeting has been cancelled");
    } else if (raw.status === "completed") {
      accessState = "completed";
      reasons.push("Meeting has been completed");
    } else if (raw.endTime && new Date(raw.endTime) < now) {
      accessState = "ended";
      reasons.push("Meeting end time has passed");
    } else if (!raw.isInstant && raw.startTime) {
      const startTime = new Date(raw.startTime);
      const fifteenMinBefore = new Date(startTime.getTime() - 15 * 60 * 1000);
      if (now < fifteenMinBefore) {
        accessState = "not_started";
        reasons.push(
          `Meeting hasn't started yet (starts in ${Math.ceil((startTime.getTime() - now.getTime()) / 60000)} min)`,
        );
      }
    }

    if (accessState === "allowed" && hasPassword && !inviteValid) {
      accessState = "password_required";
      reasons.push("This meeting requires a password to join");
    }
    if (accessState === "allowed" && raw.waitingRoomEnabled) {
      accessState = "waiting_room";
      reasons.push("The host will admit you shortly");
    }

    // Capacity check (joined attendees vs max)
    let joinedCount = 0;
    if (raw.maxParticipants) {
      const countRes = await query(
        `SELECT COUNT(*) FROM meeting_attendees WHERE meeting_id = $1 AND status = 'joined'`,
        [raw.id],
      );
      joinedCount = parseInt(countRes.rows[0].count);
      if (
        (accessState === "allowed" || accessState === "password_required" || accessState === "waiting_room") &&
        joinedCount >= raw.maxParticipants
      ) {
        accessState = "full";
        reasons.push("Meeting is currently at maximum capacity");
      }
    }

    const response: ApiResponse<any> = {
      success: true,
      data: {
        id: raw.id,
        title: raw.title,
        description: raw.description,
        status: raw.status,
        startTime: raw.startTime,
        endTime: raw.endTime,
        timezone: raw.timezone,
        meetingCode: raw.meetingCode,
        meetingLink: buildMeetingLink(raw.meetingCode),
        isInstant: raw.isInstant,
        waitingRoomEnabled: raw.waitingRoomEnabled,
        recordingEnabled: raw.recordingEnabled,
        screenSharingEnabled: raw.screenSharingEnabled,
        maxParticipants: raw.maxParticipants,
        currentParticipants: joinedCount,
        hasPassword,
        isHost: false,
        isGuest: true,
        inviteValid,
        accessState,
        reasons,
      },
    };
    res.json(response);
  } catch (error) {
    console.error("Guest validate meeting error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to validate meeting access",
    });
  }
};

/**
 * @swagger
 * /meetings/generate-invite:
 *   post:
 *     summary: Generate a guest invite link for a meeting
 *     tags: [Meetings]
 *     security:
 *       - bearerAuth: []
 */
export const generateMeetingInvite: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { roomId, participantName } = req.body || {};
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }
    if (!roomId) {
      return res.status(400).json({ success: false, error: "roomId is required" });
    }

    // Resolve meeting (id or code) inside the host's business
    // `id::text = $1` avoids the 22P02 cast error when roomId is a CODE.
    const meetingRes = await query(
      `SELECT id, meeting_code as "meetingCode", title FROM meetings
       WHERE (meeting_code = $1 OR id::text = $1) AND business_id = $2`,
      [roomId, businessId],
    );
    if (meetingRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Meeting not found" });
    }
    const meeting = meetingRes.rows[0];

    // Create a reusable-ish invite token (24h validity, single use)
    const token = crypto.randomBytes(32).toString("hex");
    await query(
      `INSERT INTO invitation_tokens (token, room_id, expires_at, used)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours', FALSE)`,
      [token, meeting.id],
    );

    const meetingLink = buildMeetingLink(meeting.meetingCode);
    const separator = meetingLink.includes("?") ? "&" : "?";
    const inviteLink = `${meetingLink}${separator}token=${token}&guest=1`;

    res.json({
      success: true,
      data: {
        inviteLink,
        token,
        meetingCode: meeting.meetingCode,
        expiresInHours: 24,
      },
    });
  } catch (error) {
    console.error("Generate meeting invite error:", error);
    res.status(500).json({ success: false, error: "Failed to generate invite link" });
  }
};

// ==================== GUEST ACCESS ====================
// Guests (no account) join via public meeting links using a short-lived
// guest token scoped to a single meeting room.

export const guestJoinMeeting: RequestHandler = async (req, res) => {
  try {
    const { code } = req.params;
    const { name, password } = req.body || {};

    if (!code) {
      return res.status(400).json({ success: false, error: "Meeting code is required" });
    }
    const guestName = (name || "").toString().trim().slice(0, 60);
    if (!guestName) {
      return res.status(400).json({ success: false, error: "Your name is required to join as a guest" });
    }

    // Look up meeting globally by code (guests are not business-scoped)
    const meetingRes = await query(
      `SELECT m.id, m.title, m.status, m.start_time, m.end_time, m.password, m.waiting_room_enabled,
              m.max_participants, m.meeting_code, m.business_id, m.recording_enabled, m.screen_sharing_enabled,
              u.name AS host_name
       FROM meetings m
       LEFT JOIN users u ON m.host_id = u.id
       WHERE m.meeting_code = $1`,
      [code]
    );

    if (meetingRes.rows.length === 0) {
      return res.status(404).json({ success: false, errorCode: "MEETING_NOT_FOUND", error: "Meeting not found" });
    }

    const meeting = meetingRes.rows[0];

    if (meeting.status === "cancelled") {
      return res.status(410).json({ success: false, errorCode: "MEETING_CANCELLED", error: "This meeting has been cancelled" });
    }
    if (meeting.status === "completed") {
      return res.status(410).json({ success: false, errorCode: "MEETING_COMPLETED", error: "This meeting has already ended" });
    }
    if (meeting.end_time && new Date(meeting.end_time).getTime() < Date.now() - 60 * 60 * 1000) {
      return res.status(410).json({ success: false, errorCode: "MEETING_ENDED", error: "This meeting has ended" });
    }

    // Password check
    if (meeting.password && meeting.password !== password) {
      return res.status(403).json({ success: false, errorCode: "PASSWORD_REQUIRED", error: "Incorrect meeting password" });
    }

    // Capacity check (count of joined attendees)
    if (meeting.max_participants) {
      const countRes = await query(
        `SELECT COUNT(*)::int AS joined FROM meeting_attendees WHERE meeting_id = $1 AND status = 'joined'`,
        [meeting.id]
      );
      if (countRes.rows[0].joined >= meeting.max_participants) {
        return res.status(409).json({ success: false, errorCode: "MAX_PARTICIPANTS_REACHED", error: "Meeting is full" });
      }
    }

    const { generateGuestToken } = await import("../utils/guestTokens");
    const { token, payload } = generateGuestToken({
      name: guestName,
      scope: "meeting",
      roomId: meeting.id,
      businessId: meeting.business_id,
      ttlMinutes: 6 * 60,
    });

    // Provider-specific media credentials for the guest (never host grants).
    let calling: unknown;
    try {
      const provider = await resolveProviderForRoom("meeting", meeting.id, (meeting as any).provider || null);
      calling = await buildCallingCredentials(provider, {
        roomType: "meeting",
        roomId: meeting.id,
        title: meeting.title || "",
        identity: payload.guestId,
        displayName: guestName,
        isHost: false,
        remainingSeconds: computeRemainingSeconds(meeting.end_time),
        maxParticipants: meeting.max_participants || null,
      });
    } catch (err) {
      console.error("Failed to build guest meeting calling credentials:", err);
    }

    res.json({
      success: true,
      data: {
        meeting: {
          id: meeting.id,
          title: meeting.title,
          meetingCode: meeting.meeting_code,
          status: meeting.status,
          startTime: meeting.start_time,
          endTime: meeting.end_time,
          hostName: meeting.host_name,
          waitingRoomEnabled: meeting.waiting_room_enabled,
          recordingEnabled: meeting.recording_enabled,
          screenSharingEnabled: meeting.screen_sharing_enabled,
          hasPassword: Boolean(meeting.password),
        },
        guestToken: token,
        guestId: payload.guestId,
        guestName,
        roomId: meeting.id,
        socketRoom: `meeting:${meeting.id}`,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
        calling,
      },
    });
  } catch (error) {
    console.error("Guest join meeting error:", error);
    res.status(500).json({ success: false, error: "Failed to join meeting as guest" });
  }
};

/**
 * GET /meetings/:id/transcript
 * Provider-agnostic meeting transcript (built from caption segments that the
 * backend relays + persists regardless of whether the media provider is
 * LiveKit or MediaSoup). Access: host, co-host or attendees of the meeting.
 */
export const getMeetingTranscript: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params as { id: string };
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    let actualId: string | undefined;
    if (isValidUUID(id)) {
      const r = await query(`SELECT id FROM meetings WHERE id = $1 AND business_id = $2`, [id, businessId]);
      actualId = r.rows[0]?.id;
    }
    if (!actualId) {
      const r = await query(`SELECT id FROM meetings WHERE meeting_code = $1 AND business_id = $2`, [id, businessId]);
      actualId = r.rows[0]?.id;
    }
    if (!actualId) {
      return res.status(404).json({ success: false, error: "Meeting not found" });
    }

    const transcript = await query(
      `SELECT t.id, t.speaker_id as "speakerId", t.speaker_name as "speakerName", t.text,
              t.language, t.created_at as "createdAt"
       FROM meeting_transcripts t
       WHERE t.meeting_id = $1
       ORDER BY t.created_at ASC
       LIMIT 2000`,
      [actualId],
    );

    res.json({ success: true, data: { meetingId: actualId, segments: transcript.rows } });
  } catch (error) {
    console.error("Get meeting transcript error:", error);
    res.status(500).json({ success: false, error: "Failed to load transcript" });
  }
};

/**
 * GET /meetings/:id/notes — AI meeting notes (summary, key points, decisions,
 * action items). Returns notes: null when not generated yet.
 */
export const getMeetingNotes: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params as { id: string };
    const businessId = req.user?.businessId;
    if (!businessId || !req.user?.userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    let actualId: string | undefined;
    if (isValidUUID(id)) {
      const r = await query(`SELECT id FROM meetings WHERE id = $1 AND business_id = $2`, [id, businessId]);
      actualId = r.rows[0]?.id;
    }
    if (!actualId) {
      const r = await query(`SELECT id FROM meetings WHERE meeting_code = $1 AND business_id = $2`, [id, businessId]);
      actualId = r.rows[0]?.id;
    }
    if (!actualId) {
      return res.status(404).json({ success: false, error: "Meeting not found" });
    }

    const notes = await query(
      `SELECT meeting_id as "meetingId", summary, key_points as "keyPoints", decisions,
              action_items as "actionItems", important_timestamps as "importantTimestamps",
              model, generated_at as "generatedAt"
       FROM meeting_notes WHERE meeting_id = $1`,
      [actualId],
    );

    res.json({ success: true, data: { meetingId: actualId, notes: notes.rows[0] || null } });
  } catch (error) {
    console.error("Get meeting notes error:", error);
    res.status(500).json({ success: false, error: "Failed to load meeting notes" });
  }
};

/**
 * POST /meetings/:id/notes/generate — (re)generate AI notes from the stored
 * transcript on demand (also runs automatically when a meeting ends).
 */
export const generateMeetingNotesEndpoint: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params as { id: string };
    const businessId = req.user?.businessId;
    if (!businessId || !req.user?.userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    let actualId: string | undefined;
    if (isValidUUID(id)) {
      const r = await query(`SELECT id FROM meetings WHERE id = $1 AND business_id = $2`, [id, businessId]);
      actualId = r.rows[0]?.id;
    }
    if (!actualId) {
      const r = await query(`SELECT id FROM meetings WHERE meeting_code = $1 AND business_id = $2`, [id, businessId]);
      actualId = r.rows[0]?.id;
    }
    if (!actualId) {
      return res.status(404).json({ success: false, error: "Meeting not found" });
    }

    if (!(await hasSummarizableTranscript(actualId))) {
      return res.status(409).json({
        success: false,
        error: "Not enough transcript content yet. Captions recorded during the meeting are required.",
        errorCode: "no_transcript",
      });
    }

    const notes = await generateMeetingNotes(actualId);
    if (!notes) {
      return res.status(503).json({
        success: false,
        error: "AI notes are unavailable right now (AI provider not configured or output invalid).",
        errorCode: "ai_unavailable",
      });
    }

    res.json({ success: true, data: { meetingId: actualId, notes } });
  } catch (error) {
    console.error("Generate meeting notes error:", error);
    res.status(500).json({ success: false, error: "Failed to generate meeting notes" });
  }
};

// ==================== MEETING REPORT (summary view) ====================

/**
 * GET /meetings/:id/report
 * One-shot "meeting report" payload for the post-meeting screen: meeting
 * metadata, attendee join/leave timeline, AI notes (with action-item owners
 * resolved to names), transcript segments and recordings.
 * Access mirrors getMeetingById (business-scoped; host/co-host/attendee rows
 * also carry user ids from the same business).
 */
export const getMeetingReport: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params as { id: string };
    const businessId = req.user?.businessId;
    if (!businessId || !req.user?.userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }

    // Resolve by UUID first, then by meeting code (clients send either).
    let result = isValidUUID(id)
      ? await query(
        `SELECT id, title, description, start_time as "startTime", end_time as "endTime",
                timezone, created_by as "createdById", host_id as "hostId", co_host_id as "coHostId",
                status, meeting_code as "meetingCode", is_instant as "isInstant",
                max_participants as "maxParticipants", waiting_room_enabled as "waitingRoomEnabled",
                recording_enabled as "recordingEnabled", screen_sharing_enabled as "screenSharingEnabled",
                created_at as "createdAt", updated_at as "updatedAt"
         FROM meetings WHERE id = $1 AND business_id = $2`,
        [id, businessId],
      )
      : { rows: [] as any[] };
    if (result.rows.length === 0) {
      result = await query(
        `SELECT id, title, description, start_time as "startTime", end_time as "endTime",
                timezone, created_by as "createdById", host_id as "hostId", co_host_id as "coHostId",
                status, meeting_code as "meetingCode", is_instant as "isInstant",
                max_participants as "maxParticipants", waiting_room_enabled as "waitingRoomEnabled",
                recording_enabled as "recordingEnabled", screen_sharing_enabled as "screenSharingEnabled",
                created_at as "createdAt", updated_at as "updatedAt"
         FROM meetings WHERE meeting_code = $1 AND business_id = $2`,
        [id, businessId],
      );
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Meeting not found" });
    }
    const meeting = result.rows[0];

    // Attendee timeline (joined_at/left_at written by join/leave endpoints).
    let attendees: any[] = [];
    try {
      const attendeesResult = await query(
        `SELECT ma.user_id as "userId", u.name, u.avatar_url as "avatarUrl",
                ma.joined_at as "joinedAt", ma.left_at as "leftAt", ma.status
         FROM meeting_attendees ma
         LEFT JOIN users u ON u.id = ma.user_id
         WHERE ma.meeting_id = $1
         ORDER BY ma.joined_at NULLS LAST, ma.created_at ASC`,
        [meeting.id],
      );
      attendees = attendeesResult.rows;
    } catch { /* join/leave columns may be missing on very old schemas */ }

    // AI notes (generated at meeting end / on demand).
    let notes: any = null;
    try {
      const notesResult = await query(
        `SELECT id, summary, key_points as "keyPoints", decisions,
                action_items as "actionItems", important_timestamps as "importantTimestamps",
                model, generated_at as "generatedAt"
         FROM meeting_notes WHERE meeting_id = $1
         LIMIT 1`,
        [meeting.id],
      );
      const rawNotes = notesResult.rows[0] || null;
      if (rawNotes) {
        // Resolve action-item owners/assignees (stored as user ids) to names,
        // keeping the raw fields intact.
        const actionItems = Array.isArray(rawNotes.actionItems) ? rawNotes.actionItems : [];
        const ownerIds = new Set<string>();
        const pickOwnerId = (item: any): string | null => {
          const candidate = item?.owner ?? item?.ownerId ?? item?.assignee ?? item?.assigneeId ?? null;
          const asString = candidate && typeof candidate === "object"
            ? (candidate.id ?? null)
            : candidate;
          return asString && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(asString))
            ? String(asString)
            : null;
        };
        for (const item of actionItems) {
          const ownerId = pickOwnerId(item);
          if (ownerId) ownerIds.add(ownerId);
        }
        const ownerNames = new Map<string, string>();
        if (ownerIds.size > 0) {
          try {
            const usersResult = await query(
              `SELECT id, name FROM users WHERE id = ANY($1::uuid[])`,
              [[...ownerIds]],
            );
            for (const row of usersResult.rows) ownerNames.set(row.id, row.name);
          } catch { /* keep raw ids when lookup fails */ }
        }
        const resolvedActionItems = actionItems.map((item: any) => {
          const ownerId = pickOwnerId(item);
          const ownerName = ownerId ? (ownerNames.get(ownerId) || null) : null;
          return ownerName ? { ...item, ownerName } : item;
        });
        notes = { ...rawNotes, actionItems: resolvedActionItems };
      }
    } catch { /* notes table may not exist yet */ }

    // Transcript segments (persisted captions), ascending.
    let transcripts: any[] = [];
    try {
      const transcriptResult = await query(
        `SELECT t.id, t.speaker_id as "speakerId", t.speaker_name as "speakerName",
                t.text, t.created_at as "createdAt"
         FROM meeting_transcripts t
         WHERE t.meeting_id = $1
         ORDER BY t.created_at ASC
         LIMIT 2000`,
        [meeting.id],
      );
      transcripts = transcriptResult.rows;
    } catch { /* transcript table may not exist yet */ }

    // Recordings for this meeting.
    let recordings: any[] = [];
    try {
      const recordingsResult = await query(
        `SELECT id, storage_url as "storageUrl", duration, size, status, created_at as "createdAt"
         FROM recordings WHERE meeting_id = $1
         ORDER BY created_at ASC`,
        [meeting.id],
      );
      recordings = recordingsResult.rows;
    } catch { /* recordings table may not exist yet */ }

    // Duration: completed meetings measure end_time - start_time; ongoing
    // meetings measure from start_time to now.
    let durationSeconds: number | null = null;
    const startTime = meeting.startTime ? new Date(meeting.startTime) : null;
    const endTime = meeting.endTime ? new Date(meeting.endTime) : null;
    if (startTime) {
      const reference = meeting.status === "completed" && endTime ? endTime : new Date();
      durationSeconds = Math.max(0, Math.round((reference.getTime() - startTime.getTime()) / 1000));
    }

    const response: ApiResponse<any> = {
      success: true,
      data: {
        meeting: {
          id: meeting.id,
          title: meeting.title,
          description: meeting.description,
          status: meeting.status,
          meetingCode: meeting.meetingCode,
          timezone: meeting.timezone,
          scheduledAt: meeting.startTime,
          startedAt: meeting.startTime,
          endedAt: meeting.endTime,
          durationSeconds,
          createdById: meeting.createdById,
          hostId: meeting.hostId,
          coHostId: meeting.coHostId,
          recordingEnabled: meeting.recordingEnabled,
          waitingRoomEnabled: meeting.waitingRoomEnabled,
        },
        attendees,
        notes,
        transcripts,
        recordings,
      },
    };
    res.json(response);
  } catch (error) {
    console.error("Get meeting report error:", error);
    res.status(500).json({ success: false, error: "Failed to load meeting report" });
  }
};
