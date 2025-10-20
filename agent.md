# Icecream Kiosk AI Avatar - Agent Notes

## Project Snapshot
- **Goal**: Deliver a LiveKit-first Scoop Haven kiosk where the React UI simply joins a room, while a Python LiveKit Agent (with the Anam avatar plugin) handles voice, reasoning, and tool orchestration.
- **Architecture**: Monorepo with `backend_py/` (FastAPI LiveKit token service), `frontend/` (Next.js 15 landing + session views), and `agents/` (VoiceAgent worker). The frontend never talks to HeyGen; instead it renders the agent participant published by the worker.
- **Core Flow**: Landing → `/session` joins LiveKit → Agent streams video/audio and pushes overlay directives on a data track → Frontend renders overlays (products, cart, directions, checkout) and offers a single mic toggle for push-to-talk.

## External References
- [LiveKit Docs – Access tokens](https://docs.livekit.io/home/server-api/#access-tokens)
- [LiveKit Docs – React components](https://docs.livekit.io/client-sdk/react/)
- [LiveKit Agents – Voice pipeline](https://docs.livekit.io/agents/voice/overview/)
- [Anam Plugin quickstart](https://docs.livekit.io/agents/plugins/anam/)
- [Agents function tools guide](https://docs.livekit.io/agents/tools/)

## Notes & Follow-ups
- Frontend expects `/api/livekit/token` to respond with `{ url, token }`. Configure a proxy if the backend runs on another host.
- Agent tool definitions should stay in sync with your Make.com webhook payloads. Each tool emits overlay JSON using `session.publish_data`.
- Keep the agent worker close to your LiveKit region to minimise latency (consider running in the same cloud region as your STT/TTS providers).
- When adding new overlay types, extend `OverlayDispatcher` and broadcast `{ type: "ui.overlay", payload: {...} }` messages from the agent.
