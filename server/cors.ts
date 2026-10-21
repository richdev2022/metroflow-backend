import type { CorsOptions } from "cors";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://metroflow-app.netlify.app",
  "https://metricorex-app.netlify.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "https://api.metricorex.com",
  "https://metricorex.com",
  "https://www.metricorex.com",
  "https://files.metricorex.com",
  "https://app.metricorex.com",
  "https://admin.metricorex.com",
  "https://compliance.metricorex.com",
  "https://metricorex-admin.netlify.app",
  "https://metricorex-backend.netlify.app",
  "https://metricorex-site.netlify.app",
  // Personal app (web) — must be first-class, not an afterthought.
  "https://personal.metricorex.com",
  "https://metricorex-personal.netlify.app",
  "https://metricorex-personal-web.netlify.app",
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

// VAPT MF-003 fix: local development origins are matched with an EXACT
// host:port pattern, never a substring check. The old `origin.includes(
// "localhost")` reflected hostile origins like `https://localhost.evil.com`
// (live-confirmed exploitable) because they merely CONTAIN the substring.
// `Origin: null` (sandboxed iframes, some cross-site form posts, and the
// classic `document.origin = null` tricks) is likewise no longer trusted.
const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function isCorsOriginAllowed(origin?: string | null) {
  if (!origin) {
    // No Origin header (server-to-server, mobile apps, curl) — CORS is a
    // browser concept; these requests were never blocked and must not start
    // being blocked now.
    return true;
  }

  if (origin === "null") {
    return false;
  }

  if (LOCAL_ORIGIN_PATTERN.test(origin)) {
    return true;
  }

  const allowedOrigins = getAllowedOrigins();
  return allowedOrigins.includes("*") || allowedOrigins.includes(origin);
}

export function getCorsHeaders(origin?: string | null, requestedHeaders?: string | null) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS,PATCH",
    "Access-Control-Allow-Headers": requestedHeaders || DEFAULT_ALLOWED_HEADERS.join(","),
    "Access-Control-Expose-Headers": "Content-Disposition,Content-Length,x-mfv-enc",
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

    // VAPT MF-003 fix: a disallowed origin must NOT error the request.
    // callback(Error) turned every blocked cross-site probe into a 500 and
    // (worse) some error paths still carried CORS headers. callback(null,
    // false) simply omits Access-Control-Allow-Origin so the BROWSER rejects
    // the response — the request itself answers normally (200/4xx).
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  exposedHeaders: ["Content-Disposition", "Content-Length", "x-mfv-enc"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};
