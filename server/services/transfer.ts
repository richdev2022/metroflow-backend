import { query } from "../db";
import { initiateTransfer, toMinorUnit } from "./squad";
import { creditPlatformWallet, debitPlatformWallet, creditRevenueWallet, debitRevenueWallet } from "./fees";
export { accountLookup } from "./squad";

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
      
      const payload = {
        bank_code: transfer.recipient_bank,
        account_number: transfer.recipient_account,
        amount: amountMinor,
        account_name: transfer.recipient_name,
        transaction_reference: transfer.reference,
        remark: transfer.remark,
        currency_id: transfer.currency || 'NGN'
      };

      const response = await initiateTransfer(payload);

      if (response.status === 200 && response.success) {
         // 4. Success (or queued at Squad side)
         // Debit Platform Wallet (Amount only) as it has been sent out
         const amount = parseFloat(transfer.amount);
         await debitPlatformWallet(amount, transfer.currency || 'NGN');

         await query(
           `UPDATE transfer_queue 
            SET status = 'success', updated_at = CURRENT_TIMESTAMP, meta_data = $2 
            WHERE id = $1`,
           [transfer.id, JSON.stringify(response.data)]
         );
      } else {
        // Failed at Squad immediate response
        const reason = response.message || "Unknown error from Squad";
        
        // Refund Wallet
        if (transfer.wallet_id) {
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

            // Record Refund Transaction (Amount)
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

            // Refund Fee logic
            if (fee > 0) {
                // Record Fee Refund
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

        await query(
           `UPDATE transfer_queue 
            SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1`,
           [transfer.id, reason]
         );
      }

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
    const res = await query(
      `INSERT INTO transfer_queue 
       (business_id, amount, currency, recipient_account, recipient_bank, recipient_name, remark, status, reference, wallet_id, fee)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
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
         t.fee || 0
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
    
    const payload = {
      bank_code: transfer.recipient_bank,
      account_number: transfer.recipient_account,
      amount: amountMinor,
      account_name: transfer.recipient_name,
      transaction_reference: transfer.reference,
      remark: transfer.remark,
      currency_id: transfer.currency || 'NGN'
    };

    const response = await initiateTransfer(payload);

    if (response.status === 200 && response.success) {
       // Success
       // Debit Platform Wallet (Amount only) as it has been sent out
       const amount = parseFloat(transfer.amount);
       await debitPlatformWallet(amount, transfer.currency || 'NGN');

       await query(
         `UPDATE transfer_queue 
          SET status = 'success', updated_at = CURRENT_TIMESTAMP, meta_data = $2 
          WHERE id = $1`,
         [transfer.id, JSON.stringify(response.data)]
       );
       return { success: true, message: "Transfer processed successfully", data: response.data };
    } else {
      // Failed at Squad
      const reason = response.message || "Unknown error from Squad";
      
      // Refund Wallet
      if (transfer.wallet_id) {
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

      await query(
         `UPDATE transfer_queue 
          SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP 
          WHERE id = $1`,
         [transfer.id, reason]
       );
       throw new Error(reason);
    }

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
