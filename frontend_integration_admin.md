# Admin Platform Integration Guide

This guide details the **Fee Management** endpoints available for the Admin Platform. These endpoints allow admins to configure fees for various transaction categories using different calculation models.

## Fee Management

Admins can Create, Read, Update, and Delete (CRUD) fee configurations.

### Transaction Categories
*   `funding_card`: Funding via Card
*   `funding_account`: Funding via Account Transfer
*   `transfer`: Outbound Transfers
*   `otp_sms`: OTP SMS Verification
*   `stamp_duty`: Stamp Duty

### Fee Configuration Types (Models)
1.  **Percentage with Cap (`percentage_cap`)**: Charge X% up to a maximum of Y.
    *   Config: `{ "percentage": 1.5, "cap": 2000 }`
2.  **Flat Amount (`flat`)**: Charge a fixed amount X.
    *   Config: `{ "amount": 50 }`
3.  **Flat Conditional (`flat_conditional`)**: Charge X if amount > Y, else Z.
    *   Config: `[{ "condition": "gt", "threshold": 1000, "amount": 50 }, { "condition": "lte", "threshold": 1000, "amount": 10 }]`
4.  **Range Base (`range`)**: Charge X if amount is between A and B.
    *   Config: `[{ "min": 0, "max": 1000, "amount": 10 }, { "min": 1001, "max": 5000, "amount": 25 }]`

---

### Endpoints

#### 1. List All Fees
**GET** `/api/admin/fees`

*   **Response**:
    ```json
    {
      "success": true,
      "data": [
        {
          "id": "uuid",
          "category": "transfer",
          "config_type": "flat",
          "config_value": { "amount": 50 },
          "created_at": "..."
        }
      ]
    }
    ```

#### 2. Create Fee Configuration
**POST** `/api/admin/fees`

*   **Payload**:
    ```json
    {
      "category": "funding_card",
      "config_type": "percentage_cap",
      "config_value": {
        "percentage": 1.5,
        "cap": 2000
      }
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "message": "Fee configuration created",
      "data": { ... }
    }
    ```

#### 3. Update Fee Configuration
**PUT** `/api/admin/fees/:id`

*   **Payload** (Update type and/or value):
    ```json
    {
      "config_type": "flat",
      "config_value": {
        "amount": 100
      }
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "message": "Fee configuration updated"
    }
    ```

#### 4. Delete Fee Configuration
**DELETE** `/api/admin/fees/:id`

*   **Response**:
    ```json
    {
      "success": true,
      "message": "Fee configuration deleted"
    }
    ```

---

## Platform Revenue Wallet

A system-level wallet is automatically created/designated to collect all fee revenues.
*   **Credits**: All collected fees (transfer fees, SMS fees, funding fees) are credited to this wallet.
*   **Debits**: Refunds or admin withdrawals (future scope).

### Endpoints

#### 1. Get Revenue Wallet Details
**GET** `/api/admin/wallet`

*   **Response**:
    ```json
    {
      "success": true,
      "wallet": {
        "id": "uuid",
        "balance": "50000.00",
        "currency": "NGN",
        "status": "active",
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    }
    ```

#### 2. Get Revenue Wallet History
**GET** `/api/admin/wallet/history`

*   **Response**:
    ```json
    {
      "success": true,
      "transactions": [
        {
          "id": "uuid",
          "amount": "50.00",
          "type": "credit",
          "description": "Transfer Fee",
          "reference": "TRF-FEE-...",
          "status": "success",
          "created_at": "2024-01-01T10:00:00.000Z"
        }
      ]
    }
    ```
