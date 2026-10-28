import express from "express";
import { query, pool } from "../db";
import { getProvider, resolveProvider } from "../services/providers/factory";
import { calculateFee, creditRevenueWallet, creditPlatformWallet, debitPlatformWallet } from "../services/fees";
import { gateFundingInflow, evaluateInflow } from "../services/fraud";
import { maybePayReferralBonus } from "../services/referral";
import { settlePaymentLinkPayment } from "./payment_links";
import { settleInvoicePayment } from "./invoices";
import { settleStoreOrderPayment } from "./store";
import { settleSubscriptionCharge } from "./recurring";
import crypto from "crypto";
import { sendTransactionAlert } from "../services/email";
import { createNotification } from "../services/notifications";
import { reverseFailedTransfer } from "../services/transfer";
import { checkFundingLimit, rejectOverLimitFunding } from "../services/funding-limits";

const router = express.Router();

/**
 * Flutterwave BILL PAYMENT webhooks — settle pending bill_payments rows.
 *
 * Bills arrive on the generic webhook as either a dedicated bill event
 * (bills.completed / bills.failed / bill.*) or as charge.completed with the
 * bill's tx_ref (our BILL-… reference). Both routes end up here BEFORE the
 * generic charge logic, which would otherwise try (and fail) to verify a
 * bill as a card charge. Outcome is cross-checked against
 * GET /v3/bills/{reference} when the payload status is unclear.
 */
const handleFlutterwaveBillWebhook = async (event: any): Promise<boolean> => {
    const eventType = String(event?.event || "");
    const data = event?.data || {};
    const reference = String(data.tx_ref || data.reference || "");

    const isBillEvent = /^bills?\./i.test(eventType);
    const isBillReference = /^BILL-/i.test(reference);
    if (!isBillEvent && !(eventType === "charge.completed" && isBillReference)) return false;

    if (!reference) {
        console.warn("Flutterwave bill webhook without reference, ignoring");
        return true;
    }

    const billRes = await query(`SELECT * FROM bill_payments WHERE reference = $1 LIMIT 1`, [reference]);
    const bill = billRes.rows[0];
    if (!bill) {
        console.warn(`Flutterwave bill webhook for unknown reference ${reference}`);
        return true;
    }

    // Idempotency — only pending rows are settled here.
    if (bill.status !== "pending") return true;

    let outcome: "success" | "failed" | null = null;
    const payloadStatus = String(data.status || "").toUpperCase();
    if (["SUCCESSFUL", "SUCCESS", "COMPLETED", "DELIVERED"].includes(payloadStatus)) outcome = "success";
    else if (["FAILED", "REJECTED", "REVERSED", "CANCELLED", "CANCELED"].includes(payloadStatus)) outcome = "failed";

    if (!outcome) {
        // Payload status unclear — pull the authoritative bill record.
        try {
            const { getBillPaymentByReference } = await import("../services/flutterwave");
            const remote = await getBillPaymentByReference(reference);
            const remoteStatus = String(remote?.status || "").toUpperCase();
            if (["SUCCESSFUL", "SUCCESS", "COMPLETED", "DELIVERED"].includes(remoteStatus)) outcome = "success";
            else if (["FAILED", "REJECTED", "REVERSED"].includes(remoteStatus)) outcome = "failed";
        } catch (e: any) {
            console.warn(`Bill status pull failed for ${reference}:`, e?.message);
        }
    }
    if (!outcome) return true; // still processing — leave pending

    const total = parseFloat(bill.total);
    await query(
        `UPDATE bill_payments
         SET status = $2, provider_response = $3::jsonb,
             recharge_token = COALESCE($4, recharge_token), updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [bill.id, outcome, JSON.stringify(event), data.recharge_token || null]
    );

    if (outcome === "failed" && bill.wallet_id) {
        await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [total, bill.wallet_id]);
        await query(
            `INSERT INTO transactions
             (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction)
             VALUES ($1, $2, $3, $4, $5, 'success', 'credit', $6, 'bill_refund', $7, 'credit')`,
            [bill.business_id, bill.user_id, total, bill.currency || "NGN", `${bill.reference}-REFUND`,
             `Bill payment refund — ${bill.provider_name} (${bill.customer_ref})`, bill.wallet_id]
        );
    }

    try {
        await createNotification({
            businessId: bill.business_id,
            userId: bill.user_id,
            type: outcome === "success" ? "debit" : "system",
            title: outcome === "success" ? "Bill Payment Successful" : "Bill Payment Failed",
            message: outcome === "success"
                ? `${bill.provider_name} for ${bill.customer_ref} was successful${data.recharge_token ? ` — token: ${data.recharge_token}` : ""}.`
                : `${bill.provider_name} payment failed and your wallet has been refunded.`,
            actionUrl: "/bills",
            actionType: "view_bill",
            metadata: { reference, status: outcome },
            isActionable: false,
            expiresInHours: 72,
        });
    } catch { /* best effort */ }

    return true;
};


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
                    // Handle Payment Links (revenue feature) — settles merchant
                    // wallet net of collection fee; fee → revenue wallet.
                    if (transaction.transaction_type === 'payment_link') {
                        await settlePaymentLinkPayment(reference, 'squad');
                    }

                    // Handle Smart Invoices (revenue feature) — settles merchant
                    // wallet net of settlement fee; fee → revenue wallet.
                    if (transaction.transaction_type === 'invoice') {
                        await settleInvoicePayment(reference, 'squad');
                    }

                    // Handle Storefront orders (revenue feature) — settles merchant
                    // wallet net of order fee; fee → revenue wallet.
                    if (transaction.transaction_type === 'store_order') {
                        await settleStoreOrderPayment(reference, 'squad');
                    }

                    // Handle Recurring Billing charges (revenue feature) — settles
                    // merchant wallet net of subscription fee; fee → revenue wallet.
                    if (transaction.transaction_type === 'subscription') {
                        await settleSubscriptionCharge(reference, 'squad');
                    }

                    // Handle Wallet Funding
                    if (transaction.transaction_type === 'wallet_funding') {
                        const amount = parseFloat(transaction.amount);
                        const walletId = transaction.wallet_id;

                        if (walletId) {
                            // INFLOW LIMIT GATE (Squad checkout): the user has
                            // PAID — if the amount now exceeds the tier
                            // limits, do not credit; fail + auto-refund.
                            const fundingLimit = await checkFundingLimit(
                                {
                                    businessId: transaction.business_id,
                                    userId: transaction.user_id,
                                    ownerKey: transaction.business_id || transaction.user_id,
                                },
                                amount,
                                { currency: String(transaction.currency || 'NGN').toUpperCase() },
                            );
                            if (!fundingLimit.ok) {
                                await rejectOverLimitFunding({
                                    walletId,
                                    businessId: transaction.business_id,
                                    userId: transaction.user_id,
                                    amount,
                                    currency: String(transaction.currency || 'NGN').toUpperCase(),
                                    reference,
                                    provider: 'squad',
                                    source: 'checkout',
                                    gatewayEvent: body,
                                    existingTransactionId: transaction.id,
                                    limitResult: fundingLimit,
                                });
                                return;
                            }

                            // FRAUD GATE (inflow): hold/reject parks the
                            // transaction as 'held' WITHOUT crediting; a
                            // compliance reviewer releases (audited credit)
                            // or rejects it.
                            if (!(await gateFundingInflow({ transaction, provider: 'squad', source: 'checkout' }))) return;

                            await query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [amount, walletId]);

                            const platformWallet = await query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
                            if (platformWallet.rows.length > 0) {
                                await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [amount, platformWallet.rows[0].id]);

                                await query(
                                    `INSERT INTO transactions
                                    (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                                    VALUES ($1, $2, 'success', $3, 'debit', 'User Wallet Funding (Squad)', 'platform', $4, 'debit')`,
                                    [amount, transaction.currency || 'NGN', `${reference}-PLATFORM`, platformWallet.rows[0].id]
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
                        // Revenue-LEDGER row only (wallet_id NULL, transaction_type
                        // 'subscription') — subscriptions must NEVER touch the
                        // platform operational ledger (owner invariant).
                        await creditRevenueWallet(subAmount, transaction.currency || 'NGN', reference, 'Subscription Payment', 'squad', undefined, { revenueType: 'subscription' });
                        // Refer & Earn: first-subscription referral bonus (idempotent, best effort)
                        maybePayReferralBonus(businessId, transaction.plan_id);
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

              // INFLOW LIMIT GATE (Squad virtual account): the sender has
              // already moved money into the VA. Over the tier limit -> do
              // not credit; record the failed funding (Squad has no refund
              // API, so rejectOverLimitFunding flags it for manual refund).
              const fundingLimit = await checkFundingLimit(
                {
                  businessId: wallet.business_id,
                  userId: wallet.user_id,
                  ownerKey: wallet.business_id || wallet.user_id,
                },
                amount,
                { currency: 'NGN' },
              );
              if (!fundingLimit.ok) {
                await rejectOverLimitFunding({
                  walletId: wallet.id,
                  businessId: wallet.business_id,
                  userId: wallet.user_id,
                  amount,
                  currency: 'NGN',
                  reference,
                  provider: 'squad',
                  source: 'virtual_account',
                  gatewayEvent: body,
                  limitResult: fundingLimit,
                });
                return;
              }

              // Credit user wallet — ATOMIC increment (never SET to an
              // absolutely-computed value). The previous
              // `SET balance = $newBalance` lost concurrent increments
              // (webhook-vs-webhook or webhook-vs-debit race): both ledger
              // rows inserted but one credit silently vanished — the exact
              // root cause of user balance drift (e.g. a ₦240 deposit −
              // ₦50 fee = ₦190 that never lands). A single UPDATE with
              // `balance = balance + $1` is atomic under Postgres
              // row-level locking.
              await query(
                `UPDATE wallets SET balance = COALESCE(balance, 0) + $1 WHERE id = $2`,
                [creditAmount, wallet.id],
              );

              // Platform ledger (owner invariant): a funding event produces
              // exactly ONE platform-ledger row — a DEBIT of the amount that
              // lands in the user's wallet. The gross gateway inflow row was
              // noise ("unwanted transaction") and is gone; the fee goes to
              // the REVENUE ledger only.
              await debitPlatformWallet(creditAmount, 'NGN', `${reference}-USER`, 'User Wallet Funding (Virtual Account)', 'squad');
              if (fee > 0) {
                await creditRevenueWallet(fee, 'NGN', reference, undefined, 'squad');
              }

              await query(
                `INSERT INTO transactions 
                 (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider)
                 VALUES ($1, $2, $3, 'NGN', 'success', $4, 'credit', 'Wallet Funding via Virtual Account', 'wallet_funding', $5, 'credit', $6, 'squad')`,
                [wallet.business_id, wallet.user_id, creditAmount, reference, wallet.id, fee]
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
                // Fresh post-credit balance for the alert (the atomic UPDATE
                // above is the source of truth — never reuse a pre-computed
                // value).
                const newBalanceRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [wallet.id]);
                const newBalance = newBalanceRes.rows.length > 0 ? parseFloat(newBalanceRes.rows[0].balance) : null;
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

            // AUTO-REVERSAL: the provider rejected the payout — return the
            // user's money (amount + fee) immediately and unwind holds.
            if (newStatus === 'failed' && transfer.wallet_id) {
                try {
                    await reverseFailedTransfer(transfer, failureReason || 'Squad reported transfer failed');
                } catch (reversalError) {
                    console.error(`Auto-reversal failed for Squad transfer ${reference}:`, reversalError);
                }
            }
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
                    // Handle Payment Links (revenue feature)
                    if (transaction.transaction_type === 'payment_link') {
                        await settlePaymentLinkPayment(reference, 'monnify');
                    }

                    // Handle Smart Invoices (revenue feature)
                    if (transaction.transaction_type === 'invoice') {
                        await settleInvoicePayment(reference, 'monnify');
                    }

                    // Handle Storefront orders (revenue feature)
                    if (transaction.transaction_type === 'store_order') {
                        await settleStoreOrderPayment(reference, 'monnify');
                    }

                    // Handle Recurring Billing charges (revenue feature)
                    if (transaction.transaction_type === 'subscription') {
                        await settleSubscriptionCharge(reference, 'monnify');
                    }

                    // Handle Wallet Funding
                    if (transaction.transaction_type === 'wallet_funding') {
                        const amount = parseFloat(transaction.amount);
                        const walletId = transaction.wallet_id;

                        if (walletId) {
                            // INFLOW LIMIT GATE (Monnify checkout): the user
                            // has PAID — if the amount now exceeds the tier
                            // limits, do not credit; fail + auto-refund.
                            const fundingLimit = await checkFundingLimit(
                                {
                                    businessId: transaction.business_id,
                                    userId: transaction.user_id,
                                    ownerKey: transaction.business_id || transaction.user_id,
                                },
                                amount,
                                { currency: String(transaction.currency || 'NGN').toUpperCase() },
                            );
                            if (!fundingLimit.ok) {
                                await rejectOverLimitFunding({
                                    walletId,
                                    businessId: transaction.business_id,
                                    userId: transaction.user_id,
                                    amount,
                                    currency: String(transaction.currency || 'NGN').toUpperCase(),
                                    reference,
                                    provider: 'monnify',
                                    source: 'checkout',
                                    providerReference: transactionData.transactionReference || null,
                                    gatewayEvent: transactionData,
                                    existingTransactionId: transaction.id,
                                    limitResult: fundingLimit,
                                });
                                return;
                            }

                            // FRAUD GATE (inflow): see Squad checkout note.
                            if (!(await gateFundingInflow({ transaction, provider: 'monnify', source: 'checkout' }))) return;

                            await query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [amount, walletId]);
                            // Owner invariant: funding -> platform ledger DEBITED,
                            // user credited. ONE debit row, no gross-inflow row.
                            await debitPlatformWallet(amount, transaction.currency || 'NGN', `${reference}-PLATFORM`, 'User Wallet Funding (Monnify)', 'monnify');
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
                        // Revenue-LEDGER row only — subscriptions never touch the
                        // platform operational ledger (owner invariant).
                        await creditRevenueWallet(subAmount, transaction.currency || 'NGN', reference, 'Subscription Payment', 'monnify', undefined, { revenueType: 'subscription' });
                        // Refer & Earn: first-subscription referral bonus (idempotent, best effort)
                        maybePayReferralBonus(businessId, transaction.plan_id);
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

              // INFLOW LIMIT GATE (Monnify virtual account): over the tier
              // limit -> do not credit; record failed funding + auto-refund
              // (Monnify supports the refunds API).
              const fundingLimit = await checkFundingLimit(
                {
                  businessId: wallet.business_id,
                  userId: wallet.user_id,
                  ownerKey: wallet.business_id || wallet.user_id,
                },
                amount,
                { currency: 'NGN' },
              );
              if (!fundingLimit.ok) {
                await rejectOverLimitFunding({
                  walletId: wallet.id,
                  businessId: wallet.business_id,
                  userId: wallet.user_id,
                  amount,
                  currency: 'NGN',
                  reference,
                  provider: 'monnify',
                  source: 'virtual_account',
                  providerReference: transactionData.transactionReference || null,
                  gatewayEvent: transactionData,
                  limitResult: fundingLimit,
                });
                return;
              }

              // Credit user wallet — ATOMIC increment (see the Squad path
              // above for the full rationale). Never SET an absolutely
              // computed balance: concurrent webhook processing lost
              // credits while both ledger rows were written (the ₦190-class
              // drift reports).
              await query(
                `UPDATE wallets SET balance = COALESCE(balance, 0) + $1 WHERE id = $2`,
                [creditAmount, wallet.id],
              );

              // Platform ledger (owner invariant): ONE debit row for the user
              // funding; the gross gateway inflow row was noise.
              await debitPlatformWallet(creditAmount, 'NGN', `${reference}-USER`, 'User Wallet Funding (Monnify)', 'monnify');

              // Fee -> revenue ledger only (creditRevenueWallet no longer
              // mirrors revenue movements into the platform pool).
              if (fee > 0) {
                await creditRevenueWallet(fee, 'NGN', reference, undefined, 'monnify');
              }

              await query(
                `INSERT INTO transactions 
                 (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider)
                 VALUES ($1, $2, $3, 'NGN', 'success', $4, 'credit', 'Wallet Funding via Virtual Account', 'wallet_funding', $5, 'credit', $6, $7)`,
                [wallet.business_id, wallet.user_id, creditAmount, reference, wallet.id, fee, paymentProvider]
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
                // Fresh post-credit balance for the alert (the atomic UPDATE
                // above is the source of truth — never reuse a pre-computed
                // value).
                const newBalanceRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [wallet.id]);
                const newBalance = newBalanceRes.rows.length > 0 ? parseFloat(newBalanceRes.rows[0].balance) : null;
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

                    // AUTO-REVERSAL: Monnify FAILED/REVERSED disbursement —
                    // return the user's money (amount + fee) immediately.
                    // REVERSED = provider paid out THEN pulled funds back to the
                    // pool, so the pool ledger must record the inflow.
                    if (newStatus === 'failed' && transfer.wallet_id) {
                        try {
                            await reverseFailedTransfer(transfer, failureReason || 'Monnify reported transfer failed/reversed', { providerReturnedFunds: isReversed });
                        } catch (reversalError) {
                            console.error(`Auto-reversal failed for Monnify transfer ${reference}:`, reversalError);
                        }
                    }
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

                // AUTO-REVERSAL: Monnify FAILED/REVERSED disbursement (single).
                // REVERSED = provider returned funds to the pool.
                if (newStatus === 'failed' && transfer.wallet_id) {
                    try {
                        await reverseFailedTransfer(transfer, failureReason || 'Monnify reported transfer failed/reversed', { providerReturnedFunds: isReversed });
                    } catch (reversalError) {
                        console.error(`Auto-reversal failed for Monnify transfer ${reference}:`, reversalError);
                    }
                }
            }
        }
    }
};

// ---------------------------------------------------------------
// Flutterwave webhook handling (V3)
// Docs: https://developer.flutterwave.com/docs/webhooks
// Events: charge.completed, transfer.completed
// Security: `verif-hash` header must equal FLW_SECRET_HASH.
// Credit rule: transaction verification is ALWAYS run against the
// Flutterwave API before any wallet is credited.
// ---------------------------------------------------------------

const FLW_TRANSFER_SUCCESS_STATUSES = ["SUCCESSFUL"];
const FLW_TRANSFER_PENDING_STATUSES = ["NEW", "PENDING", "QUEUED", "ONGOING", "PROCESSING", "CREATED"];

async function verifyFlutterwaveCharge(reference: string): Promise<any | null> {
    try {
        const provider = getProvider("flutterwave");
        const verifyResponse = await provider.verifyPayment(reference);
        if (verifyResponse?.success && ["successful", "success"].includes(verifyResponse.data?.status)) {
            return verifyResponse.data;
        }
        return null;
    } catch (error: any) {
        console.error(`Flutterwave verification failed for ${reference}:`, error.message);
        return null;
    }
}

// Atomically credit a wallet for a wallet_funding transaction (idempotent).
// Runs transaction + wallet credit + platform fee inside a single DB transaction.
async function creditWalletFundingTransaction(transaction: any, providerName: string) {
    const reference = transaction.reference;

    // FRAUD GATE (inflow): evaluate BEFORE crediting. hold/reject parks the
    // transaction as 'held' (no credit); a compliance reviewer later releases
    // it (audited credit via releaseHeldFunding) or rejects it. Fail-open on
    // engine errors — availability beats false positives.
    if (!(await gateFundingInflow({ transaction, provider: providerName, source: 'charge.completed' }))) {
        return false;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Re-check status inside the transaction (double-processing guard)
        const fresh = await client.query(`SELECT status FROM transactions WHERE id = $1 FOR UPDATE`, [transaction.id]);
        if (fresh.rows[0]?.status === 'success') {
            await client.query('COMMIT');
            return true;
        }

        // 1. Mark transaction successful
        await client.query(
            `UPDATE transactions SET status = 'success', updated_at = NOW() WHERE id = $1`,
            [transaction.id]
        );

        // 2. Create settlement if missing
        const settlementRes = await client.query(`SELECT id, status FROM settlements WHERE transaction_id = $1`, [transaction.id]);
        if (settlementRes.rows.length === 0) {
            await client.query(
                `INSERT INTO settlements (transaction_id, business_id, user_id, amount, status) VALUES ($1, $2, $3, $4, 'settled')`,
                [transaction.id, transaction.business_id, transaction.user_id, transaction.amount]
            );
        } else if (settlementRes.rows[0].status !== 'settled') {
            await client.query(`UPDATE settlements SET status = 'settled', updated_at = NOW() WHERE id = $1`, [settlementRes.rows[0].id]);
        }

        // 3. Credit user wallet
        if (transaction.wallet_id) {
            await client.query(
                `UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
                [transaction.amount, transaction.wallet_id]
            );
        }

        // 4. Funding fee -> REVENUE ledger (owner invariant: deposit fees are
        //    revenue, they must NOT sit in the platform operational ledger).
        const fee = parseFloat(transaction.fee || 0);
        if (fee > 0) {
            try {
                await creditRevenueWallet(fee, 'NGN', reference, 'Wallet Funding Fee', 'flutterwave');
            } catch (feeErr: any) {
                console.warn(`Funding fee revenue credit skipped for ${reference}:`, (feeErr?.message || feeErr).toString().substring(0, 150));
            }
        }

        await client.query('COMMIT');

        // 5. Platform ledger (owner invariant, AFTER COMMIT — the helper uses
        //    the pool while `client` held wallet row locks): a funding event
        //    produces exactly ONE platform-ledger row, a DEBIT of the amount
        //    that landed in the user's wallet. This path previously omitted
        //    the platform side entirely, so Flutterwave/verify-path fundings
        //    left both the platform balance and its ledger untouched while
        //    the startup backfill later added the missing ledger row —
        //    recording a movement the balance never made. Idempotent by
        //    reference; never fails the funding itself.
        try {
            await debitPlatformWallet(
                parseFloat(transaction.amount),
                transaction.currency || 'NGN',
                `${reference}-PLATFORM`,
                `User Wallet Funding (${providerName === 'flutterwave' ? 'Flutterwave' : providerName})`,
                providerName,
            );
        } catch (ledgerErr: any) {
            console.error(`Funding platform ledger debit failed for ${reference}:`, ledgerErr?.message || ledgerErr);
        }

        return true;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`creditWalletFundingTransaction failed for ${reference}:`, error);
        return false;
    } finally {
        client.release();
    }
}

const handleFlutterwaveWebhook = async (event: any) => {
    const eventType = event?.event;
    const data = event?.data || {};

    // ---------- Bill payments (dedicated events + charge.completed bridge) ----------
    if (await handleFlutterwaveBillWebhook(event)) {
        return;
    }

    // ---------- Charge (checkout / card / bank transfer / USSD...) ----------
    if (eventType === 'charge.completed') {
        const reference = data.tx_ref;
        const flwRef = data.flw_ref;
        const isSuccessEvent = data.status === 'successful';

        if (!reference) {
            console.warn('Flutterwave charge.completed without tx_ref, ignoring');
            return;
        }

        // Find local transaction by reference
        const txnRes = await query(`SELECT * FROM transactions WHERE reference = $1`, [reference]);

        if (txnRes.rows.length > 0) {
            const transaction = txnRes.rows[0];
            const businessId = transaction.business_id;

            if (!isSuccessEvent) {
                // Mark failed without crediting
                if (transaction.status !== 'failed') {
                    await query(
                        `UPDATE transactions SET status = 'failed', gateway_response = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                        [JSON.stringify(event), transaction.id]
                    );
                }
                return;
            }

            // SECURITY: run server-to-server transaction verification before crediting
            const verified = await verifyFlutterwaveCharge(reference);
            if (!verified) {
                console.warn(`Flutterwave webhook charge ${reference}: verification failed - wallet NOT credited. Will be re-verified on callback.`);
                await query(
                    `UPDATE transactions SET gateway_response = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                    [JSON.stringify({ ...event, verification: 'pending_webhook_verify_failed' }), transaction.id]
                );
                return;
            }

            // Amount sanity check: verified amount must cover amount + fee
            const verifiedAmount = parseFloat(verified.amount);
            const expectedAmount = parseFloat(transaction.amount) + parseFloat(transaction.fee || 0);
            if (!Number.isNaN(verifiedAmount) && verifiedAmount + 0.01 < expectedAmount) {
                console.error(`Flutterwave webhook amount mismatch for ${reference}: expected >= ${expectedAmount}, verified ${verifiedAmount}`);
                return;
            }

            // Idempotent atomic credit
            // Payment Links settle through their own path (merchant gets net
            // of collection fee; gross must NOT be credited generically).
            if (transaction.transaction_type === 'payment_link') {
                await settlePaymentLinkPayment(reference, 'flutterwave');
                return;
            }
            // Smart Invoices settle through their own path too.
            if (transaction.transaction_type === 'invoice') {
                await settleInvoicePayment(reference, 'flutterwave');
                return;
            }
            // Storefront orders settle through their own path as well.
            if (transaction.transaction_type === 'store_order') {
                await settleStoreOrderPayment(reference, 'flutterwave');
                return;
            }
            // Recurring Billing charges settle through their own path too.
            if (transaction.transaction_type === 'subscription') {
                await settleSubscriptionCharge(reference, 'flutterwave');
                return;
            }
            // INFLOW LIMIT GATE (Flutterwave checkout): the user has PAID —
            // if the amount now exceeds the tier limits, do not credit; fail
            // the funding and auto-refund via Flutterwave's refunds API.
            if (transaction.transaction_type === 'wallet_funding') {
                const fundingLimit = await checkFundingLimit(
                    {
                        businessId: transaction.business_id,
                        userId: transaction.user_id,
                        ownerKey: transaction.business_id || transaction.user_id,
                    },
                    parseFloat(transaction.amount),
                    { currency: String(transaction.currency || 'NGN').toUpperCase() },
                );
                if (!fundingLimit.ok) {
                    await rejectOverLimitFunding({
                        walletId: String(transaction.wallet_id),
                        businessId: transaction.business_id,
                        userId: transaction.user_id,
                        amount: parseFloat(transaction.amount),
                        currency: String(transaction.currency || 'NGN').toUpperCase(),
                        reference,
                        provider: 'flutterwave',
                        source: 'checkout',
                        providerTransactionId: verified.id || data.id || null,
                        gatewayEvent: event,
                        existingTransactionId: transaction.id,
                        limitResult: fundingLimit,
                    });
                    return;
                }
            }
            const credited = await creditWalletFundingTransaction(transaction, 'flutterwave');
            if (credited && transaction.transaction_type === 'wallet_funding') {
                const newBalanceRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [transaction.wallet_id]);
                const newBalance = newBalanceRes.rows.length > 0 ? parseFloat(newBalanceRes.rows[0].balance) : null;

                if (transaction.user_id) {
                    await createNotification({
                        businessId: businessId!,
                        userId: transaction.user_id,
                        type: "credit",
                        title: "Wallet Credited",
                        message: `Your wallet has been credited with ₦${parseFloat(transaction.amount).toLocaleString()}`,
                        actionUrl: "/wallet",
                        actionType: "view_wallet",
                        metadata: { amount: parseFloat(transaction.amount), reference, transactionType: "wallet_funding" },
                        isActionable: false,
                        expiresInHours: 24,
                    }).catch(() => {});
                }

                const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [transaction.user_id]);
                if (userRes.rows.length > 0 && newBalance !== null) {
                    await sendTransactionAlert(
                        userRes.rows[0].email,
                        userRes.rows[0].name || 'User',
                        'credit',
                        parseFloat(transaction.amount),
                        transaction.currency || 'NGN',
                        newBalance,
                        'success',
                        reference,
                        'Wallet Funding via Flutterwave Checkout'
                    ).catch(() => {});
                }
            }

            // Subscription handling (verify first, same rule)
            if (credited && transaction.transaction_type === 'subscription' && businessId) {
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
                await creditRevenueWallet(subAmount, transaction.currency || 'NGN', reference, 'Subscription Payment', 'flutterwave', undefined, { revenueType: 'subscription' });
                // Refer & Earn: first-subscription referral bonus (idempotent, best effort)
                maybePayReferralBonus(businessId, transaction.plan_id);
            }

            return;
        }

        // ---------- Virtual Account funding (no matching local transaction) ----------
        // Flutterwave static VA payments carry the tx_ref assigned at VA creation
        // (stored in virtual_accounts.provider_metadata.va_tx_ref).
        const vaTxRef = data.tx_ref;
        let wallet: any = null;
        let vaRecord: any = null;

        // 1. Look up by VA tx_ref in provider metadata (nested data.va_tx_ref or flat va_tx_ref)
        const vaRowsResult = await query(
            `SELECT * FROM virtual_accounts 
             WHERE payment_provider = 'flutterwave' 
             AND (provider_metadata->'data'->>'va_tx_ref' = $1 
                  OR provider_metadata->>'va_tx_ref' = $1
                  OR provider_metadata::text LIKE $2)
             LIMIT 1`,
            [vaTxRef, `%"${vaTxRef}"%`]
        );
        let vaRows = vaRowsResult.rows;
        // 2. Fallback: flutterwave VAs store the account number; webhook may include it
        if (vaRows.length === 0 && (data.account_number || data.virtual_account_number)) {
            const vaByNumber = await query(
                `SELECT * FROM virtual_accounts WHERE virtual_account_number = $1 AND payment_provider = 'flutterwave' LIMIT 1`,
                [data.account_number || data.virtual_account_number]
            );
            vaRows = vaByNumber.rows;
        }
        // 3. Fallback: customer email -> user wallet
        if (vaRows.length === 0 && data.customer?.email) {
            const userRes = await query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [data.customer.email]);
            if (userRes.rows.length > 0) {
                const walletRes = await query(`SELECT * FROM wallets WHERE user_id = $1 LIMIT 1`, [userRes.rows[0].id]);
                if (walletRes.rows.length > 0) {
                    wallet = walletRes.rows[0];
                }
            }
        }

        if (!wallet && vaRows.length > 0) {
            vaRecord = vaRows[0];
            const walletRes = await query(`SELECT * FROM wallets WHERE id = $1`, [vaRecord.wallet_id]);
            if (walletRes.rows.length > 0) {
                wallet = walletRes.rows[0];
            }
        }

        if (!wallet || !isSuccessEvent) {
            console.warn(`Flutterwave VA funding could not be attributed (tx_ref=${vaTxRef}, status=${data.status})`);
            return;
        }

        // SECURITY: verify the VA payment via the API before crediting
        const verified = await verifyFlutterwaveCharge(vaTxRef);
        if (!verified) {
            console.warn(`Flutterwave VA funding ${vaTxRef}: verification failed - wallet NOT credited`);
            return;
        }

        // Idempotency: use the unique Flutterwave transaction id as reference
        const creditReference = `FLW-VA-${verified.id || data.id}`;
        const txnCheck = await query(`SELECT id FROM transactions WHERE reference = $1`, [creditReference]);
        if (txnCheck.rows.length > 0) {
            console.log(`Flutterwave VA funding ${creditReference} already processed, skipping`);
            return;
        }

        const amount = parseFloat(verified.amount || data.amount);
        if (Number.isNaN(amount) || amount <= 0) {
            console.error(`Flutterwave VA funding ${vaTxRef}: invalid amount`, verified.amount);
            return;
        }

        const fee = await calculateFee(amount, 'funding_account');
        const creditAmount = Math.max(0, amount - fee);

        // INFLOW LIMIT GATE (Flutterwave virtual account): over the tier
        // limit -> do not credit; record the failed funding + auto-refund
        // via the Flutterwave refunds API.
        {
            const fundingLimit = await checkFundingLimit(
                {
                    businessId: wallet.business_id,
                    userId: wallet.user_id,
                    ownerKey: wallet.business_id || wallet.user_id,
                },
                amount,
                { currency: 'NGN' },
            );
            if (!fundingLimit.ok) {
                await rejectOverLimitFunding({
                    walletId: wallet.id,
                    businessId: wallet.business_id,
                    userId: wallet.user_id,
                    amount,
                    currency: 'NGN',
                    reference: creditReference,
                    provider: 'flutterwave',
                    source: 'virtual_account',
                    providerTransactionId: verified.id || data.id || null,
                    gatewayEvent: event,
                    limitResult: fundingLimit,
                });
                return;
            }
        }

        // FRAUD GATE (inflow, Flutterwave virtual account): decide BEFORE the
        // credit. hold/reject inserts the transaction row as 'held' WITHOUT
        // crediting; a compliance reviewer releases (audited credit via
        // releaseHeldFunding) or rejects it later.
        let vaFraudDecision: string = 'allow';
        try {
            const vaFraud = await evaluateInflow({
                flow: 'funding',
                userId: wallet.user_id || null,
                businessId: wallet.business_id || null,
                walletId: wallet.id,
                amount: creditAmount,
                currency: 'NGN',
                reference: creditReference,
                channel: 'flutterwave:virtual_account',
            });
            vaFraudDecision = vaFraud.decision;
        } catch (e: any) {
            console.error('[fraud] VA inflow gate crashed (fail-open):', e?.message);
        }
        const vaInitialStatus = (vaFraudDecision === 'hold' || vaFraudDecision === 'reject') ? 'held' : 'success';

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (vaInitialStatus === 'success') {
                await client.query(
                    `UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
                    [creditAmount, wallet.id]
                );
            }
            await client.query(
                `INSERT INTO transactions
                 (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider, gateway_response)
                 VALUES ($1, $2, $3, 'NGN', $8, $4, 'credit', 'Wallet Funding via Flutterwave Virtual Account', 'wallet_funding', $5, 'credit', $6, 'flutterwave', $7)`,
                [wallet.business_id, wallet.user_id, creditAmount, creditReference, wallet.id, fee, JSON.stringify(event), vaInitialStatus]
            );
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`Flutterwave VA credit failed for ${creditReference}:`, error);
            return;
        } finally {
            client.release();
        }

        if (vaInitialStatus !== 'success') {
            console.log(`[fraud] VA funding ${creditReference} parked as ${vaInitialStatus} (${vaFraudDecision})`);
            return;
        }

        // Platform ledger (owner invariant): ONE debit row for the amount that
        // lands in the user's wallet; the fee goes to the REVENUE ledger.
        await debitPlatformWallet(creditAmount, 'NGN', `${creditReference}-USER`, 'User Wallet Funding (Flutterwave)', 'flutterwave').catch(() => {});

        if (fee > 0) {
            await creditRevenueWallet(fee, 'NGN', creditReference, undefined, 'flutterwave').catch(() => {});
        }

        // Notify the wallet owner
        if (wallet.user_id) {
            await createNotification({
                businessId: wallet.business_id!,
                userId: wallet.user_id,
                type: "credit",
                title: "Wallet Credited",
                message: `Your wallet has been credited with ₦${creditAmount.toLocaleString()}`,
                actionUrl: "/wallet",
                actionType: "view_wallet",
                metadata: { amount: creditAmount, reference: creditReference, transactionType: "wallet_funding" },
                isActionable: false,
                expiresInHours: 24,
            }).catch(() => {});
        }

        const userRes = await query(`SELECT email, name FROM users WHERE id = $1`, [wallet.user_id]);
        if (userRes.rows.length > 0) {
            const balanceRes = await query(`SELECT balance FROM wallets WHERE id = $1`, [wallet.id]);
            await sendTransactionAlert(
                userRes.rows[0].email,
                userRes.rows[0].name || 'User',
                'credit',
                creditAmount,
                'NGN',
                parseFloat(balanceRes.rows[0]?.balance || 0),
                'success',
                creditReference,
                'Wallet Funding via Flutterwave Virtual Account'
            ).catch(() => {});
        }

        return;
    }

    // ---------- Transfers (single + bulk items) ----------
    if (eventType === 'transfer.completed') {
        const transferData = data;
        const reference = transferData.reference;
        const payloadStatus = (transferData.status || '').toUpperCase();

        if (!reference) {
            console.warn('Flutterwave transfer.completed without reference, ignoring');
            return;
        }

        const transferRes = await query(`SELECT * FROM transfer_queue WHERE reference = $1`, [reference]);

        if (transferRes.rows.length === 0) {
            console.warn(`Flutterwave transfer.completed for unknown reference ${reference}`);
            return;
        }

        const transfer = transferRes.rows[0];

        // Double confirmation (same principle as wallet funding): re-verify the
        // transfer via the Flutterwave API before trusting the webhook payload.
        // Docs best practice: use the API as the source of truth for fulfilment.
        let status = payloadStatus;
        try {
            const provider = getProvider('flutterwave');
            const verifyResponse = await provider.verifyTransfer(reference, {
                data: { id: transferData.id },
            });
            const verified = verifyResponse?.data || verifyResponse;
            if (verified?.status) {
                status = String(verified.status).toUpperCase();
                console.log(`Flutterwave transfer ${reference} verified via API: ${status}`);
            }
        } catch (verifyError: any) {
            // Verification call failed - fall back to the (hash-validated) payload
            console.warn(`Flutterwave transfer re-verification failed for ${reference}, using payload status:`,
                verifyError?.message || verifyError);
        }

        let newStatus: 'success' | 'failed' | 'processing' = 'processing';
        let failureReason: string | null = null;

        if (FLW_TRANSFER_SUCCESS_STATUSES.includes(status)) {
            newStatus = 'success';
        } else if (["FAILED", "REVERTED", "CANCELED", "CANCELLED"].includes(status)) {
            newStatus = 'failed';
            failureReason = transferData.complete_message || 'Transfer failed at Flutterwave';
        }

        await query(
            `UPDATE transfer_queue 
             SET status = $1, failure_reason = $2, updated_at = CURRENT_TIMESTAMP, meta_data = $3, provider_metadata = $4
             WHERE id = $5`,
            [newStatus, failureReason, JSON.stringify(event), JSON.stringify(transferData), transfer.id]
        );

        // AUTO-REVERSAL: Flutterwave FAILED/REVERTED/CANCELED transfer —
        // return the user's money (amount + fee) immediately.
        if (newStatus === 'failed' && transfer.wallet_id) {
            try {
                await reverseFailedTransfer(transfer, failureReason || 'Flutterwave reported transfer failed/reverted');
            } catch (reversalError) {
                console.error(`Auto-reversal failed for Flutterwave transfer ${reference}:`, reversalError);
            }
        }
    }
};

// Webhook Endpoint
router.post("/", async (req, res) => {
    try {
        const squadSignature = req.headers['x-squad-signature'] as string;
        const monnifySignature = req.headers['monnify-signature'] as string;
        const flutterwaveSignature = (req.headers['verif-hash'] || req.headers['x-fw-signature']) as string;

        let providerName: 'squad' | 'monnify' | 'flutterwave';

        if (flutterwaveSignature) {
            // Flutterwave: `verif-hash` header must match FLW_SECRET_HASH exactly
            providerName = 'flutterwave';
            const flwProvider = getProvider('flutterwave');
            if (!flwProvider.verifyWebhook(req.body, flutterwaveSignature)) {
                console.error("Invalid Flutterwave webhook signature - rejecting");
                return res.status(401).send('Invalid signature');
            }
        } else if (squadSignature) {
            providerName = 'squad';
            const squadProvider = getProvider('squad');
            if (!squadProvider.verifyWebhook(req.body, squadSignature)) {
                // SECURITY: an invalid signature must never be processed.
                // (Previously this only logged and continued.)
                console.error("Invalid Squad webhook signature - rejecting");
                return res.status(401).send('Invalid signature');
            }
        } else if (monnifySignature) {
            providerName = 'monnify';
            const monnifyProvider = getProvider('monnify');
            if (!monnifyProvider.verifyWebhook(req.body, monnifySignature)) {
                console.error("Invalid Monnify webhook signature - rejecting");
                return res.status(401).send('Invalid signature');
            }
        } else {
            // No provider signature header at all - internet scanner or forged
            // request. Previously these fell through and were processed as
            // Squad webhooks with zero validation.
            console.warn("Webhook rejected: no provider signature header present");
            return res.status(401).send('Missing signature');
        }
        
        const event = req.body;

        // Save to DB
        const eventType = providerName === 'squad' ? event.Event : (providerName === 'flutterwave' ? event.event : event.eventType);

        // Compact single-line log (full payload is persisted in squad_webhooks)
        const flwRef = event?.data?.tx_ref || event?.data?.reference;
        console.log(`${providerName} webhook: ${eventType || 'unknown'} | ref: ${flwRef || 'n/a'} | status: ${event?.data?.status || 'n/a'}`);

        await query(
            `INSERT INTO squad_webhooks (event_type, payload, provider) VALUES ($1, $2, $3)`,
            [eventType, event, providerName]
        );

        if (providerName === 'squad') {
            await handleSquadWebhook(event);
        } else if (providerName === 'monnify') {
            await handleMonnifyWebhook(event);
        } else if (providerName === 'flutterwave') {
            await handleFlutterwaveWebhook(event);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Webhook processing error:", error);
        res.sendStatus(500);
    }
});

export default router;
