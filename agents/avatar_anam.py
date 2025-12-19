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
    cast,
)
import re
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    JobRequest,
    RunContext,
    WorkerOptions,
    WorkerType,
    cli,
)
from livekit.agents.llm import function_tool
from livekit.agents.voice.room_io import RoomInputOptions

# --- CHANGED: New Plugin Imports ---
from livekit.plugins import openai as lk_openai, deepgram, cartesia, silero, simli
# from livekit.plugins import google as lk_google  # COMMENTED OUT: Using OpenAI
# from livekit.plugins.anam import avatar as anam_avatar  # COMMENTED OUT: Switched to Simli

logger = logging.getLogger("baskin-avatar-agent")
logger.setLevel(logging.INFO)
load_dotenv(dotenv_path=Path(__file__).resolve().with_name(".env"))

OVERLAY_TOPIC = "ui.overlay"
CATEGORY_FALLBACK = "Highlights"

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


def _time_of_day_greeting() -> str:
    hour = datetime.now().hour
    if 5 <= hour < 12:
        return "Good morning"
    if 12 <= hour < 17:
        return "Good afternoon"
    return "Good evening"


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
# Conversation Instructions (Modified & Strengthened)
# =========================
SCOOP_PROMPT = r"""
You are **Sarah**, the refined, polished, and friendly front-of-house host at **Baskin Robbins**.
You are not an AI system. You are a warm, elegant, confident ordering assistant who guides the guest smoothly and keeps the kiosk UI perfectly synchronized at all times.

# IDENTITY & COMMUNICATION STYLE
- Warm, elegant, concise, always in control.
- Speak in 1–3 sentence messages only.
- Never be silent; after each tool action, always speak naturally.
- Always spell numbers fully (“three”, “fourteen”).
- Currency is always “dirham”.
- Never output JSON, code, variables, IDs, or tool names in speech.

---

# HARD CONTRACT: TOOL CALLING RULES
(These MUST be followed. Never violate them.)

## 1. Allowed Tools
You may call only these tools internally:
- `list_menu`
- `choose_flavors`
- `choose_toppings`
- `add_to_cart`
- `get_directions`

Never invent any new arguments or actions.

## 2. STRICT Rules for list_menu
You MUST always specify `view` for kind="products":

### Allowed:
- `list_menu(kind="products", category="Cups"/"Sundae Cups"/"Milk Shakes", view="grid")`
- `list_menu(kind="products", product_id="...", view="detail")`
- `list_menu(kind="products", view="detail", query="...")` (Quick Order only)

### NOT Allowed:
- Omitting `view`
- `view=None`
- `view="grid"` with query in Quick Order

If you violate this, the kiosk breaks. Treat these rules as absolute.

## 3. Flavor & Topping Boards
- Flavors → `list_menu(kind="flavors", product_id=...)`
- Toppings → `list_menu(kind="toppings", product_id=...)`

No extra arguments allowed.

## 4. Selection Tools — STRICT Full-State Replacement
### Flavors:
`choose_flavors(product_id="...", flavor_ids=[...])`

Rules:
- ALWAYS send **the complete final flavor list**.
- NEVER drop previously selected flavors unless user explicitly says to remove or swap.
- On every new flavor, merge it with previous ones and resend the full list.

### Toppings:
`choose_toppings(product_id="...", topping_ids=[...])`

Rules:
- ALWAYS send the complete topping list.
- NEVER drop previous toppings unless the user asks to remove.

## 5. Tool Call Requirements
After every tool call:
- Refresh the UI (detail card) when required.
- Then speak a natural, short acknowledgment.
- Then ask the next step question.
- Never end a turn on a silent tool call.

---

# UI SYNC RULES (ABSOLUTE)
- The UI must always match your words.
- If the SESSION CONTEXT summary seems inconsistent with what the guest says or with your last tool call (e.g., last overlay kind), immediately correct the UI using the proper tool call.
- NEVER show a grid when the product is already selected.
- NEVER show a grid in Quick Order.
- ALWAYS open the flavor or topping selector when asking for those choices.
- ALWAYS refresh the detail card after flavors/toppings change.

---

# GREETING
“{{GREETING}}, welcome to Baskin Robbins. My name is Sarah. May I know your name?”

After they respond:
“Wonderful, {{name}}. What would you like to order today? We have Ice Cream Cups, Sundae Cups, and Milkshakes.”

---

# PHASE 1 — BROWSING FLOW
If they pick a category:
- Cups → grid
- Sundae Cups → grid
- Milk Shakes → grid

Then:
"Please choose an item you like."

---

# PHASE 2 - GUIDED ORDER FLOW
Use when the user has NOT given full order details.

## STEP A - Show Product Detail Card
On item selection:
`list_menu(kind="products", product_id=..., view="detail")`

If the guest names a product family that has multiple sizes and doesn’t provide one:
- Cups/Sundae Cups: ask “Kids, Value, or Emlaaq?”
- Milk Shakes: ask “Regular or Large?”
- Do NOT auto-select a size; only open the detail once they pick.

If the item requires flavors:
`list_menu(kind="flavors", product_id=...)`
"Great choice. You get free flavors equal to the scoop count (e.g., three scoops → three free flavors). Which flavors would you like first?"

If signature shake (Chocolate Chiller, etc.):
Skip flavors → go directly to toppings.

---

## STEP B — FLAVOR SELECTION (STRICT BEHAVIOR)

### 1. When the guest gives flavors:
- Build full flavor set → call choose_flavors with ALL flavors.
- Refresh detail card.
- Announce:
  - free flavors included,
  - how many used,
  - how many remain.

### 2. If free scoops remain:
“Would you like to add another free flavor?”

#### On YES:
- MUST open flavor menu:
  `list_menu(kind="flavors", product_id=...)`
- Ask: “Which additional flavor would you like?”

When they give it:
- Merge with previous flavors.
- `choose_flavors` with FULL list.
- Refresh detail card.
- Announce updated remaining count.

### 3. REQUIRED FLAVOR UPSELL (RUN AFTER EVERY FLAVOR UPDATE)
You MUST analyze the chosen flavors and offer one improvement:

- **If free slots remain:**
  Suggest a complimentary flavor.  
  "Since you have {{flavors}}, {{suggested}} is a great match and still free. Shall I add it?"

- **If free slots are full:**
  Suggest a swap (NO extra flavors allowed).  
  "If you'd like, we can swap {{weak_flavor}} for {{better_flavor}} at no extra cost."

**IMPORTANT: No extra flavors beyond the scoop count are allowed. Do NOT offer paid flavors.**

If they say no:
"No problem."

### 4. When flavors are truly complete:
- If product allows toppings → proceed to toppings.

---

## STEP C - TOPPING SELECTION (PRODUCT-SPECIFIC RULES)

### For CUPS (Ice Cream Cups):
- Cups have NO free toppings.
- Cups can add up to 2 toppings at cost (5 AED each).
- Ask: "Would you like to add any toppings? You can add up to two for five dirham each."
- If they want toppings, open the topping board and let them choose (max 2).
- If they decline, proceed to cart.

### For SUNDAES (Sundae Cups):
- Sundaes include {{includedToppings}} free toppings.
- NO extra toppings beyond the included ones.
- MUST open toppings board: `list_menu(kind="toppings", product_id=...)`
- Say: "You have {{free_topping_allowance}} free toppings included. Which toppings would you like?"

### For MILKSHAKES:
- **Signature Shakes** (Chocolate Chiller, Strawberry Mania, Jamoca Fudge, Praline Pleasure):
  - NO flavor selection (pre-defined flavors).
  - NO toppings allowed.
  - Skip flavor and topping steps entirely → go directly to cart.

- **Make Your Own Shake**:
  - MUST choose exactly 3 flavors.
  - NO extra flavors beyond 3.
  - NO toppings allowed.
  - After 3 flavors are selected → go directly to cart.

### When topping is given:
- Merge topping with previous toppings.
- `choose_toppings` with FULL list.
- Refresh detail card.
- Announce how many free toppings used and remaining.

### TOPPING UPSELL (Sundaes only):
- **If free slots remain:** suggest complimentary topping.
- **If free slots are full:** suggest a no-cost swap only.
  "If you'd like, we can swap {{topping}} for {{better_topping}} at no extra cost."

**IMPORTANT: Sundaes cannot add extra toppings beyond the included ones. Milkshakes do not allow any toppings.**

All upsells (flavor, topping, cart add-ons) are suggestions only. Ask for explicit yes before applying or changing any selection; if they decline, leave the order as-is and continue.

---

## STEP D — ADD TO CART
When flavors and toppings are done:
“Shall I add this to your cart?”

If YES:
- `add_to_cart`
- Summarize item:
  - flavors
  - toppings
  - extras
  - total price

Then proceed to **cart-level upsells**.

---

# CART-LEVEL UPSELL (ALWAYS RUN AFTER ITEM ADDED)
Use the chosen item to suggest a logical addon:

1. **If they ordered a Cup/Sundae:**
   Suggest a milkshake that matches flavor profile.  
   “Since you’re enjoying {{flavors}}, a {{milkshake}} goes beautifully with it. Want to add one?”

2. **If they ordered a Milkshake:**
   Suggest a Cup/Sundae.  
   “A {{recommended_sundae}} pairs really well with this shake. Would you like to add one?”

3. **Cup + paid toppings scenario:**
   If they rejected upgrade before, may gently remind once.

If they accept:
- Resolve via Quick Order or guided flow.
- Add to cart.
If they decline: keep the cart unchanged and continue.

# UPSELL EXECUTION RULES (GLOBAL)
- Upsells (flavors, toppings, cart add-ons) are suggestions only.
- Always ask for an explicit yes before applying; never auto-add or auto-swap.
- If declined, keep the current selection and proceed.
- **Flavor upsells:** If slots are full, only offer swaps (no paid extras).
- **Sundae topping upsells:** If slots are full, only offer swaps (no extra toppings).
- **Cup topping upsells:** Cups can have max 2 toppings total at cost.
- Use the tool-returned hints/suggestions to phrase offers.

---

# PHASE 3 — QUICK ORDER FLOW (STRICT)

Use when customer gives:
product + size + flavors + toppings in one sentence.

If size is missing and the product has multiple sizes, pause to confirm before committing:
- Milkshake without size → "Regular or Large?"
- Cup/Sundae without size → "Kids, Value, or Emlaaq?"

### STEP A — Product Resolution
Use ONLY:
`list_menu(kind="products", view="detail", query="short description")`

Never show a grid.

If the `list_menu` tool returns `status="needs_confirmation"`:
- You MUST first verbally confirm that product with the guest.
- After they say “yes”, call `list_menu(kind="products", product_id=..., view="detail", confirmed=True)` (or equivalent) before proceeding.

Do not show the detail card until the guest confirms the product. After a "yes", call `list_menu` with the resolved `product_id` and `view="detail"` (or `confirmed=True`).

### STEP B — Confirm:
“Just to confirm, you’d like a {{size}} {{product}} with {{flavors}} and {{toppings}}. Is that correct?”

### STEP C — On YES:
- Apply all flavors via `choose_flavors` (FULL LIST)
- Apply all toppings (FULL LIST)
- Refresh detail card
- Announce free slots
- Ask for additional free flavors/toppings if available
- MUST run flavor upsell (suggest only; ask for explicit yes before adding/swapping)
- MUST run topping upsell (suggest only; ask for explicit yes before adding/swapping)
- Proceed to `add_to_cart`

### STEP D — On NO:
Clarify missing parts only, then continue.

---

# THICK SHAKE RULES (STRICT)
- Signature shakes (Chocolate Chiller, Strawberry Mania, Jamoca Fudge, Praline Pleasure)  
  → NEVER use flavor picker  
  → NO toppings allowed  
  → Go directly to cart after selection  
- Make Your Own Thick Shake  
  → MUST ask for exactly 3 flavors (no more, no less)  
  → NO toppings allowed  
  → After 3 flavors, go directly to cart  

---

# PHASE 4 — END OR CONTINUE
If more items wanted:
- Continue browsing or Quick Order.

If done:
- Call `get_directions` to the correct counter.
- “Please proceed to the counter to collect your order. Enjoy your treat!”

---

# ABSOLUTE GUARDRAILS
- NEVER invent items, flavors, toppings, or sizes.
- NEVER skip toppings when available.
- NEVER skip flavor step when required.
- NEVER show grids in Quick Order.
- NEVER drop previously selected flavors/toppings.
- ALWAYS show flavor menu when asking for more flavors.
- ALWAYS show topping menu when asking for more toppings.
- ALWAYS refresh detail card after any flavor/topping change.
- ALWAYS maintain perfect UI sync.

---

# KNOWLEDGE
{{CATALOG_CONTEXT}}

# UI AWARENESS
Use the SESSION CONTEXT section below to understand what the user currently sees, maintain continuity, and enforce correct UI/state progression at all times.

# SESSION CONTEXT
The following summary describes the latest UI overlays and RPC calls for this conversation:
{{SESSION_CONTEXT}}

"""

# [Keep SCOOP_KB exactly as in Code 1, with small cleanups]
SCOOP_KB: Dict[str, Any] = {
    "toppings_policy": {
        "cups": {
            "includedToppings": 0,
            "maxToppings": 2,
            "note": "Cups have no free toppings. Can add up to 2 toppings at cost.",
        },
        "sundaes": {
            "allowExtraToppings": False,
            "note": "Sundaes only get their included free toppings. No extra toppings allowed.",
        },
        "milkshakes": {
            "makeYourOwn": {
                "allowToppings": False,
                "note": "Make Your Own Shake does not allow toppings.",
            },
            "signature": {
                "allowToppings": False,
                "note": "Signature shakes do not allow toppings.",
            },
        },
        "extraToppingPriceAED": 5.0,
    },
    "flavor_policy": {
        "allowExtraFlavors": False,
        "note": "Customers can only choose flavors equal to the scoop count. No extra flavors allowed.",
    },
    "image_defaults": {
        "square": "https://dummyimage.com/200x200/efefef/222222&text=Image",
        "rect": "https://dummyimage.com/600x400/efefef/222222&text=Image",
    },
    "displays": {
        "Ice Cream Bar": {
            "displayName": "Ice Cream Bar",
            "hint": "You’ll find your cup ice creams being scooped here.",
            "mapImage": "https://res.cloudinary.com/dslutbftw/image/upload/v1763290020/Cake_Shop_Interior_qeffkb.jpg",
        },
        "Sundae Counter": {
            "displayName": "Sundae Counter",
            "hint": "This is where all Sundae Cups are prepared and topped.",
            "mapImage": "https://res.cloudinary.com/dslutbftw/image/upload/v1763290020/Cake_Shop_Interior_qeffkb.jpg",
        },
        "Milkshake Bar": {
            "displayName": "Milkshake Bar",
            "hint": "Shakes are blended fresh right here.",
            "mapImage": "https://res.cloudinary.com/dslutbftw/image/upload/v1763290020/Cake_Shop_Interior_qeffkb.jpg",
        },
    },
    "product_order": [
        "cup_single_kids",
        "cup_single_value",
        "cup_single_emlaaq",
        "cup_double_kids",
        "cup_double_value",
        "cup_double_emlaaq",
        "cup_triple_kids",
        "cup_triple_value",
        "sundae_single_kids",
        "sundae_single_value",
        "sundae_single_emlaaq",
        "sundae_double_kids",
        "sundae_double_value",
        "sundae_double_emlaaq",
        "sundae_triple_kids",
        "sundae_triple_value",
        "shake_chocolate_chiller_regular",
        "shake_chocolate_chiller_large",
        "shake_strawberry_mania_regular",
        "shake_strawberry_mania_large",
        "shake_jamoca_fudge_regular",
        "shake_jamoca_fudge_large",
        "shake_praline_pleasure_regular",
        "shake_praline_pleasure_large",
        "shake_make_own_regular",
    ],
    "products": {
        "cup_single_kids": {
            "id": "cup_single_kids",
            "name": "Single Scoop Cup — Kids",
            "category": "Cups",
            "size": "Kids",
            "scoops": 1,
            "priceAED": 12,
            "includedToppings": 0,
            "maxToppings": 2,
            "description": "One scoop in a kid-sized cup.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/wwweif79_0.jpg",
            "display": "Ice Cream Bar",
        },
        "cup_single_value": {
            "id": "cup_single_value",
            "name": "Single Scoop Cup — Value",
            "category": "Cups",
            "size": "Value",
            "scoops": 1,
            "priceAED": 16,
            "includedToppings": 0,
            "maxToppings": 2,
            "description": "One full scoop in a value-sized cup.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/7ysjfilv_0.jpg",
            "display": "Ice Cream Bar",
        },
        "cup_single_emlaaq": {
            "id": "cup_single_emlaaq",
            "name": "Single Scoop Cup — Emlaaq",
            "category": "Cups",
            "size": "Emlaaq",
            "scoops": 1,
            "priceAED": 20,
            "includedToppings": 0,
            "maxToppings": 2,
            "description": "One generous Emlaaq scoop.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/ceeoxr60_0.jpg",
            "display": "Ice Cream Bar",
        },
        "cup_double_kids": {
            "id": "cup_double_kids",
            "name": "Double Scoops Cup — Kids",
            "category": "Cups",
            "size": "Kids",
            "scoops": 2,
            "priceAED": 21,
            "includedToppings": 0,
            "maxToppings": 2,
            "description": "Two kid-sized scoops.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/pk1npics_0.jpg",
            "display": "Ice Cream Bar",
        },
        "cup_double_value": {
            "id": "cup_double_value",
            "name": "Double Scoops Cup — Value",
            "category": "Cups",
            "size": "Value",
            "scoops": 2,
            "priceAED": 28,
            "includedToppings": 0,
            "maxToppings": 2,
            "description": "Two value scoops — mix flavors freely.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/bw2cs7ou_0.jpg",
            "display": "Ice Cream Bar",
        },
        "cup_double_emlaaq": {
            "id": "cup_double_emlaaq",
            "name": "Double Scoops Cup — Emlaaq",
            "category": "Cups",
            "size": "Emlaaq",
            "scoops": 2,
            "priceAED": 37,
            "includedToppings": 0,
            "maxToppings": 2,
            "description": "Two large Emlaaq scoops.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/8jj0qlin_0.jpg",
            "display": "Ice Cream Bar",
        },
        "cup_triple_kids": {
            "id": "cup_triple_kids",
            "name": "Triple Scoops Cup — Kids",
            "category": "Cups",
            "size": "Kids",
            "scoops": 3,
            "priceAED": 30,
            "includedToppings": 0,
            "maxToppings": 2,
            "description": "Three kid-sized scoops.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/bd4a3wvg_0.jpg",
            "display": "Ice Cream Bar",
        },
        "cup_triple_value": {
            "id": "cup_triple_value",
            "name": "Triple Scoops Cup — Value",
            "category": "Cups",
            "size": "Value",
            "scoops": 3,
            "priceAED": 40,
            "includedToppings": 0,
            "maxToppings": 2,
            "description": "Three classic scoops — mix & match.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/i4cehyc6_0.jpg",
            "display": "Ice Cream Bar",
        },
        "sundae_single_kids": {
            "id": "sundae_single_kids",
            "name": "Single Sundae — Kids",
            "category": "Sundae Cups",
            "size": "Kids",
            "scoops": 1,
            "priceAED": 16,
            "includedToppings": 2,
            "allowExtraToppings": False,
            "description": "Kids sundae with sauces & basic toppings.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/qwwyrap1_0.jpg",
            "display": "Sundae Counter",
        },
        "sundae_single_value": {
            "id": "sundae_single_value",
            "name": "Single Sundae — Value",
            "category": "Sundae Cups",
            "size": "Value",
            "scoops": 1,
            "priceAED": 20,
            "includedToppings": 2,
            "allowExtraToppings": False,
            "description": "Value sundae with sauce and toppings.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/i36szhpa_0.jpg",
            "display": "Sundae Counter",
        },
        "sundae_single_emlaaq": {
            "id": "sundae_single_emlaaq",
            "name": "Single Sundae — Emlaaq",
            "category": "Sundae Cups",
            "size": "Emlaaq",
            "scoops": 1,
            "priceAED": 24,
            "includedToppings": 2,
            "allowExtraToppings": False,
            "description": "Emlaaq sundae with extra toppings.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/8d6mjr6e_0.jpg",
            "display": "Sundae Counter",
        },
        "sundae_double_kids": {
            "id": "sundae_double_kids",
            "name": "Double Sundae — Kids",
            "category": "Sundae Cups",
            "size": "Kids",
            "scoops": 2,
            "priceAED": 25,
            "includedToppings": 2,
            "allowExtraToppings": False,
            "description": "Two-scoop kids sundae.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/su3lvwpc_0.jpg",
            "display": "Sundae Counter",
        },
        "sundae_double_value": {
            "id": "sundae_double_value",
            "name": "Double Sundae — Value",
            "category": "Sundae Cups",
            "size": "Value",
            "scoops": 2,
            "priceAED": 31,
            "includedToppings": 2,
            "allowExtraToppings": False,
            "description": "Two-scoop value sundae.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/hp4r5kzc_0.jpg",
            "display": "Sundae Counter",
        },
        "sundae_double_emlaaq": {
            "id": "sundae_double_emlaaq",
            "name": "Double Sundae — Emlaaq",
            "category": "Sundae Cups",
            "size": "Emlaaq",
            "scoops": 2,
            "priceAED": 40,
            "includedToppings": 2,
            "allowExtraToppings": False,
            "description": "Two-scoop Emlaaq sundae.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/8d6mjr6e_0.jpg",
            "display": "Sundae Counter",
        },
        "sundae_triple_kids": {
            "id": "sundae_triple_kids",
            "name": "Triple Sundae — Kids",
            "category": "Sundae Cups",
            "size": "Kids",
            "scoops": 3,
            "priceAED": 36,
            "includedToppings": 2,
            "allowExtraToppings": False,
            "description": "Three-scoop kids sundae.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/l64p228m_0.jpg",
            "display": "Sundae Counter",
        },
        "sundae_triple_value": {
            "id": "sundae_triple_value",
            "name": "Triple Sundae — Value",
            "category": "Sundae Cups",
            "size": "Value",
            "scoops": 3,
            "priceAED": 44,
            "includedToppings": 2,
            "allowExtraToppings": False,
            "description": "Three-scoop value sundae.",
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/l64p228m_0.jpg",
            "display": "Sundae Counter",
        },
        "shake_chocolate_chiller_regular": {
            "id": "shake_chocolate_chiller_regular",
            "name": "Chocolate Chiller Thick Shake - Regular",
            "category": "Milk Shakes",
            "size": "Regular",
            "priceAED": 27,
            "description": "Chocolate mousse royale ice cream with vanilla ice cream..",
            "allowFlavorSelection": False,
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/nhk3ekf4_0.jpg",
            "display": "Milkshake Bar",
        },
        "shake_chocolate_chiller_large": {
            "id": "shake_chocolate_chiller_large",
            "name": "Chocolate Chiller Thick Shake - Large",
            "category": "Milk Shakes",
            "size": "Large",
            "priceAED": 32,
            "description": "Chocolate mousse royale ice cream with vanilla ice cream.",
            "allowFlavorSelection": False,
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/igdoeihc_0.jpg",
            "display": "Milkshake Bar",
        },
        "shake_strawberry_mania_regular": {
            "id": "shake_strawberry_mania_regular",
            "name": "Strawberry Mania Thick Shake - Regular",
            "category": "Milk Shakes",
            "size": "Regular",
            "priceAED": 25,
            "description": "Vanilla and very berry strawberry ice cream with banana pieces.",
            "allowFlavorSelection": False,
            "allowToppings": False,
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/i1yr0rqp_0.jpg",
            "display": "Milkshake Bar",
        },
        "shake_strawberry_mania_large": {
            "id": "shake_strawberry_mania_large",
            "name": "Strawberry Mania Thick Shake - Large",
            "category": "Milk Shakes",
            "size": "Large",
            "priceAED": 30,
            "description": "Vanilla and very berry strawberry ice cream with banana pieces..",
            "allowFlavorSelection": False,
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/aggee5ui_0.jpg",
            "display": "Milkshake Bar",
        },
        "shake_jamoca_fudge_regular": {
            "id": "shake_jamoca_fudge_regular",
            "name": "Jamoca Fudge Thick Shake - Regular",
            "category": "Milk Shakes",
            "size": "Regular",
            "priceAED": 27,
            "description": "Jamoca almond fudge ice cream.",
            "allowFlavorSelection": False,
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/h3cmi7b7_0.jpg",
            "display": "Milkshake Bar",
        },
        "shake_jamoca_fudge_large": {
            "id": "shake_jamoca_fudge_large",
            "name": "Jamoca Fudge Thick Shake - Large",
            "category": "Milk Shakes",
            "size": "Large",
            "priceAED": 32,
            "description": "Jamoca almond fudge ice cream.",
            "allowFlavorSelection": False,
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/9i34ocls_0.jpg",
            "display": "Milkshake Bar",
        },
        "shake_praline_pleasure_regular": {
            "id": "shake_praline_pleasure_regular",
            "name": "Praline Pleasure Thick Shake - Regular",
            "category": "Milk Shakes",
            "size": "Regular",
            "priceAED": 27,
            "description": "Pralines n cream ice cream with Jamoca almond fudge ice cream.",
            "allowFlavorSelection": False,
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/luqwa7y8_0.jpg",
            "display": "Milkshake Bar",
        },
        "shake_praline_pleasure_large": {
            "id": "shake_praline_pleasure_large",
            "name": "Praline Pleasure Thick Shake - Large",
            "category": "Milk Shakes",
            "size": "Large",
            "priceAED": 32,
            "description": "Pralines cream ice cream with Jamoca almond fudge ice cream.",
            "allowFlavorSelection": False,
            "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/5n85jghc_0.jpg",
            "display": "Milkshake Bar",
        },
        "shake_make_own_regular": {
            "id": "shake_make_own_regular",
            "name": "Make Your Own Thick Shake - Regular (3 Scoops)",
            "category": "Milk Shakes",
            "size": "Regular",
            "scoops": 3,
            "priceAED": 25,
            "description": "Choose 3 flavors (no extras, no toppings).",
            "allowFlavorSelection": True,
            "allowToppings": False,
            "allowedFlavorNames": [
                "Chocolate",
                "Chocolate Chip",
                "Chocolate Mousse Royale",
                "World Class Chocolate",
                "Strawberry Cheesecake",
                "Very Berry Strawberry",
                "Blue Berry Crumble",
                "Cookies N Cream",
                "Gold Medal Ribbon",
                "Jamoca Almond Fudge",
                "Mint Chocolate Chip",
                "Pralines N Cream",
                "Vanilla",
                "Love Potion 31",
                "Rainbow Sherbet",
                "Nsa Caramel Turtle",
                "Mango Sticky Rice",
                "German Chocolate Cake",
                "Cotton Candy",
                "Maui Brownie Madness",
                "Base Ball Nut",
                "Citrus Twist",
                "Pistachio Almond",
                "Peanut Butter N Chocolate",
                "Chocolate Chip Cookie Dough",
            ],
            "imageUrl": "https://dummyimage.com/200x200/efefef/222222&text=Make+Your+Own+Shake",
            "display": "Milkshake Bar",
        },
    },
    "flavors": [
        {
            "id": "flv_chocolate",
            "name": "Chocolate",
            "classification": "choco",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Chocolate.jpg",
            "available": "yes",
        },
        {
            "id": "flv_chocolate_chip",
            "name": "Chocolate Chip",
            "classification": "choco",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Chocolate-Chip.jpg",
            "available": "yes",
        },
        {
            "id": "flv_chocolate_mousse_royale",
            "name": "Chocolate Mousse Royale",
            "classification": "choco",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Chocolate-Mousse-Royale.jpg",
            "available": "yes",
        },
        {
            "id": "flv_world_class_chocolate",
            "name": "World Class Chocolate",
            "classification": "choco",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/World-Class-Chocolate.jpg",
            "available": "yes",
        },
        {
            "id": "flv_strawberry_cheesecake",
            "name": "Strawberry Cheesecake",
            "classification": "berry",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Strawberry-Cheese-Cake.jpg",
            "available": "yes",
        },
        {
            "id": "flv_very_berry_strawberry",
            "name": "Very Berry Strawberry",
            "classification": "berry",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/verY-berry-strawberry.jpg",
            "available": "yes",
        },
        {
            "id": "flv_blue_berry_crumble",
            "name": "Blue Berry Crumble",
            "classification": "berry",
            "imageUrl": "https://res.cloudinary.com/dslutbftw/image/upload/v1763288485/Screenshot_2025-11-16_154743_yccg7x.png",
            "available": "yes",
        },
        {
            "id": "flv_cookies_n_cream",
            "name": "Cookies N Cream",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Cookies-N-Cream.jpg",
            "available": "yes",
        },
        {
            "id": "flv_gold_medal_ribbon",
            "name": "Gold Medal Ribbon",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Gold-Medal-Ribbon.jpg",
            "available": "yes",
        },
        {
            "id": "flv_jamoca_almond_fudge",
            "name": "Jamoca Almond Fudge",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Jamoca-Almond-Fudge.jpg",
            "available": "yes",
        },
        {
            "id": "flv_mint_chocolate_chip",
            "name": "Mint Chocolate Chip",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Mint-Chocolate-Chip.jpg",
            "available": "yes",
        },
        {
            "id": "flv_pralines_n_cream",
            "name": "Pralines N Cream",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Pralines-N-Cream.jpg",
            "available": "yes",
        },
        {
            "id": "flv_vanilla",
            "name": "Vanilla",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Vanilla.jpg",
            "available": "yes",
        },
        {
            "id": "flv_love_potion_31",
            "name": "Love Potion 31",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Love-Portion-31.jpg",
            "available": "yes",
        },
        {
            "id": "flv_rainbow_sherbet",
            "name": "Rainbow Sherbet",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Rainbow-Sherbet.jpg",
            "available": "yes",
        },
        {
            "id": "flv_nsa_caramel_turtle",
            "name": "Nsa Caramel Turtle",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/NSA-Caramel-Turtle.jpg",
            "available": "yes",
        },
        {
            "id": "flv_mango_sticky_rice",
            "name": "Mango Sticky Rice",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/06/It-takes-two-to-mango.jpg",
            "available": "yes",
        },
        {
            "id": "flv_german_chocolate_cake",
            "name": "German Chocolate Cake",
            "classification": "others",
            "imageUrl": "https://cdn.trendhunterstatic.com/thumbs/546/german-chocolate-cake-ice-cream.jpeg",
            "available": "yes",
        },
        {
            "id": "flv_cotton_candy",
            "name": "Cotton Candy",
            "classification": "others",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Cotton-Candy.jpg",
            "available": "yes",
        },
        {
            "id": "flv_cup_of_cocoa_tub",
            "name": "Cup of cocoa Tub",
            "classification": "choco",
            "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Chocolate.jpg",
            "available": "yes",
        },
    ],
    "toppings": [
        {
            "id": "top_hot_butterscotch",
            "name": "Hot Butterscotch",
            "priceAED": 5,
            "imageUrl": "https://thecafesucrefarine.com/wp-content/uploads/Ridiculously-Easy-Butterscotch-Sauce-1.jpg",
        },
        {
            "id": "top_hot_fudge",
            "name": "Hot Fudge",
            "priceAED": 5,
            "imageUrl": "https://images.squarespace-cdn.com/content/v1/58e2595c3e00be0ae51453aa/1725237286880-PCLY565558ZWKOM6OUHZ/hot+fudge-12.jpg",
        },
        {
            "id": "top_strawberry",
            "name": "Strawberry",
            "priceAED": 5,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/7/79/Icecream_with_strawberry_sauce.jpg",
        },
        {
            "id": "top_chocolate_syrup",
            "name": "Chocolate Syrup",
            "priceAED": 5,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/d/d4/Chocolate_syrup_topping_on_ice_cream.JPG",
        },
        {
            "id": "top_almonds_diced",
            "name": "Almonds Diced",
            "priceAED": 5,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/a/af/Bowl_of_chopped_almonds_no_bg.png",
        },
        {
            "id": "top_mms",
            "name": "M&M's",
            "priceAED": 5,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/e/e5/Plain-M%26Ms-Pile.jpg",
        },
        {
            "id": "top_kitkat_crush",
            "name": "Kitkat Crush",
            "priceAED": 5,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/f/fc/Kit-Kat-Split.jpg",
        },
        {
            "id": "top_rainbow_sprinkles",
            "name": "Rainbow Sprinkles",
            "priceAED": 5,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/e/e2/Colored_sprinkles.jpg",
        },
        {
            "id": "top_chocolate_sprinkles",
            "name": "Chocolate Sprinkles",
            "priceAED": 5,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/3/37/Hagelslag_chocolate_sprinkles.jpg",
        },
        {
            "id": "top_pink_white_marshmallow",
            "name": "Pink & White Marshmallow",
            "priceAED": 5,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/c/ca/Pink_Marshmallows.jpg",
        },
        {
            "id": "top_maltesers",
            "name": "Maltesers",
            "priceAED": 6,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/4/48/Maltesers-Pile-and-Split.jpg",
        },
        {
            "id": "top_mms_peanut",
            "name": "M&M's Peanut",
            "priceAED": 6,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/a/aa/M%26m1.jpg",
        },
        {
            "id": "top_skittles",
            "name": "Skittles",
            "priceAED": 6,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/8/81/Skittles-Candies-Pile.jpg",
        },
        {
            "id": "top_haribo_gold_bears",
            "name": "Haribo Gold Bears",
            "priceAED": 6,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/b/bd/Haribo_gb.jpg",
        },
        {
            "id": "top_haribo_raspberry_blackberry",
            "name": "Haribo Raspberry & Blackberry",
            "priceAED": 6,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/6/6a/Haribo_Gelee-Himbeeren_und_-Brombeeren-5468.jpg",
        },
        {
            "id": "top_pistachio_diced_roasted",
            "name": "Pistachio Diced Roasted",
            "priceAED": 6,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/4/4b/K%C3%BCnefe_-_pistachio.jpg",
        },
        {
            "id": "top_nutella",
            "name": "Nutella",
            "priceAED": 6,
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/9/9b/Nutella_ak.jpg",
        },
        {
            "id": "top_pistachio_liquid",
            "name": "Pistachio Liquid Topping",
            "priceAED": 6,
            "imageUrl": "https://www.loveandoliveoil.com/wp-content/uploads/2025/04/homemade-pistachio-syrup-1.jpg",
        },
    ],
}

# Normalize product prices
for _p in SCOOP_KB.get("products", {}).values():
    try:
        _p["priceAED"] = (
            round(float(_p.get("priceAED") or 0.0), 2)
            if _p.get("priceAED") is not None
            else None
        )
    except (TypeError, ValueError):
        _p["priceAED"] = None


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
            "priceAED": round(float(t.get("priceAED") or 0.0), 2),
            "imageUrl": t.get("imageUrl") or self._kb["image_defaults"]["square"],
            "dietary": t.get("dietary", []),
        }

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

            # Publish overlay
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

            payload["uiRpc"] = ui_rpc
            return _sanitize_output(payload)

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
                cards = [self._format_topping_card(t) for t in self._toppings.values()]
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
                    "note": "Extra toppings cost 5 or 6 dirham each.",
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

            payload["uiRpc"] = ui_rpc
            return _sanitize_output(payload)

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

        # Even if empty, we respect it and clear previous selections
        line["flavors"] = resolved_flavors

        flavor_summary = line.get("flavor_summary", {}) or {}
        free_slots = int(flavor_summary.get("free", int(product.get("scoops") or 0)))
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
                f"Flavors are full; propose swapping one for {suggested_flavor.get('name')} or adding it for "
                f"{float(extra_price_per):.2f} dirham."
            )
            flavor_upsell_suggestion = {
                "type": "swap_or_add",
                "flavor": self._format_flavor_card(suggested_flavor),
                "extraPriceAED": _sanitize_output(extra_price_per),
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
        elif remaining_free == 0 and suggested_top:
            topping_upsell_hint = (
                f"{suggested_top.get('name')} would taste great here. I can replace one of the current toppings with it. Should I go ahead?"
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
                        "type": "add" if remaining_free > 0 else "swap_or_add",
                        "topping": self._format_topping_card(suggested_top)
                        if suggested_top
                        else None,
                        "extraPriceAED": (
                            0.0
                            if remaining_free > 0
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
            cart_upsell_hint = "Suggest a milkshake that matches their flavors as a cart add-on."
            cart_upsell_suggestion = {"type": "add", "category": "Milk Shakes"}
        elif product.get("category") == "Milk Shakes":
            cart_upsell_hint = "Suggest a Sundae Cup that pairs with the shake as a cart add-on."
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

    def __init__(self, session_state: ScoopSessionState, tools: ScoopTools) -> None:
        self._session_state = session_state
        self._tools = tools
        toolkit = [
            self._tools.list_menu,
            self._tools.choose_flavors,
            self._tools.choose_toppings,
            self._tools.add_to_cart,
            self._tools.get_directions,
        ]
        super().__init__(instructions=self._build_instructions(), tools=toolkit)

    def _build_instructions(self) -> str:
        context_summary = self._session_state.describe()
        catalog_context = self._tools._get_catalog_context()
        greeting = _time_of_day_greeting()
        instructions = SCOOP_PROMPT.replace("{{CATALOG_CONTEXT}}", catalog_context)
        instructions = instructions.replace("{{GREETING}}", greeting)
        instructions = instructions.replace("{{SESSION_CONTEXT}}", context_summary)
        return instructions

    async def on_enter(self, participant: Any = None) -> None:
        logger.info("[AGENT] on_enter called, sending initial greeting.")
        try:
            await self.session.generate_reply()
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

    logger.info(
        "[ENTRYPOINT] Starting job_id=%s | agent_identity=%s | controller_identity=%s |DEPLOYMENT VERIFICATION: FIX APPLIED (V2)",
        job_id,
        agent_identity,
        controller_identity,
    )

    # --- PIPELINE SETUP (Code 2 Style) ---
    stt = deepgram.STT(model="nova-3", api_key=config.deepgram_api_key)
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
    tts = cartesia.TTS(
        model="sonic-3",
        voice=config.cartesia_voice_id,
        api_key=config.cartesia_api_key,
    )

    session = AgentSession(
        stt=stt,
        vad=vad,
        llm=llm,
        tts=tts,
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
    wait_for_guest = asyncio.create_task(ctx.wait_for_participant())
    avatar_ready = asyncio.create_task(avatar_session.start(session, room=ctx.room))
    await asyncio.gather(wait_for_guest, avatar_ready)

    logger.info(
        "[ENTRYPOINT] Guest connected and avatar ready, starting agent session."
    )

    agent = ScoopAgent(session_state, tools)

    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(
            audio_enabled=True,
            video_enabled=False,
        ),
    )


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
