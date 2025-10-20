import { Router } from "express";
import { toolWebhookHandler } from "../controllers/assistantController";

const router = Router();

router.post("/tool", toolWebhookHandler);

export default router;
