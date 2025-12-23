import axios from 'axios';

const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY;

// Determine Base URL
// 1. Use SQUAD_BASE_URL if explicitly set in .env
// 2. Fallback to derived URL based on environment (production/live vs sandbox)
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.SQUAD_ENV === 'live';
const DEFAULT_URL = IS_PRODUCTION 
  ? 'https://api-d.squadco.com' 
  : 'https://sandbox-api-d.squadco.com';

const BASE_URL = process.env.SQUAD_BASE_URL || DEFAULT_URL;

export interface InitiatePaymentInput {
  amount: number;
  email: string;
  reference: string;
  callbackUrl: string;
  currency?: string;
  isRecurring?: boolean;
}

export interface VerifyPaymentResponse {
  success: boolean;
  data?: {
    transaction_ref: string;
    transaction_status: string;
    amount: number;
    currency: string;
    token_id?: string; // Capture token from webhook/verification if available
    card_details?: any; // Allow any structure for card details
    payment_information?: any; // Allow any structure for payment info
  };
}

export const initiatePayment = async (input: InitiatePaymentInput) => {
  const apiKey = process.env.SQUAD_SECRET_KEY;
  if (!apiKey) {
    console.error("SQUAD_SECRET_KEY is missing in environment variables");
    throw new Error("Payment configuration error");
  }

  try {
    console.log(`Initiating payment with Squad (${BASE_URL}) for ${input.email}`);
    const response = await axios.post(
      `${BASE_URL}/transaction/initiate`,
      {
        amount: input.amount,
        email: input.email,
        currency: input.currency || "NGN",
        initiate_type: "inline",
        transaction_ref: input.reference,
        callback_url: input.callbackUrl,
        is_recurring: input.isRecurring || false,
        payment_channels: ['card']
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (error: any) {
    console.error('Squad initiate error details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      headers: error.response?.headers,
      requestHeaders: error.config?.headers
    });
    throw error;
  }
};

export const chargeCard = async (amount: number, tokenId: string, transactionRef?: string) => {
  const apiKey = process.env.SQUAD_SECRET_KEY;
  if (!apiKey) throw new Error("SQUAD_SECRET_KEY is missing");

  try {
    const payload: any = {
      amount: amount,
      token_id: tokenId,
    };
    if (transactionRef) {
      payload.transaction_ref = transactionRef;
    }

    const response = await axios.post(
      `${BASE_URL}/transaction/charge_card`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (error: any) {
    console.error('Squad charge card error:', error.response?.data || error.message);
    throw error;
  }
};

export const cancelRecurring = async (tokenId: string) => {
  const apiKey = process.env.SQUAD_SECRET_KEY;
  if (!apiKey) throw new Error("SQUAD_SECRET_KEY is missing");

  try {
    const response = await axios.patch(
      `${BASE_URL}/transaction/cancel/recurring`,
      {
        auth_code: [tokenId]
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (error: any) {
    console.error('Squad cancel recurring error:', error.response?.data || error.message);
    throw error;
  }
};

export const verifyPayment = async (reference: string): Promise<VerifyPaymentResponse> => {
  const apiKey = process.env.SQUAD_SECRET_KEY;
  if (!apiKey) throw new Error("SQUAD_SECRET_KEY is missing");

  try {
    const response = await axios.get(
      `${BASE_URL}/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );
    return response.data;
  } catch (error: any) {
    console.error('Squad verify error:', error.response?.data || error.message);
    throw error;
  }
};

export const queryTransactions = async (params: { 
    page?: number; 
    perPage?: number; 
    reference?: string; 
    startDate: string; // Compulsory
    endDate: string;   // Compulsory
    currency?: string;
}) => {
    try {
        const response = await axios.get(`${BASE_URL}/transaction`, {
            params: {
                page: params.page,
                perpage: params.perPage,
                reference: params.reference,
                start_date: params.startDate,
                end_date: params.endDate,
                currency: params.currency
            },
            headers: {
                Authorization: `Bearer ${SQUAD_SECRET_KEY}`,
            },
        });
        return response.data;
    } catch (error: any) {
        console.error('Squad query transactions error:', error.response?.data || error.message);
        throw error;
    }
};
