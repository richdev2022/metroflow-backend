
# Environment Variables Setup Guide

This guide will help you set up all required environment variables for MetricFlow.

## Table of Contents
1. [Database](#database)
2. [Authentication](#authentication)
3. [API Configuration](#api-configuration)
4. [Payment Providers](#payment-providers)
   - [Squad](#squad-payment-gateway)
   - [Monnify](#monnify-payment-gateway)
5. [SMS & WhatsApp](#sms--whatsapp)
   - [Termii](#termii)
   - [Kudi](#kudi)
6. [Caching & Background Jobs](#caching--background-jobs)
7. [Error Monitoring](#error-monitoring)
8. [File Storage](#file-storage)
9. [Web Push (VAPID)](#9-web-push-vapid--optional-auto-generated)

---

## 1. Database
### PostgreSQL (Neon or Local)
```env
DATABASE_URL="postgresql://user:password@host:port/database"
```
- **How to get**:
  - **Neon**: Sign up at [neon.tech](https://neon.tech/), create a database, and copy the connection string.
  - **Local**: Set up PostgreSQL locally and use your local credentials.

---

## 2. Authentication
```env
JWT_SECRET="your-super-secret-jwt-key"
TOKEN_IDLE_TIMEOUT_MINUTES=30
```
- **JWT_SECRET**: Generate a secure random string using `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- **TOKEN_IDLE_TIMEOUT_MINUTES**: Default is 30 minutes.

---

## 3. API Configuration
```env
CLIENT_URL="http://localhost:8081"
API_BASE_URL="http://localhost:3000"
```
- **CLIENT_URL**: URL of your frontend application.
- **API_BASE_URL**: URL of your backend API (without `/api` prefix).

---

## 4. Payment Providers

### Squad Payment Gateway
```env
SQUAD_SECRET_KEY=
SQUAD_ENV=sandbox
DEFAULT_PAYMENT_PROVIDER=squad
```
- **How to get**:
  1. Sign up at [squadco.com](https://squadco.com/)
  2. Navigate to Settings > API Keys
  3. Copy your Secret Key
  4. Use `sandbox` for testing, `live` for production.

### Monnify Payment Gateway
```env
MONNIFY_API_KEY=
MONNIFY_SECRET_KEY=
MONNIFY_CONTRACT_CODE=
MONNIFY_BASE_URL=https://sandbox.monnify.com
MONNIFY_WALLET_ACCOUNT_NUMBER=
```
- **How to get**:
  1. Sign up at [monnify.com](https://monnify.com/)
  2. Navigate to Settings > API Keys to get API Key and Secret Key.
  3. Contract Code is in your Monnify dashboard.

---

## 5. SMS & WhatsApp

### Meta WhatsApp Business API (Default)
```env
META_GRAPH_API_URL=https://graph.facebook.com/v20.0
META_WHATSAPP_ACCESS_TOKEN=
META_WHATSAPP_PHONE_NUMBER_ID=
DEFAULT_WHATSAPP_PROVIDER=meta
```
- **How to get**:
  1. Go to [developers.facebook.com](https://developers.facebook.com/) and create a Facebook Developer account.
  2. Create a new App, select "Business" as the app type.
  3. Add the WhatsApp Business API product to your app.
  4. Get your Access Token from App Dashboard > WhatsApp > Getting Started.
  5. Get your Phone Number ID from App Dashboard > WhatsApp > Phone Numbers.
  6. For production, you will need to verify your business and a phone number with Meta.

### KudiSMS (Default for SMS — OTPs & notifications)
```env
KUDI_API_KEY=
KUDI_SENDER_ID=
DEFAULT_SMS_PROVIDER=kudi
```
- **How to get**:
  1. Sign up at [my.kudisms.net](https://my.kudisms.net/) (KudiSMS — kudisms.net; NOT kudi.ai, which is a different company).
  2. Copy your API Key from the dashboard → this is `KUDI_API_KEY`.
  3. Submit your Sender ID (e.g. `METRICOREX`) for approval as a **Corporate** Sender ID from the dashboard — corporate approval is required for the transactional route this backend uses (`POST /api/corporate`). Set the approved ID as `KUDI_SENDER_ID`.
  4. Optional: `KUDI_API_BASE` overrides the API base URL (default `https://my.kudisms.net/api`).
- **Behavior**: all OTP/notification SMS (transfer OTP, PIN-update OTP, OTP-toggle OTP, KYC OTP, contact-change OTP) go through KudiSMS and are checked against the provider response — a rejected delivery now fails the request with the provider's reason (e.g. invalid token, unapproved sender ID, insufficient balance) instead of silently pretending success.
- **Docs**: [API overview](https://www.kudisms.net/docs) · [SMS endpoints](https://www.kudisms.net/docs/sms/) · [Error codes](https://www.kudisms.net/docs/errors/)

### Termii (Backup for SMS & WhatsApp)
```env
TERMII_API_KEY=
TERMII_SENDER_ID=N-Alert
TERMII_WHATSAPP_NUMBER=
```
- **How to get**:
  1. Sign up at [termii.com](https://termii.com/)
  2. Go to Settings > API Keys to get your API Key.
  3. Sender ID can be your business name (must be approved for production).
  4. For WhatsApp, you need to set up a WhatsApp number in your Termii dashboard.
  5. Termii is NOT the default SMS provider anymore — only used if you set `DEFAULT_SMS_PROVIDER=termii`, or as a WhatsApp channel via `DEFAULT_WHATSAPP_PROVIDER=termii`.

---

## 6. Caching & Background Jobs
```env
REDIS_URL="redis://localhost:6379"
```
- **How to get**:
  - **Local**: Install and run Redis locally.
  - **Upstash (free tier)**: Sign up at [upstash.com](https://upstash.com/), create a Redis database, and copy the connection URL.

---

## 7. Error Monitoring
```env
SENTRY_DSN=
```
- **How to get**:
  1. Sign up at [sentry.io](https://sentry.io/)
  2. Create a new Node.js project.
  3. Copy the DSN from your project settings.

---

## 8. File Storage (Cloudflare R2)
```env
CLOUDFLARE_R2_ACCOUNT_ID=
CLOUDFLARE_R2_ACCESS_KEY_ID=
CLOUDFLARE_R2_SECRET_ACCESS_KEY=
CLOUDFLARE_R2_BUCKET_NAME=
CLOUDFLARE_R2_PUBLIC_URL=
```
- **How to get**:
  1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/)
  2. Navigate to R2 > Create Bucket.
  3. Account ID is found in the Cloudflare dashboard URL (after `dash.cloudflare.com/`).
  4. Go to R2 > Manage R2 API Tokens to create an Access Key and Secret Key.
  5. (Optional) Set up a Custom Domain for your bucket to use as `CLOUDFLARE_R2_PUBLIC_URL`.

---

## 9. Web Push (VAPID) — optional, auto-generated
```env
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT="mailto:support@metricorex.com"
```
- **Purpose**: browser push notifications (incoming-call rings, missed-call
  notices) via the Web Push protocol. Mobile keeps using FCM
  (`FIREBASE_SERVICE_ACCOUNT_JSON` / `FCM_SERVER_KEY`).
- **How to get**:
  - **Nothing to do (default)**: if both keys are missing at boot, the backend
    generates a key pair with `webpush.generateVAPIDKeys()`, persists it to the
    `system_settings` table (`vapid_public_key` / `vapid_private_key`) and
    prints a banner with both keys — copy them into `.env` (and your secret
    manager) so they are STABLE across deployments and database resets.
    Changing the public key silently invalidates every existing browser
    subscription.
  - **Manual**: generate a pair once with
    `node -e "console.log(require('web-push').generateVAPIDKeys())"` and paste
    the values here.
- **VAPID_SUBJECT** (optional): a `mailto:` or `https:` contact URL sent with
  every push; defaults to `mailto:support@metricorex.com`.
- Related endpoints: `POST /push/subscribe`, `POST /push/unsubscribe`,
  `GET /push/vapid-public-key`.

---

## Quick Start
1. Copy `.env.example` to `.env`
2. Fill in all required variables using the guides above
3. Restart your development server
