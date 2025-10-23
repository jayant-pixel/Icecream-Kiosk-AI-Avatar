# Scoop Avatar Worker

This worker drives the Scoop Haven kiosk avatar. It combines a local
knowledge base, LiveKit realtime voice, and UI RPCs to guide guests
through the menu, cart, and pickup flow.

## Prerequisites

- Python 3.11+ (tested with 3.13)
- LiveKit project and avatar credentials
- OpenAI realtime API key
- Anam replica credentials

Install dependencies in an isolated environment:

```bash
python -m venv .venv
. .venv/Scripts/activate        # or: source .venv/bin/activate
pip install -r requirements.txt
```

## Environment

Create `agents/.env` with the following variables:

| Variable | Description |
| --- | --- |
| `LIVEKIT_URL` | LiveKit host (e.g. `wss://your-host.livekit.cloud`) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | API credentials with room access |
| `LIVEKIT_AGENT_NAME` | Agent display name (defaults to `scoop-avatar`) |
| `OPENAI_API_KEY` | Realtime API key |
| `OPENAI_REALTIME_MODEL` | Realtime model id (defaults to `gpt-realtime-mini-2025-10-06`) |
| `OPENAI_REALTIME_VOICE` | Voice id (`coral` by default) |
| `ANAM_API_KEY` / `ANAM_AVATAR_ID` | Anam replica credentials |

No external webhooks are required—the menu and directions are baked
into the worker’s knowledge base.

## Architecture Snapshot

```
LiveKit Room
├─ Scoop avatar (Anam video feed)
├─ Controller participant (browser client)
└─ Worker (this process)
   ├─ Knowledge base (SCOOP_KB)
   ├─ livekit-agents realtime session
   ├─ Tool suite (menu, cart, directions)
   ├─ Data overlays (legacy compatibility)
   └─ RPC publisher (client.products / client.directions / agent.addToCart)
```

### Tool behaviour

| Tool | Purpose | RPC emitted |
| --- | --- | --- |
| `list_icecream_flavors` | Menu search / recommendations | `client.products` (`menu` or `detail`) |
| `add_to_cart` | Cart mutation | `client.products` (`added`) |
| `get_directions` | Pickup details | `client.directions` (`show`) |

The client registers matching RPC handlers to render product cards,
confirm add-to-cart events, and transition into the pickup card. If a
client misses an RPC, the worker still publishes data overlays so the
experience degrades gracefully.

## Running the worker

```bash
python agents/avatar_anam.py start
```

The worker:

1. Connects to LiveKit and waits for the controller participant.
2. Starts the Anam avatar session and the realtime voice session.
3. Serves menu/cart/directions via the knowledge base + tools.
4. Streams overlays and UI RPC payloads to the frontend.

Logs include RPC dispatch details so you can verify menu/detail/added
events are reaching the client (`Dispatched RPC client.products ...`).

## Frontend pairing

The Next.js app in `frontend/` consumes the RPC payloads via the new
`ProductShowcase` component. Start it with:

```bash
cd frontend
npm install
npm run dev
```

Make sure the frontend uses the same room name and LiveKit credentials
as the worker.

## Preparing to push to GitHub

1. **Lint / build**  
   - `python -m compileall agents/avatar_anam.py`  
   - `npm run lint` (from `frontend/`)

2. **Review git status**  
   The repo currently has tracked build artefacts (`frontend/.next/**`)
   marked for deletion. Clean or regenerate as needed before committing.

3. **Commit and push**  
   ```bash
   git add agents/ frontend/ package-lock.json agents/requirements.txt
   git status            # confirm staged files
   git commit -m "feat: scoop avatar kb + rpc product showcase"
   git push origin <branch>
   ```

Update the branch name as appropriate for your workflow.

