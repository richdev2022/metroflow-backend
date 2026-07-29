# Frontend Integration Guide: Call & Meeting Duration Enforcement (Plan-Based Limits)

## 1. Overview

Call and meeting durations are enforced automatically based on the **pricing plan** the user's business is subscribed to.

### Key Rules

- **Plan field used:** `pricing_plans.max_meeting_duration` (in minutes). Configurable by admin.
- **Duration countdown does NOT start immediately.** The timer only starts counting when **2 or more participants** have successfully joined the room (via `call:join` / `meeting:join` socket events).
- **Once started, the countdown cannot be paused**, even if participants drop back to 1.
- **Backend auto-closes** the call/meeting when `endsAt` is reached. Frontend must also handle cleanup when it receives the ended event.
- **Warnings are broadcast** at 5 minutes remaining and 1 minute remaining so the frontend can show alerts.

`null` or missing `maxMeetingDuration` means **unlimited duration** (typically Enterprise/Unlimited plans).

---

## 2. Plan Limits Inherited Automatically by Backend

The backend applies these limits and returns them in API responses:

| Route | Field returned | Type | Description |
|---|---|---|---|
| `POST /calls` | `data.maxMeetingDuration` | `number \| null` | Minutes allowed per call (plan limit) |
| `POST /calls/:id/join` | `data.maxMeetingDuration` | `number \| null` | Plan limit |
| `POST /meetings` | `data.maxMeetingDuration` | `number \| null` | Plan limit |
| Socket participants-list event | `maxMeetingDuration` | `number \| null` | Plan limit (consistent source for frontend) |

The backend also:

1. **Caps scheduled meeting `endTime`** to the plan's duration limit on creation (for non-instant meetings).
2. **Caps `maxParticipants`** on calls and meetings to the plan-level `maxParticipants` limit.
3. **Rejects call creation** if initial invited participant count exceeds plan `maxParticipants`.

---

## 3. Socket Event Flow (CRITICAL - Read Carefully)

### 3.1 Emitted by Frontend

#### For Calls

```typescript
socket.emit('call:join', {
  roomId: string,          // call UUID (NOT the call code)
  userId: string,          // user UUID
  userName: string,        // display name
  isHost: boolean,
  audioEnabled: boolean,
  videoEnabled: boolean,
});
```

```typescript
socket.emit('call:leave', {
  roomId: string,
  userId: string,
  userName: string,
});
```

```typescript
socket.emit('call:end', { callId: string });
```

#### For Meetings

```typescript
socket.emit('meeting:join', {
  meetingId: string,       // meeting UUID (NOT the meeting code)
  userId: string,
  userName?: string,
  isHost?: boolean,
  audioEnabled?: boolean,
  videoEnabled?: boolean,
});
```

```typescript
socket.emit('meeting:leave', {
  meetingId: string,
  userId: string,
  userName?: string,
});
```

```typescript
socket.emit('meeting:end', { meetingId: string });
```

---

### 3.2 Events Listened by Frontend — Lifecycle + Duration

#### CALLS

| Event | Payload Type | When Triggered | Frontend Action |
|---|---|---|---|
| `call:participants-list` | `{ participants, endsAt: ISO\|null, maxMeetingDuration: number\|null }` | Immediately after frontend emits `call:join` | Initialize participant list. If `endsAt` is present, countdown may already be running. If `endsAt` is null and `maxMeetingDuration` is set → waiting for 2nd participant. |
| `call:waiting-for-participants` | `{ message: string, maxMeetingDuration: number\|null }` | Participant count ≤ 1 after joining | Show a banner: "Waiting for more participants. Timer will start when 2+ people join." |
| `call:duration-started` | `{ endsAt: ISO, maxMeetingDuration: number\|null, startedAt: ISO }` | Participant count just transitioned from 1 → 2. Timer BEGINS NOW. | **This is the primary trigger to start the UI countdown.** Set timer state = `new Date(endsAt)`. |
| `call:duration-active` | `{ endsAt: ISO, maxMeetingDuration: number\|null, remainingMs: number }` | Frontend joins late (after countdown already started) | Start UI countdown using `endsAt` or `remainingMs`. |
| `call:countdown-warning` | `{ callId, remainingMs, remainingMinutes: 5\|1, message }` | Exactly once at 5-min mark, once at 1-min mark | Show toast/banner/modal warning. Pulse the countdown UI in red. |
| `call:ended` | `{ callId, reason: 'duration_limit' \| 'ended_by_host' \| string }` | Auto-close by backend OR host ended | **Tear everything down:** stop tracks, close transports, navigate away, show "Call Ended" screen. |
| `call:participant-joined` | `{ userId, userName, isHost }` | Another participant joins | Update participant UI. After this, the count may be >1 so `call:duration-started` will fire separately. |
| `call:participant-left` | `{ userId, userName }` | Another participant leaves | Update participant list UI. |

#### MEETINGS

Identical pattern as calls, with the `meeting:` prefix:

| Event |
|---|
| `meeting:participants-list` |
| `meeting:waiting-for-participants` |
| `meeting:duration-started` |
| `meeting:duration-active` |
| `meeting:countdown-warning` |
| `meeting:ended` |
| `meeting:participant-joined` |
| `meeting:participant-left` |

Payload shapes are the same, with the addition of `meetingId` instead of `callId` where appropriate.

---

## 4. State Machine for Duration UI

```
┌─────────────────────────────────────────────────────────────────────┐
│ State: PRE-WAITING (just joined, evaluating)                         │
│   └─ Received call:participants-list → check endsAt vs maxMeetingDuration │
└──────────────────────────────────────────────┬──────────────────────┘
                                               │
             ┌─────────────────────────────────┴───────────────────────┐
             │                                                         │
             ▼                                                         ▼
  endsAt != null (late join)                              endsAt == null
  └─ State: COUNTING ACTIVE                               └─ State: WAITING FOR PARTICIPANTS
     start countdown from endsAt                              Show banner "Waiting…"
     bind call:countdown-warning                              Listen for call:duration-started
     bind call:ended
                                                             (countdown may start later via duration-started)
```

**Transitions to COUNTING ACTIVE from either:**
1. `call:duration-started` → **primary** when count goes to 2+
2. `call:duration-active` → if you joined after the countdown already started
3. `call:participants-list.endsAt != null` → fallback

---

## 5. Frontend Countdown Implementation (Reference TypeScript)

### 5.1 Types

```typescript
type DurationState =
  | { status: 'idle' }
  | { status: 'waiting'; maxMeetingDurationMinutes: number | null }
  | { status: 'running'; endsAt: Date; maxMeetingDurationMinutes: number | null };

interface CountdownDisplay {
  totalMs: number;
  hours: number;
  minutes: number;
  seconds: number;
  percentUsed: number; // 0..1
}
```

### 5.2 Hook Implementation

```typescript
import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

export function useCallDuration(socket: Socket, roomId: string | undefined, mode: 'call' | 'meeting') {
  const [state, setState] = useState<DurationState>({ status: 'idle' });
  const [now, setNow] = useState<number>(Date.now());
  const warned5Ref = useRef(false);
  const warned1Ref = useRef(false);
  const prefix = mode; // 'call' or 'meeting'

  // Tick every second for countdown
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!socket || !roomId) return;
    warned5Ref.current = false;
    warned1Ref.current = false;

    // --- Reset ---
    setState({ status: 'idle' });

    // 1) participants-list — first authoritative state
    socket.on(`${prefix}:participants-list`, (data: any) => {
      if (data.endsAt) {
        setState({
          status: 'running',
          endsAt: new Date(data.endsAt),
          maxMeetingDurationMinutes: data.maxMeetingDuration ?? null,
        });
      } else {
        setState({
          status: 'waiting',
          maxMeetingDurationMinutes: data.maxMeetingDuration ?? null,
        });
      }
    });

    // 2) waiting — explicit banner state
    socket.on(`${prefix}:waiting-for-participants`, () => {
      setState(s => s.status === 'running' ? s : {
        status: 'waiting',
        maxMeetingDurationMinutes: s.status === 'waiting' ? s.maxMeetingDurationMinutes : null,
      });
    });

    // 3) duration-started — countdown BEGIN
    socket.on(`${prefix}:duration-started`, (data: any) => {
      warned5Ref.current = false;
      warned1Ref.current = false;
      setState({
        status: 'running',
        endsAt: new Date(data.endsAt),
        maxMeetingDurationMinutes: data.maxMeetingDuration ?? null,
      });
    });

    // 4) duration-active — late join
    socket.on(`${prefix}:duration-active`, (data: any) => {
      setState({
        status: 'running',
        endsAt: new Date(data.endsAt),
        maxMeetingDurationMinutes: data.maxMeetingDuration ?? null,
      });
    });

    // cleanup
    return () => {
      socket.off(`${prefix}:participants-list`);
      socket.off(`${prefix}:waiting-for-participants`);
      socket.off(`${prefix}:duration-started`);
      socket.off(`${prefix}:duration-active`);
    };
  }, [socket, roomId, prefix]);

  // Derived countdown display
  const display: CountdownDisplay | null = useMemo(() => {
    if (state.status !== 'running') return null;
    const totalMs = Math.max(0, state.endsAt.getTime() - now);
    const totalSec = Math.floor(totalMs / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    let percentUsed = 0;
    if (state.maxMeetingDurationMinutes) {
      const totalAllowedMs = state.maxMeetingDurationMinutes * 60 * 1000;
      const elapsedMs = totalAllowedMs - totalMs;
      percentUsed = Math.min(1, Math.max(0, elapsedMs / totalAllowedMs));
    }
    return { totalMs, hours, minutes, seconds, percentUsed };
  }, [state, now]);

  return { state, display };
}
```

### 5.3 UI Rendering Snippet

```tsx
function CountdownBadge({ display, state }: any) {
  if (state.status === 'waiting') {
    return <span className="badge badge-waiting">⏳ Waiting for participants…</span>;
  }
  if (state.status !== 'running' || !display) return null;

  const isUrgent = display.totalMs <= 60_000;
  const isWarning = display.totalMs <= 5 * 60_000;
  const hh = display.hours.toString().padStart(2, '0');
  const mm = display.minutes.toString().padStart(2, '0');
  const ss = display.seconds.toString().padStart(2, '0');

  return (
    <span
      className={[
        'countdown-badge',
        isUrgent && 'countdown-urgent',
        isWarning && !isUrgent && 'countdown-warning',
      ].filter(Boolean).join(' ')}
    >
      {display.hours > 0 ? `${hh}:` : ''}{mm}:{ss}
    </span>
  );
}
```

---

## 6. Auto-Close Handling (`call:ended` / `meeting:ended`)

The backend will automatically update the call/meeting status to `completed` in the DB and emit the ended event. The frontend MUST perform cleanup when receiving the ended event regardless of reason.

### 6.1 Cleanup Checklist

When receiving `call:ended` or `meeting:ended`:

1. Stop all local MediaStream tracks (audio + video):
   ```typescript
   stream.getTracks().forEach(t => { t.stop(); });
   ```
2. Close all mediasoup transports (`transport.close()`), producers, consumers.
3. Clear all countdown intervals and warning state.
4. Leave the socket room (optional — server handles it, but defensive).
5. Display end screen with reason:
   - `duration_limit` → "Call ended: Maximum plan duration reached."
   - `ended_by_host` → "Call ended by host."
6. Navigate back to dashboard / call history after ~3–5 seconds (or on user click).

### 6.2 Defensive Fallback

Even if the socket event is missed (network glitch), once the local countdown display reaches 0 (`display.totalMs <= 0`), frontend should trigger its own teardown sequence. **Always treat the socket `:ended` event as authoritative, but use the timer as a safety net.**

---

## 7. Countdown Warning UI

When `call:countdown-warning` fires with:

- `remainingMinutes: 5` → show a non-intrusive toast + pulse the countdown badge yellow.
- `remainingMinutes: 1` → show a modal or sticky red banner requiring no user action. Optionally play a short audible beep.

Suggested toast content:

```
5 minutes remaining
This call will end automatically when the time limit is reached.
```

```
⚠ 1 minute remaining
Please wrap up — this call will end shortly.
```

---

## 8. Call / Meeting Initialization Checklist for Frontend

Before showing the in-call UI, the frontend should:

| Step | Action |
|---|---|
| 1 | Authenticate the socket and ensure socket is connected. |
| 2 | Call `POST /calls` (or `/meetings`). Capture the returned `id` (UUID) **and** `maxMeetingDuration`. |
| 3 | Initialize mediasoup client on frontend. |
| 4 | **Emit `call:join` / `meeting:join`** with the UUID from step 2. **This must happen before any media production so that participant-based duration triggering is reliable.** |
| 5 | Listen for all duration events (§3.2) BEFORE joining so you don't miss the initial `participants-list` ack. |
| 6 | When leaving the call page, always emit `call:leave` / `meeting:leave`. |

> **IMPORTANT:** Use the call/meeting **UUID** for socket events, NOT the short code. The backend uses `room:${uuid}` internally for room-based broadcasts. Do NOT rely on using `callCode` or `meetingCode` as the `roomId`.

---

## 9. Edge Cases

### 9.1 Participant count drops back to 1 after countdown started

**Per backend behavior:** Countdown keeps running. It does NOT pause. Rationale: avoid abuse (people toggling joins/leaves to prolong meetings). The UI should keep counting down.

### 9.2 `maxMeetingDuration` is `null`

The plan is unlimited. Hide the countdown UI entirely, and do not listen for warnings (the backend will not emit any).

### 9.3 Network reconnect during a call

On reconnect:
- Re-emit `call:join` / `meeting:join`.
- The backend will respond with `call:participants-list` (which has `endsAt` if already running) followed by `call:duration-active`.
- The hook in §5.2 handles this correctly via effect re-run on socket change.

### 9.4 Host scheduled a 2-hr meeting but plan only allows 60 min

Backend silently caps the DB `end_time` at `start + maxMeetingDuration`. API response will reflect the capped value. Frontend should trust the `endTime` returned in the `POST /meetings` response and NOT the value the user typed into the scheduler.

### 9.5 What happens when the duration hits 0 exactly while frontend is waiting for event?

The backend checks every 10 seconds. Worst case is the call appears "alive" for up to ~10 extra seconds. Frontend timer at 0 should block new media operations and show "Ending call…" spinner until `call:ended` is received.

---

## 10. Quick Reference: Event Map

```
USER CREATES CALL
  │
  ├─ POST /calls → returns { id: UUID, maxMeetingDuration, endedAt: null, ... }
  │
  │  HOST joins via socket:
  │    emit call:join(roomId: UUID)
  │    ← call:participants-list { endsAt: null, ... }
  │    ← call:waiting-for-participants { ... }
  │
  │  2ND USER joins:
  │    emit call:join(roomId: UUID)
  │    → BACKEND sets endedAt = now + maxMeetingDuration * 60s (persists to DB)
  │    ← ALL sockets receive:  call:duration-started { endsAt, ... }
  │    ← NEW socket also gets: call:participants-list { endsAt, ... }
  │
  │  COUNTDOWN RUNS
  │    ← call:countdown-warning (5min)
  │    ← call:countdown-warning (1min)
  │
  │  TIME'S UP (within 10s cron tick)
  │    BACKEND sets status = completed
  │    ← call:ended { callId, reason: 'duration_limit' }
  │
  └─ Frontend tears down media & navigates away
```

---

## 11. Fields Summary — API & Socket Payloads

### `POST /api/calls` Response `data`

```typescript
{
  id: string;                     // UUID — use this for socket roomId
  callCode: string;               // short code, for humans / URL display
  type: 'audio' | 'video';
  status: 'ongoing';
  startedAt: ISO;                 // when created (NOT when countdown began)
  endedAt: ISO | null;            // null until participants ≥ 2
  maxMeetingDuration: number | null;  // plan limit (minutes)
  maxParticipants: number | null;
  isGroupCall: boolean;
  waitingRoomEnabled: boolean;
  recordingEnabled: boolean;
  participants: Array<{ userId, status: 'joined' | 'invited', joinedAt, leftAt }>;
  // ... other fields
}
```

### `POST /api/meetings` Response `data`

```typescript
{
  id: string;                     // UUID — use this for socket meetingId
  meetingCode: string;
  title: string;
  isInstant: boolean;
  startTime: ISO;
  endTime: ISO | null;            // null for instant meetings until participants ≥ 2
  maxMeetingDuration: number | null; // plan limit (minutes)
  maxParticipants: number | null;
  // ... other fields
}
```

### Socket `call:participants-list`

```typescript
{
  participants: Array<{
    id: string;       // userId
    name: string;
    isHost: boolean;
    audioEnabled: boolean;
    videoEnabled: boolean;
    screenSharing: boolean;
    joinedAt: ISO;
  }>;
  endsAt: ISO | null;
  maxMeetingDuration: number | null;
}
```

### Socket `call:duration-started`

```typescript
{
  endsAt: ISO;
  maxMeetingDuration: number | null;
  startedAt: ISO;     // when countdown officially began (now)
}
```

### Socket `call:countdown-warning`

```typescript
{
  callId: string;
  remainingMs: number;
  remainingMinutes: 5 | 1;
  message: string;    // ready-to-display string
}
```

### Socket `call:ended`

```typescript
{
  callId: string;
  reason: 'duration_limit' | 'ended_by_host' | string;
}
```

(Meeting variants use the same shapes with `meetingId` instead of `callId`.)

---

## 12. Backend Files Changed (for reference)

| File | What changed |
|---|---|
| `server/routes/calls.ts:203-262` | Fetch plan limits, set `endedAt = null` at creation, enforce `maxParticipants`, attach `maxMeetingDuration` to response. |
| `server/routes/calls.ts:669-678` | `joinCall` endpoint now attaches `maxMeetingDuration` from plan. |
| `server/routes/meetings.ts:229-304` | Fetch plan limits, cap `endTime` for scheduled meetings, set instant meetings to `endTime = null` (deferred to 2nd participant), enforce `maxParticipants`. |
| `server/routes/meetings.ts:371-372` | Attach `maxMeetingDuration` to meeting create response. |
| `server/lib/socket.ts:13-148` | `endRoom` now emits typed ended events + reason; 10-s cron now emits 5-min and 1-min warnings before expiration. |
| `server/lib/socket.ts:124-229` | `call:join` now defers `endsAt` calculation until participant count > 1, emits `duration-started`, `duration-active`, `waiting-for-participants`. |
| `server/lib/socket.ts:365-510` | `meeting:join/leave/end` now fully integrated with `roomManager` and duration system (mirrors call flow). |
| `server/lib/roomManager.ts:69-74` | Added `setRoomEndsAt()` helper used by socket handlers. |

Use this guide as the source of truth for duration integration on the frontend.
