import { getSMSProvider } from './sms-providers/factory';

export async function sendSMS(to: string, message: string) {
    const provider = getSMSProvider();
    return provider.sendSMS(to, message);
}
