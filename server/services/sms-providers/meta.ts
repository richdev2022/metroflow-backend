
import axios from 'axios';
import { WhatsAppProvider } from './index';

const META_GRAPH_API_URL = process.env.META_GRAPH_API_URL || 'https://graph.facebook.com/v20.0';
const META_WHATSAPP_ACCESS_TOKEN = process.env.META_WHATSAPP_ACCESS_TOKEN;
const META_WHATSAPP_PHONE_NUMBER_ID = process.env.META_WHATSAPP_PHONE_NUMBER_ID;

export const metaProvider: WhatsAppProvider = {
    async sendWhatsApp(to: string, message: string) {
        if (!META_WHATSAPP_ACCESS_TOKEN || !META_WHATSAPP_PHONE_NUMBER_ID) {
            if (process.env.NODE_ENV === 'production') {
                console.error(
                    '[Meta WhatsApp] NOT CONFIGURED: META_WHATSAPP_ACCESS_TOKEN and/or META_WHATSAPP_PHONE_NUMBER_ID are unset in production. Delivery cannot succeed.'
                );
                return {
                    success: false,
                    provider: 'meta',
                    error: 'Meta WhatsApp is not configured on the server (META_WHATSAPP_ACCESS_TOKEN / META_WHATSAPP_PHONE_NUMBER_ID missing)',
                };
            }
            console.warn(`[MOCK Meta WhatsApp] To: ${to}, Message: ${message} — set META_WHATSAPP_ACCESS_TOKEN + META_WHATSAPP_PHONE_NUMBER_ID for real delivery`);
            return { success: true, provider: 'meta', mock: true, message: "Mock WhatsApp sent (Meta not configured)" };
        }

        try {
            // Format phone number (Meta expects it in E.164 format without +)
            let formattedTo = to.replace(/\D/g, '');
            if (!formattedTo.startsWith('234')) {
                if (formattedTo.startsWith('0')) {
                    formattedTo = '234' + formattedTo.slice(1);
                }
            }

            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: formattedTo,
                text: {
                    body: message
                }
            };

            const response = await axios.post(
                `${META_GRAPH_API_URL}/${META_WHATSAPP_PHONE_NUMBER_ID}/messages`,
                payload,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${META_WHATSAPP_ACCESS_TOKEN}`
                    }
                }
            );

            return { success: true, data: response.data };
        } catch (error: any) {
            console.error('Meta WhatsApp Error:', error.response?.data || error.message);
            return { success: false, error: error.response?.data || error.message };
        }
    }
};
