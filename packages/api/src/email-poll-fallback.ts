// packages/api/src/email-poll-fallback.ts
import type { SupabaseEmailTokenStore } from "@agent-mouth/storage-supabase";
import { logger } from "./logger.js";

export interface EmailPollFallbackDeps {
  tokenStore: Pick<SupabaseEmailTokenStore, "list">;
  /**
   * Re-uses the email.fetch logic per token. Implementations should call
   * the same path that the webhook would (driver.fetchNewMessages + processInbound + queue).
   */
  fetchOne: (emailAddress: string, lastHistoryId: string) => Promise<void>;
}

export async function handleEmailPollFallback(deps: EmailPollFallbackDeps): Promise<void> {
  const tokens = await deps.tokenStore.list();
  for (const tok of tokens) {
    if (tok.status !== "active") continue;
    try {
      await deps.fetchOne(tok.email_address, tok.last_history_id ?? "1");
    } catch (err) {
      logger.error({ err: String(err), email: tok.email_address }, "email.poll.fallback per-token failure");
    }
  }
}
