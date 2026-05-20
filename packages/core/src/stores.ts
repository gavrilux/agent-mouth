// packages/core/src/stores.ts
import type { Workspace, Contact, ChannelIdentity, Channel, Policy, Thread } from "./identity.js";

export interface WorkspaceStore {
  getDefault(): Promise<Workspace>;
}

export interface ContactStore {
  findById(workspaceId: string, id: string): Promise<Contact | null>;
  upsertByDisplayName(workspaceId: string, displayName: string): Promise<Contact>;
}

export interface IdentityResolveResult {
  contact: Contact;
  channel: Channel;
  channel_identity: ChannelIdentity;
  created: boolean;
}

export interface IdentityResolver {
  resolveOrCreate(args: {
    workspaceId: string;
    channelType: Channel["type"];
    identifier: string;
    displayName: string;
  }): Promise<IdentityResolveResult>;
}

export interface PolicyEngine {
  evaluate(args: {
    workspaceId: string;
    contactId: string;
    channelType: Channel["type"];
  }): Promise<Policy>;
}

export interface ThreadStore {
  resolveOrCreate(args: {
    workspaceId: string;
    contactId: string;
    channelId: string;
    externalThreadId: string;
  }): Promise<Thread>;
}

export interface PersistedMessageInput {
  threadId: string;
  channelId: string;
  channelIdentityId: string | null;
  direction: "inbound" | "outbound";
  content: string;
  attachments: Array<Record<string, unknown>>;
  rawPayload: Record<string, unknown> | null;
  externalMessageId: string | null;
  sentBy: "human" | "agent" | null;
}

export interface PersistedMessage {
  id: string;
  thread_id: string;
  channel_id: string;
  channel_identity_id: string | null;
  direction: "inbound" | "outbound";
  content: string;
  attachments: Array<Record<string, unknown>>;
  raw_payload: Record<string, unknown> | null;
  external_message_id: string | null;
  sent_by: "human" | "agent" | null;
  created_at: string;
}

export interface MessageStore {
  insert(msg: PersistedMessageInput): Promise<PersistedMessage>;
  listRecent(args: {
    workspaceId: string;
    threadId?: string;
    sinceId?: string;
    limit: number;
  }): Promise<PersistedMessage[]>;
  waitForNew(args: {
    workspaceId: string;
    sinceCreatedAt: string;
    timeoutSeconds: number;
  }): Promise<PersistedMessage[]>;
}
