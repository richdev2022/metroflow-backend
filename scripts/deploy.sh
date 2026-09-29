#!/usr/bin/env bash
# =============================================================================
# MetricFlow backend — one-shot VPS deploy + verification (v2)
#
# Usage (on the VPS, inside the backend repo checkout):
#   bash scripts/deploy.sh
#
# What it does:
#   1. Handles a dirty working tree safely:
#        • generated files (server/swagger-output.json) are discarded — they
#          are rebuilt by `npm run build` anyway (this is what made past
#          `git pull`s fail with "local changes would be overwritten")
#        • any OTHER local edits are stashed (recoverable via `git stash pop`)
#   2. git pull (fast-forward only)
#   3. npm ci (fallback: npm install)
#   4. npm run build
#   5. pm2 restart metroflow
#   6. Verifies the NEW build is serving via /api/health (+ route probes)
#      and prints actionable warnings when GLM_API_KEY / TENOR_API_KEY are
#      missing.
# =============================================================================
set -uo pipefail

APP_NAME="${APP_NAME:-metroflow}"
PORT="${PORT:-3000}"
BASE="http://127.0.0.1:${PORT}"
GENERATED_FILES=("server/swagger-output.json")

step() { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()   { printf "  \033[0;32m✔ %s\033[0m\n" "$*"; }
warn() { printf "  \033[1;33m⚠ %s\033[0m\n" "$*"; }
fail() { printf "  \033[0;31m✖ %s\033[0m\n" "$*"; }

step "1/5  Preparing working tree + pulling latest code"
OLD_REV="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

# 1a. discard drift in generated files (rebuilt by npm run build)
for f in "${GENERATED_FILES[@]}"; do
  if ! git diff --quiet -- "$f" 2>/dev/null; then
    git checkout -- "$f" && warn "discarded local drift in generated $f (rebuilt during build)"
  fi
done

# 1b. stash any remaining local edits so the fast-forward pull cannot be blocked
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  if git stash push -u -m "deploy.sh auto-stash $(date +%F_%T)" > /dev/null 2>&1; then
    STASHED=1
    warn "local edits stashed (recover with: git stash pop after reviewing)"
  else
    fail "could not stash local changes automatically."
    echo "       Inspect with 'git status' (or run: git checkout -- . to discard), then re-run."
    exit 1
  fi
fi

if ! git pull --ff-only; then
  [ "$STASHED" = "1" ] && git stash pop
  fail "git pull failed (diverged?). Resolve manually, then re-run."
  exit 1
fi
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
  npm install --no-audit --no-fund || { fail "dependency install failed"; [ "$STASHED" = "1" ] && git stash pop; exit 1; }
fi

step "3/5  Building (swagger + server bundle)"
npm run build || { fail "build failed — old process left untouched"; [ "$STASHED" = "1" ] && git stash pop; exit 1; }
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
HEALTH_JSON="$(curl -sf -m 10 "$BASE/api/health" 2>/dev/null || true)"
if [ -n "$HEALTH_JSON" ]; then
  ok "/api/health: $(echo "$HEALTH_JSON" | head -c 220)..."
  echo "$HEALTH_JSON" | grep -q '"metricAi":{"configured":true' \
    && ok "MetricAi: GLM key configured — AI replies live" \
    || warn "MetricAi: GLM_API_KEY missing -> /api/public/metric-ai/ask will 503."
  echo "       Free key: https://z.ai (starts with sk-) or https://open.bigmodel.cn (looks like id.secret)."
  echo "       Both formats are auto-detected — add GLM_API_KEY to the backend .env, then: pm2 restart $APP_NAME --update-env"
  echo "$HEALTH_JSON" | grep -q '"gifs":{"configured":true' \
    && ok "GIF picker: TENOR_API_KEY configured" \
    || warn "GIF picker: TENOR_API_KEY not set (chat GIF tab stays hidden — optional)"
  echo "$HEALTH_JSON" | grep -q '"db":"up"' \
    && ok "Database: up" \
    || { fail "Database: DOWN — check DATABASE_URL"; STALE=1; }
else
  warn "/api/health not available (very old build?) — falling back to route probes"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$BASE/api/public/app-config")
  if [ "$CODE" = "200" ]; then ok "/api/public/app-config -> 200 (new-ish build confirmed)"; else fail "/api/public/app-config -> $CODE (expected 200)"; STALE=1; fi
fi

# Direct probe of the endpoint that triggered this deploy flow
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 45 -X POST "$BASE/api/public/metric-ai/ask" -H "Content-Type: application/json" -d '{"message":"ping"}')
if [ "$CODE" = "404" ]; then
  fail "/api/public/metric-ai/ask -> 404 — still an OLD build; did the restart pick up dist/?"
  STALE=1
elif [ "$CODE" = "503" ]; then
  warn "/api/public/metric-ai/ask -> 503 ai_not_configured (route live, GLM_API_KEY missing)"
elif [ "$CODE" = "200" ]; then
  ok "/api/public/metric-ai/ask -> 200 MetricAi answered"
else
  warn "/api/public/metric-ai/ask -> $CODE (unexpected; inspect response)"
fi

# Route-existence probes (401 = registered + auth-gated)
for p in "/api/ai/status" "/api/chat/gifs" "/api/support/my/conversations" "/api/tasks/00000000-0000-0000-0000-000000000000/attachments"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$BASE$p")
  if [ "$CODE" = "404" ]; then fail "$p -> 404 (route missing!)"; STALE=1; else ok "$p -> $CODE (registered)"; fi
done

[ "$STASHED" = "1" ] && warn "remember: your pre-deploy local edits are in 'git stash' (git stash pop / git stash drop)"

if [ "$STALE" = "1" ]; then
  fail "DEPLOY INCOMPLETE — the running process is stale. Run: pm2 restart $APP_NAME --update-env"
  exit 2
fi

printf "\n\033[0;32mDeploy verified. MetricAi + support desk + attachments are live.\033[0m\n"
echo "Reminders:"
echo "  • nginx: client_max_body_size >= 100m for large chat video uploads"
echo "  • Optional env: TENOR_API_KEY (GIF tab), SUPPORT_ALERT_EMAIL (new-support email ping)"
echo "  • Swagger UI: http://127.0.0.1:${PORT}/api-docs  |  Health: /api/health"
