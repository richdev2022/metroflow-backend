/** E2E step 3: meeting create (isInstant) + TRUE vision test via data URL image. */
import fs from "fs";

const BASE = "http://localhost:3001/api";
const creds = JSON.parse(fs.readFileSync("/home/z/my-project/scripts/e2e-creds.json", "utf8"));
const H = (t: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${t}` });

function assert(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}

// Real 320x160 red PNG with white text "METRICOREX 2026" (generated via PIL)
const RED_PNG_B64 = fs.readFileSync("/home/z/my-project/scripts/red_test_png.b64", "utf8").trim();

async function main() {
  const hostToken = creds.hostToken;

  // ---- Meeting create (instant) ----
  const mk = await fetch(`${BASE}/meetings`, {
    method: "POST", headers: H(hostToken),
    body: JSON.stringify({ title: "E2E Signal Test", isInstant: true, startTime: new Date().toISOString() }),
  });
  const mkBody = await mk.json();
  const meeting = mkBody.data || mkBody;
  assert("meeting created", mk.ok && !!meeting.id, `code=${meeting.meetingCode || meeting.code} id=${meeting.id}`);
  creds.meeting = meeting;
  fs.writeFileSync("/home/z/my-project/scripts/e2e-creds.json", JSON.stringify(creds, null, 2));

  // ---- TRUE vision: red image as data URL ----
  const v0 = Date.now();
  const vis = await fetch(`${BASE}/ai/chat`, {
    method: "POST", headers: H(hostToken),
    body: JSON.stringify({
      message: "I attached a test image. Type the exact TEXT shown in it, nothing else.",
      imageUrl: `data:image/png;base64,${RED_PNG_B64}`,
    }),
  });
  const visBody = await vis.json();
  const reply = String(visBody.data?.reply || "");
  assert("vision OCR reads METRICOREX text", /METRICOREX\s*2026/i.test(reply), `${Date.now() - v0}ms reply="${reply.slice(0, 100)}"`);

  // ---- Realistic OCR: text inside image ----
  process.exit(process.exitCode || 0);
}
main().catch((e) => { console.error("E2E-3 CRASHED:", e); process.exit(1); });
