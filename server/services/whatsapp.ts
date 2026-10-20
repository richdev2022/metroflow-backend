import { getWhatsAppProvider } from './sms-providers/factory';

/**
 * Sends a WhatsApp message through the configured default provider (Meta).
 *
 * Throws when the provider reports a failure so OTP routes surface a real
 * error to the client instead of a silent fake success.
 */
export async function sendWhatsApp(to: string, message: string) {
    const provider = getWhatsAppProvider();
    const result = await provider.sendWhatsApp(to, message);

    if (!result || result.success === false) {
        const reason = result?.error || (result ? JSON.stringify(result).slice(0, 300) : 'no response from provider');
        console.error(`[WHATSAPP DELIVERY FAILED] provider=${result?.provider || 'unknown'} to=${to} reason=${reason}`);
        throw new Error(`WhatsApp delivery failed: ${reason}`);
    }

    return result;
}
