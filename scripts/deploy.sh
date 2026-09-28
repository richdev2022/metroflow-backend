#!/usr/bin/env bash
# =============================================================================
# MetricFlow backend — one-shot VPS deploy + verification
#
# Usage (on the VPS, inside the backend repo checkout):
#   bash scripts/deploy.sh
#
# What it does:
#   1. git pull (fast-forward only)
#   2. npm ci (fallback: npm install)
#   3. npm run build
#   4. pm2 restart metroflow
#   5. Verifies the NEW build is actually serving (routes from batches 2/5/6)
#      and prints actionable warnings if GLM_API_KEY is missing.
# =============================================================================
set -uo pipefail

APP_NAME="metroflow"
PORT="${PORT:-3000}"
BASE="http://127.0.0.1:${PORT}"

step() { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()   { printf "  \033[0;32m✔ %s\033[0m\n" "$*"; }
warn() { printf "  \033[1;33m⚠ %s\033[0m\n" "$*"; }
fail() { printf "  \033[0;31m✖ %s\033[0m\n" "$*"; }

step "1/5  Pulling latest code"
OLD_REV="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
git pull --ff-only || { fail "git pull failed (diverged?). Resolve manually, then re-run."; exit 1; }
NEW_REV="$(git rev-parse HEAD)"
if [ "$OLD_REV" = "$NEW_REV" ]; then
  warn "Already up to date ($NEW_REV). If you expected new code, check the remote."
else
  ok "Updated: ${OLD_REV:0:8} -> ${NEW_REV:0:8}"
fi

step "2/5  Installing dependencies"
if npm ci --no-audit --no-fund; then
  ok "npm ci done"
else
  warn "npm ci failed — falling back to npm install"
  npm install --no-audit --no-fund || { fail "dependency install failed"; exit 1; }
fi

step "3/5  Building (swagger + server bundle)"
npm run build || { fail "build failed — old process left untouched"; exit 1; }
ok "build complete (dist/server/node-build.mjs)"

step "4/5  Restarting pm2 process '$APP_NAME'"
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
  pm2 save
  ok "pm2 restart done"
else
  fail "pm2 process '$APP_NAME' not found. Start it once with:"
  echo "       pm2 start dist/server/node-build.mjs --name $APP_NAME --time"
  echo "       pm2 save"
  exit 1
fi

step "5/5  Verifying the new build is serving"
echo "  Waiting for boot (migrations run automatically, all idempotent)..."
DEAD=0
while [ $DEAD -lt 30 ]; do
  if curl -sf -m 3 "$BASE/api/ping" > /dev/null 2>&1; then break; fi
  DEAD=$((DEAD+1)); sleep 2
done
if [ $DEAD -ge 30 ]; then
  fail "server did not answer $BASE/api/ping within 60s — check: pm2 logs $APP_NAME --lines 50"
  exit 1
fi
ok "/api/ping responds"

STALE=0
# Batch-2 marker: public app-config
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$BASE/api/public/app-config")
if [ "$CODE" = "200" ]; then ok "/api/public/app-config -> 200 (new build confirmed)"; else fail "/api/public/app-config -> $CODE (expected 200)"; STALE=1; fi

# Batch-6 marker: public MetricAi ask  (200 with GLM key, 503 ai_not_configured without)
BODY=$(curl -s -m 45 -X POST "$BASE/api/public/metric-ai/ask" -H "Content-Type: application/json" -d '{"message":"ping"}')
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 45 -X POST "$BASE/api/public/metric-ai/ask" -H "Content-Type: application/json" -d '{"message":"ping"}')
if [ "$CODE" = "404" ]; then
  fail "/api/public/metric-ai/ask -> 404 — still an OLD build; did the restart pick up dist/?"
  STALE=1
elif [ "$CODE" = "503" ]; then
  warn "/api/public/metric-ai/ask -> 503 ai_not_configured"
  echo "       Route is live but GLM_API_KEY is missing on this machine."
  echo "       Add a free key from https://z.ai (or https://open.bigmodel.cn) to the"
  echo "       pm2 environment (.env next to the repo), then: pm2 restart $APP_NAME --update-env"
elif [ "$CODE" = "200" ]; then
  ok "/api/public/metric-ai/ask -> 200 MetricAi answered: $(echo "$BODY" | head -c 80)..."
else
  warn "/api/public/metric-ai/ask -> $CODE (unexpected; inspect response)"
fi

# Batch-5/6 markers: route-exists probes (401 = registered + auth-gated)
for p in "/api/ai/status" "/api/chat/gifs" "/api/support/my/conversations" "/api/tasks/00000000-0000-0000-0000-000000000000/attachments"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$BASE$p")
  if [ "$CODE" = "404" ]; then fail "$p -> 404 (route missing!)"; STALE=1; else ok "$p -> $CODE (registered)"; fi
done

if [ "$STALE" = "1" ]; then
  fail "DEPLOY INCOMPLETE — the running process is stale. Run: pm2 restart $APP_NAME --update-env"
  exit 2
fi

printf "\n\033[0;32mDeploy verified. MetricAi + support desk + attachments are live.\033[0m\n"
echo "Optional reminders:"
echo "  • nginx: client_max_body_size >= 100m for large chat video uploads"
echo "  • Optional env: TENOR_API_KEY (GIF tab), SUPPORT_ALERT_EMAIL (new-support email ping)"
echo "  • Swagger UI: http://127.0.0.1:${PORT}/api-docs"
