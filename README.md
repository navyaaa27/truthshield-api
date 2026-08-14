# 🛡️ TruthShield

<p align="center">
  <em>Live Multimodal AI Forensics for Deepfakes, Misinformation, and Stolen Content.</em>
</p>

TruthShield is a full-stack media forensics platform designed for journalists, researchers, and digital newsrooms to verify the authenticity of digital content. It fuses multiple AI models to analyze images, videos, and text claims in real-time.

---

## ✨ Key Features

- **Deepfake & Image Forensics**: Detect facial artifacts, GAN signatures, lighting inconsistencies, and compression noise using integrated models (e.g., Hive Moderation, AWS Rekognition).
- **Claim Verification**: Cross-reference text claims against verified news sources using LLMs (Claude 3.5) and Fact Check APIs.
- **Stolen Content Radar**: Perceptual hash matching for identifying copied or reposted media across the web.
- **Real-time Processing**: Fast, queue-based background processing using Redis and BullMQ.
- **Developer API**: RESTful API endpoints and WebSocket integration for embedding the forensics engine into custom platforms.
- **Real-time Dashboard**: A sleek, high-contrast, editorial UI for managing alerts, viewing detailed forensic reports, and monitoring workspace billing/API usage.

## 🛠️ Tech Stack

**Frontend**
- React 19, TypeScript, Vite
- Framer Motion (Animations & Micro-interactions)
- Socket.io-client (Real-time alerts)
- CSS variables for theming (Acid-green & dark forensics aesthetic)

**Backend**
- Node.js, Express, TypeScript
- Redis + BullMQ (Task queuing & background jobs)
- Socket.io (WebSocket event emitter)
- Axios (External API communication)

## 📁 Repository Structure

```text
truthshield-api/
├── api/                  # Express.js Backend
│   ├── src/
│   │   ├── config/       # Environment & App Config
│   │   ├── modules/      # Domain modules (Alerts, Auth, Reports, Jobs)
│   │   ├── shared/       # Shared utilities, Logger, WebSocket server
│   │   └── index.ts      # Server entry point
│   ├── .env.example      # Backend environment template
│   └── package.json
│
└── frontend/             # React (Vite) Frontend
    ├── src/
    │   ├── components/   # Reusable UI components
    │   ├── context/      # React Context (Auth)
    │   ├── lib/          # Utilities & Axios instances
    │   ├── pages/        # Views (Landing, Login, Dashboard)
    │   └── App.tsx       # Main router entry
    └── package.json
```

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Redis](https://redis.io/) server running locally or remotely (required for BullMQ background processing).

### 1. Backend Setup

Navigate to the API directory:
```bash
cd api
```

Install dependencies:
```bash
npm install
```

Set up your environment variables:
```bash
cp .env.example .env
```
*(Make sure to fill in your API keys for Hive, AWS, Claude, etc., and confirm the `REDIS_URL` matches your local/remote Redis instance.)*

Start the backend development server:
```bash
npm run dev
```
The API will run on `http://localhost:3000`.

### 2. Frontend Setup

In a new terminal window, navigate to the frontend directory:
```bash
cd frontend
```

Install dependencies:
```bash
npm install
```

Start the Vite development server:
```bash
npm run dev
```
The frontend will run on `http://localhost:5173`.

## 📜 License
© 2026 TruthShield AI · Built to protect the information layer.
