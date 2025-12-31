/// <reference types="node" />
import "dotenv/config";
import { createServer } from "./index";

const port = process.env.PORT || 3000;

async function start() {
  try {
    const app = await createServer();

    app.listen(port, () => {
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
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

start();
