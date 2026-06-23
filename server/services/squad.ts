
// Backward compatibility wrapper for existing code
import { squadProvider, toMinorUnit } from "./providers/squad";
import { BANK_LIST, Bank } from "../utils/bank-codes";

// Re-export interfaces to keep existing imports working
export interface TransferRequest {
  bank_code: string;
  account_number: string;
  amount: string;
  account_name: string;
  transaction_reference: string;
  remark: string;
  currency_id?: string; // "NGN" or "USD"
}

export interface VirtualAccountRequest {
  first_name: string;
  last_name: string;
  middle_name?: string;
  mobile_num: string;
  dob: string; // mm/dd/yyyy
  email: string;
  bvn: string;
  gender: "1" | "2"; // 1 male, 2 female
  address: string;
  customer_identifier: string;
  beneficiary_account: string; // GTBank Account Number
}

export interface BusinessVirtualAccountRequest {
  bvn: string;
  business_name: string;
  customer_identifier: string;
  mobile_num: string;
  beneficiary_account: string; // GTBank Account Number
}

export interface InitiatePaymentRequest {
  email: string;
  amount: string | number;
  reference: string;
  callbackUrl?: string;
  currency?: string;
  isRecurring?: boolean;
}

// Re-export provider and helper
export { squadProvider, toMinorUnit };

// Export original functions for backward compatibility
export function getBanks(): Bank[] {
  return squadProvider.getBanks();
}

export async function createVirtualAccount(data: VirtualAccountRequest) {
  return squadProvider.createVirtualAccount({
    firstName: data.first_name,
    lastName: data.last_name,
    middleName: data.middle_name,
    phoneNumber: data.mobile_num,
    dob: data.dob,
    email: data.email,
    bvn: data.bvn,
    gender: data.gender,
    address: data.address,
    customerIdentifier: data.customer_identifier,
    beneficiaryAccount: data.beneficiary_account,
  });
}

export async function createBusinessVirtualAccount(
  data: BusinessVirtualAccountRequest
) {
  return squadProvider.createBusinessVirtualAccount({
    bvn: data.bvn,
    businessName: data.business_name,
    customerIdentifier: data.customer_identifier,
    phoneNumber: data.mobile_num,
    beneficiaryAccount: data.beneficiary_account,
  });
}

export async function initiatePayment(request: InitiatePaymentRequest) {
  return squadProvider.initiatePayment(request);
}

export async function verifyPayment(reference: string) {
  return squadProvider.verifyPayment(reference);
}

export async function chargeCard(
  amount: number,
  tokenId: string,
  transactionRef?: string
) {
  return squadProvider.chargeCard({ amount, tokenId, transactionRef });
}

export async function cancelRecurring(token: string) {
  return squadProvider.cancelRecurring(token);
}

export async function initiateTransfer(data: TransferRequest) {
  return squadProvider.initiateTransfer({
    bankCode: data.bank_code,
    accountNumber: data.account_number,
    amount: data.amount,
    accountName: data.account_name,
    transactionReference: data.transaction_reference,
    remark: data.remark,
    currencyId: data.currency_id,
  });
}

export async function accountLookup(bankCode: string, accountNumber: string) {
  return squadProvider.accountLookup(bankCode, accountNumber);
}

export function verifySquadWebhook(body: any, signature: string): boolean {
  return squadProvider.verifyWebhook(body, signature);
}
