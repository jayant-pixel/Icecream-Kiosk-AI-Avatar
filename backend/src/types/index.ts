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

export type AssistantEventType = "show_products" | "add_to_cart" | "directions" | "chat";

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
      displayName?: string;
    } & AssistantEventBase)
  | ({
      type: "directions";
      directions: {
        displayName: string;
        hint?: string;
        mapImage?: string;
        steps?: string[];
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
