import type { Request, Response } from "express";
import { runAssistant } from "../services/openai";
import { assistantTools } from "../services/tools";
import { speakWithSession } from "../services/heygen";
import type { BrainRequestBody } from "../types";

export const brainRespondHandler = async (req: Request, res: Response) => {
  const { utterance, cart = [], threadId, session }: BrainRequestBody = req.body ?? {};

  if (!utterance || typeof utterance !== "string") {
    return res.status(400).json({ error: "utterance is required" });
  }

  try {
    const result = await runAssistant(utterance, cart, threadId);
    const finalSpokenPrompt =
      result.events[result.events.length - 1]?.spokenPrompt ?? result.response;

    if (session?.sessionId && session?.accessToken) {
      void speakWithSession(session.sessionId, session.accessToken, finalSpokenPrompt).catch(
        (error: unknown) => {
          // Do not fail the request if speech dispatch fails; just log for observability
          console.error("Failed to dispatch speech task to HeyGen", error);
        },
      );
    }

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Assistant run failed",
    });
  }
};

export const toolWebhookHandler = (req: Request, res: Response) => {
  const { name, arguments: args = {}, cart = [] } = req.body ?? {};

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const { output, event, updatedCart } = assistantTools.handle(name, args, cart);
    return res.json({
      output,
      event,
      cart: updatedCart ?? cart,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Tool execution failed",
    });
  }
};
