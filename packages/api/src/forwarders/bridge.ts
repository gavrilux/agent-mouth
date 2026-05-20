import { logger } from "../logger.js";

/**
 * Forwards a Telegram update payload to a downstream bridge (e.g.
 * lab.agentiko.es/webhook). If `secretToken` is provided, includes it as
 * the X-Telegram-Bot-Api-Secret-Token header — the same header Telegram
 * itself sends when setWebhook is called with secret_token. The bridge
 * uses this header to authenticate forwarded traffic.
 *
 * Never throws. Returns true on 2xx, false on non-2xx or network error.
 */
export async function forwardToBridge(
  url: string,
  payload: unknown,
  secretToken?: string,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secretToken) headers["X-Telegram-Bot-Api-Secret-Token"] = secretToken;
    const res = await fetch(url, {
      method: "POST",
      headers,
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
