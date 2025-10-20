import type { Request, Response } from "express";
import { createStreamingToken } from "../services/heygen";
import { env } from "../config/env";

export const createSessionHandler = async (req: Request, res: Response) => {
  try {
    const { avatarId = env.heygen.defaultAvatarId } = req.body ?? {};

    if (!avatarId) {
      return res.status(400).json({ error: "avatarId is required" });
    }

    const token = await createStreamingToken();

    return res.json({
      token: token.token,
      avatarId,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create session",
    });
  }
};
