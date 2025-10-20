export interface Product {
  id: string;
  name: string;
  description?: string;
  priceCents: number;
  imageUrl: string;
  displayNames: string[];
  primaryDisplayName: string;
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
      displayName?: string;
      spokenPrompt?: string;
    }
  | {
      type: "directions";
      directions: {
        displayName: string;
        hint?: string;
        mapImage?: string;
        steps?: string[];
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
