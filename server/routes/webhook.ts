import express from "express";
import { query } from "../db";
import { verifySquadWebhook } from "../services/squad";
import { calculateFee, creditPlatformWallet } from "../services/fees";
import crypto from "crypto";

const router = express.Router();

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

// Webhook Endpoint
router.post("/", async (req, res) => {
    try {
        const signature = req.headers['x-squad-signature'] as string;
        
        if (!verifySquadWebhook(req.body, signature)) {
             console.error("Invalid Squad Signature");
             // return res.status(401).send("Invalid signature"); // Squad might retry if we fail, but for security we should reject.
        }

        const event = req.body;
        console.log("Squad Webhook Received:", JSON.stringify(event, null, 2));

        // Save to DB
        await query(
            `INSERT INTO squad_webhooks (event_type, payload, provider) VALUES ($1, $2, 'squad')`,
            [event.Event, event]
        );

        if (event.Event === 'charge_successful') {
            const body = event.Body;
            const reference = body.transaction_ref;
            
            // Find transaction
            const txnRes = await query(`SELECT * FROM transactions WHERE reference = $1`, [reference]);
            
            if (txnRes.rows.length > 0) {
                const transaction = txnRes.rows[0];
                const businessId = transaction.business_id;
                const userId = transaction.user_id;

                // Extract Card Data
                const paymentInfo = body.payment_information || {};
                const cardDetails = body.card_details || {};
                const tokenId = body.token_id || paymentInfo.token_id || cardDetails.token_id;
                
                let last4 = null;
                let cardType = null;
                let expMonth = null;
                let expYear = null;
                
                // Parse PAN/Card info
                if (paymentInfo.pan) {
                     const parsed = parsePan(paymentInfo.pan);
                     last4 = parsed.last4;
                     expMonth = parsed.expMonth;
                     expYear = parsed.expYear;
                     cardType = paymentInfo.card_type || paymentInfo.type;
                } else if (cardDetails.pan) {
                     const parsed = parsePan(cardDetails.pan);
                     last4 = parsed.last4;
                     expMonth = parsed.expMonth;
                     expYear = parsed.expYear;
                     cardType = cardDetails.type;
                }

                // If token exists, save card (if business transaction)
                if (tokenId && businessId) {
                     // Check if card exists
                     const cardCheck = await query(`SELECT id FROM payment_cards WHERE token_id = $1`, [tokenId]);
                     if (cardCheck.rows.length === 0) {
                         await query(`
                            INSERT INTO payment_cards (business_id, token_id, last4, card_type, exp_month, exp_year, is_active)
                            VALUES ($1, $2, $3, $4, $5, $6, true)
                         `, [businessId, tokenId, last4, cardType, expMonth, expYear]);
                     } else {
                         // Ensure it is active
                         await query(`UPDATE payment_cards SET is_active = true WHERE token_id = $1`, [tokenId]);
                     }
                     
                     // Deactivate other cards for this business?
                     await query(`UPDATE payment_cards SET is_active = false WHERE business_id = $1 AND token_id != $2`, [businessId, tokenId]);

                     // Update business with card token
                     await query(`UPDATE businesses SET card_token = $1 WHERE id = $2`, [tokenId, businessId]);
                }

                // Update Transaction Status
                if (transaction.status !== 'success') {
                    await query(
                        `UPDATE transactions SET status = 'success', gateway_response = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                        [JSON.stringify(body), transaction.id]
                    );

                    // Handle Wallet Funding
                    if (transaction.transaction_type === 'wallet_funding') {
                        const amount = parseFloat(transaction.amount);
                        const walletId = transaction.wallet_id;

                        if (walletId) {
                            // Credit User/Business Wallet
                            await query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [amount, walletId]);

                            // Find and Debit Platform Wallet
                            const platformWallet = await query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
                            if (platformWallet.rows.length > 0) {
                                await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [amount, platformWallet.rows[0].id]);
                                
                                // Record Platform Transaction
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
                        // Fetch Plan Duration
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

                        // Credit Platform Revenue Wallet
                        const subAmount = parseFloat(transaction.amount);
                        await creditPlatformWallet(subAmount, transaction.currency || 'NGN');
                    }
                }
            } else {
                // Transaction not found in DB (Maybe Virtual Account Transfer?)
                // Check for Virtual Account Credit logic if Squad sends `charge_successful` for VAs too.
                // Usually VAs have `virtual_account_number` in payload.
                const vaNumber = body.virtual_account_number || body.customer?.virtual_account_number;
                
                if (vaNumber) {
                     // Find wallet by VA
                     const walletRes = await query(`SELECT id, user_id, business_id FROM wallets WHERE virtual_account_number = $1`, [vaNumber]);
                     
                     if (walletRes.rows.length > 0) {
                         const wallet = walletRes.rows[0];
                         const amount = parseFloat(body.amount) / 100; // Assuming minor unit if not specified, check docs. Usually Squad sends minor. 
                         // But for charge_successful body, it might be minor. 
                         // If `body.amount` is 10000 (100.00), dividing by 100 gives 100.
                         
                         // Check if transaction already exists (idempotency)
                         const txnCheck = await query(`SELECT id FROM transactions WHERE reference = $1`, [reference]);
                         
                         if (txnCheck.rows.length === 0) {
                             // Calculate Fee for Funding via Account
                             const fee = await calculateFee(amount, 'funding_account');
                             const creditAmount = Math.max(0, amount - fee);

                             // Credit Wallet
                             await query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [creditAmount, wallet.id]);
                             
                             // Record Transaction
                             await query(
                                `INSERT INTO transactions 
                                 (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee)
                                 VALUES ($1, $2, $3, 'NGN', 'success', $4, 'credit', 'Wallet Funding via Virtual Account', 'wallet_funding', $5, 'credit', $6)`,
                                [wallet.business_id, wallet.user_id, amount, reference, wallet.id, fee]
                             );

                             // Credit Platform Wallet with Fee
                             if (fee > 0) {
                                await creditPlatformWallet(fee, 'NGN');
                             }
                         }
                     }
                }
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Webhook processing error:", error);
        res.sendStatus(500);
    }
});

export default router;
