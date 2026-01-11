import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processAllPending } from './transfer';
import * as db from '../db';
import * as squad from './squad';

// Mock DB
vi.mock('../db', () => ({
  query: vi.fn(),
}));

// Mock Squad
vi.mock('./squad', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        initiateTransfer: vi.fn(),
        toMinorUnit: (val) => (val * 100).toString()
    };
});

describe('processAllPending', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should debit user, credit platform (amount) & revenue (fee), call provider, and debit platform (amount) on success', async () => {
        // Mock Data
        const businessId = 'biz_123';
        const transfer = { 
            id: 'trf_123', 
            wallet_id: 'wallet_123', 
            amount: '100', 
            fee: '10', 
            business_id: businessId,
            recipient_bank: '058',
            recipient_account: '1234567890',
            recipient_name: 'John Doe',
            reference: 'REF123',
            currency: 'NGN',
            status: 'pending'
        };

        const mockQuery = db.query as any;
        
        // 1. Fetch Pending Transfers
        mockQuery.mockResolvedValueOnce({ rows: [transfer] });

        // 2. Update Status to processing
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 3. Check Wallet & Debit (Balance Check)
        mockQuery.mockResolvedValueOnce({ rows: [{ balance: '1000' }] });

        // 4. Debit User Wallet (Amount + Fee = 110)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 5. Credit Platform Wallet (Operational - Amount = 100)
        // inside creditPlatformWallet:
        //   Select Operational Wallet
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'op_1' }] }); 
        //   Update Operational Wallet
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 6. Credit Revenue Wallet (Fee = 10)
        // inside creditRevenueWallet:
        //   Select Revenue Wallet
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rev_1' }] }); 
        //   Update Revenue Wallet
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 7. Record Transaction (Amount)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 8. Record Transaction (Fee)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 9. Initiate Transfer (Squad) - Mocked below
        
        // 10. Debit Platform Wallet (Success) - Amount only = 100
        // inside debitPlatformWallet -> creditPlatformWallet:
        //   Select Operational Wallet
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'op_1' }] });
        //   Update Operational Wallet (-100)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 11. Update Transfer Queue (Success)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // Mock Squad Success
        const mockInitiateTransfer = squad.initiateTransfer as any;
        mockInitiateTransfer.mockResolvedValue({ status: 200, success: true, data: { id: 'sq_1' } });

        await processAllPending(businessId);

        // Verifications
        const updateWalletCalls = mockQuery.mock.calls.filter((call: any[]) => call[0].includes('UPDATE wallets'));
        const updatePlatformWalletCalls = mockQuery.mock.calls.filter((call: any[]) => call[0].includes('UPDATE platform_wallet'));
        
        // Expected Wallet Updates:
        // 1. Debit User 110 (User Wallet)
        // 2. Credit Operational 100 (Operational Wallet)
        // 3. Debit Operational 100 (Operational Wallet)
        expect(updateWalletCalls.length).toBe(3);
        
        // Debit User
        expect(updateWalletCalls[0][1][0]).toBe(110); 
        expect(updateWalletCalls[0][1][1]).toBe('wallet_123');

        // Credit Operational (100)
        expect(updateWalletCalls[1][1][0]).toBe(100);
        expect(updateWalletCalls[1][1][1]).toBe('op_1');

        // Debit Operational (-100)
        expect(updateWalletCalls[2][1][0]).toBe(-100);
        expect(updateWalletCalls[2][1][1]).toBe('op_1');

        // Expected Revenue Updates:
        // 1. Credit Revenue 10 (Revenue Wallet)
        expect(updatePlatformWalletCalls.length).toBe(1);
        expect(updatePlatformWalletCalls[0][1][0]).toBe(10);
        expect(updatePlatformWalletCalls[0][1][1]).toBe('rev_1');
    });

    it('should debit user, credit platform & revenue, fail provider, and reverse all', async () => {
        // Mock Data
        const businessId = 'biz_123';
        const transfer = { 
            id: 'trf_123', 
            wallet_id: 'wallet_123', 
            amount: '100', 
            fee: '10', 
            business_id: businessId,
            recipient_bank: '058',
            recipient_account: '1234567890',
            recipient_name: 'John Doe',
            reference: 'REF123',
            currency: 'NGN',
            status: 'pending'
        };

        const mockQuery = db.query as any;
        
        // Setup similar to success until Squad call
        mockQuery.mockResolvedValueOnce({ rows: [transfer] }); // Fetch
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Processing
        mockQuery.mockResolvedValueOnce({ rows: [{ balance: '1000' }] }); // Check Balance
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Debit User
        
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'op_1' }] }); // Get Op
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Credit Op (100)
        
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rev_1' }] }); // Get Rev
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Credit Rev (10)
        
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Txn 1
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Txn 2

        // Squad Fails
        const mockInitiateTransfer = squad.initiateTransfer as any;
        mockInitiateTransfer.mockResolvedValue({ status: 400, success: false, message: 'Failed' });

        // Failure handling
        // 1. Refund User Wallet (110)
        mockQuery.mockResolvedValueOnce({ rows: [] }); 
        
        // 2. Reverse Platform Wallet (Debit 100)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'op_1' }] }); // Get Op
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update Op (-100)

        // 3. Reverse Revenue Wallet (Debit 10)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rev_1' }] }); // Get Rev
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update Rev (-10)

        // 4. Record Refund Txn 1
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // 5. Record Refund Txn 2
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 6. Update Transfer Queue (Failed)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        await processAllPending(businessId);

        const updateWalletCalls = mockQuery.mock.calls.filter((call: any[]) => call[0].includes('UPDATE wallets'));
        const updatePlatformWalletCalls = mockQuery.mock.calls.filter((call: any[]) => call[0].includes('UPDATE platform_wallet'));
        
        // Expected Wallet Updates:
        // 1. Debit User 110
        // 2. Credit Operational 100
        // 3. Refund User 110
        // 4. Debit Operational 100
        expect(updateWalletCalls.length).toBe(4);
        
        // Refund User (+110)
        expect(updateWalletCalls[2][1][0]).toBe(110); 
        
        // Reverse Operational (-100)
        expect(updateWalletCalls[3][1][0]).toBe(-100);

        // Expected Revenue Updates:
        // 1. Credit Revenue 10
        // 2. Debit Revenue 10
        expect(updatePlatformWalletCalls.length).toBe(2);
        
        // Reverse Revenue (-10)
        expect(updatePlatformWalletCalls[1][1][0]).toBe(-10);
    });
});