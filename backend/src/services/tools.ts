import type { AssistantEvent, CartItem, Product } from "../types";
import { env } from "../config/env";
import { logger } from "../utils/logger";

const DEFAULT_PRODUCTS: Product[] = [
  {
    id: "p1",
    name: "Chocolate Cone",
    description: "Classic cocoa-dipped waffle cone with rich chocolate ice cream.",
    priceCents: 1200,
    imageUrl: "/assets/products/chocolate-cone.png",
    bin: "FZ-A2-B4",
  },
  {
    id: "p2",
    name: "Vanilla Cup",
    description: "Madagascar vanilla in a single-serve cup.",
    priceCents: 900,
    imageUrl: "/assets/products/vanilla-cup.png",
    bin: "FZ-B1-A1",
  },
  {
    id: "p3",
    name: "Strawberry Pint",
    description: "Fresh strawberry compote folded into creamy goodness.",
    priceCents: 1800,
    imageUrl: "/assets/products/strawberry-pint.png",
    bin: "FZ-A2-C2",
  },
];

const priceLookup = new Map(DEFAULT_PRODUCTS.map((product) => [product.id, product.priceCents]));
const DEFAULT_PRODUCT = DEFAULT_PRODUCTS[0]!;

const callWebhook = async <T>(url: string | undefined, payload: unknown): Promise<T | null> => {
  if (!url) {
    return null;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new Error(message || `Webhook request failed with status ${response.status}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    logger.warn("Integration webhook request failed", {
      url,
      error,
    });
    return null;
  }
};

const normalizeProduct = (raw: Record<string, unknown>): Product => {
  const id = String(raw.id ?? "").trim();
  const name = String(raw.name ?? DEFAULT_PRODUCT.name);
  const description = raw.description ? String(raw.description) : undefined;
  const priceCandidate =
    typeof raw.priceCents === "number"
      ? raw.priceCents
      : typeof raw.price_cents === "number"
        ? (raw.price_cents as number)
        : undefined;
  const priceCents = Number.isFinite(priceCandidate) ? Number(priceCandidate) : DEFAULT_PRODUCT.priceCents;
  const imageUrl =
    typeof raw.imageUrl === "string"
      ? raw.imageUrl
      : typeof raw.image_url === "string"
        ? (raw.image_url as string)
        : "/assets/products/placeholder.png";
  const bin = typeof raw.bin === "string" && raw.bin ? (raw.bin as string) : DEFAULT_PRODUCT.bin;

  return {
    id: id || DEFAULT_PRODUCT.id,
    name,
    description,
    priceCents,
    imageUrl,
    bin,
  };
};

const fallBackProducts = (query: string): Product[] => {
  const q = query.trim().toLowerCase();
  if (!q) {
    return DEFAULT_PRODUCTS;
  }

  return DEFAULT_PRODUCTS.filter((product) => {
    const name = product.name.toLowerCase();
    const description = product.description?.toLowerCase() ?? "";
    return (
      name.includes(q) ||
      description.includes(q) ||
      q.split(/\s+/).some((term) => name.includes(term))
    );
  });
};

const fetchProducts = async (query: string): Promise<Product[]> => {
  const remote = await callWebhook<{ products?: Record<string, unknown>[] }>(
    env.integrations.productsWebhook,
    { query },
  );

  if (remote?.products && Array.isArray(remote.products) && remote.products.length > 0) {
    return remote.products.map(normalizeProduct);
  }

  return fallBackProducts(query);
};

const updateCart = (cart: CartItem[], productId: string, qty: number): CartItem[] => {
  const normalizedQty = Math.max(1, qty);
  const price = priceLookup.get(productId) ?? DEFAULT_PRODUCT.priceCents;

  const existingIndex = cart.findIndex((item) => item.id === productId);
  if (existingIndex >= 0) {
    return cart.map((item, index) =>
      index === existingIndex
        ? {
            ...item,
            qty: item.qty + normalizedQty,
          }
        : item,
    );
  }

  return [
    ...cart,
    {
      id: productId,
      qty: normalizedQty,
      priceCents: price,
    },
  ];
};

const computeTotals = async (cart: CartItem[]) => {
  const remote = await callWebhook<{
    subtotal?: number;
    tax?: number;
    total?: number;
  }>(env.integrations.checkoutWebhook, { cart });

  if (remote && typeof remote.total === "number") {
    return {
      subtotal: Number(remote.subtotal ?? 0),
      tax: Number(remote.tax ?? 0),
      total: Number(remote.total),
    };
  }

  const subtotal = cart.reduce((sum, item) => sum + item.qty * item.priceCents, 0);
  const tax = Math.round(subtotal * 0.05);
  const total = subtotal + tax;
  return { subtotal, tax, total };
};

const directionsForBin = async (bin: string) => {
  const remote = await callWebhook<{
    display_name?: string;
    steps?: string[];
    bin?: string;
    map_svg_url?: string;
  }>(env.integrations.directionsWebhook, { bin });

  if (remote) {
    return {
      displayName: remote.display_name ?? remote.bin ?? DEFAULT_PRODUCT.bin,
      steps:
        Array.isArray(remote.steps) && remote.steps.length > 0
          ? remote.steps
          : [
              "Walk straight 5 meters past the central display.",
              "Turn left at the freezer aisle.",
              `Locate bin ${bin} on the second shelf.`,
            ],
      bin: remote.bin ?? bin,
      mapSvgUrl: remote.map_svg_url ?? undefined,
    };
  }

  const fallback = DEFAULT_PRODUCTS.find((item) => item.bin === bin);
  return {
    displayName: fallback
      ? `${fallback.name} pickup at freezer bin ${fallback.bin}`
      : `Pickup at freezer bin ${bin}`,
    steps: [
      "Walk straight 5 meters past the central display.",
      "Turn left at the freezer aisle.",
      `Locate bin ${bin} on the second shelf.`,
    ],
    bin,
    mapSvgUrl: "/assets/maps/icecream-aisle.svg",
  };
};

export const assistantTools = {
  definition: [
    {
      type: "function" as const,
      function: {
        name: "find_products",
        description: "Search the ice-cream catalog using a natural language query.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The keywords describing the product or flavor the guest wants.",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "add_to_cart",
        description: "Add a product to the guest's cart with a quantity.",
        parameters: {
          type: "object",
          properties: {
            product_id: {
              type: "string",
              description: "The product identifier to add to the cart.",
            },
            qty: {
              type: "integer",
              description: "How many units should be added.",
              minimum: 1,
            },
          },
          required: ["product_id", "qty"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "checkout",
        description: "Summarise the cart totals with tax for the guest.",
        parameters: {
          type: "object",
          properties: {
            cart: {
              type: "array",
              description: "Current cart contents.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  qty: { type: "integer" },
                  price_cents: { type: "integer" },
                },
                required: ["id", "qty", "price_cents"],
              },
            },
          },
          required: ["cart"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "get_directions",
        description: "Describe how to reach the freezer bin for pickup.",
        parameters: {
          type: "object",
          properties: {
            bin: {
              type: "string",
              description: "The freezer bin code, for example FZ-A2-B4.",
            },
          },
          required: ["bin"],
        },
      },
    },
  ],
  handle: async (
    name: string,
    args: Record<string, unknown>,
    cart: CartItem[],
  ): Promise<ToolCallResult> => {
    switch (name) {
      case "find_products": {
        const query = String(args.query ?? "");
        const products = await fetchProducts(query);
        const spokenPrompt =
          products.length > 0
            ? "Here are some choices that match what you're craving."
            : "I couldn't find an exact match, but here are some popular treats.";
        return {
          output: { products },
          event: {
            type: "show_products",
            products,
            spokenPrompt,
          },
        };
      }
      case "add_to_cart": {
        const productId = String(args.product_id ?? DEFAULT_PRODUCT.id);
        const qty = Number.isFinite(args.qty) ? Number(args.qty) : 1;
        const updatedCart = updateCart(cart, productId, qty);
        return {
          output: { cart: updatedCart },
          event: {
            type: "add_to_cart",
            cart: updatedCart,
            productId,
            qty,
            spokenPrompt: "All set. I've added that to your order.",
          },
          updatedCart,
        };
      }
      case "checkout": {
        const normalizedCart: CartItem[] = Array.isArray(args.cart)
          ? (args.cart as Array<Record<string, unknown>>).map((item) => {
              const id = String(item.id ?? "") || DEFAULT_PRODUCT.id;
              const qty = Number(item.qty ?? 1) || 1;
              const rawPrice = item.priceCents;
              const legacyPrice = item["price_cents"];
              const priceCents =
                typeof rawPrice === "number"
                  ? rawPrice
                  : typeof legacyPrice === "number"
                    ? (legacyPrice as number)
                    : priceLookup.get(id) ?? DEFAULT_PRODUCT.priceCents;
              return { id, qty, priceCents };
            })
          : cart;

        const totals = await computeTotals(normalizedCart);
        return {
          output: { receipt: totals },
          event: {
            type: "checkout",
            receipt: totals,
            spokenPrompt: `Your total comes to $${(totals.total / 100).toFixed(2)}. Would you like anything else?`,
          },
        };
      }
      case "get_directions": {
        const bin = String(args.bin ?? DEFAULT_PRODUCT.bin);
        const directions = await directionsForBin(bin);
        return {
          output: directions,
          event: {
            type: "directions",
            directions,
            spokenPrompt: `You'll find it at ${directions.displayName}.`,
          },
        };
      }
      default:
        return {
          output: { acknowledged: true },
          event: { type: "chat", spokenPrompt: "Got it. Let me know what you'd like next." },
        };
    }
  },
};

export { DEFAULT_PRODUCTS as PRODUCTS };
