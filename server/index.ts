import "dotenv/config";
import * as Sentry from "@sentry/node";
import express from "express";
import path from "path";
// import { fileURLToPath } from 'url';
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { specs } from "./swagger";
import { isOverdue } from "./utils/date";
import logger from "./lib/logger";
import { corsOptions } from "./cors";

// Sentry is initialized in instrument.ts which is imported first in the entry file
let sentryInitialized = !!process.env.SENTRY_DSN;

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);


import { handleDemo } from "./routes/demo";
import {
  registerBusiness,
  verifyOTP,
  login,
  resendOTP,
  forgotPassword,
  verifyResetOTP,
  resetPassword,
  googleAuth,
  setPassword,
  changePassword,
  getMe,
} from "./routes/auth";
import { biometricEnroll, biometricLogin, biometricRevoke, biometricStatus } from "./routes/auth";
import {
  getTasks,
  createTask,
  bulkCreateTasks,
  updateTask,
  bulkUpdateTasks,
  deleteTask,
  bulkDeleteTasks,
  getBoard,
  uploadTaskAttachments,
  getTaskAttachments,
  deleteTaskAttachment,
} from "./routes/tasks";
import {
  getTeamMembers,
  getTeamRanking,
  getTopTeamRanking,
  inviteTeamMember,
  acceptInvite,
  verifyInviteToken,
  getTeamMemberById,
  updateTeamMemberStatus,
  updateTeamMemberRole,
  deleteTeamMember,
} from "./routes/team";
import { getComments, createComment, deleteComment, toggleReaction } from "./routes/comments";
import { getEpics, createEpic, linkTasksToEpic, backfillEpics } from "./routes/epics";
import {
  assignTasks,
  getAssignments,
  removeAssignment,
} from "./routes/assignments";
import { getActivityLogs } from "./routes/activity";
import { getIdeas, createIdea, updateIdeaStatus, updateIdea, deleteIdea } from "./routes/ideas";
import productDocsRouter from "./routes/product_docs";
import adminRouter from "./routes/admin";
import subscriptionRouter from "./routes/subscription";
import webhookRouter from "./routes/webhook";
import dashboardRouter from "./routes/dashboard";
import rolesRouter from "./routes/roles";
import { requireTeamPermission } from "./middleware/teamAuth";
import transferRouter from "./routes/transfers";
import payrollRouter from "./routes/payroll";
import settingsRouter from "./routes/settings";
import { rtcRouter } from "./lib/calling/routes";
import { livekitWebhookRouter } from "./lib/calling/webhook";
import kycRouter from "./routes/kyc";
import walletRouter from "./routes/wallet";
import adminFeesRouter from "./routes/admin_fees";
import feesRouter from "./routes/fees";
import paymentLinksRouter from "./routes/payment_links";
import aiCreditsRouter from "./routes/ai_credits";
import invoicesRouter from "./routes/invoices";
import storeRouter from "./routes/store";
import recurringRouter from "./routes/recurring";
import providersRouter from "./routes/providers";
import testCommunicationsRouter from "./routes/test-communications";
import taskStatusesRouter from "./routes/task-statuses";
import { getMeetings, createMeeting, updateMeeting, deleteMeeting, getMeetingByCode, getMeetingById, addMeetingParticipants, joinMeeting, leaveMeeting, validateMeetingAccess, guestValidateMeeting, generateMeetingInvite, guestJoinMeeting, getMeetingTranscript, getMeetingNotes, generateMeetingNotesEndpoint, getMeetingReport } from "./routes/meetings";
import { getConversations, getConversationMessages, createConversation, sendMessage, markConversationAsRead, uploadChatMedia, searchChatGifs, editMessage, deleteMessage, getParticipants, leaveConversation, updateParticipantRole, removeParticipant, aiTranslateMessage, aiSmartReplies, aiSummarizeConversation } from "./routes/chat";
import { blockUser, unblockUser, listBlocked } from "./routes/blocks";
import { getAiStatus, postAiChat, getAiHistory, deleteAiHistory, getAiVideoJob, getAiUsage, postAiAttachment, aiAttachmentUpload, requireMetricAiAccess } from "./routes/ai";
import { getCalls, createCall, updateCall, joinCall, leaveCall, getCallByCode, getCallDetail, getCallTranscript, deleteCall, addCallParticipants, generateCallInvite, validateCallAccess, guestJoinCall, guestValidateCall } from "./routes/calls";
import { getRecordings, createRecording, updateRecording, deleteRecording, uploadRecording } from "./routes/recordings";
import { getNotifications, markNotificationAsRead, markAllNotificationsAsRead, takeNotificationAction, registerDevice, unregisterDevice } from "./routes/notifications";
import { subscribePush, unsubscribePush, getVapidPublicKeyEndpoint } from "./routes/push";
import {
  initializeDatabase,
  query,
  resolvedDatabaseName,
  verifySchema,
} from "./db";
import { runPostInitializeMigrations } from "./migrations";
import { isGlmConfigured } from "./lib/glm";
import { isTenorConfigured } from "./lib/config-flags";
import { getMediasoupDiagnostics } from "./lib/mediasoup";
import { getCloudStorage } from "./lib/storage";
import publicRouter from "./routes/public";
import supportRouter from "./routes/support";
import { authenticateToken, checkTeamLimit, checkSubscriptionStatus, checkFeaturePermission } from "./middleware/auth";
import { rateLimiter, secureHeaders, sanitizeMiddleware } from "./middleware/security";
import { processSubscriptionRenewals } from "./services/subscription";
import { processPendingProductDocJobs } from "./services/productDocJobs";
import { startTransferMonitor } from "./services/transfer";
import * as cron from "node-cron";
import { getStore } from "@netlify/blobs";
import { initRedis } from "./lib/cache";
import { transferQueue, productDocQueue, scheduledQueue } from "./lib/queues";
// Import workers for non-serverless environments
if (!process.env.NETLIFY && !process.env.LAMBDA_TASK_ROOT) {
  import("./lib/workers");
}

async function updateOverdueTasks() {
  try {
    console.log("Updating overdue tasks...");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Update tasks that are overdue
    await query(`
      UPDATE tasks
      SET is_overdue = TRUE, updated_at = CURRENT_TIMESTAMP
      WHERE is_overdue = FALSE
        AND status != 'completed'
        AND (
          (due_date IS NOT NULL AND due_date < $1)
          OR (due_date IS NULL AND end_date < $1)
        )
    `, [today.toISOString().split('T')[0]]);
    
    // Update tasks that are no longer overdue (if dates changed)
    await query(`
      UPDATE tasks
      SET is_overdue = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE is_overdue = TRUE
        AND status != 'completed'
        AND (
          (due_date IS NOT NULL AND due_date >= $1)
          OR (due_date IS NULL AND end_date >= $1)
        )
    `, [today.toISOString().split('T')[0]]);
    
    console.log("Overdue tasks updated successfully");
  } catch (error) {
    console.error("Error updating overdue tasks:", error);
  }
}

export async function createServer() {
  const app = express();

  // Sentry is initialized at the top, we'll keep our current setup is already initialized
  // No Handlers in Sentry v10, keep existing setup

  // Initialize Redis
  initRedis();
  logger.info("✅ Redis initialization attempted");

  // Initialize database with retries. initializeDatabase() is fully
  // idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so
  // re-running it after a transient failure (cold-start, quota blip,
  // connection reset) is safe and completes the previously-partial schema.
  // Serverless keeps a single attempt: function timeouts are short.
  const isServerlessEnv = Boolean(process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT);
  const DB_INIT_MAX_ATTEMPTS = isServerlessEnv ? 1 : 5;
  const DB_INIT_RETRY_DELAY_MS = 5_000;
  let isDbReady = false;
  let dbInitError: any = null;

  const dbInitPromise = (async () => {
    for (let attempt = 1; attempt <= DB_INIT_MAX_ATTEMPTS; attempt++) {
      try {
        await initializeDatabase();
        // Post-init migrations + one-off ledger backfills (idempotent)
        await runPostInitializeMigrations();
        // Authoritative schema check — AFTER every table-creating migration
        // has run (checking inside initializeDatabase always reported the
        // revenue/RBAC tables missing because their migrations run later).
        await verifySchema();
        logger.info("✅ Database initialized successfully");
        isDbReady = true;
        return;
      } catch (error: any) {
        dbInitError = error;
        if (attempt < DB_INIT_MAX_ATTEMPTS) {
          const delay = DB_INIT_RETRY_DELAY_MS * attempt;
          logger.error(`Database init attempt ${attempt}/${DB_INIT_MAX_ATTEMPTS} failed [${error?.code || "UNKNOWN"}]: ${error?.message}. Retrying in ${delay / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    logger.error(`❌ Database initialization failed after ${DB_INIT_MAX_ATTEMPTS} attempt(s): ${dbInitError?.message || dbInitError}`);
    if (dbInitError?.code === "3D000") {
      logger.error(`   → PostgreSQL rejected the database name "${resolvedDatabaseName || "?"}".`);
      logger.error("     Almost always a typo in the DATABASE_URL line of .env (e.g. a stray '>' from a manual edit).");
      logger.error("     Check it with:  grep -n '^DATABASE_URL' .env");
      logger.error("     The name between the last '/' and '?' must EXACTLY match the database created at your provider (Neon console → project → Dashboard → database name).");
      logger.error("     After fixing:   pm2 restart metroflow --update-env");
    }
  })();

  // Post-init tasks that need the database. On a persistent server (PM2/VPS)
  // the HTTP listener must NOT wait for this: the deploy health check probes
  // /api/ping within 60s of the pm2 restart, and a cold Neon connection plus
  // first-run migrations must never delay the bind (this previously made every
  // deploy report "server did not answer .../api/ping within 60s" and put pm2
  // into a restart loop). Serverless still awaits — frozen background tasks
  // would never finish there.
  const dbReadyPromise = (async () => {
    await dbInitPromise;
    if (isDbReady) {
      try {
        await updateOverdueTasks();
      } catch (error) {
        logger.error("Post-init updateOverdueTasks failed:", error);
      }
    } else {
      // Stay up: /api/ping keeps answering (deploys stay green), the DB check
      // middleware returns 503 for data routes, and the next restart re-runs
      // the fully idempotent initialization.
      logger.error("Server is up, but the database is unavailable — data routes return 503 until initialization succeeds.");
    }
  })();

  if (isServerlessEnv) {
    console.log("Serverless environment detected, awaiting database initialization...");
    await dbReadyPromise;
    if (!isDbReady) {
      throw dbInitError ?? new Error("Database initialization failed");
    }
  }

  // Middleware
  cron.schedule("0 * * * *", async () => {
    if (!isDbReady) return; // DB still initializing — skip this tick
    try {
      logger.info("Running activity log cleanup...");
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      const result = await query(
        "DELETE FROM activity_logs WHERE created_at < $1",
        [threeDaysAgo],
      );

      logger.info(`Cleaned up ${result.rowCount} old activity logs`);

      // Check for expired trials
      logger.info("Checking for expired trials...");
      const expiredResult = await query(`
        UPDATE businesses 
        SET subscription_status = 'inactive' 
        WHERE trial_ends_at < NOW() 
          AND subscription_status = 'active'
          AND plan_id IN (SELECT id FROM pricing_plans WHERE price = 0 OR trial_days > 0)
        RETURNING id, email
      `);
      
      logger.info(`Deactivated ${expiredResult.rowCount} expired trials`);
      
      // Send expiration warning emails (for trials expiring tomorrow)
      const warningResult = await query(`
        SELECT id, name, email 
        FROM businesses 
        WHERE trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '1 day'
          AND subscription_status = 'active'
      `);
      
      // Mock sending emails
      warningResult.rows.forEach(b => {
        logger.info(`Sending trial expiration warning to ${b.email}`);
        // await sendEmail(...)
      });

      // Process subscription renewals
      await processSubscriptionRenewals();
      
      // Update overdue tasks
      await updateOverdueTasks();
    } catch (error) {
      logger.error("Cron job error:", error);
    }
  });
  
  // Start transfer reconciliation poller (non-serverless only).
  // Webhook-first design: Flutterwave `transfer.completed` webhooks drive
  // status changes; the poller is a cheap safety net (probe-first query,
  // bounded batch, self-scheduling loop, exponential backoff on DB errors).
  // Started only after the DB is ready so its first probe never fails.
  if (!isServerlessEnv) {
    void dbReadyPromise.then(() => {
      if (isDbReady) startTransferMonitor();
    });
  }

  // Meeting reminders (push + email at 60/15 minutes before start).
  // VPS/PM2 only — serverless cannot run per-minute crons. Each tick atomically
  // claims due meeting_reminders rows (sent=FALSE) so ticks never double-send.
  if (!isServerlessEnv) {
    cron.schedule("* * * * *", async () => {
      if (!isDbReady) return; // DB still initializing — skip this tick
      try {
        const { processDueMeetingReminders } = await import("./services/meetingReminders");
        const result = await processDueMeetingReminders();
        if (result.processed > 0) {
          logger.info(`[meetingReminders] delivered ${result.processed} reminder(s)`);
        }
      } catch (error) {
        logger.error("Meeting reminders cron error:", error);
      }
    });

    // Recurring Billing charge engine — runs every 5 minutes, charges each
    // due customer subscription (wallet path debits the subscriber's wallet
    // instantly; checkout path queues a hosted-checkout charge and emails the
    // pay link). Idempotent via the next_charge_date claim inside
    // processDueSubscriptionCharges.
    cron.schedule("*/5 * * * *", async () => {
      if (!isDbReady) return; // DB still initializing — skip this tick
      try {
        const { processDueSubscriptionCharges } = await import("./routes/recurring");
        const result = await processDueSubscriptionCharges();
        if (result.processed > 0) {
          logger.info(`[Recurring] charges processed ${result.processed}: ${result.succeeded} ok, ${result.failed} failed`);
        }
      } catch (error) {
        logger.error("Recurring billing cron error:", error);
      }
    });
  }

  // Serverless fallback: in serverless environments there is no persistent
  // process, so a per-minute cron stands in for the poller. On a persistent
  // server (PM2/VPS) this MUST NOT run - the poller above already covers it,
  // and a second scheduler would double the database load.
  if (process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT) {
    cron.schedule("* * * * *", async () => {
      try {
        const { checkProcessingTransfers } = await import("./services/transfer");
        await checkProcessingTransfers();
      } catch (error) {
        console.error("[Cron] Error checking processing transfers:", error);
      }
    });
  }

  // Logging Middleware
  app.use((req, res, next) => {
    const start = Date.now();
    const { method, url } = req;
    
    res.on("finish", () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const log = `${method} ${url} ${status} - ${duration}ms`;
      
      if (status >= 400) {
        console.error(log);
      } else {
        console.log(log);
      }
    });
    
    next();
  });

  app.use(cors(corsOptions));

  // Security middleware
  app.use(secureHeaders);
  app.use(rateLimiter);

  app.use(express.json({
    // Capture the raw body for signature-validated webhooks (LiveKit egress events).
    verify: (req: any, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(express.urlencoded({ extended: true }));

  // Swagger Documentation
  const CSS_URL = "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.0.0/swagger-ui.min.css";
  const JS_URL = "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.0.0/swagger-ui-bundle.min.js";
  const JS_PRESET_URL = "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.0.0/swagger-ui-standalone-preset.min.js";

  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs, {
    customCssUrl: CSS_URL,
    customJs: [JS_URL, JS_PRESET_URL]
  }));


  // Serve static files
  // app.use(express.static(path.join(__dirname, "../public")));
  app.use(express.static(path.join(process.cwd(), "public")));
  
  // Serve uploaded files
  const isLambda = !!process.env.LAMBDA_TASK_ROOT || !!process.env.NETLIFY;
  const uploadDir = isLambda ? path.join("/tmp", "uploads") : path.join(process.cwd(), "uploads");
  app.use("/uploads", express.static(uploadDir));
  app.get("/uploads/:filename", async (req, res) => {
    try {
      const { filename } = req.params as any;
      if (!isLambda) {
        const localPath = path.join(uploadDir, filename);
        return res.sendFile(localPath);
      }
      const store = getStore("uploads");
      const blob: any = await store.get(filename, { type: "blob" } as any);
      if (!blob) {
        return res.status(404).send("Not found");
      }
      const ab = typeof blob.arrayBuffer === "function" ? await blob.arrayBuffer() : blob;
      const buffer = Buffer.from(ab as ArrayBuffer);
      const ext = path.extname(filename).toLowerCase();
      const contentType =
        ext === ".png" ? "image/png" :
        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
        ext === ".gif" ? "image/gif" :
        "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=31536000");
      return res.send(buffer);
    } catch (e) {
      console.error("Uploads route error:", e);
      return res.status(500).send("Error");
    }
  });

  let lastDocJobRun = 0;
  // Serverless-only: crons cannot run in serverless, so HTTP traffic drives
  // product doc job processing there (throttled to one tick per 15s).
  // On persistent servers the dedicated cron below handles it instead.
  if (process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT) {
    app.use((req, res, next) => {
      const now = Date.now();
      if (now - lastDocJobRun > 15000) {
        lastDocJobRun = now;
        processPendingProductDocJobs(1).catch((e) => console.error("Doc job tick error:", e));
      }
      next();
    });
  }

  // Fix for potential body parsing issues in serverless environment
  app.use((req, res, next) => {
    // Handle Buffer body (common in some serverless environments)
    if (Buffer.isBuffer(req.body)) {
      try {
        const bodyString = req.body.toString('utf8');
        req.body = JSON.parse(bodyString);
        console.log("Parsed body from Buffer");
      } catch (e) {
        console.error("Failed to parse Buffer body:", e);
      }
    }

    // Attempt to recover body from Netlify event if express.json() failed or wasn't triggered
    if ((!req.body || Object.keys(req.body).length === 0) && (req as any).netlifyEvent) {
      const event = (req as any).netlifyEvent;
      if (event.body) {
        try {
          const bodyString = event.isBase64Encoded
            ? Buffer.from(event.body, 'base64').toString('utf8')
            : event.body;
          req.body = JSON.parse(bodyString);
          console.log("Manually parsed body from Netlify event");
        } catch (e) {
          console.error("Failed to parse Netlify event body:", e);
        }
      }
    }

    if (req.body && typeof req.body === "string") {
      try {
        req.body = JSON.parse(req.body);
      } catch (e) {
        console.error("Failed to parse string body:", e);
      }
    }
    
    next();
  });

  // Single local cron for product documentation jobs (non-serverless only).
  if (!isServerlessEnv) {
    cron.schedule("* * * * *", async () => {
      if (!isDbReady) return; // DB still initializing — skip this tick
      try {
        await processPendingProductDocJobs(5);
      } catch (error) {
        console.error("Product doc cron error:", error);
      }
    });
  }

  // Check DB status for API routes (both / and /api paths)
  const dbCheckMiddleware = (req, res, next) => {
    if (req.path === '/' || req.path === '/ping' || req.path === '/demo') return next();
    
    if (!isDbReady) {
      // Allow pre-flight requests to pass through
      if (req.method === 'OPTIONS') return next();

      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Server is still initializing database connection. Please try again in a few seconds.",
        details: dbInitError ? (dbInitError instanceof Error ? dbInitError.message : String(dbInitError)) : undefined
      });
    }
    next();
  };

  app.post("/internal/jobs/product-docs/process", async (req, res) => {
    try {
      const secretHeader = req.headers["x-job-secret"];
      const expected = process.env.JOBS_SECRET;
      if (expected && secretHeader !== expected) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
      const limit = Number((req.body as any)?.limit) || 3;
      const result = await processPendingProductDocJobs(limit);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Internal job processing error:", error);
      res.status(500).json({ success: false, error: "Failed to process jobs" });
    }
  });

  // Create a main router for all API endpoints (will be mounted at both / and /api)
  const mainRouter = express.Router();

  // Example API routes
  mainRouter.get("/", (_req, res) => {
    res.json({ 
      message: "Metricorex Backend API is running", 
      docs: "/api-docs",
      status: "active" 
    });
  });

  mainRouter.get("/ping", (_req, res) => {
    const ping = process.env.PING_MESSAGE ?? "ping";
    res.json({ message: ping });
  });

  // Deployment/ops health probe (public, read-only, no secrets).
  // deploy.sh uses this to verify a fresh build is actually serving and to
  // surface which optional integrations (MetricAi, GIFs, storage) are live.
  mainRouter.get("/health", async (_req, res) => {
    const started = Date.now();
    let db: "up" | "down" = "down";
    try {
      await query("SELECT 1");
      db = "up";
    } catch {
      db = "down";
    }
    const storage = process.env.CLOUDINARY_URL || process.env.CLOUDINARY_CLOUD_NAME
      ? "cloudinary"
      : process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID
        ? "r2"
        : getCloudStorage()
          ? "configured"
          : "local-disk";
    const { getActiveProviderName, listProviderNames, getProviderByName } = await import("./lib/calling/factory");
    const activeCallingProvider = await getActiveProviderName().catch(() => "livekit");
    const callingProviders: Record<string, unknown> = {};
    for (const name of listProviderNames()) {
      const p = getProviderByName(name);
      callingProviders[name] = { configured: p.isConfigured(), active: name === activeCallingProvider };
    }
    res.json({
      success: true,
      data: {
        status: db === "up" ? "ok" : "degraded",
        db,
        metricAi: { configured: isGlmConfigured() },
        gifs: { configured: isTenorConfigured() },
        rtc: getMediasoupDiagnostics(),
        calling: { activeProvider: activeCallingProvider, providers: callingProviders },
        redis: { configured: !!process.env.REDIS_URL && !process.env.DISABLE_REDIS },
        storage,
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        env: process.env.NODE_ENV || "development",
        checkedInMs: Date.now() - started,
      },
    });
  });

  // Test route for Sentry verification
  mainRouter.get("/test-sentry", (_req, res) => {
    try {
      // Intentional error to test Sentry
      // @ts-ignore
      foo();
    } catch (e) {
      if (sentryInitialized) {
        Sentry.captureException(e);
        console.log("📨 Error captured and sent to Sentry");
      }
      res.status(500).json({ 
        message: "Test error generated", 
        sentry: sentryInitialized ? "Error sent to Sentry" : "Sentry not initialized" 
      });
    }
  });

  mainRouter.get("/demo", handleDemo);

  // Auth API routes
  mainRouter.post("/auth/register", registerBusiness);
  mainRouter.post("/auth/verify-otp", verifyOTP);
  mainRouter.post("/auth/login", login);
  mainRouter.post("/auth/resend-otp", resendOTP);
  mainRouter.post("/auth/forgot-password", forgotPassword);
  mainRouter.post("/auth/verify-reset-otp", verifyResetOTP);
  mainRouter.post("/auth/reset-password", resetPassword);
  mainRouter.post("/auth/google", googleAuth);
  mainRouter.post("/auth/set-password", authenticateToken, setPassword);
  mainRouter.post("/auth/change-password", authenticateToken, changePassword);
  mainRouter.get("/auth/me", authenticateToken, getMe);

  // Biometric unlock endpoints
  mainRouter.post("/auth/biometric/enroll", authenticateToken, biometricEnroll);
  mainRouter.post("/auth/biometric/login", biometricLogin);
  mainRouter.post("/auth/biometric/status", biometricStatus);
  mainRouter.delete("/auth/biometric/enroll", authenticateToken, biometricRevoke);

  // Tasks API routes
  mainRouter.get("/board", authenticateToken, checkSubscriptionStatus, getBoard);
  mainRouter.get("/tasks", authenticateToken, checkSubscriptionStatus, getTasks);
  mainRouter.post("/tasks", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), requireTeamPermission('manage_tasks'), createTask);
  mainRouter.post("/tasks/bulk", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), requireTeamPermission('manage_tasks'), bulkCreateTasks);
  mainRouter.put("/tasks/bulk-update", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), requireTeamPermission('manage_tasks'), bulkUpdateTasks);
  mainRouter.put("/tasks/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), requireTeamPermission('manage_tasks'), updateTask);
  mainRouter.delete("/tasks/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), requireTeamPermission('manage_tasks'), deleteTask);
  mainRouter.delete("/tasks", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), requireTeamPermission('manage_tasks'), bulkDeleteTasks);

  // Task file attachments (WhatsApp-style uploads)
  mainRouter.post("/tasks/:id/attachments", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), requireTeamPermission('manage_tasks'), uploadTaskAttachments);
  mainRouter.get("/tasks/:id/attachments", authenticateToken, checkSubscriptionStatus, getTaskAttachments);
  mainRouter.delete("/tasks/attachments/:attachmentId", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), requireTeamPermission('manage_tasks'), deleteTaskAttachment);

  // Team API routes
  mainRouter.get("/team/ranking", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('view_ranking'), requireTeamPermission('view_ranking'), getTeamRanking);
  mainRouter.get("/team/ranking/top", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('view_ranking'), requireTeamPermission('view_ranking'), getTopTeamRanking);
  mainRouter.get("/team", authenticateToken, checkSubscriptionStatus, getTeamMembers);
  mainRouter.get("/team/:id", authenticateToken, checkSubscriptionStatus, getTeamMemberById);
  mainRouter.post("/team/invite", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_team'), requireTeamPermission('manage_team'), checkTeamLimit, inviteTeamMember);
  mainRouter.get("/team/verify-invite-token/:token", verifyInviteToken);
  mainRouter.post("/team/accept-invite/:token", acceptInvite);
  mainRouter.patch(
    "/team/:id/status",
    authenticateToken,
    checkSubscriptionStatus,
    checkFeaturePermission('manage_team'), requireTeamPermission('manage_team'),
    updateTeamMemberStatus,
  );
  mainRouter.put(
    "/team/:id/status",
    authenticateToken,
    checkSubscriptionStatus,
    checkFeaturePermission('manage_team'), requireTeamPermission('manage_team'),
    updateTeamMemberStatus,
  );
  mainRouter.patch("/team/:id/role", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_team'), requireTeamPermission('manage_team'), updateTeamMemberRole);
  mainRouter.put("/team/:id/role", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_team'), requireTeamPermission('manage_team'), updateTeamMemberRole);
  mainRouter.delete("/team/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_team'), requireTeamPermission('manage_team'), deleteTeamMember);

  // Comments API routes
  mainRouter.get("/comments/epic/:epicName", authenticateToken, checkSubscriptionStatus, getComments);
  mainRouter.get("/comments/:taskId", authenticateToken, checkSubscriptionStatus, getComments);
  mainRouter.post("/comments", authenticateToken, checkSubscriptionStatus, createComment);
  mainRouter.delete("/comments/:commentId", authenticateToken, checkSubscriptionStatus, deleteComment);
  mainRouter.post("/comments/:commentId/reaction", authenticateToken, checkSubscriptionStatus, toggleReaction);

  // Epics API routes
  mainRouter.get("/epics", authenticateToken, checkSubscriptionStatus, getEpics);
  mainRouter.post("/epics", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_epics'), requireTeamPermission('manage_epics'), createEpic);
  mainRouter.post("/epics/backfill", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_epics'), requireTeamPermission('manage_epics'), backfillEpics);
  mainRouter.post("/epics/:epicId/tasks", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_epics'), requireTeamPermission('manage_epics'), linkTasksToEpic);

  // Task assignments API routes
  mainRouter.post("/assignments", authenticateToken, checkSubscriptionStatus, assignTasks);
  mainRouter.get("/assignments/:taskId", authenticateToken, checkSubscriptionStatus, getAssignments);
  mainRouter.delete("/assignments/:assignmentId", authenticateToken, checkSubscriptionStatus, removeAssignment);

  // Activity logs API routes
  mainRouter.get("/activity-logs", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('view_activity'), requireTeamPermission('view_activity'), getActivityLogs);

  // Ideas API routes
  mainRouter.get("/ideas", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), requireTeamPermission('manage_ideas'), getIdeas);
  mainRouter.post("/ideas", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), requireTeamPermission('manage_ideas'), createIdea);
  mainRouter.put("/ideas/:id/status", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), requireTeamPermission('manage_ideas'), updateIdeaStatus);
  mainRouter.put("/ideas/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), requireTeamPermission('manage_ideas'), updateIdea);
  mainRouter.delete("/ideas/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), requireTeamPermission('manage_ideas'), deleteIdea);

  // Product Documentation API routes
  mainRouter.use("/product-docs", productDocsRouter);
  mainRouter.use("/", productDocsRouter); // Backward-compatible mount

  // Fee Management Routes
  mainRouter.use("/fees", feesRouter);
  mainRouter.use("/admin/fees", adminFeesRouter);

  // Revenue features: Payment Links ("Get Paid") + MetricAi Credit Packs + Smart Invoices
  mainRouter.use("/payment-links", paymentLinksRouter);
  mainRouter.use("/ai-credits", aiCreditsRouter);
  mainRouter.use("/invoices", invoicesRouter);
  // Business revenue features: Storefront + Recurring Billing (Customer Subscriptions).
  // (Bills Hub & Savings Vaults live in server/features/personal — dormant until
  // the Personal app ships; see server/features/personal/README.md.)
  mainRouter.use("/store", storeRouter);
  mainRouter.use("/recurring", recurringRouter);

  // Admin API routes
  mainRouter.use("/admin", adminRouter);

  // Dashboard API routes
  mainRouter.use("/dashboard", dashboardRouter);
  // Business-team Role & Permission management (mirror of the admin RBAC)
  mainRouter.use("/roles", rolesRouter);

  // Subscription API routes
  mainRouter.use("/subscription", subscriptionRouter);

  // Webhook API routes
  // LiveKit provider webhooks FIRST (exact path, signature-validated, no auth);
  // then the generic application webhooks.
  mainRouter.use("/webhook/livekit", livekitWebhookRouter);
  mainRouter.use("/webhook", webhookRouter);

  // Transfer API routes
  mainRouter.use("/transfers", transferRouter);

  // Payroll API routes
  mainRouter.use("/payroll", payrollRouter);

  // RTC session routes (media token refresh + host moderation) — provider-agnostic
  mainRouter.use("/rtc", authenticateToken, checkSubscriptionStatus, rtcRouter);

  // Settings API routes
  mainRouter.use("/settings", settingsRouter);

  // KYC API routes
    mainRouter.use("/kyc", kycRouter);

    // Wallet API routes
    mainRouter.use("/wallet", walletRouter);

    // Task Statuses API routes
    mainRouter.use("/task-statuses", taskStatusesRouter);

  // Providers API routes
  mainRouter.use("/providers", providersRouter);

  // Test Communications API routes
  mainRouter.use("/test-communications", testCommunicationsRouter);

  // Meetings API routes
  mainRouter.get("/meetings", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), getMeetings);
  mainRouter.get("/meetings/code/:code", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), getMeetingByCode);
  mainRouter.get("/meetings/validate/:code", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), validateMeetingAccess);
  // Get meeting by UUID or code (must be registered after the more specific GET routes above)
  mainRouter.get("/meetings/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), getMeetingById);
  mainRouter.post("/meetings", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), createMeeting);
  mainRouter.put("/meetings/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), updateMeeting);
  mainRouter.delete("/meetings/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), deleteMeeting);
  mainRouter.post("/meetings/:id/join", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), joinMeeting);
  mainRouter.post("/meetings/:id/leave", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), leaveMeeting);
  mainRouter.post("/meetings/:meetingId/participants", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), addMeetingParticipants);
  mainRouter.post("/meetings/generate-invite", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), generateMeetingInvite);
  // Transcript + AI meeting notes (provider-agnostic — fed by caption segments)
  mainRouter.get("/meetings/:id/transcript", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), getMeetingTranscript);
  mainRouter.get("/meetings/:id/notes", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), getMeetingNotes);
  mainRouter.post("/meetings/:id/notes/generate", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), generateMeetingNotesEndpoint);
  // Post-meeting report (attendees, AI notes, transcript, recordings)
  mainRouter.get("/meetings/:id/report", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_meetings"), requireTeamPermission("use_meetings"), getMeetingReport);
  // Public guest access (must be before any conflicting authenticated routes)
  mainRouter.get("/meetings/guest/validate/:code", guestValidateMeeting);
  // Guest join (public, no auth): guests join via meeting link + name (+password if set)
  mainRouter.post("/meetings/guest/:code/join", guestJoinMeeting);

  // Chat API routes
  mainRouter.get("/chat/conversations", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), getConversations);
  mainRouter.post("/chat/conversations", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), createConversation);
  mainRouter.get("/chat/conversations/:conversationId/messages", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), getConversationMessages);
  mainRouter.post("/chat/conversations/:conversationId/messages", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), sendMessage);
  mainRouter.put("/chat/conversations/:conversationId/read", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), markConversationAsRead);
  mainRouter.post("/chat/conversations/:conversationId/read", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), markConversationAsRead);
  // Voice-note / media upload for chat (WhatsApp-style audio messages)
  mainRouter.post("/chat/media", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), uploadChatMedia);
  // GIF picker (Tenor proxy — key stays server-side)
  mainRouter.get("/chat/gifs", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), searchChatGifs);

  // MetricAi chat intelligence: translate a message / smart reply chips /
  // whole-conversation summary (all GLM-backed, graceful 503 when unset)
  mainRouter.post("/chat/ai/translate", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), aiTranslateMessage);
  mainRouter.post("/chat/ai/smart-replies", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), aiSmartReplies);
  mainRouter.post("/chat/conversations/:conversationId/ai/summarize", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), aiSummarizeConversation);

  // Chat message edit / delete (WhatsApp-style)
  mainRouter.patch("/chat/conversations/:conversationId/messages/:messageId", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), editMessage);
  mainRouter.delete("/chat/conversations/:conversationId/messages/:messageId", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), deleteMessage);

  // Chat participants: roster / leave / roles / remove (WhatsApp-style)
  mainRouter.get("/chat/conversations/:conversationId/participants", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), getParticipants);
  mainRouter.post("/chat/conversations/:conversationId/leave", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), leaveConversation);
  mainRouter.patch("/chat/conversations/:conversationId/participants/:userId", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), updateParticipantRole);
  mainRouter.delete("/chat/conversations/:conversationId/participants/:userId", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("use_chat"), requireTeamPermission("use_chat"), removeParticipant);

  // Contact blocking (direct chats; enforced in sendMessage/createConversation)
  mainRouter.get("/users/blocked", authenticateToken, checkSubscriptionStatus, listBlocked);
  mainRouter.post("/users/:userId/block", authenticateToken, checkSubscriptionStatus, blockUser);
  mainRouter.delete("/users/:userId/block", authenticateToken, checkSubscriptionStatus, unblockUser);

  // MetricAi — GLM-powered in-app assistant (plan-gated)
  mainRouter.get("/ai/status", authenticateToken, checkSubscriptionStatus, requireMetricAiAccess, getAiStatus);
  mainRouter.post("/ai/chat", authenticateToken, checkSubscriptionStatus, requireMetricAiAccess, postAiChat);
  mainRouter.get("/ai/history", authenticateToken, checkSubscriptionStatus, requireMetricAiAccess, getAiHistory);
  mainRouter.delete("/ai/history", authenticateToken, checkSubscriptionStatus, requireMetricAiAccess, deleteAiHistory);
  mainRouter.get("/ai/video/:jobId", authenticateToken, checkSubscriptionStatus, requireMetricAiAccess, getAiVideoJob);
  mainRouter.get("/ai/usage", authenticateToken, checkSubscriptionStatus, requireMetricAiAccess, getAiUsage);
  mainRouter.post("/ai/attachments", authenticateToken, checkSubscriptionStatus, requireMetricAiAccess, (req, res, next) => {
    aiAttachmentUpload(req, res, (err: any) => {
      if (err) {
        const isLimit = err?.code === "LIMIT_FILE_SIZE";
        return res.status(isLimit ? 413 : 400).json({
          success: false,
          error: isLimit
            ? "Attachment exceeds the 100 MB upload limit."
            : err?.message || "Attachment upload failed.",
        });
      }
      next();
    });
  }, postAiAttachment);

  // Calls API routes
  mainRouter.get("/calls", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), getCalls);
  mainRouter.get("/calls/code/:code", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), getCallByCode);
  mainRouter.get("/calls/validate/:code", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), validateCallAccess);
  // Rich call detail (GET /calls/:id returns a superset of the legacy payload:
  // legacy top-level call fields + { call, participants, hasTranscript,
  // transcriptsCount, recording, conversationId }). Transcript endpoint kept
  // separate so /calls/:id keeps matching codes and UUIDs alike.
  mainRouter.get("/calls/:id/transcript", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), getCallTranscript);
  // Get call by UUID or code (must be registered after the more specific GET routes above)
  mainRouter.get("/calls/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), getCallDetail);
  mainRouter.post("/calls", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), createCall);
  mainRouter.put("/calls/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), updateCall);
  mainRouter.post("/calls/:id/join", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), joinCall);
  mainRouter.post("/calls/:id/leave", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), leaveCall);
  mainRouter.delete("/calls/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), deleteCall);
  mainRouter.post("/calls/:callId/participants", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), addCallParticipants);
  mainRouter.post("/calls/generate-invite", authenticateToken, checkSubscriptionStatus, checkFeaturePermission(["use_calls", "use_chat"]), requireTeamPermission("use_calls"), generateCallInvite);
  // Guest access (public, no auth): guests join via call link + name (+password if set)
  mainRouter.get("/calls/guest/validate/:code", guestValidateCall);
  mainRouter.post("/calls/guest/:code/join", guestJoinCall);

  // Recordings API routes
  mainRouter.get("/recordings", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("rtc.recording"), getRecordings);
  mainRouter.post("/recordings", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("rtc.recording"), createRecording);
  mainRouter.put("/recordings/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("rtc.recording"), updateRecording);
  // PATCH alias: the web client patches recording status on failure
  mainRouter.patch("/recordings/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("rtc.recording"), updateRecording);
  mainRouter.post("/recordings/:id/upload", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("rtc.recording"), ...uploadRecording);
  mainRouter.delete("/recordings/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission("rtc.recording"), deleteRecording);

  // Public app configuration (maintenance mode, announcements) - no auth
  mainRouter.use("/public", publicRouter);

  // Customer Support desk (MetricAi handoff, guest widget chat, agent inbox)
  mainRouter.use("/support", supportRouter);

  // Notifications API routes
  mainRouter.get("/notifications", authenticateToken, checkSubscriptionStatus, getNotifications);
  mainRouter.patch("/notifications/:id/read", authenticateToken, checkSubscriptionStatus, markNotificationAsRead);
  mainRouter.patch("/notifications/read-all", authenticateToken, checkSubscriptionStatus, markAllNotificationsAsRead);
  mainRouter.post("/notifications/:id/action", authenticateToken, checkSubscriptionStatus, takeNotificationAction);

  // Push notification device registration (FCM)
  mainRouter.post("/notifications/register-device", authenticateToken, registerDevice);
  mainRouter.delete("/notifications/register-device", authenticateToken, unregisterDevice);

  // Web Push (VAPID) — browser push subscriptions
  mainRouter.get("/push/vapid-public-key", getVapidPublicKeyEndpoint);
  mainRouter.post("/push/subscribe", authenticateToken, subscribePush);
  mainRouter.post("/push/unsubscribe", authenticateToken, unsubscribePush);

  // Mount the main router at both / and /api for backward compatibility
  app.use(dbCheckMiddleware);
  app.use("/", mainRouter);
  app.use("/api", mainRouter);

  // Redirect /wallet/verify to /api/wallet/verify (for backward compatibility with old callback URLs)
  app.get("/wallet/verify", (req, res) => {
    const queryString = req.url.split('?')[1] || '';
    res.redirect(`/api/wallet/verify?${queryString}`);
  });

  // Redirect backend /accept-invite/:token to frontend
  app.get("/accept-invite/:token", (req, res) => {
    const frontendUrl = process.env.CLIENT_URL || process.env.APP_BASE_URL || process.env.APP_URL;
    if (!frontendUrl) {
      res.status(500).json({ error: "CLIENT_URL environment variable is not set" });
      return;
    }
    res.redirect(`${frontendUrl}/accept-invite/${req.params.token}`);
  });



  // Global Error Handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error("❌ Unhandled Error:", err);
    if (sentryInitialized) {
      Sentry.captureException(err);
    }
    if (res.headersSent) {
      return next(err);
    }
    res.status(500).json({ 
      error: "Internal Server Error", 
      message: err.message,
      path: req.path
    });
  });

  return app;
}

const PORT = process.env.PORT || 8080;

// Only start server in development if executed directly (not imported)
// This check (import.meta.url === pathToFileURL(process.argv[1]).href) is ESM specific
// For simplicity in this hybrid setup, we'll disable auto-start since Vite handles it.
// If standalone dev server is needed, a separate entry file should be used.
/*
if (process.env.NODE_ENV !== "production") {
  createServer()
    .then((app) => {
      app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
      });
    })
    .catch((error) => {
      console.error("Failed to create server:", error);
    });
}
*/
