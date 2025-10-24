# Agent Architecture Brief

## Mission Profile
- **Experience**: Guests speak with Scoop, an Anam-powered avatar that knows the full menu, manages the cart, and guides pickup in a LiveKit room.
- **Control Surface**: The browser simply joins the room, streams the microphone, and listens for agent updates. All reasoning, menus, and cart logic live in the Python worker.

## Runtime Wiring
```
Browser (Next.js) ────── LiveKit Room ────── Python AgentSession
        │                                 ├─ OpenAI Realtime (LLM + TTS)
        │                                 └─ Anam avatar video pipeline
        │
        └─ RPC topics
             • client.products   → product grid / detail / add-to-cart toast
             • client.directions → pickup guidance card
             • agent.addToCart   ← UI button invokes tool

Legacy overlays (`ui.overlay`) are still pushed for backward compatibility.
```

## Knowledge Base & Tools
- `SCOOP_KB` holds the entire menu (ids, price, image, display, keywords) and every pickup location (map + hint). No remote webhooks are required.
- Tool behaviour:
  | Tool | Purpose | RPC Emitted |
  | --- | --- | --- |
  | `list_icecream_flavors` | Menu search / recommendations | `client.products` (`menu` for lists, `detail` for one item) |
  | `add_to_cart` | Cart mutation + totals | `client.products` (`added`) |
  | `get_directions` | Pickup details | `client.directions` (`show`, automatically clears product UI) |

If a client misses RPC updates, the worker also publishes the same payload via the data overlay channel.

## Setup Checklist
1. **Environment (`agents/.env`)**
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
   - `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`
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
   Watch for `Dispatched RPC client.products...` logs—they confirm UI payloads are being sent.

## Debugging Playbook
- **No menu cards**: Confirm the browser registered `client.products`; the worker should log a dispatch and the console should show the handler firing.
- **Add-to-cart button disabled**: The browser hasn’t discovered the agent participant yet—wait for the avatar track or refresh.
- **Directions missing**: Ensure the flow calls `get_directions`; the worker emits `client.directions` plus the legacy overlay.
- **Talkative listings**: The prompt keeps Scoop to names-only for broad menu questions. Adjust `SCOOP_PROMPT` if you need more narrative detail.

## Example Conversation (tool + RPC timeline)
1. **Greeting**  
   Agent welcomes the guest; no tools yet.

2. **Menu request**  
   Guest: “What do you have today?”  
   Agent runs `list_icecream_flavors(query=None, dietary=None)`  
   → RPC `client.products` `{ action: "menu", products: [...] }`  
   → Overlay `products` for legacy UI  
   → Spoken response: “Here are a few favourites—Strawberry Cone, Vanilla Cup, Mango Sorbet—check the screen to see them.”

3. **Item detail**  
   Guest: “Tell me about the mint pint.”  
   Agent runs `list_icecream_flavors(query="mint", dietary=None)`  
   → RPC `client.products` `{ action: "detail", products: [Mint Chocolate Chip Pint] }`  
   → Spoken response describing the item.

4. **Add to cart**  
   Guest taps “Add to cart” in the UI.  
   Browser sends `agent.addToCart` `{ productId: "recMintChip1", qty: 1 }`  
   Agent executes `add_to_cart(product_id="recMintChip1", qty=1)`  
   → RPC `client.products` `{ action: "added", product: {...}, summary: {...} }`  
   → Overlay `cart` snapshot.

5. **Directions**  
   Agent runs `get_directions(display_name="Freezer Aisle 2")`  
   → RPC `client.directions` `{ action: "show", display: "Freezer Aisle 2", directions: [...] }`  
   → Spoken response guiding the guest to the freezer aisle.

6. **Wrap-up**  
   Agent recaps the order, reminds about payment at the counter, and signs off.

## Deployment Notes
- Run the worker in the same region as your LiveKit deployment to minimise latency.
- Updating the menu only requires editing `SCOOP_KB`; the tools and UI reflections are data-driven.
- Before pushing code:
  ```bash
  python -m compileall agents/avatar_anam.py
  npm run lint --workspace frontend
  ```
- Clean tracked build artefacts (`frontend/.next/**`) before committing.

### LiveKit Cloud rollouts
1. Authenticate once: `lk cloud auth` then `lk project set-default "avatars"`.
2. Deploy updates from `agents/`: `lk agent deploy` (uses `livekit.toml` → agent `CA_WBqzxRkUtMFh`).  
3. Update secrets when they change: `lk agent update-secrets --id CA_WBqzxRkUtMFh --secrets-file secrets.env`.  
4. Watch status/logs: `lk agent status ...`, `lk agent logs ...`.

### Frontend hosting snapshot
- Copy `LIVEKIT_*` secrets and the `NEXT_PUBLIC_*` values in `frontend/.env` into your hosting provider (e.g. Vercel).
- Build with `npm install && npm run build`, deploy, then sanity check that `/api/livekit/connection-details` and `/api/livekit/request-agent` operate against the cloud worker.

## References
- [LiveKit Agents](https://docs.livekit.io/agents/)
- [LiveKit RPC guide](https://docs.livekit.io/home/client/data/rpc/)
- [Anam plugin](https://docs.livekit.io/agents/plugins/anam/)
- [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime)
