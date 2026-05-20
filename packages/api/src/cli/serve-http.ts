import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SupabaseOffsetStore } from "@agent-mouth/storage-supabase";
import { TelegramTransport, type TelegramConfig } from "@agent-mouth/transport-telegram";
import { loadConfigFromEnv } from "../config.js";
import { logger } from "../logger.js";
import { buildServer } from "../server.js";

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
  const PORT = Number(process.env.PORT ?? 3000);
  const AUTH_TOKEN = process.env.AGENT_MOUTH_AUTH_TOKEN;

  const telegramTransport = new TelegramTransport();
  await telegramTransport.init({
    ...config.telegram,
    offsetStore,
  } as TelegramConfig);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, { ok: true, handle: config.telegram!.handle });
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
      httpServer.close(() => process.exit(0));
    });
  }
}
