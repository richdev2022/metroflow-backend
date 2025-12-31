import { query } from "../db";
import { chargeCard } from "./squad";
import { sendEmail } from "./email";
import { creditPlatformWallet } from "./fees";
import axios from "axios";

export const processSubscriptionRenewals = async () => {
    console.log("Starting subscription renewal process...");
    
    // Find subscriptions due for renewal
    // We check for active or past_due statuses that are due
    const dueSubscriptions = await query(`
        SELECT b.id as business_id, b.card_token, b.plan_id, b.email, b.name, p.name as plan_name, p.price, p.currency, p.duration
        FROM businesses b
        JOIN pricing_plans p ON b.plan_id = p.id
        WHERE b.subscription_status IN ('active', 'past_due') 
        AND b.next_billing_date <= CURRENT_TIMESTAMP
        AND (b.is_manual_subscription IS FALSE OR b.is_manual_subscription IS NULL)
    `);

    const results = {
        processed: 0,
        success: 0,
        failed: 0,
        no_card: 0,
        errors: [] as any[]
    };

    for (const sub of dueSubscriptions.rows) {
        results.processed++;
        try {
            // Free plans don't need charging, just renew? 
            // Assuming price > 0 for charge. If price is 0 (Free tier), maybe we just extend?
            // User asked: "If Subscription has expired either Free or Starter or Pro, check if user have active payment method and attempt charge"
            // If Free is 0, we shouldn't charge.
            
            if (parseFloat(sub.price) === 0) {
                // Just extend date for free plan? Or do nothing as they don't expire in the same way?
                // Usually free plans don't have expiry unless trial.
                // Assuming this logic is for paid renewals.
                // If it's a paid plan:
                
                // If price is 0, we can just update the date without charging.
                 const nextDate = new Date();
                 if (sub.duration === 'yearly') {
                    nextDate.setFullYear(nextDate.getFullYear() + 1);
                 } else {
                    nextDate.setMonth(nextDate.getMonth() + 1);
                 }
                 await query(`
                    UPDATE businesses 
                    SET next_billing_date = $1, subscription_status = 'active', updated_at = CURRENT_TIMESTAMP 
                    WHERE id = $2
                `, [nextDate, sub.business_id]);
                results.success++;
                continue;
            }

            // Check if card exists
            if (!sub.card_token) {
                 console.log(`No card for business ${sub.business_id}, sending notification`);
                 results.no_card++;
                 
                 // Send No Payment Method Email
                 await sendEmail(
                     sub.email,
                     sub.name,
                     "Action Required: Subscription Renewal Failed",
                     `<p>Your subscription for ${sub.plan_name} has expired. We could not renew it because no payment method is attached. Please add a card to continue using MetroFlow.</p>`
                 );
                 
                 // Update status to past_due
                 await query(`UPDATE businesses SET subscription_status = 'past_due' WHERE id = $1`, [sub.business_id]);
                 
                 continue;
            }

            // Calculate amount
            let amount = parseFloat(sub.price);
            
            // Handle currency conversion
            if (sub.currency === 'USD') {
                 try {
                    const rateRes = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
                    if (rateRes.data && rateRes.data.rates && rateRes.data.rates.NGN) {
                        amount = amount * rateRes.data.rates.NGN;
                    }
                 } catch (e) {
                     console.error("Rate fetch failed for recurring", e);
                     throw new Error("Currency conversion failed");
                 }
            }

            const amountInMinor = Math.round(amount * 100);

            console.log(`Charging business ${sub.business_id} amount ${amountInMinor}`);
            const chargeRes = await chargeCard(amountInMinor, sub.card_token);
            
            if (chargeRes && chargeRes.success) {
                // Update next billing date (1 month from now)
                const nextDate = new Date();
                if (sub.duration === 'yearly') {
                    nextDate.setFullYear(nextDate.getFullYear() + 1);
                } else {
                    nextDate.setMonth(nextDate.getMonth() + 1);
                }
                
                await query(`
                    UPDATE businesses 
                    SET next_billing_date = $1, subscription_status = 'active', updated_at = CURRENT_TIMESTAMP 
                    WHERE id = $2
                `, [nextDate, sub.business_id]);

                // Log transaction
                await query(`
                    INSERT INTO transactions (business_id, plan_id, amount, currency, reference, status, gateway_response, transaction_type)
                    VALUES ($1, $2, $3, $4, $5, 'success', $6, 'subscription')
                `, [
                    sub.business_id, 
                    sub.plan_id, 
                    amount, 
                    'NGN', // Assuming we charged in NGN
                    `REC_${Date.now()}_${sub.business_id.substring(0,4)}`,
                    JSON.stringify(chargeRes)
                ]);

                // Credit Platform Revenue Wallet
                await creditPlatformWallet(amount, 'NGN');

                results.success++;
            } else {
                throw new Error("Charge failed or declined");
            }

        } catch (err: any) {
            console.error(`Recurring charge failed for business ${sub.business_id}`, err);
            results.failed++;
            results.errors.push({ businessId: sub.business_id, error: err.message });
            
            // Send Payment Failed Email
            try {
                await sendEmail(
                    sub.email,
                    sub.name,
                    "Payment Failed: Subscription Renewal",
                    `<p>We attempted to renew your subscription for ${sub.plan_name} but the payment failed. Please update your payment method to avoid service interruption.</p>`
                );
            } catch (emailErr) {
                console.error("Failed to send failure email", emailErr);
            }

            // Update status to past_due
            await query(`UPDATE businesses SET subscription_status = 'past_due' WHERE id = $1`, [sub.business_id]);
        }
    }

    console.log("Renewal process completed:", results);
    return results;
};
