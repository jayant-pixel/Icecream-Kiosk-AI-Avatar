import OpenAI from "openai";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { assistantTools } from "./tools";

const openai = new OpenAI({
  apiKey: env.openai.apiKey,
});

let assistantId: string | null = null;
const baseAssistantConfig = {
  name: env.openai.assistantName,
  instructions:
    "You are Scoop Haven, a warm and concise ice-cream kiosk assistant. Use the provided tools to help guests discover flavours, add items to their cart, and guide them to pickup locations. Always keep responses under 30 words unless summarising a receipt.",
  tools: assistantTools.definition,
  model: env.openai.model,
  metadata: {
    project: "icecream-kiosk",
  },
} as const;

export const getAssistantId = async (): Promise<string> => {
  if (assistantId) {
    return assistantId;
  }

  if (env.openai.assistantId) {
    try {
      logger.info("Using existing assistant from configuration", {
        assistantId: env.openai.assistantId,
      });

      const updated = await openai.beta.assistants.update(
        env.openai.assistantId,
        baseAssistantConfig,
      );
      assistantId = updated.id;
      logger.info("Assistant configuration refreshed", { assistantId });
      return assistantId;
    } catch (error) {
      logger.warn("Failed to update configured assistant; will attempt to create a new one", {
        assistantId: env.openai.assistantId,
        error,
      });
    }
  }

  try {
    logger.info("Creating new assistant...");
    const assistant = await openai.beta.assistants.create(baseAssistantConfig);
    assistantId = assistant.id;
    logger.info("Assistant created successfully", { assistantId });
    logger.warn(
      "Persist the assistant ID via OPENAI_ASSISTANT_ID to avoid recreating it on subsequent restarts",
      { assistantId },
    );
    return assistantId;
  } catch (error) {
    logger.error("Failed to create assistant", { error });
    throw error;
  }
};
