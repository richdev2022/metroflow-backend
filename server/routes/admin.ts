import express from "express";
import { loginAdmin } from "../services/admin-auth";
import { authenticateAdmin, requirePermission, AuthenticatedAdminRequest } from "../middleware/adminAuth";
import { query, pool } from "../db";
import { generateOTP, getOTPExpiry, hashPassword } from "../services/auth";
import { sendEmail, generateAdminInviteEmailHtml, generateMaintenanceModeEmailHtml, generateBroadcastEmailHtml, sendDisputeAdminAlert, emailLogoHeader, getEmailConfigWithMeta, saveEmailConfig, EMAIL_CONFIG_KEYS } from "../services/email";
import {
  getDisputeAdminEmails,
  setDisputeAdminEmails,
  parseEmailList,
  disputeAdminEmails,
} from "./disputes";
import { getSetting, setSetting, getIntlTransferConfig, getIntlPayoutLimits, getIntlPayoutSourceCurrency, DEFAULT_PAYOUT_LIMITS } from "../services/app-config";
import { sendPushToAll } from "../services/push";
import adminDisputesRouter from "./admin_disputes";
import { invalidateActiveProviderCache, getActiveTransferProviderName } from "../services/providers/factory";
import { reverseFailedTransfer } from "../services/transfer";
import { invalidatePlanLimitsCache } from "../lib/ai-usage";
import { verifyPayment } from "../services/squad";
import { AVAILABLE_PERMISSIONS } from "../config/permissions";

import * as XLSX from "xlsx";
import { generateBusinessId } from "../utils/idGenerator";

const router = express.Router();

const authRouter = express.Router();
const protectedRouter = express.Router();

protectedRouter.use(authenticateAdmin);

const toJsonbParam = (value: unknown, fallback: unknown = []) => {
  const normalized = value === undefined || value === null || value === "" ? fallback : value;

  if (typeof normalized === "string") {
    try {
      JSON.parse(normalized);
      return normalized;
    } catch {
      return JSON.stringify(normalized);
    }
  }

  return JSON.stringify(normalized);
};

// Backward-compatible public aliases (no token required)
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await loginAdmin(email, password);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(401).json({ success: false, error: error.message });
  }
});

router.post("/verify-login", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const adminCheck = await query(`SELECT * FROM platform_admins WHERE email = $1 AND reset_token = $2 AND reset_expires > NOW()`, [email, otp]);

    if (adminCheck.rows.length > 0) {
      await query(`UPDATE platform_admins SET reset_token = NULL, reset_expires = NULL WHERE email = $1`, [email]);
      res.json({ success: true, message: "Admin verified successfully" });
    } else {
      res.status(401).json({ success: false, error: "Invalid OTP" });
    }
  } catch (error: any) {
    res.status(401).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /admin/auth/login:
 *   post:
 *     summary: Admin login
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 token:
 *                   type: string
 *                 admin:
 *                   type: object
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 error:
 *                   type: string
 */
// Admin Login
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await loginAdmin(email, password);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(401).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /admin/auth/verify-login:
 *   post:
 *     summary: Verify admin login with OTP
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - otp
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *     responses:
 *       200:
 *         description: OTP verified successfully
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
 *         description: Invalid OTP
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 error:
 *                   type: string
 */
// Admin Verify Login
authRouter.post("/verify-login", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const adminCheck = await query(`SELECT * FROM platform_admins WHERE email = $1 AND reset_token = $2 AND reset_expires > NOW()`, [email, otp]);

    if (adminCheck.rows.length > 0) {
      await query(`UPDATE platform_admins SET reset_token = NULL, reset_expires = NULL WHERE email = $1`, [email]);
      res.json({ success: true, message: "Admin verified successfully" });
    } else {
      res.status(401).json({ success: false, error: "Invalid OTP" });
    }
  } catch (error: any) {
    res.status(401).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /admin/auth/verify-forgot-password-otp:
 *   post:
 *     summary: Verify forgot password OTP
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - otp
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *     responses:
 *       200:
 *         description: OTP verified successfully
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
 *         description: Invalid OTP
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 error:
 *                   type: string
 */
// Admin Verify Forgot Password OTP
authRouter.post("/verify-forgot-password-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const adminCheck = await query(`SELECT * FROM platform_admins WHERE email = $1 AND reset_token = $2 AND reset_expires > NOW()`, [email, otp]);

    if (adminCheck.rows.length > 0) {
      await query(`UPDATE platform_admins SET reset_token = NULL, reset_expires = NULL WHERE email = $1`, [email]);
      res.json({ success: true, message: "OTP verified successfully" });
    } else {
      res.status(401).json({ success: false, error: "Invalid OTP" });
    }
  } catch (error: any) {
    res.status(401).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /admin/auth/reset-password:
 *   post:
 *     summary: Reset admin password
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - otp
 *               - newPassword
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password reset successfully
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
 *         description: Invalid OTP
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 error:
 *                   type: string
 */
// Admin Reset Password
authRouter.post("/reset-password", async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
    }

    const adminCheck = await query(`SELECT * FROM platform_admins WHERE email = $1 AND reset_token = $2 AND reset_expires > NOW()`, [email, otp]);

    if (adminCheck.rows.length > 0) {
      const passwordHash = await hashPassword(newPassword);
      await query(`UPDATE platform_admins SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE email = $2`, [passwordHash, email]);
      res.json({ success: true, message: "Password reset successfully" });
    } else {
      res.status(401).json({ success: false, error: "Invalid OTP" });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /admin/auth/forgot-password:
 *   post:
 *     summary: Request password reset
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Reset instructions sent (if account exists)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       500:
 *         description: Failed to process request
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 error:
 *                   type: string
 */
// Admin Forgot Password
authRouter.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const adminCheck = await query(`SELECT * FROM platform_admins WHERE email = $1`, [email]);
    
    if (adminCheck.rows.length > 0) {
      const otp = generateOTP();
      await query(`UPDATE platform_admins SET reset_token = $1, reset_expires = $2 WHERE email = $3`, 
        [otp, getOTPExpiry(), email]);
      await sendEmail(email, "Platform Admin", "Reset Your Metricorex Admin Password", `
        <html>
          <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px;">
              ${emailLogoHeader(150)}
              <h2 style="color: #1d4ed8; margin-bottom: 20px;">Reset Your Password</h2>
              <p style="color: #333;">Hi,</p>
              <p style="color: #666; line-height: 1.6;">We received a request to reset your admin password. Use the code below to proceed:</p>
              <div style="background-color: #f0f0f0; padding: 20px; border-radius: 4px; margin: 20px 0; text-align: center;">
                <p style="font-size: 32px; font-weight: bold; color: #1d4ed8; margin: 0; letter-spacing: 5px;">${otp}</p>
              </div>
              <p style="color: #999; font-size: 12px;">This code expires in 10 minutes. If you didn't request this reset, please ignore this email.</p>
            </div>
          </body>
        </html>
      `);
    }
    
    // Always return success to prevent email enumeration
    res.json({ success: true, message: "If account exists, reset instructions sent." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to process request" });
  }
});

router.use('/auth', authRouter);
// Dispute lifecycle — own router (brings authenticateAdmin + manage_finance per route)
router.use('/disputes', adminDisputesRouter);
router.use('/', protectedRouter);

// Dashboard Stats
protectedRouter.get("/dashboard/stats", requirePermission('view_dashboard'), async (req, res) => {
  try {
    const businessesCount = await query(`SELECT COUNT(*) FROM businesses`);
    const usersCount = await query(`SELECT COUNT(*) FROM users`);
    const activeBusinesses = await query(`SELECT COUNT(*) FROM businesses WHERE subscription_status = 'active'`);
    
    // Real revenue: ONLY platform earnings — the wallet_id-NULL fee/subscription
    // credit rows written by creditRevenueWallet()/subscription settlement (the
    // same aggregation the /revenue endpoint uses). Previously this summed
    // EVERY successful transaction (fundings, transfers, refunds, ledger
    // mirrors), massively overstating revenue.
    const revenue = await query(`
      SELECT COALESCE(SUM(amount), 0) as sum
      FROM transactions
      WHERE status = 'success'
        AND transaction_type IN ('fee', 'subscription')
        AND wallet_id IS NULL
        AND type = 'credit'
    `);

    res.json({
      success: true,
      stats: {
        totalBusinesses: parseInt(businessesCount.rows[0].count),
        totalUsers: parseInt(usersCount.rows[0].count),
        activeBusinesses: parseInt(activeBusinesses.rows[0].count),
        totalRevenue: parseInt(revenue.rows[0].sum || '0')
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch stats" });
  }
});

// Dashboard Charts
/**
 * @swagger
 * /admin/dashboard/charts:
 *   get:
 *     summary: Get dashboard charts data
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Chart data
 */
protectedRouter.get("/dashboard/charts", requirePermission('view_dashboard'), async (req, res) => {
  try {
    // 1. Revenue Over Time (Last 6 months) — platform earnings ONLY
    //    (fee/subscription credit rows), not every successful transaction.
    const revenueRes = await query(`
      SELECT 
        to_char(d, 'Mon') as name, 
        COALESCE(SUM(t.amount), 0) as revenue 
      FROM generate_series(
        date_trunc('month', NOW() - INTERVAL '5 months'), 
        date_trunc('month', NOW()), 
        '1 month'::interval
      ) d
      LEFT JOIN transactions t 
        ON date_trunc('month', t.created_at) = d 
        AND t.status = 'success'
        AND t.transaction_type IN ('fee', 'subscription')
        AND t.wallet_id IS NULL
        AND t.type = 'credit'
      GROUP BY d
      ORDER BY d ASC
    `);

    // 2. Business Growth (Last 6 months)
    const growthRes = await query(`
      SELECT 
        to_char(d, 'Mon') as name, 
        COUNT(b.id) as businesses 
      FROM generate_series(
        date_trunc('month', NOW() - INTERVAL '5 months'), 
        date_trunc('month', NOW()), 
        '1 month'::interval
      ) d
      LEFT JOIN businesses b ON date_trunc('month', b.created_at) = d
      GROUP BY d
      ORDER BY d ASC
    `);

    // Format data to ensure integer values for chart
    const revenueData = revenueRes.rows.map(row => ({
      name: row.name,
      revenue: parseInt(row.revenue)
    }));

    const businessGrowthData = growthRes.rows.map(row => ({
      name: row.name,
      businesses: parseInt(row.businesses)
    }));

    res.json({
      success: true,
      charts: {
        revenueData,
        businessGrowthData
      }
    });
  } catch (error) {
    console.error("Failed to fetch charts data:", error);
    res.status(500).json({ success: false, error: "Failed to fetch charts data" });
  }
});

// Admin Wallet
protectedRouter.get("/wallet", requirePermission('view_dashboard'), async (req, res) => {
  try {
    // Find or Create Platform Wallet
    // We assume Platform Wallet has business_id = NULL and user_id = NULL
    
    let wallet = await query(`SELECT * FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
    
    if (wallet.rows.length === 0) {
      // Create it
      const newWallet = await query(
        `INSERT INTO wallets (status, currency, balance) VALUES ('active', 'NGN', 0) RETURNING *`
      );
      wallet = newWallet;
    }

    res.json({ success: true, wallet: wallet.rows[0] });

  } catch (error) {
    console.error("Get Admin Wallet Error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch admin wallet" });
  }
});

protectedRouter.get("/revenue", requirePermission('view_dashboard'), async (req, res) => {
  try {
    const walletsRes = await query(`SELECT * FROM platform_wallet`);
    let wallets = walletsRes.rows;
    // Revenue-side ledger rows are the ones written by creditRevenueWallet()
    // (transaction_type fee/subscription with NO wallet_id - user-side fee
    // debits carry a wallet_id and must NOT be double-counted here).
    // Sign-aware: revenue DEBIT rows (reversals/refunds) reduce the balance.
    const revenueBalancesRes = await query(`
      SELECT currency, COALESCE(SUM(
        CASE WHEN type = 'debit' OR direction = 'debit' THEN -amount ELSE amount END
      ), 0) as balance
      FROM transactions
      WHERE status = 'success'
      AND transaction_type IN ('subscription', 'fee')
      AND wallet_id IS NULL
      GROUP BY currency
    `);
    const revenueBalanceByCurrency = new Map(
      revenueBalancesRes.rows.map(row => [row.currency || 'NGN', row.balance])
    );
    
    // Ensure NGN wallet exists (Default)
    let ngnWallet = wallets.find(w => w.currency === 'NGN');
    if (!ngnWallet) {
       const newWallet = await query(
         `INSERT INTO platform_wallet (balance, currency) VALUES (0, 'NGN') RETURNING *`
       );
       ngnWallet = newWallet.rows[0];
       wallets.push(ngnWallet);
    }

    wallets = wallets.map(wallet => ({
      ...wallet,
      balance: revenueBalanceByCurrency.get(wallet.currency || 'NGN') || wallet.balance,
      stored_balance: wallet.balance
    }));
    ngnWallet = wallets.find(w => w.currency === 'NGN') || ngnWallet;

    // Return NGN wallet as primary 'wallet' for backward compatibility, and full list in 'wallets'
    res.json({ success: true, wallet: ngnWallet, wallets: wallets });

  } catch (error) {
    console.error("Get Revenue Wallet Error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch revenue wallet" });
  }
});

protectedRouter.get("/wallet/history", requirePermission('view_dashboard'), async (req, res) => {
  try {
    const walletRes = await query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
    if (walletRes.rows.length === 0) {
        return res.json({ success: true, transactions: [] });
    }
    const walletId = walletRes.rows[0].id;

    // PLATFORM LEDGER = mirror of the provider pool account. Show ONLY rows
    // that correspond to real pool movements (fundings in, payouts out, vendor
    // settlements, provider reversals). Internal allocation pairs ("-USER",
    // "-MERCHANT", revenue mirrors, transfer holds) never touched the pool —
    // filter them defensively so legacy/un-migrated rows can't pollute the
    // history either.
    const transactions = await query(
        `SELECT * FROM transactions 
         WHERE wallet_id = $1 
         AND transaction_type NOT IN ('fee', 'subscription')
         AND reference NOT LIKE '%-USER'
         AND reference NOT LIKE '%-MERCHANT'
         AND reference NOT LIKE '%-PLATFORM'
         AND description NOT LIKE 'Platform Wallet Debit for Revenue%'
         AND description NOT LIKE 'Platform Wallet Credit (Revenue Reversal)%'
         AND description NOT LIKE 'Platform Wallet Credit for Transfer%'
         AND description NOT LIKE 'Reversal of platform hold%'
         AND description NOT IN ('Bill Payment Received', 'Savings Withdrawal Received', 'Subscription Charge Collected')
         ORDER BY created_at DESC`,
        [walletId]
    );

    res.json({ success: true, transactions: transactions.rows });

  } catch (error) {
    console.error("Get Admin Wallet History Error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch history" });
  }
});

protectedRouter.get("/revenue/history", requirePermission('view_dashboard'), async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;

    // Revenue-side movements ONLY. Two row generations exist in the ledger:
    //  - current: transaction_type IN ('fee','subscription') written by
    //    creditRevenueWallet() with wallet_id NULL, and
    //  - legacy: transaction_type = 'revenue' rows attached to the platform
    //    wallet by the pre-refactor writer (reference *-REVENUE).
    // Excluding the legacy generation is why this endpoint returned an empty
    // list on production databases that predate the current writer.
    const where = `status = 'success'
         AND (
           (transaction_type IN ('subscription', 'fee') AND wallet_id IS NULL)
           OR transaction_type = 'revenue'
         )`;
    const countRes = await query(
        `SELECT COUNT(*)::int AS total FROM transactions WHERE ${where}`
    );
    const transactions = await query(
        `SELECT * FROM transactions
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
    );

    const history = transactions.rows.map(txn => {
        const isLegacyRevenue = txn.transaction_type === 'revenue';
        return {
            ...txn,
            // Legacy rows are platform-wallet mirrors of a fee inflow: show
            // them as credits (revenue direction) with a clean description.
            type: isLegacyRevenue ? 'credit' : (txn.type === 'debit' ? 'debit' : 'credit'),
            description: isLegacyRevenue && /debit for revenue/i.test(txn.description || '')
                ? 'Revenue Credit (fee)'
                : txn.description,
        };
    });

    res.json({ success: true, transactions: history, pagination: { page, limit, total: countRes.rows[0]?.total || 0 } });

  } catch (error) {
    console.error("Get Admin Revenue History Error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch revenue history" });
  }
});

// KYC Management
protectedRouter.get("/kyc", requirePermission('manage_businesses'), async (req, res) => {
  try {
    // Fetch Users with KYC
    const users = await query(`
        SELECT id, name, email, bvn, nin, kyc_status, kyc_data, created_at, 'user' as type 
        FROM users 
        WHERE kyc_status IS NOT NULL AND kyc_status != 'none'
    `);

    // Fetch Businesses with KYC
    const businesses = await query(`
        SELECT id, name, email, cac_number, proof_of_address_url, kyc_status, kyc_rejection_reason,
               address_country, address_state, address_city, address_street, address_house_number,
               created_at, 'business' as type 
        FROM businesses 
        WHERE kyc_status IS NOT NULL AND kyc_status != 'none'
    `);

    res.json({ 
        success: true, 
        kyc_records: [...users.rows, ...businesses.rows].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) 
    });

  } catch (error) {
    console.error("Get Admin KYC Error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch KYC records" });
  }
});

protectedRouter.post("/kyc/business/:id/approve", requirePermission('manage_businesses'), async (req, res) => {
    try {
        const { id } = req.params;
        
        // Update Status
        await query(
            `UPDATE businesses SET kyc_status = 'verified', kyc_rejection_reason = NULL WHERE id = $1`,
            [id]
        );

        // Fetch Email
        const busRes = await query(`SELECT email, name FROM businesses WHERE id = $1`, [id]);
        if (busRes.rows.length > 0) {
            const { email, name } = busRes.rows[0];
            
            // Send Email
            await sendEmail(email, name, "KYC Approved", `
                <html>
                  <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
                    <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px;">
                      ${emailLogoHeader(150)}
                      <h3 style="color: #10b981;">KYC Approved</h3>
                      <p style="color: #333;">Congratulations, your business verification for <strong>${name}</strong> has been approved.</p>
                      <p style="color: #666;">You can now proceed to create your Business Wallet.</p>
                    </div>
                  </body>
                </html>
            `);
        }

        res.json({ success: true, message: "Business KYC Approved" });

    } catch (error) {
        console.error("Approve KYC Error:", error);
        res.status(500).json({ success: false, error: "Failed to approve KYC" });
    }
});

protectedRouter.post("/kyc/business/:id/reject", requirePermission('manage_businesses'), async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ success: false, error: "Rejection reason is required" });
        }
        
        // Update Status
        await query(
            `UPDATE businesses SET kyc_status = 'rejected', kyc_rejection_reason = $1 WHERE id = $2`,
            [reason, id]
        );

        // Fetch Email
        const busRes = await query(`SELECT email, name FROM businesses WHERE id = $1`, [id]);
        if (busRes.rows.length > 0) {
            const { email, name } = busRes.rows[0];
            
            // Send Email
            await sendEmail(email, name, "KYC Rejected", `
                <html>
                  <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
                    <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px;">
                      ${emailLogoHeader(150)}
                      <h3 style="color: #ef4444;">KYC Update</h3>
                      <p style="color: #333;">Your business verification for <strong>${name}</strong> has been rejected.</p>
                      <p style="color: #333;"><strong>Reason:</strong> ${reason}</p>
                      <p style="color: #666;">Please update your information and resubmit.</p>
                    </div>
                  </body>
                </html>
            `);
        }

        res.json({ success: true, message: "Business KYC Rejected" });

    } catch (error) {
        console.error("Reject KYC Error:", error);
        res.status(500).json({ success: false, error: "Failed to reject KYC" });
    }
});

// Businesses Management
protectedRouter.get("/pricing", requirePermission('manage_plans', 'manage_businesses'), async (req, res) => {
    try {

        const result = await query(`SELECT * FROM pricing_plans ORDER BY price ASC`);
        res.json({ success: true, plans: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch plans" });
    }
});

/**
 * @swagger
 * /admin/pricing:
 *   post:
 *     summary: Create a new pricing plan
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - price
 *               - currency
 *               - duration
 *             properties:
 *               name:
 *                 type: string
 *               price:
 *                 type: number
 *               currency:
 *                 type: string
 *               duration:
 *                 type: string
 *                 enum: [monthly, yearly]
 *               discount:
 *                 type: number
 *               features:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Plan created
 */
protectedRouter.post("/pricing", requirePermission('manage_plans', 'manage_businesses'), async (req, res) => {
    try {
        const { 
            name, price, currency, duration, discount, features, permissions,
            maxMeetingDuration, maxParticipants, maxRecordingDuration, maxRecordingStorage,
            waitingRoomEnabled, recordingEnabled, screenSharingEnabled,
            breakoutRoomsEnabled, virtualBackgrounds, liveCaptions,
            paymentLinksEnabled, maxPaymentLinks, paymentLinkFeeDiscountPercent,
            aiCreditDiscountPercent
        } = req.body;
        
        if (!name || !price || !currency || !duration) {
            return res.status(400).json({ success: false, error: "Missing required fields" });
        }

        const result = await query(
            `INSERT INTO pricing_plans 
            (name, price, currency, duration, discount, features, permissions, is_active,
            max_meeting_duration, max_participants, max_recording_duration, max_recording_storage,
            waiting_room_enabled, recording_enabled, screen_sharing_enabled,
            breakout_rooms_enabled, virtual_backgrounds, live_captions,
            payment_links_enabled, max_payment_links, payment_link_fee_discount_percent,
            ai_credit_discount_percent)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, true, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
             RETURNING *`,
            [
                name, price, currency, duration, discount || 0, toJsonbParam(features), toJsonbParam(permissions),
                maxMeetingDuration, maxParticipants, maxRecordingDuration, maxRecordingStorage,
                waitingRoomEnabled, recordingEnabled, screenSharingEnabled,
                breakoutRoomsEnabled, virtualBackgrounds, liveCaptions,
                paymentLinksEnabled ?? true, maxPaymentLinks ?? 3, paymentLinkFeeDiscountPercent ?? 0,
                aiCreditDiscountPercent ?? 0
            ]
        );

        res.json({ success: true, plan: result.rows[0] });
    } catch (error) {
        console.error("Create Plan Error:", error);
        res.status(500).json({ success: false, error: "Failed to create plan" });
    }
});

/**
 * @swagger
 * /admin/pricing/{id}:
 *   put:
 *     summary: Update a pricing plan
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               price:
 *                 type: number
 *               discount:
 *                 type: number
 *               features:
 *                 type: array
 *                 items:
 *                   type: string
 *               is_active:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Plan updated
 */
protectedRouter.put("/pricing/:id", requirePermission('manage_plans', 'manage_businesses'), async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            name, price, discount, features, permissions, is_active,
            maxMeetingDuration, maxParticipants, maxRecordingDuration, maxRecordingStorage,
            waitingRoomEnabled, recordingEnabled, screenSharingEnabled,
            breakoutRoomsEnabled, virtualBackgrounds, liveCaptions,
            metricAiEnabled,
            paymentLinksEnabled, maxPaymentLinks, paymentLinkFeeDiscountPercent,
            aiCreditDiscountPercent,
            invoicesEnabled, maxInvoicesPerMonth, invoiceFeeDiscountPercent,
            storeEnabled, maxStoreProducts, storeFeeDiscountPercent,
            recurringEnabled, maxSubscriptionPlans, subscriptionFeeDiscountPercent
        } = req.body;

        // Dynamic update
        let queryStr = "UPDATE pricing_plans SET updated_at = NOW()";
        const params: any[] = [id];
        let paramCount = 2;

        if (name !== undefined) {
            queryStr += `, name = $${paramCount}`;
            params.push(name);
            paramCount++;
        }
        if (price !== undefined) {
            queryStr += `, price = $${paramCount}`;
            params.push(price);
            paramCount++;
        }
        if (discount !== undefined) {
            queryStr += `, discount = $${paramCount}`;
            params.push(discount);
            paramCount++;
        }
        if (features !== undefined) {
            queryStr += `, features = $${paramCount}::jsonb`;
            params.push(toJsonbParam(features));
            paramCount++;
        }
        if (permissions !== undefined) {
            queryStr += `, permissions = $${paramCount}::jsonb`;
            params.push(toJsonbParam(permissions));
            paramCount++;
        }
        if (is_active !== undefined) {
            queryStr += `, is_active = $${paramCount}`;
            params.push(is_active);
            paramCount++;
        }
        if (maxMeetingDuration !== undefined) {
            queryStr += `, max_meeting_duration = $${paramCount}`;
            params.push(maxMeetingDuration);
            paramCount++;
        }
        if (maxParticipants !== undefined) {
            queryStr += `, max_participants = $${paramCount}`;
            params.push(maxParticipants);
            paramCount++;
        }
        if (maxRecordingDuration !== undefined) {
            queryStr += `, max_recording_duration = $${paramCount}`;
            params.push(maxRecordingDuration);
            paramCount++;
        }
        if (maxRecordingStorage !== undefined) {
            queryStr += `, max_recording_storage = $${paramCount}`;
            params.push(maxRecordingStorage);
            paramCount++;
        }
        if (waitingRoomEnabled !== undefined) {
            queryStr += `, waiting_room_enabled = $${paramCount}`;
            params.push(waitingRoomEnabled);
            paramCount++;
        }
        if (recordingEnabled !== undefined) {
            queryStr += `, recording_enabled = $${paramCount}`;
            params.push(recordingEnabled);
            paramCount++;
        }
        if (screenSharingEnabled !== undefined) {
            queryStr += `, screen_sharing_enabled = $${paramCount}`;
            params.push(screenSharingEnabled);
            paramCount++;
        }
        if (breakoutRoomsEnabled !== undefined) {
            queryStr += `, breakout_rooms_enabled = $${paramCount}`;
            params.push(breakoutRoomsEnabled);
            paramCount++;
        }
        if (virtualBackgrounds !== undefined) {
            queryStr += `, virtual_backgrounds = $${paramCount}`;
            params.push(virtualBackgrounds);
            paramCount++;
        }
        if (liveCaptions !== undefined) {
            queryStr += `, live_captions = $${paramCount}`;
            params.push(liveCaptions);
            paramCount++;
        }
        if (metricAiEnabled !== undefined) {
            queryStr += `, metric_ai_enabled = $${paramCount}`;
            params.push(String(metricAiEnabled === true));
            paramCount++;
        }
        if (paymentLinksEnabled !== undefined) {
            queryStr += `, payment_links_enabled = $${paramCount}`;
            params.push(paymentLinksEnabled === true);
            paramCount++;
        }
        if (maxPaymentLinks !== undefined) {
            queryStr += `, max_payment_links = $${paramCount}`;
            params.push(Number(maxPaymentLinks) || 0);
            paramCount++;
        }
        if (paymentLinkFeeDiscountPercent !== undefined) {
            queryStr += `, payment_link_fee_discount_percent = $${paramCount}`;
            params.push(Number(paymentLinkFeeDiscountPercent) || 0);
            paramCount++;
        }
        if (aiCreditDiscountPercent !== undefined) {
            queryStr += `, ai_credit_discount_percent = $${paramCount}`;
            params.push(Number(aiCreditDiscountPercent) || 0);
            paramCount++;
        }
        if (invoicesEnabled !== undefined) {
            queryStr += `, invoices_enabled = $${paramCount}`;
            params.push(invoicesEnabled === true);
            paramCount++;
        }
        if (maxInvoicesPerMonth !== undefined) {
            queryStr += `, max_invoices_per_month = $${paramCount}`;
            params.push(Number(maxInvoicesPerMonth) || 0);
            paramCount++;
        }
        if (invoiceFeeDiscountPercent !== undefined) {
            queryStr += `, invoice_fee_discount_percent = $${paramCount}`;
            params.push(Number(invoiceFeeDiscountPercent) || 0);
            paramCount++;
        }
        if (storeEnabled !== undefined) {
            queryStr += `, store_enabled = $${paramCount}`;
            params.push(storeEnabled === true);
            paramCount++;
        }
        if (maxStoreProducts !== undefined) {
            queryStr += `, max_store_products = $${paramCount}`;
            params.push(Number(maxStoreProducts) || 0);
            paramCount++;
        }
        if (storeFeeDiscountPercent !== undefined) {
            queryStr += `, store_fee_discount_percent = $${paramCount}`;
            params.push(Number(storeFeeDiscountPercent) || 0);
            paramCount++;
        }
        if (recurringEnabled !== undefined) {
            queryStr += `, recurring_enabled = $${paramCount}`;
            params.push(recurringEnabled === true);
            paramCount++;
        }
        if (maxSubscriptionPlans !== undefined) {
            queryStr += `, max_subscription_plans = $${paramCount}`;
            params.push(Number(maxSubscriptionPlans) || 0);
            paramCount++;
        }
        if (subscriptionFeeDiscountPercent !== undefined) {
            queryStr += `, subscription_fee_discount_percent = $${paramCount}`;
            params.push(Number(subscriptionFeeDiscountPercent) || 0);
            paramCount++;
        }

        queryStr += ` WHERE id = $1 RETURNING *`;

        const result = await query(queryStr, params);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Plan not found" });
        }

        res.json({ success: true, plan: result.rows[0] });
    } catch (error) {
        console.error("Update Plan Error:", error);
        res.status(500).json({ success: false, error: "Failed to update plan" });
    }
});

/**
 * @swagger
 * /admin/businesses:
 *   get:
 *     summary: Get all businesses
 *     tags: [Admin]
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
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: planId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of businesses
 */
protectedRouter.get("/businesses", requirePermission('manage_businesses'), async (req, res) => {
  try {
    const { page = 1, limit = 10, search, status, planId } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let queryStr = `
      SELECT b.*, p.name as plan_name 
      FROM businesses b
      LEFT JOIN pricing_plans p ON b.plan_id = p.id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramCount = 1;

    if (search) {
      queryStr += ` AND (b.name ILIKE $${paramCount} OR b.email ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    if (status) {
      queryStr += ` AND b.subscription_status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (planId) {
      queryStr += ` AND b.plan_id = $${paramCount}`;
      params.push(planId);
      paramCount++;
    }

    // Count query
    const countQuery = `SELECT COUNT(*) FROM (${queryStr}) as count_table`;
    const countRes = await query(countQuery, params);
    const total = parseInt(countRes.rows[0].count);

    queryStr += ` ORDER BY b.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await query(queryStr, params);

    res.json({
      success: true,
      businesses: result.rows,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
        totalPages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch businesses" });
  }
});

/**
 * @swagger
 * /admin/businesses/{id}/team:
 *   get:
 *     summary: Get business team members
 *     tags: [Admin]
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
 *         description: List of team members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 team:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
protectedRouter.get("/businesses/:id/team", requirePermission('manage_businesses'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(`
      SELECT id, name, email, role, status, last_login, created_at
      FROM users
      WHERE business_id = $1
      ORDER BY created_at DESC
    `, [id]);
    res.json({ success: true, team: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch team members" });
  }
});

// Admin Transactions View
/**
 * @swagger
 * /admin/transactions:
 *   get:
 *     summary: Get all transactions
 *     tags: [Admin]
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
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by transaction status
 *       - in: query
 *         name: businessId
 *         schema:
 *           type: string
 *         description: Filter by business ID
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by start date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by end date (YYYY-MM-DD)
 *       - in: query
 *         name: reference
 *         schema:
 *           type: string
 *         description: Search by transaction reference
 *     responses:
 *       200:
 *         description: List of transactions with pagination
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
 *                         format: uuid
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
 *                       business_name:
 *                         type: string
 *                       plan_name:
 *                         type: string
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
 */
protectedRouter.get("/transactions", requirePermission('view_dashboard'), async (req, res) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const perPage = parseInt((req.query.perPage || req.query.limit) as string) || 50;
        const offset = (page - 1) * perPage;

        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;
        const reference = req.query.reference as string;
        const status = req.query.status as string;
        const businessId = req.query.businessId as string;

        const params: any[] = [];
        const transactionFilters: string[] = [];
        const transferFilters: string[] = [];

        const addSharedFilter = (transactionCondition: string, transferCondition: string, value: any) => {
            params.push(value);
            const placeholder = `$${params.length}`;
            transactionFilters.push(transactionCondition.replace("?", placeholder));
            transferFilters.push(transferCondition.replace("?", placeholder));
        };

        if (businessId) {
            addSharedFilter("t.business_id = ?", "tq.business_id = ?", businessId);
        }

        if (startDate) {
            addSharedFilter("t.created_at >= ?", "tq.created_at >= ?", startDate);
        }

        if (endDate) {
            const endDateTime = new Date(endDate);
            endDateTime.setHours(23, 59, 59, 999);
            addSharedFilter("t.created_at <= ?", "tq.created_at <= ?", endDateTime.toISOString());
        }

        if (reference) {
            addSharedFilter("t.reference ILIKE ?", "tq.reference ILIKE ?", `%${reference}%`);
        }

        if (status && status !== 'all') {
            addSharedFilter("t.status = ?", "tq.status = ?", status);
        }

        const transactionWhere = transactionFilters.length
            ? `WHERE ${transactionFilters.join(" AND ")}`
            : "";

        // Base exclusions for the transactions side of the UNION:
        //  - transaction_type='platform' rows are the internal pool ledger —
        //    never user-facing transactions.
        //  - transaction_type='transfer' rows duplicate the transfer_queue
        //    side of this UNION (every transfer is queued; the txn row only
        //    mirrors its wallet debit), which made every transfer appear TWICE
        //    in the admin history.
        // Platform ledger rows can still be inspected on the Platform Wallet
        // page (/admin/wallet/history).
        const transactionBase =
            "t.transaction_type IS DISTINCT FROM 'platform' AND t.transaction_type IS DISTINCT FROM 'transfer'";
        const transactionsWhereFinal = transactionWhere
            ? `${transactionWhere} AND ${transactionBase}`
            : `WHERE ${transactionBase}`;
        const transferWhere = transferFilters.length ? `WHERE ${transferFilters.join(" AND ")}` : "";

        const transactionsQuery = `
            SELECT
                t.id,
                t.business_id,
                t.user_id,
                t.amount,
                t.currency,
                t.status,
                t.reference,
                t.type,
                t.description,
                t.transaction_type,
                t.wallet_id,
                t.direction,
                t.fee,
                t.payment_provider,
                t.created_at,
                t.updated_at,
                b.name as business_name,
                b.email as business_email,
                p.name as plan_name,
                'transaction' as source,
                NULL::varchar as recipient_account,
                NULL::varchar as recipient_bank,
                NULL::varchar as recipient_name,
                NULL::text as failure_reason
            FROM transactions t
            LEFT JOIN businesses b ON t.business_id = b.id
            LEFT JOIN pricing_plans p ON t.plan_id = p.id
            ${transactionsWhereFinal}
        `;

        const transfersQuery = `
            SELECT
                tq.id,
                tq.business_id,
                tq.initiated_by as user_id,
                tq.amount,
                tq.currency,
                tq.status,
                tq.reference,
                'debit' as type,
                tq.remark as description,
                'transfer' as transaction_type,
                tq.wallet_id,
                'debit' as direction,
                0::numeric as fee,
                tq.payment_provider,
                tq.created_at,
                tq.updated_at,
                b.name as business_name,
                b.email as business_email,
                NULL::varchar as plan_name,
                'transfer_queue' as source,
                tq.recipient_account,
                tq.recipient_bank,
                tq.recipient_name,
                tq.failure_reason
            FROM transfer_queue tq
            LEFT JOIN businesses b ON tq.business_id = b.id
            ${transferWhere}
        `;

        // Combine both queries with UNION ALL, sort, then paginate
        const limitParam = params.length + 1;
        const offsetParam = params.length + 2;
        const combinedQuery = `
            WITH combined AS (
                ${transactionsQuery}
                UNION ALL
                ${transfersQuery}
            )
            SELECT * FROM combined
            ORDER BY created_at DESC
            LIMIT $${limitParam} OFFSET $${offsetParam}
        `;
        const combinedParams = [...params, perPage, offset];

        const result = await query(combinedQuery, combinedParams);

        // Get total count
        const countQuery = `
            WITH combined AS (
                ${transactionsQuery}
                UNION ALL
                ${transfersQuery}
            )
            SELECT COUNT(*) as total FROM combined
        `;
        const countResult = await query(countQuery, params);
        const total = parseInt(countResult.rows[0].total);

        res.json({ 
            success: true, 
            transactions: result.rows,
            pagination: {
                total,
                page,
                perPage,
                totalPages: Math.ceil(total / perPage),
                pages: Math.ceil(total / perPage)
            }
        });

    } catch (error) {
        console.error("Admin transactions error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch transactions" });
    }
});

// Pending Settlements
/**
 * @swagger
 * /admin/transactions/pending-settlement:
 *   get:
 *     summary: Get transactions requiring settlement
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [all, pending, settled]
 *           default: pending
 *         description: Filter by settlement status
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: List of transactions with settlement info
 */
protectedRouter.get("/transactions/pending-settlement", requirePermission('view_dashboard'), async (req, res) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = (page - 1) * limit;

        const search = req.query.search as string;
        const status = (req.query.status as string)?.toLowerCase() || 'pending';
        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;

        const params: any[] = []; 
        let paramIndex = 1; 

        let whereClause = `WHERE 1=1`;

        // Status Filter
        if (status === 'pending') {
            whereClause += ` AND s.status = 'pending'`;
        } else if (status === 'settled') {
            whereClause += ` AND s.status = 'settled'`;
        }
        // If status === 'all', we don't add a status filter

        // Search Filter
        if (search) {
            whereClause += ` AND (t.reference ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex} OR b.name ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        // Date Range Filter
        if (startDate) {
            whereClause += ` AND s.created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            const endDateTime = new Date(endDate);
            endDateTime.setHours(23, 59, 59, 999);
            whereClause += ` AND s.created_at <= $${paramIndex}`;
            params.push(endDateTime.toISOString());
            paramIndex++;
        }

        // Count Query
        const countQueryText = `
            SELECT COUNT(*) 
            FROM settlements s
            JOIN transactions t ON s.transaction_id = t.id
            LEFT JOIN users u ON t.user_id = u.id 
            LEFT JOIN businesses b ON t.business_id = b.id 
            ${whereClause}
        `;
        
        const countRes = await query(countQueryText, params);
        const total = parseInt(countRes.rows[0].count);

        // Data Query
        const queryText = `
            SELECT 
                t.*, 
                s.status as settlement_status,
                s.id as settlement_id,
                s.created_at as settlement_date,
                u.email as user_email, 
                u.name as user_name,
                b.name as business_name 
            FROM settlements s
            JOIN transactions t ON s.transaction_id = t.id
            LEFT JOIN users u ON t.user_id = u.id 
            LEFT JOIN businesses b ON t.business_id = b.id 
            ${whereClause}
            ORDER BY s.created_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        params.push(limit, offset);

        const result = await query(queryText, params);

        res.json({
            success: true,
            transactions: result.rows,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error("Get Pending Settlements Error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch pending settlements" });
    }
});

// Manual Settlement
/**
 * @swagger
 * /admin/transactions/settle:
 *   post:
 *     summary: Manually settle a transaction
 *     tags: [Admin]
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
 *         description: Transaction settled
 */
protectedRouter.post("/transactions/settle", requirePermission('manage_businesses'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { reference, force } = req.body;
        
        if (!reference) {
            client.release();
            return res.status(400).json({ success: false, error: "Reference is required" });
        }

        // 1. Fetch Transaction
        const txRes = await query(`SELECT * FROM transactions WHERE reference = $1`, [reference]);
        if (txRes.rows.length === 0) {
            client.release();
            return res.status(404).json({ success: false, error: "Transaction not found" });
        }
        const transaction = txRes.rows[0];

        // 2. Check/Create Settlement Record
        let settlementRes = await query(`SELECT * FROM settlements WHERE transaction_id = $1`, [transaction.id]);
        let settlement = settlementRes.rows[0];

        if (!settlement) {
             // Create default pending settlement
             const sRes = await query(`
                INSERT INTO settlements (transaction_id, business_id, user_id, amount, status)
                VALUES ($1, $2, $3, $4, 'pending')
                RETURNING *
             `, [transaction.id, transaction.business_id, transaction.user_id, transaction.amount]);
             settlement = sRes.rows[0];
        }

        if (settlement.status === 'settled' && !force) {
             client.release();
             return res.status(400).json({ success: false, error: "Transaction already settled. Use force to override." });
        }

        // 3. Resolve Wallet ID if missing
        let userWalletId = transaction.wallet_id;
        if (!userWalletId && transaction.user_id) {
             const wRes = await query(`SELECT id FROM wallets WHERE user_id = $1`, [transaction.user_id]);
             if (wRes.rows.length > 0) {
                  userWalletId = wRes.rows[0].id;
             }
        }
        
        if (!userWalletId) {
             client.release();
             return res.status(400).json({ success: false, error: "User wallet not found for this transaction" });
        }

        // 4. Atomic Settlement Execution
        await client.query('BEGIN');

        // Check Platform Wallet
        const platformWalletRes = await client.query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
        let platformWalletId;
        if (platformWalletRes.rows.length === 0) {
             const newWallet = await client.query(`INSERT INTO wallets (status, currency) VALUES ('active', 'NGN') RETURNING id`);
             platformWalletId = newWallet.rows[0].id;
        } else {
             platformWalletId = platformWalletRes.rows[0].id;
        }

        // Check if Platform was already debited for this specific transaction
        const platTxCheck = await client.query(
            `SELECT id FROM transactions WHERE reference = $1 AND wallet_id = $2 AND type = 'debit'`,
            [`${reference}-PLATFORM`, platformWalletId]
        );
        const platformDebited = platTxCheck.rows.length > 0;

        let creditUser = false;
        let debitPlatform = false;
        let settlementNote = "Manual Settlement";

        if (platformDebited) {
             // Platform already debited. Likely partial failure where User wasn't credited.
             // We MUST credit user to fix the state.
             creditUser = true;
             settlementNote += " (Fix: User Credit Only)";
             
             // Safety check: If transaction was success, maybe user WAS credited?
             // But if admin is running this, we assume they verified user wasn't credited.
             // If 'force' is not used, we warn if it looks suspicious.
             if (transaction.status === 'success' && !force) {
                  await client.query('ROLLBACK');
                  client.release();
                  return res.status(400).json({ success: false, error: "Transaction marked success & Platform debited. Potentially already settled. Use 'force' to credit user anyway." });
             }
        } else {
             // Platform NOT debited.
             debitPlatform = true;
             
             if (transaction.status === 'success') {
                  // Transaction is success, but Platform not debited.
                  // This implies User was credited (normal flow) but Platform debit failed or wasn't done.
                  // So we only debit platform.
                  creditUser = false;
                  settlementNote += " (Fix: Platform Debit Only)";
                  
                  if (force) {
                       creditUser = true; // Force credit user too
                       settlementNote += " + Force Credit";
                  }
             } else {
                  // Transaction is pending/failed. Full settlement needed.
                  creditUser = true;
                  settlementNote += " (Full)";
             }
        }

        // Execute Actions
        if (creditUser) {
             const creditRes = await client.query(
                `UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
                [transaction.amount, userWalletId]
             );
             if (creditRes.rowCount === 0) {
                  throw new Error(`User wallet ${userWalletId} update failed (row count 0)`);
             }
        }

        if (debitPlatform) {
             await client.query(
                `UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2`,
                [transaction.amount, platformWalletId]
             );
             
             await client.query(
                `INSERT INTO transactions
                (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction)
                VALUES ($1, $2, 'success', $3, 'debit', $4, 'platform', $5, 'debit')`,
                [transaction.amount, transaction.currency || 'NGN', `${reference}-PLATFORM`, `Platform Wallet Debit for ${reference}`, platformWalletId]
            );
        }

        // Update Transaction Status
        await client.query(
            `UPDATE transactions SET status = 'success', description = description || $1, updated_at = NOW() WHERE id = $2`,
            [` - ${settlementNote}`, transaction.id]
        );

        // Update Settlement Status
        await client.query(
            `UPDATE settlements SET status = 'settled', updated_at = NOW() WHERE id = $1`,
            [settlement.id]
        );

        await client.query('COMMIT');
        client.release();

        res.json({ 
            success: true, 
            message: "Transaction settled successfully",
            details: settlementNote
        });

    } catch (error: any) {
        if (client) {
            await client.query('ROLLBACK');
            client.release();
        }
        console.error("Manual Settlement Error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to settle transaction" });
    }
});

/**
 * @swagger
 * /admin/businesses/{id}/status:
 *   put:
 *     summary: Update business status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Status updated
 */
protectedRouter.put("/businesses/:id/status", requirePermission('manage_businesses'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'active', 'inactive'
    await query(`UPDATE businesses SET subscription_status = $1 WHERE id = $2`, [status, id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to update business status" });
  }
});

// Plan Features (Permissions)
/**
 * @swagger
 * /admin/features:
 *   get:
 *     summary: Get all available plan features/permissions
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available features
 */
protectedRouter.get("/features", requirePermission('manage_plans'), async (req, res) => {
  res.json({ success: true, features: AVAILABLE_PERMISSIONS });
});

// RBAC: Permissions Management
/**
 * @swagger
 * /admin/permissions:
 *   get:
 *     summary: Get all available permissions
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of permissions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 permissions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       slug:
 *                         type: string
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 */
protectedRouter.get("/permissions", requirePermission('manage_roles'), async (req, res) => {
  try {
    const result = await query(`SELECT * FROM admin_permissions ORDER BY name ASC`);
    res.json({ success: true, permissions: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch permissions" });
  }
});

// RBAC: Roles Management
/**
 * @swagger
 * /admin/roles:
 *   get:
 *     summary: Get all admin roles
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of roles with permissions
 */
protectedRouter.get("/roles", requirePermission('manage_roles'), async (req, res) => {
  try {
    // Get roles with their permission slugs
    const result = await query(`
      SELECT r.*, 
             COALESCE(array_agg(p.slug) FILTER (WHERE p.slug IS NOT NULL), '{}') as permissions
      FROM admin_roles r
      LEFT JOIN admin_role_permissions arp ON r.id = arp.role_id
      LEFT JOIN admin_permissions p ON arp.permission_id = p.id
      GROUP BY r.id
      ORDER BY r.name ASC
    `);
    res.json({ success: true, roles: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch roles" });
  }
});

/**
 * @swagger
 * /admin/roles:
 *   post:
 *     summary: Create a new admin role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of permission slugs
 *     responses:
 *       200:
 *         description: Role created
 */
protectedRouter.post("/roles", requirePermission('manage_roles'), async (req, res) => {
  try {
    const { name, description, permissions } = req.body; // permissions is array of slugs

    // Start transaction (simple version without explicit BEGIN/COMMIT for now, but careful order)
    // 1. Create Role
    const roleRes = await query(
      `INSERT INTO admin_roles (name, description) VALUES ($1, $2) RETURNING id`,
      [name, description]
    );
    const roleId = roleRes.rows[0].id;

    // 2. Map Permissions
    if (permissions && Array.isArray(permissions) && permissions.length > 0) {
      // Get IDs for these slugs
      // This assumes frontend sends slugs. Alternatively frontend can send IDs.
      // Let's assume slugs as they are more readable in API.
      const permIdsRes = await query(`SELECT id FROM admin_permissions WHERE slug = ANY($1)`, [permissions]);
      
      for (const row of permIdsRes.rows) {
        await query(
          `INSERT INTO admin_role_permissions (role_id, permission_id) VALUES ($1, $2)`,
          [roleId, row.id]
        );
      }
    }

    res.json({ success: true, roleId });
  } catch (error) {
    console.error("Create role error:", error);
    res.status(500).json({ success: false, error: "Failed to create role" });
  }
});

/**
 * @swagger
 * /admin/roles/{id}:
 *   put:
 *     summary: Update an admin role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Role updated
 */
protectedRouter.put("/roles/:id", requirePermission('manage_roles'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, permissions } = req.body;

    // Check if super admin
    const check = await query(`SELECT is_super_admin FROM admin_roles WHERE id = $1`, [id]);
    if (check.rows.length > 0 && check.rows[0].is_super_admin) {
       return res.status(403).json({ success: false, error: "Cannot modify Super Admin role" });
    }

    await query(
      `UPDATE admin_roles SET name = $1, description = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [name, description, id]
    );

    // Update permissions: Delete old, Insert new
    await query(`DELETE FROM admin_role_permissions WHERE role_id = $1`, [id]);

    if (permissions && Array.isArray(permissions) && permissions.length > 0) {
      const permIdsRes = await query(`SELECT id FROM admin_permissions WHERE slug = ANY($1)`, [permissions]);
      for (const row of permIdsRes.rows) {
        await query(
          `INSERT INTO admin_role_permissions (role_id, permission_id) VALUES ($1, $2)`,
          [id, row.id]
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to update role" });
  }
});

/**
 * @swagger
 * /admin/roles/{id}:
 *   delete:
 *     summary: Delete an admin role
 *     tags: [Admin]
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
 *         description: Role deleted
 */
protectedRouter.delete("/roles/:id", requirePermission('manage_roles'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if super admin
    const check = await query(`SELECT is_super_admin FROM admin_roles WHERE id = $1`, [id]);
    if (check.rows.length > 0 && check.rows[0].is_super_admin) {
       return res.status(403).json({ success: false, error: "Cannot delete Super Admin role" });
    }

    // Check if assigned to any user
    const userCheck = await query(`SELECT COUNT(*) FROM platform_admins WHERE role_id = $1`, [id]);
    if (parseInt(userCheck.rows[0].count) > 0) {
      return res.status(400).json({ success: false, error: "Cannot delete role assigned to users" });
    }

    await query(`DELETE FROM admin_roles WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to delete role" });
  }
});

// RBAC: Admin Users Management
/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: Get all admin users
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of admin users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 admins:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       name:
 *                         type: string
 *                       email:
 *                         type: string
 *                       status:
 *                         type: string
 *                       role_name:
 *                         type: string
 *                       role_id:
 *                         type: string
 *                         format: uuid
 *                       created_at:
 *                         type: string
 *                         format: date-time
 */
protectedRouter.get("/users", requirePermission('manage_admins'), async (req, res) => {
  try {
    const result = await query(`
      SELECT a.id, a.name, a.email, a.status, a.created_at, r.name as role_name, r.id as role_id
      FROM platform_admins a
      LEFT JOIN admin_roles r ON a.role_id = r.id
      ORDER BY a.created_at DESC
    `);
    res.json({ success: true, admins: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch admins" });
  }
});

/**
 * @swagger
 * /admin/users/invite:
 *   post:
 *     summary: Invite a new admin user
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - roleId
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               roleId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Admin invited successfully
 */
protectedRouter.post("/users/invite", requirePermission('manage_admins'), async (req, res) => {
  try {
    const { name, email, roleId } = req.body;

    // Check if exists
    const check = await query(`SELECT id FROM platform_admins WHERE email = $1`, [email]);
    if (check.rows.length > 0) {
      return res.status(400).json({ success: false, error: "Admin with this email already exists" });
    }

    // Create temp password
    const tempPassword = Math.random().toString(36).slice(-8);
    // hashPassword is async — the missing `await` previously persisted "{}"
    // as password_hash, making the generated temp password unusable.
    const hashed = await hashPassword(tempPassword);

    await query(
      `INSERT INTO platform_admins (name, email, password_hash, role_id, status) VALUES ($1, $2, $3, $4, 'pending_invite')`,
      [name, email, hashed, roleId]
    );

    // Send email
    let baseUrl = process.env.ADMIN_URL || process.env.CLIENT_URL || process.env.APP_BASE_URL || process.env.APP_URL;

    // If no env var, try to infer from request origin (useful for dev/ngrok)
    if (!baseUrl && req.get('origin')) {
      baseUrl = req.get('origin');
    }

    if (!baseUrl) {
      throw new Error('ADMIN_URL or CLIENT_URL environment variable is not set and no origin header available');
    }

    const loginLink = baseUrl.includes('/login') ? baseUrl : `${baseUrl}/login`;
    const emailHtml = generateAdminInviteEmailHtml(name, email, tempPassword, loginLink);

    // Email is best-effort: the admin record is already created, so an
    // SMTP/Brevo outage must NOT fail the invitation. The caller can resend
    // or share the temp password through a secure channel.
    let emailSent = false;
    try {
      emailSent = await sendEmail(
        email,
        name,
        "Admin Access Invitation",
        emailHtml
      );
    } catch (emailError) {
      console.error("Admin invite email threw an error:", emailError);
    }
    if (!emailSent) {
      console.error(`Failed to send admin invite email to ${email}`);
    }

    res.json({
      success: true,
      emailSent,
      message: emailSent
        ? "Admin invited"
        : "Admin created, but the invitation email could not be delivered. Share the credentials manually or resend later.",
    });
  } catch (error) {
    console.error("Invite admin error:", error);
    res.status(500).json({ success: false, error: "Failed to invite admin" });
  }
});

/**
 * @swagger
 * /admin/users/{id}:
 *   put:
 *     summary: Update an admin user's role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - roleId
 *             properties:
 *               roleId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Admin updated
 */
protectedRouter.put("/users/:id", requirePermission('manage_admins'), async (req, res) => {
  try {
    const { id } = req.params;
    const { roleId } = req.body;

    // Prevent modifying Super Admin user if not Super Admin? 
    // Generally, only Super Admins have 'manage_admins' permission usually, or we can enforce that.
    
    // Check target user
    const targetUser = await query(`SELECT email FROM platform_admins WHERE id = $1`, [id]);
    if (targetUser.rows.length > 0 && targetUser.rows[0].email === 'admin@quantigrate.com') {
        // Protect the main super admin
        return res.status(403).json({ success: false, error: "Cannot modify root Super Admin" });
    }

    await query(`UPDATE platform_admins SET role_id = $1 WHERE id = $2`, [roleId, id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to update admin" });
  }
});

/**
 * @swagger
 * /admin/users/{id}/status:
 *   put:
 *     summary: Update an admin user's status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [active, inactive, pending_invite]
 *     responses:
 *       200:
 *         description: Admin status updated
 */
protectedRouter.put("/users/:id/status", requirePermission('manage_admins'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate status
    if (!['active', 'inactive', 'pending_invite'].includes(status)) {
        return res.status(400).json({ success: false, error: "Invalid status" });
    }

    // Protect root super admin
    const targetUser = await query(`SELECT email FROM platform_admins WHERE id = $1`, [id]);
    if (targetUser.rows.length > 0 && targetUser.rows[0].email === 'admin@quantigrate.com') {
        return res.status(403).json({ success: false, error: "Cannot modify root Super Admin status" });
    }

    await query(`UPDATE platform_admins SET status = $1 WHERE id = $2`, [status, id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to update admin status" });
  }
});

/**
 * @swagger
 * /admin/users/{id}:
 *   delete:
 *     summary: Delete an admin user
 *     tags: [Admin]
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
 *         description: Admin deleted
 */
protectedRouter.delete("/users/:id", requirePermission('manage_admins'), async (req, res) => {
  try {
    const { id } = req.params;
    const adminReq = req as AuthenticatedAdminRequest;
    
    // Protect root super admin
    const targetUser = await query(`SELECT email FROM platform_admins WHERE id = $1`, [id]);
    if (targetUser.rows.length > 0 && targetUser.rows[0].email === 'admin@quantigrate.com') {
        return res.status(403).json({ success: false, error: "Cannot delete root Super Admin" });
    }

    // Prevent deleting self
    if (adminReq.admin?.adminId === id) {
        return res.status(400).json({ success: false, error: "Cannot delete yourself" });
    }

    await query(`DELETE FROM platform_admins WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to delete admin" });
  }
});

// System Settings
/**
 * @swagger
 * /admin/settings/card-verification-amount:
 *   get:
 *     summary: Get card verification amount
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Card verification amount
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 amount:
 *                   type: integer
 */
protectedRouter.get("/settings/card-verification-amount", async (req, res) => {
    try {
        const result = await query(`SELECT value FROM system_settings WHERE key = 'card_verification_amount'`);
        const amount = result.rows.length > 0 ? parseInt(result.rows[0].value) : 100;
        res.json({ success: true, amount });
    } catch (error) {
        console.error("Error fetching card verification amount:", error);
        res.status(500).json({ success: false, error: "Failed to fetch settings" });
    }
});

/**
 * @swagger
 * /admin/settings/card-verification-amount:
 *   put:
 *     summary: Update card verification amount
 *     tags: [Admin]
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
 *             properties:
 *               amount:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Settings updated
 */
protectedRouter.put("/settings/card-verification-amount", async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || isNaN(amount) || amount < 50) {
            return res.status(400).json({ success: false, error: "Invalid amount. Minimum is 50." });
        }
        
        await query(
            `INSERT INTO system_settings (key, value, description) 
             VALUES ('card_verification_amount', $1, 'Amount charged for card verification in Naira')
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
            [amount.toString()]
        );
        
        res.json({ success: true, message: "Card verification amount updated" });
    } catch (error) {
        console.error("Error updating card verification amount:", error);
        res.status(500).json({ success: false, error: "Failed to update settings" });
    }
});

// Helper for CSV download
const sendCSV = (res: any, data: any[], filename: string) => {
    const ws = XLSX.utils.json_to_sheet(data);
    const csv = XLSX.utils.sheet_to_csv(ws);
    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
};

// Webhook Notifications
/**
 * @swagger
 * /admin/webhooks:
 *   get:
 *     summary: Get webhook notifications
 *     tags: [Admin]
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
 *       - in: query
 *         name: provider
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Webhook notifications
 */
protectedRouter.get("/webhooks", async (req, res) => {
    try {
        const { page = 1, limit = 10, provider, status, startDate, endDate, search } = req.query;
        const offset = (Number(page) - 1) * Number(limit);
        
        let queryStr = `SELECT * FROM squad_webhooks WHERE 1=1`;
        const params: any[] = [];
        let paramCount = 1;

        if (provider) {
            queryStr += ` AND provider = $${paramCount}`;
            params.push(provider);
            paramCount++;
        }

        if (status) {
            queryStr += ` AND status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (startDate) {
            queryStr += ` AND created_at >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
        }

        if (endDate) {
            queryStr += ` AND created_at <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
        }

        if (search) {
            queryStr += ` AND payload::text ILIKE $${paramCount}`;
            params.push(`%${search}%`);
            paramCount++;
        }

        const countQuery = `SELECT COUNT(*) FROM (${queryStr}) as count_table`;
        const countRes = await query(countQuery, params);
        const total = parseInt(countRes.rows[0].count);

        let reportQuery = `SELECT COALESCE(provider, 'squad') as provider, status, COUNT(*)::int as count FROM squad_webhooks WHERE 1=1`;
        const reportParams: any[] = [];
        let reportParamCount = 1;

        if (status) {
            reportQuery += ` AND status = $${reportParamCount}`;
            reportParams.push(status);
            reportParamCount++;
        }

        if (startDate) {
            reportQuery += ` AND created_at >= $${reportParamCount}`;
            reportParams.push(startDate);
            reportParamCount++;
        }

        if (endDate) {
            reportQuery += ` AND created_at <= $${reportParamCount}`;
            reportParams.push(endDate);
            reportParamCount++;
        }

        if (search) {
            reportQuery += ` AND payload::text ILIKE $${reportParamCount}`;
            reportParams.push(`%${search}%`);
            reportParamCount++;
        }

        reportQuery += ` GROUP BY COALESCE(provider, 'squad'), status ORDER BY provider ASC, status ASC`;
        const reportRes = await query(reportQuery, reportParams);

        queryStr += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(limit, offset);

        const result = await query(queryStr, params);

        res.json({
            success: true,
            webhooks: result.rows,
            provider_reports: reportRes.rows,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (error) {
        console.error("Get webhooks error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch webhooks" });
    }
});

// Export Transactions (Admin)
/**
 * @swagger
 * /admin/reports/transactions/export:
 *   get:
 *     summary: Export transactions to CSV
 *     tags: [Admin]
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
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Transaction status
 */
protectedRouter.get("/reports/transactions/export", async (req, res) => {
    try {
        const { startDate, endDate, status } = req.query;
        let queryStr = `
            SELECT t.*, b.name as business_name, b.email as business_email, p.name as plan_name
            FROM transactions t
            LEFT JOIN businesses b ON t.business_id = b.id
            LEFT JOIN pricing_plans p ON t.plan_id = p.id
            WHERE 1=1
        `;
        const params: any[] = [];
        let paramCount = 1;

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

        sendCSV(res, result.rows, `transactions_admin_${Date.now()}.csv`);
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to export transactions" });
    }
});

// Export Business Users (Admin)
/**
 * @swagger
 * /admin/reports/businesses/export:
 *   get:
 *     summary: Export businesses to CSV
 *     tags: [Admin]
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
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Subscription status
 */
protectedRouter.get("/reports/businesses/export", async (req, res) => {
    try {
        const { startDate, endDate, status } = req.query;
        let queryStr = `
            SELECT b.*, p.name as plan_name
            FROM businesses b
            LEFT JOIN pricing_plans p ON b.plan_id = p.id
            WHERE 1=1
        `;
        const params: any[] = [];
        let paramCount = 1;

        if (startDate) {
            queryStr += ` AND b.created_at >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
        }
        if (endDate) {
            queryStr += ` AND b.created_at <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
        }
        if (status) {
            queryStr += ` AND b.subscription_status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        queryStr += ` ORDER BY b.created_at DESC`;
        const result = await query(queryStr, params);

        sendCSV(res, result.rows, `businesses_admin_${Date.now()}.csv`);
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to export businesses" });
    }
});

// Migration: Recreate Business IDs
/**
 * @swagger
 * /admin/migrate-business-ids:
 *   post:
 *     summary: Recreate all business IDs to updated format
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
protectedRouter.post("/migrate-business-ids", requirePermission('manage_businesses'), async (req, res) => {
    try {
        // 1. Fetch all businesses
        const businesses = await query(`SELECT id, name FROM businesses`);
        
        // 2. Prepare tables for Cascade Update
        const tables = ['users', 'tasks', 'transactions', 'epics', 'activity_logs', 'ideas', 'payment_cards'];
        
        for (const table of tables) {
            // Drop existing FK and Add with ON UPDATE CASCADE
            try {
                // Drop by standard name guess
                await query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_business_id_fkey`);
                // Re-add
                await query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE ON UPDATE CASCADE`);
            } catch (err) {
                console.log(`Failed to update constraint for ${table}:`, err);
            }
        }

        let updatedCount = 0;
        const errors = [];

        // 3. Update IDs
        for (const business of businesses.rows) {
            const oldId = business.id;
            const newId = generateBusinessId(business.name);
            
            if (oldId !== newId) {
                try {
                    // Check if newId exists
                    const check = await query(`SELECT id FROM businesses WHERE id = $1`, [newId]);
                    if (check.rows.length > 0) {
                        console.log(`ID collision for ${business.name}: ${newId}`);
                        continue;
                    }

                    await query(`UPDATE businesses SET id = $1 WHERE id = $2`, [newId, oldId]);
                    updatedCount++;
                } catch (err: any) {
                    errors.push({ id: oldId, name: business.name, error: err.message });
                }
            }
        }

        res.json({ success: true, message: `Updated ${updatedCount} businesses`, errors });
    } catch (error) {
        console.error("Migration error:", error);
        res.status(500).json({ success: false, error: "Failed to migrate business IDs" });
    }
});

/**
 * @swagger
 * /admin/subscription/manual-upgrade:
 *   post:
 *     summary: Manually upgrade a business plan (No expiry)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessId
 *               - planId
 *             properties:
 *               businessId:
 *                 type: string
 *               planId:
 *                 type: string
 */
protectedRouter.post("/subscription/manual-upgrade", requirePermission('manage_plans'), async (req, res) => {
    try {
        const { businessId, planId } = req.body;

        if (!businessId || !planId) {
            return res.status(400).json({ success: false, error: "Business ID and Plan ID are required" });
        }

        // Verify plan exists
        const planCheck = await query(`SELECT id, name FROM pricing_plans WHERE id = $1`, [planId]);
        if (planCheck.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Plan not found" });
        }

        // Update business
        // Set next_billing_date to NULL (Never expires)
        // Set is_manual_subscription to TRUE
        await query(
            `UPDATE businesses 
             SET plan_id = $1, 
                 subscription_status = 'active', 
                 next_billing_date = NULL, 
                 is_manual_subscription = TRUE,
                 updated_at = NOW() 
             WHERE id = $2`,
            [planId, businessId]
        );

        res.json({ success: true, message: `Business upgraded to ${planCheck.rows[0].name} (Manual)` });
    } catch (error) {
        console.error("Manual upgrade error:", error);
        res.status(500).json({ success: false, error: "Failed to upgrade business" });
    }
});

/**
 * @swagger
 * /admin/subscription/manual-upgrade/revoke:
 *   post:
 *     summary: Revoke manual upgrade and revert to Free/Inactive
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - businessId
 *             properties:
 *               businessId:
 *                 type: string
 */
protectedRouter.post("/subscription/manual-upgrade/revoke", requirePermission('manage_plans'), async (req, res) => {
    try {
        const { businessId } = req.body;

        if (!businessId) {
            return res.status(400).json({ success: false, error: "Business ID is required" });
        }

        // Find Free Plan
        const freePlan = await query(`SELECT id FROM pricing_plans WHERE price = 0 LIMIT 1`);
        let targetPlanId = null;
        let status = 'inactive';

        if (freePlan.rows.length > 0) {
            targetPlanId = freePlan.rows[0].id;
            status = 'active';
        }

        // Revert business
        await query(
            `UPDATE businesses 
             SET plan_id = $1, 
                 subscription_status = $2, 
                 next_billing_date = NOW(), 
                 is_manual_subscription = FALSE,
                 updated_at = NOW() 
             WHERE id = $3`,
            [targetPlanId, status, businessId]
        );

        res.json({ success: true, message: "Manual upgrade revoked" });
    } catch (error) {
        console.error("Revoke upgrade error:", error);
        res.status(500).json({ success: false, error: "Failed to revoke upgrade" });
    }
});

/**
 * @swagger
 * /admin/transfers:
 *   get:
 *     summary: Get all transfers (queue)
 *     tags: [Admin]
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
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: businessId
 *         schema:
 *           type: string
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by reference, recipient name/account, business name/email
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by start date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by end date (YYYY-MM-DD)
 *     responses:
 *       200:
 *         description: List of transfers
 */
protectedRouter.get("/transfers", requirePermission('view_dashboard'), async (req, res) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = (page - 1) * limit;

        const status = req.query.status as string;
        const businessId = req.query.businessId as string;
        const search = req.query.search as string;
        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;

        let queryText = `
            SELECT t.*, b.name as business_name, b.email as business_email
            FROM transfer_queue t
            LEFT JOIN businesses b ON t.business_id = b.id
            WHERE 1=1
        `;
        const queryParams: any[] = [];
        let paramIndex = 1;

        if (businessId) {
            queryText += ` AND t.business_id = $${paramIndex}`;
            queryParams.push(businessId);
            paramIndex++;
        }

        if (status) {
            queryText += ` AND t.status = $${paramIndex}`;
            queryParams.push(status);
            paramIndex++;
        }

        if (search) {
            queryText += ` AND (t.reference ILIKE $${paramIndex} OR t.recipient_account ILIKE $${paramIndex} OR t.recipient_name ILIKE $${paramIndex} OR b.name ILIKE $${paramIndex} OR b.email ILIKE $${paramIndex})`;
            queryParams.push(`%${search}%`);
            paramIndex++;
        }

        if (startDate) {
            queryText += ` AND t.created_at >= $${paramIndex}`;
            queryParams.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            const endDateTime = new Date(endDate);
            endDateTime.setHours(23, 59, 59, 999);
            queryText += ` AND t.created_at <= $${paramIndex}`;
            queryParams.push(endDateTime.toISOString());
            paramIndex++;
        }

        // Count
        const whereClause = queryText.substring(queryText.indexOf("WHERE"));
        const countQuery = `SELECT COUNT(*) FROM transfer_queue t LEFT JOIN businesses b ON t.business_id = b.id ${whereClause}`;
        const countRes = await query(countQuery, queryParams);
        const total = parseInt(countRes.rows[0].count);

        queryText += ` ORDER BY t.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        queryParams.push(limit, offset);

        const result = await query(queryText, queryParams);

        res.json({
            success: true,
            transfers: result.rows,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error("Admin transfers error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch transfers" });
    }
});

/**
 * POST /admin/transfers/:id/reverse — platform-admin "click to reverse".
 *
 * Reverses a FAILED transfer from the admin console (Admin → Transfers).
 * Uses the same idempotent, claim-first reverseFailedTransfer() helper the
 * webhook/monitor paths use, so double-clicks and races are safe. The
 * provider's live status is re-checked first: a transfer Flutterwave reports
 * as SUCCESSFUL must NEVER be reversed (money was actually delivered).
 */
protectedRouter.post("/transfers/:id/reverse", requirePermission('manage_businesses'), async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body || {};
        if (!id) {
            return res.status(400).json({ success: false, error: "Transfer id is required" });
        }

        const transferRes = await query(`SELECT * FROM transfer_queue WHERE id::text = $1 OR reference = $1 LIMIT 1`, [id]);
        if (transferRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Transfer not found" });
        }
        const transfer = transferRes.rows[0];

        if (transfer.status === 'success') {
            return res.status(409).json({ success: false, error: "This transfer succeeded — it cannot be reversed" });
        }
        if (transfer.status !== 'failed') {
            return res.status(409).json({ success: false, error: `Only failed transfers can be reversed (this one is "${transfer.status}")` });
        }
        if (!transfer.wallet_id) {
            return res.status(409).json({ success: false, error: "This transfer is not linked to a wallet — nothing to reverse" });
        }

        // Double-check with the provider before touching money: if the live
        // status is SUCCESSFUL, refuse (the failure signal was stale).
        try {
            // getProvider comes from the factory — import it lazily (this file
            // only imports adminAuth statically; a static import of the
            // provider factory here previously crashed tsc AND the runtime).
            const { getProvider } = await import("../services/providers/factory");
            const provider = getProvider(transfer.payment_provider);
            if (provider && typeof provider.verifyTransfer === 'function') {
                const verifyRes = await provider.verifyTransfer(transfer.reference, transfer.provider_metadata);
                const verified = verifyRes?.data || verifyRes;
                const liveStatus = String(verified?.status || '').toUpperCase();
                if (liveStatus === 'SUCCESSFUL') {
                    await query(
                        `UPDATE transfer_queue SET status = 'success', failure_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                        [transfer.id]
                    );
                    return res.status(409).json({ success: false, error: "Provider reports this transfer as SUCCESSFUL — reversal refused and the transfer was re-marked successful" });
                }
            }
        } catch (verifyErr: any) {
            // Provider verify is best-effort — a network error must not block
            // the reversal of a transfer already known to be failed.
            console.warn(`[admin] provider verify before reversal failed for ${transfer.reference}:`, verifyErr?.message);
        }

        const reversed = await reverseFailedTransfer(
            transfer,
            reason ? `Admin reversal: ${String(reason).slice(0, 200)}` : 'Admin reversal from Admin Console'
        );
        if (!reversed) {
            // reverseFailedTransfer returns false when the refund row already
            // exists (already reversed) — surface that honestly.
            const refundCheck = await query(
                `SELECT reference FROM transactions WHERE reference = $1 LIMIT 1`,
                [`${transfer.reference}-REFUND`]
            );
            if (refundCheck.rows.length > 0) {
                return res.status(409).json({ success: false, error: "This transfer was already reversed" });
            }
            return res.status(500).json({ success: false, error: "Reversal could not be completed — check the server logs" });
        }

        res.json({
            success: true,
            message: `Transfer ${transfer.reference} reversed — the full amount (including the fee) is back in the customer's wallet.`,
            data: { reference: transfer.reference }
        });
    } catch (error) {
        console.error("Admin reverse transfer error:", error);
        res.status(500).json({ success: false, error: "Failed to reverse transfer" });
    }
});

// KYC Management
/**
 * @swagger
 * /admin/kyc/pending:
 *   get:
 *     summary: Get pending KYC requests
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Pending KYC requests
 */
protectedRouter.get("/kyc/pending", requirePermission('manage_businesses'), async (req, res) => {
    try {
        const pendingUsers = await query(`
            SELECT id, name, email, business_id, kyc_status, kyc_data, bvn, nin, phone_number, created_at 
            FROM users 
            WHERE kyc_status IN ('pending_review', 'pending_otp') 
            ORDER BY created_at ASC
        `);

        const pendingBusinesses = await query(`
            SELECT id, name, email, kyc_status, proof_of_address_url, created_at 
            FROM businesses 
            WHERE kyc_status = 'pending_review' 
            ORDER BY created_at ASC
        `);

        res.json({
            success: true,
            users: pendingUsers.rows,
            businesses: pendingBusinesses.rows
        });
    } catch (error) {
        console.error("Admin KYC pending error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch pending KYC" });
    }
});

/**
 * @swagger
 * /admin/kyc/user/{id}:
 *   put:
 *     summary: Update User KYC status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [verified, rejected]
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Status updated
 */
protectedRouter.put("/kyc/user/:id", requirePermission('manage_businesses'), async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reason } = req.body;

        if (!['verified', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, error: "Invalid status" });
        }

        await query(
            `UPDATE users SET kyc_status = $1, otp_hash = NULL WHERE id = $2`,
            [status, id]
        );

        // If verified, ensure wallet exists
        if (status === 'verified') {
             // We can dynamically import or just replicate logic since this is admin route
             // Ideally we call a service. For now, lazy create on next login or just here.
             await query(
                `INSERT INTO wallets (user_id, balance, currency, status) 
                 VALUES ($1, 0.00, 'NGN', 'active') 
                 ON CONFLICT (user_id) DO NOTHING`,
                [id]
             );
        }

        // Send email notification (TODO)

        res.json({ success: true, message: `User KYC ${status}` });
    } catch (error) {
        console.error("Admin user KYC error:", error);
        res.status(500).json({ success: false, error: "Failed to update user KYC" });
    }
});

/**
 * @swagger
 * /admin/kyc/business/{id}:
 *   put:
 *     summary: Update Business KYC status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [verified, rejected]
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Status updated
 */
protectedRouter.put("/kyc/business/:id", requirePermission('manage_businesses'), async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reason } = req.body;

        if (!['verified', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, error: "Invalid status" });
        }

        await query(
            `UPDATE businesses SET kyc_status = $1 WHERE id = $2`,
            [status, id]
        );
        
        // If verified, ensure wallet exists
        if (status === 'verified') {
             await query(
                `INSERT INTO wallets (business_id, balance, currency, status) 
                 VALUES ($1, 0.00, 'NGN', 'active') 
                 ON CONFLICT (business_id) DO NOTHING`,
                [id]
             );
        }

        res.json({ success: true, message: `Business KYC ${status}` });
    } catch (error) {
        console.error("Admin business KYC error:", error);
        res.status(500).json({ success: false, error: "Failed to update business KYC" });
    }
});

// ==================== PAYMENT PROVIDER MANAGEMENT ====================

// Get payment providers overview (active provider, config status, stats)
protectedRouter.get("/payment-providers", async (req, res) => {
    try {
        const { getActiveProviderName, getActiveTransferProviderName, getAvailableProviders, getProviderConfigStatus } = await import("../services/providers/factory");
        const activeProvider = await getActiveProviderName();
        const transferProvider = await getActiveTransferProviderName();
        const configStatus = getProviderConfigStatus();

        // Stats per provider: transaction counts + volume + webhook log counts
        const txStats = await query(
            `SELECT payment_provider, COUNT(*)::int AS transactions,
                    COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) AS successful_volume
             FROM transactions
             WHERE payment_provider IS NOT NULL
             GROUP BY payment_provider`
        );
        const webhookStats = await query(
            `SELECT provider, COUNT(*)::int AS events FROM squad_webhooks GROUP BY provider`
        );
        const transferStats = await query(
            `SELECT payment_provider, COUNT(*)::int AS transfers FROM transfer_queue GROUP BY payment_provider`
        );

        const providers = getAvailableProviders().map((name) => {
            const tx = txStats.rows.find((r) => r.payment_provider === name) || {};
            const wh = webhookStats.rows.find((r) => r.provider === name) || {};
            const tr = transferStats.rows.find((r) => r.payment_provider === name) || {};
            return {
                name,
                isActive: name === activeProvider,
                configured: configStatus[name]?.configured ?? false,
                requiredEnv: configStatus[name]?.requiredEnv ?? [],
                transactionCount: tx.transactions || 0,
                successfulVolume: tx.successful_volume || 0,
                transferCount: tr.transfers || 0,
                webhookEventCount: wh.events || 0,
            };
        });

        res.json({ success: true, data: { activeProvider, transferProvider, providers } });
    } catch (error) {
        console.error("Admin get payment providers error:", error);
        res.status(500).json({ success: false, error: "Failed to load payment providers" });
    }
});

// Toggle the globally active payment provider
protectedRouter.put("/payment-providers/active", async (req, res) => {
    try {
        const { provider } = req.body || {};
        const { getAvailableProviders, invalidateActiveProviderCache } = await import("../services/providers/factory");

        if (!provider || !getAvailableProviders().includes(provider)) {
            return res.status(400).json({
                success: false,
                error: `Invalid provider. Must be one of: ${getAvailableProviders().join(", ")}`,
            });
        }

        await query(
            `INSERT INTO system_settings (key, value, description)
             VALUES ('active_payment_provider', $1, 'Globally active payment provider (managed by platform admins)')
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
            [provider]
        );

        invalidateActiveProviderCache();

        try {
            const { logAuditEvent } = await import("../services/audit");
            await logAuditEvent({
                action: 'payment_provider_changed',
                entityType: 'system_settings',
                entityId: 'active_payment_provider',
                newValues: { provider },
            });
        } catch (auditErr) {
            console.warn("Failed to audit log provider change:", auditErr);
        }

        res.json({ success: true, message: `Active payment provider set to ${provider}`, data: { provider } });
    } catch (error) {
        console.error("Admin set active payment provider error:", error);
        res.status(500).json({ success: false, error: "Failed to set active payment provider" });
    }
});

// Toggle the globally active TRANSFER provider (independent of collections)
protectedRouter.put("/payment-providers/transfer-active", async (req, res) => {
    try {
        const { provider } = req.body || {};
        const { getAvailableProviders, invalidateActiveProviderCache } = await import("../services/providers/factory");

        if (!provider || !getAvailableProviders().includes(provider)) {
            return res.status(400).json({
                success: false,
                error: `Invalid provider. Must be one of: ${getAvailableProviders().join(", ")}`,
            });
        }

        await query(
            `INSERT INTO system_settings (key, value, description)
             VALUES ('active_transfer_provider', $1, 'Globally active TRANSFER provider (payouts, bank lookups - managed by platform admins)')
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
            [provider]
        );

        invalidateActiveProviderCache();

        try {
            const { logAuditEvent } = await import("../services/audit");
            await logAuditEvent({
                action: 'transfer_provider_changed',
                entityType: 'system_settings',
                entityId: 'active_transfer_provider',
                newValues: { provider },
            });
        } catch (auditErr) {
            console.warn("Failed to audit log transfer provider change:", auditErr);
        }

        res.json({ success: true, message: `Active transfer provider set to ${provider}`, data: { provider } });
    } catch (error) {
        console.error("Admin set active transfer provider error:", error);
        res.status(500).json({ success: false, error: "Failed to set active transfer provider" });
    }
});

// ---------------------------------------------------------------------
// Calling / meeting provider (LiveKit vs MediaSoup) — platform setting.
// The backend is the source of truth: clients ask the API which media
// infrastructure a room uses; they never decide it themselves.
// ---------------------------------------------------------------------
protectedRouter.get("/calling/providers", async (req, res) => {
    try {
        const { getProvidersStatus } = await import("../lib/calling/factory");
        const status = await getProvidersStatus();
        res.json({ success: true, data: status });
    } catch (error) {
        console.error("Admin get calling providers error:", error);
        res.status(500).json({ success: false, error: "Failed to load calling providers" });
    }
});

// Health/status alias per API spec (same payload as GET /calling/providers).
protectedRouter.get("/calling/providers/status", async (req, res) => {
    try {
        const { getProvidersStatus } = await import("../lib/calling/factory");
        const status = await getProvidersStatus();
        res.json({ success: true, data: status });
    } catch (error) {
        console.error("Admin calling providers status error:", error);
        res.status(500).json({ success: false, error: "Failed to load calling provider status" });
    }
});

protectedRouter.put("/calling/provider", async (req, res) => {
    try {
        const { provider } = req.body || {};
        const { setActiveProviderName, listProviderNames, isProviderName } = await import("../lib/calling/factory");

        if (!isProviderName(provider)) {
            return res.status(400).json({
                success: false,
                error: `Invalid provider. Must be one of: ${listProviderNames().join(", ")}`,
            });
        }

        await setActiveProviderName(provider);

        try {
            const { logAuditEvent } = await import("../services/audit");
            await logAuditEvent({
                action: 'calling_provider_changed',
                entityType: 'system_settings',
                entityId: 'calling_provider',
                newValues: { provider },
            });
        } catch (auditErr) {
            console.warn("Failed to audit log calling provider change:", auditErr);
        }

        res.json({ success: true, message: `Active calling provider set to ${provider}`, data: { provider } });
    } catch (error) {
        console.error("Admin set active calling provider error:", error);
        res.status(500).json({ success: false, error: "Failed to set active calling provider" });
    }
});

// List all virtual accounts (per provider) with wallet ownership context
protectedRouter.get("/virtual-accounts", async (req, res) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const provider = req.query.provider as string;
        const offset = (page - 1) * limit;

        const params: any[] = [];
        let where = `WHERE 1=1`;
        if (provider) {
            params.push(provider);
            where += ` AND va.payment_provider = $${params.length}`;
        }

        const countRes = await query(`SELECT COUNT(*)::int AS total FROM virtual_accounts va ${where}`, params);
        const rows = await query(
            `SELECT va.id, va.virtual_account_number, va.bank_code, va.account_name,
                    va.payment_provider, va.customer_identifier, va.is_active, va.created_at,
                    w.id AS wallet_id, w.balance, w.currency,
                    u.name AS user_name, u.email AS user_email,
                    b.name AS business_name, b.id AS business_id
             FROM virtual_accounts va
             LEFT JOIN wallets w ON va.wallet_id = w.id
             LEFT JOIN users u ON w.user_id = u.id
             LEFT JOIN businesses b ON w.business_id = b.id
             ${where}
             ORDER BY va.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );

        res.json({
            success: true,
            data: rows.rows,
            pagination: { page, limit, total: countRes.rows[0]?.total || 0 },
        });
    } catch (error) {
        console.error("Admin list virtual accounts error:", error);
        res.status(500).json({ success: false, error: "Failed to list virtual accounts" });
    }
});

// Verify a pending transaction against its provider (manual re-verification tool)
protectedRouter.post("/transactions/verify", async (req, res) => {
    try {
        const { reference } = req.body || {};
        if (!reference) {
            return res.status(400).json({ success: false, error: "reference is required" });
        }

        const txRes = await query(`SELECT * FROM transactions WHERE reference = $1`, [reference]);
        if (txRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Transaction not found" });
        }
        const transaction = txRes.rows[0];
        if (!transaction.payment_provider) {
            return res.status(400).json({ success: false, error: "Transaction has no payment provider recorded" });
        }

        const { getProvider } = await import("../services/providers/factory");
        const provider = getProvider(transaction.payment_provider);
        const verifyResponse = await provider.verifyPayment(reference);

        // Normalized success detection across providers
        let providerSuccess = false;
        if (provider.name === 'squad') {
            providerSuccess = verifyResponse?.success && verifyResponse?.data?.transaction_status === 'success';
        } else if (provider.name === 'flutterwave') {
            providerSuccess = verifyResponse?.success && ['successful', 'success'].includes(verifyResponse?.data?.status);
        } else if (provider.name === 'monnify') {
            providerSuccess = verifyResponse?.success && verifyResponse?.data?.paymentStatus === 'PAID';
        }

        res.json({
            success: true,
            data: {
                reference,
                localStatus: transaction.status,
                provider: provider.name,
                providerSuccess,
                providerResponse: verifyResponse,
            },
        });
    } catch (error: any) {
        console.error("Admin verify transaction error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to verify transaction" });
    }
});

// ============================================================================
// Maintenance mode
// ============================================================================

/**
 * GET /admin/maintenance-mode
 * Returns the current maintenance mode flag.
 */
protectedRouter.get("/maintenance-mode", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const value = await getSetting("maintenance_mode", "off");
        res.json({ success: true, data: { maintenance_mode: value === "on" } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to read maintenance mode" });
    }
});

/**
 * PUT /admin/maintenance-mode
 * Toggle maintenance mode. When toggled ON, every user is emailed (and pushed)
 * that the app is under maintenance; when toggled OFF, everyone is emailed that
 * the app is back up.
 */
protectedRouter.put("/maintenance-mode", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const enabled = Boolean(req.body?.enabled);
        const newValue = enabled ? "on" : "off";
        const current = await getSetting("maintenance_mode", "off");
        await setSetting("maintenance_mode", newValue, "When 'on', user apps show a maintenance screen");

        if (current !== newValue) {
            const now = new Date();
            const usersRes = await query(`SELECT id, business_id, email, name FROM users WHERE email_verified = TRUE AND status = 'active'`);

            // Fire-and-forget fan-out so the admin request returns quickly
            (async () => {
                let sent = 0;
                for (const user of usersRes.rows) {
                    try {
                        const personalized = generateMaintenanceModeEmailHtml(user.name || user.email, enabled, now);
                        await sendEmail(user.email, user.name || user.email,
                            enabled ? 'Metricorex maintenance in progress' : 'Metricorex is back up',
                            personalized);
                        sent++;
                    } catch { /* keep going */ }
                }
                try {
                    await sendPushToAll({
                        title: enabled ? 'Scheduled maintenance' : 'We are back up!',
                        body: enabled
                            ? 'Metricorex is undergoing maintenance. Some features may be unavailable.'
                            : 'Maintenance complete - Metricorex is fully back up. Thank you for your patience!',
                        androidChannelId: 'general',
                    }, 'maintenance');
                } catch (pushErr: any) {
                    console.warn('Maintenance push fan-out failed:', pushErr?.message);
                }
                console.log(`[maintenance] mode=${newValue}; emailed ${sent}/${usersRes.rows.length} users`);
            })();
        }

        res.json({ success: true, data: { maintenance_mode: enabled } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to update maintenance mode" });
    }
});

// ============================================================================
// Dispute email recipients (ADMIN-MANAGED — stored in system_settings, NOT .env)
// ============================================================================

/**
 * GET /admin/settings/dispute-emails
 * Returns the inboxes that receive transaction dispute alerts.
 * `source` tells the console whether the list comes from the database
 * (admin-managed) or from the .env fallback chain (not yet overridden).
 */
protectedRouter.get("/settings/dispute-emails", requirePermission('manage_settings', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { emails, source, envFallback } = await getDisputeAdminEmails();
        res.json({ success: true, data: { emails, source, envFallback } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load dispute emails" });
    }
});

/**
 * PUT /admin/settings/dispute-emails
 * Body: { emails: string[] | string } — list of inboxes (or a comma/newline
 * separated string). Validated, deduped, lowercased and persisted to
 * system_settings so it survives deploys and needs no redeploy to change.
 */
protectedRouter.put("/settings/dispute-emails", requirePermission('manage_settings', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const raw = req.body?.emails;
        if (raw === undefined || raw === null) {
            res.status(400).json({ success: false, error: "emails is required" });
            return;
        }
        const rawList = Array.isArray(raw) ? raw.join(",") : String(raw);
        const emails = parseEmailList(rawList);
        if (emails.length === 0) {
            res.status(400).json({
                success: false,
                error: "Provide at least one valid email address",
            });
            return;
        }
        if (emails.length > 20) {
            res.status(400).json({ success: false, error: "A maximum of 20 email addresses is allowed" });
            return;
        }
        await setDisputeAdminEmails(emails);

        console.log(`[admin] dispute emails updated by admin ${req.admin?.adminId}: ${emails.join(", ")}`);
        res.json({ success: true, data: { emails, source: "database" } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to save dispute emails" });
    }
});

/**
 * GET /admin/settings/app-store-urls — mobile app download links shown by
 * the marketing site download sections, the web meeting interstitial and
 * push/link deep-links. Persisted in system_settings (setSetting upsert).
 */
protectedRouter.get("/settings/app-store-urls", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const [appStore, playStore] = await Promise.all([
            getSetting("app_store_url"),
            getSetting("play_store_url"),
        ]);
        res.json({ success: true, data: { app_store_url: appStore || "", play_store_url: playStore || "" } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load app store URLs" });
    }
});

/**
 * PUT /admin/settings/app-store-urls
 * Body: { app_store_url?: string, play_store_url?: string } — either key may
 * be empty to clear it. Must be an https(s) or market:// URL.
 */
protectedRouter.put("/settings/app-store-urls", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { app_store_url, play_store_url } = req.body || {};
        if (app_store_url === undefined && play_store_url === undefined) {
            return res.status(400).json({ success: false, error: "Provide app_store_url and/or play_store_url" });
        }
        const validUrl = (v: unknown) => {
            const s = String(v || "").trim();
            if (!s) return "";
            if (!/^(https:\/\/|http:\/\/|market:\/\/)/i.test(s) || s.length > 500) return null;
            return s;
        };
        if (app_store_url !== undefined) {
            const app = validUrl(app_store_url);
            if (app === null) return res.status(400).json({ success: false, error: "app_store_url must be a valid https:// (or market://) URL" });
            await setSetting("app_store_url", app, "Apple App Store download link for the Metroflow mobile app");
        }
        if (play_store_url !== undefined) {
            const play = validUrl(play_store_url);
            if (play === null) return res.status(400).json({ success: false, error: "play_store_url must be a valid https:// (or market://) URL" });
            await setSetting("play_store_url", play, "Google Play Store download link for the Metroflow mobile app");
        }
        const [appStore, playStore] = await Promise.all([getSetting("app_store_url"), getSetting("play_store_url")]);
        console.log(`[admin] app store URLs updated by admin ${req.admin?.adminId}`);
        res.json({ success: true, data: { app_store_url: appStore || "", play_store_url: playStore || "" } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to save app store URLs" });
    }
});

/**
 * GET /admin/email-config — the shared EMAIL footer configuration (app
 * download links + social links) that every outbound email renders. Returns
 * the effective values (stored override or sensible default) plus a
 * using_defaults map so the console can show which keys are unedited.
 */
protectedRouter.get("/email-config", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { config, usingDefaults } = await getEmailConfigWithMeta();
        res.json({ success: true, data: { ...config, using_defaults: usingDefaults } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load email config" });
    }
});

/**
 * PUT /admin/email-config
 * Body: any subset of { play_store_url, app_store_url, instagram_link,
 * twitter_link, linkedin_link, facebook_link }. Values must be http(s) URLs
 * (max 500 chars); an empty string clears the override so the default shows
 * again. Persists to system_settings and invalidates the 60s email cache.
 */
protectedRouter.put("/email-config", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const body = req.body || {};
        const provided = EMAIL_CONFIG_KEYS.filter((k) => body[k] !== undefined);
        if (provided.length === 0) {
            return res.status(400).json({
                success: false,
                error: `Provide at least one of: ${EMAIL_CONFIG_KEYS.join(", ")}`,
            });
        }

        const result = await saveEmailConfig(body);
        if (result.ok === false) {
            return res.status(400).json({ success: false, error: result.error });
        }

        try {
            const { logAuditEvent } = await import("../services/audit");
            await logAuditEvent({
                action: 'email_config_updated',
                entityType: 'system_settings',
                entityId: 'email_config',
                newValues: Object.fromEntries(provided.map((k) => [k, result.config[k]])),
            });
        } catch (auditErr) {
            console.warn("Failed to audit log email config change:", auditErr);
        }

        console.log(`[admin] email footer config updated by admin ${req.admin?.adminId}: ${provided.join(", ")}`);
        const { config, usingDefaults } = await getEmailConfigWithMeta();
        res.json({ success: true, message: "Email footer configuration saved", data: { ...config, using_defaults: usingDefaults } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to save email config" });
    }
});

/**
 * POST /admin/settings/dispute-emails/test
 * Sends a test dispute alert to every configured inbox and reports the
 * per-address delivery result, so admins can verify the wiring instantly.
 */
protectedRouter.post("/settings/dispute-emails/test", requirePermission('manage_settings', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { emails } = await getDisputeAdminEmails();
        if (emails.length === 0) {
            res.status(400).json({
                success: false,
                error: "No dispute emails configured yet — add at least one address first",
            });
            return;
        }
        const results: Array<{ email: string; sent: boolean; error?: string }> = [];
        for (const email of emails) {
            try {
                await sendDisputeAdminAlert(email, "Dispute Desk", {
                    customerName: "Test customer",
                    reference: "TEST-" + Date.now().toString().slice(-8),
                    amount: "1,000.00",
                    currency: "NGN",
                    category: "failed_transfer",
                    status: "open",
                    message: "This is a TEST dispute alert triggered from the Admin Console to verify dispute email delivery.",
                });
                results.push({ email, sent: true });
            } catch (err: any) {
                results.push({ email, sent: false, error: err?.message || "send failed" });
            }
        }
        const allSent = results.every((r) => r.sent);
        res.status(allSent ? 200 : 502).json({ success: allSent, data: { results } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to send test emails" });
    }
});

// Legacy alias kept for older console builds: which inboxes WOULD the env use?
protectedRouter.get("/settings/dispute-emails/env", requirePermission('manage_settings', 'manage_finance'), async (_req: AuthenticatedAdminRequest, res) => {
    res.json({ success: true, data: { emails: disputeAdminEmails() } });
});

// ============================================================================
// Admin notification feed (dispute alerts, support, etc.)
// ============================================================================

/** GET /admin/notifications — latest 50 feed rows + unread count. */
protectedRouter.get("/notifications", async (req: AuthenticatedAdminRequest, res) => {
    try {
        const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 100);
        const rows = await query(
            `SELECT id, type, title, body, is_read, created_at
             FROM admin_notifications
             WHERE admin_id IS NULL
             ORDER BY created_at DESC
             LIMIT $1`,
            [limit],
        );
        const unread = await query(
            `SELECT COUNT(*)::int AS count FROM admin_notifications WHERE admin_id IS NULL AND is_read = FALSE`,
        );
        res.json({ success: true, data: rows.rows, unread: unread.rows[0]?.count || 0 });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load notifications" });
    }
});

/** POST /admin/notifications/read-all — mark the whole feed as read. */
protectedRouter.post("/notifications/read-all", async (req: AuthenticatedAdminRequest, res) => {
    try {
        await query(`UPDATE admin_notifications SET is_read = TRUE WHERE admin_id IS NULL AND is_read = FALSE`);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to mark notifications read" });
    }
});

// ============================================================================
// Announcements
// ============================================================================

/**
 * GET /admin/announcements
 */
protectedRouter.get("/announcements", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const result = await query(`SELECT * FROM announcements WHERE business_id IS NULL ORDER BY created_at DESC`);
        res.json({ success: true, data: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to fetch announcements" });
    }
});

/**
 * POST /admin/announcements
 * Create an announcement shown on the user-side sliding ticker.
 */
protectedRouter.post("/announcements", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { message, title, is_active } = req.body || {};
        if (!message || !String(message).trim()) {
            return res.status(400).json({ success: false, error: "message is required" });
        }
        const result = await query(
            `INSERT INTO announcements (business_id, title, message, is_active, created_by)
             VALUES (NULL, $1, $2, COALESCE($3, TRUE), $4)
             RETURNING *`,
            [title || null, String(message).trim(), is_active !== false, req.admin?.adminId || null],
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to create announcement" });
    }
});

/**
 * PUT /admin/announcements/:id
 */
protectedRouter.put("/announcements/:id", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { message, title, is_active } = req.body || {};
        const result = await query(
            `UPDATE announcements SET
                title = COALESCE($1, title),
                message = COALESCE($2, message),
                is_active = COALESCE($3, is_active),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $4 AND business_id IS NULL
             RETURNING *`,
            [title ?? null, message ? String(message).trim() : null, is_active ?? null, req.params.id],
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Announcement not found" });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to update announcement" });
    }
});

/**
 * DELETE /admin/announcements/:id
 */
protectedRouter.delete("/announcements/:id", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const result = await query(`DELETE FROM announcements WHERE id = $1 AND business_id IS NULL RETURNING id`, [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Announcement not found" });
        }
        res.json({ success: true, message: "Announcement deleted" });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to delete announcement" });
    }
});

// ============================================================================
// Mobile app releases (drives the in-app update prompt)
// ============================================================================

const APP_VERSION_PLATFORMS = ["ios", "android"];

const parseAppVersionPayload = (body: any, { forCreate }: { forCreate: boolean }) => {
  const errors: string[] = [];
  const out: Record<string, any> = {};

  if (body.platform !== undefined || forCreate) {
    const platform = String(body.platform || "").toLowerCase().trim();
    if (!APP_VERSION_PLATFORMS.includes(platform)) {
      errors.push("platform must be 'ios' or 'android'");
    } else {
      out.platform = platform;
    }
  }

  if (body.version_name !== undefined || forCreate) {
    const versionName = String(body.version_name ?? "").trim();
    if (!versionName) errors.push("version_name is required");
    else if (versionName.length > 32) errors.push("version_name must be 32 characters or fewer");
    else out.version_name = versionName;
  }

  if (body.version_code !== undefined || forCreate) {
    const code = parseInt(String(body.version_code), 10);
    if (!Number.isFinite(code) || code <= 0) errors.push("version_code must be a positive integer (the build number)");
    else out.version_code = code;
  }

  if (body.min_supported_version_code !== undefined) {
    if (body.min_supported_version_code === null || body.min_supported_version_code === "") {
      out.min_supported_version_code = null;
    } else {
      const minCode = parseInt(String(body.min_supported_version_code), 10);
      if (!Number.isFinite(minCode) || minCode <= 0) errors.push("min_supported_version_code must be a positive integer or null");
      else out.min_supported_version_code = minCode;
    }
  }

  if (body.force_update !== undefined) out.force_update = body.force_update === true || body.force_update === "true";
  if (body.is_active !== undefined) out.is_active = body.is_active === true || body.is_active === "true";

  if (body.release_notes !== undefined) {
    // Empty string means "clear" (COALESCE on the server keeps '' as the new value).
    const notes = body.release_notes === null ? null : String(body.release_notes).trim();
    out.release_notes = notes === null ? null : notes.slice(0, 5000);
  }

  if (body.store_url !== undefined) {
    const url = body.store_url === null ? null : String(body.store_url).trim();
    if (url && !/^https?:\/\//i.test(url) && !/^market:\/\//i.test(url)) {
      errors.push("store_url must start with https://, http:// or market://");
    } else {
      out.store_url = url === null ? null : url;
    }
  }

  return { out, errors };
};

/**
 * GET /admin/app-versions
 * List every tracked mobile release (both platforms), newest first.
 */
protectedRouter.get("/app-versions", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const result = await query(
            `SELECT * FROM app_versions ORDER BY platform ASC, version_code DESC, created_at DESC`,
        );
        res.json({ success: true, data: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to fetch app releases" });
    }
});

/**
 * POST /admin/app-versions
 * Publish a new mobile release. Once active, app builds with a lower
 * version_code are prompted to update (forced when force_update is set or
 * they are below min_supported_version_code).
 */
protectedRouter.post("/app-versions", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { out, errors } = parseAppVersionPayload(req.body || {}, { forCreate: true });
        if (errors.length > 0) {
            return res.status(400).json({ success: false, error: errors.join("; ") });
        }

        const result = await query(
            `INSERT INTO app_versions
                (platform, version_name, version_code, force_update, min_supported_version_code,
                 release_notes, store_url, is_active, created_by)
             VALUES ($1, $2, $3, COALESCE($4, FALSE), $5, $6, $7, COALESCE($8, TRUE), $9)
             RETURNING *`,
            [
                out.platform,
                out.version_name,
                out.version_code,
                out.force_update ?? false,
                out.min_supported_version_code ?? null,
                out.release_notes ?? null,
                out.store_url ?? null,
                out.is_active ?? true,
                req.admin?.adminId || null,
            ],
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (error: any) {
        if (error?.code === "23505") {
            return res.status(409).json({
                success: false,
                error: "A release with this version code already exists for this platform",
            });
        }
        res.status(500).json({ success: false, error: error.message || "Failed to create app release" });
    }
});

/**
 * PUT /admin/app-versions/:id
 * Partial update — toggle force_update / is_active, raise the support floor,
 * edit notes or the store link.
 */
protectedRouter.put("/app-versions/:id", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { out, errors } = parseAppVersionPayload(req.body || {}, { forCreate: false });
        if (errors.length > 0) {
            return res.status(400).json({ success: false, error: errors.join("; ") });
        }

        const result = await query(
            `UPDATE app_versions SET
                platform = COALESCE($1, platform),
                version_name = COALESCE($2, version_name),
                version_code = COALESCE($3, version_code),
                force_update = COALESCE($4, force_update),
                min_supported_version_code = COALESCE($5, min_supported_version_code),
                release_notes = COALESCE($6, release_notes),
                store_url = COALESCE($7, store_url),
                is_active = COALESCE($8, is_active),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $9
             RETURNING *`,
            [
                out.platform ?? null,
                out.version_name ?? null,
                out.version_code ?? null,
                out.force_update ?? null,
                out.min_supported_version_code ?? null,
                out.release_notes ?? null,
                out.store_url ?? null,
                out.is_active ?? null,
                req.params.id,
            ],
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "App release not found" });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error: any) {
        if (error?.code === "23505") {
            return res.status(409).json({
                success: false,
                error: "A release with this version code already exists for this platform",
            });
        }
        res.status(500).json({ success: false, error: error.message || "Failed to update app release" });
    }
});

/**
 * DELETE /admin/app-versions/:id
 */
protectedRouter.delete("/app-versions/:id", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const result = await query(`DELETE FROM app_versions WHERE id = $1 RETURNING id`, [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "App release not found" });
        }
        res.json({ success: true, message: "App release deleted" });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to delete app release" });
    }
});

// ============================================================================
// Broadcast push / email notifications
// ============================================================================

/**
 * POST /admin/broadcast
 * Send an email and/or push notification to all (verified) users.
 * Body: { channels: ['email','push'], subject, message }
 */
protectedRouter.post("/broadcast", requirePermission('manage_settings'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const channels: string[] = Array.isArray(req.body?.channels) ? req.body.channels : ['email'];
        const subject = String(req.body?.subject || '').trim() || 'Metricorex announcement';
        const message = String(req.body?.message || '').trim();
        if (!message) {
            return res.status(400).json({ success: false, error: "message is required" });
        }

        const usersRes = await query(`SELECT id, business_id, email, name FROM users WHERE email_verified = TRUE AND status = 'active'`);
        const users = usersRes.rows;
        const wantsEmail = channels.includes('email');
        const wantsPush = channels.includes('push');

        // Email fan-out (synchronous-ish but awaited in background)
        let emailsSent = 0;
        const emailPromise = (async () => {
            if (!wantsEmail) return 0;
            for (const user of users) {
                try {
                    await sendEmail(user.email, user.name || user.email, subject, generateBroadcastEmailHtml(user.name || user.email, subject, message));
                    emailsSent++;
                } catch { /* continue */ }
            }
            return emailsSent;
        })();

        let pushesSent = 0;
        if (wantsPush) {
            try {
                const pushResult = await sendPushToAll({ title: subject, body: message, androidChannelId: 'general' }, 'broadcast');
                pushesSent = pushResult.sent;
            } catch (pushErr: any) {
                console.warn('Broadcast push failed:', pushErr?.message);
            }
        }

        await emailPromise;

        res.json({
            success: true,
            data: { recipients: users.length, emails_sent: emailsSent, pushes_sent: pushesSent, channels },
            message: `Broadcast queued to ${users.length} users`,
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to send broadcast" });
    }
});

// ============================================================================
// International transfer fees / markup configuration
// ============================================================================

/**
 * GET /admin/intl-transfer-config
 */
protectedRouter.get("/intl-transfer-config", requirePermission('manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const config = await getIntlTransferConfig();
        const transferProvider = await getActiveTransferProviderName();
        res.json({ success: true, data: { ...config, spread_percent: config.spreadPercent, quote_ttl_seconds: config.quoteTtlSeconds, transfer_provider: transferProvider } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load international transfer config" });
    }
});

/**
 * PUT /admin/intl-transfer-config
 * Body: { markup_percent, fee_percent, fee_flat, spread_percent, transfer_provider? }
 * spread_percent is the admin-only margin layered on top of markup — customers
 * only ever see markup+spread merged as one number in their quote.
 */
protectedRouter.put("/intl-transfer-config", requirePermission('manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { markup_percent, fee_percent, fee_flat, spread_percent, quote_ttl_seconds, transfer_provider } = req.body || {};
        if (markup_percent !== undefined) {
            const v = Number(markup_percent);
            if (!Number.isFinite(v) || v < 0 || v > 100) return res.status(400).json({ success: false, error: "markup_percent must be between 0 and 100" });
            await setSetting("intl_transfer_markup_percent", String(v));
        }
        if (fee_percent !== undefined) {
            const v = Number(fee_percent);
            if (!Number.isFinite(v) || v < 0 || v > 100) return res.status(400).json({ success: false, error: "fee_percent must be between 0 and 100" });
            await setSetting("intl_transfer_fee_percent", String(v));
        }
        if (fee_flat !== undefined) {
            const v = Number(fee_flat);
            if (!Number.isFinite(v) || v < 0) return res.status(400).json({ success: false, error: "fee_flat must be a positive number" });
            await setSetting("intl_transfer_fee_flat", String(v));
        }
        if (spread_percent !== undefined) {
            const v = Number(spread_percent);
            if (!Number.isFinite(v) || v < 0 || v > 100) return res.status(400).json({ success: false, error: "spread_percent must be between 0 and 100" });
            await setSetting("intl_transfer_spread_percent", String(v));
        }
        if (quote_ttl_seconds !== undefined) {
            const v = Number(quote_ttl_seconds);
            if (!Number.isFinite(v) || v < 30 || v > 1800) return res.status(400).json({ success: false, error: "quote_ttl_seconds must be between 30 and 1800" });
            await setSetting("intl_quote_ttl_seconds", String(Math.round(v)), "Quote lock countdown window for international transfers");
        }
        if (transfer_provider !== undefined) {
            const allowed = ['flutterwave'];
            if (transfer_provider && !allowed.includes(transfer_provider)) {
                return res.status(400).json({ success: false, error: `International transfers support only: ${allowed.join(', ')}` });
            }
            await setSetting("active_transfer_provider", transfer_provider || '');
            invalidateActiveProviderCache();
        }
        const config = await getIntlTransferConfig();
        const transferProvider = await getActiveTransferProviderName();
        res.json({ success: true, data: { ...config, spread_percent: config.spreadPercent, quote_ttl_seconds: config.quoteTtlSeconds, transfer_provider: transferProvider } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to update international transfer config" });
    }
});

// ============================================================================
// International payout limits (min / max per currency) + platform float
// ============================================================================

/**
 * GET /admin/intl-payout-limits
 */
protectedRouter.get("/intl-payout-limits", requirePermission('manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const limits = await getIntlPayoutLimits();
        const sourceCurrency = await getIntlPayoutSourceCurrency();
        res.json({ success: true, data: { limits, defaults: DEFAULT_PAYOUT_LIMITS, source_currency: sourceCurrency } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load payout limits" });
    }
});

/**
 * PUT /admin/intl-payout-limits
 * Body: { limits: { USD: {min,max}, GBP: {...}, EUR: {...} }, source_currency? }
 * Flutterwave's published rails: min 10 / max 20,000 per transfer for
 * USD, GBP and EUR. Clients surface these as an amount-field hint.
 */
protectedRouter.put("/intl-payout-limits", requirePermission('manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { limits, source_currency } = req.body || {};
        if (limits !== undefined) {
            if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
                return res.status(400).json({ success: false, error: "limits must be an object keyed by currency" });
            }
            const cleaned: Record<string, { min: number; max: number }> = {};
            for (const [cur, val] of Object.entries(limits)) {
                const currency = String(cur).toUpperCase();
                if (!['USD', 'GBP', 'EUR'].includes(currency)) {
                    return res.status(400).json({ success: false, error: `Unsupported payout currency: ${cur}` });
                }
                const min = Number((val as any)?.min);
                const max = Number((val as any)?.max);
                if (!Number.isFinite(min) || min <= 0) {
                    return res.status(400).json({ success: false, error: `${currency} min must be a positive number` });
                }
                if (!Number.isFinite(max) || max <= 0) {
                    return res.status(400).json({ success: false, error: `${currency} max must be a positive number` });
                }
                if (max < min) {
                    return res.status(400).json({ success: false, error: `${currency} max must be greater than or equal to min` });
                }
                cleaned[currency] = { min, max };
            }
            await setSetting("intl_payout_limits", JSON.stringify(cleaned), "International payout min/max per currency");
        }
        if (source_currency !== undefined) {
            const src = String(source_currency || 'NGN').toUpperCase();
            if (!['NGN', 'USD', 'GBP', 'EUR'].includes(src)) {
                return res.status(400).json({ success: false, error: "source_currency must be one of NGN, USD, GBP, EUR" });
            }
            await setSetting("intl_payout_source_currency", src, "Platform float currency funding international payouts");
        }
        const saved = await getIntlPayoutLimits();
        const savedSource = await getIntlPayoutSourceCurrency();
        res.json({ success: true, data: { limits: saved, source_currency: savedSource } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to update payout limits" });
    }
});

// ============================================================================
// Virtual account regeneration (business name fix for existing users)
// ============================================================================

/**
 * GET /admin/virtual-accounts/personal-name
 * Lists business wallets whose stored account_name looks like a personal name
 * (i.e. differs from the business name) - candidates for regeneration.
 */
protectedRouter.get("/virtual-accounts/personal-name", requirePermission('manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const result = await query(`
            SELECT w.id AS wallet_id, w.business_id, w.account_name, w.virtual_account_number, w.bank_code, w.payment_provider,
                   b.name AS business_name
            FROM wallets w
            JOIN businesses b ON b.id = w.business_id
            WHERE w.virtual_account_number IS NOT NULL
              AND LOWER(w.account_name) IS DISTINCT FROM LOWER(b.name)
            ORDER BY w.updated_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to list mismatched virtual accounts" });
    }
});

/**
 * POST /admin/virtual-accounts/:walletId/regenerate
 * Regenerates a single business virtual account with the business name.
 */
protectedRouter.post("/virtual-accounts/:walletId/regenerate", requirePermission('manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const walletId = req.params.walletId;
        const walletRes = await query(
            `SELECT w.*, b.name AS business_name FROM wallets w JOIN businesses b ON b.id = w.business_id WHERE w.id = $1`,
            [walletId],
        );
        if (walletRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Wallet not found" });
        }
        const wallet = walletRes.rows[0];
        if (!wallet.business_id) {
            return res.status(400).json({ success: false, error: "Not a business wallet" });
        }

        const ownerRes = await query(
            `SELECT id, bvn, nin, phone_number FROM users WHERE business_id = $1 AND role = 'owner' LIMIT 1`,
            [wallet.business_id],
        );
        const owner = ownerRes.rows[0];
        if (!owner?.bvn) {
            return res.status(400).json({ success: false, error: "Business owner has no BVN on file" });
        }

        const { getProvider } = await import("../services/providers/factory");
        const provider = getProvider(wallet.payment_provider || undefined);
        const vaResponse = await provider.createBusinessVirtualAccount({
            bvn: owner.bvn,
            nin: owner.nin || "12345678901",
            businessName: wallet.business_name,
            customerIdentifier: `BIZ-${String(wallet.business_id).substring(0, 8)}`,
            phoneNumber: owner.phone_number || "08000000000",
            beneficiaryAccount: wallet.beneficiary_account || "0000000000",
        } as any);

        let vaNumber: string | null = null;
        let bankCode = '058';
        if (provider.name === 'flutterwave') {
            if (vaResponse?.status === 'success' && vaResponse?.data?.account_number) {
                vaNumber = String(vaResponse.data.account_number);
                bankCode = vaResponse.data.bank_code || '058';
            }
        } else if (provider.name === 'monnify') {
            if (vaResponse?.requestSuccessful) {
                const accounts = vaResponse?.responseBody?.accounts;
                vaNumber = accounts?.[0]?.accountNumber || null;
                bankCode = accounts?.[0]?.bankCode || '058';
            }
        } else if (provider.name === 'squad') {
            if (vaResponse?.success && vaResponse?.data) {
                vaNumber = vaResponse.data.virtual_account_number;
                bankCode = vaResponse.data.bank_code || '058';
            }
        }

        if (!vaNumber) {
            const errMsg = vaResponse?.responseMessage || vaResponse?.message || "Provider failed to recreate the virtual account";
            return res.status(400).json({ success: false, error: errMsg });
        }

        await query(
            `UPDATE wallets SET virtual_account_number = $1, bank_code = $2, account_name = $3, payment_provider = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
            [vaNumber, bankCode, wallet.business_name, provider.name, walletId],
        );

        res.json({
            success: true,
            message: "Virtual account regenerated with the business name",
            data: { wallet_id: walletId, account_number: vaNumber, bank_code: bankCode, account_name: wallet.business_name },
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to regenerate virtual account" });
    }
});


/**
 * POST /admin/virtual-accounts/regenerate-bulk
 * Regenerate business-wallet virtual accounts so the account NAME is the
 * BUSINESS name (not the owner's personal name).
 * Body:
 *   { all: true }                      -> every business wallet
 *   { businessId }                     -> one business
 *   { userId }                         -> the business that user belongs to
 *                                        (as owner/admin)
 * Uses the ACTIVE payment provider; per-wallet results are returned.
 */
protectedRouter.post("/virtual-accounts/regenerate-bulk", requirePermission('manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { all, businessId, userId } = req.body || {};
        let walletIds: string[] = [];

        if (all) {
            const r = await query(
                `SELECT id FROM wallets WHERE business_id IS NOT NULL ORDER BY created_at DESC`,
            );
            walletIds = r.rows.map((row: any) => row.id);
        } else if (businessId) {
            const r = await query(`SELECT id FROM wallets WHERE business_id = $1`, [businessId]);
            walletIds = r.rows.map((row: any) => row.id);
        } else if (userId) {
            const userRes = await query(`SELECT business_id FROM users WHERE id = $1`, [userId]);
            const userBizId = userRes.rows[0]?.business_id;
            if (!userBizId) {
                return res.status(400).json({ success: false, error: "User has no business" });
            }
            const r = await query(`SELECT id FROM wallets WHERE business_id = $1`, [userBizId]);
            walletIds = r.rows.map((row: any) => row.id);
        } else {
            return res.status(400).json({ success: false, error: "Provide all=true, businessId or userId" });
        }

        const { getProvider, getActiveProviderName } = await import("../services/providers/factory");
        const activeProviderName = await getActiveProviderName().catch(() => null);

        const results: any[] = [];
        for (const walletId of walletIds) {
            try {
                const walletRes = await query(
                    `SELECT w.*, b.name AS business_name FROM wallets w JOIN businesses b ON b.id = w.business_id WHERE w.id = $1`,
                    [walletId],
                );
                if (walletRes.rows.length === 0) {
                    results.push({ wallet_id: walletId, success: false, error: "Wallet not found" });
                    continue;
                }
                const wallet = walletRes.rows[0];

                const ownerRes = await query(
                    `SELECT id, bvn, nin, phone_number FROM users WHERE business_id = $1 AND role IN ('owner','admin') ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END LIMIT 1`,
                    [wallet.business_id],
                );
                const owner = ownerRes.rows[0];
                if (!owner?.bvn) {
                    results.push({ wallet_id: walletId, business: wallet.business_name, success: false, error: "No owner/admin BVN on file" });
                    continue;
                }

                const provider = getProvider(activeProviderName || undefined);
                const vaResponse = await provider.createBusinessVirtualAccount({
                    bvn: owner.bvn,
                    nin: owner.nin || "12345678901",
                    businessName: wallet.business_name,
                    customerIdentifier: `BIZ-${String(wallet.business_id).substring(0, 8)}`,
                    phoneNumber: owner.phone_number || "08000000000",
                    beneficiaryAccount: wallet.beneficiary_account || "0000000000",
                } as any);

                let vaNumber: string | null = null;
                let bankCode = '058';
                if (provider.name === 'flutterwave') {
                    if (vaResponse?.status === 'success' && vaResponse?.data?.account_number) {
                        vaNumber = String(vaResponse.data.account_number);
                        bankCode = vaResponse.data.bank_code || '058';
                    }
                } else if (provider.name === 'monnify') {
                    if (vaResponse?.requestSuccessful) {
                        const accounts = vaResponse?.responseBody?.accounts;
                        vaNumber = accounts?.[0]?.accountNumber || null;
                        bankCode = accounts?.[0]?.bankCode || '058';
                    }
                } else if (provider.name === 'squad') {
                    if (vaResponse?.success && vaResponse?.data) {
                        vaNumber = vaResponse.data.virtual_account_number;
                        bankCode = vaResponse.data.bank_code || '058';
                    }
                }

                if (!vaNumber) {
                    const errMsg = vaResponse?.responseMessage || vaResponse?.message || "Provider failed to recreate the virtual account";
                    results.push({ wallet_id: walletId, business: wallet.business_name, success: false, error: errMsg });
                    continue;
                }

                // Legacy columns on the wallets row.
                await query(
                    `UPDATE wallets SET virtual_account_number = $1, bank_code = $2, account_name = $3, payment_provider = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
                    [vaNumber, bankCode, wallet.business_name, provider.name, walletId],
                );
                // AND the virtual_accounts row the wallet screen actually reads —
                // keep it in sync so both surfaces show the business name.
                const existingVa = await query(
                    `SELECT id FROM virtual_accounts WHERE wallet_id = $1 AND payment_provider = $2`,
                    [walletId, provider.name],
                );
                if (existingVa.rows.length > 0) {
                    await query(
                        `UPDATE virtual_accounts SET virtual_account_number = $1, bank_code = $2, account_name = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
                        [vaNumber, bankCode, wallet.business_name, existingVa.rows[0].id],
                    );
                } else {
                    await query(
                        `INSERT INTO virtual_accounts (wallet_id, payment_provider, virtual_account_number, bank_code, account_name, customer_identifier, beneficiary_account, provider_metadata)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [walletId, provider.name, vaNumber, bankCode, wallet.business_name, `BIZ-${String(wallet.business_id).substring(0, 8)}`, "0000000000", JSON.stringify(vaResponse)],
                    );
                }

                results.push({
                    wallet_id: walletId,
                    business: wallet.business_name,
                    success: true,
                    account_number: vaNumber,
                    bank_code: bankCode,
                    account_name: wallet.business_name,
                });
            } catch (err: any) {
                results.push({ wallet_id: walletId, success: false, error: err?.message || "Regeneration failed" });
            }
        }

        res.json({
            success: true,
            message: `Regenerated ${results.filter((r) => r.success).length}/${results.length} business wallet(s)`,
            data: results,
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to regenerate business wallets" });
    }
});

/**
 * POST /admin/virtual-accounts/clear
 * Deletes virtual accounts, optionally scoped:
 *   { provider }                                  -> EVERY VA on that provider
 *   { all: true }                                 -> EVERY VA on every provider
 *   { business_id | wallet_id | user_id, provider? } -> one customer's VAs
 * Clears wallet VA fields and deletes the virtual_accounts rows.
 */
protectedRouter.post("/virtual-accounts/clear", requirePermission('manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { business_id, wallet_id, user_id, provider, all } = req.body || {};
        if (!business_id && !wallet_id && !user_id && !provider && !all) {
            return res.status(400).json({ success: false, error: "Provide provider, business_id, wallet_id, user_id, or all=true" });
        }

        const vaParams: any[] = [];
        let vaWhere = '1=1';
        if (provider) { vaParams.push(provider); vaWhere += ` AND va.payment_provider = $${vaParams.length}`; }
        if (wallet_id) { vaParams.push(wallet_id); vaWhere += ` AND va.wallet_id = $${vaParams.length}`; }
        if (business_id) { vaParams.push(business_id); vaWhere += ` AND va.wallet_id IN (SELECT id FROM wallets WHERE business_id = $${vaParams.length})`; }
        if (user_id) {
            vaParams.push(user_id); const ui = vaParams.length;
            vaWhere += ` AND va.wallet_id IN (SELECT id FROM wallets WHERE user_id = $${ui} OR business_id IN (SELECT business_id FROM users WHERE id = $${ui}))`;
        }

        // Wallets whose provider-side VA records will be removed
        const walletsRes = await query(
            `SELECT DISTINCT w.id, w.payment_provider
             FROM virtual_accounts va JOIN wallets w ON va.wallet_id = w.id
             WHERE ${vaWhere}`,
            vaParams,
        );

        // Delete the per-wallet virtual_accounts rows for the same scope
        const vaDel = await query(`DELETE FROM virtual_accounts va WHERE ${vaWhere} RETURNING va.id, va.payment_provider`, vaParams);

        // Clear the legacy single-VA mirror fields on the wallets themselves
        // (pre virtual_accounts-table deployments stored the VA on the wallet).
        const walletParams: any[] = [];
        let walletWhere = 'virtual_account_number IS NOT NULL';
        if (provider) { walletParams.push(provider); walletWhere += ` AND payment_provider = $${walletParams.length}`; }
        if (wallet_id) { walletParams.push(wallet_id); walletWhere += ` AND id = $${walletParams.length}`; }
        if (business_id) { walletParams.push(business_id); walletWhere += ` AND business_id = $${walletParams.length}`; }
        if (user_id) {
            walletParams.push(user_id); const wi = walletParams.length;
            walletWhere += ` AND (user_id = $${wi} OR business_id IN (SELECT business_id FROM users WHERE id = $${wi}))`;
        }
        const walletClear = await query(
            `UPDATE wallets SET virtual_account_number = NULL, bank_code = NULL, account_name = NULL,
             customer_identifier = NULL, provider_metadata = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE ${walletWhere} RETURNING id`,
            walletParams,
        );

        // Deactivate the provider on affected wallets so a fresh VA can be issued
        for (const w of walletsRes.rows) {
            await query(
                `UPDATE wallets SET provider_metadata = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND virtual_account_number IS NOT NULL`,
                [w.id],
            ).catch(() => {});
        }

        try {
            const { logAuditEvent } = await import("../services/audit");
            await logAuditEvent({
                action: 'virtual_accounts_cleared',
                entityType: 'virtual_accounts',
                entityId: provider || 'all',
                newValues: {
                    provider: provider || null,
                    deleted_va_records: vaDel.rows.length,
                    wallets_affected: walletsRes.rows.length,
                    legacy_wallet_fields_cleared: walletClear.rows.length,
                },
            });
        } catch (auditErr) {
            console.warn("Failed to audit log virtual account clear:", auditErr);
        }

        res.json({
            success: true,
            message: `Deleted ${vaDel.rows.length} virtual account record(s) across ${walletsRes.rows.length} wallet(s)${provider ? ` on ${provider}` : ''}`,
            data: {
                deleted_va_records: vaDel.rows.length,
                wallets_affected: walletsRes.rows.length,
                legacy_wallet_fields_cleared: walletClear.rows.length,
                providers: [...new Set(vaDel.rows.map((r: any) => r.payment_provider))],
            },
        });
    } catch (error: any) {
        console.error("Admin clear virtual accounts error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to clear virtual accounts" });
    }
});

// ---------------------------------------------------------------------------
// MetricAi usage limits — per plan, per feature, daily/monthly (admin-managed)
// ---------------------------------------------------------------------------
const AI_LIMIT_FIELDS = [
    "metric_ai_chat_daily",
    "metric_ai_chat_monthly",
    "metric_ai_image_daily",
    "metric_ai_image_monthly",
    "metric_ai_video_daily",
    "metric_ai_video_monthly",
] as const;

/** Normalize an incoming limit value: positive int, 0, or null (= unlimited). */
const normalizeAiLimit = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "" || value === "null") return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return null;
    return Math.floor(num);
};

protectedRouter.get("/ai/limits", requirePermission('manage_plans'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const result = await query(
            `SELECT id, name, price, currency, duration, is_active,
                    metric_ai_enabled,
                    metric_ai_chat_daily, metric_ai_chat_monthly,
                    metric_ai_image_daily, metric_ai_image_monthly,
                    metric_ai_video_daily, metric_ai_video_monthly
             FROM pricing_plans
             ORDER BY price ASC, created_at ASC`
        );
        res.json({ success: true, data: { plans: result.rows } });
    } catch (error: any) {
        console.error("Admin list AI limits error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to load AI limits" });
    }
});

protectedRouter.put("/ai/limits/:planId", requirePermission('manage_plans'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { planId } = req.params;
        const body = req.body || {};

        const planCheck = await query(`SELECT id, name FROM pricing_plans WHERE id = $1`, [planId]);
        if (planCheck.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Plan not found" });
        }

        const values: Record<string, number | null> = {};
        for (const field of AI_LIMIT_FIELDS) {
            // Accept camelCase or snake_case keys from the admin UI
            const camel = field.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
            if (body[field] !== undefined || body[camel] !== undefined) {
                values[field] = normalizeAiLimit(body[field] ?? body[camel]);
            }
        }

        const sets: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        for (const [field, value] of Object.entries(values)) {
            sets.push(`${field} = $${idx}`);
            params.push(value);
            idx += 1;
        }
        if (typeof body.metric_ai_enabled === "boolean" || typeof body.metricAiEnabled === "boolean") {
            sets.push(`metric_ai_enabled = $${idx}`);
            params.push(Boolean(body.metric_ai_enabled ?? body.metricAiEnabled));
            idx += 1;
        }
        if (sets.length === 0) {
            return res.status(400).json({ success: false, error: "No limit fields provided" });
        }

        params.push(planId);
        await query(
            `UPDATE pricing_plans SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`,
            params,
        );
        invalidatePlanLimitsCache();

        const updated = await query(
            `SELECT id, name, metric_ai_enabled,
                    metric_ai_chat_daily, metric_ai_chat_monthly,
                    metric_ai_image_daily, metric_ai_image_monthly,
                    metric_ai_video_daily, metric_ai_video_monthly
             FROM pricing_plans WHERE id = $1`,
            [planId],
        );
        res.json({
            success: true,
            message: `MetricAi limits updated for ${planCheck.rows[0].name}`,
            data: updated.rows[0],
        });
    } catch (error: any) {
        console.error("Admin update AI limits error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to update AI limits" });
    }
});

// ============================================================================
// GROWTH — site wishlist, email subscribers, notification campaigns
// (gated by the 'manage_growth' permission)
// ============================================================================

import {
  SUBSCRIBER_CATEGORIES,
  sendCategoryCampaign,
  normalizeCategories,
} from "../services/siteGrowth";

protectedRouter.get("/growth/categories", requirePermission('manage_growth'), async (_req: AuthenticatedAdminRequest, res) => {
    res.json({ success: true, data: SUBSCRIBER_CATEGORIES });
});

protectedRouter.get("/growth/overview", requirePermission('manage_growth'), async (_req: AuthenticatedAdminRequest, res) => {
    try {
        const wishlistRes = await query(`SELECT COUNT(*)::int AS total FROM site_wishlist_entries`);
        const subscribersRes = await query(`SELECT COUNT(*)::int AS total FROM site_subscribers WHERE is_active = TRUE`);
        const perCategory = await query(
            `SELECT c AS category, COUNT(*)::int AS total
             FROM site_subscribers, unnest(categories) AS c
             WHERE is_active = TRUE
             GROUP BY c ORDER BY total DESC`
        );
        const campaignsRes = await query(
            `SELECT COUNT(*)::int AS total, COALESCE(SUM(sent_count), 0)::int AS emails_sent FROM site_email_campaigns`
        );
        const last7 = await query(
            `SELECT COUNT(*)::int AS total FROM site_wishlist_entries WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '7 days'`
        );
        res.json({
            success: true,
            data: {
                wishlist_total: wishlistRes.rows[0].total,
                wishlist_last_7_days: last7.rows[0].total,
                subscribers_total: subscribersRes.rows[0].total,
                subscribers_per_category: perCategory.rows,
                campaigns_total: campaignsRes.rows[0].total,
                emails_sent_total: campaignsRes.rows[0].emails_sent,
            },
        });
    } catch (error: any) {
        console.error("Admin growth overview error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to load growth overview" });
    }
});

/**
 * @swagger
 * /admin/growth/wishlist:
 *   get:
 *     summary: List all Personal wishlist entries (searchable, paginated)
 *     tags: [Admin]
 */
protectedRouter.get("/growth/wishlist", requirePermission('manage_growth'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
        const offset = (page - 1) * limit;

        const params: unknown[] = [];
        let where = "";
        if (search) {
            params.push(`%${search}%`);
            where = `WHERE name ILIKE $1 OR email ILIKE $1 OR note ILIKE $1`;
        }

        const totalRes = await query(`SELECT COUNT(*)::int AS total FROM site_wishlist_entries ${where}`, params);
        const rowsRes = await query(
            `SELECT id, name, email, features, note, source, welcome_email_sent_at as "welcomeEmailSentAt", created_at as "createdAt"
             FROM site_wishlist_entries ${where}
             ORDER BY created_at DESC
             LIMIT ${limit} OFFSET ${offset}`,
            params,
        );
        res.json({
            success: true,
            data: {
                items: rowsRes.rows,
                total: totalRes.rows[0].total,
                page,
                limit,
            },
        });
    } catch (error: any) {
        console.error("Admin wishlist list error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to load wishlist" });
    }
});

protectedRouter.delete("/growth/wishlist/:id", requirePermission('manage_growth'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const result = await query(`DELETE FROM site_wishlist_entries WHERE id = $1 RETURNING id`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: "Wishlist entry not found" });
        res.json({ success: true, message: "Wishlist entry removed" });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to delete wishlist entry" });
    }
});

/**
 * @swagger
 * /admin/growth/subscribers:
 *   get:
 *     summary: List email subscribers (filter by category, searchable)
 *     tags: [Admin]
 */
protectedRouter.get("/growth/subscribers", requirePermission('manage_growth'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const category = String(req.query.category || "").trim();
        const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
        const offset = (page - 1) * limit;

        const params: unknown[] = [];
        const clauses: string[] = [];
        if (search) {
            params.push(`%${search}%`);
            clauses.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`);
        }
        if (category) {
            params.push(category);
            clauses.push(`$${params.length} = ANY(categories)`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

        const totalRes = await query(`SELECT COUNT(*)::int AS total FROM site_subscribers ${where}`, params);
        const rowsRes = await query(
            `SELECT id, name, email, categories, source, is_active as "isActive",
                    welcome_email_sent_at as "welcomeEmailSentAt", created_at as "createdAt"
             FROM site_subscribers ${where}
             ORDER BY created_at DESC
             LIMIT ${limit} OFFSET ${offset}`,
            params,
        );
        res.json({
            success: true,
            data: { items: rowsRes.rows, total: totalRes.rows[0].total, page, limit },
        });
    } catch (error: any) {
        console.error("Admin subscribers list error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to load subscribers" });
    }
});

/** Admin manually adds a subscriber. */
protectedRouter.post("/growth/subscribers", requirePermission('manage_growth'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { addSubscriber, isValidEmail } = await import("../services/siteGrowth");
        const email = String(req.body?.email || "").trim();
        if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "A valid email address is required" });
        const result = await addSubscriber({
            name: req.body?.name,
            email,
            categories: normalizeCategories(req.body?.categories).length
                ? normalizeCategories(req.body?.categories)
                : ["product_updates"],
            source: "admin",
        });
        res.json({ success: true, data: result, message: "Subscriber added" });
    } catch (error: any) {
        res.status(400).json({ success: false, error: error.message || "Could not add subscriber" });
    }
});

/** Update a subscriber's categories / active flag. */
protectedRouter.put("/growth/subscribers/:id", requirePermission('manage_growth'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (Array.isArray(req.body?.categories)) {
            const cats = normalizeCategories(req.body.categories);
            params.push(cats);
            sets.push(`categories = $${params.length}`);
        }
        if (typeof req.body?.isActive === "boolean") {
            params.push(req.body.isActive);
            sets.push(`is_active = $${params.length}`);
        }
        if (sets.length === 0) return res.status(400).json({ success: false, error: "Nothing to update" });
        params.push(req.params.id);
        const result = await query(
            `UPDATE site_subscribers SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $${params.length}
             RETURNING id, email, categories, is_active`,
            params,
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: "Subscriber not found" });
        res.json({ success: true, data: result.rows[0], message: "Subscriber updated" });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to update subscriber" });
    }
});

protectedRouter.delete("/growth/subscribers/:id", requirePermission('manage_growth'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const result = await query(`DELETE FROM site_subscribers WHERE id = $1 RETURNING id`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: "Subscriber not found" });
        res.json({ success: true, message: "Subscriber removed" });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to delete subscriber" });
    }
});

/**
 * @swagger
 * /admin/growth/campaigns/send:
 *   post:
 *     summary: Send an email notification to every subscriber of a category
 *     tags: [Admin]
 */
protectedRouter.post("/growth/campaigns/send", requirePermission('manage_growth'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const result = await sendCategoryCampaign({
            category: req.body?.category,
            subject: req.body?.subject,
            bodyHtml: req.body?.bodyHtml,
            createdBy: req.admin!.adminId,
        });
        res.json({
            success: true,
            message: `Campaign sent — ${result.sent}/${result.recipients} delivered`,
            data: result,
        });
    } catch (error: any) {
        res.status(400).json({ success: false, error: error.message || "Campaign failed" });
    }
});

protectedRouter.get("/growth/campaigns", requirePermission('manage_growth'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "25"), 10) || 25));
        const offset = (page - 1) * limit;
        const totalRes = await query(`SELECT COUNT(*)::int AS total FROM site_email_campaigns`);
        const rowsRes = await query(
            `SELECT id, category, subject, recipients_count as "recipientsCount", sent_count as "sentCount",
                    failed_count as "failedCount", created_at as "createdAt", completed_at as "completedAt"
             FROM site_email_campaigns
             ORDER BY created_at DESC
             LIMIT ${limit} OFFSET ${offset}`,
        );
        res.json({ success: true, data: { items: rowsRes.rows, total: totalRes.rows[0].total, page, limit } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load campaigns" });
    }
});

// ---------------------------------------------------------------------------
// Revenue features — admin management
// ---------------------------------------------------------------------------

/**
 * MetricAi Credit Packs CRUD. Pack prices are global; per-plan discounts are
 * configured on the plan itself (ai_credit_discount_percent via /admin/pricing).
 */
protectedRouter.get("/ai-credit-packs", requirePermission('manage_plans', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const rows = await query(`SELECT * FROM ai_credit_packs ORDER BY sort_order ASC, price ASC`);
        const stats = await query(
            `SELECT COALESCE(SUM(amount), 0) AS revenue, COUNT(*)::int AS purchases
             FROM ai_credit_purchases WHERE status = 'success'`
        );
        res.json({ success: true, packs: rows.rows, stats: stats.rows[0] });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load AI credit packs" });
    }
});

protectedRouter.post("/ai-credit-packs", requirePermission('manage_plans', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { name, credits, price, currency, is_active, sort_order } = req.body || {};
        if (!name || !credits || !price) return res.status(400).json({ success: false, error: "name, credits and price are required" });
        const rows = await query(
            `INSERT INTO ai_credit_packs (name, credits, price, currency, is_active, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [name, Math.round(Number(credits)), Number(price), currency || 'NGN', is_active ?? true, sort_order ?? 0]
        );
        res.json({ success: true, pack: rows.rows[0] });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to create AI credit pack" });
    }
});

protectedRouter.put("/ai-credit-packs/:id", requirePermission('manage_plans', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { id } = req.params;
        const { name, credits, price, currency, is_active, sort_order } = req.body || {};
        const rows = await query(
            `UPDATE ai_credit_packs SET
                name = COALESCE($2, name),
                credits = COALESCE($3, credits),
                price = COALESCE($4, price),
                currency = COALESCE($5, currency),
                is_active = COALESCE($6, is_active),
                sort_order = COALESCE($7, sort_order),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING *`,
            [id, name || null, credits != null ? Math.round(Number(credits)) : null, price != null ? Number(price) : null,
             currency || null, is_active ?? null, sort_order ?? null]
        );
        if (rows.rows.length === 0) return res.status(404).json({ success: false, error: "Pack not found" });
        res.json({ success: true, pack: rows.rows[0] });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to update AI credit pack" });
    }
});

protectedRouter.delete("/ai-credit-packs/:id", requirePermission('manage_plans', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { id } = req.params;
        const rows = await query(`DELETE FROM ai_credit_packs WHERE id = $1 RETURNING id`, [id]);
        if (rows.rows.length === 0) return res.status(404).json({ success: false, error: "Pack not found" });
        res.json({ success: true, message: "Pack deleted" });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to delete AI credit pack" });
    }
});

/** Platform-wide Payment Links overview (admin). */
protectedRouter.get("/payment-links", requirePermission('manage_plans', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const summary = await query(
            `SELECT COUNT(*)::int AS total_links,
                    COALESCE(SUM(CASE WHEN is_active THEN 1 ELSE 0 END), 0)::int AS active_links
             FROM payment_links`
        );
        const payments = await query(
            `SELECT COALESCE(SUM(amount), 0) AS gross, COALESCE(SUM(fee), 0) AS fees, COALESCE(SUM(net_amount), 0) AS net,
                    COUNT(*)::int AS transactions
             FROM payment_link_payments WHERE status = 'success'`
        );
        const recent = await query(
            `SELECT q.transaction_reference, q.amount, q.fee, q.net_amount, q.currency, q.status,
                    q.payer_name, q.payer_email, q.payment_provider, q.created_at,
                    l.title AS link_title, b.name AS business_name
             FROM payment_link_payments q
             JOIN payment_links l ON l.id = q.link_id
             LEFT JOIN businesses b ON b.id = q.business_id
             ORDER BY q.created_at DESC LIMIT 50`
        );
        res.json({ success: true, summary: summary.rows[0], payments: payments.rows[0], recent: recent.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load payment links overview" });
    }
});

/**
 * @openapi
 * /admin/invoices:
 *   get:
 *     summary: Platform-wide Smart Invoices overview (revenue, volumes, recent payments)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Invoice summary + payments + recent activity
 */
protectedRouter.get("/invoices", requirePermission('manage_plans', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const summary = await query(
            `SELECT COUNT(*)::int AS total_invoices,
                    COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending_invoices,
                    COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0)::int AS paid_invoices
             FROM invoices`
        );
        const payments = await query(
            `SELECT COALESCE(SUM(amount), 0) AS gross, COALESCE(SUM(fee), 0) AS fees, COALESCE(SUM(net_amount), 0) AS net,
                    COUNT(*)::int AS transactions
             FROM invoice_payments WHERE status = 'success'`
        );
        const recent = await query(
            `SELECT q.transaction_reference, q.amount, q.fee, q.net_amount, q.currency, q.status,
                    q.payer_name, q.payer_email, q.payment_provider, q.created_at,
                    i.invoice_number, i.client_name, b.name AS business_name
             FROM invoice_payments q
             JOIN invoices i ON i.id = q.invoice_id
             LEFT JOIN businesses b ON b.id = q.business_id
             ORDER BY q.created_at DESC LIMIT 50`
        );
        res.json({ success: true, summary: summary.rows[0], payments: payments.rows[0], recent: recent.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load invoices overview" });
    }
});

/**
 * @openapi
 * /admin/store:
 *   get:
 *     summary: Platform-wide Storefront overview (products, orders, order-fee revenue, recent orders)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Store summary + money stats + recent activity
 */
protectedRouter.get("/store", requirePermission('manage_plans', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const summary = await query(
            `SELECT COUNT(*)::int AS total_products,
                    COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0)::int AS active_products
             FROM store_products`
        );
        const orders = await query(
            `SELECT COUNT(*)::int AS total_orders,
                    COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN 1 ELSE 0 END), 0)::int AS paid_orders,
                    COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending_orders,
                    COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN total ELSE 0 END), 0) AS gross,
                    COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN fee ELSE 0 END), 0) AS revenue
             FROM store_orders`
        );
        const recent = await query(
            `SELECT o.order_number, o.customer_name, o.total, o.fee, o.currency, o.status, o.payment_provider, o.created_at,
                    b.name AS business_name
             FROM store_orders o
             LEFT JOIN businesses b ON b.id = o.business_id
             ORDER BY o.created_at DESC LIMIT 50`
        );
        res.json({ success: true, summary: summary.rows[0], orders: orders.rows[0], recent: recent.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load store overview" });
    }
});

/**
 * @openapi
 * /admin/subscriptions:
 *   get:
 *     summary: Platform-wide Recurring Billing overview (plans, subscribers, charge-fee revenue, recent charges)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription summary + money stats + recent activity
 */
protectedRouter.get("/subscriptions", requirePermission('manage_plans', 'manage_finance'), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const summary = await query(
            `SELECT COUNT(*)::int AS total_plans,
                    COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0)::int AS active_plans
             FROM customer_subscription_plans`
        );
        const subscribers = await query(
            `SELECT COUNT(*)::int AS total_subscribers,
                    COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0)::int AS active_subscribers,
                    COALESCE(SUM(CASE WHEN status = 'past_due' THEN 1 ELSE 0 END), 0)::int AS past_due,
                    COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0)::int AS cancelled
             FROM customer_subscribers`
        );
        const money = await query(
            `SELECT COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) AS gross,
                    COALESCE(SUM(CASE WHEN status = 'success' THEN fee ELSE 0 END), 0) AS revenue,
                    COALESCE(SUM(CASE WHEN status = 'success' THEN net_amount ELSE 0 END), 0) AS net,
                    COUNT(*)::int AS successful_charges
             FROM subscription_charges`
        );
        const recent = await query(
            `SELECT c.reference, c.amount, c.fee, c.net_amount, c.currency, c.status, c.charge_path, c.created_at,
                    s.customer_name, s.customer_email, p.name AS plan_name, p.interval,
                    b.name AS business_name
             FROM subscription_charges c
             JOIN customer_subscribers s ON s.id = c.subscriber_id
             JOIN customer_subscription_plans p ON p.id = c.plan_id
             LEFT JOIN businesses b ON b.id = c.business_id
             ORDER BY c.created_at DESC LIMIT 50`
        );
        res.json({ success: true, summary: summary.rows[0], subscribers: subscribers.rows[0], money: money.rows[0], recent: recent.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load subscriptions overview" });
    }
});

// ============================================================================
// REQUEST LOGS (Activity Logs screen) — every API call from BOTH the user app
// and this admin panel, with encrypted-at-rest payloads. Filter by actor
// (email/phone/name), type (admin/user), method, status, date range.
// ============================================================================

/**
 * @swagger
 * /admin/request-logs:
 *   get:
 *     summary: Query the encrypted API request log trail
 *     tags: [Admin]
 *     security: [ { bearerAuth: [] } ]
 */
protectedRouter.get("/request-logs", requirePermission("view_request_logs"), async (req: AuthenticatedAdminRequest, res) => {
    try {
      const {
        type = "all", // all | admin | user
        search = "",
        method = "",
        path = "",
        status = "",
        startDate = "",
        endDate = "",
        page = "1",
        limit = "25",
      } = req.query as Record<string, string>;

      const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 25));
      const offset = (pageNum - 1) * limitNum;

      const where: string[] = [];
      const params: any[] = [];
      const push = (val: any) => {
        params.push(val);
        return `$${params.length}`;
      };

      if (type === "admin" || type === "user") {
        where.push(`l.user_type = ${push(type)}`);
      }
      if (method) {
        where.push(`l.method = ${push(String(method).toUpperCase())}`);
      }
      if (path) {
        where.push(`l.path ILIKE ${push("%" + path + "%")}`);
      }
      if (status) {
        // Accept a class (2xx/4xx/5xx) or an exact code (401).
        const statusStr = String(status);
        const classMatch = statusStr.match(/^([2-5])xx$/i);
        if (classMatch) {
          const lo = Number(classMatch[1]) * 100;
          where.push(`l.status_code >= ${lo} AND l.status_code < ${lo + 100}`);
        } else if (/^\d{3}$/.test(statusStr)) {
          where.push(`l.status_code = ${push(Number(statusStr))}`);
        }
      }
      if (startDate) {
        where.push(`l.created_at >= ${push(`${startDate} 00:00:00`)}::timestamptz`);
      }
      if (endDate) {
        where.push(`l.created_at <= ${push(`${endDate} 23:59:59`)}::timestamptz`);
      }
      const s = String(search || "").trim();
      if (s) {
        const like = `%${s}%`;
        // Actor search spans business users (users table) and platform admins.
        where.push(
          `(
            u.email ILIKE ${push(like)} OR u.phone_number ILIKE ${push(like)} OR u.name ILIKE ${push(like)}
            OR pa.email ILIKE ${push(like)} OR pa.name ILIKE ${push(like)}
            OR l.path ILIKE ${push(like)}
          )`,
        );
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const totalRes = await query(
        `SELECT COUNT(*)::int AS total
         FROM api_request_logs l
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN platform_admins pa ON pa.id = l.user_id
         ${whereSql}`,
        params,
      );
      const total = totalRes.rows[0]?.total || 0;

      const logsRes = await query(
        `SELECT l.id, l.user_type AS "userType", l.user_id AS "userId", l.business_id AS "businessId",
                l.method, l.path, l.status_code AS "statusCode", l.duration_ms AS "durationMs",
                l.ip, l.user_agent AS "userAgent",
                (l.request_payload IS NOT NULL OR l.response_payload IS NOT NULL) AS "hasPayload",
                l.encrypted,
                l.created_at AS "createdAt",
                u.name AS "userName", u.email AS "userEmail", u.phone_number AS "userPhone",
                pa.email AS "adminEmail", pa.name AS "adminName"
         FROM api_request_logs l
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN platform_admins pa ON pa.id = l.user_id
         ${whereSql}
         ORDER BY l.created_at DESC
         LIMIT ${limitNum} OFFSET ${offset}`,
        params,
      );

      const logs = logsRes.rows.map((r: any) => ({
        ...r,
        userEmail: r.userEmail || r.adminEmail || null,
        userName: r.userName || r.adminName || null,
        adminEmail: undefined,
        adminName: undefined,
      }));

      res.json({
        success: true,
        data: { logs, total, page: pageNum, pages: Math.max(1, Math.ceil(total / limitNum)) },
      });
    } catch (error: any) {
      console.error("Admin request-logs list error:", error);
      res.status(500).json({ success: false, error: error.message || "Failed to load request logs" });
    }
  });

protectedRouter.get("/request-logs/stats", requirePermission("view_request_logs"), async (req: AuthenticatedAdminRequest, res) => {
    try {
      const result = await query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE user_type = 'admin')::int AS "adminActions",
          COUNT(*) FILTER (WHERE user_type = 'user')::int AS "userActions",
          COUNT(*) FILTER (WHERE status_code >= 400 AND created_at >= NOW() - INTERVAL '24 hours')::int AS "errors24h"
        FROM api_request_logs
      `);
      res.json({ success: true, data: result.rows[0] || { today: 0, total: 0, adminActions: 0, userActions: 0, errors24h: 0 } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || "Failed to load request log stats" });
    }
  });

protectedRouter.get("/request-logs/:id", requirePermission("view_request_logs"), async (req: AuthenticatedAdminRequest, res) => {
    try {
      const { id } = req.params;
      const logRes = await query(
        `SELECT l.*, u.name AS "userName", u.email AS "userEmail", u.phone_number AS "userPhone",
                pa.email AS "adminEmail", pa.name AS "adminName"
         FROM api_request_logs l
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN platform_admins pa ON pa.id = l.user_id
         WHERE l.id = $1`,
        [id],
      );
      if (logRes.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Log entry not found" });
      }
      const row = logRes.rows[0];
      res.json({
        success: true,
        data: {
          ...row,
          userType: row.user_type,
          userId: row.user_id,
          businessId: row.business_id,
          statusCode: row.status_code,
          durationMs: row.duration_ms,
          userAgent: row.user_agent,
          // Payload bodies in their STORED form (ciphertext when encrypted).
          // The admin UI renders them in the payload sections and shows the
          // Decrypt action for encrypted rows; plaintext arrives only through
          // POST /request-logs/:id/decrypt.
          requestBody: row.request_payload ?? null,
          responseBody: row.response_payload ?? null,
          requestPayload: row.request_payload ?? null,
          responsePayload: row.response_payload ?? null,
          encrypted: !!row.encrypted,
          userEmail: row.userEmail || row.adminEmail || null,
          userName: row.userName || row.adminName || null,
          createdAt: row.created_at,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || "Failed to load request log" });
    }
  });

/**
 * Clear the request-log trail. Permission-gated; supports three modes:
 *   scope=old   -> delete everything older than 24h (default)
 *   scope=all   -> wipe the whole table
 *   scope=range -> delete between startDate/endDate (inclusive)
 * Returns the number of deleted rows.
 */
protectedRouter.post("/request-logs/clear", requirePermission("decrypt_request_logs"), async (req: AuthenticatedAdminRequest, res) => {
    try {
      const scope = String((req.body as any)?.scope || "old").toLowerCase();
      let result: { rowCount?: number | null };
      if (scope === "all") {
        result = await query(`DELETE FROM api_request_logs`);
      } else if (scope === "range") {
        const startDate = String((req.body as any)?.startDate || "").slice(0, 10);
        const endDate = String((req.body as any)?.endDate || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
          return res.status(400).json({ success: false, error: "startDate and endDate (YYYY-MM-DD) are required for scope=range" });
        }
        result = await query(
          `DELETE FROM api_request_logs
           WHERE created_at >= $1::timestamptz AND created_at < ($2::date + INTERVAL '1 day')`,
          [`${startDate} 00:00:00`, endDate],
        );
      } else {
        result = await query(`DELETE FROM api_request_logs WHERE created_at < NOW() - INTERVAL '24 hours'`);
      }
      const deleted = result.rowCount || 0;
      console.log(`[admin] request-logs cleared by admin ${req.admin?.adminId}: scope=${scope} deleted=${deleted}`);
      res.json({ success: true, data: { deleted, scope } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || "Failed to clear request logs" });
    }
  });

/**
 * Decrypt a single log entry's request/response payloads. Requires the
 * `decrypt_request_logs` permission (super-admins bypass). The response
 * contains the PLAINTEXT bodies — this is the ONLY place the platform
 * exposes them.
 */
protectedRouter.post("/request-logs/:id/decrypt", requirePermission("decrypt_request_logs"), async (req: AuthenticatedAdminRequest, res) => {
    try {
      const { id } = req.params;
      const logRes = await query(`SELECT * FROM api_request_logs WHERE id = $1`, [id]);
      if (logRes.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Log entry not found" });
      }
      const row = logRes.rows[0];
      if (!row.encrypted) {
        return res.json({
          success: true,
          data: { requestBody: row.request_payload, responseBody: row.response_payload },
        });
      }
      const { decryptString } = await import("../lib/payload-crypto");
      const requestBody = row.request_payload ? decryptString(row.request_payload) : null;
      const responseBody = row.response_payload ? decryptString(row.response_payload) : null;
      if (row.request_payload && requestBody === null) {
        return res.status(409).json({
          success: false,
          error: "Payload cannot be decrypted with the current PAYLOAD_ENCRYPTION_KEY (key may have been rotated)",
          code: "DECRYPT_KEY_MISMATCH",
        });
      }
      res.json({ success: true, data: { requestBody, responseBody } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || "Failed to decrypt request log" });
    }
  });


// ============================================================================
// LOCKED / BLOCKED ACCOUNTS — login lockout escalation. 5 failed passwords
// lock an account for 30 minutes; after 3 lock cycles the account is blocked
// until support (here) resolves it.
// ============================================================================

protectedRouter.get("/locked-accounts", requirePermission("view_dashboard"), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { search = "", status = "all" } = req.query as Record<string, string>;
        const params: any[] = [];
        const where: string[] = [];
        let having = "";
        if (status === "blocked") {
            where.push("u.account_blocked = TRUE");
        } else if (status === "locked") {
            where.push("u.account_blocked = FALSE AND u.locked_until > NOW()");
        } else if (status === "attempts") {
            where.push("u.account_blocked = FALSE AND (u.locked_until IS NULL OR u.locked_until <= NOW()) AND u.failed_login_attempts > 0");
        } else {
            where.push("(u.account_blocked = TRUE OR u.locked_until > NOW() OR u.failed_login_attempts > 0)");
        }
        if (search) {
            params.push(`%${search}%`);
            where.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
        }
        having = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const result = await query(
            `SELECT u.id, u.email, u.name, u.business_id as "businessId",
                    u.failed_login_attempts AS "failedAttempts",
                    u.lock_count AS "lockCount",
                    u.locked_until AS "lockedUntil",
                    u.account_blocked AS "blocked",
                    u.blocked_at AS "blockedAt",
                    (SELECT MAX(la.created_at) FROM login_attempts la WHERE la.email = u.email) AS "lastLoginAt",
                    CASE
                        WHEN u.account_blocked THEN 'blocked'
                        WHEN u.locked_until > NOW() THEN 'locked'
                        ELSE 'failed_attempts'
                    END AS status
             FROM users u
             ${having}
             ORDER BY u.account_blocked DESC, u.locked_until DESC NULLS LAST, u.failed_login_attempts DESC
             LIMIT 200`,
            params,
        );
        res.json({ success: true, data: { accounts: result.rows } });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load locked accounts" });
    }
});

/**
 * POST /admin/locked-accounts/:userId/resolve — unlock AND unblock: clears the
 * attempt counter, the lock window and the permanent block flag.
 */
protectedRouter.post("/locked-accounts/:userId/resolve", requirePermission("manage_team"), async (req: AuthenticatedAdminRequest, res) => {
    try {
        const { userId } = req.params;
        const result = await query(
            `UPDATE users
             SET failed_login_attempts = 0,
                 locked_until = NULL,
                 account_blocked = FALSE,
                 blocked_at = NULL,
                 lock_count = 0
             WHERE id = $1
             RETURNING id, email, name, account_blocked, locked_until, lock_count`,
            [userId],
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Account not found" });
        }
        const row = result.rows[0];
        // Notify the user their access was restored (best-effort).
        try {
            const { sendEmail } = await import("../services/email");
            const logoUrl = process.env.APP_LOGO_URL || "https://metricorex.com/Assets/logo.png";
            await sendEmail(
                row.email,
                row.name || "User",
                "Your Metricorex account has been reactivated",
                `<html><body style="font-family:'Segoe UI',Tahoma,sans-serif;background:#f3f4f6;padding:40px 0;">
                 <div style="max-width:600px;margin:0 auto;background:#fff;padding:40px;border-radius:12px;">
                 <div style="text-align:center;margin-bottom:24px;"><img src="${logoUrl}" alt="Metricorex" style="max-width:160px;"/></div>
                 <h1 style="color:#111827;font-size:22px;text-align:center;">Account Reactivated</h1>
                 <p style="color:#374151;font-size:15px;line-height:1.6;">Good news — our support team has reactivated your account after the recent sign-in issues. You can sign in again now.</p>
                 <p style="color:#6b7280;font-size:13px;">If you did not request this, please contact support immediately.</p>
                 </div></body></html>`,
            );
        } catch {}
        res.json({ success: true, message: "Account unlocked and reactivated", data: row });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to resolve account" });
    }
});

export default router;
