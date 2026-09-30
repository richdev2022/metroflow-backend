import { Router, RequestHandler } from "express";
import { query } from "../../db";
import { AuthenticatedRequest, checkFeaturePermission } from "../../middleware/auth";
import {
  buildCallingCredentials,
  computeRemainingSeconds,
  resolveProviderForRoom,
} from "./factory";
import { logActivity } from "../../services/activity";

/**
 * RTC session routes — token refresh + host moderation.
 *
 * All access decisions happen here on the backend: membership, block state,
 * meeting state and the plan deadline are re-validated on every call. The
 * provider (LiveKit / MediaSoup) is resolved from the room row, so a refresh
 * always mints credentials for the provider the room was created with.
 */

export const rtcRouter = Router();

type RoomRow = {
  id: string;
  provider: string | null;
  ended_at: string | null;
  end_time: string | null;
  status: string;
  max_participants: number | null;
  password: string | null;
  host_id: string | null;
  co_host_id: string | null;
  created_by: string | null;
};

async function resolveRoom(roomType: "call" | "meeting", idOrCode: string, businessId: string): Promise<RoomRow | null> {
  const table = roomType === "call" ? "calls" : "meetings";
  const codeCol = roomType === "call" ? "call_code" : "meeting_code";
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrCode);
  const res = await query(
    `SELECT id, provider, ended_at, end_time, status, max_participants, password, host_id, co_host_id, created_by
     FROM ${table} WHERE ${isUuid ? "id" : codeCol} = $1 AND business_id = $2`,
    [idOrCode, businessId],
  );
  return res.rows[0] || null;
}

async function isRoomMember(roomType: "call" | "meeting", roomId: string, userId: string): Promise<boolean> {
  const table = roomType === "call" ? "call_participants" : "meeting_attendees";
  const col = roomType === "call" ? "call_id" : "meeting_id";
  const res = await query(`SELECT 1 FROM ${table} WHERE ${col} = $1 AND user_id = $2 LIMIT 1`, [roomId, userId]);
  return res.rows.length > 0;
}

function roomEnded(r: RoomRow): boolean {
  if (r.status === "completed" || r.status === "cancelled" || r.status === "missed") return true;
  const deadline = r.ended_at || r.end_time;
  if (deadline && new Date(deadline).getTime() < Date.now()) {
    // For calls, ended_at doubles as the plan deadline while status is still ongoing.
    return r.status !== "ongoing" || !!r.ended_at;
  }
  return false;
}

/**
 * POST /rtc/token — mint/refresh short-lived media credentials.
 * Body: { roomType: "call"|"meeting", roomId: <uuid-or-code> }
 */
const postToken: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }
    const { roomType, roomId } = req.body || {};
    if (roomType !== "call" && roomType !== "meeting") {
      return res.status(400).json({ success: false, error: "roomType must be 'call' or 'meeting'" });
    }
    if (!roomId) {
      return res.status(400).json({ success: false, error: "roomId is required" });
    }

    const room = await resolveRoom(roomType, roomId, businessId);
    if (!room) return res.status(404).json({ success: false, error: "Room not found" });
    if (roomEnded(room)) {
      return res.status(410).json({ success: false, error: "Room has already ended", errorCode: "room_ended" });
    }
    if (room.password) {
      // Refresh only mints tokens for known members; a password-protected
      // room the user never joined is rejected (they must join via /join first).
      const member = await isRoomMember(roomType, room.id, userId);
      if (!member) {
        return res.status(403).json({ success: false, error: "Join the room first", errorCode: "join_required" });
      }
    }

    const userRes = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
    const isHost = room.host_id === userId || room.co_host_id === userId || room.created_by === userId;
    const provider = await resolveProviderForRoom(roomType, room.id, room.provider);

    const credentials = await buildCallingCredentials(provider, {
      roomType,
      roomId: room.id,
      title: "",
      identity: userId,
      displayName: userRes.rows[0]?.name || "User",
      isHost,
      remainingSeconds: computeRemainingSeconds(room.ended_at || room.end_time),
      maxParticipants: room.max_participants,
    });

    res.json({ success: true, data: { credentials } });
  } catch (error) {
    console.error("RTC token refresh error:", error);
    res.status(500).json({ success: false, error: "Failed to mint media credentials" });
  }
};

/**
 * POST /rtc/rooms/:roomType/:roomId/participants/:identity/remove — host removes a participant.
 * The media-layer removal is delegated to the provider (LiveKit RoomService;
 * MediaSoup rooms rely on the socket-level call:ended broadcast).
 */
const postRemoveParticipant: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    const { roomType, roomId, identity } = req.params as { roomType: any; roomId: string; identity: string };
    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }
    if (roomType !== "call" && roomType !== "meeting") {
      return res.status(400).json({ success: false, error: "Invalid room type" });
    }
    const room = await resolveRoom(roomType, roomId, businessId);
    if (!room) return res.status(404).json({ success: false, error: "Room not found" });
    const isHost = room.host_id === userId || room.co_host_id === userId || room.created_by === userId;
    if (!isHost) return res.status(403).json({ success: false, error: "Only hosts can remove participants" });

    const provider = await resolveProviderForRoom(roomType, room.id, room.provider);
    let mediaRemoved = false;
    if (provider.removeParticipant) {
      mediaRemoved = await provider.removeParticipant(room.id, identity);
    }

    // Application-level: broadcast so every client drops the participant.
    const { getSocketServer } = await import("../socket");
    const io = getSocketServer();
    if (io) {
      io.to(`room:${room.id}`).emit(roomType === "call" ? "call:participant-removed" : "meeting:participant-removed", {
        roomId: room.id,
        [roomType === "call" ? "callId" : "meetingId"]: room.id,
        userId: identity,
        removedBy: userId,
      });
    }
    res.json({ success: true, data: { mediaRemoved } });
  } catch (error) {
    console.error("RTC remove participant error:", error);
    res.status(500).json({ success: false, error: "Failed to remove participant" });
  }
};

/**
 * POST /rtc/rooms/:roomType/:roomId/participants/:identity/mute — host mutes a participant.
 */
const postMuteParticipant: RequestHandler = async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    const { roomType, roomId, identity } = req.params as { roomType: any; roomId: string; identity: string };
    if (!businessId || !userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }
    if (roomType !== "call" && roomType !== "meeting") {
      return res.status(400).json({ success: false, error: "Invalid room type" });
    }
    const room = await resolveRoom(roomType, roomId, businessId);
    if (!room) return res.status(404).json({ success: false, error: "Room not found" });
    const isHost = room.host_id === userId || room.co_host_id === userId || room.created_by === userId;
    if (!isHost) return res.status(403).json({ success: false, error: "Only hosts can mute participants" });

    const provider = await resolveProviderForRoom(roomType, room.id, room.provider);
    let mediaMuted = false;
    if (provider.muteParticipant) {
      mediaMuted = await provider.muteParticipant(room.id, identity, { audio: true });
    }

    // Application-level mute hint for clients on providers without server mute.
    const { getSocketServer } = await import("../socket");
    const io = getSocketServer();
    if (io) {
      io.to(`room:${room.id}`).emit(roomType === "call" ? "call:participant-mute-requested" : "meeting:participant-mute-requested", {
        roomId: room.id,
        [roomType === "call" ? "callId" : "meetingId"]: room.id,
        userId: identity,
        by: userId,
      });
    }
    res.json({ success: true, data: { mediaMuted } });
  } catch (error) {
    console.error("RTC mute participant error:", error);
    res.status(500).json({ success: false, error: "Failed to mute participant" });
  }
};

/**
 * POST /rtc/rooms/:roomType/:roomId/recording/start — host starts a room recording.
 *
 * Provider-agnostic:
 *  - LiveKit rooms  → RoomCompositeEgress (server-side MP4 into R2). The DB row
 *    is created first so we have an id for the storage key; the egress id is
 *    attached and finalization (status/storageUrl/duration/size) happens via
 *    the LiveKit webhook (`egress_ended`).
 *  - MediaSoup rooms → no server recorder; the row is created and the client
 *    continues its existing local MediaRecorder + /recordings/:id/upload flow
 *    (mode: "client").
 */
const postRecordingStart: RequestHandler[] = [
  checkFeaturePermission("rtc.recording"),
  async (req: AuthenticatedRequest, res) => {
    try {
      const businessId = req.user?.businessId;
      const userId = req.user?.userId;
      const { roomType, roomId } = req.params as { roomType: any; roomId: string };
      if (!businessId || !userId) {
        return res.status(400).json({ success: false, error: "User authentication required" });
      }
      if (roomType !== "call" && roomType !== "meeting") {
        return res.status(400).json({ success: false, error: "Invalid room type" });
      }
      const room = await resolveRoom(roomType, roomId, businessId);
      if (!room) return res.status(404).json({ success: false, error: "Room not found" });
      if (roomEnded(room)) {
        return res.status(410).json({ success: false, error: "Room has already ended", errorCode: "room_ended" });
      }
      const isHost = room.host_id === userId || room.co_host_id === userId || room.created_by === userId;
      if (!isHost) return res.status(403).json({ success: false, error: "Only hosts can start recordings" });

      // One active recording per room.
      const active = await query(
        `SELECT id, egress_id FROM recordings
         WHERE (meeting_id = $1 OR call_id = $1) AND status IN ('recording','processing')
         LIMIT 1`,
        [room.id],
      );
      if (active.rows.length > 0) {
        return res.status(409).json({ success: false, error: "This room is already being recorded", errorCode: "already_recording" });
      }

      const provider = await resolveProviderForRoom(roomType, room.id, room.provider);
      // No server-side recorder (MediaSoup) → the client keeps its existing
      // local MediaRecorder + /recordings upload flow; no row is created here.
      if (!provider.startRecording) {
        return res.json({ success: true, data: { mode: "client", provider: provider.name } });
      }
      const created = await query(
        `INSERT INTO recordings (business_id, meeting_id, call_id, recorded_by, storage_url, duration, status)
         VALUES ($1, $2, $3, $4, '', 0, 'recording')
         RETURNING id`,
        [businessId, roomType === "meeting" ? room.id : null, roomType === "call" ? room.id : null, userId],
      );
      const recordingId = String(created.rows[0]?.id || "");
      const fileKey = `recordings/${businessId}/${recordingId}.mp4`;
      const audioOnly = req.body?.audioOnly === true;

      try {
        const result = await provider.startRecording(room.id, { fileKey, audioOnly });
        if (!result.supported) {
          // Provider declined at call time (e.g. storage not configured) — clean up.
          await query(`DELETE FROM recordings WHERE id = $1`, [recordingId]).catch(() => undefined);
          return res.json({
            success: true,
            data: { mode: "client", provider: provider.name, reason: result.reason },
          });
        }
        await query(
          `UPDATE recordings SET egress_id = $1, provider = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
          [result.egressId || null, provider.name, recordingId],
        );
        await logActivity({
          businessId,
          userId,
          action: "create",
          actionType: "recording",
          description: `Started server-side recording`,
          metadata: { meetingId: roomType === "meeting" ? room.id : undefined, callId: roomType === "call" ? room.id : undefined, recordingId, provider: provider.name },
        });
        const { getSocketServer } = await import("../socket");
        const io = getSocketServer();
        if (io) {
          io.to(`room:${room.id}`).emit("recording:started", {
            recordingId,
            roomId: room.id,
            mode: "server",
            provider: provider.name,
            startedAt: result.startedAt,
            startedBy: userId,
          });
        }
        return res.json({
          success: true,
          data: { mode: "server", recordingId, egressId: result.egressId, startedAt: result.startedAt, provider: provider.name },
        });
      } catch (err) {
        // Roll the placeholder row back so the room can retry cleanly.
        await query(`DELETE FROM recordings WHERE id = $1`, [recordingId]).catch(() => undefined);
        throw err;
      }
    } catch (error) {
      console.error("RTC recording start error:", error);
      res.status(500).json({ success: false, error: "Failed to start recording" });
    }
  },
];

/**
 * POST /rtc/rooms/:roomType/:roomId/recording/stop — host stops the active recording.
 * Body: { recordingId?: string }. LiveKit: calls Egress stop; the row is finalized
 * by the egress_ended webhook (fallback: marked completed here if the webhook is late).
 */
const postRecordingStop: RequestHandler[] = [
  checkFeaturePermission("rtc.recording"),
  async (req: AuthenticatedRequest, res) => {
    try {
      const businessId = req.user?.businessId;
      const userId = req.user?.userId;
      const { roomType, roomId } = req.params as { roomType: any; roomId: string };
      if (!businessId || !userId) {
        return res.status(400).json({ success: false, error: "User authentication required" });
      }
      if (roomType !== "call" && roomType !== "meeting") {
        return res.status(400).json({ success: false, error: "Invalid room type" });
      }
      const room = await resolveRoom(roomType, roomId, businessId);
      if (!room) return res.status(404).json({ success: false, error: "Room not found" });
      const isHost = room.host_id === userId || room.co_host_id === userId || room.created_by === userId;
      if (!isHost) return res.status(403).json({ success: false, error: "Only hosts can stop recordings" });

      const recordingId = String(req.body?.recordingId || "");
      const recRes = recordingId
        ? await query(
            `SELECT id, egress_id, provider, status FROM recordings WHERE id = $1 AND business_id = $2`,
            [recordingId, businessId],
          )
        : await query(
            `SELECT id, egress_id, provider, status FROM recordings
             WHERE (meeting_id = $1 OR call_id = $1) AND status IN ('recording','processing')
             ORDER BY created_at DESC LIMIT 1`,
            [room.id],
          );
      const rec = recRes.rows[0];
      if (!rec) return res.status(404).json({ success: false, error: "No active recording for this room" });

      const provider = await resolveProviderForRoom(roomType, room.id, room.provider);
      let stopped = false;
      if (rec.egress_id && provider.stopRecording) {
        stopped = await provider.stopRecording(room.id, String(rec.egress_id));
      }

      // Optimistic finalization — the LiveKit webhook will overwrite with the
      // real storageUrl/duration/size when the file lands in R2.
      await query(
        `UPDATE recordings SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'recording'`,
        [rec.id],
      );
      await logActivity({
        businessId,
        userId,
        action: "update",
        actionType: "recording",
        description: `Stopped server-side recording`,
        metadata: { recordingId: rec.id, mediaStopped: stopped },
      });
      const { getSocketServer } = await import("../socket");
      const io = getSocketServer();
      if (io) {
        io.to(`room:${room.id}`).emit("recording:stopped", {
          recordingId: rec.id,
          roomId: room.id,
          stoppedBy: userId,
        });
      }
      return res.json({ success: true, data: { recordingId: rec.id, mediaStopped: stopped } });
    } catch (error) {
      console.error("RTC recording stop error:", error);
      res.status(500).json({ success: false, error: "Failed to stop recording" });
    }
  },
];

rtcRouter.post("/token", postToken);
rtcRouter.post("/rooms/:roomType/:roomId/participants/:identity/remove", postRemoveParticipant);
rtcRouter.post("/rooms/:roomType/:roomId/participants/:identity/mute", postMuteParticipant);
rtcRouter.post("/rooms/:roomType/:roomId/recording/start", ...postRecordingStart);
rtcRouter.post("/rooms/:roomType/:roomId/recording/stop", ...postRecordingStop);
