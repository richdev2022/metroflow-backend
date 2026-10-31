import { query } from "../../db";
import { creditPlatformWallet } from "../../services/fees";
import { creditRevenueWallet, debitRevenueWallet } from "../../services/fees";
import { insertTransaction, creditCashbackBalance, debitCashbackBalance } from "./personal-utils";

/**
 * BILL MONEY ENGINE — the single ledger path for bill-payment money events
 * beyond the customer's own debit/credit:
 *
 *   1. VENDOR HOLD  (`<ref>-VENDOR`, platform ledger, at dispatch)
 *      The moment a bill is dispatched to the provider, the platform
 *      operational wallet is debited the face value. The provider is going to
 *      consume real float for it — securing the funds first means a failed
 *      settlement can never leave the pool holding money for a vendor that
 *      was never paid (and vice versa: a delivered bill always has its vendor
 *      cost reserved).
 *
 *   2. DISCOUNT MARGIN (`<ref>-DISCOUNT-REVENUE`, revenue ledger, on completion)
 *      Sogo's webhook/purchase payload carries the DISCOUNTED amount the
 *      provider actually charges us (their wholesale rate is below face
 *      value). Face − discounted = platform margin → credited to the REVENUE
 *      ledger, well narrated, so the discount the provider grants is captured
 *      as revenue instead of silently diluting the float.
 *
 *   3. CASHBACK (`<ref>-CB`, user cashback balance)
 *      Admin-configured airtime/data cashback accrues to the wallet's
 *      DEDICATED cashback balance (spendable on bill payments), with its own
 *      user-visible ledger row.
 *
 *   4. CASHBACK FUNDING (`<ref>-CB-FUND`, revenue ledger)
 *      The promo cashback is not free money: the moment it is credited to
 *      the customer's cashback balance — almost immediately after the
 *      provider's commission/discount from the webhook was credited into the
 *      Revenue ledger — the same amount is DEBITED from the PLATFORM REVENUE
 *      ledger. Revenue pays for cashback; the books stay balanced.
 *
 * Every write is idempotent by reference, so the pay flow, the webhook
 * handler, the settlement reaper and the sync endpoints can all call these
 * concurrently without double-posting.
 */

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Best-effort extraction of what the provider actually charged for a bill
 * from a Sogo transaction payload (purchase response OR webhook). Sogo has
 * used several shapes; sniff defensively and fall back to the face value.
 */
export function extractProviderCharge(tx: any, faceValue: number): { charge: number; discount: number; source: string } {
  const face = r2(faceValue);
  if (!tx || typeof tx !== "object") return { charge: face, discount: 0, source: "face-value-fallback" };

  const num = (v: any): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? r2(n) : null;
  };

  // 1. Explicit discount on the payload (webhook metadata.discount_amount).
  const discount = num(tx?.metadata?.discount_amount) ?? num(tx?.discount_amount) ?? num(tx?.discount) ?? 0;
  if (discount > 0) {
    const charge = Math.max(0, r2(face - discount));
    return { charge, discount: r2(discount), source: "payload-discount" };
  }

  // 2. The net amount Sogo settled to their own books for this bill.
  const net = num(tx?.net_amount?.raw) ?? num(tx?.net_amount) ?? num(tx?.amount_charged) ?? num(tx?.settlement_amount);
  const rawAmount = num(tx?.amount?.raw) ?? num(tx?.amount);
  if (net != null && rawAmount != null && net < rawAmount) {
    return { charge: net, discount: r2(rawAmount - net), source: "net-vs-amount" };
  }

  // 3. Fee field on the transaction = the provider's charge leg.
  const fee = num(tx?.fee?.raw) ?? num(tx?.fee);
  if (fee != null && fee > 0 && fee <= face) {
    return { charge: fee, discount: r2(face - fee), source: "fee-field" };
  }

  return { charge: face, discount: 0, source: "face-value-fallback" };
}

/**
 * VENDOR HOLD — debit the platform operational wallet by the bill face value.
 * Idempotent on the `${ref}-VENDOR` platform ledger row.
 */
export async function holdVendorForBill(reference: string, faceValue: number, category: string): Promise<void> {
  const face = r2(faceValue);
  if (!(face > 0) || !reference) return;
  try {
    const existing = await query(
      `SELECT 1 FROM transactions WHERE reference = $1 AND transaction_type = 'platform' LIMIT 1`,
      [`${reference}-VENDOR`],
    );
    if (existing.rows.length) return;
    await creditPlatformWallet(
      -face,
      "NGN",
      `${reference}-VENDOR`,
      `Vendor funds hold — ${category} bill dispatched to provider (${reference})`,
      "bills",
    );
  } catch (e: any) {
    console.error(`[bill-ledger] vendor hold failed for ${reference}:`, e?.message);
  }
}

/**
 * COMPLETION LEDGER — post the provider's discounted charge + margin to the
 * ledgers and accrue promo cashback. Idempotent per reference.
 *   - Ensures the vendor hold exists (at the REAL provider charge when known).
 *   - Credits the discount margin (face − provider charge) to the revenue ledger.
 */
export async function recordBillCompletionLedger(bill: {
  reference: string;
  category: string;
  amount: number | string;
  user_id?: string;
  business_id?: string | null;
  wallet_id?: string | null;
}, providerTx: any): Promise<{ vendorCharge: number; discount: number; source: string }> {
  const reference = String(bill?.reference || "");
  const face = r2(Number(bill?.amount) || 0);
  if (!reference || !(face > 0)) return { vendorCharge: 0, discount: 0, source: "skipped" };

  const { charge, discount, source } = extractProviderCharge(providerTx, face);

  // 1. Vendor leg: hold exists? if not, post it at the REAL provider charge.
  try {
    const vendorRow = await query(
      `SELECT amount FROM transactions WHERE reference = $1 AND transaction_type = 'platform' LIMIT 1`,
      [`${reference}-VENDOR`],
    );
    if (!vendorRow.rows.length) {
      await creditPlatformWallet(
        -charge,
        "NGN",
        `${reference}-VENDOR`,
        `Vendor charge — ${bill.category} bill paid by provider (${reference})`,
        "bills",
      );
    } else {
      const held = r2(Number(vendorRow.rows[0].amount) || 0);
      if (charge < held) {
        // We held the face value but the provider only charged the discounted
        // amount — release the difference back to the operational pool.
        await creditPlatformWallet(
          r2(held - charge),
          "NGN",
          `${reference}-VENDOR-RELEASE`,
          `Vendor over-hold released — provider charged ₦${charge.toLocaleString()} of ₦${held.toLocaleString()} (${reference})`,
          "bills",
        );
      }
    }
  } catch (e: any) {
    console.error(`[bill-ledger] vendor leg failed for ${reference}:`, e?.message);
  }

  // 2. Discount margin → Revenue ledger (narrated for the record).
  if (discount > 0) {
    try {
      const existing = await query(
        `SELECT 1 FROM transactions WHERE reference = $1 AND wallet_id IS NULL LIMIT 1`,
        [`${reference}-DISCOUNT-REVENUE-CREDIT`],
      );
      if (!existing.rows.length) {
        await creditRevenueWallet(
          discount,
          "NGN",
          `${reference}-DISCOUNT`,
          `Bill purchase discount — provider charged ₦${charge.toLocaleString()} for ₦${face.toLocaleString()} ${bill.category} bill (${reference}); margin booked as revenue`,
          "bills",
        );
      }
    } catch (e: any) {
      console.error(`[bill-ledger] discount revenue failed for ${reference}:`, e?.message);
    }
  }

  return { vendorCharge: charge, discount, source };
}

/**
 * CASHBACK FUNDING — pay for the promo cashback out of the PLATFORM REVENUE
 * ledger. Called by every accrual path (pay flow, webhook settlement, reaper,
 * sync) right after the provider's commission/discount was credited into the
 * Revenue ledger, so the sequence the books see is:
 *
 *   Revenue ledger  +commission (webhook)   →  Revenue ledger −cashback
 *                                                →  user cashback balance +cashback
 *
 * Idempotent on the `${ref}-CB-FUND-REVENUE-DEBIT` revenue row, so
 * concurrent settlers can never double-fund the same cashback.
 */
export async function fundBillCashbackFromRevenue(bill: {
  reference: string;
  category?: string;
}, cashbackAmount: number): Promise<boolean> {
  const reference = String(bill?.reference || "");
  const cb = r2(Number(cashbackAmount) || 0);
  if (!reference || !(cb > 0)) return false;
  try {
    const existing = await query(
      `SELECT 1 FROM transactions WHERE reference = $1 AND wallet_id IS NULL LIMIT 1`,
      [`${reference}-CB-FUND-REVENUE-DEBIT`],
    );
    if (existing.rows.length) return true; // already funded — idempotent no-op
    await debitRevenueWallet(
      cb,
      "NGN",
      `${reference}-CB-FUND`,
      `Bill cashback funded from platform revenue — ₦${cb.toLocaleString()} promo cashback for ${bill.category || "bill"} ${reference} moved from the Revenue ledger to the customer's cashback balance`,
      "bills",
    );
    return true;
  } catch (e: any) {
    console.error(`[bill-ledger] cashback revenue funding failed for ${reference}:`, e?.message);
    return false;
  }
}

/**
 * CASHBACK accrual — credit the promo cashback into the wallet's DEDICATED
 * cashback balance with a user-visible ledger row. Idempotent on `${ref}-CB`.
 * The accrual is REVENUE-FUNDED: the exact amount is first debited from the
 * Platform Revenue ledger (immediately after the provider's commission from
 * the webhook was credited there), then the customer's cashback balance is
 * topped up — revenue pays for cashback, always.
 */
export async function accrueBillCashback(bill: {
  reference: string;
  category: string;
  amount: number | string;
  user_id?: string;
  business_id?: string | null;
  wallet_id?: string | null;
}, cashbackAmount: number, percentLabel: number | string): Promise<boolean> {
  const reference = String(bill?.reference || "");
  const cb = r2(Number(cashbackAmount) || 0);
  if (!reference || !(cb > 0) || !bill.wallet_id) return false;
  try {
    const existing = await query(
      `SELECT 1 FROM transactions WHERE reference = $1 AND type = 'credit' LIMIT 1`,
      [`${reference}-CB`],
    );
    if (existing.rows.length) return false;
    // FUNDING LEG — debit the Platform Revenue ledger first (best-effort: a
    // failed revenue row must never block the customer's cashback; support
    // can replay it), then credit the user's cashback balance.
    await fundBillCashbackFromRevenue(bill, cb);
    await creditCashbackBalance(String(bill.wallet_id), cb);
    await insertTransaction({
      userId: bill.user_id ?? null,
      businessId: bill.business_id ?? null,
      walletId: bill.wallet_id,
      reference: `${reference}-CB`,
      type: "credit",
      transactionType: "bill_cashback",
      amount: cb,
      currency: "NGN",
      description: `Cashback — ${bill.category} bill payment (${percentLabel}%) credited to your cashback balance`,
    });
    return true;
  } catch (e: any) {
    console.error(`[bill-ledger] cashback accrual failed for ${reference}:`, e?.message);
    return false;
  }
}

/**
 * Cashback clawback (reversal path) — take the promo cashback back out of the
 * cashback balance when the bill is reversed. Best-effort: whatever is still
 * in the cashback balance is taken; spent cashback never blocks a refund.
 */
export async function clawbackBillCashback(bill: { reference: string; user_id?: string; business_id?: string | null; wallet_id?: string | null }): Promise<number> {
  const reference = String(bill?.reference || "");
  if (!reference || !bill.wallet_id) return 0;
  try {
    const cbRow = await query(
      `SELECT amount FROM transactions WHERE reference = $1 AND type = 'credit' LIMIT 1`,
      [`${reference}-CB`],
    );
    const cb = r2(Number(cbRow.rows[0]?.amount) || 0);
    if (!(cb > 0)) return 0;
    const existingReversal = await query(
      `SELECT 1 FROM transactions WHERE reference = $1 LIMIT 1`,
      [`${reference}-CB-REVERSAL`],
    );
    if (existingReversal.rows.length) return 0;
    const taken = await debitCashbackBalance(String(bill.wallet_id), cb);
    if (taken > 0) {
      await insertTransaction({
        userId: bill.user_id ?? null,
        businessId: bill.business_id ?? null,
        walletId: bill.wallet_id,
        reference: `${reference}-CB-REVERSAL`,
        type: "debit",
        transactionType: "bill_cashback_reversal",
        amount: taken,
        currency: "NGN",
        description: `Cashback reversal — bill ${reference} was reversed`,
      });
    }
    return taken;
  } catch (e: any) {
    console.error(`[bill-ledger] cashback clawback failed for ${reference}:`, e?.message);
    return 0;
  }
}

/**
 * Cashback-funding unwind (reversal path) — the Revenue ledger paid for the
 * promo cashback when it was accrued; when the cashback is clawed back, give
 * the Revenue ledger its money back too. Idempotent on the
 * `${ref}-CB-FUND-REVERSAL-REVENUE-CREDIT` revenue row.
 */
export async function unwindBillCashbackRevenueFunding(reference: string, category?: string): Promise<void> {
  const ref = String(reference || "");
  if (!ref) return;
  try {
    const funded = await query(
      `SELECT amount FROM transactions WHERE reference = $1 AND wallet_id IS NULL LIMIT 1`,
      [`${ref}-CB-FUND-REVENUE-DEBIT`],
    );
    const cb = r2(Number(funded.rows[0]?.amount) || 0);
    if (!(cb > 0)) return; // never revenue-funded — nothing to unwind
    const existing = await query(
      `SELECT 1 FROM transactions WHERE reference = $1 AND wallet_id IS NULL LIMIT 1`,
      [`${ref}-CB-FUND-REVERSAL-REVENUE-CREDIT`],
    );
    if (existing.rows.length) return;
    await creditRevenueWallet(
      cb,
      "NGN",
      `${ref}-CB-FUND-REVERSAL`,
      `Reversal — bill cashback funding returned to platform revenue for ${category || "bill"} ${ref}`,
      "bills",
    );
  } catch (e: any) {
    console.error(`[bill-ledger] cashback funding unwind failed for ${reference}:`, e?.message);
  }
}

/**
 * Discount-revenue unwind (reversal path) — debit the revenue ledger back
 * when a discounted bill is reversed. Idempotent.
 */
export async function unwindBillDiscountRevenue(reference: string, category?: string): Promise<void> {
  const ref = String(reference || "");
  if (!ref) return;
  try {
    const row = await query(
      `SELECT amount FROM transactions WHERE reference = $1 AND wallet_id IS NULL LIMIT 1`,
      [`${ref}-DISCOUNT-REVENUE-CREDIT`],
    );
    const discount = r2(Number(row.rows[0]?.amount) || 0);
    if (!(discount > 0)) return;
    const existing = await query(
      `SELECT 1 FROM transactions WHERE reference = $1 AND wallet_id IS NULL LIMIT 1`,
      [`${ref}-DISCOUNT-REVENUE-DEBIT`],
    );
    if (existing.rows.length) return;
    await creditRevenueWallet(
      -discount,
      "NGN",
      `${ref}-DISCOUNT`,
      `Reversal — bill purchase discount for ${category || "bill"} ${ref}`,
      "bills",
    );
  } catch (e: any) {
    console.error(`[bill-ledger] discount unwind failed for ${reference}:`, e?.message);
  }
}
