import { Router, type Request, type Response, type RequestHandler } from "express";
import { WebhookReceiver } from "livekit-server-sdk";
import { query } from "../../db";
import { getLiveKitConfig } from "./livekit";
import { getSocketServer } from "../socket";

/**
 * LiveKit webhooks — provider → backend callbacks.
 *
 * Mounted at POST /webhook/livekit WITHOUT authentication (LiveKit signs the
 * payload); every request is validated with WebhookReceiver (SHA256 HMAC over
 * the raw body in the Authorization header) using the same API key/secret the
 * backend mints join tokens with.
 *
 * Handled events:
 *  - egress_started / egress_update → keep recordings.status in sync
 *  - egress_ended   → finalize the recordings row (storageUrl, duration, size,
 *    completed/failed) and broadcast recording:stopped to the room
 *
 * This is what turns Egress output into a finished recording without any
 * polling: the MP4 lands in R2 (S3 output configured at egress start) and the
 * webhook tells us the final file key + duration + size.
 */

export const livekitWebhookRouter = Router();

type LivekitEgressFileResult = {
  filename?: string;
  startedAt?: number | string;
  endedAt?: number | string;
  duration?: number | string; // nanoseconds (protobuf int64 → string)
  size?: number | string;
  status?: string;
};

function toMillis(v: number | string | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Protobuf timestamps arrive in ms (int64 millis); egress durations in ns.
  return n > 1e12 ? n : n / 1e6;
}

function fileKeyFromFilename(filename: string | undefined): string | null {
  if (!filename) return null;
  // Our egress writes with filepath = "recordings/<businessId>/<recordingId>.mp4".
  // S3 output reports the full path we requested; strip a leading slash and any
  // "s3://bucket/" style prefix if the egress includes it.
  let key = String(filename);
  if (key.startsWith("s3://")) {
    const idx = key.indexOf("/", 5);
    if (idx !== -1) key = key.slice(idx + 1);
  }
  return key.replace(/^\/+/, "") || null;
}

const handleLivekitWebhook: RequestHandler = async (rawReq: Request, res: Response) => {
  const req = rawReq as Request & { rawBody?: Buffer };
  try {
    const { apiKey, apiSecret } = getLiveKitConfig();
    if (!apiKey || !apiSecret) {
      return res.status(503).json({ success: false, error: "LiveKit is not configured" });
    }

    const authHeader = String(req.headers.authorization || "");
    if (!authHeader) {
      return res.status(401).json({ success: false, error: "Missing Authorization header" });
    }
    const rawBody = req.rawBody?.toString("utf8") ?? "";
    if (!rawBody) {
      return res.status(400).json({ success: false, error: "Missing raw body" });
    }

    let event: any;
    try {
      const receiver = new WebhookReceiver(apiKey, apiSecret);
      event = await receiver.receive(rawBody, authHeader);
    } catch (err: any) {
      console.warn("LiveKit webhook signature validation failed:", String(err?.message || err));
      return res.status(401).json({ success: false, error: "Invalid webhook signature" });
    }

    const eventName = String(event?.event || "");
    if (!eventName.startsWith("egress_")) {
      // Not an event we act on (participant/room/track events) — acknowledge.
      return res.json({ success: true, ignored: eventName });
    }

    const info = event?.egressInfo;
    const egressId = String(info?.egressId || "");
    if (!egressId) {
      return res.json({ success: true, ignored: "egress event without egressId" });
    }

    const found = await query(
      `SELECT id, business_id, meeting_id, call_id, status FROM recordings WHERE egress_id = $1 LIMIT 1`,
      [egressId],
    );
    const rec = found.rows[0];
    if (!rec) {
      return res.json({ success: true, ignored: "egress id not tracked by metricorex" });
    }

    if (eventName === "egress_ended") {
      const file: LivekitEgressFileResult | undefined = info?.fileResults?.[0];
      const fileKey = fileKeyFromFilename(file?.filename);
      const startedMs = toMillis(info?.startedAt) ?? toMillis(file?.startedAt);
      const endedMs = toMillis(info?.endedAt) ?? toMillis(file?.endedAt);
      const durationNs = typeof file?.duration === "string" ? Number(file.duration) : Number(file?.duration || 0);
      let durationSeconds = 0;
      if (Number.isFinite(durationNs) && durationNs > 0) {
        durationSeconds = Math.round(durationNs / 1e9);
      } else if (startedMs && endedMs && endedMs > startedMs) {
        durationSeconds = Math.round((endedMs - startedMs) / 1000);
      }
      const size = Number(file?.size || 0) || null;
      const failed = String(info?.status || "").toUpperCase() === "EGRESS_FAILED" || String(info?.error || "");

      await query(
        `UPDATE recordings
         SET status = $1,
             storage_url = COALESCE($2, storage_url),
             duration = CASE WHEN $3 > 0 THEN $3 ELSE duration END,
             size = COALESCE($4, size),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [failed ? "failed" : "completed", fileKey, durationSeconds, size, rec.id],
      );

      const io = getSocketServer();
      if (io) {
        const roomId = rec.meeting_id || rec.call_id;
        if (roomId) {
          io.to(`room:${roomId}`).emit("recording:stopped", {
            recordingId: rec.id,
            roomId,
            status: failed ? "failed" : "completed",
            durationSeconds,
          });
        }
      }
      return res.json({ success: true, recordingId: rec.id, status: failed ? "failed" : "completed" });
    }

    // egress_started / egress_update — confirm the row is still marked active.
    await query(
      `UPDATE recordings SET status = 'recording', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'processing'`,
      [rec.id],
    );
    return res.json({ success: true, recordingId: rec.id });
  } catch (error) {
    console.error("LiveKit webhook error:", error);
    return res.status(500).json({ success: false, error: "Webhook processing failed" });
  }
};

livekitWebhookRouter.post("/", handleLivekitWebhook);
