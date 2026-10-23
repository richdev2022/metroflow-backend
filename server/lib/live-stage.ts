import { query } from "../db";

/**
 * Live-stage publish gating.
 *
 * Personal LIVE streams ride the call-room stack: every live session owns a
 * `calls` row (matched by call_code) and viewers join that room's media.
 * A viewer must NEVER be able to publish audio/video to the broadcast room —
 * only the host and stage guests (cohost_ids) may. LiveKit tokens now carry
 * an explicit canPublish grant derived from this check, so even a tampered
 * client cannot unmute a viewer inside someone's live stream.
 */
export interface LiveStageInfo {
  /** True when this call room is the media room of an active LIVE session. */
  isLiveSession: boolean;
  sessionId: string | null;
  isHost: boolean;
  /** On stage (host or approved guest). */
  isStage: boolean;
  /** May publish mic/cam/screen tracks into the room. */
  canPublish: boolean;
}

const NOT_LIVE: LiveStageInfo = {
  isLiveSession: false,
  sessionId: null,
  isHost: false,
  isStage: false,
  canPublish: true,
};

export async function liveStageForCallRoom(callRoomId: string, userId: string): Promise<LiveStageInfo> {
  try {
    const r = await query(
      `SELECT l.id, l.host_id, l.cohost_ids
       FROM live_sessions l
       JOIN calls c ON c.call_code = l.call_code
       WHERE c.id = $1 AND l.status = 'live'
       LIMIT 1`,
      [callRoomId],
    );
    const row = r.rows[0];
    if (!row) return NOT_LIVE;
    const cohosts = Array.isArray(row.cohost_ids) ? row.cohost_ids : [];
    const isHost = row.host_id === userId;
    const isStage = isHost || cohosts.includes(userId);
    return {
      isLiveSession: true,
      sessionId: row.id,
      isHost,
      isStage,
      canPublish: isStage,
    };
  } catch {
    // Fail-open for non-live rooms: this helper must never break normal calls.
    return NOT_LIVE;
  }
}
