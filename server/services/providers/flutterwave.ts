
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
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

/**
 * MOCK MODE (local E2E tests only): FLW_MOCK=true or FLW_SECRET_KEY="mock"
 * replaces every outbound Flutterwave call with deterministic local behaviour:
 *   - rates return a fixed 1550 NGN/USD,
 *   - account resolution returns a canned receiver name,
 *   - initiateTransfer always queues as PENDING,
 *   - verifyTransfer reads the outcome for a reference from
 *     /tmp/flw_mock_outcomes.json ("successful" | "failed"), default pending.
 * NEVER enabled in production (the flag is ignored unless explicitly set).
 */
export const FLW_MOCK = process.env.FLW_MOCK === "true" || FLW_SECRET_KEY === "mock";
const FLW_MOCK_OUTCOMES_FILE = process.env.FLW_MOCK_OUTCOMES_FILE || "/tmp/flw_mock_outcomes.json";
function flwMockOutcome(reference: string): string {
  try {
    const outcomes = JSON.parse(fs.readFileSync(FLW_MOCK_OUTCOMES_FILE, "utf8"));
    return String(outcomes?.[reference] || "pending").toLowerCase();
  } catch {
    return "pending";
  }
}
function flwMockId(reference: string): number {
  let h = 0;
  for (let i = 0; i < reference.length; i++) h = (h * 31 + reference.charCodeAt(i)) >>> 0;
  return 990000 + (h % 9999);
}
// Public key: NOT used for server-to-server REST calls (secret key is the
// Bearer token). It is required CLIENT-SIDE for Inline checkout (v3.js
// `FlutterwaveCheckout`) and the mobile SDKs. Served to clients via the
// public GET /providers/checkout-config endpoint.
const FLW_PUBLIC_KEY = process.env.FLW_PUBLIC_KEY;
// Secret hash: set the SAME value in the Flutterwave dashboard webhook
// settings. Flutterwave sends it back in the `verif-hash` header; requests
// without a matching value are discarded (see verifyWebhook).
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH;
// Encryption key: only needed for Direct Charge endpoints (3DES payload
// encryption) which this integration does not use today.
const FLW_ENCRYPTION_KEY =
  process.env.FLW_ENCRYPTION_KEY || process.env.FLUTTERWAVE_ENCRYPTION_KEY;
const FLW_BASE_URL = process.env.FLW_BASE_URL || "https://api.flutterwave.com";

if (!FLW_SECRET_KEY) {
  console.warn("FLW_SECRET_KEY is not set. Flutterwave services will fail.");
}
if (!FLW_PUBLIC_KEY) {
  console.warn("FLW_PUBLIC_KEY is not set. Client-side inline checkout (web/mobile) will not work for Flutterwave.");
}
if (!FLW_SECRET_HASH) {
  console.warn("FLW_SECRET_HASH is not set. Flutterwave webhooks will be rejected - set it in .env AND in the Flutterwave dashboard webhook settings.");
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
      if (FLW_MOCK) {
        return {
          status: "success",
          message: "Transfer Queued Successfully",
          data: {
            id: flwMockId(data.transactionReference),
            status: "PENDING",
            reference: data.transactionReference,
            amount: data.amount,
            currency: data.currencyId || "NGN",
            mock: true,
          },
        };
      }
      const payload: Record<string, unknown> = {
        account_bank: data.bankCode,
        account_number: data.accountNumber,
        amount: roundAmount(toMajorUnit(data.amount)),
        narration: data.remark || "Metroflow transfer",
        currency: data.currencyId || "NGN",
        reference: data.transactionReference,
        beneficiary_name: data.accountName,
      };

      // Cross-currency funding: when the payout currency differs from the
      // platform float currency, Flutterwave converts automatically via
      // `payment_instruction` (source NGN -> destination USD/GBP/EUR) — no
      // pre-funded foreign wallet needed. Same-currency payouts keep the
      // classic `debit_currency` form. (docs: developer.flutterwave.com —
      // "International (USD, EUR & GBP)" + payment_instruction guide.)
      const destCurrency = (data.currencyId || "NGN").toUpperCase();
      const sourceCurrency = (data.sourceCurrency || "NGN").toUpperCase();
      if (destCurrency !== "NGN" && sourceCurrency !== destCurrency) {
        payload.payment_instruction = {
          source_currency: sourceCurrency,
          destination_currency: destCurrency,
          amount: {
            applies_to: "destination_currency",
            value: roundAmount(toMajorUnit(data.amount)),
          },
        };
      } else {
        payload.debit_currency = destCurrency;
      }

      // International rails (USD/GBP/EUR): Flutterwave requires the
      // beneficiary's bank + address details INSIDE `meta[0]` — top-level
      // fields (bank_name / swift_code / routing_number / beneficiary_*) are
      // silently IGNORED by /v3/transfers, so the payout reaches disbursement
      // with no routing data and fails with "DISBURSE FAILED: Invalid account
      // number" even when the details are correct (verified against the
      // official reference: developer.flutterwave.com/docs/international-usd-eur-gbp).
      const isIntl = (data.currencyId || "NGN") !== "NGN" || !!data.beneficiaryCountry;
      if (isIntl) {
        const meta: Record<string, unknown> = {};
        if (data.routingNumber) meta.routing_number = data.routingNumber;
        if (data.swiftCode) meta.swift_code = data.swiftCode.toUpperCase();
        if (data.bankName) meta.bank_name = data.bankName;
        // account_type for USD (checking|savings|depository→checking) and GBP
        // (personal|corporate). Default sensibly when the client did not send it.
        if ((data.currencyId || "").toUpperCase() === "USD") {
          const usdType = String(data.accountType || "").toLowerCase();
          meta.account_type = usdType === "savings" ? "savings" : "checking";
        } else if ((data.currencyId || "").toUpperCase() === "GBP") {
          meta.account_type = ["personal", "corporate"].includes(String(data.accountType || "").toLowerCase())
            ? String(data.accountType).toLowerCase()
            : "personal";
        }
        if (data.beneficiaryAddress) meta.beneficiary_address = data.beneficiaryAddress;
        if (data.beneficiaryCity) {
          meta.beneficiary_city = data.beneficiaryCity;
          meta.city = data.beneficiaryCity; // legacy key kept for older rails
        }
        if (data.beneficiaryState) {
          meta.beneficiary_state = data.beneficiaryState;
          meta.state = data.beneficiaryState;
        }
        if (data.beneficiaryPostalCode) {
          meta.beneficiary_postal_code = data.beneficiaryPostalCode;
          meta.postal_code = data.beneficiaryPostalCode; // legacy key
        }
        if (data.recipientStreetNumber) meta.street_number = data.recipientStreetNumber;
        if (data.recipientStreetName) meta.street_name = data.recipientStreetName;
        if (data.beneficiaryEmail) meta.email = data.beneficiaryEmail;
        if (data.beneficiaryCountry) {
          meta.beneficiary_country = String(data.beneficiaryCountry).toUpperCase();
        }
        if (data.senderPhone) meta.sender_mobile_number = data.senderPhone;
        if (data.senderAddress) meta.sender_address = data.senderAddress;
        if (Object.keys(meta).length > 0) payload.meta = [meta];
      }
      if (isIntl) {
        payload.sender = {
          name: data.senderName || data.accountName || "Metroflow business",
          ...(data.senderEmail ? { email: data.senderEmail } : {}),
          ...(data.senderPhone ? { phone_number: data.senderPhone } : {}),
          ...(data.senderAddress ? { address: data.senderAddress } : {}),
          ...(data.senderCity ? { city: data.senderCity } : {}),
          ...(data.senderState ? { state: data.senderState } : {}),
          ...(data.senderPostalCode ? { postal_code: data.senderPostalCode } : {}),
          ...(data.senderCountry || data.beneficiaryCountry
            ? { country: (data.senderCountry || data.beneficiaryCountry).toUpperCase() }
            : {}),
        };
      }

      let response;
      try {
        response = await flwClient.post("/v3/transfers", payload);
      } catch (piError: any) {
        // Fallback: some Flutterwave integrations reject `payment_instruction`
        // (older API revision). Retry ONCE with the classic cross-currency
        // form — currency stays the destination, debit_currency the platform
        // float — before giving up.
        const piMsg = String(piError?.response?.data?.message || piError?.message || "");
        const usedPaymentInstruction = "payment_instruction" in payload;
        if (usedPaymentInstruction && destCurrency !== "NGN") {
          console.warn(`[flutterwave] payment_instruction rejected (${piMsg}); retrying with debit_currency=${sourceCurrency}`);
          delete payload.payment_instruction;
          payload.debit_currency = sourceCurrency;
          response = await flwClient.post("/v3/transfers", payload);
        } else {
          throw piError;
        }
      }
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
      if (FLW_MOCK) {
        const outcome = flwMockOutcome(reference);
        const id = flwMockId(reference);
        if (outcome === "successful") {
          return { status: "success", message: "Transfer fetched", data: { id, status: "SUCCESSFUL", reference, mock: true } };
        }
        if (outcome === "failed" || outcome === "reverted" || outcome === "canceled") {
          const flwStatus = outcome === "failed" ? "FAILED" : outcome.toUpperCase();
          return { status: "success", message: "Transfer fetched", data: { id, status: flwStatus, reference, complete_message: "DISBURSE FAILED: Mock provider failure", mock: true } };
        }
        return { status: "success", message: "Transfer fetched", data: { id, status: "PENDING", reference, mock: true } };
      }
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
      if (FLW_MOCK) {
        return {
          status: "success",
          data: {
            account_number: accountNumber,
            account_name: `MOCK RECEIVER ${accountNumber}`,
          },
        };
      }
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

/**
 * Live FX rate from Flutterwave (GET /v3/transfers/rates).
 * Returns the rate for converting `amount` from source to destination currency.
 */
export async function getFlutterwaveTransferRate(
  amount: number | string,
  sourceCurrency: string,
  destinationCurrency: string,
): Promise<{ rate: number; raw: any }> {
  try {
    if (FLW_MOCK) {
      // Deterministic test rates matching the real API's semantics: the rate
      // CONVERTS source -> destination, i.e. USD-per-NGN (~1/1550), not the
      // colloquial "1 USD = 1550 NGN".
      const mockRates: Record<string, number> = { USD: 1 / 1550, GBP: 1 / 1900, EUR: 1 / 1680 };
      const rate = mockRates[String(destinationCurrency).toUpperCase()] || 1 / 1550;
      return { rate, raw: { mock: true } };
    }
    const response = await flwClient.get("/v3/transfers/rates", {
      params: {
        amount: roundAmount(typeof amount === "string" ? parseFloat(amount) : amount),
        source_currency: sourceCurrency,
        destination_currency: destinationCurrency,
      },
    });
    const body = response.data;
    const rate = Number(body?.data?.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(body?.message || "Invalid rate response");
    }
    return { rate, raw: body?.data };
  } catch (error: any) {
    console.error(
      "Flutterwave Transfer Rate Error:",
      error.response?.data || error.message
    );
    throw new Error(error.response?.data?.message || "Failed to fetch exchange rate");
  }
}

export function isFlutterwaveConfigured(): boolean {
  return Boolean(FLW_SECRET_KEY);
}

/**
 * Public key for client-side checkout SDKs (web inline checkout / mobile).
 * Public by design - safe to expose through public endpoints.
 */
export function getFlutterwavePublicKey(): string | null {
  return FLW_PUBLIC_KEY || null;
}

export function isFlutterwaveWebhookConfigured(): boolean {
  return Boolean(FLW_SECRET_HASH);
}
