import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus, checkFeaturePermission } from "../middleware/auth";
import { processAllPending, accountLookup } from "../services/transfer";
import { getProvider } from "../services/providers/factory";
import { calculateFee, creditRevenueWallet } from "../services/fees";
import { generateOTP, getOTPExpiry } from "../services/auth";
import { sendEmail, generateOtpEmailHtml } from "../services/email";
import { sendSMS } from "../services/sms";

const router = express.Router();

// Helper to generate reference if util doesn't exist
const genRef = () => `TRF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

/**
 * @swagger
 * tags:
 *   name: Transfers
 *   description: Bulk transfer and queue management
 */

/**
 * @swagger
 * /transfers/otp/request:
 *   post:
 *     summary: Request OTP for transfer authorization
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               wallet_id:
 *                 type: string
 *                 description: Optional wallet ID to charge SMS fee from
 *     responses:
 *       200:
 *         description: OTP sent
 */
router.post("/otp/request", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const userId = req.user!.userId;
        const { wallet_id } = req.body;

        // 1. Get Preference & User Info
        const prefRes = await query(`SELECT otp_preference FROM businesses WHERE id = $1`, [businessId]);
        const business = prefRes.rows[0];
        const preference = business.otp_preference || 'email';

        const userRes = await query(`SELECT email, phone_number FROM users WHERE id = $1`, [userId]);
        const user = userRes.rows[0];

        // 2. Generate OTP
        const otpCode = generateOTP();
        const otpExpiresAt = getOTPExpiry();

        await query(
            `UPDATE users SET otp_code = $1, otp_expires_at = $2 WHERE id = $3`,
            [otpCode, otpExpiresAt, userId]
        );

        let feeCharged = 0;

        // 3. Send OTP
        if (preference === 'email' || preference === 'both') {
            const emailHtml = generateOtpEmailHtml(otpCode, "Transfer Verification");
            await sendEmail(user.email, "Transfer OTP", "Confirm Transfer", emailHtml);
        }

        if (preference === 'sms' || preference === 'both') {
            if (!user.phone_number) {
                 return res.status(400).json({ success: false, error: "User phone number required for SMS OTP. Please update your profile." });
            }
            
            // Charge Fee
            const feeAmt = await calculateFee(1, 'otp_sms'); 
            if (feeAmt > 0) {
                 // Find wallet
                 let wallet;
                 if (wallet_id) {
                     const wRes = await query(`SELECT * FROM wallets WHERE id = $1 AND business_id = $2`, [wallet_id, businessId]);
                     wallet = wRes.rows[0];
                 } else {
                     const wRes = await query(`SELECT * FROM wallets WHERE business_id = $1 AND currency = 'NGN' LIMIT 1`, [businessId]);
                     wallet = wRes.rows[0];
                 }

                 if (!wallet) return res.status(400).json({ success: false, error: "No NGN wallet found to charge OTP fee" });
                 
                 if (parseFloat(wallet.balance) < feeAmt) {
                     return res.status(400).json({ success: false, error: "Insufficient wallet balance for OTP SMS fee" });
                 }

                 // Debit
                 await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [feeAmt, wallet.id]);
                 
                 // Record Transaction
                 await query(
                    `INSERT INTO transactions 
                     (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee)
                     VALUES ($1, $2, $3, 'success', $4, 'debit', 'OTP SMS Fee', 'fee', $5, 'debit', $6)`,
                    [businessId, feeAmt, 'NGN', `OTP-FEE-${Date.now()}`, wallet.id, feeAmt]
                 );
                 
                 await creditRevenueWallet(feeAmt, 'NGN');
                 feeCharged = feeAmt;
            }

            await sendSMS(user.phone_number, `Your Transfer OTP is: ${otpCode}`);
        }

        res.json({ success: true, message: "OTP sent successfully", fee_charged: feeCharged });

    } catch (error) {
        console.error("OTP Request error:", error);
        res.status(500).json({ success: false, error: "Failed to request OTP" });
    }
});

/**
 * @swagger
 * /transfers/single:
 *   post:
 *     summary: Initiate a single transfer
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - bankCode
 *               - accountNumber
 *               - amount
 *               - otp
 *             properties:
 *               bankCode:
 *                 type: string
 *               accountNumber:
 *                 type: string
 *               accountName:
 *                 type: string
 *               amount:
 *                 type: number
 *               remark:
 *                 type: string
 *               otp:
 *                 type: string
 *               wallet_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Transfer queued
 */
router.post("/single", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const { bankCode, accountNumber, accountName, amount, remark, otp, wallet_id } = req.body;
        const businessId = req.user?.businessId;
        const userId = req.user?.userId;

        if (!otp) {
            return res.status(400).json({ success: false, error: "OTP is required" });
        }

        // Verify OTP
        const uRes = await query(`SELECT otp_code, otp_expires_at FROM users WHERE id = $1`, [userId]);
        const user = uRes.rows[0];

        if (!user.otp_code || user.otp_code !== otp) {
            return res.status(400).json({ success: false, error: "Invalid OTP" });
        }
        if (new Date(user.otp_expires_at) < new Date()) {
            return res.status(400).json({ success: false, error: "OTP expired" });
        }

        // Invalidate OTP
        await query(`UPDATE users SET otp_code = NULL WHERE id = $1`, [userId]);

        // Validate Wallet
        let walletId = wallet_id;
        if (!walletId) {
             const wRes = await query(`SELECT id FROM wallets WHERE business_id = $1 LIMIT 1`, [businessId]);
             if (wRes.rows.length > 0) walletId = wRes.rows[0].id;
             else return res.status(400).json({ success: false, error: "Wallet ID required" });
        }

        // Calculate Fee
        const fee = await calculateFee(amount, 'transfer');

        // Queue Transfer
        const defaultProvider = process.env.DEFAULT_PAYMENT_PROVIDER || 'squad';
        await query(
            `INSERT INTO transfer_queue 
            (business_id, reference, recipient_account, recipient_bank, recipient_name, amount, currency, remark, source_type, source_id, status, wallet_id, payment_provider)
            VALUES ($1, $2, $3, $4, $5, $6, 'NGN', $7, 'manual', null, 'pending', $8, $9)`,
            [businessId, genRef(), accountNumber, bankCode, accountName, amount, remark || 'Transfer', walletId, defaultProvider]
        );

        // Trigger processing
        processAllPending(businessId!).catch(err => console.error("Single transfer process error:", err));

        res.json({ success: true, message: "Transfer initiated successfully" });

    } catch (error) {
        console.error("Single transfer error:", error);
        res.status(500).json({ success: false, error: "Failed to initiate transfer" });
    }
});

/**
 * @swagger
 * /transfers/bulk:
 *   post:
 *     summary: Initiate a bulk transfer
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - otp
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [manual, sprint, salary, task]
 *               otp:
 *                 type: string
 *                 description: OTP code for authorization
 *               source_wallet_id:
 *                 type: string
 *                 description: ID of the wallet to fund the transfer from
 *               data:
 *                 type: object
 *                 description: Data depending on type (manual items, sprint name, task IDs)
 *     responses:
 *       200:
 *         description: Transfers queued
 */
router.post("/bulk", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
  try {
    const { type, data, source_wallet_id, otp } = req.body;
    const businessId = req.user?.businessId;
    
    if (!businessId) {
      return res.status(400).json({ success: false, error: "Business ID required" });
    }

    // Verify OTP
    if (!otp) {
        return res.status(400).json({ success: false, error: "OTP is required" });
    }
    const userId = req.user!.userId;
    const uRes = await query(`SELECT otp_code, otp_expires_at FROM users WHERE id = $1`, [userId]);
    const user = uRes.rows[0];
    
    if (!user.otp_code || user.otp_code !== otp) {
        return res.status(400).json({ success: false, error: "Invalid OTP" });
    }
    if (new Date(user.otp_expires_at) < new Date()) {
        return res.status(400).json({ success: false, error: "OTP expired" });
    }
    
    // Invalidate OTP
    await query(`UPDATE users SET otp_code = NULL WHERE id = $1`, [userId]);

    // Validate Source Wallet
    let walletId = source_wallet_id;
    if (!walletId) {
        // Try to find default business wallet
        const wRes = await query(`SELECT id FROM wallets WHERE business_id = $1 LIMIT 1`, [businessId]);
        if (wRes.rows.length > 0) {
            walletId = wRes.rows[0].id;
        } else {
            return res.status(400).json({ success: false, error: "Source wallet ID required" });
        }
    } else {
        // Verify ownership
        const wCheck = await query(`SELECT id FROM wallets WHERE id = $1 AND (business_id = $2 OR user_id IN (SELECT id FROM users WHERE business_id = $2))`, [walletId, businessId]);
        if (wCheck.rows.length === 0) {
            return res.status(403).json({ success: false, error: "Invalid source wallet" });
        }
    }

    let transfersToQueue: any[] = [];

    // 1. Prepare transfers based on type
    if (type === 'manual') {
      // data.items: Array of { amount, bankCode, accountNumber, accountName, remark }
      if (!Array.isArray(data?.items)) {
        return res.status(400).json({ success: false, error: "Items array required for manual type" });
      }
      transfersToQueue = await Promise.all(data.items.map(async (item: any) => ({
        ...item,
        sourceType: 'manual',
        sourceId: null,
        fee: await calculateFee(item.amount, 'transfer')
      })));

    } else if (type === 'salary') {
      // Pay all active employees with salary_amount > 0
      const usersRes = await query(
        `SELECT id, salary_amount, salary_currency, bank_code, account_number, account_name 
         FROM users 
         WHERE business_id = $1 AND status = 'active' AND salary_amount > 0`,
        [businessId]
      );
      
      const users = usersRes.rows.filter(u => u.bank_code && u.account_number);

      // Fetch pending adjustments for these users
      const userIds = users.map(u => u.id);
      let adjustmentsMap = new Map();
      
      if (userIds.length > 0) {
        const adjRes = await query(
          `SELECT * FROM payroll_adjustments 
           WHERE business_id = $1 AND status = 'pending' AND user_id = ANY($2::uuid[])`,
          [businessId, userIds]
        );
        
        adjRes.rows.forEach(adj => {
          if (!adjustmentsMap.has(adj.user_id)) {
            adjustmentsMap.set(adj.user_id, []);
          }
          adjustmentsMap.get(adj.user_id).push(adj);
        });
      }

      transfersToQueue = await Promise.all(users.map(async u => {
        let finalAmount = parseFloat(u.salary_amount);
        let remarks = ['Salary Payment'];
        const userAdjustments = adjustmentsMap.get(u.id) || [];
        
        // Apply adjustments
        userAdjustments.forEach((adj: any) => {
          const adjAmount = parseFloat(adj.amount);
          if (adj.type === 'bonus') {
            finalAmount += adjAmount;
            remarks.push(`Bonus: ${adj.reason} (+${adjAmount})`);
          } else if (adj.type === 'deduction') {
            finalAmount -= adjAmount;
            remarks.push(`Deduction: ${adj.reason} (-${adjAmount})`);
          }
        });

        return {
          amount: finalAmount > 0 ? finalAmount : 0,
          currency: u.salary_currency,
          bankCode: u.bank_code,
          accountNumber: u.account_number,
          accountName: u.account_name || 'Employee',
          remark: remarks.join('; '),
          sourceType: 'salary',
          sourceId: u.id,
          adjustments: userAdjustments, // Pass along to mark as processed later
          fee: await calculateFee(finalAmount > 0 ? finalAmount : 0, 'transfer')
        };
      }));

    } else if (type === 'sprint') {
      // Pay for tasks in a sprint
      // data.sprint: string (sprint name)
      if (!data?.sprint) return res.status(400).json({ success: false, error: "Sprint name required" });

      // Get business currency
      const businessRes = await query(`SELECT currency FROM businesses WHERE id = $1`, [businessId]);
      const businessCurrency = businessRes.rows[0]?.currency || 'NGN';

      const tasksRes = await query(
        `SELECT t.id, t.target_value, ta.user_id, t.currency 
         FROM tasks t
         JOIN task_assignments ta ON t.id = ta.task_id
         WHERE t.business_id = $1 AND t.sprint = $2 AND t.status = 'completed'`, 
        [businessId, data.sprint]
      );

      for (const row of tasksRes.rows) {
        const userRes = await query(
          `SELECT bank_code, account_number, account_name FROM users WHERE id = $1`,
          [row.user_id]
        );
        const user = userRes.rows[0];

        if (user && user.bank_code && user.account_number) {
          const assigneeCountRes = await query(`SELECT COUNT(*) FROM task_assignments WHERE task_id = $1`, [row.id]);
          const assigneeCount = parseInt(assigneeCountRes.rows[0].count) || 1;
          const splitAmount = row.target_value / assigneeCount;

          transfersToQueue.push({
            amount: splitAmount,
            currency: row.currency || businessCurrency,
            bankCode: user.bank_code,
            accountNumber: user.account_number,
            accountName: user.account_name,
            remark: `Sprint Payment: ${data.sprint}`,
            sourceType: 'sprint',
            sourceId: row.id, // Task ID
            fee: await calculateFee(splitAmount, 'transfer')
          });
        }
      }

    } else if (type === 'task') {
      // Pay specific tasks
      // data.taskIds: string[]
      if (!Array.isArray(data?.taskIds)) return res.status(400).json({ success: false, error: "Task IDs required" });

      // Get business currency
      const businessRes = await query(`SELECT currency FROM businesses WHERE id = $1`, [businessId]);
      const businessCurrency = businessRes.rows[0]?.currency || 'NGN';

      const tasksRes = await query(
        `SELECT t.id, t.target_value, ta.user_id, t.currency 
         FROM tasks t
         JOIN task_assignments ta ON t.id = ta.task_id
         WHERE t.business_id = $1 AND t.id = ANY($2::uuid[])`,
        [businessId, data.taskIds]
      );

      for (const row of tasksRes.rows) {
         const userRes = await query(
          `SELECT bank_code, account_number, account_name FROM users WHERE id = $1`,
          [row.user_id]
        );
        const user = userRes.rows[0];

        if (user && user.bank_code && user.account_number) {
           const assigneeCountRes = await query(`SELECT COUNT(*) FROM task_assignments WHERE task_id = $1`, [row.id]);
           const assigneeCount = parseInt(assigneeCountRes.rows[0].count) || 1;
           const splitAmount = row.target_value / assigneeCount;

           transfersToQueue.push({
             amount: splitAmount,
             currency: row.currency || businessCurrency,
             bankCode: user.bank_code,
             accountNumber: user.account_number,
             accountName: user.account_name,
             remark: `Task Payment`,
             sourceType: 'task',
             sourceId: row.id,
             fee: await calculateFee(splitAmount, 'transfer')
           });
        }
      }
    } else {
      return res.status(400).json({ success: false, error: "Invalid transfer type" });
    }

    if (transfersToQueue.length === 0) {
      return res.json({ success: true, message: "No eligible transfers found to queue" });
    }

    // 2. Insert into transfer_queue
    let queuedCount = 0;
    const defaultProvider = process.env.DEFAULT_PAYMENT_PROVIDER || 'squad';
    for (const t of transfersToQueue) {
      if (t.amount <= 0) continue;

      const transferRes = await query(
        `INSERT INTO transfer_queue 
        (business_id, reference, recipient_account, recipient_bank, recipient_name, amount, currency, remark, source_type, source_id, status, wallet_id, payment_provider)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12)
        RETURNING id`,
        [
          businessId,
          genRef(),
          t.accountNumber,
          t.bankCode,
          t.accountName,
          t.amount,
          t.currency || 'NGN',
          t.remark,
          t.sourceType,
          t.sourceId,
          walletId,
          t.payment_provider || defaultProvider
        ]
      );
      
      const transferId = transferRes.rows[0].id;

      // Mark adjustments as processed
      if (t.adjustments && t.adjustments.length > 0) {
        const adjustmentIds = t.adjustments.map((adj: any) => adj.id);
        await query(
          `UPDATE payroll_adjustments 
           SET status = 'processed', processed_at = CURRENT_TIMESTAMP, transfer_id = $1 
           WHERE id = ANY($2::uuid[])`,
          [transferId, adjustmentIds]
        );
      }

      queuedCount++;
    }

    // 3. Trigger processing in background
    processAllPending(businessId).catch(err => console.error("Background processing error:", err));

    res.json({ success: true, message: `Queued ${queuedCount} transfers for processing` });

  } catch (error) {
    console.error("Bulk transfer error:", error);
    res.status(500).json({ success: false, error: "Failed to initiate bulk transfer" });
  }
});

/**
 * @swagger
 * /transfers:
 *   get:
 *     summary: Get transfer queue
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by recipient name, account or reference
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, processing, success, failed]
 *         description: Filter by status
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
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Items per page
 *     responses:
 *       200:
 *         description: List of transfers
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
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 */
router.get("/", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user?.businessId;
    const { search, status, startDate, endDate, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let queryText = `SELECT * FROM transfer_queue WHERE business_id = $1`;
    let countQueryText = `SELECT COUNT(*) FROM transfer_queue WHERE business_id = $1`;
    const params: any[] = [businessId];
    let paramIdx = 2;

    if (search) {
      const searchClause = ` AND (recipient_name ILIKE $${paramIdx} OR recipient_account ILIKE $${paramIdx} OR reference ILIKE $${paramIdx})`;
      queryText += searchClause;
      countQueryText += searchClause;
      params.push(`%${search}%`);
      paramIdx++;
    }

    if (status) {
      const statusClause = ` AND status = $${paramIdx}`;
      queryText += statusClause;
      countQueryText += statusClause;
      params.push(status);
      paramIdx++;
    }

    if (startDate) {
      const startDateClause = ` AND created_at >= $${paramIdx}`;
      queryText += startDateClause;
      countQueryText += startDateClause;
      params.push(startDate);
      paramIdx++;
    }

    if (endDate) {
      const endDateClause = ` AND created_at <= $${paramIdx}`;
      queryText += endDateClause;
      countQueryText += endDateClause;
      params.push(endDate);
      paramIdx++;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    
    const result = await query(queryText, [...params, Number(limit), offset]);
    const countRes = await query(countQueryText, params);
    
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total: parseInt(countRes.rows[0].count),
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(parseInt(countRes.rows[0].count) / Number(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch transfers" });
  }
});

/**
 * @swagger
 * /transfers/{id}/retry:
 *   post:
 *     summary: Retry a failed transfer
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Retry initiated
 */
router.post("/:id/retry", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;

    // Verify ownership and status
    const check = await query(`SELECT * FROM transfer_queue WHERE id = $1 AND business_id = $2`, [id, businessId]);
    if (check.rows.length === 0) return res.status(404).json({ success: false, error: "Transfer not found" });
    
    if (check.rows[0].status !== 'failed') {
      return res.status(400).json({ success: false, error: "Only failed transfers can be retried" });
    }

    // Reset status to pending
    await query(`UPDATE transfer_queue SET status = 'pending', failure_reason = NULL, reference = $2 WHERE id = $1`, [id, `TRF-RETRY-${Date.now()}`]);

    // Trigger processing
    processAllPending(businessId).catch(err => console.error("Retry processing error:", err));

    res.json({ success: true, message: "Transfer retry initiated" });

  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to retry transfer" });
  }
});

/**
 * @swagger
 * /transfers/banks:
 *   get:
 *     summary: Get list of supported banks
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of banks
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
 *                       code:
 *                         type: string
 *                       name:
 *                         type: string
 */
router.get("/banks", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const provider = getProvider();
    const banks = provider.getBanks();
    res.json({ success: true, data: banks });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch banks" });
  }
});

/**
 * @swagger
 * /transfers/lookup:
 *   post:
 *     summary: Lookup account name
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - bankCode
 *               - accountNumber
 *             properties:
 *               bankCode:
 *                 type: string
 *               accountNumber:
 *                 type: string
 *     responses:
 *       200:
 *         description: Account details
 */
router.post("/lookup", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
  try {
    const { bankCode, accountNumber } = req.body;
    if (!bankCode || !accountNumber) {
      return res.status(400).json({ success: false, error: "Bank code and account number required" });
    }

    const data = await accountLookup(bankCode, accountNumber);
    res.json({ success: true, data });

  } catch (error: any) {
    res.status(500).json({ success: false, error: error.response?.data?.message || "Lookup failed" });
  }
});

/**
 * @swagger
 * /transfers/account-lookup:
 *   post:
 *     summary: Lookup account details
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - bank_code
 *               - account_number
 *             properties:
 *               bank_code:
 *                 type: string
 *               account_number:
 *                 type: string
 *     responses:
 *       200:
 *         description: Account details
 */
router.post("/account-lookup", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
  try {
    const { bank_code, account_number } = req.body;
    if (!bank_code || !account_number) {
      return res.status(400).json({ success: false, error: "Bank code and account number required" });
    }

    const data = await accountLookup(bank_code, account_number);
    res.json({ success: true, data });

  } catch (error: any) {
    res.status(500).json({ success: false, error: error.response?.data?.message || "Lookup failed" });
  }
});

export default router;
