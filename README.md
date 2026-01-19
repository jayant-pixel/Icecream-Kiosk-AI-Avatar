# Ice Cream Kiosk AI Avatar

An AI-powered kiosk that uses a **virtual avatar** to help customers order ice cream through natural voice conversations. Built with LiveKit for real-time communication, the system features an intelligent agent that knows the menu, handles customization (flavors, toppings), manages cart with VAT calculations, and guides customers to pickup.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BROWSER (Next.js)                            │
│   • Displays avatar video stream                                    │
│   • Shows product cards, flavor/topping pickers, cart               │
│   • Captures user microphone                                        │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ LiveKit (media + data)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     PYTHON AGENT (avatar_anam.py)                   │
│   • STT: Deepgram (speech-to-text)                                  │
│   • LLM: OpenAI GPT-4o (conversation + tools)                       │
│   • TTS: Cartesia (text-to-speech)                                  │
│   • Avatar: Simli (video stream)                                    │
│   • Menu/Cart/Pickup logic embedded in agent                        │
└─────────────────────────────────────────────────────────────────────┘
```

The agent owns all business logic—menu catalog, pricing, upsells, and VAT—and pushes UI updates to the browser via RPC.

---

## Project Structure

```
Icecream-Kiosk-AI-Avatar/
├── agents/                 # Python LiveKit agent
│   ├── avatar_anam.py      # Main agent with menu knowledge base
│   ├── requirements.txt    # Python dependencies
│   └── .env                # Agent secrets (not committed)
├── frontend/               # Next.js web UI
│   ├── app/                # Next.js pages and components
│   ├── package.json        # Node dependencies
│   └── .env.local          # Frontend secrets (not committed)
└── README.md               # This file
```

---

## Prerequisites

| Component | Requirements |
|-----------|--------------|
| **Agent** | Python 3.11+, API keys for: LiveKit, OpenAI, Deepgram, Cartesia, Simli |
| **Frontend** | Node.js 20+, npm 10+ |

---

## Installation & Setup

### 1. Clone the Repository

```bash
git clone <repository-url>
cd Icecream-Kiosk-AI-Avatar
```

### 2. Setup the Agent (Python)

```bash
cd agents

# Create virtual environment
python -m venv .venv

# Activate virtual environment
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

Create `agents/.env` with your API keys:

```env
# LiveKit
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret

# AI Services
OPENAI_API_KEY=your_openai_key
DEEPGRAM_API_KEY=your_deepgram_key
CARTESIA_API_KEY=your_cartesia_key

# Avatar (Simli)
SIMLI_API_KEY=your_simli_key
```

### 3. Setup the Frontend (Node.js)

```bash
cd frontend

# Install dependencies
npm install
```

Create `frontend/.env`:

```env
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
```

---

## Running the Application

### Start the Agent

```bash
cd agents
python avatar_anam.py start
```

### Start the Frontend

```bash
cd frontend
npm run dev
```

Open **http://localhost:3000** in your browser, click **Start Session**, and begin talking to the avatar!

---

## Key Features

- **Voice Conversations**: Natural speech-to-text and text-to-speech powered by Deepgram and Cartesia
- **AI Avatar**: Realistic video avatar from Simli that syncs with speech
- **Smart Ordering**: Guided flow for selecting items, flavors, and toppings
- **Cart Management**: Real-time pricing with 5% VAT calculation
- **Upsell Suggestions**: Intelligent recommendations based on selections
- **Pickup Directions**: Visual guidance to the correct counter

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No avatar appears | Check agent logs for connection errors; verify SIMLI_API_KEY |
| No audio from avatar | Check CARTESIA_API_KEY and browser audio permissions |
| UI cards not showing | Verify frontend is connected to same LiveKit room as agent |
| Token errors | Ensure LiveKit credentials match in both `.env` files |

---

## References

- [LiveKit Agents SDK](https://docs.livekit.io/agents/)
- [Simli Avatars](https://docs.simli.com/)
- [Deepgram STT](https://developers.deepgram.com/)
- [Cartesia TTS](https://docs.cartesia.ai/)
- [OpenAI API](https://platform.openai.com/docs/)
