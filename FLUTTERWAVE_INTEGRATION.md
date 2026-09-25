# Flutterwave V3 Integration Guide

This document describes the Flutterwave (V3) payment gateway integration across the Metroflow platform, and how the provider-toggle system works.

Reference docs: https://developer.flutterwave.com/ (V3 API)

## 1. Overview

Flutterwave is now a first-class payment provider alongside Squad and Monnify. It supports:

| Capability | Status | Notes |
|---|---|---|
| Checkout (wallet funding) | ✅ | Flutterwave Standard (`POST /v3/payments`) hosted checkout |
| Transaction verification | ✅ | `GET /v3/transactions/verify_by_reference?tx_ref=` — always run before crediting |
| Webhook notifications | ✅ | `charge.completed`, `transfer.completed`, validated via `verif-hash` header |
| Virtual accounts (Personal & Business) | ✅ | Static VA via `POST /v3/virtual-account-numbers` (BVN required) |
| Single transfers | ✅ | `POST /v3/transfers` |
| Bulk transfers (incl. payroll) | ✅ | `POST /v3/bulk-transfers` |
| Account name resolution | ✅ | `POST /v3/accounts/resolve` |
| Bank list | ✅ | Static NIBSS code list (same codes used platform-wide) |
| Direct card charge / recurring | ❌ | Not implemented (Squad/Monnify handle card tokenization) |

## 2. Environment Variables

```env
FLW_SECRET_KEY=FLWSECK-xxxxxxxxxxxxxxxxxxxx     # REQUIRED - Bearer token for ALL server-side V3 API calls
FLW_PUBLIC_KEY=FLWPUBK_TEST-xxxxxxxxxxxxxxxxx   # REQUIRED for client-side inline checkout (v3.js / mobile SDKs)
FLW_SECRET_HASH=your-webhook-secret-hash        # REQUIRED for webhooks - MUST match the dashboard webhook secret hash
# FLW_ENCRYPTION_KEY=xxxxxxxxxxxxxxxxxxxxxxxx    # OPTIONAL - only for Direct Charge endpoints (3DES); not used today
FLW_BASE_URL=https://api.flutterwave.com        # Optional override (test & live share this base URL)
```

| Variable | Used by | Where |
|----------|---------|-------|
| `FLW_SECRET_KEY` | Server → Flutterwave REST API | All `/v3/*` calls (checkout, verify, transfers, VAs, balances) |
| `FLW_PUBLIC_KEY` | **Client** (web / mobile) | Inline checkout `FlutterwaveCheckout({ public_key })` and mobile SDKs. Served to clients via **public** `GET /api/providers/checkout-config` and included in `GET /api/providers/list` `configStatus` |
| `FLW_SECRET_HASH` | Webhook validation | `verif-hash` header compare (constant-time), 401 on mismatch |
| `FLW_ENCRYPTION_KEY` | Direct charges only | 3DES payload encryption — not needed for hosted checkout, transfers, VAs or verification |

> **Note:** Flutterwave uses the same API base URL for test and live modes — the mode is determined by the key prefix (test keys contain `FLWSECK_TEST` / `FLWPUBK_TEST`). No environment switch is needed.
>
> **Startup diagnostics:** the server logs a warning at boot if any of `FLW_SECRET_KEY`, `FLW_PUBLIC_KEY` or `FLW_SECRET_HASH` is missing, and `GET /api/providers/list` reports `publicKeyConfigured` / `webhookSecretConfigured` per provider.

### Webhook configuration (Flutterwave dashboard)

1. Set the webhook URL to: `https://<your-backend-domain>/api/webhook` (also reachable at `/webhook`).
2. Set the **secret hash** in the dashboard to the same value as `FLW_SECRET_HASH`.
3. Flutterwave sends every event with a `verif-hash` header. The backend rejects requests whose hash does not match with **401**.

## 3. Provider toggle ("If Provider is toggled to Flutterwave...")

The platform has a **global active payment provider**, managed by platform admins:

- Stored in the `system_settings` table under the key `active_payment_provider`.
- Read through `getActiveProviderName()` (30s in-memory cache) and `resolveProvider(explicit?)` in `server/services/providers/factory.ts`.
- Falls back to `DEFAULT_PAYMENT_PROVIDER` env when not set.

**What uses the active provider:**
- `POST /api/wallet/fund/card` — uses the active provider **unless** the client passes an explicit `provider` in the body (the checkout provider toggle in the Web/Mobile UIs).
- Transfers (single, bulk, payroll) — `transfer_queue.payment_provider` is stamped with the active provider at initiation time; retries re-stamp with the current active provider.
- Virtual account creation — the active provider's VA endpoints are used.

**Admin endpoints:**

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/payment-providers` | Providers overview: active provider, config status, per-provider stats |
| PUT | `/api/admin/payment-providers/active` | Toggle the global provider: `{ "provider": "flutterwave" }` |
| GET | `/api/admin/virtual-accounts?provider=&page=&limit=` | All virtual accounts with owner context |
| POST | `/api/admin/transactions/verify` | Manually re-verify a transaction against its provider: `{ "reference": "FUND-..." }` |

**Client endpoints:**

| Method | Path | Description |
|---|---|---|
| GET | `/api/providers/list` | `{ providers: [...], activeProvider, defaultProvider, configStatus }` |
| POST | `/api/wallet/fund/card` | Body now accepts optional `provider` (one of `squad|monnify|flutterwave`) |

## 4. Wallet funding flow (Flutterwave checkout)

```
Client (Web/Mobile)                    Backend                             Flutterwave
      │  POST /wallet/fund/card            │                                    │
      │  { amount, wallet_id, provider }   │                                    │
      │───────────────────────────────────>│  POST /v3/payments                 │
      │                                    │───────────────────────────────────>│
      │  { payment_url, reference, fee }   │  -> data.link (hosted checkout)    │
      │<───────────────────────────────────│                                    │
      │  redirect user to payment_url      │                                    │
      │────────────────────────────────────────────────────────────────────────>│
      │                                    │   webhook: charge.completed        │
      │                                    │<───────────────────────────────────│
      │                                    │  1. verify verif-hash (401 if bad) │
      │                                    │  2. verifyPayment(tx_ref) — API    │
      │                                    │  3. amount/currency sanity check   │
      │                                    │  4. credit wallet (atomic, idempotent)
      │  redirect to /wallet?status=success&reference=...                       │
      │<───────────────────────────────────│                                    │
```

**Verification-before-credit rule:** a wallet is NEVER credited from a webhook payload alone. The handler always re-verifies the charge server-to-server (`GET /v3/transactions/verify_by_reference`) and checks that the verified `amount >= transaction.amount + fee` and `currency` matches before crediting. Crediting runs inside a DB transaction with a `FOR UPDATE` row lock and is idempotent.

The same rule applies to the `GET /api/wallet/verify` redirect endpoint (used by the hosted-checkout return flow and mobile webviews): verification must succeed (including amount/currency sanity checks) before the wallet is credited.

## 5. Virtual account funding (bank transfers to VA)

1. Users create VAs per provider: `POST /api/wallet/create-virtual-account` — for Flutterwave, a **static (permanent)** VA is created with the user's BVN; the generated `tx_ref` is stored in `virtual_accounts.provider_metadata.va_tx_ref`.
2. When money hits the VA, Flutterwave sends `charge.completed` with the VA's `tx_ref` and a `payment_type` of `bank_transfer`.
3. The handler attributes the payment via:
   - `virtual_accounts.provider_metadata` → `va_tx_ref` (primary),
   - account number fields in the payload (fallback),
   - customer email → user wallet (last resort).
4. **Verification-first** applies here too; the credit is recorded with a unique reference `FLW-VA-<flw_transaction_id>` so repeated webhooks can never double-credit.
5. Platform fee: `calculateFee(amount, 'funding_account')`, credited to the revenue wallet.

## 6. Transfers (single, bulk, payroll)

- Single: `transfer_queue` rows are executed by `processAllPending` → `provider.initiateTransfer` (Flutterwave `POST /v3/transfers`); the FLW transfer `id` is persisted in `provider_metadata` and used by `verifyTransfer`.
- Verification: `verifySingleTransfer` passes the stored provider metadata so Flutterwave transfers are verified by `GET /v3/transfers/{id}` (fallback: paging search by our reference).
- Statuses: `SUCCESSFUL` → success; `FAILED`/`REVERTED`/`CANCELED` → failed (with refund flow, same as other providers); `NEW`/`PENDING`/`QUEUED`/`ONGOING` → still processing.
- Bulk/payroll: Flutterwave `POST /v3/bulk-transfers` is implemented on the provider interface (`initiateBulkTransfer`, `getBulkTransferStatus`). The standard pipeline executes queued rows item-by-item, which also gives per-item fee/refund accounting.
- Webhook `transfer.completed` updates `transfer_queue` by our reference.

## 7. Amount units

Internally the platform passes **minor units (kobo)** between services (`toMinorUnit`). The Flutterwave provider converts to **major units** at the boundary (`initiatePayment`, `initiateTransfer`, `initiateBulkTransfer`), so callers don't change.

## 8. Files changed (backend)

| File | Change |
|---|---|
| `server/services/providers/flutterwave.ts` | **NEW** — full V3 provider |
| `server/services/providers/factory.ts` | Register flutterwave; active-provider resolution + cache |
| `server/services/providers/index.ts` | `verifyTransfer(reference, providerMetadata?)` |
| `server/routes/providers.ts` | `/providers/list` returns active provider + config status |
| `server/routes/wallet.ts` | Provider param on funding; FLW verify + VA parsing; email resolution fix |
| `server/routes/webhook.ts` | FLW webhook handler; verify-before-credit; 401 on bad signature |
| `server/services/transfer.ts` | FLW transfer status parsing (verify + immediate) |
| `server/routes/transfers.ts` | Active-provider stamping; `walletId` camelCase accepted |
| `server/routes/admin.ts` | Provider management + VA listing + manual verify endpoints |
| `.env.example` | FLW_* variables documented |

## 9. Client integration summary

- **Web** (`metroflow-app`): fund dialog shows a Payment Method selector (from `/providers/list`, defaults to the active provider); sends `provider` on `POST /wallet/fund/card`; wallet page handles `?status=success|failed&reference=` redirect params; socket connects with `auth.token`; public guest pages at `/join/meeting/:code` and `/join/call/:code`.
- **Mobile** (`Metroflow-Mobile`): Fund Wallet screen shows provider chips; socket service sends the auth token on handshake; in-app single transfer now asks for the transaction PIN (backend-mandated).
- **Admin** (`metroflow-admin`): new "Payment Providers" page (toggle active provider, view VAs), provider verification action on Transactions, Flutterwave filter in Webhooks.
