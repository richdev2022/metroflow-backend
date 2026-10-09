
export interface VirtualAccountRequest {
  firstName?: string;
  lastName?: string;
  middleName?: string;
  phoneNumber: string;
  dob?: string;
  email: string;
  bvn: string;
  nin?: string;
  gender?: string;
  address?: string;
  customerIdentifier: string;
  beneficiaryAccount?: string; // For Squad
}

export interface BusinessVirtualAccountRequest {
  bvn: string;
  nin?: string;
  businessName: string;
  customerIdentifier: string;
  phoneNumber: string;
  beneficiaryAccount?: string; // For Squad
}

export interface InitiatePaymentRequest {
  email: string;
  amount: string | number;
  reference: string;
  callbackUrl?: string;
  currency?: string;
  isRecurring?: boolean;
}

export interface ChargeCardRequest {
  amount: number;
  tokenId: string;
  transactionRef?: string;
}

export interface TransferRequest {
  bankCode: string;
  accountNumber: string;
  amount: string;
  accountName: string;
  transactionReference: string;
  remark: string;
  currencyId?: string;
  // ---- International payout beneficiary details (Flutterwave) ----
  // Flutterwave's USD/GBP/EUR rails reject transfers without the
  // beneficiary's full address; see providers/flutterwave.ts mapping.
  beneficiaryAddress?: string;
  beneficiaryCity?: string;
  beneficiaryState?: string;
  beneficiaryPostalCode?: string;
  /** ISO 3166-1 alpha-2, e.g. "US" */
  beneficiaryCountry?: string;
  bankName?: string;
  swiftCode?: string;
  routingNumber?: string;
  /** USD: "checking" | "depository". GBP: "personal" | "corporate". */
  accountType?: string;
  /** Street components required by the USD corridor (meta[0]). */
  recipientStreetNumber?: string;
  recipientStreetName?: string;
  /** Beneficiary email — optional meta[0] field for intl payouts. */
  beneficiaryEmail?: string;
  /**
   * Platform float currency the payout should be DEBITED from on the
   * provider side (e.g. "NGN"). When it differs from the destination
   * currency, Flutterwave converts automatically via payment_instruction —
   * no pre-funded USD/GBP/EUR wallet needed.
   */
  sourceCurrency?: string;
  // Sender (the paying business) — compliance data for intl transfers
  senderName?: string;
  senderEmail?: string;
  senderPhone?: string;
  senderAddress?: string;
  senderCity?: string;
  senderState?: string;
  senderPostalCode?: string;
  senderCountry?: string;
}

export interface SenderInfo {
  sourceAccountName?: string;
  sourceAccountNumber?: string;
  senderBankCode?: string;
}

export interface SingleTransferRequest extends TransferRequest {
  async?: boolean;
  senderInfo?: SenderInfo;
}

export interface BulkTransferTransaction {
  amount: number;
  reference: string;
  narration: string;
  destinationBankCode: string;
  destinationAccountNumber: string;
  destinationAccountName: string;
  currency: string;
}

export interface BulkTransferRequest {
  title: string;
  batchReference: string;
  narration: string;
  sourceAccountNumber: string;
  onValidationFailure: 'CONTINUE' | 'BREAK';
  notificationInterval?: number;
  transactionList: BulkTransferTransaction[];
}

export interface Provider {
  name: string;

  getRequirements(): {
    personalVirtualAccount: { requiredFields: string[] };
    businessVirtualAccount: { requiredFields: string[] };
  };

  createVirtualAccount(data: VirtualAccountRequest): Promise<any>;
  createBusinessVirtualAccount(data: BusinessVirtualAccountRequest): Promise<any>;
  initiatePayment(data: InitiatePaymentRequest): Promise<any>;
  verifyPayment(reference: string): Promise<any>;
  /**
   * Best-effort automatic refund of a COLLECTED payment (checkout or
   * virtual-account inflow). Used by the over-limit funding guard to return
   * money to the payer when a funding must be rejected after collection.
   * Implementations should return a normalized
   * { success: boolean, message: string, data?: any } envelope and must
   * never throw for "provider does not support refunds" — return
   * { success: false, message: "not supported" } instead.
   */
  refundPayment?(request: {
    /** Provider-native transaction id (e.g. Flutterwave numeric id). */
    transactionId?: string | number;
    /** Provider-native transaction reference (e.g. Monnify transactionReference). */
    providerReference?: string;
    /** Our own FUND-xxx / FLW-VA-xxx reference, when the provider keys refunds off it. */
    reference?: string;
    amount?: number;
    currency?: string;
    reason?: string;
  }): Promise<any>;
  chargeCard(data: ChargeCardRequest): Promise<any>;
  cancelRecurring(token: string): Promise<any>;
  initiateTransfer(data: SingleTransferRequest): Promise<any>;
  verifyTransfer(reference: string, providerMetadata?: any): Promise<any>;
  authorizeTransfer(reference: string, authorizationCode: string): Promise<any>;
  resendTransferOTP(reference: string): Promise<any>;
  getAllTransfers(pageNo?: number, pageSize?: number): Promise<any>;
  getWalletBalance(accountNumber: string): Promise<any>;
  searchDisbursementTransactions(filters?: any): Promise<any>;
  initiateBulkTransfer(data: BulkTransferRequest): Promise<any>;
  authorizeBulkTransfer(reference: string, authorizationCode: string): Promise<any>;
  resendBulkTransferOTP(reference: string): Promise<any>;
  getBulkTransferStatus(batchReference: string): Promise<any>;
  getBulkTransferTransactions(batchReference: string, pageNo?: number, pageSize?: number): Promise<any>;
  accountLookup(bankCode: string, accountNumber: string): Promise<any>;
  getBanks(): any[];
  verifyWebhook(body: any, signature: string): boolean;
}
