
import axios from 'axios';
import { SMSProvider, WhatsAppProvider } from './index';
import { normalizePhone } from './phone';

const TERMII_API_URL = "https://api.ng.termii.com/api/sms/send";
const TERMII_WHATSAPP_URL = "https://api.ng.termii.com/api/whatsapp/send";
const API_KEY = process.env.TERMII_API_KEY;
const SENDER_ID = process.env.TERMII_SENDER_ID || "N-Alert";

function missingConfigResult(channel: 'SMS' | 'WhatsApp') {
    if (process.env.NODE_ENV === 'production') {
        console.error(
            `[Termii ${channel}] NOT CONFIGURED: TERMII_API_KEY is unset in production. Delivery cannot succeed via Termii.`
        );
        return {
            success: false as const,
            provider: 'termii',
            error: 'Termii is not configured on the server (TERMII_API_KEY missing)',
        };
    }
    return null; // caller falls through to mock
}

export const termiiProvider: SMSProvider & WhatsAppProvider = {
    async sendSMS(to: string, message: string) {
        if (!API_KEY) {
            const missing = missingConfigResult('SMS');
            if (missing) return missing;
            console.warn(`[MOCK Termii SMS] To: ${to}, Message: ${message} — set TERMII_API_KEY for real delivery`);
            return { success: true, provider: 'termii', mock: true, message: 'Mock SMS sent (Termii not configured)' };
        }

        try {
            const payload = {
                to: normalizePhone(to),
                from: SENDER_ID,
                sms: message,
                type: "plain",
                channel: "generic",
                api_key: API_KEY,
            };

            const response = await axios.post(TERMII_API_URL, payload, { timeout: 15000 });
            const data = response.data || {};

            // Termii success responses carry message:"success" (+ message_id).
            if (data.message === 'success' || data.message_id) {
                return { success: true, provider: 'termii', response: data };
            }
            const reason = data.msg || data.message || 'Unexpected Termii response';
            console.error(`[Termii SMS] Delivery rejected | to=${payload.to} | ${reason}`);
            return { success: false, provider: 'termii', error: reason, response: data };
        } catch (error: any) {
            console.error("Termii SMS Error:", error.response?.data || error.message);
            return {
                success: false,
                provider: 'termii',
                error: error.response?.data?.msg || error.message,
                response: error.response?.data,
            };
        }
    },

    async sendWhatsApp(to: string, message: string) {
        if (!API_KEY) {
            const missing = missingConfigResult('WhatsApp');
            if (missing) return missing;
            console.warn(`[MOCK Termii WhatsApp] To: ${to}, Message: ${message} — set TERMII_API_KEY for real delivery`);
            return { success: true, provider: 'termii', mock: true, message: 'Mock WhatsApp sent (Termii not configured)' };
        }

        try {
            const payload = {
                to: normalizePhone(to),
                from: process.env.TERMII_WHATSAPP_NUMBER || SENDER_ID,
                type: "text",
                sms: message,
                api_key: API_KEY,
                media: null
            };

            const response = await axios.post(TERMII_WHATSAPP_URL, payload, { timeout: 15000 });
            const data = response.data || {};

            if (data.message === 'success' || data.message_id) {
                return { success: true, provider: 'termii', response: data };
            }
            const reason = data.msg || data.message || 'Unexpected Termii response';
            console.error(`[Termii WhatsApp] Delivery rejected | to=${payload.to} | ${reason}`);
            return { success: false, provider: 'termii', error: reason, response: data };
        } catch (error: any) {
            console.error("Termii WhatsApp Error:", error.response?.data || error.message);
            return {
                success: false,
                provider: 'termii',
                error: error.response?.data?.msg || error.message,
                response: error.response?.data,
            };
        }
    }
};
