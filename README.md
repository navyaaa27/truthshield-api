<div align="center">

  # :shield: TruthShield AI

  ### *Enterprise-Grade Multimodal Forensics Engine for Deepfakes, Misinformation & Digital Media Authenticity*

  <p align="center">
    <a href="#-key-features--capabilities">Features</a> &bull;
    <a href="#-deepfake-face-detector-model--training-pipeline">PyTorch Deepfake Model</a> &bull;
    <a href="#-system-architecture">Architecture</a> &bull;
    <a href="#-instant-quickstart">Instant Quickstart</a> &bull;
    <a href="#-api-reference">API Reference</a> &bull;
    <a href="#-tech-stack-matrix">Tech Stack</a> &bull;
    <a href="#-security--defensive-architecture">Security</a>
  </p>

  <p align="center">
    <img src="https://img.shields.io/badge/PyTorch-2.0+-EE4C2C?style=for-the-badge&logo=pytorch&logoColor=white" alt="PyTorch" />
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

## :pushpin: Executive Overview

**TruthShield** is an industrial-strength, full-stack media forensics and verification platform built for journalists, intelligence analysts, fact-checkers, and digital newsrooms. In an era where generative AI creates indistinguishable synthetic media and coordinated disinformation campaigns spread rapidly, TruthShield provides automated, real-time, multi-layered verification across images, videos, audio, and textual claims.

By synthesizing predictive neural networks (including a custom **PyTorch ResNet18 Face Authenticity Classifier**), computer vision heuristics, large language model fact cross-referencing, and perceptual cryptographic hashing, TruthShield computes defensible authenticity scores with deterministic forensic proofs.

---

## :zap: Live Highlights & Differentiators

- :brain: **Custom PyTorch Deepfake Classifier**: Built-in transfer learning pipeline trained on 140,000 real & synthetic facial portraits, integrated directly via an ultra-low latency Python inference sidecar.
- :mag: **Real-Time Multimodal Analysis**: Parallel inspection of video frames, image tensors, audio waveforms, and raw text claims.
- :zap: **Zero-Config Developer Preview**: Built-in in-memory database (`pg-mem`) and queue emulation allowing the entire full-stack app to run locally without installing Postgres or Redis.
- :control_knobs: **High-Contrast Forensics Dashboard**: Tactical dark-mode command center styled with high-contrast emerald/acid-green aesthetics, interactive metric visualizations, and live event telemetry.
- :arrows_counterclockwise: **Real-Time Push Architecture**: Powered by WebSockets and BullMQ distributed task queues with zero-latency alert notifications.
- :shield: **Enterprise Multi-Tenancy**: Built-in Organization boundaries, Row-Level Security (RLS), TOTP Two-Factor Authentication, and scoped API key management.
- :clipboard: **Comprehensive Audit Exports**: Automated forensic PDF dossiers with watermarking, verification hashes, and chain-of-custody metadata.

---

## :brain: Deepfake Face Detector: Model Architecture & Training Pipeline

TruthShield includes a dedicated, standalone real-versus-synthetic facial authenticity scanner powered by a custom-trained **PyTorch ResNet18** model. Below is the full training specification, methodology, and reproducibility workflow developed in Google Colab on a cloud T4 GPU.

### :chart_with_upwards_trend: Training Performance Summary
- **Base Architecture**: `torchvision.models.resnet18(weights='IMAGENET1K_V1')`
- **Backbone State**: Frozen pre-trained convolutional feature extractor (`requires_grad = False`)
- **Classification Head**: Custom linear layer `nn.Linear(512, 2)`
- **Dataset**: Kaggle `xhlulu/140k-real-and-fake-faces` (140,000 balanced human & AI face images)
- **Class Mapping**: Index `0` &rarr; `fake` | Index `1` &rarr; `real`
- **Validation Accuracy**: **79.29%** on unseen hold-out validation set
- **Inference Runtime**: CPU-compatible sidecar subprocess with in-memory base64 streaming

```
Input Image (RGB) 
  │
  ▼
Preprocessing Pipeline: Resize(224, 224) ──▶ ToTensor() ──▶ ImageNet Normalization
  │
  ▼
Frozen ResNet18 Feature Extractor (conv1 ──▶ layer4: 512-dim latent embedding)
  │
  ▼
Custom Linear Classifier (nn.Linear(512, 2))
  │
  ▼
Softmax Probability Distribution: [P(fake), P(real)] ──▶ Calibrated Experimental Verdict
```

---

### :memo: Step-by-Step Training Guide (Google Colab Reproducibility)

#### Step 1 — Workspace Setup (Google Colab with T4 GPU)
1. Navigate to [colab.research.google.com](https://colab.research.google.com/) and create a **New Notebook**.
2. Select **Runtime** &rarr; **Change runtime type** &rarr; Hardware accelerator: **T4 GPU** &rarr; **Save**.

#### Step 2 — Dataset Acquisition (Kaggle API)
Generate an API token from your Kaggle Account Settings (`kaggle.json`), then run:

```python
!pip install kaggle
from google.colab import files
files.upload()  # Upload kaggle.json here

!mkdir -p ~/.kaggle
!cp kaggle.json ~/.kaggle/
!chmod 600 ~/.kaggle/kaggle.json

# Download 140k Real & Synthetic Faces Dataset
!kaggle datasets download -d xhlulu/140k-real-and-fake-faces
!unzip -q 140k-real-and-fake-faces.zip -d faces_data
```

#### Step 3 — Dataset Directory Verification
Confirm the split structure across `train`, `valid`, and `test` partitions:

```python
import os
for root, dirs, files_ in os.walk('faces_data'):
    if files_:
        print(root, "→", len(files_), "files")
```

#### Step 4 — Image Transformation & DataLoader Pipeline
Apply the standard ImageNet input normalization and batch loaders:

```python
import torch
from torchvision import datasets, transforms
from torch.utils.data import DataLoader

transform = transforms.Compose([
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
])

train_data = datasets.ImageFolder('faces_data/real_vs_fake/real-vs-fake/train', transform=transform)
val_data = datasets.ImageFolder('faces_data/real_vs_fake/real-vs-fake/valid', transform=transform)

train_loader = DataLoader(train_data, batch_size=32, shuffle=True)
val_loader = DataLoader(val_data, batch_size=32)

print("Class Order:", train_data.classes)  # ['fake', 'real'] -> index 0=fake, 1=real
```

#### Step 5 — Transfer Learning with Frozen ResNet18 Backbone
Freeze all pre-trained convolutional feature weights to preserve ImageNet visual representations, and replace the fully-connected output layer with a binary classifier:

```python
import torch.nn as nn
from torchvision import models

model = models.resnet18(weights='IMAGENET1K_V1')

# Freeze feature extractor
for param in model.parameters():
    param.requires_grad = False

# Replace final layer for binary classification: fake vs real
model.fc = nn.Linear(model.fc.in_features, 2)

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
model = model.to(device)
```

#### Step 6 — Loss Function & Optimizer
Train exclusively the new linear classification layer parameters:

```python
criterion = nn.CrossEntropyLoss()
optimizer = torch.optim.Adam(model.fc.parameters(), lr=0.001)
```

#### Step 7 — 5-Epoch Model Training Loop
Execute transfer learning across the training partition:

```python
epochs = 5
for epoch in range(epochs):
    model.train()
    running_loss = 0.0
    for images, labels in train_loader:
        images, labels = images.to(device), labels.to(device)
        optimizer.zero_grad()
        outputs = model(images)
        loss = criterion(outputs, labels)
        loss.backward()
        optimizer.step()
        running_loss += loss.item()
    print(f"Epoch {epoch+1}/{epochs}, Loss: {running_loss/len(train_loader):.4f}")
```

#### Step 8 — Empirical Validation & Accuracy Check
Evaluate on the hold-out validation partition without gradient computation:

```python
model.eval()
correct = 0
total = 0
with torch.no_grad():
    for images, labels in val_loader:
        images, labels = images.to(device), labels.to(device)
        outputs = model(images)
        _, predicted = torch.max(outputs, 1)
        total += labels.size(0)
        correct += (predicted == labels).sum().item()

print(f"Validation Accuracy: {100 * correct / total:.2f}%")
# Result: ~79.29% validation accuracy
```

#### Step 9 — Checkpoint Serialization
Save the full model state or export only the lightweight classification head:

```python
# Save full checkpoint
torch.save(model.state_dict(), 'deepfake_detector_v1.pth')

# Or save only the trained FC head weights (recommended for lightweight repo footprint)
torch.save(model.fc.state_dict(), 'deepfake_head.pth')
```

---

### :warning: Model Limitations & Responsible AI Disclaimer
- **Early In-Dataset Benchmark**: The ~79.29% validation accuracy reflects in-distribution performance on the 140k dataset. It is an experimental heuristic, not mathematical proof of authenticity.
- **Retouching & Studio Lighting Sensitivity**: Heavy photographic retouching, studio beauty lighting, and compression artifacts can trigger false-positive `fake` classifications.
- **Still Imagery Only**: The model operates strictly on static 2D facial crops and **does not** analyze video frames or temporal continuity. TruthShield explicitly flags every prediction with a clear experimental disclaimer.

---

## :building_construction: System Architecture

```mermaid
flowchart TD
    subgraph INGESTION["1. Ingestion Layer"]
        A1["Web Console UI\n(React 19 + Vite)"]
        A2["RESTful API\n(Bearer / API Key)"]
        A3["Face Analysis Endpoint\n(/api/v1/face-analysis)"]
    end

    subgraph CORE_API["2. TruthShield Core API (Express + TypeScript)"]
        B1["API Gateway & Rate Limiter"]
        B2["Authentication & RLS Guard\n(JWT / HMAC)"]
        B3["Multer In-Memory Buffer\n(Zero disk retention)"]
    end

    subgraph PYTHON_SIDECAR["3. PyTorch Deepfake Vision Engine"]
        P1["Python Subprocess Worker\n(api/scripts/infer_face.py)"]
        P2["ResNet18 Backbone (ImageNet V1)"]
        P3["Trained FC Head (deepfake_head.pth)"]
        P4["Softmax Probability Engine\n(Real vs Fake Scores)"]
    end

    subgraph QUEUE_LAYER["4. Queue & Orchestration (BullMQ + Redis)"]
        C1["detectionQueue\n(Priority 1-10)"]
        C2["alertQueue\n(Realtime dispatch)"]
        C3["reportQueue\n(PDF compilation)"]
    end

    subgraph ENGINES["5. Forensics & Inference Workers"]
        D1["Deepfake Vision Engine\n• Facial artifact detection\n• GAN noise signatures"]
        D2["Misinformation Engine\n• Claude 3.5 Sonnet validation\n• Google Fact Check Tools"]
        D3["Stolen Content Radar\n• Perceptual Hashing (pHash)\n• Vector Hamming distance"]
        D4["EXIF & Metadata Tampering\n• Hex dump inspection\n• GPS / Chrono-sequence"]
    end

    subgraph STORAGE["6. Data & Telemetry"]
        E1[("PostgreSQL\n(Neon / pg-mem)")]
        E2[("Redis Store\n(Upstash / Cache)")]
        E3[("S3 / Cloudflare R2\n(Media Vault)")]
    end

    INGESTION --> CORE_API
    CORE_API -->|Direct In-Memory Inference| PYTHON_SIDECAR
    PYTHON_SIDECAR --> P1 --> P2 --> P3 --> P4
    CORE_API --> QUEUE_LAYER
    QUEUE_LAYER --> ENGINES
    ENGINES --> STORAGE
```

---

## :sparkles: Key Features & Capabilities

### :bust_in_silhouette: 1. AI Face Authenticity Scanner (PyTorch ResNet18)
- **Deepfake Probability**: Generates per-class calibrated real vs. fake confidence percentages.
- **Zero-Storage In-Memory Inference**: Uploaded images are buffered in RAM with `multer.memoryStorage()` and passed directly to the PyTorch inference subprocess—zero disk writes.
- **Standalone Dashboard Page**: Dedicated `/face-analysis` UI with drag-and-drop file upload, live visual confidence bars, and real-time inference telemetry.

### :eye: 2. Multimodal Deepfake & Synthetic Media Detection
- **Facial Landmark Artifacts**: Analyzes warping, eye reflections, teeth consistency, and blended boundaries.
- **GAN / Diffusion Fingerprints**: Computes spectral frequencies to isolate generator artifacts left by Midjourney, Stable Diffusion, Flux, and Sora models.
- **Confidence Calibration**: Returns a calibrated probability score (`0-100%`) alongside detailed diagnostic flags.

### :newspaper: 3. Claim Verification & Misinformation Radar
- **Automated Claim Extraction**: Parses unstructured articles, social media links, and transcripts into discrete factual claims.
- **LLM Consensus Engine**: Queries Claude 3.5 Sonnet to cross-reference claims against thousands of verified news sources and the Google Fact Check API.
- **Credibility Scoring**: Generates contextual source credibility ratings with citations.

### :dart: 4. Stolen Content & Perceptual Hashing (pHash)
- **Visual Fingerprinting**: Converts media into 64-bit perceptual hashes invariant to scaling, cropping, slight rotations, and compression artifacts.
- **Reverse Media Matching**: Instantly identifies duplicates across brand assets and public repositories.
- **Automated DMCA Packets**: Generates formal intellectual property infringement notices with timestamps and forensic hash evidence.

### :busts_in_silhouette: 5. Human-in-the-Loop (HITL) Review Portal
- **Analyst Queue**: High-risk or borderline media (`confidence 40-70%`) is routed automatically to human investigators.
- **Strict SLA Timers**: Built-in 24-hour SLA countdowns with automatic escalation and alert management.
- **Verdict Overrides**: Investigators can record notes, adjust confidence verdicts, and trigger audit log events.

### :key: 6. Developer Platform & Scoped API Keys
- Provision instant `ts_live_...` API keys with customizable permissions (`jobs:create`, `reports:read`, etc.).
- Granular per-minute rate limiting with IP whitelisting and abuse anomaly mitigation.

---

## :hammer_and_wrench: Tech Stack Matrix

| Domain | Technology | Purpose |
| :--- | :--- | :--- |
| **Deep Learning & CV** | PyTorch, Torchvision, Pillow | Custom ResNet18 facial authenticity classifier |
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

## :rocket: Instant Quickstart

TruthShield includes a built-in **In-Memory Preview Mode** (`MOCK_INFRA=true`). You can boot the entire stack and test all user auth, face analysis, dashboard tabs, API keys, and jobs **without installing PostgreSQL or Redis locally**.

### Prerequisites
- [Node.js](https://nodejs.org/) (v20.0.0 or higher recommended)
- `npm` (v10+)
- [Python 3.10+](https://www.python.org/) with `pip` (for local deepfake inference)

---

### Step 1: Clone the Repository
```bash
git clone https://github.com/navyaaa27/truthshield-api.git
cd truthshield-api
```

---

### Step 2: Set Up Python Inference Dependencies & Weights
Install the deep learning dependencies:

```bash
cd api
pip install -r requirements.txt
```

> **Model Checkpoint**: Ensure the trained head weights are placed at:  
> `api/models/deepfake_head.pth`  
> *(On first run, Torchvision will automatically download the ~44 MB pre-trained ResNet18 backbone weights into your user PyTorch cache).*

---

### Step 3: Start the Backend API (Port 3000)

```bash
# 1. Install Node.js dependencies
npm install

# 2. Configure Environment (Defaults are pre-configured for zero-dependency preview)
cp .env.example .env

# 3. Launch Development Server
npm run dev
```

> The API will be live at: **`http://localhost:3000`** (Health Check: `http://localhost:3000/health`)

---

### Step 4: Start the Frontend Console (Port 5173)

Open a new terminal window:

```bash
cd frontend

# 1. Install dependencies
npm install

# 2. Start the Vite dev server
npm run dev
```

> The web console will be accessible at: **`http://localhost:5173`**

---

### Step 5: Test the Face Authenticity Scanner
1. Open **`http://localhost:5173/login`**.
2. Switch to the **Create account** tab and register an account.
3. In the left navigation sidebar, click **Face Analysis** (tagged with the `NEW` badge).
4. Drag and drop any facial portrait photo (JPEG, PNG, WebP) and click **Run Analysis**.
5. View the real-time classification verdict, confidence scores, and per-class bars!

---

## :gear: Environment Configuration

Backend configuration is validated at runtime via **Zod** (`api/src/config/env.ts`). Below is the variable reference:

```env
# ── Core Infrastructure ──────────────────────────────────────────
PORT=3000                                 # API HTTP Server Port
NODE_ENV=development                     # 'development' | 'production' | 'test'
MOCK_INFRA=true                           # Set 'true' for zero-dependency local mode
PYTHON_BIN=python                         # Path to Python 3 binary (optional override)

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

## :satellite: REST API Reference

All authenticated endpoints accept a Bearer token: `Authorization: Bearer <token>` or an API key: `x-api-key: ts_live_...`.

### Auth Endpoints
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `POST` | `/api/v1/auth/register` | Register new organization & admin user | No |
| `POST` | `/api/v1/auth/login` | Authenticate credentials & issue JWTs | No |
| `POST` | `/api/v1/auth/refresh` | Rotate access token using refresh token | No |
| `GET`  | `/api/v1/users/me` | Fetch active user profile & org metadata | Yes |

### PyTorch Face Analysis Endpoint
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `POST` | `/api/v1/face-analysis` | Analyze single portrait image via PyTorch ResNet18 model | Yes |

#### Request Example:
```bash
curl -X POST http://localhost:3000/api/v1/face-analysis \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>" \
  -F "image=@/path/to/portrait.jpg"
```

#### Response Example:
```json
{
  "success": true,
  "data": {
    "prediction": "fake",
    "scores": {
      "fake": 0.9521,
      "real": 0.0479
    },
    "confidence": 0.9521,
    "disclaimer": "This is an experimental model estimate (≈79% validation accuracy on training dataset). It is not a definitive authenticity verdict and does not apply to videos."
  }
}
```

### Detection & Forensics Jobs
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `POST` | `/api/v1/jobs` | Submit new media or claim for forensic scan | Yes |
| `GET`  | `/api/v1/jobs` | List recent scans with pagination & filters | Yes |
| `GET`  | `/api/v1/jobs/:id` | Retrieve comprehensive forensic breakdown | Yes |
| `POST` | `/api/v1/uploads/presign` | Generate secure presigned URL for S3 upload | Yes |

### Alerts & Triage
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `GET`   | `/api/v1/alerts` | Retrieve active high/critical severity alerts | Yes |
| `PATCH` | `/api/v1/alerts/:id/acknowledge` | Acknowledge alert and silence notifications | Yes |
| `PATCH` | `/api/v1/alerts/:id/resolve` | Mark alert as resolved with triage notes | Yes |

### API Credentials & Reports
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `GET`  | `/api/v1/api-keys` | List active organization API keys | Yes |
| `POST` | `/api/v1/api-keys` | Generate new scoped API key (`ts_live_...`) | Yes |
| `POST` | `/api/v1/reports` | Compile automated PDF forensic audit dossier | Yes |

---

## :lock: Security & Defensive Architecture

- **Row-Level Security (RLS)**: Enforced across PostgreSQL tenant tables to guarantee data isolation between organizations.
- **Cryptographic Token Lifecycle**: Access tokens expire in 15 minutes; refresh tokens use cryptographic rotation with immediate revocation blacklists.
- **Zero-Disk In-Memory Inspection**: Face images are analyzed entirely in volatile RAM buffers and streamed to the Python sidecar without persisting raw uploads to local disk.
- **Multi-Tier Rate Limiting**: Redis-backed leaky bucket algorithms preventing DDoS, brute-force login attempts, and scraping abuse.
- **Audit Logging**: Every sensitive action (`USER_LOGIN`, `API_KEY_CREATED`, `VERDICT_OVERRIDE`) writes immutable audit records with IP addresses and user agents.
- **Sanitized Headers**: Hardened with Helmet, CORS whitelist policies, and HPP parameter pollution guards.

---

## :test_tube: Testing & Code Quality

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

## :world_map: Roadmap & Upcoming Milestones

- [x] Multi-tenant organization architecture & Row-Level Security
- [x] Real-time BullMQ background pipeline with priority queueing
- [x] High-contrast Dark Forensic UI with live WebSocket alert streams
- [x] In-memory zero-dependency local preview mode (`pg-mem`)
- [x] PyTorch ResNet18 Deepfake Face Detection Engine & dedicated UI
- [ ] Multimodal Video Frame-by-Frame Temporal Inconsistency Analyzer
- [ ] Chrome Browser Extension for one-click web claim fact-checking
- [ ] Decentralized C2PA (Coalition for Content Provenance and Authenticity) metadata stamping
- [ ] Enterprise Single Sign-On (SAML / Okta / Azure AD)

---

## :handshake: Contributing

We welcome contributions from researchers, security engineers, and developers!

1. **Fork** the repository.
2. Create your branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'feat: Add deepfake audio spectral analyzer'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a **Pull Request**.

Please ensure all tests pass and code complies with ESLint and Prettier rules before submitting.

---

## :page_facing_up: License

Distributed under the **MIT License**. See `LICENSE` for more details.

<div align="center">
  <sub>Built with precision to safeguard the integrity of digital information. &copy; 2026 TruthShield AI.</sub>
</div>
