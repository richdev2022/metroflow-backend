import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { logActivity } from "../services/activity";
import { getSocketServer } from "../lib/socket";

async function canAccessMeeting(meetingId: string, businessId: string, userId: string) {
  const result = await query(
    `SELECT id FROM meetings m
     WHERE m.id = $1 AND m.business_id = $2
     AND (
       m.created_by = $3
       OR m.host_id = $3
       OR m.co_host_id = $3
       OR EXISTS (
         SELECT 1 FROM meeting_attendees ma
         WHERE ma.meeting_id = m.id AND ma.user_id = $3
       )
     )`,
    [meetingId, businessId, userId],
  );

  return result.rows.length > 0;
}

async function canAccessCall(callId: string, businessId: string, userId: string) {
  const result = await query(
    `SELECT id FROM calls c
     WHERE c.id = $1 AND c.business_id = $2
     AND (
       c.created_by = $3
       OR c.host_id = $3
       OR c.co_host_id = $3
       OR EXISTS (
         SELECT 1 FROM call_participants cp
         WHERE cp.call_id = c.id AND cp.user_id = $3
       )
     )`,
    [callId, businessId, userId],
  );

  return result.rows.length > 0;
}

/**
 * @swagger
 * /recordings:
 *   get:
 *     summary: Get recordings
 *     description: Returns paginated recordings for the authenticated user's business.
 *     tags: [Recordings]
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
 *         description: Recordings fetched successfully
 */
export const getRecordings: RequestHandler = async (
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
       FROM recordings r
       LEFT JOIN meetings m ON r.meeting_id = m.id
       LEFT JOIN calls c ON r.call_id = c.id
       WHERE r.business_id = $1
       AND (
         r.recorded_by = $2
         OR m.created_by = $2
         OR m.host_id = $2
         OR m.co_host_id = $2
         OR c.created_by = $2
         OR c.host_id = $2
         OR c.co_host_id = $2
         OR EXISTS (
           SELECT 1 FROM meeting_attendees ma
           WHERE ma.meeting_id = r.meeting_id AND ma.user_id = $2
         )
         OR EXISTS (
           SELECT 1 FROM call_participants cp
           WHERE cp.call_id = r.call_id AND cp.user_id = $2
         )
       )`,
      [businessId, userId],
    );
    const total = parseInt(countResult.rows[0].total);

    const result = await query(
      `SELECT 
        r.id, r.business_id as "businessId", r.meeting_id as "meetingId", r.call_id as "callId",
        r.recorded_by as "recordedById", r.storage_url as "storageUrl", r.duration, r.status,
        r.size, r.created_at as "createdAt", r.updated_at as "updatedAt",
        u.name as "recordedByName"
      FROM recordings r
      JOIN users u ON r.recorded_by = u.id
      LEFT JOIN meetings m ON r.meeting_id = m.id
      LEFT JOIN calls c ON r.call_id = c.id
      WHERE r.business_id = $1
      AND (
        r.recorded_by = $2
        OR m.created_by = $2
        OR m.host_id = $2
        OR m.co_host_id = $2
        OR c.created_by = $2
        OR c.host_id = $2
        OR c.co_host_id = $2
        OR EXISTS (
          SELECT 1 FROM meeting_attendees ma
          WHERE ma.meeting_id = r.meeting_id AND ma.user_id = $2
        )
        OR EXISTS (
          SELECT 1 FROM call_participants cp
          WHERE cp.call_id = r.call_id AND cp.user_id = $2
        )
      )
      ORDER BY r.created_at DESC
      LIMIT $3 OFFSET $4`,
      [businessId, userId, limit, offset],
    );

    const response: ApiResponse<{ recordings: any[]; total: number }> = {
      success: true,
      data: { recordings: result.rows, total },
    };
    res.json(response);
  } catch (error) {
    console.error("Get recordings error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to fetch recordings",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /recordings:
 *   post:
 *     summary: Create a recording (start)
 *     tags: [Recordings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               meetingId:
 *                 type: string
 *                 format: uuid
 *               callId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       201:
 *         description: Recording started successfully
 */
export const createRecording: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { meetingId, callId } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    if (!meetingId && !callId) {
      return res.status(400).json({
        success: false,
        error: "Either meetingId or callId is required",
      });
    }

    if (meetingId && !(await canAccessMeeting(meetingId, businessId, userId))) {
      return res.status(404).json({
        success: false,
        error: "Meeting not found",
      });
    }

    if (callId && !(await canAccessCall(callId, businessId, userId))) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    const result = await query(
      `INSERT INTO recordings 
        (business_id, meeting_id, call_id, recorded_by, storage_url, duration, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, business_id as "businessId", meeting_id as "meetingId", 
                 call_id as "callId", recorded_by as "recordedById", storage_url as "storageUrl",
                 duration, status, size, created_at as "createdAt", updated_at as "updatedAt"`,
      [
        businessId,
        meetingId || null,
        callId || null,
        userId,
        "", // temporary empty storage url
        0,
        "recording"
      ],
    );

    const recording = result.rows[0];

    // Log activity
    await logActivity({
      businessId,
      userId,
      action: "create",
      actionType: "recording",
      description: `Started a recording`,
      metadata: {
        meetingId,
        callId,
      },
    });

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      const roomId = meetingId ? `meeting:${meetingId}` : `call:${callId}`;
      io.to(roomId).emit("recording:started", recording);
    }

    const response: ApiResponse<any> = {
      success: true,
      data: recording,
    };
    res.status(201).json(response);
  } catch (error) {
    console.error("Create recording error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to start recording",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /recordings/{id}:
 *   put:
 *     summary: Update a recording (stop/pause/resume)
 *     tags: [Recordings]
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
 *                 enum: [paused, completed, failed]
 *               storageUrl:
 *                 type: string
 *               duration:
 *                 type: integer
 *               size:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Recording updated successfully
 */
export const updateRecording: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
) => {
  try {
    const { id } = req.params;
    const { status, storageUrl, duration, size } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    if (!businessId || !userId) {
      return res.status(400).json({
        success: false,
        error: "User authentication required",
      });
    }

    const result = await query(
      `UPDATE recordings
       SET status = COALESCE($1, status),
           storage_url = COALESCE($2, storage_url),
           duration = COALESCE($3, duration),
           size = COALESCE($4, size),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND business_id = $6 AND recorded_by = $7
       RETURNING id, business_id as "businessId", meeting_id as "meetingId", 
                 call_id as "callId", recorded_by as "recordedById", storage_url as "storageUrl",
                 duration, status, size, created_at as "createdAt", updated_at as "updatedAt"`,
      [status, storageUrl, duration, size, id, businessId, userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Recording not found",
      });
    }

    const recording = result.rows[0];

    // Emit socket event
    const io = getSocketServer();
    if (io) {
      const roomId = recording.meetingId 
        ? `meeting:${recording.meetingId}` 
        : `call:${recording.callId}`;
      if (status === "paused") {
        io.to(roomId).emit("recording:paused", recording);
      } else if (status === "completed") {
        io.to(roomId).emit("recording:stopped", recording);
      }
    }

    const response: ApiResponse<any> = {
      success: true,
      data: recording,
    };
    res.json(response);
  } catch (error) {
    console.error("Update recording error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to update recording",
    };
    res.status(500).json(response);
  }
};

/**
 * @swagger
 * /recordings/{id}:
 *   delete:
 *     summary: Delete a recording
 *     tags: [Recordings]
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
 *         description: Recording deleted successfully
 */
export const deleteRecording: RequestHandler = async (
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

    const result = await query(`DELETE FROM recordings WHERE id = $1 AND business_id = $2 AND recorded_by = $3 RETURNING id`, [
      id,
      businessId,
      userId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Recording not found",
      });
    }

    await logActivity({
      businessId,
      userId,
      action: "delete",
      actionType: "recording",
      description: `Deleted recording`,
      metadata: {
        recordingId: id,
      },
    });

    const response: ApiResponse<null> = {
      success: true,
    };
    res.json(response);
  } catch (error) {
    console.error("Delete recording error:", error);
    const response: ApiResponse<null> = {
      success: false,
      error: "Failed to delete recording",
    };
    res.status(500).json(response);
  }
};
