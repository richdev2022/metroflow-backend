# MetricFlow (Fusion Starter)

A comprehensive web application for tracking Key Performance Indicators (KPIs), managing developer tasks, and monitoring business performance. Built with a modern tech stack featuring React, Node.js, and PostgreSQL.

## 🚀 Features

- **Authentication & Authorization**: Secure login, registration, password recovery, and role-based access control (Admin/Developer).
- **Business Management**: Multi-tenant support with business-specific data isolation.
- **Task Management**:
  - Create and track tasks with targets and accomplished values.
  - Organize tasks by Sprints and Epics.
  - Assign tasks to specific developers.
  - Track status, due dates, and overdue items.
- **Dashboard**: Visual analytics using Recharts to monitor progress and KPIs.
- **Activity Logs**: Audit trail of user actions and system events.
- **Developer Management**: Manage team members, invites, and profiles.

## 🛠️ Tech Stack

### Frontend

- **Framework**: [React](https://reactjs.org/) with [Vite](https://vitejs.dev/)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **UI Components**: [Radix UI](https://www.radix-ui.com/) (via shadcn/ui patterns)
- **State Management**: [TanStack Query](https://tanstack.com/query/latest) (React Query)
- **Forms**: [React Hook Form](https://react-hook-form.com/) with [Zod](https://zod.dev/) validation
- **Charts**: [Recharts](https://recharts.org/)

### Backend

- **Runtime**: [Node.js](https://nodejs.org/)
- **Framework**: [Express](https://expressjs.com/)
- **Database**: [PostgreSQL](https://www.postgresql.org/) (using `pg` driver)
- **API**: RESTful API architecture
- **Deployment**: Configured for [Netlify](https://www.netlify.com/) Functions

## 📋 Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [PostgreSQL](https://www.postgresql.org/) database
- [pnpm](https://pnpm.io/) (recommended package manager)

## ⚙️ Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd MetricFlow
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   # or
   npm install
   ```

## 🔧 Configuration

1. **Environment Variables**
   Create a `.env` file in the root directory based on `.env.example`:

   ```bash
   cp .env.example .env
   ```

2. **Update `.env` values**
   ```env
   DATABASE_URL="postgresql://user:password@localhost:5432/your_database"
   JWT_SECRET="your-secure-jwt-secret"
   CLIENT_URL="http://localhost:5173" # Update port if different
   ```

## 🏃‍♂️ Running the Application

### Development

Start the development server (Frontend + Backend in development mode):

```bash
npm run dev
```

This will start Vite for the frontend. The backend setup depends on your specific dev environment configuration, but typically Vite proxies API requests or you run the server separately.

### Production Build

Build both client and server:

```bash
npm run build
```

To start the production server:

```bash
npm start
```

## 📜 Scripts

- `npm run dev`: Start the development server (Vite).
- `npm run build`: Build both client and server.
- `npm run build:client`: Build only the frontend.
- `npm run build:server`: Build only the backend.
- `npm run test`: Run tests using Vitest.
- `npm run typecheck`: Run TypeScript type checking.
- `npm run format.fix`: Format code using Prettier.

## 📂 Project Structure

```
MetricFlow/
├── client/                 # Frontend source code
│   ├── components/         # Reusable UI components
│   ├── hooks/              # Custom React hooks
│   ├── pages/              # Application pages/routes
│   └── lib/                # Utility functions
├── server/                 # Backend source code
│   ├── routes/             # API routes
│   ├── middleware/         # Express middleware (auth, etc.)
│   ├── services/           # Business logic services
│   └── db.ts               # Database connection and schema
├── shared/                 # Shared types/utils between client and server
├── netlify/                # Netlify serverless functions configuration
└── public/                 # Static assets
```

## 🤝 Contributing

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request
