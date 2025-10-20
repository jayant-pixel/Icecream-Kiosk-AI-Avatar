import { config } from "dotenv";

config();

type EnvValue = string & { readonly __brand: unique symbol };

const optionalList = (value: string | undefined): string[] =>
  value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const requireEnv = (name: string): EnvValue => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value as EnvValue;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number.parseInt(process.env.PORT ?? "8080", 10),
  heygen: {
    apiKey: requireEnv("HEYGEN_API_KEY"),
    baseUrl: process.env.HEYGEN_BASE_URL ?? "https://api.heygen.com",
    defaultAvatarId: process.env.HEYGEN_AVATAR_ID,
  },
  openai: {
    apiKey: requireEnv("OPENAI_API_KEY"),
    model: process.env.OPENAI_ASSISTANT_MODEL ?? "gpt-4o-mini",
    assistantName: process.env.OPENAI_ASSISTANT_NAME ?? "Icecream Kiosk Assistant",
    assistantId: process.env.OPENAI_ASSISTANT_ID,
  },
  cors: {
    origins: optionalList(process.env.CORS_ALLOWED_ORIGINS),
  },
  integrations: {
    productsWebhook: process.env.PRODUCTS_WEBHOOK_URL,
    directionsWebhook: process.env.DIRECTIONS_WEBHOOK_URL,
  },
} as const;

export const isProduction = env.nodeEnv === "production";
