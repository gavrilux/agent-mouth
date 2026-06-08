import { z } from "zod";

export const ChannelTypeSchema = z.enum(["telegram", "email", "whatsapp", "discord", "slack"]);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const MessageDirectionSchema = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  channel_type: ChannelTypeSchema,
  direction: MessageDirectionSchema,
  external_id: z.string(),
  sender_identifier: z.string(),
  content: z.string(),
  created_at: z.string(), // ISO 8601
  attachments: z.array(z.unknown()).optional(),
  raw_payload: z.unknown().optional(),
});
export type Message = z.infer<typeof MessageSchema>;
