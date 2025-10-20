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

export type AssistantEventType =
  | "show_products"
  | "add_to_cart"
  | "checkout"
  | "directions"
  | "chat";

interface AssistantEventBase {
  spokenPrompt?: string;
}

export type AssistantEvent =
  | ({ type: "show_products"; products: Product[] } & AssistantEventBase)
  | ({
      type: "add_to_cart";
      cart: CartItem[];
      productId: string;
      qty: number;
    } & AssistantEventBase)
  | ({
      type: "checkout";
      receipt: { subtotal: number; tax: number; total: number };
    } & AssistantEventBase)
  | ({
      type: "directions";
      directions: {
        displayName: string;
        steps: string[];
        bin: string;
        mapSvgUrl?: string;
      };
    } & AssistantEventBase)
  | ({ type: "chat" } & AssistantEventBase);

export interface BrainRequestBody {
  utterance: string;
  cart?: CartItem[];
  threadId?: string;
  session?: {
    sessionId: string;
    accessToken: string;
  };
}

export interface BrainResponseBody {
  threadId: string;
  response: string;
  cart: CartItem[];
  events: AssistantEvent[];
}
