// packages/core/src/identity.ts
import { z } from "zod";

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  owner_user_id: z.string().uuid().nullable(),
  plan: z.string().default("self-host"),
  daily_budget_usd_cap: z.number().default(0),
  created_at: z.string().datetime({ offset: true }),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const ContactSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  display_name: z.string().min(1),
  notes: z.string().default(""),
  created_at: z.string().datetime({ offset: true }),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ChannelTypeEnum = z.enum(["telegram", "email", "whatsapp", "discord", "slack"]);
export type ChannelType = z.infer<typeof ChannelTypeEnum>;

export const ChannelSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  type: ChannelTypeEnum,
  config: z.record(z.unknown()),
  status: z.enum(["active", "paused", "error"]).default("active"),
  created_at: z.string().datetime({ offset: true }),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const ChannelIdentitySchema = z.object({
  id: z.string().uuid(),
  contact_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  identifier: z.string().min(1),
  verified: z.boolean().default(false),
});
export type ChannelIdentity = z.infer<typeof ChannelIdentitySchema>;

export const PolicyActionEnum = z.enum(["auto", "suggest", "escalate", "silent"]);
export type PolicyAction = z.infer<typeof PolicyActionEnum>;

export const PolicySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  contact_id: z.string().uuid().nullable(),
  channel_type: ChannelTypeEnum.nullable(),
  policy: PolicyActionEnum,
  system_prompt: z.string().default(""),
  rules: z.record(z.unknown()).default({}),
  priority: z.number().int().default(0),
  model_id: z.string().nullable().default(null),
  rate_limit_per_hour: z.number().int().nonnegative().default(60),
  max_tokens_out: z.number().int().positive().default(8000),
  max_tool_calls: z.number().int().nonnegative().default(10),
  forbidden_topics_regex: z.array(z.string()).default([]),
  escalate_triggers_regex: z.array(z.string()).default([]),
  created_at: z.string().datetime({ offset: true }),
});
export type Policy = z.infer<typeof PolicySchema>;

export const ThreadSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  external_thread_id: z.string().nullable(),
  related_thread_ids: z.array(z.string().uuid()).default([]),
  last_message_at: z.string().datetime({ offset: true }).nullable(),
  closed: z.boolean().default(false),
  created_at: z.string().datetime({ offset: true }),
});
export type Thread = z.infer<typeof ThreadSchema>;
