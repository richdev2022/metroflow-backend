# Frontend Integration Guide: Meetings, Chat & Calls

This guide provides all the necessary information for integrating the new meetings, chat, and audio/video call features into your frontend application.

---

## Table of Contents

1. [Overview](#overview)
2. [API Endpoints](#api-endpoints)
   - [Meetings](#meetings)
   - [Chat](#chat)
   - [Calls](#calls)
3. [Socket.io Real-time Events](#socketio-real-time-events)
4. [Jitsi Meet Integration](#jitsi-meet-integration)
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
          "start_time": "2024-01-01T10:00:00.000Z",
          "end_time": "2024-01-01T11:00:00.000Z",
          "timezone": "UTC",
          "created_by": "user-uuid",
          "status": "scheduled",
          "meeting_url": "https://meet.jit.si/...",
          "google_event_id": "optional-google-calendar-id",
          "created_at": "2024-01-01T09:00:00.000Z",
          "updated_at": "2024-01-01T09:00:00.000Z",
          "attendees": [
            { "id": "uuid", "user_id": "user-uuid", "status": "invited" }
          ]
        }
      ],
      "total": 5
    }
  }
  ```

#### Create a Meeting
- **Endpoint**: `POST /api/meetings`
- **Request Body**:
  ```json
  {
    "title": "Sprint Planning",
    "description": "Weekly sprint planning",
    "start_time": "2024-01-01T10:00:00.000Z",
    "end_time": "2024-01-01T11:00:00.000Z",
    "timezone": "UTC",
    "attendee_ids": ["user-uuid-1", "user-uuid-2"],
    "meeting_url": "https://meet.jit.si/...",
    "google_event_id": "optional"
  }
  ```
- **Response**: Same as single meeting in Get All Meetings

#### Update a Meeting
- **Endpoint**: `PUT /api/meetings/:id`
- **Request Body**: Same as Create (all fields optional)
- **Response**: Same as single meeting

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
- **Response**: Same as single conversation

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
- **Response**: Same as single message in Get Messages

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
          "status": "ongoing", // or "completed", "missed"
          "started_at": "2024-01-01T09:00:00.000Z",
          "ended_at": "2024-01-01T09:30:00.000Z",
          "created_by": "user-uuid",
          "jitsi_room_id": "room-name",
          "created_at": "2024-01-01T09:00:00.000Z",
          "updated_at": "2024-01-01T09:00:00.000Z",
          "participants": [
            {
              "id": "uuid",
              "user_id": "user-uuid",
              "status": "joined", // or "invited", "left"
              "joined_at": "2024-01-01T09:00:00.000Z",
              "left_at": "2024-01-01T09:15:00.000Z"
            }
          ]
        }
      ],
      "total": 5
    }
  }
  ```

#### Create a Call
- **Endpoint**: `POST /api/calls`
- **Request Body**:
  ```json
  {
    "type": "video", // or "audio"
    "participant_ids": ["user-uuid-1", "user-uuid-2"]
  }
  ```
- **Response**: Same as single call in Get Calls

#### Update a Call
- **Endpoint**: `PUT /api/calls/:id`
- **Request Body**:
  ```json
  {
    "status": "completed" // or "ongoing", "missed"
  }
  ```
- **Response**: Same as single call

#### Join a Call
- **Endpoint**: `POST /api/calls/:id/join`
- **Response**: Same as single call

#### Leave a Call
- **Endpoint**: `POST /api/calls/:id/leave`
- **Response**: Same as single call

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
- **Mark User as Online**:
  ```javascript
  socket.emit('user-online', 'YOUR_USER_ID', 'YOUR_BUSINESS_ID');
  ```
- **User Keep-alive**:
  ```javascript
  socket.emit('user-keep-alive', 'YOUR_USER_ID', 'YOUR_BUSINESS_ID');
  ```
- **Join Conversation Room**:
  ```javascript
  socket.emit('join-conversation', 'CONVERSATION_ID');
  ```

### Events to Listen For
- **Meeting Created**:
  ```javascript
  socket.on('meeting:created', (meeting) => {
    console.log('New meeting:', meeting);
  });
  ```
- **Meeting Updated**:
  ```javascript
  socket.on('meeting:updated', (meeting) => {
    console.log('Meeting updated:', meeting);
  });
  ```
- **Meeting Deleted**:
  ```javascript
  socket.on('meeting:deleted', (meetingId) => {
    console.log('Meeting deleted:', meetingId);
  });
  ```
- **Conversation Created**:
  ```javascript
  socket.on('conversation:created', (conversation) => {
    console.log('New conversation:', conversation);
  });
  ```
- **Message Created**:
  ```javascript
  socket.on('message:created', (message) => {
    console.log('New message:', message);
  });
  ```
- **Call Created**:
  ```javascript
  socket.on('call:created', (call) => {
    console.log('New call:', call);
  });
  ```
- **Call Updated**:
  ```javascript
  socket.on('call:updated', (call) => {
    console.log('Call updated:', call);
  });
  ```
- **Call Participant Joined**:
  ```javascript
  socket.on('call:participantJoined', ({ callId, userId }) => {
    console.log('Participant joined:', userId, 'in call:', callId);
  });
  ```
- **Call Participant Left**:
  ```javascript
  socket.on('call:participantLeft', ({ callId, userId }) => {
    console.log('Participant left:', userId, 'from call:', callId);
  });
  ```
- **User Presence Updated**:
  ```javascript
  socket.on('user-presence-updated', ({ userId, status }) => {
    console.log('User presence updated:', userId, 'is now', status);
    // Update your UI to show user's online/offline status
  });
  ```

---

## Jitsi Meet Integration

To integrate Jitsi Meet into your frontend, you can use the `@jitsi/react-sdk` or the iframe API:

### Iframe API Example
```javascript
const domain = 'meet.jit.si';
const options = {
  roomName: 'your-jitsi-room-id', // from call.jitsi_room_id
  width: '100%',
  height: '100%',
  parentNode: document.getElementById('jitsi-container'),
  configOverwrite: {
    startWithAudioMuted: true,
    startWithVideoMuted: true,
  },
  interfaceConfigOverwrite: {
    TOOLBAR_BUTTONS: [
      'microphone', 'camera', 'closedcaptions', 'desktop',
      'fullscreen', 'fodeviceselection', 'hangup', 'profile',
      'chat', 'recording', 'livestreaming', 'etherpad',
      'sharedvideo', 'settings', 'raisehand', 'videoquality',
      'filmstrip', 'invite', 'feedback', 'stats', 'shortcuts',
      'tileview', 'videobackgroundblur', 'download', 'help',
      'mute-everyone', 'security'
    ],
  },
};

const api = new JitsiMeetExternalAPI(domain, options);

// Listen for events
api.addEventListeners({
  readyToClose: () => {
    console.log('Call ended');
  },
  participantJoined: (data) => {
    console.log('Participant joined:', data);
  },
  participantLeft: (data) => {
    console.log('Participant left:', data);
  },
});
```

---
