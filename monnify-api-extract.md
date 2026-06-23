
# Monnify API Extract for Metricorex Integration

## Overview
This document extracts the relevant Monnify API endpoints from the provided `monnify-collection.yml` for integrating Monnify as an additional payment provider alongside Squad in Metricorex.

## 1. Authentication
Monnify uses Basic Authentication to get an access token, which is then used for all other API calls.

### Endpoint: Generate Access Token
- **Method**: POST
- **URL**: `/api/v1/auth/login`
- **Security**: Basic Auth (API Key: Secret Key)
- **Description**: Generates a Bearer access token for authenticating subsequent API requests.
- **Response Example**:
  ```json
  {
    "requestSuccessful": true,
    "responseMessage": "Success",
    "responseCode": "0",
    "responseBody": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expiresIn": 3600
    }
  }
  ```

---

## 2. Virtual Accounts (Reserved Accounts)
These endpoints are for creating and managing reserved virtual accounts for both personal and business users.

### Important: BVN and NIN Requirement
Both BVN and NIN are required for creating or updating virtual accounts on Monnify.

---

### Endpoint: Create Reserved Account (General/Personal)
- **Method**: POST
- **URL**: `/api/v2/bank-transfer/reserved-accounts`
- **Security**: Bearer Auth
- **Request Body**:
  ```json
  {
    "accountReference": "unique-user-ref",
    "accountName": "John Doe",
    "currencyCode": "NGN",
    "contractCode": "your-contract-code",
    "customerEmail": "john@example.com",
    "customerName": "John Doe",
    "bvn": "21212121212",
    "nin": "12345678901",
    "getAllAvailableBanks": true,
    "preferredBanks": ["50515"]
  }
  ```
- **Required Fields**: `accountReference`, `accountName`, `currencyCode`, `contractCode`, `customerEmail`, `customerName`, `bvn`, `nin`, `getAllAvailableBanks`, `preferredBanks`
- **Response Example**:
  ```json
  {
    "requestSuccessful": true,
    "responseMessage": "Success",
    "responseCode": "0",
    "responseBody": {
      "accountReference": "unique-user-ref",
      "accountName": "John Doe",
      "currencyCode": "NGN",
      "contractCode": "your-contract-code",
      "customerEmail": "john@example.com",
      "customerName": "John Doe",
      "accounts": [
        {
          "bankCode": "035",
          "bankName": "Wema Bank",
          "accountNumber": "1234567890",
          "accountName": "John Doe"
        }
      ],
      "collectionChannel": "RESERVED_ACCOUNT"
    }
  }
  ```

---

### Endpoint: Update KYC Info (Link BVN/NIN to Account)
- **Method**: PUT
- **URL**: `/api/v1/bank-transfer/reserved-accounts/{accountReference}/kyc-info`
- **Security**: Bearer Auth
- **Parameters**: `accountReference` (path, required)
- **Description**: Links customers' BVN/NIN to their respective reserved accounts (can be used after account creation if not provided initially).
- **Request Body**:
  ```json
  {
    "bvn": "22222222222",
    "nin": "121212121212"
  }
  ```
- **Required Fields**: `bvn`, `nin`
- **Response Example**:
  ```json
  {
    "requestSuccessful": true,
    "responseMessage": "success",
    "responseCode": "0",
    "responseBody": {
      "accountReference": "a1fe1c73c6f985eb43e8ef35ec0d6a398698cdea",
      "accountName": "MARVELOUS BENJI",
      "customerEmail": "test@tester.com",
      "customerName": "mao  Zhang",
      "bvn": "21212121212"
    }
  }
  ```

---

### Endpoint: Get Reserved Account Details
- **Method**: GET
- **URL**: `/api/v2/bank-transfer/reserved-accounts/{accountReference}`
- **Security**: Bearer Auth
- **Parameters**: `accountReference` (path, required)

---

## 3. Card Tokenization & Recurring Payments
Monnify provides card tokenization for recurring payments. Tokens are generated after a successful initial card transaction.

### Endpoint: Charge Card Token
- **Method**: POST
- **URL**: `/api/v1/merchant/cards/charge-card-token`
- **Security**: Bearer Auth
- **Request Body**:
  ```json
  {
    "cardToken": "card-token-here",
    "amount": 1000,
    "customerEmail": "john@example.com",
    "paymentReference": "unique-payment-ref"
  }
  ```
- **Description**: Charges a previously tokenized card.

---

## 4. Transfers (Disbursements)
These endpoints handle single and bulk transfers (payouts).

### Endpoint: Initiate Single Transfer
- **Method**: POST
- **URL**: `/api/v2/disbursements/single`
- **Security**: Bearer Auth
- **Request Body**:
  ```json
  {
    "amount": 1000,
    "reference": "unique-transfer-ref",
    "narration": "Transfer to John Doe",
    "destinationBankCode": "058",
    "destinationAccountNumber": "0123456789",
    "currency": "NGN",
    "sourceAccountNumber": "your-wallet-account-number"
  }
  ```

### Endpoint: Initiate Bulk Transfer
- **Method**: POST
- **URL**: `/api/v2/disbursements/batch`
- **Security**: Bearer Auth
- **Request Body**:
  ```json
  {
    "title": "Bulk Transfer",
    "batchReference": "unique-batch-ref",
    "narration": "Monthly salaries",
    "sourceAccountNumber": "your-wallet-account-number",
    "onValidationFailure": "CONTINUE",
    "transactions": [
      {
        "amount": 1000,
        "reference": "txn-ref-1",
        "narration": "Salary - John Doe",
        "destinationBankCode": "058",
        "destinationAccountNumber": "0123456789"
      },
      {
        "amount": 2000,
        "reference": "txn-ref-2",
        "narration": "Salary - Jane Doe",
        "destinationBankCode": "011",
        "destinationAccountNumber": "9876543210"
      }
    ]
  }
  ```

### Endpoint: Single Transfer Status
- **Method**: GET
- **URL**: `/api/v2/disbursements/single/summary?reference=unique-transfer-ref`
- **Security**: Bearer Auth
- **Parameters**: `reference` (query, required)

### Endpoint: Bulk Transfer Status
- **Method**: GET
- **URL**: `/api/v2/disbursements/batch/summary?reference=unique-batch-ref`
- **Security**: Bearer Auth
- **Parameters**: `reference` (query, required)

### Endpoint: Get Wallet Balance
- **Method**: GET
- **URL**: `/api/v2/disbursements/wallet-balance?accountNumber=your-wallet-account-number`
- **Security**: Bearer Auth
- **Parameters**: `accountNumber` (query, required)

---

## 5. Bank Account Verification
Useful for validating bank account details before initiating a transfer.

### Endpoint: Validate Bank Account
- **Method**: GET
- **URL**: `/api/v1/disbursements/account/validate?accountNumber=0123456789&bankCode=058`
- **Security**: Bearer Auth
- **Parameters**:
  - `accountNumber` (query, required)
  - `bankCode` (query, required)

---

## 6. Other Useful Endpoints

### Get Supported Banks
- **Method**: GET
- **URL**: `/api/v1/banks`
- **Security**: Bearer Auth
- **Description**: Returns a list of all banks supported by Monnify.

### Get Transaction Status
- **Method**: GET
- **URL**: `/api/v2/merchant/transactions/query?paymentReference=unique-payment-ref`
- **Security**: Bearer Auth
- **Parameters**: `paymentReference` (query, required) or `transactionReference`
