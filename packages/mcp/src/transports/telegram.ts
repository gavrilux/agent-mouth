import { Bot } from "grammy";
import type {
  Contact,
  Identity,
  ReceivedMessage,
  ReceiveOptions,
  SendOptions,
  SentMessage,
  Transport,
  TransportConfig,
  WaitOptions
} from "./types.js";

export interface TelegramConfig extends TransportConfig {
  bot_token: string;
  chat_id: string;
  handle: string;
}

export class TelegramTransport implements Transport {
  private bot: Bot | null = null;
  private chatId: string = "";
  private handle: string = "";
  private botUserId: number = 0;

  async init(config: TransportConfig): Promise<void> {
    const c = config as TelegramConfig;
    if (!c.bot_token || !c.chat_id) {
      throw new Error("TelegramTransport requires bot_token and chat_id");
    }
    this.bot = new Bot(c.bot_token);
    this.chatId = c.chat_id;
    this.handle = c.handle;

    // Resolve bot identity for self-filtering
    const me = await this.bot.api.getMe();
    this.botUserId = me.id;
  }

  async whoami(): Promise<Identity> {
    if (!this.bot) throw new Error("Transport not initialized");
    const me = await this.bot.api.getMe();
    return {
      handle: me.username!,
      display_name: me.first_name,
      bot_id: me.id,
      chat_id: this.chatId
    };
  }

  async listContacts(): Promise<Contact[]> {
    if (!this.bot) throw new Error("Transport not initialized");
    const admins = await this.bot.api.getChatAdministrators(this.chatId);
    return admins
      .filter((m) => m.user.id !== this.botUserId)
      .map((m) => ({
        handle: m.user.username ?? `user_${m.user.id}`,
        display_name: m.user.first_name ?? null,
        is_bot: m.user.is_bot
      }));
  }

  async send(opts: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error("Transport not initialized");
    const text = opts.to && opts.to !== "broadcast"
      ? `@${opts.to} ${opts.body}`
      : opts.body;
    const sent = await this.bot.api.sendMessage(this.chatId, text, {
      reply_parameters: opts.reply_to_message_id
        ? { message_id: Number(opts.reply_to_message_id) }
        : undefined
    });
    return {
      message_id: String(sent.message_id),
      timestamp: new Date(sent.date * 1000)
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
      filter: opts.filter
    });
  }

  private async fetchUpdates(args: {
    timeoutSeconds: number;
    filter?: "mentions" | "replies" | "all";
    limit?: number;
  }): Promise<ReceivedMessage[]> {
    if (!this.bot) throw new Error("Transport not initialized");
    const updates = await this.bot.api.getUpdates({
      timeout: args.timeoutSeconds,
      allowed_updates: ["message"],
      limit: args.limit ?? 100
    });

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
        raw: update
      });
    }

    return mapped;
  }

  async close(): Promise<void> {
    this.bot = null;
  }
}
