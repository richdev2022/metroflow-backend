
import axios from "axios";
import crypto from "crypto";
import {
  Provider,
  VirtualAccountRequest,
  BusinessVirtualAccountRequest,
  InitiatePaymentRequest,
  ChargeCardRequest,
  SingleTransferRequest,
} from "./index";
import { BANK_LIST, Bank } from "../../utils/bank-codes";

const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY;
const SQUAD_BASE_URL =
  process.env.NODE_ENV === "production"
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

// Helper to convert major unit (e.g. 100.50) to minor unit (10050)
export function toMinorUnit(amount: number | string): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return Math.round(num * 100).toString();
}

export const squadProvider: Provider = {
  name: "squad",

  getRequirements() {
    return {
      personalVirtualAccount: {
        requiredFields: [
          "bvn",
          "firstName",
          "lastName",
          "email",
          "phoneNumber",
          "address",
          "dob",
          "gender",
        ],
      },
      businessVirtualAccount: {
        requiredFields: [
          "bvn",
          "businessName",
          "email",
          "phoneNumber",
          "beneficiaryAccount",
        ],
      },
    };
  },

  async createVirtualAccount(data: VirtualAccountRequest) {
    try {
      const payload = {
        first_name: data.firstName,
        last_name: data.lastName,
        middle_name: data.middleName,
        mobile_num: data.phoneNumber,
        dob: data.dob || "01/01/1990",
        email: data.email,
        bvn: data.bvn,
        gender: data.gender || "1",
        address: data.address || "Lagos, Nigeria",
        customer_identifier: data.customerIdentifier,
        beneficiary_account: data.beneficiaryAccount || "0000000000",
      };

      const response = await squadClient.post("/virtual-account", payload);
      return response.data;
    } catch (error: any) {
      console.error(
        "Squad Create VA Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Virtual Account creation failed"
      );
    }
  },

  async createBusinessVirtualAccount(data: BusinessVirtualAccountRequest) {
    try {
      const payload = {
        bvn: data.bvn,
        business_name: data.businessName,
        customer_identifier: data.customerIdentifier,
        mobile_num: data.phoneNumber,
        beneficiary_account: data.beneficiaryAccount || "0000000000",
      };

      const response = await squadClient.post(
        "/virtual-account/business",
        payload
      );
      return response.data;
    } catch (error: any) {
      console.error(
        "Squad Create Business VA Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Business Virtual Account creation failed"
      );
    }
  },

  async initiatePayment(request: InitiatePaymentRequest) {
    try {
      const payload: any = {
        email: request.email,
        amount:
          typeof request.amount === "string"
            ? parseInt(request.amount)
            : request.amount, // Squad expects minor unit (kobo) as integer
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
      console.error(
        "Squad Initiate Payment Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Payment initiation failed"
      );
    }
  },

  async verifyPayment(reference: string) {
    try {
      const response = await squadClient.get(
        `/transaction/verify/${reference}`
      );
      return response.data;
    } catch (error: any) {
      console.error(
        "Squad Verify Payment Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Payment verification failed"
      );
    }
  },

  async chargeCard(data: ChargeCardRequest) {
    try {
      const payload = {
        amount: data.amount,
        token_id: data.tokenId,
        transaction_ref:
          data.transactionRef ||
          `CHG_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      };
      const response = await squadClient.post(
        "/transaction/charge_card",
        payload
      );
      return response.data;
    } catch (error: any) {
      console.error(
        "Squad Charge Card Error:",
        error.response?.data || error.message
      );
      if (error.response?.data) {
        return error.response.data;
      }
      throw new Error(error.response?.data?.message || "Card charge failed");
    }
  },

  async cancelRecurring(token: string) {
    console.log(`[Squad] Cancel recurring for token: ${token}`);
    return { success: true, message: "Recurring subscription cancelled locally" };
  },

  async initiateTransfer(data: SingleTransferRequest) {
    try {
      const payload = {
        bank_code: data.bankCode,
        account_number: data.accountNumber,
        amount: data.amount,
        account_name: data.accountName,
        transaction_reference: data.transactionReference,
        remark: data.remark,
        currency_id: data.currencyId || "NGN",
      };

      const response = await squadClient.post("/payout/transfer", payload);
      return response.data;
    } catch (error: any) {
      console.error(
        "Squad Transfer Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Transfer initiation failed"
      );
    }
  },

  async verifyTransfer(reference: string) {
    try {
      const response = await squadClient.get(`/payout/transfer/${reference}`);
      return response.data;
    } catch (error: any) {
      console.error(
        "Squad Verify Transfer Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Transfer verification failed"
      );
    }
  },

  async authorizeTransfer(reference: string, authorizationCode: string) {
    console.log(`[Squad] Authorize transfer (not implemented): ${reference}`);
    throw new Error("Authorize transfer not implemented for Squad");
  },

  async resendTransferOTP(reference: string) {
    console.log(`[Squad] Resend transfer OTP (not implemented): ${reference}`);
    throw new Error("Resend OTP not implemented for Squad");
  },

  async getAllTransfers(pageNo: number = 0, pageSize: number = 20) {
    console.log(`[Squad] Get all transfers (not implemented)`);
    throw new Error("Get all transfers not implemented for Squad");
  },

  async getWalletBalance(accountNumber: string) {
    console.log(`[Squad] Get wallet balance (not implemented): ${accountNumber}`);
    throw new Error("Get wallet balance not implemented for Squad");
  },

  async searchDisbursementTransactions(filters: any = {}) {
    console.log(`[Squad] Search disbursement transactions (not implemented)`);
    throw new Error("Search disbursements not implemented for Squad");
  },

  async initiateBulkTransfer(data: any) {
    console.log(`[Squad] Initiate bulk transfer (not implemented)`);
    throw new Error("Initiate bulk transfer not implemented for Squad");
  },

  async authorizeBulkTransfer(reference: string, authorizationCode: string) {
    console.log(`[Squad] Authorize bulk transfer (not implemented): ${reference}`);
    throw new Error("Authorize bulk transfer not implemented for Squad");
  },

  async resendBulkTransferOTP(reference: string) {
    console.log(`[Squad] Resend bulk OTP (not implemented): ${reference}`);
    throw new Error("Resend bulk OTP not implemented for Squad");
  },

  async getBulkTransferStatus(batchReference: string) {
    console.log(`[Squad] Get bulk transfer status (not implemented): ${batchReference}`);
    throw new Error("Get bulk transfer status not implemented for Squad");
  },

  async getBulkTransferTransactions(batchReference: string, pageNo: number = 0, pageSize: number = 20) {
    console.log(`[Squad] Get bulk transfer transactions (not implemented): ${batchReference}`);
    throw new Error("Get bulk transfer transactions not implemented for Squad");
  },

  async accountLookup(bankCode: string, accountNumber: string) {
    try {
      const response = await squadClient.post("/payout/account/lookup", {
        bank_code: bankCode,
        account_number: accountNumber,
      });
      return response.data;
    } catch (error: any) {
      console.error(
        "Squad Account Lookup Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Account lookup failed"
      );
    }
  },

  getBanks(): Bank[] {
    return BANK_LIST;
  },

  verifyWebhook(body: any, signature: string): boolean {
    if (!SQUAD_SECRET_KEY) return false;
    const hash = crypto
      .createHmac("sha512", SQUAD_SECRET_KEY)
      .update(JSON.stringify(body))
      .digest("hex");
    return hash === signature;
  },
};
