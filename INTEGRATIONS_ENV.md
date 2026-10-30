# Integrations — Environment Variable Reference

Single source of truth for every third-party integration env var used by the
Metricorex backend, based on the current code (2026-10). Values live in the
**gitignored** `.env`; `.env.example` mirrors the same names with placeholders.
The Personal Products admin console surfaces the Bitnob / Prestmit /
Flutterwave switches, so these vars directly drive what admins see.

| # | Integration | Purpose | Status |
|---|-------------|---------|--------|
| 1 | [Bitnob](#1-bitnob--usd-virtual-cards--crypto--payouts) | USD virtual cards, crypto rates, crypto→NGN payouts | **Credentials configured — awaiting IP whitelist** |
| 2 | [Prestmit](#2-prestmit--gift-card-buy--sell) | Gift card buy + sell trading | **Var names set — values pending re-entry** |
| 3 | [Flutterwave](#3-flutterwave--cards--bills--transfers) | Card funding, bills payment, transfers, webhook | **Configured in `.env`** |
| 4 | [Monnify](#4-monnify--virtual-accounts--collections) | Virtual accounts, collections | Configured |
| 5 | [Squad](#5-squad--payment-gateway) | Card/transfer payments | Configured |
| 6 | [Prembly](#6-prembly--kyc-verification) | Identity KYC verification | Configured |
| 7 | [SMS & WhatsApp](#7-sms--whatsapp) | Termii, Kudi SMS, Meta WhatsApp OTP | Configured |
| 8 | [Email](#8-email--smtp--brevo) | Transactional email (SMTP + Brevo) | Configured |
| 9 | [Push Notifications](#9-push-notifications--firebase--apns--web-push) | FCM, APNs, Web Push (VAPID) | Configured |
| 10 | [RTC / Calling](#10-rtc--calling--livekit--mediasoup) | Live audio/video, recording egress | Configured |
| 11 | [File Storage](#11-file-storage--cloudflare-r2--cloudinary) | Media upload, avatars, attachments | Configured |
| 12 | [AI — MetricAi](#12-ai--metricai) | Chat, vision, image, video models | Configured |
| 13 | [Core / Platform](#13-core--platform-variables) | DB, auth, URLs, CORS, Redis, limits | Configured |

**How env is loaded**: `server/index.ts` loads `.env` (local / droplet) or the
Netlify function environment. Nothing is committed to git. The helper scripts
`scripts/test_bitnob_auth.mjs` and `scripts/test_bitnob_sandbox.mjs` verify
Bitnob connectivity without touching any money movement.

---

## 1. Bitnob — USD virtual cards + crypto + payouts + STABLECOINS (USDT/USDC)

**Files**: `server/services/bitnob.ts` (route layer) ·
`server/services/providers/bitnob.ts` (feature layer) ·
consumers: `server/features/personal/virtualcards.ts`, `crypto.ts`,
`server/features/personal/stablecoin.ts` (stablecoin hub),
`server/routes/personal-webhooks.ts` (deposit/withdraw webhooks).

**Auth scheme (HMAC-SHA256)** — identical in both clients after the
2026-10 unification:

```
stringToSign = CLIENT_ID:TIMESTAMP:NONCE:PAYLOAD   # PAYLOAD = exact JSON body, "" when none
signature    = HMAC_SHA256(stringToSign, SECRET_KEY).hex
headers      = X-Auth-Client, X-Auth-Timestamp (unix sec), X-Auth-Nonce (16-byte hex),
               X-Auth-Signature
```

### Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BITNOB_CLIENT_ID` | ✅ | Dashboard **Client ID** — sent as `X-Auth-Client`. |
| `BITNOB_SECRET_KEY` | ✅ | Dashboard **secret key** — HMAC signing secret. |
| `BITNOB_API_KEY` | ⚠️ deprecated | Legacy alias of `BITNOB_SECRET_KEY`. Do not use in new code. |
| `BITNOB_BASE_URL` | optional | Default `https://api.bitnob.com` (paths in code already include `/api`; a trailing `/api` here would double it). |
| `BITNOB_ENV` | optional | `production` (default) or `sandbox` (switches base to `https://sandboxapi.bitnob.co/api`). |
| `BITNOB_WEBHOOK_URL` | optional | Sent to Bitnob when creating cards; points at the backend webhook route. |
| `BITNOB_WEBHOOK_SECRET` | optional | Shared secret used to verify webhook signatures (`personal-webhooks.ts`). **Strongly recommended in production** — stablecoin deposit crediting verifies `x-bitnob-signature` (HMAC-SHA512 hex **or** HMAC-SHA256 hex over the raw body) against it. |
| `BITNOB_PAYOUT_CALLBACK_URL` | optional | Callback URL attached to crypto payout requests (`crypto.ts`). |
| `BITNOB_DEPOSIT_AMOUNT_MODE` | optional | How `deposit.success` webhook amounts are interpreted: `base` (token units, e.g. `75` = 75 USDT), `micro` (6-decimal base units, e.g. `75000000` = 75 USDT), or `auto` (default — integer values ≥ 1,000,000 are treated as micro-units). Verify against a real webhook payload from the Bitnob dashboard and pin it explicitly if needed. |

### Stablecoin hub endpoints (mounted 2026-10)

| Route | Purpose |
|-------|---------|
| `GET /api/crypto/stablecoin/chains` | Supported deposit networks per coin (live from `GET /api/stablecoins/supported-chains`). |
| `POST /api/crypto/stablecoin/addresses` | Generate / re-use a personal deposit address (`POST /api/addresses`). One per user per coin per chain; 20/day fraud cap. |
| `GET /api/crypto/stablecoin/rate` | Live `USDT/USDC → NGN` rate (trading price → convert API → simulator). |
| `POST /api/crypto/stablecoin/convert/quote` | Locked-rate quote for stablecoin ↔ NGN (`POST /api/trading/quotes`). |
| `POST /api/crypto/stablecoin/convert` | Execute the conversion (`POST /api/trading/orders`); debits the source wallet first, refunds on failure; PIN + fraud engine gated. |
| `POST /api/crypto/stablecoin/withdraw` | On-chain payout (`POST /api/withdrawals`) with local + Bitnob address validation, PIN, fraud engine. |
| `GET /api/crypto/stablecoin/{addresses,conversions,deposits,withdrawals}` | User histories. |
| `POST /api/webhook/bitnob` + `POST /api/webhook/bitnob/stablecoin` | Webhook receivers: `deposit.success` credits the owner of the deposit address (signature → dedup → address binding → currency match → min $1 → server-side tx cross-check → idempotent ledger); `transfer.success/failed` finalizes withdrawals (refund on failure). |

**Bitnob dashboard setup for stablecoins (production)**:
1. API key scopes required: `wallet:read`, `wallet:write`, `transfer:create`.
2. Whitelist the **droplet's** public IP (Dashboard → API Keys → IP whitelist) —
   the container/dev IP will get `403 IP address not whitelisted`.
3. Set the webhook URL to `https://api.metricorex.com/api/webhook/bitnob/stablecoin`
   (the general `…/api/webhook/bitnob` also handles deposits) and copy the
   signing secret into `BITNOB_WEBHOOK_SECRET`.
4. Minimum deposit/withdrawal is **$1** per Bitnob; the platform adds its own
   clamps (convert 2–50,000; withdraw 2–20,000).
5. `BITNOB_ALLOW_INSECURE_TLS` — optional; `1` tolerates the sandbox host's
   mismatched TLS certificate (sandbox host is broken upstream; production
   `api.bitnob.com` is fine and does not need it).

### Current values (configured 2026-10)

```env
BITNOB_CLIENT_ID=a8692858-1439-4bd5-b7cd-55cdada078f9
BITNOB_SECRET_KEY=prd:sandbox_c4d0508e65b200c57383b0e570c718d1d6ab3cabaf3d5ee31ac48a534a792839
BITNOB_BASE_URL=https://api.bitnob.com
```

### Live verification (2026-10)

- `https://api.bitnob.com` **is the live base** — probes to
  `/api/balances`, `/api/exchange-rates`, `/api/v1/wallets` all answered the
  standard gate: `403 {"detail":"IP address not whitelisted","code":"FORBIDDEN"}`.
  This confirms host, path scheme and reachability; Bitnob validates the IP
  whitelist **before** auth, so signature correctness will be proven on the
  first call after whitelisting.
- `https://sandboxapi.bitnob.co` currently serves a **mismatched TLS
  certificate** and 404s all routes even with TLS verification disabled —
  the sandbox host is effectively unusable until Bitnob fixes it.
- Dev-container egress IP at test time: `47.57.232.232`.

### ⚠️ Required action to go live

1. Bitnob dashboard → **API Keys → IP whitelist** → add the production
   server's egress IP (and `47.57.232.232` if you want to test from the dev
   container).
2. Re-run the read-only probe: `node scripts/test_bitnob_auth.mjs` — expect
   `200` JSON balances/rates instead of the 403.
3. If you create webhooks, set `BITNOB_WEBHOOK_SECRET` to the value shown in
   the Bitnob dashboard and point `BITNOB_WEBHOOK_URL` at
   `https://api.metricorex.com/api/personal/webhooks/bitnob`.

### Troubleshooting

| Error surfaced | Meaning | Fix |
|----------------|---------|-----|
| `BITNOB_IP_WHITELIST` (HTTP 503) | 403 IP not whitelisted | Whitelist the server IP in the Bitnob dashboard. |
| `BITNOB_AUTH` (HTTP 502) | 401 signature/client mismatch | Check `BITNOB_CLIENT_ID` and `BITNOB_SECRET_KEY`. |
| Simulator labels in the apps | `isBitnobConfigured()` false | One of the two required vars is missing. |

Card amounts are **micro-units** internally: `1 USD = 1_000_000`
(`toMicros` / `fromMicros` in the provider client).

---

## 2. Prestmit — gift card buy + sell

**Files**: `server/services/prestmit.ts` (service client, verified live
against the sandbox during build) · `server/features/personal/prestmit.ts`
(feature client) · `server/features/personal/routes/giftcards.ts` ·
`server/routes/personal-webhooks.ts`.

**Auth**: `API-KEY` header + `Authorization: Bearer` twin. Sandbox and live
bases share the same path scheme (`/partners/v1`).

### Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRESTMIT_API_KEY` | ✅ | Partner API key — Prestmit Console → **Developers**. |
| `PRESTMIT_API_SECRET` | ✅ (feature client) | HMAC request-signing secret — **not** the webhook signing key. |
| `PRESTMIT_BASE_URL` | optional | Override. Sandbox `https://dev-api.prestmit.io/partners/v1`, live `https://api.prestmit.io/partners/v1`. |
| `PRESTMIT_SANDBOX` | optional | `true` → sandbox base (feature client). |
| `PRESTMIT_ENV` | optional | `live` → live base (service client default switching). |
| `PRESTMIT_WEBHOOK_SIGNING_KEY` | optional | Verifies `x-prestmit-signature` = `base64(HMAC_SHA256(key, raw body))` on webhooks; the sync cron polls history anyway when unset. |
| `PRESTMIT_ACCOUNT_PIN` | optional | Partner account 4-digit PIN — **required for `POST /giftcard-trade/buy/create`**. |
| `PRESTMIT_PUBLIC_KEY` / `PRESTMIT_PRIVATE_KEY` | optional | Key-pair presence flags surfaced by the admin Personal Products console. |

### Status & required action

The sandbox credentials entered in an earlier session were **lost with the
workspace reset** — the current `.env` only carries commented placeholders.
Re-enter from the Prestmit Console → Developers:

```env
PRESTMIT_API_KEY=<from console>
PRESTMIT_API_SECRET=<from console>
PRESTMIT_BASE_URL=https://dev-api.prestmit.io/partners/v1
PRESTMIT_WEBHOOK_SIGNING_KEY=<from console>
PRESTMIT_ACCOUNT_PIN=<4-digit partner PIN>
```

Sanity checks (read-only, once keys are in):
`GET /general/service-availability`, `GET /general/user` (wallet balance),
`GET /giftcard-trade/sell/rate-calculator-data` — all implemented in
`server/services/prestmit.ts` and previously verified live.

---

## 3. Flutterwave — cards · bills · transfers

**Files**: `server/services/providers/flutterwave.ts`,
`server/features/personal/flutterwave-bills.ts`, `FLUTTERWAVE_INTEGRATION.md`
(full integration doc). Keys are present in `.env`.

| Variable | Required | Description |
|----------|----------|-------------|
| `FLW_SECRET_KEY` / `FLUTTERWAVE_SECRET_KEY` | ✅ | `FLWSECK-...` server-side secret. **Live bills route through Flutterwave automatically when this is set** (Flutterwave *Bills* product must be enabled on the FLW account). |
| `FLW_PUBLIC_KEY` | ✅ | `FLWPUBK-...` — client-side inline checkout (v3.js). |
| `FLW_ENCRYPTION_KEY` / `FLUTTERWAVE_ENCRYPTION_KEY` | ✅ | `FLWSECK-...` encryption key for payload encryption. |
| `FLW_SECRET_HASH` | ✅ | Webhook verification hash — set the same value in the Flutterwave dashboard webhook settings. |
| `FLW_BASE_URL` | optional | Default `https://api.flutterwave.com`. |
| `FLW_MOCK` / `FLW_MOCK_OUTCOMES_FILE` | optional | Test-only mock harness flags. Never set in production. |

Webhook receiver: backend `server/routes/webhook.ts` — verify
`verif-hash` header against `FLW_SECRET_HASH`.

---

## 4. Monnify — virtual accounts & collections

| Variable | Required | Description |
|----------|----------|-------------|
| `MONNIFY_API_KEY` | ✅ | Monnify console API key. |
| `MONNIFY_SECRET_KEY` | ✅ | Monnify console secret (used for Base64 Basic auth token). |
| `MONNIFY_CONTRACT_CODE` | ✅ | Contract code for reserved accounts. |
| `MONNIFY_WALLET_ACCOUNT_NUMBER` | ✅ | Settlement wallet account number. |
| `MONNIFY_BASE_URL` | ✅ | `https://sandbox.monnify.com` or `https://api.monnify.com`. |

---

## 5. Squad — payment gateway

| Variable | Required | Description |
|----------|----------|-------------|
| `SQUAD_SECRET_KEY` | ✅ | `sandbox_sk_...` / `pk_live_...` secret key. |
| `SQUAD_ENV` | optional | `sandbox` (default) or `production`. |
| `SQUAD_BASE_URL` | optional | Override of the API base. |
| `DEFAULT_PAYMENT_PROVIDER` | optional | `squad` / `monnify` / `flutterwave` — default collection provider. |

---

## 6. Prembly — KYC verification

| Variable | Required | Description |
|----------|----------|-------------|
| `PREMBLY_API_KEY` | ✅ | Prembly (Identitypass) API key. |
| `PREMBLY_APP_ID` | ✅ | Prembly app id. |
| `PREMBLY_BASE_URL` | optional | Default live base. |
| `PREMBLY_TIMEOUT_SECONDS` | optional | Request timeout (default 30). |

---

## 7. SMS & WhatsApp

Provider selection: `DEFAULT_SMS_PROVIDER` = `termii` | `kudi` | `meta`
(factory in `server/services/sms-providers/`).

| Variable | Provider | Description |
|----------|----------|-------------|
| `TERMII_API_KEY` | Termii | Termii API key. |
| `TERMII_SENDER_ID` | Termii | Registered sender ID. |
| `TERMII_WHATSAPP_NUMBER` | Termii | WhatsApp sender number (OTP via WhatsApp). |
| `KUDI_API_KEY` / `KUDI_API_BASE` / `KUDI_SENDER_ID` | Kudi | Kudi SMS credentials. |
| `META_WHATSAPP_ACCESS_TOKEN` | Meta | Cloud API permanent token for WhatsApp sends. |

---

## 8. Email — SMTP + Brevo

| Variable | Description |
|----------|-------------|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | SMTP transport (`smtp-relay.brevo.com`, 587, `false` for STARTTLS). |
| `SMTP_USER` / `SMTP_PASS` | SMTP credentials (Brevo SMTP key pair). |
| `SMTP_FROM_EMAIL` / `SMTP_FROM_NAME` | Verified sender identity. |
| `BREVO_API_KEY` | Brevo API (transactional templates / contacts). |
| `BREVO_SENDER_EMAIL` / `BREVO_SENDER_NAME` / `BREVO_BASE_URL` / `BREVO_TIMEOUT_SECONDS` | Brevo API options. |
| `ADMIN_ALERT_EMAIL` / `DISPUTE_ADMIN_EMAILS` / `KYC_ADMIN_EMAILS` | Operational alert routing. |

---

## 9. Push notifications — Firebase + APNs + Web Push

| Variable | Description |
|----------|-------------|
| `FIREBASE_PROJECT_ID` | Firebase project for FCM v1. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Full service-account JSON (preferred on Netlify). |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | …or a path to the JSON file (droplet). |
| `FCM_SERVER_KEY` | Legacy FCM server key (fallback path). |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_P` / `APNS_ENV` | Apple Push: key id, team, bundle (`com.metricorex.app`), `.p8` contents, `production`/`sandbox`. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push keys (auto-generated on first boot when unset). |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional standard Google ADC path. |

---

## 10. RTC / calling — LiveKit + mediasoup

| Variable | Description |
|----------|-------------|
| `LIVEKIT_URL` | Client-facing wss endpoint. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Server API credentials for token minting. |
| `LIVEKIT_API_URL` | Host API base (room management). |
| `LIVEKIT_EGRESS_URL` | Egress service base (recordings). |
| `MEDIASOUP_PUBLIC_IP` / `MEDIASOUP_ANNOUNCED_IP` | Self-hosted SFU fallback (droplet). |
| `MEDIASOUP_RTC_MIN_PORT` / `MEDIASOUP_RTC_MAX_PORT` | UDP port range for media. |
| `MEDIASOUP_ALLOW_LOOPBACK` | Dev-only loopback ICE. |

Calling provider selection lives in `server/lib/calling/factory.ts`
(LiveKit → mediasoup fallback).

---

## 11. File storage — Cloudflare R2 + Cloudinary

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_R2_ACCOUNT_ID` | R2 account id. |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` / `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | R2 S3-compatible credentials. |
| `CLOUDFLARE_R2_BUCKET_NAME` | Target bucket. |
| `CLOUDFLARE_R2_PUBLIC_URL` | Public base URL for served assets. |
| `CLOUDINARY_URL` / `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Legacy/optional Cloudinary path. |

---

## 12. AI — MetricAi

| Variable | Description |
|----------|-------------|
| `GLM_API_KEY` | GLM (Z.ai) API key — chat/vision/image/video backbone. |
| `GLM_API_BASE` | Override of the GLM endpoint. |
| `GLM_CHAT_MODEL` / `GLM_VISION_MODEL` / `GLM_IMAGE_MODEL` / `GLM_VIDEO_MODEL` | Model selection per capability. |
| `GOOGLE_AI_KEY` / `OPENAI_API_KEY` / `OPENAI_VISION_MODEL` | Fallback vision providers. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_ANDROID_CLIENT_ID` / `GOOGLE_IOS_CLIENT_ID` | Google Sign-In audience checks. |

---

## 13. Core / platform variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL (Neon or droplet). |
| `JWT_SECRET` / `TOKEN_IDLE_TIMEOUT_MINUTES` | Auth signing + idle expiry. |
| `CLIENT_URL` / `ADMIN_URL` / `API_BASE_URL` / `API_PUBLIC_BASE_URL` / `APP_BASE_URL` | Canonical origins used for CORS, links and callbacks. |
| `CORS_ORIGINS` | Comma-separated allow-list (site, personal web, admin, mobile). |
| `REDIS_URL` / `DISABLE_REDIS` / `REDIS_CONNECT_TIMEOUT_MS` / `REDIS_MAX_RETRIES` | BullMQ queues + cache; disable when Redis is absent. |
| `PAYLOAD_ENCRYPTION_KEY` / `PAYLOAD_ENCRYPTION_DISABLED` | Request payload crypto. |
| `SENTRY_DSN` / `LOG_LEVEL` / `DB_LOG_QUERIES` | Observability. |
| `API_REQUEST_LOG_MODE` / `API_REQUEST_LOG_RETENTION_*` | Request audit log retention. |
| `LOGIN_MAX_FAILED_ATTEMPTS` / `LOGIN_LOCK_MINUTES` / `LOGIN_BLOCK_AFTER_LOCKS` / `ADMIN_LOGIN_*` | Brute-force protection. |
| `BILLS_PROVIDER_URL` / `BILLS_PROVIDER_API_KEY` | Optional external bills provider; leave unset to use Flutterwave bills. |
| `DEFAULT_SMS_PROVIDER` | SMS factory selection (see §7). |

---

## 14. Sogo — bills · gift cards · RMB · crypto off-ramp

**Files**: `server/services/sogo.ts` (service client + webhook verification) ·
`server/routes/personal-webhooks.ts` (`POST /webhook/sogo`) ·
`server/features/personal/provider-routing.ts` (routing defaults).

**Auth**: `Authorization: Bearer $SOGO_SECRET_KEY` (key prefix
`sogo_sk_test_` → sandbox, `sogo_sk_live_` → live; the base URL auto-routes on
the prefix unless `SOGO_BASE_URL` overrides it).

### Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SOGO_SECRET_KEY` | ✅ | Secret API key — Sogo developer profile. Decides sandbox vs live. |
| `SOGO_PUBLIC_KEY` | optional | Public key flag surfaced by the admin Personal Products console. |
| `SOGO_WEBHOOK_SECRET` | ✅ for webhooks | The endpoint **signing secret** Sogo shows when you register the webhook ("copy this signing secret"). Verifies `X-Sogo-Signature-256: sha256= + HMAC-SHA256(raw body, secret)` timing-safely. **Fail closed**: without it every Sogo webhook is answered `401` and nothing settles. |
| `SOGO_BASE_URL` | optional | Override (`https://sandbox.sogo.africa/v1` / `https://api.sogo.africa/v1`); the key prefix decides otherwise. |

### Where to put the signing secret

It is a **server environment variable, not code**: paste
`SOGO_WEBHOOK_SECRET=<the secret from the Sogo dashboard>` into the backend
hosting provider's environment (droplet `.env` / Render → service →
Environment) and restart/redeploy so `process.env` picks it up. Never commit
the real value — `.env` is gitignored and CI must not see it.

Local verification without waiting for Sogo traffic (signed curl, exit 0 +
`{"success":true}` means the secret matches):

```bash
BODY='{"event":"ping","data":{}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SOGO_WEBHOOK_SECRET" -hex | sed 's/^.* //')"
curl -s -X POST https://api.metricorex.com/api/webhook/sogo \
  -H "Content-Type: application/json" -H "X-Sogo-Signature-256: $SIG" -d "$BODY"
```

Every received webhook (accepted **and** signature-rejected) is recorded for
the Admin Console → **Webhooks** screen (provider `sogo`) with the event,
reference, full payload, signature verdict and processing outcome.

#### Live webhook shape (observed 2026-10-30, livemode) — read before debugging

- `data.object` is the **discriminator string** `"transaction"`; the real
  transaction fields sit directly in `data` (`data.reference`,
  `data.status: {value, is_final}`, `data.type: {value, is_credit}`,
  `data.amount: {raw, currency, formatted}`, `data.metadata`, `data.timestamps`).
- `data.reference` is **Sogo's own `BILL…` reference** — Sogo does not echo our
  Idempotency-Key in webhooks. Our row's `provider_reference` is captured from
  the purchase response (or backfilled from the webhook by amount + customer
  ref + category + creation window) and is the reconciliation key.
- Statuses use their own vocabulary (`successful`/`delivered`/`failure`/
  `canceled`) — all normalized to `completed|failed|refunded|cancelled`.
- Bill events are **reconfirmed** against `GET /transactions/{ref}` before
  settlement; on contradiction the row is left untouched for reconciliation.
- Dropped/acknowledged events can be re-driven after a fix with
  `POST /api/admin/webhooks/sogo/{squad_webhooks.id}/replay` (Admin token) —
  Sogo never resends events that were ACKed 200.

---

## Deployment checklist

1. **Droplet `.env`** — mirror every section above; the file is gitignored, so
   copy values manually (or via your secrets manager) — never `scp` the dev
   `.env` blindly.
2. **Netlify function env** (backend + personal web functions) — set at least:
   `DATABASE_URL`, `JWT_SECRET`, `CLIENT_URL`, `CORS_ORIGINS`,
   `FLW_*`, `PRESTMIT_*`, `BITNOB_*`, `FIREBASE_SERVICE_ACCOUNT_JSON`,
   `GLM_API_KEY`, Brevo/SMTP, `VAPID_*`.
3. **Bitnob** — whitelist the production egress IP, then
   `node scripts/test_bitnob_auth.mjs` from the droplet must return 200.
4. **Prestmit** — re-enter keys (see §2), then run the three read-only sanity
   GETs.
5. **Webhooks to register in dashboards**:
   - Bitnob → `https://api.metricorex.com/api/personal/webhooks/bitnob`
   - Prestmit → same handler family (`personal-webhooks.ts`), signed with
     `PRESTMIT_WEBHOOK_SIGNING_KEY`
   - Sogo → `https://api.metricorex.com/api/webhook/sogo`, and store the
     signing secret it shows as `SOGO_WEBHOOK_SECRET` (see §14)
   - Flutterwave → backend `/api/webhook` with `verif-hash` = `FLW_SECRET_HASH`
   - Monnify → backend monnify webhook route
