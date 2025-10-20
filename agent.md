# Icecream Kiosk AI Avatar - Agent Notes

## Project Snapshot
- **Goal**: Build a kiosk experience that records mic input, transcribes it with custom OpenAI Whisper STT, routes intents through an LLM "brain" with function calls (Make webhooks for products/orders, local fallbacks), and speaks via HeyGen's streaming avatars.
- **Architecture**: Monorepo (`backend/`, `frontend/`). Backend (Node/Express + TypeScript) exposes `/api` endpoints for session tokens, STT, brain, and optional Make proxies; it now calls `v1/streaming.create_token` (no direct LiveKit handling). Frontend (Vite + React + TS) captures audio, calls the backend, and drives the HeyGen Streaming SDK directly (token + `createStartAvatar`) to render video and trigger speech.
- **Key Requirements from `Detailed doc for project build`**  
  - HeyGen v3 avatars; keep API keys on the server.  
  - Custom Whisper STT endpoint (multipart upload) for transcripts.  
  - LLM brain must select tools (`find_products`, `add_to_cart`, `checkout`, `get_directions`) and proxy to Make webhooks when configured.  
  - Backend can serve the built frontend (`frontend/dist`) for single-port deployments.

## External References
- [Creating a Vite Project with Streaming SDK](https://docs.heygen.com/docs/creating-a-vite-project-with-streaming-sdk) - current reference for token + SDK workflow (mirrors our frontend).
- [Using HeyGen with Managed LiveKit Credentials](https://docs.heygen.com/docs/using-heygen-with-managed-livekit-credentials) - background on the managed infrastructure the SDK consumes.
- [Streaming API Integration with LiveKit v2](https://docs.heygen.com/docs/streaming-api-integration-with-livekit-v2) - legacy REST flow (useful only for comparison now that LiveKit is abstracted).
- [React Native Integration Guide](https://docs.heygen.com/docs/react-native-integration-guide-with-streaming-api-livekit) - SDK parity hints.
- [Session Management Best Practices](https://docs.heygen.com/docs/session-management-best-practices) - guidance for timeouts and cleanup (still relevant with SDK).
- [Using Your Own LiveKit Instance](https://docs.heygen.com/docs/using-your-own-livekit-instance) - fallback if we ever self-host.
- HeyGen sample repo: [InteractiveAvatarNextJSDemo](https://github.com/HeyGen-Official/InteractiveAvatarNextJSDemo) - demonstrates the same token + SDK pattern we follow.

## Notes & Follow-ups
- Frontend expects a valid **avatar slug** (e.g. `Elenora_IT_Sitting_public`) via `VITE_HEYGEN_AVATAR_ID`; backend returns fresh tokens only. Ensure the slug corresponds to an interactive avatar enabled for streaming.
- Whisper STT + LLM brain endpoints remain unchanged; responses now call `avatar.speak` client-side instead of routing through `/api/avatar/speak`.
- When extending the flow (e.g., Assistant API integration, built-in voice chat), reuse the SDK token obtained from `/api/session/new` to avoid duplicating authentication logic.
