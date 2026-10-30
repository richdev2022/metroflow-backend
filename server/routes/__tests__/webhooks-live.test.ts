import { describe, it, expect, vi, beforeEach } from 'vitest';
import { liveWebhookFeed } from '../admin';
import * as db from '../../db';

vi.mock('../../db', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

const mkRes = () => {
  const res: any = {
    statusCode: 200,
    body: null as any,
    status: vi.fn().mockReturnThis(),
    json: vi.fn((j: any) => { res.body = j; return res; }),
  };
  return res;
};

describe('GET /admin/webhooks/live (live alarm feed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.query as any).mockResolvedValue({ rows: [] });
  });

  it('baseline call (no after) returns only the watermark and no events', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ m: new Date('2026-10-30T12:00:00Z') }] });
    const res = mkRes();
    await liveWebhookFeed({ query: {} } as any, res);

    // Exactly one query — the MAX watermark probe; no events query.
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String((db.query as any).mock.calls[0][0])).toContain('MAX(created_at)');
    expect(res.body).toEqual({
      success: true,
      watermark: '2026-10-30T12:00:00.000Z',
      events: [],
    });
  });

  it('baseline with no alarm history starts from the epoch watermark', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ m: null }] });
    const res = mkRes();
    await liveWebhookFeed({ query: {} } as any, res);
    expect(res.body.watermark).toBe('1970-01-01T00:00:00.000Z');
    expect(res.body.events).toEqual([]);
  });

  it('poll with after returns events oldest-first and advances the watermark to the newest row', async () => {
    const rows = [
      { id: 'a', provider: 'sogo', event_type: 'transaction.failed', reference: 'REF-1', status: 'failed', signature_valid: true, error: 'provider decline', created_at: new Date('2026-10-30T12:00:01Z') },
      { id: 'b', provider: 'prestmit', event_type: 'unknown', reference: null, status: 'rejected', signature_valid: false, error: 'Invalid webhook signature', created_at: new Date('2026-10-30T12:00:02Z') },
    ];
    (db.query as any).mockResolvedValueOnce({ rows });
    const res = mkRes();
    await liveWebhookFeed({ query: { after: '2026-10-30T11:59:00.000Z' } } as any, res);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (db.query as any).mock.calls[0];
    expect(String(sql)).toContain("status IN ('rejected', 'failed')");
    expect(String(sql)).toContain('created_at >= $1');
    expect(params).toEqual(['2026-10-30T11:59:00.000Z', 10]);

    expect(res.body.watermark).toBe('2026-10-30T12:00:02.000Z');
    expect(res.body.events.map((e: any) => e.id)).toEqual(['a', 'b']); // oldest-first
    expect(res.body.events[0]).not.toHaveProperty('payload'); // payloads stay on the feed screen
  });

  it('poll with no new events keeps the caller watermark unchanged', async () => {
    const res = mkRes();
    await liveWebhookFeed({ query: { after: '2026-10-30T12:00:02.000Z' } } as any, res);
    expect(res.body.watermark).toBe('2026-10-30T12:00:02.000Z');
    expect(res.body.events).toEqual([]);
  });

  it('clamps limit into the 1..25 range and defaults it to 10', async () => {
    const res = mkRes();
    await liveWebhookFeed({ query: { after: '2026-10-30T12:00:00.000Z', limit: '999' } } as any, res);
    expect((db.query as any).mock.calls[0][1]).toEqual(['2026-10-30T12:00:00.000Z', 25]);

    vi.clearAllMocks();
    (db.query as any).mockResolvedValue({ rows: [] });
    const res2 = mkRes();
    await liveWebhookFeed({ query: { after: '2026-10-30T12:00:00.000Z', limit: 'not-a-number' } } as any, res2);
    expect((db.query as any).mock.calls[0][1]).toEqual(['2026-10-30T12:00:00.000Z', 10]);
  });

  it('treats an unparseable after as a baseline instead of erroring', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ m: new Date('2026-10-30T12:30:00Z') }] });
    const res = mkRes();
    await liveWebhookFeed({ query: { after: 'garbage' } } as any, res);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String((db.query as any).mock.calls[0][0])).toContain('MAX(created_at)');
    expect(res.body.events).toEqual([]);
    expect(res.body.watermark).toBe('2026-10-30T12:30:00.000Z');
  });

  it('answers 500 without throwing when the DB query fails', async () => {
    (db.query as any).mockRejectedValueOnce(new Error('db down'));
    const res = mkRes();
    await liveWebhookFeed({ query: { after: '2026-10-30T12:00:00.000Z' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.success).toBe(false);
  });
});
