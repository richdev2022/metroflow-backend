# Plan Management Endpoints

This document outlines the API endpoints and flow for managing pricing plans and their associated feature permissions. This allows for dynamic feature toggling per plan.

## Overview

The plan management flow consists of:
1.  **Fetching Available Permissions:** Retrieve the list of all system features that can be toggled.
2.  **Creating a Plan:** Define a new pricing plan and specify which features are enabled (toggled ON).
3.  **Updating a Plan:** Modify an existing plan, including its enabled features.

## Feature Permissions

Permissions are feature flags that control access to specific parts of the application.

### Endpoint: Get Available Features
Returns a list of all available permissions that can be assigned to a plan.

- **URL:** `/api/admin/features`
- **Method:** `GET`
- **Auth Required:** Yes (Admin Token)

#### Response (Success 200)
```json
{
  "success": true,
  "features": [
    {
      "id": "view_dashboard",
      "name": "View Dashboard",
      "description": "Access to view the main dashboard and analytics"
    },
    {
      "id": "manage_tasks",
      "name": "Manage Tasks",
      "description": "Create, update, and delete tasks"
    },
    {
      "id": "manage_team",
      "name": "Manage Team",
      "description": "Invite and manage team members"
    },
    {
      "id": "manage_epics",
      "name": "Manage Epics",
      "description": "Create and manage epics/projects"
    },
    {
      "id": "manage_ideas",
      "name": "Manage Ideas",
      "description": "Submit and vote on ideas"
    },
    {
      "id": "view_activity",
      "name": "View Activity Logs",
      "description": "Access to view team activity history"
    },
    {
      "id": "export_data",
      "name": "Export Data",
      "description": "Ability to export reports and data"
    },
    {
      "id": "view_ranking",
      "name": "View Ranking",
      "description": "Access to view team ranking and leaderboards"
    }
  ]
}
```

## Pricing Plans

### Endpoint: Create Pricing Plan
Creates a new pricing plan with specific feature permissions enabled.

- **URL:** `/api/admin/pricing`
- **Method:** `POST`
- **Auth Required:** Yes (Admin Token)

#### Request Body
```json
{
  "name": "Pro Plan",
  "description": "For growing teams",
  "price": 29.99,
  "currency": "USD",
  "duration": "monthly",
  "max_team_members": 10,
  "trial_days": 14,
  "features": [
    "Unlimited Projects",
    "Priority Support"
  ],
  "permissions": [
    "view_dashboard",
    "manage_tasks",
    "manage_team",
    "view_ranking"
  ]
}
```
*Note: `features` is for display purposes (marketing text), while `permissions` controls actual system access. `duration` can be `monthly` or `yearly` (defaults to `monthly`).*

#### Response (Success 200)
```json
{
  "success": true
}
```

### Endpoint: Update Pricing Plan
Updates an existing pricing plan.

- **URL:** `/api/admin/pricing/:id`
- **Method:** `PUT`
- **Auth Required:** Yes (Admin Token)

#### Request Body
```json
{
  "name": "Pro Plan Updated",
  "price": 35.00,
  "duration": "yearly",
  "permissions": [
    "view_dashboard",
    "manage_tasks",
    "manage_team",
    "view_ranking",
    "export_data"
  ]
}
```

#### Response (Success 200)
```json
{
  "success": true
}
```

## Access Control Behavior

When a business user attempts to access a feature (API endpoint):
1.  The system checks the user's business plan.
2.  It verifies if the plan has the required permission in its `permissions` list.
3.  **Authorized:** Request proceeds normally.
4.  **Unauthorized:** Returns HTTP 403 Forbidden with the error:
    ```json
    {
      "success": false,
      "error": "Kindly upgrade your plan to enjoy this feature."
    }
    ```
