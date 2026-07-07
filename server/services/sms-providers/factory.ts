import { SMSProvider, WhatsAppProvider } from "./index";
import { termiiProvider } from "./termii";
import { kudiProvider } from "./kudi";
import { metaProvider } from "./meta";

const smsProviders: Record<string, SMSProvider> = {
  termii: termiiProvider,
  kudi: kudiProvider,
};

const whatsappProviders: Record<string, WhatsAppProvider> = {
  meta: metaProvider,
  termii: termiiProvider,
};

const DEFAULT_SMS_PROVIDER = process.env.DEFAULT_SMS_PROVIDER || "termii";
const DEFAULT_WHATSAPP_PROVIDER = process.env.DEFAULT_WHATSAPP_PROVIDER || "meta";

export function getSMSProvider(providerName?: string): SMSProvider {
  const provider = providerName || DEFAULT_SMS_PROVIDER;
  if (!smsProviders[provider]) {
    throw new Error(`SMS Provider ${provider} not found`);
  }
  return smsProviders[provider];
}

export function getWhatsAppProvider(providerName?: string): WhatsAppProvider {
  const provider = providerName || DEFAULT_WHATSAPP_PROVIDER;
  if (!whatsappProviders[provider]) {
    throw new Error(`WhatsApp Provider ${provider} not found`);
  }
  return whatsappProviders[provider];
}

export function getAvailableSMSProviders(): string[] {
  return Object.keys(smsProviders);
}

export function getAvailableWhatsAppProviders(): string[] {
  return Object.keys(whatsappProviders);
}
