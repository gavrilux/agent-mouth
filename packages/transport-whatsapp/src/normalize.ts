// packages/transport-whatsapp/src/normalize.ts
import type { InboundMessage } from "@agent-mouth/core";
import { WhatsAppTextMessageSchema, WhatsAppValueSchema } from "./schema.js";

/**
 * Convert a Meta webhook `value` object into zero or more InboundMessage rows.
 * - Returns [] for status/receipt events (value has `statuses` and/or no `messages`).
 * - Each entry in `messages[]` is validated against WhatsAppTextMessageSchema;
 *   non-text messages (image/audio/...) are skipped (out of scope v1).
 * The contact display name comes from contacts[0].profile.name, falling back to
 * the message sender's wa_id when absent.
 */
export function whatsappMessageToInbound(
  value: unknown,
  channelId: string,
): InboundMessage[] {
  const parsedValue = WhatsAppValueSchema.safeParse(value);
  if (!parsedValue.success) return [];
  const v = parsedValue.data;
  if (!v.messages || v.messages.length === 0) return [];

  const contactName = v.contacts?.[0]?.profile?.name ?? null;

  const out: InboundMessage[] = [];
  for (const raw of v.messages) {
    const msg = WhatsAppTextMessageSchema.safeParse(raw);
    if (!msg.success) continue; // skip non-text
    const m = msg.data;
    out.push({
      channel_type: "whatsapp",
      external_message_id: m.id, // wamid
      external_thread_id: m.from, // wa_id — one thread per sender
      sender_identifier: m.from, // wa_id
      sender_display_name: contactName ?? m.from,
      sender_handle: null,
      chat_type: "private",
      content: m.text.body,
      attachments: [],
      raw_payload: {
        whatsapp: raw as Record<string, unknown>,
        channel_id: channelId,
        metadata: v.metadata as unknown as Record<string, unknown>,
      },
      received_at: new Date(Number(m.timestamp) * 1000).toISOString(),
    });
  }
  return out;
}
