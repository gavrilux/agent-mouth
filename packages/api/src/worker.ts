import { Agent } from "@agent-mouth/agent";
import { NotesUpdater } from "@agent-mouth/agent-notes-updater";
import { bootstrapTools, resolveToolsForPolicy } from "@agent-mouth/agent-tools";
import { resolveRuntime } from "@agent-mouth/agent-runtime";
import type { KnowledgeSource, Policy, Tool, Transport } from "@agent-mouth/core";
import type {
  ContactStore,
  MessageStore,
  PolicyEngine,
  ThreadStore,
  WorkspaceStore,
} from "@agent-mouth/core";
import { resolveEmbeddingProvider } from "@agent-mouth/embeddings";
import { resolveKnowledgeSource } from "@agent-mouth/knowledge-source";
import { PgBossQueue } from "@agent-mouth/queue-pgboss";
import { SupabaseAuditLogStore, SupabaseDraftStore } from "@agent-mouth/storage-supabase";
import { resolveVectorStore } from "@agent-mouth/vector-store";
import { resolveWebSearchProvider } from "@agent-mouth/web-search";
import { Client as PgClient } from "pg";
import { logger } from "./logger.js";

// Side-effect imports — register providers in their respective registries
import "@agent-mouth/embeddings";
import "@agent-mouth/web-search";
import "@agent-mouth/vector-store";
import "@agent-mouth/knowledge-source";

export interface WorkerDeps {
  databaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  /**
   * API keys keyed by env-var name (e.g. { ANTHROPIC_API_KEY: "sk-...", GOOGLE_API_KEY: "AIza..." }).
   * The runtime registry looks up the right key per model prefix.
   */
  apiKeys: Record<string, string | undefined>;
  defaultModel: string;
  notesModel: string;
  enableNotesUpdater: boolean;
  contactStore: ContactStore;
  messageStore: MessageStore;
  threadStore: ThreadStore;
  workspaceStore: WorkspaceStore;
  policyEngine: PolicyEngine;
  transport: Transport;
  // Phase 3 — when true, attempt to bootstrap tools at startup
  enableAgentTools?: boolean;
  // Workspace ID used to look up the knowledge source row (typically the default workspace)
  defaultWorkspaceId?: string;
}

export interface RespondJobData {
  workspaceId: string;
  contactId: string;
  threadId: string;
  channelType: "telegram" | "email" | "whatsapp" | "discord" | "slack";
  channelId: string;
  channelIdentityId: string | null;
  /** External chat id (e.g. Telegram chat_id) — what transport.send needs as destination. */
  externalChatId: string;
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

  const respondRuntime = await resolveRuntime(deps.defaultModel, deps.apiKeys);
  const notesRuntime = await resolveRuntime(deps.notesModel, deps.apiKeys);

  const agent = new Agent({
    runtime: respondRuntime,
    contactStore: deps.contactStore,
    messageStore: deps.messageStore,
    auditLogStore: auditStore,
    workspaceStore: deps.workspaceStore,
  });

  const notesUpdater = new NotesUpdater({
    runtime: notesRuntime,
    threads: deps.threadStore,
    messages: deps.messageStore,
    contacts: deps.contactStore,
    audit: auditStore,
  });

  // ── Phase 3 bootstrap (tools + knowledge source providers) ──────────────────
  // Any failure here falls back to Phase 2 (no tools) without crashing the worker.
  let toolsResolver: ((policy: Policy) => Tool[]) | null = null;

  if (deps.enableAgentTools && deps.defaultWorkspaceId) {
    try {
      const env = process.env;
      const embedder = await resolveEmbeddingProvider("openai", env);
      const webSearch = await resolveWebSearchProvider("tavily", env);
      const vectorStore = await resolveVectorStore({ type: "pgvector", env });

      // Load knowledge source config from DB — connect inside try/finally to
      // guarantee pg.end() runs even if pg.connect() itself throws.
      const pg = new PgClient({ connectionString: deps.databaseUrl });
      let knowledgeSource: KnowledgeSource | null = null;
      try {
        await pg.connect();
        const { rows } = await pg.query(
          `SELECT id, type, config FROM knowledge_sources WHERE workspace_id = $1 LIMIT 1`,
          [deps.defaultWorkspaceId],
        );
        if (rows.length > 0) {
          knowledgeSource = await resolveKnowledgeSource({
            type: rows[0].type as string,
            config: rows[0].config as Record<string, unknown>,
            env,
          });
        }
      } finally {
        await pg.end().catch(() => {});
      }

      if (knowledgeSource) {
        bootstrapTools({
          webSearchProvider: webSearch,
          vectorStore,
          embedder,
          knowledgeSource,
        });
        toolsResolver = (policy) => resolveToolsForPolicy(policy);
        logger.info(
          "[phase-3] agent tools registered: search_web, search_knowledge, read_knowledge_file",
        );
      } else {
        logger.warn(
          "[phase-3] no knowledge_sources row for workspace — tools NOT registered, falling back to Phase 2",
        );
      }
    } catch (err) {
      logger.error({ err }, "[phase-3] tools bootstrap failed — continuing in Phase 2 mode");
      toolsResolver = null;
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  await queue.work<RespondJobData>("agent.respond", async (data) => {
    await handleRespondJob(data, {
      agent,
      queue,
      deps,
      auditStore,
      draftStore,
      toolsResolver: toolsResolver ?? undefined,
    });
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
      await respondRuntime.dispose();
      await notesRuntime.dispose();
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
    toolsResolver?: (policy: Policy) => Tool[];
  },
): Promise<void> {
  const policy = await ctx.deps.policyEngine.evaluate({
    workspaceId: data.workspaceId,
    contactId: data.contactId,
    channelType: data.channelType,
  });

  if (policy.policy === "silent") return;

  const t0 = Date.now();
  const tools = ctx.toolsResolver ? ctx.toolsResolver(policy) : undefined;
  const out = await ctx.agent.respond({
    workspaceId: data.workspaceId,
    contactId: data.contactId,
    threadId: data.threadId,
    channelType: data.channelType,
    incomingMessageId: data.messageId,
    incomingContent: data.messageContent,
    policy,
    tools,
  });
  const latencyMs = Date.now() - t0;

  if (out.decision === "ready_to_send" || out.decision === "ready_to_draft") {
    for (const tc of out.response.toolsCalled) {
      const inputJson = JSON.stringify(tc.arguments);
      const details: Record<string, unknown> = {
        tool_name: tc.name,
        input_summary: inputJson.length > 200 ? inputJson.slice(0, 200) + "…" : inputJson,
        success: tc.ok ?? false,
      };
      if (tc.id !== undefined) details.tool_id = tc.id;
      if (tc.error !== undefined) details.error = tc.error;
      await ctx.auditStore.write({
        workspace_id: data.workspaceId,
        action: "tool.call",
        actor: "agent",
        related_message_id: data.messageId,
        related_contact_id: data.contactId,
        cost_usd: tc.costUsd ?? 0,
        latency_ms: tc.latencyMs ?? 0,
        details,
      });
    }
  }

  if (out.decision === "ready_to_send") {
    const sent = await ctx.deps.transport.send({
      to: data.externalChatId,
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
        tools_called: out.response.toolsCalled as unknown as Array<Record<string, unknown>>,
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
