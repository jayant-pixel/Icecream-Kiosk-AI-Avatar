import express from "express";
import fetch from "node-fetch";
import multer from "multer";
import dotenv from "dotenv";
import { File } from "node:buffer";
import { OpenAI } from "openai";

dotenv.config();

const app = express();
app.use(express.json());

const HEYGEN_API = process.env.HEYGEN_BASE_URL || "https://api.heygen.com";
const HEYGEN_KEY = process.env.HEYGEN_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MAKE_PRODUCTS_HOOK = process.env.MAKE_PRODUCTS_HOOK;
const MAKE_ORDER_HOOK = process.env.MAKE_ORDER_HOOK;

if (!HEYGEN_KEY) {
  throw new Error("Missing HEYGEN_API_KEY environment variable");
}
if (!OPENAI_KEY) {
  throw new Error("Missing OPENAI_API_KEY environment variable");
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

app.post("/api/session/new", async (req, res) => {
  try {
    const { avatarId, language = "en", quality = "high" } = req.body || {};
    if (!avatarId) {
      return res.status(400).json({ error: "avatarId is required" });
    }

    const response = await fetch(`${HEYGEN_API}/v1/streaming.new`, {
      method: "POST",
      headers: {
        "x-api-key": HEYGEN_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        avatar_id: avatarId,
        version: "v3",
        language,
        quality,
        voice_mode: false,
        voice_auto_start: false,
      }),
    });

    const data = await response.json();
    if (!response.ok || !data?.data) {
      return res.status(500).json({ error: data });
    }

    const { session_id, livekit_url, access_token } = data.data;
    res.json({ sessionId: session_id, livekitUrl: livekit_url, accessToken: access_token });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "session.new failed" });
  }
});

app.post("/api/avatar/speak", async (req, res) => {
  try {
    const { sessionId, text } = req.body || {};
    if (!sessionId || !text) {
      return res.status(400).json({ error: "sessionId and text are required" });
    }

    const response = await fetch(`${HEYGEN_API}/v1/streaming.task`, {
      method: "POST",
      headers: {
        "x-api-key": HEYGEN_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: sessionId, task_type: "talk", text }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data });
    }

    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "speak failed" });
  }
});

const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/stt/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "missing audio" });
    }

    const audioFile = new File([req.file.buffer], req.file.originalname || "input.webm", {
      type: req.file.mimetype,
    });

    const transcript = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
    });

    res.json({ text: transcript.text });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "stt failed" });
  }
});

type CartItem = { id: string; qty: number; price_cents: number };
type Product = {
  id: string;
  name: string;
  price_cents: number;
  image_url: string;
  bin: string;
};

type Directions = {
  display_name: string;
  steps: string[];
  bin: string;
  map_svg_url: string;
};

const PRODUCTS: Product[] = [
  {
    id: "p1",
    name: "Chocolate Cone",
    price_cents: 12000,
    image_url: "/img/choc_cone.svg",
    bin: "FZ-A2-B4",
  },
  {
    id: "p2",
    name: "Vanilla Cup",
    price_cents: 9000,
    image_url: "/img/vanilla_cup.svg",
    bin: "FZ-B1-A1",
  },
  {
    id: "p3",
    name: "Strawberry Tub",
    price_cents: 18000,
    image_url: "/img/straw_tub.svg",
    bin: "FZ-A2-C2",
  },
];

function findProductsLocal(query: string): Product[] {
  const normalized = (query || "").toLowerCase();
  return PRODUCTS.filter((product) =>
    product.name.toLowerCase().includes(normalized)
  );
}

function addToCartLocal(cart: CartItem[], product_id: string, qty: number): CartItem[] {
  const product = PRODUCTS.find((item) => item.id === product_id) || PRODUCTS[0];
  const existingIndex = cart.findIndex((item) => item.id === product.id);
  if (existingIndex >= 0) {
    const updated = [...cart];
    updated[existingIndex].qty += qty;
    return updated;
  }
  return [...cart, { id: product.id, qty, price_cents: product.price_cents }];
}

function checkoutLocal(cart: CartItem[]) {
  const subtotal = cart.reduce((sum, item) => sum + item.price_cents * item.qty, 0);
  const tax = Math.round(subtotal * 0.05);
  const total = subtotal + tax;
  return { subtotal, tax, total };
}

function getDirections(bin: string): Directions {
  return {
    display_name: "Freezer Aisle 2, Bin 4",
    steps: ["Walk straight 5m", "Turn left"],
    bin,
    map_svg_url: "/map/store.svg",
  };
}

async function findProductsViaMake(query: string): Promise<Product[]> {
  if (!MAKE_PRODUCTS_HOOK) {
    return findProductsLocal(query);
  }

  const response = await fetch(MAKE_PRODUCTS_HOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Make products hook failed with status ${response.status}`);
  }

  const data = (await response.json()) as { products?: Product[] };
  return data.products || [];
}

async function checkoutViaMake(cart: CartItem[]) {
  if (!MAKE_ORDER_HOOK) {
    return checkoutLocal(cart);
  }

  const response = await fetch(MAKE_ORDER_HOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cart, total: cart.reduce((sum, item) => sum + item.price_cents * item.qty, 0) }),
  });

  if (!response.ok) {
    throw new Error(`Make order hook failed with status ${response.status}`);
  }

  const data = (await response.json()) as { receipt?: { subtotal: number; tax: number; total: number } };
  return data.receipt || checkoutLocal(cart);
}

app.post("/api/make/products", async (req, res) => {
  if (!MAKE_PRODUCTS_HOOK) {
    return res.status(501).json({ error: "MAKE_PRODUCTS_HOOK not configured" });
  }

  try {
    const { query } = req.body || {};
    const response = await fetch(MAKE_PRODUCTS_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "make products failed" });
  }
});

app.post("/api/make/order", async (req, res) => {
  if (!MAKE_ORDER_HOOK) {
    return res.status(501).json({ error: "MAKE_ORDER_HOOK not configured" });
  }

  try {
    const { cart, total } = req.body || {};
    const response = await fetch(MAKE_ORDER_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cart, total }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "make order failed" });
  }
});

app.post("/api/brain/respond", async (req, res) => {
  try {
    const { utterance, cart = [] } = req.body || {};
    if (!utterance) {
      return res.status(400).json({ error: "utterance is required" });
    }

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "find_products",
          description: "Search ice-cream catalog by a natural language query.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "add_to_cart",
          description: "Add a product to the cart with quantity.",
          parameters: {
            type: "object",
            properties: {
              product_id: { type: "string" },
              qty: { type: "integer", minimum: 1 },
            },
            required: ["product_id", "qty"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "checkout",
          description: "Compute totals for the current cart.",
          parameters: {
            type: "object",
            properties: {
              cart: { type: "array", items: { type: "object" } },
            },
            required: ["cart"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "get_directions",
          description: "Get pickup directions for a product bin code.",
          parameters: {
            type: "object",
            properties: {
              bin: { type: "string" },
            },
            required: ["bin"],
          },
        },
      },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a kiosk assistant for an ice-cream shop. Be brief and helpful." },
        { role: "user", content: utterance },
      ],
      tools,
    });

    const choice = completion.choices[0];
    const toolCall = choice?.message?.tool_calls?.[0];

    if (toolCall) {
      const { name, arguments: argsJson } = toolCall.function;
      const args = JSON.parse(argsJson || "{}");

      if (name === "find_products") {
        const items = await findProductsViaMake(args.query || "");
        return res.json({
          type: "show_products",
          products: items,
          response: "Here are some options I found.",
        });
      }

      if (name === "add_to_cart") {
        const qty = typeof args.qty === "number" && args.qty > 0 ? args.qty : 1;
        const updated = addToCartLocal(cart, args.product_id, qty);
        return res.json({
          type: "add_to_cart",
          productId: args.product_id,
          qty,
          cart: updated,
          response: "Added to your cart. Anything else?",
        });
      }

      if (name === "checkout") {
        const totals = await checkoutViaMake(cart);
        return res.json({
          type: "checkout",
          receipt: totals,
          response: `Your total is ₹${(totals.total / 100).toFixed(2)}. Would you like anything else?`,
        });
      }

      if (name === "get_directions") {
        const info = getDirections(args.bin || "FZ-A2-B4");
        return res.json({
          type: "directions",
          directions: info,
          response: `Please head to ${info.display_name}.`,
        });
      }
    }

    return res.json({
      type: "chat",
      response: choice?.message?.content || "How can I help you choose ice-cream?",
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "brain failed" });
  }
});

app.post("/api/nlp/interpret", (_req, res) => {
  res.json({ type: "chat", response: "Use /api/brain/respond for intent + tools." });
});

app.get("/api/catalog/search", (req, res) => {
  const query = ((req.query.q as string) || "").toLowerCase();
  const results = PRODUCTS.filter((product) => product.name.toLowerCase().includes(query));
  res.json({ results });
});

app.post("/api/order/checkout", (req, res) => {
  const cart: CartItem[] = req.body?.cart || [];
  const totals = checkoutLocal(cart);
  res.json({ receipt: totals, receipt_url: "/receipt/123" });
});

app.get("/api/directions/for-pickup", (req, res) => {
  const bin = (req.query.bin as string) || "FZ-A2-B4";
  res.json(getDirections(bin));
});

const PORT = Number(process.env.PORT || 8080);

app.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}`);
});
