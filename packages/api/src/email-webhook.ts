// packages/api/src/email-webhook.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseEmailWebhookEventsStore } from "@agent-mouth/storage-supabase";
import { parsePubSubEnvelope, type verifyGooglePushJwt } from "@agent-mouth/transport-email";
import { logger } from "./logger.js";

export interface EmailWebhookConfig {
  audience: string;
  serviceAccountEmail: string;
}

export interface EmailWebhookDeps {
  verifyJwt: typeof verifyGooglePushJwt;
  webhookEventsStore: Pick<SupabaseEmailWebhookEventsStore, "recordOnce">;
  queueEnqueue: (
    name: string,
    data: Record<string, unknown>,
    options?: { singletonKey?: string },
  ) => Promise<void>;
  config: EmailWebhookConfig;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function handleEmailWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EmailWebhookDeps,
): Promise<void> {
  // 1. Extract + validate JWT
  const auth = req.headers.authorization;
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    send(res, 401, { error: "missing bearer token" });
    return;
  }
  const token = auth.slice(7);
  try {
    await deps.verifyJwt(token, {
      audience: deps.config.audience,
      serviceAccountEmail: deps.config.serviceAccountEmail,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "email-webhook JWT validation failed");
    send(res, 401, { error: "invalid token" });
    return;
  }

  // 2. Parse + validate envelope
  const body = await readBody(req);
  let parsed: ReturnType<typeof parsePubSubEnvelope>;
  try {
    parsed = parsePubSubEnvelope(body);
  } catch (err) {
    logger.warn({ err: String(err) }, "email-webhook payload malformed");
    send(res, 400, { error: "malformed pub/sub envelope" });
    return;
  }

  // 3. Idempotency: insert-or-noop (email_address, history_id)
  let isNew: boolean;
  try {
    isNew = await deps.webhookEventsStore.recordOnce(parsed.email_address, parsed.history_id);
  } catch (err) {
    logger.error({ err: String(err) }, "email-webhook idempotency check failed");
    send(res, 200, { ok: true, skipped: "idempotency-check-failed" });
    return;
  }

  if (!isNew) {
    logger.info(
      { email: parsed.email_address, historyId: parsed.history_id },
      "email-webhook duplicate, noop",
    );
    send(res, 200, { ok: true, duplicate: true });
    return;
  }

  // 4. Enqueue fetch job
  try {
    await deps.queueEnqueue(
      "email.fetch",
      { email_address: parsed.email_address, history_id: parsed.history_id },
      { singletonKey: `email.fetch.${parsed.email_address}.${parsed.history_id}` },
    );
    logger.info(
      { email: parsed.email_address, historyId: parsed.history_id },
      "email-webhook job enqueued",
    );
  } catch (err) {
    logger.error({ err: String(err) }, "email-webhook enqueue failed");
    // Still return 200 — webhook delivered, job retry will catch up via fallback polling.
  }

  send(res, 200, { ok: true });
}
