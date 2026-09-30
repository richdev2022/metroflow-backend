import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * LiveKit → MediaSoup degradation in buildCallingCredentials.
 *
 * The production incident this guards against: LIVEKIT_* env vars configured
 * but the SFU down (502 behind the reverse proxy). mintJoinCredentials only
 * signs a JWT — it never touches the network — so without the reachability
 * gate the backend happily hands out tokens no client can use.
 */

vi.mock('../../db', () => ({
  query: vi.fn().mockImplementation(async () => ({ rows: [] })),
}));

let configured = true;
let reachable = true;

vi.mock('../lib/calling/livekit', () => ({
  livekitProvider: {
    name: 'livekit',
    label: 'LiveKit',
    isConfigured: () => configured,
    async mintJoinCredentials(ctx: any) {
      if (!configured) throw new Error('LiveKit is not configured');
      return {
        serverUrl: 'wss://livekit.example.com',
        roomName: ctx.roomId,
        token: 'lk-jwt',
        tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    },
    async endSession() {},
  },
  isLiveKitConfigured: () => configured,
  isLiveKitReachable: async () => reachable,
}));

vi.mock('../lib/calling/mediasoup', () => ({
  mediasoupProvider: {
    name: 'mediasoup',
    label: 'MediaSoup (self-hosted)',
    isConfigured: () => true,
    async healthCheck() {
      return { enabled: true, configured: true, healthy: true, details: {} };
    },
    async mintJoinCredentials(ctx: any) {
      return { roomName: ctx.roomId };
    },
    async endSession() {},
    // no startRecording/stopRecording — capability = method absence
  },
}));

import { buildCallingCredentials } from '../lib/calling/factory';
import { livekitProvider } from '../lib/calling/livekit';
import { mediasoupProvider } from '../lib/calling/mediasoup';
import type { CallingJoinContext } from '../lib/calling/types';

function ctx(overrides: Partial<CallingJoinContext> = {}): CallingJoinContext {
  return {
    roomType: 'call',
    roomId: 'room-1',
    title: 'Test call',
    identity: 'user-1',
    displayName: 'Test User',
    isHost: false,
    remainingSeconds: 1800,
    maxParticipants: null,
    ...overrides,
  };
}

beforeEach(() => {
  configured = true;
  reachable = true;
});

describe('buildCallingCredentials degradation', () => {
  it('mints LiveKit credentials when configured and reachable', async () => {
    const creds = await buildCallingCredentials(livekitProvider, ctx());
    expect(creds?.provider).toBe('livekit');
    expect(creds?.token).toBe('lk-jwt');
    expect(creds?.serverUrl).toBe('wss://livekit.example.com');
    expect(creds?.fallback).toBeFalsy();
  });

  it('degrades to MediaSoup when the LiveKit server is unreachable', async () => {
    reachable = false;
    const creds = await buildCallingCredentials(livekitProvider, ctx());
    expect(creds?.provider).toBe('mediasoup');
    expect(creds?.token).toBeUndefined();
    expect(creds?.fallback).toBe(true);
    expect(String(creds?.fallbackReason)).toMatch(/unreachable/i);
  });

  it('degrades to MediaSoup when LiveKit is not configured', async () => {
    configured = false;
    const creds = await buildCallingCredentials(livekitProvider, ctx());
    expect(creds?.provider).toBe('mediasoup');
    expect(creds?.fallback).toBe(true);
    expect(String(creds?.fallbackReason)).toMatch(/not configured/i);
  });

  it('keeps MediaSoup rooms on MediaSoup without probing', async () => {
    reachable = false; // LiveKit down must not affect mediasoup rooms
    const creds = await buildCallingCredentials(mediasoupProvider, ctx());
    expect(creds?.provider).toBe('mediasoup');
    expect(creds?.fallback).toBeFalsy();
    expect(creds?.roomName).toBe('room-1');
  });
});
