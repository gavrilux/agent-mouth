export interface Identity {
  handle: string; // bot username without @
  display_name: string;
  bot_id?: number; // Telegram-specific, optional in interface
  chat_id?: string; // current group context
}

export interface Contact {
  handle: string;
  display_name: string | null;
  is_bot: boolean;
  last_seen?: Date;
}

export interface ReceivedMessage {
  id: string; // serialized "<update_id>:<message_id>"
  from_handle: string;
  body: string;
  timestamp: Date;
  reply_to_message_id?: string;
  is_mention: boolean; // whether this message mentions me
  raw?: unknown;
}

export interface SentMessage {
  message_id: string;
  timestamp: Date;
}

export interface SendOptions {
  to?: string; // handle, or "broadcast" / undefined
  body: string;
  reply_to_message_id?: string;
}

export interface ReceiveOptions {
  filter?: "mentions" | "replies" | "all";
  since_message_id?: string;
  limit?: number;
}

export interface WaitOptions {
  timeout_seconds?: number;
  filter?: "mentions" | "replies" | "all";
}

export interface TransportConfig {
  [key: string]: unknown;
}

export interface Transport {
  init(config: TransportConfig): Promise<void>;
  whoami(): Promise<Identity>;
  listContacts(): Promise<Contact[]>;
  send(opts: SendOptions): Promise<SentMessage>;
  receive(opts: ReceiveOptions): Promise<ReceivedMessage[]>;
  waitForMessages(opts: WaitOptions): Promise<ReceivedMessage[]>;
  close(): Promise<void>;
}
