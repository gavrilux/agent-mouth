// packages/api/src/cli/email-setup.ts
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { SupabaseEmailTokenStore, SupabaseWorkspaceStore } from "@agent-mouth/storage-supabase";
import {
  GmailDriver,
  buildAuthUrl,
  encryptToken,
  exchangeCodeForTokens,
} from "@agent-mouth/transport-email";
import { logger } from "../logger.js";

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export interface EmailSetupArgs {
  port: number;
  workspaceId?: string;
  topicName?: string;
  scopes: string[];
}

export function parseEmailSetupArgs(argv: string[]): EmailSetupArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return {
    port: Number(get("--port") ?? "53682"),
    workspaceId: get("--workspace-id"),
    topicName: get("--topic") ?? process.env.GOOGLE_PUBSUB_TOPIC,
    scopes: DEFAULT_SCOPES,
  };
}

export async function emailSetup(argv: string[]): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const encryptionKey = process.env.AGENT_MOUTH_TOKEN_ENCRYPTION_KEY;
  if (!supabaseUrl || !supabaseKey || !clientId || !clientSecret || !encryptionKey) {
    logger.error(
      "Missing required env: SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, AGENT_MOUTH_TOKEN_ENCRYPTION_KEY",
    );
    process.exit(1);
  }

  const opts = parseEmailSetupArgs(argv);
  if (!opts.topicName) {
    logger.error("Missing --topic <topic-name> or GOOGLE_PUBSUB_TOPIC env var");
    process.exit(1);
  }

  let workspaceId = opts.workspaceId;
  if (!workspaceId) {
    try {
      const ws = new SupabaseWorkspaceStore(supabaseUrl, supabaseKey);
      const def = await ws.getDefault();
      workspaceId = def.id;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to resolve default workspace — pass --workspace-id to override",
      );
      process.exit(1);
    }
  }

  const redirectUri = `http://localhost:${opts.port}/callback`;
  const authUrl = buildAuthUrl({ clientId, redirectUri, scopes: opts.scopes });

  console.log("\n=== Agent Mouth — Email Setup ===\n");
  console.log("Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\nWaiting for redirect (Ctrl-C to abort)...\n");

  const code = await waitForCode(opts.port);
  console.log("Received code, exchanging for tokens...");

  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code });
  if (!tokens.refresh_token) {
    logger.error("No refresh_token returned. Make sure prompt=consent in auth URL.");
    process.exit(1);
  }

  // Get email + initial historyId
  const driver = new GmailDriver({ clientId, clientSecret });
  const me = await driver.whoami({ refresh_token: tokens.refresh_token, email_address: "" });
  console.log(`Authenticated as: ${me.email_address}`);

  // Initial watch
  const watch = await driver.watch({
    auth: { refresh_token: tokens.refresh_token, email_address: me.email_address },
    topic_name: opts.topicName,
  });
  console.log(`Watch created. Expires: ${watch.expiration}`);

  // Ensure channel row exists for type='email' in this workspace.
  // Use Supabase REST (HTTPS) instead of direct pg (IPv6) so the CLI works from
  // any local network without IPv6 routing to Supabase's Postgres endpoint.
  const restHeaders = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
  };
  let channelId: string;
  const lookupUrl = `${supabaseUrl}/rest/v1/channels?workspace_id=eq.${workspaceId}&type=eq.email&select=id&limit=1`;
  const lookupRes = await fetch(lookupUrl, { headers: restHeaders });
  if (!lookupRes.ok) {
    logger.error(
      { status: lookupRes.status, body: await lookupRes.text() },
      "channel lookup failed",
    );
    process.exit(1);
  }
  const lookupRows = (await lookupRes.json()) as Array<{ id: string }>;
  if (lookupRows.length > 0) {
    channelId = lookupRows[0]!.id;
  } else {
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/channels`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        workspace_id: workspaceId,
        type: "email",
        config: { email_address: me.email_address },
        status: "active",
      }),
    });
    if (!insertRes.ok) {
      logger.error(
        { status: insertRes.status, body: await insertRes.text() },
        "channel insert failed",
      );
      process.exit(1);
    }
    const insertRows = (await insertRes.json()) as Array<{ id: string }>;
    if (insertRows.length === 0) {
      logger.error("channel insert returned no rows");
      process.exit(1);
    }
    channelId = insertRows[0]!.id;
  }

  // Save token row
  const tokenStore = new SupabaseEmailTokenStore({ url: supabaseUrl, anonKey: supabaseKey });
  await tokenStore.upsert({
    workspace_id: workspaceId,
    channel_id: channelId,
    email_address: me.email_address,
    refresh_token_encrypted: encryptToken(tokens.refresh_token, encryptionKey),
    scopes: opts.scopes,
    last_history_id: watch.history_id,
    watch_expiration: watch.expiration,
    status: "active",
    last_error: null,
    consecutive_renewal_failures: 0,
  });

  console.log(`\nSetup complete for ${me.email_address}`);
  console.log(`Watch expires ${watch.expiration} — auto-renewal cron will refresh every 6 days`);
}

function waitForCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(`<h1>Error: ${error}</h1>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" }).end("<h1>No code</h1>");
        server.close();
        reject(new Error("no code in redirect"));
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<h1>Authorization received</h1><p>You can close this tab.</p>");
      server.close();
      resolve(code);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}
