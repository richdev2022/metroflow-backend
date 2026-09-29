/** E2E step 2: meeting create, AI chat, vision OCR via attachment, limit enforcement, FLW verify route. */
import { query } from "./server/db";
import fs from "fs";

const BASE = "http://localhost:3001/api";
const creds = JSON.parse(fs.readFileSync("/home/z/my-project/scripts/e2e-creds.json", "utf8"));
const H = (t: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${t}` });

function assert(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}

// 1x1 red PNG for upload
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function main() {
  const hostToken = creds.hostToken;
  const partToken = creds.partToken;
  const hostId = creds.hostUser.id || creds.hostUser.userId;

  // ---- Meeting create (instant) ----
  const mk = await fetch(`${BASE}/meetings`, {
    method: "POST", headers: H(hostToken),
    body: JSON.stringify({ title: "E2E Signal Test", isInstant: true, startTime: new Date().toISOString() }),
  });
  const mkBody = await mk.json();
  const meeting = mkBody.data || mkBody;
  const meetingId = meeting.id;
  const meetingCode = meeting.meetingCode || meeting.code;
  assert("meeting created", mk.ok && !!meetingId, `code=${meetingCode} id=${meetingId}`);
  creds.meeting = meeting;
  fs.writeFileSync("/home/z/my-project/scripts/e2e-creds.json", JSON.stringify(creds, null, 2));

  // ---- Participant validates meeting (join gate; webapp calls GET /meetings/validate/:code) ----
  const val = await fetch(`${BASE}/meetings/validate/${meetingCode}`, { headers: H(partToken) });
  const valBody = await val.json().catch(() => ({}));
  // The backend returns the entity FLAT (no nested .meeting) — this is the shape
  // JoinMeeting.tsx expects (commit 0aecf4d). Assert flat id presence.
  const flat = (valBody.data || valBody);
  assert("participant validate meeting (flat shape)", val.status === 200 && !!flat.id && flat.accessState !== undefined,
    `HTTP ${val.status} keys=${Object.keys(flat).slice(0, 8).join(",")} accessState=${flat.accessState}`);

  // ---- AI chat (plain text) ----
  const t0 = Date.now();
  const chat = await fetch(`${BASE}/ai/chat`, {
    method: "POST", headers: H(hostToken),
    body: JSON.stringify({ message: "In one short sentence, what is Metricorex?" }),
  });
  const chatBody = await chat.json();
  assert("ai chat text reply", chat.ok && !!chatBody.data?.reply, `${Date.now() - t0}ms: ${String(chatBody.data?.reply || JSON.stringify(chatBody)).slice(0, 120)}`);

  // ---- AI attachment upload (image) ----
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "test-pixel.png");
  const up = await fetch(`${BASE}/ai/attachments`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` }, body: form });
  const upBody = await up.json();
  assert("ai attachment upload", up.ok && !!upBody.data?.url, JSON.stringify(upBody.data || upBody).slice(0, 140));
  const imageUrl = upBody.data?.url;

  // ---- AI vision/OCR on the attached image ----
  if (imageUrl) {
    const v0 = Date.now();
    const vis = await fetch(`${BASE}/ai/chat`, {
      method: "POST", headers: H(hostToken),
      body: JSON.stringify({ message: "I attached a tiny test image. What color is it? One word.", imageUrl }),
    });
    const visBody = await vis.json();
    const reply = String(visBody.data?.reply || "");
    assert("ai vision (attached image understood)", vis.ok && reply.length > 0, `${Date.now() - v0}ms: ${reply.slice(0, 140)}`);
  }

  // ---- Video attachment upload accepted (no frame extraction for tiny fake, graceful reply) ----
  const fakeMp4 = Buffer.from("AAAAfxAAAH8AAAAAAA==", "base64"); // not a real video — server should still store it
  const formV = new FormData();
  formV.append("file", new Blob([fakeMp4], { type: "video/mp4" }), "clip.mp4");
  const upv = await fetch(`${BASE}/ai/attachments`, { method: "POST", headers: { Authorization: `Bearer ${hostToken}` }, body: formV });
  const upvBody = await upv.json();
  assert("ai video attachment upload", upv.ok && !!upvBody.data?.url && upvBody.data?.attachmentType === "video", JSON.stringify(upvBody.data || upvBody).slice(0, 140));

  // ---- Usage counters incremented ----
  const us = await fetch(`${BASE}/ai/usage`, { headers: H(hostToken) });
  const usBody = await us.json();
  const chatUsed = usBody.data?.usage?.chat?.daily?.used ?? -1;
  assert("usage counter incremented", chatUsed >= 2, `chat.daily.used=${chatUsed}`);

  // ---- Limit enforcement (inject a counter at the cap, then expect 429) ----
  const partId = creds.partUser.id || creds.partUser.userId;
  // find participant's daily chat limit via their own usage endpoint
  const usP = await fetch(`${BASE}/ai/usage`, { headers: H(partToken) });
  const usPBody = await usP.json();
  const dailyLimit = usPBody.data?.usage?.chat?.daily?.limit;
  if (dailyLimit != null) {
    await query(
      `INSERT INTO metric_ai_usage (user_id, feature, day, month, count)
       VALUES ($1, 'chat', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM'), $2)
       ON CONFLICT (user_id, feature, day) DO UPDATE SET count = $2`,
      [partId, dailyLimit],
    );
    const blocked = await fetch(`${BASE}/ai/chat`, {
      method: "POST", headers: H(partToken),
      body: JSON.stringify({ message: "hello" }),
    });
    const blockedBody = await blocked.json();
    assert("limit enforcement 429", blocked.status === 429 && blockedBody.code === "ai_limit_reached",
      `HTTP ${blocked.status} code=${blockedBody.code} err=${String(blockedBody.error).slice(0, 80)}`);
    // cleanup the injected row
    await query(`DELETE FROM metric_ai_usage WHERE user_id = $1 AND feature = 'chat' AND day = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`, [partId]);
    const ok = await fetch(`${BASE}/ai/chat`, { method: "POST", headers: H(partToken), body: JSON.stringify({ message: "Say OK in one word" }) });
    assert("unblocked after cleanup", ok.status === 200, `HTTP ${ok.status}`);
  } else {
    assert("limit enforcement 429", false, "could not read participant daily limit");
  }

  // ---- Flutterwave verify route exists + behaves (404 for unknown reference) ----
  const flw = await fetch(`${BASE}/subscription/verify-payment`, {
    method: "POST", headers: H(partToken),
    body: JSON.stringify({ reference: `TXN_E2E_NONEXISTENT_${Date.now()}` }),
  });
  const flwBody = await flw.json().catch(() => ({}));
  assert("verify-payment route live (404 unknown ref)", flw.status === 404, `HTTP ${flw.status} ${JSON.stringify(flwBody).slice(0, 100)}`);

  // ---- History includes attachments ----
  const hist = await fetch(`${BASE}/ai/history?page=1&limit=10`, { headers: H(hostToken) });
  const histBody = await hist.json();
  const lastUser = (histBody.data?.messages || []).filter((m: any) => m.role === "user").pop();
  assert("history persists attachments", !!lastUser && (!!lastUser.imageUrl || !!lastUser.attachmentUrl), JSON.stringify({ imageUrl: lastUser?.imageUrl, attachmentUrl: lastUser?.attachmentUrl, type: lastUser?.attachmentType }).slice(0, 140));

  process.exit(process.exitCode || 0);
}
main().catch((e) => { console.error("E2E-2 CRASHED:", e); process.exit(1); });
