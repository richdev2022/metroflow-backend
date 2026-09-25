
import axios from "axios";
import crypto from "crypto";
import {
  Provider,
  VirtualAccountRequest,
  BusinessVirtualAccountRequest,
  InitiatePaymentRequest,
  ChargeCardRequest,
  SingleTransferRequest,
  BulkTransferRequest,
} from "./index";
import { BANK_LIST, Bank } from "../../utils/bank-codes";

/**
 * Flutterwave V3 Provider
 * Docs: https://developer.flutterwave.com/
 *
 * - Standard/Checkout:  POST /v3/payments            -> data.link (hosted checkout)
 * - Verify:             GET  /v3/transactions/verify_by_reference?tx_ref=
 * - Transfers:          POST /v3/transfers           (amount in MAJOR units)
 * - Bulk transfers:     POST /v3/bulk-transfers      { title, bulk_data[] }
 * - Transfer status:    GET  /v3/transfers/{id}      (FLW numeric id required)
 * - Account resolve:    POST /v3/accounts/resolve
 * - Virtual accounts:   POST /v3/virtual-account-numbers (is_permanent + bvn for static)
 * - Webhook security:   `verif-hash` header must equal FLW_SECRET_HASH
 *
 * NOTE: Flutterwave uses the same base URL for both test and live modes;
 * the mode is determined by the secret key (test keys start with FLWSECK-TEST).
 */

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH;
const FLW_BASE_URL = process.env.FLW_BASE_URL || "https://api.flutterwave.com";

if (!FLW_SECRET_KEY) {
  console.warn("FLW_SECRET_KEY is not set. Flutterwave services will fail.");
}

const flwClient = axios.create({
  baseURL: FLW_BASE_URL,
  headers: {
    Authorization: `Bearer ${FLW_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 60000,
});

// Flutterwave expects amounts in MAJOR units (e.g. 500.00 NGN).
// Other providers in this codebase pass minor units (kobo) between services,
// so we convert here to keep the Provider contract consistent.
function toMajorUnit(amount: number | string): number {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (Number.isNaN(num)) return 0;
  // Heuristic: kobo strings are integers ending in whole kobo; the pipeline
  // always passes minor units (toMinorUnit) into initiateTransfer/initiatePayment.
  // Values from transfer_queue.amount are Naira strings - but processAllPending
  // always converts with toMinorUnit() before calling the provider, so any
  // integer string we receive here is treated as kobo when it has no decimals.
  if (Number.isInteger(num)) {
    return Math.round(num) / 100;
  }
  return Math.round(num * 100) / 100;
}

function roundAmount(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// Constant-time string compare for webhook hash validation
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export const flutterwaveProvider: Provider = {
  name: "flutterwave",

  getRequirements() {
    return {
      personalVirtualAccount: {
        requiredFields: [
          "bvn",
          "firstName",
          "lastName",
          "email",
          "phoneNumber",
        ],
      },
      businessVirtualAccount: {
        requiredFields: [
          "bvn",
          "businessName",
          "email",
          "phoneNumber",
        ],
      },
    };
  },

  /**
   * Static (permanent) NGN virtual account.
   * Flutterwave requires BVN + email for permanent accounts.
   */
  async createVirtualAccount(data: VirtualAccountRequest) {
    try {
      const nameParts = `${data.firstName || "Metroflow"} ${data.lastName || "User"}`.split(" ");
      const payload: Record<string, any> = {
        email: data.email,
        is_permanent: true,
        firstname: (data.firstName || nameParts[0] || "Metroflow").trim(),
        lastname: (data.lastName || nameParts.slice(1).join(" ") || nameParts[0] || "User").trim(),
        phonenumber: data.phoneNumber,
        narration: `${data.firstName || "Metroflow"} ${data.lastName || "User"}`.trim(),
        tx_ref: `VA-${data.customerIdentifier}-${Date.now()}`,
        bvn: data.bvn,
      };
      if (data.nin) payload.nin = data.nin;

      const response = await flwClient.post("/v3/virtual-account-numbers", payload);
      const body = response.data;
      // Attach the tx_ref used so webhook funding events can be attributed
      if (body?.data) {
        body.data.va_tx_ref = payload.tx_ref;
      }
      return body;
    } catch (error: any) {
      console.error(
        "Flutterwave Create VA Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Virtual Account creation failed"
      );
    }
  },

  /**
   * Flutterwave V3 has no separate business VA endpoint; the static virtual
   * account endpoint is used with the business name as the narration and a
   * deterministic business email built from the customer identifier.
   */
  async createBusinessVirtualAccount(data: BusinessVirtualAccountRequest) {
    try {
      const slug = (data.customerIdentifier || "biz")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
      const payload: Record<string, any> = {
        email: `va+${slug || Date.now()}@metroflow-virtual-accounts.local`,
        is_permanent: true,
        firstname: (data.businessName || "Metroflow").split(" ")[0] || "Metroflow",
        lastname: (data.businessName || "Business").split(" ").slice(1).join(" ") || "Business",
        phonenumber: data.phoneNumber,
        narration: data.businessName,
        tx_ref: `VA-${data.customerIdentifier}-${Date.now()}`,
        bvn: data.bvn,
      };
      if (data.nin) payload.nin = data.nin;

      const response = await flwClient.post("/v3/virtual-account-numbers", payload);
      const body = response.data;
      if (body?.data) {
        body.data.va_tx_ref = payload.tx_ref;
      }
      return body;
    } catch (error: any) {
      console.error(
        "Flutterwave Create Business VA Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Business Virtual Account creation failed"
      );
    }
  },

  /**
   * Flutterwave Standard checkout.
   * Normalized envelope (same shape as Monnify's):
   *   { success, message, data: { checkout_url, link, ... } }
   * `request.amount` arrives as a minor-unit value (kobo string/number) from
   * the wallet pipeline, so it is converted to major units here.
   */
  async initiatePayment(request: InitiatePaymentRequest) {
    try {
      const payload: Record<string, any> = {
        tx_ref: request.reference,
        amount: roundAmount(toMajorUnit(request.amount)),
        currency: request.currency || "NGN",
        redirect_url: request.callbackUrl,
        customer: {
          email: request.email,
        },
        customizations: {
          title: "Metroflow Wallet Funding",
          description: "Wallet funding payment",
        },
      };

      const response = await flwClient.post("/v3/payments", payload);
      const body = response.data;
      return {
        success: body?.status === "success",
        message: body?.message || "Hosted Link",
        data: {
          ...body?.data,
          checkout_url: body?.data?.link,
          link: body?.data?.link,
        },
      };
    } catch (error: any) {
      console.error(
        "Flutterwave Initiate Payment Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Payment initiation failed"
      );
    }
  },

  /**
   * Verify a transaction by our reference (tx_ref).
   * Normalized: { success, message, data: { status: 'successful', amount, currency, ... } }
   */
  async verifyPayment(reference: string) {
    try {
      const response = await flwClient.get(
        `/v3/transactions/verify_by_reference`,
        { params: { tx_ref: reference } }
      );
      const body = response.data;
      return {
        success: body?.status === "success",
        message: body?.message || "Verification complete",
        data: body?.data,
      };
    } catch (error: any) {
      console.error(
        "Flutterwave Verify Payment Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Payment verification failed"
      );
    }
  },

  async chargeCard(data: ChargeCardRequest) {
    // Flutterwave tokenized charges are a separate flow (v3/tokenized-charges)
    // and are not part of the wallet funding pipeline today.
    throw new Error("Direct card charge not implemented for Flutterwave");
  },

  async cancelRecurring(token: string) {
    console.log(`[Flutterwave] Cancel recurring for token: ${token}`);
    return { success: true, message: "Recurring subscription cancelled locally" };
  },

  /**
   * Single payout. `data.amount` arrives as a minor-unit string (kobo) from
   * processAllPending -> toMinorUnit(); Flutterwave wants major units.
   */
  async initiateTransfer(data: SingleTransferRequest) {
    try {
      const payload = {
        account_bank: data.bankCode,
        account_number: data.accountNumber,
        amount: roundAmount(toMajorUnit(data.amount)),
        narration: data.remark || "Metroflow transfer",
        currency: data.currencyId || "NGN",
        reference: data.transactionReference,
        beneficiary_name: data.accountName,
        debit_currency: data.currencyId || "NGN",
      };

      const response = await flwClient.post("/v3/transfers", payload);
      return response.data;
    } catch (error: any) {
      console.error(
        "Flutterwave Transfer Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Transfer initiation failed"
      );
    }
  },

  /**
   * Verify a transfer. Flutterwave V3 only supports fetching by its numeric
   * transfer id, so we look for the id in the stored provider metadata first
   * (set after initiateTransfer), then fall back to paging through recent
   * transfers to match our reference.
   */
  async verifyTransfer(reference: string, providerMetadata?: any) {
    try {
      // 1. If we stored the FLW transfer id, use it directly.
      const flwId =
        providerMetadata?.data?.id ||
        providerMetadata?.id ||
        providerMetadata?.flw_transfer_id;

      if (flwId) {
        const response = await flwClient.get(`/v3/transfers/${flwId}`);
        return response.data;
      }

      // 2. If the reference itself is numeric, it may be the FLW id.
      if (/^\d+$/.test(reference)) {
        try {
          const response = await flwClient.get(`/v3/transfers/${reference}`);
          const body = response.data;
          if (body?.status === "success" && body?.data?.reference === reference) {
            return body;
          }
        } catch {
          // fall through to paging search
        }
      }

      // 3. Fallback: search recent transfers (up to 3 pages of 100).
      for (let page = 1; page <= 3; page++) {
        const response = await flwClient.get("/v3/transfers", {
          params: { page, limit: 100 },
        });
        const body = response.data;
        const items = Array.isArray(body?.data) ? body.data : [];
        const match = items.find((t: any) => t?.reference === reference);
        if (match) {
          return { status: body.status, message: "Transfer fetched", data: match };
        }
        if (items.length === 0) break;
      }

      throw new Error("Could not find transfer with the given reference");
    } catch (error: any) {
      console.error(
        "Flutterwave Verify Transfer Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Transfer verification failed"
      );
    }
  },

  async authorizeTransfer(reference: string, authorizationCode: string) {
    // Flutterwave transfers do not require OTP authorization
    throw new Error("Authorize transfer not required for Flutterwave");
  },

  async resendTransferOTP(reference: string) {
    throw new Error("Resend OTP not required for Flutterwave");
  },

  async getAllTransfers(pageNo: number = 1, pageSize: number = 100) {
    try {
      const response = await flwClient.get("/v3/transfers", {
        params: { page: pageNo, limit: pageSize },
      });
      return response.data;
    } catch (error: any) {
      console.error(
        "Flutterwave Get All Transfers Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Fetch transfers failed"
      );
    }
  },

  async getWalletBalance(accountNumber: string) {
    try {
      // Flutterwave settlement balance by currency; accountNumber is used as
      // the currency hint when provided (NGN by default).
      const currency = accountNumber && /^[A-Z]{3}$/.test(accountNumber) ? accountNumber : "NGN";
      const response = await flwClient.get(`/v3/balances/${currency}`);
      return response.data;
    } catch (error: any) {
      console.error(
        "Flutterwave Get Wallet Balance Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Fetch balance failed"
      );
    }
  },

  async searchDisbursementTransactions(filters: any = {}) {
    try {
      const params: Record<string, any> = {};
      if (filters.reference) params.reference = filters.reference;
      if (filters.page) params.page = filters.page;
      if (filters.limit) params.limit = filters.limit;
      const response = await flwClient.get("/v3/transfers", { params });
      return response.data;
    } catch (error: any) {
      console.error(
        "Flutterwave Search Disbursements Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Search disbursements failed"
      );
    }
  },

  /**
   * Bulk payout. Maps the internal BulkTransferRequest to Flutterwave's
   * { title, bulk_data[] } shape. Amounts arrive as minor units per item and
   * are converted to major units.
   */
  async initiateBulkTransfer(data: BulkTransferRequest) {
    try {
      const bulkData = data.transactionList.map((tx) => ({
        bank_code: tx.destinationBankCode,
        account_number: tx.destinationAccountNumber,
        amount: roundAmount(toMajorUnit(tx.amount)),
        narration: tx.narration,
        currency: tx.currency || "NGN",
        reference: tx.reference,
        beneficiary_name: tx.destinationAccountName,
      }));

      const payload = {
        title: data.title,
        bulk_data: bulkData,
      };

      const response = await flwClient.post("/v3/bulk-transfers", payload);
      return response.data;
    } catch (error: any) {
      console.error(
        "Flutterwave Bulk Transfer Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Bulk transfer initiation failed"
      );
    }
  },

  async authorizeBulkTransfer(reference: string, authorizationCode: string) {
    throw new Error("Authorize bulk transfer not required for Flutterwave");
  },

  async resendBulkTransferOTP(reference: string) {
    throw new Error("Resend bulk OTP not required for Flutterwave");
  },

  /**
   * Flutterwave batch: GET /v3/transfers?batch_id={bulk id}
   * Accepts either the FLW numeric bulk id or falls back to paging search.
   */
  async getBulkTransferStatus(batchReference: string) {
    try {
      const response = await flwClient.get("/v3/transfers", {
        params: { batch_id: batchReference },
      });
      const body = response.data;
      const items = Array.isArray(body?.data) ? body.data : [];
      return {
        status: body?.status,
        message: body?.message,
        data: {
          batch_id: batchReference,
          transfers: items,
          total: items.length,
          successful: items.filter((t: any) => t?.status === "SUCCESSFUL").length,
          failed: items.filter((t: any) => ["FAILED", "REVERTED"].includes(t?.status)).length,
          pending: items.filter((t: any) => !["SUCCESSFUL", "FAILED", "REVERTED"].includes(t?.status)).length,
        },
      };
    } catch (error: any) {
      console.error(
        "Flutterwave Get Bulk Status Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Fetch bulk transfer status failed"
      );
    }
  },

  async getBulkTransferTransactions(batchReference: string, pageNo: number = 1, pageSize: number = 100) {
    try {
      const response = await flwClient.get("/v3/transfers", {
        params: { batch_id: batchReference, page: pageNo, limit: pageSize },
      });
      return response.data;
    } catch (error: any) {
      console.error(
        "Flutterwave Get Bulk Transactions Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Fetch bulk transfer transactions failed"
      );
    }
  },

  /**
   * Resolve account name for a bank account (Nigeria supported).
   */
  async accountLookup(bankCode: string, accountNumber: string) {
    try {
      const response = await flwClient.post("/v3/accounts/resolve", {
        account_bank: bankCode,
        account_number: accountNumber,
      });
      return response.data;
    } catch (error: any) {
      console.error(
        "Flutterwave Account Lookup Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message || "Account lookup failed"
      );
    }
  },

  getBanks(): Bank[] {
    // Flutterwave NG accepts standard NIBSS bank codes for payouts, matching
    // the codes already stored on users/payees across the platform.
    return BANK_LIST;
  },

  /**
   * Flutterwave webhook validation: the `verif-hash` header must equal the
   * configured FLW_SECRET_HASH. The signature argument is the header value.
   */
  verifyWebhook(body: any, signature: string): boolean {
    if (!FLW_SECRET_HASH || !signature) return false;
    return safeEquals(signature, FLW_SECRET_HASH);
  },
};

export function isFlutterwaveConfigured(): boolean {
  return Boolean(FLW_SECRET_KEY);
}
