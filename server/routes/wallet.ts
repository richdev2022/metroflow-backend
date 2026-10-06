import express from "express";
import { authenticateToken, checkSubscriptionStatus, AuthenticatedRequest, checkKycStatus } from "../middleware/auth";
import { requireTeamPermission } from "../middleware/teamAuth";
import { query, pool } from "../db";
import { getProvider, resolveProvider, getActiveProviderName, getAvailableProviders } from "../services/providers/factory";
import { toMinorUnit } from "../services/transfer";
import { calculateFee, creditPlatformWallet, debitPlatformWallet, creditRevenueWallet } from "../services/fees";
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
router.post("/create-virtual-account", authenticateToken, checkKycStatus, requireTeamPermission("manage_finance"), async (req: AuthenticatedRequest, res) => {
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
        // Invited members must NEVER see the business wallet — only the
        // business owner and admins do. The flag also lets the web/mobile
        // clients decide whether to render the business wallet card (and the
        // "Create VA" affordance for owners before the wallet exists).
        let canManageBusinessWallet = false;
        if (businessId) {
             const roleCheck = await query(`SELECT role FROM users WHERE id = $1`, [userId]);
             canManageBusinessWallet = ['owner', 'admin'].includes(roleCheck.rows[0]?.role);
             if (canManageBusinessWallet) {
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
            business_wallet: businessWallet,
            canManageBusinessWallet
        });

    } catch (error) {
        console.error("Get Wallet Error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch wallet" });
    }
});

/**
 * @swagger
 * /wallet/history:
 *   get:
 *     summary: Paginated wallet transaction history with filters and CSV export
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: wallet_id
 *         schema: { type: string }
 *         description: Filter by specific wallet
 *       - in: query
 *         name: direction
 *         schema: { type: string, enum: [credit, debit] }
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *         description: Transaction type filter (wallet_funding, transfer, fee, adjustment, platform)
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search reference / description / transaction ID
 *       - in: query
 *         name: min_amount / max_amount / start_date / end_date
 *         schema: { type: string }
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [json, csv] }
 *     responses:
 *       200:
 *         description: Transaction history
 */
router.get("/history", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;
        const {
            wallet_id, direction, type, search,
            min_amount, max_amount, start_date, end_date,
            page = "1", limit = "20", format = "json",
        } = req.query as Record<string, string>;

        // Resolve the wallets visible to this user: personal wallet + business wallet (admins/owner)
        const roleRes = await query(`SELECT role FROM users WHERE id = $1`, [userId]);
        const role = roleRes.rows[0]?.role;
        const walletParams: any[] = [userId];
        let walletSql = `SELECT id, currency, balance FROM wallets WHERE user_id = $1`;
        if (['owner', 'admin'].includes(role) && businessId) {
            walletSql += ` OR business_id = $2`;
            walletParams.push(businessId);
        }
        const walletsRes = await query(walletSql, walletParams);
        const walletIds = walletsRes.rows.map((w: any) => w.id);
        if (walletIds.length === 0) {
            return res.json({ success: true, data: [], wallets: [], pagination: { total: 0, page: 1, limit: Number(limit), totalPages: 0 } });
        }

        const params: any[] = [];
        let sql = `SELECT t.*, w.currency AS wallet_currency, w.balance AS wallet_balance
                   FROM transactions t
                   LEFT JOIN wallets w ON w.id = t.wallet_id
                   WHERE (t.wallet_id = ANY($1) OR (t.business_id = $2 AND t.transaction_type IN ('subscription','fee') AND t.wallet_id IS NULL))`;
        params.push(walletIds, businessId);
        let idx = params.length + 1;

        if (wallet_id && walletIds.includes(wallet_id)) {
            sql += ` AND t.wallet_id = $${idx}`;
            params.push(wallet_id);
            idx++;
        }
        if (direction === 'credit' || direction === 'debit') {
            sql += ` AND t.direction = $${idx}`;
            params.push(direction);
            idx++;
        }
        if (type) {
            sql += ` AND t.transaction_type = $${idx}`;
            params.push(type);
            idx++;
        }
        if (search) {
            sql += ` AND (t.reference ILIKE $${idx} OR t.description ILIKE $${idx} OR t.id::text ILIKE $${idx})`;
            params.push(`%${search}%`);
            idx++;
        }
        if (min_amount) {
            sql += ` AND t.amount >= $${idx}`;
            params.push(Number(min_amount));
            idx++;
        }
        if (max_amount) {
            sql += ` AND t.amount <= $${idx}`;
            params.push(Number(max_amount));
            idx++;
        }
        if (start_date) {
            sql += ` AND t.created_at >= $${idx}`;
            params.push(start_date);
            idx++;
        }
        if (end_date) {
            // inclusive of the whole end day
            sql += ` AND t.created_at < ($${idx}::timestamp + interval '1 day')`;
            params.push(end_date);
            idx++;
        }

        sql += ` ORDER BY t.created_at DESC`;

        // CSV export (respects the same filters, no pagination)
        if (format === 'csv') {
            const csvRes = await query(sql, params);
            const rows = csvRes.rows;
            const esc = (v: any) => {
                const s = v === null || v === undefined ? '' : String(v);
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const header = ['Transaction ID', 'Reference', 'Date', 'Direction', 'Type', 'Amount', 'Currency', 'Status', 'Fee', 'Description'];
            const lines = [header.join(',')];
            for (const r of rows) {
                lines.push([
                    esc(r.id), esc(r.reference), esc(r.created_at), esc(r.direction), esc(r.transaction_type),
                    esc(r.amount), esc(r.currency || r.wallet_currency || 'NGN'), esc(r.status), esc(r.fee ?? 0), esc(r.description),
                ].join(','));
            }
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="wallet-transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
            return res.send(lines.join('\n'));
        }

        const countRes = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) sub`, params);
        const total = countRes.rows[0]?.total || 0;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const lim = Math.min(Math.max(1, parseInt(limit) || 20), 200);
        sql += ` LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(lim, (pageNum - 1) * lim);

        const dataRes = await query(sql, params);

        res.json({
            success: true,
            data: dataRes.rows,
            wallets: walletsRes.rows,
            pagination: { total, page: pageNum, limit: lim, totalPages: Math.ceil(total / lim) },
        });
    } catch (error: any) {
        console.error("Wallet history error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch wallet history" });
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
router.post("/fund/card", authenticateToken, checkKycStatus, requireTeamPermission("manage_finance"), async (req: AuthenticatedRequest, res) => {
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
            // Currency follows the SELECTED WALLET (wallet.currency) — the
            // dashboard wallet picker can now fund a business/NGN or USD
            // wallet; the transaction row must match or the ledger breaks.
            const walletCurrency = String(wallet.currency || 'NGN').toUpperCase();
            await query(
                `INSERT INTO transactions 
                 (business_id, user_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee, payment_provider)
                 VALUES ($1, $2, $3, $4, 'pending', $5, 'credit', 'Wallet Funding via Card', 'wallet_funding', $6, 'credit', $7, $8)`,
                [wallet.business_id, wallet.user_id, amount, walletCurrency, reference, wallet.id, fee, provider.name]
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
        const { gtb_account_number } = req.body;

        // Verify Permission
        const roleCheck = await query(`SELECT role, bvn, nin, phone_number FROM users WHERE id = $1`, [userId]);
        if (roleCheck.rows[0]?.role !== 'owner') {
            return res.status(403).json({ success: false, error: "Only business owner can create business wallet" });
        }

        const user = roleCheck.rows[0];

        if (!user.bvn) {
            return res.status(400).json({ success: false, error: "Owner must complete KYC (BVN) first" });
        }

        // Always resolve the authoritative business name from the DB (falls
        // back to the request body, never to the BVN personal name).
        const bizRes = await query(`SELECT name FROM businesses WHERE id = $1`, [businessId]);
        const businessName = (bizRes.rows[0]?.name || req.body.business_name || '').trim();
        if (!businessName) {
            return res.status(400).json({ success: false, error: "Business name is required to create a business virtual account" });
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
            businessName,
            customerIdentifier: `BIZ-${businessId.substring(0, 8)}`,
            phoneNumber: user.phone_number || "08000000000",
            beneficiaryAccount: gtb_account_number || "0000000000" // GTB Account provided by user (Squad only)
        };

        const vaResponse = await provider.createBusinessVirtualAccount(vaData);

        let isSuccess = false;
        let vaNumber: string | null = null;
        let bankCode = '058';
        // The account display name must always be the BUSINESS name (never the
        // personal name pulled from the BVN by the provider).
        let accountName = businessName;
        
        if (provider.name === 'squad') {
            isSuccess = vaResponse.success && vaResponse.data;
            if (isSuccess) {
                vaNumber = vaResponse.data.virtual_account_number;
                bankCode = vaResponse.data.bank_code;
            }
        } else if (provider.name === 'monnify') {
            isSuccess = vaResponse.requestSuccessful;
            if (isSuccess) {
                const accounts = vaResponse.responseBody?.accounts;
                if (accounts && accounts.length > 0) {
                    vaNumber = accounts[0].accountNumber;
                    bankCode = accounts[0].bankCode;
                }
            }
        } else if (provider.name === 'flutterwave') {
            // Flutterwave envelope: { status: 'success', data: { account_number, bank_name, ... } }
            isSuccess = vaResponse?.status === 'success' && !!vaResponse?.data?.account_number;
            if (isSuccess) {
                vaNumber = String(vaResponse.data.account_number);
                bankCode = vaResponse.data.bank_code || vaResponse.data.bank_name || '058';
                if (vaResponse.data.bank_code && /^[A-Z0-9]{3,10}$/i.test(vaResponse.data.bank_code)) {
                    bankCode = vaResponse.data.bank_code;
                }
            }
        } else {
            // Generic provider fallback: { success, data: { account_number } }
            isSuccess = (vaResponse?.success || vaResponse?.status === 'success') && !!vaResponse?.data?.account_number;
            if (isSuccess) {
                vaNumber = String(vaResponse.data.account_number);
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
            
            res.json({ success: true, message: "Business Wallet created successfully", data: { ...(vaResponse.responseBody || vaResponse.data || {}), account_name: accountName } });
        } else {
            const errorMessage = provider.name === 'squad' 
                ? vaResponse.message 
                : vaResponse.responseMessage || vaResponse.message || "Failed to create Virtual Account";
            res.status(400).json({ success: false, error: errorMessage });
        }

    } catch (error: any) {
        console.error("Create Business Wallet Error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to create business wallet" });
    }
});

/**
 * Regenerate the business virtual account. For existing users whose VA was
 * created with their personal (BVN) name, this recreates it so the account
 * name reflects the business name. Owner-only, best-effort provider call.
 */
router.post("/business/regenerate-va", authenticateToken, checkKycStatus, requireTeamPermission("manage_finance"), async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;

        const roleCheck = await query(`SELECT role, bvn, nin, phone_number FROM users WHERE id = $1`, [userId]);
        if (roleCheck.rows[0]?.role !== 'owner') {
            return res.status(403).json({ success: false, error: "Only business owner can regenerate the business virtual account" });
        }
        const user = roleCheck.rows[0];
        if (!user.bvn) {
            return res.status(400).json({ success: false, error: "Owner must complete KYC (BVN) first" });
        }

        const bizRes = await query(`SELECT name FROM businesses WHERE id = $1`, [businessId]);
        const businessName = (bizRes.rows[0]?.name || '').trim();
        if (!businessName) {
            return res.status(400).json({ success: false, error: "Business name not found" });
        }

        const walletRes = await query(`SELECT * FROM wallets WHERE business_id = $1 LIMIT 1`, [businessId]);
        if (walletRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "No wallet found for this business" });
        }
        const wallet = walletRes.rows[0];

        const provider = getProvider();
        const vaData = {
            bvn: user.bvn,
            nin: user.nin || "12345678901",
            businessName,
            customerIdentifier: `BIZ-${businessId.substring(0, 8)}`,
            phoneNumber: user.phone_number || "08000000000",
            beneficiaryAccount: wallet.beneficiary_account || "0000000000",
        };

        const vaResponse = await provider.createBusinessVirtualAccount(vaData);

        let isSuccess = false;
        let vaNumber: string | null = null;
        let bankCode = '058';

        if (provider.name === 'squad') {
            isSuccess = vaResponse.success && vaResponse.data;
            if (isSuccess) {
                vaNumber = vaResponse.data.virtual_account_number;
                bankCode = vaResponse.data.bank_code;
            }
        } else if (provider.name === 'monnify') {
            isSuccess = vaResponse.requestSuccessful;
            if (isSuccess) {
                const accounts = vaResponse.responseBody?.accounts;
                if (accounts && accounts.length > 0) {
                    vaNumber = accounts[0].accountNumber;
                    bankCode = accounts[0].bankCode;
                }
            }
        } else if (provider.name === 'flutterwave') {
            isSuccess = vaResponse?.status === 'success' && !!vaResponse?.data?.account_number;
            if (isSuccess) {
                vaNumber = String(vaResponse.data.account_number);
                if (vaResponse.data.bank_code && /^[A-Z0-9]{3,10}$/i.test(vaResponse.data.bank_code)) {
                    bankCode = vaResponse.data.bank_code;
                }
            }
        }

        if (isSuccess && vaNumber) {
            await query(
                `UPDATE wallets SET virtual_account_number = $1, bank_code = $2, account_name = $3, payment_provider = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
                [vaNumber, bankCode, businessName, provider.name, wallet.id],
            );
            res.json({
                success: true,
                message: "Business virtual account regenerated with the business name",
                data: { account_number: vaNumber, bank_code: bankCode, account_name: businessName, provider: provider.name },
            });
        } else {
            const errorMessage = vaResponse?.responseMessage || vaResponse?.message || "Failed to regenerate virtual account";
            res.status(400).json({ success: false, error: errorMessage });
        }
    } catch (error: any) {
        console.error("Regenerate Business VA Error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to regenerate business virtual account" });
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
        // Flutterwave's standard redirect appends `tx_ref` (NOT `reference`)
        // to the callback URL — accept both so the browser-facing callback
        // never dead-ends on a missing-reference error page.
        const queryReference = req.query.reference || req.query.tx_ref;
        const reference = typeof queryReference === 'string' ? queryReference : undefined;
        const redirect_url = req.query.redirect_url;
        
        if (!reference) {
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
            // Bare origins land on the dedicated client callback route,
            // which knows how to re-verify and display the outcome.
            if (!hasLandingPath) base += `/payment/callback`;
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
        let verifyNotFound = false;
        try {
            verifyResponse = await provider.verifyPayment(reference);
        } catch (err: any) {
            console.error(`${provider.name} Verification Failed:`, err);
            // A cancelled/abandoned checkout has no completed provider transaction.
            const notFound = /no transaction|not found|could not be found|does not exist/i.test(err?.message || '')
                || err?.response?.status === 404;
            if (notFound && transaction.status !== 'success') {
                // Mark cancelled locally (idempotent) and show a friendly page
                await query(
                    `UPDATE transactions SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status NOT IN ('success','cancelled')`,
                    [transaction.id],
                ).catch(() => {});
                const cancelledTarget = buildClientRedirect('cancelled', false);
                return res.send(`
                    <html>
                        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                            <div style="margin-bottom: 20px; font-size: 48px;">🚫</div>
                            <h1 style="color: #f59e0b;">Payment Cancelled</h1>
                            <p>You cancelled the payment before it was completed. No money was deducted from your account.</p>
                            <p>You can safely start the payment again at any time.</p>
                            <a href="${cancelledTarget}" style="display: inline-block; padding: 10px 20px; background: #f59e0b; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
                        </body>
                    </html>
                `);
            }
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

                await client.query('COMMIT');

                // 4. Platform ledger (owner invariant) — a funding event
                // produces exactly ONE platform-ledger row: a DEBIT of the
                // amount that lands in the user's wallet (platform ledger is
                // debited, user credited). The fee goes to the REVENUE ledger
                // only. Runs AFTER COMMIT: the ledger helpers use the
                // connection pool while `client` still held row locks on the
                // wallets row inside the settlement transaction. Every helper
                // is idempotent by reference, so a replayed verify callback
                // cannot duplicate rows (and the status guard above means
                // settlement only happens once).
                try {
                    const ledgerProvider = transaction.payment_provider || null;
                    const netAmount = Number(transaction.amount) || 0;
                    const feeAmount = Number(transaction.fee) || 0;

                    await debitPlatformWallet(
                        netAmount,
                        'NGN',
                        `${reference}-PLATFORM`,
                        'User Wallet Funding (Card)',
                        ledgerProvider,
                    );
                    // The fee lands in the revenue wallet —
                    // this writes the wallet_id-NULL revenue row that the
                    // admin Revenue Ledger history aggregates on.
                    if (feeAmount > 0) {
                        await creditRevenueWallet(
                            feeAmount,
                            'NGN',
                            reference,
                            'Wallet Funding Fee',
                            ledgerProvider,
                        );
                    }
                } catch (ledgerErr) {
                    // Never fail the user's funding because of a ledger write;
                    // the startup backfill reconciles any missing rows.
                    console.error('Card funding ledger entries failed:', ledgerErr);
                }
                
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
