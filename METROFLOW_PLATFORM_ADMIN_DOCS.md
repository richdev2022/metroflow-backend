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

## 4. Webhook & Reconciliation Logic

**Endpoint**: `POST /webhook`
**Provider**: Squad

**Logic for `charge_successful` event**:
1.  System validates signature (HMAC-SHA512).
2.  Finds transaction by reference.
3.  **Credits** User/Business Wallet (Balance + Amount).
4.  **Debits** Platform Admin Wallet (Balance - Amount).
5.  Updates Transaction Status to `success`.
