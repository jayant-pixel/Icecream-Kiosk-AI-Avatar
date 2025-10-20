# Icecream Kiosk AI Avatar

An end-to-end kiosk experience that combines:

- **HeyGen Streaming Avatar SDK** for real-time avatar video, lip-sync, and kiosk-friendly audio playback.
- **OpenAI Assistants API** for conversational intelligence, tool calling, and contextual replies.
- **OpenAI Whisper** for reliable push-to-talk speech recognition that feeds external tools.
- Dynamic overlays (products, checkout summary, pickup directions) driven by Assistant tool decisions.

## Monorepo layout

```
.
├── backend/    # Express + TypeScript API (HeyGen token proxy, Whisper STT, OpenAI Assistants)
├── frontend/   # Next.js 14 App Router kiosk UI with Streaming Avatar video and overlays
└── Detailed doc for project build
```

## Prerequisites

- Node.js 18+ and npm.
- HeyGen API key with access to the **Streaming Avatar** feature.
- OpenAI API key and an Assistants v2 ID configured with the kiosk tools.

## Environment configuration

### Backend (`backend/.env`)

Duplicate `backend/.env.example` and populate:

| Variable | Description |
| --- | --- |
| `PORT` | API port (default `8080`). |
| `HEYGEN_API_KEY` | Secret from the HeyGen dashboard (Streaming Avatar enabled). |
| `HEYGEN_BASE_URL` | Defaults to `https://api.heygen.com`. |
| `HEYGEN_AVATAR_ID` | Optional default streaming avatar ID. |
| `OPENAI_API_KEY` | Secret from OpenAI. |
| `OPENAI_ASSISTANT_ID` | Assistant v2 ID which contains kiosk instructions and tools. |
| `OPENAI_ASSISTANT_MODEL` | Assistant model (default `gpt-4o-mini`). |
| `CORS_ALLOWED_ORIGINS` | CSV of allowed origins (e.g. `http://localhost:3000`). |

### Frontend (`frontend/.env.local`)

Create `frontend/.env.local` (or update your environment) with:

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_HEYGEN_AVATAR_ID` | Streaming avatar ID to start sessions with. |
| `NEXT_PUBLIC_BACKEND_URL` | Backend URL (default `http://localhost:8080`). |
| `NEXT_PUBLIC_HEYGEN_BASE_URL` | Optional override for the HeyGen API base (default `https://api.heygen.com`). |

## Install & run

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (new terminal)
cd ../frontend
npm install
npm run dev
```

The Next.js dev server runs at http://localhost:3000. Configure `NEXT_PUBLIC_BACKEND_URL` so the kiosk points to your Express API (for local development use `http://localhost:8080`). On the first successful connection the avatar greets the user; use the push-to-talk bar and the session controls to mute audio or end the conversation.

## Backend API overview

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/session/new` | Request a short-lived Streaming Avatar access token. |
| `POST` | `/api/stt/transcribe` | Send audio to OpenAI Whisper and return the transcript. |
| `POST` | `/api/brain/respond` | Run the Assistant, execute tool calls, and produce UI directives + speech. |
| `POST` | `/webhooks/openai/tool` | Utility webhook that mirrors tool handling (reserved for future integrations). |
| `GET` | `/health` | Basic readiness probe. |

The backend configures the Assistant on startup so tool definitions stay in sync with the kiosk behaviour.

## Frontend features

- React kiosk UI powered by `@heygen/streaming-avatar` for low-latency video and speech playback.
- Push-to-talk bar that captures microphone audio, calls Whisper, and feeds transcripts into the Assistant for tool routing.
- One-tap session controls for ending the conversation or muting avatar audio.
- Overlay manager for product recommendations, checkout totals, and pickup directions.
- Avatar responses are spoken with `avatar.speak(...)`, using the Assistant's `spokenPrompt` when provided.

## HTTPS & kiosk mode

Browsers require HTTPS for microphone/WebRTC when not running on `localhost`. For kiosk hardware, provide HTTPS via a reverse proxy or `next dev --experimental-https`. Chrome kiosk mode can be launched with:

```bash
chrome --kiosk https://your-kiosk-url
```

## Offline environments

If npm registry access is blocked (e.g., `npm ERR! code E403`), install dependencies in a network-friendly workspace, copy the resulting `node_modules` directories (or cached tarballs) into this project, and rerun `npm install --offline` inside each package.
