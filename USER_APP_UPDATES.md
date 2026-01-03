# User App Updates for Pricing Plans

This document outlines the updates required in the User App (Frontend) to display and handle the new **Plan Discount** feature.

## Overview
Pricing plans now support a `discount` field. If a plan has a discount, the UI should highlight the savings to encourage subscription.

## API Endpoints

### 1. List Pricing Plans
**Endpoint:** `GET /subscription/plans`
**Description:** Returns all active pricing plans available for subscription.

**Response Update:**
The `plans` array now includes a `discount` field.

```json
{
  "success": true,
  "plans": [
    {
      "id": "uuid",
      "name": "Standard Plan",
      "price": "5000.00", // Original Price
      "discount": "500.00", // Discount Amount
      "currency": "NGN",
      "duration": "monthly",
      "features": [...]
    }
  ]
}
```

### 2. Get Current Subscription
**Endpoint:** `GET /subscription/current`
**Description:** Returns details of the user's current subscription.

**Response Update:**
The `subscription` object now includes `plan_discount`.

```json
{
  "success": true,
  "subscription": {
    "plan_name": "Standard Plan",
    "plan_price": "5000.00",
    "plan_discount": "500.00",
    ...
  }
}
```

## UI Implementation Tasks

### 1. Pricing Page (Plan Selection)
When displaying a plan card:
-   **Check if `discount > 0`**.
-   **If Discounted**:
    -   Display the **Original Price** with a strikethrough (e.g., ~~₦5,000~~).
    -   Display the **Final Price** prominently (e.g., **₦4,500**).
        -   *Calculation:* `Final Price = Price - Discount`.
    -   (Optional) Add a badge saying "Save ₦500" or "Discount Applied".
-   **If No Discount**:
    -   Display the **Price** normally.

### 2. Payment Summary (Checkout)
Before initiating payment:
-   Show the breakdown:
    -   Subtotal: ₦5,000
    -   Discount: -₦500
    -   **Total Pay**: **₦4,500**

*Note: The backend automatically calculates the final charge amount based on these values, so the frontend only needs to display them correctly.*
