
# OTP, WhatsApp & Transaction PIN Integration Guide (Frontend)

## Table of Contents
1. [Overview](#overview)
2. [WhatsApp OTP Support](#whatsapp-otp-support)
3. [Endpoints Reference](#endpoints-reference)
4. [Transaction PIN Management](#transaction-pin-management)
5. [OTP Toggles](#otp-toggles)
6. [Sample Requests & Responses](#sample-requests--responses)

---

## Overview

This integration provides your users with:
- WhatsApp as an OTP delivery option (alongside SMS and email)
- Transaction PIN for extra transfer security
- Business-level OTP toggle settings
- OTP method overrides per request
- Separate configurable fees for OTP SMS and WhatsApp (for transfers only; KYC/BVN/NIN OTPs are free)

---

## WhatsApp OTP Support

Your users can now choose **WhatsApp**, **SMS**, or **Email** for OTP delivery via:
- Transfer OTP requests
- KYC (BVN/NIN) OTP requests

---

## Endpoints Reference

### 1. Transfers

#### 1.1 Request OTP for Transfer
`POST /transfers/otp/request`

**Authentication: Bearer Token

**Request Body:**
```json
{
  "otp_method": "whatsapp",  // Optional: "whatsapp" | "sms" | "email"
  "wallet_id": "550e8400-e29b-41d4-a716-446655440000"  // Optional
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "fee_charged": 10.5
}
```

---

#### 1.2 Single Transfer
`POST /transfers/single`

**Authentication: Bearer Token**

**Request Body:**
```json
{
  "bankCode": "058",
  "accountNumber": "0123456789",
  "accountName": "John Doe",
  "amount": 5000,
  "remark": "Payment for services",
  "otp": "123456",  // Required if OTP is enabled for the business
  "pin": "1234",    // Required (Always required)
  "wallet_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Transfer initiated successfully",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "reference": "TRF-1234567890",
    "amount": 5000,
    "currency": "NGN",
    "fee": 10.5,
    "total": 5010.5,
    "recipient": {
      "accountNumber": "0123456789",
      "bankCode": "058",
      "accountName": "John Doe"
    },
    "status": "pending",
    "walletId": "550e8400-e29b-41d4-a716-446655440000",
    "paymentProvider": "squad"
  }
}
```

---

#### 1.3 Bulk Transfer
`POST /transfers/bulk`

**Authentication: Bearer Token**

**Request Body (Epic Type - Custom List):**
```json
{
  "type": "Epic",
  "otp": "123456",  // Required if OTP is enabled
  "pin": "1234",   // Required
  "source_wallet_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "items": [
      {
        "amount": 5000,
        "bankCode": "058",
        "accountNumber": "0123456789",
        "accountName": "John Doe",
        "remark": "Payment for services"
      },
      {
        "amount": 10000,
        "bankCode": "033",
        "accountNumber": "9876543210",
        "accountName": "Jane Smith",
        "remark": "Commission"
      }
    ]
  }
}
```

**Request Body (Salary Type):**
```json
{
  "type": "Salary",
  "otp": "123456",  // Required if OTP is enabled
  "pin": "1234",   // Required
  "source_wallet_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

### 2. KYC

#### 2.1 Initiate KYC Verification (BVN or NIN)
`POST /kyc/initiate`

**Authentication: Bearer Token**

**Request Body:**
```json
{
  "type": "bvn",  // Or "nin"
  "number": "12345678901",
  "otp_method": "whatsapp"  // Optional: "whatsapp" | "sms" | "email"
}
```

---

### 3. Settings

#### 3.1 Get OTP Toggle Status & PIN Info
`GET /settings/otp-enabled`

**Authentication: Bearer Token**

**Response:**
```json
{
  "success": true,
  "otpEnabled": true,
  "pinCreated": true
}
```

---

#### 3.2 Toggle OTP Requirement for Transfers
`PUT /settings/otp-enabled`

**Authentication: Bearer Token**

**Request Body:**
```json
{
  "enabled": false
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP disabled successfully"
}
```

---

#### 3.3 Create Transaction PIN
`POST /settings/pin`

**Authentication: Bearer Token**

**Request Body:**
```json
{
  "pin": "1234"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Transaction PIN created successfully"
}
```

---

#### 3.4 Send PIN Update OTP
`POST /settings/pin/send-otp`

**Authentication: Bearer Token**

**Response:**
```json
{
  "success": true,
  "message": "OTP sent successfully"
}
```

---

#### 3.5 Update Transaction PIN
`PUT /settings/pin`

**Authentication: Bearer Token**

**Request Body:**
```json
{
  "newPin": "4321",
  "otp": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Transaction PIN updated successfully"
}
```

---

#### 3.6 Get Default OTP Preference
`GET /settings/otp-preference`

**Authentication: Bearer Token**

**Response:**
```json
{
  "success": true,
  "preference": "email"
}
```

---

#### 3.7 Update Default OTP Preference
`PUT /settings/otp-preference`

**Authentication: Bearer Token**

**Request Body:**
```json
{
  "preference": "sms"  // Or "email", "whatsapp", or "both"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP preference updated"
}
```

---

## Transaction PIN Management

### PIN Flow
1. **Create PIN**: First time, call `POST /settings/pin`
2. **Use PIN**: Always include in `/transfers/single` & `/transfers/bulk`
3. **Update PIN**: Call `POST /settings/pin/send-otp` → then `PUT /settings/pin`

### Important Notes
- PIN is **always required** for transfers (even when OTP is disabled)
- OTP is optional (toggleable via business-level setting)

---

## OTP Toggles

| Endpoint | What it Does |
|----------|---------|
| `PUT /settings/otp-enabled` | Turn transfer OTP requirement on/off |
| `PUT /settings/otp-preference` | Set business default OTP method |
| `/transfers/otp/request?otp_method=` | Override OTP method per transfer |
| `/kyc/initiate?otp_method=` | Override OTP method per KYC |

---

## Sample Requests & Responses

### Request OTP via WhatsApp
**Request:**
```http
POST /transfers/otp/request
Authorization: Bearer <your-token>
Content-Type: application/json

{
  "otp_method": "whatsapp"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "fee_charged": 10.5
}
```

---

### Single Transfer with PIN & OTP
**Request:**
```http
POST /transfers/single
Authorization: Bearer <your-token>
Content-Type: application/json

{
  "bankCode": "058",
  "accountNumber": "0123456789",
  "amount": 5000,
  "pin": "1234",
  "otp": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Transfer initiated successfully",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "reference": "TRF-1234567890",
    "amount": 5000,
    "currency": "NGN",
    "fee": 10.5,
    "total": 5010.5,
    "status": "pending"
  }
}
```

---

### Toggle OTP OFF
**Request:**
```http
PUT /settings/otp-enabled
Authorization: Bearer <your-token>
Content-Type: application/json

{
  "enabled": false
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP disabled successfully"
}
```
