import type { NormalizedEmail } from "@agent-mouth/core";

export interface SendEmailArgs {
  /** From-address (matches the EmailToken.email_address used to authenticate) */
  from_address: string;
  to_addresses: string[];
  cc_addresses?: string[];
  subject: string;
  body_text: string;
  in_reply_to?: string; // RFC822 Message-ID header value
  references?: string[]; // accumulated thread references
}

export interface SendEmailResult {
  message_id: string; // Gmail message id
  thread_id: string; // Gmail threadId
}

export interface FetchResult {
  messages: NormalizedEmail[];
  next_cursor: string; // new historyId (or empty if unchanged)
}

export interface WatchResult {
  history_id: string; // historyId at watch creation time
  expiration: string; // ISO 8601 — when this watch expires (~7 days out)
}

/** Per-token state injected into the driver before each call */
export interface EmailDriverAuthCtx {
  refresh_token: string;
  email_address: string;
}
