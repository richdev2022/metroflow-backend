# Call & Meeting Duration Implementation Guide

## Overview

This guide explains how to integrate the new call and meeting duration functionality works and what the frontend needs to implement.

## Backend Features Implemented

### 1. Pricing Plan Configuration
- Each pricing plan now has a `maxMeetingDuration` field (in minutes) that defines the maximum allowed duration for calls/meetings.

### 2. Call/Meeting End Time Calculation
- When a call is created, the backend automatically calculates and sets an `endedAt` timestamp based on the plan's `maxMeetingDuration`.
- The `endedAt` = `startedAt` + `maxMeetingDuration` * 60000 (converting minutes to milliseconds).

### 3. Automatic Ending
- A background process runs every 10 seconds to check for expired calls/meetings and automatically ends them.
- When a call/meeting expires, the status is updated to 'completed' and a `call:ended` event is emitted to all participants.

## Frontend Implementation Steps

### 1. Display Countdown Timer
When joining a call/meeting via the `call:participants-list` event, the frontend will receive `endsAt` and `maxMeetingDuration`. The frontend should:
- Parse `endsAt` to display a countdown timer showing how much time is remaining.
- The timer should count down from the remaining time.
- When the timer reaches 0, the frontend should handle the call ending.

```typescript
// Example countdown implementation
let countdownInterval: number | null = null;

// In the call/meeting join handler:
socket.on('call:participants-list', (data) => {
  if (data.endsAt) {
    startCountdown(new Date(data.endsAt));
  }
});

function startCountdown(endsAt: Date) {
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }
  
  countdownInterval = window.setInterval(() => {
    const now = new Date();
    const diff = endsAt.getTime() - now.getTime();
    
    if (diff <= 0) {
      clearInterval(countdownInterval!);
      return;
    }
    
    // Convert diff is in milliseconds, convert to minutes:seconds
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    
    // Update UI with countdown
    console.log(`Time remaining: ${minutes}:${seconds.toString().padStart(2, '0')});
  }, 1000);
}

// When leaving call handler
socket.on('call:ended', () => {
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }
  // Handle call ended UI
});
```

### 2. Handle Call Ended Event
The frontend must listen for the `call:ended` event and handle it:
- Show a message to the user that the call has ended
- Disconnect from the call
- Clean up any media streams
- Navigate back to the dashboard or call history

```typescript
socket.on('call:ended', () => {
  // Stop all media tracks
  const localTracks.forEach(track => track.stop());
  // Navigate to call ended screen
  console.log('Call ended due to duration limit');
});
```

### 3. Call/Meeting Creation
The backend already handles calculating `endedAt` when a call is created, so no changes are needed for this step.

## Socket Events

### Events Emitted by Backend
- `call:participants-list` (updated)`: Includes `endsAt` and `maxMeetingDuration`
- `call:ended`: Emitted when the call/meeting ends (either manually or automatically)
