// packages/api/src/watchdog/checks/telegram-webhook.ts
import type { CheckResult } from "../types.js";

export interface TelegramWebhookCheckDeps {
  botToken: string;
  /** {PUBLIC_BASE_URL}/telegram-webhook */
  expectedUrl: string;
  fetchFn?: typeof fetch;
}

const ID = "telegram-webhook";

export async function checkTelegramWebhook(deps: TelegramWebhookCheckDeps): Promise<CheckResult> {
  const f = deps.fetchFn ?? fetch;
  try {
    const res = await f(`https://api.telegram.org/bot${deps.botToken}/getWebhookInfo`);
    if (!res.ok) {
      return { id: ID, status: "down", message: `getWebhookInfo HTTP ${res.status}` };
    }
    const json = (await res.json()) as { ok?: boolean; result?: { url?: string } };
    const url = json.result?.url ?? "";
    if (url !== deps.expectedUrl) {
      return {
        id: ID,
        status: "down",
        message: `telegram webhook apunta a "${url || "(vacío)"}" (esperado "${deps.expectedUrl}")`,
        action: "Re-registra el webhook o revisa el bridge.",
      };
    }
    return { id: ID, status: "ok", message: "ok" };
  } catch (err) {
    return { id: ID, status: "down", message: `telegram getWebhookInfo falló: ${String(err)}` };
  }
}
