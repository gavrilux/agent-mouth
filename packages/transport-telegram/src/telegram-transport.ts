import type {
  Identity,
  OffsetStore,
  ReceiveOptions,
  ReceivedMessage,
  SendOptions,
  SentMessage,
  Transport,
  TransportConfig,
  TransportContact,
  WaitOptions,
} from "@agent-mouth/core";
import { Bot } from "grammy";

export interface TelegramConfig extends TransportConfig {
  bot_token: string;
  chat_id: string;
  handle: string;
  last_seen_update_id?: number;
  offsetStore?: OffsetStore;
}

export class TelegramTransport implements Transport {
  private bot: Bot | null = null;
  private chatId = "";
  private handle = "";
  private botUserId = 0;
  private lastSeenUpdateId = 0;
  private offsetStore?: OffsetStore;

  async init(config: TransportConfig): Promise<void> {
    const c = config as TelegramConfig;
    if (!c.bot_token || !c.chat_id) {
      throw new Error("TelegramTransport requires bot_token and chat_id");
    }
    this.bot = new Bot(c.bot_token);
    this.chatId = c.chat_id;
    this.handle = c.handle;
    this.offsetStore = c.offsetStore;

    if (c.offsetStore) {
      this.lastSeenUpdateId = await c.offsetStore.getOffset(c.handle);
    } else {
      this.lastSeenUpdateId = c.last_seen_update_id ?? 0;
    }

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
      chat_id: this.chatId,
    };
  }

  async listContacts(): Promise<TransportContact[]> {
    if (!this.bot) throw new Error("Transport not initialized");
    const admins = await this.bot.api.getChatAdministrators(this.chatId);
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
    // If `to` looks like a numeric chat id (positive for private, negative for groups),
    // send directly to that chat (1-on-1 reply path used by the agent worker).
    // Otherwise treat it as a username/handle and mention it in the configured chat (Phase 0 group behavior).
    const isNumericChatId = !!opts.to && /^-?\d+$/.test(opts.to);
    const targetChat = isNumericChatId ? opts.to! : this.chatId;
    const text =
      !isNumericChatId && opts.to && opts.to !== "broadcast"
        ? `@${opts.to} ${opts.body}`
        : opts.body;
    const sent = await this.bot.api.sendMessage(targetChat, text, {
      reply_parameters: opts.reply_to_message_id
        ? { message_id: Number(opts.reply_to_message_id) }
        : undefined,
    });
    return {
      message_id: String(sent.message_id),
      timestamp: new Date(sent.date * 1000),
    };
  }

  async receive(opts: ReceiveOptions): Promise<ReceivedMessage[]> {
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
    const updates = await this.bot.api.getUpdates({
      offset: this.lastSeenUpdateId + 1,
      timeout: args.timeoutSeconds,
      allowed_updates: ["message"],
      limit: args.limit ?? 100,
    });

    if (updates.length > 0) {
      this.lastSeenUpdateId = Math.max(...updates.map((u) => u.update_id));
      await this.offsetStore?.saveOffset(this.handle, this.lastSeenUpdateId);
    }

    const myMention = `@${(await this.whoami()).handle}`.toLowerCase();
    const mapped: ReceivedMessage[] = [];

    for (const update of updates) {
      const msg = update.message;
      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== this.chatId) continue;
      if (msg.from?.id === this.botUserId) continue;

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
}
