# Icecream Kiosk AI Avatar

This repository contains a full-stack demo kiosk that pairs an interactive HeyGen avatar with an OpenAI-powered intent brain and Whisper-based speech-to-text pipeline. The project follows the "Detailed doc for project build" specification included in this repo.

## Structure

```
.
├── backend/    # Express + TypeScript API for HeyGen, Whisper, and tool routing
├── frontend/   # React + Vite kiosk interface with LiveKit video & overlays
└── Detailed doc for project build
```

## Backend

1. Duplicate `backend/.env.example` to `backend/.env` and populate:
   - `HEYGEN_API_KEY`
   - `OPENAI_API_KEY`
   - Optional: `MAKE_PRODUCTS_HOOK`, `MAKE_ORDER_HOOK` for Make.com integrations
2. Install dependencies (requires npm registry access):

   ```bash
   cd backend
   npm install
   ```

3. Start the API:

   ```bash
   npm run dev
   ```

   The server exposes routes for creating HeyGen sessions, forwarding audio to Whisper, routing LLM tool calls, and returning kiosk overlays.

## Frontend

1. Configure `VITE_HEYGEN_AVATAR_ID` in `frontend/.env` with your HeyGen avatar ID (v3).
2. Install dependencies:

   ```bash
   cd frontend
   npm install
   ```

3. Run the development server:

   ```bash
   npm run dev
   ```

   The Vite dev server proxies `/api/*` calls to `http://localhost:8080` by default. The UI connects to LiveKit, renders the HeyGen avatar stream, and surfaces product/direction overlays triggered by the brain endpoint.

## Offline environments

If npm registry access is blocked (e.g., `npm ERR! code E403`), fetch dependencies in a networked environment, copy the resulting `node_modules` or an `.tgz` mirror into this workspace, and rerun `npm install --offline`.

