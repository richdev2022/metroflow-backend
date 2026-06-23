
import axios from "axios";
import crypto from "crypto";
import {
  Provider,
  VirtualAccountRequest,
  BusinessVirtualAccountRequest,
  InitiatePaymentRequest,
  ChargeCardRequest,
  TransferRequest as ProviderTransferRequest,
} from "./index";
import { BANK_LIST, Bank } from "../../utils/bank-codes";

const MONNIFY_API_KEY = process.env.MONNIFY_API_KEY;
const MONNIFY_SECRET_KEY = process.env.MONNIFY_SECRET_KEY;
const MONNIFY_CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE;
const MONNIFY_BASE_URL =
  process.env.MONNIFY_BASE_URL ||
  (process.env.NODE_ENV === "production"
    ? "https://api.monnify.com"
    : "https://sandbox.monnify.com");
const MONNIFY_WALLET_ACCOUNT_NUMBER = process.env.MONNIFY_WALLET_ACCOUNT_NUMBER;

if (!MONNIFY_API_KEY || !MONNIFY_SECRET_KEY || !MONNIFY_CONTRACT_CODE) {
  console.warn(
    "Monnify configuration is incomplete. Monnify services may fail."
  );
}

interface MonnifyAuthResponse {
  requestSuccessful: boolean;
  responseBody: {
    accessToken: string;
    expiresIn: number;
  };
}

let cachedAccessToken: string | null = null;
let tokenExpiryTime: number = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiryTime) {
    return cachedAccessToken;
  }

  const authString = Buffer.from(
    `${MONNIFY_API_KEY}:${MONNIFY_SECRET_KEY}`
  ).toString("base64");

  try {
    const response = await axios.post<MonnifyAuthResponse>(
      `${MONNIFY_BASE_URL}/api/v1/auth/login`,
      {},
      {
        headers: {
          Authorization: `Basic ${authString}`,
        },
      }
    );

    if (response.data.requestSuccessful) {
      cachedAccessToken = response.data.responseBody.accessToken;
      tokenExpiryTime = now + (response.data.responseBody.expiresIn - 60) * 1000; // Subtract 60s for buffer
      return cachedAccessToken;
    } else {
      throw new Error("Failed to get Monnify access token");
    }
  } catch (error: any) {
    console.error(
      "Monnify Auth Error:",
      error.response?.data || error.message
    );
    throw new Error("Failed to get Monnify access token");
  }
}

const monnifyClient = axios.create({
  baseURL: MONNIFY_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

// Add interceptor to add access token to all requests
monnifyClient.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export const monnifyProvider: Provider = {
  name: "monnify",

  getRequirements() {
    return {
      personalVirtualAccount: {
        requiredFields: [
          "bvn",
          "nin",
          "firstName",
          "lastName",
          "email",
          "phoneNumber",
        ],
      },
      businessVirtualAccount: {
        requiredFields: [
          "bvn",
          "nin",
          "businessName",
          "email",
          "phoneNumber",
        ],
      },
    };
  },

  async createVirtualAccount(data: VirtualAccountRequest) {
    try {
      // First try to get existing account from Monnify
      try {
        const getResponse = await monnifyClient.get(
          `/api/v2/bank-transfer/reserved-accounts/${data.customerIdentifier}`
        );
        if (getResponse.data.requestSuccessful) {
          console.log("Retrieved existing Monnify virtual account");
          return getResponse.data;
        }
      } catch (getError: any) {
        // If not found, continue to create new account
        console.log("Existing account not found, creating new one...");
      }

      const fullName = `${data.firstName || ""} ${data.lastName || ""}`.trim();
      const payload = {
        accountReference: data.customerIdentifier,
        accountName: fullName,
        currencyCode: "NGN",
        contractCode: MONNIFY_CONTRACT_CODE,
        customerEmail: data.email,
        customerName: fullName,
        bvn: data.bvn,
        nin: data.nin,
        getAllAvailableBanks: true,
        preferredBanks: ["50515"], // Moniepoint MFB as default
      };

      const response = await monnifyClient.post(
        "/api/v2/bank-transfer/reserved-accounts",
        payload
      );
      return response.data;
    } catch (error: any) {
      console.error(
        "Monnify Create VA Error:",
        error.response?.data || error.message
      );
      // If error is "same reference", try to retrieve account
      if (
        error.response?.data?.responseMessage?.includes("same reference")
      ) {
        try {
          console.log("Trying to retrieve existing account after error...");
          const getResponse = await monnifyClient.get(
            `/api/v2/bank-transfer/reserved-accounts/${data.customerIdentifier}`
          );
          if (getResponse.data.requestSuccessful) {
            return getResponse.data;
          }
        } catch (retrieveError: any) {
          console.error("Failed to retrieve existing account:", retrieveError.response?.data || retrieveError.message);
        }
      }
      throw new Error(
        error.response?.data?.responseMessage ||
          "Virtual Account creation failed"
      );
    }
  },

  async createBusinessVirtualAccount(data: BusinessVirtualAccountRequest) {
    try {
      // First try to get existing account from Monnify
      try {
        const getResponse = await monnifyClient.get(
          `/api/v2/bank-transfer/reserved-accounts/${data.customerIdentifier}`
        );
        if (getResponse.data.requestSuccessful) {
          console.log("Retrieved existing Monnify business virtual account");
          return getResponse.data;
        }
      } catch (getError: any) {
        // If not found, continue to create new account
        console.log("Existing business account not found, creating new one...");
      }

      const payload = {
        accountReference: data.customerIdentifier,
        accountName: data.businessName,
        currencyCode: "NGN",
        contractCode: MONNIFY_CONTRACT_CODE,
        customerEmail: data.customerIdentifier + "@metrocorex.ng", // Temporary email, can be updated later
        customerName: data.businessName,
        bvn: data.bvn,
        nin: data.nin,
        getAllAvailableBanks: true,
        preferredBanks: ["50515"],
      };

      let response;
      try {
        response = await monnifyClient.post(
          "/api/v2/bank-transfer/reserved-accounts",
          payload
        );
      } catch (error: any) {
        // If error is "same reference", try to retrieve account
        if (
          error.response?.data?.responseMessage?.includes("same reference")
        ) {
          try {
            console.log("Trying to retrieve existing business account after error...");
            const getResponse = await monnifyClient.get(
              `/api/v2/bank-transfer/reserved-accounts/${data.customerIdentifier}`
            );
            if (getResponse.data.requestSuccessful) {
              return getResponse.data;
            }
          } catch (retrieveError: any) {
            console.error("Failed to retrieve existing business account:", retrieveError.response?.data || retrieveError.message);
          }
        }
        throw error;
      }

      // Also update KYC info if needed (to link business details properly)
      if (response.data.requestSuccessful) {
        try {
          await monnifyClient.put(
            `/api/v1/bank-transfer/reserved-accounts/${data.customerIdentifier}/kyc-info`,
            {
              bvn: data.bvn,
              nin: data.nin,
            }
          );
        } catch (kycError) {
          console.warn("Failed to update KYC info for business VA, but VA was created:", kycError);
        }
      }

      return response.data;
    } catch (error: any) {
      console.error(
        "Monnify Create Business VA Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.responseMessage ||
          "Business Virtual Account creation failed"
      );
    }
  },

  async initiatePayment(request: InitiatePaymentRequest) {
    try {
      const amount =
        typeof request.amount === "string"
          ? parseFloat(request.amount)
          : request.amount;

      const payload = {
        amount: amount / 100, // Monnify expects major unit (Naira)
        customerName: request.email.split("@")[0],
        customerEmail: request.email,
        paymentReference: request.reference,
        paymentDescription: "Wallet funding",
        currencyCode: request.currency || "NGN",
        contractCode: MONNIFY_CONTRACT_CODE,
        redirectUrl: request.callbackUrl,
      };

      const response = await monnifyClient.post(
        "/api/v1/merchant/transactions/init-transaction",
        payload
      );
      return {
        success: response.data.requestSuccessful,
        message: response.data.responseMessage,
        data: {
          checkout_url: response.data.responseBody.checkoutUrl,
        },
      };
    } catch (error: any) {
      console.error(
        "Monnify Initiate Payment Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.responseMessage || "Payment initiation failed"
      );
    }
  },

  async verifyPayment(reference: string) {
    try {
      const response = await monnifyClient.get(
        `/api/v2/merchant/transactions/query?paymentReference=${reference}`
      );
      return {
        success: response.data.requestSuccessful,
        message: response.data.responseMessage,
        data: response.data.responseBody,
      };
    } catch (error: any) {
      console.error(
        "Monnify Verify Payment Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.responseMessage || "Payment verification failed"
      );
    }
  },

  async chargeCard(data: ChargeCardRequest) {
    try {
      const payload = {
        cardToken: data.tokenId,
        amount: data.amount / 100,
        customerEmail: "customer@example.com", // TODO: Should get from somewhere
        paymentReference:
          data.transactionRef ||
          `CHG_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      };

      const response = await monnifyClient.post(
        "/api/v1/merchant/cards/charge-card-token",
        payload
      );
      return response.data;
    } catch (error: any) {
      console.error(
        "Monnify Charge Card Error:",
        error.response?.data || error.message
      );
      if (error.response?.data) {
        return error.response.data;
      }
      throw new Error(
        error.response?.data?.responseMessage || "Card charge failed"
      );
    }
  },

  async cancelRecurring(token: string) {
    console.log(`[Monnify] Cancel recurring for token: ${token}`);
    return { success: true, message: "Recurring subscription cancelled locally" };
  },

  async initiateTransfer(data: ProviderTransferRequest) {
    try {
      const amount =
        typeof data.amount === "string"
          ? parseFloat(data.amount)
          : data.amount;

      const payload = {
        amount: amount / 100,
        reference: data.transactionReference,
        narration: data.remark,
        destinationBankCode: data.bankCode,
        destinationAccountNumber: data.accountNumber,
        currency: "NGN",
        sourceAccountNumber: MONNIFY_WALLET_ACCOUNT_NUMBER,
      };

      const response = await monnifyClient.post(
        "/api/v2/disbursements/single",
        payload
      );
      return response.data;
    } catch (error: any) {
      console.error(
        "Monnify Transfer Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.responseMessage || "Transfer initiation failed"
      );
    }
  },

  async accountLookup(bankCode: string, accountNumber: string) {
    try {
      const response = await monnifyClient.get(
        `/api/v1/disbursements/account/validate?accountNumber=${accountNumber}&bankCode=${bankCode}`
      );
      return response.data;
    } catch (error: any) {
      console.error(
        "Monnify Account Lookup Error:",
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.responseMessage || "Account lookup failed"
      );
    }
  },

  getBanks(): Bank[] {
    return BANK_LIST;
  },

  verifyWebhook(body: any, signature: string): boolean {
    if (!MONNIFY_SECRET_KEY) return false;
    const hash = crypto
      .createHmac("sha512", MONNIFY_SECRET_KEY)
      .update(JSON.stringify(body))
      .digest("hex");
    return hash === signature;
  },
};
