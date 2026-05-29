// packages/transport-whatsapp/src/schema.ts
import { z } from "zod";

/** A single inbound WhatsApp text message (type === "text"). Non-text messages fail this guard. */
export const WhatsAppTextMessageSchema = z.object({
  from: z.string(), // wa_id of sender (digits)
  id: z.string(), // wamid
  timestamp: z.string(), // unix seconds as string
  type: z.literal("text"),
  text: z.object({ body: z.string() }),
});
export type WhatsAppTextMessage = z.infer<typeof WhatsAppTextMessageSchema>;

/** The `value` object inside a `changes[]` entry. */
export const WhatsAppValueSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  metadata: z.object({
    phone_number_id: z.string(),
    display_phone_number: z.string().optional(),
  }),
  contacts: z
    .array(
      z.object({
        profile: z.object({ name: z.string() }).optional(),
        wa_id: z.string(),
      }),
    )
    .optional(),
  // Narrowed to text via WhatsAppTextMessageSchema in normalize.
  messages: z.array(z.unknown()).optional(),
  // Presence => delivery/read receipt event; skipped by the handler.
  statuses: z.array(z.unknown()).optional(),
});
export type WhatsAppValue = z.infer<typeof WhatsAppValueSchema>;

export const WhatsAppWebhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: WhatsAppValueSchema })),
    }),
  ),
});
export type WhatsAppWebhook = z.infer<typeof WhatsAppWebhookSchema>;
