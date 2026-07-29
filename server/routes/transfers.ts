import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus, checkFeaturePermission } from "../middleware/auth";
import { validateBody } from "../middleware/validation";
import { InitiateSingleTransferSchema, InitiateBulkTransferSchema } from "../lib/validation";
import { accountLookup, processAllPending } from "../services/transfer";
import { getProvider } from "../services/providers/factory";
import { calculateFee, creditRevenueWallet } from "../services/fees";
import { generateOTP, getOTPExpiry, verifyPassword } from "../services/auth";
import { sendEmail, generateOtpEmailHtml } from "../services/email";
import { sendSMS } from "../services/sms";
import { sendWhatsApp } from "../services/whatsapp";
import { logAuditEvent, generateTransactionHash } from "../services/audit";
import { transferQueue } from "../lib/queues";

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
 *     description: Sends an OTP (One-Time Password) to the authenticated user using their preferred method (email or SMS). The OTP is required to initiate any single or bulk transfer.
 *     tags: [Transfers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               wallet_id:
 *                 type: string
 *                 format: uuid
 *                 description: Optional wallet ID to charge SMS fee from (if SMS is the OTP method)
 *           examples:
 *             WithWalletId:
 *               summary: Request OTP with wallet ID for SMS fee
 *               value:
 *                 wallet_id: "550e8400-e29b-41d4-a716-446655440000"
 *             WithoutWalletId:
 *               summary: Request OTP without wallet ID (uses default wallet)
 *               value: {}
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "OTP sent successfully"
 *                 fee_charged:
 *                   type: number
 *                   description: Fee charged for SMS (if applicable)
 *                   example: 10.50
 *       400:
 *         description: Bad request (e.g., no wallet found for SMS fee)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "No NGN wallet found to charge OTP fee"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Failed to request OTP"
 */
router.post("/otp/request", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const userId = req.user!.userId;
        const { wallet_id, otp_method } = req.body;

        // 1. Get Preference & User Info
        const prefRes = await query(`SELECT otp_preference FROM businesses WHERE id = $1`, [businessId]);
        const business = prefRes.rows[0];
        const preference = otp_method || business.otp_preference || 'email';

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

        if (preference === 'whatsapp') {
            if (!user.phone_number) {
                 return res.status(400).json({ success: false, error: "User phone number required for WhatsApp OTP. Please update your profile." });
            }
            
            // Charge WhatsApp OTP fee
            const feeAmt = await calculateFee(1, 'otp_whatsapp'); 
            if (feeAmt > 0) {
                 let wallet;
                 if (wallet_id) {
                     const wRes = await query(`SELECT * FROM wallets WHERE id = $1 AND business_id = $2`, [wallet_id, businessId]);
                     wallet = wRes.rows[0];
                 } else {
                     const wRes = await query(`SELECT * FROM wallets WHERE business_id = $1 AND currency = 'NGN' LIMIT 1`, [businessId]);
                     wallet = wRes.rows[0];
                 }

                 if (!wallet) return res.status(400).json({ success: false, error: "No NGN wallet found to charge OTP WhatsApp fee" });
                 
                 if (parseFloat(wallet.balance) < feeAmt) {
                     return res.status(400).json({ success: false, error: "Insufficient wallet balance for OTP WhatsApp fee" });
                 }

                 await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [feeAmt, wallet.id]);
                 await query(
                    `INSERT INTO transactions 
                     (business_id, amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, fee)
                     VALUES ($1, $2, $3, 'success', $4, 'debit', 'OTP WhatsApp Fee', 'fee', $5, 'debit', $6)`,
                    [businessId, feeAmt, 'NGN', `OTP-WHATSAPP-FEE-${Date.now()}`, wallet.id, feeAmt]
                 );
                 
                 await creditRevenueWallet(feeAmt, 'NGN');
                 feeCharged = feeAmt;
            }

            await sendWhatsApp(user.phone_number, `Your Transfer OTP is: ${otpCode}`);
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
 *     description: Queues a single transfer to a recipient's bank account. Requires a valid OTP obtained from /transfers/otp/request.
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
 *                 description: Bank code of the recipient's bank (use /transfers/banks to get valid codes)
 *                 example: "058"
 *               accountNumber:
 *                 type: string
 *                 description: Recipient's bank account number
 *                 example: "0123456789"
 *               accountName:
 *                 type: string
 *                 description: Recipient's account name (optional, but recommended to verify)
 *                 example: "John Doe"
 *               amount:
 *                 type: number
 *                 description: Amount to transfer (in major currency unit, e.g., NGN)
 *                 example: 5000
 *               remark:
 *                 type: string
 *                 description: Optional remark for the transfer
 *                 example: "Payment for services"
 *               otp:
 *                 type: string
 *                 description: OTP obtained from /transfers/otp/request
 *                 example: "123456"
 *               wallet_id:
 *                 type: string
 *                 format: uuid
 *                 description: Optional wallet ID to debit from (uses default wallet if not provided)
 *                 example: "550e8400-e29b-41d4-a716-446655440000"
 *           examples:
 *             Example1:
 *               summary: Single transfer with all fields
 *               value:
 *                 bankCode: "058"
 *                 accountNumber: "0123456789"
 *                 accountName: "John Doe"
 *                 amount: 5000
 *                 remark: "Payment for services"
 *                 otp: "123456"
 *                 wallet_id: "550e8400-e29b-41d4-a716-446655440000"
 *             Example2:
 *               summary: Single transfer with minimal fields
 *               value:
 *                 bankCode: "033"
 *                 accountNumber: "9876543210"
 *                 amount: 10000
 *                 otp: "654321"
 *     responses:
 *       200:
 *         description: Transfer queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Transfer initiated successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                       description: Unique ID of the queued transfer
 *                     reference:
 *                       type: string
 *                       description: Unique transfer reference
 *                     amount:
 *                       type: number
 *                       description: Transfer amount
 *                     currency:
 *                       type: string
 *                       description: Transfer currency
 *                     fee:
 *                       type: number
 *                       description: Transfer fee
 *                     total:
 *                       type: number
 *                       description: Total amount (amount + fee)
 *                     recipient:
 *                       type: object
 *                       properties:
 *                         accountNumber:
 *                           type: string
 *                         bankCode:
 *                           type: string
 *                         accountName:
 *                           type: string
 *                     status:
 *                       type: string
 *                       description: Transfer status
 *                       enum: [pending, processing, success, failed]
 *                     walletId:
 *                       type: string
 *                       format: uuid
 *                       description: Wallet ID used for the transfer
 *                     paymentProvider:
 *                       type: string
 *                       description: Payment provider used
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Bad request (invalid OTP, missing fields, etc.)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Invalid OTP"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Failed to initiate transfer"
 */
router.post("/single", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), validateBody(InitiateSingleTransferSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const { bankCode, accountNumber, accountName, amount, remark, otp, pin, wallet_id } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;

    // Get business settings
    const businessRes = await query(
      `SELECT transaction_pin_hash, otp_enabled FROM businesses WHERE id = $1`,
      [businessId]
    );
    const business = businessRes.rows[0];

    // Check if PIN is set
    if (!business?.transaction_pin_hash) {
      return res.status(400).json({ 
        success: false, 
        error: "Transaction PIN not set. Please create one first.",
        code: "PIN_NOT_SET"
      });
    }

    // Validate PIN
    if (!pin) {
      return res.status(400).json({ success: false, error: "Transaction PIN is required" });
    }

    const pinValid = await verifyPassword(pin, business.transaction_pin_hash);
    if (!pinValid) {
      return res.status(400).json({ success: false, error: "Invalid transaction PIN" });
    }

    // Check OTP requirement
    let isOtpValidated = false;
    if (business.otp_enabled) {
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
      isOtpValidated = true;
    }

    // Validate Wallet
    let walletId = wallet_id;
    if (!walletId) {
      const wRes = await query(`SELECT id FROM wallets WHERE business_id = $1 LIMIT 1`, [businessId]);
      if (wRes.rows.length > 0) walletId = wRes.rows[0].id;
      else return res.status(400).json({ success: false, error: "Wallet ID required" });
    }

    // Calculate Fee
    const fee = await calculateFee(amount, 'transfer');
    const reference = genRef();
    const defaultProvider = process.env.DEFAULT_PAYMENT_PROVIDER || 'squad';

    // Generate transaction hash for integrity
    const transactionHash = generateTransactionHash(reference, amount.toString(), accountNumber, bankCode);

    // Queue Transfer
    const insertRes = await query(
      `INSERT INTO transfer_queue 
      (business_id, reference, recipient_account, recipient_bank, recipient_name, amount, currency, remark, source_type, source_id, status, wallet_id, payment_provider, fee, transaction_hash, initiated_by)
      VALUES ($1, $2, $3, $4, $5, $6, 'NGN', $7, 'manual', null, 'pending', $8, $9, $10, $11, $12)
      RETURNING *`,
      [businessId, reference, accountNumber, bankCode, accountName, amount, remark || 'Transfer', walletId, defaultProvider, fee, transactionHash, userId]
    );

    // Log audit event
    await logAuditEvent({
      businessId,
      userId,
      action: 'transfer_initiated',
      entityType: 'transfer',
      entityId: insertRes.rows[0].id,
      newValues: {
        reference,
        amount,
        recipientAccount: accountNumber,
        recipientBank: bankCode,
        recipientName: accountName,
        walletId,
      },
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
    });

    const queuedTransfer = insertRes.rows[0];

    // Trigger processing via BullMQ AND process synchronously for immediate result
    let syncProcessingError: any = null;
    try {
      await processAllPending(businessId!);
    } catch (syncErr) {
      console.error("[Sync] Error processing pending transfers inline:", syncErr);
      syncProcessingError = syncErr;
    }

    // BullMQ fallback (retry via background worker if sync processing failed or as redundancy)
    if (transferQueue) {
      try {
        await transferQueue.add('process-transfers', { businessId: businessId! });
      } catch (qErr) {
        console.error("[Queue] Failed to enqueue transfer job:", qErr);
      }
    }

    // Re-query to get the actual final status after sync processing
    let finalTransfer = queuedTransfer;
    try {
      const updatedRes = await query(
        `SELECT * FROM transfer_queue WHERE id = $1`,
        [queuedTransfer.id]
      );
      if (updatedRes.rows.length > 0) {
        finalTransfer = updatedRes.rows[0];
      }
    } catch (qErr) {
      console.error("Error re-querying transfer status:", qErr);
    }

    // If sync processing failed and status is still pending, surface the error
    let responseMessage = "Transfer initiated successfully";
    if (syncProcessingError && finalTransfer.status === 'pending') {
      responseMessage = `Transfer queued: ${syncProcessingError.message || 'Background processing will retry shortly'}`;
    } else if (finalTransfer.status === 'success') {
      responseMessage = "Transfer completed successfully";
    } else if (finalTransfer.status === 'failed') {
      responseMessage = finalTransfer.failure_reason || "Transfer failed";
    } else if (finalTransfer.status === 'processing') {
      responseMessage = "Transfer is being processed";
    }

    const statusCode = finalTransfer.status === 'failed' ? 200 : 200;

    res.status(statusCode).json({ 
      success: finalTransfer.status !== 'failed', 
      message: responseMessage,
      data: {
        id: finalTransfer.id,
        reference: finalTransfer.reference,
        amount: finalTransfer.amount,
        currency: finalTransfer.currency,
        fee: finalTransfer.fee,
        total: parseFloat(finalTransfer.amount) + parseFloat(finalTransfer.fee),
        recipient: {
          accountNumber: finalTransfer.recipient_account,
          bankCode: finalTransfer.recipient_bank,
          accountName: finalTransfer.recipient_name
        },
        status: finalTransfer.status,
        failureReason: finalTransfer.failure_reason || null,
        walletId: finalTransfer.wallet_id,
        paymentProvider: finalTransfer.payment_provider,
        createdAt: finalTransfer.created_at,
        updatedAt: finalTransfer.updated_at
      }
    });

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
 *     description: "Queues multiple transfers at once. Supports different types: Salary (pay active employees) and Epic (custom list of recipients). Requires a valid OTP obtained from /transfers/otp/request."
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
 *                 enum: [Salary, Epic]
 *                 description: Type of bulk transfer
 *               otp:
 *                 type: string
 *                 description: OTP code for authorization
 *                 example: "123456"
 *               source_wallet_id:
 *                 type: string
 *                 format: uuid
 *                 description: ID of the wallet to fund the transfer from (uses default wallet if not provided)
 *                 example: "550e8400-e29b-41d4-a716-446655440000"
 *               data:
 *                 type: object
 *                 description: Data depending on transfer type (items for Epic, none for Salary)
 *           examples:
 *             EpicType:
 *               summary: Epic bulk transfer (custom list of recipients)
 *               value:
 *                 type: "Epic"
 *                 otp: "123456"
 *                 source_wallet_id: "550e8400-e29b-41d4-a716-446655440000"
 *                 data:
 *                   items:
 *                     - amount: 5000
 *                       bankCode: "058"
 *                       accountNumber: "0123456789"
 *                       accountName: "John Doe"
 *                       remark: "Payment for services"
 *                     - amount: 10000
 *                       bankCode: "033"
 *                       accountNumber: "9876543210"
 *                       accountName: "Jane Smith"
 *                       remark: "Commission"
 *             SalaryType:
 *               summary: Salary bulk transfer (pay active employees)
 *               value:
 *                 type: "Salary"
 *                 otp: "123456"
 *                 source_wallet_id: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: Transfers queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Queued 2 transfers for processing"
 *                 data:
 *                   type: object
 *                   properties:
 *                     queued:
 *                       type: integer
 *                       description: Number of transfers queued
 *                       example: 2
 *                     type:
 *                       type: string
 *                       description: Type of bulk transfer
 *                     walletId:
 *                       type: string
 *                       format: uuid
 *                       description: Wallet ID used for the transfers
 *                     totals:
 *                       type: object
 *                       properties:
 *                         amount:
 *                           type: number
 *                           description: Total transfer amount
 *                         fee:
 *                           type: number
 *                           description: Total transfer fee
 *                         total:
 *                           type: number
 *                           description: Total amount (amount + fee)
 *                     transfers:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             format: uuid
 *                           reference:
 *                             type: string
 *                           amount:
 *                             type: number
 *                           currency:
 *                             type: string
 *                           fee:
 *                             type: number
 *                           recipient:
 *                             type: object
 *                             properties:
 *                               accountNumber:
 *                                 type: string
 *                               bankCode:
 *                                 type: string
 *                               accountName:
 *                                 type: string
 *                           status:
 *                             type: string
 *                             enum: [pending, processing, success, failed]
 *                           paymentProvider:
 *                             type: string
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 *       400:
 *         description: Bad request (invalid OTP, missing fields, invalid type, etc.)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Invalid transfer type"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Failed to initiate bulk transfer"
 */
router.post("/bulk", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), validateBody(InitiateBulkTransferSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const { type, data, source_wallet_id, otp, pin } = req.body;
    const businessId = req.user?.businessId;
    
    if (!businessId) {
      return res.status(400).json({ success: false, error: "Business ID required" });
    }

    // Get business settings
    const businessRes = await query(
      `SELECT transaction_pin_hash, otp_enabled FROM businesses WHERE id = $1`,
      [businessId]
    );
    const business = businessRes.rows[0];

    // Check if PIN is set
    if (!business?.transaction_pin_hash) {
      return res.status(400).json({ 
        success: false, 
        error: "Transaction PIN not set. Please create one first.",
        code: "PIN_NOT_SET"
      });
    }

    // Validate PIN
    if (!pin) {
      return res.status(400).json({ success: false, error: "Transaction PIN is required" });
    }

    const pinValid = await verifyPassword(pin, business.transaction_pin_hash);
    if (!pinValid) {
      return res.status(400).json({ success: false, error: "Invalid transaction PIN" });
    }

    // Check OTP requirement
    let isOtpValidated = false;
    if (business.otp_enabled) {
      if (!otp) {
        return res.status(400).json({ success: false, error: "OTP is required" });
      }

      // Verify OTP
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
      isOtpValidated = true;
    }

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
    if (type === 'Epic') {
      // data.items: Array of { amount, bankCode, accountNumber, accountName, remark }
      if (!Array.isArray(data?.items)) {
        return res.status(400).json({ success: false, error: "Items array required for Epic type" });
      }
      transfersToQueue = await Promise.all(data.items.map(async (item: any) => ({
        ...item,
        sourceType: 'Epic',
        sourceId: null,
        fee: await calculateFee(item.amount, 'transfer')
      })));

    } else if (type === 'Salary') {
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
          sourceType: 'Salary',
          sourceId: u.id,
          adjustments: userAdjustments, // Pass along to mark as processed later
          fee: await calculateFee(finalAmount > 0 ? finalAmount : 0, 'transfer')
        };
      }));

    } else {
      return res.status(400).json({ success: false, error: "Invalid transfer type" });
    }

    if (transfersToQueue.length === 0) {
      return res.json({ success: true, message: "No eligible transfers found to queue", data: { queued: 0, transfers: [] } });
    }

    // 2. Insert into transfer_queue
    let queuedTransfers: any[] = [];
    const defaultProvider = process.env.DEFAULT_PAYMENT_PROVIDER || 'squad';
    for (const t of transfersToQueue) {
      if (t.amount <= 0) continue;

      const transferRes = await query(
        `INSERT INTO transfer_queue 
        (business_id, reference, recipient_account, recipient_bank, recipient_name, amount, currency, remark, source_type, source_id, status, wallet_id, payment_provider, fee)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $13)
        RETURNING *`,
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
          t.payment_provider || defaultProvider,
          t.fee
        ]
      );
      
      const queuedTransfer = transferRes.rows[0];
      queuedTransfers.push(queuedTransfer);

      // Mark adjustments as processed
      if (t.adjustments && t.adjustments.length > 0) {
        const adjustmentIds = t.adjustments.map((adj: any) => adj.id);
        await query(
          `UPDATE payroll_adjustments 
           SET status = 'processed', processed_at = CURRENT_TIMESTAMP, transfer_id = $1 
           WHERE id = ANY($2::uuid[])`,
          [queuedTransfer.id, adjustmentIds]
        );
      }
    }

    // 3. Trigger processing via BullMQ AND process synchronously for immediate result
    let syncProcessingError: any = null;
    try {
      await processAllPending(businessId!);
    } catch (syncErr) {
      console.error("[Sync] Error processing bulk pending transfers inline:", syncErr);
      syncProcessingError = syncErr;
    }

    // BullMQ fallback (retry via background worker if sync processing failed or as redundancy)
    if (transferQueue) {
      try {
        await transferQueue.add('process-transfers', { businessId: businessId! });
      } catch (qErr) {
        console.error("[Queue] Failed to enqueue bulk transfer job:", qErr);
      }
    }

    // Re-query to get actual final statuses after sync processing
    let finalTransfers = queuedTransfers;
    try {
      if (queuedTransfers.length > 0) {
        const ids = queuedTransfers.map(t => t.id);
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
        const updatedRes = await query(
          `SELECT * FROM transfer_queue WHERE id = ANY(ARRAY[${placeholders}]::uuid[]) ORDER BY created_at ASC`,
          ids
        );
        if (updatedRes.rows.length > 0) {
          finalTransfers = updatedRes.rows;
        }
      }
    } catch (qErr) {
      console.error("Error re-querying bulk transfer statuses:", qErr);
    }

    // Aggregate status summary
    const statusCounts = finalTransfers.reduce((acc: any, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    }, {});

    // Calculate totals
    const totalAmount = finalTransfers.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const totalFee = finalTransfers.reduce((sum, t) => sum + parseFloat(t.fee || 0), 0);

    let responseMessage = `Queued ${finalTransfers.length} transfers for processing`;
    let overallSuccess = true;

    if (syncProcessingError && statusCounts.pending === finalTransfers.length) {
      responseMessage = `Transfers queued (sync processing delayed): ${syncProcessingError.message || 'Background processing will retry shortly'}`;
    } else if (statusCounts.success > 0 && statusCounts.failed === 0 && statusCounts.processing === 0 && statusCounts.pending === 0) {
      responseMessage = `All ${statusCounts.success} transfers completed successfully`;
    } else if (statusCounts.failed > 0 && statusCounts.success === 0 && statusCounts.processing === 0 && statusCounts.pending === 0) {
      responseMessage = `All ${statusCounts.failed} transfers failed`;
      overallSuccess = false;
    } else {
      const parts: string[] = [];
      if (statusCounts.success) parts.push(`${statusCounts.success} completed`);
      if (statusCounts.failed) parts.push(`${statusCounts.failed} failed`);
      if (statusCounts.processing) parts.push(`${statusCounts.processing} processing`);
      if (statusCounts.pending) parts.push(`${statusCounts.pending} pending`);
      responseMessage = `Transfers: ${parts.join(', ')}`;
      overallSuccess = statusCounts.failed ? statusCounts.success > 0 : true;
    }

    res.json({ 
      success: overallSuccess, 
      message: responseMessage,
      data: {
        queued: finalTransfers.length,
        type,
        walletId,
        summary: statusCounts,
        totals: {
          amount: totalAmount,
          fee: totalFee,
          total: totalAmount + totalFee
        },
        transfers: finalTransfers.map(t => ({
          id: t.id,
          reference: t.reference,
          amount: t.amount,
          currency: t.currency,
          fee: t.fee,
          recipient: {
            accountNumber: t.recipient_account,
            bankCode: t.recipient_bank,
            accountName: t.recipient_name
          },
          status: t.status,
          failureReason: t.failure_reason || null,
          paymentProvider: t.payment_provider,
          createdAt: t.created_at,
          updatedAt: t.updated_at
        }))
      }
    });

  } catch (error: any) {
    console.error("Bulk transfer error:", error);
    res.status(500).json({ success: false, error: "Failed to initiate bulk transfer", details: error.message || error });
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

    // Build query for transfer_queue (existing)
    let tqQueryText = `SELECT 
        id,
        business_id,
        wallet_id,
        reference,
        recipient_account,
        recipient_bank,
        recipient_name,
        amount,
        currency,
        remark,
        status,
        failure_reason,
        source_type,
        source_id,
        transaction_hash,
        initiated_by,
        payment_provider,
        provider_metadata,
        created_at,
        updated_at,
        'transfer' as type
      FROM transfer_queue 
      WHERE business_id = $1`;
    let tqParams: any[] = [businessId];
    let tqParamIdx = 2;

    // Build query for transactions (credits, and other transactions)
    let txQueryText = `SELECT 
        id,
        business_id,
        wallet_id,
        reference,
        amount,
        currency,
        status,
        description,
        transaction_type,
        direction,
        fee,
        payment_provider,
        provider_metadata,
        created_at,
        updated_at,
        'transaction' as type
      FROM transactions 
      WHERE business_id = $1`;
    let txParams: any[] = [businessId];
    let txParamIdx = 2;

    // Apply filters to both queries
    if (search) {
      // Transfer Queue: search by recipient_name, recipient_account, reference
      const tqSearch = ` AND (recipient_name ILIKE $${tqParamIdx} OR recipient_account ILIKE $${tqParamIdx} OR reference ILIKE $${tqParamIdx})`;
      tqQueryText += tqSearch;
      tqParams.push(`%${search}%`);
      tqParamIdx++;

      // Transactions: search by description, reference
      const txSearch = ` AND (description ILIKE $${txParamIdx} OR reference ILIKE $${txParamIdx})`;
      txQueryText += txSearch;
      txParams.push(`%${search}%`);
      txParamIdx++;
    }

    if (status) {
      // Transfer Queue: exact status match
      tqQueryText += ` AND status = $${tqParamIdx}`;
      tqParams.push(status);
      tqParamIdx++;

      // Transactions: exact status match
      txQueryText += ` AND status = $${txParamIdx}`;
      txParams.push(status);
      txParamIdx++;
    }

    if (startDate) {
      tqQueryText += ` AND created_at >= $${tqParamIdx}`;
      tqParams.push(startDate);
      tqParamIdx++;

      txQueryText += ` AND created_at >= $${txParamIdx}`;
      txParams.push(startDate);
      txParamIdx++;
    }

    if (endDate) {
      tqQueryText += ` AND created_at <= $${tqParamIdx}`;
      tqParams.push(endDate);
      tqParamIdx++;

      txQueryText += ` AND created_at <= $${txParamIdx}`;
      txParams.push(endDate);
      txParamIdx++;
    }

    // Execute both queries
    const [tqResult, txResult] = await Promise.all([
      query(tqQueryText, tqParams),
      query(txQueryText, txParams)
    ]);

    // Build a set of references to exclude from transactions (to avoid duplicates with transfer_queue)
    // This includes the transfer references themselves and their corresponding fee suffixes
    const excludedTxReferences = new Set<string>();
    for (const tqRow of tqResult.rows) {
      excludedTxReferences.add(tqRow.reference);
      excludedTxReferences.add(tqRow.reference + '-FEE');
      excludedTxReferences.add(tqRow.reference + '-REFUND');
      excludedTxReferences.add(tqRow.reference + '-FEE-REFUND');
    }

    // Filter out transactions that are already represented in transfer_queue (by reference)
    // Only keep non-transfer transactions: wallet_funding, manual adjustments, etc.
    const filteredTxResult = txResult.rows.filter(txRow => {
      if (excludedTxReferences.has(txRow.reference)) {
        return false;
      }
      return true;
    });

    // Combine results and sort by created_at descending
    const allItems = [
      ...tqResult.rows.map(row => ({ ...row, source: 'transfer_queue' })),
      ...filteredTxResult.map(row => ({ ...row, source: 'transaction' }))
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // Calculate total for pagination
    const total = allItems.length;

    // Apply pagination manually
    const paginatedItems = allItems.slice(offset, offset + Number(limit));

    // Format response to be backwards compatible
    const formattedData = paginatedItems.map(item => {
      if (item.source === 'transfer_queue') {
        // Return as before for backwards compatibility
        return item;
      } else {
        // Format transaction to look similar to transfer for consistency
        return {
          id: item.id,
          business_id: item.business_id,
          wallet_id: item.wallet_id,
          reference: item.reference,
          recipient_account: null,
          recipient_bank: null,
          recipient_name: item.description,
          amount: item.amount,
          currency: item.currency,
          remark: item.description,
          status: item.status,
          failure_reason: null,
          source_type: item.transaction_type,
          source_id: null,
          transaction_hash: null,
          initiated_by: null,
          payment_provider: item.payment_provider,
          provider_metadata: item.provider_metadata,
          created_at: item.created_at,
          updated_at: item.updated_at,
          type: 'transaction',
          direction: item.direction,
          transaction_type: item.transaction_type,
          fee: item.fee
        };
      }
    });

    res.json({
      success: true,
      data: formattedData,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    console.error("Get transfers error:", error);
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
 *           format: uuid
 *     responses:
 *       200:
 *         description: Retry initiated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
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

    const defaultProvider = process.env.DEFAULT_PAYMENT_PROVIDER || 'squad';
    
    // Reset status to pending and get the updated transfer
    const updateRes = await query(
      `UPDATE transfer_queue SET status = 'pending', failure_reason = NULL, reference = $2, payment_provider = $3 WHERE id = $1 RETURNING *`,
      [id, `TRF-RETRY-${Date.now()}`, defaultProvider]
    );
    const updatedTransfer = updateRes.rows[0];

    // Trigger processing via BullMQ
    if (transferQueue) {
      await transferQueue.add('process-transfers', { businessId: businessId! });
    }

    res.json({ 
      success: true, 
      message: "Transfer retry initiated",
      data: {
        id: updatedTransfer.id,
        reference: updatedTransfer.reference,
        amount: updatedTransfer.amount,
        currency: updatedTransfer.currency,
        fee: updatedTransfer.fee,
        recipient: {
          accountNumber: updatedTransfer.recipient_account,
          bankCode: updatedTransfer.recipient_bank,
          accountName: updatedTransfer.recipient_name
        },
        status: updatedTransfer.status,
        paymentProvider: updatedTransfer.payment_provider,
        createdAt: updatedTransfer.created_at,
        updatedAt: updatedTransfer.updated_at
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to retry transfer" });
  }
});

router.post("/:id/verify", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;

    // Verify ownership
    const check = await query(`SELECT * FROM transfer_queue WHERE id = $1 AND business_id = $2`, [id, businessId]);
    if (check.rows.length === 0) return res.status(404).json({ success: false, error: "Transfer not found" });
    
    const transfer = check.rows[0];

    if (transfer.status === 'success' || transfer.status === 'failed') {
      return res.json({ 
        success: true, 
        message: "Transfer already in final state", 
        data: transfer 
      });
    }

    // Import verifySingleTransfer
    const { verifySingleTransfer } = await import("../services/transfer");
    const updatedTransfer = await verifySingleTransfer(transfer);

    res.json({ 
      success: true, 
      message: updatedTransfer.status === 'success' ? "Transfer completed successfully" : "Transfer failed",
      data: updatedTransfer
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to verify transfer" });
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
