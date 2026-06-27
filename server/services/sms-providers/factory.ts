import { SMSProvider } from "./index";
import { termiiProvider } from "./termii";
import { kudiProvider } from "./kudi";

const providers: Record<string, SMSProvider> = {
  termii: termiiProvider,
  kudi: kudiProvider,
};

const DEFAULT_PROVIDER = process.env.DEFAULT_SMS_PROVIDER || "termii";

export function getSMSProvider(providerName?: string): SMSProvider {
  const provider = providerName || DEFAULT_PROVIDER;
  if (!providers[provider]) {
    throw new Error(`SMS Provider ${provider} not found`);
  }
  return providers[provider];
}

export function getAvailableSMSProviders(): string[] {
  return Object.keys(providers);
}
