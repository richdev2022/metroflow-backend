# Meeting Schedules, Chat, Audio & Video Call Features

## 1. Feature Overview

This integration will enhance MetricFlow with real-time collaboration capabilities including:

- **Meeting Scheduling**: Schedule team meetings, sync with calendars, send invitations and reminders
- **Chat**: Real-time one-on-one and group chat with file attachments
- **Audio/Video Calls**: High-quality peer-to-peer audio and video calls with screen sharing

## 2. Vision Alignment

MetricFlow's core vision is to provide a comprehensive platform for **tracking KPIs, managing developer tasks, and monitoring business performance** for teams and businesses. Adding real-time collaboration features aligns perfectly by:

- Enabling seamless team communication without leaving the platform
- Connecting task management with immediate discussion capabilities
- Facilitating synchronous collaboration via meetings and calls
- Reducing context switching and improving productivity

## 3. Recommended Providers (100% Free & Open-Source)

### 3.1 Chat & Real-time Messaging

**Socket.io + Redis (Upstash Free Tier)**
- **Socket.io**: Open-source, free, and widely adopted real-time engine
- **Redis (Upstash Free Tier)**: Already configured in your project for BullMQ; use for Socket.io adapter
- Complete control over your infrastructure
- No ongoing costs
- Scalable architecture
- Supports namespaces, rooms, and acknowledgments

### 3.2 Audio/Video Calls & Screen Sharing

**Jitsi Meet**
- 100% free and open-source WebRTC video conferencing platform
- No user limits on free tier
- Built-in screen sharing
- Self-hostable or use the free public Jitsi servers
- Pre-built embeddable widget
- Works across all browsers
- Supports recording via Jibri (self-hosted)

### 3.3 Meeting Scheduling

**Custom Implementation + Google Calendar API (Free Tier)**
- **Custom Scheduling**: Build scheduling internally using PostgreSQL (no external costs)
- **Google Calendar API**: Free tier available for calendar sync
  - 1,000,000 requests per month free
  - OAuth2 authentication
  - Create/update/delete events
  - Send invitations

**Why This Stack?**
- Zero upfront costs
- Leverages existing infrastructure (Redis/Upstash already in use)
- Open-source and community-supported
- No vendor lock-in
- Can scale to paid solutions later if needed

## 4. Revenue Model

### 4.1 Subscription Tiers

Add the following features to existing pricing tiers:

| Tier | Meeting Scheduling | Chat | Audio Calls | Video Calls | Screen Sharing |
|------|--------------------|------|-------------|-------------|----------------|
| Free | 🔒 No | 🔒 No | 🔒 No | 🔒 No | 🔒 No |
| Basic | ✅ Yes | ✅ 1:1 Chat | ✅ Up to 4 participants | ✅ Up to 4 participants | 🔒 No |
| Pro | ✅ Yes | ✅ Group Chat | ✅ Up to 10 participants | ✅ Up to 10 participants | ✅ Yes |
| Enterprise | ✅ Yes | ✅ Unlimited | ✅ Unlimited | ✅ Unlimited | ✅ Yes |

### 4.2 Usage-based Add-ons

- **Additional Video Call Minutes**: $0.02/minute
- **Extra Call Participants**: $5/month per additional 5 participants
- **Recording Storage**: $0.10/GB/month

## 5. Implementation Plan

### 5.1 Phase 1: Database Schema & Models (Week 1)

Add the following Prisma models:

```prisma
// Meeting Scheduling
model Meeting {
  id          String   @id @default(uuid())
  businessId  String   @map("business_id")
  title       String
  description String?
  startTime   DateTime @map("start_time")
  endTime     DateTime @map("end_time")
  timezone    String
  createdById String   @map("created_by")
  status      String   @default("scheduled")
  meetingUrl  String?  @map("meeting_url")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @default(now()) @map("updated_at")

  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  createdBy   User     @relation(fields: [createdById], references: [id])
  attendees   MeetingAttendee[]
  reminders   MeetingReminder[]

  @@map("meetings")
}

model MeetingAttendee {
  id        String   @id @default(uuid())
  meetingId String   @map("meeting_id")
  userId    String   @map("user_id")
  status    String   @default("invited")
  createdAt DateTime @default(now()) @map("created_at")

  meeting   Meeting  @relation(fields: [meetingId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([meetingId, userId])
  @@map("meeting_attendees")
}

model MeetingReminder {
  id        String   @id @default(uuid())
  meetingId String   @map("meeting_id")
  minutes   Int      // Remind X minutes before
  sent      Boolean  @default(false)
  sentAt    DateTime? @map("sent_at")
  createdAt DateTime @default(now()) @map("created_at")

  meeting   Meeting  @relation(fields: [meetingId], references: [id], onDelete: Cascade)

  @@map("meeting_reminders")
}

// Chat
model ChatConversation {
  id          String   @id @default(uuid())
  businessId  String   @map("business_id")
  name        String?  // For group conversations
  type        String   @default("direct") // direct or group
  createdById String?  @map("created_by")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @default(now()) @map("updated_at")

  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  createdBy   User?    @relation(fields: [createdById], references: [id], onDelete: SetNull)
  participants ChatParticipant[]
  messages    ChatMessage[]

  @@map("chat_conversations")
}

model ChatParticipant {
  id             String   @id @default(uuid())
  conversationId String   @map("conversation_id")
  userId         String   @map("user_id")
  lastReadAt     DateTime? @map("last_read_at")
  createdAt      DateTime @default(now()) @map("created_at")

  conversation   ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  user           User             @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([conversationId, userId])
  @@map("chat_participants")
}

model ChatMessage {
  id             String   @id @default(uuid())
  conversationId String   @map("conversation_id")
  senderId       String   @map("sender_id")
  content        String?
  attachmentUrl  String?  @map("attachment_url")
  attachmentType String?  @map("attachment_type")
  createdAt      DateTime @default(now()) @map("created_at")

  conversation   ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  sender         User             @relation(fields: [senderId], references: [id], onDelete: Cascade)

  @@map("chat_messages")
}

// Calls
model Call {
  id          String   @id @default(uuid())
  businessId  String   @map("business_id")
  type        String   // audio or video
  status      String   // ongoing, completed, missed
  startedAt   DateTime? @map("started_at")
  endedAt     DateTime? @map("ended_at")
  createdById String   @map("created_by")
  jitsiRoomId String   @map("jitsi_room_id") // Jitsi room name
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @default(now()) @map("updated_at")

  business    Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  createdBy   User     @relation(fields: [createdById], references: [id])
  participants CallParticipant[]

  @@map("calls")
}

model CallParticipant {
  id        String   @id @default(uuid())
  callId    String   @map("call_id")
  userId    String   @map("user_id")
  joinedAt  DateTime? @map("joined_at")
  leftAt    DateTime? @map("left_at")
  status    String
  createdAt DateTime @default(now()) @map("created_at")

  call      Call     @relation(fields: [callId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([callId, userId])
  @@map("call_participants")
}
```

### 5.2 Phase 2: Backend API (Week 2)

Create new API routes in `server/routes/`:
- `meetings.ts` - CRUD for meetings, attendees, reminders
- `chat.ts` - Conversations, messages, participants
- `calls.ts` - Create calls, manage participants

Integrate with existing authentication middleware (`server/middleware/auth.ts`).

### 5.3 Phase 3: Real-time Integration (Week 3)

- Set up Socket.io with Redis adapter (using existing Upstash instance) for real-time chat updates
- Implement BullMQ jobs for meeting reminders
- Integrate Jitsi Meet widget for audio/video calls

### 5.4 Phase 4: Frontend Integration (Week 4-5)

- Implement UI components for chat interface
- Build meeting scheduler UI
- Integrate Daily.co video call widget
- Connect to backend API endpoints

### 5.5 Phase 5: Testing & Deployment (Week 6)

- Write unit and integration tests
- Update Swagger documentation
- Deploy to production
- Monitor usage and performance

## 6. Technical Considerations

### 6.1 Scalability
- Use Redis for real-time message pub/sub
- Implement database indexing for chat and meeting queries
- Consider database sharding for large datasets

### 6.2 Security
- End-to-end encryption for sensitive conversations
- Secure WebSocket connections (WSS)
- Access control for calls and meetings
- Audit logging for all collaboration activities

### 6.3 Cost Management
- No direct costs with this free stack!
- Monitor Upstash Redis usage to stay within free tier limits
- Implement rate limiting for API endpoints
- Jitsi public servers are free but may have rate limits for very high usage; consider self-hosting if needed

## 7. Success Metrics

- Adoption rate by active teams
- Daily active users on chat/calls
- Meeting attendance rate
- Customer satisfaction (CSAT) score
- Revenue impact from tier upgrades
