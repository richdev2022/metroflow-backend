import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creditRevenueWallet, creditPlatformWallet, debitPlatformWallet } from '../fees';
import * as db from '../../db';

// Mock DB: query returns { rows: [] } unless a per-test override is set.
vi.mock('../../db', () => ({
  query: vi.fn().mockImplementation(async () => ({ rows: [] })),
}));

const mockedQuery = vi.mocked(db.query);

beforeEach(() => {
  mockedQuery.mockReset();
  mockedQuery.mockImplementation(async (sql: any) => {
    const s = String(sql || '');
    // getOrCreateInternalWallet: SELECT id FROM wallets / INSERT ... RETURNING id
    if (/SELECT id FROM wallets/i.test(s) || /RETURNING id/i.test(s)) {
      return { rows: [{ id: 'pw-1' }] } as any;
    }
    return { rows: [] } as any;
  });
});

/** Capture every INSERT INTO transactions as { sql, params }. */
function insertedTransactionRows(): { sql: string; params: any[] }[] {
  const rows: { sql: string; params: any[] }[] = [];
  for (const call of mockedQuery.mock.calls) {
    const sql = String(call[0] || '');
    if (/INSERT INTO transactions/i.test(sql)) {
      rows.push({ sql, params: (call[1] as any[]) || [] });
    }
  }
  return rows;
}

describe('creditRevenueWallet', () => {
  it('writes the revenue row linked to the reference with the explicit description', async () => {
    await creditRevenueWallet(500, 'NGN', 'SUB-REF-1', 'Subscription Payment', 'squad', 'Platform Wallet Debit for Subscription Revenue');

    const inserts = insertedTransactionRows();
    // Exactly 2 transaction inserts: platform mirror + revenue row
    expect(inserts.length).toBe(2);

    // Revenue row SQL carries transaction_type 'fee' and direction 'credit'
    const revenue = inserts.find((r) => /'fee'/.test(r.sql) && /'credit'/.test(r.sql) && r.params.length === 5);
    expect(revenue).toBeTruthy();
    expect(revenue!.params[0]).toBe(500); // amount
    expect(revenue!.params[2]).toContain('SUB-REF-1'); // reference linkage
    expect(revenue!.params[3]).toBe('Subscription Payment'); // description

    // Platform mirror row (9 SQL columns -> 8 params) with mirror description
    const mirror = inserts.find((r) => /'platform'/.test(r.sql));
    expect(mirror).toBeTruthy();
    expect(mirror!.params[4]).toBe('Platform Wallet Debit for Subscription Revenue');
  });

  it('is idempotent: skips the revenue row when the reference already exists', async () => {
    mockedQuery.mockImplementation(async (sql: any) => {
      const s = String(sql || '');
      if (/SELECT id FROM transactions WHERE reference = \$1 AND transaction_type = 'fee'/i.test(s)) {
        return { rows: [{ id: 'exists' }] } as any;
      }
      if (/SELECT id FROM wallets/i.test(s) || /RETURNING id/i.test(s)) {
        return { rows: [{ id: 'pw-1' }] } as any;
      }
      return { rows: [] } as any;
    });

    await creditRevenueWallet(500, 'NGN', 'SUB-REF-2', 'Subscription Payment', 'squad');

    const inserts = insertedTransactionRows();
    // Only the platform mirror insert may run; the revenue row is skipped
    expect(inserts.length).toBe(1);
    expect(inserts[0].params.length).toBe(8);
  });
});

describe('platform pool helpers', () => {
  it('creditPlatformWallet records a platform ledger row (gross inflow)', async () => {
    await creditPlatformWallet(505, 'NGN', 'FUND-REF-1', 'Customer Wallet Funding Received (Card)', 'squad');

    const inserts = insertedTransactionRows();
    expect(inserts.length).toBe(1);
    expect(inserts[0].params[0]).toBe(505);
    expect(inserts[0].params[3]).toBe('credit');
    expect(inserts[0].sql).toContain("'platform'");
  });

  it('debitPlatformWallet records a platform debit row (user payout)', async () => {
    await debitPlatformWallet(500, 'NGN', 'FUND-REF-1-USER', 'Platform Wallet Debit for User Funding', 'squad');

    const inserts = insertedTransactionRows();
    expect(inserts.length).toBe(1);
    expect(inserts[0].params[0]).toBe(500);
    expect(inserts[0].params[3]).toBe('debit');
    expect(inserts[0].sql).toContain("'platform'");
  });

  it('ignores zero-amount movements', async () => {
    await creditPlatformWallet(0, 'NGN', 'ZERO-1', 'nothing');
    await creditRevenueWallet(0, 'NGN', 'ZERO-2', 'nothing');
    expect(insertedTransactionRows().length).toBe(0);
  });
});
