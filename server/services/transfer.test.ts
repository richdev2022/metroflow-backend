import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processAllPending } from './transfer';
import * as db from '../db';

// Mock DB
vi.mock('../db', () => ({
  query: vi.fn(),
}));

// Mock the providers factory to return a mock squad provider
const mockInitiateTransfer = vi.fn();
const mockVerifyTransfer = vi.fn();
vi.mock('./providers/factory', () => ({
  getProvider: () => ({
    name: 'squad',
    initiateTransfer: mockInitiateTransfer,
    verifyTransfer: mockVerifyTransfer,
    getBanks: () => [],
    createVirtualAccount: vi.fn(),
    createBusinessVirtualAccount: vi.fn(),
    initiatePayment: vi.fn(),
    verifyPayment: vi.fn(),
    chargeCard: vi.fn(),
    cancelRecurring: vi.fn(),
    accountLookup: vi.fn(),
    verifyWebhook: vi.fn(),
    getRequirements: () => ({ personalVirtualAccount: { requiredFields: [] }, businessVirtualAccount: { requiredFields: [] } }),
  }),
  getAvailableProviders: () => ['squad'],
}));

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
        //   a. Select Operational Wallet (no existing)
        mockQuery.mockResolvedValueOnce({ rows: [] }); 
        //   b. Create Operational Wallet
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'op_1' }] });
        //   c. Update Operational Wallet
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 6. Credit Revenue Wallet (Fee = 10)
        // inside creditRevenueWallet:
        //   a. Select Revenue Wallet (no existing)
        mockQuery.mockResolvedValueOnce({ rows: [] }); 
        //   b. Create Revenue Wallet
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rev_1' }] });
        //   c. Update Revenue Wallet
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 7. Record Transaction (Amount)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 8. Record Transaction (Fee)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 9. Mock Squad Success
        mockInitiateTransfer.mockResolvedValue({ 
            status: 200, 
            success: true, 
            data: { id: 'sq_1' } 
        });

        // 10. Update transfer_queue to processing (new step added)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 11. Debit Platform Wallet (Success) - Amount only = 100
        // inside debitPlatformWallet -> creditPlatformWallet:
        //   a. Select Operational Wallet (returns existing one)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'op_1' }] });
        //   b. Update Operational Wallet (-100)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 12. Mock verifyTransfer success
        mockVerifyTransfer.mockResolvedValue({
            success: true,
            data: {
                status: 'success',
                transaction_status: 'success'
            }
        });

        // 13. verifySingleTransfer calls:
        //   a. Update transfer_queue to success
        mockQuery.mockResolvedValueOnce({ rows: [] });
        //   b. Get updated transfer
        mockQuery.mockResolvedValueOnce({ rows: [{ ...transfer, status: 'success' }] });

        await processAllPending(businessId);

        // Verifications
        const updateWalletCalls = mockQuery.mock.calls.filter((call: any[]) => 
            call[0].includes('UPDATE wallets') && !call[0].includes('INSERT')
        );
        
        // Expected Wallet Updates:
        // 1. Debit User 110 (User Wallet)
        // 2. Credit Operational 100 (Operational Wallet)
        // 3. Debit Operational 100 (Operational Wallet)
        expect(updateWalletCalls.length).toBe(3);
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
        mockQuery.mockResolvedValueOnce({ rows: [transfer] }); // 1. Fetch
        mockQuery.mockResolvedValueOnce({ rows: [] }); // 2. Processing
        mockQuery.mockResolvedValueOnce({ rows: [{ balance: '1000' }] }); // 3. Check Balance
        mockQuery.mockResolvedValueOnce({ rows: [] }); // 4. Debit User
        
        // 5. Credit Operational Wallet
        mockQuery.mockResolvedValueOnce({ rows: [] }); // a. Select Op
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'op_1' }] }); // b. Create Op
        mockQuery.mockResolvedValueOnce({ rows: [] }); // c. Update Op (+100)
        
        // 6. Credit Revenue Wallet
        mockQuery.mockResolvedValueOnce({ rows: [] }); // a. Select Rev
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rev_1' }] }); // b. Create Rev
        mockQuery.mockResolvedValueOnce({ rows: [] }); // c. Update Rev (+10)
        
        mockQuery.mockResolvedValueOnce({ rows: [] }); // 7. Txn 1
        mockQuery.mockResolvedValueOnce({ rows: [] }); // 8. Txn 2

        // 9. Squad Fails
        mockInitiateTransfer.mockResolvedValue({ success: false, message: 'Failed' });

        // 10. Update transfer_queue to processing (new step added)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 11. Mock verifyTransfer failed
        mockVerifyTransfer.mockResolvedValue({
            success: false,
            message: 'Failed',
            data: {
                status: 'failed',
                failure_reason: 'Failed'
            }
        });

        // 12. verifySingleTransfer calls:
        //   a. Update transfer_queue to failed
        mockQuery.mockResolvedValueOnce({ rows: [] });
        //   b. Check if we debited (txnCheck)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'txn_1' }] });
        //   c. Refund user wallet
        mockQuery.mockResolvedValueOnce({ rows: [] }); 
        //   d. Reverse Platform Wallet (Debit 100)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'op_1' }] }); // a. Get Op
        mockQuery.mockResolvedValueOnce({ rows: [] }); // b. Update Op (-100)
        //   e. Reverse Revenue Wallet (Debit 10)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rev_1' }] }); // a. Get Rev
        mockQuery.mockResolvedValueOnce({ rows: [] }); // b. Update Rev (-10)
        //   f. Record Refund Txn 1
        mockQuery.mockResolvedValueOnce({ rows: [] });
        //   g. Record Refund Txn 2
        mockQuery.mockResolvedValueOnce({ rows: [] });
        //   h. Get updated transfer
        mockQuery.mockResolvedValueOnce({ rows: [{ ...transfer, status: 'failed' }] });

        await processAllPending(businessId);
    });
});
