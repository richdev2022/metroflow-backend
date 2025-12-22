import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from 'url';
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { specs } from "./swagger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
import { getIdeas, createIdea, updateIdeaStatus } from "./routes/ideas";
import adminRouter from "./routes/admin";
import subscriptionRouter from "./routes/subscription";
import dashboardRouter from "./routes/dashboard";
import { initializeDatabase, query } from "./db";
import { authenticateToken, checkTeamLimit } from "./middleware/auth";
import * as cron from "node-cron";

export async function createServer() {
  const app = express();

  // Initialize database on startup
  try {
    await initializeDatabase();
  } catch (error) {
    console.error("Failed to initialize database:", error);
  }

  // Schedule activity log cleanup (runs daily at midnight)
  cron.schedule("0 0 * * *", async () => {
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

    } catch (error) {
      console.error("Cron job error:", error);
    }
  });

  // Middleware
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Swagger Documentation
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

  // Serve static files
  app.use(express.static(path.join(__dirname, "../public")));

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

  // Example API routes
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
  app.get("/api/tasks", authenticateToken, getTasks);
  app.post("/api/tasks", authenticateToken, createTask);
  app.post("/api/tasks/bulk", authenticateToken, bulkCreateTasks);
  app.put("/api/tasks/bulk-update", authenticateToken, bulkUpdateTasks);
  app.put("/api/tasks/:id", authenticateToken, updateTask);
  app.delete("/api/tasks/:id", authenticateToken, deleteTask);
  app.delete("/api/tasks", authenticateToken, bulkDeleteTasks);

  // Team API routes
  app.get("/api/team/ranking", authenticateToken, getTeamRanking);
  app.get("/api/team/ranking/top", authenticateToken, getTopTeamRanking);
  app.get("/api/team", authenticateToken, getTeamMembers);
  app.get("/api/team/:id", authenticateToken, getTeamMemberById);
  app.post("/api/team/invite", authenticateToken, checkTeamLimit, inviteTeamMember);
  app.get("/api/team/verify-invite-token/:token", verifyInviteToken);
  app.post("/api/team/accept-invite/:token", acceptInvite);
  app.put(
    "/api/team/:id/status",
    authenticateToken,
    updateTeamMemberStatus,
  );
  app.put("/api/team/:id/role", authenticateToken, updateTeamMemberRole);
  app.delete("/api/team/:id", authenticateToken, deleteTeamMember);

  // Comments API routes
  app.get("/api/comments/epic/:epicName", authenticateToken, getComments);
  app.get("/api/comments/:taskId", authenticateToken, getComments);
  app.post("/api/comments", authenticateToken, createComment);
  app.delete("/api/comments/:commentId", authenticateToken, deleteComment);
  app.post("/api/comments/:commentId/reaction", authenticateToken, toggleReaction);

  // Epics API routes
  app.get("/api/epics", authenticateToken, getEpics);
  app.post("/api/epics", authenticateToken, createEpic);
  app.post("/api/epics/backfill", authenticateToken, backfillEpics);
  app.post("/api/epics/:epicId/tasks", authenticateToken, linkTasksToEpic);

  // Task assignments API routes
  app.post("/api/assignments", authenticateToken, assignTasks);
  app.get("/api/assignments/:taskId", authenticateToken, getAssignments);
  app.delete("/api/assignments/:assignmentId", authenticateToken, removeAssignment);

  // Activity logs API routes
  app.get("/api/activity-logs", authenticateToken, getActivityLogs);

  // Ideas API routes
  app.get("/api/ideas", authenticateToken, getIdeas);
  app.post("/api/ideas", authenticateToken, createIdea);
  app.put("/api/ideas/:id/status", authenticateToken, updateIdeaStatus);

  // Admin API routes
  app.use("/api/admin", adminRouter);

  // Dashboard API routes
  app.use("/api/dashboard", dashboardRouter);

  // Subscription API routes
  app.use("/api/subscription", subscriptionRouter);

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
