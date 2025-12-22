
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendCommentNotification } from '../email';

// Mock DB
vi.mock('../../db', () => ({
  query: vi.fn()
}));

// Mock Email Sender
vi.mock('../email-sender', () => ({
  sendEmail: vi.fn().mockResolvedValue(true)
}));

import { query } from '../../db';
import { sendEmail } from '../email-sender';

describe('sendCommentNotification Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send email to other users in the business, excluding the actor', async () => {
    // Mock DB returning 3 users: Actor, Recipient1, Recipient2
    (query as any).mockResolvedValue({
      rows: [
        { id: '1', name: 'Actor User', email: 'actor@test.com' },
        { id: '2', name: 'Recipient One', email: 'r1@test.com' },
        { id: '3', name: 'Recipient Two', email: 'r2@test.com' }
      ]
    });

    await sendCommentNotification(
      'biz-id-1',
      'added',
      'Hello world',
      'Actor User',
      'My Task',
      'task'
    );

    // Verify DB was queried correctly
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id, name, email FROM users'),
      ['biz-id-1']
    );

    // Verify sendEmail was called exactly twice (for r1 and r2)
    expect(sendEmail).toHaveBeenCalledTimes(2);

    // Check arguments for first recipient
    expect(sendEmail).toHaveBeenCalledWith(
      'r1@test.com',
      'Recipient One',
      expect.stringContaining('Comment added on task: My Task'),
      expect.stringContaining('Hello world')
    );

    // Check arguments for second recipient
    expect(sendEmail).toHaveBeenCalledWith(
      'r2@test.com',
      'Recipient Two',
      expect.stringContaining('Comment added on task: My Task'),
      expect.stringContaining('Hello world')
    );

    // Verify Actor was NOT emailed
    expect(sendEmail).not.toHaveBeenCalledWith(
      'actor@test.com',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('should NOT send any emails if only the actor is in the business', async () => {
    // Mock DB returning only Actor
    (query as any).mockResolvedValue({
      rows: [
        { id: '1', name: 'Actor User', email: 'actor@test.com' }
      ]
    });

    await sendCommentNotification(
      'biz-id-1',
      'added',
      'Hello world',
      'Actor User',
      'My Task',
      'task'
    );

    expect(sendEmail).not.toHaveBeenCalled();
  });
});
