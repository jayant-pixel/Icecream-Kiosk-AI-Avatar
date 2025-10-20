import { Router } from "express";
import multer from "multer";
import { transcribeHandler } from "../controllers/speechController";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

router.post("/transcribe", upload.single("audio"), transcribeHandler);

export default router;
