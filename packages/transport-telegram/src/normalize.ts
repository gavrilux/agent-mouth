// packages/transport-telegram/src/normalize.ts
import type { InboundMessage } from "@agent-mouth/core";

interface TgUser { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string }
interface TgChat { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string; first_name?: string; last_name?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; date: number; text?: string }
interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: unknown }

export function telegramUpdateToInbound(update: TgUpdate): InboundMessage | null {
  const m = update.message;
  if (!m || !m.from || typeof m.text !== "string") return null;
  const displayName = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || String(m.from.id);
  return {
    channel_type: "telegram",
    external_message_id: String(m.message_id),
    external_thread_id: String(m.chat.id),
    sender_identifier: String(m.from.id),
    sender_display_name: displayName,
    sender_handle: m.from.username ?? null,
    chat_type: m.chat.type,
    content: m.text,
    attachments: [],
    raw_payload: update as unknown as Record<string, unknown>,
    received_at: new Date(m.date * 1000).toISOString(),
  };
}
