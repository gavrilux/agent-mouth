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

  async send(_opts: SendOptions): Promise<SentMessage> {
    throw new Error("not implemented in Task 3");
  }

  async receive(_opts: ReceiveOptions): Promise<ReceivedMessage[]> {
    throw new Error("not implemented in Task 3");
  }

  async waitForMessages(_opts: WaitOptions): Promise<ReceivedMessage[]> {
    throw new Error("not implemented in Task 3");
  }

  async close(): Promise<void> {
    this.bot = null;
  }
}
