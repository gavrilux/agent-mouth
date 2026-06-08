// packages/api/src/email-fetch.ts
import { InboundMessageSchema } from "@agent-mouth/core";
import type { SupabaseEmailTokenStore } from "@agent-mouth/storage-supabase";
import type { FetchResult, GmailDriver } from "@agent-mouth/transport-email";
import { normalizedEmailToInbound } from "@agent-mouth/transport-email";
import { logger } from "./logger.js";
import type { RouterDeps, RouterResult } from "./router.js";
import type { processInbound } from "./router.js";

export interface EmailFetchJobData {
  email_address: string;
  history_id: string;
}

export interface EmailFetchDeps {
  data: EmailFetchJobData;
  workspaceId: string;
  tokenStore: Pick<SupabaseEmailTokenStore, "getByAddress" | "updateCursor" | "markError">;
  driver: Pick<GmailDriver, "fetchNewMessages">;
  decrypt: (cipher: string, keyHex: string) => string;
  encryptionKey: string;
  routerDeps: RouterDeps;
  processInbound: typeof processInbound;
  queueSend: (
    name: string,
    data: Record<string, unknown>,
    opts?: { singletonKey?: string },
  ) => Promise<void>;
}

export async function handleEmailFetch(deps: EmailFetchDeps): Promise<void> {
  const tok = await deps.tokenStore.getByAddress(deps.workspaceId, deps.data.email_address);
  if (!tok) {
    logger.warn({ email: deps.data.email_address }, "email.fetch: no token row");
    return;
  }
  if (tok.status !== "active") {
    logger.warn(
      { email: tok.email_address, status: tok.status },
      "email.fetch: token not active, skipping",
    );
    return;
  }

  let refreshToken: string;
  try {
    refreshToken = deps.decrypt(tok.refresh_token_encrypted, deps.encryptionKey);
  } catch (err) {
    logger.error({ err: String(err) }, "email.fetch: decrypt failed");
    return;
  }

  const lastCursor = tok.last_history_id ?? deps.data.history_id;
  let fetchResult: FetchResult;
  try {
    fetchResult = await deps.driver.fetchNewMessages({
      auth: { refresh_token: refreshToken, email_address: tok.email_address },
      last_cursor: lastCursor,
    });
  } catch (err) {
    const msg = String(err);
    logger.error({ err: msg, email: tok.email_address }, "email.fetch: driver failed");
    // A revoked/expired refresh token (invalid_grant) is permanent: mark the
    // token so the watchdog email-inbound check sees status='error' and the
    // fetch/poll crons stop hammering a dead token. Transient errors (network)
    // are left untouched so a blip doesn't disable a healthy mailbox.
    if (/invalid_grant/i.test(msg)) {
      await deps.tokenStore
        .markError(tok.id, `invalid_grant on fetch: ${msg.slice(0, 200)}`)
        .catch((e) => logger.error({ err: String(e) }, "email.fetch: markError failed"));
    }
    return;
  }

  for (const normalized of fetchResult.messages) {
    const inbound = normalizedEmailToInbound(normalized, tok.channel_id);
    const parsed = InboundMessageSchema.safeParse(inbound);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, "email inbound schema mismatch");
      continue;
    }
    let result: RouterResult;
    try {
      result = await deps.processInbound(parsed.data, deps.routerDeps);
    } catch (err) {
      logger.error({ err: String(err) }, "email.fetch: processInbound failed");
      continue;
    }
    // Phase 1b debug — log every router result so we can see why agent.respond isn't enqueueing
    logger.info(
      {
        kind: result.kind,
        policy: result.kind === "persisted" ? result.policy : undefined,
        contactId: result.kind === "persisted" ? result.contactId : undefined,
        channelType: result.kind === "persisted" ? result.channelType : undefined,
        externalChatId: result.kind === "persisted" ? result.externalChatId : undefined,
      },
      "email.fetch processInbound result",
    );

    if (result.kind === "persisted" && result.policy !== "silent") {
      await deps
        .queueSend(
          "agent.respond",
          {
            workspaceId: deps.routerDeps.workspaceId,
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
        .catch((err) =>
          logger.error({ err: String(err) }, "email.fetch enqueue agent.respond failed"),
        );
      logger.info({ messageId: result.messageId }, "email.fetch agent.respond enqueued");
    }
  }

  await deps.tokenStore.updateCursor(tok.id, fetchResult.next_cursor);
}
