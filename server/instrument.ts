import "dotenv/config";
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 1.0,
    dataCollection: {
      // Optional: Adjust these settings based on your privacy preferences
      // userInfo: false,
      // httpBodies: [],
    },
  });
  console.log("✅ Sentry initialized successfully");
} else {
  console.log("ℹ️ SENTRY_DSN not set, skipping Sentry initialization");
}
