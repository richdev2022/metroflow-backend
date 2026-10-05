import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creditRevenueWallet, creditPlatformWallet, debitPlatformWallet, debitRevenueWallet } from '../fees';
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
  it('writes ONLY a revenue row (no platform mirror) with subscription type on request', async () => {
    await creditRevenueWallet(500, 'NGN', 'SUB-REF-1', 'Subscription Payment', 'squad', undefined, { revenueType: 'subscription' });

    const inserts = insertedTransactionRows();
    // Owner invariant: revenue movements must NEVER touch the platform pool.
    expect(inserts.length).toBe(1);
    expect(inserts[0].sql).not.toContain("'platform'");
    expect(inserts[0].sql).toContain("'subscription'");
    expect(inserts[0].params[0]).toBe(500); // amount
    expect(inserts[0].params[2]).toBe('SUB-REF-1-REVENUE-CREDIT'); // deterministic ref
    expect(inserts[0].params[3]).toBe('Subscription Payment'); // description
  });

  it('defaults to transaction_type fee with a -REVENUE-CREDIT reference', async () => {
    await creditRevenueWallet(50, 'NGN', 'FEE-REF-1', 'Wallet Funding Fee', 'squad');

    const inserts = insertedTransactionRows();
    expect(inserts.length).toBe(1);
    expect(inserts[0].sql).toContain("'fee'");
    expect(inserts[0].params[2]).toBe('FEE-REF-1-REVENUE-CREDIT');
  });

  it('records a genuine revenue DEBIT row for negative amounts (reversal)', async () => {
    await debitRevenueWallet(25, 'NGN', 'FEE-REF-2', 'Reversal of fee revenue for failed transfer X');

    const inserts = insertedTransactionRows();
    expect(inserts.length).toBe(1);
    expect(inserts[0].sql).toContain("'debit'");
    expect(inserts[0].params[0]).toBe(25); // amount stored positive
    expect(inserts[0].params[2]).toBe('FEE-REF-2-REVENUE-DEBIT');
  });

  it('is idempotent: skips the revenue row when the reference already exists', async () => {
    mockedQuery.mockImplementation(async (sql: any) => {
      const s = String(sql || '');
      if (/SELECT id FROM transactions WHERE reference = \$1 AND wallet_id IS NULL/i.test(s)) {
        return { rows: [{ id: 'exists' }] } as any;
      }
      if (/SELECT id FROM wallets/i.test(s) || /SELECT id FROM platform_wallet/i.test(s) || /RETURNING id/i.test(s)) {
        return { rows: [{ id: 'pw-1' }] } as any;
      }
      return { rows: [] } as any;
    });

    await creditRevenueWallet(500, 'NGN', 'SUB-REF-2', 'Subscription Payment', 'squad');

    expect(insertedTransactionRows().length).toBe(0);
  });
});

describe('platform pool helpers', () => {
  it('creditPlatformWallet records a platform ledger row (withdrawal hold)', async () => {
    await creditPlatformWallet(505, 'NGN', 'TRF-REF-1', 'Platform Wallet Credit for Transfer TRF-REF-1', 'squad');

    const inserts = insertedTransactionRows();
    expect(inserts.length).toBe(1);
    expect(inserts[0].params[0]).toBe(505);
    expect(inserts[0].params[3]).toBe('credit');
    expect(inserts[0].sql).toContain("'platform'");
  });

  it('debitPlatformWallet records a platform debit row (user funding payout)', async () => {
    await debitPlatformWallet(500, 'NGN', 'FUND-REF-1-USER', 'User Wallet Funding (Squad)', 'squad');

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
