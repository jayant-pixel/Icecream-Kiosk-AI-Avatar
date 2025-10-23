# Icecream Kiosk AI Avatar

Modern, LiveKit‑powered kiosk experience that pairs a Python realtime
agent (with an Anam avatar) and a Next.js frontend. The agent owns a
local knowledge base, handles conversational logic, and drives the UI
through LiveKit RPCs; the browser renders the avatar stream, product
cards, and pickup guidance.

---

## Architecture at a glance

```
                           ┌────────────────────────┐
                           │      OpenAI Realtime   │
                           │        (LLM + TTS)     │
                           └──────────┬─────────────┘
                                      │
┌────────────┐    audio/video   ┌─────▼─────┐   RPC / data   ┌──────────────┐
│  Browser   │◄────────────────►│ LiveKit   │◄──────────────►│ Python Agent │
│ (Next.js)  │   + RPC handler   │   Cloud   │   overlay data │  (agents/)   │
└────┬───────┘                   └─────▲─────┘                └────┬─────────┘
     │ UI state / inputs               │ Room media                   │ Tools
     │                                 │                               │
┌────▼─────────────────────────────────┴────────────┐         ┌────────▼────────┐
│  ProductShowcase (RPC) + OverlayLayer (data)       │         │ SCOOP_KB        │
│  mic controls, room join, avatar renderer          │         │ (products +     │
│                                                    │         │  directions)    │
└────────────────────────────────────────────────────┘         └────────────────┘
```

### Key flows

1. **Room join** – Frontend obtains a LiveKit token (from Cloud or your
   own token service) and joins `kiosk-room`.
2. **Avatar session** – The Python worker connects, launches the Anam
   avatar, and starts the realtime OpenAI session.
3. **Conversation** – Agent uses the local knowledge base + tools to
   service guests. Menu queries → `client.products` RPC (`menu` / `detail`),
   cart updates → `client.products` (`added`), pickup guidance →
   `client.directions`.
4. **Frontend render** – ProductShowcase reacts to RPC payloads (grid,
   detail card, toast, directions). OverlayLayer still listens to the
   legacy data topic for backwards compatibility.

---

## Repository layout

```
agents/     # Python LiveKit worker, Anam avatar session, knowledge base
frontend/   # Next.js 15 UI that joins LiveKit and renders RPC-driven cards
```

> The original FastAPI token service (`backend_py/`) is no longer part of
> the active build. Provide your own token API or issue tokens via LiveKit
> Cloud when running locally.

---

## Prerequisites

| Component | Requirement |
| --- | --- |
| Agent | Python 3.11+ (tested with 3.13), LiveKit Cloud project, Anam credentials, OpenAI realtime API key |
| Frontend | Node 20+ / npm 10+, LiveKit token service |

Optional: Docker for containerizing the worker.

---

## Agent setup (`agents/`)

1. **Install dependencies**

   ```bash
   cd agents
   python -m venv .venv
   . .venv/Scripts/activate        # or: source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Create `.env`**

   ```
   LIVEKIT_URL=wss://<your-project>.livekit.cloud
   LIVEKIT_API_KEY=lk_...
   LIVEKIT_API_SECRET=...
   LIVEKIT_AGENT_NAME=scoop-avatar

   OPENAI_API_KEY=...
   OPENAI_REALTIME_MODEL=gpt-realtime-mini-2025-10-06
   OPENAI_REALTIME_VOICE=coral

   ANAM_API_KEY=...
   ANAM_AVATAR_ID=...
   ```

   *No external webhooks are required – the worker ships with `SCOOP_KB`
   (menu + pickup directions).*

3. **Run the worker**

   ```bash
   python avatar_anam.py start
   ```

   Logs display tool execution, overlay dispatch, and RPC targets:
   `Dispatched RPC client.products to guest-xxxx ...`.

4. **Docker (optional)**

   ```bash
   docker build -t scoop-agent:latest agents/
   docker run --rm --env-file agents/.env scoop-agent:latest
   ```

### RPC & overlay topics

| Topic | Direction | Payload | Purpose |
| --- | --- | --- | --- |
| `client.products` | Agent → frontend | `{ action: "menu" \| "detail" \| "added", ... }` | Drives product grid, detail, toast |
| `client.directions` | Agent → frontend | `{ action: "show" \| "clear", directions: [...] }` | Renders pickup card |
| `agent.addToCart` | Frontend → agent | `{ productId, qty }` | Allows UI button to add via tool |
| `ui.overlay` | Agent → frontend data channel | Legacy overlay JSON (products/cart/directions) |

---

## Frontend setup (`frontend/`)

1. **Install dependencies**

   ```bash
   cd frontend
   npm install
   ```

2. **Environment**

   Create `.env.local` if you need to override defaults:

   ```
   NEXT_PUBLIC_LIVEKIT_URL=wss://<your-project>.livekit.cloud
   NEXT_PUBLIC_TOKEN_ENDPOINT=https://<your-token-service>/api/livekit/token
   ```

   Tokens may come from LiveKit Cloud (for development) or your own API.

3. **Run the dev server**

   ```bash
   npm run dev
   ```

   Visit `http://localhost:3000` and click **Start Session**. The app
   joins the room, renders the avatar track, registers RPC handlers, and
   exposes a microphone toggle.

### UI highlights

- **ProductShowcase** (`frontend/app/rooms/[roomName]/ProductShowcase.tsx`)  
  Handles `client.products` and `client.directions`, animates menu grid,
  detail card, add-to-cart toast, and pickup card.

- **OverlayLayer**  
  Continues to display data-track overlays for backwards compatibility
  with older agent payloads.

---

## Development workflow

1. **Agent** – reconnect after any knowledge-base or tool change:

   ```bash
   python avatar_anam.py start
   ```

2. **Frontend** – rebuild when editing components:

   ```bash
   npm run dev
   ```

3. **Lint / sanity checks**

   ```bash
   # Python
   python -m compileall agents/avatar_anam.py

   # Frontend
   npm run lint
   ```

4. **Git hygiene**

   - Do **not** commit `.next/**` build artefacts – ensure they are ignored.
   - Stage only source changes (`agents/`, `frontend/**/*.{ts,tsx,css}`, manifests).

---

## Common issues

| Symptom | Explanation / Fix |
| --- | --- |
| RPC logs show `room not ready` | Controller participant hasn’t joined yet. Open the frontend before speaking. |
| Menu speech works but no cards render | Verify `client.products` RPC registration (check browser console). Ensure the worker logs `Dispatched RPC client.products…`. |
| Add-to-cart button disabled | Browser hasn’t detected the agent participant – wait for the avatar to join or refresh. |
| Directions card never appears | Ensure the agent calls `get_directions` after checkout flow; worker now emits `client.directions` that clears the product deck. |
| LiveKit token errors | Confirm your token service scopes the participant to the correct room (default `kiosk-room`). |

---

## Deploying / pushing to GitHub

1. Clean up generated artefacts (`frontend/.next`, legacy backend files) to
   avoid committing deletions you don’t intend.
2. Run tests/lint as above.
3. Stage and commit:

   ```bash
   git add agents/ frontend/ package-lock.json agents/requirements.txt
   git commit -m "feat: scoop avatar kb + rpc showcase"
   git push origin <branch>
   ```

4. Update GitHub secrets (LiveKit URL/key/secret, OpenAI, Anam) in your
   deployment environment.

---

## Reference

- [LiveKit Realtime RPC docs](https://docs.livekit.io/home/client/data/rpc/)
- [LiveKit Agents SDK](https://docs.livekit.io/agents/)
- [Anam Avatars](https://github.com/anam-ai/)

Happy scooping!

