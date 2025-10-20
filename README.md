# Icecream Kiosk AI Avatar

An end-to-end kiosk experience powered by LiveKit. The React frontend connects to a FastAPI backend for LiveKit access tokens, while a Python LiveKit Agent (with the Anam avatar plugin) handles STT → LLM → tool calls and streams video/audio back to guests.

## Monorepo layout

```
agents/       # LiveKit Agent worker (Python) + Anam avatar session
backend_py/   # FastAPI service for LiveKit tokens & optional tool proxies
frontend/     # Next.js 15 kiosk UI that joins LiveKit and renders overlays
```

## Prerequisites

- Node.js 18+ and npm (for the frontend).
- Python 3.12 (for the FastAPI backend and the LiveKit agent worker).
- LiveKit Cloud project (or self-hosted) with API key/secret.
- Provider keys for the agent pipeline (e.g., OpenAI, Deepgram, Cartesia, Anam).
- Optional Make.com webhook URLs for product/cart/directions/checkout flows.

## Environment configuration

### Backend (`backend_py/.env`)

Duplicate `backend_py/.env.example` and fill in the values:

| Variable | Description |
| --- | --- |
| `PORT` | API port (default `8080`). |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed origins (defaults to `http://localhost:3000`). |
| `LIVEKIT_URL` | Your LiveKit server WebSocket URL (e.g., `wss://example.livekit.cloud`). |
| `LIVEKIT_API_KEY` | LiveKit API key with permission to mint room tokens. |
| `LIVEKIT_API_SECRET` | LiveKit API secret. |

### Agent

Set the following environment variables when running `agents/scoop_agent.py` (or the Docker image):

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_ROOM`
- `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID`
- `ANAM_API_KEY`, `ANAM_AVATAR_ID`
- Optional Make.com webhooks: `FIND_PRODUCTS_WEBHOOK_URL`, `ADD_TO_CART_WEBHOOK_URL`, `GET_DIRECTIONS_WEBHOOK_URL`, `CHECKOUT_WEBHOOK_URL`

### Frontend (`frontend/.env.local`)

Create `frontend/.env.local` if you need to override defaults:

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_BACKEND_URL` | Override the backend URL if you are not proxying requests (default `/`). |

## Install & run

### FastAPI backend

```bash
cd backend_py
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env  # update values
uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

Test the endpoints:

```bash
curl http://localhost:8080/health
curl -X POST http://localhost:8080/api/livekit/token \
  -H "content-type: application/json" \
  -d '{"identity":"kiosk-001","name":"kiosk-001"}'
```

### LiveKit agent worker

```bash
cd agents
python -m venv .venv
source .venv/bin/activate
pip install "livekit-agents[anam]==1.2.0" \
  livekit-plugins-openai==0.3.2 \
  livekit-plugins-deepgram==0.3.2 \
  livekit-plugins-cartesia==0.3.2 \
  httpx==0.27.2
python scoop_agent.py
```

Or build/run with Docker:

```bash
cd agents
docker build -t scoop-agent:latest .
docker run --rm --env-file ../agent.env scoop-agent:latest
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The Next.js dev server runs at http://localhost:3000. The landing page contains a Start button that navigates to `/session`; the session screen fetches a LiveKit token from the FastAPI backend, joins the room, renders the Anam avatar track, and listens for overlay directives over the LiveKit data channel.

## Key flows

1. **Landing page** – Single CTA that routes visitors to `/session`.
2. **Session view** – Connects to LiveKit, renders the agent video tile, exposes a single microphone toggle, and displays overlays from the agent (products, cart, directions, checkout).
3. **Agent worker** – Handles STT → LLM → tool invocation, streams audio/video via the Anam plugin, and publishes overlay JSON on the data track.
4. **Tooling** – Agent tools call Make.com webhooks (directly or via backend proxy) to drive product discovery, cart building, pickup directions, and checkout receipts.

## Testing checklist

- `GET /health` returns `{ "ok": true }`.
- `POST /api/livekit/token` returns `{ url, token }`.
- Frontend session page successfully joins the LiveKit room and renders the Anam avatar video.
- Mic toggle publishes the local audio track; the agent responds with speech.
- Overlay payloads received via LiveKit data track render on screen.
- Checkout flow displays the final amount and receipt link when the agent calls the `checkout` tool.
