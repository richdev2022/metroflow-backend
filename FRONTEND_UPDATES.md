
# Metricorex Frontend Updates Documentation

This document outlines the API changes and updates needed for the frontend following the Monnify integration.

---

## 1. New Endpoints

### 1.1 Get Provider Requirements
**Endpoint:** `GET /api/providers/requirements`

**Query Parameters:**
- `provider` (optional): Specific provider to get requirements for (e.g., 'squad' or 'monnify'). If not provided, uses default provider.

**Response (Success):**
```json
{
  "success": true,
  "data": {
    "provider": "squad", // or "monnify"
    "personalVirtualAccount": {
      "requiredFields": ["bvn", "firstName", "lastName", "email", "phoneNumber", "address", "dob", "gender"]
    },
    "businessVirtualAccount": {
      "requiredFields": ["bvn", "businessName", "email", "phoneNumber", "beneficiaryAccount"]
    }
  }
}
```

**Provider-Specific Requirements:**

#### Squad Provider:
- Personal VA: bvn, firstName, lastName, email, phoneNumber, address, dob, gender
- Business VA: bvn, businessName, email, phoneNumber, beneficiaryAccount (GTB account number)

#### Monnify Provider:
- Personal VA: bvn, nin, firstName, lastName, email, phoneNumber
- Business VA: bvn, nin, businessName, email, phoneNumber

---

### 1.2 List Available Providers
**Endpoint:** `GET /api/providers/list`

**Response:**
```json
{
  "success": true,
  "data": {
    "providers": ["squad", "monnify"],
    "defaultProvider": "squad"
  }
}
```

---

## 2. Updated Endpoints

### 2.1 Create Virtual Account (Personal/Business)
**Endpoint:** `POST /api/wallet/create-virtual-account`

**Authentication:** Bearer Token Required

**Request Body:**
```json
{
  "accountType": "Personal" // or "Business"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Personal Virtual Account created successfully",
  "virtual_account_number": "1234567890"
}
```

**Response (Error):**
```json
{
  "success": false,
  "error": "Personal virtual account already exists for this provider"
}
```

**Key Changes:**
- This endpoint now uses the default provider configured on the backend
- The account creation uses data from the user's KYC profile (no need to send all fields in request)
- Supports both personal and business accounts in one endpoint

---

### 2.2 Get Wallet Details
**Endpoint:** `GET /api/wallet`

**Authentication:** Bearer Token Required

**Response (Success):**
```json
{
  "success": true,
  "user_wallet": {
    "id": "wallet-uuid",
    "user_id": "user-uuid",
    "balance": 5000.00,
    "status": "active",
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z",
    "virtual_accounts": [
      {
        "id": "va-uuid",
        "wallet_id": "wallet-uuid",
        "payment_provider": "squad",
        "virtual_account_number": "1234567890",
        "bank_code": "058",
        "account_name": "John Doe",
        "customer_identifier": "customer-id",
        "beneficiary_account": "0987654321",
        "provider_metadata": {},
        "created_at": "2024-01-01T00:00:00.000Z",
        "updated_at": "2024-01-01T00:00:00.000Z",
        "is_active": true
      },
      {
        "id": "va-uuid-2",
        "wallet_id": "wallet-uuid",
        "payment_provider": "monnify",
        "virtual_account_number": "0987654321",
        "bank_code": "50515",
        "account_name": "John Doe",
        "customer_identifier": "customer-id",
        "beneficiary_account": "0000000000",
        "provider_metadata": {},
        "created_at": "2024-01-01T00:00:00.000Z",
        "updated_at": "2024-01-01T00:00:00.000Z",
        "is_active": false
      }
    ]
  },
  "business_wallet": {
    // Same structure as user_wallet, if applicable
  }
}
```

**Key Changes:**
- Now returns `virtual_accounts` array with all virtual accounts for the wallet (one per provider)
- Each virtual account has `is_active` flag indicating which one is currently active (matches default provider)
- Wallet object no longer has direct VA fields (they're nested in `virtual_accounts`)

---

### 2.3 Fund Wallet via Card
**Endpoint:** `POST /api/wallet/fund/card`

**Authentication:** Bearer Token Required

**Request Body:**
```json
{
  "amount": 1000.00,
  "wallet_id": "wallet-uuid",
  "redirect_url": "https://your-app.com/wallet" // Optional, defaults to origin
}
```

**Response (Success):**
```json
{
  "success": true,
  "payment_url": "https://checkout.provider.com/...",
  "reference": "FUND-wallet-id-1234567890-user-id",
  "fee": 50.00,
  "total_amount": 1050.00
}
```

**Key Changes:**
- Uses default provider configured on backend
- No frontend changes needed for this endpoint

---

## 3. Frontend Implementation Checklist

### Wallet Screen Updates:
1. **Fetch Provider Requirements:**
   - On wallet screen load, call `GET /api/providers/requirements` to know what fields are needed
   - Use this to dynamically render the VA creation form

2. **Display Multiple Virtual Accounts:**
   - The `/api/wallet` endpoint now returns multiple virtual accounts (one per provider)
   - Display all VA options, highlighting the active one (`is_active: true`)

3. **Create VA Flow:**
   - Instead of separate endpoints for personal/business, use the single `/api/wallet/create-virtual-account` endpoint
   - Pass `accountType: "Personal"` or `accountType: "Business"` in the request body
   - Ensure user has completed KYC with required fields before allowing VA creation

4. **KYC Updates:**
   - If using Monnify, make sure the KYC process collects both BVN and NIN
   - Use the requirements endpoint to know which fields to collect

---

## 4. Backward Compatibility

- All existing endpoints continue to work as before
- Frontend can adopt the new features incrementally
- The new `/api/providers` endpoints are optional but recommended for better UX

---

## 5. Environment Variables (Backend)

The backend uses these environment variables to configure the payment providers:
- `DEFAULT_PAYMENT_PROVIDER`: Set to "squad" or "monnify"
- `MONNIFY_API_KEY`: Monnify API key
- `MONNIFY_SECRET_KEY`: Monnify secret key
- `MONNIFY_CONTRACT_CODE`: Monnify contract code
- `MONNIFY_BASE_URL`: Monnify API base URL (sandbox or production)
- `MONNIFY_WALLET_ACCOUNT_NUMBER`: Monnify wallet account number for disbursements

