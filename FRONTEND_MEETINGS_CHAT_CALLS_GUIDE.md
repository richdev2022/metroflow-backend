
# Frontend Integration Guide: Meetings, Chat &amp; Calls (Self-Hosted WebRTC)

This guide provides all the necessary information for integrating the new self-hosted WebRTC meetings, chat, and audio/video call features into your frontend application.

---

## Table of Contents

1. [Overview](#overview)
2. [API Endpoints](#api-endpoints)
   - [Meetings](#meetings)
   - [Chat](#chat)
   - [Calls](#calls)
   - [Recordings](#recordings)
3. [Socket.io Real-time Events](#socketio-real-time-events)
4. [WebRTC Integration with Mediasoup](#webrtc-integration-with-mediasoup)
5. [Permissions](#permissions)

---

## Overview

All endpoints are prefixed with `/api` (or `/` for backward compatibility) and require authentication via a bearer token in the `Authorization` header:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

---

## API Endpoints

### Meetings

#### Get All Meetings
- **Endpoint**: `GET /api/meetings`
- **Query Params**:
  - `page`: (optional, default 1) Page number
  - `limit`: (optional, default 10) Items per page
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "meetings": [
        {
          "id": "uuid",
          "title": "Sprint Planning",
          "description": "Weekly sprint planning meeting",
          "startTime": "2024-01-01T10:00:00.000Z",
          "endTime": "2024-01-01T11:00:00.000Z",
          "timezone": "UTC",
          "createdById": "user-uuid",
          "hostId": "user-uuid",
          "coHostId": "optional-user-uuid",
          "status": "scheduled",
          "meetingCode": "ABC123",
          "isInstant": false,
          "password": "optional-password",
          "maxParticipants": 100,
          "waitingRoomEnabled": false,
          "recordingEnabled": false,
          "screenSharingEnabled": true,
          "googleEventId": "optional-google-calendar-id",
          "createdAt": "2024-01-01T09:00:00.000Z",
          "updatedAt": "2024-01-01T09:00:00.000Z",
          "attendees": [
            { "id": "uuid", "userId": "user-uuid", "status": "invited" }
          ]
        }
      ],
      "total": 5
    }
  }
  ```

#### Get Meeting by Code
- **Endpoint**: `GET /api/meetings/code/:code`
- **Response**: Same as single meeting object from Get All Meetings.

#### Create a Meeting
- **Endpoint**: `POST /api/meetings`
- **Request Body**:
  ```json
  {
    "title": "Sprint Planning",
    "description": "Weekly sprint planning",
    "startTime": "2024-01-01T10:00:00.000Z",
    "endTime": "2024-01-01T11:00:00.000Z",
    "timezone": "UTC",
    "isInstant": false,
    "password": "optional-password",
    "maxParticipants": 100,
    "waitingRoomEnabled": false,
    "recordingEnabled": false,
    "screenSharingEnabled": true,
    "attendeeIds": ["user-uuid-1", "user-uuid-2"]
  }
  ```
- **Response**: Same as single meeting.

#### Update a Meeting
- **Endpoint**: `PUT /api/meetings/:id`
- **Request Body**: Same as Create (all fields optional).
- **Response**: Same as single meeting.

#### Delete a Meeting
- **Endpoint**: `DELETE /api/meetings/:id`
- **Response**:
  ```json
  {
    "success": true
  }
  ```

---

### Chat

#### Get All Conversations
- **Endpoint**: `GET /api/chat/conversations`
- **Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "id": "uuid",
        "name": "Project Team Chat",
        "type": "group", // or "direct"
        "created_by": "user-uuid",
        "created_at": "2024-01-01T09:00:00.000Z",
        "updated_at": "2024-01-01T09:00:00.000Z",
        "participants": [
          { "id": "uuid", "user_id": "user-uuid", "last_read_at": "2024-01-01T09:00:00.000Z" }
        ],
        "last_message": "Hello everyone!",
        "last_message_at": "2024-01-01T09:00:00.000Z"
      }
    ]
  }
  ```

#### Create a Conversation
- **Endpoint**: `POST /api/chat/conversations`
- **Request Body**:
  ```json
  {
    "name": "Project Team Chat", // optional for direct conversations
    "type": "group", // or "direct"
    "participant_ids": ["user-uuid-1", "user-uuid-2"]
  }
  ```
- **Response**: Same as single conversation.

#### Get Conversation Messages
- **Endpoint**: `GET /api/chat/conversations/:conversationId/messages`
- **Query Params**:
  - `page`: (optional, default 1) Page number
  - `limit`: (optional, default 50) Items per page
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "messages": [
        {
          "id": "uuid",
          "conversation_id": "conversation-uuid",
          "sender_id": "user-uuid",
          "content": "Hello everyone!",
          "attachment_url": "optional-url",
          "attachment_type": "image/png",
          "created_at": "2024-01-01T09:00:00.000Z",
          "sender_name": "John Doe"
        }
      ],
      "total": 100
    }
  }
  ```

#### Send a Message
- **Endpoint**: `POST /api/chat/conversations/:conversationId/messages`
- **Request Body**:
  ```json
  {
    "content": "Hello everyone!",
    "attachment_url": "optional-url",
    "attachment_type": "image/png"
  }
  ```
- **Response**: Same as single message in Get Messages.

---

### Calls

#### Get All Calls
- **Endpoint**: `GET /api/calls`
- **Query Params**:
  - `page`: (optional, default 1) Page number
  - `limit`: (optional, default 10) Items per page
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "calls": [
        {
          "id": "uuid",
          "type": "video", // or "audio"
          "status": "ongoing", // or "completed", "missed", "cancelled"
          "startedAt": "2024-01-01T09:00:00.000Z",
          "endedAt": "2024-01-01T09:30:00.000Z",
          "createdById": "user-uuid",
          "hostId": "user-uuid",
          "coHostId": "optional-user-uuid",
          "callCode": "XYZ789",
          "isGroupCall": false,
          "password": "optional-password",
          "maxParticipants": 10,
          "waitingRoomEnabled": false,
          "recordingEnabled": false,
          "createdAt": "2024-01-01T09:00:00.000Z",
          "updatedAt": "2024-01-01T09:00:00.000Z",
          "participants": [
            {
              "id": "uuid",
              "userId": "user-uuid",
              "status": "joined", // or "invited", "left"
              "joinedAt": "2024-01-01T09:00:00.000Z",
              "leftAt": "2024-01-01T09:15:00.000Z"
            }
          ]
        }
      ],
      "total": 5
    }
  }
  ```

#### Get Call by Code
- **Endpoint**: `GET /api/calls/code/:code`
- **Response**: Same as single call object from Get All Calls.

#### Create a Call
- **Endpoint**: `POST /api/calls`
- **Request Body**:
  ```json
  {
    "type": "video", // or "audio"
    "isGroupCall": false,
    "password": "optional-password",
    "maxParticipants": 10,
    "waitingRoomEnabled": false,
    "recordingEnabled": false,
    "participantIds": ["user-uuid-1", "user-uuid-2"]
  }
  ```
- **Response**: Same as single call.

#### Update a Call
- **Endpoint**: `PUT /api/calls/:id`
- **Request Body**:
  ```json
  {
    "status": "completed", // or "ongoing", "missed", "cancelled"
    "waitingRoomEnabled": false,
    "recordingEnabled": false,
    "coHostId": "optional-user-uuid"
  }
  ```
- **Response**: Same as single call.

#### Join a Call
- **Endpoint**: `POST /api/calls/:id/join`
- **Request Body**:
  ```json
  {
    "password": "optional-password"
  }
  ```
- **Response**: Same as single call.

#### Leave a Call
- **Endpoint**: `POST /api/calls/:id/leave`
- **Response**: Same as single call.

#### Delete a Call
- **Endpoint**: `DELETE /api/calls/:id`
- **Response**:
  ```json
  {
    "success": true
  }
  ```

---

### Recordings

#### Get All Recordings
- **Endpoint**: `GET /api/recordings`
- **Query Params**:
  - `page`: (optional, default 1) Page number
  - `limit`: (optional, default 10) Items per page
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "recordings": [
        {
          "id": "uuid",
          "businessId": "business-uuid",
          "meetingId": "optional-meeting-uuid",
          "callId": "optional-call-uuid",
          "recordedById": "user-uuid",
          "recordedByName": "John Doe",
          "storageUrl": "https://...",
          "duration": 1800, // seconds
          "status": "completed", // or "recording", "paused", "failed"
          "size": 5242880, // bytes
          "createdAt": "2024-01-01T09:00:00.000Z",
          "updatedAt": "2024-01-01T09:30:00.000Z"
        }
      ],
      "total": 10
    }
  }
  ```

#### Start a Recording
- **Endpoint**: `POST /api/recordings`
- **Request Body**:
  ```json
  {
    "meetingId": "optional-meeting-uuid", // either meetingId or callId must be provided
    "callId": "optional-call-uuid"
  }
  ```
- **Response**: Same as single recording.

#### Update a Recording (Stop/Pause)
- **Endpoint**: `PUT /api/recordings/:id`
- **Request Body**:
  ```json
  {
    "status": "paused", // or "completed", "failed"
    "storageUrl": "https://...",
    "duration": 1800,
    "size": 5242880
  }
  ```
- **Response**: Same as single recording.

#### Delete a Recording
- **Endpoint**: `DELETE /api/recordings/:id`
- **Response**:
  ```json
  {
    "success": true
  }
  ```

---

## Socket.io Real-time Events

### Initial Setup
```javascript
import { io } from 'socket.io-client';

const socket = io('YOUR_BACKEND_URL', {
  transports: ['websocket'],
});
```

### Connection Events
```javascript
socket.on('connect', () => {
  console.log('Connected to server');

  // When connected, tell the server you're online
  socket.emit('user-online', 'YOUR_USER_ID', 'YOUR_BUSINESS_ID');

  // Set up keep-alive ping every 30 seconds to maintain presence
  setInterval(() => {
    socket.emit('user-keep-alive', 'YOUR_USER_ID', 'YOUR_BUSINESS_ID');
  }, 30000);
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
});
```

### Events to Emit

#### User Presence
```javascript
// Update presence status (online, offline, busy, calling, in-meeting, away, do-not-disturb)
socket.emit('user-presence', 'busy');
```

#### Call Events
```javascript
// Invite a user to a call
socket.emit('call:invite', { callId: 'call-uuid', targetUserId: 'user-uuid', type: 'video' });

// Accept an incoming call
socket.emit('call:accept', { callId: 'call-uuid' });

// Reject an incoming call
socket.emit('call:reject', { callId: 'call-uuid' });

// End a call
socket.emit('call:end', { callId: 'call-uuid' });
```

#### Meeting Events
```javascript
// Join a meeting room
socket.emit('meeting:join', { meetingId: 'meeting-uuid' });

// Leave a meeting room
socket.emit('meeting:leave', { meetingId: 'meeting-uuid' });

// End a meeting
socket.emit('meeting:end', { meetingId: 'meeting-uuid' });
```

#### WebRTC Signaling (Mediasoup)
```javascript
// Get router RTP capabilities
socket.emit('mediasoup:getRouterRtpCapabilities', (response) => {
  const { rtpCapabilities } = response;
  // Use rtpCapabilities to initialize your client-side mediasoup
});

// Create WebRTC transport
socket.emit('mediasoup:createWebRtcTransport', { roomId: 'meeting-or-call-uuid' }, (response) => {
  const { id, iceParameters, iceCandidates, dtlsParameters } = response;
  // Initialize your local transport
});

// Connect WebRTC transport
socket.emit('mediasoup:connectWebRtcTransport', {
  transportId: 'transport-uuid',
  dtlsParameters: dtlsParameters,
  roomId: 'meeting-or-call-uuid'
}, () => {
  console.log('Transport connected');
});

// Produce media
socket.emit('mediasoup:produce', {
  transportId: 'transport-uuid',
  kind: 'video', // or 'audio'
  rtpParameters: rtpParameters,
  roomId: 'meeting-or-call-uuid'
}, (response) => {
  const producerId = response.id;
  console.log('Producer created:', producerId);
});

// Consume media
socket.emit('mediasoup:consume', {
  transportId: 'transport-uuid',
  producerId: 'producer-uuid',
  rtpCapabilities: rtpCapabilities,
  roomId: 'meeting-or-call-uuid'
}, (response) => {
  const { id, producerId, kind, rtpParameters } = response;
  // Initialize your consumer
});

// Resume consumer (start receiving media)
socket.emit('mediasoup:resume', {
  consumerId: 'consumer-uuid',
  roomId: 'meeting-or-call-uuid'
}, () => {
  console.log('Consumer resumed');
});
```

#### Recording Events
```javascript
// Start recording
socket.emit('recording:start', { meetingId: 'meeting-uuid' });

// Stop recording
socket.emit('recording:stop', { meetingId: 'meeting-uuid' });
```

#### Screen Sharing
```javascript
// Start screen sharing
socket.emit('screen-share:start', { meetingId: 'meeting-uuid' });

// Stop screen sharing
socket.emit('screen-share:stop', { meetingId: 'meeting-uuid' });
```

#### In-Meeting Chat
```javascript
// Send in-meeting message
socket.emit('meeting-chat:message', {
  meetingId: 'meeting-uuid',
  message: 'Hello everyone!'
});
```

---

### Events to Listen For

#### User Presence
```javascript
socket.on('user-presence-updated', ({ userId, status }) => {
  console.log('User presence updated:', userId, 'is now', status);
});
```

#### Call Events
```javascript
// Incoming call
socket.on('call:incoming', ({ callId, from, type, callCode }) => {
  console.log('Incoming call from:', from);
});

// Call accepted
socket.on('call:accepted', ({ callId }) => {
  console.log('Call accepted:', callId);
});

// Call rejected
socket.on('call:rejected', ({ callId }) => {
  console.log('Call rejected:', callId);
});

// Call ended
socket.on('call:ended', ({ callId }) => {
  console.log('Call ended:', callId);
});

// Participant joined call
socket.on('call:participantJoined', ({ callId, userId }) => {
  console.log('Participant joined:', userId, 'in call:', callId);
});

// Participant left call
socket.on('call:participantLeft', ({ callId, userId }) => {
  console.log('Participant left:', userId, 'from call:', callId);
});
```

#### Meeting Events
```javascript
socket.on('meeting:created', (meeting) => {
  console.log('New meeting:', meeting);
});

socket.on('meeting:updated', (meeting) => {
  console.log('Meeting updated:', meeting);
});

socket.on('meeting:deleted', (meetingId) => {
  console.log('Meeting deleted:', meetingId);
});

socket.on('call:deleted', (callId) => {
  console.log('Call deleted:', callId);
});

socket.on('meeting:participantJoined', ({ meetingId, userId }) => {
  console.log('Participant joined:', userId, 'in meeting:', meetingId);
});

socket.on('meeting:participantLeft', ({ meetingId, userId }) => {
  console.log('Participant left:', userId, 'from meeting:', meetingId);
});

socket.on('meeting:ended', ({ meetingId }) => {
  console.log('Meeting ended:', meetingId);
});
```

#### WebRTC Signaling
```javascript
socket.on('mediasoup:newProducer', ({ producerId, kind }) => {
  console.log('New producer available:', producerId, kind);
  // Consume this producer
});
```

#### Recording Events
```javascript
socket.on('recording:started', (recording) => {
  console.log('Recording started:', recording);
});

socket.on('recording:paused', (recording) => {
  console.log('Recording paused:', recording);
});

socket.on('recording:stopped', (recording) => {
  console.log('Recording stopped:', recording);
});
```

#### Screen Sharing
```javascript
socket.on('screen-share:started', ({ userId }) => {
  console.log('User started screen sharing:', userId);
});

socket.on('screen-share:stopped', ({ userId }) => {
  console.log('User stopped screen sharing:', userId);
});
```

#### In-Meeting Chat
```javascript
socket.on('meeting-chat:message', ({ userId, message, timestamp }) => {
  console.log('New in-meeting message from:', userId);
  // Display the message
});
```

---

## WebRTC Integration with Mediasoup

Use the `mediasoup-client` library on the frontend for WebRTC communication:
```bash
npm install mediasoup-client
```

For detailed integration examples, check the [mediasoup documentation](https://mediasoup.org/documentation/v3/mediasoup-client/).

---

## Permissions

All RTC-related permissions start with the `rtc.` prefix. Check the permissions guide for a complete list of available permissions and how to validate them.
