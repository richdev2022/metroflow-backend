import express from "express";
import { query } from "../db";
import { getProvider } from "../services/providers/factory";
import { calculateFee, creditRevenueWallet } from "../services/fees";
import crypto from "crypto";
import { sendTransactionAlert } from "../services/email";
import { createNotification } from "../services/notifications";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Webhooks
 *   description: Webhook endpoints for payment providers (Squad and Monnify)
 */

/**
 * @swagger
 * /webhook:
 *   post:
 *     summary: Webhook endpoint for payment providers
 *     description: Receives and processes webhook events from Squad and Monnify
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *       500:
 *         description: Internal server error
 */

// Helper to parse card PAN
const parsePan = (pan: string) => {
    let last4 = null;
    let expMonth = null;
    let expYear = null;
    let cardType = null;
    
    if (pan && pan.includes('|')) {
        const parts = pan.split('|');
        const cardPart = parts[0];
        const expPart = parts[1]; 
        
        last4 = cardPart.slice(-4);
        if (expPart && expPart.length === 4) {
            expMonth = expPart.substring(0, 2);
            expYear = "20" + expPart.substring(2);
        }
    } else if (pan) {
        last4 = pan.slice(-4);
    }
    
    return { last4, expMonth, expYear, cardType };
};

// Helper to handle Squad webhook
const handleSquadWebhook = async (event: any) => {
    if (event.Event === 'charge_successful' || event.Event === 'charge_failed') {
        const body = event.Body;
        const reference = body.transaction_ref;
        const isSuccess = event.Event === 'charge_successful';
        
        // Find transaction
        const txnRes = await query(`SELECT * FROM transactions WHERE reference = $1`, [reference]);
        
        if (txnRes.rows.length > 0) {
            const transaction = txnRes.rows[0];
            const businessId = transaction.business_id;
            const userId = transaction.user_id;

            // Extract Card Data if needed
            const paymentInfo = body.payment_information || {};
            const cardDetails = body.card_details || {};
            const tokenId = body.token_id || paymentInfo.token_id || cardDetails.token_id;
            
            let last4 = null;
            let cardType = null;
            let expMonth = null;
            let expYear = null;
            
            if (isSuccess && paymentInfo.pan) {
                 const parsed = parsePan(paymentInfo.pan);
                 last4 = parsed.last4;
                 expMonth = parsed.expMonth;
                 expYear = parsed.expYear;
                 cardType = paymentInfo.card_type || paymentInfo.type;
            } else if (isSuccess && cardDetails.pan) {
                 const parsed = parsePan(cardDetails.pan);
                 last4 = parsed.last4;
                 expMonth = parsed.expMonth;
                 expYear = parsed.expYear;
                 cardType = cardDetails.type;
            }

            // If token exists, save card (if business transaction and success)
            if (isSuccess && tokenId && businessId) {
                 const cardCheck = await query(`SELECT id FROM payment_cards WHERE token_id = $1`, [tokenId]);
                 if (cardCheck.rows.length === 0) {
                     await query(`
                        INSERT INTO payment_cards (business_id, token_id, last4, card_type, exp_month, exp_year, is_active)
                        VALUES ($1, $2, $3, $4, $5, $6, true)
                     `, [businessId, tokenId, last4, cardType, expMonth, expYear]);
                 } else {
                     await query(`UPDATE payment_cards SET is_active = true WHERE token_id = $1`, [tokenId]);
                 }
                 
                 await query(`UPDATE payment_cards SET is_active = false WHERE business_id = $1 AND token_id != $2`, [businessId, tokenId]);
                 await query(`UPDATE businesses SET card_token = $1 WHERE id = $2`, [tokenId, businessId]);
            }

            // Update Transaction Status
            const newStatus = isSuccess ? 'success' : 'failed';
            if (transaction.status !== newStatus) {
                await query(
                    `UPDATE transactions SET status = $1, gateway_response = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
                    [newStatus, JSON.stringify(body), transaction.id]
                );

                if (isSuccess) {
                    // Handle Wallet Funding
                    if (transaction.transaction_type === 'wallet_funding') {
                        const amount = parseFloat(transaction.amount);
                        const walletId = transaction.wallet_id;

                        if (walletId) {
                            await query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [amount, walletId]);

                            const platformWallet = await query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
                            if (platformWallet.rows.length > 0) {
                                await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [amount, platformWallet.rows[0].id]);
                                
                                await query(
                                    `INSERT INTO transactions 
                                    (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                                    VALUES ($1, 'NGN', 'success', $2, 'debit', 'Platform Wallet Debit for User Funding', 'wallet_funding', $3, 'debit')`,
                                    [amount, `${reference}-PLATFORM`, platformWallet.rows[0].id]
                                );
                            }
                        }
                    }

                    // Handle Subscription
                    if (transaction.transaction_type === 'subscription' && businessId) {
                        const planRes = await query(`SELECT duration FROM pricing_plans WHERE id = $1`, [transaction.plan_id]);
                        const planDuration = planRes.rows.length > 0 ? planRes.rows[0].duration : 'monthly';

                        const nextBillingDate = new Date();
                        if (planDuration === 'yearly') {
                            nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
                        } else {
                            nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
                        }
                        
                        await query(
                            `UPDATE businesses 
                            SET plan_id = $1, 
                            subscription_status = 'active', 
                            trial_ends_at = NULL, 
                            updated_at = CURRENT_TIMESTAMP,
                            next_billing_date = $3
                            WHERE id = $2`,
                            [transaction.plan_id, businessId, nextBillingDate]
                        );

                        const subAmount = parseFloat(transaction.amount);
                        await creditRevenueWallet(subAmount, transaction.currency || 'NGN');
                    }
                }
            }
        } else if (isSuccess) {
      // Transaction not found in DB (Maybe Virtual Account Transfer?)
      const vaNumber = body.virtual_account_number || body.customer?.virtual_account_number;
      
      if (vaNumber) {
        let walletId: string | null = null;
        const vaRes = await query(`SELECT wallet_id FROM virtual_accounts WHERE virtual_account_number = $1`, [vaNumber]);
        
        if (vaRes.rows.length > 0) {
          walletId = vaRes.rows[0].wallet_id;
        } else {
          const walletRes = await query(`SELECT id FROM wallets WHERE virtual_account_number = $1`, [vaNumber]);
          if (walletRes.rows.length > 0) {
            walletId = walletRes.rows[0].id;
          }
        }
        
        if (walletId) {
          const walletRes = await query(`SELECT id, user_id, business_id, balance FROM wallets WHERE id = $1`, [walletId]);
          
          if (walletRes.rows.length > 0) {
            const wallet = walletRes.rows[0];
            let amount = parseFloat(body.amount);
            
            const txnCheck = await query(`SELECT id FROM transactions WHERE reference = $1`, [reference]);
            
            if (txnCheck.rows.length === 0) {
              const fee = await calculateFee(amount, 'funding_account');
              const creditAmount = Math.max(0, amount - fee);
              const newBalance = (parseFloat(wallet.balance) || 0) + creditAmount;

              // Credit user wallet first
              await query(`UPDATE wallets SET balance = $1 WHERE id = $2`, [newBalance, wallet.id]);

              // Debit platform wallet for user credit
              const platformWalletRes = await query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL LIMIT 1`);
              if (platformWalletRes.rows.length > 0) {
                await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [creditAmount, platformWalletRes.rows[0].id]);
                
                await query(
                  `INSERT INTO transactions 
                   (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                   VALUES ($1, 'NGN', 'success', $2, 'debit', 'Platform Wallet Debit for User Funding', 'wallet_funding', $3, 'debit')`,
                  [creditAmount, `${reference}-USER`, platformWalletRes.rows[0].id]
                );
              }

              // Credit revenue wallet (this will also debit platform wallet for fee)
              if (fee > 0) {
                await creditRevenueWallet(fee, 'NGN', reference);
              }

              await query(
                `INSERT INTO transactions 
                 (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider)
                 VALUES ($1, $2, $3, 'NGN', 'success', $4, 'credit', 'Wallet Funding via Virtual Account', 'wallet_funding', $5, 'credit', $6, 'squad')`,
                [wallet.business_id, wallet.user_id, amount, reference, wallet.id, fee]
              );

              // Send in-app notification
              if (wallet.user_id) {
                await createNotification({
                  businessId: wallet.business_id!,
                  userId: wallet.user_id,
                  type: "credit",
                  title: "Wallet Credited",
                  message: `Your wallet has been credited with ₦${creditAmount.toLocaleString()}`,
                  actionUrl: "/wallet",
                  actionType: "view_wallet",
                  metadata: { amount: creditAmount, reference, transactionType: "wallet_funding" },
                  isActionable: false,
                  expiresInHours: 24,
                });
              }

              // Send email notification
              const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [wallet.user_id]);
              if (userRes.rows.length > 0) {
                const user = userRes.rows[0];
                await sendTransactionAlert(
                  user.email,
                  user.name || 'User',
                  'credit',
                  creditAmount,
                  'NGN',
                  newBalance,
                  'success',
                  reference,
                  'Wallet Funding via Virtual Account'
                );
              }
            }
          }
        }
      }
    }
    }

    // Handle transfer status updates
    if (event.Event === 'transfer_successful' || event.Event === 'transfer_failed') {
        const body = event.Body;
        const reference = body.transaction_ref || body.reference;
        const isSuccess = event.Event === 'transfer_successful';

        // Find transfer in transfer_queue
        const transferRes = await query(`SELECT * FROM transfer_queue WHERE reference = $1`, [reference]);
        
        if (transferRes.rows.length > 0) {
            const transfer = transferRes.rows[0];
            const newStatus = isSuccess ? 'success' : 'failed';
            const failureReason = !isSuccess ? body.message || 'Transfer failed' : null;

            await query(
                `UPDATE transfer_queue 
                 SET status = $1, failure_reason = $2, updated_at = CURRENT_TIMESTAMP, meta_data = $3, provider_metadata = $4
                 WHERE id = $5`,
                [newStatus, failureReason, JSON.stringify(body), JSON.stringify(body), transfer.id]
            );
        }
    }
};

// Helper to handle Monnify webhook
const handleMonnifyWebhook = async (event: any) => {
    const eventType = event.eventType;
    
    if (eventType === 'SUCCESSFUL_TRANSACTION' || eventType === 'FAILED_TRANSACTION') {
        const transactionData = event.eventData;
        const reference = transactionData.paymentReference;
        const isSuccess = eventType === 'SUCCESSFUL_TRANSACTION';
        
        console.log('Monnify webhook received:', JSON.stringify(transactionData, null, 2));
        
        // Find transaction
        const txnRes = await query(`SELECT * FROM transactions WHERE reference = $1`, [reference]);
        
        if (txnRes.rows.length > 0) {
            const transaction = txnRes.rows[0];
            const businessId = transaction.business_id;
            const userId = transaction.user_id;
            const newStatus = isSuccess ? 'success' : 'failed';
            
            // Update Transaction Status
            if (transaction.status !== newStatus) {
                await query(
                    `UPDATE transactions SET status = $1, gateway_response = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
                    [newStatus, JSON.stringify(transactionData), transaction.id]
                );
                
                if (isSuccess) {
                    // Handle Wallet Funding
                    if (transaction.transaction_type === 'wallet_funding') {
                        const amount = parseFloat(transaction.amount);
                        const walletId = transaction.wallet_id;
                        
                        if (walletId) {
                            await query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [amount, walletId]);
                            
                            const platformWallet = await query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
                            if (platformWallet.rows.length > 0) {
                                await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [amount, platformWallet.rows[0].id]);
                                
                                await query(
                                    `INSERT INTO transactions 
                                    (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                                    VALUES ($1, 'NGN', 'success', $2, 'debit', 'Platform Wallet Debit for User Funding', 'wallet_funding', $3, 'debit')`,
                                    [amount, `${reference}-PLATFORM`, platformWallet.rows[0].id]
                                );
                            }
                        }
                    }
                    
                    // Handle Subscription
                    if (transaction.transaction_type === 'subscription' && businessId) {
                        const planRes = await query(`SELECT duration FROM pricing_plans WHERE id = $1`, [transaction.plan_id]);
                        const planDuration = planRes.rows.length > 0 ? planRes.rows[0].duration : 'monthly';
                        
                        const nextBillingDate = new Date();
                        if (planDuration === 'yearly') {
                            nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
                        } else {
                            nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
                        }
                        
                        await query(
                            `UPDATE businesses 
                            SET plan_id = $1, 
                            subscription_status = 'active', 
                            trial_ends_at = NULL, 
                            updated_at = CURRENT_TIMESTAMP,
                            next_billing_date = $3
                            WHERE id = $2`,
                            [transaction.plan_id, businessId, nextBillingDate]
                        );
                        
                        const subAmount = parseFloat(transaction.amount);
                        await creditRevenueWallet(subAmount, transaction.currency || 'NGN');
                    }
                }
            }
        } else if (isSuccess) {
            // Check for Virtual Account Credit (Monnify Reserved Account)
            // Try both accountDetails and destinationAccountInformation (Monnify uses both depending on payment type)
            let accountDetails = transactionData.accountDetails;
            if (!accountDetails) {
                accountDetails = transactionData.destinationAccountInformation;
            }
            const vaNumber = accountDetails?.accountNumber;
            
            console.log('Looking for VA number:', vaNumber, 'from accountDetails:', accountDetails);
            
            let walletId: string | null = null;
            
            if (vaNumber) {
                const vaRes = await query(`SELECT wallet_id FROM virtual_accounts WHERE virtual_account_number = $1`, [vaNumber]);
                if (vaRes.rows.length === 0) {
                    const walletRes = await query(`SELECT id, user_id, business_id FROM wallets WHERE virtual_account_number = $1`, [vaNumber]);
                    if (walletRes.rows.length > 0) {
                        walletId = walletRes.rows[0].id;
                    }
                } else {
                    walletId = vaRes.rows[0].wallet_id;
                }
            }
            
            // If no VA found, try product.reference which is user ID
            if (!walletId && transactionData.product?.reference) {
                const productRef = transactionData.product.reference;
                console.log('Trying product reference:', productRef);
                // Try to find wallet by user_id
                const walletRes = await query(`SELECT id FROM wallets WHERE user_id = $1`, [productRef]);
                if (walletRes.rows.length > 0) {
                    walletId = walletRes.rows[0].id;
                } else {
                    // Try to find wallet by business_id
                    const businessWalletRes = await query(`SELECT id FROM wallets WHERE business_id = $1`, [productRef]);
                    if (businessWalletRes.rows.length > 0) {
                        walletId = businessWalletRes.rows[0].id;
                    }
                }
            }
                
            if (walletId) {
                const walletRes = await query(`SELECT id, user_id, business_id, balance FROM wallets WHERE id = $1`, [walletId]);
            
                if (walletRes.rows.length > 0) {
                    const wallet = walletRes.rows[0];
                    // Monnify amount for reserved accounts is in Naira
                    let amount = parseFloat(transactionData.amountPaid || transactionData.amount);
                    
                    console.log('Processing credit of amount:', amount);
                    
                    // Get active payment provider from business
                    let paymentProvider = 'monnify'; // Default to monnify since this is a monnify webhook
                    if (wallet.business_id) {
                        const businessRes = await query(`SELECT active_payment_provider FROM businesses WHERE id = $1`, [wallet.business_id]);
                        if (businessRes.rows.length > 0 && businessRes.rows[0].active_payment_provider) {
                            paymentProvider = businessRes.rows[0].active_payment_provider;
                        }
                    }
                    
                    const txnCheck = await query(`SELECT id FROM transactions WHERE reference = $1`, [reference]);
                    
                    if (txnCheck.rows.length === 0) {
              const fee = await calculateFee(amount, 'funding_account');
              const creditAmount = Math.max(0, amount - fee);
              const newBalance = (parseFloat(wallet.balance) || 0) + creditAmount;

              // Credit user wallet first
              await query(`UPDATE wallets SET balance = $1 WHERE id = $2`, [newBalance, wallet.id]);

              // Debit platform wallet for user credit
              const platformWalletRes = await query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
              if (platformWalletRes.rows.length > 0) {
                await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [creditAmount, platformWalletRes.rows[0].id]);
                
                await query(
                  `INSERT INTO transactions 
                   (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                   VALUES ($1, 'NGN', 'success', $2, 'debit', 'Platform Wallet Debit for User Funding', 'wallet_funding', $3, 'debit')`,
                  [creditAmount, `${reference}-USER`, platformWalletRes.rows[0].id]
                );
              }

              // Credit revenue wallet (this will also debit platform wallet for fee)
              if (fee > 0) {
                await creditRevenueWallet(fee, 'NGN', reference);
              }

              await query(
                `INSERT INTO transactions 
                 (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider)
                 VALUES ($1, $2, $3, 'NGN', 'success', $4, 'credit', 'Wallet Funding via Virtual Account', 'wallet_funding', $5, 'credit', $6, $7)`,
                [wallet.business_id, wallet.user_id, amount, reference, wallet.id, fee, paymentProvider]
              );

              // Send in-app notification
              if (wallet.user_id) {
                await createNotification({
                  businessId: wallet.business_id!,
                  userId: wallet.user_id,
                  type: "credit",
                  title: "Wallet Credited",
                  message: `Your wallet has been credited with ₦${creditAmount.toLocaleString()}`,
                  actionUrl: "/wallet",
                  actionType: "view_wallet",
                  metadata: { amount: creditAmount, reference, transactionType: "wallet_funding" },
                  isActionable: false,
                  expiresInHours: 24,
                });
              }

              // Send email notification
              const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [wallet.user_id]);
              if (userRes.rows.length > 0) {
                const user = userRes.rows[0];
                await sendTransactionAlert(
                  user.email,
                  user.name || 'User',
                  'credit',
                  creditAmount,
                  'NGN',
                  newBalance,
                  'success',
                  reference,
                  'Wallet Funding via Virtual Account'
                );
              }
            }
                }
            }
        }
    }

    // Handle single transfer status updates (old event names)
    if (eventType === 'SUCCESSFUL_TRANSFER' || eventType === 'FAILED_TRANSFER') {
        const transferData = event.eventData;
        const reference = transferData.transactionReference || transferData.reference;
        const isSuccess = eventType === 'SUCCESSFUL_TRANSFER';

        // Find transfer in transfer_queue
        const transferRes = await query(`SELECT * FROM transfer_queue WHERE reference = $1`, [reference]);
        
        if (transferRes.rows.length > 0) {
            const transfer = transferRes.rows[0];
            const newStatus = isSuccess ? 'success' : 'failed';
            const failureReason = !isSuccess ? transferData.responseMessage || 'Transfer failed' : null;

            await query(
                `UPDATE transfer_queue 
                 SET status = $1, failure_reason = $2, updated_at = CURRENT_TIMESTAMP, meta_data = $3, provider_metadata = $4
                 WHERE id = $5`,
                [newStatus, failureReason, JSON.stringify(transferData), JSON.stringify(transferData), transfer.id]
            );
        }
    }

    // Handle disbursement (single and bulk) status updates (new event names)
    if (eventType === 'SUCCESSFUL_DISBURSEMENT' || eventType === 'FAILED_DISBURSEMENT' || eventType === 'REVERSED_DISBURSEMENT') {
        const disbursementData = event.eventData;
        
        // Check if it's a bulk disbursement (has transactionList or batchReference)
        if (disbursementData.transactionList && Array.isArray(disbursementData.transactionList)) {
            // Process each transaction in the bulk
            for (const tx of disbursementData.transactionList) {
                const reference = tx.reference;
                const isSuccess = eventType === 'SUCCESSFUL_DISBURSEMENT' && tx.status === 'SUCCESS';
                const isFailed = eventType === 'FAILED_DISBURSEMENT' || tx.status === 'FAILED';
                const isReversed = eventType === 'REVERSED_DISBURSEMENT';

                const transferRes = await query(`SELECT * FROM transfer_queue WHERE reference = $1`, [reference]);
                if (transferRes.rows.length > 0) {
                    const transfer = transferRes.rows[0];
                    let newStatus = 'processing';
                    let failureReason = null;

                    if (isSuccess) {
                        newStatus = 'success';
                    } else if (isFailed) {
                        newStatus = 'failed';
                        failureReason = tx.responseMessage || 'Transfer failed';
                    } else if (isReversed) {
                        newStatus = 'failed'; // Or create a 'reversed' status if needed
                        failureReason = 'Transfer reversed';
                    }

                    await query(
                        `UPDATE transfer_queue 
                         SET status = $1, failure_reason = $2, updated_at = CURRENT_TIMESTAMP, meta_data = $3, provider_metadata = $4
                         WHERE id = $5`,
                        [newStatus, failureReason, JSON.stringify(tx), JSON.stringify(disbursementData), transfer.id]
                    );
                }
            }
        } else {
            // Single disbursement
            const reference = disbursementData.transactionReference || disbursementData.reference;
            const isSuccess = eventType === 'SUCCESSFUL_DISBURSEMENT';
            const isFailed = eventType === 'FAILED_DISBURSEMENT';
            const isReversed = eventType === 'REVERSED_DISBURSEMENT';

            const transferRes = await query(`SELECT * FROM transfer_queue WHERE reference = $1`, [reference]);
            if (transferRes.rows.length > 0) {
                const transfer = transferRes.rows[0];
                let newStatus = 'processing';
                let failureReason = null;

                if (isSuccess) {
                    newStatus = 'success';
                } else if (isFailed) {
                    newStatus = 'failed';
                    failureReason = disbursementData.responseMessage || 'Transfer failed';
                } else if (isReversed) {
                    newStatus = 'failed'; // Or create a 'reversed' status if needed
                    failureReason = 'Transfer reversed';
                }

                await query(
                    `UPDATE transfer_queue 
                     SET status = $1, failure_reason = $2, updated_at = CURRENT_TIMESTAMP, meta_data = $3, provider_metadata = $4
                     WHERE id = $5`,
                    [newStatus, failureReason, JSON.stringify(disbursementData), JSON.stringify(disbursementData), transfer.id]
                );
            }
        }
    }
};

// Webhook Endpoint
router.post("/", async (req, res) => {
    try {
        const squadSignature = req.headers['x-squad-signature'] as string;
        const monnifySignature = req.headers['monnify-signature'] as string;
        
        let providerName = 'squad';
        let isValid = false;
        
        if (squadSignature) {
            const squadProvider = getProvider('squad');
            isValid = squadProvider.verifyWebhook(req.body, squadSignature);
            if (!isValid) {
                console.error("Invalid Squad Signature");
            }
        } else if (monnifySignature) {
            const monnifyProvider = getProvider('monnify');
            isValid = monnifyProvider.verifyWebhook(req.body, monnifySignature);
            providerName = 'monnify';
            if (!isValid) {
                console.error("Invalid Monnify Signature");
            }
        }
        
        const event = req.body;
        console.log(`${providerName} Webhook Received:`, JSON.stringify(event, null, 2));

        // Save to DB
        const eventType = providerName === 'squad' ? event.Event : event.eventType;
        await query(
            `INSERT INTO squad_webhooks (event_type, payload, provider) VALUES ($1, $2, $3)`,
            [eventType, event, providerName]
        );

        if (providerName === 'squad') {
            await handleSquadWebhook(event);
        } else if (providerName === 'monnify') {
            await handleMonnifyWebhook(event);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Webhook processing error:", error);
        res.sendStatus(500);
    }
});

export default router;
