// Smoke test for the upgraded push pipeline diagnostics (Task: push-status Android investigation).
// Boots the REAL server/services/push.ts with:
//   - a generated RSA service account (real JWT signing path),
//   - a stubbed Google OAuth + FCM HTTP v1 endpoint (axios patched),
//   - no database (platform lookup + prune queries fail gracefully — exercises those guards).
// Asserts: per-token diagnostics, data-only Android call shape, iOS APNs alert shape,
// 404 prune behaviour, and the config-mismatch warning.
import { createRequire } from "node:module";
import crypto from "node:crypto";
import axios from "axios";

// ---- env BEFORE importing anything that reads them ----
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "firebase-adminsdk-fbsvc@metricorex.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  project_id: "proj-under-test",
});
process.env.FIREBASE_PROJECT_ID = "proj-under-test";
// Instant-fail DB (port 1) so the graceful DB-down guards are exercised.
process.env.DATABASE_URL = "postgresql://smoke:smoke@127.0.0.1:1/db";
process.env.PG_CONNECTION_TIMEOUT_MS = "200";
process.env.PGPOOL_MAX = "1";

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// Capture console.error across the WHOLE run (the fresh-token mismatch warning
// fires once per process, from the first 404 prune — wherever that happens).
const errLogs = [];
const origErr = console.error;
console.error = (...args) => { errLogs.push(args.map(String).join(" ")); origErr(...args); };

// ---- stub the Google endpoints on the shared axios instance ----
const fcmCalls = [];
const originalPost = axios.post;
axios.post = async function patchedPost(url, body, config) {
  if (url.includes("oauth2.googleapis.com/token")) {
    return { data: { access_token: "smoke-access-token", expires_in: 3600 } };
  }
  if (url.startsWith("https://fcm.googleapis.com/v1/projects/")) {
    fcmCalls.push({ url, body, config });
    const token = body?.message?.token || "";
    if (token.startsWith("OK")) return { data: { name: `projects/proj-under-test/messages/smoke-1` } };
    if (token.startsWith("DEAD")) {
      const err = new Error("Requested entity was not found.");
      err.response = { status: 404, data: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } };
      throw err;
    }
    if (token.startsWith("BUSY")) {
      const err = new Error("Quota exceeded");
      err.response = { status: 429, data: { error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" } } };
      throw err;
    }
  }
  return originalPost.apply(this, arguments);
};

const { sendToTokens, isPushConfigured, pushDeliveryMode } = await import("../server/services/push.ts");

ok(isPushConfigured() === true, "isPushConfigured true with service account");
ok(pushDeliveryMode() === "http-v1", "delivery mode http-v1");

// ---- case 1: incoming-call shape (production attempt 1) — iOS ok, Android 404, Android 429 ----
const callPayload = {
  title: "Push Test Caller",
  body: "Incoming audio call (push pipeline test)",
  data: {
    type: "incoming-call",
    callId: "push-test-abc",
    callType: "audio",
    callerName: "Push Test Caller",
    callerId: "user-1",
    callCode: "",
  },
  androidChannelId: "calls",
  ttlSeconds: 45,
  collapseKey: "incoming-call-push-test-abc",
  androidDataOnly: true,
};
fcmCalls.length = 0;
const diags1 = [];
const r1 = await sendToTokens(["OK-ios-token-aaaaaaaaaaaaaaaaaaaa", "DEAD-android-token-bbbbbbbbbbb", "BUSY-android-token-cccccccc"], callPayload, diags1);
ok(r1.sent === 1 && r1.failed === 2, `case1 counts sent=1 failed=2 (got sent=${r1.sent} failed=${r1.failed})`);
ok(diags1.length === 3, `case1 diagnostics for all 3 tokens (got ${diags1.length})`);
ok(diags1[0].ok === true && diags1[0].httpStatus === 200, "case1 iOS token diagnostics ok");
ok(diags1[1].httpStatus === 404 && diags1[1].ok === false && /NOT_FOUND/.test(diags1[1].error || ""), "case1 DEAD token 404 diagnostic with FCM error body");
ok(diags1[2].httpStatus === 429 && /RESOURCE_EXHAUSTED|Quota/.test(diags1[2].error || ""), "case1 BUSY token 429 diagnostic (NOT pruned path)");

// Shape assertions: the android (data-only) call message must have NO notification block;
// the iOS message must carry a real apns alert.
const iosMsg = fcmCalls.find((c) => c.body?.message?.token?.startsWith("OK"))?.body?.message;
ok(!!iosMsg, "case1 iOS message captured");
ok(iosMsg?.apns?.headers?.["apns-push-type"] === "alert" && iosMsg?.apns?.headers?.["apns-priority"] === "10", "case1 iOS message pushed as alert at priority 10");
ok(iosMsg?.apns?.payload?.aps?.alert?.title === "Push Test Caller" && !!iosMsg?.apns?.payload?.aps?.alert?.body, "case1 iOS message = real APNs alert with title");
ok(!!iosMsg?.data?.type === true && iosMsg?.data?.type === "incoming-call", "case1 iOS message carries data payload for deep-link");
ok(iosMsg?.apns?.headers?.["apns-expiration"] !== undefined, "case1 iOS call message carries apns-expiration (45s)");
const andMsg = fcmCalls.find((c) => c.body?.message?.token?.startsWith("DEAD"))?.body?.message;
ok(!!andMsg, "case1 Android message captured");
ok(andMsg?.notification === undefined, "case1 Android call message is DATA-ONLY (no system notification block)");
ok(andMsg?.android?.priority === "high" && andMsg?.android?.ttl === "45s" && andMsg?.android?.collapse_key === "incoming-call-push-test-abc", "case1 Android call message high-priority + 45s TTL + collapse key");
ok(fcmCalls.every((c) => c.url === "https://fcm.googleapis.com/v1/projects/proj-under-test/messages:send"), "case1 all sends target FIREBASE_PROJECT_ID");
ok(fcmCalls.every((c) => c.config?.headers?.Authorization === "Bearer smoke-access-token"), "case1 sends use OAuth bearer token");

// ---- case 2: chat shape (visible tray notification on Android) ----
const chatPayload = {
  title: "Push Test",
  body: "This is a chat push delivery test",
  data: { type: "chat-message", conversationId: "c1", messageId: "m1", senderName: "Push Test", badge: "1" },
  androidChannelId: "general",
  ttlSeconds: 3600,
  collapseKey: "chat-c1",
};
fcmCalls.length = 0;
const diags2 = [];
await sendToTokens(["OK-android-token-dddddddddddddddd"], chatPayload, diags2);
const chatMsg = fcmCalls[0]?.body?.message;
ok(chatMsg?.android?.notification?.title === "Push Test" && chatMsg?.android?.notification?.body === "This is a chat push delivery test" && chatMsg?.android?.notification?.channel_id === "general", "case2 Android chat message = visible tray notification on 'general' channel");
ok(chatMsg?.android?.collapse_key === "chat-c1" && chatMsg?.android?.ttl === "3600s", "case2 chat collapse + ttl set");
ok(diags2[0]?.ok === true, "case2 diagnostic ok");

// ---- case 3: general shape ----
fcmCalls.length = 0;
const diags3 = [];
await sendToTokens(["OK-ios-token-eeeeeeeeeeee"], { title: "Metroflow push test", body: "hello", data: { type: "test", kind: "general" } }, diags3);
const genMsg = fcmCalls[0]?.body?.message;
ok(genMsg?.apns?.payload?.aps?.alert?.body === "hello" && genMsg?.apns?.payload?.aps?.["interruption-level"] === "time-sensitive", "case3 general iOS alert time-sensitive");
ok(diags3[0]?.platform === "ios", "case3 diagnostic reports platform ios");

// ---- case 4: 404 prune leaves a paper trail + fresh-token mismatch warning ----
// (the mismatch warning fires ONCE per process — case1's DEAD token consumes it,
//  so assert on everything captured across the whole run)
fcmCalls.length = 0;
const diags4 = [];
await sendToTokens(["DEAD-ios-token-ffffffffffff"], { title: "t", body: "b", data: { type: "test" } }, diags4);
console.error = origErr;
ok(errLogs.some((l) => l.includes("[push] pruned invalid token") && l.includes("status=404")), "case4 prune logged with status + FCM error (paper trail)");
ok(errLogs.some((l) => l.includes("FRESH token pruned") && l.includes("CONFIG problem") && l.includes("proj-under-test")), "case4 fresh-token CONFIG-mismatch warning fired with project id (once per process, from case1's prune)");
ok(diags4[0]?.httpStatus === 404, "case4 diagnostic httpStatus 404");

// ---- case 5: platform split under a working DB — android token gets data-only call, ios gets alert (same batch) ----
fcmCalls.length = 0;
const diags5 = [];
await sendToTokens(["OK-ios-token-gggggggggg", "OK-android-token-hhhhhhhh"], callPayload, diags5);
ok(fcmCalls.find((c) => c.body?.message?.token?.includes("-android-"))?.body?.message?.notification === undefined, "case5 Android in mixed batch stays data-only for calls");
ok(fcmCalls.find((c) => c.body?.message?.token?.includes("-ios-"))?.body?.message?.apns?.payload?.aps?.alert !== undefined, "case5 iOS in mixed batch gets the APNs alert");
ok(diags5.every((d) => d.ok), "case5 both diagnostics ok");

console.log(failures === 0 ? "\nALL PUSH SMOKE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
