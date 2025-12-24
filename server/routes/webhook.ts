import express from "express";
import { query } from "../db";
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
        // Ideally verify signature here using SQUAD_SECRET_KEY
        // const hash = crypto.createHmac('sha512', process.env.SQUAD_SECRET_KEY!).update(JSON.stringify(req.body)).digest('hex');
        // if (hash !== signature) return res.status(401).send("Invalid signature");

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

                // If token exists, save card
                if (tokenId) {
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

                // Update Transaction
                await query(
                    `UPDATE transactions SET status = 'success', gateway_response = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                    [JSON.stringify(body), transaction.id]
                );
                
                // If this was a subscription payment (not just card validation), update subscription
                if (transaction.transaction_type === 'subscription') {
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
