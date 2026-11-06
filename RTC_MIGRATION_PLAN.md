
# RTC Backend Migration Plan: Replace Jitsi with Self-Hosted WebRTC

## Overview
This document outlines the complete plan to migrate from Jitsi to a self-hosted WebRTC infrastructure for MetricFlow's real-time communication features.

---

## Current State
### ✅ Already Implemented
- PostgreSQL database models:
  - `Meeting`, `MeetingAttendee`, `MeetingReminder`
  - `Call`, `CallParticipant`
  - `ChatConversation`, `ChatParticipant`, `ChatMessage`
- Express routes for calls and meetings
- Socket.IO server with Redis adapter for horizontal scaling
- Authentication, subscription, and permission systems
- Background job processing via BullMQ
- Logging (Winston) and Sentry integration

---

## Migration Steps

### 1. Update Prisma Schema (`prisma/schema.prisma`)
#### Changes to `Meeting` Model
- **Remove:** `meetingUrl` (Jitsi-specific)
- **Add:**
  - `meetingCode` (String, unique) - for joining via code
  - `password` (String, optional) - meeting password
  - `hostId` (String) - reference to User
  - `coHostId` (String, optional) - reference to User
  - `isInstant` (Boolean, default false) - instant vs scheduled
  - `maxParticipants` (Int, optional) - configurable limit
  - `waitingRoomEnabled` (Boolean, default false)
  - `recordingEnabled` (Boolean, default false)
  - `screenSharingEnabled` (Boolean, default true)

#### Changes to `Call` Model
- **Remove:** `jitsiRoomId` (Jitsi-specific)
- **Add:**
  - `callCode` (String, unique)
  - `password` (String, optional)
  - `hostId` (String)
  - `coHostId` (String, optional)
  - `isGroupCall` (Boolean, default false)
  - `waitingRoomEnabled` (Boolean, default false)
  - `recordingEnabled` (Boolean, default false)

#### New Model: `Recording`
```prisma
model Recording {
  id             String   @id @default(uuid())
  businessId     String   @map("business_id")
  meetingId      String?  @map("meeting_id")
  callId         String?  @map("call_id")
  recordedById   String   @map("recorded_by")
  storageUrl     String   @map("storage_url")
  duration       Int      // in seconds
  status         String   // recording, paused, completed, failed
  size           Int?     // in bytes
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @default(now()) @map("updated_at")

  business     Business  @relation(fields: [businessId], references: [id], onDelete: Cascade)
  meeting      Meeting?  @relation(fields: [meetingId], references: [id], onDelete: Cascade)
  call         Call?     @relation(fields: [callId], references: [id], onDelete: Cascade)
  recordedBy   User      @relation(fields: [recordedById], references: [id])

  @@map("recordings")
}
```

#### Update `User` Model
- **Add:** `presenceStatus` (String, default "offline")

---

### 2. Install New Dependencies
- `mediasoup`: WebRTC SFU for group calls/meetings

---

### 3. Update Permissions (`server/config/permissions.ts`)
Add all RTC-specific permissions:
```
- rtc.audio_call
- rtc.video_call
- rtc.group_call
- rtc.instant_meeting
- rtc.schedule_meeting
- rtc.recording
- rtc.screen_share
- rtc.file_share
- rtc.chat
- rtc.raise_hand
- rtc.waiting_room
- rtc.breakout_room
- rtc.host_controls
- rtc.co_host
- rtc.meeting_password
- rtc.join_by_code
- rtc.join_by_link
- rtc.allow_guest_join
- rtc.max_meeting_duration
- rtc.max_participants
- rtc.max_recording_storage
- rtc.max_recording_duration
- rtc.analytics
```

---

### 4. Create Mediasoup Configuration & Service (`server/lib/mediasoup.ts`)
- Initialize mediasoup worker
- Configure router, transports, producers, consumers
- Handle room creation and management

---

### 5. Extend Socket.IO Server (`server/lib/socket.ts`)
Add event handlers for:
- **User Presence:**
  - `user-presence` (update status)
- **Call Events:**
  - `call:invite`
  - `call:accept`
  - `call:reject`
  - `call:end`
  - `call:cancel`
  - `call:busy`
- **Meeting Events:**
  - `meeting:join`
  - `meeting:leave`
  - `meeting:end`
  - `meeting:invite`
- **WebRTC Signaling:**
  - `webrtc:offer`
  - `webrtc:answer`
  - `webrtc:ice-candidate`
- **Recording Events:**
  - `recording:start`
  - `recording:stop`
  - `recording:pause`
  - `recording:resume`
- **Screen Sharing:**
  - `screen-share:start`
  - `screen-share:stop`
- **In-Meeting Chat:**
  - `meeting-chat:message`

---

### 6. Update API Routes
- `server/routes/calls.ts`
- `server/routes/meetings.ts`
- **New:** `server/routes/recordings.ts`

---

### 7. Create Background Jobs
- Recording processing jobs
- Cleanup old recordings
- Presence timeout handling

---

## Architecture Diagram
```
┌─────────────────┐
│   Frontend      │
└────────┬────────┘
         │
         ▼
┌───────────────────────────────┐
│     Express API Server        │
│  - Auth & Permissions         │
│  - REST APIs (calls/meetings) │
└────────────┬──────────────────┘
             │
    ┌────────┴────────┐
    ▼                 ▼
┌──────────────┐  ┌─────────────────┐
│  Socket.IO   │  │  Mediasoup SFU  │
│  (Signaling) │  │  (Media)        │
└──────┬───────┘  └────────┬────────┘
       │                   │
       └────────┬──────────┘
                ▼
         ┌───────────────┐
         │  Redis        │
         │  (Sync & Pub/ │
         │   Sub)        │
         └───────────────┘
                │
                ▼
         ┌───────────────┐
         │  PostgreSQL   │
         │  (DB)         │
         └───────────────┘
```

---

## Provider Toggle — LiveKit (default) vs MediaSoup (IMPORTANT, 2026-11)

Live streaming and calls run **LiveKit-first**. The active provider is the
`calling_provider` system setting (seeded to `livekit`, switchable via
`PUT /admin/calling/provider`, status via `GET /admin/calling/providers/status`).
Each call/live room persists its own `provider` column; rooms created while a
provider was active keep using it.

**If live streams "don't work" or silently run MediaSoup, check the LIVEKIT_*
environment first** — an unconfigured or unreachable LiveKit deployment makes
`resolveProviderForRoom` degrade to MediaSoup automatically:

| Env var | Purpose |
| --- | --- |
| `LIVEKIT_URL` | Client-facing `wss://` LiveKit host (tokens embed it) |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `LIVEKIT_API_URL` | Optional server-side `https://` host (derived from URL if empty) |
| `LIVEKIT_EGRESS_URL` | Optional dedicated egress host (recordings) |

All three of `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` must be
set to real values (placeholders count as missing). Reachability is probed and
cached for 30s; a 502 behind the URL fails the probe and degrades to MediaSoup.
The web apps and both mobile apps pick the provider from the join response
(`calling.provider` + token), so **no client change is needed to switch**.
