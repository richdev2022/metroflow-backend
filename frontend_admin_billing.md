# Frontend Integration Guide: Admin Billing & Subscription Management

This guide covers the integration points for the Admin Dashboard related to billing, subscriptions, and pricing management.

## Base URL
All endpoints are relative to your API base URL (e.g., `http://localhost:5000/api`).

## Authentication
All endpoints require the `Authorization` header with a valid Admin Bearer token.
`Authorization: Bearer <admin_token>`

---

## 1. Dashboard Analytics
Get high-level billing stats and charts.

### Stats Cards
- **Endpoint**: `GET /admin/dashboard/stats`
- **Auth**: Required (Permission: `view_dashboard`)

#### Response
```json
{
  "success": true,
  "stats": {
    "totalBusinesses": 10,
    "totalUsers": 50,
    "activeBusinesses": 8,
    "totalRevenue": 150000 // Total successful transaction amount
  }
}
```

### Revenue Charts
- **Endpoint**: `GET /admin/dashboard/charts`
- **Auth**: Required (Permission: `view_dashboard`)

#### Response
```json
{
  "success": true,
  "charts": {
    "revenueData": [
      { "name": "Jul", "revenue": 50000 },
      { "name": "Aug", "revenue": 75000 }
    ],
    "businessGrowthData": [
      { "name": "Jul", "businesses": 2 },
      { "name": "Aug", "businesses": 5 }
    ]
  }
}
```

---

## 2. Transaction Monitoring
View all transactions across all businesses.

- **Endpoint**: `GET /admin/transactions`
- **Auth**: Required (Permission: `view_dashboard`)
- **Query Params**:
  - `page`: default 1
  - `perPage`: default 50
  - `status`: success, pending, failed
  - `reference`: search by txn reference
  - `businessId`: filter by specific business
  - `startDate`, `endDate`: filter by date range

### Response
```json
{
  "success": true,
  "transactions": [
    {
      "id": "txn-uuid",
      "amount": "5000.00",
      "currency": "NGN",
      "status": "success",
      "reference": "TXN_...",
      "business_name": "Acme Corp",
      "plan_name": "Pro Plan",
      "created_at": "2023-..."
    }
  ],
  "pagination": {
    "total": 100,
    "page": 1,
    "totalPages": 2
  }
}
```

---

## 3. Pricing Plan Management
Manage the subscription plans available to users.

### Get All Plans
- **Endpoint**: `GET /admin/pricing`
- **Auth**: Required (Permission: `manage_plans`)

#### Response
```json
{
  "success": true,
  "plans": [
    {
      "id": "plan-uuid",
      "name": "Starter",
      "price": "29.00",
      "currency": "USD",
      "is_active": true,
      "features": ["Feature A", "Feature B"],
      "max_team_members": 5,
      "trial_days": 7
    }
  ]
}
```

### Create New Plan
- **Endpoint**: `POST /admin/pricing`
- **Auth**: Required (Permission: `manage_plans`)
- **Payload**:
```json
{
  "name": "Enterprise",
  "description": "For large teams",
  "price": 299.00,
  "currency": "USD",
  "features": ["All Features", "Priority Support"],
  "max_team_members": 50,
  "trial_days": 14
}
```

#### Response
```json
{
  "success": true
}
```

### Update Plan
- **Endpoint**: `PUT /admin/pricing/:id`
- **Auth**: Required (Permission: `manage_plans`)
- **Payload**:
```json
{
  "name": "Enterprise Updated",
  "description": "For large teams",
  "price": 349.00,
  "is_active": true,
  "features": ["All Features", "Priority Support", "Dedicated Agent"],
  "max_team_members": 100,
  "trial_days": 14
}
```

#### Response
```json
{
  "success": true
}
```

---

## 4. Business Subscription Management
View and manage business subscriptions directly.

### Get All Businesses
- **Endpoint**: `GET /admin/businesses`
- **Auth**: Required (Permission: `manage_businesses`)

#### Response
```json
{
  "success": true,
  "businesses": [
    {
      "id": "business-uuid",
      "name": "Client Company",
      "subscription_status": "active",
      "plan_name": "Starter",
      "trial_ends_at": "2023-..."
    }
  ]
}
```

### Update Business Status
Manually update a business's subscription status (e.g., suspend or activate).

- **Endpoint**: `PUT /admin/businesses/:id/status`
- **Auth**: Required (Permission: `manage_businesses`)
- **Payload**:
```json
{
  "status": "active" // active, inactive, past_due
}
```

#### Response
```json
{
  "success": true
}
```
