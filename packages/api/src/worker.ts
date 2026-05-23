import { Agent } from "@agent-mouth/agent";
import { NotesUpdater } from "@agent-mouth/agent-notes-updater";
import { ClaudeRuntime } from "@agent-mouth/agent-runtime";
import type { Transport } from "@agent-mouth/core";
import type {
  ContactStore,
  MessageStore,
  PolicyEngine,
  ThreadStore,
  WorkspaceStore,
} from "@agent-mouth/core";
import { PgBossQueue } from "@agent-mouth/queue-pgboss";
import { SupabaseAuditLogStore, SupabaseDraftStore } from "@agent-mouth/storage-supabase";

export interface WorkerDeps {
  databaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  anthropicApiKey: string;
  defaultModel: string;
  notesModel: string;
  enableNotesUpdater: boolean;
  contactStore: ContactStore;
  messageStore: MessageStore;
  threadStore: ThreadStore;
  workspaceStore: WorkspaceStore;
  policyEngine: PolicyEngine;
  transport: Transport;
}

export interface RespondJobData {
  workspaceId: string;
  contactId: string;
  threadId: string;
  channelType: "telegram" | "email" | "whatsapp" | "discord" | "slack";
  channelId: string;
  channelIdentityId: string | null;
  messageId: string;
  messageContent: string;
}

export interface NotesJobData {
  workspaceId: string;
  contactId: string;
  threadId: string;
}

export async function startWorker(
  deps: WorkerDeps,
): Promise<{ queue: PgBossQueue; stop: () => Promise<void> }> {
  const queue = new PgBossQueue({ connectionString: deps.databaseUrl });
  await queue.start();

  const auditStore = new SupabaseAuditLogStore({
    url: deps.supabaseUrl,
    anonKey: deps.supabaseAnonKey,
  });
  const draftStore = new SupabaseDraftStore({
    url: deps.supabaseUrl,
    anonKey: deps.supabaseAnonKey,
  });

  const sonnet = new ClaudeRuntime();
  await sonnet.initialize({
    apiKey: deps.anthropicApiKey,
    defaultModel: deps.defaultModel,
  });

  const haiku = new ClaudeRuntime();
  await haiku.initialize({
    apiKey: deps.anthropicApiKey,
    defaultModel: deps.notesModel,
  });

  const agent = new Agent({
    runtime: sonnet,
    contactStore: deps.contactStore,
    messageStore: deps.messageStore,
    auditLogStore: auditStore,
    workspaceStore: deps.workspaceStore,
  });

  const notesUpdater = new NotesUpdater({
    runtime: haiku,
    threads: deps.threadStore,
    messages: deps.messageStore,
    contacts: deps.contactStore,
    audit: auditStore,
  });

  await queue.work<RespondJobData>("agent.respond", async (data) => {
    await handleRespondJob(data, { agent, queue, deps, auditStore, draftStore });
  });

  if (deps.enableNotesUpdater) {
    await queue.work<NotesJobData>("agent.notes.maybe_update", async (data) => {
      await notesUpdater.maybeUpdate(data);
    });
  }

  return {
    queue,
    stop: async () => {
      await queue.stop();
      await sonnet.dispose();
      await haiku.dispose();
    },
  };
}

export async function handleRespondJob(
  data: RespondJobData,
  ctx: {
    agent: Agent;
    queue: PgBossQueue;
    deps: WorkerDeps;
    auditStore: SupabaseAuditLogStore;
    draftStore: SupabaseDraftStore;
  },
): Promise<void> {
  const policy = await ctx.deps.policyEngine.evaluate({
    workspaceId: data.workspaceId,
    contactId: data.contactId,
    channelType: data.channelType,
  });

  if (policy.policy === "silent") return;

  const t0 = Date.now();
  const out = await ctx.agent.respond({
    workspaceId: data.workspaceId,
    contactId: data.contactId,
    threadId: data.threadId,
    channelType: data.channelType,
    incomingMessageId: data.messageId,
    incomingContent: data.messageContent,
    policy,
  });
  const latencyMs = Date.now() - t0;

  if (out.decision === "ready_to_send") {
    const sent = await ctx.deps.transport.send({
      to: data.channelId,
      body: out.response.body,
    });
    await ctx.deps.messageStore.insert({
      threadId: data.threadId,
      channelId: data.channelId,
      channelIdentityId: data.channelIdentityId,
      direction: "outbound",
      content: out.response.body,
      attachments: [],
      rawPayload: { externalMessageId: sent?.message_id ?? null },
      externalMessageId: sent?.message_id ?? null,
      sentBy: "agent",
    });
    await ctx.auditStore.write({
      workspace_id: data.workspaceId,
      action: "agent.respond",
      actor: "agent",
      related_message_id: data.messageId,
      related_contact_id: data.contactId,
      decision: "sent",
      tokens_in: out.response.tokens.in,
      tokens_out: out.response.tokens.out,
      tokens_cached: out.response.tokens.cached,
      cost_usd: out.response.costUsd,
      latency_ms: latencyMs,
      model_id: policy.model_id ?? ctx.deps.defaultModel,
    });
  } else if (out.decision === "ready_to_draft") {
    const existing = await ctx.draftStore.findPendingByMessageId(data.messageId);
    if (!existing) {
      await ctx.draftStore.insert({
        message_id: data.messageId,
        proposed_body: out.response.body,
        agent_reasoning: out.response.reasoning,
        tools_called: [],
      });
    }
    await ctx.auditStore.write({
      workspace_id: data.workspaceId,
      action: "agent.respond",
      actor: "agent",
      related_message_id: data.messageId,
      related_contact_id: data.contactId,
      decision: "draft",
      tokens_in: out.response.tokens.in,
      tokens_out: out.response.tokens.out,
      tokens_cached: out.response.tokens.cached,
      cost_usd: out.response.costUsd,
      latency_ms: latencyMs,
      model_id: policy.model_id ?? ctx.deps.defaultModel,
    });
  } else {
    await ctx.auditStore.write({
      workspace_id: data.workspaceId,
      action: "agent.respond",
      actor: "agent",
      related_message_id: data.messageId,
      related_contact_id: data.contactId,
      decision: out.decision === "escalated" ? "escalated" : "blocked",
      block_reason: "blockReason" in out ? out.blockReason : undefined,
      latency_ms: latencyMs,
    });
  }

  if (ctx.deps.enableNotesUpdater) {
    await ctx.queue.send("agent.notes.maybe_update", {
      workspaceId: data.workspaceId,
      contactId: data.contactId,
      threadId: data.threadId,
    });
  }
}
