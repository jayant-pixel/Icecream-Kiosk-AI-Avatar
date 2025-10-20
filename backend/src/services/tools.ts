import type { AssistantEvent, CartItem, Product } from "../types";
import { env } from "../config/env";
import { logger } from "../utils/logger";

type ToolCallResult = {
  output: unknown;
  event: AssistantEvent;
  updatedCart?: CartItem[];
};

const PLACEHOLDER_IMAGE = "https://dummyimage.com/320x320/ede9ff/4b3cc4&text=Scoop+Haven";

const DEFAULT_PRODUCTS: Product[] = [
  {
    id: "p1",
    name: "Chocolate Cone",
    description: "Classic cocoa-dipped waffle cone with rich chocolate ice cream.",
    priceCents: 1200,
    imageUrl: PLACEHOLDER_IMAGE,
    displayNames: ["Freezer A2 - Upper Shelf"],
    primaryDisplayName: "Freezer A2 - Upper Shelf",
  },
  {
    id: "p2",
    name: "Vanilla Cup",
    description: "Madagascar vanilla in a single-serve cup.",
    priceCents: 900,
    imageUrl: PLACEHOLDER_IMAGE,
    displayNames: ["Front Counter Chill Case"],
    primaryDisplayName: "Front Counter Chill Case",
  },
  {
    id: "p3",
    name: "Strawberry Pint",
    description: "Fresh strawberry compote folded into creamy goodness.",
    priceCents: 1800,
    imageUrl: PLACEHOLDER_IMAGE,
    displayNames: ["Freezer A3 - Middle Shelf"],
    primaryDisplayName: "Freezer A3 - Middle Shelf",
  },
];

const priceLookup = new Map<string, number>();
const displayNameLookup = new Map<string, string>();
const locationLookup = new Map<string, string>();

const registerProduct = (product: Product) => {
  priceLookup.set(product.id, product.priceCents);
  displayNameLookup.set(product.id, product.primaryDisplayName);
  product.displayNames.forEach((location) => {
    const normalized = location.toLowerCase();
    if (!locationLookup.has(normalized)) {
      locationLookup.set(normalized, location);
    }
  });
};

DEFAULT_PRODUCTS.forEach(registerProduct);

const DEFAULT_PRODUCT = DEFAULT_PRODUCTS[0]!;
const DEFAULT_DIRECTIONS_HINT =
  "Head to the main freezer aisle and follow the signage for Scoop Haven displays.";

const callWebhook = async <T>(
  url: string | undefined,
  payload: Record<string, unknown>,
): Promise<T | null> => {
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

const ensureDisplayNames = (names: unknown): { list: string[]; primary: string } => {
  if (Array.isArray(names)) {
    const cleaned = names
      .map((value) => (typeof value === "string" ? value.trim() : String(value ?? "")))
      .filter((value) => value.length > 0);
    if (cleaned.length > 0) {
      return { list: cleaned, primary: cleaned[0]! };
    }
  }

  if (typeof names === "string" && names.trim().length > 0) {
    const trimmed = names.trim();
    return {
      list: [trimmed],
      primary: trimmed,
    };
  }

  return {
    list: [DEFAULT_PRODUCT.primaryDisplayName],
    primary: DEFAULT_PRODUCT.primaryDisplayName,
  };
};

const normalizeProduct = (raw: Record<string, unknown>): Product => {
  const id = String(raw.id ?? "").trim() || DEFAULT_PRODUCT.id;
  const name = String(raw.name ?? DEFAULT_PRODUCT.name);
  const description = raw.description ? String(raw.description) : undefined;
  const priceCandidate =
    typeof raw.priceCents === "number"
      ? raw.priceCents
      : typeof raw.price_cents === "number"
        ? Number(raw.price_cents)
        : undefined;
  const priceCents = Number.isFinite(priceCandidate) ? Number(priceCandidate) : DEFAULT_PRODUCT.priceCents;
  const imageUrl =
    typeof raw.imageUrl === "string"
      ? raw.imageUrl
      : typeof raw.image_url === "string"
        ? String(raw.image_url)
        : PLACEHOLDER_IMAGE;

  const { list: displayNames, primary: primaryDisplayName } = ensureDisplayNames(raw.displayName);

  const product: Product = {
    id,
    name,
    priceCents,
    imageUrl,
    displayNames,
    primaryDisplayName,
    ...(description ? { description } : {}),
  };

  registerProduct(product);
  return product;
};

const fallBackProducts = (query: string): Product[] => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return DEFAULT_PRODUCTS;
  }

  return DEFAULT_PRODUCTS.filter((product) => {
    const name = product.name.toLowerCase();
    const description = product.description?.toLowerCase() ?? "";
    return (
      name.includes(trimmed) ||
      description.includes(trimmed) ||
      trimmed.split(/\s+/).some((term) => name.includes(term))
    );
  });
};

const fetchProducts = async (query: string): Promise<Product[]> => {
  const requestText = query.trim()
    ? `Guest request: "${query}". Respond with JSON { "products": [...] } where each product includes id, name, description, priceCents (integer cents), imageUrl, and displayName array describing the display locations.`
    : "Provide a curated list of popular Scoop Haven treats with the fields id, name, description, priceCents, imageUrl, and displayName array.";

  const remote = await callWebhook<{ products?: Record<string, unknown>[] }>(
    env.integrations.productsWebhook,
    {
      webhook: "products",
      query: requestText,
    },
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

const directionsForDisplay = async (displayName: string) => {
  const normalized =
    locationLookup.get(displayName.toLowerCase()) ??
    displayNameLookup.get(displayName) ??
    displayName;

  const location = (normalized && normalized.trim()) || DEFAULT_PRODUCT.primaryDisplayName;

  const remote = await callWebhook<{
    directions?: Array<{ displayName?: string; mapImage?: string; hint?: string }>;
  }>(env.integrations.directionsWebhook, {
    webhook: "directions",
    displayName: location,
    query: `Guest needs pickup guidance for "${location}". Respond with JSON { "directions": [ { "displayName": "...", "mapImage": "...", "hint": "..." } ] }.`,
  });

  if (remote?.directions && Array.isArray(remote.directions) && remote.directions.length > 0) {
    const [first] = remote.directions;
    const response: { displayName: string; hint?: string; mapImage?: string } = {
      displayName:
        (typeof first?.displayName === "string" && first.displayName.trim().length > 0
          ? first.displayName.trim()
          : location),
    };

    if (typeof first?.hint === "string" && first.hint.trim().length > 0) {
      response.hint = first.hint.trim();
    }

    if (typeof first?.mapImage === "string" && first.mapImage.trim().length > 0) {
      response.mapImage = first.mapImage.trim();
    }

    return response;
  }

  return {
    displayName: location,
    hint: DEFAULT_DIRECTIONS_HINT,
    steps: [
      "Head toward the main freezer aisle.",
      `Follow the signage for "${location}".`,
      "The display will be highlighted with Scoop Haven branding.",
    ],
  };
};

export const assistantTools = {
  definition: [
    {
      type: "function" as const,
      function: {
        name: "find_products",
        description:
          "Search the ice-cream catalogue and return menu items with pricing and display locations.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural language request describing flavours or products the guest wants.",
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
        name: "get_directions",
        description: "Describe how to reach the product's display location inside the store.",
        parameters: {
          type: "object",
          properties: {
            display_name: {
              type: "string",
              description: "The display name or location provided with the product recommendation.",
            },
          },
          required: ["display_name"],
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
        const displayName = displayNameLookup.get(productId);
        const spokenPrompt = displayName
          ? `All set. ${displayName} has been added to your order.`
          : "All set. I've added that to your order.";
        const event: AssistantEvent = displayName
          ? {
              type: "add_to_cart",
              cart: updatedCart,
              productId,
              qty,
              displayName,
              spokenPrompt,
            }
          : {
              type: "add_to_cart",
              cart: updatedCart,
              productId,
              qty,
              spokenPrompt,
            };
        return {
          output: { cart: updatedCart },
          event,
          updatedCart,
        };
      }
      case "get_directions": {
        const displayName = String(args.display_name ?? DEFAULT_PRODUCT.primaryDisplayName);
        const directions = await directionsForDisplay(displayName);
        return {
          output: directions,
          event: {
            type: "directions",
            directions,
            spokenPrompt: directions.hint
              ? directions.hint
              : `You'll find it at ${directions.displayName}.`,
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
