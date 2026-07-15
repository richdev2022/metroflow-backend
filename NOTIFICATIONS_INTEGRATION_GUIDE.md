# Notifications Feature - Frontend Integration Guide

## Overview
The notifications feature allows users to receive real-time updates about events like meeting invitations, wallet credits, task assignments, and more. Notifications can be viewed in-app, marked as read, and actionable notifications allow users to take direct actions (e.g., accept a meeting invitation).

## Flow Diagram
1. **Backend Creates Notification**: When an event occurs (e.g., meeting created, wallet credited), the backend creates a `Notification` record in the database and emits a socket event.
2. **Frontend Receives Socket Event**: The frontend listens for the `notification:new` event to get real-time updates.
3. **Frontend Fetches Notifications**: The frontend fetches notifications via the API to display to the user.
4. **User Interacts with Notifications**: The user can mark notifications as read, mark all as read, or take action on actionable notifications.

## Socket Events
### `notification:new`
Triggered when a new notification is created for the user.
**Payload**:
```json
{
  "id": "uuid",
  "businessId": "uuid",
  "userId": "uuid",
  "type": "meeting | task | chat | call | credit | debit | ...",
  "title": "string",
  "message": "string",
  "actionUrl": "string | null",
  "actionType": "string | null",
  "metadata": "object | null",
  "isRead": false,
  "isActionable": false,
  "actionTaken": "string | null",
  "createdAt": "ISO 8601 timestamp",
  "expiresAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp"
}
```

## API Endpoints
All endpoints require authentication (JWT token via `Authorization: Bearer <token>` header).

---

### 1. Get Notifications
Retrieve a paginated list of notifications for the authenticated user.

**Endpoint**: `GET /notifications` or `GET /api/notifications`

**Query Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| page | number | No | 1 | Page number to retrieve |
| limit | number | No | 20 | Number of notifications per page |
| unreadOnly | boolean | No | false | If true, only return unread notifications |

**Response**:
```json
{
  "success": true,
  "data": {
    "notifications": [
      {
        "id": "uuid",
        "businessId": "uuid",
        "userId": "uuid",
        "type": "meeting",
        "title": "Meeting Invitation",
        "message": "John Doe invited you to a meeting: Sprint Planning",
        "actionUrl": "/meetings/ABC123",
        "actionType": "view_meeting",
        "metadata": {
          "meetingId": "uuid",
          "meetingCode": "ABC123"
        },
        "isRead": false,
        "isActionable": false,
        "actionTaken": null,
        "createdAt": "2026-07-15T20:20:26.057Z",
        "expiresAt": "2026-07-16T20:20:26.057Z",
        "updatedAt": "2026-07-15T20:20:26.057Z"
      }
    ],
    "total": 1
  }
}
```

---

### 2. Mark Notification as Read
Mark a single notification as read.

**Endpoint**: `PATCH /notifications/:id/read` or `PATCH /api/notifications/:id/read`

**Path Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Yes | ID of the notification to mark as read |

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "businessId": "uuid",
    "userId": "uuid",
    "type": "meeting",
    "title": "Meeting Invitation",
    "message": "John Doe invited you to a meeting: Sprint Planning",
    "actionUrl": "/meetings/ABC123",
    "actionType": "view_meeting",
    "metadata": {
      "meetingId": "uuid",
      "meetingCode": "ABC123"
    },
    "isRead": true,
    "isActionable": false,
    "actionTaken": null,
    "createdAt": "2026-07-15T20:20:26.057Z",
    "expiresAt": "2026-07-16T20:20:26.057Z",
    "updatedAt": "2026-07-15T20:25:26.057Z"
  }
}
```

---

### 3. Mark All Notifications as Read
Mark all notifications for the authenticated user as read.

**Endpoint**: `PATCH /notifications/read-all` or `PATCH /api/notifications/read-all`

**Response**:
```json
{
  "success": true
}
```

---

### 4. Take Action on Notification
Take an action on an actionable notification (e.g., accept a call, decline an invitation).

**Endpoint**: `POST /notifications/:id/action` or `POST /api/notifications/:id/action`

**Path Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Yes | ID of the notification to take action on |

**Request Body**:
```json
{
  "action": "string" // e.g., "accept", "decline", "view"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "businessId": "uuid",
    "userId": "uuid",
    "type": "call",
    "title": "Incoming Call",
    "message": "John Doe is calling you",
    "actionUrl": "/calls/XYZ789",
    "actionType": "accept_call",
    "metadata": {
      "callId": "uuid",
      "callCode": "XYZ789"
    },
    "isRead": true,
    "isActionable": true,
    "actionTaken": "accept",
    "createdAt": "2026-07-15T20:20:26.057Z",
    "expiresAt": "2026-07-16T20:20:26.057Z",
    "updatedAt": "2026-07-15T20:25:26.057Z"
  }
}
```

## Notification Types
| Type | Description | Action Type (if applicable) |
|------|-------------|------------------------------|
| `meeting` | Meeting invitation | `view_meeting` |
| `task` | Task assigned/updated | `view_task` |
| `chat` | New chat message | `view_chat` |
| `call` | Incoming call | `accept_call`, `decline_call` |
| `credit` | Wallet credited | `view_wallet` |
| `debit` | Wallet debited | `view_wallet` |

## Integration Steps
1. **Listen for Socket Events**: Add a listener for the `notification:new` event to update the UI in real-time.
2. **Fetch Notifications**: Use the `GET /notifications` endpoint to retrieve notifications on page load and after receiving a new notification.
3. **Display Notifications**: Render notifications in the UI, showing unread notifications differently (e.g., bold text, badge).
4. **Implement Interactions**:
   - Add a "Mark as Read" button for individual notifications.
   - Add a "Mark All as Read" button.
   - For actionable notifications, add action buttons (e.g., "Accept", "Decline", "View").
5. **Update UI**: After each interaction, update the local state to reflect the changes without refetching all notifications (or refetch to ensure consistency).
