import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { InboundMessageSchema } from "@agent-mouth/core";
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
  EmailTransport,
  GmailDriver,
  decryptToken,
  verifyGooglePushJwt,
} from "@agent-mouth/transport-email";
import {
  type TelegramConfig,
  TelegramTransport,
  telegramUpdateToInbound,
} from "@agent-mouth/transport-telegram";
import {
  WhatsAppTransport,
  verifyMetaSignature,
  whatsappMessageToInbound,
} from "@agent-mouth/transport-whatsapp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfigFromEnv } from "../config.js";
import { buildEmailReauthUrl, completeEmailReauth, createStateStore } from "../email-reauth.js";
import { type EmailWebhookDeps, handleEmailWebhook } from "../email-webhook.js";
import { forwardToBridge } from "../forwarders/bridge.js";
import { logger } from "../logger.js";
import { type RouterDeps, processInbound } from "../router.js";
import { buildServer } from "../server.js";
import { TransportRegistry } from "../transports/registry.js";
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

/**
 * Meta GET verification handshake. Returns the challenge string to echo (200)
 * when mode=subscribe and the verify token matches; otherwise null (caller → 403).
 */
export function verifyWhatsAppHandshake(url: URL, verifyToken: string): string | null {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === verifyToken && challenge !== null) {
    return challenge;
  }
  return null;
}

/** Read the raw request body as a UTF-8 string (needed verbatim for HMAC signature checks). */
async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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
  // One-click email re-auth (email-reauth.ts): public base for the OAuth redirect
  // + in-memory single-use CSRF state store for the start→callback round-trip.
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://agent-mouth.fly.dev";
  const emailReauthStates = createStateStore();

  const telegramTransport = new TelegramTransport();

  // Phase 1b — populated after EmailTransport bootstraps and worker boots.
  // Until then `/email-webhook` returns 503.
  let emailWebhookDeps: EmailWebhookDeps | null = null;
  let transportRegistry: TransportRegistry | null = null;
  let emailFetchDeps: NonNullable<Parameters<typeof startWorker>[0]["emailFetchDeps"]> | undefined =
    undefined;

  // Phase 4a — WhatsApp. `whatsappTransport`/`whatsappAppSecret` stay null until
  // ENABLE_WHATSAPP_TRANSPORT=true with full config; until then /whatsapp-webhook → 503.
  let whatsappTransport: WhatsAppTransport | null = null;
  let whatsappAppSecret: string | null = null;
  let whatsappVerifyToken: string | null = null;

  // Temporary holder for the parts of emailWebhookDeps that don't need workerCtl.queue.
  // Consumed after startWorker() resolves.
  let emailWebhookPrep: {
    verifyJwt: typeof verifyGooglePushJwt;
    webhookEventsStore: SupabaseEmailWebhookEventsStore;
    config: { audience: string; serviceAccountEmail: string };
  } | null = null;

  // A transport's auth failure (e.g. a revoked AGENT_MOUTH_BOT_TOKEN → getMe 401)
  // must NOT crash the whole multi-channel server. Mirror the email/whatsapp
  // bootstrap pattern below: log loudly and continue so /health, email, whatsapp
  // and /mcp stay up. Telegram rejoins automatically once the token is fixed and
  // the app reboots.
  try {
    await telegramTransport.init({
      ...config.telegram,
      offsetStore,
    } as TelegramConfig);
    logger.info({ handle: config.telegram?.handle }, "telegram transport initialized");
  } catch (err) {
    logger.error(
      { err: String(err) },
      "telegram transport init failed (check AGENT_MOUTH_BOT_TOKEN); continuing without telegram",
    );
  }

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

  // Phase 4a — bootstrap WhatsAppTransport if configured
  const enableWhatsapp = process.env.ENABLE_WHATSAPP_TRANSPORT === "true";
  if (enableWhatsapp) {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    const graphVersion = process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0";
    const displayPhoneNumber = process.env.WHATSAPP_DISPLAY_PHONE_NUMBER;

    if (!phoneNumberId || !accessToken || !appSecret || !verifyToken) {
      logger.warn(
        "ENABLE_WHATSAPP_TRANSPORT=true but missing required env vars (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN); WhatsAppTransport will not boot",
      );
    } else {
      try {
        const transport = new WhatsAppTransport({
          phone_number_id: phoneNumberId,
          access_token: accessToken,
          graph_version: graphVersion,
          display_phone_number: displayPhoneNumber,
        });
        await transport.init({});

        // Ensure a whatsapp channel row exists for this workspace (mirrors the
        // email channel bootstrap in email-setup.ts). Supabase REST over HTTPS.
        const restHeaders = {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
        };
        const lookupUrl = `${supabaseUrl}/rest/v1/channels?workspace_id=eq.${workspace.id}&type=eq.whatsapp&select=id&limit=1`;
        const lookupRes = await fetch(lookupUrl, { headers: restHeaders });
        if (!lookupRes.ok) {
          throw new Error(
            `whatsapp channel lookup failed: ${lookupRes.status} ${await lookupRes.text()}`,
          );
        }
        const lookupRows = (await lookupRes.json()) as Array<{ id: string }>;
        if (lookupRows.length === 0) {
          const insertRes = await fetch(`${supabaseUrl}/rest/v1/channels`, {
            method: "POST",
            headers: { ...restHeaders, Prefer: "return=representation" },
            body: JSON.stringify({
              workspace_id: workspace.id,
              type: "whatsapp",
              config: {
                phone_number_id: phoneNumberId,
                display_phone_number: displayPhoneNumber ?? null,
              },
              status: "active",
            }),
          });
          if (!insertRes.ok) {
            throw new Error(
              `whatsapp channel insert failed: ${insertRes.status} ${await insertRes.text()}`,
            );
          }
        }

        // Reuse the registry the email block may have created; else create it
        // and register telegram first.
        if (!transportRegistry) {
          transportRegistry = new TransportRegistry();
          transportRegistry.register("telegram", telegramTransport);
        }
        transportRegistry.register("whatsapp", transport);

        whatsappTransport = transport;
        whatsappAppSecret = appSecret;
        whatsappVerifyToken = verifyToken;
        logger.info({ phoneNumberId }, "whatsapp transport bootstrapped");
      } catch (err) {
        logger.error(
          { err: String(err) },
          "whatsapp transport bootstrap failed; continuing without whatsapp",
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

      // One-click email OAuth re-auth. Gated by ?token=<AGENT_MOUTH_AUTH_TOKEN>.
      // Token (Google Testing mode) dies every 7 days; this makes re-consent a link.
      if (url.pathname === "/email-oauth-start" && req.method === "GET") {
        if (!AUTH_TOKEN || url.searchParams.get("token") !== AUTH_TOKEN) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
        if (!clientId) {
          sendJson(res, 503, { error: "email oauth not configured" });
          return;
        }
        const state = randomUUID();
        emailReauthStates.issue(state, Date.now());
        const authUrl = buildEmailReauthUrl({
          clientId,
          redirectUri: `${PUBLIC_BASE_URL}/email-oauth-callback`,
          state,
        });
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      }

      if (url.pathname === "/email-oauth-callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        // Reject anything without a valid single-use CSRF state we issued.
        if (!code || !state || !emailReauthStates.consume(state, Date.now())) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<h1>Solicitud inválida o caducada</h1><p>Vuelve a abrir el enlace de re-autorización.</p>",
          );
          return;
        }
        const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
        const encryptionKey = process.env.AGENT_MOUTH_TOKEN_ENCRYPTION_KEY;
        const topicName = process.env.GOOGLE_PUBSUB_TOPIC;
        if (!clientId || !clientSecret || !encryptionKey || !topicName) {
          res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>Email OAuth no configurado</h1>");
          return;
        }
        try {
          const result = await completeEmailReauth({
            code,
            clientId,
            clientSecret,
            redirectUri: `${PUBLIC_BASE_URL}/email-oauth-callback`,
            encryptionKey,
            topicName,
            supabaseUrl,
            supabaseKey,
            workspaceId: workspace.id,
          });
          logger.info({ email: result.email_address }, "email re-auth completed via web flow");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<h1>✅ Email re-autorizado</h1><p><b>${result.email_address}</b></p><p>Watch hasta ${result.watch_expiration}.</p><p>Ya puedes cerrar esta pestaña.</p>`,
          );
        } catch (err) {
          logger.error({ err: String(err) }, "email re-auth via web flow failed");
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>Error al re-autorizar</h1><p>Revisa los logs del servidor.</p>");
        }
        return;
      }

      if (url.pathname === "/whatsapp-webhook" && req.method === "GET") {
        if (!whatsappVerifyToken) {
          sendJson(res, 503, { error: "whatsapp transport not configured" });
          return;
        }
        const challenge = verifyWhatsAppHandshake(url, whatsappVerifyToken);
        if (challenge === null) {
          sendJson(res, 403, { error: "verification failed" });
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(challenge);
        return;
      }

      if (url.pathname === "/whatsapp-webhook" && req.method === "POST") {
        if (!whatsappTransport || !whatsappAppSecret) {
          sendJson(res, 503, { error: "whatsapp transport not configured" });
          return;
        }
        const rawBody = await readRawBody(req);
        const sigHeader = req.headers["x-hub-signature-256"];
        const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
        if (!verifyMetaSignature(rawBody, sig ?? undefined, whatsappAppSecret)) {
          logger.warn("whatsapp-webhook signature verification failed");
          sendJson(res, 403, { error: "invalid signature" });
          return;
        }
        let body: unknown;
        try {
          body = rawBody ? JSON.parse(rawBody) : undefined;
        } catch {
          logger.warn("whatsapp-webhook body not JSON");
          sendJson(res, 200, { ok: true, skipped: "malformed" });
          return;
        }
        // Resolve the whatsapp channel id once (for raw_payload provenance).
        let whatsappChannelId = "";
        try {
          const chUrl = `${supabaseUrl}/rest/v1/channels?workspace_id=eq.${workspace.id}&type=eq.whatsapp&select=id&limit=1`;
          const chRes = await fetch(chUrl, {
            headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
          });
          if (chRes.ok) {
            const rows = (await chRes.json()) as Array<{ id: string }>;
            whatsappChannelId = rows[0]?.id ?? "";
          }
        } catch {
          // non-fatal — provenance only
        }
        const parsedBody = body as {
          entry?: { changes?: { field: string; value: unknown }[] }[];
        };
        const inbounds = (parsedBody.entry ?? [])
          .flatMap((e) => e.changes ?? [])
          .filter((c) => c.field === "messages")
          .flatMap((c) => whatsappMessageToInbound(c.value, whatsappChannelId));
        // Respond 200 immediately so Meta does not retry; process inline.
        sendJson(res, 200, { ok: true, count: inbounds.length });
        for (const inbound of inbounds) {
          const parsed = InboundMessageSchema.safeParse(inbound);
          if (!parsed.success) {
            logger.warn({ issues: parsed.error.issues }, "whatsapp inbound schema mismatch");
            continue;
          }
          processInbound(parsed.data, routerDeps)
            .then((result) => {
              logger.info({ result }, "whatsapp webhook processed");
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
                  .catch((err) => logger.error({ err }, "enqueue agent.respond (whatsapp) failed"));
              }
            })
            .catch((err) => logger.error({ err }, "whatsapp processInbound failed"));
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
