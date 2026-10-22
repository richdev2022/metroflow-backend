/**
 * Feature-level Prestmit shim — the REAL client lives in
 * server/services/prestmit.ts (HMAC-signed, full endpoint surface).
 * This module keeps the historical feature imports stable.
 */
export {
  isPrestmitConfigured,
  prestmitGet,
  prestmitPost,
  prestmitPostMultipart,
  sellCategories,
  sellSubcategories,
  sellRateCalculatorData,
  sellPayoutMethods,
  createSellTrade,
  sellHistory,
  buyConfig,
  createBuyTrade,
  buyHistory,
} from "../../services/prestmit";

import { buyCalculate, fetchCardCodes, serviceAvailability } from "../../services/prestmit";

export async function buyCalculatePayment(input: { giftCardSKU: string; price: number; quantity: number }): Promise<any> {
  return buyCalculate(input.giftCardSKU, input.price, input.quantity);
}

export async function buyFetchCodes(reference: string): Promise<any> {
  return fetchCardCodes(reference);
}

export async function prestmitServiceAvailability(): Promise<Record<string, boolean>> {
  return serviceAvailability();
}
