import type { Request, Response } from "express";
import { transcribeAudio } from "../services/openai";

export const transcribeHandler = async (req: Request, res: Response) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: "audio file is required (field name: audio)" });
  }

  try {
    const text = await transcribeAudio(file.buffer, file.originalname ?? "audio.webm", file.mimetype);
    return res.json({ text });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to transcribe audio",
    });
  }
};
