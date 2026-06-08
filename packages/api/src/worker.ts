import { Agent } from "@agent-mouth/agent";
import { NotesUpdater } from "@agent-mouth/agent-notes-updater";
import { resolveRuntime } from "@agent-mouth/agent-runtime";
import { bootstrapTools, resolveToolsForPolicy } from "@agent-mouth/agent-tools";
import type { KnowledgeSource, Policy, Tool, Transport } from "@agent-mouth/core";
import type {
  ContactStore,
  MessageStore,
  PolicyEngine,
  ThreadStore,
  WorkspaceStore,
} from "@agent-mouth/core";
import { resolveEmbeddingProvider } from "@agent-mouth/embeddings";
import {
  MarkdownChunker,
  indexSource,
  resolveKnowledgeSource,
} from "@agent-mouth/knowledge-source";
import { PgBossQueue } from "@agent-mouth/queue-pgboss";
import {
  SupabaseAuditLogStore,
  SupabaseDraftStore,
  SupabaseKnowledgeFilesRepo,
} from "@agent-mouth/storage-supabase";
import { resolveVectorStore } from "@agent-mouth/vector-store";
import { resolveWebSearchProvider } from "@agent-mouth/web-search";
import { Client as PgClient } from "pg";
import { handleEmailFetch } from "./email-fetch.js";
import { handleEmailPollFallback } from "./email-poll-fallback.js";
import { handleEmailWatchRenew } from "./email-watch-renew.js";
import { logger } from "./logger.js";
import { checkDailySpend } from "./watchdog/checks/daily-spend.js";
import { checkDatabase } from "./watchdog/checks/database.js";
import { checkEmailInbound } from "./watchdog/checks/email-inbound.js";
import { checkTelegramWebhook } from "./watchdog/checks/telegram-webhook.js";
import { checkWhatsAppInbound } from "./watchdog/checks/whatsapp-inbound.js";
import { sendHeartbeat } from "./watchdog/heartbeat.js";
import { reportSweep } from "./watchdog/reporter.js";
import { runWatchdogSweep } from "./watchdog/run.js";
import { PgWatchdogStateStore } from "./watchdog/state.js";

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
  // Phase 3 — when true, register the knowledge.sync cron handler
  enableKnowledgeSync?: boolean;
  // Default 15 minutes
  knowledgeSyncIntervalMin?: number;
  // Phase 3 — when set, daily 7am UTC health-check sends a Telegram alert to
  // this chat ID if any threshold is breached.
  alertChatId?: string;
  /** Phase 1b — populated when EmailTransport is configured. Enables email.fetch worker job + cron crons. */
  emailFetchDeps?: {
    tokenStore: import("@agent-mouth/storage-supabase").SupabaseEmailTokenStore;
    driver: import("@agent-mouth/transport-email").GmailDriver;
    decrypt: (cipher: string, keyHex: string) => string;
    encryptionKey: string;
    routerDeps: import("./router.js").RouterDeps;
    processInbound: typeof import("./router.js").processInbound;
    topicName: string;
  };
  /** Phase 1b — when present, handleRespondJob picks transport per channelType (telegram vs email). */
  transportRegistry?: { get(type: import("@agent-mouth/core").ChannelType): Transport };
  // Watchdog (v1) — fallos silenciosos de entrada + recursos
  enableWatchdog?: boolean;
  watchdog?: {
    intervalMin: number;
    emailExpiryMarginHours: number;
    healthchecksUrl?: string;
    publicBaseUrl: string;
    authToken: string;
    botToken: string;
    whatsapp: {
      enabled: boolean;
      graphVersion: string;
      phoneNumberId: string;
      accessToken: string;
    };
  };
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
      const pg = new PgClient({
        connectionString: deps.databaseUrl,
        connectionTimeoutMillis: 10_000,
      });
      let knowledgeSource: KnowledgeSource | null = null;
      try {
        await pg.connect();
        const { rows } = await pg.query(
          "SELECT id, type, config FROM knowledge_sources WHERE workspace_id = $1 LIMIT 1",
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

  // ── Phase 3 knowledge.sync recurring job ────────────────────────────────────
  if (deps.enableKnowledgeSync && deps.defaultWorkspaceId) {
    await queue.work("knowledge.sync", async () => {
      await runKnowledgeSync({
        databaseUrl: deps.databaseUrl,
        workspaceId: deps.defaultWorkspaceId!,
      });
    });

    const intervalMin = deps.knowledgeSyncIntervalMin ?? 15;
    // Single fixed singletonKey so the cron tick and the boot kick share one
    // queued slot — overlapping invocations dedupe against each other.
    const SYNC_KEY = "knowledge.sync.singleton";
    await queue.scheduleRecurring(
      "knowledge.sync",
      `*/${intervalMin} * * * *`,
      {},
      { singletonKey: SYNC_KEY },
    );
    // Trigger one immediate run so first boot doesn't wait the full interval.
    await queue.send("knowledge.sync", {}, { singletonKey: SYNC_KEY });
    logger.info({ intervalMin }, "[phase-3] knowledge.sync registered");
  }
  // ────────────────────────────────────────────────────────────────────────────

  // ── Phase 3 daily health-check (silent unless breach) ───────────────────────
  if (deps.alertChatId && deps.defaultWorkspaceId) {
    await queue.work("phase-3.health-check", async () => {
      await runPhase3HealthCheck({
        databaseUrl: deps.databaseUrl,
        workspaceId: deps.defaultWorkspaceId!,
        transport: deps.transport,
        alertChatId: deps.alertChatId!,
      });
    });
    await queue.scheduleRecurring(
      "phase-3.health-check",
      "0 7 * * *", // 7am UTC = 9am Madrid CEST (8am CET in winter)
      {},
      { singletonKey: "phase-3.health-check.singleton" },
    );
    logger.info("[phase-3] health-check cron registered (7am UTC daily)");
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

  if (deps.emailFetchDeps) {
    await queue.work<{ email_address: string; history_id: string }>("email.fetch", async (data) => {
      await handleEmailFetch({
        data,
        workspaceId: deps.defaultWorkspaceId ?? "",
        tokenStore: deps.emailFetchDeps!.tokenStore,
        driver: deps.emailFetchDeps!.driver,
        decrypt: deps.emailFetchDeps!.decrypt,
        encryptionKey: deps.emailFetchDeps!.encryptionKey,
        routerDeps: deps.emailFetchDeps!.routerDeps,
        processInbound: deps.emailFetchDeps!.processInbound,
        queueSend: async (name, jobData, opts) => {
          await queue.send(name, jobData, opts ?? {});
        },
      });
    });
    logger.info("email.fetch worker registered");

    // email.poll.fallback — safety net every 10 min
    const fallbackInterval = Number(process.env.EMAIL_POLL_FALLBACK_INTERVAL_MIN ?? "10");
    await queue.scheduleRecurring(
      "email.poll.fallback",
      `*/${fallbackInterval} * * * *`,
      {},
      { singletonKey: "email.poll.singleton" },
    );
    await queue.work("email.poll.fallback", async () => {
      await handleEmailPollFallback({
        tokenStore: deps.emailFetchDeps!.tokenStore,
        fetchOne: async (email, lastHistoryId) => {
          await queue.send(
            "email.fetch",
            { email_address: email, history_id: lastHistoryId },
            { singletonKey: `email.fetch.${email}.${lastHistoryId}` },
          );
        },
      });
    });

    // email.watch.renew — every 6 days at 05:00 UTC
    const renewIntervalDays = Number(process.env.EMAIL_WATCH_RENEW_INTERVAL_DAYS ?? "6");
    await queue.scheduleRecurring(
      "email.watch.renew",
      `0 5 */${renewIntervalDays} * *`,
      {},
      { singletonKey: "email.watch.renew.singleton" },
    );
    await queue.work("email.watch.renew", async () => {
      await handleEmailWatchRenew({
        tokenStore: deps.emailFetchDeps!.tokenStore,
        driver: deps.emailFetchDeps!.driver,
        decrypt: deps.emailFetchDeps!.decrypt,
        encryptionKey: deps.emailFetchDeps!.encryptionKey,
        topicName: deps.emailFetchDeps!.topicName,
      });
    });

    logger.info("email cron jobs registered (poll.fallback, watch.renew)");
  }

  // ── Watchdog sweep (v1) ─────────────────────────────────────────────────────
  if (deps.enableWatchdog && deps.watchdog && deps.alertChatId && deps.defaultWorkspaceId) {
    const wd = deps.watchdog;
    const workspaceId = deps.defaultWorkspaceId;
    const alertChatId = deps.alertChatId;
    const reauthUrl = `${wd.publicBaseUrl}/email-oauth-start?token=${wd.authToken}`;
    const expectedWebhook = `${wd.publicBaseUrl}/telegram-webhook`;
    const stateStore = new PgWatchdogStateStore(deps.databaseUrl);
    const tokenStore = deps.emailFetchDeps?.tokenStore;
    const now = () => new Date();

    await queue.work("watchdog.sweep", async () => {
      const checks: {
        id: string;
        run: () => Promise<import("./watchdog/types.js").CheckResult>;
      }[] = [
        {
          id: "telegram-webhook",
          run: () => checkTelegramWebhook({ botToken: wd.botToken, expectedUrl: expectedWebhook }),
        },
        {
          id: "whatsapp-inbound",
          run: () =>
            checkWhatsAppInbound({
              enabled: wd.whatsapp.enabled,
              graphVersion: wd.whatsapp.graphVersion,
              phoneNumberId: wd.whatsapp.phoneNumberId,
              accessToken: wd.whatsapp.accessToken,
            }),
        },
        { id: "database", run: () => checkDatabase({ databaseUrl: deps.databaseUrl }) },
        {
          id: "daily-spend",
          run: () =>
            checkDailySpend({
              workspaceId,
              audit: auditStore,
              workspaces: deps.workspaceStore,
              now,
            }),
        },
      ];
      if (tokenStore) {
        checks.unshift({
          id: "email-inbound",
          run: () =>
            checkEmailInbound({
              tokenStore,
              workspaceId,
              reauthUrl,
              expiryMarginMs: wd.emailExpiryMarginHours * 3_600_000,
              now,
            }),
        });
      }
      await runWatchdogSweep({
        checks,
        report: (results) =>
          reportSweep(results, { stateStore, transport: deps.transport, alertChatId, now }),
        heartbeat: () => sendHeartbeat({ url: wd.healthchecksUrl }),
      });
    });

    const intervalMin =
      Number.isInteger(wd.intervalMin) && wd.intervalMin > 0 ? wd.intervalMin : 60;
    if (intervalMin !== wd.intervalMin) {
      logger.error(
        { configured: wd.intervalMin },
        "[watchdog] WATCHDOG_INTERVAL_MIN inválido — usando 60 por defecto",
      );
    }
    await queue.scheduleRecurring(
      "watchdog.sweep",
      `*/${intervalMin} * * * *`,
      {},
      { singletonKey: "watchdog.sweep.singleton" },
    );
    await queue.send("watchdog.sweep", {}, { singletonKey: "watchdog.sweep.singleton" });
    logger.info({ intervalMin }, "[watchdog] sweep cron registered");
  }
  // ────────────────────────────────────────────────────────────────────────────

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
        input_summary: inputJson.length > 200 ? `${inputJson.slice(0, 200)}…` : inputJson,
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
    // Phase 1b: pick the right transport per channelType (telegram vs email).
    // Falls back to deps.transport (Telegram singleton) when no registry configured.
    const tx = ctx.deps.transportRegistry?.get(data.channelType) ?? ctx.deps.transport;
    const sent = await tx.send({
      to: data.externalChatId,
      body: out.response.body,
      // For email: subject required for new threads. Use "Re:" prefix when replying.
      subject: data.channelType === "email" ? `Re: ${data.messageContent.slice(0, 60)}` : undefined,
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

// ── Phase 3: runKnowledgeSync (exported for testability) ────────────────────

export interface RunKnowledgeSyncArgs {
  databaseUrl: string;
  workspaceId: string;
}

export async function runKnowledgeSync(args: RunKnowledgeSyncArgs): Promise<void> {
  const env = process.env;
  // 10s connect timeout so a hung Supabase doesn't keep this job open forever.
  const pg = new PgClient({ connectionString: args.databaseUrl, connectionTimeoutMillis: 10_000 });
  try {
    await pg.connect();
    const { rows } = await pg.query(
      "SELECT id, type, config FROM knowledge_sources WHERE workspace_id = $1",
      [args.workspaceId],
    );
    // Embedder + vector store don't depend on the row; resolve once per tick.
    const embedder = await resolveEmbeddingProvider("openai", env);
    const vectorStore = await resolveVectorStore({ type: "pgvector", env });
    for (const row of rows) {
      const sourceId = row.id as string;
      try {
        const source = await resolveKnowledgeSource({
          type: row.type as string,
          config: row.config as Record<string, unknown>,
          env,
        });
        const filesRepo = new SupabaseKnowledgeFilesRepo({ connectionString: args.databaseUrl });
        await filesRepo.init();
        const chunker = new MarkdownChunker({
          targetTokens: 400,
          maxTokens: 500,
          overlapTokens: 50,
        });
        try {
          const result = await indexSource({
            sourceId,
            source,
            embedder,
            vectorStore,
            chunker,
            filesRepo,
          });
          await pg.query(
            "UPDATE knowledge_sources SET last_synced_at = NOW(), last_sync_status = $1 WHERE id = $2",
            ["ok", sourceId],
          );
          logger.info({ sourceId, result }, "[phase-3] knowledge.sync done");
        } finally {
          await filesRepo.close().catch(() => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await pg.query("UPDATE knowledge_sources SET last_sync_status = $1 WHERE id = $2", [
          `error: ${msg}`,
          sourceId,
        ]);
        logger.error({ err, sourceId }, "[phase-3] knowledge.sync source failed");
      }
    }
  } finally {
    await pg.end().catch(() => {});
  }
}

// ── Phase 3: daily health-check (Telegram alert only if breach) ─────────────

export interface RunPhase3HealthCheckArgs {
  databaseUrl: string;
  workspaceId: string;
  transport: Transport;
  alertChatId: string;
}

const ALERT_ERR_RATIO = 0.2;
const ALERT_COST_USD = 0.5;
const ALERT_LATENCY_MS = 30000;
const ALERT_SYNC_STALE_MIN = 45;

export async function runPhase3HealthCheck(args: RunPhase3HealthCheckArgs): Promise<void> {
  const pg = new PgClient({
    connectionString: args.databaseUrl,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await pg.connect();
    const stats = await pg.query(
      `SELECT
         count(*) FILTER (WHERE action='tool.call') AS calls,
         count(*) FILTER (WHERE action='tool.call' AND (details->>'success')::bool = true) AS ok,
         count(*) FILTER (WHERE action='tool.call' AND (details->>'success')::bool = false) AS err,
         coalesce(sum(cost_usd) FILTER (WHERE action='tool.call'), 0)::float AS cost_usd,
         coalesce(max(latency_ms) FILTER (WHERE action='tool.call'), 0) AS max_ms,
         coalesce(avg(latency_ms) FILTER (WHERE action='tool.call'), 0)::int AS avg_ms
       FROM audit_log
       WHERE workspace_id = $1
         AND created_at > now() - interval '24 hours'`,
      [args.workspaceId],
    );
    const sync = await pg.query(
      `SELECT last_synced_at, last_sync_status
       FROM knowledge_sources WHERE workspace_id = $1 LIMIT 1`,
      [args.workspaceId],
    );

    const s = stats.rows[0];
    const totalCalls = Number(s.calls);
    const errCount = Number(s.err);
    const errRatio = totalCalls > 0 ? errCount / totalCalls : 0;
    const cost = Number(s.cost_usd);
    const maxMs = Number(s.max_ms);
    const avgMs = Number(s.avg_ms);

    const alerts: string[] = [];
    if (totalCalls > 0 && errRatio > ALERT_ERR_RATIO) {
      alerts.push(`🔴 err ratio ${(errRatio * 100).toFixed(0)}% (${errCount}/${totalCalls})`);
    }
    if (cost > ALERT_COST_USD) {
      alerts.push(`🟠 cost $${cost.toFixed(4)} (cap $1/día)`);
    }
    if (maxMs > ALERT_LATENCY_MS) {
      alerts.push(`🟠 max latency ${maxMs}ms (timeout=${ALERT_LATENCY_MS})`);
    }
    const syncRow = sync.rows[0];
    if (syncRow?.last_sync_status?.startsWith("error:")) {
      alerts.push(`🔴 knowledge.sync FAILED: ${syncRow.last_sync_status.slice(0, 120)}`);
    }
    if (syncRow?.last_synced_at) {
      const ageMin = (Date.now() - new Date(syncRow.last_synced_at).getTime()) / 60_000;
      if (ageMin > ALERT_SYNC_STALE_MIN) {
        alerts.push(`🟠 sync stale: hace ${Math.round(ageMin)}min`);
      }
    }

    logger.info(
      { totalCalls, errRatio, cost, maxMs, avgMs, alerts: alerts.length },
      "[phase-3] health-check ran",
    );

    if (alerts.length === 0) return; // silent — todo bien

    const body =
      `⚠️ agent-mouth Phase 3 — alertas últimas 24h:\n\n${alerts.join("\n")}\n\n` +
      `Stats: ${totalCalls} tool calls, $${cost.toFixed(4)}, avg ${avgMs}ms, max ${maxMs}ms`;
    await args.transport.send({ to: args.alertChatId, body });
  } finally {
    await pg.end().catch(() => {});
  }
}
