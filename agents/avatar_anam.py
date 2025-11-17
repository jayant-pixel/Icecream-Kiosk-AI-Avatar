"""
Baskin Robbins Avatar Agent — Galadari POC
------------------------------------------
LiveKit realtime worker that drives the Anam avatar with Baskin Robbins' kiosk persona.
OpenAI realtime LLM + voice, Anam avatar, and KB-backed tools for products,
flavors, toppings, cart, and directions aligned to BR flows.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Dict, List, Optional, TYPE_CHECKING, cast
import re

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

logger = logging.getLogger("baskin-avatar-agent")
logger.setLevel(logging.INFO)
load_dotenv(dotenv_path=Path(__file__).resolve().with_name(".env"))

if TYPE_CHECKING:
    RunCtxParam = Optional[RunContext]
else:
    RunCtxParam = Optional[Any]

OVERLAY_TOPIC = "ui.overlay"
CATEGORY_FALLBACK = "Highlights"

# =========================
# Conversation Instructions
# =========================
SCOOP_PROMPT = r"""## ROLE
You are Sarah, the friendly Baskin Robbins concierge at Al Quoz, UAE. Welcome guests, help them choose between Cups, Sundae Cups, and Milk Shakes, build their order, state totals in dirham, and guide them to the pickup counter. Stay in character as Sarah.

## KNOWLEDGE BASE
SCOOP_KB contains:
- Full catalog of Cups, Sundae Cups, Milk Shakes, Make-Your-Own.
- Flavors with classifications (choco / berry / others / sugarless), availability, and images.
- Toppings with priceAED (5 vs 6), dietary tags, and images.
- Pricing rules: free flavors per scoops, flavor_policy.defaultFlavorPriceAED (3.0 dirham per extra flavor), toppings behavior, shake rules.
- Display locations (Ice Cream Bar, Sundae Counter, Milkshake Bar) for pickup.

Treat SCOOP_KB as the single source of truth. Never invent products, flavors, sizes, or prices. Use priceAED, includedToppings, scoops, and policies from the KB. Map pickup locations from each product's `display`.

Flavor/Topping behavior:
- Cups: free flavors = scoops. No free toppings; all toppings are charged (5 or 6 dirham).
- Sundae Cups: free flavors = scoops. Two free toppings unless KB `includedToppings` overrides; extra toppings charged.
- Milk Shakes + Make Your Own: recipes are fixed or 3 scoops for MYO. Unlimited toppings allowed, each charged by priceAED. Extra flavors beyond the scoop count cost 3.0 dirham each.

## TOOLKIT
(Never mention tool names/JSON; describe results as "on screen".)
- `list_menu(kind, category?, size?, query?, view?, product_id?)`: control whether the menu grid (left) or detail card (right) is visible, and open the flavor/topping galleries.
- `choose_flavors(product_id, flavor_ids)`: attach flavors, respecting free scoops and extra-flavor charges.
- `choose_toppings(product_id, topping_ids)`: attach toppings, marking which are free vs extra.
- `add_to_cart(product_id, qty)`: add configured items and return cart totals in dirham.
- `recommend_upgrade(product_id)`: suggest better sizes/options if many paid toppings are added.
- `get_directions(display_name)`: surface pickup map cards tied to Ice Cream Bar, Sundae Counter, or Milkshake Bar.

## STYLE
- Warm, upbeat Baskin Robbins tone. Short confirmations like "Perfect pick!"
- Light sensory cues ("rich chocolate", "berry and creamy") without overdoing it.
- One idea per turn, then pause. ~60 words unless summarizing the cart or directions.
- Always say prices as "X dirham" (never just "AED").
- Use the guest's name naturally once you know it.

## UI CHOREOGRAPHY
- When the guest wants to browse, call `list_menu("products")` so the **menu grid stays on the left** while the avatar remains centered.
- When they focus on a specific treat, show the **detail card on the right** but keep the menu visible on the left until they confirm the item.
- Once they commit to that item (ready for flavors/toppings), the menu slides away, the **detail card shifts left**, and you open flavors/toppings as stacked panels on the **right** (one panel at a time).
- Cart summaries, upgrade banners, and pickup directions also occupy the right column; keep the left/center clear so the avatar remains unobstructed.

## PLAYBOOK
1. **Welcome & Setup**
   - "Hi! Welcome to Baskin Robbins Al Quoz, I'm Sarah. What's your name?"
   - Follow with: "What kind of mood are you in today—rich chocolate, bright berries, or something indulgent?"
   - Introduce categories every time: "We can do classic Cups, Sundae Cups stacked with toppings, or Milk Shakes." If they look unsure, explain a Sundae is simply a cup with toppings piled on.
   - Keep the screen clear until they ask for options; then call `list_menu("products")` (menu grid left).

2. **Guide Choice by Category**
   - Use mood cues to suggest categories. Ask: "Should we go Cup, Sundae, or Milk Shake?" then open the relevant grid via `list_menu("products", category=...)`.
   - When discussing flavors, call `list_menu("flavors")` and summarize by Chocolate / Berry / Classics / Sugarless.

3. **Case Flows**
   - **Cups**: confirm size (Kids/Value/Emlaaq) immediately, remind them how many flavors that size includes, then capture flavors. Offer toppings afterward and, if they add several, suggest upgrading to the matching Sundae for value.
   - **Sundae Cups**: confirm size, highlight they can pick the same number of flavors as scoops, then lead them into toppings (two free unless KB overrides). Always mention free vs paid toppings.
   - **Milk Shakes**: ask if they want a fixed recipe or Make-Your-Own. Confirm size (Regular/Large). For MYO, remind them it includes three flavors + unlimited paid toppings. Show no more than four shake cards per size when browsing.

4. **Quick / Regular Orders**
   - If a guest gives a full spec (e.g., "Single Value Scoop Cup with Blue Berry Crumble, no toppings"), confirm details, note any remaining scoops/toppings they’re entitled to, and run the tools without extra browsing.
   - If a Sundae order includes explicit toppings ("Triple Value Sundae with Chocolate chips, Blueberry Crumble, Love Potion 31"), confirm quantity and whether they want another flavor before adding to cart.
   - For multi-item orders, handle each sequentially, summarizing totals after every addition.

5. **Cart, Directions & Close**
   - Before each `add_to_cart`, restate size, flavors, toppings, and quantity, then quote the price in dirham. After adding, point out the cart overlay on the right with subtotal/tax/total and ask if they need anything else.
   - Offer pickup directions (`get_directions`) once ordering is done, referencing Ice Cream Bar / Sundae Counter / Milkshake Bar.
   - Close warmly: "Thank you, {name}. Enjoy your ice cream!"

## GUARDRAILS
- Always rely on SCOOP_KB for names, scoops, prices, toppings, and displays.
- Never expose tool names or JSON; describe what's "on screen".
- If audio is unclear: "Sorry, I didn't catch that—could you say it again?"
- Always say money as "dirham". Stay calm, friendly, precise, and human."""
# =====================
# Knowledge Base (Hard)
# =====================
SCOOP_KB: Dict[str, Any] = {
  "toppings_policy": {
    "extraToppingsCharged": "yes",
    "extraToppingPriceAED": 5.0,
    "note": "Extra toppings are charged per topping unless included by the item/size. Milkshakes can take unlimited toppings; each topping is charged according to its own priceAED."
  },

  "flavor_policy": {
    "extraFlavorsCharged": "yes",
    "defaultFlavorPriceAED": 3.0,
    "note": "Items include free flavors equal to their scoop count. Additional flavors beyond that number are charged per flavor."
  },

  "image_defaults": {
    "square": "https://dummyimage.com/200x200/efefef/222222&text=Image",
    "rect": "https://dummyimage.com/600x400/efefef/222222&text=Image"
  },

  "displays": {
    "Ice Cream Bar": {
      "displayName": "Ice Cream Bar",
      "hint": "You’ll find your cup ice creams being scooped here.",
      "mapImage": "https://res.cloudinary.com/dslutbftw/image/upload/v1763290020/Cake_Shop_Interior_qeffkb.jpg"
    },
    "Sundae Counter": {
      "displayName": "Sundae Counter",
      "hint": "This is where all Sundae Cups are prepared and topped.",
      "mapImage": "https://res.cloudinary.com/dslutbftw/image/upload/v1763290020/Cake_Shop_Interior_qeffkb.jpg"
    },
    "Milkshake Bar": {
      "displayName": "Milkshake Bar",
      "hint": "Shakes are blended fresh right here.",
      "mapImage": "https://res.cloudinary.com/dslutbftw/image/upload/v1763290020/Cake_Shop_Interior_qeffkb.jpg"
    }
  },

  "product_order": [
    "cup_single_kids", "cup_single_value", "cup_single_emlaaq",
    "cup_double_kids", "cup_double_value", "cup_double_emlaaq",
    "cup_triple_kids", "cup_triple_value", "cup_triple_emlaaq",
    "sundae_single_kids", "sundae_single_value", "sundae_single_emlaaq",
    "sundae_double_kids", "sundae_double_value", "sundae_double_emlaaq",
    "sundae_triple_kids", "sundae_triple_value", "sundae_triple_emlaaq",
    "shake_chocolate_chiller_regular", "shake_chocolate_chiller_large",
    "shake_strawberry_mania_regular", "shake_strawberry_mania_large",
    "shake_jamoca_fudge_regular", "shake_jamoca_fudge_large",
    "shake_praline_pleasure_regular", "shake_praline_pleasure_large",
    "shake_make_own_regular"
  ],

  "products": {
    "cup_single_kids": {
      "id": "cup_single_kids",
      "name": "Single Scoop Cup — Kids",
      "category": "Cups",
      "size": "Kids",
      "scoops": 1,
      "priceAED": 12,
      "description": "One scoop in a kid-sized cup.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/wwweif79_0.jpg",
      "display": "Ice Cream Bar"
    },
    "cup_single_value": {
      "id": "cup_single_value",
      "name": "Single Scoop Cup — Value",
      "category": "Cups",
      "size": "Value",
      "scoops": 1,
      "priceAED": 16,
      "description": "One full scoop in a value-sized cup.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/7ysjfilv_0.jpg",
      "display": "Ice Cream Bar"
    },
    "cup_single_emlaaq": {
      "id": "cup_single_emlaaq",
      "name": "Single Scoop Cup — Emlaaq",
      "category": "Cups",
      "size": "Emlaaq",
      "scoops": 1,
      "priceAED": 20,
      "description": "One generous Emlaaq scoop.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/ceeoxr60_0.jpg",
      "display": "Ice Cream Bar"
    },

    "cup_double_kids": {
      "id": "cup_double_kids",
      "name": "Double Scoops Cup — Kids",
      "category": "Cups",
      "size": "Kids",
      "scoops": 2,
      "priceAED": 21,
      "description": "Two kid-sized scoops.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/pk1npics_0.jpg",
      "display": "Ice Cream Bar"
    },
    "cup_double_value": {
      "id": "cup_double_value",
      "name": "Double Scoops Cup — Value",
      "category": "Cups",
      "size": "Value",
      "scoops": 2,
      "priceAED": 28,
      "description": "Two value scoops — mix flavors freely.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/bw2cs7ou_0.jpg",
      "display": "Ice Cream Bar"
    },
    "cup_double_emlaaq": {
      "id": "cup_double_emlaaq",
      "name": "Double Scoops Cup — Emlaaq",
      "category": "Cups",
      "size": "Emlaaq",
      "scoops": 2,
      "priceAED": 37,
      "description": "Two large Emlaaq scoops.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/8jj0qlin_0.jpg",
      "display": "Ice Cream Bar"
    },

    "cup_triple_kids": {
      "id": "cup_triple_kids",
      "name": "Triple Scoops Cup — Kids",
      "category": "Cups",
      "size": "Kids",
      "scoops": 3,
      "priceAED": 30,
      "description": "Three kid-sized scoops.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/bd4a3wvg_0.jpg",
      "display": "Ice Cream Bar"
    },
    "cup_triple_value": {
      "id": "cup_triple_value",
      "name": "Triple Scoops Cup — Value",
      "category": "Cups",
      "size": "Value",
      "scoops": 3,
      "priceAED": 35,
      "description": "Three classic scoops — mix & match.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/i4cehyc6_0.jpg",
      "display": "Ice Cream Bar"
    },
    "cup_triple_emlaaq": {
      "id": "cup_triple_emlaaq",
      "name": "Triple Scoops Cup — Emlaaq",
      "category": "Cups",
      "size": "Emlaaq",
      "scoops": 3,
      "priceAED": 40,
      "description": "Three large Emlaaq scoops.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/i4cehyc6_0.jpg",
      "display": "Ice Cream Bar"
    },

    "sundae_single_kids": {
      "id": "sundae_single_kids",
      "name": "Single Sundae — Kids",
      "category": "Sundae Cups",
      "size": "Kids",
      "scoops": 1,
      "priceAED": 18,
      "includedToppings": 2,
      "description": "Kids sundae with sauces & basic toppings.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/qwwyrap1_0.jpg",
      "display": "Sundae Counter"
    },
    "sundae_single_value": {
      "id": "sundae_single_value",
      "name": "Single Sundae — Value",
      "category": "Sundae Cups",
      "size": "Value",
      "scoops": 1,
      "priceAED": 22,
      "includedToppings": 2,
      "description": "Value sundae with sauce and toppings.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/i36szhpa_0.jpg",
      "display": "Sundae Counter"
    },
    "sundae_single_emlaaq": {
      "id": "sundae_single_emlaaq",
      "name": "Single Sundae — Emlaaq",
      "category": "Sundae Cups",
      "size": "Emlaaq",
      "scoops": 1,
      "priceAED": 28,
      "includedToppings": 3,
      "description": "Emlaaq sundae with extra toppings.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/8d6mjr6e_0.jpg",
      "display": "Sundae Counter"
    },

    "sundae_double_kids": {
      "id": "sundae_double_kids",
      "name": "Double Sundae — Kids",
      "category": "Sundae Cups",
      "size": "Kids",
      "scoops": 2,
      "priceAED": 25,
      "includedToppings": 2,
      "description": "Two-scoop kids sundae.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/su3lvwpc_0.jpg",
      "display": "Sundae Counter"
    },
    "sundae_double_value": {
      "id": "sundae_double_value",
      "name": "Double Sundae — Value",
      "category": "Sundae Cups",
      "size": "Value",
      "scoops": 2,
      "priceAED": 30,
      "includedToppings": 2,
      "description": "Two-scoop value sundae.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/hp4r5kzc_0.jpg",
      "display": "Sundae Counter"
    },
    "sundae_double_emlaaq": {
      "id": "sundae_double_emlaaq",
      "name": "Double Sundae — Emlaaq",
      "category": "Sundae Cups",
      "size": "Emlaaq",
      "scoops": 2,
      "priceAED": 35,
      "includedToppings": 2,
      "description": "Two-scoop Emlaaq sundae.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/8d6mjr6e_0.jpg",
      "display": "Sundae Counter"
    },

    "sundae_triple_kids": {
      "id": "sundae_triple_kids",
      "name": "Triple Sundae — Kids",
      "category": "Sundae Cups",
      "size": "Kids",
      "scoops": 3,
      "priceAED": 30,
      "includedToppings": 2,
      "description": "Three-scoop kids sundae.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/l64p228m_0.jpg",
      "display": "Sundae Counter"
    },
    "sundae_triple_value": {
      "id": "sundae_triple_value",
      "name": "Triple Sundae — Value",
      "category": "Sundae Cups",
      "size": "Value",
      "scoops": 3,
      "priceAED": 35,
      "includedToppings": 2,
      "description": "Three-scoop value sundae.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/l64p228m_0.jpg",
      "display": "Sundae Counter"
    },
    "sundae_triple_emlaaq": {
      "id": "sundae_triple_emlaaq",
      "name": "Triple Sundae — Emlaaq",
      "category": "Sundae Cups",
      "size": "Emlaaq",
      "scoops": 3,
      "priceAED": 40,
      "includedToppings": 2,
      "description": "Three-scoop Emlaaq sundae.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/l64p228m_0.jpg",
      "display": "Sundae Counter"
    },

    "shake_chocolate_chiller_regular": {
      "id": "shake_chocolate_chiller_regular",
      "name": "Chocolate Chiller Thick Shake — Regular",
      "category": "Milk Shakes",
      "size": "Regular",
      "priceAED": 27,
      "description": "Chocolate mousse royale + vanilla blend.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/nhk3ekf4_0.jpg",
      "display": "Milkshake Bar"
    },
    "shake_chocolate_chiller_large": {
      "id": "shake_chocolate_chiller_large",
      "name": "Chocolate Chiller Thick Shake — Large",
      "category": "Milk Shakes",
      "size": "Large",
      "priceAED": 32,
      "description": "Large chocolate mousse royale + vanilla.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/igdoeihc_0.jpg",
      "display": "Milkshake Bar"
    },

    "shake_strawberry_mania_regular": {
      "id": "shake_strawberry_mania_regular",
      "name": "Strawberry Mania Thick Shake — Regular",
      "category": "Milk Shakes",
      "size": "Regular",
      "priceAED": 27,
      "description": "Vanilla + very berry strawberry + banana.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/i1yr0rqp_0.jpg",
      "display": "Milkshake Bar"
    },
    "shake_strawberry_mania_large": {
      "id": "shake_strawberry_mania_large",
      "name": "Strawberry Mania Thick Shake — Large",
      "category": "Milk Shakes",
      "size": "Large",
      "priceAED": 30,
      "description": "Large vanilla + berry + banana blend.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/aggee5ui_0.jpg",
      "display": "Milkshake Bar"
    },

    "shake_jamoca_fudge_regular": {
      "id": "shake_jamoca_fudge_regular",
      "name": "Jamoca Fudge Thick Shake — Regular",
      "category": "Milk Shakes",
      "size": "Regular",
      "priceAED": 27,
      "description": "Jamoca almond fudge blend.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/h3cmi7b7_0.jpg",
      "display": "Milkshake Bar"
    },
    "shake_jamoca_fudge_large": {
      "id": "shake_jamoca_fudge_large",
      "name": "Jamoca Fudge Thick Shake — Large",
      "category": "Milk Shakes",
      "size": "Large",
      "priceAED": 32,
      "description": "Large Jamoca almond fudge blend.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/9i34ocls_0.jpg",
      "display": "Milkshake Bar"
    },

    "shake_praline_pleasure_regular": {
      "id": "shake_praline_pleasure_regular",
      "name": "Praline Pleasure Thick Shake — Regular",
      "category": "Milk Shakes",
      "size": "Regular",
      "priceAED": 27,
      "description": "Pralines n Cream + Jamoca almond fudge.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/luqwa7y8_0.jpg",
      "display": "Milkshake Bar"
    },
    "shake_praline_pleasure_large": {
      "id": "shake_praline_pleasure_large",
      "name": "Praline Pleasure Thick Shake — Large",
      "category": "Milk Shakes",
      "size": "Large",
      "priceAED": 32,
      "description": "Large Pralines n Cream + Jamoca almond fudge.",
      "imageUrl": "https://f.nooncdn.com/food_production/food/menu/M8654550136017771626691016A/5n85jghc_0.jpg",
      "display": "Milkshake Bar"
    },

    "shake_make_own_regular": {
      "id": "shake_make_own_regular",
      "name": "Make Your Own Thick Shake — Regular (3 Scoops)",
      "category": "Milk Shakes",
      "size": "Regular",
      "scoops": 3,
      "priceAED": 25,
      "description": "Choose 3 flavors + unlimited toppings (charged).",
      "allowedFlavorNames": [
        "Chocolate", "Chocolate Chip", "Chocolate Mousse Royale", "World Class Chocolate",
        "Strawberry Cheesecake", "Very Berry Strawberry", "Blue Berry Crumble",
        "Cookies N Cream", "Gold Medal Ribbon", "Jamoca Almond Fudge", "Mint Chocolate Chip",
        "Pralines N Cream", "Vanilla", "Love Potion 31", "Rainbow Sherbet",
        "Nsa Caramel Turtle", "Mango Sticky Rice", "German Chocolate Cake",
        "Cotton Candy", "Maui Brownie Madness", "Base Ball Nut",
        "Citrus Twist", "Pistachio Almond", "Peanut Butter N Chocolate",
        "Chocolate Chip Cookie Dough"
      ],
      "imageUrl": "https://dummyimage.com/200x200/efefef/222222&text=Make+Your+Own+Shake",
      "display": "Milkshake Bar"
    }
  },

  "flavors": [
    { "id": "flv_chocolate", "name": "Chocolate", "classification": "choco", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Chocolate.jpg", "available": "yes" },
    { "id": "flv_chocolate_chip", "name": "Chocolate Chip", "classification": "choco", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Chocolate-Chip.jpg", "available": "yes" },
    { "id": "flv_chocolate_mousse_royale", "name": "Chocolate Mousse Royale", "classification": "choco", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Chocolate-Mousse-Royale.jpg", "available": "yes" },
    { "id": "flv_world_class_chocolate", "name": "World Class Chocolate", "classification": "choco", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/World-Class-Chocolate.jpg", "available": "yes" },

    { "id": "flv_strawberry_cheesecake", "name": "Strawberry Cheesecake", "classification": "berry", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Strawberry-Cheese-Cake.jpg", "available": "yes" },
    { "id": "flv_very_berry_strawberry", "name": "Very Berry Strawberry", "classification": "berry", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/verY-berry-strawberry.jpg", "available": "yes" },
    { "id": "flv_blue_berry_crumble", "name": "Blue Berry Crumble", "classification": "berry", "imageUrl": "https://res.cloudinary.com/dslutbftw/image/upload/v1763288485/Screenshot_2025-11-16_154743_yccg7x.png", "available": "yes" },

    { "id": "flv_cookies_n_cream", "name": "Cookies N Cream", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Cookies-N-Cream.jpg", "available": "yes" },
    { "id": "flv_gold_medal_ribbon", "name": "Gold Medal Ribbon", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Gold-Medal-Ribbon.jpg", "available": "yes" },
    { "id": "flv_jamoca_almond_fudge", "name": "Jamoca Almond Fudge", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Jamoca-Almond-Fudge.jpg", "available": "yes" },
    { "id": "flv_mint_chocolate_chip", "name": "Mint Chocolate Chip", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Mint-Chocolate-Chip.jpg", "available": "yes" },
    { "id": "flv_pralines_n_cream", "name": "Pralines N Cream", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Pralines-N-Cream.jpg", "available": "yes" },
    { "id": "flv_vanilla", "name": "Vanilla", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Vanilla.jpg", "available": "yes" },
    { "id": "flv_love_potion_31", "name": "Love Potion 31", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Love-Portion-31.jpg", "available": "yes" },
    { "id": "flv_rainbow_sherbet", "name": "Rainbow Sherbet", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Rainbow-Sherbet.jpg", "available": "yes" },
    { "id": "flv_nsa_caramel_turtle", "name": "Nsa Caramel Turtle", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/NSA-Caramel-Turtle.jpg", "available": "yes" },
    { "id": "flv_mango_sticky_rice", "name": "Mango Sticky Rice", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/06/It-takes-two-to-mango.jpg", "available": "yes" },
    { "id": "flv_german_chocolate_cake", "name": "German Chocolate Cake", "classification": "others", "imageUrl": "https://cdn.trendhunterstatic.com/thumbs/546/german-chocolate-cake-ice-cream.jpeg", "available": "yes" },
    { "id": "flv_cotton_candy", "name": "Cotton Candy", "classification": "others", "imageUrl": "https://www.baskinrobbinsmea.com/wp-content/uploads/2020/05/Cotton-Candy.jpg", "available": "yes" },

    { "id": "flv_sugarless", "name": "SugarLess", "classification": "sugarless", "imageUrl": "null", "available": "no" }
  ],

  "toppings": [
    { "id": "top_hot_butterscotch", "name": "Hot Butterscotch", "priceAED": 5, "imageUrl": "https://thecafesucrefarine.com/wp-content/uploads/Ridiculously-Easy-Butterscotch-Sauce-1.jpg" },
    { "id": "top_hot_fudge", "name": "Hot Fudge", "priceAED": 5, "imageUrl": "https://images.squarespace-cdn.com/content/v1/58e2595c3e00be0ae51453aa/1725237286880-PCLY565558ZWKOM6OUHZ/hot+fudge-12.jpg" },
    { "id": "top_strawberry", "name": "Strawberry", "priceAED": 5, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/7/79/Icecream_with_strawberry_sauce.jpg" },
    { "id": "top_chocolate_syrup", "name": "Chocolate Syrup", "priceAED": 5, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/d/d4/Chocolate_syrup_topping_on_ice_cream.JPG" },
    { "id": "top_almonds_diced", "name": "Almonds Diced", "priceAED": 5, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/a/af/Bowl_of_chopped_almonds_no_bg.png" },
    { "id": "top_mms", "name": "M&M's", "priceAED": 5, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/e/e5/Plain-M%26Ms-Pile.jpg" },
    { "id": "top_kitkat_crush", "name": "Kitkat Crush", "priceAED": 5, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/f/fc/Kit-Kat-Split.jpg" },
    { "id": "top_rainbow_sprinkles", "name": "Rainbow Sprinkles", "priceAED": 5, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/e/e2/Colored_sprinkles.jpg" },
    { "id": "top_chocolate_sprinkles", "name": "Chocolate Sprinkles", "priceAED": 5, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/3/37/Hagelslag_chocolate_sprinkles.jpg" },
    { "id": "top_pink_white_marshmallow", "name": "Pink & White Marshmallow", "priceAED": 5, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/c/ca/Pink_Marshmallows.jpg" },

    { "id": "top_maltesers", "name": "Maltesers", "priceAED": 6, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/4/48/Maltesers-Pile-and-Split.jpg" },
    { "id": "top_mms_peanut", "name": "M&M's Peanut", "priceAED": 6, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/a/aa/M%26m1.jpg" },
    { "id": "top_skittles", "name": "Skittles", "priceAED": 6, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/8/81/Skittles-Candies-Pile.jpg" },
    { "id": "top_haribo_gold_bears", "name": "Haribo Gold Bears", "priceAED": 6, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/b/bd/Haribo_gb.jpg" },
    { "id": "top_haribo_raspberry_blackberry", "name": "Haribo Raspberry & Blackberry", "priceAED": 6, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/6/6a/Haribo_Gelee-Himbeeren_und_-Brombeeren-5468.jpg" },
    { "id": "top_pistachio_diced_roasted", "name": "Pistachio Diced Roasted", "priceAED": 6, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/4/4b/K%C3%BCnefe_-_pistachio.jpg" },
    { "id": "top_nutella", "name": "Nutella", "priceAED": 6, "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/9/9b/Nutella_ak.jpg" },
    { "id": "top_pistachio_liquid", "name": "Pistachio Liquid Topping", "priceAED": 6, "imageUrl": "https://www.loveandoliveoil.com/wp-content/uploads/2025/04/homemade-pistachio-syrup-1.jpg" }
  ]
}

# Normalize numeric prices
for _p in SCOOP_KB.get("products", {}).values():
    try:
        _p["priceAED"] = round(float(_p.get("priceAED") or 0.0), 2) if _p.get("priceAED") is not None else None
    except (TypeError, ValueError):
        _p["priceAED"] = None

# ==========================
# Agent Configuration Helper
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
        missing = [k for k, v in required.items() if not v]
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
# =========================
# UI Overlay / RPC Helpers
# =========================
async def _publish_overlay(
    session: Optional[AgentSession],
    kind: str,
    data: Dict[str, Any],
    room: Optional[Any] = None,
) -> None:
    room_obj = room or getattr(session, "room", None)
    if not room_obj:
        logger.warning("Skipping overlay '%s'; no room reference available", kind)
        return
    local_participant = getattr(room_obj, "local_participant", None)
    if not local_participant:
        logger.warning("Skipping overlay '%s'; local participant missing", kind)
        return
    message = json.dumps({"type": "ui.overlay", "payload": {"kind": kind, **data}}).encode("utf-8")
    try:
        await local_participant.publish_data(message, topic=OVERLAY_TOPIC)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to publish overlay '%s': %s", kind, exc)
# =================
# Tools / Functions
# =================
class ScoopTools:
    SIZE_ALIAS = {"small": "Kids", "value": "Value", "big": "Emlaaq", "large": "Emlaaq"}

    def __init__(self, config: AgentConfig, session: AgentSession, room: Any, controller_identity: Optional[str]) -> None:
        self.config = config
        self._session = session
        self._room = room
        self._controller_identity = controller_identity
        self._kb = SCOOP_KB
        self._product_order: List[str] = [
            pid for pid in self._kb.get("product_order", []) if pid in self._kb["products"]
        ]
        self._products = self._kb["products"]
        self._flavors = {f["id"]: f for f in self._kb.get("flavors", [])}
        self._toppings = {t["id"]: t for t in self._kb.get("toppings", [])}
        self._line_state: Dict[str, Dict[str, Any]] = {}
        self._cart_items: List[Dict[str, Any]] = []
        self._cart_summary: Dict[str, Any] = {}
        self._active_product_id: Optional[str] = None
        self._product_tokens_cache: Dict[str, set[str]] = {}
        self._flavor_tokens_cache: Dict[str, set[str]] = {}
        self._topping_tokens_cache: Dict[str, set[str]] = {}
        self._flavor_name_index = self._build_name_index(self._flavors)
        self._topping_name_index = self._build_name_index(self._toppings)

    async def _emit_client_rpc(self, ctx: "RunCtxParam", method: str, payload: Dict[str, Any]) -> None:
        run_ctx = cast(Optional[RunContext], ctx) if ctx else None
        session_obj = run_ctx.session if run_ctx and getattr(run_ctx, "session", None) else self._session
        room = getattr(session_obj, "room", None) or self._room
        if not room or not room.local_participant:
            return
        local_identity = getattr(room.local_participant, "identity", None)
        destinations: List[str] = []
        for participant in room.remote_participants.values():
            identity = getattr(participant, "identity", None)
            if not identity or identity == local_identity:
                continue
            attrs = getattr(participant, "attributes", {}) or {}
            is_guest = identity.startswith("guest-") or identity.startswith("guest_") or attrs.get("role") == "guest"
            if is_guest and identity not in destinations:
                destinations.append(identity)
        if (
            self._controller_identity
            and self._controller_identity not in destinations
            and self._controller_identity != local_identity
        ):
            destinations.append(self._controller_identity)
        if not destinations:
            return
        payload_json = json.dumps(payload)
        for identity in destinations:
            try:
                await room.local_participant.perform_rpc(destination_identity=identity, method=method, payload=payload_json)
            except Exception as exc:  # noqa: BLE001
                logger.exception("RPC %s -> %s failed: %s", method, identity, exc)

    async def _publish_overlay_for_ctx(self, ctx: "RunCtxParam", kind: str, data: Dict[str, Any]) -> None:
        run_ctx = cast(Optional[RunContext], ctx) if ctx else None
        session_obj = run_ctx.session if run_ctx and getattr(run_ctx, "session", None) else self._session
        room_obj = getattr(run_ctx, "room", None) if run_ctx else None
        if not room_obj and session_obj:
            room_obj = getattr(session_obj, "room", None)
        room_obj = room_obj or self._room
        if room_obj and room_obj is not self._room:
            # Keep the cached reference fresh in case the session rebinds rooms.
            self._room = room_obj
        await _publish_overlay(session_obj, kind, data, room_obj)

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
        }

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

    def _map_size_alias(self, size: Optional[str]) -> Optional[str]:
        if not size:
            return None
        s = size.strip().lower()
        return self.SIZE_ALIAS.get(s, size.title())

    def _normalize_label(self, value: Optional[str]) -> str:
        if not value:
            return ""
        return re.sub(r"[^a-z0-9]", "", value.lower())

    def _tokens_for_label(self, value: Optional[str]) -> set[str]:
        tokens = self._tokenize(value)
        normalized = self._normalize_label(value)
        if normalized:
            tokens.add(normalized)
            if normalized.endswith("s") and len(normalized) > 1:
                tokens.add(normalized[:-1])
        return tokens

    def _build_name_index(self, entries: Dict[str, Dict[str, Any]]) -> Dict[str, List[str]]:
        index: Dict[str, List[str]] = {}
        for entry_id, entry in entries.items():
            normalized = self._normalize_label(entry.get("name"))
            if not normalized:
                continue
            index.setdefault(normalized, []).append(entry_id)
            if normalized.endswith("s") and len(normalized) > 1:
                index.setdefault(normalized[:-1], []).append(entry_id)
        return index

    def _resolve_catalog_entry(
        self,
        ref: Any,
        entries: Dict[str, Dict[str, Any]],
        name_index: Dict[str, List[str]],
        token_cache: Dict[str, set[str]],
    ) -> Optional[Dict[str, Any]]:
        if not ref:
            return None
        lookup_value = ref
        if isinstance(ref, dict):
            lookup_value = ref.get("id") or ref.get("name")
        if lookup_value is None:
            return None
        lookup_str = str(lookup_value)
        direct = entries.get(lookup_str)
        if direct:
            return direct
        normalized = self._normalize_label(lookup_str)
        if normalized:
            for match_id in name_index.get(normalized, []):
                match = entries.get(match_id)
                if match:
                    return match
        tokens = self._tokens_for_label(lookup_str)
        if not tokens:
            return None
        best: Optional[Dict[str, Any]] = None
        best_score = 0.0
        for entry_id, entry in entries.items():
            if entry_id not in token_cache:
                token_cache[entry_id] = self._tokens_for_label(entry.get("name"))
            entry_tokens = token_cache[entry_id]
            if not entry_tokens:
                continue
            overlap = len(tokens & entry_tokens)
            if not overlap:
                continue
            coverage = overlap / len(tokens)
            if coverage >= 1.0:
                return entry
            if coverage > best_score:
                best = entry
                best_score = coverage
        return best if best_score >= 0.5 else None

    def _resolve_flavor(self, ref: Any) -> Optional[Dict[str, Any]]:
        return self._resolve_catalog_entry(ref, self._flavors, self._flavor_name_index, self._flavor_tokens_cache)

    def _resolve_topping(self, ref: Any) -> Optional[Dict[str, Any]]:
        return self._resolve_catalog_entry(ref, self._toppings, self._topping_name_index, self._topping_tokens_cache)

    def _tokenize(self, value: Optional[str]) -> set[str]:
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

    def _product_tokens(self, product: Dict[str, Any]) -> set[str]:
        product_id = product.get("id")
        if product_id and product_id in self._product_tokens_cache:
            return self._product_tokens_cache[product_id]
        tokens: set[str] = set()
        tokens |= self._tokenize(product.get("name"))
        tokens |= self._tokenize(product.get("category"))
        tokens |= self._tokenize(product.get("size"))
        tokens |= self._tokenize(" ".join(product.get("keywords", [])))
        tokens |= self._tokenize(product.get("display"))
        if product_id:
            self._product_tokens_cache[product_id] = tokens
        return tokens

    def _match_query_tokens(self, product: Dict[str, Any], query_tokens: set[str]) -> bool:
        if not query_tokens:
            return True
        product_tokens = self._product_tokens(product)
        return all(token in product_tokens for token in query_tokens)

    def _best_token_match(self, query: str) -> Optional[Dict[str, Any]]:
        tokens = self._tokenize(query)
        if not tokens:
            return None
        for product in self._products.values():
            if self._match_query_tokens(product, tokens):
                return product
        return None

    def _default_free_toppings(self, product: Dict[str, Any]) -> int:
        category = (product.get("category") or "").strip()
        if category == "Sundae Cups":
            included = product.get("includedToppings")
            if included is None:
                return 2
            return int(included)
        if category in {"Cups", "Milk Shakes"}:
            return 0
        return 0

    def _flavor_policy(self) -> Dict[str, Any]:
        return self._kb.get("flavor_policy", {})

    def _topping_policy(self) -> Dict[str, Any]:
        return self._kb.get("toppings_policy", {})

    def _get_or_create_line_state(self, product: Dict[str, Any]) -> Dict[str, Any]:
        product_id = product.get("id")
        if not product_id:
            raise ValueError("Product is missing id")
        line = self._line_state.get(product_id)
        if line:
            return line
        free_flavors = int(product.get("scoops") or 0)
        free_toppings = self._default_free_toppings(product)
        line = {
            "product": product,
            "flavors": [],
            "toppings": [],
            "flavor_summary": {
                "free": free_flavors,
                "used": 0,
                "extra": 0,
                "charge": Decimal("0.00"),
            },
            "topping_summary": {
                "free": free_toppings,
                "used": 0,
                "extra": 0,
                "charge": Decimal("0.00"),
            },
        }
        self._line_state[product_id] = line
        return line

    def _size_options_for(self, product: Dict[str, Any]) -> List[Dict[str, Any]]:
        base_name = (product.get("name") or "").split("—")[0].strip()
        category = product.get("category")
        size_rank = {"Kids": 0, "Small": 0, "Value": 1, "Regular": 1, "Emlaaq": 2, "Large": 2}
        options: List[Dict[str, Any]] = []
        for other in self._products.values():
            if category and other.get("category") != category:
                continue
            other_base = (other.get("name") or "").split("—")[0].strip()
            if base_name and other_base and other_base != base_name:
                continue
            price = other.get("priceAED")
            options.append(
                {
                    "id": other.get("id"),
                    "size": other.get("size"),
                    "priceAED": round(float(price), 2) if price is not None else None,
                }
            )
        options.sort(key=lambda opt: size_rank.get(opt.get("size") or "", 99))
        return options

    def _resolve_product(self, product_id: Optional[str], query: Optional[str]) -> Optional[Dict[str, Any]]:
        if product_id:
            product = self._products.get(product_id)
            if product:
                return product
        if query:
            normalized = query.strip().lower()
            token_match = self._best_token_match(query)
            if token_match:
                return token_match
            for product in self._products.values():
                if normalized in (product.get("id") or "").lower():
                    return product
                if normalized in (product.get("name") or "").lower():
                    return product
        return None

    def _format_flavor_summary(self, line: Dict[str, Any]) -> Dict[str, Any]:
        summary = line.get("flavor_summary", {})
        free = int(summary.get("free", 0))
        used = int(summary.get("used", 0))
        extra = int(summary.get("extra", 0))
        charge = Decimal(summary.get("charge", Decimal("0.00")))
        total_selected = len(line.get("flavors", []))
        denominator = free or total_selected or 0
        label = f"Scoops used: {total_selected} / {denominator}" if denominator else f"Scoops selected: {total_selected}"
        extra_note = None
        if extra > 0:
            extra_note = f"{extra} extra flavor{'s' if extra != 1 else ''} (+{charge} dirham)"
        return {"label": label, "extraNote": extra_note}

    def _format_topping_summary(self, line: Dict[str, Any]) -> Dict[str, Any]:
        summary = line.get("topping_summary", {})
        free_total = int(summary.get("free", 0))
        used = int(summary.get("used", 0))
        extra = int(summary.get("extra", 0))
        charge = Decimal(summary.get("charge", Decimal("0.00")))
        label = f"Free: {used}   Extra: {extra}"
        if extra > 0 and charge > 0:
            label = f"{label} (+{charge} dirham)"
        return {"label": label}

    def _build_product_grid_payload(
        self,
        category: Optional[str],
        size: Optional[str],
        query: Optional[str],
    ) -> Dict[str, Any]:
        cat_filter = (category or "").strip()
        size_filter = self._map_size_alias(size)
        q = (query or "").strip()
        query_tokens = self._tokenize(q)
        products: List[Dict[str, Any]] = []
        for pid in self._product_order or list(self._products.keys()):
            product = self._products.get(pid)
            if not product:
                continue
            if cat_filter and product.get("category") != cat_filter:
                continue
            if size_filter and (product.get("size") or "").lower() != size_filter.lower():
                continue
            if q and not self._match_query_tokens(product, query_tokens):
                continue
            products.append(self._format_product_card(product))
        return {
            "kind": "products",
            "view": "grid",
            "category": cat_filter or "All",
            "size": size_filter,
            "query": query,
            "products": products,
            "cartSummary": self._cart_summary,
        }

    def _build_product_detail_payload(self, product: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "kind": "products",
            "view": "detail",
            "products": [],
        }
        if not product:
            return payload
        card = self._format_product_card(product)
        line = self._get_or_create_line_state(product)
        payload.update(
            {
                "product": card,
                "products": [card],
                "selectedFlavors": line.get("flavors", []),
                "selectedToppings": line.get("toppings", []),
                "flavorSummary": self._format_flavor_summary(line),
                "toppingSummary": self._format_topping_summary(line),
                "sizeOptions": self._size_options_for(product),
                "contextProductId": product.get("id"),
                "cartSummary": self._cart_summary,
            }
        )
        return payload

    def _recompute_cart_summary(self) -> Dict[str, Any]:
        subtotal = Decimal("0.00")
        for item in self._cart_items:
            subtotal += Decimal(str(item.get("lineTotalAED", 0.0)))
        subtotal = subtotal.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        tax = (subtotal * Decimal("0.07")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        total = (subtotal + tax).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        summary = {
            "subtotalAED": float(subtotal),
            "taxAED": float(tax),
            "totalAED": float(total),
        }
        self._cart_summary = summary
        return summary
    @function_tool(
        name="list_menu",
        description=(
            "Render kiosk overlays. kind='products' | 'flavors' | 'toppings'. "
            "Products accept optional category ('Cups'|'Sundae Cups'|'Milk Shakes'), size (Kids/Value/Emlaaq/Regular/Large), "
            "query text, view ('grid'|'detail'), and product_id when focusing on a single card."
        ),
    )
    async def list_menu(
        self,
        kind: str,
        category: Optional[str] = None,
        size: Optional[str] = None,
        query: Optional[str] = None,
        view: Optional[str] = None,
        product_id: Optional[str] = None,
        ctx: "RunCtxParam" = None,
    ) -> Dict[str, Any]:
        kind_normalized = (kind or "").strip().lower()
        if kind_normalized == "products":
            view_mode = (view or "").strip().lower()
            if view_mode not in {"grid", "detail"}:
                view_mode = "grid"
            target_product = None
            if view_mode == "detail" or product_id:
                target_product = self._resolve_product(product_id or self._active_product_id, query)
                if not target_product and query:
                    target_product = self._resolve_product(None, query)
                if not target_product and self._product_order:
                    target_product = self._products.get(self._product_order[0])
                if target_product:
                    self._active_product_id = target_product.get("id")
                    payload = self._build_product_detail_payload(target_product)
                else:
                    payload = self._build_product_grid_payload(category, size, query)
                view_mode = "detail"
            else:
                payload = self._build_product_grid_payload(category, size, query)
            payload["view"] = view_mode
            await self._publish_overlay_for_ctx(ctx, "products", payload)
            return payload

        if kind_normalized == "flavors":
            product = self._resolve_product(product_id or self._active_product_id, None)
            if not product:
                payload = {"kind": "flavors", "flavors": []}
                await self._publish_overlay_for_ctx(ctx, "flavors", payload)
                return payload
            line = self._get_or_create_line_state(product)
            free_flavors = int(product.get("scoops") or 0)
            max_flavors = max(free_flavors, len(line.get("flavors", [])))
            payload = {
                "kind": "flavors",
                "productId": product.get("id"),
                "productName": product.get("name"),
                "freeFlavors": free_flavors,
                "maxFlavors": max_flavors,
                "selectedFlavorIds": [f.get("id") for f in line.get("flavors", []) if f.get("id")],
                "selectedFlavors": line.get("flavors", []),
                "usedFreeFlavors": int(line.get("flavor_summary", {}).get("used", 0)),
                "extraFlavorCount": int(line.get("flavor_summary", {}).get("extra", 0)),
                "flavors": [self._format_flavor_card(f) for f in self._kb.get("flavors", [])],
            }
            await self._publish_overlay_for_ctx(ctx, "flavors", payload)
            return payload

        if kind_normalized == "toppings":
            product = self._resolve_product(product_id or self._active_product_id, None)
            if not product:
                payload = {"kind": "toppings", "toppings": []}
                await self._publish_overlay_for_ctx(ctx, "toppings", payload)
                return payload
            line = self._get_or_create_line_state(product)
            topping_summary = line.get("topping_summary", {})
            free_total = int(topping_summary.get("free", 0))
            free_used = int(topping_summary.get("used", 0))
            free_remaining = max(free_total - free_used, 0)
            category = product.get("category")
            if category == "Cups":
                note = "No free toppings; all toppings are charged."
            elif category == "Milk Shakes":
                note = "You can add any number of toppings; each topping is charged."
            else:
                note = None
            payload = {
                "kind": "toppings",
                "productId": product.get("id"),
                "productName": product.get("name"),
                "category": category,
                "note": note,
                "freeToppings": free_total,
                "freeToppingsRemaining": free_remaining,
                "selectedToppingIds": [t.get("id") for t in line.get("toppings", []) if t.get("id")],
                "selectedToppings": line.get("toppings", []),
                "toppings": [self._format_topping_card(t) for t in self._kb.get("toppings", [])],
            }
            await self._publish_overlay_for_ctx(ctx, "toppings", payload)
            return payload

        return {"error": "invalid kind"}
    @function_tool(
        name="choose_flavors",
        description=(
            "Attach selected flavors (by flavor_ids) to a specific product (product_id). "
            "Enforces the max scoop count defined for that product. "
            "Returns the flavors bound to that line, including their names."
        ),
    )
    async def choose_flavors(self, product_id: str, flavor_ids: List[str], ctx: "RunCtxParam" = None) -> Dict[str, Any]:
        product = self._products.get(product_id)
        if not product:
            return {"error": f"Unknown product '{product_id}'"}
        line = self._get_or_create_line_state(product)
        free_flavors = int(product.get("scoops") or 0)
        policy = self._flavor_policy()
        extra_price = Decimal(str(policy.get("defaultFlavorPriceAED", 0.0)))
        selected: List[Dict[str, Any]] = []
        resolved_flavors: List[Dict[str, Any]] = []
        for raw in flavor_ids:
            flavor = self._resolve_flavor(raw)
            if flavor:
                resolved_flavors.append(flavor)
        for idx, flavor in enumerate(resolved_flavors):
            is_extra = free_flavors <= 0 or idx >= free_flavors
            selected.append(
                {
                    "id": flavor["id"],
                    "name": flavor["name"],
                    "classification": flavor.get("classification"),
                    "imageUrl": flavor.get("imageUrl") or self._kb["image_defaults"]["square"],
                    "isExtra": is_extra,
                }
            )
        used_free = min(free_flavors, len(selected)) if free_flavors else 0
        extra_count = max(len(selected) - free_flavors, 0) if free_flavors else len(selected)
        extra_charge = (extra_price * extra_count).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if extra_count else Decimal("0.00")
        line["flavors"] = selected
        line["flavor_summary"] = {
            "free": free_flavors,
            "used": used_free,
            "extra": extra_count,
            "charge": extra_charge,
        }
        detail_payload = self._build_product_detail_payload(product)
        await self._publish_overlay_for_ctx(ctx, "products", detail_payload)
        return {
            "product_id": product_id,
            "productName": product.get("name"),
            "size": product.get("size"),
            "scoops": free_flavors,
            "selectedFlavors": selected,
            "freeFlavors": free_flavors,
            "usedFreeFlavors": used_free,
            "extraFlavorCount": extra_count,
            "extraFlavorChargeAED": float(extra_charge),
            "uiSummary": self._format_flavor_summary(line),
        }
    @function_tool(
        name="choose_toppings",
        description=(
            "Attach selected toppings (by topping_ids) to a product line. "
            "Respects any includedToppings for that product (free toppings) and charges extras using topping priceAED. "
            "Returns toppings list, number free, and charged AED."
        ),
    )
    async def choose_toppings(self, product_id: str, topping_ids: List[str], ctx: "RunCtxParam" = None) -> Dict[str, Any]:
        product = self._products.get(product_id)
        if not product:
            return {"error": f"Unknown product '{product_id}'"}
        line = self._get_or_create_line_state(product)
        free_total = self._default_free_toppings(product)
        policy = self._topping_policy()
        default_price = Decimal(str(policy.get("extraToppingPriceAED", 5.0)))
        selected: List[Dict[str, Any]] = []
        resolved_toppings: List[Dict[str, Any]] = []
        free_remaining = free_total
        extra_count = 0
        extra_charge = Decimal("0.00")
        for raw in topping_ids:
            topping = self._resolve_topping(raw)
            if topping:
                resolved_toppings.append(topping)
        for topping in resolved_toppings:
            price = Decimal(str(topping.get("priceAED") or default_price))
            is_free = free_remaining > 0
            if is_free:
                free_remaining -= 1
            else:
                extra_count += 1
                extra_charge += price
            selected.append(
                {
                    "id": topping["id"],
                    "name": topping["name"],
                    "priceAED": round(float(price), 2),
                    "imageUrl": topping.get("imageUrl") or self._kb["image_defaults"]["square"],
                    "isFree": is_free,
                }
            )
        extra_charge = extra_charge.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        free_used = free_total - free_remaining
        line["toppings"] = selected
        line["topping_summary"] = {
            "free": free_total,
            "used": free_used,
            "extra": extra_count,
            "charge": extra_charge,
        }
        detail_payload = self._build_product_detail_payload(product)
        await self._publish_overlay_for_ctx(ctx, "products", detail_payload)
        return {
            "product_id": product_id,
            "productName": product.get("name"),
            "category": product.get("category"),
            "selectedToppings": selected,
            "freeToppingsTotal": free_total,
            "freeToppingsUsed": free_used,
            "extraToppingsCount": extra_count,
            "extraToppingsChargeAED": float(extra_charge),
            "uiSummary": self._format_topping_summary(line),
        }
    @function_tool(
        name="add_to_cart",
        description=(
            "Add a Baskin Robbins product to the cart (by product_id and qty). "
            "Merges any staged flavors and toppings for that line. "
            "Recomputes subtotal, 7% tax, and total in AED and returns the full cart summary."
        ),
    )
    async def add_to_cart(self, product_id: str, qty: int = 1, ctx: "RunCtxParam" = None) -> Dict[str, Any]:
        product = self._products.get(product_id)
        if not product:
            product = self._resolve_product(None, product_id)
            if product:
                product_id = product.get("id", product_id)
        if not product:
            return {"error": f"Unknown product '{product_id}'", "cart": {"items": [], **self._cart_summary}}

        qty = max(1, int(qty))
        line = self._get_or_create_line_state(product)
        base_price = Decimal(str(product.get("priceAED") or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        flavor_extra = Decimal(str(line.get("flavor_summary", {}).get("charge", Decimal("0.00")))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        topping_extra = Decimal(str(line.get("topping_summary", {}).get("charge", Decimal("0.00")))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        unit_total = (base_price + flavor_extra + topping_extra).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        line_total = (unit_total * qty).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        flavor_extra_total = (flavor_extra * qty).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        topping_extra_total = (topping_extra * qty).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        base_total = (base_price * qty).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

        flavors_simple = [{"id": f.get("id"), "name": f.get("name")} for f in line.get("flavors", []) if f.get("id")]
        toppings_simple = [
            {
                "id": t.get("id"),
                "name": t.get("name"),
                "isFree": bool(t.get("isFree")),
                "priceAED": t.get("priceAED"),
            }
            for t in line.get("toppings", [])
            if t.get("id")
        ]
        display_name = self._canonical_display(product.get("display"))
        cart_line = {
            "lineId": secrets.token_hex(4),
            "product_id": product_id,
            "name": product.get("name"),
            "category": product.get("category"),
            "size": product.get("size"),
            "imageUrl": product.get("imageUrl"),
            "qty": qty,
            "flavors": flavors_simple,
            "toppings": toppings_simple,
            "basePriceAED": float(base_total),
            "flavorExtrasAED": float(flavor_extra_total),
            "toppingExtrasAED": float(topping_extra_total),
            "lineTotalAED": float(line_total),
            "display": display_name,
        }
        self._cart_items.append(cart_line)
        summary = self._recompute_cart_summary()
        summary["message"] = "Grab and pay at the counter!"
        cart_payload = {
            "items": self._cart_items,
            "subtotalAED": summary["subtotalAED"],
            "taxAED": summary["taxAED"],
            "totalAED": summary["totalAED"],
            "message": summary["message"],
        }
        await self._publish_overlay_for_ctx(ctx, "cart", {"cart": cart_payload})
        return {"cart": cart_payload}
    @function_tool(
        name="recommend_upgrade",
        description=(
            "Check if a Cup product with many paid toppings should be suggested to upgrade to a Sundae Cup of the same size. "
            "Returns recommend=True/False and the suggested sundae product_id if applicable."
        ),
    )
    async def recommend_upgrade(self, product_id: str, ctx: "RunCtxParam" = None) -> Dict[str, Any]:
        product = self._products.get(product_id)
        if not product or product.get("category") != "Cups":
            return {"show": False}

        line = self._line_state.get(product_id)
        if not line:
            return {"show": False}
        topping_summary = line.get("topping_summary", {})
        upcharge = Decimal(str(topping_summary.get("charge", "0"))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if upcharge < Decimal("4.00"):
            return {"show": False}

        size = product.get("size")
        target = None
        for candidate in self._products.values():
            if (
                candidate.get("category") == "Sundae Cups"
                and candidate.get("size") == size
                and candidate.get("scoops") == product.get("scoops")
            ):
                target = candidate
                break
        if not target:
            return {"show": False}

        from_card = self._format_product_card(product)
        to_card = self._format_product_card(target)
        current_price = Decimal(str(product.get("priceAED") or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        target_price = Decimal(str(target.get("priceAED") or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        price_diff = (target_price - current_price).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        savings = max(upcharge - price_diff, Decimal("0.00")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        response = {
            "show": True,
            "fromProduct": from_card,
            "toProduct": {
                **to_card,
                "headline": target.get("name"),
                "subline": "More scoops + 2 free toppings" if target.get("category") == "Sundae Cups" else "Extra value for your toppings",
            },
            "priceDiffAED": float(price_diff),
            "savingsEstimateAED": float(savings),
            "uiCopy": {
                "bannerTitle": "Better Value Suggestion",
                "primaryCtaLabel": f"Upgrade to {target.get('name')}",
                "secondaryCtaLabel": "Keep Current Choice",
            },
        }
        await self._publish_overlay_for_ctx(ctx, "upgrade", response)
        return response
    @function_tool(
        name="get_directions",
        description=(
            "Get wayfinding information for a display area like 'Beverage Corner' or 'Gelato Bar'. "
            "Emits client.directions(action='show') and clears products."
        ),
    )
    async def get_directions(
        self,
        display_name: str,
        extra_displays: Optional[List[str]] = None,
        ctx: "RunCtxParam" = None,
    ) -> Dict[str, Any]:
        displays = []
        primary = (display_name or "").strip()
        if primary:
            displays.append(primary)
        for extra in extra_displays or []:
            if extra and extra not in displays:
                displays.append(extra)
        if not displays and primary:
            displays.append(primary)
        kb_displays = self._kb.get("displays", {})
        locations: List[Dict[str, Any]] = []
        for name in displays:
            record = kb_displays.get(name)
            canonical = self._canonical_display(name)
            products_here = [
                item.get("name")
                for item in self._cart_items
                if canonical and item.get("display") == canonical
            ]
            locations.append(
                {
                    "displayName": (record or {}).get("displayName") or canonical or name,
                    "hint": (record or {}).get("hint"),
                    "mapImage": (record or {}).get("mapImage"),
                    "products": [p for p in products_here if p],
                }
            )
        payload = {"locations": locations}
        await self._publish_overlay_for_ctx(ctx, "directions", payload)
        await self._emit_client_rpc(ctx, "client.directions", {"action": "show", "locations": locations})
        return payload
# =====================
# Worker Entrypoint
# =====================
async def entrypoint(ctx: JobContext) -> None:
    config = CONFIG
    job_id = ctx.job.id if ctx.job else None
    agent_identity = config.agent_identity(job_id)
    controller_identity = config.controller_identity(job_id)

    await ctx.connect()
    await ctx.wait_for_participant()

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

    session = AgentSession(llm=llm, resume_false_interruption=False)

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

    tools = ScoopTools(config, session, ctx.room, controller_identity)

    async def handle_add_to_cart_rpc(rpc_data) -> str:
        try:
            payload_raw = rpc_data.payload or "{}"
            payload = json.loads(payload_raw)
            product_id = payload.get("productId") or payload.get("product_id")
            qty = int(payload.get("qty", 1))
            if not product_id:
                return "missing productId"
            await tools.add_to_cart(str(product_id), qty, None)
            return "ok"
        except Exception as exc:  # noqa: BLE001
            logger.exception("agent.addToCart RPC error: %s", exc)
            return f"error: {exc}"

    ctx.room.local_participant.register_rpc_method("agent.addToCart", handle_add_to_cart_rpc)

    agent = Agent(
        instructions=SCOOP_PROMPT,
        tools=[
            tools.list_menu,
            tools.choose_flavors,
            tools.choose_toppings,
            tools.add_to_cart,
            tools.recommend_upgrade,
            tools.get_directions,
        ],
    )

    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(video_enabled=False, audio_enabled=True),
        room_output_options=RoomOutputOptions(audio_enabled=True),
    )

    await session.generate_reply(
        instructions="Greet the guest as Sarah from Baskin Robbins, ask about their mood, and offer Cup, Sundae Cup, or Milkshake."
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
    await req.accept(
        name=config.agent_name,
        identity=controller_identity,
        metadata=json.dumps(metadata),
        attributes=attributes,
    )

# =========
# __main__
# =========
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


