import { env } from "../config/env";
import { logger } from "../utils/logger";

interface HeygenResponse<T> {
  code: number;
  data: T;
  message?: string;
}

export interface HeygenToken {
  token: string;
}

export const createStreamingToken = async (): Promise<HeygenToken> => {
  const response = await fetch(`${env.heygen.baseUrl}/v1/streaming.create_token`, {
    method: "POST",
    headers: {
      "x-api-key": env.heygen.apiKey,
    },
  });

  const payload = (await response.json().catch(() => ({}))) as HeygenResponse<HeygenToken>;
  if (!response.ok || !payload?.data?.token) {
    const message = payload?.message ?? "Failed to create access token";
    logger.error("HeyGen streaming.create_token failed", {
      status: response.status,
      message,
    });
    throw new Error(message);
  }

  return payload.data;
};

export const speakWithSession = async (
  sessionId: string,
  accessToken: string,
  text: string,
  options: { taskType?: string; mode?: string } = {},
) => {
  if (!text.trim()) {
    return;
  }

  const response = await fetch(`${env.heygen.baseUrl}/v1/streaming.task`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "x-api-key": env.heygen.apiKey,
    },
    body: JSON.stringify({
      session_id: sessionId,
      task_type: options.taskType ?? "repeat",
      text,
      task_mode: options.mode ?? "async",
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    logger.error("HeyGen streaming.task failed", {
      sessionId,
      status: response.status,
      message,
    });
    throw new Error(message || "HeyGen speak task failed");
  }
};
