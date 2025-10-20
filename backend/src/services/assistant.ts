import OpenAI from "openai";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { assistantTools } from "./tools";

const openai = new OpenAI({
  apiKey: env.openai.apiKey,
});

let assistantId: string | null = null;

export const getAssistantId = async (): Promise<string> => {
  if (assistantId) {
    return assistantId;
  }

  try {
    logger.info("Creating new assistant...");
    const assistant = await openai.beta.assistants.create({
      name: env.openai.assistantName,
      instructions:
        "You are Scoop Haven, a warm and concise ice-cream kiosk assistant. Use the provided tools to help guests discover flavours, add items to their cart, checkout, and find pickup directions. Always keep responses under 30 words unless summarising a receipt.",
      tools: assistantTools.definition,
      model: env.openai.model,
      metadata: {
        project: "icecream-kiosk",
      },
    });
    assistantId = assistant.id;
    logger.info("Assistant created successfully", { assistantId });
    return assistantId;
  } catch (error) {
    logger.error("Failed to create assistant", { error });
    throw error;
  }
};
