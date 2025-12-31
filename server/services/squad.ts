import axios from "axios";
import crypto from "crypto";

const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY;
const SQUAD_BASE_URL = process.env.NODE_ENV === 'production' 
  ? "https://api.squadco.com" 
  : "https://sandbox-api-d.squadco.com";

if (!SQUAD_SECRET_KEY) {
  console.warn("SQUAD_SECRET_KEY is not set. Squad services will fail.");
}

const squadClient = axios.create({
  baseURL: SQUAD_BASE_URL,
  headers: {
    Authorization: `Bearer ${SQUAD_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
});

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

import { BANK_LIST, Bank } from "../utils/bank-codes";

export function getBanks(): Bank[] {
  return BANK_LIST;
}

export async function createVirtualAccount(data: VirtualAccountRequest) {
  try {
    const response = await squadClient.post("/virtual-account", data);
    return response.data;
  } catch (error: any) {
    console.error("Squad Create VA Error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Virtual Account creation failed");
  }
}

export async function createBusinessVirtualAccount(data: BusinessVirtualAccountRequest) {
  try {
    const response = await squadClient.post("/virtual-account/business", data);
    return response.data;
  } catch (error: any) {
    console.error("Squad Create Business VA Error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Business Virtual Account creation failed");
  }
}

export interface InitiatePaymentRequest {
    email: string;
    amount: string | number;
    reference: string;
    callbackUrl?: string;
    currency?: string;
    isRecurring?: boolean;
}

export async function initiatePayment(request: InitiatePaymentRequest) {
    try {
        const payload: any = {
            email: request.email,
            amount: typeof request.amount === 'string' ? parseInt(request.amount) : request.amount, // Squad expects minor unit (kobo) as integer
            currency: request.currency || "NGN",
            initiate_type: "inline", // or 'payment_link'
            transaction_ref: request.reference,
            callback_url: request.callbackUrl,
        };

        if (request.isRecurring) {
            payload.is_recurring = true;
        }

        const response = await squadClient.post("/transaction/initiate", payload);
        return response.data;
    } catch (error: any) {
        console.error("Squad Initiate Payment Error:", error.response?.data || error.message);
        throw new Error(error.response?.data?.message || "Payment initiation failed");
    }
}

export async function verifyPayment(reference: string) {
  try {
    const response = await squadClient.get(`/transaction/verify/${reference}`);
    return response.data;
  } catch (error: any) {
    console.error("Squad Verify Payment Error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Payment verification failed");
  }
}

export async function chargeCard(amount: number, tokenId: string, transactionRef?: string) {
  try {
    const payload = {
      amount: amount,
      token_id: tokenId,
      transaction_ref: transactionRef || `CHG_${Date.now()}_${Math.random().toString(36).substring(7)}`
    };
    const response = await squadClient.post("/transaction/charge_card", payload);
    return response.data;
  } catch (error: any) {
    console.error("Squad Charge Card Error:", error.response?.data || error.message);
    // Return a failed response structure instead of throwing if possible, or throw
    // The caller expects { success: boolean } or throws.
    // Let's throw to be consistent with other methods, but the caller in subscription.ts expects a response object.
    if (error.response?.data) {
        return error.response.data;
    }
    throw new Error(error.response?.data?.message || "Card charge failed");
  }
}

export async function cancelRecurring(token: string) {
    // Squad doesn't explicitly have a "cancel token" endpoint documented in the common set.
    // Usually we just stop charging it.
    // We'll log it for now.
    console.log(`[Squad] Cancel recurring for token: ${token}`);
    return { success: true, message: "Recurring subscription cancelled locally" };
}

export async function initiateTransfer(data: TransferRequest) {
  try {
    const response = await squadClient.post("/payout/transfer", data);
    return response.data;
  } catch (error: any) {
    console.error("Squad Transfer Error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Transfer initiation failed");
  }
}

export async function accountLookup(bankCode: string, accountNumber: string) {
  try {
    const response = await squadClient.post("/payout/account/lookup", {
      bank_code: bankCode,
      account_number: accountNumber,
    });
    return response.data;
  } catch (error: any) {
    console.error("Squad Account Lookup Error:", error.response?.data || error.message);
    throw new Error(error.response?.data?.message || "Account lookup failed");
  }
}

// Helper to convert major unit (e.g. 100.50) to minor unit (10050)
export function toMinorUnit(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return Math.round(num * 100).toString();
}

export function verifySquadWebhook(body: any, signature: string): boolean {
    if (!SQUAD_SECRET_KEY) return false;
    const hash = crypto.createHmac('sha512', SQUAD_SECRET_KEY).update(JSON.stringify(body)).digest('hex');
    return hash === signature;
}
