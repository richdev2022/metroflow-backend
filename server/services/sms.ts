import { getSMSProvider } from './sms-providers/factory';

/**
 * Sends an SMS through the configured default provider (KudiSMS).
 *
 * Providers return a normalized envelope { success, provider, error?, ... }.
 * A failed provider request THROWS here so calling routes (transfer OTP,
 * PIN-update OTP, KYC OTP, contact-change OTP...) fail with a real error
 * instead of responding "OTP sent successfully" while nothing was delivered.
 */
export async function sendSMS(to: string, message: string) {
    const provider = getSMSProvider();
    const result = await provider.sendSMS(to, message);

    if (!result || result.success === false) {
        const reason = result?.error || (result ? JSON.stringify(result).slice(0, 300) : 'no response from provider');
        console.error(`[SMS DELIVERY FAILED] provider=${result?.provider || 'unknown'} to=${to} reason=${reason}`);
        throw new Error(`SMS delivery failed: ${reason}`);
    }

    return result;
}
