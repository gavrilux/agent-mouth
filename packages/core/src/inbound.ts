// packages/core/src/inbound.ts
import { z } from "zod";
import { ChannelTypeEnum } from "./identity.js";

export const InboundMessageSchema = z.object({
  channel_type: ChannelTypeEnum,
  external_message_id: z.string().min(1),
  external_thread_id: z.string().min(1),
  sender_identifier: z.string().min(1),
  sender_display_name: z.string().min(1),
  sender_handle: z.string().nullable(),
  chat_type: z.enum(["private", "group", "supergroup", "channel"]),
  content: z.string().min(1),
  attachments: z.array(z.record(z.unknown())).default([]),
  raw_payload: z.record(z.unknown()),
  received_at: z.string().datetime(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
