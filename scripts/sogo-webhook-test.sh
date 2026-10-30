#!/usr/bin/env bash
# ============================================================================
# SOGO WEBHOOK PROBE — sign a payload with SOGO_WEBHOOK_SECRET and POST it.
#
# Answers "is the production webhook endpoint + secret actually working?"
# in one command, so nobody has to hand-compute HMACs into Swagger UI again.
#
# Usage:
#   export SOGO_WEBHOOK_SECRET='whsec_...'          # the endpoint signing secret
#   ./scripts/sogo-webhook-test.sh                  # signed ping → api.metricorex.com
#   ./scripts/sogo-webhook-test.sh http://localhost:3000/api/webhook/sogo
#   ./scripts/sogo-webhook-test.sh https://api.metricorex.com/api/webhook/sogo \
#       '{"event":"ping","data":{"reference":"probe-1"}}'
#
# Exit codes: 0 = 200 verified · 1 = 401 bad signature · 2 = 503 secret not
# configured on the server · 3 = other/transport error.
# ============================================================================
set -euo pipefail

URL="${1:-https://api.metricorex.com/api/webhook/sogo}"
BODY="${2:-{\"event\":\"ping\",\"data\":{}}}"

if [ -z "${SOGO_WEBHOOK_SECRET:-}" ]; then
  echo "ERROR: export SOGO_WEBHOOK_SECRET first (the endpoint signing secret" >&2
  echo "from the Sogo dashboard → developer profile → Webhooks)." >&2
  exit 3
fi

# The header is "sha256=" + HMAC-SHA256(secret, RAW BODY) hex. The digest must
# cover the exact bytes sent — printf '%s' guarantees no trailing newline.
HEX="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SOGO_WEBHOOK_SECRET" -hex | sed 's/^.* //')"
SIG="sha256=${HEX}"

echo "POST  $URL"
echo "body  $BODY"
echo "sig   ${SIG:0:24}…$(echo "$SIG" | tail -c 9)"
echo "---"

HTTP_CODE="$(curl -sS -o /tmp/sogo-probe-response.json -w '%{http_code}' \
  -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "X-Sogo-Signature-256: $SIG" \
  --data-raw "$BODY")" || { echo "transport error"; exit 3; }

echo "HTTP ${HTTP_CODE}"
cat /tmp/sogo-probe-response.json; echo

case "$HTTP_CODE" in
  200) echo "✅ VERIFIED — signature accepted, event processed."; exit 0 ;;
  401) echo "❌ 401 — signature rejected. The header must be sha256=+HMAC(secret, EXACT raw body); re-check the secret and that the body bytes match."; exit 1 ;;
  503) echo "⚠️  503 — the SERVER has no SOGO_WEBHOOK_SECRET configured. Fix the server env, then retry."; exit 2 ;;
  *)   exit 3 ;;
esac
