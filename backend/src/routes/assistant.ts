import { Router } from "express";
import { brainRespondHandler } from "../controllers/assistantController";

const router = Router();

router.post("/respond", brainRespondHandler);

export default router;
