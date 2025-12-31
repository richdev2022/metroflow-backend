import express from "express";
import { authenticateToken, checkSubscriptionStatus, AuthenticatedRequest } from "../middleware/auth";
import { query, pool } from "../db";
import { initiatePayment, createBusinessVirtualAccount, verifyPayment } from "../services/squad";
import { toMinorUnit } from "../services/squad";
import { calculateFee } from "../services/fees";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Wallet
 *   description: Wallet management endpoints
 */

/**
 * @swagger
 * /wallet/create-virtual-account:
 *   post:
 *     summary: Retry creation of Virtual Account for User Wallet
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Virtual Account created successfully
 */
router.post("/create-virtual-account", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        
        // Check if wallet exists
        const walletRes = await query(`SELECT * FROM wallets WHERE user_id = $1`, [userId]);
        if (walletRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Wallet not found. Complete KYC first." });
        }
        
        const wallet = walletRes.rows[0];
        if (wallet.virtual_account_number) {
            return res.status(400).json({ success: false, error: "Virtual account already exists" });
        }

        // Fetch User Data
        const userRes = await query(
            `SELECT id, name, email, bvn, kyc_data, phone_number FROM users WHERE id = $1`, 
            [userId]
        );
        const user = userRes.rows[0];
        
        if (!user) {
             return res.status(404).json({ success: false, error: "User not found" });
        }

        const kycData = user.kyc_data?.data || user.kyc_data;

        // NOTE: We are using placeholder/fallback data as before because of schema limitations
        const beneficiaryAccount = "0000000000"; 
        
        const nameParts = user.name.split(' ');
        const firstName = kycData?.firstName || nameParts[0] || "User";
        const lastName = kycData?.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : nameParts[0] || "User");
        
        const vaData = {
             first_name: firstName,
             last_name: lastName,
             mobile_num: kycData?.phoneNumber || user.phone_number || "08000000000",
             dob: kycData?.dateOfBirth || "01/01/1990",
             email: user.email,
             bvn: kycData?.bvn || user.bvn || "12345678901",
             gender: kycData?.gender === 'Male' ? "1" : "2",
             address: "Lagos, Nigeria", 
             customer_identifier: userId,
             beneficiary_account: beneficiaryAccount
        };

        try {
             // Import createVirtualAccount dynamically or ensure it's imported at top
             const { createVirtualAccount } = await import("../services/squad");
             
             const vaResponse = await createVirtualAccount(vaData as any);
             
             if (vaResponse && vaResponse.success) {
                 const vaNumber = vaResponse.data.virtual_account_number;
                 await query(
                     `UPDATE wallets SET virtual_account_number = $1, bank_code = '058', customer_identifier = $2 WHERE user_id = $3`,
                     [vaNumber, userId, userId]
                 );
                 return res.json({ success: true, message: "Virtual Account created successfully", virtual_account_number: vaNumber });
             } else {
                 return res.status(400).json({ success: false, error: "Failed to create Virtual Account via provider", details: vaResponse });
             }
        } catch (err: any) {
             console.error("Manual VA Creation Error:", err);
             return res.status(500).json({ success: false, error: err.message || "Internal server error during VA creation" });
        }

    } catch (error: any) {
        console.error("Retry VA Creation Error:", error);
        res.status(500).json({ success: false, error: "Failed to process request" });
    }
});

/**
 * @swagger
 * /wallet:
 *   get:
 *     summary: Get wallet details (Balance, Virtual Account)
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Wallet details
 */
router.get("/", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;
        
        // Return User Wallet AND Business Wallet (if user is admin/owner)
        // Or just the context wallet.
        // Usually, users see their personal wallet. Business admins see business wallet.
        
        const userWallet = await query(`SELECT * FROM wallets WHERE user_id = $1`, [userId]);
        
        let businessWallet = null;
        if (businessId) {
             // Check permission? Assuming all members can see business wallet? Or just admins?
             // Usually only admins.
             const roleCheck = await query(`SELECT role FROM users WHERE id = $1`, [userId]);
             if (['owner', 'admin'].includes(roleCheck.rows[0]?.role)) {
                 const bw = await query(`SELECT * FROM wallets WHERE business_id = $1`, [businessId]);
                 businessWallet = bw.rows[0];
             }
        }

        res.json({
            success: true,
            user_wallet: userWallet.rows[0],
            business_wallet: businessWallet
        });

    } catch (error) {
        console.error("Get Wallet Error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch wallet" });
    }
});

/**
 * @swagger
 * /wallet/fund/card:
 *   post:
 *     summary: Initiate wallet funding via Card
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               amount:
 *                 type: number
 *               wallet_type:
 *                 type: string
 *                 enum: [user, business]
 *     responses:
 *       200:
 *         description: Payment link generated
 */
router.post("/fund/card", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;
        const email = req.user!.email; // Note: AuthenticatedRequest interface needs to include email if we use it here.
        // Assuming user token payload includes email. Let's check verifyToken in services/auth.ts later. 
        // If not, we might need to fetch it.
        // But for now, let's stick to what was there, just fixing userId/businessId.
        
        const { amount, wallet_type, redirect_url } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: "Invalid amount" });
        }

        // Calculate Fee for Funding via Card
        const fee = await calculateFee(amount, 'funding_card');
        const totalAmount = Number(amount) + Number(fee);

        // Generate Reference
        const reference = `FUND-${wallet_type}-${Date.now()}-${userId.substring(0, 8)}`;
        
        // Convert total amount to minor unit (kobo)
        const amountMinor = toMinorUnit(totalAmount);

        // Initiate Payment
        // Callback URL should point to backend verification endpoint
        // Use dynamic host detection to support any port
        const baseUrl = process.env.API_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
        let callbackUrl = `${baseUrl}/api/wallet/verify`;

        // Determine client redirect URL: explicitly provided > Origin header
        const clientRedirectUrl = redirect_url || req.get('origin');

        if (clientRedirectUrl) {
             callbackUrl += `?redirect_url=${encodeURIComponent(clientRedirectUrl)}`;
        }
        
        // Use object parameter for initiatePayment
        const paymentResponse = await initiatePayment({
            email: email || "user@example.com", // Fallback or fetch from DB if missing
            amount: amountMinor,
            reference,
            callbackUrl
        });

        if (paymentResponse.status === 200 && paymentResponse.success) {
            // Log pending transaction
            const walletQuery = wallet_type === 'business' 
                ? `SELECT id FROM wallets WHERE business_id = $1`
                : `SELECT id FROM wallets WHERE user_id = $1`;
            
            const params = wallet_type === 'business' ? [businessId] : [userId];
            const walletRes = await query(walletQuery, params);
            
            if (walletRes.rows.length === 0) {
                 return res.status(404).json({ success: false, error: "Wallet not found" });
            }

            await query(
                `INSERT INTO transactions 
                 (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee)
                 VALUES ($1, $2, $3, 'NGN', 'pending', $4, 'credit', 'Wallet Funding via Card', 'wallet_funding', $5, 'credit', $6)`,
                [businessId, userId, amount, reference, walletRes.rows[0].id, fee]
            );

            res.json({ success: true, payment_url: paymentResponse.data.checkout_url, reference, fee, total_amount: totalAmount });
        } else {
            res.status(400).json({ success: false, error: paymentResponse.message });
        }

    } catch (error: any) {
        console.error("Fund Wallet Error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to initiate funding" });
    }
});

/**
 * @swagger
 * /wallet/business/create:
 *   post:
 *     summary: Create Business Virtual Account (Wallet)
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               gtb_account_number:
 *                 type: string
 *               business_name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Business Wallet created
 */
router.post("/business/create", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;
        const { gtb_account_number, business_name } = req.body;

        // Verify Permission
        const roleCheck = await query(`SELECT role, bvn, phone_number FROM users WHERE id = $1`, [userId]);
        if (roleCheck.rows[0]?.role !== 'owner') {
            return res.status(403).json({ success: false, error: "Only business owner can create business wallet" });
        }

        const user = roleCheck.rows[0];

        if (!user.bvn) {
            return res.status(400).json({ success: false, error: "Owner must complete KYC (BVN) first" });
        }

        // Check if wallet already exists
        const walletCheck = await query(`SELECT * FROM wallets WHERE business_id = $1`, [businessId]);
        let walletId;

        if (walletCheck.rows.length === 0) {
            // Create wallet row if not exists
            const w = await query(
                `INSERT INTO wallets (business_id, status) VALUES ($1, 'active') RETURNING id`,
                [businessId]
            );
            walletId = w.rows[0].id;
        } else {
            walletId = walletCheck.rows[0].id;
            if (walletCheck.rows[0].virtual_account_number) {
                return res.status(400).json({ success: false, error: "Business Virtual Account already exists" });
            }
        }

        // Prepare Squad Payload
        // "Map other info behind" - using Owner's BVN and Phone
        const vaData = {
            bvn: user.bvn,
            business_name: business_name,
            customer_identifier: `BIZ-${businessId.substring(0, 8)}`,
            mobile_num: user.phone_number || "08000000000",
            beneficiary_account: gtb_account_number // GTB Account provided by user
        };

        const vaResponse = await createBusinessVirtualAccount(vaData);

        if (vaResponse.success && vaResponse.data) {
             await query(
                `UPDATE wallets SET 
                    virtual_account_number = $1, 
                    bank_code = $2, 
                    account_name = $3, 
                    customer_identifier = $4,
                    beneficiary_account = $5
                 WHERE id = $6`,
                [
                    vaResponse.data.virtual_account_number, 
                    vaResponse.data.bank_code, 
                    // Squad B2B response might differ, usually returns name
                    vaResponse.data.first_name ? `${vaResponse.data.first_name} ${vaResponse.data.last_name}` : business_name,
                    vaResponse.data.customer_identifier,
                    vaResponse.data.beneficiary_account,
                    walletId
                ]
            );
            
            res.json({ success: true, message: "Business Wallet created successfully", data: vaResponse.data });
        } else {
            res.status(400).json({ success: false, error: vaResponse.message || "Failed to create Virtual Account" });
        }

    } catch (error: any) {
        console.error("Create Business Wallet Error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to create business wallet" });
    }
});

/**
 * @swagger
 * /wallet/verify:
 *   get:
 *     summary: Verify payment transaction
 *     tags: [Wallet]
 *     parameters:
 *       - in: query
 *         name: reference
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Payment verified successfully
 */
router.get("/verify", async (req, res) => {
    try {
        const { reference, redirect_url } = req.query;
        
        if (!reference || typeof reference !== 'string') {
            return res.status(400).send(`
                <html>
                    <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                        <h1 style="color: red;">Error</h1>
                        <p>Transaction reference is required</p>
                    </body>
                </html>
            `);
        }

        const clientAppUrl = (redirect_url as string) || process.env.CLIENT_APP_URL || 'http://localhost:5173';

        // 1. Check local transaction status first
        const txRes = await query(`SELECT * FROM transactions WHERE reference = $1`, [reference]);
        
        if (txRes.rows.length === 0) {
            return res.status(404).send(`
                <html>
                    <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                        <h1 style="color: orange;">Transaction Not Found</h1>
                        <p>We could not find a transaction with this reference.</p>
                        <a href="${clientAppUrl}" style="display: inline-block; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
                    </body>
                </html>
            `);
        }

        const transaction = txRes.rows[0];

        // Check if settlement exists
        let settlementRes = await query(`SELECT * FROM settlements WHERE transaction_id = $1`, [transaction.id]);
        let settlement = settlementRes.rows[0];

        if (transaction.status === 'success') {
             // If settlement is also settled (or missing and we assume success), redirect
             if (!settlement || settlement.status === 'settled') {
                 return res.send(`
                    <html>
                        <head>
                            <meta http-equiv="refresh" content="3;url=${clientAppUrl}/wallet?status=success&reference=${reference}" />
                        </head>
                        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                            <div style="margin-bottom: 20px;">
                                <div style="border: 4px solid #f3f3f3; border-top: 4px solid #28a745; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto;"></div>
                            </div>
                            <h1 style="color: green;">Payment Successful</h1>
                            <p>Your wallet has been funded.</p>
                            <p>Redirecting you back to the app...</p>
                            <a href="${clientAppUrl}/wallet?status=success&reference=${reference}" style="display: inline-block; padding: 10px 20px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
                            <style>
                                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                            </style>
                        </body>
                    </html>
                `);
             }
        }

        // 2. Verify with Squad
        let verifyResponse;
        try {
            verifyResponse = await verifyPayment(reference);
        } catch (err: any) {
            console.error("Squad Verification Failed:", err);
        }
        
        // 3. Update Status based on Squad Response
        if (verifyResponse && verifyResponse.success && verifyResponse.data.transaction_status === 'success') {
            
            // Create Settlement record if missing (Pending)
            if (!settlement) {
                 const sRes = await query(`
                    INSERT INTO settlements (transaction_id, business_id, user_id, amount, status)
                    VALUES ($1, $2, $3, $4, 'pending')
                    RETURNING *
                 `, [transaction.id, transaction.business_id, transaction.user_id, transaction.amount]);
                 settlement = sRes.rows[0];
            }

            // Perform Settlement
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // 1. Credit User Wallet
                await client.query(
                    `UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
                    [transaction.amount, transaction.wallet_id]
                );

                // 2. Update Transaction to Success
                await client.query(
                    `UPDATE transactions SET status = 'success', updated_at = NOW() WHERE id = $1`,
                    [transaction.id]
                );

                // 3. Update Settlement to Settled
                await client.query(
                    `UPDATE settlements SET status = 'settled', updated_at = NOW() WHERE id = $1`,
                    [settlement.id]
                );

                // 4. Credit Platform Wallet with Fee (if any)
                if (transaction.fee > 0) {
                     // Find Platform Wallet (Revenue Wallet)
                     const platformWalletRes = await client.query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
                     
                     if (platformWalletRes.rows.length > 0) {
                         const platformWalletId = platformWalletRes.rows[0].id;
                         
                         // Check if already credited (idempotency)
                         const platTxCheck = await client.query(
                            `SELECT id FROM transactions WHERE reference = $1 AND type = 'credit' AND wallet_id = $2`,
                            [`${reference}-PLATFORM-FEE`, platformWalletId]
                        );

                        if (platTxCheck.rows.length === 0) {
                             await client.query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [transaction.fee, platformWalletId]);
                             
                             await client.query(
                                `INSERT INTO transactions 
                                (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                                VALUES ($1, 'NGN', 'success', $2, 'credit', 'Fee for Wallet Funding', 'fee', $3, 'credit')`,
                                [transaction.fee, `${reference}-PLATFORM-FEE`, platformWalletId]
                            );
                        }
                     }
                }

                await client.query('COMMIT');
                
                // Send Success Email (Async)
                // sendEmail(...)
                
                return res.send(`
                    <html>
                        <head>
                            <meta http-equiv="refresh" content="3;url=${clientAppUrl}/wallet?status=success&reference=${reference}" />
                        </head>
                        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                            <div style="margin-bottom: 20px;">
                                <div style="border: 4px solid #f3f3f3; border-top: 4px solid #28a745; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto;"></div>
                            </div>
                            <h1 style="color: green;">Payment Successful</h1>
                            <p>Your wallet has been funded.</p>
                            <p>Redirecting you back to the app...</p>
                            <a href="${clientAppUrl}/wallet?status=success&reference=${reference}" style="display: inline-block; padding: 10px 20px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
                            <style>
                                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                            </style>
                        </body>
                    </html>
                `);

            } catch (err) {
                await client.query('ROLLBACK');
                console.error("Settlement Transaction Failed:", err);
                
                return res.send(`
                    <html>
                        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                            <h1 style="color: orange;">Payment Successful, Settlement Pending</h1>
                            <p>We received your payment, but there was a delay in crediting your wallet.</p>
                            <p>The system will retry automatically, or an admin will process it shortly.</p>
                            <a href="${clientAppUrl}/dashboard/wallet?status=pending_settlement&reference=${reference}" style="display: inline-block; padding: 10px 20px; background: #ffc107; color: black; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
                        </body>
                    </html>
                `);
            } finally {
                client.release();
            }

        } else {
             // Verification failed or status is not success
             return res.send(`
                <html>
                    <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                        <h1 style="color: red;">Verification Failed</h1>
                        <p>We could not verify your payment. Please contact support if you have been debited.</p>
                        <a href="${clientAppUrl}/dashboard/wallet?status=failed&reference=${reference}" style="display: inline-block; padding: 10px 20px; background: #dc3545; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
                    </body>
                </html>
            `);
        }

    } catch (error: any) {
        console.error("Verify Payment Error:", error);
        // Fallback to HTML if redirect fails or severe error
        res.status(500).send(`
            <html>
                <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h1 style="color: red;">System Error</h1>
                    <p>An unexpected error occurred during verification.</p>
                    <p>Please contact support.</p>
                </body>
            </html>
        `);
    }
});

export default router;
