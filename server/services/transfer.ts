import { query } from "../db";
import { getProvider, resolveProvider } from "./providers/factory";
import type { SingleTransferRequest } from "./providers";
import { creditPlatformWallet, debitPlatformWallet, creditRevenueWallet, debitRevenueWallet } from "./fees";
import { logAuditEvent, generateTransactionHash } from "./audit";
import { sendTransactionAlert } from "./email";

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
  };

  const isIntl = payload.currencyId !== 'NGN' || !!payload.beneficiaryCountry;
  if (isIntl && transfer.business_id) {
    try {
      const bRes = await query(`SELECT name, email FROM businesses WHERE id = $1`, [transfer.business_id]);
      payload.senderName = bRes.rows[0]?.name || payload.accountName;
      payload.senderEmail = bRes.rows[0]?.email || undefined;
      payload.senderAddress = payload.beneficiaryAddress;
      payload.senderCountry = payload.beneficiaryCountry;
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

// Flutterwave transfer status buckets
const FLW_SUCCESS_STATUSES = ['SUCCESSFUL'];
const FLW_PENDING_STATUSES = ['NEW', 'PENDING', 'QUEUED', 'ONGOING', 'PROCESSING', 'CREATED'];

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

        // Handle refunds if needed
        if (transfer.wallet_id) {
          const amount = parseFloat(transfer.amount);
          const fee = parseFloat(transfer.fee || '0');
          const totalRefund = amount + fee;

          // Check if we already debited the wallet
          const txnCheck = await query(
            `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit'`,
            [transfer.reference]
          );
          if (txnCheck.rows.length > 0) {
            console.log(`[TransferMonitor] Refunding transfer ${transfer.reference} - Amount: ${totalRefund}`);
            
            await query(
              `UPDATE wallets SET balance = balance + $1 WHERE id = $2`,
              [totalRefund, transfer.wallet_id]
            );
            
            await debitPlatformWallet(amount, transfer.currency || 'NGN');

            if (fee > 0) {
              await debitRevenueWallet(fee, transfer.currency || 'NGN');
            }

            // Check if refund transaction already exists
            const refundTxnCheck = await query(
              `SELECT id FROM transactions WHERE reference = $1`,
              [transfer.reference + '-REFUND']
            );
            
            if (refundTxnCheck.rows.length === 0) {
              await query(
                `INSERT INTO transactions 
                 (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                 VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
                [
                  transfer.business_id, 
                  amount, 
                  transfer.currency || 'NGN', 
                  transfer.reference + '-REFUND', 
                  `Refund for failed transfer: ${transfer.reference}`,
                  transfer.wallet_id
                ]
              );
            }

            if (fee > 0) {
              const feeRefundTxnCheck = await query(
                `SELECT id FROM transactions WHERE reference = $1`,
                [transfer.reference + '-FEE-REFUND']
              );
              
              if (feeRefundTxnCheck.rows.length === 0) {
                await query(
                  `INSERT INTO transactions 
                   (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                   VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
                  [
                    transfer.business_id, 
                    fee, 
                    transfer.currency || 'NGN', 
                    transfer.reference + '-FEE-REFUND', 
                    `Refund fee for failed transfer: ${transfer.reference}`,
                    transfer.wallet_id
                  ]
                );
              }
            }
          }
        }

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
        
        // Handle refund
        if (transfer.wallet_id) {
          const amount = parseFloat(transfer.amount);
          const fee = parseFloat(transfer.fee || '0');
          const totalRefund = amount + fee;
          
          const txnCheck = await query(
            `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit'`,
            [transfer.reference]
          );
          
          if (txnCheck.rows.length > 0) {
            console.log(`[TransferMonitor] Refunding transfer ${transfer.reference} - Amount: ${totalRefund}`);
            
            await query(
              `UPDATE wallets SET balance = balance + $1 WHERE id = $2`,
              [totalRefund, transfer.wallet_id]
            );
            
            await debitPlatformWallet(amount, transfer.currency || 'NGN');
            
            if (fee > 0) {
              await debitRevenueWallet(fee, transfer.currency || 'NGN');
            }
            
            // Check if refund transaction already exists
            const refundTxnCheck = await query(
              `SELECT id FROM transactions WHERE reference = $1`,
              [transfer.reference + '-REFUND']
            );
            
            if (refundTxnCheck.rows.length === 0) {
              await query(
                `INSERT INTO transactions 
                 (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                 VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
                [
                  transfer.business_id, 
                  amount, 
                  transfer.currency || 'NGN', 
                  transfer.reference + '-REFUND', 
                  `Refund for failed transfer: ${transfer.reference}`,
                  transfer.wallet_id
                ]
              );
            }
          }
        }
        
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

// Refund a timed-out transfer back to the source wallet
async function refundTimedOutTransfer(rawTransfer: any) {
  const transfer = normalizeTransferForProcessing(rawTransfer);
  const amount = parseFloat(transfer.amount);
  const fee = parseFloat(transfer.fee || '0');
  const totalRefund = amount + fee;

  await query(
    `UPDATE transfer_queue
     SET status = 'failed',
         failure_reason = 'Transfer timed out after 24 hours',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [transfer.id]
  );

  if (!transfer.wallet_id) return;

  const txnCheck = await query(
    `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit'`,
    [transfer.reference]
  );
  if (txnCheck.rows.length === 0) return;

  await query(
    `UPDATE wallets SET balance = balance + $1 WHERE id = $2`,
    [totalRefund, transfer.wallet_id]
  );

  await debitPlatformWallet(amount, transfer.currency || 'NGN');

  if (fee > 0) {
    await debitRevenueWallet(fee, transfer.currency || 'NGN');
  }

  // Check if refund transaction already exists
  const refundTxnCheck = await query(
    `SELECT id FROM transactions WHERE reference = $1`,
    [transfer.reference + '-REFUND']
  );

  if (refundTxnCheck.rows.length === 0) {
    await query(
      `INSERT INTO transactions
       (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
       VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
      [
        transfer.business_id,
        amount,
        transfer.currency || 'NGN',
        transfer.reference + '-REFUND',
        `Refund for timed out transfer: ${transfer.reference}`,
        transfer.wallet_id
      ]
    );
  }
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
export function normalizeTransferForProcessing(transfer: any): any {
  const debitAmount = transfer.debit_amount != null ? parseFloat(transfer.debit_amount) : NaN;
  if (Number.isFinite(debitAmount) && debitAmount > 0 && debitAmount !== parseFloat(transfer.amount)) {
    return {
      ...transfer,
      _providerAmount: transfer.amount,
      _providerCurrency: transfer.currency || 'NGN',
      amount: debitAmount,
      currency: transfer.debit_currency || transfer.currency || 'NGN',
    };
  }
  return { ...transfer, _providerAmount: transfer.amount, _providerCurrency: transfer.currency || 'NGN' };
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

  pendingTransfers.rows = pendingTransfers.rows.map(normalizeTransferForProcessing);

  console.log(`Processing ${pendingTransfers.rows.length} pending transfers for business ${businessId}`);

  for (const transfer of pendingTransfers.rows) {
    // Update status to processing to prevent double pick-up
    await query(`UPDATE transfer_queue SET status = 'processing' WHERE id = $1`, [transfer.id]);

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
          
          // Credit Platform Wallet (Amount) - Intermediary Step for Payout.
          // Reference passed so the movement is visible in the admin Platform Ledger.
          await creditPlatformWallet(
            amount,
            transfer.currency || 'NGN',
            transfer.reference,
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

      // 3. Initiate Transfer
      const provider = getProvider(transfer.payment_provider); // Use transfer's provider or default

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
      
      // Debit Platform Wallet (Amount only) if initial response was success
      if (isSuccess) {
        const amount = parseFloat(transfer.amount);
        await debitPlatformWallet(
          amount,
          transfer.currency || 'NGN',
          transfer.reference,
          `Payout to ${transfer.recipient_name || transfer.recipient_account || 'recipient'} (${transfer.reference})`,
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
        // If provider rejected immediately, refund the wallet
        const amount = parseFloat(transfer.amount);
        const fee = parseFloat(transfer.fee || '0');
        const totalRefund = amount + fee;

        const txnCheck = await query(
          `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit'`,
          [transfer.reference]
        );
        if (txnCheck.rows.length > 0) {
          console.log(`[TransferService] Immediate refund for transfer ${transfer.reference} - Amount: ${totalRefund}, Reason: ${failureReason}`);
          
          await query(
            `UPDATE wallets SET balance = balance + $1 WHERE id = $2`,
            [totalRefund, transfer.wallet_id]
          );
          
          await debitPlatformWallet(
            amount,
            transfer.currency || 'NGN',
            transfer.reference + '-REFUND',
            `Reversal of platform hold for failed transfer ${transfer.reference}`,
          );

          if (fee > 0) {
            await debitRevenueWallet(
              fee,
              transfer.currency || 'NGN',
              transfer.reference + '-REFUND',
              `Reversal of fee revenue for failed transfer ${transfer.reference}`,
            );
          }

          const refundTxnCheck = await query(
            `SELECT id FROM transactions WHERE reference = $1`,
            [transfer.reference + '-REFUND']
          );
          
          if (refundTxnCheck.rows.length === 0) {
            await query(
              `INSERT INTO transactions 
               (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
               VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
              [
                transfer.business_id, 
                amount, 
                transfer.currency || 'NGN', 
                transfer.reference + '-REFUND', 
                `Refund for failed transfer: ${transfer.reference}`,
                transfer.wallet_id
              ]
            );
          }

          if (fee > 0) {
            const feeRefundTxnCheck = await query(
              `SELECT id FROM transactions WHERE reference = $1`,
              [transfer.reference + '-FEE-REFUND']
            );
            
            if (feeRefundTxnCheck.rows.length === 0) {
              await query(
                `INSERT INTO transactions 
                 (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                 VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
                [
                  transfer.business_id, 
                  fee, 
                  transfer.currency || 'NGN', 
                  transfer.reference + '-FEE-REFUND', 
                  `Refund fee for failed transfer: ${transfer.reference}`,
                  transfer.wallet_id
                ]
              );
            }
          }

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
        !reason.startsWith("Wallet currency mismatch") &&
        transfer.wallet_id
      ) {
          // Check if we actually debited? 
           const txnCheck = await query(`SELECT id FROM transactions WHERE reference = $1 AND type = 'debit'`, [transfer.reference]);
           if (txnCheck.rows.length > 0) {
               // We debited, so refund
               const amount = parseFloat(transfer.amount);
               const fee = parseFloat(transfer.fee || '0');
               const totalRefund = amount + fee;

                await query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [totalRefund, transfer.wallet_id]);
                
                // Reversal: Debit Platform Wallet (Amount)
                await debitPlatformWallet(amount, transfer.currency || 'NGN');

                // Reversal: Debit Revenue Wallet (Fee)
                if (fee > 0) {
                    await debitRevenueWallet(fee, transfer.currency || 'NGN');
                }

                // Check if refund transaction already exists
                const refundTxnCheck = await query(
                    `SELECT id FROM transactions WHERE reference = $1`,
                    [transfer.reference + '-REFUND']
                );
                
                if (refundTxnCheck.rows.length === 0) {
                    await query(
                        `INSERT INTO transactions 
                         (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                         VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
                        [
                            transfer.business_id, 
                            amount, 
                            transfer.currency || 'NGN', 
                            transfer.reference + '-REFUND', 
                            `Refund for failed transfer: ${transfer.reference}`,
                            transfer.wallet_id
                        ]
                    );
                }

                if (fee > 0) {
                    const feeRefundTxnCheck = await query(
                        `SELECT id FROM transactions WHERE reference = $1`,
                        [transfer.reference + '-FEE-REFUND']
                    );
                    
                    if (feeRefundTxnCheck.rows.length === 0) {
                        await query(
                            `INSERT INTO transactions 
                             (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                             VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
                            [
                                transfer.business_id, 
                                fee, 
                                transfer.currency || 'NGN', 
                                transfer.reference + '-FEE-REFUND', 
                                `Refund fee for failed transfer: ${transfer.reference}`,
                                transfer.wallet_id
                            ]
                        );
                    }
                }
           }
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
  const transfer = normalizeTransferForProcessing(res.rows[0]);
  
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
        
        // Credit Platform Wallet (Amount) - Intermediary Step for Payout
        await creditPlatformWallet(amount, transfer.currency || 'NGN');

        // Credit Revenue Wallet (Fee) - Earnings
        if (fee > 0) {
            await creditRevenueWallet(fee, transfer.currency || 'NGN');
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
      // If provider rejected immediately, refund the wallet
      const amount = parseFloat(transfer.amount);
      const fee = parseFloat(transfer.fee || '0');
      const totalRefund = amount + fee;

      const txnCheck = await query(
        `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit'`,
        [transfer.reference]
      );
      if (txnCheck.rows.length > 0) {
        console.log(`[TransferService] Immediate refund for transfer ${transfer.reference} - Amount: ${totalRefund}, Reason: ${failureReason}`);
        
        await query(
          `UPDATE wallets SET balance = balance + $1 WHERE id = $2`,
          [totalRefund, transfer.wallet_id]
        );
        
        await debitPlatformWallet(amount, transfer.currency || 'NGN');

        if (fee > 0) {
          await debitRevenueWallet(fee, transfer.currency || 'NGN');
        }

        const refundTxnCheck = await query(
          `SELECT id FROM transactions WHERE reference = $1`,
          [transfer.reference + '-REFUND']
        );
        
        if (refundTxnCheck.rows.length === 0) {
          await query(
            `INSERT INTO transactions 
             (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
             VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
            [
              transfer.business_id, 
              amount, 
              transfer.currency || 'NGN', 
              transfer.reference + '-REFUND', 
              `Refund for failed transfer: ${transfer.reference}`,
              transfer.wallet_id
            ]
          );
        }

        if (fee > 0) {
          const feeRefundTxnCheck = await query(
            `SELECT id FROM transactions WHERE reference = $1`,
            [transfer.reference + '-FEE-REFUND']
          );
          
          if (feeRefundTxnCheck.rows.length === 0) {
            await query(
              `INSERT INTO transactions 
               (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
               VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
              [
                transfer.business_id, 
                fee, 
                transfer.currency || 'NGN', 
                transfer.reference + '-FEE-REFUND', 
                `Refund fee for failed transfer: ${transfer.reference}`,
                transfer.wallet_id
              ]
            );
          }
        }

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
    
    // Refund Logic (Simplified check)
    const noRefundErrors = ["Insufficient wallet balance", "Source wallet not found"];
    if (!noRefundErrors.includes(reason) && transfer.wallet_id) {
         const txnCheck = await query(`SELECT id FROM transactions WHERE reference = $1 AND type = 'debit'`, [transfer.reference]);
         if (txnCheck.rows.length > 0) {
             const amount = parseFloat(transfer.amount);
             const fee = parseFloat(transfer.fee || '0');
             const totalRefund = amount + fee;

              await query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [totalRefund, transfer.wallet_id]);
              
              // Reversal: Debit Platform Wallet (Amount)
              await debitPlatformWallet(amount, transfer.currency || 'NGN');

              // Reversal: Debit Revenue Wallet (Fee)
              if (fee > 0) {
                  await debitRevenueWallet(fee, transfer.currency || 'NGN');
              }

              // Check if refund transaction already exists
              const refundTxnCheck = await query(
                  `SELECT id FROM transactions WHERE reference = $1`,
                  [transfer.reference + '-REFUND']
              );
              
              if (refundTxnCheck.rows.length === 0) {
                await query(
                    `INSERT INTO transactions 
                     (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                     VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
                    [
                        transfer.business_id, 
                        amount, 
                        transfer.currency || 'NGN', 
                        transfer.reference + '-REFUND', 
                        `Refund for failed transfer: ${transfer.reference}`,
                        transfer.wallet_id
                    ]
                );
              }

              if (fee > 0) {
                const feeRefundTxnCheck = await query(
                    `SELECT id FROM transactions WHERE reference = $1`,
                    [transfer.reference + '-FEE-REFUND']
                );
                
                if (feeRefundTxnCheck.rows.length === 0) {
                  await query(
                      `INSERT INTO transactions 
                       (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                       VALUES ($1, $2, $3, 'success', $4, 'credit', $5, 'refund', $6, 'credit')`,
                      [
                          transfer.business_id, 
                          fee, 
                          transfer.currency || 'NGN', 
                          transfer.reference + '-FEE-REFUND', 
                          `Refund fee for failed transfer: ${transfer.reference}`,
                          transfer.wallet_id
                      ]
                  );
                }
              }
         }
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
