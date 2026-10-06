# Metricorex — Backend API

The backend powering **Metricorex** (project: Metroflow) — an all-in-one business operations platform that combines team workspace, WhatsApp-style chat, video meetings/calls, project management, and a full fintech suite (wallets, transfers, international payouts, payroll) behind plan-based subscriptions.

- **Production API**: `https://api.metricorex.com` (Express + Node, PM2 on VPS, port 3000)
- **Web app**: `metricorex.com` (Netlify) — repo `metroflow-app`
- **Mobile app**: Flutter (Android/iOS) — repo `metroflow-mobile`
- **Admin console**: Netlify — repo `metroflow-admin`
- **Marketing site**: Netlify — repo `metroflow-site`
- **Swagger docs**: served at `/api-docs` from `server/swagger-output.json` (regenerate with `npx tsx scripts/generate-swagger.ts`)

---

## Platform Overview

### Team Workspace
- Multi-tenant businesses with role-based members (owner / admin / manager / member), plan-based feature permissions.
- Tasks, Kanban board, backlog, epics, sprints, task statuses (custom per business), comments with mentions & reactions, **file attachments on tasks** (images/videos/documents, WhatsApp-style), activity logs, rankings/leaderboards, product documentation generator (OpenAI / Gemini / **free GLM** — switchable via `AI_PROVIDER`).

### Chat (WhatsApp-style)
- Direct & group conversations, display names/avatars, unread badges.
- **Attachments**: images, videos, documents, GIFs (Tenor), stickers — send, view, play, download on web and mobile (up to 100 MB per file).
- Voice notes with in-bubble player (seek + speed), emoji/sticker/GIF picker, big-emoji rendering, call-log messages linked to conversations.

### Calls & Meetings (RTC)
- 1:1 audio/video calls + group calls + meeting rooms with waiting rooms, co-hosts, meeting passwords, join-by-code/link, guest access.
- Mediasoup SFU on the backend (`server/lib/mediasoup.ts` + Socket.IO signaling in `server/lib/socket.ts`), Redis-backed waiting-room queue with in-memory fallback.
- Meeting recordings, screen share, in-call chat, call duration limits enforced from the caller's plan.

### MetricAi (built-in AI assistant, like Meta AI in WhatsApp)
- Powered by the **free GLM models from Z.ai** — no cost per user, no user-supplied keys.
  - Chat: `glm-4-flash` (OpenAI-compatible endpoint)
  - Image generation: `cogview-3-flash`
- **Plan-gated**: admins toggle `metric_ai_enabled` on a pricing plan; only subscribers of that plan can chat (`GET /ai/status`, enforced by `requireMetricAiAccess`).
- Knows the whole Metricorex platform + answers general questions, generates images, and detects when a user needs a human (`suggestHumanSupport`).
- **Human handoff** into the Support desk (see below), on web, mobile and the public website.
- **Public "Ask MetricAi"**: `POST /api/public/metric-ai/ask` lets any website visitor chat for help/support (session-based, IP rate-limited), with escalation to human support.

### Customer Support Desk
- MetricAi handoff or direct requests create **support conversations** with the full chat transcript attached.
- Guests (website widget) chat via a per-conversation `access_key`; logged-in users via JWT; agents via admin token + `support` permission.
- **Admin Support dashboard**: inbox with status filters (open / pending / resolved / closed) + search, live chat (polling with `?after=` cursor), assign-to-me, conclude conversation, loud ringtone on new customer messages, in-app notifications (`admin_notifications`), support stats and a MetricAi activity feed.
- Agents are platform admins whose role carries the `support` permission (super admins always have access). Customers get FCM push + in-app notifications on agent replies.

### Fintech
- Multi-currency wallets (NGN/USD), funding via card (Monnify / Squad / Flutterwave providers), virtual accounts (personal & business, business-name VAs, regeneration).
- Transfers (single/bulk) with admin-toggled payout provider, account lookup, transfer history with filters + CSV export.
- **International payouts via Flutterwave** with live FX quotes, admin markup % + fee % + **hidden spread %**, quote lock windows (`expires_at`), server-side pricing enforcement and auto-reversal on every failure path, three-ledger accounting: debit user wallet → credit platform wallet → credit revenue wallet (fees + markup), all recorded idempotently with historical backfill.
- **Epic transfers** — one-off payments to multiple recipients from an epic, NGN + USD rows validated per corridor (10-digit NGN accounts, ABA checksum + account type for USD).
- Payroll: employees (NGN & USD recipients), **Excel template with a Banks sheet + dropdown + VLOOKUP bank-code autofill**, invite emails, **bank-account verification** (only verified employees enter payout), bulk verification, salary payouts honoring verification.
- Transaction OTP/PIN, KYC (BVN/NIN/business docs via Prembly), biometric unlock, login-attempt alert emails.

### Revenue Features (all plan-configurable via /admin/pricing)
Five monetised surfaces, each wired into `pricing_plans` (feature toggles + limits + fee discounts that admins control per plan) and settled through the platform revenue wallet. (Bills Hub and Savings Vaults were reclassified as **Personal app** features and moved to the dormant `server/features/personal/` folder — see that folder's README.)

1. **Storefront** (`/api/store`) — the Metroflow Store: businesses list products/services in a shareable storefront; customers order through the public page (`/store/public/:businessId`) and pay via hosted checkout. Every successful order credits the merchant wallet net of an order fee (fee type `store_order`, 2.5% capped ₦2,000 default) reduced by the plan's `store_fee_discount_percent`; stock decrements automatically and paid orders are fulfilment-tracked. Plan cap via `max_store_products` (ladder: 5 on Free Trial · 25 on Starter · unlimited on Pro). Admin overview: `GET /api/admin/store`.
2. **Recurring Billing** (`/api/recurring`) — customer subscriptions: merchants create daily/weekly/monthly plans and share public subscribe links. Subscribers whose email maps to a Metroflow user are auto-charged from their wallet by the 5-minute cron engine (`processDueSubscriptionCharges`, idempotent via `next_charge_date` claiming); everyone else receives an emailed hosted-checkout link per cycle. Each successful charge credits the merchant net of the platform fee (fee type `subscription`, 2% capped ₦1,500 default) reduced by `subscription_fee_discount_percent`; plan caps via `max_subscription_plans` (ladder: 2 on Free Trial · 25 on Starter · unlimited on Pro), and 3 consecutive failed wallet charges pause the subscriber as `past_due`. Admin overview: `GET /api/admin/subscriptions`.
3. **Payment Links** (`/api/payment-links`) — shareable checkout links (fixed or customer-chosen amount) with public `/pay/:slug` pages; 1.5% capped ₦2,000 collection fee (type `payment_link`) reduced by `payment_link_fee_discount_percent`, link count limited by `max_payment_links`. Settled by the payment webhooks. Admin overview: `GET /api/admin/payment-links`.
4. **Smart Invoices** (`/api/invoices`) — itemised invoices (line items, tax, due date) with public `/invoices/:id/pay` checkout; 1% capped ₦2,500 settlement fee (type `invoice`) reduced by `invoice_fee_discount_percent`, monthly creation capped by `max_invoices_per_month`. Overdue is computed on read; settled by the payment webhooks. Admin overview: `GET /api/admin/invoices`.
5. **MetricAi Credit Packs** (`/api/ai-credits`) — one-time AI credit top-ups purchasable from any wallet when a plan's MetricAi allowance runs out; plan-level `ai_credit_discount_percent` prices packs per plan. Admin manages packs via `/api/admin/ai-credit-packs`.

### Platform Operations (Admin)
- Role & permission management (roles carry permission slugs; includes `support`, `view_request_logs`, `decrypt_request_logs`), admin management.
- Payment provider toggles (global + transfer provider), fees & international transfer config (markup + spread), platform/revenue ledgers with movements + reconciliation.
- **Activity Logs** (`/admin/request-logs`): every user + admin API request with actor/email/phone search, type/method/path/status/date filters, stats, per-log **decrypt** (permission-gated) revealing endpoint + payload + response.
- **Locked Accounts** (`/admin/locked-accounts`): see and resolve login-lockout escalations (5 failed passwords → 30-min lock; 3 cycles → permanent block until an admin resolves).
- Maintenance mode (emails + pushes all users), announcements ticker, broadcast email/push, KYC review, webhook monitoring, subscriptions & pricing plans (incl. per-plan RTC limits and MetricAi toggle).

### Notifications
- In-app notifications + FCM push (HTTP v1, token registry with auto-pruning) with **multi-channel delivery fallback**: pushes fan out to **every registered device** of the user, incoming calls are delivered as Android data-only messages (the app renders the full-screen ringing UI itself), a hybrid retry fires when FCM reports 0 delivered, and chat/call events additionally fall back to **Web Push (VAPID)** for browsers (`POST /push/subscribe` accepts both flat and nested subscription payloads).
- Login-attempt emails with device info, welcome emails, task notifications, support desk notifications.
- Maintenance/announcement/broadcast pipelines.

---

## E2E Payload Encryption (x-mfv-enc)

Every JSON request/response body can travel as an **AES-256-GCM envelope** `{ v, iv, tag, ct }` so the browser/app network inspector never shows raw payloads.

- **Opt-in per client**: a request carries `x-mfv-enc: 1` (all clients send it on every request once `*_PAYLOAD_ENCRYPTION_KEY` is configured) → the server decrypts envelope bodies and encrypts **every response** (success AND error paths, GETs included).
- **Backward compatible**: keyless servers, old clients, multipart uploads, provider webhooks and infra paths (`/health`, `/api-docs`, …) bypass entirely — mismatched deployments degrade, never break (clients retry once in plaintext on `400 DECRYPT_FAILED`).
- **Audit trail**: the request logger stores each request/response (payloads **encrypted at rest**, secrets redacted) into `api_request_logs`. Admins with `view_request_logs` browse them in the Activity Logs screen; `decrypt_request_logs` (super-admin bypass) unlocks `POST /admin/request-logs/:id/decrypt` which returns the plaintext bodies. If the key was rotated, decrypt answers `409 DECRYPT_KEY_MISMATCH`.
- **Client keys**: web/admin `VITE_PAYLOAD_ENCRYPTION_KEY`, mobile `EXPO_PUBLIC_PAYLOAD_ENCRYPTION_KEY` — all MUST equal the backend value. **Rotating the key makes previously stored encrypted log rows undecryptable.**

---

## Tech Stack

- **Runtime**: Node.js + Express (REST + Socket.IO), Mediasoup SFU
- **Database**: PostgreSQL (Neon) via `pg`, Prisma schema in `prisma/schema.prisma`, idempotent runtime migrations in `server/migrations.ts`
- **Storage**: Cloudflare R2 → Cloudinary → local `/uploads` fallback chain (`server/services/media-upload.ts`)
- **Auth**: JWT (users) + admin token system (platform admins), Google SSO
- **Email**: Brevo (fallback SMTP), **SMS/WhatsApp**: Kudi / Termii / Meta WhatsApp, **Push**: FCM
- **AI**: Z.ai GLM (`glm-4-flash` + `cogview-3-flash`), OpenAI, Gemini — `AI_PROVIDER` env toggle for document generation
- **Payments**: Monnify, Squad, Flutterwave (collections + transfers + FX)
- **Testing**: Vitest (`npx vitest --run`)

## Environment

Key variables (see `ENVIRONMENT_SETUP.md` for the full list):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection (Neon pooler) |
| `JWT_SECRET` | User JWT signing |
| `GLM_API_KEY` | **Required for MetricAi + GLM doc generation** (free from Z.ai; aliases `ZAI_API_KEY` / `Z_AI_API_KEY`) |
| `GLM_CHAT_MODEL` / `GLM_IMAGE_MODEL` / `GLM_API_BASE` | Optional GLM overrides (defaults: `glm-4-flash`, `cogview-3-flash`, `https://api.z.ai/api/paas/v4`) |
| `AI_PROVIDER` | Document-generation provider: `openai` \| `google` \| `glm` |
| `TENOR_API_KEY` | Optional — enables the chat GIF picker |
| `CLOUDINARY_URL` / R2 vars | Upload storage chain |
| `BREVO_API_KEY` | Transactional email |
| `FCM_*` | Push notifications |
| `VAPID_*` (public/private/subject) | Web Push for browsers (incoming-call rings when the tab is closed) |
| `PAYLOAD_ENCRYPTION_KEY` | **E2E payload encryption** — 32-byte base64 key shared with all clients. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Unset = plaintext mode (fully backward compatible). |
| `PAYLOAD_ENCRYPTION_DISABLED` | Set `true` to force-disable encryption even when a key exists |
| `API_REQUEST_LOG_MODE` | Request audit trail volume: `all` (default) \| `writes` \| `off` |
| `API_REQUEST_LOG_RETENTION_DAYS` | Daily purge of `api_request_logs` (default 30) |
| `REDIS_URL` | `redis://127.0.0.1:6379` on the VPS — powers the waiting-room queue + caching. `/health` reports `{configured, connected, reason}` diagnostics; **`DISABLE_REDIS=true` disables Redis entirely** (remove it to enable) |
| `SUPPORT_ALERT_EMAIL` | Optional email ping on new support requests |

| `JOBS_SECRET` | Optional shared secret for `/internal/jobs/*` endpoints |

## Local Development

```bash
npm install
npm run build        # tsc build
npm start            # run from dist
npx tsx server/index.ts   # dev
npx vitest --run          # tests
npx tsc --noEmit          # typecheck
npx tsx scripts/generate-swagger.ts   # regenerate swagger-output.json
```

## Deployment (VPS)

One-shot deploy + verification (recommended — handles a dirty working tree safely, pulls, installs, builds, restarts pm2 and verifies the new build is actually serving via `/api/health`, including a live MetricAi probe):

```bash
bash scripts/deploy.sh
```

Notes:
- Local drift in generated `server/swagger-output.json` is discarded automatically (it is rebuilt during the build); any other uncommitted edits are stashed and can be restored with `git stash pop`.
- `GET /api/health` (public, no secrets) reports `db`, `metricAi.configured`, `gifs.configured`, `storage`, uptime and node version — useful for ops dashboards and post-deploy checks.

Manual equivalent:

```bash
git pull && npm install && npm run build
pm2 restart metroflow
```

Migrations run automatically on boot (`runPostInitializeMigrations`): support-desk tables, `admin_notifications`, `ai_messages`, chat attachment columns, payroll verification columns, ledger backfill, plan `metric_ai_enabled`, and more — all idempotent.

## Branching

- `main` — production. What the VPS runs (`api.metricorex.com`).
- `develop` — integration branch. Changes land here first and are verified, then a PR `develop → main` is merged for release.
- Hotfixes may branch from `main` and be merged back into `develop` to keep them in sync.

## Support Desk Permissions

1. Admin console → Roles → create/edit a role (e.g. "Customer Support") and grant the **Customer Support (`support`)** permission.
2. Admins → add an admin with that role.
3. The Support dashboard (`/support`) appears for that admin; super admins always see it.

## API Documentation

Swagger UI: `/api-docs`. The spec is generated from JSDoc annotations in `server/routes/*.ts` (`npm run generate-swagger`) and served from `server/swagger-output.json`.

Coverage now includes **every endpoint of the five revenue features** — Storefront (`Storefront`), Recurring Billing (`Recurring Billing`), Payment Links (`Payment Links`), Smart Invoices (`Smart Invoices`) and MetricAi Credits (`MetricAi Credits`), plus their admin overviews (`/admin/store`, `/admin/subscriptions`, `/admin/invoices`) — alongside auth, team, tasks (+attachments), epics, comments, chat (+media/GIFs), calls, meetings, recordings, MetricAi (+public Ask), support desk, wallet, transfers, payroll, KYC, settings, notifications, subscriptions and the admin API. (Personal-app endpoints — Bills, Savings — are intentionally not documented here; they live dormant in `server/features/personal/`.)

### Plan configuration (admin)
All five revenue features are wired into `pricing_plans` and editable per plan through `PUT /admin/pricing` with: `store_enabled`, `max_store_products`, `store_fee_discount_percent`, `recurring_enabled`, `max_subscription_plans`, `subscription_fee_discount_percent`, `payment_links_enabled`, `max_payment_links`, `payment_link_fee_discount_percent`, `invoices_enabled`, `max_invoices_per_month`, `invoice_fee_discount_percent`, and `ai_credit_discount_percent`.
