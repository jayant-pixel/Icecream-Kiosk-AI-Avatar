export interface Product {
  id: string;
  name: string;
  description?: string;
  priceCents: number;
  imageUrl: string;
  bin: string;
}

export interface CartItem {
  id: string;
  qty: number;
  priceCents: number;
}

export type AssistantEvent =
  | {
      type: "show_products";
      products: Product[];
      spokenPrompt?: string;
    }
  | {
      type: "add_to_cart";
      cart: CartItem[];
      productId: string;
      qty: number;
      spokenPrompt?: string;
    }
  | {
      type: "checkout";
      receipt: { subtotal: number; tax: number; total: number };
      spokenPrompt?: string;
    }
  | {
      type: "directions";
      directions: {
        displayName: string;
        steps: string[];
        bin: string;
        mapSvgUrl?: string;
      };
      spokenPrompt?: string;
    }
  | {
      type: "chat";
      spokenPrompt?: string;
    };

export interface BrainResponse {
  threadId: string;
  response: string;
  cart: CartItem[];
  events: AssistantEvent[];
}
