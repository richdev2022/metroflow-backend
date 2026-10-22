# MetriCorex Expansion Master Plan — Fraud, Compliance, Personal App & Provider Integrations

**Date:** 2026-10-21 · **Owner:** Engineering · **Status:** In execution
**Scope of record:** backend (`metroflow-backend`), admin (`metroflow-admin`), business web (`metroflow-app`), marketing site (`metroflow-site`), mobile (`Metroflow-Mobile`), and the two new Personal repos (`metricorex-personal-web`, `metricorex-personal-mobile`).

---

## 0. Executive Summary

This plan covers everything required to deliver, end to end:

1. **Free-forever plan fix** — the blocking "Subscription Required" modal (already fixed on `main`, deployment blocked — see §11).
2. **A rules-based fraud engine** on every inflow and outflow with four outcomes: `allow`, `flag` (allow + human review), `hold` (freeze until review / due diligence), `reject` (auto-decline before the money ever hits our position).
3. **A due-diligence (EDD) workflow** — auto-raised when a transaction is held; user submits an evidence form; a compliance-role admin approves / rejects / escalates; releasing a held transaction is one click.
4. **A fraud & compliance console in admin** — rule configuration, live monitoring queues, decisions, audit trail.
5. **Admin APK distribution** — upload the Android APK, set the Play Store link, and give the marketing site a "direct APK download" path for users who cannot use the Play Store.
6. **App availability toggles** — admin switches the Business and Personal apps ON/OFF; the marketing site swaps the "Join the wishlist" section for real CTAs when ON.
7. **MetriCorex Personal** — new web app (`metricorex-personal-web`) and new mobile app (`metricorex-personal-mobile`), built by reusing the Business apps' components/styles/functions; shared login, shared wallet, and KYC-gated Business features inside the Personal app (and vice versa).
8. **Provider integrations** — Flutterwave bill payments (all categories, fetched live from the API, never hardcoded), Prestmit gift cards (buy + sell), and eSIM top-ups; the marketing site mirrors the live bill categories.
9. **Marketing site expansion** — the full Personal feature story (wallets, gift cards, eSIM, bills, chat, streams, polls, marketplace, savings, virtual cards, social feed), the ten service tiles, and the three-step "How it works".

Everything is designed to reuse existing infrastructure (wallet ledger, providers factory, plan permissions, media upload, admin RBAC, app_versions) rather than invent parallel systems.

---

## 1. Current-State Audit (what already exists and is reused)

| Area | Existing asset | Reuse strategy |
|---|---|---|
| Money movement | `server/services/transfer.ts` (single/bulk payout, re-drive cron), `server/routes/webhook.ts` (Flutterwave/Monnify/Squad funding), `server/routes/wallet.ts` | Fraud hooks wrap these call sites — no parallel ledger |
| Providers | `server/services/providers/{factory,flutterwave,monnify,squad}.ts` | Same factory pattern extended with `billsProvider` + `giftcardProvider` |
| Personal scaffolds | `server/features/personal/{bills,savings,bills-provider,schema}.ts` (dormant, documented reactivation steps) | Reactivate exactly per `features/personal/README.md` |
| Admin RBAC | `AdminRole` / `AdminPermission` / `requirePermission()`; finance, settings, disputes permissions already exist | Add `manage_fraud` and `manage_compliance` permissions; grant compliance role both |
| Releases | `app_versions` table + `GET /admin/app-versions` + public `GET /api/public/app-links` (`play_store_url`, `app_store_url`) | Extend with APK upload + `apk_url` |
| File storage | `server/services/media-upload.ts` (R2 → Cloudinary → local fallback), multer 500 MB limit | APK uploads reuse `uploadMediaBuffer` |
| Plan gating | `checkFeaturePermission()` middleware (trial-aware, permission lists) | Personal features gated the same way |
| KYC | `kyc` routes, `KycPrompt`/`KycBusiness` pages, `checkKycStatus` middleware | Personal↔Business cross-prompts reuse these |
| Site | `DownloadAppSection` (already reads `/api/public/app-links`), wishlist form (`GrowthWishlist` backend), `personal/` components | Extend, don't rebuild |
| Fees | `fee_configurations` + `server/services/fees.ts` | Bills/gift-card convenience fees reuse this |

**Known live facts (verified today):** business `RWT3B4C` is on `Free Forever` (price 0.00, `subscription_status=active`, trial lapsed 2026-10-10) — the old web bundle wrongly walls it behind "Subscription Required".

---

## 2. Free-Forever Plan Fix (WS-A) — DONE, deploy-pending

- **Root cause:** `metroflow-app/client/components/layout.tsx` showed the blocking dialog when a price-0 plan's signup trial lapsed. Free plans never expire.
- **Fix (commit `a48fdbd`, merged to `main` 7b1b730):** only *paid* plans that are neither active nor inside their trial get the wall; `Subscription.tsx` renders free plans as Active with "Free plan — no billing required".
- **Verified:** live API returns `plan_price=0.00, subscription_status=active` for the affected business; the deployed bundle still contains the old predicate (`plan_price==="0.00"`) — i.e. the only missing step is a Netlify deploy (§11).
- **Residual risk:** none in code. Backend renewal cron already keeps free plans active and renews silently.

---

## 3. Fraud Engine (WS-B)

### 3.1 Design principles

- **Single evaluation point, two directions:** `server/services/fraud.ts` exposes `evaluateOutflow(ctx)` and `evaluateInflow(ctx)`. Every money-moving endpoint calls exactly one of them before committing.
- **Fail-open with alarm:** if the fraud service itself throws, the transaction proceeds but a `system_error` flag is recorded — availability beats false positives, and we still see the failure.
- **Decisions are recorded, never silent:** every evaluation writes a `fraud_evaluations` row (inputs snapshot, matched rules, score, decision) even when the decision is `allow`.
- **No position risk from rejects:** `reject` fires *before* any wallet debit or provider call. `hold` fires after debit-at-initiation semantics are decided per flow (see 3.4).

### 3.2 New tables (idempotent DDL in `server/migrations.ts`)

```sql
CREATE TABLE IF NOT EXISTS fraud_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(80) UNIQUE NOT NULL,          -- e.g. OUT_VELOCITY_COUNT_1H
  name VARCHAR(160) NOT NULL,
  description TEXT,
  direction VARCHAR(10) NOT NULL,            -- inflow | outflow | both
  category VARCHAR(40) NOT NULL,             -- velocity | amount | device | geo | blacklist | mule | account | beneficiary | schedule | structuring
  is_enabled BOOLEAN DEFAULT TRUE,
  action VARCHAR(10) NOT NULL DEFAULT 'flag',-- allow | flag | hold | reject
  threshold JSONB,                           -- rule-specific knobs (window, limit, multiplier ...)
  weight INTEGER DEFAULT 10,                 -- score contribution when triggered
  priority INTEGER DEFAULT 100,              -- evaluation order (rejects first)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fraud_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  transfer_reference VARCHAR(255),
  direction VARCHAR(10) NOT NULL,            -- inflow | outflow
  flow VARCHAR(40) NOT NULL,                 -- transfer|bill|giftcard|funding|withdrawal|esim
  user_id UUID,
  business_id VARCHAR(255),
  wallet_id UUID,
  amount DECIMAL(15,2),
  currency VARCHAR(3) DEFAULT 'NGN',
  context JSONB,                             -- ip, device, user_agent, beneficiary, channel ...
  score INTEGER DEFAULT 0,
  decision VARCHAR(10) NOT NULL,             -- allow|flag|hold|reject|system_error
  matched_rules JSONB,                       -- [{code,name,weight,action,threshold_snapshot}]
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fraud_eval_tx ON fraud_evaluations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_fraud_eval_decision ON fraud_evaluations(decision, created_at);

CREATE TABLE IF NOT EXISTS fraud_cases (     -- human worklist (flag/hold/reject-review)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id UUID REFERENCES fraud_evaluations(id),
  transaction_id UUID,
  transfer_reference VARCHAR(255),
  direction VARCHAR(10),
  user_id UUID,
  business_id VARCHAR(255),
  amount DECIMAL(15,2),
  currency VARCHAR(3) DEFAULT 'NGN',
  status VARCHAR(20) DEFAULT 'open',         -- open | released | rejected | escalated | expired
  decision_notes TEXT,
  assigned_admin UUID,
  decided_by UUID,
  decided_at TIMESTAMP,
  due_diligence_id UUID,                     -- link when EDD was required
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fraud_cases_status ON fraud_cases(status, created_at);

CREATE TABLE IF NOT EXISTS fraud_blacklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(20) NOT NULL,                 -- user | business | device | ip | bank_account | phone
  value VARCHAR(255) NOT NULL,
  reason TEXT,
  created_by UUID,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (type, value)
);
```

Held *money* is tracked on the flow rows themselves (see 3.4) — no parallel balance system.

### 3.3 Rule catalogue (seeded defaults, all admin-tunable)

**Outflow (before any debit):**
| Code | Logic | Default threshold | Default action |
|---|---|---|---|
| OUT_AMT_LIMIT_HARD | single amount > hard ceiling | ₦5,000,000 | reject |
| OUT_AMT_LIMIT_REVIEW | single amount > review ceiling | ₦2,000,000 | flag |
| OUT_VELOCITY_COUNT_1H | > N debits in 1h | 10 | flag |
| OUT_VELOCITY_COUNT_24H | > N debits in 24h | 25 | flag |
| OUT_VELOCITY_SUM_24H | 24h out-sum > X | ₦10,000,000 | hold |
| OUT_STRUCTURING | ≥3 debits in 24h each in [0.9X, X) just below the review ceiling | 3 txns | reject |
| OUT_NEW_BENEFICIARY_LARGE | first transfer to this beneficiary > X | ₦500,000 | flag |
| OUT_NEW_BENEFICIARY_XLARGE | first transfer > XL | ₦2,000,000 | hold |
| OUT_DEVICE_CHANGE_LARGE | amount > X from a never-seen device/IP | ₦1,000,000 | hold |
| OUT_IMPOSSIBLE_TRAVEL | last login geo → now geo faster than flight | 900 km/h | hold |
| OUT_BLACKLIST | beneficiary account / device / ip / user on blacklist | — | reject |
| OUT_MULE_IN_OUT | ≥70% of recently credited funds leaving within T | 70% / 6h | hold |
| OUT_NIGHT_OWL_LARGE | amount > X between 00:00–04:59 with no night history | ₦1,000,000 | flag |
| OUT_ACCOUNT_AGE | account < 24h old and 24h out-sum > X | ₦200,000 | hold |
| OUT_BENEFICIARY_VELOCITY | same new beneficiary hit by ≥N senders in 24h | 3 senders | reject |

**Inflow (at webhook credit, before balance update):**
| Code | Logic | Default | Action |
|---|---|---|---|
| IN_BLACKLIST_FUNDING | sender account/device/ip blacklisted | — | hold (freeze, don't credit) |
| IN_MULE_PATTER | ≥N distinct senders → same wallet in 24h, then outflow attempt | 5 | flag |
| IN_VELOCITY_COUNT_24H | > N funding txns in 24h | 30 | flag |
| IN_AMT_ANOMALY | amount > 20× user's 90-day mean funding | 20× | flag |
| IN_RAPID_PUMP | wallet funds > X in 1h from ≥3 channels | ₦5,000,000 | hold |
| IN_REVERSAL_ABUSE | ≥2 charged-back/reversed fundings in 90d | 2 | hold |
| IN_DORMANT_JUMP | dormant ≥90d account suddenly funds > X | ₦1,000,000 | flag |

Scoring: decisions are the **max** action among matched rules (reject > hold > flag > allow); ties broken by priority; score = Σ weights of matched rules (shown to admins as a risk score 0–100 capped).

### 3.4 HOLD semantics per flow (no position risk)

- **Transfers (outflow):** transfer row is created with `status='held'` and the **wallet is NOT debited**. Release → normal execution path (debit + provider payout). Reject → transfer `status='failed'` with reason `fraud_hold_rejected`, wallet untouched.
- **Bills / gift cards / eSIM (outflow):** order row `status='held'`, wallet not debited; same release/reject path.
- **Funding (inflow):** webhook receives the event but the wallet is **not credited**; a fraud case is opened; the raw gateway payload is retained for the reviewer. Release → manual credit via an audited admin action (creates the normal credit rows + notification). Reject → recorded, no credit; blacklist option surfaced.
- **User visibility:** held *outflows* appear in the wallet/transactions list as "Under review" with the EDD hint (WS-E).

### 3.5 Integration points (exact call sites)

| Flow | File | Hook |
|---|---|---|
| Single transfer | `routes/transfers.ts` `/single` | after validation, before ledger write → `evaluateOutflow({flow:'transfer',...})` |
| Bulk transfer | `routes/transfers.ts` `/bulk` | per-item evaluate; any reject/hold marks the item, batch continues per current semantics |
| Funding webhooks | `routes/webhook.ts` (Flutterwave + Monnify + Squad credit paths) | before `balance = balance + ...` → `evaluateInflow(...)` |
| Wallet withdrawal | `routes/wallet.ts` withdrawal endpoint | `evaluateOutflow({flow:'withdrawal',...})` |
| Bills (reactivated) | `features/personal/bills.ts` create | `evaluateOutflow({flow:'bill',...})` |
| Gift cards | new `features/personal/giftcards.ts` create (buy & sell) | `evaluateOutflow`/`evaluateInflow` respectively |
| eSIM | new `features/personal/esim.ts` purchase | `evaluateOutflow({flow:'esim',...})` |

Context captured per evaluation: `ip` (x-forwarded-for), `user_agent`, `user_id`, `business_id`, wallet, amount, currency, beneficiary (account/bank/name), device fingerprint (client header `x-device-id` when present), session age, recent-history aggregates.

---

## 4. Due Diligence / EDD (WS-C) + User Surface (WS-E)

### 4.1 Data model

```sql
CREATE TABLE IF NOT EXISTS due_diligence_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fraud_case_id UUID UNIQUE,                 -- 1:1 with the hold that raised it
  user_id UUID NOT NULL,
  business_id VARCHAR(255),
  status VARCHAR(20) DEFAULT 'pending',      -- pending | submitted | under_review | approved | rejected | expired
  form_schema VARCHAR(20) DEFAULT 'v1',
  submission JSONB,                          -- answers + uploaded file urls
  reviewed_by UUID,
  reviewed_at TIMESTAMP,
  review_notes TEXT,
  auto_opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reminder_sent_at TIMESTAMP,
  expires_at TIMESTAMP,                      -- default +14 days; expiry auto-rejects held txns
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS due_diligence_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID REFERENCES due_diligence_cases(id) ON DELETE CASCADE,
  field_key VARCHAR(80) NOT NULL,
  file_url TEXT NOT NULL,
  file_name VARCHAR(255),
  mime_type VARCHAR(120),
  size_bytes BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 4.2 Automation

1. When a `hold` decision lands, a `fraud_cases` row is created **and** a `due_diligence_cases` row auto-opens (status `pending`), linked both ways.
2. User is notified (in-app + email): "A transaction needs extra verification" with a deep link.
3. Dashboard/wallet banner: "You have N transaction(s) on hold — complete verification to release them" → `/due-diligence`.
4. Daily cron: pending cases older than 72h get a reminder; `expires_at` lapse auto-rejects the linked holds (funds stay in wallet; transfer fails with clear reason).
5. Release (approve): reviewer clicks Approve → held transfer(s) resume the normal execution path automatically; the case, the fraud case and the evaluation are stamped.
6. Reject: reviewer rejects → held transfer(s) fail with `fraud_hold_rejected`; optional "blacklist beneficiary" checkbox on the reject form.

### 4.3 Form v1 (all fields stored in `submission` JSONB)

- Purpose of the transaction (select + free text)
- Source of funds (salary / business revenue / gift / investment / other + explanation)
- Relationship to beneficiary (self / family / business partner / customer / other)
- Expected monthly volume + average transaction size (for limit tuning)
- Occupation / business type
- Supporting documents (bank statement, invoice, ID) — ≤3 files, 10 MB each, reuse media upload
- Attestation checkbox (truthful information)

### 4.4 User app surface (WS-E)

- `GET /api/fraud/holds` (authed) → list of the user's held items (type, amount, status, DD case status).
- Dashboard + Wallet mount a dismissible `HeldTransactionsBanner` when that endpoint returns >0 rows.
- `/due-diligence` page: reads the auto-opened case, renders form v1, uploads docs, submits → status `submitted`, banner switches to "Under review".

---

## 5. Admin Fraud & Compliance Console (WS-D)

New admin pages, both gated on new permissions:

- **Fraud overview** (`/fraud`) — KPI cards (open flags, open holds, 24h rejects, avg review time), decision volume chart, recent evaluations feed.
- **Cases queue** (`/fraud/cases`) — filter by status/direction/flow/amount/risk-score; case drawer shows full evaluation context (matched rules with thresholds, IP/device, beneficiary, history aggregates) and actions: Release / Reject / Escalate / Mark handled, with mandatory notes on reject.
- **Rules editor** (`/fraud/rules`) — table of all rules: enable/disable, change action, edit thresholds (typed JSON form per category), reorder priority. Changes are audited.
- **Blacklists** (`/fraud/blacklists`) — add/remove entries (type+value+reason), search.
- **Due diligence** (`/compliance/due-diligence`) — queue (pending/submitted/under_review), detail view with documents preview, Approve (releases linked holds) / Reject (+optional blacklist) / request more info (notes → user sees them).
- **RBAC:** new permissions `manage_fraud` (rules, blacklists, cases) and `manage_compliance` (DD queue + decisions). Super admin sees both; compliance role template gets `manage_compliance` + read-only fraud views.

Admin API (all under `requirePermission`, audited via existing audit service):
`GET/POST/PATCH /admin/fraud/rules`, `GET /admin/fraud/evaluations`, `GET /admin/fraud/cases`, `POST /admin/fraud/cases/:id/{release,reject,escalate}`, `GET/POST/DELETE /admin/fraud/blacklists`, `GET /admin/compliance/due-diligence`, `POST /admin/compliance/due-diligence/:id/{approve,reject,more-info}`.

---

## 6. Admin APK Upload + Play Store Link + Site Direct Download (WS-F/9/10)

- **Backend:** extend `app_versions` with `apk_url TEXT, apk_size_bytes BIGINT, apk_sha256 VARCHAR(64)`.
  - `POST /admin/app-versions/:id/apk` (multipart, ≤500 MB, mime `application/vnd.android.package-archive` / octet-stream, `.apk` ext) → `uploadMediaBuffer` (R2 first) → saves url+size+sha256. One active APK per android release row; re-upload replaces.
  - `GET /api/public/app-links` additionally returns `apk_url`, `apk_version_name`, `apk_version_code`, `apk_size_bytes` (from newest active android release).
  - Download served via redirect to the storage URL (R2 public/signed per existing media config) — no droplet bandwidth cost.
- **Admin UI (`AppReleases.tsx`):** Play Store URL input per android release (store_url already exists — surface it as "Google Play link") + APK upload dropzone with size/hash display + copyable direct link.
- **Site (`DownloadAppSection`):** under the store buttons, when `apk_url` exists: "Having trouble with Google Play? **Download the APK directly** (v{version}, {size} MB)" — direct anchor download with a short install-permission hint. Keep the section's current "coming soon" behavior when nothing is configured.
- **Security notes:** static `Cache-Control`, checksum surfaced for verification, admin-only upload, no CDN HTML caching of the APK path.

---

## 7. App Availability Toggles + Site CTA Switching (WS-G/11/12/13)

- **Backend:** two system settings — `business_app_enabled`, `personal_app_enabled` (default `personal_app_enabled=false` until launch). Exposed publicly via `GET /api/public/app-flags` (no auth, cached 60 s, no PII).
- **Admin UI (`SystemSettings.tsx`):** two toggle cards with confirm dialogs and audit entries.
- **Site behavior:**
  - Personal section: toggle OFF → the current wishlist/invite block stays exactly as-is; ON → the "Join the wishlist" CTA is replaced by "Open MetriCorex Personal" + store/direct links.
  - Business section: same pattern for the Business CTA.
- **Login pages (both apps):** cross CTA block — "More of a business user? Open Business app" / "Personal user? Open Personal app" + sign-up links to both. Links come from build env (`VITE_*_APP_URL`) with the site as fallback.

---

## 8. Provider Integrations (WS-I/J/14/15/19)

### 8.1 Flutterwave bill payments (primary bills provider)

- New `server/services/providers/bills/flutterwave-bills.ts` implementing a `BillsProvider` interface: `getCategories()`, `getBillers(category)`, `getBillersById?()`, `validateCustomer(biller, customer)`, `pay(biller, customer, amount, reference)`.
- **Never hardcode categories:** categories/billers fetched live (`GET /bill-categories`, `GET /billers?category=`) with a 24 h in-process cache + admin force-refresh knob; unknown categories still render (generic form using validate+pay).
- Amount/currency from biller metadata; customer validation result (name/fee) shown before payment; idempotency via our `reference`; webhook-agnostic (bills are synchronous in FLW but we verify by transaction id).
- `features/personal/bills.ts` switched from simulator to this provider via `BILLS_PROVIDER=flutterwave_bills`; simulator retained for dev.
- Site "services" tiles + personal web Bills hub render categories from `GET /api/bills/categories` (live), so the site never drifts from the API.
- Category map for display (from FLW docs): AIRTIME, MOBILEDATA, CABLEBILLS, INTSERVICE, UTILITYBILLS, TAX, DONATIONS, TRANSLOG, DEALPAY, RELINST, SCHPB — **display-only**, sourced live at runtime.

### 8.2 Prestmit gift cards (buy + sell)

- `server/services/providers/giftcards/prestmit.ts` + `features/personal/giftcards.ts`:
  - **Sell (user → us):** user selects card+amount+sub-card, uploads card codes/images → Prestmit trade quote → accept → order `pending_admin` when manual review needed (card media review) or auto-processed when Prestmit confirms; payout to wallet on confirmation.
  - **Buy (us → user):** catalog from Prestmit (`GET /gift-cards/cards` style endpoints per docs) with rates; user pays from wallet; delivery code/image to user's email + in-app.
  - Webhook/rate cache per Prestmit docs (https://documentation.prestmit.io); secrets via `PRESTMIT_PUBLIC_KEY`/`PRESTMIT_SECRET_KEY` env; sandbox flag for dry-runs.
  - Fraud hooks: sell = inflow (card fraud!), buy = outflow.
- Admin: gift-card orders queue (approve/reject sell trades, adjust rates).

### 8.3 eSIM top-ups

- `features/personal/esim.ts` with a provider adapter (`ESIM_PROVIDER_URL`-style pluggable like bills; candidate providers evaluated per docs availability at build time; simulator first, live provider drops in without schema change).
- Plans catalog (country → packages), purchase debits wallet, QR/activation delivered in-app + email.

### 8.4 "Other bills" fallback provider

- Flutterwave covers all 11 Nigerian categories listed. For anything FLW cannot fulfil (e.g., international utility categories in future), the `BillsProvider` interface keeps a second adapter slot (`fallbackProvider`) selected per category — no code path changes when a provider is added later.

---

## 9. MetriCorex Personal (WS-K/L/M/16/17/18)

### 9.1 Architecture decisions

- **Two new standalone repos** (both currently empty):
  - `metricorex-personal-web` — forked from `metroflow-app` (React 19 + Vite + Tailwind + shadcn), pruned to Personal, rebranded, deploy target `app personal` subdomain.
  - `metricorex-personal-mobile` — forked from `Metroflow-Mobile/metroflow_flutter` (Flutter), pruned/rebranded, package id `com.metricorex.personal`.
- **One backend, one wallet:** the same `api.metricorex.com` serves both apps. Wallets are keyed to the business/user account — Personal and Business views read/write the same rows. No wallet sync needed because there is only one wallet.
- **Same credentials everywhere:** login is account-level (email/phone+password+PIN). A user account has `account_type` personal|business *preference* but both apps accept any account:
  - Business user opens Personal app → straight in, personal features available.
  - Personal user opens Business app → passes through the **Business KYC prompt** (existing `KycPrompt`/`KycBusinessUpgrade` flow) before business-only features unlock.
- **Feature flags per app:** `checkFeaturePermission` plan permissions already differentiate; personal-only features are additionally gated by `personal_app_enabled`/`business_app_enabled` so the console toggle actually controls the apps, not just the website.

### 9.2 Personal web app (WS-K/17)

Reuse from `metroflow-app`: auth shell, wallet UI, transactions, PIN/OTP flows, chat UI, calls UI, KYC components, plan/subscription, profile, notifications, socket layer, design system.
Personal-specific screens (new, but styled from existing components): Bills Hub (11 categories), Gift Cards (buy/sell), eSIM store, Savings Vaults, Marketplace, Social feed + Polls, Live streaming entry, Virtual cards, Contacts/withdrawals.
Personal landing page on the site gets the full marketing story (§10).

### 9.3 Personal mobile app (WS-L/16)

Reuse from `metroflow_flutter`: navigation shell/theme, wallet, transfers, bills UI foundations, chat/calls stack, KYC screens, push (FCM + iOS CallKit), splash/branding pipeline.
Personal-only: bottom-nav tabs Money · Lifestyle (bills/giftcards/esim) · Social (feed/polls/marketplace) · Vault (savings) · Profile; same API.
CI: reuse the Android/iOS workflows (keystore secrets already in the org; new bundle id registered by the user in Play/ASC when we get there).

### 9.4 Cross-app wiring (WS-M/18)

- Backend: `auth/login` returns `account_type` + `has_business_kyc` + `business_ready` flags; new `GET /api/auth/app-context` returns everything each app needs to decide prompts (one call).
- Business app: on login, if the user has no completed business profile → existing KYC prompt modal (already built) — no change needed beyond flag wiring.
- Personal app: no KYC wall for personal features; a "Go further with Business" card when `business_ready=false`.
- Shared wallet guarantee: all money endpoints are already account-scoped, not app-scoped — both frontends call identical endpoints. Verified by the route inventory (wallet/transfers/bills all keyed by `business_id`/`user_id`).

---

## 10. Marketing Site (WS-G/H/10/13/19)

1. **Personal landing sections** (copy supplied by the user, reused verbatim where possible):
   - Hero "Your money. Your people. Your whole life." + founding-member perks + phone mockup with the Personal balance card (reuse `personal/PhoneMockup`).
   - Marquee of the 12 features; stats row (190+ countries, 2 currencies, 12+ features, <30s bills).
   - "A life less interrupted" — Anywhere / Everyday / Global moment cards.
   - "Twelve ways Personal makes life easier" interactive feature grid (wallets, chat & calls, vaults, virtual cards, live streaming, gift cards, eSIM, bills, social feed, polls, marketplace, withdrawals) with the animated mini-cards.
   - "How it works — three steps and you're in" + Get-started CTA.
2. **Service tiles:** Airtime to Cash · Buy & Top-up eSIM · Buy Gift Cards · Sell Gift Cards · Crypto to Cash · Buy Airtime · Buy Data · Fund Betting Accounts · Pay Electricity · Pay Cable TV — rendered from a data file so the live Flutterwave category fetch can highlight/annotate them.
3. **Dynamic CTAs:** app-flag driven (§7) — wishlist ↔ open-app.
4. **Bill categories live mirror:** site services section pulls `GET /api/bills/categories` and renders the current set (falls back to the static list when the API is unreachable).
5. **Download section:** APK direct download (§6).

---

## 11. Deployment & Verification (WS-N/20)

- **Backend:** push → droplet `git pull && npm ci && npm run build && pm2 restart metroflow --update-env`. Boot migrations create all new tables idempotently. Health probe: `/api/health` 200, db up.
- **Admin:** Netlify deploy (same as today).
- **Business web:** code merged on `main` — **blocked on Netlify deploy** (see below).
- **Site:** Netlify deploy after all sections land.
- **Personal web/mobile:** push initial commits to the new repos; CI pipelines cloned and adapted.
- **E2E checks:** transfer happy-path + each fraud action via seeded rule triggers on staging wallet; DD lifecycle open→submit→approve→release; bills categories live fetch; Prestmit + eSIM in sandbox mode; site flags/wishlist toggle; APK upload → public app-links → site button.
- **Netlify blocker (ACTION NEEDED FROM USER):** `app.metricorex.com` is **not** connected to GitHub (no auto-deploy; no commit statuses; manual deploys). To let engineering ship web fixes without the user hand-running `netlify deploy`, provide a **Netlify Personal Access Token** (Netlify → User settings → Applications → New access token). It will be stored as a GitHub Actions secret and used only for `netlify deploy --prod`. Until then, web deliverables ship as ready-to-deploy branches and the user runs the deploy.

---

## 12. Delivery Order (execution sequence)

| Phase | Contents | Exit criteria |
|---|---|---|
| P0 (this commit series) | Fraud schema + engine + hooks (transfers, webhooks, withdrawals) + admin API + seeds | Rules fire on staging data; decisions recorded |
| P1 | DD workflow + user banner/form + admin compliance console | Full hold→submit→approve→release cycle in staging |
| P2 | Admin fraud/blacklist UI + app toggles + APK upload (backend+admin) + public app-links extension | Admin console fully operable |
| P3 | Site: Personal sections, service tiles, dynamic CTAs, APK button, live categories | Site complete behind flags |
| P4 | Bills: Flutterwave provider + reactivated personal bills; Prestmit gift cards; eSIM adapter | Sandbox E2E payments succeed |
| P5 | Personal web app repo (port + prune + brand + cross-login) | App boots against prod API with a real account |
| P6 | Personal mobile repo (port + prune + brand) | Flutter builds green both platforms |
| P7 | Deployments + E2E verification + worklog + user handoff (incl. Netlify ask, Play/ASC next steps) | All systems live / documented |

## 13. Risks & Open Questions

- **Netlify deploy access** (§11) — the only hard external blocker for shipping web code.
- **Flutterwave bills production access** — sandbox first; live requires the FLW account to have bills enabled (user confirmation when we reach P4).
- **Prestmit account** — API keys needed for live trades; simulator until keys arrive.
- **APK size on Netlify functions is irrelevant** (uploads go to the droplet/R2; site only links).
- **Fraud false positives** — every default above starts conservative (flag over reject) except hard-limit and blacklist; thresholds are admin-tunable without deploys.
- **Personal mobile store presence** — new bundle id needs new Play/ASC records; deferred until the apps build (does not block development).
