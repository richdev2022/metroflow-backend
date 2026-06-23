
# Metrocorex Wallet Feature Implementation Guide

This document provides a detailed guide for implementing the wallet feature, including virtual account (VA) creation flows tailored to the active payment provider.

---

## Table of Contents
1. [Active Provider Detection](#1-active-provider-detection)
2. [Monnify Flow](#2-monnify-flow)
3. [Squad Flow](#3-squad-flow)
4. [KYC Flow Details](#4-kyc-flow-details)
5. [Endpoints Reference](#5-endpoints-reference)
6. [Frontend Implementation Checklist](#6-frontend-implementation-checklist)

---

## 1. Active Provider Detection

First, determine the active/default provider to decide the wallet behavior:

### Step 1: Get Active Provider & Requirements
**Endpoint:** `GET /api/providers/requirements`

**Response (Monnify Active):**
```json
{
  "success": true,
  "data": {
    "provider": "monnify",
    "personalVirtualAccount": {
      "requiredFields": ["bvn", "nin", "firstName", "lastName", "email", "phoneNumber"]
    },
    "businessVirtualAccount": {
      "requiredFields": ["bvn", "nin", "businessName", "email", "phoneNumber"]
    }
  }
}
```

**Response (Squad Active):**
```json
{
  "success": true,
  "data": {
    "provider": "squad",
    "personalVirtualAccount": {
      "requiredFields": ["bvn", "firstName", "lastName", "email", "phoneNumber", "address", "dob", "gender"]
    },
    "businessVirtualAccount": {
      "requiredFields": ["bvn", "businessName", "email", "phoneNumber", "beneficiaryAccount"]
    }
  }
}
```

---

## 2. Monnify Flow

### 2.1 Key Monnify Behavior
- **Personal Virtual Account** is **automatically created** by the backend **as soon as the user successfully verifies their BVN via OTP** (in `/kyc/verify-otp`)
- **Business VA** is NOT automatically created (must be created manually)
- Frontend can still call the create VA endpoints, backend will validate and return a "already exists" response if VA already exists for the active provider
- **No GTB account or proof of address required for Monnify Business VA**

### 2.2 Monnify User Journey
1. **KYC Verification (BVN):** User initiates BVN verification → receives OTP → verifies OTP
2. **Backend Automatically Creates Personal VA:** Backend detects BVN verification success → automatically creates Personal VA
3. **Frontend Fetches Wallet:** Call `GET /api/wallet` → Personal VA already present in `virtual_accounts` array
4. **Business VA Creation:** User clicks "Create Business VA" manually → backend creates it (no extra fields needed beyond what's already in KYC)
5. **Manual Create Attempt for Personal VA:** If user tries to manually create Personal VA, backend returns "already exists" (graceful response)

### 2.3 Create VA Endpoint Behavior (Monnify)
**Endpoint:** `POST /api/wallet/create-virtual-account`

**Request (Personal):**
```json
{
  "accountType": "Personal"
}
```

**Response (VA Already Exists):**
```json
{
  "success": false,
  "error": "Personal virtual account already exists for this provider"
}
```

**Request (Business):**
```json
{
  "accountType": "Business"
}
```

---

## 3. Squad Flow

### 3.1 Key Squad Behavior
- **Personal VA:** Created automatically on BVN verification (same as Monnify)
- **Business VA:** Requires:
  1. First submit Business KYC: `POST /kyc/business` (requires proof of address file + address details)
  2. Then call `/wallet/create-virtual-account` with `accountType: "Business"`

### 3.2 Squad User Journey
1. **Personal VA Creation:** User completes BVN KYC → Personal VA automatically created
2. **Business VA Creation:**
   a. **Submit Business KYC:** Call `POST /kyc/business` (multipart form with proof_of_address file + country/state/city/street/house_number)
   b. **Create Business VA:** Call `POST /api/wallet/create-virtual-account` with `accountType: "Business"`

### 3.3 Create VA Endpoint Behavior (Squad)
**Endpoint:** `POST /api/wallet/create-virtual-account`

**Request (Personal):**
```json
{
  "accountType": "Personal"
}
```

**Request (Business):**
```json
{
  "accountType": "Business"
}
```

---

## 4. KYC Flow Details

### 4.1 Get KYC Status
**Endpoint:** `GET /kyc/status`
**Authentication:** Bearer Token

**Response:**
```json
{
  "success": true,
  "user": {
    "bvnStatus": "verified",
    "ninStatus": "pending",
    "rejection_reason": null
  },
  "business": {
    "status": "pending_review",
    "rejection_reason": null
  }
}
```

### 4.2 Initiate KYC (BVN/NIN)
**Endpoint:** `POST /kyc/initiate`
**Authentication:** Bearer Token

**Request:**
```json
{
  "type": "bvn",
  "number": "12345678901"
}
```

### 4.3 Verify OTP
**Endpoint:** `POST /kyc/verify-otp`
**Authentication:** Bearer Token

**Request:**
```json
{
  "otp": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "KYC Verified successfully"
}
```

### 4.4 Submit Business KYC
**Endpoint:** `POST /kyc/business`
**Authentication:** Bearer Token
**Content-Type:** multipart/form-data

**Request Fields:**
- `proof_of_address`: File (required)
- `country`: String (required)
- `state`: String (required)
- `city`: String (required)
- `street`: String (required)
- `house_number`: String (required)

---

## 5. Endpoints Reference

### 5.1 Get Wallet Details
**Endpoint:** `GET /api/wallet`
**Authentication:** Bearer Token

**Response (Monnify - KYC Verified):**
```json
{
  "success": true,
  "user_wallet": {
    "id": "wallet-uuid",
    "user_id": "user-uuid",
    "balance": 0,
    "status": "active",
    "virtual_accounts": [
      {
        "id": "va-uuid",
        "wallet_id": "wallet-uuid",
        "payment_provider": "monnify",
        "virtual_account_number": "1234567890",
        "bank_code": "50515",
        "account_name": "John Doe",
        "is_active": true
      }
    ]
  },
  "business_wallet": {
    "id": "business-wallet-uuid",
    "business_id": "business-uuid",
    "balance": 0,
    "status": "active",
    "virtual_accounts": [] // Empty until business VA created manually
  }
}
```

### 5.2 Create Virtual Account
**Endpoint:** `POST /api/wallet/create-virtual-account`
**Authentication:** Bearer Token

---

## 6. Frontend Implementation Checklist

1. **Check Active Provider First:**
   - Always call `GET /api/providers/requirements` on wallet screen mount
   - Store active provider in state

2. **Monnify-Specific UI:**
   - After KYC (BVN) verification success, immediately fetch wallet details
   - Hide "Create Personal VA" button or show "VA Already Created" status
   - For Business VA: Show "Create Business VA" button (no extra fields needed, just call endpoint)

3. **Squad-Specific UI:**
   - For Business VA creation:
     a. First show Business KYC form (proof of address file upload + address fields)
     b. After Business KYC submitted, show "Create Business VA" button

4. **Handle "Already Exists" Gracefully:**
   - When user clicks "Create VA", backend may return already exists
   - Show friendly message instead of error
   - Refresh wallet details to display existing VA

5. **Display All Virtual Accounts:**
   - Show all VAs in `virtual_accounts` array
   - Highlight active VA (`is_active: true`)

