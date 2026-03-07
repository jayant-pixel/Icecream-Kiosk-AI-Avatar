"""
Baskin Robbins Avatar Agent
---------------------------
LiveKit Agents 1.3.x  |  Deepgram STT  |  OpenAI LLM  |  Cartesia TTS  |  Simli Avatar
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import sys
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from dotenv import load_dotenv

# TOML: built-in on 3.11+, else tomli
if sys.version_info >= (3, 11):
    import tomllib
else:
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ImportError:
        raise ImportError("Python < 3.11 requires 'tomli': pip install tomli")

from livekit.agents import Agent, AgentSession, JobContext, JobRequest, WorkerOptions, WorkerType, cli
from livekit.agents.llm import function_tool
from livekit.agents.voice.room_io import RoomInputOptions
from livekit.plugins import cartesia, deepgram, openai as lk_openai, silero, simli
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from kb import SCOOP_KB

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logger = logging.getLogger("baskin-avatar-agent")
logger.setLevel(logging.INFO)

load_dotenv(dotenv_path=Path(__file__).resolve().with_name(".env"))

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
OVERLAY_TOPIC = "ui.overlay"
CATEGORY_FALLBACK = "Highlights"
VAT_RATE = Decimal("0.05")

# ---------------------------------------------------------------------------
# Environment validation  (single, authoritative check)
# ---------------------------------------------------------------------------
_REQUIRED_ENV = [
    "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
    "OPENAI_API_KEY", "DEEPGRAM_API_KEY", "CARTESIA_API_KEY", "SIMLI_API_KEY",
]


def _validate_env() -> None:
    missing = [v for v in _REQUIRED_ENV if not os.getenv(v)]
    if missing:
        raise RuntimeError(f"Missing env vars: {', '.join(missing)}")


_validate_env()

# ---------------------------------------------------------------------------
# Token helpers  (module-level, reused everywhere)
# ---------------------------------------------------------------------------

def _normalize(value: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def _tokenize(value: Optional[str]) -> set[str]:
    tokens: set[str] = set()
    for raw in re.split(r"[^a-z0-9]+", (value or "").lower()):
        t = raw.strip()
        if t:
            tokens.add(t)
            if t.endswith("s") and len(t) > 1:
                tokens.add(t[:-1])
    return tokens


def _label_tokens(value: Optional[str]) -> set[str]:
    tokens = _tokenize(value)
    n = _normalize(value)
    if n:
        tokens.add(n)
        if n.endswith("s") and len(n) > 1:
            tokens.add(n[:-1])
    return tokens

# ---------------------------------------------------------------------------
# Serialisation helper  (converts Decimal → float recursively, once)
# ---------------------------------------------------------------------------

def _clean(data: Any) -> Any:
    """Recursively convert Decimal to float so JSON serialisation is safe."""
    if isinstance(data, Decimal):
        return float(data)
    if isinstance(data, dict):
        return {k: _clean(v) for k, v in data.items()}
    if isinstance(data, list):
        return [_clean(v) for v in data]
    return data

# ---------------------------------------------------------------------------
# Time-of-day greeting helpers
# ---------------------------------------------------------------------------

def _greeting(arabic: bool = False) -> str:
    h = datetime.now().hour
    if arabic:
        if 5 <= h < 12:
            return "صباح الخير"
        return "مساء الخير" if h < 17 else "مساء النور"
    if 5 <= h < 12:
        return "Good morning"
    return "Good afternoon" if h < 17 else "Good evening"

# ---------------------------------------------------------------------------
# Prompt loader  (loads & caches personal.toml once)
# ---------------------------------------------------------------------------
_TOML_PATH = Path(__file__).resolve().with_name("personal.toml")
_PROMPT_CACHE: Dict[str, Dict[str, str]] = {}


def _load_prompt(language: str = "english") -> Tuple[str, str]:
    global _PROMPT_CACHE
    if not _PROMPT_CACHE:
        with open(_TOML_PATH, "rb") as fh:
            _PROMPT_CACHE = tomllib.load(fh)
        logger.info("[PROMPT] Loaded personal.toml: %s", list(_PROMPT_CACHE))
    lang = language.lower().strip()
    if lang not in _PROMPT_CACHE:
        logger.warning("[PROMPT] Language '%s' not found, falling back to english", lang)
        lang = "english"
    s = _PROMPT_CACHE[lang]
    return s["prompt"], s["voice_id"]

# ---------------------------------------------------------------------------
# Session state  (lightweight context carried across turns)
# ---------------------------------------------------------------------------

@dataclass
class SessionState:
    guest_name: Optional[str] = None
    last_overlay_kind: Optional[str] = None
    overlay_history: List[str] = field(default_factory=list)
    current_product_id: Optional[str] = None

    def describe(self) -> str:
        history = ", ".join(self.overlay_history[-4:]) or "none"
        return (
            f"Guest: {self.guest_name or 'unknown'}. "
            f"Last overlay: {self.last_overlay_kind or 'none'}. "
            f"History: {history}. "
            f"Active product: {self.current_product_id or 'none'}."
        )

# ---------------------------------------------------------------------------
# Agent config  (single source of truth for all env vars)
# ---------------------------------------------------------------------------

class AgentConfig:
    def __init__(self) -> None:
        self.livekit_url = os.environ["LIVEKIT_URL"]
        self.livekit_api_key = os.environ["LIVEKIT_API_KEY"]
        self.livekit_api_secret = os.environ["LIVEKIT_API_SECRET"]
        self.agent_name = os.getenv("LIVEKIT_AGENT_NAME", "baskin-avatar")
        self.agent_identity_prefix = (
            os.getenv("LIVEKIT_AGENT_IDENTITY_PREFIX", self.agent_name)
            .strip().lower().replace(" ", "-")
        )
        self.openai_api_key = os.environ["OPENAI_API_KEY"]
        self.openai_model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini-2025-04-14")
        self.deepgram_api_key = os.environ["DEEPGRAM_API_KEY"]
        self.cartesia_api_key = os.environ["CARTESIA_API_KEY"]
        self.simli_api_key = os.environ["SIMLI_API_KEY"]
        self.simli_face_id = os.getenv("SIMLI_FACE_ID", "cace3ef7-a4c4-425d-a8cf-a5358eb0c427")

    def agent_identity(self, job_id: Optional[str]) -> str:
        suffix = (job_id or secrets.token_hex(3))[-6:]
        return f"{self.agent_identity_prefix}-{suffix}"

    def controller_identity(self, job_id: Optional[str]) -> str:
        return f"{self.agent_identity(job_id)}-ctrl"

    def agent_metadata(self, agent_identity: str) -> Dict[str, str]:
        return {
            "role": "agent",
            "agentName": self.agent_name,
            "avatarId": self.simli_face_id,
            "agentType": "avatar",
            "agentIdentity": agent_identity,
        }


CONFIG = AgentConfig()

# ---------------------------------------------------------------------------
# UI communication helpers
# ---------------------------------------------------------------------------

async def _publish_overlay(room: Any, kind: str, data: Dict[str, Any]) -> None:
    """Publish a UI overlay via LiveKit data packet."""
    lp = getattr(room, "local_participant", None)
    if not lp:
        logger.warning("[OVERLAY] No local_participant, skipping kind=%s", kind)
        return
    msg = json.dumps({"type": "ui.overlay", "payload": {"kind": kind, **_clean(data)}}).encode()
    try:
        await lp.publish_data(msg, topic=OVERLAY_TOPIC)
    except Exception:
        logger.exception("[OVERLAY] publish failed kind=%s", kind)


async def _rpc(room: Any, method: str, payload: Dict[str, Any]) -> Optional[str]:
    """
    Send an RPC to the first guest participant in the room.
    Returns the raw response string, or None on failure.
    """
    lp = getattr(room, "local_participant", None)
    if not lp:
        logger.error("[RPC] No local_participant for method=%s", method)
        return None

    # Collect guest identities (exclude self)
    local_id = getattr(lp, "identity", None)
    destinations = [
        identity
        for p in room.remote_participants.values()
        if (identity := getattr(p, "identity", None))
        and identity != local_id
        and (
            identity.startswith("guest")
            or (getattr(p, "attributes", {}) or {}).get("role") == "guest"
        )
    ]
    if not destinations:
        logger.warning("[RPC] No guest found for method=%s", method)
        return None

    dest = destinations[0]
    try:
        resp = await lp.perform_rpc(
            destination_identity=dest,
            method=method,
            payload=json.dumps(_clean(payload)),
            response_timeout=2.0,
        )
        logger.debug("[RPC] %s → %s ok", method, dest)
        return resp
    except Exception:
        logger.error("[RPC] %s → %s failed", method, dest, exc_info=True)
        return None

# ---------------------------------------------------------------------------
# ScoopTools  (all agent function_tools)
# ---------------------------------------------------------------------------

class ScoopTools:
    """Encapsulates all tools available to the avatar agent."""

    SIZE_ALIAS = {"small": "Kids", "value": "Value", "big": "Emlaaq", "large": "Emlaaq"}

    def __init__(
        self,
        config: AgentConfig,
        session: AgentSession,
        room: Any,
        session_state: SessionState,
    ) -> None:
        self._config = config
        self._session = session
        self._room = room
        self._state = session_state

        # Knowledge base slices
        self._kb = SCOOP_KB
        self._products: Dict[str, Dict[str, Any]] = self._kb["products"]
        self._product_order: List[str] = [
            pid for pid in self._kb.get("product_order", []) if pid in self._products
        ]
        # Flavors/toppings keyed by id for O(1) lookup
        self._flavors: Dict[str, Dict[str, Any]] = {f["id"]: f for f in self._kb.get("flavors", [])}
        self._toppings: Dict[str, Dict[str, Any]] = {t["id"]: t for t in self._kb.get("toppings", [])}

        # Per-session order state
        self._line_state: Dict[str, Dict[str, Any]] = {}
        self._cart_items: List[Dict[str, Any]] = []
        self._cart_summary: Dict[str, Any] = {}
        self._active_product_id: Optional[str] = None

        # Pre-computed token caches for fast fuzzy matching
        self._product_tokens: Dict[str, set[str]] = {}
        self._flavor_tokens: Dict[str, set[str]] = {}
        self._topping_tokens: Dict[str, set[str]] = {}

        # Extra flavor price (0 if policy disallows extras — kept for pricing integrity)
        fp = self._kb.get("flavor_policy", {}).get("defaultFlavorPriceAED", 0.0)
        self._extra_flavor_price = Decimal(str(fp))

    # ------------------------------------------------------------------
    # Internal: token caches
    # ------------------------------------------------------------------

    def _product_token_set(self, pid: str) -> set[str]:
        if pid not in self._product_tokens:
            p = self._products[pid]
            tokens = _label_tokens(p.get("name")) | _label_tokens(p.get("category")) | _label_tokens(p.get("size"))
            cat = (p.get("category") or "").lower()
            if "milk" in cat or "shake" in cat:
                tokens.update({"shake", "milkshake", "milkshakes"})
            if "sundae" in cat:
                tokens.add("sundae")
            if "cup" in cat:
                tokens.add("cup")
            self._product_tokens[pid] = tokens
        return self._product_tokens[pid]

    def _flavor_token_set(self, fid: str) -> set[str]:
        if fid not in self._flavor_tokens:
            self._flavor_tokens[fid] = _label_tokens(self._flavors[fid].get("name"))
        return self._flavor_tokens[fid]

    def _topping_token_set(self, tid: str) -> set[str]:
        if tid not in self._topping_tokens:
            self._topping_tokens[tid] = _label_tokens(self._toppings[tid].get("name"))
        return self._topping_tokens[tid]

    # ------------------------------------------------------------------
    # Internal: resolvers
    # ------------------------------------------------------------------

    def _resolve_product(self, product_id: Optional[str], query: Optional[str]) -> Optional[Dict[str, Any]]:
        if product_id:
            return self._products.get(product_id)
        if not query:
            return None
        q = query.lower()
        # Fast substring match
        for p in self._products.values():
            if q in (p.get("name") or "").lower():
                return p
        # Token-based match
        q_tokens = _label_tokens(query)
        if not q_tokens:
            return None
        best_pid, best_score = None, 0
        for pid in self._product_order:
            score = len(self._product_token_set(pid) & q_tokens)
            if score > best_score:
                best_score, best_pid = score, pid
        return self._products.get(best_pid) if best_pid and best_score > 0 else None

    def _resolve_flavor(self, ref: str) -> Optional[Dict[str, Any]]:
        # Direct id / exact name
        if ref in self._flavors:
            return self._flavors[ref]
        for f in self._flavors.values():
            if f["name"].lower() == ref.lower():
                return f
        # Token match
        ref_tokens = _label_tokens(ref)
        if not ref_tokens:
            return None
        best_fid, best_score = None, 0
        for fid in self._flavors:
            score = len(self._flavor_token_set(fid) & ref_tokens)
            if score > best_score:
                best_score, best_fid = score, fid
        return self._flavors.get(best_fid) if best_fid and best_score > 0 else None

    def _resolve_topping(self, ref: str) -> Optional[Dict[str, Any]]:
        if ref in self._toppings:
            return self._toppings[ref]
        for t in self._toppings.values():
            if t["name"].lower() == ref.lower():
                return t
        ref_tokens = _label_tokens(ref)
        if not ref_tokens:
            return None
        best_tid, best_score = None, 0
        for tid in self._toppings:
            score = len(self._topping_token_set(tid) & ref_tokens)
            if score > best_score:
                best_score, best_tid = score, tid
        return self._toppings.get(best_tid) if best_tid and best_score > 0 else None

    # ------------------------------------------------------------------
    # Internal: line state
    # ------------------------------------------------------------------

    def _line(self, product: Dict[str, Any]) -> Dict[str, Any]:
        pid = product["id"]
        if pid not in self._line_state:
            free_flavors = int(product.get("scoops") or 0)
            free_toppings = int(product.get("includedToppings") or 0)
            self._line_state[pid] = {
                "product": product,
                "flavors": [],
                "toppings": [],
                "flavor_summary": {
                    "free": free_flavors, "used": 0,
                    "remainingFree": free_flavors, "extraCount": 0, "charge": Decimal(0),
                },
                "topping_summary": {
                    "free": free_toppings, "used": 0,
                    "remainingFree": free_toppings, "extraCount": 0, "charge": Decimal(0),
                },
            }
        return self._line_state[pid]

    # ------------------------------------------------------------------
    # Internal: card formatters
    # ------------------------------------------------------------------

    def _product_card(self, p: Dict[str, Any]) -> Dict[str, Any]:
        price = p.get("priceAED")
        card: Dict[str, Any] = {
            "id": p.get("id"),
            "name": p.get("name"),
            "category": p.get("category") or CATEGORY_FALLBACK,
            "size": p.get("size"),
            "scoops": p.get("scoops"),
            "priceAED": round(float(price), 2) if price is not None else None,
            "imageUrl": p.get("imageUrl") or self._kb["image_defaults"]["square"],
            "display": self._canonical_display(p.get("display")),
            "includedToppings": p.get("includedToppings"),
            "allowsFlavorSelection": self._allows_flavors(p),
        }
        if p.get("category") == "Cakes":
            card.update(serves=p.get("serves"), cakeBaseFlavor=p.get("cakeBaseFlavor"),
                        allowCakeMessage=p.get("allowCakeMessage", False))
        return card

    def _flavor_card(self, f: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": f["id"], "name": f["name"],
            "classification": f.get("classification"),
            "imageUrl": f.get("imageUrl") or self._kb["image_defaults"]["square"],
            "dietary": f.get("dietary", []),
            "available": bool(f.get("available")),
        }

    def _topping_card(self, t: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": t["id"], "name": t["name"],
            "priceAED": round(float(t.get("priceAED") or 0.0), 2),
            "imageUrl": t.get("imageUrl") or self._kb["image_defaults"]["square"],
            "dietary": t.get("dietary", []),
        }

    # ------------------------------------------------------------------
    # Internal: misc helpers
    # ------------------------------------------------------------------

    def _allows_flavors(self, product: Optional[Dict[str, Any]]) -> bool:
        if not product:
            return False
        if "allowFlavorSelection" in product:
            return bool(product["allowFlavorSelection"])
        return bool(product.get("scoops"))

    def _canonical_display(self, raw: Optional[str]) -> Optional[str]:
        if not raw:
            return None
        displays = self._kb.get("displays", {})
        if raw in displays:
            return displays[raw].get("displayName") or raw
        for rec in displays.values():
            if rec.get("displayName") == raw:
                return rec["displayName"]
        return raw

    def _catalog_context(self) -> str:
        lines = ["# Product Cheat Sheet"]
        for pid in self._product_order:
            p = self._products.get(pid)
            if p:
                lines.append(f"- {p.get('name')} ({p.get('priceAED')} AED)")
        return "\n".join(lines)

    def _sundae_upgrade(self, product: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if product.get("category") != "Cups":
            return None
        size, scoops = product.get("size"), product.get("scoops")
        for p in self._products.values():
            if (p.get("category") == "Sundae Cups" and p.get("size") == size
                    and p.get("scoops") == scoops and p.get("available", True)):
                return p
        return None

    def _suggest_flavor(self, exclude_ids: set[str]) -> Optional[Dict[str, Any]]:
        for f in self._flavors.values():
            if f["id"] not in exclude_ids and f.get("available"):
                return f
        return None

    def _suggest_premium_topping(
        self, exclude_ids: set[str], current_flavors: List[Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        flavor_names = " ".join(f.get("name", "") for f in current_flavors).lower()

        def score(t: Dict[str, Any]) -> int:
            name = (t.get("name") or "").lower()
            s = 3 if float(t.get("priceAED") or 0) >= 6 else 0
            if "choco" in flavor_names:
                s += 3 if any(k in name for k in ["choco", "fudge", "nutella", "kitkat", "brownie"]) else 0
            if any(k in flavor_names for k in ["berry", "strawberry"]):
                s += 3 if any(k in name for k in ["berry", "strawberry", "rasp"]) else 0
            if any(k in flavor_names for k in ["vanilla", "classic", "coffee"]):
                s += 2 if any(k in name for k in ["almond", "pistachio", "caramel", "sprinkle"]) else 0
            return s

        candidates = [
            (score(t), t) for t in self._toppings.values()
            if t["id"] not in exclude_ids and t.get("available", True)
        ]
        return max(candidates, key=lambda x: x[0])[1] if candidates else None

    # ------------------------------------------------------------------
    # Internal: overlay + rpc shortcut (used by every tool)
    # ------------------------------------------------------------------

    async def _emit(self, kind: str, data: Dict[str, Any], rpc_method: Optional[str] = None,
                    rpc_payload: Optional[Dict[str, Any]] = None) -> Optional[str]:
        """Publish overlay and optionally send RPC. Returns parsed RPC response or None."""
        # Update session state
        self._state.last_overlay_kind = kind
        h = self._state.overlay_history
        h.append(kind)
        if len(h) > 10:
            del h[0]

        await _publish_overlay(self._room, kind, data)

        if rpc_method is not None:
            return await _rpc(self._room, rpc_method, rpc_payload or {})
        return None

    def _detail_overlay_data(self, product: Dict[str, Any], line: Dict[str, Any]) -> Dict[str, Any]:
        """Build the detail card payload (shared between list_menu, choose_flavors, choose_toppings)."""
        flavors = line["flavors"]
        toppings = line["toppings"]
        fs = line["flavor_summary"]
        ts = line["topping_summary"]
        free_f = int(fs["free"])

        sel_flavors = [
            {**self._flavor_card(f), "isExtra": idx >= free_f}
            for idx, f in enumerate(flavors)
        ]
        free_t = int(ts["free"])
        sel_toppings = [
            {**self._topping_card(t), "isFree": idx < free_t}
            for idx, t in enumerate(toppings)
        ]
        return {
            "view": "detail",
            "product": self._product_card(product),
            "selectedFlavors": _clean(sel_flavors),
            "selectedToppings": _clean(sel_toppings),
            "flavorSummary": _clean(fs),
            "toppingSummary": _clean(ts),
            "contextProductId": product["id"],
            "cartSummary": self._cart_summary or None,
        }

    # ==================================================================
    # TOOLS
    # ==================================================================

    @function_tool(name="list_menu", description="Render menu overlays. kind='products'|'flavors'|'toppings'.")
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
        kind = (kind or "").strip().lower()

        # ── PRODUCTS ───────────────────────────────────────────────────
        if kind == "products":
            view_mode = view or "grid"
            target: Optional[Dict[str, Any]] = None

            if view_mode == "detail" or product_id:
                target = self._resolve_product(product_id, None) if product_id else \
                         self._resolve_product(None, query) if query else \
                         self._products.get(self._active_product_id) if self._active_product_id else None

                # Quick-order: require verbal confirmation first
                if query and not product_id and not confirmed and target:
                    return _clean({
                        "status": "needs_confirmation",
                        "productId": target["id"],
                        "productName": target["name"],
                        "agentNote": "Confirm the item with the guest before showing the detail card.",
                    })

                if target:
                    self._active_product_id = target["id"]
                    self._state.current_product_id = target["id"]
                    line = self._line(target)
                    payload = {"kind": "products", **self._detail_overlay_data(target, line)}
                    view_mode = "detail"
                else:
                    view_mode = "grid"

            if view_mode == "grid":
                prods = [
                    self._product_card(p) for p in self._products.values()
                    if not category or p.get("category") == category
                ]
                payload = {"kind": "products", "view": "grid", "products": prods,
                           "category": category or "All", "size": size, "query": query,
                           "cartSummary": self._cart_summary or None}

            await self._emit(
                "products", payload,
                rpc_method="client.menuLoaded",
                rpc_payload={"view": view_mode,
                              "category": category or "All",
                              "productId": target["id"] if target else None,
                              "productName": target["name"] if target else None},
            )
            return _clean(payload)

        # ── FLAVORS / TOPPINGS ─────────────────────────────────────────
        if kind in ("flavors", "toppings"):
            pid = product_id or self._active_product_id
            product = self._products.get(pid) if pid else None
            line = self._line(product) if product else None

            if kind == "flavors":
                if not product or not self._allows_flavors(product):
                    return _clean({
                        "error": "flavor_selection_not_available",
                        "productId": pid,
                        "agentNote": "Flavor selection is not available. Proceed to toppings.",
                    })
                fs = line["flavor_summary"]
                free_f = int(fs["free"])
                flavors_list = line["flavors"]
                sel_ids = [f["id"] for f in flavors_list]
                sel = [{**self._flavor_card(f), "isExtra": idx >= free_f} for idx, f in enumerate(flavors_list)]
                payload = {
                    "kind": "flavors", "productId": pid,
                    "productName": product["name"],
                    "freeFlavors": free_f,
                    "selectedFlavorIds": sel_ids, "selectedFlavors": sel,
                    "usedFreeFlavors": min(len(flavors_list), free_f),
                    "extraFlavorCount": max(0, len(flavors_list) - free_f),
                    "flavors": [self._flavor_card(f) for f in self._flavors.values()],
                }
            else:  # toppings
                free_t = int(product.get("includedToppings") or 0) if product else 0
                if line:
                    free_t = int(line["topping_summary"]["free"])
                toppings_list = line["toppings"] if line else []
                sel_ids = [t["id"] for t in toppings_list]
                sel = [{**self._topping_card(t), "isFree": idx < free_t} for idx, t in enumerate(toppings_list)]
                payload = {
                    "kind": "toppings", "productId": pid,
                    "productName": product["name"] if product else None,
                    "freeToppings": free_t,
                    "freeToppingsRemaining": max(0, free_t - len(toppings_list)),
                    "selectedToppingIds": sel_ids, "selectedToppings": sel,
                    "toppings": [self._topping_card(t) for t in self._toppings.values()],
                }

            await self._emit(kind, payload,
                             rpc_method=f"client.{kind}Loaded",
                             rpc_payload={"productId": pid})
            return _clean(payload)

        return {"error": "invalid kind"}

    @function_tool(name="choose_flavors", description="Attach selected flavors to product.")
    async def choose_flavors(self, product_id: str, flavor_ids: List[str]) -> Dict[str, Any]:
        self._active_product_id = product_id
        product = self._products.get(product_id)
        if not product:
            return {"error": f"Unknown product: {product_id}"}
        if not self._allows_flavors(product):
            return _clean({"status": "Flavor selection unavailable", "productId": product_id,
                           "agentNote": "Offer toppings instead; they are charged."})

        line = self._line(product)
        resolved = [f for ref in flavor_ids if (f := self._resolve_flavor(ref))]
        line["flavors"] = resolved

        fs = line["flavor_summary"]
        free = int(fs["free"])
        used = len(resolved)
        extra = max(0, used - free)
        charge = self._extra_flavor_price * Decimal(extra)
        fs.update(used=used, remainingFree=max(0, free - used), extraCount=extra, charge=charge)

        # Refresh UI detail card
        await self._emit("products", {"kind": "products", **self._detail_overlay_data(product, line)})

        # Upsell logic
        used_ids = {f["id"] for f in resolved}
        suggestion = self._suggest_flavor(used_ids)
        remaining = max(0, free - used)
        if suggestion and remaining > 0:
            upsell = f"You still have {remaining} free flavor slot(s). {suggestion['name']} would be a great addition — still free!"
        elif suggestion and remaining == 0:
            upsell = f"Slots full. Swap one for {suggestion['name']}?"
        else:
            upsell = None

        names = ", ".join(f["name"] for f in resolved) or "none"
        agent_note = (
            f"Added {used} flavor(s): {names}. "
            f"{remaining} free slot(s) remaining. Extra charge: {float(charge):.2f} dirham."
        )
        if upsell:
            agent_note += f" {upsell}"

        return _clean({
            "status": "Flavors updated", "productId": product_id,
            "flavors": [f["id"] for f in resolved],
            "flavorSummary": fs, "agentNote": agent_note,
        })

    @function_tool(name="choose_toppings", description="Attach selected toppings to product.")
    async def choose_toppings(self, product_id: str, topping_ids: List[str]) -> Dict[str, Any]:
        self._active_product_id = product_id
        product = self._products.get(product_id)
        if not product:
            return {"error": f"Unknown product: {product_id}"}

        line = self._line(product)
        resolved = [t for ref in topping_ids if (t := self._resolve_topping(ref))]
        line["toppings"] = resolved

        ts = line["topping_summary"]
        free = int(ts["free"])
        used = len(resolved)
        chargeable = resolved[free:]
        charge = sum(Decimal(str(t.get("priceAED", 0))) for t in chargeable)
        remaining = max(0, free - used)
        ts.update(used=used, remainingFree=remaining, extraCount=max(0, used - free), charge=charge)

        # Refresh UI
        await self._emit("products", {"kind": "products", **self._detail_overlay_data(product, line)})

        # Sundae Cup upgrade hint
        upgrade_hint = None
        if product.get("category") == "Cups" and used > free:
            sundae = self._sundae_upgrade(product)
            if sundae:
                diff = Decimal(str(sundae.get("priceAED", 0))) - Decimal(str(product.get("priceAED", 0)))
                upgrade_data = {
                    "kind": "upgrade", "show": True,
                    "fromProduct": _clean(self._product_card(product)),
                    "toProduct": {**_clean(self._product_card(sundae)),
                                  "headline": f"Upgrade to {sundae['name']}",
                                  "subline": "Toppings included with Sundae Cups."},
                    "priceDiffAED": _clean(diff), "savingsEstimateAED": _clean(charge),
                }
                await self._emit("upgrade", upgrade_data)
                upgrade_hint = (f"Upgrade to {sundae['name']} for {float(diff):.2f} dirham — "
                                "toppings become included.")

        # Topping upsell
        used_ids = {t["id"] for t in resolved}
        suggestion = self._suggest_premium_topping(used_ids, line["flavors"])
        topping_upsell = None
        if suggestion:
            topping_upsell = (
                f"{suggestion['name']} would go great! Add it free?" if remaining > 0
                else f"Swap one topping for {suggestion['name']}?"
            )

        names = ", ".join(t["name"] for t in resolved) or "none"
        agent_note = (
            f"Added {used} topping(s): {names}. "
            f"{remaining} free slot(s) remaining. Extra charge: {float(charge):.2f} dirham."
        )
        if upgrade_hint:
            agent_note += f" {upgrade_hint}"
        if topping_upsell:
            agent_note += f" {topping_upsell}"

        return _clean({
            "status": "Toppings updated", "productId": product_id,
            "toppings": [t["id"] for t in resolved],
            "toppingSummary": ts, "agentNote": agent_note,
            "upgradeHint": upgrade_hint, "toppingUpsellHint": topping_upsell,
        })

    @function_tool(name="add_to_cart", description="Finalize product and add to cart.")
    async def add_to_cart(self, product_id: str, qty: int = 1) -> Dict[str, Any]:
        product = self._products.get(product_id)
        if not product:
            return {"error": f"Unknown product: {product_id}"}
        qty = max(1, int(qty))
        line = self._line(product)

        base = Decimal(str(product.get("priceAED") or 0))
        fs = line["flavor_summary"]
        flavor_charge = Decimal(str(fs.get("charge", 0)))

        # Tag flavors
        free_f = int(fs.get("free", int(product.get("scoops") or 0)))
        tagged_flavors = []
        for idx, f in enumerate(line["flavors"]):
            is_extra = idx >= free_f
            unit_price = float(self._extra_flavor_price) if is_extra else 0.0
            tagged_flavors.append({
                **self._flavor_card(f),
                "isExtra": is_extra,
                "unitPriceAED": unit_price,
                "linePriceAED": unit_price * qty,
            })

        # Tag toppings
        incl = int(product.get("includedToppings") or 0)
        topping_charge = Decimal(0)
        tagged_toppings = []
        for idx, t in enumerate(line["toppings"]):
            is_free = idx < incl
            unit = 0.0 if is_free else float(t.get("priceAED") or 0.0)
            if not is_free:
                topping_charge += Decimal(str(unit))
            tagged_toppings.append({
                **self._topping_card(t),
                "isFree": is_free, "unitPriceAED": unit, "linePriceAED": unit * qty,
            })

        per_unit = base + flavor_charge + topping_charge
        line_sub = (per_unit * Decimal(qty)).quantize(Decimal("0.01"))
        line_tax = (line_sub * VAT_RATE).quantize(Decimal("0.01"))
        line_total = line_sub + line_tax

        cart_item = {
            "product_id": product_id, "name": product["name"],
            "category": product.get("category"), "size": product.get("size"),
            "imageUrl": product.get("imageUrl") or self._kb["image_defaults"]["square"],
            "qty": qty,
            "basePriceAED": _clean(base), "flavorExtrasAED": _clean(flavor_charge),
            "toppingExtrasAED": _clean(topping_charge), "unitSubTotalAED": _clean(per_unit),
            "unitTaxAED": _clean(per_unit * VAT_RATE),
            "lineSubTotalAED": _clean(line_sub), "lineTaxAED": _clean(line_tax),
            "lineTotalAED": _clean(line_total),
            "flavors": _clean(tagged_flavors), "toppings": _clean(tagged_toppings),
        }
        self._cart_items.append(cart_item)

        # Recalculate cart totals
        cart_sub = sum(Decimal(str(i["lineSubTotalAED"])) for i in self._cart_items)
        cart_tax = sum(Decimal(str(i["lineTaxAED"])) for i in self._cart_items)
        cart_total = cart_sub + cart_tax
        self._cart_summary = {
            "subTotalAED": _clean(cart_sub),
            "taxAED": _clean(cart_tax),
            "totalAED": _clean(cart_total),
        }

        cart_payload = {"items": self._cart_items, **self._cart_summary}
        await self._emit("cart", {"cart": cart_payload},
                         rpc_method="client.cartUpdated", rpc_payload={"cart": cart_payload})

        # Cart-level upsell
        cat = product.get("category", "")
        if cat in ("Cups", "Sundae Cups"):
            upsell = "Would you also like a milkshake to go with your ice cream?"
        elif cat == "Milk Shakes":
            upsell = "Would you like to add a Sundae Cup to pair with your shake?"
        else:
            upsell = None

        agent_note = (
            f"Added {qty} {product['name']} to your cart. "
            f"Total so far: {float(cart_total):.2f} dirham including tax."
        )
        if upsell:
            agent_note += f" {upsell}"

        return _clean({"cart": cart_payload, "agentNote": agent_note, "cartUpsellHint": upsell})

    @function_tool(name="get_directions", description="Show pickup directions to the correct counter.")
    async def get_directions(
        self,
        display_name: str,
        extra_displays: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        displays = self._kb.get("displays", {})

        def build(name: str) -> Dict[str, Any]:
            info = displays.get(name, {})
            return {
                "displayName": info.get("displayName", name),
                "hint": info.get("hint", "Please proceed to this counter."),
                "mapImage": info.get("mapImage"),
            }

        locations = [build(display_name)] + [build(e) for e in (extra_displays or [])]
        payload = {"locations": locations}

        await self._emit("directions", payload,
                         rpc_method="client.directions",
                         rpc_payload={"action": "show", "locations": locations})
        return _clean(payload)

# ---------------------------------------------------------------------------
# ScoopAgent
# ---------------------------------------------------------------------------

class ScoopAgent(Agent):
    def __init__(self, state: SessionState, tools: ScoopTools, language: str = "english") -> None:
        self._state = state
        self._tools = tools
        self._language = language
        prompt, _ = _load_prompt(language)
        instructions = (
            prompt
            .replace("{{CATALOG_CONTEXT}}", tools._catalog_context())
            .replace("{{SESSION_CONTEXT}}", state.describe())
        )
        super().__init__(
            instructions=instructions,
            tools=[
                tools.list_menu, tools.choose_flavors, tools.choose_toppings,
                tools.add_to_cart, tools.get_directions,
            ],
        )

    async def on_enter(self) -> None:
        logger.info("[AGENT] on_enter — sending greeting")
        try:
            tod = _greeting(arabic=self._language == "arabic")
            if self._language == "arabic":
                greeting = f"{tod}، يا هلا فيكم في باسكين روبنز، اسمي سارة. أتشرف، ويا منو أتكلم اليوم؟"
            else:
                greeting = f"{tod}, welcome to Baskin Robbins! My name is Sarah. May I know your name?"
            await self.session.say(greeting, allow_interruptions=True)
        except Exception:
            logger.exception("[AGENT] Failed to deliver greeting")

# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

async def entrypoint(ctx: JobContext) -> None:
    config = CONFIG
    job_id = ctx.job.id if ctx.job else None
    agent_identity = config.agent_identity(job_id)
    controller_identity = config.controller_identity(job_id)

    await ctx.connect()

    # Detect language from room metadata
    language = "english"
    try:
        raw_meta = ctx.room.metadata or ""
        if raw_meta:
            language = json.loads(raw_meta).get("language", "english").lower().strip()
    except (json.JSONDecodeError, AttributeError):
        logger.warning("[ENTRYPOINT] Could not parse room metadata, defaulting to english")

    _, voice_id = _load_prompt(language)
    logger.info("[ENTRYPOINT] job=%s | identity=%s | lang=%s | voice=%s",
                job_id, agent_identity, language, voice_id)

    # Pipeline components
    stt = deepgram.STT(
        model="nova-3",
        language="ar" if language == "arabic" else "en",
        api_key=config.deepgram_api_key,
    )
    vad = silero.VAD.load()
    llm = lk_openai.LLM(model=config.openai_model, api_key=config.openai_api_key)
    tts = cartesia.TTS(model="sonic-3", voice=voice_id, api_key=config.cartesia_api_key)
    turn_detector = MultilingualModel()

    session = AgentSession(
        stt=stt, vad=vad, llm=llm, tts=tts,
        turn_detection=turn_detector,
        min_endpointing_delay=0.5,
        max_endpointing_delay=3.0,
    )

    avatar_session = simli.AvatarSession(
        simli_config=simli.SimliConfig(api_key=config.simli_api_key, face_id=config.simli_face_id),
        avatar_participant_name=config.agent_name,
    )

    state = SessionState()
    tools = ScoopTools(config, session, ctx.room, state)

    # RPC handlers
    async def _handle_add_to_cart(rpc_data) -> str:
        try:
            payload = json.loads(rpc_data.payload or "{}")
            pid = payload.get("productId") or payload.get("product_id")
            if not pid:
                return "missing productId"
            await tools.add_to_cart(str(pid), int(payload.get("qty", 1)))
            return "ok"
        except Exception as exc:
            logger.exception("[RPC] agent.addToCart error")
            return f"error: {exc}"

    ctx.room.local_participant.register_rpc_method("agent.addToCart", _handle_add_to_cart)
    ctx.room.local_participant.register_rpc_method("agent.overlayAck", lambda _: "ok")

    # Start avatar and wait for guest in parallel
    await asyncio.gather(
        ctx.wait_for_participant(),
        avatar_session.start(session, room=ctx.room),
    )

    logger.info("[ENTRYPOINT] Guest connected, avatar ready. Starting agent session.")
    agent = ScoopAgent(state, tools, language=language)

    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(audio_enabled=True, video_enabled=False),
    )

# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------

async def request_fnc(req: JobRequest) -> None:
    config = CONFIG
    agent_identity = config.agent_identity(req.id)
    controller_identity = config.controller_identity(req.id)
    metadata = config.agent_metadata(agent_identity)
    logger.info("[REQUEST] job=%s | agent=%s | ctrl=%s", req.id, agent_identity, controller_identity)
    await req.accept(
        name=config.agent_name,
        identity=controller_identity,
        metadata=json.dumps(metadata),
        attributes={**metadata, "agentControllerIdentity": controller_identity},
    )

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        worker_type=WorkerType.ROOM,
        request_fnc=request_fnc,
        agent_name=CONFIG.agent_name,
    ))