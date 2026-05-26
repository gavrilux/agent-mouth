import type { ChannelType, Contact, MessageStore, OffsetStore, Transport } from "@agent-mouth/core";

/** Light-weight thread row shape needed by tools that infer channel from a reply context. */
export interface ToolThreadRef {
  id: string;
  channel_id: string;
}

/** Light-weight channel row shape needed by tools that need the channel type. */
export interface ToolChannelRef {
  id: string;
  type: ChannelType;
}

export interface ToolContext {
  transport: Transport;
  configPath?: string;
  offsetStore?: OffsetStore;
  handle?: string;
  messageStore?: MessageStore;
  workspaceId?: string;
  /**
   * Phase 1b — multi-transport routing. Resolves the right Transport per ChannelType
   * (e.g. "telegram" vs "email"). When absent, tools fall back to `transport`.
   */
  transportRegistry?: { get(type: ChannelType): Transport };
  /** Phase 1b — used by send_message to infer channel from reply_to_message_id. */
  threadStore?: { findById(id: string): Promise<ToolThreadRef | null> };
  /** Phase 1b — used by send_message to infer channel from a thread's channel_id. */
  channelStore?: { findById(id: string): Promise<ToolChannelRef | null> };
  /** Phase 1b — used by link_email_to_contact MCP tool. */
  contactStore?: {
    addEmailToMetadata(workspaceId: string, contactId: string, email: string): Promise<Contact>;
  };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

export const tools: ToolDef[] = [];

export function registerTool(tool: ToolDef): void {
  if (tools.find((t) => t.name === tool.name)) return; // idempotent
  tools.push(tool);
}
