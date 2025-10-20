import type { BrainResponse, CartItem } from "./types";

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

const withErrorHandling = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
};

export interface SessionDescriptor {
  token: string;
  avatarId: string;
}

export const newSession = async (avatarId?: string): Promise<SessionDescriptor> => {
  const response = await fetch("/api/session/new", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      avatarId,
    }),
  });

  return withErrorHandling<SessionDescriptor>(response);
};

export const transcribeAudio = async (audioBlob: Blob): Promise<string> => {
  const formData = new FormData();
  formData.append("audio", audioBlob, "input.webm");

  const response = await fetch("/api/stt/transcribe", {
    method: "POST",
    body: formData,
  });

  const payload = await withErrorHandling<{ text: string }>(response);
  return payload.text;
};

export const brainRespond = async (
  utterance: string,
  cart: CartItem[],
  threadId?: string,
  session?: { sessionId: string; accessToken: string },
): Promise<BrainResponse> => {
  const response = await fetch("/api/brain/respond", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      utterance,
      cart,
      threadId,
      session,
    }),
  });

  return withErrorHandling<BrainResponse>(response);
};
