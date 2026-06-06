import "dotenv/config";
import express from "express";
import path from "path";
// import { fileURLToPath } from 'url';
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { specs } from "./swagger";
import { isOverdue } from "./utils/date";

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
} from "./routes/auth";
import {
  getTasks,
  createTask,
  bulkCreateTasks,
  updateTask,
  bulkUpdateTasks,
  deleteTask,
  bulkDeleteTasks,
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
import transferRouter from "./routes/transfers";
import payrollRouter from "./routes/payroll";
import settingsRouter from "./routes/settings";
import kycRouter from "./routes/kyc";
import walletRouter from "./routes/wallet";
import adminFeesRouter from "./routes/admin_fees";
import feesRouter from "./routes/fees";
import { initializeDatabase, query } from "./db";
import { authenticateToken, checkTeamLimit, checkSubscriptionStatus, checkFeaturePermission } from "./middleware/auth";
import { processSubscriptionRenewals } from "./services/subscription";
import { processPendingProductDocJobs } from "./services/productDocJobs";
import * as cron from "node-cron";
import { getStore } from "@netlify/blobs";

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

  // Initialize database
  let isDbReady = false;
  let dbInitError: any = null;

  const dbInitPromise = initializeDatabase()
    .then(() => {
      console.log("✅ Database initialized successfully");
      isDbReady = true;
    })
    .catch((error) => {
      console.error("❌ Failed to initialize database:", error);
      dbInitError = error;
    });

  // In serverless environments, we must wait for the database to initialize
  // because background tasks may be frozen immediately after the response is sent.
  if (process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT) {
    console.log("Serverless environment detected, awaiting database initialization...");
    try {
      await dbInitPromise;
    } catch (e) {
      // Error is already captured in dbInitError
    }
  }

  // Middleware
  cron.schedule("0 * * * *", async () => {
    try {
      console.log("Running activity log cleanup...");
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      const result = await query(
        "DELETE FROM activity_logs WHERE created_at < $1",
        [threeDaysAgo],
      );

      console.log(`Cleaned up ${result.rowCount} old activity logs`);

      // Check for expired trials
      console.log("Checking for expired trials...");
      const expiredResult = await query(`
        UPDATE businesses 
        SET subscription_status = 'inactive' 
        WHERE trial_ends_at < NOW() 
          AND subscription_status = 'active'
          AND plan_id IN (SELECT id FROM pricing_plans WHERE price = 0 OR trial_days > 0)
        RETURNING id, email
      `);
      
      console.log(`Deactivated ${expiredResult.rowCount} expired trials`);
      
      // Send expiration warning emails (for trials expiring tomorrow)
      const warningResult = await query(`
        SELECT id, name, email 
        FROM businesses 
        WHERE trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '1 day'
          AND subscription_status = 'active'
      `);
      
      // Mock sending emails
      warningResult.rows.forEach(b => {
        console.log(`Sending trial expiration warning to ${b.email}`);
        // await sendEmail(...)
      });

      // Process subscription renewals
      await processSubscriptionRenewals();
      
      // Update overdue tasks
      await updateOverdueTasks();
    } catch (error) {
      console.error("Cron job error:", error);
    }
  });
  
  // Update overdue tasks on server startup
  await dbInitPromise;
  await updateOverdueTasks();

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

  // Middleware
  const corsOptions = {
    origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      console.log("CORS Origin Check:", origin);
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin || origin === 'null') return callback(null, true);
      
      // Allow your specific frontend origin
      const allowedOrigins = [
        'https://metroflow-app.netlify.app',
        'http://localhost:3000',
        'http://localhost:5173'
      ];
      
      if (allowedOrigins.includes(origin) || origin.includes('localhost')) {
        return callback(null, true);
      }
      
      // Allow all origins for development/flexibility
      return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-business-id'],
    preflightContinue: false,
    optionsSuccessStatus: 204
  };

  app.use(cors(corsOptions));

  app.use(express.json());
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
  app.use((req, res, next) => {
    const now = Date.now();
    if (now - lastDocJobRun > 15000) {
      lastDocJobRun = now;
      processPendingProductDocJobs(1).catch((e) => console.error("Doc job tick error:", e));
    }
    next();
  });

  // Local-only cron to process product documentation jobs frequently
  if (!process.env.NETLIFY && !process.env.LAMBDA_TASK_ROOT) {
    cron.schedule("* * * * *", async () => {
      try {
        const result = await processPendingProductDocJobs(5);
        console.log("Product doc jobs processed by local cron:", result);
      } catch (error) {
        console.error("Product doc job cron error:", error);
      }
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

  if (!isLambda) {
    cron.schedule("* * * * *", async () => {
      try {
        await processPendingProductDocJobs(3);
      } catch (error) {
        console.error("Product doc cron error:", error);
      }
    });
  }

  // Check DB status for API routes
  app.use('/api', (req, res, next) => {
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
  });

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

  // Example API routes
  app.get("/", (_req, res) => {
    res.json({ 
      message: "MetroFlow Backend API is running", 
      docs: "/api-docs",
      status: "active" 
    });
  });

  app.get("/api", (_req, res) => {
    res.json({
      message: "MetroFlow Backend API is running",
      status: isDbReady ? "online" : "initializing",
      version: "1.0.0",
      docs: "/api-docs"
    });
  });

  app.get("/api/ping", (_req, res) => {
    const ping = process.env.PING_MESSAGE ?? "ping";
    res.json({ message: ping });
  });

  app.get("/api/demo", handleDemo);

  // Auth API routes
  app.post("/api/auth/register", registerBusiness);
  app.post("/api/auth/verify-otp", verifyOTP);
  app.post("/api/auth/login", login);
  app.post("/api/auth/resend-otp", resendOTP);
  app.post("/api/auth/forgot-password", forgotPassword);
  app.post("/api/auth/verify-reset-otp", verifyResetOTP);
  app.post("/api/auth/reset-password", resetPassword);

  // Tasks API routes
  app.get("/api/tasks", authenticateToken, checkSubscriptionStatus, getTasks);
  app.post("/api/tasks", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), createTask);
  app.post("/api/tasks/bulk", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), bulkCreateTasks);
  app.put("/api/tasks/bulk-update", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), bulkUpdateTasks);
  app.put("/api/tasks/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), updateTask);
  app.delete("/api/tasks/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), deleteTask);
  app.delete("/api/tasks", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_tasks'), bulkDeleteTasks);

  // Team API routes
  app.get("/api/team/ranking", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('view_ranking'), getTeamRanking);
  app.get("/api/team/ranking/top", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('view_ranking'), getTopTeamRanking);
  app.get("/api/team", authenticateToken, checkSubscriptionStatus, getTeamMembers);
  app.get("/api/team/:id", authenticateToken, checkSubscriptionStatus, getTeamMemberById);
  app.post("/api/team/invite", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_team'), checkTeamLimit, inviteTeamMember);
  app.get("/api/team/verify-invite-token/:token", verifyInviteToken);
  app.post("/api/team/accept-invite/:token", acceptInvite);
  app.put(
    "/api/team/:id/status",
    authenticateToken,
    checkSubscriptionStatus,
    checkFeaturePermission('manage_team'),
    updateTeamMemberStatus,
  );
  app.put("/api/team/:id/role", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_team'), updateTeamMemberRole);
  app.delete("/api/team/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_team'), deleteTeamMember);

  // Comments API routes
  app.get("/api/comments/epic/:epicName", authenticateToken, checkSubscriptionStatus, getComments);
  app.get("/api/comments/:taskId", authenticateToken, checkSubscriptionStatus, getComments);
  app.post("/api/comments", authenticateToken, checkSubscriptionStatus, createComment);
  app.delete("/api/comments/:commentId", authenticateToken, checkSubscriptionStatus, deleteComment);
  app.post("/api/comments/:commentId/reaction", authenticateToken, checkSubscriptionStatus, toggleReaction);

  // Epics API routes
  app.get("/api/epics", authenticateToken, checkSubscriptionStatus, getEpics);
  app.post("/api/epics", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_epics'), createEpic);
  app.post("/api/epics/backfill", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_epics'), backfillEpics);
  app.post("/api/epics/:epicId/tasks", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_epics'), linkTasksToEpic);

  // Task assignments API routes
  app.post("/api/assignments", authenticateToken, checkSubscriptionStatus, assignTasks);
  app.get("/api/assignments/:taskId", authenticateToken, checkSubscriptionStatus, getAssignments);
  app.delete("/api/assignments/:assignmentId", authenticateToken, checkSubscriptionStatus, removeAssignment);

  // Activity logs API routes
  app.get("/api/activity-logs", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('view_activity'), getActivityLogs);

  // Ideas API routes
  app.get("/api/ideas", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), getIdeas);
  app.post("/api/ideas", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), createIdea);
  app.put("/api/ideas/:id/status", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), updateIdeaStatus);
  app.put("/api/ideas/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), updateIdea);
  app.delete("/api/ideas/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_ideas'), deleteIdea);

  // Product Documentation API routes
  app.use("/api/product-docs", productDocsRouter);
  // Backward-compatible mount at /api to support existing clients
  app.use("/api", productDocsRouter);

  // Fee Management Routes
  app.use("/api/fees", feesRouter);
  app.use("/api/admin/fees", adminFeesRouter);

  // Admin API routes
  app.use("/api/admin", adminRouter);

  // Dashboard API routes
  app.use("/api/dashboard", dashboardRouter);

  // Subscription API routes
  app.use("/api/subscription", subscriptionRouter);

  // Webhook API routes
  app.use("/api/webhook", webhookRouter);

  // Transfer API routes
  app.use("/api/transfers", transferRouter);

  // Payroll API routes
  app.use("/api/payroll", payrollRouter);

  // Settings API routes
  app.use("/api/settings", settingsRouter);

  // KYC API routes
  app.use("/api/kyc", kycRouter);

  // Wallet API routes
  app.use("/api/wallet", walletRouter);

  // Redirect /wallet/verify to /api/wallet/verify (for backward compatibility with old callback URLs)
  app.get("/wallet/verify", (req, res) => {
    const queryString = req.url.split('?')[1] || '';
    res.redirect(`/api/wallet/verify?${queryString}`);
  });

  // Redirect backend /accept-invite/:token to frontend
  app.get("/accept-invite/:token", (req, res) => {
    const frontendUrl = process.env.APP_BASE_URL || 'https://metroflow-app.netlify.app';
    res.redirect(`${frontendUrl}/accept-invite/${req.params.token}`);
  });

  // Global Error Handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("❌ Unhandled Error:", err);
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
