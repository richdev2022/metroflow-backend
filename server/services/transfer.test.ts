import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processAllPending } from './transfer';
import * as db from '../db';
import * as fees from './fees';
import * as audit from './audit';
import * as email from './email';

// Mock DB
vi.mock('../db', () => ({
  query: vi.fn().mockImplementation(async () => {
    return { rows: [] };
  }),
}));

// Mock audit service
vi.mock('./audit', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
  generateTransactionHash: vi.fn().mockReturnValue('fakehash123'),
}));

// Mock email service
vi.mock('./email', () => ({
  sendTransactionAlert: vi.fn().mockResolvedValue(undefined),
}));

// Mock fees module functions
vi.mock('./fees', () => ({
  creditPlatformWallet: vi.fn().mockResolvedValue(undefined),
  debitPlatformWallet: vi.fn().mockResolvedValue(undefined),
  creditRevenueWallet: vi.fn().mockResolvedValue(undefined),
  debitRevenueWallet: vi.fn().mockResolvedValue(undefined),
  calculateFee: vi.fn().mockResolvedValue(0),
}));

// Mock the providers factory to return a mock squad provider
const mockInitiateTransfer = vi.fn();
const mockVerifyTransfer = vi.fn();
const mockAuthorizeTransfer = vi.fn();
const mockResendTransferOTP = vi.fn();
const mockGetAllTransfers = vi.fn();
const mockGetWalletBalance = vi.fn();
const mockSearchDisbursementTransactions = vi.fn();
const mockInitiateBulkTransfer = vi.fn();
const mockAuthorizeBulkTransfer = vi.fn();
const mockResendBulkTransferOTP = vi.fn();
const mockGetBulkTransferStatus = vi.fn();
const mockGetBulkTransferTransactions = vi.fn();

vi.mock('./providers/factory', () => ({
  getProvider: (name: string) => ({
    name: name || 'squad',
    initiateTransfer: mockInitiateTransfer,
    verifyTransfer: mockVerifyTransfer,
    authorizeTransfer: mockAuthorizeTransfer,
    resendTransferOTP: mockResendTransferOTP,
    getAllTransfers: mockGetAllTransfers,
    getWalletBalance: mockGetWalletBalance,
    searchDisbursementTransactions: mockSearchDisbursementTransactions,
    initiateBulkTransfer: mockInitiateBulkTransfer,
    authorizeBulkTransfer: mockAuthorizeBulkTransfer,
    resendBulkTransferOTP: mockResendBulkTransferOTP,
    getBulkTransferStatus: mockGetBulkTransferStatus,
    getBulkTransferTransactions: mockGetBulkTransferTransactions,
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
  getAvailableProviders: () => ['squad', 'monnify'],
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

        // 5-6. Platform/Revenue wallet credit functions are now mocked, skip internal queries
        // 7. Idempotency check for amount transaction (SELECT existing - none found)
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // 8. Record Transaction (Amount) - INSERT
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // 9. Idempotency check for fee transaction (SELECT existing - none found)
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // 10. Record Transaction (Fee) - INSERT
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 11. Mock Squad Success - returns success=true, which our code will now detect as immediate success
        mockInitiateTransfer.mockResolvedValue({ 
            status: 200, 
            success: true, 
            data: { id: 'sq_1' } 
        });

        // 12. Update transfer_queue status (to 'success' immediately now)
        mockQuery.mockResolvedValueOnce({ rows: [] });

        // 11-13. Debit platform wallet is mocked, and verifySingleTransfer is skipped when status is already 'success'.
        // Provide defaults for remaining direct queries (notifications/audit are mocked, SELECTs use defaults)

        await processAllPending(businessId);

        // Verifications via mocked modules
        expect(fees.creditPlatformWallet).toHaveBeenCalledWith(100, 'NGN');
        expect(fees.creditRevenueWallet).toHaveBeenCalledWith(10, 'NGN');
        expect(mockInitiateTransfer).toHaveBeenCalledTimes(1);
        expect(fees.debitPlatformWallet).toHaveBeenCalledWith(100, 'NGN');

        // verifySingleTransfer should NOT have been called since we determined immediate status = success
        // (mockVerifyTransfer is the provider.verifyTransfer call)
        expect(mockVerifyTransfer).not.toHaveBeenCalled();

        // Audit log for success should be called
        expect(audit.logAuditEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'transfer_completed',
                entityType: 'transfer',
                entityId: transfer.id,
            })
        );

        // Direct query-based verification
        const userWalletDebitCall = mockQuery.mock.calls.find((call: any[]) => 
            call[0].includes('UPDATE wallets SET balance = balance') && 
            call[1][1] === transfer.wallet_id
        );
        expect(userWalletDebitCall).toBeDefined();
        expect(userWalletDebitCall[1][0]).toEqual(110); // amount + fee = 100 + 10
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
            status: 'pending',
            initiated_by: 'user_123',
        };

        const mockQuery = db.query as any;
        
        // Setup similar to success until Squad call
        mockQuery.mockResolvedValueOnce({ rows: [transfer] }); // 1. Fetch
        mockQuery.mockResolvedValueOnce({ rows: [] }); // 2. Processing
        mockQuery.mockResolvedValueOnce({ rows: [{ balance: '1000' }] }); // 3. Check Balance
        mockQuery.mockResolvedValueOnce({ rows: [] }); // 4. Debit User
        mockQuery.mockResolvedValueOnce({ rows: [] }); // 5. Idempotency SELECT amount txn
        mockQuery.mockResolvedValueOnce({ rows: [] }); // 6. INSERT amount txn
        mockQuery.mockResolvedValueOnce({ rows: [] }); // 7. Idempotency SELECT fee txn
        mockQuery.mockResolvedValueOnce({ rows: [] }); // 8. INSERT fee txn

        // 9. Squad returns failed (success=false) - our code will detect as immediate failure
        mockInitiateTransfer.mockResolvedValue({ success: false, message: 'Insufficient funds at provider' });

        // 10. Update transfer_queue to 'failed' immediately
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // 11. SELECT transactions to check if debited (for refund)
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'txn_1' }] });
        // 12. Refund user wallet (+110)
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // 13+ Remaining direct queries use default fallback

        await processAllPending(businessId);

        // Verifications: Debit side should have been called
        expect(fees.creditPlatformWallet).toHaveBeenCalledWith(100, 'NGN');
        expect(fees.creditRevenueWallet).toHaveBeenCalledWith(10, 'NGN');
        expect(mockInitiateTransfer).toHaveBeenCalledTimes(1);

        // Refund side should reverse everything
        expect(fees.debitPlatformWallet).toHaveBeenCalledWith(100, 'NGN');
        expect(fees.debitRevenueWallet).toHaveBeenCalledWith(10, 'NGN');

        // verifySingleTransfer should NOT have been called since we determined immediate status = failed
        expect(mockVerifyTransfer).not.toHaveBeenCalled();

        // Audit log for failure should be called
        expect(audit.logAuditEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'transfer_failed',
                entityType: 'transfer',
                entityId: transfer.id,
            })
        );

        // Direct refund verification
        const userWalletRefundCall = mockQuery.mock.calls.find((call: any[]) => 
            call[0].includes('UPDATE wallets SET balance = balance +') && 
            call[1][1] === transfer.wallet_id
        );
        expect(userWalletRefundCall).toBeDefined();
        expect(userWalletRefundCall[1][0]).toEqual(110); // amount + fee = 100 + 10
    });
});
