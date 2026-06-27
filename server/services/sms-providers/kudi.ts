
import axios from 'axios';
import FormData from 'form-data';
import { SMSProvider } from './index';

const KUDI_API_URL = "https://my.kudisms.net/api/corporate";
const API_KEY = process.env.KUDI_API_KEY;
const SENDER_ID = process.env.KUDI_SENDER_ID;

export const kudiProvider: SMSProvider = {
  async sendSMS(to: string, message: string) {
    if (process.env.NODE_ENV === 'test' || !API_KEY || !SENDER_ID) {
      console.log(`[MOCK Kudi SMS] To: ${to}, Message: ${message}`);
      return { success: true, message: "Mock SMS sent" };
    }

    try {
      let phone = to;
      if (phone.startsWith('0')) {
        phone = '234' + phone.substring(1);
      } else if (phone.startsWith('+234')) {
        phone = phone.substring(1);
      }

      const formData = new FormData();
      formData.append('token', API_KEY);
      formData.append('senderID', SENDER_ID);
      formData.append('recipients', phone);
      formData.append('message', message);

      const response = await axios.post(KUDI_API_URL, formData, {
        headers: formData.getHeaders()
      });
      return response.data;
    } catch (error: any) {
      console.error("Kudi SMS Error:", error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }
};

