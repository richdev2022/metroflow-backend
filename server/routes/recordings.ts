import { RequestHandler } from "express";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiResponse } from "@shared/api";
import { logActivity } from "../services/activity";
import { getSocketServer } from "../lib/socket";
import { upload } from "../middleware/upload";
import { r2Storage } from "../lib/storage";
import fs from "fs";
import path from "path";

type UploadedRecordingRequest = AuthenticatedRequest & {
  file?: Express.Multer.File;
  files?: Express.Multer.File[] | Record<string, Express.Multer.File[]>;
};

const recordingFileFields = [
  { name: "file", maxCount: 1 },
  { name: "recording", maxCount: 1 },
  { name: "video", maxCount: 1 },
  { name: "audio", maxCount: 1 },
];

function getUploadedRecordingFile(req: UploadedRecordingRequest) {
  if (req.file) {
    return req.file;
  }

  if (Array.isArray(req.files)) {
    return req.files[0];
  }

  if (req.files) {
    for (const field of recordingFileFields) {
      const file = req.files[field.name]?.[0];
      if (file) {
        return file;
      }
    }
  }

  return undefined;
}

function getExtensionFromMimeType(mimeType: string | undefined) {
  if (!mimeType) {
    return "webm";
  }

  const subtype = mimeType.split("/")[1]?.split(";")[0];
  return subtype || "webm";
}

const normalizeRecordingUpload: RequestHandler = (req: UploadedRecordingRequest, res, next) => {
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("multipart/form-data")) {
    const uploadFields = upload.fields(recordingFileFields);
    uploadFields(req, res, (err) => {
      if (err) {
        console.error("Multer error:", err);
        return res.status(400).json({
          success: false,
          error: err.message || "File upload error",
        });
      }
      next();
    });
    return;
  }

  if (
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("application/octet-stream")
  ) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0) {
        const extension = getExtensionFromMimeType(contentType);
        req.file = {
          fieldname: "file",
          originalname: `recording.${extension}`,
          encoding: "7bit",
          mimetype: contentType,
          size: buffer.length,
          buffer,
        } as Express.Multer.File;
      }
      next();
    });
    req.on("error", next);
    return;
  }

  next();
};

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

    // Generate presigned URLs for recordings if needed
    const recordings = await Promise.all(
      result.rows.map(async (recording) => {
        if (recording.storageUrl && !recording.storageUrl.startsWith('http') && !recording.storageUrl.startsWith('/uploads/') && !recording.storageUrl.startsWith('data:') && r2Storage.isAvailable()) {
          try {
            recording.storageUrl = await r2Storage.getPresignedUrl(recording.storageUrl, 86400); // 24 hours
          } catch (err) {
            console.error("Failed to generate presigned URL for recording:", recording.id, err);
          }
        }
        return recording;
      })
    );

    const response: ApiResponse<{ recordings: any[]; total: number }> = {
      success: true,
      data: { recordings, total },
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

    const result = await query(`DELETE FROM recordings WHERE id = $1 AND business_id = $2 AND recorded_by = $3 RETURNING id, storage_url`, [
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

    // Delete from storage if exists
    const storageUrl = result.rows[0].storage_url;
    if (storageUrl && !storageUrl.startsWith('http') && !storageUrl.startsWith('/uploads/') && !storageUrl.startsWith('data:') && r2Storage.isAvailable()) {
      try {
        await r2Storage.deleteFile(storageUrl);
      } catch (err) {
        console.error("Failed to delete recording from storage:", err);
      }
    } else if (storageUrl && storageUrl.startsWith('/uploads/')) {
      // Delete local file
      const isLambda = !!process.env.LAMBDA_TASK_ROOT || !!process.env.NETLIFY;
      const baseDir = isLambda ? path.join("/tmp") : process.cwd();
      const filePath = path.join(baseDir, "uploads", storageUrl.replace('/uploads/', ''));
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error("Failed to delete local recording file:", err);
      }
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

/**
 * @swagger
 * /recordings/{id}/upload:
 *   post:
 *     summary: Upload a recording file
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
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               duration:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Recording uploaded successfully
 */
// Upload recording file endpoint
export const uploadRecording: RequestHandler[] = [
  normalizeRecordingUpload,
  async (req: UploadedRecordingRequest, res) => {
    try {
      const { id } = req.params;
      const duration = req.body?.duration ?? req.query.duration;
      const businessId = req.user?.businessId;
      const userId = req.user?.userId;
      const uploadedFile = getUploadedRecordingFile(req);

      if (!businessId || !userId) {
        return res.status(400).json({
          success: false,
          error: "User authentication required",
        });
      }

      if (!uploadedFile) {
        return res.status(400).json({
          success: false,
          error: "No file uploaded. Send multipart/form-data with a file field named file, recording, video, or audio.",
        });
      }

      // Check if recording exists and belongs to user
      const checkResult = await query(
        `SELECT id FROM recordings WHERE id = $1 AND business_id = $2 AND recorded_by = $3`,
        [id, businessId, userId]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Recording not found",
        });
      }

      // Upload to R2 if available, otherwise use local storage
      let storageUrl = '';
      let useLocalStorage = false;
      if (r2Storage.isAvailable()) {
        try {
          const fileExt = uploadedFile.originalname.includes(".")
            ? uploadedFile.originalname.split(".").pop() || "webm"
            : getExtensionFromMimeType(uploadedFile.mimetype);
          const key = `recordings/${businessId}/${id}.${fileExt}`;
          storageUrl = await r2Storage.uploadFile(key, uploadedFile.buffer, uploadedFile.mimetype);
        } catch (error) {
          console.error("R2 upload failed, falling back to local storage:", error);
          useLocalStorage = true;
        }
      } else {
        useLocalStorage = true;
      }

      if (useLocalStorage) {
        const isLambda = !!process.env.LAMBDA_TASK_ROOT || !!process.env.NETLIFY;
        const baseDir = isLambda ? path.join("/tmp") : process.cwd();
        const uploadDir = path.join(baseDir, "uploads");
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        
        const fileExt = uploadedFile.originalname.includes(".")
          ? uploadedFile.originalname.split(".").pop() || "webm"
          : getExtensionFromMimeType(uploadedFile.mimetype);
        const filename = `recording-${id}-${Date.now()}.${fileExt}`;
        const filePath = path.join(uploadDir, filename);
        
        fs.writeFileSync(filePath, uploadedFile.buffer);
        
        if (isLambda) {
          const { getStore } = require("@netlify/blobs");
          const store = getStore("uploads");
          try {
            await store.set(filename, uploadedFile.buffer.buffer.slice(uploadedFile.buffer.byteOffset, uploadedFile.buffer.byteOffset + uploadedFile.buffer.byteLength) as any);
            storageUrl = `/uploads/${filename}`;
          } catch (e) {
            console.error("Netlify Blobs upload failed, using base64:", e);
            const mime = uploadedFile.mimetype || "application/octet-stream";
            storageUrl = `data:${mime};base64,${uploadedFile.buffer.toString("base64")}`;
            try { fs.unlinkSync(filePath); } catch {}
          }
        } else {
          storageUrl = `/uploads/${filename}`;
        }
      }

      // Update recording in database
      const updateResult = await query(
        `UPDATE recordings
         SET storage_url = $1,
             duration = COALESCE($2, duration),
             size = $3,
             status = 'completed',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4 AND business_id = $5 AND recorded_by = $6
         RETURNING id, business_id as "businessId", meeting_id as "meetingId", 
                   call_id as "callId", recorded_by as "recordedById", storage_url as "storageUrl",
                   duration, status, size, created_at as "createdAt", updated_at as "updatedAt"`,
        [storageUrl, duration ? parseInt(duration as string) : null, uploadedFile.size, id, businessId, userId]
      );

      const recording = updateResult.rows[0];

      // Generate presigned URL if needed
      if (recording.storageUrl && !recording.storageUrl.startsWith('http') && !recording.storageUrl.startsWith('/uploads/') && !recording.storageUrl.startsWith('data:') && r2Storage.isAvailable()) {
        recording.storageUrl = await r2Storage.getPresignedUrl(recording.storageUrl, 86400); // 24 hours
      }

      const response: ApiResponse<any> = {
        success: true,
        data: recording,
      };
      res.json(response);
    } catch (error) {
      console.error("Upload recording error:", error);
      const response: ApiResponse<null> = {
        success: false,
        error: "Failed to upload recording",
      };
      res.status(500).json(response);
    }
  }
];
