import { Router } from "express";
import sessionRoutes from "./session";
import speechRoutes from "./speech";
import assistantRoutes from "./assistant";
import webhookRoutes from "./webhooks";

export const apiRouter = Router()
  .use("/session", sessionRoutes)
  .use("/stt", speechRoutes)
  .use("/brain", assistantRoutes);

export const webhookRouter = Router().use("/openai", webhookRoutes);
