# API Endpoints Documentation

This document outlines the available API endpoints for the MetroFlow Backend.

## Base URL
`/api`

## Authentication (`/auth`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/register` | Register a new business and admin user | No |
| POST | `/verify-otp` | Verify OTP for registration | No |
| POST | `/login` | Login for business users | No |
| POST | `/refresh-token` | Refresh access token | No |
| POST | `/logout` | Logout user | Yes |

## Admin Management (`/admin`)
*Requires Admin Authentication*

### Admin Auth
| Method | Endpoint | Description | Permissions |
|--------|----------|-------------|-------------|
| POST | `/login` | Admin login | None |
| GET | `/me` | Get current admin details | None |

### Role Management
| Method | Endpoint | Description | Permissions |
|--------|----------|-------------|-------------|
| GET | `/roles` | List all roles | `manage_roles` |
| POST | `/roles` | Create a new role | `manage_roles` |
| PUT | `/roles/:id` | Update a role | `manage_roles` |
| DELETE | `/roles/:id` | Delete a role | `manage_roles` |
| GET | `/permissions` | List all available permissions | `manage_roles` |

### Admin User Management
| Method | Endpoint | Description | Permissions |
|--------|----------|-------------|-------------|
| GET | `/users` | List all admin users | `manage_admins` |
| POST | `/users/invite` | Invite a new admin user | `manage_admins` |
| PUT | `/users/:id/role` | Update an admin's role | `manage_admins` |
| DELETE | `/users/:id` | Remove an admin user | `manage_admins` |

### System Data
| Method | Endpoint | Description | Permissions |
|--------|----------|-------------|-------------|
| GET | `/businesses` | List all businesses | `view_businesses` |
| GET | `/analytics` | Get platform analytics | `view_analytics` |

## Dashboard (`/dashboard`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/metrics` | Get dashboard metrics (tasks, completion, etc.) | Yes |

## Tasks (`/tasks`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/` | List tasks (filters: status, priority, assignee) | Yes |
| POST | `/` | Create a new task | Yes |
| GET | `/:id` | Get task details | Yes |
| PUT | `/:id` | Update task | Yes |
| DELETE | `/:id` | Delete task | Yes |
| PUT | `/:id/status` | Update task status | Yes |

## Epics (`/epics`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/` | List epics | Yes |
| POST | `/` | Create a new epic | Yes |
| GET | `/:id` | Get epic details | Yes |
| PUT | `/:id` | Update epic | Yes |
| DELETE | `/:id` | Delete epic | Yes |

## Comments (`/comments`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/:taskId` | Get comments for a task (via query params) | Yes |
| POST | `/` | Add a comment | Yes |
| PUT | `/:id` | Update a comment | Yes |
| DELETE | `/:id` | Delete a comment | Yes |
| POST | `/:id/reply` | Reply to a comment | Yes |
| POST | `/:id/reaction` | Add reaction to comment | Yes |

## Team & Members (`/team`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/members` | List team members | Yes |
| POST | `/invite` | Invite new member | Yes |
| PUT | `/members/:id` | Update member details | Yes |
| DELETE | `/members/:id` | Remove member | Yes |

## Assignments (`/assignments`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/` | Assign user to task | Yes |
| DELETE | `/` | Remove assignment | Yes |

## Activity (`/activity`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/` | Get activity logs | Yes |

## Ideas (`/ideas`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/` | List ideas | Yes |
| POST | `/` | Submit an idea | Yes |
| PUT | `/:id/vote` | Vote on an idea | Yes |
| PUT | `/:id/status` | Update idea status (Admin only) | Yes |

## Subscription (`/subscription`)
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/current` | Get current subscription details | Yes |
| POST | `/checkout` | Create checkout session | Yes |
| POST | `/portal` | Create customer portal session | Yes |
| POST | `/webhook` | Stripe webhook handler | No |
