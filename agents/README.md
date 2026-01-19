# Agent Documentation

Python agent that powers the Ice Cream Kiosk avatar. Handles voice conversations, menu logic, cart management, and UI orchestration.

---

## Architecture

```
LiveKit Room
└── Agent Worker (this process)
    ├── STT: Deepgram (nova-3) + Silero VAD
    ├── LLM: OpenAI GPT-4o with function tools
    ├── TTS: Cartesia (sonic-3)
    ├── Avatar: Simli video stream
    └── Knowledge Base: SCOOP_KB (embedded menu catalog)
```

---

## Tools & RPC

| Tool | Purpose | RPC to Frontend |
|------|---------|-----------------|
| `list_menu` | Show menu grid or product detail | `client.menuLoaded` |
| `choose_flavors` | Add flavors to current item | Updates detail card |
| `choose_toppings` | Add toppings to current item | Updates detail card |
| `add_to_cart` | Commit item to cart with VAT | `client.cartUpdated` |
| `get_directions` | Show pickup location | `client.directions` |

---

## Environment Variables

Create `agents/.env`:

| Variable | Description |
|----------|-------------|
| `LIVEKIT_URL` | LiveKit server URL |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `OPENAI_API_KEY` | OpenAI API key |
| `DEEPGRAM_API_KEY` | Deepgram STT API key |
| `CARTESIA_API_KEY` | Cartesia TTS API key |
| `SIMLI_API_KEY` | Simli avatar API key |

---

## Running

```bash
# Activate virtual environment
.venv\Scripts\activate  # Windows
source .venv/bin/activate  # macOS/Linux

# Start agent
python avatar_anam.py start
```

---

## Deployment (LiveKit Cloud)

```bash
lk cloud auth
lk project set-default "your-project"
lk agent deploy
lk agent update-secrets --id <AGENT_ID> --secrets-file .env
```

---

## Conversation Flow

1. **Greeting** → Agent captures guest name
2. **Category Selection** → `list_menu(category="Cups", view="grid")`
3. **Product Selection** → `list_menu(product_id="...", view="detail")`
4. **Flavor Picker** → `list_menu(kind="flavors")` → `choose_flavors(...)`
5. **Topping Picker** → `list_menu(kind="toppings")` → `choose_toppings(...)`
6. **Add to Cart** → `add_to_cart(...)` with VAT calculation
7. **Checkout** → `get_directions(...)` for pickup guidance
