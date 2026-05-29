// packages/transport-whatsapp/src/whatsapp-transport.ts
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

export interface WhatsAppConfig {
  phone_number_id: string;
  access_token: string; // permanent System User token (Fly secret)
  graph_version?: string; // default "v21.0"
  display_phone_number?: string;
}

const DEFAULT_GRAPH_VERSION = "v21.0";

/**
 * WhatsAppTransport bridges the Phase 0 `Transport` interface to the Meta
 * WhatsApp Cloud API (Graph). Text-only, reactive.
 *
 * receive() and waitForMessages() return [] because WhatsApp ingress happens
 * via the /whatsapp-webhook handler (Meta pushes the message body); the agent
 * reads cross-channel history from MessageStore.
 */
export class WhatsAppTransport implements Transport {
  constructor(private readonly cfg: WhatsAppConfig) {}

  async init(_config: TransportConfig): Promise<void> {
    // No-op: config injected at construction.
  }

  async whoami(): Promise<Identity> {
    const handle = this.cfg.display_phone_number ?? this.cfg.phone_number_id;
    return { handle, display_name: "WhatsApp Business", chat_id: handle };
  }

  async listContacts(): Promise<TransportContact[]> {
    return [];
  }

  async send(opts: SendOptions): Promise<SentMessage> {
    if (!opts.to) throw new Error("WhatsAppTransport.send: `to` (wa_id) is required");
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: opts.to,
      type: "text",
      text: { preview_url: false, body: opts.body },
    };
    if (opts.reply_to_message_id) {
      body.context = { message_id: opts.reply_to_message_id };
    }
    const version = this.cfg.graph_version ?? DEFAULT_GRAPH_VERSION;
    const res = await fetch(
      `https://graph.facebook.com/${version}/${this.cfg.phone_number_id}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`WhatsApp send failed ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { messages?: { id: string }[] };
    return { message_id: json.messages?.[0]?.id ?? "", timestamp: new Date() };
  }

  async receive(_opts: ReceiveOptions): Promise<ReceivedMessage[]> {
    return [];
  }

  async waitForMessages(_opts: WaitOptions): Promise<ReceivedMessage[]> {
    return [];
  }

  async close(): Promise<void> {
    // No persistent state to release.
  }
}
