import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramTransport } from "../../src/transports/telegram.js";

// Mock the grammy Bot
vi.mock("grammy", () => {
  return {
    Bot: class MockBot {
      api = {
        getMe: vi.fn().mockResolvedValue({
          id: 7234567890,
          is_bot: true,
          first_name: "Gavrilo Backend",
          username: "gavrilo_backend_bot"
        }),
        getChat: vi.fn().mockResolvedValue({
          id: -1001234567890,
          type: "supergroup",
          title: "Aurellano Team"
        }),
        getChatAdministrators: vi.fn().mockResolvedValue([
          { user: { id: 1, is_bot: false, first_name: "Gavrilo", username: "gavrilom" } },
          { user: { id: 7234567890, is_bot: true, first_name: "Gavrilo Backend", username: "gavrilo_backend_bot" } },
          { user: { id: 7345678901, is_bot: true, first_name: "Marco Front", username: "marco_frontend_bot" } }
        ])
      };
      constructor(public token: string) {}
    }
  };
});

describe("TelegramTransport", () => {
  let transport: TelegramTransport;

  beforeEach(async () => {
    transport = new TelegramTransport();
    await transport.init({
      bot_token: "7234567890:AAH-fake-token",
      chat_id: "-1001234567890",
      handle: "gavrilo-backend"
    });
  });

  afterEach(async () => {
    await transport.close();
  });

  it("whoami returns bot identity from Telegram getMe", async () => {
    const me = await transport.whoami();
    expect(me.handle).toBe("gavrilo_backend_bot");
    expect(me.display_name).toBe("Gavrilo Backend");
    expect(me.bot_id).toBe(7234567890);
    expect(me.chat_id).toBe("-1001234567890");
  });

  it("listContacts returns other group members (excluding self)", async () => {
    const contacts = await transport.listContacts();
    const handles = contacts.map((c) => c.handle);
    expect(handles).toContain("gavrilom");
    expect(handles).toContain("marco_frontend_bot");
    expect(handles).not.toContain("gavrilo_backend_bot"); // self excluded
  });
});
