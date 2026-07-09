
# Admin Guide: Self-Hosted WebRTC Configuration

This guide provides all the necessary information for administrators to configure and manage the self-hosted WebRTC system.

---

## Table of Contents

1. [Overview](#overview)
2. [Initial Setup](#initial-setup)
   - [Environment Variables](#environment-variables)
   - [Prisma Migration](#prisma-migration)
3. [Permissions &amp; Plans](#permissions--plans)
   - [Available RTC Permissions](#available-rtc-permissions)
   - [Pricing Plan Configuration](#pricing-plan-configuration)
     - [Create/Update Plan API](#createupdate-plan-api)
     - [Plan Fields](#plan-fields)
4. [Monitoring &amp; Maintenance](#monitoring--maintenance)

---

## Overview

This system replaces Jitsi with a fully self-hosted WebRTC infrastructure using Socket.io for signaling, mediasoup as SFU, and Coturn for STUN/TURN.

---

## Initial Setup

### Environment Variables

Add the following variables to your `.env` file:

```env
# Mediasoup Configuration
MEDIASOUP_ANNOUNCED_IP=your-server-public-ip  # Use 127.0.0.1 for local development
```

#### MEDIASOUP_ANNOUNCED_IP Explained

The `MEDIASOUP_ANNOUNCED_IP` environment variable tells mediasoup the public IP address where your server is running. This is crucial because:

- When mediasoup creates WebRTC transports, it includes ICE candidates that clients use to connect to your server.
- For NAT traversal, mediasoup needs to know its public IP so it can provide the correct ICE candidates.

**How to find your server's public IP:**
- On Linux/macOS: Run `curl ifconfig.me`
- On Windows: Use `nslookup myip.opendns.com resolver1.opendns.com`
- For cloud providers (AWS/GCP/Azure): It's your instance's public IP.

**Local Development:**
- Use `127.0.0.1`

**Production:**
- Use your server's actual public IP address (e.g., `192.0.2.100`)

---

### Prisma Migration

After updating the Prisma schema, apply the migrations to your database:

```bash
# Generate migration files
npx prisma migrate dev --name rtc-migration

# Apply migrations
npx prisma migrate deploy
```

---

| `rtc.video_call`             | Feature | Make and receive one-to-one video calls                                     |
| `rtc.group_call`             | Feature | Start and join group calls                                                  |
| `rtc.instant_meeting`        | Feature | Start instant, unscheduled meetings                                         |
| `rtc.schedule_meeting`       | Feature | Schedule meetings in advance                                                |
| `rtc.recording`              | Feature | Start, stop, and view meeting recordings                                    |
| `rtc.screen_share`           | Feature | Share your screen during calls/meetings                                     |
| `rtc.file_share`             | Feature | Share files during calls/meetings (future)                                  |
| `rtc.chat`                   | Feature | Send and receive in-meeting chat messages                                   |
| `rtc.raise_hand`             | Feature | Raise your hand during calls/meetings                                       |
| `rtc.waiting_room`           | Feature | Enable waiting room for meetings/calls                                      |
| `rtc.breakout_room`          | Feature | Create and manage breakout rooms (future)                                  |
| `rtc.host_controls`          | Feature | Full host controls over meetings/calls                                      |
| `rtc.co_host`                | Feature | Assign co-hosts to help manage meetings                                     |
| `rtc.meeting_password`       | Feature | Set and use passwords for meetings/calls                                    |
| `rtc.join_by_code`           | Feature | Allow participants to join via meeting/call code                            |
| `rtc.join_by_link`           | Feature | Allow participants to join via invite link                                  |
| `rtc.allow_guest_join`       | Feature | Allow guests outside the business to join (future)                          |
| `rtc.max_meeting_duration`   | Limit   | Configure maximum meeting duration limits                                   |
| `rtc.max_participants`       | Limit   | Configure maximum number of participants                                    |
| `rtc.max_recording_storage`  | Limit   | Configure maximum recording storage limit                                   |
| `rtc.max_recording_duration` | Limit   | Configure maximum individual recording duration                             |
| `rtc.analytics`              | Feature | View analytics for calls and meetings (future)                              |

---

### Pricing Plan Configuration

Plan configuration has two parts:
1. **Permissions array**: Which features are enabled for the plan
2. **RTC limits and toggles**: Numeric limits and boolean feature toggles at the plan level

#### Create/Update Plan API

Use the existing admin endpoints to manage pricing plans:

##### Get All Plans
```http
GET /admin/pricing
Authorization: Bearer <admin-token>
```

##### Create Plan
```http
POST /admin/pricing
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "Pro Plan",
  "price": 99,
  "currency": "USD",
  "duration": "monthly",
  "discount": 0,
  "features": ["All Features", "Unlimited Users", "Priority Support"],
  "permissions": [
    "view_dashboard",
    "manage_tasks",
    "use_meetings",
    "use_chat",
    "use_calls",
    "rtc.audio_call",
    "rtc.video_call",
    "rtc.recording",
    "rtc.screen_share"
  ],
  "maxMeetingDuration": 180,
  "maxParticipants": 100,
  "maxRecordingDuration": 120,
  "maxRecordingStorage": 10240,
  "waitingRoomEnabled": true,
  "recordingEnabled": true,
  "screenSharingEnabled": true,
  "breakoutRoomsEnabled": false,
  "virtualBackgrounds": false,
  "liveCaptions": false
}
```

##### Update Plan
```http
PUT /admin/pricing/:id
Authorization: Bearer <admin-token>
Content-Type: application/json
## Permissions &amp; Plans

### Available RTC Permissions

All RTC permissions start with the `rtc.` prefix, plus the core `use_*` permissions. Use the existing admin interface to assign these permissions to users and configure plan limits:

| Permission Key               | Type    | Description                                                                 |
|------------------------------|---------|-----------------------------------------------------------------------------|
| `use_meetings`               | Core    | Allow access to meetings feature                                            |
| `use_chat`                   | Core    | Allow access to chat feature                                                |
| `use_calls`                  | Core    | Allow access to calls feature                                               |
| `rtc.audio_call`             | Feature | Make and receive one-to-one audio calls                                     |

{
  "price": 119,
  "maxParticipants": 150,
  "recordingEnabled": true
}
```

---

#### Plan Fields

Here are all the available fields for creating/updating a pricing plan:

| Field                      | Type               | Required | Description                                                                 |
|----------------------------|--------------------|----------|-----------------------------------------------------------------------------|
| `name`                     | string             | Yes      | Plan name                                                                   |
| `price`                    | number             | Yes      | Plan price in specified currency                                            |
| `currency`                 | string             | Yes      | Currency code (e.g., "USD", "NGN")                                          |
| `duration`                 | string             | Yes      | Billing cycle: "monthly" or "yearly"                                        |
| `discount`                 | number             | No       | Discount amount (applied to price)                                          |
| `features`                 | array&lt;string&gt; | No       | Human-readable feature list                                                  |
| `permissions`              | array&lt;string&gt; | No       | Array of permission keys that this plan grants                              |
| `is_active`                | boolean            | No       | Whether the plan is active (true by default when creating)                  |
| ---                        | ---                | ---      | ---                                                                         |
| **RTC Limits**             | ---                | ---      | ---                                                                         |
| `maxMeetingDuration`       | integer (minutes)  | No       | Max duration per meeting/call (null for unlimited)                          |
| `maxParticipants`          | integer            | No       | Max participants per meeting/call (null for unlimited)                      |
| `maxRecordingDuration`     | integer (minutes)  | No       | Max duration per recording (null for unlimited)                             |
| `maxRecordingStorage`      | integer (MB)       | No       | Max total recording storage (null for unlimited)                            |
| ---                        | ---                | ---      | ---                                                                         |
| **RTC Toggles**            | ---                | ---      | ---                                                                         |
| `waitingRoomEnabled`       | boolean            | No       | Allow waiting room for meetings/calls                                       |
| `recordingEnabled`         | boolean            | No       | Enable meeting/call recording                                               |
| `screenSharingEnabled`     | boolean            | No       | Allow screen sharing                                                        |
| `breakoutRoomsEnabled`     | boolean            | No       | Enable breakout rooms                                                       |
| `virtualBackgrounds`       | boolean            | No       | Allow virtual backgrounds                                                   |
| `liveCaptions`             | boolean            | No       | Enable live captions                                                        |

---

## Monitoring &amp; Maintenance

### Check Mediasoup Status

If you encounter WebRTC connection issues, verify that mediasoup is initialized correctly by checking your backend logs.

### Logs

All RTC-related activity is logged using Winston. Check your logs for:
- WebRTC signaling events
- Mediasoup worker status
- Recording start/stop events
- Call/meeting lifecycle events

### Cleanup

Implement cleanup jobs to:
- Remove old meeting/call recordings
- Archive historical call/meeting data

---

## Future Improvements

- [ ] Coturn STUN/TURN integration for better NAT traversal
- [ ] Analytics dashboard
- [ ] Virtual backgrounds
- [ ] Live captions

