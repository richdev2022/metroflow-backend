import express from "express";
import { authenticateToken, checkSubscriptionStatus, AuthenticatedRequest, checkKycStatus } from "../middleware/auth";
import { query, pool } from "../db";
import { getProvider, resolveProvider, getActiveProviderName, getAvailableProviders } from "../services/providers/factory";
import { toMinorUnit } from "../services/transfer";
import { calculateFee } from "../services/fees";
import { generateToken } from "../services/auth";
import { getBankNameByCode } from "../utils/bank-codes";

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
 *     summary: Create Personal or Business Virtual Account (will create new account if provider is different)
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - accountType
 *             properties:
 *               accountType:
 *                 type: string
 *                 enum: [Personal, Business]
 *                 description: Type of virtual account to create
 *     responses:
 *       200:
 *         description: Virtual Account created successfully
 */
router.post("/create-virtual-account", authenticateToken, checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;
        const { accountType } = req.body;

        if (!accountType || !['Personal', 'Business'].includes(accountType)) {
            return res.status(400).json({ success: false, error: "Invalid accountType. Must be 'Personal' or 'Business'." });
        }

        let walletRes;
        let wallet;
        let customerIdentifier;
        let vaResponse;
        let isSuccess = false;
        let vaNumber = null;
        let bankCode = '058';
        let accountName;

        const provider = await resolveProvider();

        if (accountType === 'Personal') {
            // Check if user wallet exists
            walletRes = await query(`SELECT * FROM wallets WHERE user_id = $1`, [userId]);
            if (walletRes.rows.length === 0) {
                return res.status(404).json({ success: false, error: "Personal wallet not found. Complete KYC first." });
            }
            wallet = walletRes.rows[0];
            
            // Check if VA already exists for this provider
            const existingVaRes = await query(
                `SELECT * FROM virtual_accounts WHERE wallet_id = $1 AND payment_provider = $2`,
                [wallet.id, provider.name]
            );
            if (existingVaRes.rows.length > 0 && existingVaRes.rows[0].virtual_account_number) {
                return res.status(400).json({ success: false, error: "Personal virtual account already exists for this provider" });
            }
            
            customerIdentifier = userId;

            // Fetch User Data
            const userRes = await query(
                `SELECT id, name, email, bvn, nin, kyc_data, phone_number FROM users WHERE id = $1`, 
                [userId]
            );
            const user = userRes.rows[0];
            if (!user) {
                 return res.status(404).json({ success: false, error: "User not found" });
            }

            const kycData = user.kyc_data?.data || user.kyc_data;
            const nameParts = user.name.split(' ');
            const firstName = kycData?.firstName || nameParts[0] || "User";
            const lastName = kycData?.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : nameParts[0] || "User");
            
            const vaData = {
                 firstName,
                 lastName,
                 phoneNumber: kycData?.phoneNumber || user.phone_number || "08000000000",
                 dob: kycData?.dateOfBirth || "01/01/1990",
                 email: user.email,
                 bvn: kycData?.bvn || user.bvn || "12345678901",
                 nin: kycData?.nin || user.nin || "12345678901",
                 gender: kycData?.gender === 'Male' ? "1" : "2",
                 address: "Lagos, Nigeria", 
                 customerIdentifier,
                 beneficiaryAccount: "0000000000"
            };
            vaResponse = await provider.createVirtualAccount(vaData);

            if (provider.name === 'squad') {
                isSuccess = vaResponse.success;
                vaNumber = vaResponse.data.virtual_account_number;
                accountName = `${vaData.firstName} ${vaData.lastName}`;
            } else if (provider.name === 'flutterwave') {
                isSuccess = vaResponse.status === 'success' && !!vaResponse.data;
                if (isSuccess) {
                    vaNumber = vaResponse.data.account_number;
                    accountName = `${vaData.firstName} ${vaData.lastName}`.trim();
                }
            } else if (provider.name === 'monnify') {
                isSuccess = vaResponse.requestSuccessful;
                const accounts = vaResponse.responseBody?.accounts;
                if (accounts && accounts.length > 0) {
                    vaNumber = accounts[0].accountNumber;
                    bankCode = accounts[0].bankCode;
                    accountName = vaResponse.responseBody.accountName;
                }
            }
        } else if (accountType === 'Business') {
            if (!businessId) {
                return res.status(400).json({ success: false, error: "No business associated with this account." });
            }

            // Check permission
            const roleCheck = await query(`SELECT role FROM users WHERE id = $1`, [userId]);
            if (!['owner', 'admin'].includes(roleCheck.rows[0]?.role)) {
                return res.status(403).json({ success: false, error: "Only owner or admin can create business virtual account." });
            }

            // Check if business wallet exists
            walletRes = await query(`SELECT * FROM wallets WHERE business_id = $1`, [businessId]);
            if (walletRes.rows.length === 0) {
                // Create business wallet if not exists
                const newWallet = await query(
                    `INSERT INTO wallets (business_id, status) VALUES ($1, 'active') RETURNING *`,
                    [businessId]
                );
                wallet = newWallet.rows[0];
            } else {
                wallet = walletRes.rows[0];
            }
            
            // Check if VA already exists for this provider
            const existingVaRes = await query(
                `SELECT * FROM virtual_accounts WHERE wallet_id = $1 AND payment_provider = $2`,
                [wallet.id, provider.name]
            );
            if (existingVaRes.rows.length > 0 && existingVaRes.rows[0].virtual_account_number) {
                return res.status(400).json({ success: false, error: "Business virtual account already exists for this provider" });
            }

            customerIdentifier = `BIZ-${businessId.substring(0, 8)}`;

            // Fetch business data
            const businessRes = await query(
                `SELECT name FROM businesses WHERE id = $1`,
                [businessId]
            );
            const business = businessRes.rows[0];
            if (!business) {
                return res.status(404).json({ success: false, error: "Business not found" });
            }

            // Fetch user data for BVN/NIN
            const userRes = await query(
                `SELECT id, bvn, nin, phone_number FROM users WHERE id = $1`, 
                [userId]
            );
            const user = userRes.rows[0];
            const kycData = user.kyc_data?.data || user.kyc_data;

            const vaData = {
                 bvn: kycData?.bvn || user.bvn || "12345678901",
                 nin: kycData?.nin || user.nin || "12345678901",
                 businessName: business.name,
                 customerIdentifier,
                 phoneNumber: kycData?.phoneNumber || user.phone_number || "08000000000",
                 beneficiaryAccount: "0000000000"
            };
            vaResponse = await provider.createBusinessVirtualAccount(vaData);

            if (provider.name === 'squad') {
                isSuccess = vaResponse.success && vaResponse.data;
                if (isSuccess) {
                    vaNumber = vaResponse.data.virtual_account_number;
                    bankCode = vaResponse.data.bank_code;
                    accountName = vaResponse.data.first_name 
                        ? `${vaResponse.data.first_name} ${vaResponse.data.last_name}` 
                        : business.name;
                }
            } else if (provider.name === 'flutterwave') {
                isSuccess = vaResponse.status === 'success' && !!vaResponse.data;
                if (isSuccess) {
                    vaNumber = vaResponse.data.account_number;
                    accountName = business.name;
                }
            } else if (provider.name === 'monnify') {
                isSuccess = vaResponse.requestSuccessful;
                if (isSuccess) {
                    const accounts = vaResponse.responseBody?.accounts;
                    if (accounts && accounts.length > 0) {
                        vaNumber = accounts[0].accountNumber;
                        bankCode = accounts[0].bankCode;
                        accountName = vaResponse.responseBody.accountName || business.name;
                    }
                }
            }
        }

        if (isSuccess && vaNumber) {
            // Capture the provider-reported bank name/code when available so the
            // wallet endpoint can surface an accurate bank name to clients.
            let resolvedBankCode = bankCode;
            if (provider.name === 'flutterwave' && vaResponse.data?.bank_code) {
                resolvedBankCode = vaResponse.data.bank_code;
            }

            // Check if VA record exists for this provider, update or insert
            const existingVaRes = await query(
                `SELECT * FROM virtual_accounts WHERE wallet_id = $1 AND payment_provider = $2`,
                [wallet.id, provider.name]
            );
            
            if (existingVaRes.rows.length > 0) {
                // Update existing VA
                await query(`
                    UPDATE virtual_accounts 
                    SET virtual_account_number = $1, 
                        bank_code = $2, 
                        account_name = $3, 
                        customer_identifier = $4, 
                        beneficiary_account = $5,
                        provider_metadata = $6,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $7
                `, [vaNumber, resolvedBankCode, accountName, customerIdentifier, "0000000000", JSON.stringify(vaResponse), existingVaRes.rows[0].id]);
            } else {
                // Insert new VA
                await query(`
                    INSERT INTO virtual_accounts 
                    (wallet_id, payment_provider, virtual_account_number, bank_code, account_name, customer_identifier, beneficiary_account, provider_metadata)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [wallet.id, provider.name, vaNumber, resolvedBankCode, accountName, customerIdentifier, "0000000000", JSON.stringify(vaResponse)]);
            }

            return res.json({ 
                success: true, 
                message: `${accountType} Virtual Account created successfully`, 
                virtual_account_number: vaNumber 
            });
        } else {
            const errorMessage = provider.name === 'squad' 
                ? vaResponse.message 
                : vaResponse.responseMessage || "Failed to create Virtual Account via provider";
            return res.status(400).json({ 
                success: false, 
                error: errorMessage, 
                details: vaResponse 
            });
        }
    } catch (error: any) {
        console.error("Create Virtual Account Error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to process request" });
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
router.get("/", authenticateToken, checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;
        const activeProviderName = await getActiveProviderName();
        
        // Function to fetch wallet with virtual accounts
        const getWalletWithVAs = async (walletId: string) => {
            const vas = await query(`SELECT * FROM virtual_accounts WHERE wallet_id = $1`, [walletId]);
            return vas.rows.map(va => {
                // Resolve a human-readable bank name for display. Provider metadata
                // carries the bank name from the provisioning response:
                //  - Flutterwave: data.bank_name
                //  - Monnify:     responseBody.accounts[0].bankName
                //  - Squad:       only bank_code (NIBSS) -> resolved via lookup
                const meta = (va.provider_metadata || {}) as Record<string, any>;
                let bankName: string | null = null;
                if (meta?.data?.bank_name) bankName = meta.data.bank_name;
                else if (meta?.responseBody?.accounts?.[0]?.bankName) bankName = meta.responseBody.accounts[0].bankName;
                else if (meta?.bank_name) bankName = meta.bank_name;
                else if (meta?.bankName) bankName = meta.bankName;
                if (!bankName) bankName = getBankNameByCode(va.bank_code);
                return {
                    ...va,
                    is_active: va.payment_provider === activeProviderName,
                    bank_name: bankName
                };
            });
        };
        
        // Return User Wallet AND Business Wallet (if user is admin/owner)
        // Or just the context wallet.
        // Usually, users see their personal wallet. Business admins see business wallet.
        
        // Function to clean wallet object by removing VA-specific fields
        const cleanWallet = (wallet: any) => {
            const {
                virtual_account_number,
                bank_code,
                account_name,
                customer_identifier,
                beneficiary_account,
                payment_provider,
                provider_metadata,
                ...cleanedWallet
            } = wallet;
            return cleanedWallet;
        };
        
        let userWallet = null;
        const userWalletRes = await query(`SELECT * FROM wallets WHERE user_id = $1`, [userId]);
        if (userWalletRes.rows.length > 0) {
            userWallet = {
                ...cleanWallet(userWalletRes.rows[0]),
                virtual_accounts: await getWalletWithVAs(userWalletRes.rows[0].id)
            };
        }
        
        let businessWallet = null;
        if (businessId) {
             // Check permission? Assuming all members can see business wallet? Or just admins?
             // Usually only admins.
             const roleCheck = await query(`SELECT role FROM users WHERE id = $1`, [userId]);
             if (['owner', 'admin'].includes(roleCheck.rows[0]?.role)) {
                 const bwRes = await query(`SELECT * FROM wallets WHERE business_id = $1`, [businessId]);
                 if (bwRes.rows.length > 0) {
                     businessWallet = {
                         ...cleanWallet(bwRes.rows[0]),
                         virtual_accounts: await getWalletWithVAs(bwRes.rows[0].id)
                     };
                 }
             }
        }

        res.json({
            success: true,
            user_wallet: userWallet,
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
 *             required:
 *               - amount
 *               - wallet_id
 *             properties:
 *               amount:
 *                 type: number
 *               wallet_id:
 *                 type: string
 *               redirect_url:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment link generated
 */
router.post("/fund/card", authenticateToken, checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;
        const email = req.user!.email; // Note: AuthenticatedRequest interface needs to include email if we use it here.
        // Assuming user token payload includes email. Let's check verifyToken in services/auth.ts later. 
        // If not, we might need to fetch it.
        // But for now, let's stick to what was there, just fixing userId/businessId.
        
        const { amount, wallet_id, redirect_url, provider: requestedProvider } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: "Invalid amount" });
        }
        if (!wallet_id) {
            return res.status(400).json({ success: false, error: "wallet_id is required" });
        }

        // Validate requested provider (allows the client to toggle e.g. to Flutterwave)
        if (requestedProvider && !getAvailableProviders().includes(requestedProvider)) {
            return res.status(400).json({ success: false, error: `Unsupported payment provider: ${requestedProvider}` });
        }

        // Check wallet exists and user has access
        const walletRes = await query(`SELECT * FROM wallets WHERE id = $1`, [wallet_id]);
        if (walletRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Wallet not found" });
        }
        const wallet = walletRes.rows[0];
        
        // Verify access to the wallet
        if (wallet.user_id && wallet.user_id !== userId) {
            return res.status(403).json({ success: false, error: "You do not have access to this wallet" });
        }
        if (wallet.business_id && wallet.business_id !== businessId) {
            return res.status(403).json({ success: false, error: "You do not have access to this business wallet" });
        }

        // Calculate Fee for Funding via Card
        const fee = await calculateFee(amount, 'funding_card');
        const totalAmount = Number(amount) + Number(fee);

        // Generate Reference
        const reference = `FUND-${wallet_id.substring(0, 8)}-${Date.now()}-${userId.substring(0, 8)}`;
        
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
        
        const provider = await resolveProvider(requestedProvider);
        
        // Resolve the real user email (token payload does not carry it)
        let userEmail = email || null;
        if (!userEmail) {
            const userRes = await query(`SELECT email FROM users WHERE id = $1`, [userId]);
            userEmail = userRes.rows[0]?.email || null;
        }
        
        // Use object parameter for initiatePayment
        const paymentResponse = await provider.initiatePayment({
            email: userEmail || "customer@metroflow.app",
            amount: amountMinor,
            reference,
            callbackUrl
        });

        let isSuccess = false;
        let paymentUrl = null;
        
        if (provider.name === 'squad') {
            isSuccess = paymentResponse.status === 200 && paymentResponse.success;
            paymentUrl = paymentResponse.data.checkout_url;
        } else if (provider.name === 'flutterwave') {
            isSuccess = !!paymentResponse.success && !!(paymentResponse.data?.checkout_url || paymentResponse.data?.link);
            paymentUrl = paymentResponse.data?.checkout_url || paymentResponse.data?.link;
        } else if (provider.name === 'monnify') {
            isSuccess = paymentResponse.success;
            paymentUrl = paymentResponse.data?.checkout_url;
        }

        if (isSuccess && paymentUrl) {
            await query(
                `INSERT INTO transactions 
                 (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider)
                 VALUES ($1, $2, $3, 'NGN', 'pending', $4, 'credit', 'Wallet Funding via Card', 'wallet_funding', $5, 'credit', $6, $7)`,
                [wallet.business_id, wallet.user_id, amount, reference, wallet.id, fee, provider.name]
            );

            res.json({ success: true, payment_url: paymentUrl, reference, fee, total_amount: totalAmount });
        } else {
            const errorMessage = provider.name === 'squad' 
                ? paymentResponse.message 
                : paymentResponse.message || "Failed to initiate payment";
            res.status(400).json({ success: false, error: errorMessage });
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
router.post("/business/create", authenticateToken, checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;
        const { gtb_account_number, business_name } = req.body;

        // Verify Permission
        const roleCheck = await query(`SELECT role, bvn, nin, phone_number FROM users WHERE id = $1`, [userId]);
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

        const provider = getProvider();
        
        // Prepare provider payload
        const vaData = {
            bvn: user.bvn,
            nin: user.nin || "12345678901", // Monnify requires NIN
            businessName: business_name,
            customerIdentifier: `BIZ-${businessId.substring(0, 8)}`,
            phoneNumber: user.phone_number || "08000000000",
            beneficiaryAccount: gtb_account_number || "0000000000" // GTB Account provided by user (Squad only)
        };

        const vaResponse = await provider.createBusinessVirtualAccount(vaData);

        let isSuccess = false;
        let vaNumber = null;
        let bankCode = '058';
        let accountName = business_name;
        
        if (provider.name === 'squad') {
            isSuccess = vaResponse.success && vaResponse.data;
            if (isSuccess) {
                vaNumber = vaResponse.data.virtual_account_number;
                bankCode = vaResponse.data.bank_code;
                accountName = vaResponse.data.first_name 
                    ? `${vaResponse.data.first_name} ${vaResponse.data.last_name}` 
                    : business_name;
            }
        } else if (provider.name === 'monnify') {
            isSuccess = vaResponse.requestSuccessful;
            if (isSuccess) {
                const accounts = vaResponse.responseBody?.accounts;
                if (accounts && accounts.length > 0) {
                    vaNumber = accounts[0].accountNumber;
                    bankCode = accounts[0].bankCode;
                    accountName = vaResponse.responseBody.accountName || business_name;
                }
            }
        }

        if (isSuccess && vaNumber) {
             await query(
                `UPDATE wallets SET 
                    virtual_account_number = $1, 
                    bank_code = $2, 
                    account_name = $3, 
                    customer_identifier = $4,
                    beneficiary_account = $5,
                    payment_provider = $6
                 WHERE id = $7`,
                [
                    vaNumber, 
                    bankCode, 
                    accountName,
                    `BIZ-${businessId.substring(0, 8)}`,
                    gtb_account_number,
                    provider.name,
                    walletId
                ]
            );
            
            res.json({ success: true, message: "Business Wallet created successfully", data: vaResponse.responseBody || vaResponse.data });
        } else {
            const errorMessage = provider.name === 'squad' 
                ? vaResponse.message 
                : vaResponse.responseMessage || "Failed to create Virtual Account";
            res.status(400).json({ success: false, error: errorMessage });
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
                        <p style="color:#888;">This page does not require a login token.</p>
                    </body>
                </html>
            `);
        }

        const clientAppUrl = (redirect_url as string) || process.env.CLIENT_URL || process.env.CLIENT_APP_URL || process.env.APP_BASE_URL || process.env.APP_URL;
        if (!clientAppUrl) {
            return res.status(500).send(`
                <html>
                    <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                        <h1 style="color: red;">Error</h1>
                        <p>CLIENT_URL environment variable is not set</p>
                    </body>
                </html>
            `);
        }

        // Build the client-facing redirect URL. The client may pass either:
        //  - a bare origin (https://app.example.com)  -> we append /wallet + params
        //  - a specific landing path (https://app.example.com/payment/callback) -> we only append params
        const buildClientRedirect = (status: string, withToken: boolean, token?: string) => {
            let base = clientAppUrl.replace(/\/+$/, "");
            let hasLandingPath = false;
            try {
                const parsed = new URL(clientAppUrl);
                hasLandingPath = parsed.pathname && parsed.pathname !== "/";
            } catch {
                // Not an absolute URL (e.g. relative base) - treat as origin
                hasLandingPath = false;
            }
            if (!hasLandingPath) base += `/wallet`;
            const params = new URLSearchParams({ status, reference });
            if (withToken && token) params.set("token", token);
            return `${base}?${params.toString()}`;
        };

        // 1. Check local transaction status first
        const txRes = await query(`SELECT * FROM transactions WHERE reference = $1`, [reference]);
        
        if (txRes.rows.length === 0) {
            return res.status(404).send(`
                <html>
                    <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                        <h1 style="color: orange;">Transaction Not Found</h1>
                        <p>We could not find a transaction with this reference.</p>
                        <p style="color:#888;">No token is required on this page.</p>
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
                 const token = await generateToken(transaction.user_id, transaction.business_id);
                 const redirectTarget = buildClientRedirect('success', true, token);
                 return res.send(`
                    <html>
                        <head>
                            <meta http-equiv="refresh" content="3;url=${redirectTarget}" />
                        </head>
                        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                            <div style="margin-bottom: 20px;">
                                <div style="border: 4px solid #f3f3f3; border-top: 4px solid #28a745; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto;"></div>
                            </div>
                            <h1 style="color: green;">Payment Successful</h1>
                            <p>Your wallet has been funded.</p>
                            <p>Redirecting you back to the app...</p>
                            <a href="${redirectTarget}" style="display: inline-block; padding: 10px 20px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
                            <style>
                                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                            </style>
                        </body>
                    </html>
                `);
             }
        }

        // 2. Get provider from transaction or use default
        const provider = await resolveProvider(transaction.payment_provider);
        
        // 3. Verify with provider (verification MUST succeed before crediting)
        let verifyResponse;
        try {
            verifyResponse = await provider.verifyPayment(reference);
        } catch (err: any) {
            console.error(`${provider.name} Verification Failed:`, err);
        }
        
        // 4. Update Status based on provider response
        let isSuccess = false;
        if (provider.name === 'squad') {
            isSuccess = verifyResponse && verifyResponse.success && verifyResponse.data.transaction_status === 'success';
        } else if (provider.name === 'flutterwave') {
            // Flutterwave returns data.status === 'successful' for completed charges
            isSuccess = verifyResponse && verifyResponse.success &&
                ['successful', 'success'].includes(verifyResponse.data?.status);
            // Additional sanity check: amount/currency must match the recorded transaction
            if (isSuccess && verifyResponse.data) {
                const verifiedAmount = parseFloat(verifyResponse.data.amount);
                const expectedAmount = parseFloat(transaction.amount) + parseFloat(transaction.fee || 0);
                const verifiedCurrency = verifyResponse.data.currency || 'NGN';
                if (!Number.isNaN(verifiedAmount) && verifiedAmount + 0.01 < expectedAmount) {
                    console.error(`Flutterwave verify amount mismatch for ${reference}: expected >= ${expectedAmount}, got ${verifiedAmount}`);
                    isSuccess = false;
                }
                if (transaction.currency && verifiedCurrency !== transaction.currency) {
                    console.error(`Flutterwave verify currency mismatch for ${reference}: expected ${transaction.currency}, got ${verifiedCurrency}`);
                    isSuccess = false;
                }
            }
        } else if (provider.name === 'monnify') {
            isSuccess = verifyResponse && verifyResponse.success && verifyResponse.data?.paymentStatus === 'PAID';
        }
        
        if (isSuccess) {
            
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
                
                const token = await generateToken(transaction.user_id, transaction.business_id);
                const redirectTarget = buildClientRedirect('success', true, token);
                return res.send(`
                    <html>
                        <head>
                            <meta http-equiv="refresh" content="3;url=${redirectTarget}" />
                        </head>
                        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                            <div style="margin-bottom: 20px;">
                                <div style="border: 4px solid #f3f3f3; border-top: 4px solid #28a745; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto;"></div>
                            </div>
                            <h1 style="color: green;">Payment Successful</h1>
                            <p>Your wallet has been funded.</p>
                            <p>Redirecting you back to the app...</p>
                            <a href="${redirectTarget}" style="display: inline-block; padding: 10px 20px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
                            <style>
                                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                            </style>
                        </body>
                    </html>
                `);

            } catch (err) {
                await client.query('ROLLBACK');
                console.error("Settlement Transaction Failed:", err);
                
                const pendingTarget = buildClientRedirect('pending_settlement', false);
                return res.send(`
                    <html>
                        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                            <h1 style="color: orange;">Payment Successful, Settlement Pending</h1>
                            <p>We received your payment, but there was a delay in crediting your wallet.</p>
                            <p>The system will retry automatically, or an admin will process it shortly.</p>
                            <a href="${pendingTarget}" style="display: inline-block; padding: 10px 20px; background: #ffc107; color: black; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
                        </body>
                    </html>
                `);
            } finally {
                client.release();
            }

        } else {
             // Verification failed or status is not success
             const failedTarget = buildClientRedirect('failed', false);
             return res.send(`
                <html>
                    <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                        <h1 style="color: red;">Verification Failed</h1>
                        <p>We could not verify your payment. Please contact support if you have been debited.</p>
                        <a href="${failedTarget}" style="display: inline-block; padding: 10px 20px; background: #dc3545; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
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
