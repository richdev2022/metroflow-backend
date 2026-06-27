
# Metroflow Platform - Product Documentation

## Table of Contents

1. [Product Overview](#product-overview)
2. [User Types & Access](#user-types--access)
3. [Core Features](#core-features)
4. [Functional Requirements](#functional-requirements)
5. [Non-Functional Requirements](#non-functional-requirements)
6. [Performance Requirements](#performance-requirements)
7. [User Flows](#user-flows)

---

## Product Overview

**Metroflow** is an all-in-one business management platform that combines project management, team collaboration, and financial operations in a single solution. It helps businesses streamline their operations from project planning to payroll processing.

**Key Value Proposition**:
- Centralize project management and financial operations
- Reduce manual work with automated processes
- Provide real-time visibility into business performance
- Ensure compliance with built-in KYC verification

---

## User Types & Access

### 1. Business Owner
- **Full access** to all business features
- Can manage team members, settings, and financial operations
- Primary responsible for KYC and business wallet setup

### 2. Team Member
- **Limited access** based on role permissions
- Can view and manage assigned tasks
- Can access personal wallet and financial information

### 3. Platform Admin
- **Oversight access** to the entire platform
- Manages businesses, users, and system settings
- Reviews KYC submissions and resolves disputes

### 4. Mobile & Web Users
- **Cross-platform access**: Available on web and mobile (responsive design)
- Consistent experience across devices

---

## Core Features

### Project Management Module

#### Tasks
- Create, edit, and delete tasks
- Set targets, due dates, and statuses
- Assign tasks to team members
- Bulk operations for efficiency
- Overdue task detection and alerts

#### Epics & Sprints
- Organize tasks into epics for better planning
- Manage sprints for agile workflows
- Link tasks to specific epics

#### Team Collaboration
- Invite and manage team members
- Role-based access control
- Team rankings and performance tracking
- Comments and mentions on tasks and epics
- File attachments and idea submissions

### Financial Operations Module

#### Wallets
- **Personal Wallets**: For individual team members
- **Business Wallets**: For organizational funds
- **Virtual Accounts**: For easy wallet funding via bank transfers
- Real-time balance tracking

#### Funding
- Fund wallets via debit/credit card
- Fund wallets via bank transfer to virtual accounts
- Instant balance updates on successful funding

#### Transfers & Payroll
- Bulk transfers to multiple recipients
- Salary processing (monthly, custom intervals)
- Sprint/task-based payments
- Manual transfers
- Automatic retry for failed transfers
- Transaction history and status tracking

#### KYC Verification
- User KYC: BVN or NIN verification
- Business KYC: Address verification + proof of address
- OTP-based verification
- Admin review workflow

### Subscription & Billing

#### Pricing Plans
- Multiple plan options (Free Trial, Starter, Pro)
- Feature-based permissions
- Team size limits
- Monthly/yearly billing options

#### Subscription Management
- Trial period management
- Plan upgrades/downgrades
- Card-on-file for automatic renewals
- Expired subscription handling

### Admin Module

#### Business Oversight
- View and manage all businesses on the platform
- Update business status (active/inactive)
- Monitor business activity

#### KYC Review
- Review pending business KYC submissions
- Approve or reject with reasons
- Email notifications to businesses

#### Transaction Monitoring
- View all platform transactions
- Filter by status, date, business
- Manual settlement capabilities

#### Platform Management
- Manage pricing plans
- Configure fees
- Manage admin users and roles
- Set system-wide settings
- View platform analytics and dashboard

---

## Functional Requirements

### Authentication & Authorization
- FR1: Users shall be able to register a new business
- FR2: Users shall be able to login with email and password
- FR3: OTP verification shall be required for registration and password reset
- FR4: Role-based access control shall restrict features based on user role
- FR5: Sessions shall expire after a period of inactivity

### Project Management
- FR6: Business owners shall create, edit, and delete tasks
- FR7: Tasks shall be organized into epics and sprints
- FR8: Tasks shall be assignable to team members
- FR9: Team members shall add comments and attachments to tasks
- FR10: Overdue tasks shall be automatically detected and marked
- FR11: Bulk operations shall be supported for tasks
- FR12: Team members shall be invited and managed
- FR13: Team performance rankings shall be visible
- FR14: Idea submission and management shall be supported

### Financial Operations
- FR15: Users shall complete KYC verification (BVN/NIN)
- FR16: Businesses shall complete business KYC verification
- FR17: Personal wallets shall be created automatically upon KYC approval
- FR18: Business wallets shall be created upon business KYC approval
- FR19: Virtual accounts shall be generated for wallet funding
- FR20: Wallets shall be fundable via card and bank transfer
- FR21: Bulk transfers shall be processed
- FR22: Salary shall be processed based on configured intervals
- FR23: Failed transfers shall be automatically retried
- FR24: Transaction history shall be viewable
- FR25: Payroll adjustments (bonuses/deductions) shall be supported

### Subscription & Billing
- FR26: Businesses shall subscribe to pricing plans
- FR27: Trial periods shall be available
- FR28: Plan upgrades and downgrades shall be supported
- FR29: Automatic subscription renewals shall be processed
- FR30: Expired subscriptions shall restrict feature access

### Admin Module
- FR31: Platform admins shall login and manage the platform
- FR32: Admins shall view and manage all businesses
- FR33: Admins shall review and approve/reject KYC submissions
- FR34: Admins shall monitor all transactions
- FR35: Admins shall manage pricing plans and fees
- FR36: Admins shall manage other admin users and roles
- FR37: Platform analytics and dashboard shall be available

---

## Non-Functional Requirements

### Usability
- NFR1: The platform shall be intuitive and easy to navigate
- NFR2: Onboarding tutorials shall guide new users
- NFR3: Help documentation shall be accessible
- NFR4: Error messages shall be clear and actionable

### Security
- NFR5: All user data shall be encrypted in transit and at rest
- NFR6: Passwords shall be securely hashed and never stored in plain text
- NFR7: Two-factor authentication shall be available
- NFR8: Role-based access control shall be strictly enforced
- NFR9: Audit logs shall track all sensitive operations
- NFR10: Webhook signatures shall be validated

### Reliability
- NFR11: The platform shall have 99.5% uptime excluding scheduled maintenance
- NFR12: Data shall be backed up daily
- NFR13: Failed operations shall have retry mechanisms
- NFR14: System errors shall be logged and monitored

### Scalability
- NFR15: The platform shall support up to 10,000 concurrent users
- NFR16: Database operations shall scale with increasing data volume
- NFR17: The platform shall handle peak transaction volumes efficiently

### Compatibility
- NFR18: The web application shall work on all major browsers (Chrome, Firefox, Safari, Edge)
- NFR19: The platform shall be responsive and work on mobile devices
- NFR20: The API shall be versioned to support backward compatibility

---

## Performance Requirements

### Response Times
- PR1: Page loads shall complete in &lt; 2 seconds on 4G
- PR2: API endpoints shall respond in &lt; 500ms (95th percentile)
- PR3: Search operations shall complete in &lt; 1 second
- PR4: Bulk operations shall process 100 items in &lt; 5 seconds

### Throughput
- PR5: The platform shall handle 100 concurrent transactions per second
- PR6: The API shall support 500 concurrent requests

### Database
- PR7: Queries shall return results in &lt; 100ms for most operations
- PR8: Database indexing shall be optimized for common queries
- PR9: Large datasets shall be paginated to maintain performance

---

## User Flows

### Business Owner Onboarding
1. Register business with email and password
2. Verify email via OTP
3. Complete personal KYC (BVN/NIN)
4. Set up business profile
5. Complete business KYC (address + POA)
6. Wait for admin approval (if required)
7. Create business wallet
8. Subscribe to a pricing plan
9. Invite team members

### Team Member Onboarding
1. Receive invite email
2. Accept invite and create account
3. Complete personal KYC
4. Access assigned tasks and personal wallet

### Funding a Wallet
1. Navigate to wallet section
2. Select funding method (card or bank transfer)
3. Enter amount and complete payment
4. Wallet balance updates automatically

### Processing Payroll
1. Configure team members' salaries and bank details
2. Navigate to payroll section
3. Add any bonuses or deductions
4. Review payroll summary
5. Initiate bulk transfer
6. Monitor transfer status

### Admin KYC Review
1. Receive notification of new KYC submission
2. Navigate to admin KYC section
3. Review submitted documents and information
4. Approve or reject with reason
5. Business receives email notification

---

*Last Updated: June 2026*
