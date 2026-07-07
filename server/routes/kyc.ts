import express from "express";
import { authenticateToken, checkSubscriptionStatus } from "../middleware/auth";
import { AuthenticatedRequest } from "../middleware/auth";
import { query } from "../db";
import { verifyBVN, verifyNIN } from "../services/prembly";
import { sendSMS } from "../services/sms";
import { sendWhatsApp } from "../services/whatsapp";
import { sendEmail, generateKYCOtpEmailHtml } from "../services/email";
import { createWallet } from "../services/wallet";
import { createVirtualAccount } from "../services/squad";
import { getProvider } from "../services/providers/factory";
import crypto from "crypto";
import { upload } from "../middleware/upload";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: KYC
 *   description: Know Your Customer verification endpoints
 */

/**
 * @swagger
 * /kyc/status:
 *   get:
 *     summary: Get KYC status for current user and business
 *     tags: [KYC]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: KYC status details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     bvnStatus:
 *                       type: string
 *                       enum: [pending, pending_otp, pending_review, verified, failed]
 *                     ninStatus:
 *                       type: string
 *                       enum: [pending, pending_otp, pending_review, verified, failed]
 *                     rejection_reason:
 *                       type: string
 *                 business:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [pending, pending_review, verified, failed]
 *                     rejection_reason:
 *                       type: string
 */
router.get("/status", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;

        const userRes = await query(`SELECT kyc_status, bvn_status, nin_status, rejection_reason FROM users WHERE id = $1`, [userId]);
        const businessRes = await query(`SELECT kyc_status, rejection_reason FROM businesses WHERE id = $1`, [businessId]);

        res.json({
            success: true,
            user: {
                bvnStatus: userRes.rows[0]?.bvn_status || 'pending',
                ninStatus: userRes.rows[0]?.nin_status || 'pending',
                rejection_reason: userRes.rows[0]?.rejection_reason
            },
            business: {
                status: businessRes.rows[0]?.kyc_status || 'pending',
                rejection_reason: businessRes.rows[0]?.rejection_reason
            }
        });
    } catch (error) {
        console.error("Get KYC status error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch KYC status" });
    }
});

/**
 * @swagger
 * /kyc/initiate:
 *   post:
 *     summary: Initiate KYC verification (BVN or NIN)
 *     tags: [KYC]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [bvn, nin]
 *               number:
 *                 type: string
 *               otp_method:
 *                 type: string
 *                 enum: [sms, whatsapp, email]
 *     responses:
 *       200:
 *         description: Verification initiated, OTP sent if applicable
 */
router.post("/initiate", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const businessId = req.user!.businessId;
        const { type, number, otp_method } = req.body;

        if (!['bvn', 'nin'].includes(type) || !number) {
            return res.status(400).json({ success: false, error: "Invalid KYC type or number missing" });
        }

        // Check if already verified
        const userCheck = await query(`SELECT kyc_status, bvn_status, nin_status, email, name FROM users WHERE id = $1`, [userId]);
        
        if (type === 'bvn' && userCheck.rows[0]?.bvn_status === 'verified') {
            return res.status(400).json({ success: false, error: "BVN is already verified" });
        }
        if (type === 'nin' && userCheck.rows[0]?.nin_status === 'verified') {
            return res.status(400).json({ success: false, error: "NIN is already verified" });
        }
        
        const userEmail = userCheck.rows[0]?.email;
        const userName = userCheck.rows[0]?.name;

        let verificationData;
        
        // Call Prembly API
        if (type === 'bvn') {
            verificationData = await verifyBVN(number);
        } else {
            verificationData = await verifyNIN(number);
        }

        // Prembly usually returns data including phone number for OTP
        const data = verificationData?.data || verificationData;
        const phone = data?.phoneNumber || data?.phone_number || data?.phoneNumber1 || data?.mobile || data?.phone || data?.telephoneno;
        const firstName = data?.firstName || data?.first_name || data?.firstname;
        const lastName = data?.lastName || data?.last_name || data?.lastname;

        if (!phone) {
             await query(
                `UPDATE users SET ${type} = $1, kyc_data = $2, kyc_status = 'pending_review' WHERE id = $3`,
                [number, JSON.stringify(verificationData), userId]
             );
             
             return res.json({ 
                 success: true, 
                 message: "Verification data submitted for review", 
                 status: "pending_review",
                 firstName,
                 lastName
             });
        }

        // Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

        // Save OTP hash
        await query(
            `UPDATE users SET 
                ${type} = $1, 
                kyc_data = $2, 
                otp_hash = $3, 
                otp_expires_at = $4, 
                kyc_status = 'pending_otp',
                ${type}_status = 'pending_otp',
                otp_type = '${type}'
             WHERE id = $5`,
            [number, JSON.stringify(verificationData), otpHash, expiresAt, userId]
        );

        // Send OTP based on Environment and chosen method
        const kycEnv = process.env.KYC || 'live';
        const message = `Your Metroflow verification code is: ${otp}. Valid for 10 minutes.`;
        const chosenMethod = otp_method || 'sms'; // default to sms

        let messageResponse = "";
        
        if (chosenMethod === 'whatsapp') {
            await sendWhatsApp(phone, message);
            messageResponse = "OTP sent to linked WhatsApp number.";
        } else if (chosenMethod === 'sms') {
            await sendSMS(phone, message);
            messageResponse = "OTP sent to linked phone number.";
        } else if (chosenMethod === 'email' && userEmail) {
            const emailHtml = generateKYCOtpEmailHtml(userName, otp);
            await sendEmail(userEmail, userName, "KYC Verification OTP", emailHtml);
            messageResponse = "OTP sent to email.";
        }

        // If Test, also send to email as backup
        if (kycEnv.toLowerCase() === 'test' && userEmail && chosenMethod !== 'email') {
            const emailHtml = generateKYCOtpEmailHtml(userName, otp);
            await sendEmail(userEmail, userName, "KYC Verification OTP", emailHtml);
            messageResponse += " and email (Test Mode).";
        }

        res.json({ 
            success: true, 
            message: "Verification initiated. " + messageResponse, 
            phone: phone.replace(/\d(?=\d{4})/g, "*"),
            firstName,
            lastName
        });

    } catch (error: any) {
        console.error("KYC Initiate Error:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to initiate KYC" });
    }
});

/**
 * @swagger
 * /kyc/verify-otp:
 *   post:
 *     summary: Verify OTP to complete KYC
 *     tags: [KYC]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               otp:
 *                 type: string
 *     responses:
 *       200:
 *         description: KYC completed successfully
 */
router.post("/verify-otp", authenticateToken, async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user!.userId;
        const { otp } = req.body;

        if (!otp) {
            return res.status(400).json({ success: false, error: "OTP is required" });
        }

        const userResult = await query(
            `SELECT id, bvn_status, nin_status, kyc_status, otp_hash, otp_expires_at, kyc_data, otp_type, name, email
             FROM users WHERE id = $1`, 
            [userId]
        );
        const user = userResult.rows[0];

        let verifiedType = user.otp_type || '';
        if (!verifiedType) {
            if (user.bvn_status === 'pending_otp') verifiedType = 'bvn';
            else if (user.nin_status === 'pending_otp') verifiedType = 'nin';
        }

        if (!user || (!verifiedType && user.kyc_status !== 'pending_otp')) {
            return res.status(400).json({ success: false, error: "No pending OTP verification found" });
        }

        if (new Date() > new Date(user.otp_expires_at)) {
            return res.status(400).json({ success: false, error: "OTP expired" });
        }

        const inputHash = crypto.createHash('sha256').update(otp).digest('hex');
        if (inputHash !== user.otp_hash) {
            return res.status(400).json({ success: false, error: "Invalid OTP" });
        }

        // Mark as verified
        const updates: string[] = ["kyc_status = 'verified'", "otp_hash = NULL", "otp_expires_at = NULL"];
        if (verifiedType) {
            updates.push(`${verifiedType}_status = 'verified'`);
        } else {
             // If we couldn't determine type but kyc_status was pending_otp (legacy fallback)
             // We can't verify bvn_status or nin_status safely without knowing which one.
             // But we can check if bvn or nin is present and recent?
             // For now, just set kyc_status which is already in updates.
        }

        await query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $1`,
            [userId]
        );

        // Fetch User Data for VA Creation
        const kycData = user.kyc_data?.data || user.kyc_data; // Handle Prembly response structure

        // Create Wallet for user if not exists
        await createWallet(userId, 'user');

        // Create Virtual Account (Individual)
        // Get wallet id
        const walletRes = await query(`SELECT id FROM wallets WHERE user_id = $1`, [userId]);
        if (walletRes.rows.length !== 0) {
            const walletId = walletRes.rows[0].id;
            const provider = getProvider();
            
            // Check if VA already exists for this provider
            const vaCheck = await query(
                `SELECT id FROM virtual_accounts WHERE wallet_id = $1 AND payment_provider = $2`,
                [walletId, provider.name]
            );
            if (vaCheck.rows.length === 0) {
                 // Try to create VA if we have enough data
                 // This is best effort for now as we might lack beneficiary account
                 
                 const beneficiaryAccount = "0000000000"; // Dummy or needs to be fetched
                 
                 if (kycData) { 
                     const nameParts = user.name.split(' ');
                     const firstName = kycData.firstName || nameParts[0] || "User";
                     const lastName = kycData.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : nameParts[0] || "User");
                     
                     const vaData = {
                         firstName,
                         lastName,
                         phoneNumber: kycData.phoneNumber || user.phone_number || "08000000000", // Fallback
                         dob: kycData.dateOfBirth || "01/01/1990", // Fallback
                         email: user.email,
                         bvn: kycData.bvn || user.bvn || "12345678901",
                         nin: kycData.nin || user.nin || "12345678901",
                         gender: kycData.gender === 'Male' ? "1" : "2",
                         address: "Lagos, Nigeria", 
                         customerIdentifier: userId,
                         beneficiaryAccount: beneficiaryAccount
                     };
                     
                     try {
                        const vaResponse = await provider.createVirtualAccount(vaData);
                        
                        let isSuccess = false;
                        let vaNumber = null;
                        let bankCode = '058';
                        let accountName = `${firstName} ${lastName}`;
                        
                        if (provider.name === 'squad') {
                            isSuccess = vaResponse.success;
                            vaNumber = vaResponse.data.virtual_account_number;
                        } else if (provider.name === 'monnify') {
                            isSuccess = vaResponse.requestSuccessful;
                            const accounts = vaResponse.responseBody?.accounts;
                            if (accounts && accounts.length > 0) {
                                vaNumber = accounts[0].accountNumber;
                                bankCode = accounts[0].bankCode;
                                accountName = vaResponse.responseBody.accountName;
                            }
                        }
                        
                        if (isSuccess && vaNumber) {
                            // Insert into virtual_accounts
                            await query(
                                `INSERT INTO virtual_accounts 
                                 (wallet_id, payment_provider, virtual_account_number, bank_code, account_name, customer_identifier, beneficiary_account, provider_metadata)
                                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                                [walletId, provider.name, vaNumber, bankCode, accountName, userId, beneficiaryAccount, JSON.stringify(vaResponse)]
                            );
                        } else {
                            // Report error if VA generation failed but don't fail the whole KYC verification
                            console.error("VA Creation Failed (API Response):", vaResponse);
                        }
                     } catch (err: any) {
                         console.error("Failed to create VA:", err);
                     }
                 }
            }
        }
                 /*
                 if (kycData && user.account_number && user.bank_code === '058') { // 058 is GTBank
                     const vaData = {
                         first_name: kycData.firstName || user.name.split(' ')[0],
                         last_name: kycData.lastName || user.name.split(' ').slice(1).join(' '),
                         mobile_num: kycData.phoneNumber, // Fallback to kycData
                         dob: kycData.dateOfBirth, // format mm/dd/yyyy
                         email: user.email,
                         bvn: kycData.bvn,
                         gender: kycData.gender === 'Male' ? "1" : "2",
                         address: "Lagos, Nigeria", // Placeholder if not in KYC
                         customer_identifier: userId,
                         beneficiary_account: user.account_number
                     };
                     
                     // await createVirtualAccount(vaData as any);
                     // Update wallet with VA number...
                     // Note: Commented out to prevent errors if data is incomplete, needs robust handling
                 }
                 */

        res.json({ success: true, message: "KYC Verified successfully" });

    } catch (error: any) {
        console.error("Verify OTP Error:", error);
        res.status(500).json({ success: false, error: "Failed to verify OTP" });
    }
});

/**
 * @swagger
 * /kyc/business:
 *   post:
 *     summary: Submit Business KYC (Address, Proof of Address)
 *     tags: [KYC]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               proof_of_address:
 *                 type: string
 *                 format: binary
 *               country:
 *                 type: string
 *               state:
 *                 type: string
 *               city:
 *                 type: string
 *               street:
 *                 type: string
 *               house_number:
 *                 type: string
 *     responses:
 *       200:
 *         description: Business KYC submitted
 */
router.post("/business", authenticateToken, upload.single('proof_of_address'), async (req: AuthenticatedRequest, res) => {
  try {
    const businessId = req.user!.businessId;
    const { country, state, city, street, house_number } = req.body;
    
    const request = req as any;
    if (!request.file) {
         return res.status(400).json({ success: false, error: "Proof of address file is required" });
    }
    
    if (!country || !state || !city || !street || !house_number) {
         return res.status(400).json({ success: false, error: "All address fields are required" });
    }

    let proofUrl = "";
    if (request.file.buffer) {
        const b64 = request.file.buffer.toString('base64');
        proofUrl = `data:${request.file.mimetype};base64,${b64}`;
    } else if (request.file.filename) {
         // Fallback if disk storage is somehow used
         proofUrl = `/uploads/${request.file.filename}`;
    }

    await query(
      `UPDATE businesses SET 
          proof_of_address_url = $1, 
          address_country = $2,
          address_state = $3,
          address_city = $4,
          address_street = $5,
          address_house_number = $6,
          kyc_status = 'pending_review' 
       WHERE id = $7`,
      [proofUrl, country, state, city, street, house_number, businessId]
    );

    // Notify Admins
    const adminEmails = process.env.KYC_ADMIN_EMAILS ? process.env.KYC_ADMIN_EMAILS.split(',') : [];
    if (adminEmails.length > 0) {
      const busRes = await query(`SELECT name FROM businesses WHERE id = $1`, [businessId]);
      const busName = busRes.rows[0]?.name || "Unknown Business";
      
      for (const email of adminEmails) {
           await sendEmail(email.trim(), "Admin", "New Business KYC Submission", `
              <h3>New KYC Submission</h3>
              <p><strong>Business:</strong> ${busName}</p>
              <p><strong>Status:</strong> Pending Review</p>
              <p>Please log in to the admin dashboard to review.</p>
           `);
      }
    }

    res.json({ success: true, message: "Business KYC submitted for review" });

  } catch (error) {
    console.error("Business KYC Error:", error);
    res.status(500).json({ success: false, error: "Failed to submit business KYC" });
  }
});

export default router;
