import type { CorsOptions } from "cors";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://metricorex-app.netlify.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "https://api.metricorex.com",
  "https://metricorex.com",
  "https://files.metricorex.com",
  "https://app.metricorex.com",
  "https://admin.metricorex.com",
  "https://compliance.metricorex.com",
  "https://metricorex-admin.netlify.app",
  "https://metricorex-backend.netlify.app",
  "https://metricorex-site.netlify.app",
];

const DEFAULT_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
  "x-business-id",
  "x-team-id",
  "x-job-secret",
];

function getAllowedOrigins() {
  const configuredOrigins = process.env.CORS_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

  return [
    ...DEFAULT_ALLOWED_ORIGINS,
    process.env.APP_BASE_URL,
    ...configuredOrigins,
  ].filter(Boolean) as string[];
}

export function isCorsOriginAllowed(origin?: string | null) {
  if (!origin || origin === "null") {
    return true;
  }

  const allowedOrigins = getAllowedOrigins();
  return (
    allowedOrigins.includes("*") ||
    allowedOrigins.includes(origin) ||
    origin.includes("localhost") ||
    origin.includes("127.0.0.1")
  );
}

export function getCorsHeaders(origin?: string | null, requestedHeaders?: string | null) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS,PATCH",
    "Access-Control-Allow-Headers": requestedHeaders || DEFAULT_ALLOWED_HEADERS.join(","),
    "Access-Control-Expose-Headers": "Content-Disposition,Content-Length",
    Vary: "Origin, Access-Control-Request-Headers",
  };

  if (origin && isCorsOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (isCorsOriginAllowed(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Origin ${origin} is not allowed by CORS`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  exposedHeaders: ["Content-Disposition", "Content-Length"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};
