<div align="center">

  # 🛡️ TruthShield AI

  ### *Enterprise-Grade Multimodal Forensics Engine for Deepfakes, Misinformation & Digital Media Authenticity*

  <p align="center">
    <a href="#-key-features">Features</a> •
    <a href="#-system-architecture">Architecture</a> •
    <a href="#-instant-quickstart">Instant Quickstart</a> •
    <a href="#-api-reference">API Reference</a> •
    <a href="#-tech-stack">Tech Stack</a> •
    <a href="#-security--compliance">Security</a>
  </p>

  <p align="center">
    <img src="https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/React-19.2+-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 19" />
    <img src="https://img.shields.io/badge/Node.js-v20+-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
    <img src="https://img.shields.io/badge/Express-4.19+-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
    <img src="https://img.shields.io/badge/PostgreSQL-15+-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" />
    <img src="https://img.shields.io/badge/Redis-BullMQ-DC382D?style=for-the-badge&logo=redis&logoColor=white" alt="Redis" />
    <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="MIT License" />
    <img src="https://img.shields.io/badge/PRs-Welcome-brightgreen.svg?style=for-the-badge" alt="PRs Welcome" />
  </p>

</div>

---

## 📌 Executive Overview

**TruthShield** is an industrial-strength, full-stack media forensics and verification platform built for journalists, intelligence analysts, fact-checkers, and digital newsrooms. In an era where generative AI creates indistinguishable synthetic media and coordinated disinformation campaigns spread rapidly, TruthShield provides automated, real-time, multi-layered verification across images, videos, audio, and textual claims.

By synthesizing predictive neural networks, computer vision heuristics, large language model fact cross-referencing, and perceptual cryptographic hashing, TruthShield computes defensible authenticity scores with deterministic forensic proofs.

---

## ⚡ Live Highlights & Differentiators

- 🔍 **Real-Time Multimodal Analysis**: Parallel inspection of video frames, image tensors, audio waveforms, and raw text claims.
- ⚡ **Zero-Config Developer Preview**: Built-in in-memory database (`pg-mem`) and queue emulation allowing the entire full-stack app to run locally without installing Postgres or Redis.
- 🎛️ **High-Contrast Forensics Dashboard**: Tactical dark-mode command center styled with high-contrast emerald aesthetics, interactive metric visualizations, and live event telemetry.
- 🔄 **Real-Time Push Architecture**: Powered by WebSockets and BullMQ distributed task queues with zero-latency alert notifications.
- 🛡️ **Enterprise Multi-Tenancy**: Built-in Organization boundaries, Row-Level Security (RLS), TOTP Two-Factor Authentication, and scoped API key management.
- 📑 **Comprehensive Audit Exports**: Automated forensic PDF dossiers with watermarking, verification hashes, and chain-of-custody metadata.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    subgraph INGESTION["1. Ingestion Layer"]
        A1["Web Console UI\n(React 19 + Vite)"]
        A2["RESTful API\n(Bearer / API Key)"]
        A3["Webhook Ingest\n(Media Stream)"]
    end

    subgraph CORE_API["2. TruthShield Core API (Express + TypeScript)"]
        B1["API Gateway & Rate Limiter"]
        B2["Authentication & RLS Guard\n(JWT / HMAC)"]
        B3["Job Dispatcher & Metadata Validator"]
    end

    subgraph QUEUE_LAYER["3. Queue & Orchestration (BullMQ + Redis)"]
        C1["detectionQueue\n(Priority 1-10)"]
        C2["alertQueue\n(Realtime dispatch)"]
        C3["reportQueue\n(PDF compilation)"]
    end

    subgraph ENGINES["4. Forensics & Inference Workers"]
        D1["Deepfake Vision Engine\n• Facial artifact detection\n• GAN noise signatures\n• AWS Rekognition / Hive AI"]
        D2["Misinformation Engine\n• Claude 3.5 Sonnet validation\n• Google Fact Check Tools\n• Source corroboration"]
        D3["Stolen Content Radar\n• Perceptual Hashing (pHash)\n• Vector Hamming distance\n• DMCA tracking"]
        D4["EXIF & Metadata Tampering\n• Hex dump inspection\n• GPS / Chrono-sequence\n• Software fingerprinting"]
    end

    subgraph STORAGE["5. Data & Telemetry"]
        E1[("PostgreSQL\n(Neon / pg-mem)")]
        E2[("Redis Store\n(Upstash / Cache)")]
        E3[("S3 / Cloudflare R2\n(Media Vault)")]
    end

    subgraph CONSUMERS["6. Real-Time Telemetry & Delivery"]
        F1["WebSocket Server\n(Socket.io push)"]
        F2["Slack / Email Webhooks"]
        F3["Signed PDF Audit Dossier"]
    end

    INGESTION --> CORE_API
    CORE_API --> QUEUE_LAYER
    QUEUE_LAYER --> ENGINES
    ENGINES --> STORAGE
    STORAGE --> CONSUMERS
```

---

## ✨ Key Features & Capabilities

### 👁️ 1. Deepfake & Synthetic Media Detection
- **Facial Landmark Artifacts**: Analyzes warping, eye reflections, teeth consistency, and blended boundaries.
- **GAN / Diffusion Fingerprints**: Computes spectral frequencies to isolate generator artifacts left by Midjourney, Stable Diffusion, Flux, and Sora models.
- **Confidence Calibration**: Returns a calibrated probability score (`0-100%`) alongside detailed diagnostic flags.

### 📰 2. Claim Verification & Misinformation Radar
- **Automated Claim Extraction**: Parses unstructured articles, social media links, and transcripts into discrete factual claims.
- **LLM Consensus Engine**: Queries Claude 3.5 Sonnet to cross-reference claims against thousands of verified news sources and the Google Fact Check API.
- **Credibility Scoring**: Generates contextual source credibility ratings with citations.

### 🎯 3. Stolen Content & Perceptual Hashing (pHash)
- **Visual Fingerprinting**: Converts media into 64-bit perceptual hashes invariant to scaling, cropping, slight rotations, and compression artifacts.
- **Reverse Media Matching**: Instantly identifies duplicates across brand assets and public repositories.
- **Automated DMCA Packets**: Generates formal intellectual property infringement notices with timestamps and forensic hash evidence.

### 👥 4. Human-in-the-Loop (HITL) Review Portal
- **Analyst Queue**: High-risk or borderline media (`confidence 40-70%`) is routed automatically to human investigators.
- **Strict SLA Timers**: Built-in 24-hour SLA countdowns with automatic escalation and alert management.
- **Verdict Overrides**: Investigators can record notes, adjust confidence verdicts, and trigger audit log events.

### 🔑 5. Developer Platform & Scoped API Keys
- Provision instant `ts_live_...` API keys with customizable permissions (`jobs:create`, `reports:read`, etc.).
- Granular per-minute rate limiting with IP whitelisting and abuse anomaly mitigation.

---

## 🛠️ Tech Stack Matrix

| Domain | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend Core** | React 19, TypeScript, Vite | Ultra-fast client, strict type safety |
| **UI & Motion** | Tailwind CSS, Framer Motion, Lucide | High-contrast forensic theme, fluid animations |
| **Backend Core** | Node.js (v20+), Express, TypeScript | High-performance asynchronous REST API |
| **Job Queue** | BullMQ, Redis (Upstash) | Distributed priority scheduling & background workers |
| **Database** | PostgreSQL, `pg-mem` | ACID storage, Row-Level Security, in-memory mock |
| **AI & NLP** | Anthropic Claude 3.5, Google Fact Check | Fact-checking, claim classification, cross-referencing |
| **Computer Vision**| AWS Rekognition, Hive Moderation, pHash | Deepfake, facial inconsistency & hash matching |
| **Storage** | Cloudflare R2 / AWS S3 | Encrypted object storage for evidence & forensic reports |
| **Realtime** | Socket.io, Server-Sent Events | Live dashboard telemetry & alert streaming |
| **DevOps / Quality**| Jest, ESLint 10, Prettier, Dotenv, Zod | End-to-end testing, schema validation & linting |

---

## 🚀 Instant Quickstart

TruthShield includes a built-in **In-Memory Preview Mode** (`MOCK_INFRA=true`). You can boot the entire stack and test all user auth, dashboard tabs, API keys, and jobs **without installing PostgreSQL or Redis locally**.

### Prerequisites
- [Node.js](https://nodejs.org/) (v20.0.0 or higher recommended)
- `npm` (v10+)

---

### Step 1: Clone the Repository
```bash
git clone https://github.com/your-org/truthshield-api.git
cd truthshield-api
```

---

### Step 2: Start the Backend API (Port 3000)

```bash
cd api

# 1. Install dependencies
npm install

# 2. Configure Environment (Default comes ready for zero-config preview)
cp .env.example .env

# 3. Launch Development Server
npm run dev
```

> **Note**: In development mode with `MOCK_INFRA=true`, an in-memory SQL database and cache initialize automatically. The API will be live at:
> `http://localhost:3000` (Health Check: `http://localhost:3000/health`)

---

### Step 3: Start the Frontend Console (Port 5173)

Open a new terminal window:

```bash
cd frontend

# 1. Install dependencies
npm install

# 2. Start the Vite dev server
npm run dev
```

> The web console will be accessible at:
> **`http://localhost:5173`**

---

### Step 4: Login & Explore
1. Navigate to **`http://localhost:5173/login`**.
2. Switch to the **Create account** tab.
3. Enter your details (e.g. Name, Organization, Email, and Password) and submit.
4. You will be redirected immediately into the **Live Forensics Dashboard**!

---

## ⚙️ Environment Configuration

Backend configuration is validated at runtime via **Zod** (`api/src/config/env.ts`). Below is the variable reference:

```env
# ── Core Infrastructure ──────────────────────────────────────────
PORT=3000                                 # API HTTP Server Port
NODE_ENV=development                     # 'development' | 'production' | 'test'
MOCK_INFRA=true                           # Set 'true' for zero-dependency local mode

# ── Primary Database (PostgreSQL / Neon) ─────────────────────────
DATABASE_URL=postgresql://user:pass@ep-host.neon.tech/truthshield?sslmode=require
DATABASE_READ_URL=                        # Optional read-replica URL
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=20

# ── Distributed Queue (Redis / Upstash) ──────────────────────────
REDIS_URL=redis://default:token@host.upstash.io:6379

# ── Security & Authentication ────────────────────────────────────
JWT_SECRET=your_super_secret_jwt_signing_key_32_chars_min
JWT_REFRESH_SECRET=your_super_secret_jwt_refresh_key_32_chars_min
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
TOTP_ISSUER=TruthShieldAI
ADMIN_SECRET=admin-secret-key-12345

# ── Cloud Object Storage (Cloudflare R2 / AWS S3) ────────────────
S3_BUCKET_NAME=truthshield-media
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# ── AI Models & Forensics Integrations ───────────────────────────
ANTHROPIC_API_KEY=sk-ant-...              # Claude 3.5 Sonnet Fact Check
GOOGLE_FACT_CHECK_API_KEY=AIzaSy...       # Google Claim Review API
HIVE_MODERATION_API_KEY=                  # Deepfake & Visual Forensics
```

---

## 📡 REST API Reference

All authenticated endpoints accept a Bearer token: `Authorization: Bearer <token>` or an API key: `x-api-key: ts_live_...`.

### Auth Endpoints
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `POST` | `/api/v1/auth/register` | Register new organization & admin user | ❌ |
| `POST` | `/api/v1/auth/login` | Authenticate credentials & issue JWTs | ❌ |
| `POST` | `/api/v1/auth/refresh` | Rotate access token using refresh token | ❌ |
| `GET`  | `/api/v1/users/me` | Fetch active user profile & org metadata | ✅ |

### Detection & Forensics
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `POST` | `/api/v1/jobs` | Submit new media or claim for forensic scan | ✅ |
| `GET`  | `/api/v1/jobs` | List recent scans with pagination & filters | ✅ |
| `GET`  | `/api/v1/jobs/:id` | Retrieve comprehensive forensic breakdown | ✅ |
| `POST` | `/api/v1/uploads/presign` | Generate secure presigned URL for S3 upload | ✅ |

### Alerts & Triage
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `GET`   | `/api/v1/alerts` | Retrieve active high/critical severity alerts | ✅ |
| `PATCH` | `/api/v1/alerts/:id/acknowledge` | Acknowledge alert and silence notifications | ✅ |
| `PATCH` | `/api/v1/alerts/:id/resolve` | Mark alert as resolved with triage notes | ✅ |

### API Credentials & Reports
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `GET`  | `/api/v1/api-keys` | List active organization API keys | ✅ |
| `POST` | `/api/v1/api-keys` | Generate new scoped API key (`ts_live_...`) | ✅ |
| `POST` | `/api/v1/reports` | Compile automated PDF forensic audit dossier | ✅ |

---

### Example: Submitting a Media Detection Job

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "contentType": "image",
    "detectionModules": ["deepfake", "metadata_tampering"],
    "priority": 8,
    "sourceUrl": "https://example.com/suspect-image.jpg"
  }'
```

#### Response:
```json
{
  "status": "success",
  "data": {
    "jobId": "e3012b81-396e-48e8-9d1b-aad4cd3d17a2",
    "status": "queued",
    "priority": 8,
    "modules": ["deepfake", "metadata_tampering"],
    "createdAt": "2026-11-20T00:30:00.000Z"
  }
}
```

---

## 🔒 Security & Defensive Architecture

- **Row-Level Security (RLS)**: Enforced across PostgreSQL tenant tables to guarantee data isolation between organizations.
- **Cryptographic Token Lifecycle**: Access tokens expire in 15 minutes; refresh tokens use cryptographic rotation with immediate revocation blacklists.
- **Multi-Tier Rate Limiting**: Redis-backed leaky bucket algorithms preventing DDoS, brute-force login attempts, and scraping abuse.
- **Audit Logging**: Every sensitive action (`USER_LOGIN`, `API_KEY_CREATED`, `VERDICT_OVERRIDE`) writes immutable audit records with IP addresses and user agents.
- **Sanitized Headers**: Hardened with Helmet, CORS whitelist policies, and HPP parameter pollution guards.

---

## 🧪 Testing & Code Quality

TruthShield adheres to rigorous testing standards across both unit and integration suites:

```bash
# Run unit & integration test suites
npm test

# Run tests in watch mode
npm run test:watch

# Generate code coverage reports
npm run test:coverage

# Lint and check code styles
npm run lint
npm run format
```

---

## 🗺️ Roadmap & Upcoming Milestones

- [x] Multi-tenant organization architecture & Row-Level Security
- [x] Real-time BullMQ background pipeline with priority queueing
- [x] High-contrast Dark Forensic UI with live WebSocket alert streams
- [x] In-memory zero-dependency local preview mode (`pg-mem`)
- [ ] Multimodal Video Frame-by-Frame Temporal Inconsistency Analyzer
- [ ] Chrome Browser Extension for one-click web claim fact-checking
- [ ] Decentralized C2PA (Coalition for Content Provenance and Authenticity) metadata stamping
- [ ] Enterprise Single Sign-On (SAML / Okta / Azure AD)

---

## 🤝 Contributing

We welcome contributions from researchers, security engineers, and developers!

1. **Fork** the repository.
2. Create your branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'feat: Add deepfake audio spectral analyzer'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a **Pull Request**.

Please ensure all tests pass and code complies with ESLint and Prettier rules before submitting.

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for more details.

<div align="center">
  <sub>Built with precision to safeguard the integrity of digital information. © 2026 TruthShield AI.</sub>
</div>
