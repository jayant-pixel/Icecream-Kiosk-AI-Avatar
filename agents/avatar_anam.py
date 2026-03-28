"""
Baskin Robbins Avatar Agent — Hybrid
------------------------------------
Structure/Tools from Code 1 (Single Agent).
Pipeline/RPCs from Code 2 (Deepgram/Google/Cartesia).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import sys
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import (
    Any,
    Dict,
    List,
    Optional,
    Literal,
    Tuple,
    cast,
)
import re
from zoneinfo import ZoneInfo
from dotenv import load_dotenv

# TOML support (Python 3.11+ has tomllib built-in)
if sys.version_info >= (3, 11):
    import tomllib
else:
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ImportError:
        raise ImportError(
            "Python < 3.11 requires the 'tomli' package. "
            "Install it with: pip install tomli"
        )
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    JobRequest,
    RunContext,
    WorkerOptions,
    WorkerType,
    cli,
    room_io,
)
from livekit.agents.llm import function_tool

# --- CHANGED: New Plugin Imports ---
from livekit.plugins import openai as lk_openai, deepgram, cartesia, silero, simli
from livekit.plugins.turn_detector.multilingual import MultilingualModel
# from livekit.plugins import google as lk_google  # COMMENTED OUT: Using OpenAI
# from livekit.plugins.anam import avatar as anam_avatar  # COMMENTED OUT: Switched to Simli

logger = logging.getLogger("baskin-avatar-agent")
logger.setLevel(logging.INFO)
load_dotenv(dotenv_path=Path(__file__).resolve().with_name(".env"))

# =========================
# Environment Validation
# =========================
REQUIRED_ENV_VARS = [
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY", 
    "LIVEKIT_API_SECRET",
    "OPENAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "CARTESIA_API_KEY",
    "SIMLI_API_KEY",
]

def validate_environment() -> None:
    """Validate required environment variables at startup."""
    missing = [var for var in REQUIRED_ENV_VARS if not os.getenv(var)]
    if missing:
        raise RuntimeError(
            f"Missing required environment variables: {', '.join(missing)}. "
            f"Please check your .env file."
        )

# Validate on import
validate_environment()

OVERLAY_TOPIC = "ui.overlay"
CATEGORY_FALLBACK = "Highlights"
ENGLISH_PROMPT_TIMEZONE = os.getenv("ENGLISH_PROMPT_TIMEZONE", "Asia/Kolkata")
ARABIC_PROMPT_TIMEZONE = os.getenv("ARABIC_PROMPT_TIMEZONE", "Asia/Dubai")
DEFAULT_SESSION_LIMIT_SECONDS = 15 * 60
SESSION_LIMIT_SECONDS = max(
    1, int(os.getenv("SESSION_LIMIT_SECONDS", str(DEFAULT_SESSION_LIMIT_SECONDS)))
)
SESSION_WARNING_SECONDS = max(
    1, min(60, int(os.getenv("SESSION_WARNING_SECONDS", "60")))
)

# Simple UAE VAT (5%) – applied on top of item + extras
VAT_RATE = Decimal("0.05")

# =========================
# Global Helper Functions (From Code 1)
# =========================


def _normalize_label(value: Optional[str]) -> str:
    if not value:
        return ""
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _tokenize(value: Optional[str]) -> set[str]:
    tokens: set[str] = set()
    if not value:
        return tokens
    for raw in re.split(r"[^a-z0-9]+", value.lower()):
        token = raw.strip()
        if not token:
            continue
        tokens.add(token)
        if token.endswith("s") and len(token) > 1:
            tokens.add(token[:-1])
    return tokens


def _parse_room_metadata(raw: Optional[str]) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _tokens_for_label(value: Optional[str]) -> set[str]:
    tokens = _tokenize(value)
    normalized = _normalize_label(value)
    if normalized:
        tokens.add(normalized)
        if normalized.endswith("s") and len(normalized) > 1:
            tokens.add(normalized[:-1])
    return tokens


def build_name_index(entries: Dict[str, Dict[str, Any]]) -> Dict[str, List[str]]:
    index: Dict[str, List[str]] = {}
    for entry_id, entry in entries.items():
        normalized = _normalize_label(entry.get("name"))
        if not normalized:
            continue
        index.setdefault(normalized, []).append(entry_id)
        if normalized.endswith("s") and len(normalized) > 1:
            index.setdefault(normalized[:-1], []).append(entry_id)
    return index


def _sanitize_output(data: Any) -> Any:
    if isinstance(data, Decimal):
        return float(data)
    if isinstance(data, dict):
        return {k: _sanitize_output(v) for k, v in data.items()}
    if isinstance(data, list):
        return [_sanitize_output(v) for v in data]
    return data


def _current_hour_in_timezone(timezone_name: str) -> int:
    return datetime.now(ZoneInfo(timezone_name)).hour


def _time_of_day_greeting() -> str:
    hour = _current_hour_in_timezone(ENGLISH_PROMPT_TIMEZONE)
    if 5 <= hour < 12:
        return "Good morning"
    if 12 <= hour < 17:
        return "Good afternoon"
    return "Good evening"


def _time_of_day_greeting_arabic() -> str:
    hour = _current_hour_in_timezone(ARABIC_PROMPT_TIMEZONE)
    if 5 <= hour < 12:
        return "صباح الخير"
    if 12 <= hour < 17:
        return "مساء الخير"
    return "مساء النور"


# =========================
# Dynamic Prompt Loader
# =========================
_PERSONAL_TOML_PATH = Path(__file__).resolve().with_name("personal.toml")
_PROMPT_CACHE: Dict[str, Dict[str, str]] = {}


def load_prompt_config(language: str = "english") -> Tuple[str, str]:
    """
    Load prompt and voice_id from personal.toml for the given language.
    Returns (prompt_text, voice_id).
    Caches the TOML file after first read.
    """
    global _PROMPT_CACHE
    if not _PROMPT_CACHE:
        with open(_PERSONAL_TOML_PATH, "rb") as f:
            _PROMPT_CACHE = tomllib.load(f)
        logger.info("[PROMPT] Loaded personal.toml with languages: %s", list(_PROMPT_CACHE.keys()))

    lang_key = language.lower().strip()
    if lang_key not in _PROMPT_CACHE:
        logger.warning(
            "[PROMPT] Language '%s' not found in personal.toml, falling back to 'english'",
            lang_key,
        )
        lang_key = "english"

    section = _PROMPT_CACHE[lang_key]
    return section["prompt"], section["voice_id"]


@dataclass
class ScoopSessionState:
    """Tracks contextual signals (From Code 1)."""

    guest_name: Optional[str] = None
    last_overlay_kind: Optional[str] = None
    last_overlay_payload: Optional[Dict[str, Any]] = None
    overlay_ack_id: Optional[str] = None
    overlay_history: List[str] = field(default_factory=list)
    current_product_id: Optional[str] = None
    current_product_summary: Optional[str] = None

    # NEW: last RPC context
    last_rpc_method: Optional[str] = None
    last_rpc_request: Optional[Dict[str, Any]] = None
    last_rpc_response: Optional[Dict[str, Any]] = None

    def describe(self) -> str:
        overlay_info = self.last_overlay_kind or "none"
        history = ", ".join(self.overlay_history[-4:]) if self.overlay_history else "none"
        guest = self.guest_name or "unknown"
        active_product = self.current_product_id or "none"
        product_summary = self.current_product_summary or "No active build in progress."

        rpc_part = f"Last UI RPC: {self.last_rpc_method or 'none'}."

        return (
            f"Guest name: {guest}. "
            f"Last UI overlay shown: {overlay_info}. "
            f"Active product focus: {active_product}. "
            f"{product_summary} "
            f"{rpc_part}"
        )


# =========================
# Prompt is loaded dynamically from personal.toml
# See load_prompt_config() above
# =========================

from kb import SCOOP_KB


# ==========================
# Agent Configuration (Updated for Deepgram/Google/Cartesia)
# ==========================


class AgentConfig:
    def __init__(self) -> None:
        self.livekit_url = os.getenv("LIVEKIT_URL", "")
        self.livekit_api_key = os.getenv("LIVEKIT_API_KEY", "")
        self.livekit_api_secret = os.getenv("LIVEKIT_API_SECRET", "")
        self.agent_name = os.getenv("LIVEKIT_AGENT_NAME", "baskin-avatar")
        self.agent_identity_prefix = (
            os.getenv("LIVEKIT_AGENT_IDENTITY_PREFIX", self.agent_name)
            .strip()
            .lower()
            .replace(" ", "-")
        )
        # --- CHANGED: Keys for new pipeline ---
        self.openai_api_key = os.getenv("OPENAI_API_KEY", "")
        self.openai_model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini-2025-04-14")
        
        # COMMENTED OUT: Google Gemini configuration
        # self.google_api_key = os.getenv("GOOGLE_API_KEY", "")
        # self.google_model = os.getenv("GOOGLE_MODEL", "gemini-3-flash-preview")
        
        self.deepgram_api_key = os.getenv("DEEPGRAM_API_KEY", "")
        self.cartesia_api_key = os.getenv("CARTESIA_API_KEY", "")
        self.cartesia_voice_id = os.getenv(
            "CARTESIA_VOICE_ID", "829ccd10-f8b3-43cd-b8a0-4aeaa81f3b30"
        )

        # COMMENTED OUT: Anam configuration (switched to Simli)
        # self.anam_api_key = os.getenv("ANAM_API_KEY", "")
        # self.anam_avatar_id = os.getenv("ANAM_AVATAR_ID", "")
        
        # Simli configuration
        self.simli_api_key = os.getenv("SIMLI_API_KEY", "")
        self.simli_face_id = os.getenv("SIMLI_FACE_ID", "cace3ef7-a4c4-425d-a8cf-a5358eb0c427")
        self._validate()

    def _validate(self) -> None:
        required = {
            "LIVEKIT_API_KEY": self.livekit_api_key,
            "LIVEKIT_API_SECRET": self.livekit_api_secret,
            "OPENAI_API_KEY": self.openai_api_key,
            # COMMENTED OUT: Google Gemini validation
            # "GOOGLE_API_KEY": self.google_api_key,
            "DEEPGRAM_API_KEY": self.deepgram_api_key,
            "CARTESIA_API_KEY": self.cartesia_api_key,
            # COMMENTED OUT: Anam validation (switched to Simli)
            # "ANAM_API_KEY": self.anam_api_key,
            # "ANAM_AVATAR_ID": self.anam_avatar_id,
            "SIMLI_API_KEY": self.simli_api_key,
        }
        missing = [k for k, v in required.items() if not v]
        if missing:
            raise RuntimeError(
                f"Missing required environment variables: {', '.join(missing)}"
            )

    def agent_identity(self, job_id: Optional[str]) -> str:
        suffix = (job_id or secrets.token_hex(3))[-6:]
        return f"{self.agent_identity_prefix}-{suffix}"

    def controller_identity(self, job_id: Optional[str]) -> str:
        return f"{self.agent_identity(job_id)}-ctrl"

    def agent_metadata(self, agent_identity: str) -> Dict[str, str]:
        return {
            "role": "agent",
            "agentName": self.agent_name,
            "avatarId": self.simli_face_id,  # Changed from anam_avatar_id to simli_face_id
            "agentType": "avatar",
            "agentIdentity": agent_identity,
        }


CONFIG = AgentConfig()

# =========================
# UI Overlay / RPC Helpers
# =========================


async def _publish_overlay(
    session: Optional[AgentSession],
    kind: str,
    data: Dict[str, Any],
    room: Optional[Any] = None,
) -> None:
    """
    Publish overlay data to the UI via LiveKit data packets.
    IMPORTANT: we now always rely on the explicit `room` argument,
    not on `session.room`.
    """
    room_obj = room
    if not room_obj:
        logger.warning(
            "[OVERLAY] No room attached, skipping overlay for kind=%s", kind
        )
        return

    local_participant = getattr(room_obj, "local_participant", None)
    if not local_participant:
        logger.warning(
            "[OVERLAY] No local_participant on room, skipping overlay for kind=%s",
            kind,
        )
        return

    clean_data = _sanitize_output(data)
    message = json.dumps(
        {"type": "ui.overlay", "payload": {"kind": kind, **clean_data}}
    ).encode("utf-8")

    logger.info(
        "[OVERLAY] Publishing overlay | kind=%s | keys=%s",
        kind,
        list(clean_data.keys()),
    )
    try:
        await local_participant.publish_data(message, topic=OVERLAY_TOPIC)
    except Exception as exc:
        logger.exception("Failed to publish overlay '%s': %s", kind, exc)


async def _emit_client_rpc(
    ctx: Optional[RunContext],
    method: str,
    payload: Dict[str, Any],
    session: Optional[AgentSession] = None,
    room: Optional[Any] = None,
) -> Optional[str]:
    """
    Emitting RPC to UI clients.

    CRITICAL CHANGE:
    - We no longer depend on `session.room`.
    - We instead use explicit `room` (which is `ctx.room` / JobContext.room).
    """
    run_ctx = cast(Optional[RunContext], ctx) if ctx else None
    session_obj = session  # kept for possible future use

    room_obj = room
    if not room_obj:
        logger.error("[RPC] FAILED — No room available for method=%s", method)
        return None

    local_participant = getattr(room_obj, "local_participant", None)
    if not local_participant:
        logger.error(
            "[RPC] FAILED — Room has no local_participant for method=%s", method
        )
        return None

    local_identity = getattr(local_participant, "identity", None)
    destinations: List[str] = []
    for participant in room_obj.remote_participants.values():
        identity = getattr(participant, "identity", None)
        if not identity or identity == local_identity:
            continue
        attrs = getattr(participant, "attributes", {}) or {}
        is_guest = (
            identity.startswith("guest-")
            or identity.startswith("guest_")
            or attrs.get("role") == "guest"
        )
        if is_guest and identity not in destinations:
            destinations.append(identity)

    if not destinations:
        logger.warning(
            "[RPC] No guest participants found for method=%s, skipping RPC", method
        )
        return None

    if len(destinations) > 1:
        logger.warning(
            "[RPC] Multiple guests in room (%d) — RPC will target first: %s. "
            "This indicates a session isolation issue.",
            len(destinations),
            destinations[0],
        )

    clean_payload = _sanitize_output(payload)
    payload_json = json.dumps(clean_payload)
    dest_identity = destinations[0]

    logger.info(
        "[RPC] Attempting RPC → %s | destination=%s | payload=%s",
        method,
        dest_identity,
        clean_payload,
    )
    try:
        response = await local_participant.perform_rpc(
            destination_identity=dest_identity,
            method=method,
            payload=payload_json,
            response_timeout=2.0,
        )
        logger.info(
            "[RPC] SUCCESS ← %s | destination=%s | response=%s",
            method,
            dest_identity,
            response,
        )
        return response
    except Exception as exc:
        logger.error(
            "[RPC] FAILED — method=%s | destination=%s | error=%s",
            method,
            dest_identity,
            exc,
        )
        return None


# =================
# Tools / Functions
# =================


class ScoopTools:
    SIZE_ALIAS = {"small": "Kids", "value": "Value", "big": "Emlaaq", "large": "Emlaaq"}

    def __init__(
        self,
        config: AgentConfig,
        session: AgentSession,
        room: Any,
        controller_identity: Optional[str],
        session_state: ScoopSessionState,
    ) -> None:
        self.config = config
        self._session = session
        self._room = room  # <=== IMPORTANT: store JobContext.room here
        self._controller_identity = controller_identity
        self._session_state = session_state
        self._kb = SCOOP_KB
        self._product_order: List[str] = [
            pid
            for pid in self._kb.get("product_order", [])
            if pid in self._kb["products"]
        ]
        self._products = self._kb["products"]
        self._flavors = {f["id"]: f for f in self._kb.get("flavors", [])}
        self._toppings = {t["id"]: t for t in self._kb.get("toppings", [])}
        # line_state stores per-product selections (one active "build" per product ID per session)
        self._line_state: Dict[str, Dict[str, Any]] = {}
        self._cart_items: List[Dict[str, Any]] = []
        self._cart_summary: Dict[str, Any] = {}
        self._active_product_id: Optional[str] = None
        self._product_tokens_cache: Dict[str, set[str]] = {}
        self._flavor_tokens_cache: Dict[str, set[str]] = {}
        self._topping_tokens_cache: Dict[str, set[str]] = {}
        self._flavor_name_index = build_name_index(self._flavors)
        self._topping_name_index = build_name_index(self._toppings)
        self._pending_overlays: Dict[str, Dict[str, Any]] = {}
        self._last_overlay_ack: Optional[Dict[str, Any]] = None

        # Shared pricing configuration for flavors (used consistently in tools and cart)
        fp = self._kb.get("flavor_policy", {}).get("defaultFlavorPriceAED", 0.0)
        self._extra_flavor_price: Decimal = Decimal(str(fp))

    def _find_sundae_upgrade(self, product: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Find a Sundae Cup alternative with matching size/scoops for Cup upsell."""
        if product.get("category") != "Cups":
            return None
        size = product.get("size")
        scoops = product.get("scoops")
        for p in self._products.values():
            if (
                p.get("category") == "Sundae Cups"
                and p.get("size") == size
                and p.get("scoops") == scoops
                and p.get("available", True)
            ):
                return p
        return None

    def _suggest_flavor(self, exclude_ids: set[str]) -> Optional[Dict[str, Any]]:
        """Pick the first available flavor not already selected."""
        for f in self._flavors.values():
            fid = f.get("id")
            if not fid or fid in exclude_ids:
                continue
            if not f.get("available", True):
                continue
            return f
        return None

    def _suggest_topping(self, exclude_ids: set[str]) -> Optional[Dict[str, Any]]:
        """Pick the first available topping not already selected."""
        for t in self._toppings.values():
            tid = t.get("id")
            if not tid or tid in exclude_ids:
                continue
            if not t.get("available", True):
                continue
            return t
        return None

    def _suggest_premium_topping(
        self, exclude_ids: set[str], current_flavors: List[Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        """Pick a higher-priced topping that pairs with selected flavors."""
        flavor_classes = {
            f.get("classification") for f in current_flavors if f.get("classification")
        }
        flavor_names = " ".join(f.get("name", "") for f in current_flavors).lower()

        def score(t: Dict[str, Any]) -> int:
            name = (t.get("name") or "").lower()
            s = 0
            # price weight: prefer 6-dirham over 5
            price = t.get("priceAED")
            if isinstance(price, (int, float)) and price >= 6:
                s += 3
            # pairing weights
            if "choco" in flavor_names or "choco" in flavor_classes:
                if any(k in name for k in ["choco", "fudge", "nutella", "kitkat", "brownie"]):
                    s += 3
            if "berry" in flavor_names or "berry" in flavor_classes or "strawberry" in flavor_names:
                if any(k in name for k in ["berry", "strawberry", "rasp"]):
                    s += 3
            if any(k in flavor_names for k in ["vanilla", "classic", "coffee"]):
                if any(k in name for k in ["almond", "pistachio", "caramel", "sprinkle"]):
                    s += 2
            return s

        candidates = []
        for t in self._toppings.values():
            tid = t.get("id")
            if not tid or tid in exclude_ids:
                continue
            if not t.get("available", True):
                continue
            candidates.append((score(t), t))
        if not candidates:
            return None
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1] if candidates[0][0] > 0 else candidates[0][1]

    async def _rpc_with_context(
        self,
        method: str,
        payload: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """
        Wrapper around _emit_client_rpc that:
        - calls the UI
        - parses the response (if any)
        - stores it into ScoopSessionState
        - returns parsed response so tools can include it in their JSON

        NOTE: we no longer expose any ctx argument to the tools, we always
        use the stored room (self._room) and pass ctx=None to _emit_client_rpc.
        """
        rpc_raw = await _emit_client_rpc(
            None,
            method,
            payload,
            session=self._session,
            room=self._room,
        )

        rpc_parsed: Optional[Dict[str, Any]] = None
        if rpc_raw is not None:
            try:
                if isinstance(rpc_raw, (str, bytes)):
                    text = (
                        rpc_raw.decode("utf-8")
                        if isinstance(rpc_raw, bytes)
                        else rpc_raw
                    )
                    rpc_parsed = json.loads(text)
                elif isinstance(rpc_raw, dict):
                    rpc_parsed = rpc_raw
                else:
                    rpc_parsed = {"raw": rpc_raw}
            except Exception:
                rpc_parsed = {"raw": rpc_raw}

        # store in session state so SESSION_CONTEXT sees it
        if self._session_state:
            self._session_state.last_rpc_method = method
            self._session_state.last_rpc_request = _sanitize_output(payload)
            self._session_state.last_rpc_response = (
                _sanitize_output(rpc_parsed) if rpc_parsed else None
            )

        return rpc_parsed

    @function_tool(
        name="end_call",
        description="Finish the kiosk session. Call this only after you have already spoken the final professional closing line.",
    )
    async def end_call(self) -> Dict[str, Any]:
        await self._publish_overlay_for_ctx("clear", {})
        ui_rpc = await self._rpc_with_context("client.endCall", {"action": "end"})
        return _sanitize_output(
            {
                "status": "ending_call",
                "uiRpc": ui_rpc,
            }
        )

    def _get_catalog_context(self) -> str:
        lines = ["# Product Cheat Sheet"]
        for pid in self._product_order:
            product = self._products.get(pid)
            if not product:
                continue
            lines.append(f"- {product.get('name')} ({product.get('priceAED')} AED)")
        return "\n".join(lines)

    async def _publish_overlay_for_ctx(
        self, kind: str, data: Dict[str, Any]
    ) -> None:
        """
        Helper used by tools to publish overlays.
        Uses the stored room (self._room) rather than session.room.
        """

        # State updates
        if self._session_state:
            self._session_state.last_overlay_kind = kind
            self._session_state.last_overlay_payload = data
            history = self._session_state.overlay_history
            history.append(kind)
            if len(history) > 10:
                history.pop(0)

        await _publish_overlay(
            session=self._session,
            kind=kind,
            data=data,
            room=self._room,
        )

    def _canonical_display(self, raw: Optional[str]) -> Optional[str]:
        if not raw:
            return None
        displays = self._kb.get("displays", {})
        if raw in displays:
            return displays[raw].get("displayName") or raw
        for record in displays.values():
            if record.get("displayName") == raw:
                return record.get("displayName")
        return raw

    def _product_allows_flavors(self, product: Optional[Dict[str, Any]]) -> bool:
        if not product:
            return False
        if "allowFlavorSelection" in product:
            return bool(product.get("allowFlavorSelection"))
        return bool(product.get("scoops"))

    def _product_allows_toppings(self, product: Optional[Dict[str, Any]]) -> bool:
        if not product:
            return False
        allow_toppings = product.get("allowToppings")
        if allow_toppings is False:
            return False
        if allow_toppings == "liquid_only":
            return True
        category = product.get("category")
        return category in ("Cups", "Sundae Cups")

    def _format_product_card(self, p: Dict[str, Any]) -> Dict[str, Any]:
        price = p.get("priceAED")
        display_name = self._canonical_display(p.get("display"))
        return {
            "id": p.get("id"),
            "name": p.get("name"),
            "category": p.get("category") or CATEGORY_FALLBACK,
            "size": p.get("size"),
            "scoops": p.get("scoops"),
            "priceAED": round(float(price), 2) if price is not None else None,
            "imageUrl": p.get("imageUrl") or self._kb["image_defaults"]["square"],
            "display": display_name,
            "includedToppings": p.get("includedToppings"),
            "allowsFlavorSelection": self._product_allows_flavors(p),
            "allowsToppings": self._product_allows_toppings(p),
        }

    def _format_flavor_card(self, f: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": f["id"],
            "name": f["name"],
            "classification": f.get("classification"),
            "imageUrl": f.get("imageUrl") or self._kb["image_defaults"]["square"],
            "dietary": f.get("dietary", []),
            "available": bool(f.get("available", True)),
        }

    def _format_topping_card(self, t: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": t["id"],
            "name": t["name"],
            "type": t.get("type", "dry"),   # "liquid" | "dry" — used by UI for section grouping
            "priceAED": round(float(t.get("priceAED") or 0.0), 2),
            "imageUrl": t.get("imageUrl") or self._kb["image_defaults"]["square"],
            "dietary": t.get("dietary", []),
        }

    def _topping_note_for_product(self, product: Optional[Dict[str, Any]]) -> str:
        if not product:
            return "We have liquid and dry toppings."
        category = product.get("category")
        if category == "Cups":
            return "We have liquid and dry toppings. You can choose up to two, and the price depends on the topping you pick."
        if category == "Sundae Cups":
            return "We have liquid and dry toppings. Choose your included free toppings from those sections."
        if product.get("allowToppings") == "liquid_only":
            return "We have liquid and dry toppings, and this shake allows one liquid topping only."
        return "We have liquid and dry toppings."

    def _validate_toppings(
        self, product: Dict[str, Any], toppings: List[Dict[str, Any]]
    ) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        category = product.get("category")
        allow_toppings = product.get("allowToppings")
        included_toppings = int(product.get("includedToppings") or 0)
        max_toppings = int(product.get("maxToppings") or 0)
        max_liquid_toppings = int(product.get("maxLiquidToppings") or 0)

        if category == "Sundae Cups":
            if len(toppings) > included_toppings:
                return (
                    toppings[:included_toppings],
                    f"Sundae Cups only include {included_toppings} free topping(s). No extra toppings are allowed.",
                )
            return toppings, None

        if category == "Cups":
            if len(toppings) > max_toppings:
                return (
                    toppings[:max_toppings],
                    f"Cups can have up to {max_toppings} paid topping(s).",
                )
            return toppings, None

        if allow_toppings == "liquid_only":
            liquid_toppings = [t for t in toppings if t.get("type") == "liquid"]
            if len(liquid_toppings) != len(toppings):
                return (
                    liquid_toppings[:max_liquid_toppings],
                    "Make Your Own Shake allows liquid toppings only.",
                )
            if len(liquid_toppings) > max_liquid_toppings:
                return (
                    liquid_toppings[:max_liquid_toppings],
                    f"Make Your Own Shake allows only {max_liquid_toppings} liquid topping.",
                )
            return liquid_toppings, None

        return [], "Toppings are not available for this product."

    def _resolve_product(
        self, product_id: Optional[str], query: Optional[str]
    ) -> Optional[Dict[str, Any]]:
        if product_id:
            return self._products.get(product_id)
        if query:
            q = query.lower()

            # 1) Fast path: simple substring match on name
            for p in self._products.values():
                if q in (p.get("name") or "").lower():
                    return p

            # 2) Token-based match to catch hyphen/spacing differences
            q_tokens = _tokens_for_label(query)
            if q_tokens:
                # Build product token cache lazily
                def product_tokens(pid: str, prod: Dict[str, Any]) -> set[str]:
                    if pid in self._product_tokens_cache:
                        return self._product_tokens_cache[pid]

                    tokens = set()
                    tokens |= _tokens_for_label(prod.get("name"))
                    tokens |= _tokens_for_label(prod.get("category"))
                    tokens |= _tokens_for_label(prod.get("size"))

                    # Add common aliases to improve quick-order recognition
                    cat = (prod.get("category") or "").lower()
                    if "milk" in cat or "shake" in cat:
                        tokens.update({"shake", "milkshake", "milkshakes"})
                    if "sundae" in cat:
                        tokens.add("sundae")
                    if "cup" in cat:
                        tokens.add("cup")

                    self._product_tokens_cache[pid] = tokens
                    return tokens

                best_pid: Optional[str] = None
                best_score = 0

                for pid, prod in self._products.items():
                    tokens = product_tokens(pid, prod)
                    score = len(tokens & q_tokens)
                    if score > best_score:
                        best_score = score
                        best_pid = pid
                    elif score == best_score and best_pid:
                        # Tie-breaker: keep existing product order priority
                        try:
                            if (
                                self._product_order.index(pid)
                                < self._product_order.index(best_pid)
                            ):
                                best_pid = pid
                        except ValueError:
                            pass

                if best_pid and best_score > 0:
                    return self._products.get(best_pid)
        return None

    def _get_or_create_line_state(self, product: Dict[str, Any]) -> Dict[str, Any]:
        """
        Retrieve or create the current "build" state for a given product ID.
        One active line state per product ID per session.
        """
        pid = product["id"]
        if pid not in self._line_state:
            self._line_state[pid] = {
                "product": product,
                "flavors": [],  # no default vanilla, empty until choose_flavors is called
                "toppings": [],
                "flavor_summary": {
                    "free": int(product.get("scoops") or 0),
                    "used": 0,
                    "remainingFree": int(product.get("scoops") or 0),
                    "extraCount": 0,
                    "charge": Decimal(0),
                },
                "topping_summary": {
                    "free": int(product.get("includedToppings") or 0),
                    "used": 0,
                    "remainingFree": int(product.get("includedToppings") or 0),
                    "extraCount": 0,
                    "charge": Decimal(0),
                },
            }
        return self._line_state[pid]

    def _map_size_alias(self, size: Optional[str]) -> Optional[str]:
        if not size:
            return None
        return self.SIZE_ALIAS.get(size.lower(), size.title())

    def _resolve_flavor(self, ref: str) -> Optional[Dict[str, Any]]:
        # Direct id or exact name match
        direct = self._flavors.get(ref) or next(
            (f for f in self._flavors.values() if f["name"].lower() == ref.lower()),
            None,
        )
        if direct:
            return direct

        # Token-based match to handle partial names ("almond", "praline", etc.)
        ref_tokens = _tokens_for_label(ref)
        if not ref_tokens:
            return None

        def flavor_tokens(fid: str, flavor: Dict[str, Any]) -> set[str]:
            if fid in self._flavor_tokens_cache:
                return self._flavor_tokens_cache[fid]
            tokens = _tokens_for_label(flavor.get("name"))
            self._flavor_tokens_cache[fid] = tokens
            return tokens

        best_id: Optional[str] = None
        best_score = 0
        for fid, flavor in self._flavors.items():
            tokens = flavor_tokens(fid, flavor)
            score = len(tokens & ref_tokens)
            if score > best_score:
                best_score = score
                best_id = fid

        return self._flavors.get(best_id) if best_id and best_score > 0 else None

    def _resolve_topping(self, ref: str) -> Optional[Dict[str, Any]]:
        # Direct id or exact name match
        direct = self._toppings.get(ref) or next(
            (t for t in self._toppings.values() if t["name"].lower() == ref.lower()),
            None,
        )
        if direct:
            return direct

        # Token-based match to handle partial names ("almonds", "hot fudge", "sprinkles")
        ref_tokens = _tokens_for_label(ref)
        if not ref_tokens:
            return None

        def topping_tokens(tid: str, topping: Dict[str, Any]) -> set[str]:
            if tid in self._topping_tokens_cache:
                return self._topping_tokens_cache[tid]
            tokens = _tokens_for_label(topping.get("name"))
            self._topping_tokens_cache[tid] = tokens
            return tokens

        best_id: Optional[str] = None
        best_score = 0
        for tid, topping in self._toppings.items():
            tokens = topping_tokens(tid, topping)
            score = len(tokens & ref_tokens)
            if score > best_score:
                best_score = score
                best_id = tid

        return self._toppings.get(best_id) if best_id and best_score > 0 else None

    # --- MODIFIED TOOLS: CLEAN SCHEMA (NO ctx, OPTIONAL ARGS) ---
    @function_tool(
        name="list_menu",
        description="Render menu overlays. kind='products'|'flavors'|'toppings'.",
    )
    async def list_menu(
        self,
        kind: Literal["products", "flavors", "toppings"] = "products",
        category: Optional[str] = None,
        size: Optional[str] = None,
        query: Optional[str] = None,
        view: Optional[Literal["grid", "detail"]] = None,
        product_id: Optional[str] = None,
        confirmed: bool = False,
    ) -> Dict[str, Any]:

        logger.info(
            "[TOOL] list_menu CALLED | kind=%s | category=%s | size=%s | product_id=%s | view=%s | query=%s",
            kind,
            category,
            size,
            product_id,
            view,
            query,
        )

        kind_normalized = (kind or "").strip().lower()

        # =====================================================
        # PRODUCTS OVERLAY
        # =====================================================
        if kind_normalized == "products":
            view_mode = view or "grid"
            payload: Dict[str, Any] = {}
            target_product: Optional[Dict[str, Any]] = None

            # DETAIL VIEW
            if view_mode == "detail" or product_id:
                # resolve using explicit product_id first, then query, then active
                if product_id:
                    target_product = self._resolve_product(product_id, None)
                elif query:
                    target_product = self._resolve_product(None, query)
                elif self._active_product_id:
                    target_product = self._resolve_product(self._active_product_id, None)

                # For quick-order with query, require confirmation before showing detail
                if query and not product_id and not confirmed and target_product:
                    return _sanitize_output(
                        {
                            "status": "needs_confirmation",
                            "productId": target_product.get("id"),
                            "productName": target_product.get("name"),
                            "agentNote": "Confirm the item with the guest before showing the detail card.",
                        }
                    )

                if target_product:
                    self._active_product_id = target_product.get("id")

                    line = self._get_or_create_line_state(target_product)
                    flavors_for_line = line.get("flavors", [])
                    toppings_for_line = line.get("toppings", [])
                    flavor_summary = line.get("flavor_summary", {}) or {}
                    topping_summary = line.get("topping_summary", {}) or {}

                    selected_flavors = [
                        {
                            "id": f["id"],
                            "name": f["name"],
                            "classification": f.get("classification"),
                            "imageUrl": f.get("imageUrl"),
                            "isExtra": idx >= int(flavor_summary.get("free", 0)),
                        }
                        for idx, f in enumerate(flavors_for_line)
                    ]
                    selected_toppings = [
                        {
                            "id": t["id"],
                            "name": t["name"],
                            "priceAED": float(t.get("priceAED") or 0.0),
                            "imageUrl": t.get("imageUrl"),
                            "isFree": idx < int(topping_summary.get("free", 0)),
                        }
                        for idx, t in enumerate(toppings_for_line)
                    ]

                    flavor_note = None
                    if flavor_summary:
                        used = int(flavor_summary.get("used", 0))
                        free_slots = int(flavor_summary.get("free", 0))
                        extra_count = max(0, used - free_slots)
                        charge = float(flavor_summary.get("charge", 0) or 0)
                        flavor_note = {
                            "label": f"{used} flavor(s) selected ({extra_count} extra)",
                            "extraNote": (
                                f"Extra flavor charge: {charge:.2f} dirham"
                                if charge > 0
                                else None
                            ),
                        }

                    topping_note = None
                    if topping_summary:
                        used = int(topping_summary.get("used", 0))
                        free_slots = int(topping_summary.get("free", 0))
                        extra_count = max(0, used - free_slots)
                        charge = float(topping_summary.get("charge", 0) or 0)
                        topping_note = {
                            "label": f"{used} topping(s) selected ({extra_count} extra)",
                            "extraNote": (
                                f"Extra topping charge: {charge:.2f} dirham"
                                if charge > 0
                                else None
                            ),
                        }

                    payload = {
                        "kind": "products",
                        "view": "detail",
                        "product": self._format_product_card(target_product),
                        "selectedFlavors": _sanitize_output(selected_flavors),
                        "selectedToppings": _sanitize_output(selected_toppings),
                        "flavorSummary": _sanitize_output(flavor_note)
                        if flavor_note
                        else None,
                        "toppingSummary": _sanitize_output(topping_note)
                        if topping_note
                        else None,
                        "contextProductId": target_product.get("id"),
                        "cartSummary": self._cart_summary or None,
                    }
                    view_mode = "detail"
                else:
                    view_mode = "grid"

            # GRID VIEW
            if view_mode == "grid":
                prods = [
                    self._format_product_card(p)
                    for p in self._products.values()
                    if (not category or p.get("category") == category)
                ]
                payload = {
                    "kind": "products",
                    "view": "grid",
                    "products": prods,
                    "category": category or "All",
                    "size": size,
                    "query": query,
                    "cartSummary": self._cart_summary or None,
                }

            # Publish overlay (full data for UI)
            await self._publish_overlay_for_ctx("products", payload)

            # RPC
            rpc_payload = {
                "view": view_mode,
                "category": category or "All",
                "productId": target_product.get("id") if target_product else None,
                "productName": target_product.get("name") if target_product else None,
            }
            ui_rpc = await self._rpc_with_context("client.menuLoaded", rpc_payload)

            logger.info(
                "[TOOL] list_menu OUTPUT → view=%s | product_count=%d",
                view_mode,
                len(payload.get("products", []))
                if isinstance(payload.get("products"), list)
                else 1,
            )

            # Return a lightweight summary to the LLM — full card data is already
            # in the overlay so there is no need to send imageUrls and descriptions
            # back through the LLM context (saves ~1-2k tokens per tool call).
            if view_mode == "grid":
                llm_return: Dict[str, Any] = {
                    "status": "menu_shown",
                    "view": "grid",
                    "category": category or "All",
                    "count": len(payload.get("products", [])),
                    "products": [
                        {"id": p["id"], "name": p["name"], "priceAED": p["priceAED"],
                         "scoops": p.get("scoops"), "size": p.get("size"),
                         "category": p.get("category")}
                        for p in payload.get("products", [])
                    ],
                }
            else:
                tp = target_product or {}
                llm_return = {
                    "status": "detail_shown",
                    "view": "detail",
                    "productId": tp.get("id"),
                    "productName": tp.get("name"),
                    "priceAED": tp.get("priceAED"),
                    "scoops": tp.get("scoops"),
                    "size": tp.get("size"),
                    "category": tp.get("category"),
                    "includedToppings": tp.get("includedToppings"),
                    "allowsFlavorSelection": self._product_allows_flavors(tp),
                    "selectedFlavors": [f["name"] for f in (self._line_state.get(tp.get("id") or "", {}).get("flavors") or [])],
                    "selectedToppings": [t["name"] for t in (self._line_state.get(tp.get("id") or "", {}).get("toppings") or [])],
                }
            llm_return["uiRpc"] = ui_rpc
            return _sanitize_output(llm_return)

        # =====================================================
        # FLAVORS / TOPPINGS
        # =====================================================
        if kind_normalized in ["flavors", "toppings"]:
            target_product_id = product_id or self._active_product_id
            target_product = (
                self._products.get(target_product_id) if target_product_id else None
            )
            line = self._get_or_create_line_state(target_product) if target_product else None

            if kind_normalized == "flavors":
                if not target_product or not self._product_allows_flavors(target_product):
                    note = "Flavor selection is not available for this product. Please proceed with toppings only."
                    logger.info(
                        "[TOOL] list_menu skipping flavors for product=%s | reason=disallowed",
                        target_product_id,
                    )
                    return _sanitize_output(
                        {
                            "error": "flavor_selection_not_available",
                            "productId": target_product_id,
                            "productName": target_product.get("name")
                            if target_product
                            else None,
                            "agentNote": note,
                        }
                    )

                cards = [self._format_flavor_card(f) for f in self._flavors.values()]
                free_slots = 0
                used = 0
                extra_count = 0
                selected_ids: List[str] = []
                selected_flavors: List[Dict[str, Any]] = []

                if line:
                    flavor_summary = line.get("flavor_summary", {}) or {}
                    free_slots = int(
                        flavor_summary.get(
                            "free",
                            int(target_product.get("scoops") or 0)
                            if target_product
                            else 0,
                        )
                    )
                    used = len(line.get("flavors", []))
                    extra_count = max(0, used - free_slots)

                    for idx, f in enumerate(line.get("flavors", [])):
                        selected_ids.append(f["id"])
                        selected_flavors.append(
                            {
                                "id": f["id"],
                                "name": f["name"],
                                "classification": f.get("classification"),
                                "imageUrl": f.get("imageUrl"),
                                "isExtra": idx >= free_slots,
                            }
                        )

                payload = {
                    "kind": "flavors",
                    "productId": target_product_id,
                    "productName": target_product.get("name")
                    if target_product
                    else None,
                    "freeFlavors": free_slots,
                    "maxFlavors": free_slots
                    or used
                    or (target_product.get("scoops") if target_product else 0),
                    "selectedFlavorIds": selected_ids,
                    "selectedFlavors": selected_flavors,
                    "usedFreeFlavors": min(used, free_slots),
                    "extraFlavorCount": extra_count,
                    "flavors": cards,
                }

            else:  # toppings
                allowed_toppings = list(self._toppings.values())
                if target_product and not self._product_allows_toppings(target_product):
                    return _sanitize_output(
                        {
                            "error": "topping_selection_not_available",
                            "productId": target_product_id,
                            "productName": target_product.get("name"),
                            "agentNote": "Toppings are not available for this product.",
                        }
                    )
                if target_product and target_product.get("allowToppings") == "liquid_only":
                    allowed_toppings = [
                        t for t in allowed_toppings if t.get("type") == "liquid"
                    ]
                cards = [self._format_topping_card(t) for t in allowed_toppings]
                free_slots = (
                    int(target_product.get("includedToppings") or 0)
                    if target_product
                    else 0
                )
                selected_ids: List[str] = []
                selected_toppings: List[Dict[str, Any]] = []
                free_remaining = 0

                if line:
                    topping_summary = line.get("topping_summary", {}) or {}
                    free_slots = int(topping_summary.get("free", free_slots))
                    used = len(line.get("toppings", []))
                    free_remaining = max(0, free_slots - used)

                    for idx, t in enumerate(line.get("toppings", [])):
                        selected_ids.append(t["id"])
                        selected_toppings.append(
                            {
                                "id": t["id"],
                                "name": t["name"],
                                "priceAED": float(t.get("priceAED") or 0.0),
                                "imageUrl": t.get("imageUrl"),
                                "isFree": idx < free_slots,
                            }
                        )

                payload = {
                    "kind": "toppings",
                    "productId": target_product_id,
                    "productName": target_product.get("name")
                    if target_product
                    else None,
                    "category": target_product.get("category") if target_product else None,
                    "note": self._topping_note_for_product(target_product),
                    "freeToppings": free_slots,
                    "freeToppingsRemaining": free_remaining,
                    "selectedToppingIds": selected_ids,
                    "selectedToppings": selected_toppings,
                    "toppings": cards,
                }

            await self._publish_overlay_for_ctx(kind_normalized, payload)

            rpc_payload = {
                "productId": target_product_id,
                "count": len(
                    payload.get(
                        "flavors" if kind_normalized == "flavors" else "toppings", []
                    )
                ),
            }
            ui_rpc = await self._rpc_with_context(
                f"client.{kind_normalized}Loaded",
                rpc_payload,
            )

            # Return lightweight summary to LLM — full card data is in the overlay.
            if kind_normalized == "flavors":
                fl_summary = line.get("flavor_summary", {}) if line else {}
                llm_flavor_return: Dict[str, Any] = {
                    "status": "flavor_menu_shown",
                    "productId": target_product_id,
                    "freeFlavors": payload.get("freeFlavors", 0),
                    "selectedFlavors": [f["name"] for f in (line.get("flavors", []) if line else [])],
                    "remainingFree": fl_summary.get("remainingFree", payload.get("freeFlavors", 0)),
                    "availableFlavors": [f["name"] for f in self._flavors.values() if f.get("available", True)],
                }
                llm_flavor_return["uiRpc"] = ui_rpc
                return _sanitize_output(llm_flavor_return)
            else:
                tp_summary = line.get("topping_summary", {}) if line else {}
                llm_topping_return: Dict[str, Any] = {
                    "status": "topping_menu_shown",
                    "productId": target_product_id,
                    "freeToppings": payload.get("freeToppings", 0),
                    "freeToppingsRemaining": payload.get("freeToppingsRemaining", 0),
                    "selectedToppings": [t["name"] for t in (line.get("toppings", []) if line else [])],
                    "availableToppings": [
                        {"name": t["name"], "type": t.get("type", "dry"), "priceAED": t.get("priceAED")}
                        for t in allowed_toppings
                        if t.get("available", True)
                    ],
                }
                llm_topping_return["uiRpc"] = ui_rpc
                return _sanitize_output(llm_topping_return)

        return {"error": "invalid kind"}

    @function_tool(
        name="choose_flavors", description="Attach selected flavors to product."
    )
    async def choose_flavors(
        self,
        product_id: str,
        flavor_ids: List[str],
    ) -> Dict[str, Any]:
        # Keep the active product in sync so subsequent detail refreshes target the same item
        self._active_product_id = product_id
        product = self._products.get(product_id)
        if not product:
            return {"error": "Unknown product"}

        if not self._product_allows_flavors(product):
            agent_note = (
                "Flavor selection is locked for this item. Offer toppings instead; toppings are charged."
            )
            return _sanitize_output(
                {
                    "status": "Flavor selection unavailable",
                    "productId": product_id,
                    "agentNote": agent_note,
                }
            )

        line = self._get_or_create_line_state(product)

        resolved_flavors: List[Dict[str, Any]] = []
        for fid in flavor_ids:
            f = self._resolve_flavor(fid)
            if f:
                resolved_flavors.append(f)

        free_slots = int(product.get("maxFlavors") or product.get("scoops") or 0)
        truncated = False
        if len(resolved_flavors) > free_slots:
            resolved_flavors = resolved_flavors[:free_slots]
            truncated = True

        # Even if empty, we respect it and clear previous selections
        line["flavors"] = resolved_flavors

        flavor_summary = line.get("flavor_summary", {}) or {}
        free_slots = int(flavor_summary.get("free", free_slots))
        used = len(resolved_flavors)
        extra_count = max(0, used - free_slots)

        extra_price_per = self._extra_flavor_price
        extra_charge = extra_price_per * Decimal(extra_count)

        remaining_free = max(free_slots - used, 0)

        flavor_summary["free"] = free_slots
        flavor_summary["used"] = used
        flavor_summary["remainingFree"] = remaining_free
        flavor_summary["extraCount"] = extra_count
        flavor_summary["charge"] = extra_charge
        line["flavor_summary"] = flavor_summary

        # Pull current toppings so the detail card stays fully populated
        current_toppings = line.get("toppings", [])
        topping_summary = line.get("topping_summary", {}) or {}

        # Update detail product overlay
        await self._publish_overlay_for_ctx(
            "products",
            {
                "view": "detail",
                "product": self._format_product_card(product),
                "selectedFlavors": [
                    _sanitize_output(self._format_flavor_card(f))
                    for f in resolved_flavors
                ],
                "flavorSummary": _sanitize_output(flavor_summary),
                "selectedToppings": [
                    _sanitize_output(self._format_topping_card(t))
                    for t in current_toppings
                ],
                "toppingSummary": _sanitize_output(topping_summary)
                if topping_summary
                else None,
            },
        )

        # Human-readable note for the LLM to speak out
        flavor_names = ", ".join(f["name"] for f in resolved_flavors) or "no flavors"
        agent_note = (
            f"I have added {used} flavor(s): {flavor_names}. "
            f"You have {remaining_free} free flavor(s) remaining. "
            f"Extra flavor charge is {float(extra_charge):.2f} dirham."
        )
        if truncated:
            agent_note = (
                f"{agent_note} This item only allows {free_slots} flavor(s), so I kept the first {free_slots}."
            )
        upsell_hint = None
        flavor_upsell_suggestion = None
        suggested_flavor = self._suggest_flavor({f.get("id") for f in resolved_flavors})
        if remaining_free > 0 and suggested_flavor:
            upsell_hint = (
                f"You still have free flavor slots. Suggest adding {suggested_flavor.get('name')} for free."
            )
            flavor_upsell_suggestion = {
                "type": "add",
                "flavor": self._format_flavor_card(suggested_flavor),
                "extraPriceAED": 0.0,
            }
        elif remaining_free == 0 and suggested_flavor:
            upsell_hint = (
                f"Flavors are full; propose swapping one for {suggested_flavor.get('name')} at no extra cost."
            )
            flavor_upsell_suggestion = {
                "type": "swap",
                "flavor": self._format_flavor_card(suggested_flavor),
                "extraPriceAED": 0.0,
            }
        if upsell_hint:
            agent_note = f"{agent_note} {upsell_hint}"

        return _sanitize_output(
            {
                "status": "Flavors updated",
                "productId": product_id,
                "flavors": [f["id"] for f in resolved_flavors],
                "flavorSummary": flavor_summary,
                "agentNote": agent_note,
                "flavorUpsellHint": upsell_hint,
                "flavorUpsellSuggestion": flavor_upsell_suggestion,
            }
        )

    @function_tool(name="choose_toppings", description="Attach selected toppings.")
    async def choose_toppings(
        self,
        product_id: str,
        topping_ids: List[str],
    ) -> Dict[str, Any]:
        self._active_product_id = product_id
        product = self._products.get(product_id)
        if not product:
            return {"error": "Unknown product"}

        line = self._get_or_create_line_state(product)

        resolved_toppings: List[Dict[str, Any]] = []
        for tid in topping_ids:
            t = self._resolve_topping(tid)
            if t:
                resolved_toppings.append(t)

        resolved_toppings, validation_note = self._validate_toppings(
            product, resolved_toppings
        )

        line["toppings"] = resolved_toppings

        topping_summary = line.get("topping_summary", {}) or {}
        free_slots = int(
            topping_summary.get("free", int(product.get("includedToppings") or 0))
        )
        used = len(resolved_toppings)
        extra_count = max(0, used - free_slots)

        extra_charge = Decimal(0)
        if extra_count > 0:
            # charge only toppings beyond free slots
            chargeable_toppings = resolved_toppings[free_slots:]
            for t in chargeable_toppings:
                price = Decimal(str(t.get("priceAED", 0.0)))
                extra_charge += price

        remaining_free = max(free_slots - used, 0)

        topping_summary["free"] = free_slots
        topping_summary["used"] = used
        topping_summary["remainingFree"] = remaining_free
        topping_summary["extraCount"] = extra_count
        topping_summary["charge"] = extra_charge
        line["topping_summary"] = topping_summary

        current_flavors = line.get("flavors", [])
        flavor_summary = line.get("flavor_summary", {}) or {}

        await self._publish_overlay_for_ctx(
            "products",
            {
                "view": "detail",
                "product": self._format_product_card(product),
                "selectedToppings": [
                    _sanitize_output(self._format_topping_card(t))
                    for t in resolved_toppings
                ],
                "toppingSummary": _sanitize_output(topping_summary),
                "selectedFlavors": [
                    _sanitize_output(self._format_flavor_card(f))
                    for f in current_flavors
                ],
                "flavorSummary": _sanitize_output(flavor_summary)
                if flavor_summary
                else None,
            },
        )

        topping_names = ", ".join(t["name"] for t in resolved_toppings) or "no toppings"
        agent_note = (
            f"I have added {used} topping(s): {topping_names}. "
            f"You have {remaining_free} free topping(s) remaining. "
            f"Extra topping charge is {float(extra_charge):.2f} dirham."
        )
        if validation_note:
            agent_note = f"{agent_note} {validation_note}"
        upgrade_hint = None
        upgrade_overlay: Optional[Dict[str, Any]] = None
        # Deterministic Sundae upsell when a Cup has paid toppings beyond included slots.
        if product.get("category") == "Cups" and extra_count > 0:
            sundae_option = self._find_sundae_upgrade(product)
            price_diff = None
            if sundae_option:
                price_diff = Decimal(str(sundae_option.get("priceAED", 0))) - Decimal(
                    str(product.get("priceAED", 0))
                )
                upgrade_overlay = {
                    "kind": "upgrade",
                    "show": True,
                    "fromProduct": self._format_product_card(product),
                    "toProduct": {
                        **self._format_product_card(sundae_option),
                        "headline": f"Upgrade to {sundae_option.get('name')}",
                        "subline": "Toppings included with Sundae Cups.",
                    },
                    "priceDiffAED": _sanitize_output(price_diff),
                    "savingsEstimateAED": _sanitize_output(extra_charge),
                }
                await self._publish_overlay_for_ctx("upgrade", upgrade_overlay)
            upgrade_hint = (
                "This is a Cup with paid toppings. Offer an upgrade to a Sundae Cup for better value "
                "since toppings are included there."
            )
            if sundae_option and price_diff is not None:
                upgrade_hint = (
                    f"Upgrade to {sundae_option.get('name')} for about {float(price_diff):.2f} dirham; "
                    "toppings become included."
                )
            agent_note = f"{agent_note} {upgrade_hint}"

        topping_upsell_hint = None
        suggested_top = self._suggest_premium_topping(
            {t.get("id") for t in resolved_toppings}, current_flavors
        )
        if remaining_free > 0 and suggested_top:
            topping_upsell_hint = (
                f"{suggested_top.get('name')} would pair nicely with these flavors. Want me to add it for free?"
            )
        elif remaining_free == 0 and suggested_top and product.get("category") == "Sundae Cups":
            topping_upsell_hint = (
                f"{suggested_top.get('name')} would taste great here. I can replace one of the current toppings with it. Should I go ahead?"
            )
        elif (
            remaining_free == 0
            and suggested_top
            and product.get("category") == "Cups"
            and len(resolved_toppings) < int(product.get("maxToppings") or 0)
        ):
            topping_upsell_hint = (
                f"{suggested_top.get('name')} would pair nicely here for {float(suggested_top.get('priceAED') or 0.0):.2f} dirham. Want me to add it?"
            )
        if topping_upsell_hint:
            agent_note = f"{agent_note} {topping_upsell_hint}"

        return _sanitize_output(
            {
                "status": "Toppings updated",
                "productId": product_id,
                "toppings": [t["id"] for t in resolved_toppings],
                "toppingSummary": topping_summary,
                "agentNote": agent_note,
                "upgradeHint": upgrade_hint,
                "upgradeOverlay": upgrade_overlay,
                "toppingUpsellHint": topping_upsell_hint,
                "toppingUpsellSuggestion": (
                    {
                        "type": (
                            "add"
                            if remaining_free > 0
                            else "swap"
                            if product.get("category") == "Sundae Cups"
                            else "add"
                        ),
                        "topping": self._format_topping_card(suggested_top)
                        if suggested_top
                        else None,
                        "extraPriceAED": (
                            0.0
                            if remaining_free > 0 or product.get("category") == "Sundae Cups"
                            else _sanitize_output(suggested_top.get("priceAED"))
                            if suggested_top
                            else None
                        ),
                    }
                    if suggested_top
                    else None
                ),
            }
        )

    @function_tool(name="add_to_cart", description="Finalize product and add to cart.")
    async def add_to_cart(
        self,
        product_id: str,
        qty: int = 1,
    ) -> Dict[str, Any]:
        product = self._products.get(product_id)
        if not product:
            return {"error": "Unknown product"}

        qty = max(1, int(qty))

        line = self._get_or_create_line_state(product)
        flavor_summary = line.get("flavor_summary", {}) or {}
        topping_summary = line.get("topping_summary", {}) or {}

        base_price = Decimal(str(product.get("priceAED") or 0.0))
        flavor_charge = Decimal(str(flavor_summary.get("charge", 0)))
        # Re-calculate topping logic to be precise about free/paid split
        included_toppings_count = int(product.get("includedToppings") or 0)
        current_toppings = line.get("toppings", [])

        tagged_toppings = []
        topping_extras_total = Decimal(0)

        for i, t in enumerate(current_toppings):
            t_card = self._format_topping_card(t)
            is_free = i < included_toppings_count

            if is_free:
                unit_price = 0.0
            else:
                unit_price = float(t.get("priceAED") or 0.0)

            line_price = unit_price * qty
            if not is_free:
                topping_extras_total += Decimal(str(unit_price))

            tagged_toppings.append(
                {
                    **t_card,
                    "isFree": is_free,
                    "unitPriceAED": unit_price,
                    "linePriceAED": line_price,
                }
            )

        # Use our recalculated topping charge instead of the summary one
        # to ensure consistency with the line items
        topping_charge = topping_extras_total

        # 1. Calculate per-unit totals
        per_unit_subtotal = base_price + flavor_charge + topping_charge

        # 2. Calculate line totals (Subtotal + Tax)
        # Tax is applied to the line subtotal (unit * qty)
        line_subtotal = (per_unit_subtotal * Decimal(qty)).quantize(Decimal("0.01"))
        line_tax = (line_subtotal * VAT_RATE).quantize(Decimal("0.01"))
        line_total = line_subtotal + line_tax

        # Tag flavors with price and extra/free flags based on summary
        flavors_list = line.get("flavors", [])
        free_count = int(
            flavor_summary.get("free", int(product.get("scoops") or 0))
        )
        extra_price_per = self._extra_flavor_price

        tagged_flavors = []
        for i, f in enumerate(flavors_list):
            f_card = self._format_flavor_card(f)
            is_extra = i >= free_count
            unit_price = float(extra_price_per) if is_extra else 0.0
            tagged_flavors.append(
                {
                    **f_card,
                    "isExtra": is_extra,
                    "unitPriceAED": unit_price,
                    "linePriceAED": unit_price * qty,
                }
            )

        cart_item = {
            "product_id": product_id,
            "name": product["name"],
            "category": product.get("category"),
            "size": product.get("size"),
            "imageUrl": product.get("imageUrl")
            or self._kb["image_defaults"]["square"],
            "qty": qty,
            # price breakdown for UI
            "basePriceAED": _sanitize_output(base_price),
            "flavorExtrasAED": _sanitize_output(flavor_charge),
            "toppingExtrasAED": _sanitize_output(topping_charge),
            "unitSubTotalAED": _sanitize_output(per_unit_subtotal),
            "unitTaxAED": _sanitize_output(per_unit_subtotal * VAT_RATE),
            "lineSubTotalAED": _sanitize_output(line_subtotal),
            "lineTaxAED": _sanitize_output(line_tax),
            "lineTotalAED": _sanitize_output(line_total),
            # line details
            "flavors": tagged_flavors,
            "toppings": tagged_toppings,
        }

        self._cart_items.append(cart_item)

        # 4. Recalculate Cart Totals
        cart_subtotal = Decimal(0)
        cart_tax = Decimal(0)
        cart_total = Decimal(0)

        for item in self._cart_items:
            cart_subtotal += Decimal(str(item.get("lineSubTotalAED", 0.0)))
            cart_tax += Decimal(str(item.get("lineTaxAED", 0.0)))
            cart_total += Decimal(str(item.get("lineTotalAED", 0.0)))

        self._cart_summary = {
            "subTotalAED": _sanitize_output(cart_subtotal),
            "taxAED": _sanitize_output(cart_tax),
            "totalAED": _sanitize_output(cart_total),
        }

        payload = {"items": self._cart_items, **self._cart_summary}

        # 1. Publish Overlay
        await self._publish_overlay_for_ctx("cart", {"cart": payload})

        # 2. Emit Client RPC + capture UI response
        ui_rpc = await self._rpc_with_context(
            "client.cartUpdated",
            {"cart": payload},
        )

        agent_note = (
            f"I have added {qty} {product['name']} to your cart. "
            f"Your current total is {float(cart_total):.2f} dirham including tax."
        )
        cart_upsell_hint = None
        cart_upsell_suggestion = None
        # Simple cart-level upsell: if this is a Cup/Sundae, suggest a Milkshake; if a Milkshake, suggest a Sundae.
        if product.get("category") in ("Cups", "Sundae Cups"):
            cart_upsell_hint = (
                "Suggest a matching milkshake verbally only. Do not open the menu or change the UI "
                "unless the guest explicitly accepts the suggestion."
            )
            cart_upsell_suggestion = {"type": "add", "category": "Milk Shakes"}
        elif product.get("category") == "Milk Shakes":
            cart_upsell_hint = (
                "Suggest a matching Sundae Cup verbally only. Do not open the menu or change the UI "
                "unless the guest explicitly accepts the suggestion."
            )
            cart_upsell_suggestion = {"type": "add", "category": "Sundae Cups"}
        if cart_upsell_hint:
            agent_note = f"{agent_note} {cart_upsell_hint}"

        return _sanitize_output(
            {
                "cart": payload,
                "uiRpc": ui_rpc,
                "agentNote": agent_note,
                "cartUpsellHint": cart_upsell_hint,
                "cartUpsellSuggestion": cart_upsell_suggestion,
            }
        )

    @function_tool(name="get_directions", description="Show pickup directions.")
    async def get_directions(
        self,
        display_name: str,
        extra_displays: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        displays = self._kb.get("displays", {})

        locations: List[Dict[str, Any]] = []

        def build_location(name: str) -> Dict[str, Any]:
            canonical = self._canonical_display(name)
            info = displays.get(canonical or name, {})
            return {
                "displayName": info.get("displayName", canonical or name),
                "hint": info.get("hint", "Please proceed to this counter."),
                "mapImage": info.get("mapImage"),
            }

        locations.append(build_location(display_name))

        if extra_displays:
            for extra in extra_displays:
                locations.append(build_location(extra))

        payload = {"locations": locations}

        # Overlay
        await self._publish_overlay_for_ctx("directions", payload)

        # RPC for UI (DirectionsPayload expects action + locations) + store context
        ui_rpc = await self._rpc_with_context(
            "client.directions",
            {"action": "show", "locations": locations},
        )

        return _sanitize_output(
            {
                **payload,
                "uiRpc": ui_rpc,
            }
        )


class ScoopAgent(Agent):
    """Agent wrapper from Code 1, adapted for Google/Deepgram/Cartesia pipeline."""

    def __init__(
        self,
        session_state: ScoopSessionState,
        tools: ScoopTools,
        language: str = "english",
    ) -> None:
        self._session_state = session_state
        self._tools = tools
        self._language = language
        toolkit = [
            self._tools.list_menu,
            self._tools.choose_flavors,
            self._tools.choose_toppings,
            self._tools.add_to_cart,
            self._tools.end_call,
        ]
        super().__init__(instructions=self._build_instructions(), tools=toolkit)

    def _build_instructions(self) -> str:
        context_summary = self._session_state.describe()
        catalog_context = self._tools._get_catalog_context()
        # Load prompt dynamically from personal.toml
        prompt_text, _ = load_prompt_config(self._language)
        instructions = prompt_text.replace("{{CATALOG_CONTEXT}}", catalog_context)
        instructions = instructions.replace("{{SESSION_CONTEXT}}", context_summary)
        return instructions

    async def on_enter(self, participant: Any = None) -> None:
        logger.info("[AGENT] on_enter called, sending initial greeting.")
        try:
            if self._language == "arabic":
                tod = _time_of_day_greeting_arabic()
                greeting = f"{tod}، يا هلا فيكم في باسكين روبنز، اسمي سارة. أتشرف، ويا منو أتكلم اليوم؟"
            else:
                tod = _time_of_day_greeting()
                greeting = f"{tod}, welcome to Baskin Robbins. My name is Sarah. May I know your name?"
            await self.session.say(greeting, allow_interruptions=True)
        except Exception:
            logger.exception("Failed to deliver opening greeting")


# =====================
# Worker Entrypoint (Rewritten for Code 2 Pipeline)
# =====================


async def entrypoint(ctx: JobContext) -> None:
    config = CONFIG
    job_id = ctx.job.id if ctx.job else None
    agent_identity = config.agent_identity(job_id)
    controller_identity = config.controller_identity(job_id)

    await ctx.connect()

    # --- Detect language from room metadata ---
    # Retry briefly: room metadata is pre-set by connection-details API,
    # but there may be a tiny propagation delay after ctx.connect().
    language = "english"  # default
    room_meta: Dict[str, Any] = {}
    for _attempt in range(5):
        try:
            room_metadata_raw = ctx.room.metadata or ""
            if room_metadata_raw:
                room_meta = _parse_room_metadata(room_metadata_raw)
                language = room_meta.get("language", "english").lower().strip()
                break
        except AttributeError:
            pass
        await asyncio.sleep(0.2)

    session_limit_seconds = int(room_meta.get("sessionLimitSeconds") or SESSION_LIMIT_SECONDS)
    session_deadline_at_ms = int(
        room_meta.get("sessionDeadlineAt")
        or ((datetime.now().timestamp() * 1000) + (session_limit_seconds * 1000))
    )
    warning_seconds = max(1, min(SESSION_WARNING_SECONDS, session_limit_seconds))
    session_limit_minutes = max(1, session_limit_seconds // 60)

    if language == "english":
        logger.info("[ENTRYPOINT] Language resolved to 'english' (default or explicit)")
    else:
        logger.info("[ENTRYPOINT] Language resolved to '%s' from room metadata", language)

    # Load voice_id from personal.toml based on language
    _, voice_id = load_prompt_config(language)

    logger.info(
        "[ENTRYPOINT] Starting job_id=%s | agent_identity=%s | language=%s | voice=%s | deadline_ms=%s",
        job_id,
        agent_identity,
        language,
        voice_id,
        session_deadline_at_ms,
    )

    # Deepgram STT with language-aware config
    stt_language = "ar" if language == "arabic" else "en"
    stt = deepgram.STT(model="nova-3", language=stt_language, api_key=config.deepgram_api_key)
    vad = silero.VAD.load()
    llm = lk_openai.LLM(
        model=config.openai_model,
        api_key=config.openai_api_key,
    )
    
    # COMMENTED OUT: Google Gemini LLM
    # llm = lk_google.LLM(
    #     model=config.google_model,
    #     api_key=config.google_api_key,
    # )

    # TTS with language-specific voice from personal.toml (Cartesia sonic-3)
    tts = cartesia.TTS(
        model="sonic-3",
        voice=voice_id,
        api_key=config.cartesia_api_key,
    )

    # Turn detection: LiveKit MultilingualModel (runs locally on CPU, ~500 MB RAM)
    # Uses Deepgram STT transcripts for context-aware end-of-turn detection
    turn_detector = MultilingualModel()

    session = AgentSession(
        stt=stt,
        vad=vad,
        llm=llm,
        tts=tts,
        turn_detection=turn_detector,
        min_endpointing_delay=0.2,   # was 0.5 — time after speech stops before LLM fires
        max_endpointing_delay=1.2,   # was 3.0 — cap on how long we wait for more speech
    )

    # COMMENTED OUT: Anam Avatar Session (switched to Simli)
    # avatar_session = anam_avatar.AvatarSession(
    #     persona_config=anam_avatar.PersonaConfig(
    #         name=config.agent_name,
    #         avatarId=config.anam_avatar_id,
    #     ),
    #     api_key=config.anam_api_key,
    #     avatar_participant_name=config.agent_name,
    #     avatar_participant_identity=agent_identity,
    # )

    # Simli Avatar Session
    avatar_session = simli.AvatarSession(
        simli_config=simli.SimliConfig(
            api_key=config.simli_api_key,
            face_id=config.simli_face_id,
        ),
        avatar_participant_name=config.agent_name,
    )

    # State & Tools (Code 1 Style)
    session_state = ScoopSessionState()
    tools = ScoopTools(config, session, ctx.room, controller_identity, session_state)

    # --- RPC Handlers ---
    async def handle_add_to_cart_rpc(rpc_data) -> str:
        try:
            payload_raw = rpc_data.payload or "{}"
            payload = json.loads(payload_raw)
            product_id = payload.get("productId") or payload.get("product_id")
            qty = int(payload.get("qty", 1))
            if not product_id:
                return "missing productId"

            await tools.add_to_cart(str(product_id), qty)
            return "ok"
        except Exception as exc:
            logger.exception("agent.addToCart RPC error: %s", exc)
            return f"error: {exc}"

    ctx.room.local_participant.register_rpc_method(
        "agent.addToCart", handle_add_to_cart_rpc
    )

    async def handle_overlay_ack_rpc(rpc_data) -> str:
        # Minimal Ack logic for overlays
        return "ok"

    ctx.room.local_participant.register_rpc_method(
        "agent.overlayAck", handle_overlay_ack_rpc
    )

    # --- Start ---
    async def start_avatar_with_retry():
        for attempt in range(4):
            try:
                await avatar_session.start(session, room=ctx.room)
                return
            except Exception as e:
                logger.warning("[SIMLI] Failed to start avatar (attempt %d/4): %s", attempt + 1, e)
                if attempt == 3:
                    raise
                # Wait for Simli to finish cleaning up the previous session
                await asyncio.sleep(3.5)

    try:
        wait_for_guest = asyncio.create_task(ctx.wait_for_participant())
        avatar_ready = asyncio.create_task(start_avatar_with_retry())
        await asyncio.gather(wait_for_guest, avatar_ready)
    except Exception as exc:
        logger.error("[ENTRYPOINT] Critical failure starting avatar session: %s", exc)
        logger.error("This usually means Simli is down or at its concurrent session limit.")
        await ctx.room.disconnect()
        return

    logger.info(
        "[ENTRYPOINT] Guest connected and avatar ready, starting agent session. Language: %s",
        language,
    )

    agent = ScoopAgent(session_state, tools, language=language)

    await session.start(
        agent=agent,
        room=ctx.room,
        room_options=room_io.RoomOptions(
            audio_input=True,
            video_input=False,
        ),
    )

    async def session_timer() -> None:
        warned = False
        try:
            while True:
                remaining_seconds = max(
                    0,
                    int((session_deadline_at_ms - (datetime.now().timestamp() * 1000)) / 1000),
                )

                if remaining_seconds == 0:
                    break

                if not warned and remaining_seconds <= warning_seconds:
                    warned = True
                    warning_minutes = max(1, warning_seconds // 60)
                    warning_unit = "minute" if warning_minutes == 1 else "minutes"
                    await session.generate_reply(
                        instructions=(
                            f"Inform the user that the kiosk session will end in "
                            f"{warning_minutes} {warning_unit} and they should complete "
                            "their order or ask any final question now."
                        )
                    )

                await asyncio.sleep(min(5, max(1, remaining_seconds)))

            await session.generate_reply(
                instructions=(
                    f"Politely tell the user the {session_limit_minutes} minute kiosk "
                    "session has ended, thank them, and say goodbye."
                )
            )
            await tools.end_call()
            await session.close()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("[SESSION] Timer shutdown flow failed: %s", exc)

    asyncio.create_task(session_timer())


# ===============
# Request Handler
# ===============
async def request_fnc(req: JobRequest) -> None:
    config = CONFIG
    agent_identity = config.agent_identity(req.id)
    controller_identity = config.controller_identity(req.id)
    metadata = config.agent_metadata(agent_identity)
    attributes = {**metadata, "agentControllerIdentity": controller_identity}
    logger.info(
        "[REQUEST] Accepting job | job_id=%s | agent_identity=%s | controller_identity=%s",
        req.id,
        agent_identity,
        controller_identity,
    )
    await req.accept(
        name=config.agent_name,
        identity=controller_identity,
        metadata=json.dumps(metadata),
        attributes=attributes,
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
