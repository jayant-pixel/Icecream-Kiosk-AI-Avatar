export type SessionDetails = {
  sessionId: string;
  livekitUrl: string;
  accessToken: string;
};

export type BrainResponse =
  | { type: "show_products"; products: ProductSummary[]; response?: string }
  | { type: "add_to_cart"; productId: string; qty: number; cart: CartLine[]; response?: string }
  | { type: "checkout"; receipt: Receipt; response?: string }
  | { type: "directions"; directions: DirectionsPayload; response?: string }
  | { type: "chat"; response?: string };

export type ProductSummary = {
  id: string;
  name: string;
  price_cents: number;
  image_url?: string;
  bin?: string;
};

export type CartLine = { id: string; qty: number; price_cents: number };

export type Receipt = { subtotal: number; tax: number; total: number };

export type DirectionsPayload = {
  display_name: string;
  steps: string[];
  bin: string;
  map_svg_url?: string;
};

export async function newSession(avatarId: string): Promise<SessionDetails> {
  const response = await fetch("/api/session/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatarId, language: "en", quality: "high" }),
  });

  const data = (await response.json()) as SessionDetails | { error?: string };
  if (!response.ok || !("sessionId" in data)) {
    throw new Error((data as { error?: string }).error || "session.new failed");
  }

  return data as SessionDetails;
}

export async function speak(sessionId: string, text: string) {
  const response = await fetch("/api/avatar/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error?.error || "speak failed");
  }
}

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", audioBlob, "input.webm");

  const response = await fetch("/api/stt/transcribe", {
    method: "POST",
    body: form,
  });
  const data = (await response.json().catch(() => ({}))) as { text?: string; error?: string };

  if (!response.ok) {
    throw new Error(data?.error || "stt failed");
  }

  return data.text || "";
}

export async function brainRespond(utterance: string, cart: CartLine[]): Promise<BrainResponse> {
  const response = await fetch("/api/brain/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ utterance, cart }),
  });
  const data = (await response.json().catch(() => ({}))) as BrainResponse | { error?: string };

  if (!response.ok) {
    throw new Error((data as { error?: string }).error || "brain failed");
  }

  return data as BrainResponse;
}
