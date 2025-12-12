# Scoop Avatar Worker

Python worker that drives the Scoop Haven kiosk avatar. It combines an embedded knowledge base with LiveKit realtime voice, orchestrates UI state through RPC, and streams legacy overlays for fallback.

## Prerequisites

- Python 3.11+ (tested with 3.13)
- LiveKit project and avatar credentials
- Deepgram, OpenAI, Cartesia API keys
- Anam replica credentials

Install dependencies in an isolated environment:

```bash
python -m venv .venv
. .venv/Scripts/activate        # or: source .venv/bin/activate
pip install -r requirements.txt
```

## Environment

Create `agents/.env` with:

| Variable | Description |
| --- | --- |
| `LIVEKIT_URL` | LiveKit host (e.g. `wss://your-project.livekit.cloud`) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | API credentials with room access |
| `LIVEKIT_AGENT_NAME` / `LIVEKIT_AGENT_IDENTITY_PREFIX` | Optional overrides for participant naming |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI LLM (defaults to `gpt-4o`) |
| `DEEPGRAM_API_KEY` | STT (nova-3) |
| `CARTESIA_API_KEY` / `CARTESIA_VOICE_ID` | TTS (sonic-3, custom voice) |
| `ANAM_API_KEY` / `ANAM_AVATAR_ID` | Anam replica credentials |

The menu, toppings, flavors, and pickup displays are baked into `SCOOP_KB`; no external webhooks are used.

## Architecture snapshot

```
LiveKit room
├─ Avatar participant (Anam video feed)
├─ Controller participant (browser client)
└─ Worker (this process)
   ├─ Knowledge base (SCOOP_KB)
   ├─ AgentSession: Deepgram STT + Silero VAD + OpenAI LLM (GPT-4o) + Cartesia TTS
   ├─ Tools: list_menu, choose_flavors, choose_toppings, add_to_cart, get_directions
   ├─ RPC publisher: client.menuLoaded / client.flavorsLoaded / client.toppingsLoaded / client.cartUpdated / client.directions
   └─ Legacy overlay stream: topic `ui.overlay`
```


### Technical Notes

- **ScoopTools**: Encapsulates all business logic (pricing, inventory, upsells). It maintains a temporary `line_state` for products being customized (adding flavors/toppings) before they are committed to the cart.
- **Upsell Engine**: Logic within `choose_flavors` and `choose_toppings` automatically calculates best-value upgrades (e.g. "free flavor available" or "switch to Sundae to save on toppings") and returns conversational hints to the LLM.

### Tool behaviour

| Tool | Purpose | RPC emitted | Overlay |
| --- | --- | --- | --- |
| `list_menu` | Menu grid/detail, flavor picker, toppings picker | `client.menuLoaded` / `client.flavorsLoaded` / `client.toppingsLoaded` | `products` / `flavors` / `toppings` |
| `choose_flavors` | Attach flavors and compute free vs extra | — (detail overlay refresh) | `products` |
| `choose_toppings` | Attach toppings and compute free vs extra | — (detail overlay refresh) | `products` |
| `add_to_cart` | Add line with VAT + extras and cart totals | `client.cartUpdated` | `cart` |
| `get_directions` | Pickup guidance | `client.directions` | `directions` |

Incoming UI RPC: `agent.addToCart` invokes `add_to_cart` directly (used by the frontend button). If RPC delivery fails, the same payloads are streamed over `ui.overlay`.

## Running the worker

```bash
python agents/avatar_anam.py start
```

The worker:
1. Connects to LiveKit and waits for the controller participant.
2. Starts the Anam avatar session and the realtime voice pipeline.
3. Serves menu/cart/directions from `SCOOP_KB` via the tools above.
4. Streams overlays and RPC payloads to the frontend.

Logs include `client.menuLoaded`, `client.cartUpdated`, and `client.directions` for easy verification.

## Frontend pairing

The Next.js app in `frontend/` consumes both RPC and overlay payloads. Start it with:

```bash
cd frontend
npm install
npm run dev
```

Ensure the frontend uses the same LiveKit project and room name as the worker.

## Preparing to push

1. **Lint / build**  
   - `python -m compileall agents/avatar_anam.py`  
   - `npm run lint --workspace frontend`

2. **Review git status**  
   Keep secrets untracked and avoid committing `frontend/.next/**`.

3. **Commit**  
   ```bash
   git add agents/ frontend/ package-lock.json agents/requirements.txt
   git status
   git commit -m "feat: scoop avatar kb + rpc product showcase"
   ```

## LiveKit Cloud deployment

`agents/livekit.toml` targets agent `CA_WBqzxRkUtMFh`. Typical flow:

```powershell
lk cloud auth
lk project set-default "avatars"
cd agents
lk agent deploy
lk agent update-secrets --id CA_WBqzxRkUtMFh --secrets-file secrets.env
lk agent status --id CA_WBqzxRkUtMFh
lk agent logs --id CA_WBqzxRkUtMFh
```

`secrets.env` should mirror `agents/.env` but stay out of git.
