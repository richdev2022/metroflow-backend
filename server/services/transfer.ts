import { query } from "../db";
import { getProvider, resolveProvider } from "./providers/factory";
import type { SingleTransferRequest } from "./providers";
import { creditPlatformWallet, debitPlatformWallet, creditRevenueWallet, debitRevenueWallet } from "./fees";
import { logAuditEvent, generateTransactionHash } from "./audit";
import { sendTransactionAlert } from "./email";
import { sendPushToUsers } from "./push";

// Re-export account lookup from provider.

/**
 * Map a transfer_queue row onto the provider TransferRequest.
 * Includes the international beneficiary address block (required by
 * Flutterwave's USD/GBP/EUR rails) and the sender (paying business)
 * compliance data fetched from the businesses table for intl payouts.
 */
async function buildTransferProviderPayload(transfer: any): Promise<SingleTransferRequest> {
  const payload: SingleTransferRequest = {
    bankCode: transfer.recipient_bank,
    accountNumber: transfer.recipient_account,
    amount: toMinorUnit((transfer as any)._providerAmount ?? transfer.amount),
    accountName: transfer.recipient_name,
    transactionReference: transfer.reference,
    remark: transfer.remark,
    currencyId: (transfer as any)._providerCurrency ?? transfer.currency ?? 'NGN',
    beneficiaryAddress: transfer.recipient_address || undefined,
    beneficiaryCity: transfer.recipient_city || undefined,
    beneficiaryState: transfer.recipient_state || undefined,
    beneficiaryPostalCode: transfer.recipient_postal_code || undefined,
    beneficiaryCountry: transfer.recipient_country || undefined,
    bankName: transfer.recipient_bank_name || undefined,
    swiftCode: transfer.recipient_swift_code || undefined,
    routingNumber: transfer.recipient_routing_number || undefined,
    accountType: transfer.recipient_account_type || undefined,
    // USD corridor requires street_number + street_name inside meta[0]; the
    // app collects a single address line, so derive the components (first
    // numeric token = street number, remainder = street name).
    recipientStreetNumber: transfer.recipient_street_number || undefined,
    recipientStreetName: transfer.recipient_street_name || undefined,
    beneficiaryEmail: transfer.recipient_email || undefined,
    // Platform float funding the payout (Flutterwave converts NGN -> dest
    // automatically via payment_instruction when they differ).
    sourceCurrency: (transfer as any)._platformSourceCurrency || 'NGN',
  };

  if (!payload.recipientStreetNumber && payload.beneficiaryAddress) {
    const m = String(payload.beneficiaryAddress).trim().match(/^(\d+[A-Za-z]?)\s+(.+)$/);
    if (m) {
      payload.recipientStreetNumber = m[1];
      payload.recipientStreetName = m[2];
    }
  }

  const isIntl = payload.currencyId !== 'NGN' || !!payload.beneficiaryCountry;
  if (isIntl && transfer.business_id) {
    try {
      // Sender compliance data: prefer the business's KYC address block;
      // fall back to the beneficiary address only when the business has not
      // completed its profile (Flutterwave rejects intl payouts whose sender
      // address is missing, but sender == beneficiary looks fraudulent).
      const bRes = await query(
        `SELECT name, email, address_street, address_house_number, address_city,
                address_state, address_country
         FROM businesses WHERE id = $1`,
        [transfer.business_id],
      );
      const b = bRes.rows[0] || {};
      payload.senderName = b.name || payload.accountName;
      payload.senderEmail = b.email || undefined;
      const senderStreet = [b.address_house_number, b.address_street].filter(Boolean).join(' ').trim();
      const hasBusinessAddress = !!(senderStreet && b.address_city);
      payload.senderAddress = hasBusinessAddress ? senderStreet : payload.beneficiaryAddress;
      payload.senderCity = hasBusinessAddress ? b.address_city : payload.beneficiaryCity;
      payload.senderState = hasBusinessAddress ? b.address_state : payload.beneficiaryState;
      payload.senderPostalCode = payload.beneficiaryPostalCode;
      payload.senderCountry = (b.address_country || payload.beneficiaryCountry);
    } catch (e) {
      console.warn('[transfer] could not load sender details for intl payout:', e);
    }
  }
  return payload;
}
// Uses resolveProvider() so the ADMIN-SELECTED active provider (system_settings)
// is honoured - previously this used the env default directly, so switching the
// provider in admin had no effect on account lookups ("lookup failed").
export async function accountLookup(bankCode: string, accountNumber: string) {
  const provider = await resolveProvider();
  return provider.accountLookup(bankCode, accountNumber);
}

/**
 * Pre-transfer validation for INTERNATIONAL beneficiaries (USD/GBP/EUR).
 *
 * Flutterwave has no account-resolution endpoint for these corridors — the
 * only guard is to validate the beneficiary's routing data OURSELVES before
 * any wallet debit. Without this, an incomplete meta[] block sails through
 * /v3/transfers (accepted, queued) and only fails at DISBURSEMENT
 * ("Invalid account number"), by which time the wallet is debited and the
 * money is stuck until the reversal sweep runs.
 *
 * ABA checksum (USD routing numbers): 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9)
 * must be divisible by 10.
 */
export function validateIntlBeneficiary(
  currency: string,
  details: {
    routingNumber?: string;
    swiftCode?: string;
    bankName?: string;
    accountType?: string;
    accountNumber?: string;
    beneficiaryAddress?: string;
    beneficiaryPostalCode?: string;
    recipientStreetNumber?: string;
    recipientStreetName?: string;
  },
): { valid: boolean; error?: string; code?: string } {
  const cur = String(currency || 'NGN').toUpperCase();
  if (cur === 'NGN') return { valid: true }; // domestic — provider resolves accounts

  const routing = String(details.routingNumber || '').trim().replace(/[\s-]/g, '');
  const swift = String(details.swiftCode || '').trim();
  const bankName = String(details.bankName || '').trim();

  if (!bankName) {
    return { valid: false, error: "The beneficiary's bank name is required for international transfers", code: 'BANK_NAME_REQUIRED' };
  }

  if (cur === 'USD') {
    if (!/^\d{9}$/.test(routing)) {
      return { valid: false, error: 'A valid 9-digit US bank routing number (ABA) is required for USD transfers', code: 'ROUTING_NUMBER_INVALID' };
    }
    const d = routing.split('').map(Number);
    const checksum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
    if (checksum % 10 !== 0) {
      return { valid: false, error: 'The US bank routing number failed checksum validation — please double-check it with the beneficiary', code: 'ROUTING_NUMBER_CHECKSUM' };
    }
    const acctType = String(details.accountType || 'checking').toLowerCase();
    // Flutterwave accepts checking/savings on USD ACH; 'depository' appears in
    // older wiring guides — accept all three and normalise downstream.
    if (!['checking', 'savings', 'depository'].includes(acctType)) {
      return { valid: false, error: 'USD transfers require the account type to be "checking" or "savings"', code: 'ACCOUNT_TYPE_INVALID' };
    }
    // Street address is required; postal code is optional (FLW's meta builder
    // only includes it when provided — the web/mobile forms do not collect it).
    if (!details.beneficiaryAddress) {
      return { valid: false, error: "USD transfers require the beneficiary's street address", code: 'BENEFICIARY_ADDRESS_REQUIRED' };
    }
  } else if (cur === 'GBP') {
    if (!/^\d{6}$/.test(routing)) {
      return { valid: false, error: 'A valid 6-digit UK sort code is required for GBP transfers', code: 'ROUTING_NUMBER_INVALID' };
    }
    const acctType = String(details.accountType || 'personal').toLowerCase();
    if (!['personal', 'corporate'].includes(acctType)) {
      return { valid: false, error: 'GBP transfers require the account type to be "personal" or "corporate"', code: 'ACCOUNT_TYPE_INVALID' };
    }
  } else if (cur === 'EUR') {
    if (!/^[A-Za-z0-9]{8}(?:[A-Za-z0-9]{3})?$/.test(swift)) {
      return { valid: false, error: 'A valid SWIFT/BIC code (8 or 11 characters) is required for EUR transfers', code: 'SWIFT_CODE_INVALID' };
    }
  } else {
    // Other corridors: at least one routing identifier must be present.
    if (!routing && !swift) {
      return { valid: false, error: `A routing number or SWIFT code is required for ${cur} transfers`, code: 'ROUTING_DATA_REQUIRED' };
    }
  }
  return { valid: true };
}

// Flutterwave transfer status buckets
const FLW_SUCCESS_STATUSES = ['SUCCESSFUL'];
const FLW_PENDING_STATUSES = ['NEW', 'PENDING', 'QUEUED', 'ONGOING', 'PROCESSING', 'CREATED'];

// ---------------------------------------------------------------------------
// International quote calculator — SINGLE SOURCE OF TRUTH for the FX math.
//
// Flutterwave's /v3/transfers/rates returns a MULTIPLIER that converts the
// source amount INTO the destination currency (rate ≈ 0.000645 USD-per-NGN).
// Customers, however, think in the colloquial direction ("1 USD = ₦1,550"),
// so every customer-facing rate is exposed COLLOQUIAL (destination-per-source
// inverted: 1/rate).
//
// The admin markup + the ADMIN-ONLY spread are merged into ONE effective
// margin and baked INTO the conversion rate — users never see a separate
// spread or markup line, only "Conversion rate", "Fee" and "Total".
//
// Fee lives in the DEBIT (source) currency so it can be charged from the
// source wallet together with the conversion amount.
// ---------------------------------------------------------------------------
export interface IntlQuote {
  /** Colloquial mid-market rate: 1 destination = `liveRateColloquial` source. */
  liveRateColloquial: number;
  /** Colloquial rate AFTER margin — what the customer is actually charged at. */
  conversionRate: number;
  /** Destination-currency amount the beneficiary receives. */
  receivingAmount: number;
  /** Source-currency cost of the conversion (excl. fee). */
  sourceDebit: number;
  /** Source-currency fee. */
  fee: number;
  /** Source-currency total (sourceDebit + fee). */
  totalDebit: number;
  effectiveMarginPercent: number;
}

export function computeIntlQuote(
  amount: number,
  rawRate: number,
  config: { feePercent: number; feeFlat: number },
  effectiveMarginPercent: number,
): IntlQuote {
  const liveRateColloquial = Math.round((1 / rawRate) * 1000000) / 1000000;
  // Margin INFLATES the source cost: customer pays (1 + margin) colloquial units
  // per destination unit. (The raw multiplier direction would require DIVIDING
  // — the previous implementation multiplied the USD-per-NGN rate, which gave
  // customers a DISCOUNT instead of a margin.)
  const conversionRate = Math.round(liveRateColloquial * (1 + effectiveMarginPercent / 100) * 100) / 100;
  const sourceDebit = Math.round(amount * conversionRate * 100) / 100;
  const fee = Math.round((sourceDebit * (config.feePercent / 100) + config.feeFlat) * 100) / 100;
  const totalDebit = Math.round((sourceDebit + fee) * 100) / 100;
  return {
    liveRateColloquial,
    conversionRate,
    receivingAmount: Math.round(amount * 100) / 100,
    sourceDebit,
    fee,
    totalDebit,
    effectiveMarginPercent,
  };
}

// Helper function to convert amount to minor units for both providers
export function toMinorUnit(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return Math.round(num * 100).toString();
}

// Helper function to verify a single transfer with retries
export async function verifySingleTransfer(transfer: any, maxRetries: number = 3): Promise<any> {
  let currentRetry = 0;
  
  while (currentRetry < maxRetries) {
    try {
      console.log(`[TransferMonitor] Verifying transfer ${transfer.reference} (ID: ${transfer.id}, Provider: ${transfer.payment_provider}) - Attempt ${currentRetry + 1}/${maxRetries}`);
      
      const provider = getProvider(transfer.payment_provider);
      const verificationResponse = await provider.verifyTransfer(transfer.reference, transfer.provider_metadata);
      
      let isSuccess = false;
      let isPending = false;
      let failureReason = "Unknown error from provider";

      if (provider.name === 'squad') {
        isSuccess = verificationResponse.success && (
          verificationResponse.data?.status === 'success' || 
          verificationResponse.data?.transaction_status === 'success'
        );
        isPending = !isSuccess && (
          verificationResponse.data?.status === 'pending' || 
          verificationResponse.data?.transaction_status === 'pending' ||
          verificationResponse.data?.status === 'processing' || 
          verificationResponse.data?.transaction_status === 'processing'
        );
        failureReason = verificationResponse.message || 
                        verificationResponse.data?.failure_reason || 
                        verificationResponse.data?.error_message || 
                        "Transfer failed at provider";
      } else if (provider.name === 'flutterwave') {
        // Flutterwave transfer statuses: SUCCESSFUL | FAILED | REVERTED | NEW | PENDING | QUEUED | ONGOING
        const flwStatus = (verificationResponse?.data?.status || verificationResponse?.data?.transactionStatus || '').toUpperCase();
        isSuccess = verificationResponse?.status === 'success' && FLW_SUCCESS_STATUSES.includes(flwStatus);
        isPending = !isSuccess && FLW_PENDING_STATUSES.includes(flwStatus);
        failureReason = verificationResponse?.data?.complete_message ||
                        verificationResponse?.message || 
                        "Transfer failed at Flutterwave";
        // If the lookup itself failed (no status present), don't retry
        if (!flwStatus && verificationResponse?.status !== 'success') {
          isPending = false;
          console.log(`[TransferMonitor] Flutterwave verify failed for ${transfer.reference}: ${verificationResponse?.message}`);
        }
      } else if (provider.name === 'monnify') {
        isSuccess = verificationResponse.requestSuccessful && (
          verificationResponse.responseBody?.status === 'SUCCESS' ||
          verificationResponse.responseBody?.transactionStatus === 'SUCCESS'
        );
        isPending = !isSuccess && verificationResponse.requestSuccessful && (
          verificationResponse.responseBody?.status === 'PENDING' ||
          verificationResponse.responseBody?.transactionStatus === 'PENDING' ||
          verificationResponse.responseBody?.status === 'PENDING_AUTHORIZATION' ||
          verificationResponse.responseBody?.transactionStatus === 'PENDING_AUTHORIZATION' ||
          verificationResponse.responseBody?.status === 'PROCESSING' ||
          verificationResponse.responseBody?.transactionStatus === 'PROCESSING'
        );
        failureReason = verificationResponse.responseMessage || 
                        verificationResponse.responseBody?.failureReason || 
                        verificationResponse.responseBody?.errorMessage || 
                        "Transfer failed at provider";
        
        // If request is not successful (e.g., transfer not found), don't retry
        if (!verificationResponse.requestSuccessful) {
          isPending = false;
          console.log(`[TransferMonitor] Monnify verify failed for ${transfer.reference}: ${verificationResponse.responseMessage}`);
        }
      }

      console.log(`[TransferMonitor] Transfer ${transfer.reference} - Success: ${isSuccess}, Pending: ${isPending}, Reason: ${failureReason}`);

      if (isSuccess) {
        await query(
          `UPDATE transfer_queue 
           SET status = 'success', 
               updated_at = CURRENT_TIMESTAMP, 
               meta_data = $2 
           WHERE id = $1`,
          [transfer.id, JSON.stringify(verificationResponse)]
        );
        
        // Send email notification on success
        if (transfer.wallet_id) {
          const walletRes = await query(`SELECT balance, user_id FROM wallets WHERE id = $1`, [transfer.wallet_id]);
          if (walletRes.rows.length > 0 && walletRes.rows[0].user_id) {
            const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [walletRes.rows[0].user_id]);
            if (userRes.rows.length > 0) {
              const user = userRes.rows[0];
              await sendTransactionAlert(
                user.email,
                user.name || 'User',
                'debit',
                parseFloat(transfer.amount),
                transfer.currency || 'NGN',
                parseFloat(walletRes.rows[0].balance),
                'success',
                transfer.reference,
                `Transfer to ${transfer.recipient_name || 'Account'}`
              );
            }
          }
        }

        const updatedRes = await query(`SELECT * FROM transfer_queue WHERE id = $1`, [transfer.id]);
        return updatedRes.rows[0];
      } else if (isPending) {
        if (currentRetry < maxRetries - 1) {
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay between retries
          currentRetry++;
          continue;
        } else {
          // Still pending after all retries - leave as processing
          await query(
            `UPDATE transfer_queue 
             SET status = 'processing', 
                 updated_at = CURRENT_TIMESTAMP, 
                 meta_data = $2 
             WHERE id = $1`,
            [transfer.id, JSON.stringify(verificationResponse)]
          );
          const updatedRes = await query(`SELECT * FROM transfer_queue WHERE id = $1`, [transfer.id]);
          return updatedRes.rows[0];
        }
      } else {
        // Failed
        await query(
          `UPDATE transfer_queue 
           SET status = 'failed', 
               failure_reason = $2, 
               updated_at = CURRENT_TIMESTAMP, 
               meta_data = $3 
           WHERE id = $1`,
          [transfer.id, failureReason, JSON.stringify(verificationResponse)]
        );

        // Send email notification on failure
          if (transfer.wallet_id) {
            const walletRes = await query(`SELECT balance, user_id FROM wallets WHERE id = $1`, [transfer.wallet_id]);
            if (walletRes.rows.length > 0 && walletRes.rows[0].user_id) {
              const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [walletRes.rows[0].user_id]);
              if (userRes.rows.length > 0) {
                const user = userRes.rows[0];
                await sendTransactionAlert(
                  user.email,
                  user.name || 'User',
                  'debit',
                  parseFloat(transfer.amount),
                  transfer.currency || 'NGN',
                  parseFloat(walletRes.rows[0].balance),
                  'failed',
                  transfer.reference,
                  `Transfer failed: ${failureReason}`
                );
              }
            }
          }

        // AUTO-REVERSAL: single idempotent helper — credits amount+fee back to
        // the wallet, flips the debit rows to failed, notifies the user (push +
        // in-app + email) and records the refund rows.
        await reverseFailedTransfer(transfer, failureReason || 'Transfer failed at provider');

        const updatedRes = await query(`SELECT * FROM transfer_queue WHERE id = $1`, [transfer.id]);
        return updatedRes.rows[0];
      }
    } catch (error: any) {
      console.error(`[TransferMonitor] Error verifying transfer ${transfer.reference} (Attempt ${currentRetry + 1}):`, error);
      
      // Check if the error is a 404 Not Found or similar (transfer never initiated)
      const isNotFound = error.message?.includes('Not found') || 
                         error.message?.includes('404') || 
                         (error.response && error.response.status === 404) ||
                         error.message?.includes('Could not find disbursement');
      
      if (isNotFound) {
        console.log(`[TransferMonitor] Transfer ${transfer.reference} not found at provider, marking as failed`);
        
        // Mark as failed
        await query(
          `UPDATE transfer_queue 
           SET status = 'failed', 
               failure_reason = 'Transfer not found at provider', 
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [transfer.id]
        );
        
        // AUTO-REVERSAL (idempotent, notifies the user end-to-end)
        await reverseFailedTransfer(transfer, 'Transfer not found at provider');
        
        const updatedRes = await query(`SELECT * FROM transfer_queue WHERE id = $1`, [transfer.id]);
        return updatedRes.rows[0];
      }
      
      // If it's a different error, retry if we haven't exhausted retries
      if (currentRetry < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        currentRetry++;
        continue;
      }
      
      return transfer; // Return original transfer if all retries fail
    }
  }
  
  return transfer;
}

// ============================================================
// Transfer Reconciliation Service (safety net)
// ------------------------------------------------------------
// Flutterwave webhooks (`transfer.completed`) are the PRIMARY
// mechanism for transfer status changes. This poller is only a
// fallback for missed/late webhooks and is intentionally cheap:
//   1. Probe-first: a single indexed `LIMIT 1` existence query
//      per idle cycle - no row fetching when there is no work.
//   2. Bounded batch (LIMIT) when there IS work.
//   3. Self-scheduling loop: the next run is scheduled only
//      after the current one finishes, so runs can NEVER overlap
//      (the old setInterval stacked up when runs were slow).
//   4. Exponential backoff (1 -> 15 min) when the DB is
//      unhealthy (e.g. quota exceeded), instead of hammering it.
//   5. Quiet logging: nothing is logged while idle; errors are
//      rate-limited to one concise line per 5 minutes.
// ============================================================

const RECONCILE_BATCH_SIZE = 25;
// Only re-verify 'processing' transfers whose last update is older than this
const PROCESSING_STALE_SECONDS = 90;
// 'pending' transfers older than this are considered stuck and re-driven
const PENDING_STUCK_MINUTES = 2;
// A processing transfer older than this is marked failed and refunded
const TRANSFER_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

const IDLE_INTERVAL_MS = 60_000;        // 1 min idle cadence
const MAX_BACKOFF_MS = 15 * 60_000;     // 15 min max backoff
const ERROR_LOG_INTERVAL_MS = 5 * 60_000;

let monitorTimer: ReturnType<typeof setTimeout> | null = null;
let monitorRunning = false;
let consecutiveFailures = 0;
let lastErrorLogAt = 0;

function nextDelayMs(): number {
  if (consecutiveFailures === 0) return IDLE_INTERVAL_MS;
  // 1 -> 2 -> 4 -> 8 -> 15 min (capped) after consecutive failures
  const backoff = IDLE_INTERVAL_MS * Math.pow(2, Math.min(consecutiveFailures - 1, 4));
  return Math.min(backoff, MAX_BACKOFF_MS);
}

// Log at most one concise line per ERROR_LOG_INTERVAL_MS - prevents
// multi-hundred-MB log files when the database is unreachable.
function logRateLimited(context: string, error: any) {
  const now = Date.now();
  if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
  lastErrorLogAt = now;
  const msg = error?.message || String(error);
  const code = error?.code ? ` [pg ${error.code}]` : "";
  console.error(`[TransferMonitor] ${context}: ${msg}${code}`);
}

// Refund a timed-out transfer back to the source wallet.
// Delegates to the single idempotent auto-reversal helper (wallet credit +
// refund rows + failed-status flip + user notification).
async function refundTimedOutTransfer(rawTransfer: any) {
  const transfer = normalizeTransferForProcessing(rawTransfer);

  await query(
    `UPDATE transfer_queue
     SET status = 'failed',
         failure_reason = 'Transfer timed out after 24 hours',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [transfer.id]
  );

  await reverseFailedTransfer(transfer, 'Transfer timed out after 24 hours');
}

/**
 * One reconciliation pass. Safe to call from anywhere (scheduler,
 * cron, BullMQ worker) - concurrent calls are collapsed into a
 * no-op while a pass is already running.
 */
export async function checkProcessingTransfers(): Promise<void> {
  if (monitorRunning) return; // single-flight guard
  monitorRunning = true;
  try {
    // --- Probe first: ONE tiny indexed query when idle ---
    const probe = await query(
      `SELECT 1 FROM transfer_queue
       WHERE (status = 'processing' AND updated_at < NOW() - INTERVAL '${PROCESSING_STALE_SECONDS} seconds')
          OR (status = 'pending' AND created_at < NOW() - INTERVAL '${PENDING_STUCK_MINUTES} minutes')
          OR (status = 'failed' AND wallet_id IS NOT NULL AND updated_at > NOW() - INTERVAL '7 days'
              AND (
                EXISTS (SELECT 1 FROM transactions t WHERE t.reference = transfer_queue.reference AND t.type = 'debit')
                OR COALESCE(provider_metadata::text, meta_data::text, '') NOT IN ('', 'null', '{}')
              )
              AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.reference = transfer_queue.reference || '-REFUND'))
       LIMIT 1`
    );

    if (probe.rows.length === 0) {
      consecutiveFailures = 0; // DB healthy, nothing to reconcile
      return; // silent: no work, no logs
    }

    // --- There IS work: fetch a bounded batch ---
    const staleRows = await query(
      `SELECT * FROM transfer_queue
       WHERE (status = 'processing' AND updated_at < NOW() - INTERVAL '${PROCESSING_STALE_SECONDS} seconds')
          OR (status = 'pending' AND created_at < NOW() - INTERVAL '${PENDING_STUCK_MINUTES} minutes')
       ORDER BY updated_at ASC
       LIMIT ${RECONCILE_BATCH_SIZE}`
    );

    const transfers = staleRows.rows;
    console.log(`[TransferMonitor] Reconciling ${transfers.length} stale transfer(s)`);

    // 1. Re-drive stuck pending transfers through the normal pipeline
    const stuckPending = transfers.filter(t => t.status === 'pending');
    const uniqueBusinessIds = Array.from(new Set(stuckPending.map(t => t.business_id)));
    for (const businessId of uniqueBusinessIds as string[]) {
      try {
        await processAllPending(businessId);
      } catch (bizError: any) {
        logRateLimited(`Error processing stuck pending for business ${businessId}`, bizError);
      }
    }

    // 2. Verify stale processing transfers (webhook may have been missed)
    const now = Date.now();
    for (const transfer of transfers.filter(t => t.status === 'processing')) {
      const timeSinceUpdate = now - new Date(transfer.updated_at).getTime();

      if (timeSinceUpdate > TRANSFER_TIMEOUT_MS) {
        console.log(`[TransferMonitor] Transfer ${transfer.reference} timed out after 24h, marking failed + refunding`);
        try {
          await refundTimedOutTransfer(transfer);
        } catch (refundError: any) {
          logRateLimited(`Error refunding timed out transfer ${transfer.reference}`, refundError);
        }
      } else {
        try {
          await verifySingleTransfer(transfer);
        } catch (verifyError: any) {
          logRateLimited(`Error verifying transfer ${transfer.reference}`, verifyError);
        }
      }
    }

    // 3. Safety net: auto-reverse FAILED transfers whose wallet debit was
    // never refunded. Covers rows flipped to failed by a provider webhook
    // (Squad/Monnify/Flutterwave) before reversal existed, or any path that
    // marked failed without crediting the user back.
    try {
      const unrefunded = await query(
        `SELECT * FROM transfer_queue
         WHERE status = 'failed' AND wallet_id IS NOT NULL
           AND updated_at > NOW() - INTERVAL '7 days'
           AND COALESCE(provider_metadata::text, meta_data::text, '') NOT IN ('', 'null', '{}')
           AND (
             EXISTS (SELECT 1 FROM transactions t WHERE t.reference = transfer_queue.reference AND t.type = 'debit')
             OR NOT EXISTS (SELECT 1 FROM transactions t WHERE t.reference = transfer_queue.reference AND t.type = 'credit')
           )
           AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.reference = transfer_queue.reference || '-REFUND')
         ORDER BY updated_at ASC
         LIMIT 25`
      );
      for (const transfer of unrefunded.rows) {
        try {
          const reversed = await reverseFailedTransfer(transfer, 'Reconciliation sweep: failed transfer without reversal');
          if (reversed) {
            console.log(`[TransferMonitor] Auto-reversed failed transfer ${transfer.reference}`);
          }
        } catch (revError: any) {
          logRateLimited(`Error auto-reversing failed transfer ${transfer.reference}`, revError);
        }
      }
    } catch (sweepError: any) {
      logRateLimited("Failed-transfer reversal sweep skipped", sweepError);
    }

    consecutiveFailures = 0;
  } catch (error: any) {
    consecutiveFailures++;
    logRateLimited("Transfer reconciliation skipped (will retry with backoff)", error);
  } finally {
    monitorRunning = false;
  }
}

// Start the reconciliation loop.
// NOTE: intentionally self-scheduling via setTimeout (NOT setInterval)
// so that a slow pass can never overlap the next one.
export function startTransferMonitor(firstRunDelayMs: number = IDLE_INTERVAL_MS) {
  if (monitorTimer) return; // idempotent: never double-start
  console.log(
    `[TransferMonitor] Reconciliation poller started ` +
    `(idle cadence ${IDLE_INTERVAL_MS / 1000}s, backoff up to ${MAX_BACKOFF_MS / 60000}min on DB errors, webhook-first)`
  );

  const tick = async () => {
    try {
      await checkProcessingTransfers();
    } finally {
      monitorTimer = setTimeout(tick, nextDelayMs());
    }
  };

  monitorTimer = setTimeout(tick, firstRunDelayMs);
}

/**
 * Normalize a transfer_queue row for processing.
 * For international payouts, `amount`/`currency` are the DESTINATION values
 * sent to the provider, while `debit_amount`/`debit_currency` are the
 * source-currency values actually debited from the wallet and recorded in the
 * platform/revenue ledgers. Returns a shallow copy where `amount`/`currency`
 * are the DEBIT values and `_providerAmount`/`_providerCurrency` the provider
 * (destination) values.
 */
export function normalizeTransferForProcessing(transfer: any, platformSourceCurrency?: string): any {
  const debitAmount = transfer.debit_amount != null ? parseFloat(transfer.debit_amount) : NaN;
  const source = platformSourceCurrency || 'NGN';
  if (Number.isFinite(debitAmount) && debitAmount > 0 && debitAmount !== parseFloat(transfer.amount)) {
    return {
      ...transfer,
      _providerAmount: transfer.amount,
      _providerCurrency: transfer.currency || 'NGN',
      _platformSourceCurrency: source,
      amount: debitAmount,
      currency: transfer.debit_currency || transfer.currency || 'NGN',
    };
  }
  return { ...transfer, _providerAmount: transfer.amount, _providerCurrency: transfer.currency || 'NGN', _platformSourceCurrency: source };
}

/**
 * Auto-reversal: credit back a FAILED transfer's debit (amount + fee) to the
 * source wallet and unwind the platform/revenue holds, recording the
 * corresponding `refund` transaction rows.
 *
 * Idempotent by construction:
 *  - only runs when the debit transaction exists (money actually left),
 *  - only runs when no `${reference}-REFUND` transaction exists yet,
 *  - INSERTs use ON CONFLICT DO NOTHING as a final guard.
 *
 * Used by: immediate provider rejection, processing exceptions, provider
 * webhooks (Squad/Monnify/Flutterwave FAILED/REVERSED) and the monitor sweep
 * for failed-but-never-reversed rows.
 *
 * @returns true when a reversal was performed, false when skipped.
 */
export async function reverseFailedTransfer(
  transfer: any,
  reason: string,
  opts: { providerReturnedFunds?: boolean } = {},
): Promise<boolean> {
  if (!transfer || !transfer.wallet_id) return false;

  // International (currency-converted) transfers store the PROVIDER amount in
  // `amount`/`currency` (e.g. 1 USD) while the wallet was actually debited the
  // CONVERSION (debit_amount/debit_currency, e.g. 1600 NGN). Always reverse
  // what actually left the wallet.
  const queuedDebit = transfer.debit_amount != null ? parseFloat(transfer.debit_amount) : NaN;
  const amount = Number.isFinite(queuedDebit) && queuedDebit > 0 ? queuedDebit : parseFloat(transfer.amount);
  const fee = parseFloat(transfer.fee || '0');
  const currency = (Number.isFinite(queuedDebit) && queuedDebit > 0
    ? (transfer.debit_currency || transfer.currency)
    : transfer.currency) || 'NGN';
  const totalRefund = amount + fee;

  // Only reverse when money actually left the wallet (debit txn exists).
  // SELF-HEAL: some historical transfers reached the payout provider with the
  // wallet debited but the debit transaction ROW missing (a partial write in
  // an older build) — for those, every reversal path silently no-op'd and the
  // user's money was stuck forever with "it will reverse automatically". If
  // there is POSITIVE evidence the transfer reached the provider (provider
  // metadata / webhook meta stored on the queue row), reconstruct the missing
  // debit row (labelled as reconciliation) so the refund can proceed.
  let txnCheck = await query(
    `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit'`,
    [transfer.reference]
  );
  if (txnCheck.rows.length === 0) {
    const providerMeta = transfer.provider_metadata || transfer.meta_data || null;
    const hasProviderEvidence =
      (providerMeta && typeof providerMeta === 'string' && providerMeta.length > 2) ||
      (providerMeta && typeof providerMeta === 'object');
    if (!hasProviderEvidence) {
      console.warn(
        `[TransferService] reverseFailedTransfer: no debit row and no provider evidence for ${transfer.reference} — refusing to guess (nothing to reverse).`
      );
      return false;
    }
    console.warn(
      `[TransferService] RECONCILIATION: debit row missing for ${transfer.reference} but the transfer reached the provider — reconstructing it before refunding.`
    );
    await query(
      `INSERT INTO transactions
       (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
       VALUES ($1, $2, $3, 'success', $4, 'debit', $5, 'transfer', $6, 'debit')
       ON CONFLICT (reference) DO NOTHING`,
      [
        transfer.business_id,
        amount,
        currency,
        transfer.reference,
        `Reconciliation: debit reconstruction for transfer ${transfer.reference}`,
        transfer.wallet_id,
      ]
    );
    txnCheck = await query(
      `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit'`,
      [transfer.reference]
    );
    if (txnCheck.rows.length === 0) return false;
  }

  // CLAIM-FIRST idempotency: the principal refund ROW is the gate (INSERT ...
  // ON CONFLICT ... RETURNING id). The wallet credit and ledger reversals run
  // only when THIS call won the claim, so webhook/monitor races and mid-crash
  // retries can never double-credit the wallet.
  //
  // Reference suffix scheme (transactions.reference is GLOBALLY unique —
  // reusing one suffix for two rows silently swallows the second insert,
  // which is exactly what dropped the user's refund rows before):
  //   <ref>-REFUND              user wallet, principal refund row
  //   <ref>-FEE-REFUND          user wallet, fee refund row
  //   <ref>-PLATFORM-REFUND     platform ledger, reversal of the hold credit
  //   <ref>-FEE-REVENUE-REFUND  revenue ledger, reversal of the fee revenue
  const refundClaim = await query(
    `INSERT INTO transactions
     (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
     VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')
     ON CONFLICT (reference) DO NOTHING RETURNING id`,
    [
      transfer.business_id,
      amount,
      currency,
      transfer.reference + '-REFUND',
      `Auto-reversal for failed transfer: ${transfer.reference}`,
      transfer.wallet_id
    ]
  );
  if (refundClaim.rows.length === 0) return false;

  // 1. Credit the user's wallet back (principal)
  await query(
    `UPDATE wallets SET balance = balance + $1 WHERE id = $2`,
    [amount, transfer.wallet_id]
  );

  // 2. Platform ledger (owner invariant): a withdrawal reversal DEBITS the
  //    platform ledger — undoing the 'Platform Wallet Credit for Transfer
  //    <ref>' hold written at initiation. Gated on the hold row actually
  //    existing (legacy transfers queued before the hold-row fix have none).
  //    opts.providerReturnedFunds stays accepted for caller compatibility but
  //    no longer changes the ledger directions.
  const holdRow = await query(
    `SELECT 1 FROM transactions
     WHERE reference IN ($1::varchar, $1::varchar || '-PLATFORM') AND transaction_type = 'platform'
     LIMIT 1`,
    [transfer.reference]
  );
  if (holdRow.rows.length > 0) {
    await debitPlatformWallet(
      amount,
      currency,
      transfer.reference + '-PLATFORM-REFUND',
      `Reversal of platform hold for failed transfer ${transfer.reference}`,
    );
  }

  // 3. Unwind the fee revenue (it was earned on a transfer that never went
  //    through) — a genuine revenue DEBIT row with its OWN reference.
  if (fee > 0) {
    const feeClaim = await query(
      `INSERT INTO transactions
       (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
       VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')
       ON CONFLICT (reference) DO NOTHING RETURNING id`,
      [
        transfer.business_id,
        fee,
        currency,
        transfer.reference + '-FEE-REFUND',
        `Auto-reversal of fee for failed transfer: ${transfer.reference}`,
        transfer.wallet_id
      ]
    );
    if (feeClaim.rows.length > 0) {
      await query(
        `UPDATE wallets SET balance = balance + $1 WHERE id = $2`,
        [fee, transfer.wallet_id]
      );
      await debitRevenueWallet(
        fee,
        currency,
        transfer.reference + '-FEE-REVENUE-REFUND',
        `Reversal of fee revenue for failed transfer ${transfer.reference}`,
      );
    }
  }

  // 5. The original debit rows must NOT keep showing 'success' in the user's
  //    history after the money came back — flip them to 'failed'. This is the
  //    display half of "auto-reversal": users saw a green successful debit
  //    forever and concluded the money was never returned.
  await query(
    `UPDATE transactions
     SET status = 'failed', updated_at = CURRENT_TIMESTAMP
     WHERE reference = ANY($1::varchar[]) AND type = 'debit' AND status <> 'failed'`,
    [[transfer.reference, transfer.reference + '-FEE']]
  );

  // 6. Keep the queue row consistent (idempotent — never resurrect a success)
  if (transfer.id) {
    await query(
      `UPDATE transfer_queue
       SET status = 'failed',
           failure_reason = COALESCE(NULLIF(failure_reason, ''), $2),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status <> 'success'`,
      [transfer.id, reason]
    );
  }

  // 7. END-TO-END: tell the user the money is BACK — push (FCM) + in-app
  //    notification + email. Previously the app only promised "it will be
  //    reversed" and nothing ever confirmed the refund.
  try {
    const walletRes = await query(
      `SELECT user_id, business_id, balance FROM wallets WHERE id = $1`,
      [transfer.wallet_id]
    );
    if (walletRes.rows.length > 0 && walletRes.rows[0].user_id) {
      const walletRow = walletRes.rows[0];
      const newBalance = parseFloat(walletRow.balance);
      const prettyAmount = `${currency} ${totalRefund.toLocaleString()}`;
      await sendPushToUsers(
        [{ userId: walletRow.user_id, businessId: walletRow.business_id || transfer.business_id }],
        {
          title: 'Transaction Reversed',
          body: `Your failed transfer of ${prettyAmount} has been reversed. The money is back in your wallet.`,
          data: {
            type: 'transaction',
            eventType: 'reversal',
            reference: String(transfer.reference),
            amount: String(totalRefund),
            currency,
            reason: String(reason || '').slice(0, 200),
          },
        },
        { inApp: true, type: 'refund', businessId: walletRow.business_id || transfer.business_id },
      ).catch((pushErr) => console.error(`[TransferService] reversal push failed for ${transfer.reference}:`, pushErr?.message));

      const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [walletRow.user_id]);
      if (userRes.rows.length > 0) {
        await sendTransactionAlert(
          userRes.rows[0].email,
          userRes.rows[0].name || 'User',
          'credit',
          totalRefund,
          currency,
          newBalance,
          'success',
          transfer.reference + '-REFUND',
          `Auto-reversal for failed transfer: ${transfer.reference}`
        ).catch(() => {});
      }
    }
  } catch (notifyErr: any) {
    console.error(`[TransferService] reversal notification failed for ${transfer.reference}:`, notifyErr?.message);
  }

  console.log(`[TransferService] AUTO-REVERSAL applied for ${transfer.reference} | amount+fee=${totalRefund} | reason: ${reason}`);
  return true;
}

export async function processAllPending(businessId: string) {
  // 1. Fetch pending transfers
  const pendingTransfers = await query(
    `SELECT * FROM transfer_queue 
     WHERE business_id = $1 AND status = 'pending' 
     ORDER BY created_at ASC 
     LIMIT 50`, // Batch size
    [businessId]
  );

  if (pendingTransfers.rows.length === 0) return;

  // Platform float currency funding the provider side of international
  // payouts (payment_instruction source). Fetched once per batch.
  let platformFloatCurrency = 'NGN';
  try {
    const { getIntlPayoutSourceCurrency } = await import("./app-config");
    platformFloatCurrency = await getIntlPayoutSourceCurrency();
  } catch {
    // default NGN
  }

  pendingTransfers.rows = pendingTransfers.rows.map((t: any) =>
    normalizeTransferForProcessing(t, platformFloatCurrency),
  );

  console.log(`Processing ${pendingTransfers.rows.length} pending transfers for business ${businessId}`);

  for (const transfer of pendingTransfers.rows) {
    // Atomically claim the row: only the pass that flips it pending ->
    // processing may proceed. Prevents the concurrent route-pass + BullMQ
    // worker-pass race where both drove the pipeline and the loser crashed
    // on transactions_reference_key (23505) mid-insert.
    const claim = await query(
      `UPDATE transfer_queue SET status = 'processing', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [transfer.id]
    );
    if (claim.rows.length === 0) {
      // Already claimed/processed by a concurrent pass (route vs worker vs monitor)
      continue;
    }

    try {
      // 2. Check Wallet & Debit
      if (transfer.wallet_id) {
          const walletRes = await query(`SELECT balance, currency FROM wallets WHERE id = $1`, [transfer.wallet_id]);
          if (walletRes.rows.length === 0) {
              throw new Error("Source wallet not found");
          }
          const balance = parseFloat(walletRes.rows[0].balance);
          const amount = parseFloat(transfer.amount);
          const fee = parseFloat(transfer.fee || '0');
          const totalDebit = amount + fee;

          // Currency guard: the wallet MUST be in the same currency as the debit
          // (post-normalization transfer.currency IS the debit currency). Without
          // this a mixed NGN/USD salary batch debits the wrong wallet by the wrong
          // magnitude (e.g. NGN wallet charged a raw USD amount).
          const walletCurrency = String(walletRes.rows[0].currency || 'NGN').toUpperCase();
          const debitCurrency = String(transfer.currency || 'NGN').toUpperCase();
          if (walletCurrency !== debitCurrency) {
              throw new Error(`Wallet currency mismatch: source wallet is ${walletCurrency} but transfer requires ${debitCurrency}`);
          }

          if (balance < totalDebit) {
              throw new Error("Insufficient wallet balance");
          }

          // Debit Wallet
          await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [totalDebit, transfer.wallet_id]);

          // Owner invariant: a withdrawal DEBITS the user's wallet and CREDITS
          // the platform ledger — this hold row IS the withdrawal's platform
          // entry (labelled + idempotent by reference).
          // ⚠️ The hold row MUST use a DISTINCT reference (`<ref>-PLATFORM`):
          // transactions.reference is GLOBALLY unique. This hold previously
          // used the RAW transfer reference, so the user's debit-row INSERT
          // (same reference, ON CONFLICT DO NOTHING) was silently swallowed —
          // the wallet was debited with NO transaction row and every reversal
          // path (webhook/monitor/user) found "no debit row" and no-op'd.
          // That is the exact "debited but never refunded" prod bug.
          await creditPlatformWallet(
            amount,
            transfer.currency || 'NGN',
            `${transfer.reference}-PLATFORM`,
            `Platform Wallet Credit for Transfer ${transfer.reference}`,
          );

          // Credit Revenue Wallet (Fee) - Earnings
          if (fee > 0) {
            await creditRevenueWallet(
              fee,
              transfer.currency || 'NGN',
              transfer.reference,
              `Transfer fee revenue for ${transfer.reference}`,
            );
          }

          // Record Transaction (Amount) - Idempotent: Check if exists first, UPDATE if so
          const existingTxn = await query(
            `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit' AND transaction_type = 'transfer'`,
            [transfer.reference]
          );

          if (existingTxn.rows.length === 0) {
            await query(
              `INSERT INTO transactions 
               (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
               VALUES ($1, $2, $3, 'success', $4, 'debit', $5, 'transfer', $6, 'debit')
               ON CONFLICT (reference) DO NOTHING`,
              [
                  transfer.business_id, 
                  amount, 
                  transfer.currency || 'NGN', 
                  transfer.reference, 
                  `Transfer to ${transfer.recipient_name || 'Account'}`,
                  transfer.wallet_id
              ]
            );
          } else {
            await query(
              `UPDATE transactions 
               SET status = 'success', updated_at = CURRENT_TIMESTAMP 
               WHERE id = $1`,
              [existingTxn.rows[0].id]
            );
          }

          // Record Transaction (Fee) - Idempotent: Check if exists first
          if (fee > 0) {
            const existingFeeTxn = await query(
              `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit' AND transaction_type = 'fee'`,
              [transfer.reference + '-FEE']
            );

            if (existingFeeTxn.rows.length === 0) {
              await query(
                `INSERT INTO transactions 
                 (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee)
                 VALUES ($1, $2, $3, 'success', $4, 'debit', $5, 'fee', $6, 'debit', $7)
                 ON CONFLICT (reference) DO NOTHING`,
                [
                    transfer.business_id, 
                    fee, 
                    transfer.currency || 'NGN', 
                    transfer.reference + '-FEE', 
                    `Fee for transfer: ${transfer.reference}`,
                    transfer.wallet_id,
                    fee
                ]
              );
            } else {
              await query(
                `UPDATE transactions 
                 SET status = 'success', updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $1`,
                [existingFeeTxn.rows[0].id]
              );
            }
          }
      }

      // 3. Initiate Transfer
      const provider = getProvider(transfer.payment_provider); // Use transfer's provider or default

      const payload = await buildTransferProviderPayload(transfer);

      // Belt-and-braces: re-validate the intl beneficiary at processing time
      // (covers bulk queues and rows queued before the route-level check).
      // Failing here is SAFE — the debit block above wrote the debit row, so
      // the exception handler reverses it cleanly.
      if (((transfer.currency || 'NGN').toUpperCase()) !== 'NGN') {
        const intlCheck = validateIntlBeneficiary(transfer.currency, {
          routingNumber: payload.routingNumber,
          swiftCode: payload.swiftCode,
          bankName: payload.bankName,
          accountType: payload.accountType,
          accountNumber: payload.accountNumber,
          beneficiaryAddress: payload.beneficiaryAddress,
          beneficiaryPostalCode: payload.beneficiaryPostalCode,
          recipientStreetNumber: payload.recipientStreetNumber,
          recipientStreetName: payload.recipientStreetName,
        });
        if (!intlCheck.valid) {
          throw new Error(intlCheck.error || 'International beneficiary validation failed');
        }
      }

      const response = await provider.initiateTransfer(payload);

      // Parse provider response directly to determine status
      let immediateStatus: 'success' | 'failed' | 'processing' = 'processing';
      let isSuccess = false;
      let isFailed = false;
      let failureReason: string | null = null;
      const providerMetadata = response.responseBody || response.data || response || null;

      if (provider.name === 'squad') {
        const squadStatus = providerMetadata?.status || providerMetadata?.transaction_status;
        isSuccess = !!response.success && (
          squadStatus === 'success' ||
          response.status === 'success' ||
          (response.success === true && squadStatus === undefined)
        );
        isFailed = !isSuccess && (
          response.success === false ||
          squadStatus === 'failed' ||
          squadStatus === 'failure' ||
          response.status === 'failed'
        );
        failureReason = response.message ||
                        providerMetadata?.failure_reason ||
                        providerMetadata?.error_message ||
                        (isFailed ? "Transfer rejected by Squad" : null);
      } else if (provider.name === 'monnify') {
        const monnifyStatus = providerMetadata?.status || providerMetadata?.transactionStatus;
        isSuccess = !!response.requestSuccessful && (
          monnifyStatus === 'SUCCESS' ||
          response.status === 'SUCCESS' ||
          (response.requestSuccessful === true && monnifyStatus === undefined)
        );
        isFailed = !isSuccess && (
          response.requestSuccessful === false ||
          monnifyStatus === 'FAILED' ||
          monnifyStatus === 'FAILURE' ||
          response.status === 'FAILED'
        );
        failureReason = response.responseMessage ||
                        providerMetadata?.failureReason ||
                        providerMetadata?.errorMessage ||
                        (isFailed ? "Transfer rejected by Monnify" : null);
      } else if (provider.name === 'flutterwave') {
        // POST /v3/transfers response: { status: 'success', data: { id, status: 'NEW'|'SUCCESSFUL'|..., ... } }
        const flwStatus = (providerMetadata?.status || providerMetadata?.transactionStatus || '').toUpperCase();
        isSuccess = response?.status === 'success' && FLW_SUCCESS_STATUSES.includes(flwStatus);
        isFailed = !isSuccess && (
          response?.status === 'error' ||
          ["FAILED", "REVERTED", "CANCELED", "CANCELLED"].includes(flwStatus)
        );
        failureReason = providerMetadata?.complete_message ||
                        response?.message ||
                        (isFailed ? "Transfer rejected by Flutterwave" : null);
      }

      if (isSuccess) immediateStatus = 'success';
      else if (isFailed) immediateStatus = 'failed';

      // Update with the provider-determined status immediately
      await query(
        `UPDATE transfer_queue 
         SET status = $2, failure_reason = $3, updated_at = CURRENT_TIMESTAMP, meta_data = $4, payment_provider = $5, provider_metadata = $6
         WHERE id = $1`,
        [transfer.id, immediateStatus, failureReason, JSON.stringify(response), provider.name, JSON.stringify(providerMetadata)]
      );
      
      // Owner invariant: the withdrawal's platform entry is the HOLD credit
      // written at initiation ('Platform Wallet Credit for Transfer <ref>').
      // No extra platform row on payout success (the previous 'Payout to ...'
      // debit reused the hold's reference and was always silently deduped).
      if (isSuccess) {
        // Send email notification on success
        if (transfer.wallet_id) {
          const walletRes = await query(`SELECT balance, user_id FROM wallets WHERE id = $1`, [transfer.wallet_id]);
          if (walletRes.rows.length > 0 && walletRes.rows[0].user_id) {
            const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [walletRes.rows[0].user_id]);
            if (userRes.rows.length > 0) {
              const user = userRes.rows[0];
              await sendTransactionAlert(
                user.email,
                user.name || 'User',
                'debit',
                parseFloat(transfer.amount),
                transfer.currency || 'NGN',
                parseFloat(walletRes.rows[0].balance),
                'success',
                transfer.reference,
                `Transfer to ${transfer.recipient_name || 'Account'}`
              );
            }
          }
        }

        // Log audit event for success
        await logAuditEvent({
          businessId: transfer.business_id,
          userId: transfer.initiated_by,
          action: 'transfer_completed',
          entityType: 'transfer',
          entityId: transfer.id,
          newValues: {
            reference: transfer.reference,
            status: 'success',
            amount: transfer.amount,
          },
        });
      } else if (isFailed && transfer.wallet_id) {
        // If provider rejected immediately, auto-reverse the wallet debit
        // (amount + fee) and unwind the platform/revenue holds.
        const reversed = await reverseFailedTransfer(transfer, failureReason || 'Provider rejected the transfer');

        if (reversed) {
          console.log(`[TransferService] Immediate refund for transfer ${transfer.reference}, Reason: ${failureReason}`);

          // Send email notification on failure
          const walletRes = await query(`SELECT balance, user_id FROM wallets WHERE id = $1`, [transfer.wallet_id]);
          if (walletRes.rows.length > 0 && walletRes.rows[0].user_id) {
            const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [walletRes.rows[0].user_id]);
            if (userRes.rows.length > 0) {
              const user = userRes.rows[0];
              await sendTransactionAlert(
                user.email,
                user.name || 'User',
                'debit',
                parseFloat(transfer.amount),
                transfer.currency || 'NGN',
                parseFloat(walletRes.rows[0].balance),
                'failed',
                transfer.reference,
                `Transfer failed: ${failureReason || 'Unknown reason'}`
              );
            }
          }
        }

        // Log audit event for failure
        await logAuditEvent({
          businessId: transfer.business_id,
          userId: transfer.initiated_by,
          action: 'transfer_failed',
          entityType: 'transfer',
          entityId: transfer.id,
          newValues: {
            reference: transfer.reference,
            status: 'failed',
            amount: transfer.amount,
            failureReason,
          },
        });
      }
      
      // If status is still processing (provider didn't give definitive answer), verify immediately
      if (immediateStatus === 'processing') {
        await verifySingleTransfer(transfer);
      }

    } catch (error: any) {
      // 5. Handle Exception
      const reason = error.message || "Internal processing error";
      
      const noRefundErrors = ["Insufficient wallet balance", "Source wallet not found"];
      if (
        !noRefundErrors.includes(reason) &&
        !reason.startsWith("Wallet currency mismatch")
      ) {
          // Auto-reverse the debit when money actually left the wallet.
          // The helper is idempotent (checks debit txn + existing -REFUND row).
          await reverseFailedTransfer(transfer, reason);
      }

      await query(
        `UPDATE transfer_queue 
         SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1`,
        [transfer.id, reason]
      );
    }
  }
}

export async function createBulkTransfers(businessId: string, transfers: any[]) {
  const results = [];
  for (const t of transfers) {
    // Basic validation
    if (!t.amount || !t.recipient_account || !t.recipient_bank || !t.recipient_name) {
        continue;
    }
    
    // Generate reference
    const reference = `TRF-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    
    // Determine wallet_id
    const walletId = t.source_type === 'wallet' ? t.source_id : null;

    // Insert into transfer_queue
    const defaultProvider = process.env.DEFAULT_PAYMENT_PROVIDER || 'flutterwave';
    const res = await query(
      `INSERT INTO transfer_queue 
       (business_id, amount, currency, recipient_account, recipient_bank, recipient_name, remark, status, reference, wallet_id, fee, payment_provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11)
       RETURNING *`,
       [
         businessId, 
         t.amount, 
         'NGN', // Default to NGN
         t.recipient_account,
         t.recipient_bank,
         t.recipient_name,
         t.remark || '',
         reference,
         walletId,
         t.fee || 0,
         t.payment_provider || defaultProvider
       ]
    );
    results.push(res.rows[0]);
  }
  return results;
}

export async function processTransfer(transferId: string) {
  // Fetch transfer
  const res = await query(`SELECT * FROM transfer_queue WHERE id = $1`, [transferId]);
  if (res.rows.length === 0) throw new Error("Transfer not found");
  let platformFloatCurrency = 'NGN';
  try {
    const { getIntlPayoutSourceCurrency } = await import("./app-config");
    platformFloatCurrency = await getIntlPayoutSourceCurrency();
  } catch {
    // default NGN
  }
  const transfer = normalizeTransferForProcessing(res.rows[0], platformFloatCurrency);
  
  if (transfer.status === 'success') return { message: "Already successful" };
  
  // Update status to processing
  await query(`UPDATE transfer_queue SET status = 'processing' WHERE id = $1`, [transfer.id]);

  try {
    // 1. Check Wallet & Debit
    if (transfer.wallet_id) {
        const walletRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [transfer.wallet_id]);
        if (walletRes.rows.length === 0) {
            throw new Error("Source wallet not found");
        }
        const balance = parseFloat(walletRes.rows[0].balance);
        const amount = parseFloat(transfer.amount);
        const fee = parseFloat(transfer.fee || '0');
        const totalDebit = amount + fee;

        if (balance < totalDebit) {
            throw new Error("Insufficient wallet balance");
        }

        // Debit Wallet
        await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [totalDebit, transfer.wallet_id]);

        // Owner invariant: withdrawal -> platform ledger CREDIT (hold row).
        await creditPlatformWallet(
          amount,
          transfer.currency || 'NGN',
          `${transfer.reference}-PLATFORM`,
          `Platform Wallet Credit for Transfer ${transfer.reference}`,
        );

        // Credit Revenue Wallet (Fee) - Earnings
        if (fee > 0) {
            await creditRevenueWallet(
              fee,
              transfer.currency || 'NGN',
              transfer.reference,
              `Transfer fee revenue for ${transfer.reference}`,
            );
        }

        // Record Transaction (Amount) - Idempotent: Check if exists first, UPDATE if so
        const existingTxn = await query(
          `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit' AND transaction_type = 'transfer'`,
          [transfer.reference]
        );

        if (existingTxn.rows.length === 0) {
          await query(
            `INSERT INTO transactions 
             (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
             VALUES ($1, $2, $3, 'success', $4, 'debit', $5, 'transfer', $6, 'debit')`,
            [
                transfer.business_id, 
                amount, 
                transfer.currency || 'NGN', 
                transfer.reference, 
                `Transfer to ${transfer.recipient_name || 'Account'}`,
                transfer.wallet_id
            ]
          );
        } else {
          await query(
            `UPDATE transactions 
             SET status = 'success', updated_at = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [existingTxn.rows[0].id]
          );
        }

        // Record Transaction (Fee) - Idempotent: Check if exists first
        if (fee > 0) {
            const existingFeeTxn = await query(
              `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit' AND transaction_type = 'fee'`,
              [transfer.reference + '-FEE']
            );

            if (existingFeeTxn.rows.length === 0) {
              await query(
                `INSERT INTO transactions 
                 (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee)
                 VALUES ($1, $2, $3, 'success', $4, 'debit', $5, 'fee', $6, 'debit', $7)`,
                [
                    transfer.business_id, 
                    fee, 
                    transfer.currency || 'NGN', 
                    transfer.reference + '-FEE', 
                    `Fee for transfer: ${transfer.reference}`,
                    transfer.wallet_id,
                    fee
                ]
              );
            } else {
              await query(
                `UPDATE transactions 
                 SET status = 'success', updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $1`,
                [existingFeeTxn.rows[0].id]
              );
            }
        }
    }

    // 2. Initiate Transfer
    const provider = getProvider(transfer.payment_provider);

    const payload = await buildTransferProviderPayload(transfer);

    const response = await provider.initiateTransfer(payload);

    // Parse provider response directly to determine status
    let immediateStatus: 'success' | 'failed' | 'processing' = 'processing';
    let isSuccess = false;
    let isFailed = false;
    let failureReason: string | null = null;
    const providerMetadata = response.responseBody || response.data || response || null;

    if (provider.name === 'squad') {
      const squadStatus = providerMetadata?.status || providerMetadata?.transaction_status;
      isSuccess = !!response.success && (
        squadStatus === 'success' ||
        response.status === 'success' ||
        (response.success === true && squadStatus === undefined)
      );
      isFailed = !isSuccess && (
        response.success === false ||
        squadStatus === 'failed' ||
        squadStatus === 'failure' ||
        response.status === 'failed'
      );
      failureReason = response.message ||
                      providerMetadata?.failure_reason ||
                      providerMetadata?.error_message ||
                      (isFailed ? "Transfer rejected by Squad" : null);
    } else if (provider.name === 'monnify') {
      const monnifyStatus = providerMetadata?.status || providerMetadata?.transactionStatus;
      isSuccess = !!response.requestSuccessful && (
        monnifyStatus === 'SUCCESS' ||
        response.status === 'SUCCESS' ||
        (response.requestSuccessful === true && monnifyStatus === undefined)
      );
      isFailed = !isSuccess && (
        response.requestSuccessful === false ||
        monnifyStatus === 'FAILED' ||
        monnifyStatus === 'FAILURE' ||
        response.status === 'FAILED'
      );
      failureReason = response.responseMessage ||
                      providerMetadata?.failureReason ||
                      providerMetadata?.errorMessage ||
                      (isFailed ? "Transfer rejected by Monnify" : null);
    }

    if (isSuccess) immediateStatus = 'success';
    else if (isFailed) immediateStatus = 'failed';

    // Update with the provider-determined status immediately
    await query(
      `UPDATE transfer_queue 
       SET status = $2, failure_reason = $3, updated_at = CURRENT_TIMESTAMP, meta_data = $4, payment_provider = $5, provider_metadata = $6
       WHERE id = $1`,
      [transfer.id, immediateStatus, failureReason, JSON.stringify(response), provider.name, JSON.stringify(providerMetadata)]
    );
    
    // Debit Platform Wallet (Amount only) as it has been sent out
    if (isSuccess) {
      const amount = parseFloat(transfer.amount);
      await debitPlatformWallet(amount, transfer.currency || 'NGN');

      // Send email notification on success
      if (transfer.wallet_id) {
        const walletRes = await query(`SELECT balance, user_id FROM wallets WHERE id = $1`, [transfer.wallet_id]);
        if (walletRes.rows.length > 0 && walletRes.rows[0].user_id) {
          const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [walletRes.rows[0].user_id]);
          if (userRes.rows.length > 0) {
            const user = userRes.rows[0];
            await sendTransactionAlert(
              user.email,
              user.name || 'User',
              'debit',
              parseFloat(transfer.amount),
              transfer.currency || 'NGN',
              parseFloat(walletRes.rows[0].balance),
              'success',
              transfer.reference,
              `Transfer to ${transfer.recipient_name || 'Account'}`
            );
          }
        }
      }

      // Log audit event for success
      await logAuditEvent({
        businessId: transfer.business_id,
        userId: transfer.initiated_by,
        action: 'transfer_completed',
        entityType: 'transfer',
        entityId: transfer.id,
        newValues: {
          reference: transfer.reference,
          status: 'success',
          amount: transfer.amount,
        },
      });
    } else if (isFailed && transfer.wallet_id) {
      // If provider rejected immediately, auto-reverse (idempotent + notifies user)
      await reverseFailedTransfer(transfer, failureReason || 'Provider rejected the transfer');

      // Send email notification on failure
      const walletRes = await query(`SELECT balance, user_id FROM wallets WHERE id = $1`, [transfer.wallet_id]);
      if (walletRes.rows.length > 0 && walletRes.rows[0].user_id) {
        const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [walletRes.rows[0].user_id]);
        if (userRes.rows.length > 0) {
          const user = userRes.rows[0];
          await sendTransactionAlert(
            user.email,
            user.name || 'User',
            'debit',
            parseFloat(transfer.amount),
            transfer.currency || 'NGN',
            parseFloat(walletRes.rows[0].balance),
            'failed',
            transfer.reference,
            `Transfer failed: ${failureReason || 'Unknown reason'}`
          );
        }
      }

      // Log audit event for failure
      await logAuditEvent({
        businessId: transfer.business_id,
        userId: transfer.initiated_by,
        action: 'transfer_failed',
        entityType: 'transfer',
        entityId: transfer.id,
        newValues: {
          reference: transfer.reference,
          status: 'failed',
          amount: transfer.amount,
          failureReason,
        },
      });
    }
    
    // If status is still processing (provider didn't give definitive answer), verify immediately
    let finalStatus = immediateStatus;
    if (immediateStatus === 'processing') {
      const updatedTransfer = await verifySingleTransfer(transfer);
      finalStatus = updatedTransfer.status;
    } else {
      const finalRes = await query(`SELECT * FROM transfer_queue WHERE id = $1`, [transfer.id]);
      const finalTransfer = finalRes.rows[0];
      if (finalTransfer) finalStatus = finalTransfer.status;
    }
    
    if (finalStatus === 'success') {
      return { success: true, message: "Transfer processed successfully", data: providerMetadata };
    } else if (finalStatus === 'failed') {
      throw new Error(failureReason || "Transfer failed");
    }
    
    return { success: true, message: "Transfer is being processed", data: providerMetadata };

  } catch (error: any) {
    const reason = error.message || "Internal processing error";
    
    // Auto-reversal (single idempotent helper; skips no-refund errors where
    // money never left the wallet)
    const noRefundErrors = ["Insufficient wallet balance", "Source wallet not found"];
    if (!noRefundErrors.includes(reason) && transfer.wallet_id) {
      await reverseFailedTransfer(transfer, reason);
    }

    await query(
      `UPDATE transfer_queue 
       SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [transfer.id, reason]
    );
    throw error;
  }
}
