import { query } from "../db";
import { getProvider } from "./providers/factory";
import { creditPlatformWallet, debitPlatformWallet, creditRevenueWallet, debitRevenueWallet } from "./fees";

// Re-export account lookup from provider
export async function accountLookup(bankCode: string, accountNumber: string) {
  const provider = getProvider();
  return provider.accountLookup(bankCode, accountNumber);
}

// Helper function to convert amount to minor units for both providers
export function toMinorUnit(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return Math.round(num * 100).toString();
}

// Helper function to verify a single transfer
export async function verifySingleTransfer(transfer: any) {
  try {
    console.log(`[TransferMonitor] Verifying transfer ${transfer.reference} (ID: ${transfer.id}, Provider: ${transfer.payment_provider})`);
    
    const provider = getProvider(transfer.payment_provider);
    const verificationResponse = await provider.verifyTransfer(transfer.reference);
    
    let isSuccess = false;
    let failureReason = "Unknown error from provider";
    let shouldRefund = true;

    if (provider.name === 'squad') {
      isSuccess = verificationResponse.success && (
        verificationResponse.data?.status === 'success' || 
        verificationResponse.data?.transaction_status === 'success'
      );
      failureReason = verificationResponse.message || 
                      verificationResponse.data?.failure_reason || 
                      verificationResponse.data?.error_message || 
                      "Transfer failed at provider";
    } else if (provider.name === 'monnify') {
      isSuccess = verificationResponse.requestSuccessful && (
        verificationResponse.responseBody?.status === 'SUCCESS' ||
        verificationResponse.responseBody?.transactionStatus === 'SUCCESS'
      );
      failureReason = verificationResponse.responseMessage || 
                      verificationResponse.responseBody?.failureReason || 
                      verificationResponse.responseBody?.errorMessage || 
                      "Transfer failed at provider";
    }

    console.log(`[TransferMonitor] Transfer ${transfer.reference} - Success: ${isSuccess}, Reason: ${failureReason}`);

    if (isSuccess) {
      shouldRefund = false;
      await query(
        `UPDATE transfer_queue 
         SET status = 'success', 
             updated_at = CURRENT_TIMESTAMP, 
             meta_data = $2 
         WHERE id = $1`,
        [transfer.id, JSON.stringify(verificationResponse)]
      );
    } else {
      await query(
        `UPDATE transfer_queue 
         SET status = 'failed', 
             failure_reason = $2, 
             updated_at = CURRENT_TIMESTAMP, 
             meta_data = $3 
         WHERE id = $1`,
        [transfer.id, failureReason, JSON.stringify(verificationResponse)]
      );
    }

    // Handle refunds if needed
    if (shouldRefund && transfer.wallet_id) {
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

        if (fee > 0) {
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

    // Return updated transfer
    const updatedRes = await query(
      `SELECT * FROM transfer_queue WHERE id = $1`,
      [transfer.id]
    );
    return updatedRes.rows[0];
  } catch (error: any) {
    console.error(`[TransferMonitor] Error verifying transfer ${transfer.reference}:`, error);
    return transfer; // Return original transfer if verification fails
  }
}

// Background service to check processing transfers
export async function checkProcessingTransfers() {
    try {
        console.log("[TransferMonitor] Checking processing transfers...");
        
        // Get all processing transfers
        const processingTransfers = await query(
            `SELECT * FROM transfer_queue WHERE status = 'processing' ORDER BY updated_at ASC`
        );

        if (processingTransfers.rows.length === 0) {
            console.log("[TransferMonitor] No processing transfers found");
            return;
        }

        console.log(`[TransferMonitor] Found ${processingTransfers.rows.length} processing transfers`);

        for (const transfer of processingTransfers.rows) {
            await verifySingleTransfer(transfer);
        }
    } catch (error: any) {
        console.error("[TransferMonitor] Error in checkProcessingTransfers:", error);
    }
}

// Start the background service
export function startTransferMonitor(intervalMs: number = 60000) { // Default: check every minute
  console.log(`[TransferMonitor] Starting transfer monitor with interval ${intervalMs}ms`);
  setInterval(checkProcessingTransfers, intervalMs);
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

  console.log(`Processing ${pendingTransfers.rows.length} pending transfers for business ${businessId}`);

  for (const transfer of pendingTransfers.rows) {
    // Update status to processing to prevent double pick-up
    await query(`UPDATE transfer_queue SET status = 'processing' WHERE id = $1`, [transfer.id]);

    try {
      // 2. Check Wallet & Debit
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

          // Record Transaction (Amount)
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

          // Record Transaction (Fee)
          if (fee > 0) {
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
          }
      }

      // 3. Initiate Transfer
      const amountMinor = toMinorUnit(transfer.amount);
      const provider = getProvider(transfer.payment_provider); // Use transfer's provider or default
      
      const payload = {
        bankCode: transfer.recipient_bank,
        accountNumber: transfer.recipient_account,
        amount: amountMinor,
        accountName: transfer.recipient_name,
        transactionReference: transfer.reference,
        remark: transfer.remark,
        currencyId: transfer.currency || 'NGN'
      };

      const response = await provider.initiateTransfer(payload);

      // Handle success for both Squad and Monnify
      let isSuccess = false;
      let failureReason = "Unknown error from provider";

      if (provider.name === 'squad') {
        isSuccess = response.status === 200 && response.success;
        failureReason = response.message || "Unknown error from Squad";
      } else if (provider.name === 'monnify') {
        isSuccess = response.requestSuccessful;
        failureReason = response.responseMessage || "Unknown error from Monnify";
      }

      // Always mark as processing first, then verify immediately
      await query(
        `UPDATE transfer_queue 
         SET status = 'processing', updated_at = CURRENT_TIMESTAMP, meta_data = $2, payment_provider = $3, provider_metadata = $4
         WHERE id = $1`,
        [transfer.id, JSON.stringify(response), provider.name, JSON.stringify(response.responseBody || response.data || null)]
      );
      
      // Debit Platform Wallet (Amount only) if initial response was success
      if (isSuccess) {
        const amount = parseFloat(transfer.amount);
        await debitPlatformWallet(amount, transfer.currency || 'NGN');
      }
      
      // Try immediate verification
      await verifySingleTransfer(transfer);

    } catch (error: any) {
      // 5. Handle Exception
      const reason = error.message || "Internal processing error";
      
      const noRefundErrors = ["Insufficient wallet balance", "Source wallet not found"];
      if (!noRefundErrors.includes(reason) && transfer.wallet_id) {
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

                if (fee > 0) {
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
    const defaultProvider = process.env.DEFAULT_PAYMENT_PROVIDER || 'squad';
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
  const transfer = res.rows[0];
  
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

        // Record Transaction
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

        if (fee > 0) {
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
        }
    }

    // 2. Initiate Transfer
    const amountMinor = toMinorUnit(transfer.amount);
    const provider = getProvider(transfer.payment_provider);
    
    const payload = {
      bankCode: transfer.recipient_bank,
      accountNumber: transfer.recipient_account,
      amount: amountMinor,
      accountName: transfer.recipient_name,
      transactionReference: transfer.reference,
      remark: transfer.remark,
      currencyId: transfer.currency || 'NGN'
    };

    const response = await provider.initiateTransfer(payload);

    // Handle success for both Squad and Monnify
    let isSuccess = false;
    let failureReason = "Unknown error from provider";

    if (provider.name === 'squad') {
      isSuccess = response.status === 200 && response.success;
      failureReason = response.message || "Unknown error from Squad";
    } else if (provider.name === 'monnify') {
      isSuccess = response.requestSuccessful;
      failureReason = response.responseMessage || "Unknown error from Monnify";
    }

    // Always mark as processing first, then verify immediately
    await query(
      `UPDATE transfer_queue 
       SET status = 'processing', updated_at = CURRENT_TIMESTAMP, meta_data = $2, payment_provider = $3, provider_metadata = $4
       WHERE id = $1`,
      [transfer.id, JSON.stringify(response), provider.name, JSON.stringify(response.responseBody || response.data || null)]
    );
    
    // Debit Platform Wallet (Amount only) as it has been sent out
    if (isSuccess) {
      const amount = parseFloat(transfer.amount);
      await debitPlatformWallet(amount, transfer.currency || 'NGN');
    }
    
    // Try immediate verification
    const updatedTransfer = await verifySingleTransfer(transfer);
    
    if (updatedTransfer.status === 'success') {
      return { success: true, message: "Transfer processed successfully", data: response.responseBody || response.data };
    } else if (updatedTransfer.status === 'failed') {
      throw new Error(updatedTransfer.failure_reason || "Transfer failed");
    }
    
    return { success: true, message: "Transfer is being processed", data: response.responseBody || response.data };

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

              if (fee > 0) {
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

    await query(
      `UPDATE transfer_queue 
       SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [transfer.id, reason]
    );
    throw error;
  }
}
