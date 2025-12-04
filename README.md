# Icecream Kiosk AI Avatar

LiveKit-driven kiosk that pairs a Python avatar worker (Anam persona with Deepgram STT, Silero VAD, Google Gemini LLM, and Cartesia TTS) with a Next.js frontend. The agent owns the menu/pickup knowledge base, orchestrates UI state via RPC, and the browser renders the avatar stream plus product and pickup cards.

---

## Architecture

```
Browser (Next.js 15)
  - joins LiveKit room, renders avatar, registers RPC handlers
  - data overlays for legacy fallback
          ▲                     │
          │ media/data (LiveKit)│
          │                     ▼
Python worker (agents/avatar_anam.py)
  - Deepgram STT + Silero VAD
  - Google Gemini LLM (tools enabled)
  - Cartesia TTS
  - Anam avatar stream
  - RPC + overlays: menu, flavors, toppings, cart, directions
```

---

## Repository layout

```
agents/     # Python LiveKit worker, knowledge base, Anam avatar pipeline
frontend/   # Next.js 15 UI that joins LiveKit and reacts to RPC + overlays
```

---

## Prerequisites

| Component | Requirement |
| --- | --- |
| Agent | Python 3.11+, LiveKit Cloud project, Anam credentials, Deepgram/Google/Cartesia API keys |
| Frontend | Node 20+ / npm 10+, LiveKit token credentials |

Optional: Docker to containerize the worker.

---

## Agent setup (`agents/`)

1. **Install dependencies**

   ```bash
   cd agents
   python -m venv .venv
   . .venv/Scripts/activate        # or: source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Environment**

   Create `agents/.env` (do not commit secrets):

   ```
   LIVEKIT_URL=wss://<your-project>.livekit.cloud
   LIVEKIT_API_KEY=lk_...
   LIVEKIT_API_SECRET=...
   LIVEKIT_AGENT_NAME=baskin-avatar
   LIVEKIT_AGENT_IDENTITY_PREFIX=baskin-avatar

   GOOGLE_API_KEY=...
   GOOGLE_MODEL=gemini-2.5-flash-lite
   DEEPGRAM_API_KEY=...
   CARTESIA_API_KEY=...
   CARTESIA_VOICE_ID=829ccd10-f8b3-43cd-b8a0-4aeaa81f3b30

   ANAM_API_KEY=...
   ANAM_AVATAR_ID=...
   ```

   The worker ships with an embedded knowledge base (`SCOOP_KB`) for menu items, toppings, and pickup locations—no external webhooks or DB calls.

3. **Run the worker**

   ```bash
   python avatar_anam.py start
   ```

   Watch for logs like `client.menuLoaded`, `client.cartUpdated`, and `client.directions` to confirm UI payloads are being dispatched.

4. **Docker (optional)**

   ```bash
   docker build -t scoop-agent:latest agents/
   docker run --rm --env-file agents/.env scoop-agent:latest
   ```

### RPC and overlay topics

| Direction | Method / Topic | Payload highlight | Purpose |
| --- | --- | --- | --- |
| Agent → Frontend (RPC) | `client.menuLoaded` | `{ view: "grid"|"detail", category, productId? }` | Drives product grid/detail state |
| Agent → Frontend (RPC) | `client.flavorsLoaded` / `client.toppingsLoaded` | `{ productId, count }` | Opens flavor/topping pickers |
| Agent → Frontend (RPC) | `client.cartUpdated` | `{ cart: { items, subTotalAED, taxAED, totalAED } }` | Syncs cart and totals (VAT included) |
| Agent → Frontend (RPC) | `client.directions` | `{ action: "show", locations: [...] }` | Shows pickup guidance card |
| Frontend → Agent (RPC) | `agent.addToCart` | `{ productId, qty }` | UI button to invoke `add_to_cart` tool |
| Data channel fallback | Topic `ui.overlay` | `kind: products|flavors|toppings|cart|directions` | Legacy/backup UI overlay stream |

---

## Frontend setup (`frontend/`)

1. **Install dependencies**

   ```bash
   cd frontend
   npm install
   ```

2. **Environment**

   Create `.env.local` with LiveKit creds (used by the built-in token API):

   ```
   LIVEKIT_URL=wss://<your-project>.livekit.cloud
   LIVEKIT_API_KEY=lk_...
   LIVEKIT_API_SECRET=...

   NEXT_PUBLIC_AGENT_NAME=baskin-avatar
   NEXT_PUBLIC_CONN_DETAILS_ENDPOINT=/api/livekit/connection-details
   NEXT_PUBLIC_REQUEST_AGENT_ENDPOINT=/api/livekit/request-agent
   NEXT_PUBLIC_LK_RECORD_ENDPOINT=/api/livekit/record
   NEXT_PUBLIC_SHOW_SETTINGS_MENU=false
   NEXT_PUBLIC_VOICE_AGENT_IMAGE=/images/voice-agent-image.jpg
   ```

3. **Run the dev server**

   ```bash
   npm run dev
   ```

   Open `http://localhost:3000`, tap **Start Session**, and confirm the avatar joins and RPC handlers fire.

### UI highlights

- `frontend/app/rooms/[roomName]/ProductShowcase.tsx`  
  Renders product grid/detail, add-to-cart toast, and pickup card from RPC payloads.
- `frontend/app/rooms/[roomName]/OverlayLayer.tsx`  
  Listens to both RPC and `ui.overlay` data to keep legacy overlays in sync.

---

## Development workflow

1. **Agent** – reconnect after prompt/tool/KB tweaks:

   ```bash
   python avatar_anam.py start
   ```

2. **Frontend** – standard Next.js dev loop:

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

   - Keep secrets out of git (`agents/.env`, `secrets.env`).
   - Ignore build artefacts (`frontend/.next/**`).

---

## Deploying the worker to LiveKit Cloud

`agents/Dockerfile` and `agents/livekit.toml` target the avatar worker. Publish with the LiveKit CLI:

```powershell
lk cloud auth
lk project set-default "avatars"
cd agents
lk agent deploy
lk agent update-secrets --id CA_WBqzxRkUtMFh --secrets-file .env
lk agent status --id CA_WBqzxRkUtMFh
lk agent logs --id CA_WBqzxRkUtMFh
```


---

## Deploying the frontend

1. Add the LiveKit and `NEXT_PUBLIC_*` variables above to your host (e.g. Vercel).
2. Build command: `npm install` then `npm run build`.
3. Smoke test: start a room, see the avatar join, add an item, and request pickup directions.

---

## Common issues

| Symptom | Explanation / Fix |
| --- | --- |
| No cards or pickers | Check browser console for `client.menuLoaded` / `client.flavorsLoaded` / `client.toppingsLoaded` handlers and confirm the agent logs those RPCs. |
| Add-to-cart button disabled | The UI has not seen the agent participant yet; wait for the avatar track or refresh. |
| Pickup card never appears | Ensure the flow calls `get_directions`; the worker emits both `client.directions` and `ui.overlay` for fallback. |
| Token errors | Verify the LiveKit credentials in `.env.local` and that tokens scope the correct room (default `kiosk-room`). |

---

## Reference

- [LiveKit Agents SDK](https://docs.livekit.io/agents/)
- [LiveKit Realtime RPC](https://docs.livekit.io/home/client/data/rpc/)
- [Anam Avatars](https://github.com/anam-ai/)

Happy scooping!
