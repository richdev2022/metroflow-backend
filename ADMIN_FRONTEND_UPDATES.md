# Admin Frontend Updates for Plan Management

This document outlines the updates required in the Admin Frontend to support the new **Plan Discount** feature.

## Overview
Admins can now add and update a `discount` value for Monthly and Yearly pricing plans. This discount is subtracted from the original plan price during subscription payments.

## API Endpoints

### 1. List All Plans (Admin View)
**Endpoint:** `GET /admin/pricing`
**Description:** Retrieve all pricing plans (active and inactive) to display in the admin dashboard.

**Response:**
```json
{
  "success": true,
  "plans": [
    {
      "id": "uuid",
      "name": "Pro Plan",
      "price": "5000.00",
      "currency": "NGN",
      "duration": "monthly",
      "discount": "500.00", // New Field
      "features": ["Feature 1", "Feature 2"],
      "is_active": true,
      "created_at": "timestamp"
    }
  ]
}
```

### 2. Create New Plan
**Endpoint:** `POST /admin/pricing`
**Description:** Create a new pricing plan with an optional discount.

**Request Body:**
```json
{
  "name": "Enterprise Plan",
  "price": 100000,
  "currency": "NGN",
  "duration": "yearly",
  "discount": 5000, // New Field (Optional, default 0)
  "features": ["All Features", "Priority Support"]
}
```

**Response:**
```json
{
  "success": true,
  "plan": { ... } // Created plan object
}
```

### 3. Update Existing Plan
**Endpoint:** `PUT /admin/pricing/:id`
**Description:** Update details of an existing plan, including the discount.

**Request Body:**
```json
{
  "price": 120000,
  "discount": 10000 // Update discount
}
```
*Note: You can update `name`, `price`, `discount`, `features`, or `is_active` individually or together.*

## UI Implementation Tasks
1.  **Plan Management Page**:
    -   Add a column for "Discount" in the plans table.
    -   Display the Final Price (Price - Discount) for reference.
2.  **Add/Edit Plan Modal**:
    -   Add a numeric input field for "Discount Amount".
    -   Ensure validation: Discount cannot be greater than Price.
    -   (Optional) Show a live preview of the "Final Charge Amount".
