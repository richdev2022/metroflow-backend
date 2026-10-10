import express from "express";
import { sendSMS } from "../services/sms";
import { sendEmail, generateOtpEmailHtml, generateKYCOtpEmailHtml } from "../services/email";
import { sendWhatsApp } from "../services/whatsapp";
import { getAvailableSMSProviders, getSMSProvider } from "../services/sms-providers/factory";
import { isPushConfigured, sendToTokens, PushSendDiagnostic, getPushServiceAccountDiagnostics } from "../services/push";
import { query } from "../db";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import crypto from "crypto";

const router = express.Router();

/**
 * @swagger
 * /test-communications/push-status:
 *   get:
 *     summary: Push (FCM) diagnostics for the signed-in user
 *     description: Shows whether FCM credentials are configured server-side, which Firebase project sends are targeting, and how many devices are registered for the caller. Use this to verify the push pipeline end to end.
 *     tags: [Test Communications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Diagnostics
 */
router.get("/push-status", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    // Full device rows (not just counts): "my android device vanished" needs
    // creation/last-seen timestamps and a token preview to debug.
    const devicesRes = await query(
      `SELECT platform, device_name, app_version,
              LEFT(fcm_token, 18) || '…' AS token_preview,
              created_at, last_seen_at
         FROM user_devices WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    );
    const countsRes = await query(
      `SELECT platform, COUNT(*)::int AS count FROM user_devices WHERE user_id = $1 GROUP BY platform`,
      [userId],
    );
    // Unified diagnostics: handles raw JSON / base64 / FIREBASE_SERVICE_ACCOUNT_FILE
    // and returns the actionable parse error when the .env value is damaged.
    const sa = getPushServiceAccountDiagnostics();
    const account = sa.account
      ? { project_id: sa.account.project_id || null, client_email: sa.account.client_email || null }
      : { project_id: null, client_email: null, parse_error: true as const };

    const mode = sa.account
      ? sa.source === "file"
        ? "http-v1 (service account file)"
        : sa.source === "env-base64"
          ? "http-v1 (service account, base64)"
          : "http-v1 (service account)"
      : process.env.FCM_SERVER_KEY
        ? "legacy server key"
        : "NOT CONFIGURED — pushes are dropped silently; set FIREBASE_SERVICE_ACCOUNT_JSON + FIREBASE_PROJECT_ID";

    res.json({
      success: true,
      data: {
        fcmConfigured: isPushConfigured(),
        mode,
        firebaseProjectId: process.env.FIREBASE_PROJECT_ID || account?.project_id || null,
        serviceAccountEmail: account?.client_email || null,
        // false = GOOD (the credentials parsed cleanly). true = the env/file is
        // malformed and FCM can never authenticate — see serviceAccountError.
        serviceAccountParseError: !!sa.error || !(account as any)?.client_email,
        serviceAccountOk: !!sa.account,
        serviceAccountSource: sa.source,
        serviceAccountError: sa.error || null,
        serviceAccountMultilineEnvSuspected: !!sa.multilineEnvSuspected,
        myDevices: countsRes.rows,
        myDeviceDetails: devicesRes.rows,
        hint:
          "fcmConfigured:true and serviceAccountParseError:false are the healthy state — 'false' here is NOT an error. " +
          "Devices only appear for the account you are signed in as (both on the phone AND in this request). " +
          "If a device that just opened the app is MISSING, it was pruned after a failed send: check the server log for " +
          "'[push] pruned invalid token'. A fresh token pruned with 404 means the app's Firebase project " +
          "(google-services.json / GoogleService-Info.plist project_id) does not equal firebaseProjectId above — " +
          "use POST /test-communications/push-send to reproduce and see the exact FCM error per device. " +
          "If serviceAccountParseError is true, run `node scripts/fix-firebase-env.mjs` on the server and restart pm2.",
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || "Failed to read push status" });
  }
});

/**
 * @swagger
 * /test-communications/push-send:
 *   post:
 *     summary: Fire a REAL FCM push at all of the caller's registered devices
 *     description: >
 *       Replays the exact production payload shapes (incoming-call data-only ring,
 *       chat-message alert, or a plain general test) against every device registered
 *       to the signed-in user and reports the per-device FCM result. Use it to prove
 *       the pipeline end to end without placing a real call.
 *     tags: [Test Communications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               kind:
 *                 type: string
 *                 enum: [general, call, chat]
 *                 description: Payload shape to send. call = data-only ring (wakes the app full-screen), chat = message alert, general = plain test banner. Default general.
 *               platform:
 *                 type: string
 *                 enum: [android, ios]
 *                 description: Only send to this platform's devices. Default all.
 *     responses:
 *       200:
 *         description: Per-device delivery report
 */
router.post("/push-send", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(400).json({ success: false, error: "User authentication required" });
    }
    const kind = ["general", "call", "chat"].includes(req.body?.kind) ? req.body.kind : "general";
    const platformFilter = ["android", "ios"].includes(req.body?.platform) ? req.body.platform : null;

    const devicesRes = await query(
      `SELECT fcm_token, platform, device_name FROM user_devices WHERE user_id = $1`,
      [userId],
    );
    const devices = devicesRes.rows
      .filter((d: any) => d.fcm_token)
      .filter((d: any) => !platformFilter || String(d.platform || "").toLowerCase() === platformFilter);

    if (devices.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          `No registered device${platformFilter ? ` on platform "${platformFilter}"` : "s"} for this account. ` +
          "Open the mobile app signed in as THIS user first — the app registers its FCM token at " +
          "/notifications/register-device after login.",
      });
    }

    const stamp = crypto.randomBytes(4).toString("hex");
    let payload;
    if (kind === "call") {
      // EXACTLY the shape of call-push.ts attempt 1: data-only on Android so
      // the app renders the full-screen ringing UI even when killed/swiped.
      payload = {
        title: "Push Test Caller",
        body: "Incoming audio call (push pipeline test)",
        data: {
          type: "incoming-call",
          callId: `push-test-${stamp}`,
          callType: "audio",
          callerName: "Push Test Caller",
          callerId: userId,
          callCode: "",
        },
        androidChannelId: "calls-v3",
        ttlSeconds: 45,
        collapseKey: `incoming-call-push-test-${stamp}`,
        androidDataOnly: true,
      };
    } else if (kind === "chat") {
      // EXACTLY the shape of the chat.ts message push.
      payload = {
        title: "Push Test",
        body: "This is a chat push delivery test",
        data: {
          type: "chat-message",
          conversationId: `push-test-${stamp}`,
          messageId: `push-test-msg-${stamp}`,
          senderId: userId,
          senderName: "Push Test",
          conversationName: "",
          conversationType: "direct",
          message: "This is a chat push delivery test",
          badge: "1",
        },
        androidChannelId: "general",
        ttlSeconds: 3600,
        collapseKey: `chat-push-test-${stamp}`,
      };
    } else {
      payload = {
        title: "Metroflow push test",
        body: `Push pipeline test (${kind}) — if you can read this on the device, FCM delivery works`,
        data: { type: "test", kind, stamp },
      };
    }

    const diagnostics: PushSendDiagnostic[] = [];
    const result = await sendToTokens(
      devices.map((d: any) => d.fcm_token),
      payload,
      diagnostics,
    );

    const perDevice = devices.map((d: any, i: number) => ({
      platform: d.platform || "unknown",
      deviceName: d.device_name || null,
      tokenPreview: String(d.fcm_token).slice(0, 18) + "…",
      ...(diagnostics[i] || { ok: false, httpStatus: null, error: "no diagnostic recorded" }),
    }));

    const allFailed404 = result.sent === 0 && diagnostics.every((x) => x.httpStatus === 404 || x.httpStatus === 410);
    res.json({
      success: true,
      data: {
        kind,
        summary: { devices: devices.length, accepted: result.sent, failed: result.failed },
        devices: perDevice,
        diagnosis: allFailed404
          ? {
              likelyConfigProblem: true,
              message:
                "FCM rejected EVERY token with 404. For freshly-registered devices this is almost never staleness — it is a config mismatch: " +
                "the app fetched its FCM token from a DIFFERENT Firebase project than the backend sends to. " +
                "Fix: make the project_id in android/app/google-services.json AND the PROJECT_ID in ios/Runner/GoogleService-Info.plist " +
                "equal the backend's FIREBASE_PROJECT_ID (either replace the app config files with the current project's, or point the " +
                "backend service account at the app's project), then rebuild/reinstall the app. iOS additionally needs an APNs auth key " +
                "uploaded in the Firebase console (Settings > Cloud Messaging > Apple app configuration). " +
                "Tokens pruned by this test will re-register automatically next time the app opens.",
            }
          : {
              likelyConfigProblem: false,
              message:
                result.sent > 0
                  ? "FCM ACCEPTED the send — if the device still showed nothing, the problem is on-device (notification permission denied, channel disabled, or the app was force-stopped and the OEM suppressed data-only delivery)."
                  : "FCM rejected the send for reasons reported per device below.",
            },
      },
    });
  } catch (error: any) {
    console.error("Test push-send error:", error);
    res.status(500).json({ success: false, error: error?.message || "Failed to send test push" });
  }
});

/**
 * @swagger
 * tags:
 *   name: Test Communications
 *   description: Test SMS and Email functionality
 */

// SMS Categories
const SMS_CATEGORIES = {
  'otp': (otp: string) => `Your verification code is: ${otp}. Valid for 10 minutes.`,
  'transfer_otp': (otp: string) => `Your Transfer OTP is: ${otp}`,
  'bvn_nin_otp': (otp: string) => `Your Metroflow verification code is: ${otp}. Valid for 10 minutes.`
};

// Email Categories
const EMAIL_CATEGORIES = {
  'otp': {
    subject: (purpose: string = "Verification") => `${purpose} OTP`,
    html: (otp: string, purpose: string = "Verification") => generateOtpEmailHtml(otp, purpose)
  },
  'kyc_otp': {
    subject: () => "KYC Verification OTP",
    html: (otp: string, name: string = "User") => generateKYCOtpEmailHtml(name, otp)
  },
  'transfer_otp': {
    subject: () => "Confirm Transfer",
    html: (otp: string) => generateOtpEmailHtml(otp, "Transfer Verification")
  }
};

// Helper to generate OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

/**
 * @swagger
 * /test-communications/send:
 *   post:
 *     summary: Send test SMS, Email, or WhatsApp
 *     tags: [Test Communications]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - category
 *               - recipient
 *             properties:
 *               type:
 *                 type: string
 *                 enum:
 *                   - sms
 *                   - email
 *                   - whatsapp
 *                 description: Type of communication to send
 *               category:
 *                 type: string
 *                 description: Category of message (see examples for available categories)
 *               recipient:
 *                 type: string
 *                 description: Phone number for SMS/WhatsApp or email address for Email
 *               otp:
 *                 type: string
 *                 description: Optional custom OTP (auto-generated if not provided)
 *               name:
 *                 type: string
 *                 description: Optional recipient name (for email)
 *               purpose:
 *                 type: string
 *                 description: Optional purpose (for OTP emails)
 *               provider:
 *                 type: string
 *                 description: Optional SMS provider (e.g., kudi or termii)
 *     responses:
 *       200:
 *         description: Message sent successfully
 *       400:
 *         description: Invalid input
 */
router.post("/send", async (req, res) => {
  try {
    const { type, category, recipient, otp: customOtp, name, purpose, provider } = req.body;

    // Validate required fields
    if (!type || !category || !recipient) {
      return res.status(400).json({ 
        success: false, 
        error: "Type, category, and recipient are required" 
      });
    }

    // Validate type
    if (!['sms', 'email', 'whatsapp'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: "Type must be 'sms', 'email', or 'whatsapp'" 
      });
    }

    const otp = customOtp || generateOTP();

    if (type === 'sms') {
      // Validate SMS category
      const smsCategory = category as keyof typeof SMS_CATEGORIES;
      if (!SMS_CATEGORIES[smsCategory]) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid SMS category. Available categories: ${Object.keys(SMS_CATEGORIES).join(', ')}` 
        });
      }

      // Validate provider if specified
      const availableProviders = getAvailableSMSProviders();
      if (provider && !availableProviders.includes(provider)) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid SMS provider. Available providers: ${availableProviders.join(', ')}` 
        });
      }

      // Send SMS
      const message = SMS_CATEGORIES[smsCategory](otp);
      console.log("Sending SMS with message:", message, "to recipient:", recipient, "using provider:", provider || 'default');
      
      let smsResult;
      if (provider) {
        const smsProvider = getSMSProvider(provider);
        smsResult = await smsProvider.sendSMS(recipient, message);
        // Direct provider calls return a normalized envelope instead of
        // throwing — check it so a rejected delivery is reported honestly.
        if (!smsResult || smsResult.success === false) {
          const reason = smsResult?.error || 'unknown provider error';
          console.error(`Test SMS delivery failed via ${provider}: ${reason}`);
          return res.status(502).json({
            success: false,
            error: `SMS delivery failed via ${provider}: ${reason}`,
            otp,
            category,
            recipient,
            provider,
            providerResponse: smsResult
          });
        }
      } else {
        // sendSMS throws on provider failure; the outer catch reports it.
        smsResult = await sendSMS(recipient, message);
      }
      
      console.log("SMS provider response:", smsResult);
      
      res.json({ 
        success: true, 
        message: "SMS sent successfully", 
        otp, 
        category,
        recipient,
        provider,
        providerResponse: smsResult
      });

    } else if (type === 'whatsapp') {
      // Validate WhatsApp category (uses the same as SMS categories
      const whatsappCategory = category as keyof typeof SMS_CATEGORIES;
      if (!SMS_CATEGORIES[whatsappCategory]) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid WhatsApp category. Available categories: ${Object.keys(SMS_CATEGORIES).join(', ')}` 
        });
      }

      // Send WhatsApp
      const message = SMS_CATEGORIES[whatsappCategory](otp);
      console.log("Sending WhatsApp with message:", message, "to recipient:", recipient);
      
      const whatsappResult = await sendWhatsApp(recipient, message);
      
      console.log("WhatsApp provider response:", whatsappResult);
      
      res.json({ 
        success: true, 
        message: "WhatsApp sent successfully", 
        otp, 
        category,
        recipient,
        providerResponse: whatsappResult
      });

    } else {
      // Validate Email category
      const emailCategory = category as keyof typeof EMAIL_CATEGORIES;
      if (!EMAIL_CATEGORIES[emailCategory]) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid email category. Available categories: ${Object.keys(EMAIL_CATEGORIES).join(', ')}` 
        });
      }

      // Send Email
      const subject = EMAIL_CATEGORIES[emailCategory].subject(purpose);
      const html = EMAIL_CATEGORIES[emailCategory].html(otp, name);
      await sendEmail(recipient, name || "User", subject, html);
      
      res.json({ 
        success: true, 
        message: "Email sent successfully", 
        otp, 
        category,
        recipient 
      });
    }

  } catch (error) {
    console.error("Test communication error:", error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : "Failed to send message" 
    });
  }
});

/**
 * @swagger
 * /test-communications/categories:
 *   get:
 *     summary: Get available categories for SMS, Email, and WhatsApp
 *     tags: [Test Communications]
 *     responses:
 *       200:
 *         description: List of available categories
 */
router.get("/categories", (req, res) => {
  res.json({
    success: true,
    sms_categories: Object.keys(SMS_CATEGORIES),
    whatsapp_categories: Object.keys(SMS_CATEGORIES),
    email_categories: Object.keys(EMAIL_CATEGORIES),
    available_sms_providers: getAvailableSMSProviders()
  });
});

export default router;
