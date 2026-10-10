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

// ---------------------------------------------------------------------------
// Delivery-ack ledger: Android OEM launchers (Xiaomi, Oppo, Vivo, some
// Samsung power-savers) SILENTLY DROP data-only FCM messages when the app was
// swiped away — FCM reports the send as accepted (`sent: 1`), so a
// send-failure fallback never fires and the phone never rings. The mobile app
// therefore ACKs every received incoming-call push via POST /calls/push-ack;
// when no ack lands within the window below, we escalate to a VISIBLE tray
// notification (notification + data hybrid), which Android delivers through
// the system tray path that OEMs do not drop.
// ---------------------------------------------------------------------------
const ACK_WINDOW_MS = 4000;
const pendingAckFallbacks = new Map<string, NodeJS.Timeout>();

export function acknowledgeCallPush(callId: string): void {
  if (!callId) return;
  const timer = pendingAckFallbacks.get(callId);
  if (timer) {
    clearTimeout(timer);
    pendingAckFallbacks.delete(callId);
  }
}

function scheduleVisibleFallback(
  targets: { userId: string }[],
  fcmPayload: any,
  callId: string,
): void {
  // Never double-schedule for the same call (re-invites ring again).
  const existing = pendingAckFallbacks.get(callId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingAckFallbacks.delete(callId);
    console.warn(`[call-push] no delivery ack for call ${callId} within ${ACK_WINDOW_MS}ms — escalating to visible tray notification`);
    sendPushToUsers(targets, { ...fcmPayload, androidDataOnly: false }, { inApp: false }).catch(() => {});
  }, ACK_WINDOW_MS);
  // Unref so a pending fallback never keeps the process alive.
  if (typeof timer.unref === "function") timer.unref();
  pendingAckFallbacks.set(callId, timer);
}

/**
 * Ring every callee device through layered fallbacks:
 *   1. FCM data-only (Android): the app's own handler renders the rich
 *      full-screen ringing UI (Accept/Decline, ringtone) in EVERY app state
 *      — foreground, background and killed. iOS gets a real APNs alert.
 *   2. Delivery-ack fallback: the app acks the push via POST /calls/push-ack.
 *      If NO ack arrives within 4s (OEM dropped the data-only message while
 *      the app was swiped away), a VISIBLE system-tray notification is sent
 *      so the callee's phone still rings and the tap still opens the call.
 *   3. Web Push (VAPID, TTL 60s, urgency high) for browser callees.
 *   4. Socket room ring + invite email are sent by the callers upstream.
 * Never pushes to the caller.
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
    const fcmPayload = {
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
      // Max-priority heads-up rendering for the VISIBLE fallback (the 4s
      // no-ack escalation): category "call" + PRIORITY_MAX makes FCM's own
      // tray notification banner over anything and use the channel's alarm
      // sound — a swiped-away app still rings even when its own full-screen
      // render never got a chance.
      androidCallStyle: true,
      // A call that nobody answered in 45s is dead — never ring late.
      ttlSeconds: 45,
      collapseKey: `incoming-call-${info.callId}`,
    } as const;

    // --- Attempt 1: data-only on Android (rich in-app ringing UI). ---
    const primary = await sendPushToUsers(
      targets.map((userId) => ({ userId })),
      { ...fcmPayload, androidDataOnly: true },
      { inApp: false },
    ).catch(() => ({ sent: 0, failed: 0, users: 0 }));

    // --- Attempt 2 (delivery-ack fallback): even when FCM ACCEPTED the
    // send, the device may never render a data-only message (OEM drop while
    // the app is killed/swiped). The app acks on receipt; no ack within the
    // window escalates to a visible tray notification.
    if (primary.sent > 0) {
      scheduleVisibleFallback(
        targets.map((userId) => ({ userId })),
        fcmPayload,
        info.callId,
      );
    } else if (targets.length > 0) {
      // Nothing was accepted at all — fall back immediately.
      setTimeout(() => {
        sendPushToUsers(
          targets.map((userId) => ({ userId })),
          { ...fcmPayload, data: { ...fcmPayload.data, delivery: "fallback" } },
          { inApp: false },
        ).catch(() => {});
      }, 1500);
    }

    // --- Web Push (browsers): short TTL — a ring that arrives a minute late
    // is worse than no ring at all.
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
        androidChannelId: "general-v2",
        ttlSeconds: 300,
        // Deliberately tagged like the INCOMING-CALL push: on Android the
        // tag makes the missed-call notice REPLACE the still-ringing tray
        // notification instead of stacking next to it.
        collapseKey: `incoming-call-${info.callId}`,
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
        // SILENT: data-only on both platforms. The iOS branch in push.ts
        // sends a content-available background push (no aps.alert) and the
        // Android branch skips the tray notification — a hung-up call must
        // never banner or ring.
        silent: true,
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
