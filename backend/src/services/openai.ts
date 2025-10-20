import OpenAI from "openai";
import type { TextContentBlock } from "openai/resources/beta/threads/messages";
import { toFile } from "openai/uploads";
import type { AssistantEvent, BrainResponseBody, CartItem } from "../types";
import { assistantTools } from "./tools";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { getAssistantId } from "./assistant";

const openai = new OpenAI({
  apiKey: env.openai.apiKey,
});

export const transcribeAudio = async (buffer: Buffer, filename: string, mimeType: string) => {
  const file = await toFile(buffer, filename, { type: mimeType });
  const response = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });
  return response.text.trim();
};

const extractAssistantText = (messages: Awaited<
  ReturnType<typeof openai.beta.threads.messages.list>
>["data"]): string => {
  const assistantMessage = messages.find((message) => message.role === "assistant");
  if (!assistantMessage) {
    return "I'm here whenever you need another scoop!";
  }

  const content = assistantMessage.content
    .filter((item): item is TextContentBlock => item.type === "text")
    .map((item) => item.text.value?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();

  return content || "I'm here whenever you need another scoop!";
};

const ensureEventsHaveSpeech = (events: AssistantEvent[], fallback: string) => {
  if (events.length === 0) {
    events.push({
      type: "chat",
      spokenPrompt: fallback,
    });
    return;
  }

  const lastEvent = events[events.length - 1];
  if (lastEvent && !lastEvent.spokenPrompt) {
    lastEvent.spokenPrompt = fallback;
  }
};

export const runAssistant = async (
  utterance: string,
  cart: CartItem[],
  incomingThreadId?: string,
): Promise<BrainResponseBody> => {
  const assistantId = await getAssistantId();
  const threadId =
    incomingThreadId ??
    (
      await openai.beta.threads.create({
        metadata: {
          project: "icecream-kiosk",
        },
      })
    ).id;

  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: utterance,
  });

  let run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: assistantId,
    instructions: `Cart snapshot: ${cart
      .map((item) => `${item.qty}x ${item.id}`)
      .join(", ") || "empty"}. When using tools respond with clear, upbeat language.`,
  });

  const events: AssistantEvent[] = [];
  let cartState = [...cart];

  while (run.status !== "completed") {
    if (run.status === "requires_action") {
      const toolCalls = run.required_action?.submit_tool_outputs?.tool_calls ?? [];
      const toolOutputs = await Promise.all(
        toolCalls.map(async (toolCall) => {
          const args = JSON.parse(toolCall.function.arguments ?? "{}");
          const { output, event, updatedCart } = await assistantTools.handle(
            toolCall.function.name,
            args,
            cartState,
          );

          if (event) {
            events.push(event);
          }
          if (updatedCart) {
            cartState = updatedCart;
          }

          return { tool_call_id: toolCall.id, output: JSON.stringify(output) };
        }),
      );

      run = await openai.beta.threads.runs.submitToolOutputs(run.id, {
        thread_id: threadId,
        tool_outputs: toolOutputs,
      });
      continue;
    }

    if (run.status === "queued" || run.status === "in_progress") {
      run = await openai.beta.threads.runs.poll(run.id, { thread_id: threadId }, { pollIntervalMs: 750 });
      continue;
    }

    throw new Error(`Assistant run ended unexpectedly with status ${run.status}`);
  }

  const messages = await openai.beta.threads.messages.list(threadId, { limit: 10 });
  const assistantText = extractAssistantText(messages.data);
  ensureEventsHaveSpeech(events, assistantText);

  return {
    threadId,
    response: assistantText,
    cart: cartState,
    events,
  };
};
