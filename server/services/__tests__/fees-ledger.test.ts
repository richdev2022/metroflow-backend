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
    // getOrCreateInternalWallet / platform_wallet lookups
    if (/SELECT id FROM wallets/i.test(s) || /SELECT id FROM platform_wallet/i.test(s) || /RETURNING id/i.test(s)) {
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
  it('writes ONLY the revenue row (no platform-ledger mirror)', async () => {
    await creditRevenueWallet(500, 'NGN', 'SUB-REF-1', 'Subscription Payment', 'squad');

    const inserts = insertedTransactionRows();
    // The revenue wallet is a VIRTUAL allocation — fees physically stay in the
    // provider pool. Writing a platform mirror row here polluted the Platform
    // Ledger, so creditRevenueWallet must produce exactly ONE insert.
    expect(inserts.length).toBe(1);

    // Revenue row SQL carries transaction_type 'fee' and direction 'credit'
    const revenue = inserts[0];
    expect(/'fee'/.test(revenue.sql)).toBe(true);
    expect(/'credit'/.test(revenue.sql)).toBe(true);
    expect(revenue.params[0]).toBe(500); // amount
    expect(revenue.params[2]).toContain('SUB-REF-1'); // reference linkage
    expect(revenue.params[3]).toBe('Subscription Payment'); // description
  });

  it('is idempotent: skips the revenue row when the reference already exists', async () => {
    mockedQuery.mockImplementation(async (sql: any) => {
      const s = String(sql || '');
      if (/SELECT id FROM transactions WHERE reference = \$1 AND transaction_type = 'fee'/i.test(s)) {
        return { rows: [{ id: 'exists' }] } as any;
      }
      if (/SELECT id FROM wallets/i.test(s) || /SELECT id FROM platform_wallet/i.test(s) || /RETURNING id/i.test(s)) {
        return { rows: [{ id: 'pw-1' }] } as any;
      }
      return { rows: [] } as any;
    });

    await creditRevenueWallet(500, 'NGN', 'SUB-REF-2', 'Subscription Payment', 'squad');

    const inserts = insertedTransactionRows();
    // Nothing new may be inserted
    expect(inserts.length).toBe(0);
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

  it('debitPlatformWallet records a platform debit row (real pool payout)', async () => {
    await debitPlatformWallet(500, 'NGN', 'TRF-REF-1', 'Payout to Jane (TRF-REF-1)', 'squad');

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
