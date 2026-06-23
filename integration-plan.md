
# Monnify Integration Plan for Metricorex

## Goal
Integrate Monnify as an additional payment provider alongside Squad in Metricorex, maintaining the same API endpoints for the frontend to ensure backward compatibility.

---

## 1. Architecture Overview
We will implement a **provider-agnostic architecture** with the following key components:

### 1.1 Payment Provider Interface
Define a common interface that both Squad and Monnify providers will implement, ensuring they support the same methods.

### 1.2 Provider Factory
A factory function/class that will return the appropriate provider instance (Squad or Monnify) based on configuration or request context.

### 1.3 Database Changes
Add provider-related fields to relevant database tables to track which provider was used for a transaction, virtual account, etc.

### 1.4 Provider-Specific Requirements Handling
Different providers have different requirements for creating virtual accounts:
- **Squad**: Requires proof of address and GTB account for business virtual accounts
- **Monnify**: Requires BVN and NIN for both personal and business virtual accounts; does not require GTB account or proof of address

We'll need to:
- Expose an endpoint for the frontend to get the active/default provider's requirements
- Update the frontend (though the user said not to change endpoints, we'll need to make sure the frontend can adapt based on provider requirements)

---

## 2. Step-by-Step Integration Plan

### Step 1: Create Provider Interface & Base Classes
- **File Path**: `server/services/providers/index.ts`
- **Purpose**: Define a standard interface that all payment providers must implement.
- **Methods to Include**:
  - `createVirtualAccount()`
  - `createBusinessVirtualAccount()`
  - `initiatePayment()`
  - `verifyPayment()`
  - `chargeCard()`
  - `initiateTransfer()`
  - `accountLookup()`
  - `getBanks()`
  - `verifyWebhook()`

### Step 2: Refactor Squad Service to Implement the Interface
- **File Path**: `server/services/providers/squad.ts`
- **Purpose**: Modify the existing Squad service to implement our new provider interface.
- **Action**:
  - Move existing `squad.ts` to `providers/squad.ts`
  - Update method signatures to match the interface
  - Ensure backward compatibility

### Step 3: Create Monnify Provider
- **File Path**: `server/services/providers/monnify.ts`
- **Purpose**: Implement the provider interface for Monnify.
- **Key Features to Implement**:
  - **Authentication**: Handle access token generation and refresh (Monnify tokens expire after 1 hour)
  - **Virtual Accounts**:
    - Create reserved accounts for personal users
    - Create reserved accounts for businesses
  - **Payments**:
    - Initiate card payments
    - Verify payments
    - Charge tokenized cards
  - **Transfers**:
    - Single transfers
    - Bulk transfers
    - Get transfer status
    - Get wallet balance
  - **Webhooks**: Handle and verify Monnify webhook events

### Step 4: Create Provider Factory
- **File Path**: `server/services/providers/factory.ts`
- **Purpose**: Return the correct provider instance based on configuration or selection.
- **Configuration Options**:
  - Environment variable to set default provider (e.g., `DEFAULT_PAYMENT_PROVIDER=squad|monnify`)
  - Allow selecting provider per request via header or body (optional, for flexibility)

### Step 5: Update Database Schema
Add the following fields to relevant tables:

#### Table: `wallets`
- Add `payment_provider` (text, nullable, default: 'squad'): Tracks which provider the virtual account is associated with
- Add `provider_metadata` (jsonb, nullable): Stores provider-specific data (e.g., Monnify account reference)
- Ensure both `bvn` and `nin` fields are available and required for users/businesses creating virtual accounts

#### Table: `users`
- Verify that `nin` field exists (add if missing) and is required for KYC completion

#### Table: `transfer_queue`
- Add `payment_provider` (text, nullable, default: 'squad'): Tracks which provider was used for the transfer
- Add `provider_metadata` (jsonb, nullable): Stores provider-specific transfer data

#### Table: `transactions`
- Add `payment_provider` (text, nullable, default: 'squad'): Tracks which provider processed the transaction
- Add `provider_metadata` (jsonb, nullable): Stores provider-specific transaction data

### Step 6: Refactor Services to Use Provider Factory
- **Files to Update**:
  - `server/services/transfer.ts`: Use provider factory for transfers
  - `server/routes/wallet.ts`: Use provider factory for virtual accounts and payments
  - `server/routes/transfer.ts`: Use provider factory for transfer endpoints
  - `server/routes/webhook.ts`: Add handling for Monnify webhooks
- **Key Point**: All existing endpoints remain unchanged for the frontend; only the underlying implementation uses the provider factory.

### Step 7: Implement Webhook Handling for Monnify
- **File Path**: `server/routes/webhook.ts`
- **Purpose**: Handle Monnify webhook events (e.g., successful payment, transfer status updates)
- **Verification**: Monnify signs webhooks - verify the signature using your Monnify secret key.

### Step 7.5: Add Endpoint for Provider Requirements
- **File Path**: `server/routes/providers.ts` (or add to existing routes)
- **Endpoint**: `GET /api/providers/requirements`
- **Purpose**: Return the requirements for the active/default provider, or for a specific provider if a query parameter is provided
- **Response Example**:
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
  Or for Squad:
  ```json
  {
    "success": true,
    "data": {
      "provider": "squad",
      "personalVirtualAccount": {
        "requiredFields": ["bvn", "firstName", "lastName", "email", "phoneNumber", "address", "dob", "gender"]
      },
      "businessVirtualAccount": {
        "requiredFields": ["bvn", "businessName", "email", "phoneNumber", "gtbAccountNumber", "proofOfAddress"]
      }
    }
  }
  ```

### Step 8: Update Configuration & Environment Variables
Add the following environment variables to `.env` and `.env.example`:
```env
# Monnify Configuration
MONNIFY_API_KEY=your-monnify-api-key
MONNIFY_SECRET_KEY=your-monnify-secret-key
MONNIFY_CONTRACT_CODE=your-monnify-contract-code
MONNIFY_BASE_URL=https://sandbox.monnify.com # or https://api.monnify.com for production
MONNIFY_WALLET_ACCOUNT_NUMBER=your-monnify-wallet-account-number # for disbursements
DEFAULT_PAYMENT_PROVIDER=squad # or monnify
```

### Step 9: Update Swagger Documentation (If Needed)
- **File Path**: `server/swagger.ts` and/or `server/swagger-output.json`
- **Purpose**: Update swagger docs only if the request/response payloads need to change for the new provider.
- **Key Point**: Keep the same endpoint paths and request/response structures as much as possible to maintain backward compatibility.

### Step 10: Test the Integration
- **Test Scenarios**:
  1. Test the new `/api/providers/requirements` endpoint for both Squad and Monnify
  2. Create a personal virtual account with both Squad and Monnify
  3. Create a business virtual account with both providers
  4. Fund a wallet via card with both providers
  5. Initiate a single transfer with both providers
  6. Initiate a bulk transfer with both providers
  7. Test webhook handling for both providers
  8. Verify backward compatibility - ensure the frontend still works with no changes

---

## 3. File Structure After Integration
```
server/
├── services/
│   ├── providers/
│   │   ├── index.ts          # Provider interface
│   │   ├── factory.ts        # Provider factory
│   │   ├── squad.ts          # Squad provider implementation
│   │   └── monnify.ts        # Monnify provider implementation
│   ├── transfer.ts           # Updated to use provider factory
│   └── ... other services
├── routes/
│   ├── providers.ts          # New: Provider requirements and info endpoint
│   ├── wallet.ts             # Updated to use provider factory
│   ├── transfer.ts           # Updated to use provider factory
│   ├── webhook.ts            # Updated to handle Monnify webhooks
│   └── ... other routes
└── ... other files
```

---

## 4. Backward Compatibility Guarantee
- **Frontend Endpoints**: No changes to API endpoints - frontend will continue to use the same URLs.
- **Request/Response Payloads**: Same structure for requests and responses, except for optional provider-specific fields if needed.
- **Existing Data**: All existing data and integrations with Squad will continue to work as before.

---

## 5. Future Extensibility
To add another provider (e.g., Kuda) in the future:
1. Create a new file in `server/services/providers/` (e.g., `kuda.ts`)
2. Implement the provider interface
3. Add it to the provider factory
4. Add environment variables for the new provider
5. Done!

This architecture makes it easy to add new providers without changing existing code.
