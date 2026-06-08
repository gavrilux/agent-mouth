import type {
  Identity,
  ReceiveOptions,
  ReceivedMessage,
  SendOptions,
  SentMessage,
  Transport,
  TransportConfig,
  TransportContact,
  WaitOptions,
} from "@agent-mouth/core";
import type { EmailDriver } from "./drivers/driver.js";
import type { EmailDriverAuthCtx } from "./types.js";

export interface EmailTransportOptions {
  driver: EmailDriver;
  auth: EmailDriverAuthCtx;
}

/**
 * EmailTransport bridges the Phase 0 `Transport` interface to Gmail (via EmailDriver).
 *
 * Note: receive() and waitForMessages() return [] because email ingress happens
 * via webhook + cron polling at the worker layer (not via Transport.receive).
 * read_inbox in the MCP server uses MessageStore (cross-channel) which already
 * has the persisted emails.
 */
export class EmailTransport implements Transport {
  constructor(private readonly opts: EmailTransportOptions) {}

  async init(_config: TransportConfig): Promise<void> {
    // No-op: auth is injected at construction
  }

  async whoami(): Promise<Identity> {
    return {
      handle: this.opts.auth.email_address,
      display_name: this.opts.auth.email_address,
      chat_id: this.opts.auth.email_address,
    };
  }

  async listContacts(): Promise<TransportContact[]> {
    return [];
  }

  async send(opts: SendOptions): Promise<SentMessage> {
    if (!opts.to) throw new Error("EmailTransport.send: `to` (recipient address) is required");
    const result = await this.opts.driver.send({
      auth: this.opts.auth,
      payload: {
        from_address: this.opts.auth.email_address,
        to_addresses: [opts.to],
        subject: opts.subject ?? "(no subject)",
        body_text: opts.body,
        in_reply_to: opts.reply_to_message_id ?? undefined,
      },
    });
    return { message_id: result.message_id, timestamp: new Date() };
  }

  async receive(_opts: ReceiveOptions): Promise<ReceivedMessage[]> {
    return [];
  }

  async waitForMessages(_opts: WaitOptions): Promise<ReceivedMessage[]> {
    return [];
  }

  async close(): Promise<void> {
    // No persistent state to release
  }
}
