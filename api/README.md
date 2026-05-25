# TruthShield API 🛡️

A production-grade, highly secure, modular Node.js & Express backend boilerplate written in modern TypeScript (ESM) with native strict-type checking, robust Two-Factor Authentication (TOTP 2FA), PostgreSQL, Redis, and BullMQ queues.

## 🚀 Key Features

*   **Node.js 20 & ES Modules**: Standard ESM structure (`import`/`export`) leveraging Node Next compilation targets.
*   **TypeScript (Strict Mode)**: Strict type configurations with path resolving for clean ESM output.
*   **Two-Factor Authentication (2FA)**: Full support for TOTP (Google Authenticator / Authy compatibility) via `otplib` and standard QR code output.
*   **Security Boilerplate**: Hardened headers via `helmet`, CORS protection, and secure bcrypt-hashing with high rounds count.
*   **Fail-Fast Startup**: Automated environment variable schemas checked on bootstrap using `zod`.
*   **Winston Logging**: Structured logging system, using beautiful colors for dev environments and single-line JSON format for production ingestion.
*   **Robust Health Probes**: `/health` endpoint for checkups of active database pool and Redis socket connections (ready for load balancers/Kubernetes).
*   **Background Jobs & Queuing**: Modern distributed job processing using `BullMQ` (backed by Redis).
*   **Testing Suite**: Automated unit and integration testing suite utilizing Jest, configured with ESM support and standard `supertest` mock pipelines.
*   **Docker Containerized**: Multi-stage `Dockerfile` (separating builders from non-root runners to reduce container bloat) and multi-service `docker-compose.yml` (orchestrating Postgres 15, Redis 7, and the API).

---

## 📁 Directory Structure

```text
truthshield-api/
├── migrations/                # Database SQL schemas / migrations
│   └── 001_init.sql
├── src/
│   ├── config/                # App & Schema-backed environment configuration
│   │   └── env.ts
│   ├── middleware/            # Security, Auth Guards, Error catchers, and Validators
│   │   ├── auth.ts
│   │   ├── error.ts
│   │   └── validation.ts
│   ├── modules/               # Modular features (Controller -> Service design)
│   │   ├── auth/              # Registration, Login, and MFA TOTP management
│   │   ├── organizations/     # SaaS Organization accounts CRUD
│   │   └── users/             # Profile management & organization roles
│   ├── shared/                # Core persistent infrastructure layers
│   │   ├── database/          # PostgreSQL Client & Pool setup
│   │   ├── queue/             # BullMQ Queue and Worker orchestrators
│   │   └── redis/             # Redis Cache wrapper & utilities
│   ├── types/                 # Express Request and Custom types
│   │   └── express.d.ts
│   ├── utils/                 # General-purpose utility methods (Logger, etc.)
│   │   └── logger.ts
│   ├── app.ts                 # Express Setup and Middleware registration
│   └── index.ts               # HTTP bootstrap listener & Graceful shutdown
├── tests/                     # Integration and Unit test suites
│   └── auth.test.ts
├── .env                       # Active local config
├── .env.example               # Template environment configuration
├── .eslintrc.json             # ESLint static analysis configuration
├── .prettierrc                # Prettier formatter code styles
├── Dockerfile                 # Multi-stage production container script
├── docker-compose.yml         # Dev services orchestration
├── jest.config.ts             # Jest ESM test runner configurations
├── tsconfig.json              # TypeScript compilation rules
└── package.json               # Dependencies and scripts definitions
```

---

## 🚦 Getting Started

### Prerequisites

Ensure you have the following installed:
*   [Node.js (v20.x or higher)](https://nodejs.org/)
*   [Docker Desktop](https://www.docker.com/products/docker-desktop/)

---

### Method A: Spin Up Everything in Docker (Recommended)

To launch the Postgres db, Redis, and the API automatically, simply run:

```bash
docker-compose up --build
```

The API will bind to `http://localhost:3000`. Database tables and cache pools will boot automatically.

---

### Method B: Local Development

1.  **Install dependencies**:
    ```bash
    npm install
    ```

2.  **Spin up local services** (Postgres and Redis):
    ```bash
    docker-compose up postgres redis -d
    ```

3.  **Run Database Migrations** (Create tables):
    Run the SQL schema in `migrations/001_init.sql` against your local postgres server.

4.  **Launch Dev Server**:
    ```bash
    npm run dev
    ```
    This launches `nodemon` watching TypeScript file modifications, executing instantly in memory via `tsx` (fast ESM engine).

---

## 🛠️ CLI Script commands

| Command | Action |
| :--- | :--- |
| `npm run dev` | Starts server in development mode with live watch. |
| `npm run build` | Compiles `.ts` files inside `/src` to `.js` in `/dist`. |
| `npm run start` | Runs the compiled production build from the `/dist` directory. |
| `npm run test` | Runs the full integration test suite via Jest. |
| `npm run test:coverage` | Generates a full test coverage report in the `/coverage` folder. |
| `npm run lint` | Inspects code files for syntax errors using ESLint. |
| `npm run format` | Standardizes codebase spacing and style formatting via Prettier. |

---

## 🧭 API Endpoints Reference

### Core Health
*   `GET /health`: Returns health state of PostgreSQL and Redis database ports.

### Authentication Module (`/api/v1/auth`)
*   `POST /register`: Registers a new user account.
*   `POST /login`: Standard password verification (returns MFA transition token if 2FA is active, or standard JWT token pair).
*   `POST /mfa/verify`: Submits a 6-digit TOTP code during MFA login phase.
*   `POST /mfa/enable` *(Requires Auth)*: Generates a secret and a secure QR code URI for 2FA onboarding.
*   `POST /mfa/confirm` *(Requires Auth)*: Confirms a valid 6-digit TOTP code to permanently activate 2FA on the account.
*   `POST /refresh`: Uses refresh tokens cached in Redis to sign fresh JWT access tokens.
*   `POST /logout` *(Requires Auth)*: Revokes active refresh token from Redis.

### Organizations Module (`/api/v1/organizations`)
*   `GET /`: Fetches all organizations. *(Admin only)*
*   `GET /:id`: Fetches a single organization by UUID. *(Auth required)*
*   `POST /`: Creates a new organization account. *(Admin only)*
*   `PUT /:id`: Updates organization properties. *(Admin only)*
*   `DELETE /:id`: Deletes an organization. *(Admin only)*

### Users Module (`/api/v1/users`)
*   `GET /me`: Returns logged-in user profile. *(Auth required)*
*   `PUT /me`: Self-updates current profile details. *(Auth required)*
*   `GET /`: Fetches list of users (filterable by `organizationId`). *(Admin only)*
*   `PUT /:id`: Administratively updates a user profile or changes their role. *(Admin only)*
