
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
  chargeCard(data: ChargeCardRequest): Promise<any>;
  cancelRecurring(token: string): Promise<any>;
  initiateTransfer(data: TransferRequest): Promise<any>;
  verifyTransfer(reference: string): Promise<any>;
  accountLookup(bankCode: string, accountNumber: string): Promise<any>;
  getBanks(): any[];
  verifyWebhook(body: any, signature: string): boolean;
}
