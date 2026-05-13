import { Bot, GrammyError, HttpError } from "grammy";
import {
  authError,
  networkError,
  notFoundError,
  notInGroupError,
  privacyModeError,
  rateLimitedError,
} from "../errors.js";
import type {
  Contact,
  Identity,
  ReceiveOptions,
  ReceivedMessage,
  SendOptions,
  SentMessage,
  Transport,
  TransportConfig,
  WaitOptions,
} from "./types.js";

export interface TelegramConfig extends TransportConfig {
  bot_token: string;
  chat_id: string;
  handle: string;
  last_seen_update_id?: number;
}

export class TelegramTransport implements Transport {
  private bot: Bot | null = null;
  private chatId = "";
  private handle = "";
  private botUserId = 0;
  private lastSeenUpdateId = 0;

  async init(config: TransportConfig): Promise<void> {
    const c = config as TelegramConfig;
    if (!c.bot_token || !c.chat_id) {
      throw new Error("TelegramTransport requires bot_token and chat_id");
    }
    this.bot = new Bot(c.bot_token);
    this.chatId = c.chat_id;
    this.handle = c.handle;
    this.lastSeenUpdateId = c.last_seen_update_id ?? 0;

    // Resolve bot identity for self-filtering
    const me = await this.callTelegramApi(() => this.bot!.api.getMe());
    this.botUserId = me.id;
  }

  async whoami(): Promise<Identity> {
    if (!this.bot) throw new Error("Transport not initialized");
    const me = await this.callTelegramApi(() => this.bot!.api.getMe());
    return {
      handle: me.username!,
      display_name: me.first_name,
      bot_id: me.id,
      chat_id: this.chatId,
    };
  }

  async listContacts(): Promise<Contact[]> {
    if (!this.bot) throw new Error("Transport not initialized");
    const admins = await this.callTelegramApi(() =>
      this.bot!.api.getChatAdministrators(this.chatId),
    );
    return admins
      .filter((m) => m.user.id !== this.botUserId)
      .map((m) => ({
        handle: m.user.username ?? `user_${m.user.id}`,
        display_name: m.user.first_name ?? null,
        is_bot: m.user.is_bot,
      }));
  }

  async send(opts: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error("Transport not initialized");
    const text = opts.to && opts.to !== "broadcast" ? `@${opts.to} ${opts.body}` : opts.body;
    const sent = await this.callTelegramApi(() =>
      this.bot!.api.sendMessage(this.chatId, text, {
        reply_parameters: opts.reply_to_message_id
          ? { message_id: Number(opts.reply_to_message_id) }
          : undefined,
      }),
    );
    return {
      message_id: String(sent.message_id),
      timestamp: new Date(sent.date * 1000),
    };
  }

  async receive(opts: ReceiveOptions): Promise<ReceivedMessage[]> {
    // For Telegram, receive() and waitForMessages() share the same getUpdates source.
    // receive() uses timeout=0 (non-blocking poll), waitForMessages() uses long-poll.
    return this.fetchUpdates({ timeoutSeconds: 0, filter: opts.filter, limit: opts.limit });
  }

  async waitForMessages(opts: WaitOptions): Promise<ReceivedMessage[]> {
    return this.fetchUpdates({
      timeoutSeconds: opts.timeout_seconds ?? 30,
      filter: opts.filter,
    });
  }

  private async fetchUpdates(args: {
    timeoutSeconds: number;
    filter?: "mentions" | "replies" | "all";
    limit?: number;
  }): Promise<ReceivedMessage[]> {
    if (!this.bot) throw new Error("Transport not initialized");
    const updates = await this.callTelegramApi(() =>
      this.bot!.api.getUpdates({
        offset: this.lastSeenUpdateId + 1,
        timeout: args.timeoutSeconds,
        allowed_updates: ["message"],
        limit: args.limit ?? 100,
      }),
    );

    // Advance internal offset to prevent re-receiving these updates
    if (updates.length > 0) {
      this.lastSeenUpdateId = Math.max(...updates.map((u) => u.update_id));
    }

    const myMention = `@${(await this.whoami()).handle}`.toLowerCase();
    const mapped: ReceivedMessage[] = [];

    for (const update of updates) {
      const msg = update.message;
      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== this.chatId) continue;
      if (msg.from?.id === this.botUserId) continue; // skip self

      const isMention = msg.text.toLowerCase().includes(myMention);
      if (args.filter === "mentions" && !isMention) continue;
      if (args.filter === "replies" && msg.reply_to_message?.from?.id !== this.botUserId) continue;

      mapped.push({
        id: `${update.update_id}:${msg.message_id}`,
        from_handle: msg.from?.username ?? `user_${msg.from?.id ?? 0}`,
        body: msg.text,
        timestamp: new Date(msg.date * 1000),
        reply_to_message_id: msg.reply_to_message
          ? String(msg.reply_to_message.message_id)
          : undefined,
        is_mention: isMention,
        raw: update,
      });
    }

    return mapped;
  }

  getLastSeenUpdateId(): number {
    return this.lastSeenUpdateId;
  }

  async close(): Promise<void> {
    this.bot = null;
  }

  private async callTelegramApi<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapTelegramError(err);
    }
  }
}

function mapTelegramError(err: unknown): Error {
  if (err instanceof GrammyError) {
    const description = err.description.toLowerCase();
    if (err.error_code === 401) {
      return authError(
        "Telegram rejected the bot token.",
        "Regenerate the bot token with @BotFather and update the transport config.",
      );
    }
    if (err.error_code === 429) {
      return rateLimitedError(err.parameters?.retry_after ?? 1);
    }
    if (err.error_code === 400 && description.includes("chat not found")) {
      return notFoundError(
        "Telegram chat was not found.",
        "Check chat_id and make sure the bot can see the group.",
      );
    }
    if (err.error_code === 403) {
      if (description.includes("privacy")) {
        return privacyModeError(
          "Telegram privacy mode is preventing the bot from reading messages.",
          "Disable privacy mode with @BotFather or mention/reply to the bot explicitly.",
        );
      }
      if (
        description.includes("kicked") ||
        description.includes("not enough rights") ||
        description.includes("not a member") ||
        description.includes("bot was blocked")
      ) {
        return notInGroupError(
          "Telegram bot is not allowed to access this chat.",
          "Add the bot back to the group and grant the permissions required by agent-mouth.",
        );
      }
    }
  }

  if (err instanceof HttpError) {
    return networkError(err.message, "Check network connectivity and Telegram API availability.");
  }

  return err instanceof Error ? err : new Error(String(err));
}
