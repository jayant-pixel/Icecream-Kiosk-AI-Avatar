# Agent Architecture Brief

## Mission profile
- Guests speak with **Scoop**, an Anam-powered avatar that knows the entire menu, manages cart totals (with VAT), and guides pickup in a LiveKit room.
- The browser only joins the room, streams the mic, and listens for agent updates. All reasoning, menu logic, and UI orchestration live in `agents/avatar_anam.py`.

## Runtime wiring
```
Browser (Next.js) --- media/data ---> LiveKit Room <--- media/data --- Python AgentSession
                                           │
                                           ├─ STT: Deepgram (nova-3) + Silero VAD
                                           ├─ LLM: OpenAI (GPT-4o, tools enabled)
                                           ├─ TTS: Cartesia (sonic-3, custom voice)
                                           └─ Avatar video: Anam persona stream
```

## Knowledge base and tools
`SCOOP_KB` ships the full catalog (products, toppings, flavors, pickup displays) so no external webhooks are required.

### Tool-to-action map

| Tool | Purpose | RPC emitted | Overlay / UI Effect | Upsell Logic |
| --- | --- | --- | --- | --- |
| `list_menu` | Show menu grid or product detail | `client.menuLoaded` | `products` (Grid/Detail) | Validates product confirmation for quick orders. |
| `choose_flavors` | Attach flavors to current line item | — | `products` (Detail refresh) | Suggests free flavors if slots open; paid if full. |
| `choose_toppings` | Attach toppings to current line item | — | `products` (Detail refresh) | **Sundae Upgrade**: Suggests switching from Cup to Sundae if paid toppings exceed cost difference. |
| `add_to_cart` | Commit line item to cart | `client.cartUpdated` | `cart` + **Toast** notification | Suggests cross-category items (Shake <-> Sundae). |
| `get_directions` | Show pickup map | `client.directions` | `directions` | — |

**Note**: The frontend `ProductShowcase` component listens for `client.products` (action="added") to trigger a visual Toast notification when items are added.

### State Management

The agent uses `ScoopSessionState` and `ScoopTools` to manage conversational and cart state:

1.  **Line Items**: When a user selects a product, it's not immediately in the cart. It sits in a "staging" area (`_active_product_id`, `_line_state`) where flavors and toppings are modified.
2.  **Pricing Engine**: Real-time calculation of VAT (5%), included vs. paid toppings, and extra scoop charges.
3.  **Cart State**: committed only when `add_to_cart` is called. The agent then recalculates the full cart total (subtotal + tax) and broadcasts it via `client.cartUpdated`.

### RPC & Events

The system uses a robust RPC protocol for UI synchronization:

- **Agent -> Client**:
    - `client.menuLoaded`: Updates grid/detail view.
    - `client.cartUpdated`: Pushes full cart summary (items, tax breakdown, totals).
    - `client.directions`: Pushes list of pickup counters with hints/images.
- **Client -> Agent**:
    - `agent.addToCart`: Triggered by "Add" button in UI; calls `tools.add_to_cart`.
    - `agent.overlayAck`: Confirms receipt/display of overlays (for reliability).

If a client misses an RPC, the worker sends the same payload type through the `ui.overlay` data channel for graceful degradation.

## Setup checklist
1. **Environment (`agents/.env`)**
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
   - `LIVEKIT_AGENT_NAME`, `LIVEKIT_AGENT_IDENTITY_PREFIX` (optional overrides)
   - `OPENAI_API_KEY`, `OPENAI_MODEL` (defaults to `gpt-4o-2024-11-20`)
   - `DEEPGRAM_API_KEY`
   - `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID`
   - `ANAM_API_KEY`, `ANAM_AVATAR_ID`
2. **Dependencies**
   ```bash
   python -m venv .venv
   . .venv/Scripts/activate        # or: source .venv/bin/activate
   pip install -r agents/requirements.txt
   ```
3. **Run the worker**
   ```bash
   python agents/avatar_anam.py start
   ```
   Look for `client.menuLoaded`, `client.cartUpdated`, and `client.directions` in the logs—they confirm RPCs are reaching the UI.

## Debugging playbook
- **No menu/detail cards**: Confirm the browser registered `client.menuLoaded`; the worker logs a dispatch when it fires.
- **Flavor/topping pickers never open**: The agent must call `list_menu(kind="flavors"| "toppings")` after `list_menu(..., view="detail")`. Check both RPC logs and the overlay stream.
- **Add-to-cart button disabled**: The UI has not detected the agent participant; wait for the avatar or refresh the room.
- **Totals look off**: `add_to_cart` recalculates VAT and topping extras; watch the `cart` overlay payload to verify numbers.
- **Pickup card missing**: Ensure the flow ends with `get_directions(...)`; it emits both `client.directions` and `directions` overlays.

## Example conversation timeline
1. Greeting with name capture (LLM only).
2. Category selection → `list_menu(kind="products", category=..., view="grid")`.
3. Item chosen → `list_menu(kind="products", product_id=..., view="detail")`.
4. Flavors picked → `list_menu(kind="flavors", product_id=...)` then `choose_flavors(...)`.
5. Toppings picked (if any) → `list_menu(kind="toppings", product_id=...)` then `choose_toppings(...)`.
6. Cart update → `add_to_cart(product_id, qty)` → `client.cartUpdated`.
7. Checkout → `get_directions(display_name=...)` → `client.directions`.

## Deployment notes
- Keep the worker in the same region as your LiveKit deployment to limit latency.
- Menu updates are data-only edits to `SCOOP_KB`; flows and UI payloads are data-driven.
- Pre-push checks:
  ```bash
  python -m compileall agents/avatar_anam.py
  npm run lint --workspace frontend
  ```
- Clean tracked build artefacts (`frontend/.next/**`) before committing.

### LiveKit Cloud rollout
1. `lk cloud auth` then `lk project set-default "avatars"`.
2. From `agents/`: `lk agent deploy` (uses `livekit.toml` targeting `CA_WBqzxRkUtMFh`).
3. Rotate secrets when they change: `lk agent update-secrets --id CA_WBqzxRkUtMFh --secrets-file secrets.env`.
4. Monitor: `lk agent status ...`, `lk agent logs ...`.

### Frontend hosting snapshot
- Copy LiveKit secrets and `NEXT_PUBLIC_*` vars from `.env.local` into your host (e.g. Vercel).
- Build with `npm install && npm run build`.
- After deploy, sanity check `/api/livekit/connection-details` and `/api/livekit/request-agent` against the cloud worker.
