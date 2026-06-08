// packages/api/tests/watchdog/telegram-webhook.test.ts
import { describe, expect, it, vi } from "vitest";
import { checkTelegramWebhook } from "../../src/watchdog/checks/telegram-webhook.js";

const EXPECTED = "https://agent-mouth.fly.dev/telegram-webhook";
const fetchOk = (url: string) =>
  vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { url } }) })) as never;

describe("checkTelegramWebhook", () => {
  it("ok cuando el webhook apunta al esperado", async () => {
    const r = await checkTelegramWebhook({
      botToken: "b",
      expectedUrl: EXPECTED,
      fetchFn: fetchOk(EXPECTED),
    });
    expect(r.status).toBe("ok");
  });

  it("down cuando el webhook está desviado", async () => {
    const r = await checkTelegramWebhook({
      botToken: "b",
      expectedUrl: EXPECTED,
      fetchFn: fetchOk("https://lab.agentiko.es/webhook"),
    });
    expect(r.status).toBe("down");
    expect(r.message).toContain("lab.agentiko.es");
  });

  it("down cuando getWebhookInfo no es 200", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as never;
    const r = await checkTelegramWebhook({ botToken: "b", expectedUrl: EXPECTED, fetchFn });
    expect(r.status).toBe("down");
  });
});
