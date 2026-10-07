import { Request, Response, NextFunction } from "express";
import { query } from "../db";
import { isPayloadEncryptionEnabled, encryptString } from "../lib/payload-crypto";
import * as cron from "node-cron";

/**
 * API request logger — mirrors every API call into `api_request_logs`
 * (payloads stored ENCRYPTED at rest) so admins get a full "who did what"
 * trail across BOTH the user app and the admin panel:
 *
 *   GET  /admin/request-logs         (filter by email/phone/name, type, ...)
 *   GET  /admin/request-logs/stats
 *   GET  /admin/request-logs/:id
 *   POST /admin/request-logs/:id/decrypt   (permission-gated)
 *
 * Volume controls (env):
 *   API_REQUEST_LOG_MODE            all (default) | writes | off
 *   API_REQUEST_LOG_RETENTION_HOURS 24 (default) — hourly purge keeps the table
 *                                   small (overrides RETENTION_DAYS when set)
 *   API_REQUEST_LOG_RETENTION_DAYS  legacy days-based retention (default 1 now)
 */

const MODE = (process.env.API_REQUEST_LOG_MODE || "all").toLowerCase();
const MAX_PAYLOAD_CHARS = 8_000;

const SKIP_PATH_RE =
  /^\/(health|ping|api-docs|uploads|demo|test-sentry)(\/|$)|^\/api\/(health|ping|api-docs|uploads|demo|test-sentry)(\/|$)|^\/(webhook)(\/|$)|^\/api\/(webhook)(\/|$)/i;

function truncate(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (!s || s === "{}" || s === "null") return null;
  // Redact obvious secrets before they ever reach the log store.
  s = s
    .replace(/("(?:password|pin|newPin|oldPin|new_pin|old_pin|otp|otp_code|token|accessToken|refresh_token)"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/("(?:password|pin|otp|token)"\s*:\s*)\d+/gi, '$1"***"');
  return s.length > MAX_PAYLOAD_CHARS ? s.slice(0, MAX_PAYLOAD_CHARS) + "…[truncated]" : s;
}

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (MODE === "off") return next();
  const originalUrl = req.originalUrl || req.url || "";
  if (
    req.method === "OPTIONS" ||
    SKIP_PATH_RE.test(originalUrl)
  ) {
    return next();
  }
  if (MODE === "writes" && ["GET", "HEAD"].includes(req.method)) return next();

  const start = Date.now();
  res.on("finish", () => {
    try {
      // Skip binary/stream responses (uploads, pdfs, exports) — only JSON
      // endpoints carry encryptable payloads.
      const contentType = String(res.getHeader("content-type") || "");
      if (!contentType.includes("application/json")) return;

      const user = (req as any).user || null;
      const admin = (req as any).admin || null;
      const userType = admin ? "admin" : user ? "user" : "anon";
      const userId: string | null = admin?.adminId || user?.userId || user?.id || null;
      const businessId: string | null = user?.businessId || null;

      const enc = (req as any).mfvEnc || {};
      const requestBody = enc.plaintextBody !== undefined ? enc.plaintextBody : req.body;
      const responseBody = enc.plaintextResponse;

      const reqPlain = truncate(requestBody);
      const resPlain = truncate(responseBody);
      const canEncrypt = isPayloadEncryptionEnabled();
      const requestPayload = reqPlain ? (canEncrypt ? encryptString(reqPlain) : reqPlain) : null;
      const responsePayload = resPlain ? (canEncrypt ? encryptString(resPlain) : resPlain) : null;

      // Fire-and-forget: logging must never slow or break the API.
      query(
        `INSERT INTO api_request_logs
           (id, user_type, user_id, business_id, method, path, status_code, duration_ms,
            ip, user_agent, request_payload, response_payload, encrypted, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)`,
        [
          userType,
          userId,
          businessId,
          req.method.slice(0, 10),
          originalUrl.slice(0, 500),
          res.statusCode,
          Date.now() - start,
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null,
          String(req.headers["user-agent"] || "").slice(0, 300) || null,
          requestPayload,
          responsePayload,
          canEncrypt && !!(requestPayload || responsePayload),
        ],
      ).catch(() => {});
    } catch {
      /* never break the request cycle for logging */
    }
  });
  next();
}

/** Retention purge (call once at boot). Default: keep logs for 24 hours. */
export function startRequestLogRetention(): void {
  const hoursEnv = process.env.API_REQUEST_LOG_RETENTION_HOURS;
  const daysEnv = process.env.API_REQUEST_LOG_RETENTION_DAYS;
  // Resolution: explicit HOURS wins; else explicit DAYS; else default 24h.
  let hours: number | null = null;
  if (hoursEnv !== undefined && hoursEnv !== "") {
    const h = parseFloat(hoursEnv);
    if (Number.isFinite(h) && h > 0) hours = h;
  } else if (daysEnv !== undefined && daysEnv !== "") {
    const d = parseFloat(daysEnv);
    if (Number.isFinite(d) && d > 0) hours = d * 24;
  } else {
    hours = 24;
  }
  if (hours === null) return;
  const label = hours >= 24 ? `${hours / 24} day(s)` : `${hours} hour(s)`;
  const purge = async () => {
    try {
      const res = await query(
        `DELETE FROM api_request_logs WHERE created_at < NOW() - ($1 || ' hours')::interval`,
        [String(hours)],
      );
      const removed = res.rowCount || 0;
      if (removed > 0) console.log(`[request-logs] retention purge removed ${removed} row(s) older than ${label}`);
    } catch (err: any) {
      console.warn("[request-logs] retention purge failed:", err?.message);
    }
  };
  purge();
  // Hourly sweep — cheap (indexed on created_at? PK scan OK for this volume)
  cron.schedule("23 * * * *", purge);
}
