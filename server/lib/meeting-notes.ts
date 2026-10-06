import crypto from "crypto";
import { query } from "../db";
import { glmChat, isGlmConfigured } from "./glm";
import logger from "./logger";

/**
 * AI meeting notes — generated from the meeting transcript after a meeting
 * ends (or on demand). Provider-agnostic: it only depends on the persisted
 * transcript rows, never on LiveKit/MediaSoup specifics.
 */

export interface MeetingActionItem {
  title: string;
  description?: string;
  assignedTo?: string | null;
  dueDate?: string | null;
  status: "open" | "in_progress" | "done";
}

export interface MeetingNotes {
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: MeetingActionItem[];
  importantTimestamps?: { ts: string; description: string }[];
}

function extractJsonBlock(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) return raw.slice(start, end + 1);
  return null;
}

function asStringArray(v: unknown, max = 12): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === "string" && x.trim())
    .map((x) => String(x).trim().slice(0, 500))
    .slice(0, max);
}

function sanitizeNotes(raw: string): MeetingNotes | null {
  const jsonStr = extractJsonBlock(raw);
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    const actionItems: MeetingActionItem[] = Array.isArray(parsed.actionItems)
      ? parsed.actionItems.slice(0, 20).map((a: any) => ({
          title: String(a?.title || a?.task || "Action item").slice(0, 200),
          description: a?.description ? String(a.description).slice(0, 1000) : undefined,
          assignedTo: a?.assignedTo ? String(a.assignedTo).slice(0, 120) : null,
          dueDate: a?.dueDate ? String(a.dueDate).slice(0, 40) : null,
          status: ["open", "in_progress", "done"].includes(a?.status) ? a.status : "open",
        }))
      : [];
    return {
      summary: String(parsed.summary || "").slice(0, 6000),
      keyPoints: asStringArray(parsed.keyPoints),
      decisions: asStringArray(parsed.decisions),
      actionItems,
      importantTimestamps: Array.isArray(parsed.importantTimestamps)
        ? parsed.importantTimestamps.slice(0, 15).map((t: any) => ({
            ts: String(t?.ts || "").slice(0, 40),
            description: String(t?.description || "").slice(0, 300),
          }))
        : [],
    };
  } catch {
    return null;
  }
}

/** True when the transcript has enough content to be worth summarizing. */
export async function hasSummarizableTranscript(meetingId: string): Promise<boolean> {
  const res = await query(
    `SELECT COUNT(*)::int AS n FROM meeting_transcripts WHERE meeting_id = $1`,
    [meetingId],
  );
  return (res.rows[0]?.n || 0) >= 3;
}

/**
 * Generate (or regenerate) AI notes for a meeting. No-ops (returns null)
 * when there is no GLM key or the transcript is too thin.
 */
export async function generateMeetingNotes(
  meetingId: string,
  fallbackTitle = "Meeting",
): Promise<MeetingNotes | null> {
  if (!isGlmConfigured()) {
    logger.info("Meeting notes skipped: GLM not configured");
    return null;
  }
  if (!(await hasSummarizableTranscript(meetingId))) return null;

  const tRes = await query(
    `SELECT speaker_id as "speakerId", speaker_name as "speakerName", text, created_at
     FROM meeting_transcripts
     WHERE meeting_id = $1 ORDER BY created_at ASC LIMIT 400`,
    [meetingId],
  );
  // UUID-looking speaker names confuse the model AND the rendered notes —
  // resolve them to human names first (cached, best-effort).
  const { resolveSpeakerNames } = await import("./speaker-names");
  const resolvedRows = await resolveSpeakerNames(tRes.rows as any[]);
  const lines = resolvedRows.map((r: any) => `${r.speakerName || "Speaker"}: ${r.text}`);
  const transcript = lines.join("\n").slice(0, 60_000);

  const mRes = await query(`SELECT title FROM meetings WHERE id = $1`, [meetingId]);
  const title = mRes.rows[0]?.title || fallbackTitle;

  const prompt = `You are Metricorex AI. Below is the transcript of a business meeting titled "${title}".
Produce meeting notes as STRICT JSON (no markdown fences, no commentary) with exactly this shape:
{
  "summary": "2-4 sentence executive summary",
  "keyPoints": ["key discussion point", ...],
  "decisions": ["decision made", ...],
  "actionItems": [{"title": "...", "description": "...", "assignedTo": "name or null", "dueDate": "YYYY-MM-DD or null", "status": "open"}],
  "importantTimestamps": [{"ts": "reference from transcript", "description": "what happened"}]
}
Rules: be factual, only use information from the transcript, write in the meeting's dominant language, keep action items concrete and assignable.
The transcript lines are raw speech-to-text output: silently skip unintelligible fragments and obvious mis-transcriptions, interpret filler-heavy sentences by their clear meaning, and NEVER quote broken ASR text verbatim.

TRANSCRIPT:
${transcript}`;

  const raw = await glmChat({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    maxTokens: 2500,
  });
  const notes = sanitizeNotes(raw);
  if (!notes) {
    logger.warn("Meeting notes: model output was not parseable JSON");
    return null;
  }

  await query(
    `INSERT INTO meeting_notes (id, meeting_id, summary, key_points, decisions, action_items, important_timestamps, model, generated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, CURRENT_TIMESTAMP)
     ON CONFLICT (meeting_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       key_points = EXCLUDED.key_points,
       decisions = EXCLUDED.decisions,
       action_items = EXCLUDED.action_items,
       important_timestamps = EXCLUDED.important_timestamps,
       model = EXCLUDED.model,
       generated_at = CURRENT_TIMESTAMP`,
    [
      crypto.randomUUID(),
      meetingId,
      notes.summary,
      JSON.stringify(notes.keyPoints),
      JSON.stringify(notes.decisions),
      JSON.stringify(notes.actionItems),
      JSON.stringify(notes.importantTimestamps || []),
      process.env.GLM_CHAT_MODEL || "glm-4.7-flash",
    ],
  );

  return notes;
}

/**
 * Fire-and-forget finalizer used when a meeting ends. Only generates notes
 * when a transcript exists (never invents content for silent meetings).
 */
export async function generateMeetingNotesIfEligible(
  meetingId: string,
  fallbackTitle = "Meeting",
): Promise<void> {
  try {
    if (!(await hasSummarizableTranscript(meetingId))) return;
    const notes = await generateMeetingNotes(meetingId, fallbackTitle);
    if (notes) {
      const { getSocketServer } = await import("./socket");
      const io = getSocketServer();
      if (io) {
        io.to(`room:${meetingId}`).emit("meeting:notes_updated", { meetingId, notes });
        io.to(`meeting:${meetingId}`).emit("meeting:notes_updated", { meetingId, notes });
      }
    }
  } catch (err) {
    logger.warn("generateMeetingNotesIfEligible failed:", err);
  }
}
