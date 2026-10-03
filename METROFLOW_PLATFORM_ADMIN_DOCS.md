# Metroflow Platform Admin Documentation

This document serves as the guide for **Platform Administrators** managing the Metroflow Pay ecosystem. It covers oversight, wallet management, and reconciliation logic.


**Notification Configuration**:
- **`KYC_ADMIN_EMAILS`**: Comma-separated list of admin emails to receive notifications upon new Business KYC submissions (e.g., `admin1@metricorex.com,admin2@metricorex.com`).

---

## 2. Platform Features

### A. Platform Wallet & Reconciliation
The **Platform Admin Wallet** acts as the central pool/ledger for reconciliation.
- **Concept**: When a user funds their wallet (via Card/Bank), the money physically goes to the Squad aggregator. In our ledger:
  - **User Wallet**: Credited (+)
  - **Platform Admin Wallet**: Debited (-) to represent the liability/movement from the pool.
- **Funding**: Admins do not manually fund this wallet; it reflects the net flow of funds in the system.

### B. Global Oversight
- **KYC Monitoring**: 
  - View verification status of all Users and Businesses.
  - **Action Required**: Review pending Business KYC (Proof of Address).
  - **Approve**: Mark business as verified. Triggers email to business.
  - **Reject**: Mark as rejected with a mandatory reason. Triggers email to business.
- **Transfer Monitoring**: View the status of all payroll/bulk transfers occurring across the platform.

---

## 3. API Reference (Admin)

### 🔐 Authentication
- **Header**: `Authorization: Bearer <ADMIN_JWT_TOKEN>`

### 🛡️ Platform Wallet

#### 1. View Platform Wallet
- **Endpoint**: `GET /admin/wallet`
- **Description**: Shows the central pool wallet details (Balance, ID).

#### 2. Wallet History
- **Endpoint**: `GET /admin/wallet/history`
- **Description**: Shows all credits/debits to the platform wallet.
- **Use Case**: Reconciliation and audit trails.

### 👥 User & Business Management

#### 3. View All KYC
- **Endpoint**: `GET /admin/kyc`
- **Description**: List of all users/businesses and their KYC status (`verified`, `pending`, `rejected`, `none`).

#### 4. View All Transfers
- **Endpoint**: `GET /admin/transfers`
- **Description**: Global view of transfer activities. Filter by status (`failed`, `success`, `pending`).

#### 5. Approve Business KYC
- **Endpoint**: `POST /admin/kyc/business/:id/approve`
- **Description**: Approves the business verification. Sends success email.

#### 6. Reject Business KYC
- **Endpoint**: `POST /admin/kyc/business/:id/reject`
- **Body**: `{ "reason": "Invalid document" }`
- **Description**: Rejects verification with a reason. Sends rejection email.

---

## 3b. Admin Console (built-in web UI)

A self-contained admin dashboard ships with the backend — no separate app needed.

- **URL**: `https://<backend-host>/admin/` (served from `public/admin/index.html`)
- **Login**: any `platform_admins` account (same credentials as the admin API).
- **Sections**: Dashboard (stats + 6-month revenue/growth charts + platform wallet), **Disputes**, Transactions, Transfers, KYC (approve/reject business KYC), Notifications (internal alert feed), Settings (dispute emails + maintenance mode).
- **Permissions**: pages surface whatever the signed-in admin's role allows (`view_dashboard`, `manage_finance`, `manage_businesses`, `manage_settings`); actions the role lacks return a clear "Insufficient permissions" toast.

---

## 3c. Transaction Dispute Desk

Customers file disputes from the mobile/web receipt (reference + category + message + optional evidence attachment). Admins investigate and resolve from **Admin Console → Disputes** or the raw API (permission: `manage_finance`).

| Action | Endpoint | Effect |
|---|---|---|
| List / filter | `GET /admin/disputes?status=&search=&page=` | Status + reference/business search, paginated |
| Detail | `GET /admin/disputes/:id` | Dispute + customer + transaction snapshot |
| Change status | `POST /admin/disputes/:id/status` | `{ status, note }` — open / under_review / resolved / closed / rejected |
| **Recheck** | `POST /admin/disputes/:id/recheck` | Re-queries the provider: confirmed success closes the case; confirmed failure auto-refunds the customer |
| **Reverse** | `POST /admin/disputes/:id/reverse` | Credits the customer wallet. GUARDED: only FAILED, not-yet-credited transfers; server re-verifies before reversing; successful transfers are refused |
| Close | `POST /admin/disputes/:id/close` | `{ resolution: closed\|rejected, note }` |

Every action emails + pushes the customer, and writes to the admin notification feed (`GET /admin/notifications`).

### Dispute notification emails (admin-managed, NOT .env)

The inboxes that receive dispute alerts are stored in the database (`system_settings.dispute_admin_emails`) and managed from **Admin Console → Settings → Dispute notification emails**:

- `GET /admin/settings/dispute-emails` → `{ emails, source: database|env, envFallback }` (`manage_settings` or `manage_finance`)
- `PUT /admin/settings/dispute-emails` → `{ emails: [...] }` — validated, deduped, lowercased, live immediately (no redeploy)
- `POST /admin/settings/dispute-emails/test` — sends a test dispute alert to every configured inbox with per-address results

Resolution order at send time: **database value first**; the `.env` chain (`DISPUTE_ADMIN_EMAILS` → `KYC_ADMIN_EMAILS` → `SUPPORT_ALERT_EMAIL` → `ADMIN_ALERT_EMAIL`) is only a bootstrap fallback for fresh deploys that haven't saved a list yet.

---

## 4. Webhook & Reconciliation Logic

**Endpoint**: `POST /webhook`
**Provider**: Squad

**Logic for `charge_successful` event**:
1.  System validates signature (HMAC-SHA512).
2.  Finds transaction by reference.
3.  **Credits** User/Business Wallet (Balance + Amount).
4.  **Debits** Platform Admin Wallet (Balance - Amount).
5.  Updates Transaction Status to `success`.
