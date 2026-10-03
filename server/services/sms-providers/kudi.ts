
import axios from 'axios';
import { SMSProvider } from './index';
import { normalizePhone } from './phone';

/**
 * KudiSMS provider — the DEFAULT SMS channel for OTPs and notifications.
 *
 * API reference (official docs, updated July 2026): https://www.kudisms.net/docs/sms
 *  - Base URL: https://my.kudisms.net/api/
 *  - Endpoint used here: POST /corporate  ("Send Corporate SMS")
 *    Corporate route delivers plain OTP / alert / notification messages and is
 *    the correct route for transactional OTPs (works on DND numbers, and unlike
 *    /otp it needs NO pre-approved app-name or template code — only an approved
 *    Corporate Sender ID, submitted from the dashboard).
 *  - Auth: `token` field = your KudiSMS API key.
 *  - Response always contains an `error_code`; "000" means success.
 *    Full code map: https://www.kudisms.net/docs/errors
 *
 * Required env:
 *   KUDI_API_KEY    — KudiSMS API key (my.kudisms.net dashboard)
 *   KUDI_SENDER_ID  — an APPROVED Corporate Sender ID (e.g. METRICOREX)
 *   KUDI_API_BASE   — optional override (defaults to https://my.kudisms.net/api)
 */

const KUDI_API_BASE = (process.env.KUDI_API_BASE || 'https://my.kudisms.net/api').replace(/\/+$/, '');
const KUDI_CORPORATE_URL = `${KUDI_API_BASE}/corporate`;

// Error-code map from https://www.kudisms.net/docs/errors — surfaces a
// human-readable reason instead of a bare numeric code in logs/API errors.
const KUDI_ERROR_CODES: Record<string, string> = {
    '000': 'Message Sent Successfully',
    '009': 'You are only allowed to send a maximum of 6 pages of SMS at once',
    '100': 'Token provided is invalid',
    '101': 'The account has been deactivated, please contact the admin',
    '103': "The gateway selected doesn't exist",
    '104': 'Blocked message keyword(s)',
    '105': 'The sender ID used has been blocked',
    '106': 'The sender ID used do not exist',
    '107': 'Please provide a valid phone number',
    '108': 'The total amount of recipients is more than the required batch size of 100',
    '109': 'You do not have enough credit balance to perform the transaction',
    '111': 'Only approved promotional Sender ID allowed (corporate route needs a Corporate Sender ID)',
    '114': 'No package attached to this service',
    '185': 'No route attached to this package',
    '187': 'The request could not be processed',
    '188': 'The sender ID is unapproved',
    '300': 'There are missing parameters',
    '401': 'The request could not be completed',
};

export const kudiProvider: SMSProvider = {
    async sendSMS(to: string, message: string) {
        const API_KEY = process.env.KUDI_API_KEY;
        const SENDER_ID = process.env.KUDI_SENDER_ID;

        if (!API_KEY || !SENDER_ID) {
            if (process.env.NODE_ENV === 'production') {
                // Never pretend success in production — OTP routes depend on
                // this failing loudly so users see a real error and retry.
                console.error(
                    '[Kudi SMS] NOT CONFIGURED: KUDI_API_KEY and/or KUDI_SENDER_ID are unset in production. SMS cannot be delivered.'
                );
                return {
                    success: false,
                    provider: 'kudi',
                    error: 'Kudi SMS is not configured on the server (KUDI_API_KEY / KUDI_SENDER_ID missing)',
                };
            }
            console.warn(
                `[MOCK Kudi SMS] To: ${to}, Message: ${message} — set KUDI_API_KEY + KUDI_SENDER_ID for real delivery`
            );
            return { success: true, provider: 'kudi', mock: true, message: 'Mock SMS sent (Kudi not configured)' };
        }

        try {
            const phone = normalizePhone(to);

            // ⚠️ ENCODING (verified live against the real endpoint, Oct 2026):
            // KudiSMS /corporate DOES NOT parse application/x-www-form-urlencoded
            // bodies — a urlencoded POST arrives with an EMPTY $_POST and the API
            // answers 200 {"error_code":"300","msg":"Missing parameters: token,
            // senderID, recipients, message."} even though every field was sent.
            // JSON (and multipart) ARE parsed correctly. JSON is used here.
            const response = await axios.post(
                KUDI_CORPORATE_URL,
                { token: API_KEY, senderID: SENDER_ID, recipients: phone, message },
                {
                    timeout: 15000,
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                },
            );

            const data = response.data || {};
            const ok = data.error_code === '000' || data.status === 'success';

            if (ok) {
                console.log(`[Kudi SMS] Sent to ${phone} | cost=${data.cost ?? '?'} | balance=${data.balance ?? '?'} | msg_id=${JSON.stringify(data.data ?? null)}`);
                return { success: true, provider: 'kudi', response: data };
            }

            const reason = data.msg || KUDI_ERROR_CODES[data.error_code] || `Unexpected KudiSMS response (error_code=${data.error_code})`;
            console.error(`[Kudi SMS] Delivery rejected | to=${phone} | error_code=${data.error_code} | ${reason}`);
            return { success: false, provider: 'kudi', error: reason, response: data };
        } catch (error: any) {
            const apiError =
                error.response?.data?.msg ||
                error.response?.data?.message ||
                (error.response?.data ? JSON.stringify(error.response.data).slice(0, 300) : error.message);
            console.error(`[Kudi SMS] HTTP error | status=${error.response?.status ?? 'n/a'} | ${apiError}`);
            return {
                success: false,
                provider: 'kudi',
                error: typeof apiError === 'string' ? apiError : 'KudiSMS request failed',
                response: error.response?.data,
            };
        }
    },
};
