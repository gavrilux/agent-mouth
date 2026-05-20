import { logger } from "../logger.js";

export async function forwardToBridge(url: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, url }, "bridge forward non-2xx");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, url }, "bridge forward failed");
    return false;
  }
}
