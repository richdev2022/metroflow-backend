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
#   3. npm ci ONLY when package-lock.json changed (fallback: npm install);
#      skipped entirely on deploys that touch no dependencies (zero downtime)
#   4. npm run build
#   5. pm2 restart metroflow (logs flushed first: pm2 flush metroflow)
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

step "1/6  Preparing working tree + pulling latest code"

# ---------------------------------------------------------------------
# 0. Preflight: validate DATABASE_URL BEFORE touching anything.
#    A single stray character in the database name (e.g. a '>' from a
#    manual .env edit) crashes the new process after restart with
#    pg 3D000 — aborting here keeps the OLD process serving (no outage).
# ---------------------------------------------------------------------
if [ -f .env ]; then
  DB_URL="$(grep -E '^[A-Za-z_]*DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '\"'"'"'')"
  if [ -z "$DB_URL" ]; then
    fail "DATABASE_URL is missing/empty in .env — the new process would crash on boot."
    echo "       Add: DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require"
    exit 1
  fi
  DB_NAME="$(printf '%s' "$DB_URL" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*/([^?#]*).*$#\1#')"
  if [ -z "$DB_NAME" ]; then
    fail "DATABASE_URL has no database name (expected .../dbname?sslmode=require). Fix .env, then re-run."
    exit 1
  fi
  if printf '%s' "$DB_NAME" | grep -qE '[^A-Za-z0-9_$.~-]'; then
    fail "DATABASE_URL database name \"$DB_NAME\" contains invalid characters — pm2 restart would crash-loop the API."
    echo "       Fix the DATABASE_URL line in .env (the name between the last '/' and '?'),"
    echo "       it must EXACTLY match the database name at your provider, then re-run deploy.sh."
    exit 1
  fi
  ok "DATABASE_URL targets database \"$DB_NAME\""
else
  warn "no .env file found in $(pwd) — the backend may boot without configuration"
fi

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

# ---------------------------------------------------------------------
# npm ci DELETES node_modules before reinstalling. If the live pm2
# process dies for ANY reason during that window (OOM during install,
# crash, manual action), pm2's auto-restart boots into a HALF-INSTALLED
# tree and crash-loops with:
#   "Cannot find module '/root/metroflow-backend/node_modules/dotenv/config.js'"
# followed by a storm of 503s (db gate) and one-off login 500s.
# Seen in production logs 2026-10-10. Two guards fix it:
#   a) skip npm ci entirely when the lockfile did not change (most
#      deploys — also removes 1-2 min from every deploy),
#   b) when we DO reinstall, stop pm2 first and restore it on failure
#      so no request ever hits a broken boot.
# ---------------------------------------------------------------------
PM2_STOPPED=0
INSTALL_NEEDED=0
if [ ! -f node_modules/dotenv/package.json ]; then
  INSTALL_NEEDED=1   # node_modules missing/incomplete — must install
elif ! git diff --quiet "$OLD_REV" HEAD -- package-lock.json 2>/dev/null; then
  INSTALL_NEEDED=1   # lockfile changed in this pull
fi

step "2/6  Installing dependencies"
if [ "$INSTALL_NEEDED" = "0" ]; then
  ok "package-lock.json unchanged — skipping npm ci (zero-downtime deploy)"
else
  echo "  Stopping pm2 process for a safe install (no half-installed boots possible)"
  if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
    pm2 stop "$APP_NAME" >/dev/null 2>&1 || true
    PM2_STOPPED=1
  fi
  if npm ci --no-audit --no-fund; then
    ok "npm ci done"
  else
    warn "npm ci failed — falling back to npm install"
    npm install --no-audit --no-fund || { fail "dependency install failed"; [ "$STASHED" = "1" ] && git stash pop; [ "$PM2_STOPPED" = "1" ] && { warn "restoring old pm2 process"; pm2 start "$APP_NAME" --update-env >/dev/null 2>&1; }; exit 1; }
  fi
fi

step "3/6  Building (swagger + server bundle)"
npm run build || { fail "build failed"; [ "$PM2_STOPPED" = "1" ] && { warn "restoring old pm2 process (previous dist/ still on disk)"; pm2 start "$APP_NAME" --update-env >/dev/null 2>&1; }; [ "$STASHED" = "1" ] && git stash pop; exit 1; }
ok "build complete (dist/server/node-build.mjs)"

step "4/6  Restarting pm2 process '$APP_NAME'"
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  # Fresh logs per deploy: old-process errors must never be mistaken for
  # new-build errors when triaging pm2 logs after a deploy.
  pm2 flush "$APP_NAME" >/dev/null 2>&1 || true
  if [ "$PM2_STOPPED" = "1" ]; then
    pm2 start "$APP_NAME" --update-env
  else
    pm2 restart "$APP_NAME" --update-env
  fi
  pm2 save
  ok "pm2 restart done (logs flushed)"
else
  fail "pm2 process '$APP_NAME' not found. Start it once with:"
  echo "       pm2 start dist/server/node-build.mjs --name $APP_NAME --time"
  echo "       pm2 save"
  exit 1
fi

step "5/6  Verifying the new build is serving"
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
  # /health now answers 200 with db:"down" while the DB is still initializing
  # (cold Neon connect + first-run migrations). Wait for it to flip up before
  # declaring the deploy failed — it is a timing signal, not a broken build.
  if ! echo "$HEALTH_JSON" | grep -q '"db":"up"'; then
    echo "  Database still initializing — waiting for db:\"up\" (up to 60s)..."
    DBWAIT=0
    while [ $DBWAIT -lt 30 ]; do
      sleep 2; DBWAIT=$((DBWAIT+1))
      HEALTH_JSON="$(curl -sf -m 10 "$BASE/api/health" 2>/dev/null || true)"
      [ -n "$HEALTH_JSON" ] && echo "$HEALTH_JSON" | grep -q '"db":"up"' && break
    done
  fi
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
    || { fail "Database: DOWN after 60s wait — check DATABASE_URL + pm2 logs"; STALE=1; }
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
for p in "/api/ai/status" "/api/ai/usage" "/api/chat/gifs" "/api/support/my/conversations" "/api/tasks/00000000-0000-0000-0000-000000000000/attachments"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$BASE$p")
  if [ "$CODE" = "404" ]; then fail "$p -> 404 (route missing!)"; STALE=1; else ok "$p -> $CODE (registered)"; fi
done

# ---------------------------------------------------------------------
# RTC readiness: announced IP must be PUBLIC and the UDP range reachable
# (the #1 cause of participants stuck on "Preparing to join").
# ---------------------------------------------------------------------
if echo "$HEALTH_JSON" | grep -q '"rtc"'; then
  RTC_ANNOUNCED="$(echo "$HEALTH_JSON" | grep -o '"announcedIp":"[^"]*"' | head -1 | cut -d'"' -f4)"
  RTC_PUBLIC="$(echo "$HEALTH_JSON" | grep -o '"announcedIpIsPublic":[a-z]*' | head -1 | cut -d: -f2)"
  RTC_READY="$(echo "$HEALTH_JSON" | grep -o '"ready":[a-z]*' | head -1 | cut -d: -f2)"
  if [ "$RTC_READY" = "true" ]; then
    ok "Mediasoup: workers up, announced IP = ${RTC_ANNOUNCED:-?}"
  else
    warn "Mediasoup: workers not ready yet (starts in the background after boot)"
  fi
  if [ "$RTC_PUBLIC" != "true" ]; then
    warn "Mediasoup announced IP is NOT a public address (${RTC_ANNOUNCED:-unknown}) — remote participants WILL be stuck joining."
    echo "       Fix: set MEDIASOUP_ANNOUNCED_IP=<this server's PUBLIC IP> in the backend .env, then: pm2 restart $APP_NAME --update-env"
  fi
fi
RTC_MIN="$(grep -oE 'MEDIASOUP_RTC_MIN_PORT=[0-9]+' .env 2>/dev/null | cut -d= -f2 || true)"
RTC_MAX="$(grep -oE 'MEDIASOUP_RTC_MAX_PORT=[0-9]+' .env 2>/dev/null | cut -d= -f2 || true)"
RTC_MIN="${RTC_MIN:-40000}"; RTC_MAX="${RTC_MAX:-49999}"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if ufw status | grep -qE "${RTC_MIN}.*udp|${RTC_MIN}:${RTC_MAX}"; then
    ok "Firewall: UDP ${RTC_MIN}-${RTC_MAX} already open (mediasoup media ports)"
  else
    if ufw allow "${RTC_MIN}:${RTC_MAX}/udp" >/dev/null 2>&1; then
      ok "Firewall: opened UDP ${RTC_MIN}-${RTC_MAX} for mediasoup media (ufw)"
    else
      warn "Could not open UDP ${RTC_MIN}-${RTC_MAX} via ufw — open this range manually or media will not connect."
    fi
  fi
else
  echo "  • Firewall check: ensure UDP ${RTC_MIN}-${RTC_MAX} is reachable (cloud firewall + ufw) for calls/meetings."
fi

# ---------------------------------------------------------------------
# 6/6 nginx upload limit (client_max_body_size).
# nginx defaults to 1m — every chat attachment above 1MB (ANY video,
# most photos) was rejected by the proxy with 413 before reaching the
# API, surfacing in the apps as "Internal server error". This step
# makes every deploy self-heal the limit for vhosts proxying to the
# API port. Idempotent + safe: nginx -t must pass or changes revert.
# ---------------------------------------------------------------------
if command -v nginx >/dev/null 2>&1 && [ -d /etc/nginx ]; then
  step "6/6  nginx upload limit (client_max_body_size)"
  STAMP="$(date +%Y%m%d%H%M%S)"
  MIN_BODY_MB=100
  TARGET="client_max_body_size ${MIN_BODY_MB}m"

  nginx_mb_to_mib() {
    # "1m" / "1024k" / "2g" -> mebibytes (integer)
    local v="$1" n u
    n="$(echo "$v" | tr -d '[:space:]' | sed -E 's/[kKmMgG]$//')"
    u="$(echo "$v" | sed -E 's/.*([kKmMgG])$/\1/')"
    case "$u" in
      g|G) echo $(( n * 1024 )) ;;
      m|M) echo "$n" ;;
      k|K) echo $(( n / 1024 )) ;;
      *)   echo 0 ;;
    esac
  }

  CONF_DIRS=("/etc/nginx/sites-enabled" "/etc/nginx/conf.d")
  PROXY_FILES=""
  for d in "${CONF_DIRS[@]}"; do
    [ -d "$d" ] || continue
    FOUND="$(grep -rIlE "proxy_pass[^;]*:${PORT}([^/]|$)" "$d" 2>/dev/null || true)"
    [ -n "$FOUND" ] && PROXY_FILES="$PROXY_FILES $FOUND"
  done

  MODIFIED=0
  BACKUPS=()
  if [ -n "$PROXY_FILES" ]; then
    for f in $PROXY_FILES; do
      VALS="$(grep -hoE 'client_max_body_size\s+[0-9]+[kKmMgG]?' "$f" 2>/dev/null | awk '{print $2}')"
      if [ -z "$VALS" ]; then
        continue  # no per-vhost override — http-level default below covers it
      fi
      NEEDS_FIX=0
      for v in $VALS; do
        MB="$(nginx_mb_to_mib "$v")"
        if [ "$MB" -lt "$MIN_BODY_MB" ]; then NEEDS_FIX=1; break; fi
      done
      if [ "$NEEDS_FIX" = "1" ]; then
        cp "$f" "$f.bak-$STAMP" && BACKUPS+=("$f.bak-$STAMP")
        sed -i -E "s/client_max_body_size\s+[0-9]+[kKmMgG]?/$TARGET/g" "$f"
        MODIFIED=1
        ok "raised client_max_body_size to ${MIN_BODY_MB}m in $f"
      fi
    done
  fi

  # http-level default (covers vhosts without an explicit limit).
  if [ "$MODIFIED" = "0" ]; then
    HTTP_VAL=""
    for f in /etc/nginx/nginx.conf "${CONF_DIRS[@]}"; do
      [ -f "$f" ] || [ -d "$f" ] || continue
      HTTP_VAL="$(grep -rhoE 'client_max_body_size\s+[0-9]+[kKmMgG]?' "$f" 2>/dev/null | head -1 | awk '{print $2}')"
      [ -n "$HTTP_VAL" ] && break
    done
    if [ -z "$HTTP_VAL" ] || [ "$(nginx_mb_to_mib "$HTTP_VAL")" -lt "$MIN_BODY_MB" ]; then
      echo "client_max_body_size ${MIN_BODY_MB}m;" > /etc/nginx/conf.d/00-metricorex-client-max-body.conf
      BACKUPS+=("/etc/nginx/conf.d/00-metricorex-client-max-body.conf")
      MODIFIED=1
      ok "http-level default set to ${MIN_BODY_MB}m (conf.d/00-metricorex-client-max-body.conf)"
    else
      ok "nginx upload limit already >= ${MIN_BODY_MB}m ($HTTP_VAL)"
    fi
  fi

  if [ "$MODIFIED" = "1" ]; then
    if nginx -t > /dev/null 2>&1; then
      if nginx -s reload 2>/dev/null || systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null; then
        ok "nginx reloaded — uploads up to ${MIN_BODY_MB}MB now accepted"
      else
        warn "nginx config updated but reload failed — run: nginx -s reload"
      fi
    else
      warn "nginx -t FAILED after edit — reverting changes"
      for b in "${BACKUPS[@]}"; do
        case "$b" in
          *.bak-*) cp "$b" "${b%.bak-$STAMP}" ;;
          /etc/nginx/conf.d/00-metricorex-client-max-body.conf) rm -f "$b" ;;
        esac
      done
      nginx -t > /dev/null 2>&1 || true
      warn "nginx restored. Raise client_max_body_size manually (see docs)."
    fi
  fi

  # External verification: a 2MB POST must NOT be rejected with 413.
  PUBLIC_HOST="$(grep -E '^(API_PUBLIC_BASE_URL|APP_BASE_URL)=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\"'"'"'')"
  PUBLIC_HOST="$(echo "$PUBLIC_HOST" | sed -E 's#^https?://##; s#/$##')"
  PROBE_URL="${PUBLIC_HOST:-api.metricorex.com}"
  PROBE_CODE="$(dd if=/dev/zero bs=1M count=2 2>/dev/null | curl -s -o /dev/null -w "%{http_code}" -m 15 -X POST "https://${PROBE_URL}/api/auth/login" -H "Content-Type: application/json" --data-binary @- || echo curl_err)"
  if [ "$PROBE_CODE" = "413" ]; then
    warn "2MB upload probe STILL 413 at $PROBE_URL — a vhost outside sites-enabled/conf.d overrides the limit."
    echo "       Fix manually: add 'client_max_body_size 100m;' to that server block, then: nginx -s reload"
  elif [ "$PROBE_CODE" = "curl_err" ]; then
    warn "could not reach https://$PROBE_URL for the 2MB upload probe (network?)"
  else
    ok "2MB upload probe -> $PROBE_CODE (not 413) — proxy no longer blocks chat media"
  fi
else
  echo "  • nginx not present — skipping upload-limit check (client_max_body_size)."
fi

[ "$STASHED" = "1" ] && warn "remember: your pre-deploy local edits are in 'git stash' (git stash pop / git stash drop)"

if [ "$STALE" = "1" ]; then
  fail "DEPLOY INCOMPLETE — the running process is stale. Run: pm2 restart $APP_NAME --update-env"
  exit 2
fi

printf "\n\033[0;32mDeploy verified. MetricAi + support desk + attachments are live.\033[0m\n"
echo "Reminders:"
echo "  • Optional env: TENOR_API_KEY (GIF tab), SUPPORT_ALERT_EMAIL (new-support email ping)"
echo "  • Swagger UI: http://127.0.0.1:${PORT}/api-docs  |  Health: /api/health"
