# Agent Architecture Brief

## Mission profile
- **Experience**: A Scoop Haven kiosk where guests speak to an Anam avatar that knows the full menu, can build a cart, and hands off precise pickup instructions.
- **Control surface**: The browser only joins a LiveKit room, streams mic audio, and reacts to updates. All menu intelligence and cart logic lives inside the Python LiveKit Agent.

## Runtime wiring

```
Browser (Next.js) ────── LiveKit Room ────── Python AgentSession
        │                                 ┌─ OpenAI Realtime (LLM + TTS)
        │                                 └─ Anam avatar (video pipeline)
        │
        └─ RPC topics:
             • client.products   → product grid / detail / add-to-cart toast
             • client.directions → pickup card (map + hint)
             • agent.addToCart   ← UI button calls into the agent

Legacy data overlays (`ui.overlay`) are still emitted for graceful fallback.
```

## Knowledge base & tools
- `SCOOP_KB` contains the entire menu (id, description, price, image, display) and all pickup locations (map + hint). No external webhooks are needed.
- Tool behaviour:
  | Tool | Purpose | RPC emitted |
  | --- | --- | --- |
  | `list_icecream_flavors` | Menu search / recommendations | `client.products` (`menu` for full list, `detail` for a single item) |
  | `add_to_cart` | Cart mutation & totals | `client.products` (`added`) |
  | `get_directions` | Pickup guidance card | `client.directions` (`show`, and clears product UI) |

If the frontend misses an RPC, the agent also publishes the same data on the overlay track to retain backwards compatibility.

## Configuration checklist
1. **Environment variables** (`agents/.env`)
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
   - `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`
   - `ANAM_API_KEY`, `ANAM_AVATAR_ID`
2. **Install dependencies**
   ```bash
   python -m venv .venv
   . .venv/Scripts/activate        # or source .venv/bin/activate
   pip install -r agents/requirements.txt
   ```
3. **Run the worker**
   ```bash
   python agents/avatar_anam.py start
   ```
   Look for `Dispatched RPC client.products...` logs—they confirm the UI payloads are leaving the agent.

## Debugging playbook
- **No menu cards**: Check that the browser registered `client.products`. The worker should log a dispatch; browser console should show the handler firing.
- **Add-to-cart button disabled**: The browser hasn’t detected the agent participant yet. Wait for the avatar track (LiveKit identity) or refresh.
- **Directions missing**: Ensure the flow calls `get_directions`; the agent emits `client.directions` plus the legacy overlay.
- **Too much speech**: The updated prompt instructs Scoop to list only item names during wide menu queries. Tweak `SCOOP_PROMPT` to vary tone or verbosity.

## Deployment notes
- Run the worker in the same region as your LiveKit deployment to minimise latency.
- When adding new items or displays, only update `SCOOP_KB`; the tools and RPC payloads derive from it automatically.
- Before pushing code:
  ```bash
  python -m compileall agents/avatar_anam.py
  npm run lint --workspace frontend
  ```
- Remove tracked build artefacts (`frontend/.next/**`) before committing.

## References
- [LiveKit Agents](https://docs.livekit.io/agents/)
- [LiveKit RPC guide](https://docs.livekit.io/home/client/data/rpc/)
- [Anam plugin](https://docs.livekit.io/agents/plugins/anam/)
- [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime)
