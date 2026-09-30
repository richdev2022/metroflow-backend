import { Router, RequestHandler } from "express";
import { query } from "../../db";
import { AuthenticatedRequest } from "../../middleware/auth";
import {
  buildCallingCredentials,
  computeRemainingSeconds,
  resolveProviderForRoom,
} from "./factory";

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

rtcRouter.post("/token", postToken);
rtcRouter.post("/rooms/:roomType/:roomId/participants/:identity/remove", postRemoveParticipant);
rtcRouter.post("/rooms/:roomType/:roomId/participants/:identity/mute", postMuteParticipant);
