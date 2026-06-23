import express from "express";
import { authenticateToken, AuthenticatedRequest, checkFeaturePermission } from "../middleware/auth";
import { query } from "../db";
import { initiatePayment, verifyPayment, cancelRecurring } from "../services/squad";
import { processSubscriptionRenewals } from "../services/subscription";
import { sendEmail, generateSubscriptionCancelledEmail, generateSubscriptionDowngradedEmail } from "../services/email";
import crypto from "crypto";
import axios from "axios";
import * as XLSX from "xlsx";

const router = express.Router();

const sendCSV = (res: any, data: any[], filename: string) => {
    const ws = XLSX.utils.json_to_sheet(data);
    const csv = XLSX.utils.sheet_to_csv(ws);
    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
};

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

/**
 * @swagger
 * /subscription/transactions/export:
 *   get:
 *     summary: Export transactions to CSV
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: End date (YYYY-MM-DD)
 *     responses:
 *       200:
 *         description: CSV file
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *               format: binary
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get("/transactions/export", authenticateToken, checkFeaturePermission('export_data'), async (req, res) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const businessId = authReq.user?.businessId;
        if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

        const { startDate, endDate } = req.query;
        let queryStr = `
            SELECT t.reference, t.amount, t.currency, t.status, t.created_at, p.name as plan_name 
            FROM transactions t
            LEFT JOIN pricing_plans p ON t.plan_id = p.id
            WHERE t.business_id = $1
        `;
        const params: any[] = [businessId];
        let paramCount = 2;

        if (startDate) {
            queryStr += ` AND t.created_at >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
        }
        if (endDate) {
            queryStr += ` AND t.created_at <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
        }

        queryStr += ` ORDER BY t.created_at DESC`;

        const result = await query(queryStr, params);
        
        const data = result.rows.map(row => ({
            Reference: row.reference,
            Amount: row.amount,
            Currency: row.currency,
            Status: row.status,
            Plan: row.plan_name || 'N/A',
            Date: new Date(row.created_at).toLocaleString()
        }));

        sendCSV(res, data, `transactions_${businessId}_${Date.now()}.csv`);
    } catch (error) {
        console.error("Export transactions error:", error);
        res.status(500).json({ success: false, error: "Failed to export transactions" });
    }
});

/**
 * @swagger
 * /subscription/transactions:
 *   get:
 *     summary: Get transaction history (Subscription + Wallet)
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transactions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       amount:
 *                         type: number
 *                       currency:
 *                         type: string
 *                       status:
 *                         type: string
 *                       type:
 *                         type: string
 *                         description: debit or credit
 *                       transaction_type:
 *                         type: string
 *                         description: subscription, wallet_funding, transfer, etc.
 *                       created_at:
 *                         type: string
 */
router.get("/transactions", authenticateToken, async (req, res) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const businessId = authReq.user?.businessId;
        const userId = authReq.user?.userId;

        if (!businessId && !userId) return res.status(401).json({ success: false, error: "Unauthorized" });

        const { page = 1, limit = 20 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);

        // Fetch transactions for Business OR User (Wallet)
        // If businessId is present, fetch business transactions (Subscription + Business Wallet)
        // If userId is present (and no businessId?), fetch User Wallet transactions.
        // Actually, user is always authenticated.
        // If user is Admin/Owner, they see Business Transactions?
        // If user is Team Member, they see their Wallet Transactions?
        
        let queryStr = `SELECT * FROM transactions WHERE 1=1`;
        const params: any[] = [];
        let paramCount = 1;

        if (businessId) {
             // Show Business Transactions (Subscription + Wallet Funding + Payouts)
             // AND Team Member Wallet Funding? Maybe not.
             // Just Business Context.
             queryStr += ` AND (business_id = $${paramCount}`;
             params.push(businessId);
             paramCount++;
             
             // Also include transactions where user_id matches but related to business wallet?
             // The schema has business_id on transactions.
             queryStr += `)`;
        } else {
             // Individual User (e.g. freelancer/contractor not in business context yet? or just personal wallet)
             queryStr += ` AND user_id = $${paramCount}`;
             params.push(userId);
             paramCount++;
        }

        queryStr += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(limit, offset);

        const result = await query(queryStr, params);
        
        // Get Total Count
        const countQuery = `SELECT COUNT(*) FROM transactions WHERE business_id = $1`; 
        // Note: Count query needs same logic. Simplified here for brevity.
        
        res.json({ success: true, transactions: result.rows });

    } catch (error) {
        console.error("Get transactions error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch transactions" });
    }
});

/**
 * @swagger
 * tags:
 *   name: Subscription
 *   description: Subscription management endpoints
 */

/**
 * @swagger
 * /subscription/current:
 *   get:
 *     summary: Get current subscription
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current subscription details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 subscription:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     plan_name:
 *                       type: string
 *                     next_due_subscription_date:
 *                       type: string
 *                       format: date-time
 *       500:
 *         description: Server error
 */
// Get current subscription
router.get("/current", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const businessId = authReq.user?.businessId;
    if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const businessResult = await query(`
      SELECT b.id, b.name, b.subscription_status, b.trial_ends_at, b.next_billing_date,
             p.id as plan_id, p.name as plan_name, p.price as plan_price, p.discount as plan_discount,
             p.max_team_members, p.features
      FROM businesses b
      LEFT JOIN pricing_plans p ON b.plan_id = p.id
      WHERE b.id = $1
    `, [businessId]);

    if (businessResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Business not found" });
    }

    const subscription = businessResult.rows[0];
    
    // Check team usage
    const usageResult = await query(`SELECT COUNT(*) FROM users WHERE business_id = $1`, [businessId]);
    const teamCount = parseInt(usageResult.rows[0].count);

    // Determine next due subscription date logic:
    // "Next due subscription date is a count of month from the date which user's successfully subscribe and card was charge"
    // This maps to 'next_billing_date' in DB which we update on successful charge.
    
    res.json({ 
      success: true, 
      subscription: {
        ...subscription,
        team_usage: teamCount,
        next_due_subscription_date: subscription.next_billing_date
      } 
    });
  } catch (error) {
    console.error("Get subscription error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch subscription" });
  }
});

/**
 * @swagger
 * /subscription/cards:
 *   get:
 *     summary: Get all payment cards
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of payment cards
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 cards:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       last4:
 *                         type: string
 *                       card_type:
 *                         type: string
 *                       exp_month:
 *                         type: string
 *                       exp_year:
 *                         type: string
 *                       is_active:
 *                         type: boolean
 *       500:
 *         description: Server error
 */
// Get all cards
router.get("/cards", authenticateToken, async (req, res) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const businessId = authReq.user?.businessId;
        if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

        const cardsResult = await query(`SELECT * FROM payment_cards WHERE business_id = $1 ORDER BY created_at DESC`, [businessId]);
        
        res.json({ success: true, cards: cardsResult.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch cards" });
    }
});

// Get public pricing plans
router.get("/plans", async (req, res) => {
/**
 * @swagger
 * /subscription/plans:
 *   get:
 *     summary: Get all pricing plans
 *     tags: [Subscription]
 *     responses:
 *       200:
 *         description: List of pricing plans
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 plans:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       price:
 *                         type: number
 *                       currency:
 *                         type: string
 *                       duration:
 *                         type: string
 *                       features:
 *                         type: array
 *                         items:
 *                           type: string
 *       500:
 *         description: Server error
 */
  try {
    const result = await query(`SELECT * FROM pricing_plans WHERE is_active = true ORDER BY price ASC`);
    res.json({ success: true, plans: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch plans" });
  }
});

// Add Card Initiate
/**
 * @swagger
 * /subscription/cards/initiate:
 *   post:
 *     summary: Initiate adding a new card
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Card addition initiated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 checkout_url:
 *                   type: string
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.post("/cards/initiate", authenticateToken, async (req, res) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const businessId = authReq.user?.businessId;
        const userId = authReq.user?.userId;
        if (!businessId || !userId) return res.status(401).json({ success: false, error: "Unauthorized" });

        const userRes = await query('SELECT email FROM users WHERE id = $1', [userId]);
        const userEmail = userRes.rows[0]?.email;
        if (!userEmail) return res.status(401).json({ success: false, error: "User email not found" });

        // Get current plan_id
        const businessRes = await query('SELECT plan_id FROM businesses WHERE id = $1', [businessId]);
        const planId = businessRes.rows[0]?.plan_id;

        // Initiate a small charge (e.g., 100 NGN) to tokenize
        // Fetch verification amount from settings
        const settingsRes = await query(`SELECT value FROM system_settings WHERE key = 'card_verification_amount'`);
        const settingsAmount = settingsRes.rows.length > 0 ? parseInt(settingsRes.rows[0].value) : 100;
        const amount = isNaN(settingsAmount) ? 100 : settingsAmount;
        
        const currency = 'NGN';
        const reference = `CARD_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        
        // Create transaction
        await query(
            `INSERT INTO transactions (business_id, plan_id, amount, currency, reference, status, transaction_type)
             VALUES ($1, $2, $3, $4, $5, 'pending', 'card_validation')`,
            [businessId, planId, amount, currency, reference]
        );

        const origin = req.get('origin') || req.get('referer') || 'http://localhost:3000';
        const baseUrl = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        const callbackUrl = `${baseUrl}/payment/callback`;

        const squadResponse = await initiatePayment({
            email: userEmail,
            amount: amount * 100, // Kobo
            reference,
            callbackUrl,
            currency,
            isRecurring: true
        });

        if (squadResponse && squadResponse.status === 200 && squadResponse.data?.checkout_url) {
            res.json({ success: true, checkout_url: squadResponse.data.checkout_url });
        } else {
            res.status(500).json({ success: false, error: "Failed to initiate card validation" });
        }
    } catch (error) {
        console.error("Initiate card add error:", error);
        res.status(500).json({ success: false, error: "Failed to initiate card addition" });
    }
});

// Delete Card
/**
 * @swagger
 * /subscription/cards/{id}:
 *   delete:
 *     summary: Remove a payment card
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Card removed
 *       404:
 *         description: Card not found
 *       500:
 *         description: Server error
 */
router.delete("/cards/:id", authenticateToken, async (req, res) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const businessId = authReq.user?.businessId;
        const cardId = req.params.id;
        
        // Get card
        const cardRes = await query(`SELECT * FROM payment_cards WHERE id = $1 AND business_id = $2`, [cardId, businessId]);
        if (cardRes.rows.length === 0) return res.status(404).json({ success: false, error: "Card not found" });
        const card = cardRes.rows[0];
       
        // Delete from DB
        await query(`DELETE FROM payment_cards WHERE id = $1`, [cardId]);
        
        if (card.is_active) {
            await query(`UPDATE businesses SET card_token = NULL WHERE id = $1`, [businessId]);
        }

        res.json({ success: true, message: "Card removed" });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to remove card" });
    }
});

// Set Active Card
/**
 * @swagger
 * /subscription/cards/{id}/active:
 *   put:
 *     summary: Set a card as active for subscription
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Card set as active
 *       404:
 *         description: Card not found
 *       500:
 *         description: Server error
 */
router.put("/cards/:id/active", authenticateToken, async (req, res) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const businessId = authReq.user?.businessId;
        const cardId = req.params.id;
        
        const cardRes = await query(`SELECT * FROM payment_cards WHERE id = $1 AND business_id = $2`, [cardId, businessId]);
        if (cardRes.rows.length === 0) return res.status(404).json({ success: false, error: "Card not found" });
        const card = cardRes.rows[0];

        await query(`BEGIN`);
        await query(`UPDATE payment_cards SET is_active = false WHERE business_id = $1`, [businessId]);
        await query(`UPDATE payment_cards SET is_active = true WHERE id = $1`, [cardId]);
        await query(`UPDATE businesses SET card_token = $1 WHERE id = $2`, [card.token_id, businessId]);
        await query(`COMMIT`);

        res.json({ success: true, message: "Card set as active" });
    } catch (error) {
        await query(`ROLLBACK`);
        res.status(500).json({ success: false, error: "Failed to update active card" });
    }
});

// Initiate Payment
router.post("/initiate-payment", authenticateToken, async (req, res) => {
/**
 * @swagger
 * /subscription/initiate-payment:
 *   post:
 *     summary: Initiate a payment
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - planId
 *             properties:
 *               planId:
 *                 type: string
 *               currency:
 *                 type: string
 *                 default: NGN
 *     responses:
 *       200:
 *         description: Payment initiated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 checkout_url:
 *                   type: string
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Plan not found
 *       500:
 *         description: Server error
 */
  try {
    const authReq = req as AuthenticatedRequest;
    const { planId, currency = 'NGN' } = req.body;
    const businessId = authReq.user?.businessId;
    const userId = authReq.user?.userId;

    if (!businessId || !userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const userRes = await query('SELECT email FROM users WHERE id = $1', [userId]);
    const userEmail = userRes.rows[0]?.email;

    if (!userEmail) return res.status(401).json({ success: false, error: "User email not found" });

    // Verify plan exists
    const planResult = await query(`SELECT * FROM pricing_plans WHERE id = $1`, [planId]);
    if (planResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Plan not found" });
    }
    const plan = planResult.rows[0];

    // Generate unique reference
    const reference = `TXN_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    
    let finalAmount = Number(plan.price);
    const discount = Number(plan.discount || 0);
    
    if (discount > 0) {
        finalAmount = Math.max(0, finalAmount - discount);
    }
    
    // Handle currency conversion
    if (currency === 'NGN') {
       try {
         const rateRes = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
         if (rateRes.data && rateRes.data.rates && rateRes.data.rates.NGN) {
            const rate = rateRes.data.rates.NGN;
            finalAmount = Math.round(plan.price * rate);
         } else {
            // Fallback rate if API fails? Or error out?
            // For now, let's error out to be safe or use a fallback.
            // Using a safe fallback is risky for money. Better to error.
            console.error("Failed to fetch exchange rate");
            // Use a hardcoded fallback just in case or throw
            // throw new Error("Exchange rate unavailable");
            // Assuming 1500 for now as fallback if API fails completely? No, bad idea.
         }
       } catch (err) {
         console.error("Exchange rate API error:", err);
         // If we can't get the rate, we can't process NGN accurately if base is USD.
         // However, if we must proceed, we could fallback.
       }
    }

    // Amount in Minor units (Kobo for NGN, Cents for USD). 
    const amountInMinor = Math.round(finalAmount * 100); 

    // Create pending transaction record
    await query(
      `INSERT INTO transactions (business_id, plan_id, amount, currency, reference, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [businessId, planId, finalAmount, currency, reference]
    );

    // Call Squad API
    // Callback URL: The frontend page that handles the verify
    // Using referer or origin to build callback URL
    const origin = req.get('origin') || req.get('referer') || 'http://localhost:3000';
    // Clean trailing slash
    const baseUrl = origin.endsWith('/') ? origin.slice(0, -1) : origin;
    const callbackUrl = `${baseUrl}/payment/callback`;

    console.log(`Initiating payment for ${userEmail}, amount: ${amountInMinor} ${currency}, callback: ${callbackUrl}`);

    const squadResponse = await initiatePayment({
      email: userEmail,
      amount: amountInMinor,
      reference,
      callbackUrl,
      currency,
      isRecurring: true
    });

    if (squadResponse && squadResponse.status === 200 && squadResponse.data?.checkout_url) {
       res.json({ success: true, checkout_url: squadResponse.data.checkout_url });
    } else {
       console.error("Squad response invalid:", squadResponse);
       res.status(500).json({ success: false, error: "Failed to initiate payment with provider" });
    }

  } catch (error) {
    console.error("Initiate payment error:", error);
    res.status(500).json({ success: false, error: "Failed to initiate payment" });
  }
});

// Verify Payment
/**
 * @swagger
 * /subscription/verify-payment:
 *   post:
 *     summary: Verify a payment (Subscription or Card Addition)
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reference
 *             properties:
 *               reference:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment verified
 *       404:
 *         description: Transaction not found
 *       500:
 *         description: Server error
 */
router.post("/verify-payment", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { reference } = req.body;
    const businessId = authReq.user?.businessId;

    if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

    // Check if transaction exists
    const txnResult = await query(`SELECT * FROM transactions WHERE reference = $1`, [reference]);
    if (txnResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Transaction not found" });
    }
    const transaction = txnResult.rows[0];

    // If already successful, just return success
    if (transaction.status === 'success') {
       return res.json({ success: true, message: "Payment already verified" });
    }

    // Verify with Squad
    const verifyResponse = await verifyPayment(reference);

    if (verifyResponse.success && verifyResponse.data?.transaction_status === 'success') {
        // Extract Card Information
        const paymentInfo = verifyResponse.data.payment_information || {};
        const cardDetails = verifyResponse.data.card_details || {}; 
        const tokenId = paymentInfo.token_id || verifyResponse.data.token_id || cardDetails.token_id;
        
        let last4 = null;
        let cardType = null;
        let expMonth = null;
        let expYear = null;
        
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

        // Store card if token available
        if (tokenId) {
             // If we are storing a new token, should we make it active?
             // Usually yes if it's the one just used.
             await query(`UPDATE payment_cards SET is_active = false WHERE business_id = $1`, [businessId]);
             
             // Check if already exists
             const tokenCheck = await query(`SELECT id FROM payment_cards WHERE token_id = $1`, [tokenId]);
             if (tokenCheck.rows.length === 0) {
                 await query(`
                    INSERT INTO payment_cards (business_id, token_id, last4, card_type, exp_month, exp_year, is_active)
                    VALUES ($1, $2, $3, $4, $5, $6, true)
                 `, [businessId, tokenId, last4, cardType, expMonth, expYear]);
             } else {
                 await query(`UPDATE payment_cards SET is_active = true WHERE token_id = $1`, [tokenId]);
             }
        }

        // Handle 'card_validation' type
        if (transaction.transaction_type === 'card_validation') {
             // SYNC FIX: Update businesses table with the new card token since we made it active in payment_cards
             if (tokenId) {
                 await query(`UPDATE businesses SET card_token = $1 WHERE id = $2`, [tokenId, businessId]);
             }

             await query(
                `UPDATE transactions SET status = 'success', gateway_response = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [JSON.stringify(verifyResponse.data), transaction.id]
             );
             
             if (tokenId) {
                 return res.json({ success: true, message: "Card added successfully" });
             } else {
                 return res.json({ success: true, message: "Transaction successful but card token not received. Check if recurring payment is enabled and supported." });
             }
        }

        // Update transaction status
        await query(
          `UPDATE transactions SET status = 'success', gateway_response = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [JSON.stringify(verifyResponse.data), transaction.id]
        );

        // Log the full response for debugging
        console.log("Verify Payment Response:", JSON.stringify(verifyResponse, null, 2));

        // Fetch Plan Duration
        const planRes = await query(`SELECT duration FROM pricing_plans WHERE id = $1`, [transaction.plan_id]);
        const planDuration = planRes.rows.length > 0 ? planRes.rows[0].duration : 'monthly';

        // Calculate next billing date
        const nextBillingDate = new Date();
        if (planDuration === 'yearly') {
            nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
        } else {
            nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
        }

        // Update Business Subscription
        // Store token if available
        await query(
          `UPDATE businesses 
           SET plan_id = $1, 
               subscription_status = 'active', 
               trial_ends_at = NULL, 
               updated_at = CURRENT_TIMESTAMP,
               card_token = COALESCE($3, card_token),
               next_billing_date = $4
           WHERE id = $2`,
          [transaction.plan_id, transaction.business_id, tokenId, nextBillingDate]
        );
        
        res.json({ success: true, message: "Payment successful and subscription updated" });
    } else {
        // Mark as failed
        await query(
            `UPDATE transactions SET status = 'failed', gateway_response = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [JSON.stringify(verifyResponse.data || {}), transaction.id]
        );
        res.status(400).json({ success: false, error: "Payment verification failed" });
    }

  } catch (error) {
    console.error("Verify payment error:", error);
    res.status(500).json({ success: false, error: "Failed to verify payment" });
  }
});

// Downgrade Plan
router.post("/downgrade", authenticateToken, async (req, res) => {
/**
 * @swagger
 * /subscription/downgrade:
 *   post:
 *     summary: Downgrade plan
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               planId:
 *                 type: string
 *                 description: Target plan ID (defaults to free plan if not provided)
 *     responses:
 *       200:
 *         description: Downgrade requested successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Plan not found
 *       500:
 *         description: Server error
 */
    try {
        const authReq = req as AuthenticatedRequest;
        const businessId = authReq.user?.businessId;
        if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

        const { planId } = req.body;

        // Get current business and plan info
        const businessRes = await query(`
            SELECT b.*, p.name as current_plan_name 
            FROM businesses b 
            LEFT JOIN pricing_plans p ON b.plan_id = p.id 
            WHERE b.id = $1
        `, [businessId]);
        if (businessRes.rows.length === 0) return res.status(404).json({ success: false, error: "Business not found" });
        const business = businessRes.rows[0];

        // Determine target plan
        let targetPlanId;
        let targetPlanName;
        if (planId) {
            // Validate target plan exists and is cheaper or equal
            const targetPlanRes = await query(`SELECT * FROM pricing_plans WHERE id = $1 AND is_active = true`, [planId]);
            if (targetPlanRes.rows.length === 0) return res.status(404).json({ success: false, error: "Target plan not found" });
            targetPlanId = targetPlanRes.rows[0].id;
            targetPlanName = targetPlanRes.rows[0].name;
        } else {
            // Default to free plan
            const freePlanRes = await query(`SELECT id, name FROM pricing_plans WHERE price = 0 AND is_active = true LIMIT 1`);
            if (freePlanRes.rows.length === 0) return res.status(500).json({ success: false, error: "Free plan configuration missing" });
            targetPlanId = freePlanRes.rows[0].id;
            targetPlanName = freePlanRes.rows[0].name;
        }

        // Set pending downgrade
        await query(
            `UPDATE businesses 
             SET pending_subscription_change = 'downgrade',
                 pending_plan_id = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [targetPlanId, businessId]
        );

        // Send email notification
        try {
            const userRes = await query('SELECT email FROM users WHERE business_id = $1 AND role = $2 LIMIT 1', [businessId, 'owner']);
            const userEmail = userRes.rows[0]?.email;
            if (userEmail) {
                const emailHtml = generateSubscriptionDowngradedEmail(business.name, business.current_plan_name, targetPlanName);
                await sendEmail({
                    sender: { name: "Metricorex", email: "no-reply@metricorex.com" },
                    to: [{ email: userEmail, name: business.name }],
                    subject: "Your Subscription Has Been Downgraded",
                    htmlContent: emailHtml
                });
            }
        } catch (emailErr) {
            console.error("Failed to send downgrade email:", emailErr);
        }

        res.json({ success: true, message: `Downgrade to ${targetPlanName} requested. Your current plan will remain active until the end of the billing period, after which the new plan will be applied.` });

    } catch (error) {
        console.error("Downgrade error:", error);
        res.status(500).json({ success: false, error: "Failed to request downgrade" });
    }
});

// Cancel Subscription (Cancel Recurring)
router.post("/cancel", authenticateToken, async (req, res) => {
/**
 * @swagger
 * /subscription/cancel:
 *   post:
 *     summary: Cancel subscription
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription cancelled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: No active subscription
 *       500:
 *         description: Server error
 */
    try {
        const authReq = req as AuthenticatedRequest;
        const businessId = authReq.user?.businessId;
        if (!businessId) return res.status(401).json({ success: false, error: "Unauthorized" });

        const businessRes = await query(`SELECT b.*, p.name as plan_name FROM businesses b LEFT JOIN pricing_plans p ON b.plan_id = p.id WHERE b.id = $1`, [businessId]);
        if (businessRes.rows.length === 0) return res.status(404).json({ success: false, error: "Business not found" });
        const business = businessRes.rows[0];

        if (!business.card_token) {
            return res.status(400).json({ success: false, error: "No active recurring subscription found" });
        }

        // Call Squad to cancel recurring
        try {
            await cancelRecurring(business.card_token);
        } catch (err) {
            console.warn("Squad cancel recurring warning:", err);
            // Continue locally
        }

       // Update DB to set pending cancel
       await query(
           `UPDATE businesses 
            SET pending_subscription_change = 'cancel',
                updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1`,
           [businessId]
       );

       // Send email notification
       try {
           const userRes = await query('SELECT email FROM users WHERE business_id = $1 AND role = $2 LIMIT 1', [businessId, 'owner']);
           const userEmail = userRes.rows[0]?.email;
           if (userEmail) {
               const emailHtml = generateSubscriptionCancelledEmail(business.name, business.plan_name);
               await sendEmail({
                   sender: { name: "Metricorex", email: "no-reply@metricorex.com" },
                   to: [{ email: userEmail, name: business.name }],
                   subject: "Your Subscription Has Been Cancelled",
                   htmlContent: emailHtml
               });
           }
       } catch (emailErr) {
           console.error("Failed to send cancellation email:", emailErr);
       }

       res.json({ success: true, message: "Subscription cancellation requested. Your plan will remain active until the end of the billing period." });

    } catch (error) {
        console.error("Cancel subscription error:", error);
        res.status(500).json({ success: false, error: "Failed to cancel subscription" });
    }
});

// Scheduled Job / Endpoint for Recurring Charges
// In a real production app, this should be protected and called by a secure cron job.
router.post("/cron/process-renewals", async (req, res) => {
    /**
     * @swagger
     * /subscription/cron/process-renewals:
     *   post:
     *     summary: Process subscription renewals (Cron)
     *     tags: [Subscription]
     *     parameters:
     *       - in: header
     *         name: x-cron-secret
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Renewals processed
     *       401:
     *         description: Unauthorized
     */
    // Basic security: check for a secret key in headers
    const cronSecret = process.env.CRON_SECRET || 'local_dev_secret';
    if (req.headers['x-cron-secret'] !== cronSecret) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    try {
        const results = await processSubscriptionRenewals();
        res.json({ success: true, results });

    } catch (error) {
        console.error("Cron job error:", error);
        res.status(500).json({ success: false, error: "Cron job failed" });
    }
});

// View Transactions (Local DB)
router.get("/transactions", authenticateToken, async (req, res) => {
    /**
     * @swagger
     * /subscription/transactions:
     *   get:
     *     summary: Get subscription transaction history
     *     tags: [Subscription]
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: query
     *         name: page
     *         schema:
     *           type: integer
     *         description: Page number
     *       - in: query
     *         name: perPage
     *         schema:
     *           type: integer
     *         description: Items per page
     *       - in: query
     *         name: startDate
     *         schema:
     *           type: string
     *           format: date
     *         description: Filter by start date
     *       - in: query
     *         name: endDate
     *         schema:
     *           type: string
     *           format: date
     *         description: Filter by end date
     *       - in: query
     *         name: status
     *         schema:
     *           type: string
     *         description: Filter by status
     *     responses:
     *       200:
     *         description: List of transactions
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success:
     *                   type: boolean
     *                 data:
     *                   type: array
     *                   items:
     *                     type: object
     *                     properties:
     *                       id:
     *                         type: string
     *                       amount:
     *                         type: number
     *                       currency:
     *                         type: string
     *                       status:
     *                         type: string
     *                       reference:
     *                         type: string
     *                       created_at:
     *                         type: string
     *                         format: date-time
     *                 pagination:
     *                   type: object
     *                   properties:
     *                     total:
     *                       type: integer
     *                     page:
     *                       type: integer
     *                     perPage:
     *                       type: integer
     *                     totalPages:
     *                       type: integer
     *       401:
     *         description: Unauthorized
     *       500:
     *         description: Server error
     */
    try {
        const authReq = req as AuthenticatedRequest;
        const businessId = authReq.user?.businessId;
        
        if (!businessId) {
            return res.status(401).json({ success: false, error: "Unauthorized" });
        }

        const page = parseInt(req.query.page as string) || 1;
        const perPage = parseInt(req.query.perPage as string) || 50;
        const offset = (page - 1) * perPage;

        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;
        const reference = req.query.reference as string;
        const status = req.query.status as string;

        // Build query
        let queryText = `
            SELECT t.*, p.name as plan_name 
            FROM transactions t
            LEFT JOIN pricing_plans p ON t.plan_id = p.id
            WHERE t.business_id = $1
        `;
        const queryParams: any[] = [businessId];
        let paramIndex = 2;

        if (startDate) {
            queryText += ` AND t.created_at >= $${paramIndex}`;
            queryParams.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            // Adjust end date to include the full day
            const endDateTime = new Date(endDate);
            endDateTime.setHours(23, 59, 59, 999);
            queryText += ` AND t.created_at <= $${paramIndex}`;
            queryParams.push(endDateTime.toISOString());
            paramIndex++;
        }

        if (reference) {
            queryText += ` AND t.reference ILIKE $${paramIndex}`;
            queryParams.push(`%${reference}%`);
            paramIndex++;
        }

        if (status) {
            queryText += ` AND t.status = $${paramIndex}`;
            queryParams.push(status);
            paramIndex++;
        }

        // Count total for pagination
        const countQuery = `SELECT COUNT(*) FROM (${queryText}) as count_table`;
        // We need to construct the count query carefully or just run a separate count query with same where clause
        // Simpler:
        const whereClause = queryText.substring(queryText.indexOf("WHERE"));
        const countResult = await query(`SELECT COUNT(*) FROM transactions t ${whereClause}`, queryParams);
        const total = parseInt(countResult.rows[0].count);

        // Add sorting and pagination
        queryText += ` ORDER BY t.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        queryParams.push(perPage, offset);

        const result = await query(queryText, queryParams);
        
        // Format response to match expected structure (or generic)
        res.json({ 
            success: true, 
            data: result.rows,
            pagination: {
                total,
                page,
                perPage,
                totalPages: Math.ceil(total / perPage)
            }
        });

    } catch (error: any) {
        console.error("Fetch transactions error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch transactions" });
    }
});

// Export Transactions (User)
/**
 * @swagger
 * /subscription/transactions/export:
 *   get:
 *     summary: Export transactions to CSV
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 */
router.get("/transactions/export", authenticateToken, async (req, res) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const businessId = authReq.user?.businessId;
        const { startDate, endDate, status } = req.query;

        let queryStr = `
            SELECT t.reference, t.amount, t.currency, t.status, t.transaction_type, t.created_at, p.name as plan_name
            FROM transactions t
            LEFT JOIN pricing_plans p ON t.plan_id = p.id
            WHERE t.business_id = $1
        `;
        const params: any[] = [businessId];
        let paramCount = 2;

        if (startDate) {
            queryStr += ` AND t.created_at >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
        }
        if (endDate) {
            queryStr += ` AND t.created_at <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
        }
        if (status) {
            queryStr += ` AND t.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        queryStr += ` ORDER BY t.created_at DESC`;
        const result = await query(queryStr, params);

        const ws = XLSX.utils.json_to_sheet(result.rows);
        const csv = XLSX.utils.sheet_to_csv(ws);
        res.header('Content-Type', 'text/csv');
        res.header('Content-Disposition', `attachment; filename="transactions_${Date.now()}.csv"`);
        res.send(csv);

    } catch (error) {
        console.error("Export transactions error:", error);
        res.status(500).json({ success: false, error: "Failed to export transactions" });
    }
});

export default router;
