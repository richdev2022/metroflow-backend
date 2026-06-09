
import { Provider } from "./index";
import { squadProvider } from "./squad";
import { monnifyProvider } from "./monnify"; // We'll create this next

const providers: Record<string, Provider> = {
  squad: squadProvider,
  monnify: monnifyProvider,
};

const DEFAULT_PROVIDER = process.env.DEFAULT_PAYMENT_PROVIDER || "squad";

export function getProvider(providerName?: string): Provider {
  const provider = providerName || DEFAULT_PROVIDER;
  if (!providers[provider]) {
    throw new Error(`Provider ${provider} not found`);
  }
  return providers[provider];
}

export function getAvailableProviders(): string[] {
  return Object.keys(providers);
}
