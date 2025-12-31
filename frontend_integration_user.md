# User Platform Integration Guide

This guide details the new features and endpoints available for the User Platform, specifically focusing on **Business Profile**, **Contact Updates (OTP)**, **Transaction Fees**, and **Transfer Authorization**.

## 1. Business Profile Management

View and manage basic business details.

### Endpoints

#### A. Get Business Profile Settings
**GET** `/api/settings`

*   **Response**:
    ```json
    {
      "success": true,
      "settings": {
        "id": "uuid",
        "name": "My Business",
        "email": "business@example.com",
        "phone_number": "+2348012345678",
        "industry": "Technology",
        "logo_url": "https://example.com/logo.png",
        "currency": "NGN"
      }
    }
    ```

#### B. Update Profile Settings
**PUT** `/api/settings`

*   **Payload** (All fields optional):
    ```json
    {
      "name": "My Business Updated",
      "industry": "Fintech",
      "logo_url": "https://example.com/new-logo.png",
      "currency": "NGN" // "NGN" or "USD"
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "message": "Settings updated successfully"
    }
    ```

---

## 2. Contact Information Updates (OTP Verified)

Users (Team Members/Admins) can update their business email or phone number. This process is secured via OTP.

### Flow
1.  **Request OTP**: User enters new email/phone.
2.  **Receive OTP**: System sends OTP to the *new* contact method.
3.  **Verify OTP**: User enters OTP to confirm and finalize the update.

### Endpoints

#### A. Request Update OTP
**POST** `/api/settings/update-contact/request-otp`

*   **Payload**:
    ```json
    {
      "type": "email", // or "phone"
      "value": "new-email@example.com" // or "+2348012345678"
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "message": "OTP sent to new-email@example.com"
    }
    ```

#### B. Verify Update OTP
**POST** `/api/settings/update-contact/verify-otp`

*   **Payload**:
    ```json
    {
      "otp": "123456"
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "message": "Contact information updated successfully"
    }
    ```

---

## 3. Transaction OTP Preferences

Businesses can configure how they receive OTPs for transaction authorization.
*   **Email**: Free (Default).
*   **SMS**: Charged (Fee applied per SMS).
*   **Both**: Charged (Fee applied per SMS).
*   *Note: At least one method must be active.*

### Endpoints

#### A. Get Preference
**GET** `/api/settings/otp-preference`

*   **Response**:
    ```json
    {
      "success": true,
      "preference": "email" // "email", "sms", or "both"
    }
    ```

#### B. Update Preference
**PUT** `/api/settings/otp-preference`

*   **Payload**:
    ```json
    {
      "preference": "sms"
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "message": "OTP preference updated"
    }
    ```

---

## 4. Fee Transparency

Users can view the fee structure applicable to their transactions.

### Endpoint

#### Get Fee Schedule
**GET** `/api/fees`

*   **Response**:
    ```json
    {
      "success": true,
      "data": [
        {
          "category": "transfer",
          "config_type": "flat",
          "config_value": { "amount": 50 }
        },
        {
          "category": "funding_card",
          "config_type": "percentage_cap",
          "config_value": { "percentage": 1.5, "cap": 2000 }
        }
      ]
    }
    ```

---

## 5. Transfer Authorization (OTP Required)

All transfers (Single or Bulk) now require OTP authorization. The OTP is valid for 10 minutes.

### Flow
1.  **Initiate Transfer (UI)**: User fills transfer details.
2.  **Request OTP**: Frontend calls `otp/request`.
3.  **User Receives OTP**: Via Email, SMS, or Both (based on preference).
4.  **Confirm Transfer**: Frontend submits transfer payload *including* the `otp`.

### Endpoints

#### A. Request Transfer OTP
**POST** `/api/transfers/otp/request`

*   **Payload**:
    ```json
    {
      "wallet_id": "uuid-optional" // Optional: Specific wallet to charge SMS fee from (if applicable)
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "message": "OTP sent successfully",
      "fee_charged": 0 // Amount charged if SMS preference is active
    }
    ```

#### B. Single Transfer (With OTP)
**POST** `/api/transfers/single`

*   **Payload**:
    ```json
    {
      "bankCode": "058",
      "accountNumber": "0123456789",
      "accountName": "John Doe",
      "amount": 5000,
      "remark": "Payment for services",
      "otp": "123456", // REQUIRED
      "wallet_id": "uuid-optional"
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "message": "Transfer initiated successfully"
    }
    ```

#### C. Bulk Transfer (With OTP)
**POST** `/api/transfers/bulk`

*   **Payload**:
    ```json
    {
      "type": "manual",
      "source_wallet_id": "uuid-required",
      "otp": "123456", // REQUIRED
      "data": {
        "items": [
          { "amount": 1000, "bankCode": "058", "accountNumber": "000..." },
          { "amount": 2000, "bankCode": "033", "accountNumber": "111..." }
        ]
      }
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "message": "Queued 2 transfers for processing"
    }
    ```

### 6. Get Platform Revenue
- **Endpoint**: `GET /admin/revenue`
- **Description**: Returns the current balance of the platform's revenue wallet (accumulated fees and subscriptions).
- **Response**:
    ```json
    {
      "success": true,
      "wallet": {
        "id": "uuid",
        "balance": "52259.00",
        "currency": "NGN"
      },
      "wallets": [
        {
            "id": "uuid",
            "balance": "52259.00",
            "currency": "NGN"
        },
        {
            "id": "uuid",
            "balance": "99.00",
            "currency": "USD"
        }
      ]
    }
    ```

### 7. Get Revenue History
