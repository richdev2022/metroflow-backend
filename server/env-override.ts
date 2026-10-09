/**
 * env-override.ts — MUST be the first import in the server entry file.
 *
 * Why: pm2 snapshots the environment at process start. When .env is later
 * edited (e.g. DISABLE_REDIS=true → false), `pm2 restart` WITHOUT a fresh
 * shell keeps serving the STALE snapshot value, and because `dotenv` does not
 * override existing process.env entries by default, the app silently keeps
 * running with the old values (the exact "BullMQ: Redis disabled by
 * DISABLE_REDIS=true" despite .env saying false incident).
 *
 * This module re-applies the .env file OVER the current process.env, making
 * the .env file authoritative on every boot. Only variables present in .env
 * are overridden — anything injected some other way and absent from .env is
 * left alone.
 */
import dotenv from "dotenv";
import path from "path";

const envPath = process.env.DOTENV_PATH
  ? path.resolve(process.env.DOTENV_PATH)
  : path.resolve(process.cwd(), ".env");

const result = dotenv.config({ override: true, path: envPath });

if (result.error) {
  // Missing .env is normal for some deploy targets — everything falls back to
  // whatever the orchestrator injected. Parse errors are worth shouting about.
  if ((result.error as NodeJS.ErrnoException)?.code !== "ENOENT") {
    console.warn(`[env] Failed to load ${envPath}:`, (result.error as Error).message);
  }
} else if (result.parsed) {
  const keys = Object.keys(result.parsed);
  if (keys.length) {
    console.log(`[env] Loaded ${keys.length} variable(s) from ${envPath} (override: true)`);
  }
}
