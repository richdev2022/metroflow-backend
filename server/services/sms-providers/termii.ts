
import axios from 'axios';
import { SMSProvider, WhatsAppProvider } from './index';

const TERMII_API_URL = "https://api.ng.termii.com/api/sms/send";
const TERMII_WHATSAPP_URL = "https://api.ng.termii.com/api/whatsapp/send";
const API_KEY = process.env.TERMII_API_KEY;
const SENDER_ID = process.env.TERMII_SENDER_ID || "N-Alert";

export const termiiProvider: SMSProvider & WhatsAppProvider = {
  async sendSMS(to: string, message: string) {
    if (process.env.NODE_ENV === 'test' || !API_KEY) {
      console.log(`[MOCK Termii SMS] To: ${to}, Message: ${message}`);
      return { success: true, message: "Mock SMS sent" };
    }

    try {
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
        channel: "generic",
        api_key: API_KEY,
      };

      const response = await axios.post(TERMII_API_URL, payload);
      return response.data;
    } catch (error: any) {
      console.error("Termii SMS Error:", error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  },

  async sendWhatsApp(to: string, message: string) {
    if (process.env.NODE_ENV === 'test' || !API_KEY) {
      console.log(`[MOCK Termii WhatsApp] To: ${to}, Message: ${message}`);
      return { success: true, message: "Mock WhatsApp sent" };
    }

    try {
      let phone = to;
      if (phone.startsWith('0')) {
        phone = '234' + phone.substring(1);
      } else if (phone.startsWith('+234')) {
        phone = phone.substring(1);
      }

      const payload = {
        to: phone,
        from: process.env.TERMII_WHATSAPP_NUMBER || SENDER_ID,
        type: "text",
        sms: message,
        api_key: API_KEY,
        media: null
      };

      const response = await axios.post(TERMII_WHATSAPP_URL, payload);
      return response.data;
    } catch (error: any) {
      console.error("Termii WhatsApp Error:", error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }
};

