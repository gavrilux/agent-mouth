import { GrammyError, HttpError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramTransport } from "../../src/transports/telegram.js";

// Mock the grammy Bot
vi.mock("grammy", () => {
  class GrammyError extends Error {
    constructor(
      public error_code: number,
      public description: string,
      public parameters?: { retry_after?: number },
    ) {
      super(description);
      this.name = "GrammyError";
    }
  }

  class HttpError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "HttpError";
    }
  }

  return {
    GrammyError,
    HttpError,
    Bot: class MockBot {
      api = {
        getMe: vi.fn().mockResolvedValue({
          id: 7234567890,
          is_bot: true,
          first_name: "Gavrilo Backend",
          username: "gavrilo_backend_bot",
        }),
        getChat: vi.fn().mockResolvedValue({
          id: -1001234567890,
          type: "supergroup",
          title: "Aurellano Team",
        }),
        getChatAdministrators: vi.fn().mockResolvedValue([
          { user: { id: 1, is_bot: false, first_name: "Gavrilo", username: "gavrilom" } },
          {
            user: {
              id: 7234567890,
              is_bot: true,
              first_name: "Gavrilo Backend",
              username: "gavrilo_backend_bot",
            },
          },
          {
            user: {
              id: 7345678901,
              is_bot: true,
              first_name: "Marco Front",
              username: "marco_frontend_bot",
            },
          },
        ]),
      };
      constructor(public token: string) {}
    },
  };
});

describe("TelegramTransport", () => {
  let transport: TelegramTransport;

  beforeEach(async () => {
    transport = new TelegramTransport();
    await transport.init({
      bot_token: "7234567890:AAH-fake-token",
      chat_id: "-1001234567890",
      handle: "gavrilo-backend",
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

  it("send formats message with @mention when 'to' is a handle", async () => {
    // Extend the Bot mock with sendMessage
    const sendMessageSpy = vi.fn().mockResolvedValue({
      message_id: 42,
      date: Math.floor(Date.now() / 1000),
    });
    (transport as unknown as { bot: { api: { sendMessage: unknown } } }).bot.api.sendMessage =
      sendMessageSpy;

    const result = await transport.send({
      to: "marco_frontend_bot",
      body: "please connect form",
    });

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      "@marco_frontend_bot please connect form",
      expect.any(Object),
    );
    expect(result.message_id).toBe("42");
  });

  it.each([
    [
      new (GrammyError as unknown as new (code: number, description: string) => Error)(
        401,
        "Unauthorized",
      ),
      "AUTH_ERROR",
      "Regenerate the bot token",
    ],
    [
      new (GrammyError as unknown as new (code: number, description: string) => Error)(
        403,
        "Forbidden: bot was kicked from the supergroup chat",
      ),
      "NOT_IN_GROUP",
      "Add the bot back",
    ],
    [
      new (GrammyError as unknown as new (code: number, description: string) => Error)(
        403,
        "Forbidden: bot privacy mode is enabled",
      ),
      "PRIVACY_MODE_ON",
      "Disable privacy mode",
    ],
    [
      new (
        GrammyError as unknown as new (
          code: number,
          description: string,
          parameters?: { retry_after?: number },
        ) => Error
      )(429, "Too Many Requests", { retry_after: 7 }),
      "RATE_LIMITED",
      "Wait 7s",
    ],
    [
      new (HttpError as unknown as new (message: string) => Error)("fetch failed"),
      "NETWORK_ERROR",
      "network",
    ],
    [
      new (GrammyError as unknown as new (code: number, description: string) => Error)(
        400,
        "Bad Request: chat not found",
      ),
      "NOT_FOUND",
      "chat_id",
    ],
  ])("maps Telegram API failures to %s", async (err, code, hint) => {
    const sendMessageSpy = vi.fn().mockRejectedValue(err);
    (transport as unknown as { bot: { api: { sendMessage: unknown } } }).bot.api.sendMessage =
      sendMessageSpy;

    await expect(transport.send({ body: "hello" })).rejects.toMatchObject({
      name: code,
      hint: expect.stringContaining(hint),
    });
  });

  it("send without 'to' broadcasts (no mention prefix)", async () => {
    const sendMessageSpy = vi.fn().mockResolvedValue({
      message_id: 43,
      date: Math.floor(Date.now() / 1000),
    });
    (transport as unknown as { bot: { api: { sendMessage: unknown } } }).bot.api.sendMessage =
      sendMessageSpy;

    await transport.send({ body: "deploying in 5 min" });

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      "deploying in 5 min",
      expect.any(Object),
    );
  });

  it("waitForMessages parses Telegram updates into ReceivedMessages with mention detection", async () => {
    const getUpdatesSpy = vi.fn().mockResolvedValue([
      {
        update_id: 100,
        message: {
          message_id: 50,
          from: { id: 999, is_bot: false, first_name: "Marco", username: "marco_user" },
          chat: { id: -1001234567890 },
          date: 1730000000,
          text: "@gavrilo_backend_bot can you do X?",
          entities: [{ type: "mention", offset: 0, length: 23 }],
        },
      },
      {
        update_id: 101,
        message: {
          message_id: 51,
          from: { id: 888, is_bot: false, first_name: "Other", username: "other_user" },
          chat: { id: -1001234567890 },
          date: 1730000005,
          text: "unrelated broadcast",
        },
      },
    ]);
    (transport as unknown as { bot: { api: { getUpdates: unknown } } }).bot.api.getUpdates =
      getUpdatesSpy;

    const msgs = await transport.waitForMessages({ timeout_seconds: 1 });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].body).toBe("@gavrilo_backend_bot can you do X?");
    expect(msgs[0].from_handle).toBe("marco_user");
    expect(msgs[0].is_mention).toBe(true);
    expect(msgs[1].is_mention).toBe(false);
  });

  it("waitForMessages passes the correct offset (last_seen_update_id + 1) to getUpdates", async () => {
    // Re-init with a seeded last_seen_update_id
    await transport.close();
    transport = new TelegramTransport();
    await transport.init({
      bot_token: "7234567890:AAH-fake-token",
      chat_id: "-1001234567890",
      handle: "gavrilo-backend",
      last_seen_update_id: 50,
    });

    const getUpdatesSpy = vi.fn().mockResolvedValue([
      {
        update_id: 55,
        message: {
          message_id: 70,
          from: { id: 999, is_bot: false, first_name: "X", username: "x_user" },
          chat: { id: -1001234567890 },
          date: 1730000000,
          text: "hi",
        },
      },
    ]);
    (transport as unknown as { bot: { api: { getUpdates: unknown } } }).bot.api.getUpdates =
      getUpdatesSpy;

    await transport.waitForMessages({ timeout_seconds: 1, filter: "all" });
    expect(getUpdatesSpy).toHaveBeenCalledWith(expect.objectContaining({ offset: 51 }));

    // Next call should advance to 56
    const getUpdatesSpy2 = vi.fn().mockResolvedValue([]);
    (transport as unknown as { bot: { api: { getUpdates: unknown } } }).bot.api.getUpdates =
      getUpdatesSpy2;
    await transport.waitForMessages({ timeout_seconds: 1, filter: "all" });
    expect(getUpdatesSpy2).toHaveBeenCalledWith(expect.objectContaining({ offset: 56 }));
  });

  it("waitForMessages with filter='mentions' returns only messages that mention me", async () => {
    const getUpdatesSpy = vi.fn().mockResolvedValue([
      {
        update_id: 200,
        message: {
          message_id: 60,
          from: { id: 999, is_bot: false, first_name: "Marco", username: "marco_user" },
          chat: { id: -1001234567890 },
          date: 1730000000,
          text: "@gavrilo_backend_bot do X",
          entities: [{ type: "mention", offset: 0, length: 23 }],
        },
      },
      {
        update_id: 201,
        message: {
          message_id: 61,
          from: { id: 888, is_bot: false, first_name: "X", username: "x_user" },
          chat: { id: -1001234567890 },
          date: 1730000005,
          text: "broadcast",
        },
      },
    ]);
    (transport as unknown as { bot: { api: { getUpdates: unknown } } }).bot.api.getUpdates =
      getUpdatesSpy;

    const msgs = await transport.waitForMessages({ filter: "mentions" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toContain("@gavrilo_backend_bot");
  });
});
