import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { InboundMessageSchema } from "@agent-mouth/core";
import {
  SupabaseContactStore,
  SupabaseIdentityResolver,
  SupabaseMessageStore,
  SupabaseOffsetStore,
  SupabasePolicyEngine,
  SupabaseThreadStore,
  SupabaseWorkspaceStore,
} from "@agent-mouth/storage-supabase";
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
  await telegramTransport.init({
    ...config.telegram,
    offsetStore,
  } as TelegramConfig);

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
    workerCtl = await startWorker({
      databaseUrl,
      supabaseUrl,
      supabaseAnonKey: supabaseKey,
      apiKeys,
      defaultModel,
      notesModel: process.env.NOTES_UPDATER_MODEL ?? "claude-haiku-4-5-20251001",
      enableNotesUpdater: process.env.ENABLE_NOTES_UPDATER === "true",
      contactStore,
      messageStore,
      threadStore,
      workspaceStore,
      policyEngine,
      transport: telegramTransport,
    });
    logger.info({ defaultModel }, "pg-boss worker started");
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
                messageId: result.messageId,
                messageContent: result.messageContent,
              },
              { singletonKey: result.messageId },
            )
            .catch((err) => logger.error({ err }, "enqueue agent.respond failed"));
        }
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
