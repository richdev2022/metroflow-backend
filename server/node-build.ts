/// <reference types="node" />
// IMPORTANT: Import instrument.ts first to initialize Sentry as early as possible
import "./instrument";
import http from "http";
import { createServer } from "./index";
import { initSocketServer } from "./lib/socket";

const port = process.env.PORT || 3000;

async function start() {
  try {
    const app = await createServer();
    const server = http.createServer(app);
    
    // Initialize Socket.io
    initSocketServer(server);

    server.listen(Number(port), () => {
      console.log(`🚀 MetricFlow server running on port ${port}`);
      console.log(`🔧 API: http://localhost:${port}/api`);
    });

    // Graceful shutdown
    process.on("SIGTERM", () => {
      console.log("🛑 Received SIGTERM, shutting down gracefully");
      process.exit(0);
    });

    process.on("SIGINT", () => {
      console.log("🛑 Received SIGINT, shutting down gracefully");
      process.exit(0);
    });

    // Handle uncaught exceptions and rejections
    process.on("uncaughtException", (err) => {
      console.error("❌ Uncaught Exception:", err);
      // Keep the server running
      // process.exit(1);
    });

    process.on("unhandledRejection", (reason, promise) => {
      console.error("❌ Unhandled Rejection:", reason);
    });

  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

start();
