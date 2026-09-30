import * as mediasoup from "../mediasoup";
import type { CallingProvider } from "./types";

/**
 * MediaSoup provider — wraps the original in-process mediasoup stack.
 * The actual WebRTC signaling still flows over Socket.IO (`mediasoup:*`
 * events); credentials are implicit (no token), which keeps the existing
 * clients fully backward compatible.
 */
export const mediasoupProvider: CallingProvider = {
  name: "mediasoup",
  label: "MediaSoup (self-hosted)",

  isConfigured() {
    // In-process SFU: considered configured once workers are initialized.
    // Before boot completes we still report configured=true so joins can be
    // retried by clients (the mediasoup:* acks return retryable errors).
    return true;
  },

  async healthCheck() {
    const ready = mediasoup.isMediasoupReady();
    return {
      enabled: true,
      configured: ready,
      healthy: ready,
      details: mediasoup.getMediasoupDiagnostics(),
    };
  },

  async mintJoinCredentials(ctx) {
    // Legacy flow: no token — clients signal over Socket.IO with their
    // authenticated session. Room name is the resolved UUID.
    return { roomName: ctx.roomId };
  },

  async endSession(roomId: string) {
    try {
      mediasoup.removeRoom(roomId);
    } catch {
      // Room may not exist — ignore.
    }
  },

  // NOTE: no startRecording/stopRecording — MediaSoup rooms have no server
  // recorder; routes treat the missing methods as "client-side recording".

  diagnostics() {
    return mediasoup.getMediasoupDiagnostics();
  },
};
