import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";
import serveStatic from "serve-static";
import { apiRouter, webhookRouter } from "./routes";
import { env, isProduction } from "./config/env";
import { getAssistantId } from "./services/assistant";
import { logger } from "./utils/logger";

const app = express();

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);
app.use(
  cors({
    origin: env.cors.origins.length > 0 ? env.cors.origins : true,
    credentials: true,
  }),
);
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  morgan("tiny", {
    stream: {
      write: (message) => logger.info(message.trim()),
    },
  }),
);

app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  }),
);

app.use("/api", apiRouter);
app.use("/webhooks", webhookRouter);

if (isProduction) {
  const distPath = path.resolve(__dirname, "../../frontend/dist");
  app.use(serveStatic(distPath, { index: false }));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

const start = async () => {
  try {
    await getAssistantId();
    app.listen(env.port, () => {
      logger.info(`Backend listening on port ${env.port}`);
    });
  } catch (error) {
    logger.error("Failed to start backend service", {
      error,
    });
    process.exitCode = 1;
  }
};

void start();
