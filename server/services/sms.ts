import axios from 'axios';

// Using Termii as the cheapest reliable SMS provider in Nigeria
const TERMII_API_URL = "https://api.ng.termii.com/api/sms/send";
const API_KEY = process.env.TERMII_API_KEY;
const SENDER_ID = process.env.TERMII_SENDER_ID || "N-Alert"; // Or your registered ID

export async function sendSMS(to: string, message: string) {
    if (process.env.NODE_ENV === 'test' || !API_KEY) {
        console.log(`[MOCK SMS] To: ${to}, Message: ${message}`);
        return { success: true, message: "Mock SMS sent" };
    }

    try {
        // Format phone number to international format (234...)
        let phone = to;
        if (phone.startsWith('0')) {
            phone = '234' + phone.substring(1);
        } else if (phone.startsWith('+234')) {
            phone = phone.substring(1);
        }

        const payload = {
            to: phone,
            from: SENDER_ID,
            sms: message,
            type: "plain",
            channel: "generic", // 'dnd' for critical OTPs if enterprise, 'generic' for cheaper
            api_key: API_KEY,
        };

        const response = await axios.post(TERMII_API_URL, payload);
        return response.data;
    } catch (error: any) {
        console.error("SMS Error:", error.response?.data || error.message);
        // Don't throw, just return fail so we can fallback to email if needed
        return { success: false, error: error.message };
    }
}
