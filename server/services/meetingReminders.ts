import { query } from "../db";
import { sendPushToUsers } from "./push";
import { sendEmail, generateMeetingReminderEmailHtml } from "./email";

/**
 * Google-style meeting reminders.
 *
 * Reminders are absolute timestamps (meeting_reminders.remind_at) inserted when
 * a meeting is created/updated. A per-minute cron (VPS/PM2 only) claims due
 * rows and delivers push + email to team attendees AND guest emails.
 */

const REMINDER_OFFSETS_MIN = [60, 15];

export interface RecurrenceInput {
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY" | "CUSTOM";
  /** Every N days/weeks/months/years (default 1). CUSTOM: every N days. */
  interval?: number;
  /** CUSTOM only — 0=Sun..6=Sat weekday list for "Weekly on Mon,Wed" style. */
  customDays?: number[];
  /** ISO date — hard stop for the series. */
  endDate?: string;
  /** Max number of occurrences (default/cap 90). */
  count?: number;
}

/** Hard caps so a bad payload can never flood the DB or mail queue. */
const MAX_OCCURRENCES = 90;
const MAX_SERIES_HORIZON_MS = 366 * 24 * 60 * 60 * 1000; // 1 year

/**
 * Materialise concrete occurrences for a recurring meeting.
 * Returns [start, end] Date pairs; index 0 is the series head (already known).
 */
export function computeOccurrences(
  startTime: Date,
  endTime: Date | null,
  recurrence: RecurrenceInput,
): Array<{ start: Date; end: Date | null }> {
  const durationMs = endTime ? endTime.getTime() - startTime.getTime() : 60 * 60000;

  const interval = Math.max(1, Math.min(365, Math.floor(recurrence.interval || 1)));
  const count = Math.max(1, Math.min(MAX_OCCURRENCES, Math.floor(recurrence.count || MAX_OCCURRENCES)));
  const hardEnd = recurrence.endDate ? new Date(recurrence.endDate) : null;
  const horizon = startTime.getTime() + MAX_SERIES_HORIZON_MS;

  const occurrences: Array<{ start: Date; end: Date | null }> = [];
  const pushOccurrence = (d: Date) => {
    if (hardEnd && d.getTime() > hardEnd.getTime()) return false;
    if (d.getTime() > horizon) return false;
    occurrences.push({ start: new Date(d), end: new Date(d.getTime() + durationMs) });
    return occurrences.length < count;
  };

  switch (recurrence.frequency) {
    case "DAILY": {
      let cursor = new Date(startTime);
      for (let i = 1; i < count; i++) {
        cursor = new Date(cursor.getTime() + interval * 24 * 60 * 60 * 1000);
        if (!pushOccurrence(cursor)) break;
      }
      break;
    }
    case "WEEKLY":
    case "CUSTOM": {
      // CUSTOM with customDays = "Weekly on these weekdays"; otherwise plain
      // every-N-weeks on the original weekday.
      const weekdays =
        recurrence.frequency === "CUSTOM" && Array.isArray(recurrence.customDays) && recurrence.customDays.length > 0
          ? Array.from(new Set(recurrence.customDays.map((d) => ((d % 7) + 7) % 7))).sort((a, b) => a - b)
          : [startTime.getUTCDay()];

      // Build a rolling list: for each week (interval weeks apart), fire on
      // each selected weekday at the original time-of-day, after the previous
      // occurrence.
      let weekAnchor = new Date(startTime);
      let guard = 0;
      while (occurrences.length < count && guard < MAX_OCCURRENCES * 8) {
        guard++;
        for (const wd of weekdays) {
          if (occurrences.length >= count) break;
          const candidate = new Date(weekAnchor);
          const delta = (wd - weekAnchor.getUTCDay() + 7) % 7;
          candidate.setUTCDate(candidate.getUTCDate() + delta);
          if (candidate.getTime() <= startTime.getTime()) continue;
          if (hardEnd && candidate.getTime() > hardEnd.getTime()) continue;
          if (candidate.getTime() > horizon) continue;
          occurrences.push({ start: new Date(candidate), end: new Date(candidate.getTime() + durationMs) });
        }
        weekAnchor = new Date(weekAnchor.getTime() + interval * 7 * 24 * 60 * 60 * 1000);
      }
      break;
    }
    case "MONTHLY": {
      let cursor = new Date(startTime);
      for (let i = 1; i < count; i++) {
        const next = new Date(cursor);
        next.setUTCMonth(next.getUTCMonth() + interval);
        // Clamp month-end overflows (Jan 31 -> Feb 28) to the last valid day.
        if (next.getUTCDate() !== cursor.getUTCDate()) {
          next.setUTCDate(0); // last day of previous month
        }
        cursor = next;
        if (!pushOccurrence(cursor)) break;
      }
      break;
    }
    case "YEARLY": {
      let cursor = new Date(startTime);
      for (let i = 1; i < count; i++) {
        const next = new Date(cursor);
        next.setUTCFullYear(next.getUTCFullYear() + interval);
        // Feb 29 -> Feb 28 on non-leap years
        if (next.getUTCDate() !== cursor.getUTCDate()) {
          next.setUTCDate(0);
        }
        cursor = next;
        if (!pushOccurrence(cursor)) break;
      }
      break;
    }
    default:
      break;
  }

  return occurrences;
}

export function isRecurrenceInput(value: any): value is RecurrenceInput {
  return (
    !!value &&
    typeof value === "object" &&
    ["DAILY", "WEEKLY", "MONTHLY", "YEARLY", "CUSTOM"].includes(value.frequency)
  );
}

/**
 * Insert reminder rows (60 + 15 minutes before) for one meeting occurrence.
 * Skips offsets already in the past. Best-effort, never throws.
 */
export async function scheduleMeetingReminders(meetingId: string, startTime: Date): Promise<void> {
  try {
    for (const minutes of REMINDER_OFFSETS_MIN) {
      const remindAt = new Date(startTime.getTime() - minutes * 60000);
      if (remindAt.getTime() <= Date.now()) continue;
      await query(
        `INSERT INTO meeting_reminders (meeting_id, minutes, remind_at, sent)
         VALUES ($1, $2, $3, FALSE)
         ON CONFLICT DO NOTHING`,
        [meetingId, minutes, remindAt.toISOString()],
      );
    }
  } catch (err: any) {
    console.error("[meetingReminders] schedule error:", err?.message || err);
  }
}

function humanizeFrequency(recurrence: RecurrenceInput): string {
  switch (recurrence.frequency) {
    case "DAILY": return (recurrence.interval || 1) > 1 ? `Every ${recurrence.interval} days` : "Daily";
    case "WEEKLY": return (recurrence.interval || 1) > 1 ? `Every ${recurrence.interval} weeks` : "Weekly";
    case "MONTHLY": return (recurrence.interval || 1) > 1 ? `Every ${recurrence.interval} months` : "Monthly";
    case "YEARLY": return (recurrence.interval || 1) > 1 ? `Every ${recurrence.interval} years` : "Yearly";
    case "CUSTOM": return "Custom schedule";
    default: return "Recurring";
  }
}

/**
 * Cron body — claims due reminders (sent=FALSE, remind_at<=NOW()) and delivers
 * push + email to team attendees and guest emails. Idempotent via an atomic
 * UPDATE ... RETURNING claim so overlapping cron ticks never double-send.
 */
export async function processDueMeetingReminders(): Promise<{ processed: number }> {
  const claimed = await query(
    `UPDATE meeting_reminders mr
     SET sent = TRUE, sent_at = NOW()
     FROM meetings m
     WHERE mr.meeting_id = m.id
       AND mr.sent = FALSE
       AND mr.remind_at IS NOT NULL
       AND mr.remind_at <= NOW()
       AND m.status = 'scheduled'
     RETURNING mr.id, mr.meeting_id, mr.minutes, m.title, m.description,
               m.start_time as "startTime", m.end_time as "endTime", m.timezone,
               m.meeting_code as "meetingCode", m.business_id as "businessId"`,
  );

  if (claimed.rows.length === 0) return { processed: 0 };

  for (const reminder of claimed.rows) {
    try {
      const minutes = reminder.minutes || 15;
      const whenLabel = minutes >= 60 ? `${Math.round(minutes / 60)} hour${minutes >= 120 ? "s" : ""}` : `${minutes} minutes`;

      const attendeesRes = await query(
        `SELECT ma.user_id as "userId", u.email, u.name
         FROM meeting_attendees ma
         LEFT JOIN users u ON u.id = ma.user_id
         WHERE ma.meeting_id = $1`,
        [reminder.meeting_id],
      );
      const guestsRes = await query(
        `SELECT email, name FROM meeting_guests WHERE meeting_id = $1`,
        [reminder.meeting_id],
      );

      const recurrenceRes = await query(`SELECT recurrence_rule FROM meetings WHERE id = $1`, [reminder.meeting_id]);
      let recurrenceNote = "";
      try {
        const rule = recurrenceRes.rows[0]?.recurrence_rule ? JSON.parse(recurrenceRes.rows[0].recurrence_rule) : null;
        if (rule?.frequency) recurrenceNote = `Repeats: ${humanizeFrequency(rule)}`;
      } catch { /* ignore malformed rule */ }

      const startLabel = new Date(reminder.startTime).toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      const link = `${process.env.CLIENT_URL || process.env.APP_BASE_URL || process.env.APP_URL || "https://metricorex.com"}/meetings/${reminder.meetingCode}`;

      // Push + in-app notification for team members
      const targets = attendeesRes.rows
        .filter((r: any) => r.userId)
        .map((r: any) => ({ userId: r.userId, businessId: reminder.businessId }));
      if (targets.length > 0) {
        await sendPushToUsers(
          targets,
          {
            title: `Starting soon: ${reminder.title}`,
            body: `${reminder.title} starts in ${whenLabel} (${startLabel}).`,
            data: {
              type: "meeting-reminder",
              meetingId: String(reminder.meeting_id),
              meetingCode: String(reminder.meetingCode || ""),
            },
            androidChannelId: "general",
          },
          { inApp: true, type: "meeting-reminder", businessId: reminder.businessId },
        );
      }

      // Email for team attendees with an email + guests
      const recipients = [
        ...attendeesRes.rows.filter((r: any) => r.email).map((r: any) => ({ email: r.email, name: r.name || "There" })),
        ...guestsRes.rows.map((g: any) => ({ email: g.email, name: g.name || "There" })),
      ];
      for (const recipient of recipients) {
        await sendEmail(
          recipient.email,
          recipient.name,
          `Reminder: ${reminder.title} starts in ${whenLabel}`,
          generateMeetingReminderEmailHtml({
            name: recipient.name,
            title: reminder.title,
            description: reminder.description,
            startTime: new Date(reminder.startTime),
            endTime: reminder.endTime ? new Date(reminder.endTime) : null,
            timezone: reminder.timezone || "UTC",
            minutes,
            meetingCode: reminder.meetingCode,
            link,
            recurrenceNote,
          }),
        ).catch((err: any) => console.error("[meetingReminders] email error:", err?.message || err));
      }
    } catch (err: any) {
      console.error("[meetingReminders] processing error:", err?.message || err);
    }
  }

  return { processed: claimed.rows.length };
}
