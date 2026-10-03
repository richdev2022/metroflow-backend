import { sendPushToUsers } from "../services/push";
import { sendWebPushToUsers } from "../services/webPush";

/**
 * Incoming / missed call push notifications.
 *
 * Push must NEVER block or fail the call flow: every send is fire-and-forget
 * from the caller's perspective (helpers are async but callers do not await
 * them, and every failure path is caught inside).
 */

export interface IncomingCallPushInfo {
  callId: string;
  callType: string; // 'audio' | 'video'
  callerName: string;
  callerId: string;
  callCode?: string | null;
  conversationId?: string | null;
}

/**
 * Ring every callee device: FCM (data-only, high priority) + Web Push (VAPID,
 * TTL 60s, urgency high). Never pushes to the caller.
 */
export async function pushIncomingCall(
  calleeUserIds: string[],
  info: IncomingCallPushInfo,
): Promise<void> {
  try {
    const targets = (calleeUserIds || []).filter(
      (id) => id && id !== info.callerId,
    );
    if (targets.length === 0) return;

    const callTypeLabel = info.callType === "audio" ? "audio" : "video";

    // FCM (mobile): data-only style payload, no in-app notification mirror —
    // the app renders its own full-screen incoming-call UI.
    await sendPushToUsers(
      targets.map((userId) => ({ userId })),
      {
        title: info.callerName,
        body: `Incoming ${callTypeLabel} call`,
        data: {
          type: "incoming-call",
          callId: info.callId,
          callType: callTypeLabel,
          callerName: info.callerName,
          callerId: info.callerId,
          callCode: info.callCode || "",
          ...(info.conversationId ? { conversationId: info.conversationId } : {}),
        },
        androidChannelId: "calls",
      },
      { inApp: false },
    ).catch(() => {});

    // Web Push (browsers): short TTL — a ring that arrives a minute late is
    // worse than no ring at all.
    await sendWebPushToUsers(
      targets,
      {
        type: "incoming-call",
        callId: info.callId,
        callType: callTypeLabel,
        callerName: info.callerName,
        callCode: info.callCode || null,
      },
      { TTL: 60, urgency: "high" },
    );
  } catch (err: any) {
    console.error("[call-push] pushIncomingCall failed (non-fatal):", err?.message || err);
  }
}

/**
 * "Missed call" notice for the callee side when a call ends without being
 * answered (missed / cancelled / no-answer). Mirrors an in-app notification
 * (type 'call') AND sends an FCM push.
 */
export async function pushMissedCall(
  calleeUserIds: string[],
  info: { callId: string; callerName: string; callerId?: string | null; callCode?: string | null; status?: string },
): Promise<void> {
  try {
    const targets = (calleeUserIds || []).filter(
      (id) => id && id !== info.callerId,
    );
    if (targets.length === 0) return;

    await sendPushToUsers(
      targets.map((userId) => ({ userId })),
      {
        title: "Missed call",
        body: info.callerName,
        data: {
          type: "missed-call",
          callId: info.callId,
          callerName: info.callerName,
          callCode: info.callCode || "",
          status: info.status || "missed",
        },
        androidChannelId: "calls",
      },
      { inApp: true, type: "call" },
    );
  } catch (err: any) {
    console.error("[call-push] pushMissedCall failed (non-fatal):", err?.message || err);
  }
}

/**
 * "Call cancelled" — SILENT push that tells devices still RINGING that the
 * caller hung up, so the full-screen ring notification and the in-app
 * incoming-call overlay are dismissed immediately (the ring device was never
 * in the socket room, so `call:ended` alone could not reach it).
 * No banner is rendered on purpose: the call simply goes away.
 */
export async function pushCallCancelled(
  calleeUserIds: string[],
  info: { callId: string; callerName?: string | null; callerId?: string | null; reason?: string },
): Promise<void> {
  try {
    const targets = (calleeUserIds || []).filter(
      (id) => id && id !== info.callerId,
    );
    if (targets.length === 0) return;

    await sendPushToUsers(
      targets.map((userId) => ({ userId })),
      {
        title: "Call cancelled",
        body: "The call was cancelled",
        data: {
          type: "call-cancelled",
          callId: info.callId,
          callerName: info.callerName || "",
          reason: info.reason || "caller_hung_up",
        },
        androidChannelId: "calls",
      },
      // inApp:false + no type mirror => silent data push, nothing rendered.
      { inApp: false },
    ).catch(() => {});

    await sendWebPushToUsers(
      targets,
      {
        type: "call-cancelled",
        callId: info.callId,
        reason: info.reason || "caller_hung_up",
      },
      { TTL: 60, urgency: "high" },
    );
  } catch (err: any) {
    console.error("[call-push] pushCallCancelled failed (non-fatal):", err?.message || err);
  }
}
