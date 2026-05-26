import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { InboundMessageSchema } from "@agent-mouth/core";
import { handleEmailWebhook, type EmailWebhookDeps } from "../email-webhook.js";
import {
  SupabaseContactStore,
  SupabaseEmailTokenStore,
  SupabaseEmailWebhookEventsStore,
  SupabaseIdentityResolver,
  SupabaseMessageStore,
  SupabaseOffsetStore,
  SupabasePolicyEngine,
  SupabaseThreadStore,
  SupabaseWorkspaceStore,
} from "@agent-mouth/storage-supabase";
import {
  GmailDriver,
  EmailTransport,
  decryptToken,
  verifyGooglePushJwt,
} from "@agent-mouth/transport-email";
import {
  type TelegramConfig,
  TelegramTransport,
  telegramUpdateToInbound,
} from "@agent-mouth/transport-telegram";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfigFromEnv } from "../config.js";
import { forwardToBridge } from "../forwarders/bridge.js";
import { logger } from "../logger.js";
import { type RouterDeps, processInbound } from "../router.js";
import { buildServer } from "../server.js";
import { startWorker } from "../worker.js";
import { TransportRegistry } from "../transports/registry.js";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

export async function serveHttp(): Promise<void> {
  const config = loadConfigFromEnv();
  if (!config?.telegram) {
    logger.error(
      "Missing env vars: AGENT_MOUTH_BOT_TOKEN, AGENT_MOUTH_CHAT_ID, AGENT_MOUTH_HANDLE",
    );
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    logger.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    process.exit(1);
  }

  const offsetStore = new SupabaseOffsetStore(supabaseUrl, supabaseKey);

  const workspaceStore = new SupabaseWorkspaceStore(supabaseUrl, supabaseKey);
  const workspace = await workspaceStore.getDefault();
  const identityResolver = new SupabaseIdentityResolver(supabaseUrl, supabaseKey);
  const policyEngine = new SupabasePolicyEngine(supabaseUrl, supabaseKey);
  const threadStore = new SupabaseThreadStore(supabaseUrl, supabaseKey);
  const messageStore = new SupabaseMessageStore(supabaseUrl, supabaseKey);
  const contactStore = new SupabaseContactStore(supabaseUrl, supabaseKey);

  const bridgeForwardUrl = process.env.BRIDGE_FORWARD_URL ?? null;
  const bridgeForwardChats = new Set(
    (process.env.BRIDGE_FORWARD_CHATS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const bridgeForwardSecret = process.env.BRIDGE_FORWARD_SECRET ?? undefined;

  const routerDeps: RouterDeps = {
    workspaceId: workspace.id,
    bridgeForwardChats,
    bridgeForwardUrl,
    identityResolver,
    threadStore,
    policyEngine,
    messageStore,
    forwarder: (url, payload) => forwardToBridge(url, payload, bridgeForwardSecret),
  };

  const PORT = Number(process.env.PORT ?? 3000);
  const AUTH_TOKEN = process.env.AGENT_MOUTH_AUTH_TOKEN;

  const telegramTransport = new TelegramTransport();

  // Phase 1b — populated after EmailTransport bootstraps and worker boots.
  // Until then `/email-webhook` returns 503.
  let emailWebhookDeps: EmailWebhookDeps | null = null;
  let transportRegistry: TransportRegistry | null = null;
  let emailFetchDeps: NonNullable<Parameters<typeof startWorker>[0]["emailFetchDeps"]> | undefined =
    undefined;

  // Temporary holder for the parts of emailWebhookDeps that don't need workerCtl.queue.
  // Consumed after startWorker() resolves.
  let emailWebhookPrep: {
    verifyJwt: typeof verifyGooglePushJwt;
    webhookEventsStore: SupabaseEmailWebhookEventsStore;
    config: { audience: string; serviceAccountEmail: string };
  } | null = null;

  await telegramTransport.init({
    ...config.telegram,
    offsetStore,
  } as TelegramConfig);

  // Phase 1b — bootstrap EmailTransport if configured
  const enableEmail = process.env.ENABLE_EMAIL_TRANSPORT === "true";
  if (enableEmail) {
    const gClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const gClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const encryptionKey = process.env.AGENT_MOUTH_TOKEN_ENCRYPTION_KEY;
    const pubsubTopic = process.env.GOOGLE_PUBSUB_TOPIC;
    const pubsubSAEmail = process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL;
    const webhookAudience = process.env.EMAIL_WEBHOOK_AUDIENCE;

    if (
      !gClientId ||
      !gClientSecret ||
      !encryptionKey ||
      !pubsubTopic ||
      !pubsubSAEmail ||
      !webhookAudience
    ) {
      logger.warn(
        "ENABLE_EMAIL_TRANSPORT=true but missing required env vars (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, AGENT_MOUTH_TOKEN_ENCRYPTION_KEY, GOOGLE_PUBSUB_TOPIC, GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL, EMAIL_WEBHOOK_AUDIENCE); EmailTransport will not boot",
      );
    } else {
      try {
        const driver = new GmailDriver({ clientId: gClientId, clientSecret: gClientSecret });
        const tokenStore = new SupabaseEmailTokenStore({ url: supabaseUrl, anonKey: supabaseKey });
        const webhookEventsStore = new SupabaseEmailWebhookEventsStore({
          url: supabaseUrl,
          anonKey: supabaseKey,
        });

        // Pick the first active token for this workspace as the EmailTransport identity
        const tokens = await tokenStore.list(workspace.id);
        const activeToken = tokens.find((t) => t.status === "active");
        if (!activeToken) {
          logger.warn(
            "ENABLE_EMAIL_TRANSPORT=true but no active email_oauth_tokens row — run `pnpm cli email:setup` first",
          );
        } else {
          const refreshToken = decryptToken(activeToken.refresh_token_encrypted, encryptionKey);
          const emailTransport = new EmailTransport({
            driver,
            auth: { refresh_token: refreshToken, email_address: activeToken.email_address },
          });
          await emailTransport.init({});

          transportRegistry = new TransportRegistry();
          transportRegistry.register("telegram", telegramTransport);
          transportRegistry.register("email", emailTransport);

          emailFetchDeps = {
            tokenStore,
            driver,
            decrypt: decryptToken,
            encryptionKey,
            routerDeps,
            processInbound,
            topicName: pubsubTopic,
          };

          // Store immutable webhook deps; queueEnqueue is added after startWorker boots.
          emailWebhookPrep = {
            verifyJwt: verifyGooglePushJwt,
            webhookEventsStore,
            config: { audience: webhookAudience, serviceAccountEmail: pubsubSAEmail },
          };

          logger.info({ email: activeToken.email_address }, "email transport bootstrapped");
        }
      } catch (err) {
        logger.error(
          { err: String(err) },
          "email transport bootstrap failed; continuing without email",
        );
      }
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  const apiKeys: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  };
  const defaultModel = process.env.DEFAULT_AGENT_MODEL ?? "claude-sonnet-4-6";
  let workerCtl: Awaited<ReturnType<typeof startWorker>> | null = null;

  // Worker boots only if DATABASE_URL is set AND at least one API key is present.
  // resolveRuntime will throw at startup if the configured model has no key.
  const hasAnyKey = Object.values(apiKeys).some(Boolean);
  if (databaseUrl && hasAnyKey) {
    try {
      workerCtl = await startWorker({
        databaseUrl,
        supabaseUrl,
        supabaseAnonKey: supabaseKey,
        apiKeys,
        defaultModel,
        notesModel: process.env.NOTES_UPDATER_MODEL ?? "claude-haiku-4-5-20251001",
        enableNotesUpdater: process.env.ENABLE_NOTES_UPDATER === "true",
        enableAgentTools: process.env.ENABLE_AGENT_TOOLS === "true",
        enableKnowledgeSync: process.env.ENABLE_KNOWLEDGE_SYNC === "true",
        knowledgeSyncIntervalMin: process.env.KNOWLEDGE_SYNC_INTERVAL_MIN
          ? Number(process.env.KNOWLEDGE_SYNC_INTERVAL_MIN)
          : undefined,
        defaultWorkspaceId: workspace.id,
        // Phase 3 daily health-check sends alerts to the same Telegram chat
        // the bot already replies to (Gavrilo's private chat).
        alertChatId: config.telegram?.chat_id,
        contactStore,
        messageStore,
        threadStore,
        workspaceStore,
        policyEngine,
        transport: telegramTransport,
        emailFetchDeps,
        // Phase 1b: when set, handleRespondJob picks transport per channelType.
        transportRegistry: transportRegistry ?? undefined,
      });
      logger.info({ defaultModel }, "pg-boss worker started");

      // Phase 1b — finalize emailWebhookDeps now that workerCtl.queue is available
      if (emailWebhookPrep && workerCtl) {
        emailWebhookDeps = {
          verifyJwt: emailWebhookPrep.verifyJwt,
          webhookEventsStore: emailWebhookPrep.webhookEventsStore,
          queueEnqueue: async (name, data, opts) => {
            await workerCtl!.queue.send(name, data, opts ?? {});
          },
          config: emailWebhookPrep.config,
        };
        emailWebhookPrep = null;
        logger.info("email webhook deps wired");
      }
    } catch (err) {
      logger.error({ err }, "pg-boss worker failed to start — continuing in Phase 1a mode");
      workerCtl = null;
    }
  } else {
    logger.warn("DATABASE_URL or any LLM API key not set — worker not started");
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, { ok: true, handle: config.telegram!.handle });
        return;
      }

      if (url.pathname === "/telegram-webhook" && req.method === "POST") {
        const body = await readJsonBody(req);
        const inbound = telegramUpdateToInbound(
          body as Parameters<typeof telegramUpdateToInbound>[0],
        );
        if (!inbound) {
          sendJson(res, 200, { ok: true, skipped: true });
          return;
        }
        const parsed = InboundMessageSchema.safeParse(inbound);
        if (!parsed.success) {
          logger.warn({ issues: parsed.error.issues }, "inbound schema mismatch");
          sendJson(res, 200, { ok: true, skipped: true });
          return;
        }
        const result = await processInbound(parsed.data, routerDeps);
        logger.info({ result }, "webhook processed");
        sendJson(res, 200, { ok: true, result });
        if (result.kind === "persisted" && result.policy !== "silent" && workerCtl) {
          workerCtl.queue
            .send(
              "agent.respond",
              {
                workspaceId: routerDeps.workspaceId,
                contactId: result.contactId,
                threadId: result.threadId,
                channelType: result.channelType,
                channelId: result.channelId,
                channelIdentityId: result.channelIdentityId,
                externalChatId: result.externalChatId,
                messageId: result.messageId,
                messageContent: result.messageContent,
              },
              { singletonKey: result.messageId },
            )
            .catch((err) => logger.error({ err }, "enqueue agent.respond failed"));
        }
        return;
      }

      if (url.pathname === "/email-webhook" && req.method === "POST") {
        if (!emailWebhookDeps) {
          sendJson(res, 503, { error: "email transport not configured" });
          return;
        }
        await handleEmailWebhook(req, res, emailWebhookDeps);
        return;
      }

      if (AUTH_TOKEN) {
        const authHeader = req.headers.authorization ?? "";
        if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
      }

      if (url.pathname === "/mcp" && req.method === "POST") {
        const body = await readJsonBody(req);
        const mcpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        const server = buildServer({
          transport: telegramTransport,
          offsetStore,
          handle: config.telegram!.handle,
          messageStore,
          workspaceId: workspace.id,
          // Phase 1b additions
          transportRegistry: transportRegistry ?? undefined,
          threadStore: {
            findById: (id: string) => threadStore.get(id),
          },
          channelStore: {
            findById: async (id: string) => {
              const url = `${supabaseUrl}/rest/v1/channels?id=eq.${id}&select=id,type&limit=1`;
              const res = await fetch(url, {
                headers: {
                  apikey: supabaseKey,
                  Authorization: `Bearer ${supabaseKey}`,
                },
              });
              if (!res.ok) return null;
              const rows = (await res.json()) as Array<{
                id: string;
                type: "telegram" | "email" | "whatsapp" | "discord" | "slack";
              }>;
              return rows[0] ?? null;
            },
          },
          contactStore: {
            addEmailToMetadata: (workspaceId, contactId, email) =>
              contactStore.addEmailToMetadata(workspaceId, contactId, email),
          },
        });
        await server.connect(mcpTransport);
        const reqWithBody = Object.assign(req, { body });
        await mcpTransport.handleRequest(reqWithBody, res, body as Record<string, unknown>);
        res.on("close", () => {
          void mcpTransport.close();
          void server.close();
        });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      logger.error({ err }, "request error");
      if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
    }
  });

  httpServer.listen(PORT, () => {
    logger.info({ port: PORT, handle: config.telegram!.handle }, "agent-mouth serving over HTTP");
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      logger.info({ signal: sig }, "shutting down");
      httpServer.close(async () => {
        if (workerCtl) await workerCtl.stop();
        process.exit(0);
      });
    });
  }
}
