/**
 * Boot the backend locally with the repo's .env FORCED (override:true),
 * because the sandbox shell pre-exports a stale DATABASE_URL that neither
 * dotenv nor node --env-file would otherwise beat.
 */
import dotenv from "dotenv";
dotenv.config({ override: true });
process.env.PORT = process.env.PROBE_PORT || "3099";

const { spawn } = await import("node:child_process");
const child = spawn("npx", ["tsx", "server/node-build.ts"], {
  stdio: "inherit",
  env: process.env,
  cwd: new URL("..", import.meta.url).pathname,
});
child.on("exit", (code) => process.exit(code ?? 0));
