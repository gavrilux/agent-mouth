// packages/core/src/email.ts
import { z } from "zod";

export const EmailTokenStatusEnum = z.enum(["active", "error", "revoked"]);
export type EmailTokenStatus = z.infer<typeof EmailTokenStatusEnum>;

export const EmailTokenSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  email_address: z.string().email(),
  refresh_token_encrypted: z.string(),
  scopes: z.array(z.string()).default([]),
  last_history_id: z.string().nullable().default(null),
  watch_expiration: z.string().datetime({ offset: true }).nullable().default(null),
  status: EmailTokenStatusEnum.default("active"),
  last_error: z.string().nullable().default(null),
  consecutive_renewal_failures: z.number().int().nonnegative().default(0),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type EmailToken = z.infer<typeof EmailTokenSchema>;

export const NormalizedEmailSchema = z.object({
  external_id: z.string().min(1),
  external_thread_id: z.string().min(1),
  from_address: z.string().email(),
  from_name: z.string().nullable(),
  to_addresses: z.array(z.string().email()),
  cc_addresses: z.array(z.string().email()).default([]),
  subject: z.string(),
  body_text: z.string(),
  body_html: z.string().nullable().default(null),
  message_id_header: z.string(),
  in_reply_to_header: z.string().nullable().default(null),
  references_header: z.array(z.string()).default([]),
  received_at: z.string().datetime({ offset: true }),
});
export type NormalizedEmail = z.infer<typeof NormalizedEmailSchema>;

export const EmailWebhookEventSchema = z.object({
  id: z.string().uuid(),
  email_address: z.string().email(),
  history_id: z.string(),
  received_at: z.string().datetime({ offset: true }),
});
export type EmailWebhookEvent = z.infer<typeof EmailWebhookEventSchema>;
