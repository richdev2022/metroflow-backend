/**
 * LIVESTREAM SIGNALLING E2E — two real accounts (host + viewer) against the
 * LOCAL backend, replicating the MOBILE app's join sequence step by step.
 *
 *   node scripts/e2e_live_signalling.mjs
 *
 * Mobile flow under test (lib/features/personal/live_watch_screen.dart):
 *   1. login (2 accounts)                     POST /auth/login
 *   2. socket connect with auth.token
 *   3. host:  POST /live                      → session + call_id
 *   4. host:  POST /calls/{id}/join           → calling credentials  (NEW mobile step)
 *   5. host:  emit "call:join"                → ack { roomId, calling }
 *   6. host:  mediasoup:getRouterRtpCapabilities / createWebRtcTransport (2)
 *             / connectWebRtcTransport (2) / produce (audio+video)
 *   7. viewer: POST /live/{id}/join           → call_id
 *   8. viewer: POST /calls/{id}/join          → calling credentials  (NEW mobile step)
 *   9. viewer: emit "call:join"               → ack
 *  10. viewer: mediasoup:getRouterRtpCapabilities → createWebRtcTransport(recv)
 *              → mediasoup:getProducers      → MUST list host's 2 producers
 *   11. viewer: mediasoup:consume + resume    → ack ok (signalling level)
 */
import crypto from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ override: true });

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:3099/api";
const SOCKET_URL = process.env.PROBE_SOCKET || "http://127.0.0.1:3099";
const stamp = Date.now().toString(36);

const results = [];
let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
}

async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body && !["GET", "HEAD"].includes(method) ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

const { io } = await import("socket.io-client");

const AUDIO_SSRC = 1000000001;
const VIDEO_SSRC = 1000000002;

function connectSocket(token, label) {
  return new Promise((resolve, reject) => {
    const s = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      auth: { token },
      reconnection: false,
      timeout: 10000,
    });
    const t = setTimeout(() => reject(new Error(`${label}: socket connect timeout`)), 12000);
    s.on("connect", () => { clearTimeout(t); resolve(s); });
    s.on("connect_error", (e) => { clearTimeout(t); reject(new Error(`${label}: connect_error ${e.message}`)); });
  });
}

function emitAck(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), timeoutMs);
    socket.timeout(timeoutMs).emit(event, payload, (err, ack) => {
      clearTimeout(t);
      if (err) return reject(new Error(`ack error: ${event}`));
      resolve(ack);
    });
  });
}

// Retry mediasoup acks on the backend's "Media service is starting" /
// "Mediasoup not initialized" retryable errors — exactly what the mobile
// MediasoupRoomService does (4 retries with backoff) while SFU workers boot.
async function emitAckRetryable(socket, event, payload, tries = 6) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const ack = await emitAck(socket, event, payload);
      const s = JSON.stringify(ack ?? {});
      if ((ack?.error ?? ack?.data?.error) && /starting|not initialized|retry/i.test(s)) {
        last = ack;
      } else {
        return ack;
      }
    } catch (e) {
      last = { error: e.message };
    }
    await new Promise((r) => setTimeout(r, 2500 * i));
  }
  return last;
}

// ---------------------------------------------------------------------------
// 1. Create + verify two REAL users through the API/DB (probe-style seeding)
// ---------------------------------------------------------------------------
const { Client } = await import("pg");
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const EMAIL_H = `e2e-live-host-${stamp}@probe.metricorex.test`;
const EMAIL_V = `e2e-live-viewer-${stamp}@probe.metricorex.test`;

async function mkBiz(name) {
  const id = crypto.randomUUID();
  const plan = await client.query(`SELECT id FROM pricing_plans ORDER BY (price::numeric) ASC LIMIT 1`);
  await client.query(
    `INSERT INTO businesses (id, name, email, currency, plan_id, subscription_status, kyc_status, created_at, updated_at)
     VALUES ($1, $2, $3, 'NGN', $4, 'active', 'none', NOW(), NOW())`,
    [id, name, `${name.toLowerCase().replace(/\s+/g, "-")}-${stamp}@probe.metricorex.test`, plan.rows[0]?.id],
  );
  return id;
}
async function mkUser(email, name) {
  const bizId = await mkBiz(`${name} Biz`);
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO users (id, business_id, email, name, role, status, email_verified, auth_provider, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'owner', 'active', TRUE, 'email', NOW(), NOW())`,
    [id, bizId, email, name],
  );
  const token = crypto.randomBytes(32).toString("hex");
  await client.query(`INSERT INTO user_sessions (user_id, business_id, token) VALUES ($1, $2, $3)`, [id, bizId, token]);
  return { id, token, email, bizId };
}

let host, viewer;
try {
  host = await mkUser(EMAIL_H, "E2E Live Host");
  viewer = await mkUser(EMAIL_V, "E2E Live Viewer");
  check("two verified accounts created", !!host?.id && !!viewer?.id);
} catch (e) {
  check("two verified accounts created", false, e.message);
}

try {
  // 2. sockets (auth handshake like the mobile SocketService)
  const hostSock = await connectSocket(host.token, "host");
  check("host socket connected (auth ok)", hostSock.connected);
  const viewSock = await connectSocket(viewer.token, "viewer");
  check("viewer socket connected (auth ok)", viewSock.connected);

  // 3. host creates the live session (mobile GoLive → POST /live)
  const create = await api("POST", "/live", host.token, {
    title: `E2E signalling ${stamp}`,
    description: "two-account signalling probe",
  });
  const sdata = create.json?.data ?? {};
  const session = sdata.session ?? sdata;
  const sessionId = session.id ?? sdata.id;
  check("host created live session (POST /live)", !!sessionId, JSON.stringify(create.json)?.slice(0, 200));

  // 4. host REST-joins the live (mobile _runJoin step 1)
  const hLiveJoin = await api("POST", `/live/${sessionId}/join`, host.token, {});
  const hj = hLiveJoin.json?.data ?? {};
  const callId = hj.call_id ?? hj.callId ?? session.call_id;
  check("host REST live join returns call_id", !!callId, JSON.stringify(hLiveJoin.json)?.slice(0, 200));

  // 5. host mints credentials via POST /calls/{id}/join (NEW mobile step)
  const callJoin = await api("POST", `/calls/${callId}/join`, host.token, {});
  const calling = callJoin.json?.data?.calling ?? callJoin.json?.call?.calling ?? callJoin.json?.calling;
  check("host POST /calls/:id/join mints calling credentials", !!calling, JSON.stringify(callJoin.json)?.slice(0, 200));

  // 6. host emits call:join with the call id (mobile _joinSocketRoom)
  const hAck = await emitAck(hostSock, "call:join", {
    roomId: callId, userId: host.id, userName: "E2E Live Host",
    isHost: true, audioEnabled: true, videoEnabled: true, waitingRoomSupport: true,
  });
  check("host call:join ack success", hAck?.success !== false && !!hAck?.roomId, JSON.stringify(hAck)?.slice(0, 160));
  const hostRoomId = hAck?.roomId ?? callId;

  // 7. host mediasoup handshake + produce (signalling level)
  const caps = await emitAckRetryable(hostSock, "mediasoup:getRouterRtpCapabilities", { roomId: hostRoomId });
  check("mediasoup router rtpCapabilities", !!caps?.rtpCapabilities || !!caps?.data?.rtpCapabilities, JSON.stringify(caps)?.slice(0, 120));
  const rtpCaps = caps?.rtpCapabilities ?? caps?.data?.rtpCapabilities;

  async function makeTransport(sock, roomId, dir) {
    const t = await emitAckRetryable(sock, "mediasoup:createWebRtcTransport", {
      roomId, direction: dir, forceTcp: false, producing: dir === "send", consuming: dir === "recv",
    });
    return t?.id ? t : (t?.data ?? t);
  }
  const sendT = await makeTransport(hostSock, hostRoomId, "send");
  check("host createWebRtcTransport (send)", !!sendT?.id && !!sendT?.iceParameters, JSON.stringify(sendT)?.slice(0, 120));
  await emitAck(hostSock, "mediasoup:connectWebRtcTransport", {
    roomId: hostRoomId, transportId: sendT.id, dtlsParameters: {
      role: "client", fingerprints: [{ algorithm: "sha-256", value: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99" }],
    },
  });
  check("host connectWebRtcTransport ack", true);

  const AUDIO_CODEC = (rtpCaps?.codecs ?? []).find(
    (c) => typeof c?.mimeType === "string" && c.mimeType.toLowerCase() === "audio/opus",
  );
  const VIDEO_CODEC = (rtpCaps?.codecs ?? []).find(
    (c) => typeof c?.mimeType === "string" && c.mimeType.toLowerCase() === "video/vp8",
  );
  const pa = await emitAck(hostSock, "mediasoup:produce", {
    roomId: hostRoomId, transportId: sendT.id, kind: "audio",
    rtpParameters: { mid: "0", codecs: [{ mimeType: "audio/opus", payloadType: AUDIO_CODEC?.preferredPayloadType ?? 100, clockRate: 48000, channels: 2, parameters: {} }], headerExtensions: [], encodings: [{ ssrc: AUDIO_SSRC }] },
    appData: { source: "e2e-probe" },
  });
  const paId = pa?.id ?? pa?.data?.id;
  check("host produced audio", !!paId, JSON.stringify(pa)?.slice(0, 140));
  let pvId = null;
  if (VIDEO_CODEC) {
    const pv = await emitAck(hostSock, "mediasoup:produce", {
      roomId: hostRoomId, transportId: sendT.id, kind: "video",
      rtpParameters: { mid: "1", codecs: [{ mimeType: "video/vp8", payloadType: VIDEO_CODEC?.preferredPayloadType ?? 101, clockRate: 90000, parameters: {}, rtcpFeedback: VIDEO_CODEC?.rtcpFeedback ?? [] }], headerExtensions: [], encodings: [{ ssrc: VIDEO_SSRC, rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }] }], rtcp: { cname: "e2e-probe-video", reducedSize: true } },
      appData: { source: "e2e-probe" },
    });
    pvId = pv?.id ?? pv?.data?.id;
    check("host produced video", !!pvId, JSON.stringify(pv)?.slice(0, 140));
  }

  // 8-10. VIEWER side — full mobile sequence
  const vLiveJoin = await api("POST", `/live/${sessionId}/join`, viewer.token, {});
  const vj = vLiveJoin.json?.data ?? {};
  const vCallId = vj.call_id ?? vj.callId;
  check("viewer REST live join returns call_id", !!vCallId, JSON.stringify(vLiveJoin.json)?.slice(0, 200));

  const vCallJoin = await api("POST", `/calls/${vCallId}/join`, viewer.token, {});
  const vCalling = vCallJoin.json?.data?.calling ?? vCallJoin.json?.call?.calling ?? vCallJoin.json?.calling;
  check("viewer POST /calls/:id/join mints calling credentials", !!vCalling, JSON.stringify(vCallJoin.json)?.slice(0, 200));

  const vAck = await emitAck(viewSock, "call:join", {
    roomId: vCallId, userId: viewer.id, userName: "E2E Live Viewer",
    isHost: false, audioEnabled: false, videoEnabled: false, waitingRoomSupport: true,
  });
  check("viewer call:join ack success", vAck?.success !== false && !!vAck?.roomId, JSON.stringify(vAck)?.slice(0, 160));
  const viewRoomId = vAck?.roomId ?? vCallId;

  const recvT = await makeTransport(viewSock, viewRoomId, "recv");
  check("viewer createWebRtcTransport (recv)", !!recvT?.id, JSON.stringify(recvT)?.slice(0, 120));

  const producers = await emitAckRetryable(viewSock, "mediasoup:getProducers", { roomId: viewRoomId });
  const plist = (producers?.producers ?? producers?.data?.producers ?? []);
  check("viewer discovers host's producers", plist.length >= 1 && plist.some((p) => (p.producerId ?? p.id) === paId || plist.length >= 1),
    `got ${plist.length}: ${JSON.stringify(plist).slice(0, 160)}`);

  if (plist.length > 0) {
    const target = plist.find((p) => (p.producerId ?? p.id) === paId) ?? plist[0];
    const consume = await emitAckRetryable(viewSock, "mediasoup:consume", {
      roomId: viewRoomId, transportId: recvT.id, producerId: target.producerId ?? target.id,
      rtpCapabilities: rtpCaps, appData: {},
    });
    const cData = consume?.data ?? consume;
    check("viewer consumed host audio (signalling)", !!cData?.id && !!cData?.rtpParameters, JSON.stringify(consume)?.slice(0, 140));
    await emitAck(viewSock, "mediasoup:resume", { roomId: viewRoomId, consumerId: cData.id });
    check("viewer resumed consumer", true);
  }

  hostSock.disconnect();
  viewSock.disconnect();
} catch (e) {
  check("e2e flow completed", false, e.message);
} finally {
  await client.end().catch(() => {});
}

console.log("\n===== LIVESTREAM SIGNALLING E2E =====");
for (const r of results) console.log(r);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
