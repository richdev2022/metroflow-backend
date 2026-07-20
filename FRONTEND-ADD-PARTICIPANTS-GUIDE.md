# Frontend Add Participants Guide

This guide explains how to use the new "Add Participants" feature for both meetings and calls!

## Table of Contents

1. [API Endpoints](#api-endpoints)
2. [Socket Events](#socket-events)
3. [Usage Examples](#usage-examples)
4. [Reusable React Component](#reusable-react-component)

## API Endpoints

### Add Participants to Meeting
**Endpoint**: `POST /api/meetings/:meetingId/participants`
**Auth**: Requires bearer token
**Request Body**:
```json
{
  "participantIds": ["user-id-1", "user-id-2"]
}
```
**Success Response (200 OK)**:
```json
{
  "success": true,
  "message": "2 participant(s) added",
  "data": { "added": ["user-id-1", "user-id-2"] }
}
```

### Add Participants to Call
**Endpoint**: `POST /api/calls/:callId/participants`
**Auth**: Requires bearer token
**Request Body**:
```json
{
  "participantIds": ["user-id-1", "user-id-2"]
}
```
**Success Response (200 OK)**:
```json
{
  "success": true,
  "message": "2 participant(s) added",
  "data": { "added": ["user-id-1", "user-id-2"] }
}
```

## Socket Events

Both endpoints emit socket events to keep the UI updated!
- **Meeting**: `meeting:updated` - sent to the business channel
- **Call**: `call:updated` - sent to the call channel, and `call:incoming` sent to each new participant

## Usage Examples

### Example 1: Adding participants to a meeting (JavaScript/TypeScript)
```typescript
import type { AddParticipantsInput, AddParticipantsResponse } from '@shared/api';

const addMeetingParticipants = async (
  meetingId: string,
  participantIds: string[]
): Promise<AddParticipantsResponse> => {
  const response = await fetch(`/api/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('token')}`,
    },
    body: JSON.stringify({ participantIds } as AddParticipantsInput),
  });

  if (!response.ok) {
    throw new Error('Failed to add participants');
  }

  return (await response.json()) as AddParticipantsResponse;
};
```

### Example 2: Adding participants to a call
```typescript
import type { AddParticipantsInput, AddParticipantsResponse } from '@shared/api';

const addCallParticipants = async (
  callId: string,
  participantIds: string[]
): Promise<AddParticipantsResponse> => {
  const response = await fetch(`/api/calls/${callId}/participants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('token')}`,
    },
    body: JSON.stringify({ participantIds } as AddParticipantsInput),
  });

  if (!response.ok) {
    throw new Error('Failed to add participants');
  }

  return (await response.json()) as AddParticipantsResponse;
};
```

## Reusable React Component

Here's a reusable component you can use for both meetings and calls!

```tsx
import React, { useState } from 'react';
import type { AddParticipantsInput, AddParticipantsResponse, TeamMember } from '@shared/api';

type RoomType = 'meeting' | 'call';

interface AddParticipantsProps {
  roomId: string;
  roomType: RoomType;
  currentParticipantIds: string[];
  allTeamMembers: TeamMember[];
  onParticipantsAdded?: (addedIds: string[]) => void;
}

export const AddParticipantsModal: React.FC<AddParticipantsProps> = ({
  roomId,
  roomType,
  currentParticipantIds,
  allTeamMembers,
  onParticipantsAdded,
}) => {
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const availableUsers = allTeamMembers.filter(
    (user) => !currentParticipantIds.includes(user.id)
  );

  const handleAddParticipants = async () => {
    if (selectedUserIds.length === 0) {
      setError('Please select at least one participant');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const endpoint =
        roomType === 'meeting'
          ? `/api/meetings/${roomId}/participants`
          : `/api/calls/${roomId}/participants`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({
          participantIds: selectedUserIds,
        } as AddParticipantsInput),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to add participants');
      }

      const data = (await response.json()) as AddParticipantsResponse;
      setSuccess(data.message);
      setSelectedUserIds([]);
      onParticipantsAdded?.(data.data.added);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId]
    );
  };

  return (
    <div style={{ padding: '20px', maxWidth: '500px', margin: '0 auto' }}>
      <h2>Add Participants</h2>
      
      {error && (
        <div style={{ color: 'red', padding: '10px', border: '1px solid red', borderRadius: '4px', marginBottom: '10px' }}>
          {error}
        </div>
      )}
      
      {success && (
        <div style={{ color: 'green', padding: '10px', border: '1px solid green', borderRadius: '4px', marginBottom: '10px' }}>
          {success}
        </div>
      )}

      <div style={{ marginBottom: '20px', maxHeight: '300px', overflowY: 'auto' }}>
        {availableUsers.map((user) => (
          <div
            key={user.id}
            style={{
              padding: '10px',
              border: `1px solid ${selectedUserIds.includes(user.id) ? 'blue' : '#ccc'}`,
              borderRadius: '4px',
              marginBottom: '8px',
              cursor: 'pointer',
            }}
            onClick={() => toggleUserSelection(user.id)}
          >
            <div style={{ fontWeight: 'bold' }}>{user.name}</div>
            <div style={{ color: '#666', fontSize: '14px' }}>{user.email}</div>
          </div>
        ))}
      </div>

      <button
        onClick={handleAddParticipants}
        disabled={loading || selectedUserIds.length === 0}
        style={{
          padding: '10px 20px',
          backgroundColor: '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: loading || selectedUserIds.length === 0 ? 'not-allowed' : 'pointer',
          opacity: loading || selectedUserIds.length === 0 ? 0.5 : 1,
        }}
      >
        {loading ? 'Adding...' : `Add ${selectedUserIds.length} Participant${selectedUserIds.length !== 1 ? 's' : ''}`}
      </button>
    </div>
  );
};
```

## Usage in Your App

```tsx
// Example: Using the component for a meeting
<AddParticipantsModal
  roomId="meeting-123"
  roomType="meeting"
  currentParticipantIds={existingMeetingAttendeeIds}
  allTeamMembers={teamMembers}
  onParticipantsAdded={(addedIds) => {
    console.log('Added participants:', addedIds);
    // Optionally refresh your meeting data
  }}
/>

// Example: Using the component for a call
<AddParticipantsModal
  roomId="call-456"
  roomType="call"
  currentParticipantIds={existingCallParticipantIds}
  allTeamMembers={teamMembers}
  onParticipantsAdded={(addedIds) => {
    console.log('Added participants:', addedIds);
    // Optionally refresh your call data
  }}
/>
```

That's it! You now have a fully functional "Add Participants" feature that works for both meetings and calls!
