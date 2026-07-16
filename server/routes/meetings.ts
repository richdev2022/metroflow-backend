import crypto from "crypto";
import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { logActivity } from "../services/activity";
import { getSocketServer } from "../lib/socket";
import { createNotification } from "../services/notifications";
import { sendEmail, generateMeetingInvitationEmailHtml } from "../services/email";

// Helper to generate random meeting code
function generateMeetingCode() {
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

    const response: ApiResponse<{ meetings: any[]; total: number }> = {
      success: true,
      data: { meetings: result.rows, total },
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

    const uniqueAttendeeIds = Array.from(new Set<string>(attendeeIds || []));
    const validAttendeeIds = await getBusinessUserIds(uniqueAttendeeIds, businessId);
    if (validAttendeeIds.size !== uniqueAttendeeIds.length) {
      return res.status(400).json({
        success: false,
        error: "All meeting attendees must belong to this business",
      });
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
         is_instant, password, max_participants, waiting_room_enabled, recording_enabled, screen_sharing_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, title, description, start_time as "startTime", end_time as "endTime", 
                 timezone, created_by as "createdById", host_id as "hostId", co_host_id as "coHostId",
                 status, meeting_code as "meetingCode", is_instant as "isInstant", password,
                 max_participants as "maxParticipants", waiting_room_enabled as "waitingRoomEnabled",
                 recording_enabled as "recordingEnabled", screen_sharing_enabled as "screenSharingEnabled",
                 google_event_id as "googleEventId", created_at as "createdAt", updated_at as "updatedAt"`,
      [
        businessId,
        title,
        description || null,
        new Date(startTime).toISOString(),
        new Date(endTime).toISOString(),
        timezone,
        userId,
        userId,
        meetingCode,
        isInstant || false,
        password || null,
        maxParticipants || null,
        waitingRoomEnabled || false,
        recordingEnabled || false,
        screenSharingEnabled !== undefined ? screenSharingEnabled : true,
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

        // Send email invitation
        const user = usersMap.get(attendeeId);
        if (user?.email) {
          const emailHtml = generateMeetingInvitationEmailHtml(
            user.name || 'User',
            title,
            description || null,
            new Date(startTime),
            new Date(endTime),
            meeting.meetingCode,
            currentUserName || 'Someone'
          );
          await sendEmail(user.email, user.name || 'User', `Meeting Invitation: ${title}`, emailHtml);
        }
      }
    }

    meeting.attendees = attendees;

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

    // Emit socket event
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
    const { id } = req.params;
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
        id,
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
      await query(`DELETE FROM meeting_attendees WHERE meeting_id = $1`, [id]);
      const attendees = [];
      if (attendeeIds.length > 0) {
        const uniqueAttendeeIds = Array.from(new Set<string>(attendeeIds));
        for (const attendeeId of uniqueAttendeeIds) {
          const attendeeResult = await query(
            `INSERT INTO meeting_attendees (meeting_id, user_id)
             VALUES ($1, $2)
             RETURNING id, user_id as "userId", status`,
            [id, attendeeId],
          );
          attendees.push(attendeeResult.rows[0]);
        }
      }
      meeting.attendees = attendees;
    } else {
      // Get existing attendees
      const attendeeResult = await query(
        `SELECT id, user_id as "userId", status FROM meeting_attendees WHERE meeting_id = $1`,
        [id],
      );
      meeting.attendees = attendeeResult.rows;
    }

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
    const { id } = req.params;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    // Get meeting info first for logging
    const meetingResult = await query(
      `SELECT title FROM meetings
       WHERE id = $1 AND business_id = $2
       AND (created_by = $3 OR host_id = $3 OR co_host_id = $3)`,
      [id, businessId, userId],
    );

    if (meetingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
      });
    }

    const meetingTitle = meetingResult.rows[0].title;

    // Delete attendees first
    await query(`DELETE FROM meeting_attendees WHERE meeting_id = $1`, [id]);

    // Delete reminders
    await query(`DELETE FROM meeting_reminders WHERE meeting_id = $1`, [id]);

    // Delete meeting
    await query(`DELETE FROM meetings WHERE id = $1 AND business_id = $2`, [
      id,
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
