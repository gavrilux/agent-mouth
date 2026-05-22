// packages/core/src/stores.ts
import type { Workspace, Contact, ChannelIdentity, Channel, Policy, Thread } from "./identity.js";

export interface WorkspaceStore {
  getDefault(): Promise<Workspace>;
}

export interface ContactStore {
  findById(workspaceId: string, id: string): Promise<Contact | null>;
  upsertByDisplayName(workspaceId: string, displayName: string): Promise<Contact>;
  updateNotes(contactId: string, notes: string): Promise<void>;
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
  get(threadId: string): Promise<Thread | null>;
  markNotesUpdated(threadId: string): Promise<void>;
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
  lastN(threadId: string, n: number): Promise<PersistedMessage[]>;
  countSinceTimestamp(threadId: string, sinceIso: string): Promise<number>;
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

export interface Draft {
  id: string;
  message_id: string;
  proposed_body: string;
  agent_reasoning: string;
  tools_called: Array<Record<string, unknown>>;
  status: "pending" | "approved" | "rejected" | "edited";
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  workspace_id: string;
  action: string;
  actor: "human" | "agent" | "system";
  details: Record<string, unknown>;
  related_message_id: string | null;
  related_contact_id: string | null;
  decision: "sent" | "draft" | "blocked" | "escalated" | "no_action" | null;
  block_reason: string | null;
  model_id: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cached: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  created_at: string;
}

export interface DraftStore {
  /** Inserts a draft with status='pending'. Approval workflow handled outside this interface. */
  insert(input: Omit<Draft, "id" | "created_at" | "status" | "approved_by" | "approved_at">): Promise<Draft>;
  findPendingByMessageId(messageId: string): Promise<Draft | null>;
}

export interface AuditLogInput {
  workspace_id: string;
  action: string;
  actor: "human" | "agent" | "system";
  details?: Record<string, unknown>;
  related_message_id?: string | null;
  related_contact_id?: string | null;
  decision?: AuditEntry["decision"];
  block_reason?: string | null;
  model_id?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  tokens_cached?: number | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
}

export interface AuditLogStore {
  write(input: AuditLogInput): Promise<AuditEntry>;
  sumCostUsdSince(workspaceId: string, sinceIso: string): Promise<number>;
  countSentOrDraftSince(contactId: string, sinceIso: string): Promise<number>;
  findRespondedFor(messageId: string): Promise<AuditEntry | null>;
}

export interface JobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Returns the job id, or null if deduplicated by singletonKey. */
  send<T>(name: string, data: T, options?: { singletonKey?: string }): Promise<string | null>;
  work<T>(name: string, handler: (data: T) => Promise<void>): Promise<void>;
}
