
import { getWhatsAppProvider } from './sms-providers/factory';

export async function sendWhatsApp(to: string, message: string) {
    const provider = getWhatsAppProvider();
    return provider.sendWhatsApp(to, message);
}
