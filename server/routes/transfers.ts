import express from "express";
import crypto from "crypto";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus, checkFeaturePermission, checkKycStatus } from "../middleware/auth";
import { requireTeamPermission } from "../middleware/teamAuth";
import { validateBody } from "../middleware/validation";
import { InitiateSingleTransferSchema, InitiateBulkTransferSchema } from "../lib/validation";
import { accountLookup, processAllPending, reverseFailedTransfer, validateIntlBeneficiary, computeIntlQuote } from "../services/transfer";
import { getProvider, getActiveProviderName, getActiveTransferProviderName, getAvailableProviders } from "../services/providers/factory";
import { getFlutterwaveTransferRate } from "../services/providers/flutterwave";
import { calculateFee, creditRevenueWallet, chargeAncillaryFee, isFeeChargeFailure } from "../services/fees";
import { getIntlTransferConfig, effectiveMarkupPercent, getIntlPayoutLimits, limitForCurrency, checkPayoutLimit } from "../services/app-config";

/** Quote lock window fallback (seconds) — the live value comes from the
 *  admin-editable `intl_quote_ttl_seconds` system setting (getIntlTransferConfig),
 *  with INTL_QUOTE_TTL_SECONDS env as the legacy override. Clients show a
 *  countdown and must re-quote when it lapses; the initiation path re-quotes
 *  server-side regardless. */
import { generateOTP, getOTPExpiry, verifyPassword } from "../services/auth";
import { sendEmail, generateOtpEmailHtml } from "../services/email";
import { sendSMS } from "../services/sms";
import { sendWhatsApp } from "../services/whatsapp";
import { logAuditEvent, generateTransactionHash } from "../services/audit";
import { transferQueue } from "../lib/queues";

const router = express.Router();

// Helper to generate reference if util doesn't exist.
// Random hex suffix (not a bounded int) so rapid retries/bulk inserts can
// never collide on the UNIQUE reference within the same millisecond.
const genRef = () => `TRF-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;

/**
 * GET /transfers/quote
 * International payout quote: live Flutterwave rate with the admin margin
 * (markup + hidden spread) baked INTO the conversion rate, plus fees.
 * Customers see exactly three numbers — Conversion rate, Fee, Total — the
 * margin itself is never exposed (no markup_percent, no provider name).
 * Query: amount (destination-currency amount), source_currency (default NGN),
 *        destination_currency (default USD)
 * Response: conversion_rate (colloquial: 1 USD = ₦X), fee, total_debit,
 *           receiving_amount, limits {min,max}
 */
router.get("/quote", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
  try {
    const amount = Number(req.query.amount);
    const sourceCurrency = (String(req.query.source_currency || 'NGN')).toUpperCase();
    const destinationCurrency = (String(req.query.destination_currency || 'USD')).toUpperCase();

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: "amount query parameter is required and must be positive" });
    }

    const config = await getIntlTransferConfig();
    const limits = await getIntlPayoutLimits();
    const limitInfo = limitForCurrency(limits, destinationCurrency);
    const quoteTtl = config.quoteTtlSeconds;
    const expiresAt = new Date(Date.now() + quoteTtl * 1000);

    // Same-currency payout: no FX needed, just fees (fee currency follows the
    // debit currency; both legs are the same here).
    if (sourceCurrency === destinationCurrency) {
      const fee = Math.round((amount * (config.feePercent / 100) + config.feeFlat) * 100) / 100;
      return res.json({
        success: true,
        data: {
          source_currency: sourceCurrency,
          destination_currency: destinationCurrency,
          amount,
          conversion_rate: 1,
          receiving_amount: amount,
          fee,
          total_debit: Math.round((amount + fee) * 100) / 100,
          limits: limitInfo,
          expires_at: expiresAt.toISOString(),
          expires_in_seconds: quoteTtl,
          // Legacy keys (older clients): colloquial rates, no margin leak.
          live_rate: 1,
          marked_up_rate: 1,
          markup_percent: null,
        },
      });
    }

    const providerName = await getActiveTransferProviderName();
    if (providerName !== 'flutterwave') {
      return res.status(400).json({ success: false, error: "International payouts are currently unavailable. Ask an admin to enable the payout provider." });
    }

    // Payout limits (admin-configurable, Flutterwave defaults min 10 / max 20,000).
    const limitCheck = checkPayoutLimit(destinationCurrency, amount, limits);
    if (!limitCheck.ok) {
      return res.status(400).json({
        success: false,
        error: limitCheck.error,
        code: limitCheck.code,
        data: { limits: limitInfo },
      });
    }

    const { rate } = await getFlutterwaveTransferRate(amount, sourceCurrency, destinationCurrency);
    const quote = computeIntlQuote(amount, rate, config, effectiveMarkupPercent(config));

    res.json({
      success: true,
      data: {
        source_currency: sourceCurrency,
        destination_currency: destinationCurrency,
        amount,
        conversion_rate: quote.conversionRate,
        receiving_amount: quote.receivingAmount,
        fee: quote.fee,
        total_debit: quote.totalDebit,
        limits: limitInfo,
        expires_at: expiresAt.toISOString(),
        expires_in_seconds: quoteTtl,
        // Legacy keys for older clients — now COLLOQUIAL so "1 USD = ₦X"
        // renders correctly. The margin is NOT exposed (markup_percent null).
        live_rate: quote.liveRateColloquial,
        marked_up_rate: quote.conversionRate,
        markup_percent: null,
      },
    });
  } catch (error: any) {
    console.error("Transfer quote error:", error);
    res.status(500).json({ success: false, error: error.message || "Failed to fetch quote" });
  }
});

/**
 * GET /transfers/payout-limits
 * Admin-configurable min/max per international payout currency + fee hint.
 * Used by web/mobile to show the "Min $10 · Max $20,000" hint BEFORE a quote
 * exists (amount field empty).
 */
router.get("/payout-limits", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const limits = await getIntlPayoutLimits();
    const config = await getIntlTransferConfig();
    res.json({
      success: true,
      data: {
        limits,
        fee_percent: config.feePercent,
        fee_flat: config.feeFlat,
      },
    });
  } catch (error: any) {
    console.error("Payout limits error:", error);
    res.status(500).json({ success: false, error: "Failed to load payout limits" });
  }
});

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
router.post("/otp/request", authenticateToken, checkSubscriptionStatus, requireTeamPermission("manage_finance"), async (req: AuthenticatedRequest, res) => {
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
            
            // Charge Fee — wallet resolution accepts personal + business wallets
            // and falls back to any funded wallet (fixes "No NGN wallet found
            // to charge OTP fee" for personal-wallet-only users).
            const feeAmt = await calculateFee(1, 'otp_sms'); 
            if (feeAmt > 0) {
                 const charge = await chargeAncillaryFee({
                     businessId,
                     userId,
                     walletId: wallet_id,
                     amount: feeAmt,
                     description: 'OTP SMS Fee',
                     referencePrefix: 'OTP-FEE',
                 });
                 if (isFeeChargeFailure(charge)) return res.status(400).json({ success: false, error: charge.error });
                 feeCharged = charge.amount;
            }

            await sendSMS(user.phone_number, `Your Transfer OTP is: ${otpCode}`);
        }

        if (preference === 'whatsapp') {
            if (!user.phone_number) {
                 return res.status(400).json({ success: false, error: "User phone number required for WhatsApp OTP. Please update your profile." });
            }
            
            // Charge WhatsApp OTP fee — same resilient wallet resolution as SMS
            const feeAmt = await calculateFee(1, 'otp_whatsapp'); 
            if (feeAmt > 0) {
                 const charge = await chargeAncillaryFee({
                     businessId,
                     userId,
                     walletId: wallet_id,
                     amount: feeAmt,
                     description: 'OTP WhatsApp Fee',
                     referencePrefix: 'OTP-WHATSAPP-FEE',
                 });
                 if (isFeeChargeFailure(charge)) return res.status(400).json({ success: false, error: charge.error });
                 feeCharged = charge.amount;
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
// KYC REQUIRED: moving money out of the wallet is a regulated financial
// action — the customer must have completed Tier-1 KYC (BVN or NIN) first.
// The 403 carries code "KYC_REQUIRED" so clients can open the KYC flow.
router.post("/single", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), checkKycStatus, validateBody(InitiateSingleTransferSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const { bankCode, accountNumber, accountName, amount, currency: requestCurrency, remark, otp, pin, debitAmount, debitCurrency, wallet_id, walletId: camelWalletId, recipientAddress, recipientCity, recipientState, recipientPostalCode, recipientCountry, bankName, swiftCode, routingNumber, accountType, beneficiaryEmail } = req.body;
    const businessId = req.user?.businessId;
    const userId = req.user?.userId;
    const currency = (requestCurrency || 'NGN').toUpperCase();
    // International payouts: debitAmount/debitCurrency come from the /quote
    // endpoint (source-currency total the user actually pays). Flutterwave's
    // international rails require the beneficiary's full address details.
    const isIntl = currency !== 'NGN';
    // NGN payouts still require the bank code (schema allows empty for intl).
    if (!isIntl && !String(bankCode || '').trim()) {
      return res.status(400).json({ success: false, error: "Bank code is required for NGN transfers", code: "BANK_CODE_REQUIRED" });
    }
    // Postal code is OPTIONAL (the web/mobile epic + wallet forms collect
    // street/city/country; FLW's meta builder only includes postal_code when
    // provided). Street address, city and country remain required.
    if (isIntl && (!recipientAddress || !recipientCity || !recipientCountry)) {
      return res.status(400).json({
        success: false,
        error: "International payouts require the recipient's street address, city and country",
        code: "BENEFICIARY_ADDRESS_REQUIRED",
      });
    }
    // PRE-TRANSFER BENEFICIARY VALIDATION (before ANY wallet debit): Flutterwave
    // has no account-resolution for USD/GBP/EUR, so an invalid routing number
    // used to surface only at DISBURSEMENT ("Invalid account number") — after
    // the money had left the wallet. Validate the corridor's routing data here
    // so bad beneficiaries are rejected up-front with an actionable error.
    if (isIntl) {
      const intlCheck = validateIntlBeneficiary(currency, {
        routingNumber,
        swiftCode,
        bankName,
        accountType: accountType || (req.body as any)?.account_type,
        accountNumber,
        beneficiaryAddress: recipientAddress,
        beneficiaryPostalCode: recipientPostalCode,
      });
      if (!intlCheck.valid) {
        return res.status(400).json({ success: false, error: intlCheck.error, code: intlCheck.code });
      }
    }
    const hasDebit = debitAmount != null && Number(debitAmount) > 0;
    const dbDebitAmount = hasDebit ? Number(debitAmount) : null;
    const dbDebitCurrency = hasDebit ? (debitCurrency || 'NGN').toUpperCase() : null;

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

    // Validate Wallet (accept both snake_case and camelCase wallet id)
    let walletId = wallet_id || camelWalletId;

    // PAYOUT LIMITS (intl): enforce the admin-configured min/max BEFORE any
    // debit or wallet resolution.
    let payoutLimitInfo: { min: number; max: number } | null = null;
    if (isIntl) {
      const limits = await getIntlPayoutLimits();
      const limitCheck = checkPayoutLimit(currency, Number(amount), limits);
      if (!limitCheck.ok) {
        return res.status(400).json({ success: false, error: limitCheck.error, code: limitCheck.code, data: { limits: limitCheck.limit } });
      }
      payoutLimitInfo = limitCheck.limit || null;
    }

    // Fee: charged in the DEBIT currency (it leaves the same wallet as the
    // conversion amount). International payouts price from the admin intl
    // config (percent of the SOURCE debit + flat); NGN payouts keep the
    // standard transfer fee matrix.
    let fee: number;
    let finalDebitAmount: number | null = dbDebitAmount;
    let finalDebitCurrency: string | null = dbDebitCurrency;
    let intlQuote: ReturnType<typeof computeIntlQuote> | null = null;
    if (isIntl) {
      const cfg = await getIntlTransferConfig();
      const margin = effectiveMarkupPercent(cfg);
      try {
        const { rate } = await getFlutterwaveTransferRate(Number(amount), 'NGN', currency);
        const q = computeIntlQuote(Number(amount), rate, cfg, margin);
        intlQuote = q;
        fee = q.fee;
        const serverTotal = q.totalDebit;
        if (!finalDebitAmount) {
          finalDebitCurrency = 'NGN';
          finalDebitAmount = serverTotal;
        } else if (finalDebitCurrency === 'NGN') {
          // Clamp a stale/hand-crafted client debit to the authoritative
          // server number (1.5% tolerance for rate movement).
          if (Math.abs(finalDebitAmount - serverTotal) / serverTotal > 0.015) {
            console.log(`[transfers] intl quote clamp: client=${finalDebitAmount} -> server=${serverTotal}`);
            finalDebitAmount = serverTotal;
          }
        }
      } catch (quoteErr: any) {
        if (!finalDebitAmount) {
          // Live rate unavailable: reject rather than debit an arbitrary amount.
          return res.status(503).json({ success: false, error: "Could not price this international transfer right now. Please request a new quote and try again.", code: "QUOTE_UNAVAILABLE" });
        }
        console.warn('[transfers] server-side intl re-quote failed, using client debitAmount:', quoteErr?.message);
        fee = Math.round(((Number(finalDebitAmount)) * (cfg.feePercent / 100) + cfg.feeFlat) * 100) / 100;
      }
    } else {
      fee = await calculateFee(amount, 'transfer');
    }
    const neededCurrency = (finalDebitCurrency || currency).toUpperCase();
    if (!walletId) {
      // Prefer a wallet in the currency we're actually paying out.
      // Search business wallets first, then the acting user's personal wallet
      // (previously business-only → "Wallet ID required" for personal-only users).
      const wRes = await query(
        `SELECT id FROM wallets WHERE business_id = $1 AND UPPER(currency) = $2 LIMIT 1`,
        [businessId, neededCurrency],
      );
      if (wRes.rows.length > 0) {
        walletId = wRes.rows[0].id;
      } else {
        const personalRes = await query(
          `SELECT id FROM wallets WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = $2 LIMIT 1`,
          [userId, neededCurrency],
        );
        if (personalRes.rows.length > 0) {
          walletId = personalRes.rows[0].id;
        } else {
          const anyRes = await query(
            `SELECT id FROM wallets WHERE business_id = $1 OR (user_id = $2 AND business_id IS NULL) LIMIT 1`,
            [businessId, userId],
          );
          if (anyRes.rows.length > 0) walletId = anyRes.rows[0].id;
          else return res.status(400).json({ success: false, error: "Wallet ID required" });
        }
      }
    }

    // Currency guard: an NGN wallet cannot fund a USD payout (and vice versa)
    const walletCurRes = await query(`SELECT currency FROM wallets WHERE id = $1`, [walletId]);
    if (walletCurRes.rows.length > 0) {
      const walletCurrency = String(walletCurRes.rows[0].currency || 'NGN').toUpperCase();
      if (walletCurrency !== neededCurrency) {
        return res.status(400).json({
          success: false,
          error: `Source wallet is ${walletCurrency} but this transfer pays out in ${neededCurrency}. Select the ${neededCurrency} wallet.`,
        });
      }
    }

    const reference = genRef();
    const defaultProvider = await getActiveTransferProviderName();

    // Generate transaction hash for integrity
    const transactionHash = generateTransactionHash(reference, amount.toString(), accountNumber, bankCode);

    // Queue Transfer
    const insertRes = await query(
      `INSERT INTO transfer_queue
      (business_id, reference, recipient_account, recipient_bank, recipient_name, amount, currency, debit_amount, debit_currency, remark, source_type, source_id, status, wallet_id, payment_provider, fee, transaction_hash, initiated_by,
       recipient_address, recipient_city, recipient_state, recipient_postal_code, recipient_country, recipient_bank_name, recipient_swift_code, recipient_routing_number, recipient_account_type, recipient_email)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual', null, 'pending', $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
      RETURNING *`,
      [businessId, reference, accountNumber, bankCode, accountName, amount, currency, finalDebitAmount, finalDebitCurrency, remark || 'Transfer', walletId, defaultProvider, fee, transactionHash, userId,
       recipientAddress || null, recipientCity || null, recipientState || null, recipientPostalCode || null, (recipientCountry || '').toUpperCase() || null, bankName || null, swiftCode || null, routingNumber || null,
       accountType || (req.body as any)?.account_type || null, beneficiaryEmail || null]
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

    // INSTANT STATUS: users must see the real outcome, not "Processing" by
    // default. If the provider call only gave us an indeterminate status
    // (pending/processing), actively poll the provider a few times RIGHT NOW
    // (bounded ~12s) before answering. Only after this window do we leave it
    // as processing — from where the monitor/webhooks take over.
    if (['pending', 'processing', 'queued'].includes(finalTransfer.status)) {
      const { verifySingleTransfer } = await import("../services/transfer");
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, 4000));
        try {
          const reRes = await query(`SELECT * FROM transfer_queue WHERE id = $1`, [queuedTransfer.id]);
          if (reRes.rows.length > 0) finalTransfer = reRes.rows[0];
          if (['success', 'failed'].includes(finalTransfer.status)) break; // final
          const verified = await verifySingleTransfer(finalTransfer, 1);
          if (verified) finalTransfer = verified;
          if (['success', 'failed'].includes(finalTransfer.status)) break; // final
        } catch (vErr) {
          console.error("[Sync] Inline verify poll failed:", vErr);
        }
      }
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

    // BENEFICIARY AUTO-SAVE: every transfer attempt adds/refreshes the
    // recipient in the user's recent-beneficiaries directory (upsert keyed
    // on user + bank + account so repeats bump last_used_at instead of
    // duplicating). International beneficiaries keep their full corridor
    // details (bank, routing/SWIFT, address) so the beneficiary page can
    // prefill a USD/GBP/EUR payout end-to-end. Best-effort — never blocks.
    try {
      const bBank = finalTransfer.recipient_bank;
      const bAcct = finalTransfer.recipient_account;
      if (bBank && bAcct) {
        const bIntl = String(finalTransfer.currency || 'NGN').toUpperCase() !== 'NGN';
        await query(
          `INSERT INTO transfer_beneficiaries
             (user_id, business_id, bank_code, account_number, account_name, currency,
              bank_name, recipient_country, routing_number, swift_code, account_type,
              address_line, city, state, postal_code, is_intl)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (user_id, bank_code, account_number)
           DO UPDATE SET
             account_name = COALESCE(EXCLUDED.account_name, transfer_beneficiaries.account_name),
             bank_name = COALESCE(EXCLUDED.bank_name, transfer_beneficiaries.bank_name),
             recipient_country = COALESCE(EXCLUDED.recipient_country, transfer_beneficiaries.recipient_country),
             routing_number = COALESCE(EXCLUDED.routing_number, transfer_beneficiaries.routing_number),
             swift_code = COALESCE(EXCLUDED.swift_code, transfer_beneficiaries.swift_code),
             account_type = COALESCE(EXCLUDED.account_type, transfer_beneficiaries.account_type),
             address_line = COALESCE(EXCLUDED.address_line, transfer_beneficiaries.address_line),
             city = COALESCE(EXCLUDED.city, transfer_beneficiaries.city),
             state = COALESCE(EXCLUDED.state, transfer_beneficiaries.state),
             postal_code = COALESCE(EXCLUDED.postal_code, transfer_beneficiaries.postal_code),
             is_intl = EXCLUDED.is_intl,
             use_count = transfer_beneficiaries.use_count + 1,
             last_used_at = CURRENT_TIMESTAMP`,
          [
            userId,
            businessId || null,
            String(bBank),
            String(bAcct),
            finalTransfer.recipient_name || null,
            finalTransfer.currency || 'NGN',
            finalTransfer.recipient_bank_name || null,
            finalTransfer.recipient_country || null,
            finalTransfer.recipient_routing_number || null,
            finalTransfer.recipient_swift_code || null,
            finalTransfer.recipient_account_type || null,
            finalTransfer.recipient_address || null,
            finalTransfer.recipient_city || null,
            finalTransfer.recipient_state || null,
            finalTransfer.recipient_postal_code || null,
            bIntl,
          ],
        );
      }
    } catch (bErr) {
      console.error("Beneficiary auto-save failed (non-fatal):", bErr);
    }

    const statusCode = finalTransfer.status === 'failed' ? 200 : 200;

    // Provider internals are scrubbed from the customer-facing payload below —
    // users must never see which payout provider was used. The response also
    // exposes the payout limits and conversion info for international transfers.

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
        debitAmount: finalTransfer.debit_amount ?? null,
        debitCurrency: finalTransfer.debit_currency ?? null,
        ...(intlQuote
          ? {
              conversion_rate: intlQuote.conversionRate,
              limits: payoutLimitInfo,
            }
          : {}),
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
router.post("/bulk", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), checkKycStatus, validateBody(InitiateBulkTransferSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const { type, data, otp, pin, items, epicId } = req.body;
    // Accept both snake_case and camelCase source wallet id (validation schema
    // allows sourceWalletId but the handler previously only read source_wallet_id)
    const source_wallet_id = req.body.source_wallet_id || req.body.sourceWalletId;
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
    // Admin-configurable payout limits + intl fee config (used for Epic
    // per-item validation and Salary fees below).
    const payoutLimits = await getIntlPayoutLimits();
    const intlCfg = await getIntlTransferConfig();
    let unverifiedEmployees: any[] = [];

    // 1. Prepare transfers based on type
    if (type === 'Epic') {
      // New contract: top-level `items` (+ `epicId`). Legacy clients still
      // send `data.items` — accept both so no client breaks on deploy.
      const epicItems: any[] = Array.isArray(items)
        ? items
        : Array.isArray((data as any)?.items)
          ? (data as any).items
          : null;
      if (!epicItems) {
        return res.status(400).json({ success: false, error: "Items array required for Epic type" });
      }
      try {
        transfersToQueue = await Promise.all(
        epicItems.map(async (item: any) => {
          const itemCurrency = String(item.currency || 'NGN').toUpperCase();
          const isIntlItem = itemCurrency !== 'NGN';
          const bankCode = String(item.bankCode || '').trim();
          const accountNumber = String(item.accountNumber || '').trim();

          // PER-RECIPIENT VALIDATION (pre-debit, pre-queue):
          //  - NGN: bank code + 10-digit account are mandatory.
          //  - USD/GBP/EUR: Flutterwave has no account resolution — validate
          //    the corridor's routing data up-front so a bad beneficiary
          //    never reaches disbursement ("Invalid account number" + a
          //    debited wallet was the old failure mode).
          if (!isIntlItem) {
            if (!bankCode) {
              throw Object.assign(new Error(`Recipient ${item.accountName || accountNumber}: bank code is required for NGN transfers`), { statusCode: 400 });
            }
            if (!/^\d{10}$/.test(accountNumber)) {
              throw Object.assign(new Error(`Recipient ${item.accountName || accountNumber}: NGN account numbers must be exactly 10 digits`), { statusCode: 400 });
            }
          } else {
            const routingNumber = item.recipientRoutingNumber || item.routingNumber || '';
            const swiftCode = item.recipientSwiftCode || item.swiftCode || '';
            const bankName = item.recipientBankName || item.bankName || '';
            const intlCheck = validateIntlBeneficiary(itemCurrency, {
              routingNumber,
              swiftCode,
              bankName,
              accountType: item.accountType || item.account_type,
              accountNumber,
              beneficiaryAddress: item.recipientAddress,
              beneficiaryPostalCode: item.recipientPostalCode,
            });
            if (!intlCheck.valid) {
              throw Object.assign(
                new Error(`Recipient ${item.accountName || accountNumber}: ${intlCheck.error}`),
                { statusCode: 400, code: intlCheck.code },
              );
            }
            // Payout limits (admin-configurable) — enforced per item.
            const itemLimitCheck = checkPayoutLimit(itemCurrency, Number(item.amount), payoutLimits);
            if (!itemLimitCheck.ok) {
              throw Object.assign(
                new Error(`Recipient ${item.accountName || accountNumber}: ${itemLimitCheck.error}`),
                { statusCode: 400, code: itemLimitCheck.code },
              );
            }
          }

          return {
            ...item,
            currency: itemCurrency,
            bankCode,
            accountNumber,
            accountName: item.accountName || '',
            recipientBankName: item.recipientBankName || item.bankName || null,
            recipientSwiftCode: item.recipientSwiftCode || item.swiftCode || null,
            recipientRoutingNumber: item.recipientRoutingNumber || item.routingNumber || null,
            recipientAddress: item.recipientAddress || null,
            recipientCity: item.recipientCity || null,
            recipientState: item.recipientState || null,
            recipientPostalCode: item.recipientPostalCode || null,
            recipientCountry: (item.recipientCountry || '').toUpperCase() || null,
            beneficiaryEmail: item.beneficiaryEmail || null,
            accountType: item.accountType || item.account_type || null,
            epicId: epicId || null,
            sourceType: 'Epic',
            sourceId: null,
            debitAmount: item.debitAmount || item.debit_amount || null,
            debitCurrency: item.debitCurrency || item.debit_currency || null,
            // Fee rides in the DEBIT currency. Items pre-converted by the
            // client (debitAmount present, NGN debit) are charged on the
            // debit in NGN (percent + flat). Face-value items debit the
            // destination wallet — the flat fee is NGN-denominated, so only
            // the percentage applies there.
            fee: isIntlItem
              ? Math.round((((item.debitAmount || item.debit_amount) && String(item.debitCurrency || item.debit_currency || 'NGN').toUpperCase() === 'NGN'
                  ? Number(item.debitAmount || item.debit_amount) * (intlCfg.feePercent / 100) + intlCfg.feeFlat
                  : Number(item.amount) * (intlCfg.feePercent / 100)) * 100)) / 100
              : await calculateFee(item.amount, 'transfer'),
          };
        }),
      );
      } catch (epicErr: any) {
        // Per-recipient validation failures are CLIENT errors — surface a
        // precise 400 naming the offending recipient instead of a 500.
        if (epicErr?.statusCode === 400) {
          return res.status(400).json({ success: false, error: epicErr.message, code: epicErr.code });
        }
        throw epicErr;
      }
    } else if (type === 'Salary') {
      // Pay all active employees with salary_amount > 0.
      // Only employees with VERIFIED recipient account details are queued;
      // unverified ones are returned so the UI can flag them.
      const usersRes = await query(
        `SELECT id, name, salary_amount, salary_currency, bank_code, account_number, account_name,
                verification_status, verified_account_name, bank_name, bank_country, swift_code, routing_number,
                beneficiary_address, beneficiary_city, beneficiary_country
         FROM users 
         WHERE business_id = $1 AND status = 'active' AND salary_amount > 0`,
        [businessId]
      );
      
      const users = usersRes.rows.filter((u: any) => u.bank_code && u.account_number);
      unverifiedEmployees = users.filter((u: any) => u.verification_status !== 'verified').map((u: any) => ({
        id: u.id,
        name: u.name,
        verification_status: u.verification_status || 'unverified',
      }));
      const verifiedUsers = users.filter((u: any) => u.verification_status === 'verified');

      // Fetch pending adjustments for these users
      const userIds = verifiedUsers.map((u: any) => u.id);
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

      try {
        transfersToQueue = await Promise.all(verifiedUsers.map(async (u: any) => {
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

        const empCurrency = (u.salary_currency || 'NGN').toUpperCase();
        const isIntlEmp = empCurrency !== 'NGN';
        if (isIntlEmp && finalAmount > 0) {
          const empLimitCheck = checkPayoutLimit(empCurrency, finalAmount, payoutLimits);
          if (!empLimitCheck.ok) {
            throw Object.assign(
              new Error(`Employee ${u.name}: ${empLimitCheck.error}`),
              { statusCode: 400, code: empLimitCheck.code },
            );
          }
        }
        return {
          amount: finalAmount > 0 ? finalAmount : 0,
          currency: empCurrency,
          bankCode: u.bank_code,
          accountNumber: u.account_number,
          accountName: u.verified_account_name || u.account_name || u.name || 'Employee',
          remark: remarks.join('; '),
          sourceType: 'Salary',
          sourceId: u.id,
          adjustments: userAdjustments, // Pass along to mark as processed later
          recipientBankName: u.bank_name || null,
          recipientCountry: (u.bank_country || u.beneficiary_country || '').toUpperCase() || null,
          recipientSwiftCode: u.swift_code || null,
          recipientRoutingNumber: u.routing_number || null,
          recipientAddress: u.beneficiary_address || null,
          recipientCity: u.beneficiary_city || null,
          fee: isIntlEmp
            ? // Face-value destination-currency payout: the flat fee is
              // NGN-denominated, so only the percentage applies here.
              Math.round(((finalAmount > 0 ? finalAmount : 0) * (intlCfg.feePercent / 100)) * 100) / 100
            : await calculateFee(finalAmount > 0 ? finalAmount : 0, 'transfer'),
        };
        }));
      } catch (salaryErr: any) {
        if (salaryErr?.statusCode === 400) {
          return res.status(400).json({ success: false, error: salaryErr.message, code: salaryErr.code });
        }
        throw salaryErr;
      }

    } else {
      return res.status(400).json({ success: false, error: "Invalid transfer type" });
    }

    if (transfersToQueue.length === 0) {
      return res.json({ success: true, message: "No eligible transfers found to queue", data: { queued: 0, transfers: [], unverified_employees: unverifiedEmployees } });
    }

    // Currency guard: every queued transfer is debited from the SAME source
    // wallet. A mixed NGN/USD salary batch would silently debit the wrong
    // wallet by the wrong magnitude — reject it up-front with a clear message
    // instead of corrupting balances during processing.
    {
      const walletCurRes = await query(`SELECT currency FROM wallets WHERE id = $1`, [walletId]);
      const walletCurrency = String(walletCurRes.rows[0]?.currency || 'NGN').toUpperCase();
      const mismatched = transfersToQueue.filter(
        (t: any) => String(t.currency || 'NGN').toUpperCase() !== walletCurrency,
      );
      if (mismatched.length > 0) {
        const badCurrencies = [...new Set(mismatched.map((t: any) => String(t.currency || 'NGN').toUpperCase()))];
        return res.status(400).json({
          success: false,
          error: `The selected wallet is ${walletCurrency} but ${mismatched.length} payout(s) are in ${badCurrencies.join(', ')}. Fund those payouts from the matching wallet — run NGN and USD payouts separately.`,
        });
      }
    }

    // 2. Insert into transfer_queue
    let queuedTransfers: any[] = [];
    const defaultProvider = await getActiveTransferProviderName();
    for (const t of transfersToQueue) {
      if (t.amount <= 0) continue;

      const transferRes = await query(
        `INSERT INTO transfer_queue 
        (business_id, reference, recipient_account, recipient_bank, recipient_name, amount, currency, debit_amount, debit_currency, remark, source_type, source_id, status, wallet_id, payment_provider, fee,
         recipient_address, recipient_city, recipient_state, recipient_postal_code, recipient_country, recipient_bank_name, recipient_swift_code, recipient_routing_number, recipient_account_type, recipient_email)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
        RETURNING *`,
        [
          businessId,
          genRef(),
          t.accountNumber,
          t.bankCode,
          t.accountName,
          t.amount,
          t.currency || 'NGN',
          t.debitAmount != null && Number(t.debitAmount) > 0 ? Number(t.debitAmount) : null,
          t.debitCurrency ? String(t.debitCurrency).toUpperCase() : null,
          t.remark,
          t.sourceType,
          t.sourceId,
          walletId,
          t.payment_provider || defaultProvider,
          t.fee,
          t.recipientAddress || null,
          t.recipientCity || null,
          t.recipientState || null,
          t.recipientPostalCode || null,
          t.recipientCountry || null,
          t.recipientBankName || null,
          t.recipientSwiftCode || null,
          t.recipientRoutingNumber || null,
          t.accountType || t.recipient_account_type || null,
          t.beneficiaryEmail || t.recipient_email || null,
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
        unverified_employees: unverifiedEmployees,
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
          // provider name intentionally NOT exposed to customers
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
    const { search, status, startDate, endDate, walletId, direction, type, minAmount, maxAmount, page = 1, limit = 20, format } = req.query;
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

    // Wallet filter: restrict to a specific wallet (credits/debits of that wallet only)
    if (walletId) {
      tqQueryText += ` AND wallet_id = $${tqParamIdx}`;
      tqParams.push(walletId);
      tqParamIdx++;
      txQueryText += ` AND wallet_id = $${txParamIdx}`;
      txParams.push(walletId);
      txParamIdx++;
    }

    // Direction filter: 'debit' -> transfer_queue rows (outgoing payouts);
    // 'credit' -> transaction rows with direction = credit
    if (direction === 'debit' || direction === 'credit') {
      if (direction === 'debit') {
        tqQueryText += ` AND amount > 0`;
        txQueryText += ` AND direction = 'debit' AND amount > 0`;
      } else {
        tqQueryText += ` AND 1 = 0`; // transfer_queue rows are outgoing debits
        txQueryText += ` AND direction = 'credit'`;
      }
    }

    // Transaction type filter (applies to transactions side only)
    if (type) {
      txQueryText += ` AND transaction_type = $${txParamIdx}`;
      txParams.push(type);
      txParamIdx++;
    }

    // Amount range filters
    if (minAmount) {
      tqQueryText += ` AND amount >= $${tqParamIdx}`;
      tqParams.push(Number(minAmount));
      tqParamIdx++;
      txQueryText += ` AND amount >= $${txParamIdx}`;
      txParams.push(Number(minAmount));
      txParamIdx++;
    }
    if (maxAmount) {
      tqQueryText += ` AND amount <= $${tqParamIdx}`;
      tqParams.push(Number(maxAmount));
      tqParamIdx++;
      txQueryText += ` AND amount <= $${txParamIdx}`;
      txParams.push(Number(maxAmount));
      txParamIdx++;
    }

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

    // Exclude platform/revenue internal rows - users see their own ledger only
    txQueryText += ` AND transaction_type NOT IN ('platform')`;

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

    // CSV export (honours every filter above, ignores pagination)
    if (format === 'csv') {
      const esc = (v: any) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = ['Date', 'Direction', 'Type', 'Reference', 'Recipient', 'Amount', 'Currency', 'Fee', 'Status', 'Description'];
      const lines = [header.join(',')];
      for (const item of allItems) {
        const isTq = item.source === 'transfer_queue';
        lines.push([
          esc(item.created_at),
          esc(isTq ? 'debit' : (item.direction || 'credit')),
          esc(isTq ? 'transfer' : item.transaction_type),
          esc(item.reference),
          esc(isTq ? `${item.recipient_name || ''} ${item.recipient_account || ''}`.trim() : ''),
          esc(item.amount),
          esc(item.currency || 'NGN'),
          esc(item.fee ?? 0),
          esc(item.status),
          esc(isTq ? item.remark : item.description),
        ].join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="transfer-history-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(lines.join('\n'));
    }

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
          payment_provider: null,
          provider_metadata: null,
          created_at: item.created_at,
          updated_at: item.updated_at,
          type: 'transaction',
          direction: item.direction,
          transaction_type: item.transaction_type,
          fee: item.fee
        };
      }
    });

    // Provider internals never reach the customer: blank out the payout
    // provider + raw provider payloads on every row (transfer_queue rows
    // above are passed through raw, so this sweep covers both branches).
    for (const row of formattedData as any[]) {
      if ('payment_provider' in row) row.payment_provider = null;
      if ('provider_metadata' in row) row.provider_metadata = null;
    }

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
/**
 * GET /transfers/beneficiaries — the user's transfer recipients directory
 * (newest first). Powers the beneficiary page and the one-tap chips in the
 * transfer form. `?currency=NGN|USD|GBP|EUR` filters to one corridor;
 * `?intl=true|false` splits local vs global.
 */
router.get("/beneficiaries", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const currency = req.query.currency ? String(req.query.currency).toUpperCase() : null;
    const intl = req.query.intl ? String(req.query.intl).toLowerCase() === 'true' : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

    const clauses: string[] = [`user_id = $1`];
    const params: any[] = [userId];
    if (currency) {
      params.push(currency);
      clauses.push(`UPPER(currency) = $${params.length}`);
    }
    if (intl !== null) {
      params.push(intl);
      clauses.push(`COALESCE(is_intl, UPPER(currency) <> 'NGN') = $${params.length}`);
    }

    const result = await query(
      `SELECT id, bank_code, bank_name, account_number, account_name, currency,
              recipient_country, routing_number, swift_code, account_type,
              address_line, city, state, postal_code, email, is_intl,
              use_count, last_used_at
       FROM transfer_beneficiaries
       WHERE ${clauses.join(' AND ')}
       ORDER BY last_used_at DESC
       LIMIT ${limit}`,
      params,
    );

    res.json({
      success: true,
      data: result.rows.map((r: any) => ({
        id: r.id,
        bankCode: r.bank_code,
        bankName: r.bank_name || null,
        accountNumber: r.account_number,
        accountName: r.account_name || '',
        currency: (r.currency || 'NGN').toUpperCase(),
        recipientCountry: r.recipient_country || null,
        routingNumber: r.routing_number || null,
        swiftCode: r.swift_code || null,
        accountType: r.account_type || null,
        address: r.address_line || null,
        city: r.city || null,
        state: r.state || null,
        postalCode: r.postal_code || null,
        email: r.email || null,
        isIntl: r.is_intl === true || (r.currency || 'NGN').toUpperCase() !== 'NGN',
        useCount: Number(r.use_count || 0),
        lastUsedAt: r.last_used_at,
      })),
    });
  } catch (error) {
    console.error("List beneficiaries error:", error);
    res.status(500).json({ success: false, error: "Failed to load beneficiaries" });
  }
});

/**
 * POST /transfers/beneficiaries — save a beneficiary from the beneficiary
 * page. Local (NGN) beneficiaries are verified with the provider's account
 * resolution (real account-name check); international (USD/GBP/EUR)
 * beneficiaries are corridor-validated (routing checksums, SWIFT format,
 * address block) — Flutterwave does not expose account resolution for
 * foreign rails, so format validation is the strongest pre-check available.
 */
router.post("/beneficiaries", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const businessId = req.user?.businessId || null;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const b = req.body || {};
    const currency = String(b.currency || 'NGN').toUpperCase();
    const accountNumber = String(b.accountNumber || b.account_number || '').trim();
    const bankCode = String(b.bankCode || b.bank_code || (currency === 'NGN' ? '' : (b.routingNumber || b.routing_number || b.swiftCode || b.bank_name || currency))).trim();
    const accountName = String(b.accountName || b.account_name || '').trim();

    if (!accountNumber) {
      return res.status(400).json({ success: false, error: "Account number is required", code: 'ACCOUNT_NUMBER_REQUIRED' });
    }

    const isIntl = currency !== 'NGN';
    let verification: 'resolved' | 'format' | 'unverified' = 'unverified';
    let resolvedName: string | null = null;

    if (isIntl) {
      // Corridor validation first (routing checksum / sort code / SWIFT).
      const intlCheck = validateIntlBeneficiary(currency, {
        routingNumber: b.routingNumber || b.routing_number,
        swiftCode: b.swiftCode || b.swift_code,
        bankName: b.bankName || b.bank_name,
        accountType: b.accountType || b.account_type,
        accountNumber,
        beneficiaryAddress: b.address || b.addressLine || b.address_line,
        beneficiaryPostalCode: b.postalCode || b.postal_code,
      });
      if (!intlCheck.valid) {
        return res.status(400).json({ success: false, error: intlCheck.error, code: intlCheck.code });
      }
      // Best-effort provider verification: Flutterwave's accounts/resolve is
      // a local-corridor endpoint, so a foreign resolve attempt usually
      // 4xx's — the corridor validation above is the authoritative gate.
      try {
        const railCode = currency === 'USD' ? String(b.routingNumber || b.routing_number || 'ACH').toUpperCase()
          : currency === 'GBP' ? String(b.routingNumber || b.routing_number || '').replace(/[\s-]/g, '')
          : String(b.swiftCode || b.swift_code || '');
        if (railCode) {
          const lookup = await accountLookup(railCode, accountNumber);
          const name = lookup?.data?.account_name || lookup?.data?.accountName || null;
          if (name) {
            resolvedName = name;
            verification = 'resolved';
          }
        }
      } catch {
        // Expected for foreign rails — keep the format-verified result.
      }
      if (verification !== 'resolved') verification = 'format';
    } else {
      // NGN: resolve the real account name through the provider.
      if (!bankCode) {
        return res.status(400).json({ success: false, error: "Bank is required for NGN beneficiaries", code: 'BANK_CODE_REQUIRED' });
      }
      try {
        const lookup = await accountLookup(bankCode, accountNumber);
        const name = lookup?.data?.account_name || lookup?.data?.accountName || null;
        if (!name) {
          return res.status(400).json({ success: false, error: "Account could not be verified. Check the account number and bank.", code: 'ACCOUNT_RESOLVE_FAILED' });
        }
        resolvedName = name;
        verification = 'resolved';
      } catch (err: any) {
        return res.status(400).json({ success: false, error: err?.message || "Account could not be verified. Check the account number and bank.", code: 'ACCOUNT_RESOLVE_FAILED' });
      }
    }

    const finalName = accountName || resolvedName || null;
    const insert = await query(
      `INSERT INTO transfer_beneficiaries
         (user_id, business_id, bank_code, account_number, account_name, currency,
          bank_name, recipient_country, routing_number, swift_code, account_type,
          address_line, city, state, postal_code, email, is_intl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (user_id, bank_code, account_number)
       DO UPDATE SET
         account_name = COALESCE(EXCLUDED.account_name, transfer_beneficiaries.account_name),
         bank_name = COALESCE(EXCLUDED.bank_name, transfer_beneficiaries.bank_name),
         currency = EXCLUDED.currency,
         recipient_country = COALESCE(EXCLUDED.recipient_country, transfer_beneficiaries.recipient_country),
         routing_number = COALESCE(EXCLUDED.routing_number, transfer_beneficiaries.routing_number),
         swift_code = COALESCE(EXCLUDED.swift_code, transfer_beneficiaries.swift_code),
         account_type = COALESCE(EXCLUDED.account_type, transfer_beneficiaries.account_type),
         address_line = COALESCE(EXCLUDED.address_line, transfer_beneficiaries.address_line),
         city = COALESCE(EXCLUDED.city, transfer_beneficiaries.city),
         state = COALESCE(EXCLUDED.state, transfer_beneficiaries.state),
         postal_code = COALESCE(EXCLUDED.postal_code, transfer_beneficiaries.postal_code),
         email = COALESCE(EXCLUDED.email, transfer_beneficiaries.email),
         is_intl = EXCLUDED.is_intl,
         last_used_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        userId, businessId, bankCode, accountNumber, finalName, currency,
        b.bankName || b.bank_name || null,
        (b.country || b.recipient_country || (isIntl ? (currency === 'GBP' ? 'GB' : currency === 'EUR' ? 'DE' : 'US') : 'NG')) || null,
        b.routingNumber || b.routing_number || null,
        b.swiftCode || b.swift_code || null,
        b.accountType || b.account_type || null,
        b.address || b.addressLine || b.address_line || null,
        b.city || null,
        b.state || null,
        b.postalCode || b.postal_code || null,
        b.email || null,
        isIntl,
      ],
    );
    const r = insert.rows[0];

    res.json({
      success: true,
      message: verification === 'resolved'
        ? "Beneficiary verified and saved"
        : "Beneficiary details validated and saved",
      data: {
        id: r.id,
        bankCode: r.bank_code,
        bankName: r.bank_name || null,
        accountNumber: r.account_number,
        accountName: r.account_name || '',
        currency: (r.currency || 'NGN').toUpperCase(),
        isIntl: r.is_intl === true,
        verification,
        resolvedName,
      },
    });
  } catch (error) {
    console.error("Create beneficiary error:", error);
    res.status(500).json({ success: false, error: "Failed to save beneficiary" });
  }
});

/**
 * DELETE /transfers/beneficiaries/:id — remove a saved beneficiary.
 */
router.delete("/beneficiaries/:id", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const result = await query(
      `DELETE FROM transfer_beneficiaries WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: "Beneficiary not found" });
    }
    res.json({ success: true, message: "Beneficiary removed" });
  } catch (error) {
    console.error("Delete beneficiary error:", error);
    res.status(500).json({ success: false, error: "Failed to remove beneficiary" });
  }
});

/**
 * POST /transfers/:id/force-reversal — customer-triggered self-heal.
 *
 * A failed transfer whose money has NOT come back yet (e.g. the reversal
 * webhook arrived while the backend ran an older build). Idempotent: the
 * shared reverseFailedTransfer helper refuses double refunds, so tapping
 * repeatedly is safe. Accepts the transfer UUID or its reference.
 */
router.post("/:id/force-reversal", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const businessId = req.user?.businessId;
    const { id } = req.params;
    if (!userId || !businessId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isUuid = /^[0-9a-fA-F-]{36}$/.test(String(id));
    const transferRes = await query(
      isUuid
        ? `SELECT * FROM transfer_queue WHERE id = $1 AND business_id = $2`
        : `SELECT * FROM transfer_queue WHERE reference = $1 AND business_id = $2`,
      [id, businessId],
    );
    if (transferRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Transfer not found" });
    }
    const transfer = transferRes.rows[0];

    if (transfer.status !== 'failed') {
      return res.status(400).json({
        success: false,
        error: `Only failed transfers can be reversed (this one is "${transfer.status}")`,
      });
    }
    if (!transfer.wallet_id) {
      return res.status(400).json({
        success: false,
        error: "This transfer is not linked to a wallet — contact support",
      });
    }

    // Already refunded? Report the existing refund instead of erroring.
    const refundRes = await query(
      `SELECT id, reference FROM transactions WHERE reference = $1 LIMIT 1`,
      [`${transfer.reference}-REFUND`],
    );
    if (refundRes.rows.length > 0) {
      return res.json({
        success: true,
        message: 'This transfer was already reversed — the amount is back in your wallet.',
        data: { alreadyReversed: true, refundReference: refundRes.rows[0].reference },
      });
    }

    // Reverse with a HARD 20s cap. The wallet UPDATE can momentarily wait on
    // a row lock (e.g. the reconciliation monitor reversing the same failed
    // transfer concurrently) — without a cap the HTTP request hangs past the
    // mobile client's 30s timeout and the user just sees "Something went
    // wrong". On timeout we answer honestly: the reversal continues in the
    // background (idempotent) and the monitor sweep is the safety net.
    const reversed = await Promise.race([
      reverseFailedTransfer(transfer, 'Customer-requested reversal from receipt'),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20000)),
    ]);
    if (!reversed) {
      return res.status(500).json({
        success: false,
        error: "Reversal could not be completed right now — it will retry automatically, or contact support",
      });
    }

    res.json({
      success: true,
      message: "Reversal completed — the full amount (including the fee) is back in your wallet.",
      data: { alreadyReversed: false },
    });
  } catch (error) {
    console.error("Force reversal error:", error);
    res.status(500).json({ success: false, error: "Failed to reverse transfer" });
  }
});

router.post("/:id/retry", authenticateToken, requireTeamPermission("manage_finance"), checkKycStatus, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;

    // Verify ownership and status
    const check = await query(`SELECT * FROM transfer_queue WHERE id = $1 AND business_id = $2`, [id, businessId]);
    if (check.rows.length === 0) return res.status(404).json({ success: false, error: "Transfer not found" });
    
    if (check.rows[0].status !== 'failed') {
      return res.status(400).json({ success: false, error: "Only failed transfers can be retried" });
    }

    // REFUND BEFORE RETRY: retrying rewrites the queue row's reference —
    // every auto-reversal path (webhooks, monitor sweep) matches on that
    // reference, so an un-refunded debit from the FAILED attempt was
    // orphaned forever (the "money never came back" bug). Reverse the
    // original attempt FIRST (idempotent — no-op if already refunded),
    // then start the fresh attempt which re-debits the wallet cleanly.
    try {
      const refunded = await reverseFailedTransfer(check.rows[0], 'Refund of original failed attempt before retry');
      if (refunded) {
        console.log(`[Transfers] Pre-retry reversal applied for ${check.rows[0].reference}`);
      }
    } catch (reversalErr) {
      // Never block the retry on the refund bookkeeping — log for follow-up.
      console.error('[Transfers] Pre-retry reversal failed:', reversalErr);
    }

    const defaultProvider = await getActiveTransferProviderName();
    
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
        createdAt: updatedTransfer.created_at,
        updatedAt: updatedTransfer.updated_at
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to retry transfer" });
  }
});

/**
 * @swagger
 * /transfers/{id}/reverse:
 *   post:
 *     summary: Manually reverse a failed transfer back to the wallet
 *     description: Returns the debited amount (including fee) for a FAILED transfer to the source wallet. Idempotent — an already-reversed transfer reports itself instead of double-crediting.
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
 *         description: Reversal applied
 *       400:
 *         description: Transfer not eligible for reversal
 *       404:
 *         description: Transfer not found
 */
router.post("/:id/reverse", authenticateToken, requireTeamPermission("manage_finance"), async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const businessId = req.user?.businessId;

    const check = await query(`SELECT * FROM transfer_queue WHERE id = $1 AND business_id = $2`, [id, businessId]);
    if (check.rows.length === 0) return res.status(404).json({ success: false, error: "Transfer not found" });

    const transfer = check.rows[0];

    if (transfer.status !== 'failed') {
      return res.status(400).json({
        success: false,
        error: transfer.status === 'success'
          ? "Successful transfers cannot be reversed"
          : "Only failed transfers can be reversed. Transfers stuck in processing are auto-reversed after 24 hours.",
      });
    }

    // Eligibility mirrors the automatic reversal: the wallet must actually
    // have been debited (a type='debit' transaction with this reference) and
    // no '<ref>-REFUND' row may exist yet. Diagnose WHY it can't reverse so
    // the user gets an honest answer instead of a silent no-op.
    const debitCheck = await query(
      `SELECT id FROM transactions WHERE reference = $1 AND type = 'debit' LIMIT 1`,
      [transfer.reference],
    );
    const refundCheck = await query(
      `SELECT id FROM transactions WHERE reference = $1 LIMIT 1`,
      [`${transfer.reference}-REFUND`],
    );
    if (refundCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: "This transfer has already been reversed — the amount is back in your wallet.",
        code: "ALREADY_REVERSED",
      });
    }
    if (debitCheck.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: "The wallet was never debited for this transfer, so there is nothing to reverse.",
        code: "NOTHING_TO_REVERSE",
      });
    }

    const reversed = await reverseFailedTransfer(transfer, 'Manual reversal requested by user');
    if (!reversed) {
      return res.status(500).json({ success: false, error: "Reversal could not be completed. Please contact support." });
    }

    // Surface the reversal on the queue row so list screens can render an
    // honest state without probing the transactions table.
    await query(
      `UPDATE transfer_queue SET failure_reason = COALESCE(failure_reason, '') || ' [Reversed to wallet]' WHERE id = $1`,
      [id],
    );

    const amount = parseFloat(transfer.amount);
    const fee = parseFloat(transfer.fee || '0');
    res.json({
      success: true,
      message: "Reversal successful — the amount (including the fee) has been returned to your wallet.",
      data: {
        id: transfer.id,
        reference: transfer.reference,
        refunded: amount + fee,
        currency: transfer.currency || 'NGN',
      },
    });
  } catch (error) {
    console.error("Reverse transfer error:", error);
    res.status(500).json({ success: false, error: "Failed to reverse transfer" });
  }
});

router.post("/:id/verify", authenticateToken, requireTeamPermission("manage_finance"), async (req: AuthenticatedRequest, res) => {
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
    // Honour the admin-selected provider (global or transfer-specific) so bank
    // lists always match the provider actually used for payouts/lookups.
    const transferProvider = await getActiveTransferProviderName();
    const provider = getProvider(transferProvider);
    const banks = provider.getBanks();
    // Provider internals never reach the customer: banks only.
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
router.post("/lookup", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
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
router.post("/account-lookup", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
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
