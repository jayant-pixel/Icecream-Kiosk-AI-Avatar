"""
Scoop Avatar Agent
------------------
LiveKit realtime worker that drives the Anam avatar with Scoop's kiosk persona.
The agent uses OpenAI's realtime LLM + voice, publishes avatar video through
Anam, and exposes KB-backed tools that update the kiosk UI overlays and RPC widgets.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
from pathlib import Path
from typing import Any, Dict, List, Optional, TYPE_CHECKING, cast

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    JobRequest,
    RunContext,
    RoomOutputOptions,
    WorkerOptions,
    WorkerType,
    cli,
)
from livekit.agents.llm import function_tool
from livekit.agents.voice.room_io import RoomInputOptions
from livekit.plugins import openai
from livekit.plugins.anam import avatar as anam_avatar
from openai.types.beta.realtime.session import TurnDetection

logger = logging.getLogger("scoop-avatar-agent")
logger.setLevel(logging.INFO)

load_dotenv(dotenv_path=Path(__file__).resolve().with_name(".env"))


if TYPE_CHECKING:
    RunCtxParam = Optional[RunContext]
else:
    RunCtxParam = Optional[Any]


SCOOP_PROMPT = r"""
## ROLE
You are **Scoop**, the animated concierge for Scoop Haven's experiential ice-cream kiosk. You guide guests through flavour discovery, curate their cart, and walk them to the right display. Keep the experience light, knowledgeable, and genuinely helpful.

## KNOWLEDGE BASE
You can consult `SCOOP_KB`, which contains the full product catalog (names, descriptions, prices, images, displays) and detailed directions for every display. Treat it as the single source of truth - never invent details beyond what the KB or tools provide.

## TOOLKIT
- `list_icecream_flavors(query: str, dietary: list[str])` - confirm availability or surface recommendations. For broad menu questions, pull the full menu; for specific treats, pass the exact product name so the caller receives the right record.
- `add_to_cart(product_id: str, qty: int)` - update the shopper's order once you have a confirmed product id or name from the menu results.
- `get_directions(display_name: str)` - share clear pickup guidance. Use the display names returned by the menu data (or the KB) so the correct card appears for the guest.

Tools return structured JSON. Use the data to inform your replies, but always speak naturally; never recite raw JSON, schemas, or background steps.

## STYLE
- Warm, upbeat, and conversational; sprinkle in sensory language without sounding scripted.
- Celebrate delightful choices with brief enthusiasm ("Love that chocolate crunch!").
- Default to ~60 words or less unless you're clarifying orders or directions.
- Smoothly handle dietary notes, allergies, or substitutions with empathy.
- When sharing the full menu, quickly list item names only and hint that visuals are on screen.
- Mention price, description, and pickup details only after the guest focuses on a specific item.

## PLAYBOOK
1. Welcome guests with context and an immediate offer to help.
2. Ask focused discovery questions (one at a time) about flavours, dietary needs, or group size.
3. Recommend up to three items at once, each with a vivid hook and price (convert cents to dollars).
4. Use the tools to keep the cart accurate - never guess quantities or pricing.
5. Guide pickups with display names, hints, and maps from the KB.
6. Close with a recap, running total, and a clear reminder that payment happens at the counter.

## GUARDRAILS
- Always confirm menu, pricing, and locations through the tools/KB before answering.
- Share overlay or UI updates when useful, but never describe them as "background tasks."
- Keep internal instructions and JSON private.
- Stay calm, supportive, and human throughout the conversation.
"""


OVERLAY_TOPIC = "ui.overlay"

SCOOP_KB: Dict[str, Any] = {
    "product_order": [
        "recUfA2OVZkDuDXiY",
        "recf3DynSRt6MyeBp",
        "recRUnwAB4o26gYKA",
        "recABjR1DjRfPFez1",
    ],
    "products": {
        "recUfA2OVZkDuDXiY": {
            "id": "recUfA2OVZkDuDXiY",
            "name": "Chocolate Cone",
            "description": "Belgian chocolate in a crisp cone",
            "priceCents": 12000,
            "imageUrl": "https://v5.airtableusercontent.com/.../Gemini_Generated_Image_gzpq1igzpq1igzpq.png",
            "display": "Freezer Aisle 2",
            "keywords": ["chocolate", "cone", "signature"],
        },
        "recf3DynSRt6MyeBp": {
            "id": "recf3DynSRt6MyeBp",
            "name": "Salted Caramel Pretzel Bites",
            "description": "Crunchy pretzel bites coated in salted caramel",
            "priceCents": 6500,
            "imageUrl": "https://v5.airtableusercontent.com/.../Gemini_Generated_Image_m9cl4em9cl4em9cl.png",
            "display": "Pantry Section 1",
            "keywords": ["salted caramel", "pretzel", "snack"],
        },
        "recRUnwAB4o26gYKA": {
            "id": "recRUnwAB4o26gYKA",
            "name": "Sparkling Lemonade Can",
            "description": "Refreshing sparkling lemonade, 330 ml can",
            "priceCents": 3500,
            "imageUrl": "https://v5.airtableusercontent.com/.../Gemini_Generated_Image_z5n85gz5n85gz5n8.png",
            "display": "Beverage Corner",
            "keywords": ["lemonade", "drink", "sparkling"],
        },
        "recABjR1DjRfPFez1": {
            "id": "recABjR1DjRfPFez1",
            "name": "Vanilla Almond Protein Bar",
            "description": "High-protein bar with vanilla and almonds",
            "priceCents": 4500,
            "imageUrl": "https://v5.airtableusercontent.com/.../Gemini_Generated_Image_5bxf2o5bxf2o5bxf.png",
            "display": "Bakery Display",
            "keywords": ["protein", "bar", "vanilla"],
        },
    },
    "displays": {
        "Freezer Aisle 2": {
            "displayName": "Freezer Aisle 2",
            "hint": "Look for the blue freezer sign above the aisle.",
            "mapImage": "https://v5.airtableusercontent.com/.../Gemini_Generated_Image_zfr9xazfr9xazfr9.png",
        },
        "Dairy Section": {
            "displayName": "Dairy Section",
            "hint": "Dairy sign is large and blue.",
            "mapImage": "https://v5.airtableusercontent.com/.../abstract_33.png",
        },
        "Beverage Corner": {
            "displayName": "Beverage Corner",
            "hint": "Cooler is next to the bakery section.",
            "mapImage": "https://v5.airtableusercontent.com/.../Gemini_Generated_Image_vkk0qxvkk0qxvkk0.png",
        },
        "Produce Aisle 4": {
            "displayName": "Produce Aisle 4",
            "hint": "Look for green signage above the aisle.",
            "mapImage": "https://v5.airtableusercontent.com/.../abstract_40.png",
        },
        "Bakery Display": {
            "displayName": "Bakery Display",
            "hint": "Pastry display is glass-fronted.",
            "mapImage": "https://v5.airtableusercontent.com/.../Gemini_Generated_Image_xrgqhkxrgqhkxrgq.png",
        },
        "Pantry Section 1": {
            "displayName": "Pantry Section 1",
            "hint": "Bins are labeled with yellow tags.",
            "mapImage": "https://v5.airtableusercontent.com/.../Gemini_Generated_Image_2gc2mp2gc2mp2gc2.png",
        },
    },
}


class AgentConfig:
    """Typed access to environment variables with a couple of helpers."""

    def __init__(self) -> None:
        self.livekit_url = os.getenv("LIVEKIT_URL", "")
        self.livekit_api_key = os.getenv("LIVEKIT_API_KEY", "")
        self.livekit_api_secret = os.getenv("LIVEKIT_API_SECRET", "")
        self.agent_name = os.getenv("LIVEKIT_AGENT_NAME", "scoop-avatar")
        self.agent_identity_prefix = (
            os.getenv("LIVEKIT_AGENT_IDENTITY_PREFIX", self.agent_name)
            .strip()
            .lower()
            .replace(" ", "-")
        )

        self.openai_api_key = os.getenv("OPENAI_API_KEY", "")
        self.openai_realtime_model = os.getenv("OPENAI_REALTIME_MODEL", "gpt-4o-realtime-preview")
        self.openai_realtime_voice = os.getenv("OPENAI_REALTIME_VOICE", "coral")

        self.anam_api_key = os.getenv("ANAM_API_KEY", "")
        self.anam_avatar_id = os.getenv("ANAM_AVATAR_ID", "")

        self._validate()

    def _validate(self) -> None:
        required = {
            "LIVEKIT_API_KEY": self.livekit_api_key,
            "LIVEKIT_API_SECRET": self.livekit_api_secret,
            "OPENAI_API_KEY": self.openai_api_key,
            "ANAM_API_KEY": self.anam_api_key,
            "ANAM_AVATAR_ID": self.anam_avatar_id,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

    def agent_identity(self, job_id: Optional[str]) -> str:
        suffix = (job_id or secrets.token_hex(3))[-6:]
        return f"{self.agent_identity_prefix}-{suffix}"

    def controller_identity(self, job_id: Optional[str]) -> str:
        return f"{self.agent_identity(job_id)}-ctrl"

    def agent_metadata(self, agent_identity: str) -> Dict[str, str]:
        return {
            "role": "agent",
            "agentName": self.agent_name,
            "avatarId": self.anam_avatar_id,
            "agentType": "avatar",
            "agentIdentity": agent_identity,
        }

CONFIG = AgentConfig()
async def _publish_overlay(session: AgentSession, kind: str, data: Dict[str, Any]) -> None:
    room = session.room
    if not room or not room.local_participant:
        logger.debug("Skipping overlay publish; room or local participant missing")
        return

    message = json.dumps(
        {
            "type": "ui.overlay",
            "payload": {
                "kind": kind,
                **data,
            },
        }
    ).encode("utf-8")

    try:
        await room.local_participant.publish_data(message, topic=OVERLAY_TOPIC)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to publish overlay message: %s", exc)


class ScoopTools:
    def __init__(
        self,
        config: AgentConfig,
        session: AgentSession,
        room: Any,
        controller_identity: Optional[str],
    ) -> None:
        self.config = config
        self._session = session
        self._room = room
        self._controller_identity = controller_identity
        self._kb = SCOOP_KB
        self._product_order = [
            pid for pid in self._kb.get("product_order", []) if pid in self._kb["products"]
        ]
        self._catalog: Dict[str, Dict[str, Any]] = {}
        self._catalog_by_name: Dict[str, Dict[str, Any]] = {}
        self._cart: Dict[str, Dict[str, Any]] = {}
        self._cart_summary: Dict[str, Any] = {}
        self._display_lookup = {
            name.lower(): details["displayName"]
            for name, details in self._kb.get("displays", {}).items()
        }
        self._product_keywords = {}
        for data in self._kb["products"].values():
            key = data["name"].lower()
            keywords = {key}
            for kw in data.get("keywords", []):
                keywords.add(kw.lower())
            self._product_keywords[key] = keywords
        for product in self._kb["products"].values():
            self._cache_product(dict(product))

    def _normalize_display_names(
        self,
        product_name: Optional[str],
        display_value: Any,
    ) -> List[str]:
        names: List[str] = []
        candidates: List[str] = []
        if isinstance(display_value, str):
            candidates = [display_value]
        elif isinstance(display_value, (list, tuple)):
            candidates = [str(item) for item in display_value if isinstance(item, (str, bytes))]

        for candidate in candidates:
            normalized = candidate.strip()
            if not normalized:
                continue
            lower = normalized.lower()
            if lower in self._display_lookup:
                names.append(self._display_lookup[lower])
                continue
            if normalized in self._display_lookup.values():
                names.append(normalized)
                continue

        if not names and product_name:
            mapped = self._default_display_for(product_name)
            if mapped:
                names.append(mapped)

        return names

    def _canonical_display_name(self, value: str) -> str:
        candidate = (value or "").strip()
        if not candidate:
            return candidate
        lower_candidate = candidate.lower()
        if lower_candidate in self._display_lookup:
            return self._display_lookup[lower_candidate]
        if candidate in self._display_lookup.values():
            return candidate
        mapped = self._display_lookup.get(lower_candidate)
        return mapped or candidate

    def _default_display_for(self, product_name: Optional[str]) -> Optional[str]:
        if not product_name:
            return None
        name_key = product_name.strip().lower()
        product = self._catalog_by_name.get(name_key)
        if product:
            display_field = product.get("displayName") or product.get("display")
            if isinstance(display_field, list) and display_field:
                return display_field[0]
            if isinstance(display_field, str):
                return display_field
        for data in self._kb["products"].values():
            if data["name"].strip().lower() == name_key:
                return data.get("display")
        return None

    def _format_product_card(self, product: Dict[str, Any]) -> Dict[str, Any]:
        price_cents = product.get("priceCents")
        try:
            price_cents = int(price_cents) if price_cents is not None else None
        except (TypeError, ValueError):
            price_cents = None
        display_field = product.get("displayName") or product.get("display") or []
        if isinstance(display_field, str):
            display_list = [display_field]
        elif isinstance(display_field, list):
            display_list = display_field
        else:
            display_list = []
        return {
            "id": product.get("id") or product.get("productId") or product.get("name"),
            "productId": product.get("id") or product.get("productId") or product.get("name"),
            "name": product.get("name"),
            "description": product.get("description"),
            "priceCents": price_cents,
            "priceDollars": round(price_cents / 100, 2) if isinstance(price_cents, int) else None,
            "displayName": display_list,
            "imageUrl": product.get("imageUrl"),
        }

    async def _emit_client_rpc(
        self,
        ctx: "RunCtxParam",
        method: str,
        payload: Dict[str, Any],
    ) -> None:
        run_ctx = cast(Optional[RunContext], ctx) if ctx else None
        session_obj = run_ctx.session if run_ctx and getattr(run_ctx, "session", None) else self._session
        room = getattr(session_obj, "room", None) or self._room
        if not room or not room.local_participant:
            logger.debug("RPC %s skipped; room not ready", method)
            return
        destinations: List[str] = []
        for participant in room.remote_participants.values():
            identity = getattr(participant, "identity", None)
            if identity and identity not in destinations:
                destinations.append(identity)
        if self._controller_identity and self._controller_identity not in destinations:
            destinations.append(self._controller_identity)
        if not destinations:
            logger.debug("RPC %s skipped; no remote participant", method)
            return
        try:
            json_payload = json.dumps(payload)
            for identity in destinations:
                try:
                    await room.local_participant.perform_rpc(
                        destination_identity=identity,
                        method=method,
                        payload=json_payload,
                    )
                    logger.info(
                        "Dispatched RPC %s to %s with payload=%s",
                        method,
                        identity,
                        json_payload,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.exception("Failed to dispatch RPC %s to %s: %s", method, identity, exc)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to dispatch RPC %s: %s", method, exc)

    async def _fetch_product_record(self, product_name: str) -> Optional[Dict[str, Any]]:
        raw = product_name.strip()
        if not raw:
            return None
        key = raw.lower()
        if raw in self._catalog:
            logger.debug("Product cache hit by id for '%s'", product_name)
            return self._catalog[raw]
        if key in self._catalog_by_name:
            logger.debug("Product cache hit for '%s'", product_name)
            return self._catalog_by_name[key]

        best_match: Optional[Dict[str, Any]] = None
        for product in self._kb["products"].values():
            product_name_lower = product.get("name", "").strip().lower()
            product_id_lower = product.get("id", "").strip().lower()
            keywords = self._product_keywords.get(product_name_lower, set())
            if (
                key == product_id_lower
                or key == product_name_lower
                or key in keywords
                or any(kw in key or key in kw for kw in keywords)
            ):
                best_match = dict(product)
                break

        if best_match:
            logger.info("Product lookup success for '%s' (static dataset)", product_name)
            self._cache_product(best_match)
            return self._catalog_by_name.get(best_match["name"].lower())

        for product in self._kb["products"].values():
            if key in product.get("name", "").strip().lower():
                logger.info(
                    "Loose product lookup match for '%s' (static dataset)", product_name
                )
                self._cache_product(dict(product))
                return self._catalog_by_name.get(product.get("name", "").strip().lower())

        logger.warning("Product lookup returned no match for '%s'", product_name)
        return None

    def _cache_product(self, product: Dict[str, Any]) -> None:
        product_id = str(product.get("id") or "").strip()
        name = str(product.get("name") or "").strip()
        if not product_id and not name:
            return
        display_names = self._normalize_display_names(
            name or None,
            product.get("displayName") or product.get("display"),
        )
        if display_names:
            product["displayName"] = display_names
        elif product.get("display"):
            product["displayName"] = [product["display"]]
        elif name:
            default_display = self._default_display_for(name)
            if default_display:
                product["displayName"] = [default_display]
        if product_id:
            self._catalog[product_id] = product
        if name:
            self._catalog_by_name[name.lower()] = product
        return product

    @function_tool(name="list_icecream_flavors")
    async def list_icecream_flavors(
        self,
        query: Optional[str] = None,
        dietary: Optional[list[str]] = None,
        ctx: "RunCtxParam" = None,
    ) -> Dict[str, Any]:
        """Search for ice-cream treats and curated picks. Returns menu items with prices (in cents)."""
        simplified_products: List[Dict[str, Any]] = []
        requested_name = (query or "").strip().lower()
        requested_names: List[str]

        logger.info(
            "list_icecream_flavors called with query=%r dietary=%r", query, dietary
        )

        menu_product_names = [
            self._kb["products"][pid]["name"] for pid in self._product_order
        ] or [data["name"] for data in self._kb["products"].values()]

        general_queries = {
            "",
            "menu",
            "list",
            "options",
            "what do you have",
            "what's available",
        }
        if not requested_name or requested_name in general_queries:
            requested_names = menu_product_names
        else:
            matches = [
                product["name"]
                for product in self._kb["products"].values()
                if query and query.strip().lower() in product["name"].lower()
            ]
            requested_names = matches or ([query] if query else [])

        if dietary:
            requested_names = requested_names or menu_product_names

        seen_products: set[str] = set()
        for name in requested_names:
            record = await self._fetch_product_record(name)
            if not record and name:
                record = {
                    "id": name,
                    "name": name,
                    "priceCents": 0,
                    "priceDollars": 0.0,
                    "description": "Availability unknown; confirm with a team member.",
                    "displayName": [self._default_display_for(name) or "Freezer Aisle 2"],
                }
                record = self._cache_product(record) or record
            if not record:
                continue
            card = self._format_product_card(record)
            key = str(card.get("productId") or card.get("id") or card.get("name"))
            if key and key in seen_products:
                continue
            if key:
                seen_products.add(key)
            simplified_products.append(card)

        if not simplified_products and query:
            logger.warning(
                "No product records found for query '%s'; returning placeholder", query
            )
            simplified_products.append(
                {
                    "id": query,
                    "productId": query,
                    "name": query,
                    "priceCents": 0,
                    "priceDollars": 0.0,
                    "description": "Couldn't confirm that item in the menu data.",
                    "displayName": [],
                    "imageUrl": None,
                }
            )

        rpc_method = "client.products"
        if simplified_products:
            detail_mode = (
                bool(requested_name)
                and requested_name not in general_queries
                and len(simplified_products) == 1
            )
            payload = {
                "action": "detail" if detail_mode else "menu",
                "products": simplified_products,
            }
            if query:
                payload["query"] = query
            if detail_mode:
                payload["primary"] = simplified_products[0]
            await self._emit_client_rpc(ctx, rpc_method, payload)  # type: ignore[arg-type]
        else:
            await self._emit_client_rpc(ctx, rpc_method, {"action": "clear"})

        logger.info(
            "list_icecream_flavors responding with %d products: %s",
            len(simplified_products),
            [item["name"] for item in simplified_products],
        )
        response = {"products": simplified_products}
        session = cast(Optional[RunContext], ctx).session if ctx else None
        if session:
            await _publish_overlay(
                session,
                "products",
                {
                    "query": query,
                    "products": simplified_products,
                },
            )
        return response

    @function_tool(name="add_to_cart")
    async def add_to_cart(
        self,
        product_id: str,
        qty: int = 1,
        ctx: "RunCtxParam" = None,
    ) -> Dict[str, Any]:
        """Add a product to the shopper's cart. Use menu results to pick the correct product_id."""
        product = self._catalog.get(product_id)
        if not product:
            product = self._catalog_by_name.get(product_id.lower()) if product_id else None
        if not product and product_id:
            product = await self._fetch_product_record(product_id)
        logger.info("add_to_cart requested for product_id=%r qty=%s", product_id, qty)
        if not product:
            logger.warning("Unknown product requested for cart: %s", product_id)
            return {
                "items": list(self._cart.values()),
                "summary": self._cart_summary or {},
                "error": f"Unknown product id '{product_id}'",
            }

        entry = self._cart.get(product_id)
        if entry:
            entry["qty"] += max(1, qty)
        else:
            display_names = self._normalize_display_names(
                product.get("name"),
                product.get("displayName"),
            )
            self._cart[product_id] = {
                "productId": product_id,
                "name": product.get("name"),
                "qty": max(1, qty),
                "priceCents": int(product.get("priceCents", 0)),
                "displayName": display_names,
            }
        items = list(self._cart.values())
        subtotal = sum(int(item["priceCents"]) * int(item["qty"]) for item in items)
        tax = int(subtotal * 0.07)
        total = subtotal + tax
        summary = {
            "subtotalCents": subtotal,
            "taxCents": tax,
            "totalCents": total,
            "message": "Grab and pay at the counter!" if items else "Cart is empty.",
        }
        self._cart_summary = summary
        response = {"items": items, "summary": summary}
        product_card = self._format_product_card(product)
        session = cast(Optional[RunContext], ctx).session if ctx else None
        if session:
            await _publish_overlay(
                session,
                "cart",
                {
                    "items": items,
                    "summary": summary,
                },
            )
        await self._emit_client_rpc(
            ctx,
            "client.products",
            {
                "action": "added",
                "product": product_card,
                "qty": max(1, qty),
                "summary": summary,
            },
        )
        return response

    @function_tool(name="get_directions")
    async def get_directions(
        self,
        display_name: str,
        ctx: "RunCtxParam" = None,
    ) -> Dict[str, Any]:
        """Get wayfinding information for a product display."""
        normalized_display = self._canonical_display_name(display_name)
        logger.info(
            "get_directions called for display '%s' (normalized '%s')",
            display_name,
            normalized_display,
        )
        record = self._kb.get("displays", {}).get(normalized_display)
        directions = [record] if record else []
        if not record:
            logger.warning("No static directions found for display '%s'", normalized_display)
        logger.info(
            "get_directions returning %d entries for display '%s'",
            len(directions),
            normalized_display,
        )
        response = {"directions": directions}
        session = cast(Optional[RunContext], ctx).session if ctx else None
        if session:
            await _publish_overlay(
                session,
                "directions",
                {
                    "directions": directions,
                    "fallback": normalized_display,
                },
            )
        if directions:
            await self._emit_client_rpc(
                ctx,
                "client.directions",
                {
                    "action": "show",
                    "display": normalized_display,
                    "directions": directions,
                },
            )
            await self._emit_client_rpc(
                ctx,
                "client.products",
                {"action": "clear"},
            )
        else:
            await self._emit_client_rpc(
                ctx,
                "client.directions",
                {
                    "action": "clear",
                    "display": normalized_display,
                },
            )
        return response


async def entrypoint(ctx: JobContext) -> None:
    config = CONFIG
    job_id = ctx.job.id if ctx.job else None
    agent_identity = config.agent_identity(job_id)
    controller_identity = config.controller_identity(job_id)

    await ctx.connect()
    await ctx.wait_for_participant()
    logger.info("Participant available, bridging media for %s", controller_identity)

    llm = openai.realtime.RealtimeModel(
        api_key=config.openai_api_key,
        model=config.openai_realtime_model,
        voice=config.openai_realtime_voice,
        temperature=0.8,
        modalities=["text", "audio"],
        turn_detection=TurnDetection(
            type="server_vad",
            threshold=0.5,
            prefix_padding_ms=300,
            silence_duration_ms=300,
            create_response=True,
            interrupt_response=True,
        ),
    )

    session = AgentSession(
        llm=llm,
        resume_false_interruption=False,
    )

    avatar_session = anam_avatar.AvatarSession(
        persona_config=anam_avatar.PersonaConfig(
            name=config.agent_name,
            avatarId=config.anam_avatar_id,
        ),
        api_key=config.anam_api_key,
        avatar_participant_name=config.agent_name,
        avatar_participant_identity=agent_identity,
    )
    await avatar_session.start(session, room=ctx.room)

    scoop_tools = ScoopTools(config, session, ctx.room, controller_identity)

    async def handle_add_to_cart_rpc(rpc_data) -> str:
        try:
            payload_raw = rpc_data.payload or "{}"
            payload = json.loads(payload_raw)
            product_id = payload.get("productId") or payload.get("product_id")
            qty = int(payload.get("qty", 1))
            if not product_id:
                logger.warning("agent.addToCart RPC missing productId")
                return "missing productId"
            await scoop_tools.add_to_cart(str(product_id), qty, None)
            return "ok"
        except Exception as exc:  # noqa: BLE001
            logger.exception("Error handling agent.addToCart RPC: %s", exc)
            return f"error: {exc}"

    ctx.room.local_participant.register_rpc_method(
        "agent.addToCart",
        handle_add_to_cart_rpc,
    )

    agent = Agent(
        instructions=SCOOP_PROMPT,
        tools=[
            scoop_tools.list_icecream_flavors,
            scoop_tools.add_to_cart,
            scoop_tools.get_directions,
        ],
    )

    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(video_enabled=False),
        room_output_options=RoomOutputOptions(audio_enabled=False),
    )

    @ctx.room.on("track_subscribed")
    def _on_audio_track(track, publication, participant):
        logger.info(
            "Audio subscribed for participant=%s trackSid=%s source=%s",
            getattr(participant, "identity", "<unknown>"),
            getattr(publication, "track_sid", None),
            getattr(publication, "source", None),
        )

    await session.generate_reply(
        instructions="Greet the guest warmly, mention Scoop Haven, and offer help finding the perfect treat.",
    )


async def request_fnc(req: JobRequest) -> None:
    config = CONFIG
    agent_identity = config.agent_identity(req.id)
    controller_identity = config.controller_identity(req.id)
    metadata = config.agent_metadata(agent_identity)
    attributes = {**metadata, "agentControllerIdentity": controller_identity}

    await req.accept(
        name=config.agent_name,
        identity=controller_identity,
        metadata=json.dumps(metadata),
        attributes=attributes,
    )
    logger.info(
        "Accepted dispatch for room '%s' (job=%s, identity=%s)",
        getattr(req.room, "name", "<unknown>"),
        req.id,
        agent_identity,
    )


if __name__ == "__main__":
    config = CONFIG
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            worker_type=WorkerType.ROOM,
            request_fnc=request_fnc,
            agent_name=config.agent_name,
        )
    )

