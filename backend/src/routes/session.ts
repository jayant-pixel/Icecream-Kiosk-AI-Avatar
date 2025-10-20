import { Router } from "express";
import { createSessionHandler } from "../controllers/sessionController";

const router = Router();

router.post("/new", createSessionHandler);

export default router;
