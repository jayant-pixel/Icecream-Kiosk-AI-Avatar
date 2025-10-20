"""
Scoop Agent: LiveKit Voice Agent with Anam avatar + webhook tools
- Realtime LLM/STT/TTS: OpenAI Realtime model (single stream)
- Avatar: Anam (video track published to the room)
- Tools: Make.com webhooks (find_products, add_to_cart, get_directions, checkout)
- UI overlays: sent via LiveKit DataTrack as { type: "ui.overlay", payload: {...} }
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Dict

import httpx
from dotenv import load_dotenv
from livekit.agents import Agent, AgentSession, JobContext, RunContext, WorkerOptions, Plugin, cli
from livekit.agents.cli import log as cli_log
from livekit.agents.llm import function_tool
from livekit.plugins import openai
from livekit.plugins.anam import avatar as anam_avatar

load_dotenv(dotenv_path=Path(__file__).resolve().with_name(".env"))

# -------------------- ENV --------------------

ROOM = os.getenv("LIVEKIT_ROOM", "scoop-kiosk")

# Providers (keys must be set)
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ANAM_API_KEY = os.getenv("ANAM_API_KEY")
ANAM_AVATAR_ID = os.getenv("ANAM_AVATAR_ID", "default")  # replace with your avatar id
OPENAI_REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-4o-realtime-preview-2024-12-17")

_VOICE_PREFERENCE = os.getenv("OPENAI_REALTIME_VOICE") or os.getenv("VOICE_ID") or "alloy"
_SUPPORTED_REALTIME_VOICES = {
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
    "marin",
    "cedar",
}
if _VOICE_PREFERENCE.lower() not in _SUPPORTED_REALTIME_VOICES:
    logging.getLogger(__name__).warning(
        "Unsupported OpenAI realtime voice '%s'; falling back to 'alloy'. "
        "Supported voices: %s",
        _VOICE_PREFERENCE,
        ", ".join(sorted(_SUPPORTED_REALTIME_VOICES)),
    )
    OPENAI_REALTIME_VOICE = "alloy"
else:
    OPENAI_REALTIME_VOICE = _VOICE_PREFERENCE


def _setup_simple_logging(log_level: str, devmode: bool, console: bool) -> None:
    """Replace LiveKit's default JSON logging with a plain text layout."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)

    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter("%(asctime)s | %(levelname)-5s | %(name)s | %(message)s")
    )
    root.addHandler(handler)
    root.setLevel(log_level)

    cli_log._silence_noisy_loggers()

    from livekit.agents.log import logger as base_logger  # local import to avoid cycles

    if base_logger.level == logging.NOTSET:
        base_logger.setLevel(log_level)

    def _configure_plugin_logger(plugin: Plugin) -> None:
        if plugin.logger is not None and plugin.logger.level == logging.NOTSET:
            plugin.logger.setLevel(log_level)

    for plugin in Plugin.registered_plugins:
        _configure_plugin_logger(plugin)

    Plugin.emitter.on("plugin_registered", _configure_plugin_logger)


cli_log.setup_logging = _setup_simple_logging

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
@function_tool(name="find_products")
async def tool_find_products(query: str, ctx: RunContext) -> Dict[str, Any]:
    """Find products given a full-sentence query with cravings + context."""
    if not FIND_PRODUCTS_URL:
        return {"items": []}
    data = await _post_json(FIND_PRODUCTS_URL, {"query": query})
    items = data.get("items", [])
    await send_overlay(ctx.session, {"kind": "products", "items": items, "speak": data.get("speak")})
    return {"items": items}


@function_tool(name="add_to_cart")
async def tool_add_to_cart(product_id: str, qty: int, ctx: RunContext) -> Dict[str, Any]:
    """Add a product to the cart after the user confirms item and quantity."""
    if not ADD_TO_CART_URL:
        return {"ok": False}
    data = await _post_json(ADD_TO_CART_URL, {"product_id": product_id, "qty": qty})
    if "items" in data and "summary" in data:
        await send_overlay(
            ctx.session,
            {"kind": "cart", "summary": data["summary"], "items": data["items"]},
        )
    return data


@function_tool(name="get_directions")
async def tool_get_directions(display_name: str, ctx: RunContext) -> Dict[str, Any]:
    """Get pickup directions for a product's primary display."""
    if not GET_DIRECTIONS_URL:
        return {"label": display_name}
    data = await _post_json(GET_DIRECTIONS_URL, {"display_name": display_name})
    await send_overlay(
        ctx.session,
        {
            "kind": "directions",
            "label": data.get("label", display_name),
            "hint": data.get("hint"),
            "steps": data.get("steps"),
            "mapImageUrl": data.get("mapImageUrl"),
        },
    )
    return data


@function_tool(name="checkout")
async def tool_checkout(ctx: RunContext) -> Dict[str, Any]:
    """Complete the order and get the final amount & receipt."""
    if not CHECKOUT_URL:
        data = {"amountCents": 0, "receiptUrl": None}
    else:
        data = await _post_json(CHECKOUT_URL, {"session_id": ctx.session.sid})
    await send_overlay(
        ctx.session,
        {
            "kind": "checkout",
            "amountCents": data.get("amountCents", 0),
            "receiptUrl": data.get("receiptUrl"),
            "note": data.get("note"),
        },
    )
    return data


# -------------------- Entrypoint --------------------
async def entrypoint(ctx: JobContext):
    # providers
    llm = openai.realtime.RealtimeModel(
        model=OPENAI_REALTIME_MODEL,
        voice=OPENAI_REALTIME_VOICE,
        api_key=OPENAI_API_KEY,
    )

    session = AgentSession(
        llm=llm,
        resume_false_interruption=False,
    )

    # avatar session
    persona_config = anam_avatar.PersonaConfig(name="Scoop", avatarId=ANAM_AVATAR_ID)
    anam_avatar_session = anam_avatar.AvatarSession(
        api_key=ANAM_API_KEY,
        persona_config=persona_config,
    )
    await anam_avatar_session.start(session, room=ctx.room)

    # agent
    agent = Agent(
        instructions=SCOOP_PROMPT,
        tools=[tool_find_products, tool_add_to_cart, tool_get_directions, tool_checkout],
    )

    # start the agent
    await session.start(
        agent=agent,
        room=ctx.room,
    )

    await session.generate_reply(instructions="Greet the guest warmly and offer help with their treat search.")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
