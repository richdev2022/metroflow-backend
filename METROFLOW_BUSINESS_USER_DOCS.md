# Metroflow Business & Team Documentation

This document serves as the guide for **Business Owners** and **Team Members** using Metroflow Pay. It covers onboarding, wallet management, payroll processing, and transfers.

---

## 1. User Flows

### A. Onboarding & KYC (Business admin & Team Members)
1.  **User Login**: Log in to your account.
2.  **KYC Prompt**: If your status is `none`, you will be prompted to verify identity.
3.  **Submission**: Submit your **BVN** or **NIN**.
4.  **Verification**: System verifies details immediately.
    - If successful, an **OTP** is sent to your registered Phone (and Email in Test mode).
5.  **OTP Entry**: Enter the OTP to complete verification.
6.  **Completion**:
    - **Wallet Created**: A personal wallet is automatically created for you.
    - **Virtual Account Created**: A dedicated Account Number is generated for funding your wallet.

### B. Business Wallet Setup (Business Owners)
1.  **Login**: Must be the `owner` of the business.
2.  **Navigate**: Go to "Wallet" -> "Create Business Account".
3.  **KYC Requirement**: Before creating a wallet, your business must be verified.
    - **Step 1**: Provide Business Address (Country, State, City, Street, House Number).
    - **Step 2**: Upload **Proof of Address** (Utility Bill or Bank Statement).
    - **Step 3**: Submit for Review.
4.  **Review Process**:
    - Platform Admins will review your submission.
    - You will receive an **Email Notification** upon Approval or Rejection.
    - If Rejected, the email will contain the reason. You can then correct and resubmit.
5.  **Wallet Creation**: Once approved, provide:
    - **GTBank Account Number** (For settlement/compliance).
    - **Business Name**.
6.  **Result**: Business Wallet is active.

### C. Funding Wallets
1.  **Select**: Click "Fund Wallet" on your dashboard.
2.  **Method 1: Bank Transfer**
    - Copy the **Virtual Account Number** displayed on your wallet.
    - Transfer money from any bank app.
3.  **Method 2: Card Payment**
    - Enter amount.
    - Pay via the Squad Payment Gateway.
    - Your wallet is credited instantly upon success.

### D. Payroll & Transfers (Business Owners)
1.  **Configure Payroll**: Set Salary, Currency (NGN/USD), and Bank details for your team.
2.  **Initiate Transfer**: Select "Bulk Transfer" from the Finance menu.
3.  **Select Source**: Choose which wallet to pay from:
    - **Business Wallet**: Company funds.
    - **Personal Wallet**: Owner's personal funds.
4.  **Select Type**:
    - **Salary**: Pays all active employees (Net = Salary + Bonuses - Deductions).
    - **Sprint/Task**: Pays based on project completion.
    - **Manual**: Enter details manually.
5.  **Process**:
    - System checks balance -> Debits Wallet -> Queues Transfers.
    - **Note**: Failed transfers are automatically refunded to your wallet.

---

## 2. API Reference

### 🔐 Authentication
- **Header**: `Authorization: Bearer <JWT_TOKEN>`

### 👤 KYC & Onboarding

#### 1. Initiate Verification
- **Endpoint**: `POST /kyc/initiate`
- **Body**: `{ "type": "bvn" | "nin", "number": "12345678901" }`
- **Response**: OTP sent message.

#### 2. Verify OTP
- **Endpoint**: `POST /kyc/verify-otp`
- **Body**: `{ "otp": "123456" }`
- **Action**: Verifies user, creates **Wallet**, creates **Virtual Account**.

#### 3. Get Status
- **Endpoint**: `GET /kyc/status`
- **Response**: Returns your User and Business KYC status.

#### 4. Submit Business KYC (Address & POA)
- **Endpoint**: `POST /kyc/business`
- **Type**: `multipart/form-data`
- **Fields**: `country`, `state`, `city`, `street`, `house_number`, `proof_of_address` (File).
- **Description**: Submits address and POA document for Admin review.

### 💰 Wallet Management

#### 1. Get Wallet Info
- **Endpoint**: `GET /wallet`
- **Response**: Returns `user_wallet` and `business_wallet` (if you are an owner). Includes Balance and Account Number.

#### 2. Fund via Card
- **Endpoint**: `POST /wallet/fund/card`
- **Body**: `{ "amount": 5000, "wallet_type": "business" | "user" }`
- **Response**: Returns `payment_url` to complete payment.

#### 3. Create Business Wallet
- **Endpoint**: `POST /wallet/business/create`
- **Auth**: Business Owner Only.
- **Body**: `{ "gtb_account_number": "0123456789", "business_name": "My Corp" }`

### 💸 Payroll & Transfers

#### 1. Payroll Summary (Table View)
- **Endpoint**: `GET /payroll/summary`
- **Response**: List of employees with calculated details:
  - `salary`, `currency`
  - `bonuses_total`, `deductions_total`
  - `net_salary` (Calculated amount to be paid)
  - `next_pay_date`

#### 2. Update Payroll Details
- **Endpoint**: `PUT /payroll/user/:id`
- **Body**: `{ "salary": 150000, "salary_currency": "NGN", "bank_code": "058", "account_number": "..." }`

#### 3. Add Adjustment (Bonus/Deduction)
- **Endpoint**: `POST /payroll/adjustments`
- **Body**: `{ "userId": "uuid", "type": "bonus", "amount": 5000, "reason": "Performance Bonus" }`

#### 4. Initiate Bulk Transfer
- **Endpoint**: `POST /transfers/bulk`
- **Body**:
```json
{
  "type": "salary", // Options: salary, manual, sprint, task
  "source_wallet_id": "uuid-of-wallet", // REQUIRED: ID of the wallet to debit
  "data": {} // Optional
}
```

#### 5. Get Transfer Queue
- **Endpoint**: `GET /transfers`
- **Query**: `?status=failed&page=1`
- **Response**: List of transfers. Check `failure_reason` if failed.

#### 6. Retry Transfer
- **Endpoint**: `POST /transfers/:id/retry`
- **Action**: Retries a failed transfer.
