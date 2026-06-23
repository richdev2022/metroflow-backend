import { query } from "../db";
import { getProvider } from "./providers/factory";
import { sendEmail, generateSubscriptionCancelledEmail, generateSubscriptionDowngradedEmail, generateRenewalFailedEmail } from "./email";
import { creditRevenueWallet } from "./fees";
import axios from "axios";

export const processSubscriptionRenewals = async () => {
    console.log("Starting subscription renewal process...");
    
    // First handle pending changes first
    await processPendingChanges();
    
    // Find subscriptions due for renewal
    // We check for active or past_due statuses that are due
    const dueSubscriptions = await query(`
        SELECT b.id as business_id, b.card_token, b.plan_id, b.email, b.name, b.active_payment_provider, p.name as plan_name, p.price, p.currency, p.duration, p.discount
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
                 const emailHtml = generateRenewalFailedEmail(sub.name, sub.plan_name, "No payment method attached");
                 await sendEmail({
                    sender: { name: "Metricorex", email: "no-reply@metricorex.com" },
                    to: [{ email: sub.email, name: sub.name }],
                    subject: "Action Required: Subscription Renewal Failed",
                    htmlContent: emailHtml
                 });
                 
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
            const provider = getProvider(sub.active_payment_provider || 'squad');

            console.log(`Charging business ${sub.business_id} amount ${amountInMinor} via ${sub.active_payment_provider}`);
            const chargeRes = await provider.chargeCard({ 
                amount: amountInMinor, 
                tokenId: sub.card_token, 
                transactionRef: `REC_${Date.now()}_${sub.business_id.substring(0,4)}` 
            });
            
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
                    INSERT INTO transactions (business_id, plan_id, amount, currency, reference, status, gateway_response, transaction_type, payment_provider)
                    VALUES ($1, $2, $3, $4, $5, 'success', $6, 'subscription', $7)
                `, [
                    sub.business_id, 
                    sub.plan_id, 
                    amount, 
                    'NGN', // Assuming we charged in NGN
                    `REC_${Date.now()}_${sub.business_id.substring(0,4)}`,
                    JSON.stringify(chargeRes),
                    sub.active_payment_provider
                ]);

                // Credit Platform Revenue Wallet
                await creditRevenueWallet(amount, 'NGN');

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
                const emailHtml = generateRenewalFailedEmail(sub.name, sub.plan_name, err.message);
                await sendEmail({
                    sender: { name: "Metricorex", email: "no-reply@metricorex.com" },
                    to: [{ email: sub.email, name: sub.name }],
                    subject: "Payment Failed: Subscription Renewal",
                    htmlContent: emailHtml
                });
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

const processPendingChanges = async () => {
    console.log("Processing pending subscription changes...");
    
    // First get free plan ID
    const freePlanRes = await query(`SELECT id FROM pricing_plans WHERE price = 0 LIMIT 1`);
    const freePlanId = freePlanRes.rows[0]?.id;
    
    // Get businesses with pending changes where next_billing_date is <= now
    const pendingChangesRes = await query(`
        SELECT b.id, b.email, b.name, b.pending_subscription_change, b.pending_plan_id, p.name as current_plan_name, p2.name as new_plan_name
        FROM businesses b
        LEFT JOIN pricing_plans p ON b.plan_id = p.id
        LEFT JOIN pricing_plans p2 ON b.pending_plan_id = p2.id
        WHERE b.pending_subscription_change IS NOT NULL
        AND b.next_billing_date <= CURRENT_TIMESTAMP
    `);
    
    for (const business of pendingChangesRes.rows) {
        try {
            if (business.pending_subscription_change === 'cancel') {
                // Cancel subscription
                await query(`
                    UPDATE businesses 
                    SET subscription_status = 'cancelled', 
                        card_token = NULL, 
                        next_billing_date = NULL,
                        pending_subscription_change = NULL,
                        pending_plan_id = NULL,
                        updated_at = CURRENT_TIMESTAMP 
                    WHERE id = $1
                `, [business.id]);
                
                // Send cancellation confirmation email
                const emailHtml = generateSubscriptionCancelledEmail(business.name, business.current_plan_name);
                await sendEmail({
                    sender: { name: "Metricorex", email: "no-reply@metricorex.com" },
                    to: [{ email: business.email, name: business.name }],
                    subject: "Your Subscription Has Been Cancelled",
                    htmlContent: emailHtml
                });
                
            } else if (business.pending_subscription_change === 'downgrade') {
                // Downgrade to pending plan
                const newPlanId = business.pending_plan_id || freePlanId;
                if (newPlanId) {
                    await query(`
                        UPDATE businesses 
                        SET plan_id = $1, 
                            pending_subscription_change = NULL,
                            pending_plan_id = NULL,
                            updated_at = CURRENT_TIMESTAMP 
                        WHERE id = $2
                    `, [newPlanId, business.id]);
                    
                    // Send downgrade confirmation email
                    const emailHtml = generateSubscriptionDowngradedEmail(business.name, business.current_plan_name, business.new_plan_name || "Free");
                    await sendEmail({
                        sender: { name: "Metricorex", email: "no-reply@metricorex.com" },
                        to: [{ email: business.email, name: business.name }],
                        subject: "Your Subscription Has Been Downgraded",
                        htmlContent: emailHtml
                    });
                }
            }
        } catch (err) {
            console.error(`Failed to process pending change for business ${business.id}`, err);
        }
    }
    
    console.log(`Processed ${pendingChangesRes.rows.length} pending changes`);
};
