import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { logActivity } from "../services/activity";
import { getSocketServer } from "../lib/socket";

export const getMeetings: RequestHandler = async (req: AuthenticatedRequest, res) => {
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
      `SELECT COUNT(*) as total FROM meetings WHERE business_id = $1`,
      [businessId],
    );
    const total = parseInt(countResult.rows[0].total);

    const result = await query(
      `SELECT 
        m.id, m.title, m.description, m.start_time as "startTime", m.end_time as "endTime", 
        m.timezone, m.created_by as "createdById", m.status, m.meeting_url as "meetingUrl", 
        m.google_event_id as "googleEventId", m.created_at as "createdAt", m.updated_at as "updatedAt",
        json_agg(json_build_object(
          'id', ma.id,
          'userId', ma.user_id,
          'status', ma.status
        )) FILTER (WHERE ma.id IS NOT NULL) as attendees
      FROM meetings m
      LEFT JOIN meeting_attendees ma ON m.id = ma.meeting_id
      WHERE m.business_id = $1
      GROUP BY m.id
      ORDER BY m.start_time DESC
      LIMIT $2 OFFSET $3`,
      [businessId, limit, offset],
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

export const createMeeting: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const {
      title,
      description,
      startTime,
      endTime,
      timezone,
      attendeeIds,
      meetingUrl,
      googleEventId,
    } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const result = await query(
      `INSERT INTO meetings 
        (business_id, title, description, start_time, end_time, timezone, created_by, meeting_url, google_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, description, start_time as "startTime", end_time as "endTime", 
                 timezone, created_by as "createdById", status, meeting_url as "meetingUrl", 
                 google_event_id as "googleEventId", created_at as "createdAt", updated_at as "updatedAt"`,
      [
        businessId,
        title,
        description || null,
        new Date(startTime).toISOString(),
        new Date(endTime).toISOString(),
        timezone,
        userId,
        meetingUrl || null,
        googleEventId || null,
      ],
    );

    const meeting = result.rows[0];

    // Add attendees
    const attendees = [];
    if (attendeeIds && attendeeIds.length > 0) {
      for (const attendeeId of attendeeIds) {
        const attendeeResult = await query(
          `INSERT INTO meeting_attendees (meeting_id, user_id)
           VALUES ($1, $2)
           RETURNING id, user_id as "userId", status`,
          [meeting.id, attendeeId],
        );
        attendees.push(attendeeResult.rows[0]);
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
        attendeeIds: attendeeIds || [],
      },
    });

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      io.to(`business:${businessId}`).emit("meeting:created", meeting);
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

export const updateMeeting: RequestHandler = async (req: AuthenticatedRequest, res) => {
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
      meetingUrl,
      googleEventId,
      attendeeIds,
    } = req.body;

    const result = await query(
      `UPDATE meetings
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           start_time = COALESCE($3, start_time),
           end_time = COALESCE($4, end_time),
           timezone = COALESCE($5, timezone),
           status = COALESCE($6, status),
           meeting_url = COALESCE($7, meeting_url),
           google_event_id = COALESCE($8, google_event_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 AND business_id = $10
       RETURNING id, title, description, start_time as "startTime", end_time as "endTime", 
                 timezone, created_by as "createdById", status, meeting_url as "meetingUrl", 
                 google_event_id as "googleEventId", created_at as "createdAt", updated_at as "updatedAt"`,
      [
        title,
        description,
        startTime ? new Date(startTime).toISOString() : null,
        endTime ? new Date(endTime).toISOString() : null,
        timezone,
        status,
        meetingUrl,
        googleEventId,
        id,
        businessId,
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
        for (const attendeeId of attendeeIds) {
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

export const deleteMeeting: RequestHandler = async (req: AuthenticatedRequest, res) => {
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
      `SELECT title FROM meetings WHERE id = $1 AND business_id = $2`,
      [id, businessId],
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
    await query(`DELETE FROM meetings WHERE id = $1 AND business_id = $2`, [id, businessId]);

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
