# MetroFlow Backend API — Full Integration Specification
## Meetings, Video/Audio Calling, In-App Chat & Call Rooms

> **Version:** 1.0.0  
> **Last Updated:** 2026-07-29  
> **Audience:** Frontend Engineering Teams  
> **Backend Source:** `server/routes/meetings.ts`, `server/routes/calls.ts`, `server/routes/chat.ts`, `server/lib/socket.ts`, `server/routes/recordings.ts`

---

## Table of Contents

1. [Introduction & Prerequisites](#1-introduction--prerequisites)
2. [Common Error Handling](#2-common-error-handling-standardization)
3. [Meetings Feature](#3-meetings-feature)
4. [Video/Audio Calling Feature](#4-videoaudio-calling-feature)
5. [In-App Chat Feature](#5-in-app-chat-feature)
6. [Call Rooms (WebSocket / Mediasoup RTC)](#6-call-rooms-websocket--mediasoup-rtc)
7. [Recordings API](#7-recordings-api)
8. [Notifications API](#8-notifications-api)
9. [Integration Testing Guidelines](#9-integration-testing-guidelines)
10. [Change Log & Versioning](#10-change-log--versioning)

---

## 1. Introduction & Prerequisites

### 1.1 Authentication

All feature endpoints (Meetings, Calls, Chat, Recordings) require a valid bearer token obtained via the authentication flow. Admin sessions use a parallel pattern via `admin_sessions`.

#### 1.1.1 Token Acquisition Flow

| Step | Method | Endpoint | Description |
|------|--------|----------|-------------|
| 1 | `POST` | `/auth/register` | Register business + admin user. Returns `businessId` + OTP requirement. |
| 2 | `POST` | `/auth/verify-otp` | Verify registration OTP. |
| 3 | `POST` | `/auth/login` | Login with email + password. Returns `token` (bearer token) if OTP not required. |
| 4 | `POST` | `/auth/verify-otp` | (If login requires OTP) Verify login OTP → receive final `token`. |

**Token Header Format:**
```
Authorization: Bearer <64-char-hex-token>
```

#### 1.1.2 Token Properties (from `server/services/auth.ts:28-92`)

| Property | Value | Notes |
|----------|-------|-------|
| Format | 32 random bytes → 64-char hex | Stored in `user_sessions.token` |
| Idle Timeout | Configurable via `TOKEN_IDLE_TIMEOUT_MINUTES` env var, **default 30 minutes** | Every API call refreshes `last_activity_at` |
| Expiry Strategy | Sliding-window idle timeout. If `last_activity_at < NOW - idle_window`, session is deleted. | No absolute session expiration — only idle. |
| Scope | `user_sessions.user_id` + `user_sessions.business_id` | Each token is user+business scoped. |
| Injected into Request | `req.user.userId` (UUID), `req.user.businessId` (UUID) | See `AuthenticatedRequest` interface in `server/middleware/auth.ts:5-12` |

#### 1.1.3 Frontend Token Expiration Protocol

The token middleware returns **403** with body `{ success: false, error: "Invalid or expired token" }` when a session expires due to idle timeout.

**Frontend must:**
1. Intercept all 401/403 responses containing `error === "Access token required"` or `"Invalid or expired token"`.
2. Immediately clear local session storage.
3. Redirect to `/login` with a `?reason=timeout` query param.
4. Show a modal: *"Your session has expired due to inactivity. Please log in again."*

Reference: `TOKEN_EXPIRATION_GUIDE.md` in the repo root.

#### 1.1.4 Feature Permissions Gates (Middleware)

Every endpoint under `/meetings`, `/calls`, `/chat`, `/recordings` passes through:

| Middleware | What it checks | Error (403) Message |
|------------|---------------|---------------------|
| `authenticateToken` | Valid bearer token in `user_sessions` | Invalid or expired token |
| `checkSubscriptionStatus` | Business subscription is `active` AND (paid plan OR free trial not yet expired) | Your subscription has expired. Please upgrade your plan to continue accessing these features. |
| `checkFeaturePermission(featureId)` | `pricing_plans.permissions` (or `features`) contains the permission ID, or `*`/`all` | Kindly upgrade your plan to enjoy this feature. |

**Permission IDs used by each feature:**

| Feature | Permission ID |
|---------|---------------|
| Meetings | `use_meetings` |
| Calls (Audio/Video) | `use_chat` |
| In-App Chat | `use_chat` |
| Recordings | `rtc.recording` |

### 1.2 Environment Base URLs

All API routes are mounted **both** at `/` and at `/api/` for backward compatibility (`server/index.ts:618-621`). Use whichever is consistent with your client.

| Environment | Base REST URL | WebSocket (Socket.io) URL |
|-------------|---------------|----------------------------|
| **Local Development** | `http://localhost:8080` or `http://localhost:3000` (per `.env`) | `http://localhost:8080` (same origin) |
| **Sandbox / Staging** | `https://metricorex-backend.netlify.app/.netlify/functions/api` | `https://metricorex-backend.netlify.app` |
| **Production** | `https://api.metricorex.com/.netlify/functions/api` OR `https://api.metricorex.com` (if proxied) | `wss://api.metricorex.com` |

**Netlify note:** When deployed as a Netlify Function, REST paths are accessed via `/.netlify/functions/api/` prefix. WebSocket connections may require a separate long-running deployment since serverless functions cannot hold socket state. Use `server/lib/cache.ts` (Redis) + `@socket.io/redis-adapter` for cross-instance room synchronization.

### 1.3 Rate Limiting (`server/middleware/security.ts:1-44`)

| Policy | Value |
|--------|-------|
| Window | 15 minutes (sliding per-IP + per-path) |
| Max Requests | 100 per window per `{path, ip}` |
| Limit Response | **429** `{ success: false, error: "Too many requests. Please try again later." }` |
| Headers Returned | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (UNIX seconds) |

**Frontend action on 429:**
- Back off with exponential + jitter.
- Inspect `X-RateLimit-Reset` for exact retry time.
- Do NOT auto-retry POST /meetings, POST /calls, or POST /messages (risk of duplicate creation).

### 1.4 CORS Configuration (`server/cors.ts:1-83`)

| Setting | Value |
|---------|-------|
| Allowed Origins (Default) | `metricorex-app.netlify.app`, `localhost:3000`, `localhost:5173`, `*.metricorex.com` (api, app, admin, compliance, files) |
| Configurable via | `CORS_ORIGINS` env var (comma-separated) |
| Allowed Methods | `GET, POST, PUT, DELETE, OPTIONS, PATCH` |
| Allowed Headers | `Content-Type, Authorization, X-Requested-With, x-business-id, x-team-id, x-job-secret` |
| Credentials | `Access-Control-Allow-Credentials: true` |
| Exposed Headers | `Content-Disposition, Content-Length` |
| Preflight | `OPTIONS` returns **204** (`optionsSuccessStatus: 204`) |

**Frontend check:** `fetch()` / axios must be configured with `withCredentials: true` / `credentials: 'include'` if relying on cookies (the current implementation uses `Authorization` header bearer tokens, so credentials config is optional — but keep it enabled for future compatibility).

### 1.5 Core Terminology

| Term | Definition |
|------|------------|
| **Business** | A tenant organization. All meetings/calls/chat are scoped to a `business_id`. |
| **User** | Member of a business. Identified by UUID. Every authenticated request carries both `userId` and `businessId`. |
| **Meeting** | A scheduled or instant video collaboration session backed by the `meetings` table. Has `meetingCode` (6-char human slug like `OTBH0D`) and UUID `id`. |
| **Call** | An immediate (mostly 1:1 or small-group) audio/video session backed by the `calls` table. Has `callCode` (6-char slug) and UUID `id`. |
| **Call Room / Room** | A runtime WebSocket + mediasoup RTC container identified by the UUID of a *meeting OR call*. Rooms are not a separate DB entity; they are the union of meetings and calls through `resolveRoomId()`. |
| **Meeting Code / Call Code** | Human-readable short slug (6 uppercase chars) used in URLs. **Always resolve codes to UUIDs first** before DB lookups or socket joins. UUIDs are used internally in all socket rooms. |
| **Participant / Attendee** | User joined to a call (`call_participants`) or meeting (`meeting_attendees`). Status: `invited`, `joined`, `left`. |
| **Host** | User who created the meeting/call (or was appointed). Only hosts can end rooms, add participants after creation, and update settings. |
| **Co-Host** | Secondary user granted host permissions via `co_host_id` column. |
| **Instant Meeting/Call** | Created with `isInstant: true` (meetings) or always (calls are instant by default). `startTime` = now, `endTime` initially `null` until 2+ participants join. |
| **Duration / Countdown** | Plan-enforced session length. Timer **only starts when 2+ participants are present**, and runs even if count drops to 1. |
| **maxMeetingDuration** | Minutes allowed per session per pricing plan (`pricing_plans.max_meeting_duration`). `null` = unlimited. |
| **Conversation** | Chat channel, either `direct` (2 users, reused across sessions) or `group` (named, N users). |
| **Socket.io Room** | Runtime pub-sub channel: `user:${uuid}`, `business:${uuid}`, `room:${uuid}`, `meeting:${uuid}`, `call:${uuid}`, `conversation:${uuid}`. |
| **Recording** | Binary blob of a call/meeting session recording, uploaded separately via multipart endpoint and linked to `call_id` / `meeting_id`. |

---

## 2. Common Error Handling Standardization

### 2.1 Unified Response Envelope (`ApiResponse<T>` from `shared/api.ts:222-226`)

**Every REST endpoint** returns an envelope matching:

```typescript
interface ApiResponse<T> {
  success: boolean;        // true if operation succeeded
  data?: T;                // typed result when success=true
  error?: string;          // human-readable message when success=false
  message?: string;        // (sometimes used interchangeably) human message
}
```

**Rules:**
- **Never** check the raw HTTP status alone. Always read `success: boolean` from the body.
- `data` is present **only** when `success === true`.
- `error` (or occasionally `message`) is present **only** when `success === false`.

### 2.2 HTTP Status Code Mapping

| Code | Scenario | Typical `error` String |
|------|----------|-------------------------|
| **200** | OK — GET/PUT/PATCH success | — |
| **201** | OK — POST resource created | — |
| **204** | OPTIONS preflight success | — (no body) |
| **400** | Validation failure (missing fields, UUID not found in business, password missing on join) | `"User authentication required"` / `"All meeting attendees must belong to this business"` / `"participantIds must be a non-empty array"` |
| **401** | Missing `Authorization: Bearer` header | `"Access token required"` |
| **403** | Token invalid/expired; Subscription expired; Feature permission denied; Wrong password on join | `"Invalid or expired token"` / `"Your subscription has expired..."` / `"Kindly upgrade your plan..."` / `"Invalid password"` |
| **404** | Resource UUID/slug does not exist (or user lacks access) | `"{Meeting|Call|Conversation|Recording|Notification} not found"` |
| **429** | Rate limit exceeded | `"Too many requests. Please try again later."` |
| **500** | Unhandled exception | `"Failed to {verb} {noun}"` (handled) or bare `{ error: "Internal Server Error", message }` (global handler) |
| **503** | DB still initializing on serverless cold-start | `"Service Unavailable"` — `message: "Server is still initializing database connection..."` |

### 2.3 Recommended Frontend Error-Handling Strategy

```typescript
// Pseudocode axios/fetch interceptor
async function safeApiCall<T>(request: () => Promise<Response>): Promise<T> {
  try {
    const resp = await request();
    if (resp.status === 503) {
      // Retry with backoff (DB initializing). Max 3 retries, 2s / 4s / 8s.
      throw new RetryableError("Database cold-start");
    }
    const body = await resp.json() as ApiResponse<T>;
    if (body.success) return body.data as T;

    // Business errors
    if (body.error === "Invalid or expired token" || body.error === "Access token required") {
      triggerSessionExpiredFlow();
      throw new AuthError(body.error);
    }
    if (body.error === "Too many requests. Please try again later.") {
      const retryAfter = parseInt(resp.headers.get("X-RateLimit-Reset") || "0", 10);
      throw new RateLimitError(body.error, retryAfter);
    }
    if (body.error === "Kindly upgrade your plan to enjoy this feature.") {
      showUpgradePlanModal(body.error);
      throw new FeatureGateError(body.error);
    }
    throw new AppError(body.error || "Unknown error");
  } catch (networkErr) {
    if (networkErr instanceof TypeError && networkErr.message === "Failed to fetch") {
      // Offline
      queueForRetry();
    }
    throw networkErr;
  }
}
```

### 2.4 Socket Error Handling

Socket events sometimes invoke an **acknowledgement callback** (optional last argument). Always provide it for call/meeting joining:

```typescript
socket.emit(
  "call:join",
  payload,
  (ack: { success: boolean; error?: string; roomId?: string }) => {
    if (!ack.success) {
      // "Call or meeting not found" → code 404 equivalent
      // "Failed to join call" → code 500 equivalent
      showToast(ack.error || "Failed to join");
      router.back();
    } else {
      setRoomId(ack.roomId!);
    }
  }
);
```

**Socket events that support callbacks:**
- `invitation:verify`
- `call:join`
- `call:get-participants`
- `meeting:join`
- All `mediasoup:*` signaling events

---

## 3. Meetings Feature

### 3.1 REST Endpoints Summary

| # | Method | Path | Auth | Purpose | Handler |
|---|--------|------|------|---------|---------|
| M1 | `GET` | `/meetings?page=1&limit=10` | Bearer + `use_meetings` | Paginated list of meetings for user | `getMeetings` |
| M2 | `GET` | `/meetings/code/:code` | Bearer + `use_meetings` | Lookup meeting by 6-char code | `getMeetingByCode` |
| M3 | `POST` | `/meetings` | Bearer + `use_meetings` | Create scheduled or instant meeting | `createMeeting` |
| M4 | `PUT` | `/meetings/:id` (UUID or code) | Bearer + `use_meetings` + Host role | Update meeting details, status, attendees (full replace), password, co-host | `updateMeeting` |
| M5 | `DELETE` | `/meetings/:id` (UUID or code) | Bearer + `use_meetings` + Host role | Delete a meeting (and its reminders + attendees) | `deleteMeeting` |
| M6 | `POST` | `/meetings/:id/join` | Bearer + `use_meetings` | DB-level "mark me as joined"; validates password + marks attendee status. Does NOT start media — see socket. | `joinMeeting` |
| M7 | `POST` | `/meetings/:meetingId/participants` | Bearer + `use_meetings` + Host role | Add new participants to an existing meeting | `addMeetingParticipants` |

> **Note:** `:id` in PUT/DELETE resolves either as UUID OR meeting-code automatically (see `isValidUUID` helper in each handler).

### 3.2 Endpoint Details

---

#### M1 — `GET /meetings?page=1&limit=10`

**Query Params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | integer | `1` | 1-based page |
| `limit` | integer | `10` | Items per page |

**Response `data` (200):**

```typescript
{
  meetings: Array<{
    id: string;                        // UUID
    title: string;
    description: string | null;
    startTime: ISOString;
    endTime: ISOString | null;         // may be null for instant meetings until 2+ join
    timezone: string;                  // e.g. "UTC"
    createdById: string;               // UUID
    hostId: string;                    // UUID
    coHostId: string | null;
    status: "scheduled" | "ongoing" | "completed" | "cancelled";
    meetingCode: string;               // 6 chars, e.g. "OTBH0D"
    isInstant: boolean;
    password: string | null;           // NOTE: returned only to callers with host/cohost/created_by access. Strip or mask on frontend before displaying.
    maxParticipants: number | null;
    waitingRoomEnabled: boolean;
    recordingEnabled: boolean;
    screenSharingEnabled: boolean;
    googleEventId: string | null;
    createdAt: ISOString;
    updatedAt: ISOString;
    attendees: Array<{
      id: string;                      // meeting_attendee PK
      userId: string;                  // UUID of user
      status: "invited" | "joined" | "left";
    }>;
  }>;
  total: number;                       // total count across all pages
}
```

**Permission filter:** Meetings returned are limited to those where the current user is creator, host, co-host, or in `meeting_attendees`.

---

#### M2 — `GET /meetings/code/:code`

Lookup by short code. Useful for landing page URL route `/meetings/:code` → resolve before attempting join.

**Path:**

| Param | Type | Description |
|-------|------|-------------|
| `code` | string (6 chars) | Meeting code from URL |

**Response `data` (200):** Same meeting object shape as M1, single object (not array) with `.attendees`.

**404:** `{ success: false, error: "Meeting not found" }` if code not in user's business.

---

#### M3 — `POST /meetings`

Create a new meeting (scheduled or instant). Sends in-app notifications + email invitations to each attendee.

**Request Body:**

```typescript
{
  title: string;                           // REQUIRED
  description?: string | null;
  startTime: ISOString;                    // REQUIRED (even for instant: set to now() on frontend, or use isInstant flag below which overrides)
  endTime: ISOString;                      // REQUIRED for scheduled; may be silently capped by plan duration. Ignored for instant.
  timezone?: string;                       // default "UTC". IANA string expected.
  isInstant?: boolean;                     // default false. When true, startTime/endTime are ignored and set to now/null.
  attendeeIds?: string[];                  // UUIDs of other business users to invite. Creator auto-added as host.
  password?: string | null;                // meeting password (optional). If set, joinMeeting requires password.
  maxParticipants?: number | null;         // silently capped to plan's max_participants if larger.
  waitingRoomEnabled?: boolean;            // default false
  recordingEnabled?: boolean;              // default false
  screenSharingEnabled?: boolean;          // default true
}
```

**Validation Rules:**
1. All `attendeeIds` must belong to the creator's `business_id` → **400** `"All meeting attendees must belong to this business"`.
2. Duplicate attendee IDs are deduplicated.
3. Scheduled `endTime` is capped to `startTime + plan.max_meeting_duration` if set. Frontend must trust the `endTime` in the response, not the submitted value.
4. `maxParticipants` submitted value is capped to the plan's `max_participants`.

**Response `data` (201):** Same shape as single-meeting response, **plus** injected field:

```typescript
{
  ...Meeting,
  maxMeetingDuration: number | null;     // PRICING PLAN limit (minutes). `null` = unlimited. Use this value for the countdown UI.
  attendees: Attendee[];                 // newly inserted rows
}
```

**Side effects:**
- In-app notification: type=`meeting`, title=`"Meeting Invitation"`, actionUrl=`/meetings/${code}`, expires 24h.
- Email: `generateMeetingInvitationEmailHtml` sent to every attendee with `email`.
- Socket broadcast: `meeting:created` event sent to each attendee's `user:${userId}` room.
- Activity log: action="create", actionType="meeting".

---

#### M4 — `PUT /meetings/:id`

**Who can call:** Only `created_by`, `host_id`, or `co_host_id` of the meeting. Others get 404.

**Request Body (all fields optional):**

```typescript
{
  title?: string;
  description?: string | null;
  startTime?: ISOString;
  endTime?: ISOString;
  timezone?: string;
  status?: "scheduled" | "cancelled" | "completed" | "ongoing";
  attendeeIds?: string[];                // ⚠️ FULL REPLACE. Existing attendees not in this list will be DELETED.
  password?: string | null;
  maxParticipants?: number | null;
  waitingRoomEnabled?: boolean;
  recordingEnabled?: boolean;
  screenSharingEnabled?: boolean;
  coHostId?: string | null;              // must be valid business user
}
```

**Validation:**
- `attendeeIds` set → deletes all current rows, re-inserts. If `attendeeIds` is **not supplied**, existing attendees untouched.
- `coHostId` (if set + not null) must belong to the same business.

**Response `data` (200):** Updated meeting with refreshed attendees.

**Side effects:** Socket broadcast `meeting:updated` to `business:${businessId}`.

---

#### M5 — `DELETE /meetings/:id`

**Who can call:** Host / Co-Host / Creator.

**Response (200):** `{ success: true }` (no data).

**Cascading deletes:** `meeting_attendees`, `meeting_reminders` are deleted before the meeting row. `recordings` linked via `meeting_id` are NOT deleted (kept for audit; delete via recordings API separately).

**Socket event:** `meeting:deleted` broadcast to `business:${businessId}` with the `id` (as-passed, may be code or UUID).

---

#### M6 — `POST /meetings/:id/join`

REST-level join. Performs password check + adds/updates attendee row to `status='joined'` + updates `joined_at`. You **must still emit `meeting:join` over socket** to join the WebSocket RTC room; this REST call is the pre-authorization.

**Request Body:**

```typescript
{
  password?: string;        // required only if meeting.password !== null
}
```

**Response `data` (200):** Full meeting object plus:
- `maxMeetingDuration` (injected from pricing plan)
- `attendees` array with refreshed `joinedAt` for the caller

**Error 403:** `{ success: false, error: "Invalid password" }` when password set but mismatch.

---

#### M7 — `POST /meetings/:meetingId/participants`

**Who can call:** Host / Co-Host / Creator.

**Request Body:**

```typescript
{
  participantIds: string[];  // UUIDs; non-empty. Each must be valid business member.
}
```

**Validation:**
- Not an array or empty → **400** `"participantIds must be a non-empty array"`.
- Any user outside business → **400** `"All participants must belong to this business"`.
- Duplicates within the request are de-duped.
- Participants already present are silently skipped (no-op).

**Response (200):**

```typescript
{
  success: true,
  message: "2 participant(s) added",       // or "No new participants added (...)"
  data: {
    added: string[];                       // UUIDs actually inserted
  }
}
```

**Side effects:** Same as creation — each new user gets:
1. In-app notification (type=`meeting`, actionUrl=`/meetings/${code}`)
2. Email invitation
3. Socket `meeting:updated` on `business:${id}` with full new attendee list.

---

### 3.3 Socket Events: Meetings

**Prefix:** `meeting:`

> **Critical:** Socket events always resolve the input `meetingId` through `resolveMeetingId()` (`server/lib/socket.ts:18-26`), so you MAY pass either the UUID or 6-char code. Internally, socket events broadcast on TWO rooms: `room:${resolvedUUID}` (for RTC/duration events) AND `meeting:${resolvedUUID}` (for legacy/UI events). Frontend should listen to both for safety.

#### 3.3.1 Frontend → Server (Emitted)

| Event | Payload | Callback Ack |
|-------|---------|--------------|
| `meeting:join` | `{ meetingId, userId, userName?, isHost?, audioEnabled?, videoEnabled? }` | `{ success, error?, meetingId?, meetingCode? }` |
| `meeting:leave` | `{ meetingId, userId, userName? }` | — (no ack) |
| `meeting:end` | `{ meetingId }` | — (no ack; emits ended to all) |
| `recording:start` | `{ meetingId }` | — broadcasts `recording:started` |
| `recording:stop` | `{ meetingId }` | — broadcasts `recording:stopped` |
| `screen-share:start` | `{ meetingId }` | — broadcasts `screen-share:started { userId, meetingId }` |
| `screen-share:stop` | `{ meetingId }` | — broadcasts `screen-share:stopped { userId, meetingId }` |
| `meeting-chat:message` | `{ meetingId, message }` | — broadcasts `meeting-chat:message { userId, meetingId, message, timestamp }` |

#### 3.3.2 Server → Frontend (Listen)

| Event | Payload | When |
|-------|---------|------|
| `meeting:created` | Full meeting object | A new meeting is created with this user as attendee/creator |
| `meeting:updated` | Full meeting object | Any host modifies the meeting |
| `meeting:deleted` | string (meetingId/code) | Meeting deleted |
| **`meeting:participants-list`** | `{ meetingId, meetingCode?, participants: Participant[], endsAt: ISO\|null, maxMeetingDuration: number\|null }` | Immediate response to your `meeting:join` |
| **`meeting:waiting-for-participants`** | `{ meetingId, message, maxMeetingDuration: number\|null }` | You joined but count is ≤1 |
| **`meeting:duration-started`** | `{ meetingId, endsAt: ISO, maxMeetingDuration, startedAt: ISO }` | Just crossed 1→2 participants; timer BEGAN |
| **`meeting:duration-active`** | `{ meetingId, endsAt: ISO, maxMeetingDuration, remainingMs: number }` | You joined LATE and countdown already in progress |
| **`meeting:countdown-warning`** | `{ meetingId, remainingMs, remainingMinutes: 5\|1, message }` | Exactly once at 5min, once at 1min |
| **`meeting:ended`** | `{ meetingId, reason: 'duration_limit'\|'ended_by_host'\|string }` | Auto-closed by backend OR host ended. **TEAR DOWN.** |
| `meeting:participant-joined` | `{ meetingId, meetingCode?, userId, userName, isHost }` | Another participant joined |
| `meeting:participant-left` | `{ meetingId, userId, userName? }` | Another participant left |
| `recording:started` \| `recording:stopped` | `{ meetingId }` (+ whole recording object from REST, + socket payload) | Recording toggled |
| `screen-share:started` \| `screen-share:stopped` | `{ userId, meetingId }` | Screen share toggled by someone |
| `meeting-chat:message` | `{ userId, meetingId, message, timestamp: Date }` | In-meeting chat message |

**Participant object shape (socket payload):**

```typescript
interface Participant {
  id: string;           // userId
  name: string;         // userName supplied on join
  isHost: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  joinedAt: ISOString;
}
```

### 3.4 End-to-End Meeting Creation Flow

```mermaid
sequenceDiagram
    participant Host as Host (FE)
    participant API as REST /meetings
    participant DB as PostgreSQL
    participant Ntfy as Notif/Email
    participant Inv as Invited (FE)
    participant Sock as Socket.io

    Host->>API: POST /meetings { title, startTime, endTime, attendeeIds }
    API->>DB: SELECT plan FROM pricing_plans JOIN businesses
    DB-->>API: maxMeetingDuration, planMaxParticipants
    API->>DB: INSERT meetings (endTime capped by plan)
    DB-->>API: meeting { id, meetingCode }
    API->>DB: INSERT meeting_attendees (creator + attendeeIds)
    API->>Ntfy: createNotification + sendEmail per attendee
    Ntfy-->>Inv: in-app notification popup
    Ntfy-->>Inv: email invitation
    API->>Sock: io.to(user:${id}).emit("meeting:created", meeting)
    Sock-->>Inv: meeting:created event
    API-->>Host: 201 { meeting, maxMeetingDuration }
```

### 3.5 Meeting Join + Duration Flow (2+ Participants)

```mermaid
sequenceDiagram
    participant FE1 as Host FE
    participant FE2 as Guest FE
    participant Sock as Socket.io
    participant RM as RoomManager
    participant DB as Postgres

    FE1->>Sock: meeting:join { meetingId/code, userId, userName, isHost=true }
    Sock->>DB: resolveMeetingId → UUID
    DB-->>Sock: resolved UUID
    Sock->>RM: addParticipant(room_uuid, host, endsAt=null, maxDuration)
    RM-->>Sock: participantCount = 1
    Sock-->>FE1: meeting:participants-list { endsAt:null, maxDuration }
    Sock-->>FE1: meeting:waiting-for-participants { message }
    Note over FE1: UI shows "Waiting for participants..." badge

    FE2->>Sock: meeting:join { meetingId/code, userId, userName, isHost=false }
    Sock->>RM: addParticipant(room_uuid, guest)
    RM-->>Sock: participantCount = 2
    Note over Sock,DB: Because count>1 AND endsAt==null AND maxDuration set
    Sock->>RM: setRoomEndsAt(room_uuid, now + plan*60s)
    Sock->>DB: UPDATE meetings SET end_time = $1
    Sock->>Sock: BROADCAST duration-started
    Sock-->>FE1: meeting:duration-started { endsAt, startedAt }
    Sock-->>FE2: meeting:participants-list { endsAt, ... }
    Sock-->>FE2: (also gets participant-joined + list)
    Note over FE1,FE2: Both UIs start countdown from endsAt
```

### 3.6 Frontend Implementation Checklist (Meetings)

1. **Call `GET /meetings/code/:code` before entering the meeting route.** If 404, show "Meeting not found / no permission".
2. **Set up socket listeners BEFORE calling `meeting:join`.** Otherwise `participants-list` is missed.
3. **Use the UUID from `participants-list`/API response for all subsequent calls.** Never use the meeting code as `roomId` directly in Mediasoup signaling or socket room lookups (internal rooms use UUID).
4. **Password-protected meetings:** Call `POST /meetings/:id/join` with password FIRST; if it passes, proceed to the socket join. The socket layer does NOT check passwords.
5. **Duration UI:** See `FRONTEND_CALL_DURATION_GUIDE.md` §5–§6 for the reference React hook.
6. **On `meeting:ended`:** Stop all MediaStream tracks, close transports, show reason, navigate after 3–5s.
7. **Instant meetings:** The `endTime` returned from POST /meetings will be `null`. The UI should show "Waiting for more participants to start timer" until 2+ joined.
8. **Add participants UI:** Use `POST /meetings/:meetingId/participants` with `{ participantIds: [] }` for a cleaner flow than PUT+full-replace, unless user explicitly edits the whole list.
9. **Live attendee list update:** Listen to both `meeting:participant-joined`/`meeting:participant-left` AND `meeting:participants-list` (initial). When reconnection happens, a fresh `participants-list` arrives and should overwrite the local list.

---

## 4. Video/Audio Calling Feature

Calls are *instant by default* (no scheduling). They use the same RTC stack as meetings (Mediasoup + RoomManager via socket) and share the plan-based duration enforcement.

### 4.1 REST Endpoints Summary

| # | Method | Path | Auth | Purpose | Handler |
|---|--------|------|------|---------|---------|
| C1 | `GET` | `/calls?page=1&limit=10` | Bearer + `use_chat` | Call history for user's business | `getCalls` |
| C2 | `GET` | `/calls/code/:code` | Bearer + `use_chat` | Lookup call by 6-char code | `getCallByCode` |
| C3 | `POST` | `/calls` | Bearer + `use_chat` | Create a call (start ringing) | `createCall` |
| C4 | `PUT` | `/calls/:id` (UUID or code) | Bearer + `use_chat` + Host | Update status, waiting-room, recording, coHost | `updateCall` |
| C5 | `DELETE` | `/calls/:id` | Bearer + `use_chat` + Host | Delete call record + recordings + participants | `deleteCall` |
| C6 | `POST` | `/calls/:id/join` | Bearer + `use_chat` | DB-level join + password check + participant upsert | `joinCall` |
| C7 | `POST` | `/calls/:id/leave` | Bearer + `use_chat` | DB-level leave: status=left, set `left_at` | `leaveCall` |
| C8 | `POST` | `/calls/:callId/participants` | Bearer + `use_chat` + Host | Add new participants to ongoing call (with `call:incoming` ring) | `addCallParticipants` |
| C9 | `POST` | `/calls/generate-invite` | Bearer + `use_chat` | Generate a one-time guest invite link (24h token) | `generateCallInvite` |

### 4.2 Endpoint Details

---

#### C1 — `GET /calls?page=1&limit=10`

Pagination identical to Meetings. Visibility: user created, hosted, co-hosted, or participant in the call.

**Response `data.calls[]`:**

```typescript
{
  id: string;                          // UUID
  businessId: string;
  type: "audio" | "video";
  status: "ongoing" | "completed" | "missed" | "cancelled";
  startedAt: ISOString;
  endedAt: ISOString | null;
  createdById: string;
  hostId: string;
  coHostId: string | null;
  callCode: string;                    // 6 chars
  password: string | null;
  isGroupCall: boolean;
  waitingRoomEnabled: boolean;
  recordingEnabled: boolean;
  maxParticipants: number | null;
  createdAt: ISOString;
  updatedAt: ISOString;
  participants: Array<{
    id: string;                        // call_participants PK
    userId: string;
    status: "joined" | "invited" | "left";
    joinedAt: ISOString | null;
    leftAt: ISOString | null;
  }>;
}
```

---

#### C3 — `POST /calls`

Create and immediately ring participants.

**Request Body:**

```typescript
{
  type?: "audio" | "video";          // default "video"
  participantIds?: string[];         // other users to include (creator auto-included). Each must be in same business.
  isGroupCall?: boolean;             // default false
  password?: string | null;
  waitingRoomEnabled?: boolean;      // default false
  recordingEnabled?: boolean;        // default false
}
```

**Validation:**
- All `participantIds` must belong to the same business.
- `participantIds` + creator count cannot exceed plan `maxParticipants`. → **400** `"Plan allows maximum N participants per call"`.
- Call always has `status='ongoing'`, `startedAt = now`, `endedAt = null` initially (until 2+ participants present).

**Response `data` (201):**

```typescript
{
  ...CallObject (shape from C1),
  maxMeetingDuration: number | null;   // plan limit (minutes). null = unlimited.
  participants: CallParticipant[];
}
```

**Side effects:**
- Socket: `call:created` sent to every participant's `user:${userId}`.
- Socket: `call:incoming` sent to **non-creator** participants with payload:
  ```typescript
  { callId: UUID, from: userId, type: "audio"|"video", callCode: string }
  ```
  → Frontend shows incoming call screen.
- Activity log: action="create", actionType="call"

---

#### C6 — `POST /calls/:id/join`

REST join (password check + DB upsert). Mirror of M6, but for calls.

**Request Body:**

```typescript
{
  password?: string;   // required only if call.password is set
}
```

**Response `data` (200):** Call with `maxMeetingDuration` injected + refreshed participants with caller `joinedAt`.

---

#### C7 — `POST /calls/:id/leave`

Marks caller's participant row as `status='left'` with `left_at = NOW()`. Emits socket `call:participantLeft` to `call:${id}`. Always succeeds if call exists; does not require host role.

**Response `data` (200):** Updated call object with participants.

---

#### C9 — `POST /calls/generate-invite`

Create a guest invitation (single-use, 24h expiry). Useful for external attendees who are not business users.

**Request Body:**

```typescript
{
  roomId: string;                           // REQUIRED. call UUID or callCode (internally resolved)
  participantName: string;                  // REQUIRED. display name for the guest
  isHost?: boolean;                         // default false
  waitingRoomEnabled?: boolean;             // default false
}
```

**Response `data` (200):**

```typescript
{
  inviteLink: string;   // URL with query params: roomId, token, userName, isHost, waitingRoom
}
```

Token is stored in `invitation_tokens(token, room_id, expires_at, used)` with 24h TTL. Frontend must call socket `invitation:verify { token, roomId }` when the guest lands.

### 4.3 Socket Events: Calls

Calls use BOTH:
- Prefix `call:` (legacy UI events, broadcast to `call:${uuid}`)
- Prefix-less RTC events (broadcast to `room:${uuid}` via `call:join` internal logic)

Per `call:join` in socket.ts:240-361 — *all calls are joined through the generic `call:join` path which resolves to `room:${uuid}` and emits generic duration events using the `call:` prefix.*

#### 4.3.1 Frontend → Server

| Event | Payload | Ack |
|-------|---------|-----|
| **`call:join`** | `{ roomId: UUID\|code, userId, userName, isHost, audioEnabled, videoEnabled }` | `{ success, error?, roomId? }` |
| **`call:leave`** | `{ roomId, userId, userName }` | — |
| **`call:end`** | `{ callId }` | — (emits call:ended to call:${uuid} room) |
| `call:invite` | `{ callId, targetUserId, type }` | — (forwards `call:incoming` to user) |
| `call:accept` | `{ callId }` | — (forwards `call:accepted`) |
| `call:reject` | `{ callId }` | — (forwards `call:rejected`) |
| `call:participant-media-state` | `{ roomId, userId, audioEnabled, videoEnabled, screenSharing }` | — (broadcasts media state) |
| `call:get-participants` | `{ roomId }` | `{ participants: Participant[], roomId }` |
| `invitation:verify` | `{ token, roomId }` | `{ valid: boolean, error?, roomId?: UUID }` |
| `invitation:joined` | `{ roomId, userId, userName }` | — |
| `recording:start/stop` | `{ callId }` | — |
| `screen-share:start/stop` | `{ callId }` | — |
| `meeting-chat:message` | `{ callId, message }` | — (in-call text chat) |

#### 4.3.2 Server → Frontend

| Event | Payload | When |
|-------|---------|------|
| `call:created` | Full call object + maxMeetingDuration | A new call created with this user as participant |
| `call:incoming` | `{ callId, callCode, from, type }` | Someone is calling this user — show ringing UI |
| `call:accepted` \| `call:rejected` | `{ callId }` | Callee answered or declined |
| `call:updated` | call object | PUT /calls/:id or participant add |
| `call:deleted` | string id | DELETE /calls/:id |
| `call:participantJoined` \| `call:participantLeft` (from REST join/leave) | `{ callId, userId }` | REST C6/C7 side-effects |
| **`call:participants-list`** (from roomManager) | `{ roomId, participants: Participant[], endsAt: ISO\|null, maxMeetingDuration }` | In response to `call:join` |
| **`call:waiting-for-participants`** | `{ roomId, message, maxMeetingDuration }` | Count ≤ 1 after join |
| **`call:duration-started`** | `{ roomId, endsAt, maxMeetingDuration, startedAt }` | Crossed threshold 1→2 |
| **`call:duration-active`** | `{ roomId, endsAt, maxMeetingDuration, remainingMs }` | Joined late |
| **`call:countdown-warning`** | `{ callId, remainingMs, remainingMinutes: 5\|1, message }` | Emitted to `room:${uuid}` at 5min/1min |
| **`call:ended`** | `{ callId, reason: 'duration_limit'\|'ended_by_host'\|string }` | Duration or host. **BROADCAST.** |
| `call:participant-joined` (from socket) | `{ roomId, userId, userName, isHost }` | Another socket joined |
| `call:participant-left` (from socket) | `{ roomId, userId, userName }` | Another socket left |
| `call:participant-media-state` | `{ roomId, userId, audioEnabled, videoEnabled, screenSharing }` | Mic/camera/share toggled |

### 4.4 1:1 Call Initiation Flow

```mermaid
sequenceDiagram
    participant Caller as Caller FE
    participant API as POST /calls
    participant Sock as Socket.io
    participant Callee as Callee FE

    Caller->>API: POST /calls { type:"video", participantIds:[calleeId] }
    API-->>Caller: 201 { call{ id, callCode }, maxMeetingDuration }
    Caller->>Sock: emit call:join(roomId=id, userId=callerId, isHost=true, audio/video)
    Sock-->>Caller: ACK + call:participants-list { endsAt:null }
    Sock-->>Caller: call:waiting-for-participants

    API->>Sock: io.to(user:${calleeId}).emit("call:incoming", { callId, callCode, from, type })
    Sock-->>Callee: call:incoming → ringtone + Accept/Decline screen
    Callee->>Sock: emit call:accept { callId }
    Sock-->>Caller: call:accepted
    Callee->>Sock: emit call:join(roomId=id, userId=calleeId, isHost=false)
    Sock->>Sock: roomManager participantCount=2
    Sock-->>Caller: call:participant-joined
    Sock-->>Callee: call:participants-list { endsAt: ISO }
    Sock-->>Caller: call:duration-started { endsAt, startedAt }
    Sock-->>Callee: call:duration-started
```

---

## 5. In-App Chat Feature

### 5.1 REST Endpoints Summary

| # | Method | Path | Auth | Purpose | Handler |
|---|--------|------|------|---------|---------|
| CH1 | `GET` | `/chat/conversations` | Bearer + `use_chat` | List conversations (direct + group) with lastMessage preview + participants | `getConversations` |
| CH2 | `POST` | `/chat/conversations` | Bearer + `use_chat` | Create or reuse a conversation (direct messages auto-reuse existing 2-user convo) | `createConversation` |
| CH3 | `GET` | `/chat/conversations/:conversationId/messages?page=1&limit=50` | Bearer + `use_chat` | Paginated messages (oldest-first in returned page) | `getConversationMessages` |
| CH4 | `POST` | `/chat/conversations/:conversationId/messages` | Bearer + `use_chat` | Send message (text + optional attachment) | `sendMessage` |
| CH5 | `PUT` | `/chat/conversations/:conversationId/read` | Bearer + `use_chat` | Mark conversation as read (update `last_read_at` for caller) | `markConversationAsRead` |

### 5.2 Endpoint Details

---

#### CH1 — `GET /chat/conversations`

No pagination parameters (returns all).

**Response `data[]`:**

```typescript
Array<{
  id: string;                                  // conversation UUID
  businessId: string;
  name: string | null;                         // only set for group
  type: "direct" | "group";
  createdById: string;
  createdAt: ISOString;
  updatedAt: ISOString;

  participants: Array<{
    id: string;                                // chat_participant PK
    userId: string;                            // user UUID
    lastReadAt: ISOString | null;              // ‼️ may be NULL if never read
    lastSeen: ISOString | null;                // user's last activity (from user_sessions)
    name: string | null;                       // display name
    email: string | null;
    avatarUrl: string | null;
  }>;

  lastMessage: string | null;                 // content of last message (text only)
  lastMessageAt: ISOString | null;            // timestamp of last message
}>
```

> **Unread detection (frontend):** For each participant entry other than the user: ignore. For yourself, compare `participants.find(p => p.userId === me).lastReadAt` with `lastMessageAt`. If `lastMessageAt > lastReadAt` → conversation has unread.

---

#### CH2 — `POST /chat/conversations`

**Request Body:**

```typescript
{
  name?: string | null;                        // group name (ignored/redundant for direct)
  type?: "direct" | "group";                   // default "direct"
  participantIds: string[];                    // other users. Creator auto-added.
}
```

**Validation:**
- All `participantIds` must belong to the business.
- For `type: "direct"` with exactly 1 participantId, the handler FIRST searches for an existing 2-user direct conversation between (creator, participantIds[0]). If found, returns the existing conversation ID with **HTTP 200**.

**Response (201 for new; 200 for reused direct):**

```typescript
{
  success: true,
  data: {
    id: string;                              // conversation UUID
    businessId: string;
    name: string | null;
    type: "direct" | "group";
    createdById: string;
    createdAt: ISOString;
    updatedAt: ISOString;
    participants: Array<{
      id: string;
      userId: string;
      lastReadAt: ISOString | null;
    }>;
  }
}
```

**Side effect:** Socket event `conversation:created` sent to each participant's `user:${userId}`.

---

#### CH3 — `GET /chat/conversations/:conversationId/messages`

**Path + Query:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `conversationId` | string (path, UUID) | — | Required |
| `page` | integer | 1 | 1-based |
| `limit` | integer | 50 | messages per page |

**Side effect on read:** The handler reads messages AND simultaneously updates the caller's `last_read_at = CURRENT_TIMESTAMP`. So simply opening a message list marks it read. Additionally total count (`total`) is the entire conversation size, not the page.

**Response `data` (200):**

```typescript
{
  messages: Array<{                       // note: result.rows reversed → OLDEST first in array for chat scroll UX
    id: string;
    conversationId: string;
    senderId: string;
    senderName: string | null;
    content: string | null;               // null if attachment-only message? Practically always set for text-first
    attachmentUrl: string | null;         // URI (from separate upload? attach via sendMessage body)
    attachmentType: string | null;        // MIME, e.g. "image/png"
    createdAt: ISOString;
  }>;
  total: number;                          // entire conversation size
}
```

> **Important order:** The SQL query fetches `ORDER BY cm.created_at DESC LIMIT $2 OFFSET $3`, then the handler does `result.rows.reverse()` before returning. So the returned `messages[]` array is oldest-last-page-entry first, ready to append to your UI scroll bottom. If page=1 you get the MOST RECENT messages in correct read order top→bottom.

---

#### CH4 — `POST /chat/conversations/:conversationId/messages`

Send a message to a conversation.

**Request Body:**

```typescript
{
  content?: string | null;
  attachmentUrl?: string | null;       // URL to a pre-uploaded file (use upload endpoint separately)
  attachmentType?: string | null;      // MIME type
}
```

Either `content` or `attachmentUrl` should be non-null.

**Response `data` (201):**

```typescript
{
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: string | null;
  attachmentUrl: string | null;
  attachmentType: string | null;
  createdAt: ISOString;
}
```

**Side effects:**
- `chat_conversations.updated_at = NOW()`
- `chat_participants.last_read_at = NOW()` **only for sender**
- Socket event `message:created` broadcast to `conversation:${conversationId}` (so all open sockets receive; but note: sender also needs to be listening — because socket broadcast does NOT echo back to the sender. Frontend should optimistically append the returned message OR join the socket room first.)

---

#### CH5 — `PUT /chat/conversations/:conversationId/read`

Explicit read-mark (for when user scrolls without calling GET messages). No body.

**Response `data` (200):** `{ lastReadAt: Date }`.

**Socket side effect:** `conversation:read { conversationId, userId }` broadcast to conversation room. Use this to show read-receipt "John read your message".

### 5.3 Socket Events: Chat

Chat uses generic Socket.io rooms: join via `join-conversation` event when user opens the chat route for a conversation.

#### 5.3.1 Frontend → Server

| Event | Payload |
|-------|---------|
| **`join-conversation`** | `conversationId: string` (UUID) |
| (no leave event) | Socket rooms auto-clean on disconnect. You can call `socket.leave('conversation:${id}')` if user closes chat panel. |

#### 5.3.2 Server → Frontend

| Event | Payload | When |
|-------|---------|------|
| `conversation:created` | Full conversation object | User added to a new chat (group created, or first DM) |
| **`message:created`** | ChatMessage object (same as CH4 response) | New message posted to the open conversation |
| **`conversation:read`** | `{ conversationId, userId }` | Someone in the conversation marked it read |

### 5.4 Socket Presence (All Features)

User online/offline status uses the `user-online` event pattern. The same pattern drives the `lastSeen` field in CH1 participants array.

| Event | Direction | Payload | Behavior |
|-------|-----------|---------|----------|
| `user-online` | FE → Sock | `(userId, businessId)` | Joins `user:${id}` + `business:${id}` rooms. Sets Redis key `online:biz:userId` TTL 60s. Emits `user-presence-updated { status: "online" }` to business. |
| `user-keep-alive` | FE → Sock | `(userId, businessId)` | Refresh Redis TTL (every 30–45s on frontend) |
| `user-presence` | FE → Sock | status string: `"idle"` / `"dnd"` / `"away"` | Forwards to `user-presence-updated` |
| `disconnect` | Sock → FE | (builtin) | Deletes Redis key, emits `user-presence-updated { status: "offline" }` to business. |
| `user-presence-updated` | Sock → FE | `{ userId, status }` | Subscribe to render green dot. |

### 5.5 Chat Send + Receive Flow

```mermaid
sequenceDiagram
    participant Alice as Alice FE
    participant REST as REST /messages
    participant DB as PostgreSQL
    participant Sock as Socket.io
    participant Bob as Bob FE

    Alice->>Sock: join-conversation(convoId)
    Bob->>Sock: join-conversation(convoId)

    Alice->>REST: POST /chat/conversations/:convoId/messages { content: "Hi Bob" }
    REST->>DB: INSERT chat_messages
    REST->>DB: UPDATE chat_conversations.updated_at
    REST->>DB: UPDATE chat_participants.last_read_at (Alice)
    REST->>Sock: socket.to(conversation:convoId).emit("message:created", msg)
    REST-->>Alice: 201 { msg }

    Sock-->>Bob: message:created { id, senderId, content, createdAt }
    Note over Bob: Render message bubble. Update lastMessageAt.
    Note over Alice: Already has msg in local state via response (no socket echo).

    Bob->>REST: PUT /chat/conversations/:convoId/read
    REST->>DB: SET Bob's last_read_at
    REST->>Sock: emit conversation:read { convoId, userId: Bob }
    Sock-->>Alice: conversation:read { userId: Bob }
    Note over Alice: Show double-check ✔️ under Alice's last message
```

---

## 6. Call Rooms (WebSocket / Mediasoup RTC)

Call Rooms are the *runtime* layer. The backend uses **Mediasoup** for SFU-style WebRTC, and `RoomManager` (in-memory + per-process, with Redis adapter for horizontal scaling via socket.io) to track participants and per-room countdown state.

All RTC room payloads are keyed by a **UUID** (the call/meeting id). The `resolveRoomId` function accepts both UUIDs and short codes, so callers may pass either. **Always use UUIDs in your local state to avoid duplication.**

### 6.1 Room Resolution

```
resolveRoomId(inputId) → { id: UUID, type: 'call' | 'meeting' } | null
    1. Check if inputId is valid UUID v4 → calls DB lookup by UUID in calls and meetings.
    2. Otherwise → calls DB lookup by short-code callCode / meetingCode.
    3. First match wins. (Calls short-code namespace never collides with meetings because they are separate tables with separate generators.)
```

If resolution fails, socket callbacks return `{ success: false, error: "Call or meeting not found" }`.

### 6.2 RoomManager State Model (`server/lib/roomManager.ts:1-77`)

```
RoomManager.rooms = Map<roomUUID, RoomState>
RoomState {
  participants: Map<userId, Participant>,  // see Participant type
  endsAt: Date | null,                     // null until 2+ present
  maxMeetingDuration: number | null,       // from plan (inherited from DB lookup)
}
```

- Adding first participant: creates room entry with `endsAt=null`, `maxMeetingDuration` from plan.
- Adding 2nd+ participant: if `maxMeetingDuration !== null` and `endsAt === null`, the socket handler sets `endsAt = now + maxMeetingDuration * 60s`, persists to DB, and broadcasts `duration-started`.
- If count drops to 1 after started, `endsAt` continues to run. Does NOT pause.
- Room is deleted when `participants.size` becomes 0.

### 6.3 Mediasoup Signaling Events

All Mediasoup events take an (optional) acknowledgement callback. Flow:

```mermaid
sequenceDiagram
    participant FE as Frontend (mediasoup-client)
    participant Sock as Socket.io
    participant MS as Mediasoup Router/Room

    FE->>Sock: mediasoup:getRouterRtpCapabilities (cb)
    Sock->>MS: getRouter()
    MS-->>Sock: rtpCapabilities
    Sock-->>FE: cb({ rtpCapabilities })

    FE->>Sock: mediasoup:createWebRtcTransport({ roomId }, cb)
    Sock->>MS: router.createWebRtcTransport()
    MS-->>Sock: transport (ICE params, candidates, DTLS params)
    Sock-->>FE: cb({ id, iceParameters, iceCandidates, dtlsParameters, roomId })

    FE->>Sock: mediasoup:connectWebRtcTransport({ transportId, dtlsParameters, roomId }, cb)
    Sock->>MS: transport.connect({ dtlsParameters })
    MS-->>Sock: ok
    Sock-->>FE: cb()

    FE->>Sock: mediasoup:produce({ transportId, kind, rtpParameters, roomId }, cb)
    Sock->>MS: transport.produce(...)
    MS-->>Sock: producer.id
    Sock->>Sock: socket.to(room:${roomId}).emit("mediasoup:newProducer")
    Sock-->>FE: cb({ id: producerId, roomId })
    Sock-->>Others: mediasoup:newProducer { producerId, kind, roomId }

    Note over FE,Others: Peer receives newProducer event → consume it
    Others->>Sock: mediasoup:consume({ transportId, producerId, rtpCapabilities, roomId }, cb)
    Sock->>MS: transport.consume(...)
    MS-->>Sock: consumer { id, kind, rtpParameters }
    Sock-->>Others: cb({ id, producerId, kind, rtpParameters, roomId })

    Others->>Sock: mediasoup:resume({ consumerId, roomId }, cb)
    Sock->>MS: consumer.resume()
    Sock-->>Others: cb()
```

**Frontend checklist for Mediasoup integration:**

1. `mediasoup-client` v3+ on the frontend. Initialize a Device with RTP caps from step 1.
2. Use the RESOLVED UUID as the `roomId` in all mediasoup events. Never pass 6-char code (it's resolved, but still — avoid confusion in logs).
3. On `mediasoup:newProducer`, always call `consume()` + `resume()` — mediasoup consumers are paused by default when created for the SFU.
4. Capture errors via the callback. If `cb.error` is `"Transport not found"` / `"Cannot consume"`, the room may have been reset — re-run the join flow.
5. When user leaves room (`call:leave` / `meeting:leave`), close all local SendTransports / RecvTransports / Producers / Consumers and call `device.close()` if done.
6. On network reconnect:
   - Re-create transports/producers/consumers.
   - Re-emit `call:join` — RoomManager handles duplicate participant ID upsert (overwrites previous). You will get a fresh `participants-list`, possibly with `duration-active` if already counting.

### 6.4 Countdown / Auto-Close System (`socket.ts:47-181`)

A 10-second `setInterval` sweep runs in the socket service. For every call/meeting with `status='ongoing'` and `ended_at IS NOT NULL`:

| Condition | Action |
|-----------|--------|
| `endsAt - now <= 0` | Call `endRoom(roomId, type)` → UPDATE status=completed/end_time=now → emit `call:ended`/`meeting:ended` with reason `'duration_limit'` → remove all participants from RoomManager. |
| `endsAt - now ∈ (1, 5]` min and not yet warned at 5 | Emit `call:countdown-warning { remainingMinutes: 5 }` to `room:${uuid}`. |
| `endsAt - now ∈ (0, 1]` min and not yet warned at 1 | Emit `call:countdown-warning { remainingMinutes: 1 }`. |
| Meeting rooms → dual emit | Events emitted to both `room:${uuid}` AND `meeting:${uuid}` / `call:${uuid}` to be safe. |

Warned state stored in `warnedRooms5min` / `warnedRooms1min` Sets (per-process; cleared on process restart but okay since the DB state drives re-checks — the worst case is duplicate warnings on redeploy).

### 6.5 Media State Sync

Frontend emits on mic/camera/screen toggles:

```typescript
socket.emit("call:participant-media-state", {
  roomId, userId,
  audioEnabled: true/false,
  videoEnabled: true/false,
  screenSharing: true/false,
});
```

Backend forwards the exact same payload to `room:${roomId}` so all peers render mute icons.

---

## 7. Recordings API

Used in conjunction with Meetings and Calls. Recording is a two-phase operation:
1. `POST /recordings` — allocate a DB record with status `recording` (start marker).
2. Upload the binary media via `POST /recordings/:id/upload` (multipart or raw binary).

### 7.1 REST Endpoints

| # | Method | Path | Auth | Purpose |
|---|--------|------|------|---------|
| R1 | `GET` | `/recordings?page=1&limit=10` | Bearer + `rtc.recording` | List user-visible recordings (with presigned URLs if R2) |
| R2 | `POST` | `/recordings` | Bearer + `rtc.recording` | Create recording record (`status='recording'`). Requires `meetingId` XOR `callId`. |
| R3 | `PUT` | `/recordings/:id` | Bearer + `rtc.recording` | Update status/pause/complete after upload finishes, or set duration/size |
| R4 | `POST` | `/recordings/:id/upload` | Bearer + `rtc.recording` | Upload binary. Accepts multipart/form-data or raw Content-Types (video/*, audio/*, application/octet-stream) |
| R5 | `DELETE` | `/recordings/:id` | Bearer + `rtc.recording` | Remove recording from DB + storage (R2 / uploads folder) |

### 7.2 R4 — Upload Protocol

Accepted multipart field names (any one of these): `file`, `recording`, `video`, `audio`. Form field `duration` (seconds, integer) is accepted.

**Request Headers (raw binary alternative):**
- `Content-Type: video/webm` or `audio/webm` or `application/octet-stream`
- Body is the raw bytes.
- `duration` can be passed as query `?duration=125` or omitted.

**Storage cascade (`recordings.ts:652-701`):**
1. Tries Cloudflare R2 (if credentials env vars set) → returns a presigned URL valid **24 hours** in the listing API.
2. Falls back to local filesystem `uploads/` folder (served via `/uploads/:filename` static route).
3. In Netlify/Lambda, falls back further: tries `@netlify/blobs` store "uploads", then base64 `data:` URI if blobs also fail.

The upload endpoint itself sets `status='completed'` on success.

---

## 8. Notifications API

Supports the meeting invitation, call incoming, and system alerts.

### 8.1 REST Endpoints

| # | Method | Path | Auth | Purpose |
|---|--------|------|------|---------|
| N1 | `GET` | `/notifications?page=1&limit=20&unreadOnly=false` | Bearer | List notifications. Automatically deletes rows past `expires_at`. |
| N2 | `PATCH` | `/notifications/:id/read` | Bearer | Mark single notification as read (`is_read=true`). |
| N3 | `PATCH` | `/notifications/read-all` | Bearer | Mark ALL as read. |
| N4 | `POST` | `/notifications/:id/action` | Bearer | For actionable notifs: set `action_taken=$1` and mark read. Body: `{ action: string }`. |

### 8.2 Notification Row Fields (from N1 list)

```typescript
{
  id: string;                       // UUID
  business_id: string;
  user_id: string;
  type: string;                     // e.g. "meeting", "call", "payment", "system"
  title: string;                    // short title
  message: string;                  // body
  action_url: string | null;        // e.g. "/meetings/OTBH0D"
  action_type: string | null;       // e.g. "view_meeting"
  metadata: JSON | null;            // e.g. { meetingId, meetingCode }
  is_read: boolean;
  is_actionable: boolean;
  action_taken: string | null;      // populated after N4
  expires_at: ISOString | null;     // auto-deleted past this (GET N1 cleans up expired)
  created_at: ISOString;
  updated_at: ISOString;
}
```

### 8.3 Socket Notifications (Real-time Push)

For in-app popup delivery — each feature creates a DB row AND emits to `user:${userId}` socket room.

| Socket Event (S→F) | Payload | Creator |
|---------------------|---------|---------|
| (generic) — DB notification creation also uses createNotification service. The socket pattern is: `io.to(\`user:${userId}\`).emit("notification:created", notif)` | Notification row object | Meeting invitations, transfers, KYC updates, etc. Frontend should subscribe to the user-specific `notification:created` event; currently the backend pattern is feature-specific emit names like `meeting:created`. For consistency, ensure your frontend listens to BOTH. |

---

## 9. Integration Testing Guidelines

### 9.1 Sandbox Credentials (Local & Shared Dev)

| Variable | Local Value | Purpose |
|----------|-------------|---------|
| Backend base | `http://localhost:8080` (or 3000 per env) | |
| Database URL | `postgresql://postgres:postgres@localhost:5432/metroflow` (adjust as needed) | Run `pnpm prisma migrate dev` or `scripts/seed_plans.ts` first. |
| Feature permission | All permissions can be granted by updating `pricing_plans.permissions = '["*"]'` for test business. | |
| Redis | Optional; disable with `DISABLE_REDIS=true` if Redis unavailable locally. Socket.io will run without Redis adapter (single-node). | |
| Mediasoup IP | `MEDIASOUP_ANNOUNCED_IP=127.0.0.1` for localhost. Browser needs `https` or `localhost` for `getUserMedia()` permission prompts. | |

### 9.2 Required Feature Test Cases

#### A. Meetings

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| A1 | Create instant meeting with 2 attendees | `POST /meetings { title:"Instant", isInstant:true, attendeeIds:[user2] }` | 201 with `endTime=null`, `maxMeetingDuration` from plan; 2 in-app notifs created. |
| A2 | Scheduled meeting endTime capped | Plan=60min, submit endTime=3h after start. | Response `endTime = startTime + 60min`. |
| A3 | Meeting code lookup works | `GET /meetings/code/{code}` | 200 with meeting. Same code fails on different business JWT → 404. |
| A4 | Password-protected join | `POST /meetings/{id}/join { password }` wrong password → 403 `Invalid password`. | Socket `meeting:join` bypasses password — so the REST check is mandatory. |
| A5 | Duration start timing | Host socket join → 2nd socket join. | Both receive `meeting:duration-started`. 1st also had `waiting-for-participants`. |
| A6 | Countdown warnings | Simulate meeting with endsAt 6s ahead (use DB UPDATE before join). | 5min warning fires within 10s sweep; 1min warning fires if endsAt in (0,1] min. |
| A7 | Auto-close | Meeting with endsAt in past. | Within 10s sweep → `meeting:ended { reason:'duration_limit' }`. |
| A8 | Add participants with duplicates | POST participants with user that already exists. | Response: added=[] only. No duplicate DB rows. |
| A9 | Non-host tries DELETE /meetings/:id | Token of non-host user. | 404 (because the WHERE clause filters to host users). |
| A10 | Reconnection during meeting | Disconnect socket → reconnect after 5s while still in "ongoing" state, re-emit meeting:join. | Receive fresh `participants-list` with `endsAt` set; then `meeting:duration-active`. |

#### B. Calls

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| B1 | Create 1:1 video call rings the other user | `POST /calls { type:"video", participantIds:[user2] }` | user2 socket gets `call:incoming`. |
| B2 | Plan participant cap violated | Plan max=3, try `participantIds` length = 5. | **400** `"Plan allows maximum 3 participants per call"`. |
| B3 | REST leave marks `left_at` | `POST /calls/{id}/leave` | `participants[me].status === 'left'`, `leftAt` populated. |
| B4 | Password-protected call join | `POST /calls/{id}/join` mismatch | **403** `Invalid password`. |
| B5 | Invitation link lifecycle | `POST /calls/generate-invite` → verify token → verify again (already used). | First `invitation:verify { valid:true }`; second `{ valid:false, error:"Invalid or expired token" }`. |
| B6 | Participant media state sync | User1 emit `participant-media-state { audioEnabled:false }` | User2 receives same payload. |

#### C. Chat

| # | Test Case | Expected |
|---|-----------|----------|
| C1 | Direct conversation reuse | `POST /chat/conversations { type:"direct", participantIds:[user2] }` twice → 2nd call returns same UUID (HTTP 200, not 201). |
| C2 | Unread count correctness | User2 posts 3 messages to convo, User1 has not called GET messages → in CH1 list User1's `lastReadAt < lastMessageAt`. |
| C3 | Read receipt propagation | User2 calls `PUT /conversations/:id/read` → User1 socket receives `conversation:read { userId:user2 }`. |
| C4 | Non-participant GET messages | User3 requests messages for a 2-user direct convo → 404. |
| C5 | Message order in CH3 paging | `page=1, limit=50` returns messages sorted newest-first in DB, then reversed → oldest-first in returned array. First element in array is oldest. Append bottom-up. |

#### D. Recordings

| # | Test Case | Expected |
|---|-----------|----------|
| D1 | Create recording with both IDs | Body `{ meetingId, callId }` both → **400** "Either meetingId or callId is required". (No: the actual error is triggered when neither is present. Both present is accepted — DB row has nullable FKs to both. Test: neither.) |
| D2 | Upload without multipart field | POST binary video/webm → successful upload via raw-bytes branch. |
| D3 | Generate presigned URL | On R2-configured environment, GET `/recordings` → `storageUrl` has signed-query params. |
| D4 | Delete cascades storage | DELETE removes both DB row and R2/local file. |

#### E. Cross-Cutting

| # | Test Case | Expected |
|---|-----------|----------|
| E1 | Idle token expiration | Login → wait 31 min (or set env `TOKEN_IDLE_TIMEOUT_MINUTES=1` temporarily) → hit any endpoint → **403** `Invalid or expired token`; row deleted from user_sessions. |
| E2 | Rate limiting | Send 101 requests in <15 mins to any same path → 101st → **429** with headers present. |
| E3 | Subscription expiry | Manually set `businesses.subscription_status='inactive'` and expired trial → any feature route → **403** `"Your subscription has expired..."`. |
| E4 | Missing feature permission | Plan permissions do not include `use_meetings` → GET/POST `/meetings` → **403** `"Kindly upgrade your plan to enjoy this feature."`. |
| E5 | CORS preflight | OPTIONS /meetings from allowed origin → 204 with CORS headers; unlisted origin → CORS error. |

### 9.3 Validation Steps for Each Feature

**Validation workflow — Meetings/Calls:**
1. Log in two users → capture both JWTs.
2. User A creates meeting with User B as attendee.
3. Confirm User B has DB notification row: `SELECT * FROM notifications WHERE user_id=B`.
4. Confirm User B socket got `meeting:created`.
5. Join sockets from both users → verify `participants-list` length=2, both get `duration-started`.
6. Manually DB set `end_time = NOW() - interval '1 second'`; wait 12s → verify both sockets receive `call:ended`/`meeting:ended`.

**Validation workflow — Chat:**
1. Create convo (A↔B) twice → same id.
2. A posts message (REST) → B has socket event → lastMessageAt updated on next list fetch.
3. B GET /messages (also triggers last_read_at = NOW for B) → A next GET /conversations sees B's `lastReadAt >= message.createdAt`.

---

## 10. Change Log & Versioning

### 10.1 API Versioning Strategy

All routes are currently **unversioned** at the path level. Versioning is handled by:

| Layer | Mechanism |
|-------|-----------|
| Backward compatibility | Dual-mount at `/` and `/api/` preserves legacy paths. |
| Feature detection | Feature permission middleware (`checkFeaturePermission`) acts as gate; missing permission → upgrade plan modal. |
| Response fields | Fields are always **additive** (e.g. `maxMeetingDuration` injection). Do NOT remove or rename existing fields. |
| Deprecated response fields | Marked in docs for 2 minor releases, then removed in major. |
| Date / duration fields | All returned as ISO 8601 strings (`toISOString()`). Never as Unix timestamps. |
| Socket events | New events are ADDITIVE; old event names/payloads preserved for 2 releases minimum. Payload field additions only. |

To lock your integration to a tested backend revision, you can pin to specific deploy URLs or include a custom header in your client:
```
X-Client-Api-Revision: 2026-07-29
```
Currently not enforced — reserved for future use.

### 10.2 Change Log

| Version | Date | Changes | Migration / Frontend Action |
|---------|------|---------|-------------------------------|
| **1.0.0** | 2026-07-29 | **Initial public release of this specification.** Documents meetings, calls, chat, call rooms, recordings, notifications, auth/security layers. | N/A — first version. |
| (prior) | 2026-07-27 | **Duration enforcement 2.0**: Timer now starts ONLY when ≥2 participants connected (not at creation); separate `waiting-for-participants`, `duration-started`, `duration-active` socket events. | Reference `FRONTEND_CALL_DURATION_GUIDE.md` §3–§8. Update countdown state machine to handle the 3 separate starts (waiting / active from late / duration-started). |
| (prior) | 2026-07-20 | **Participant-add endpoints** (`POST /meetings/:id/participants`, `POST /calls/:id/participants`) added. Before this: only `PUT /meetings/:id { attendeeIds:[] }` full-replace was possible. | Prefer the new POST endpoints for adding users mid-flight to avoid accidental deletes from stale local attendee lists. |
| (prior) | 2026-07-15 | **Chat `lastReadAt` / `lastSeen`** exposed in participants array of CH1 conversations list. Previously both were always NULL due to JOIN alias mismatch. | Use `p.lastReadAt < lastMessageAt` to drive unread badge counts directly instead of a local tracker. |
| (prior) | 2026-07-08 | **Unified `/` and `/api/` dual mount** + Mediasoup integration + recordings multi-upload paths. | If your client was using `/api/meetings`, now either path works. Keep `/api/` for consistency in new code. |

### 10.3 Deprecation Timelines (Anticipated, Not Yet Enforced)

| Current | Future Replacement | Earliest Removal | Notes |
|---------|-------------------|------------------|-------|
| `call:participantJoined` (from REST C6, emitted to `call:${id}`) | `call:participant-joined` (from socket join room flow, emitted to `room:${id}`) | 2026-12-31 | The hyphenated form is now canonical per RoomManager. Listen to both during the transition. |
| Password on call/meeting returned in GET lists | A separate `GET /meetings/:id/security` endpoint (proposed) | 2027-01-15 | Currently host/cohost/creator users can read plaintext passwords from list responses. Strip from frontend display and treat as sensitive. |
| `call:incoming` emitting to generic `user:${id}` | Dedicated `user:${id}:calls` room or similar | TBD | No migration date; listen to current event first. |
| `feature: use_chat` for /calls route permission | `use_calls` / `use_video_calls` permission | TBD | Currently calls share the chat feature flag; backend may split in future — check for the new permission gracefully (not-found in plan permissions → fall back to current flag). |

### 10.4 Migration Guidance for Breaking Changes

When a breaking change is unavoidable:
1. 30-day **deprecation window** published in this Change Log with clear before/after payloads.
2. Dual support during the window.
3. Sandbox environment updated first.
4. Production deployment follows 7 days after sandbox validation.
5. A migration diff published as a sibling document (`MIGRATION_v1_TO_v2.md`) with exact field rename maps.
6. Backend emits `X-Api-Deprecation: true` header on responses using the deprecated path, plus a link to migration docs.

Frontends should **log deprecation headers** to Sentry/console during the deprecation window to catch missed usages before the hard switch.

---

*End of Specification.* For backend source references: see inline `handler` links in §3.1, §4.1, §5.1, §7.1, §8.1. For runtime duration/countdown UI patterns, cross-reference `FRONTEND_CALL_DURATION_GUIDE.md` in the repository root.
