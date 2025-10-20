"""
Scoop Agent: LiveKit Voice Agent with Anam avatar + webhook tools
- STT: Deepgram (low-latency)
- LLM: OpenAI (swap easily)
- TTS: Cartesia (natural speech, fast start)
- Avatar: Anam (video track published to the room)
- Tools: Make.com webhooks (find_products, add_to_cart, get_directions, checkout)
- UI overlays: sent via LiveKit DataTrack as { type: "ui.overlay", payload: {...} }
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Dict, Optional

import httpx
from livekit.agents import AgentSession, WorkerOptions, cli
from livekit.agents.llm import function_tool
from livekit.agents.voice import VoiceAgent, VoicePipeline
from livekit.plugins import cartesia, deepgram, openai
from livekit.plugins.anam import avatar as anam_avatar

# -------------------- ENV --------------------
LIVEKIT_URL = os.getenv("LIVEKIT_URL")  # e.g., wss://<your-livekit>
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")
ROOM = os.getenv("LIVEKIT_ROOM", "scoop-kiosk")

# Providers (keys must be set)
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
CARTESIA_API_KEY = os.getenv("CARTESIA_API_KEY")
ANAM_API_KEY = os.getenv("ANAM_API_KEY")
ANAM_AVATAR_ID = os.getenv("ANAM_AVATAR_ID", "default")  # replace with your avatar id
VOICE_ID = os.getenv("CARTESIA_VOICE_ID", "alloy")  # pick your Cartesia voice

# Webhooks (Make.com or your proxy)
FIND_PRODUCTS_URL = os.getenv("FIND_PRODUCTS_WEBHOOK_URL")
ADD_TO_CART_URL = os.getenv("ADD_TO_CART_WEBHOOK_URL")
GET_DIRECTIONS_URL = os.getenv("GET_DIRECTIONS_WEBHOOK_URL")
CHECKOUT_URL = os.getenv("CHECKOUT_WEBHOOK_URL")

# -------------------- PROMPT --------------------
SCOOP_PROMPT = r"""
## ROLE
Your name is **Scoop** and you're the AI concierge for **Scoop Haven**, an experiential ice-cream kiosk. You excel at conversational discovery, product expertise, cart building, and guiding guests to the exact display in-store. You never guess when you can confirm, you keep everything frictionless, and you're obsessed with delivering a magical tasting journey.

## PERSONALITY
You're warm, upbeat, and welcoming—think "friendly Scoop Haven host." You stay concise, sprinkle light enthusiasm ("mmm, love that choice!"), and keep things human with occasional natural filler words. Even when someone is rushed or curt, you remain respectful, curious, and helpful.

## COMPANY DETAILS
Scoop Haven curates premium frozen treats and merch. Guests interact with the kiosk's **Anam** avatar (you!) to explore flavours, discover specials, and locate displays quickly. Pickups happen in-store: you provide precise display names, hints, and optional map imagery so guests can find their treats immediately.

## OBJECTIVE
Help each guest:
1. Understand or refine what they're craving.
2. Recommend the perfect product lineup.
3. Add desired items to their cart.
4. Provide directions to the correct display when asked.
5. Keep them excited, informed, and ready to pick up.

## PROCESS
1. Welcome & context check → Confirm they're seeking treats.
2. Discover cravings → Ask one clear question at a time (flavour, dietary, vibe, group size).
3. Recommend & describe → Use tools; describe up to 3 items, ≤20 words each, speak price (convert cents).
4. Build the cart → Confirm quantity before calling add_to_cart.
5. Offer pickup guidance → get_directions using displayName.
6. Wrap with delight → Recap cart; cheerful close.

## STRICT RULES
- Use tools exactly as defined.
- ≤25 words per spoken reply unless giving a short item description.
- Never fabricate availability, prices, or display names.
- If STT is unclear, politely ask for a repeat.
- Always Acknowledge → Relate → Advance.
- Keep brand voice cheerful expert, never pushy.
"""


# -------------------- Helpers --------------------
async def _post_json(url: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(url, json=payload)
        response.raise_for_status()
        return response.json()


async def send_overlay(session: AgentSession, payload: Dict[str, Any]) -> None:
    message = {"type": "ui.overlay", "payload": payload}
    await session.publish_data(json.dumps(message).encode("utf-8"), reliable=True)


# -------------------- Tools --------------------
@function_tool(name="find_products", desc="Find products given a full-sentence query with cravings + context.")
async def tool_find_products(query: str, session: Optional[AgentSession] = None) -> Dict[str, Any]:
    """Return { items: [{id,name,description,priceCents,imageUrl,displayName}] } and send products overlay."""
    if not FIND_PRODUCTS_URL:
        return {"items": []}
    data = await _post_json(FIND_PRODUCTS_URL, {"query": query})
    items = data.get("items", [])
    if session:
        await send_overlay(session, {"kind": "products", "items": items, "speak": data.get("speak")})
    return {"items": items}


@function_tool(name="add_to_cart", desc="Add a product to the cart after the user confirms item and quantity.")
async def tool_add_to_cart(product_id: str, qty: int, session: Optional[AgentSession] = None) -> Dict[str, Any]:
    if not ADD_TO_CART_URL:
        return {"ok": False}
    data = await _post_json(ADD_TO_CART_URL, {"product_id": product_id, "qty": qty})
    if session and "items" in data and "summary" in data:
        await send_overlay(
            session,
            {"kind": "cart", "summary": data["summary"], "items": data["items"]},
        )
    return data


@function_tool(name="get_directions", desc="Get pickup directions for a product's primary display.")
async def tool_get_directions(display_name: str, session: Optional[AgentSession] = None) -> Dict[str, Any]:
    if not GET_DIRECTIONS_URL:
        return {"label": display_name}
    data = await _post_json(GET_DIRECTIONS_URL, {"display_name": display_name})
    if session:
        await send_overlay(
            session,
            {
                "kind": "directions",
                "label": data.get("label", display_name),
                "hint": data.get("hint"),
                "steps": data.get("steps"),
                "mapImageUrl": data.get("mapImageUrl"),
            },
        )
    return data


@function_tool(name="checkout", desc="Complete the order and get the final amount & receipt.")
async def tool_checkout(session_id: Optional[str] = None, session: Optional[AgentSession] = None) -> Dict[str, Any]:
    if not CHECKOUT_URL:
        data = {"amountCents": 0, "receiptUrl": None}
    else:
        data = await _post_json(CHECKOUT_URL, {"session_id": session_id})
    if session:
        await send_overlay(
            session,
            {
                "kind": "checkout",
                "amountCents": data.get("amountCents", 0),
                "receiptUrl": data.get("receiptUrl"),
                "note": data.get("note"),
            },
        )
    return data


# -------------------- Entrypoint --------------------
async def app_main() -> None:
    llm = openai.Chat(model="gpt-4o-mini", api_key=OPENAI_API_KEY)
    stt = deepgram.STT(model="nova-2-general", api_key=DEEPGRAM_API_KEY)
    tts = cartesia.TTS(voice=VOICE_ID, api_key=CARTESIA_API_KEY)

    avatar = anam_avatar.AvatarSession(
        api_key=ANAM_API_KEY,
        avatar_id=ANAM_AVATAR_ID,
    )

    pipeline = VoicePipeline(
        stt=stt,
        llm=llm,
        tts=tts,
        avatar=avatar,
    )

    agent = VoiceAgent(
        pipeline=pipeline,
        instructions=SCOOP_PROMPT,
        tools=[tool_find_products, tool_add_to_cart, tool_get_directions, tool_checkout],
        allow_barge_in=True,
        max_words_per_utterance=25,
    )

    async def run(session: AgentSession) -> None:
        await avatar.start(session)
        agent.bind_tool_context({"session": session})
        await session.run(agent)

    await cli.run_app(
        run,
        options=WorkerOptions(
            ws_url=LIVEKIT_URL,
            api_key=LIVEKIT_API_KEY,
            api_secret=LIVEKIT_API_SECRET,
            room=ROOM,
        ),
    )


if __name__ == "__main__":
    asyncio.run(app_main())
