type LogLevel = "info" | "error" | "warn" | "debug";

const log = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
  const payload = meta ? ` ${JSON.stringify(meta)}` : "";
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](`[${ts}] [${level.toUpperCase()}] ${message}${payload}`);
};

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
};
