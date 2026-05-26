// packages/api/src/email-watch-renew.ts
import type { SupabaseEmailTokenStore } from "@agent-mouth/storage-supabase";
import type { GmailDriver } from "@agent-mouth/transport-email";
import { logger } from "./logger.js";

export interface EmailWatchRenewDeps {
  tokenStore: Pick<
    SupabaseEmailTokenStore,
    "list" | "updateWatchExpiration" | "incrementRenewalFailures" | "markError"
  >;
  driver: Pick<GmailDriver, "watch">;
  decrypt: (cipher: string, keyHex: string) => string;
  encryptionKey: string;
  topicName: string;
}

const MAX_RENEWAL_FAILURES = 3;

export async function handleEmailWatchRenew(deps: EmailWatchRenewDeps): Promise<void> {
  const tokens = await deps.tokenStore.list();
  for (const tok of tokens) {
    if (tok.status !== "active") continue;
    try {
      const refreshToken = deps.decrypt(tok.refresh_token_encrypted, deps.encryptionKey);
      const w = await deps.driver.watch({
        auth: { refresh_token: refreshToken, email_address: tok.email_address },
        topic_name: deps.topicName,
      });
      await deps.tokenStore.updateWatchExpiration(tok.id, w.expiration);
      logger.info({ email: tok.email_address, expiration: w.expiration }, "watch renewed");
    } catch (err) {
      const fails = await deps.tokenStore.incrementRenewalFailures(tok.id).catch(() => 0);
      logger.error({ err: String(err), email: tok.email_address, fails }, "watch renewal failed");
      if (fails >= MAX_RENEWAL_FAILURES) {
        await deps.tokenStore.markError(
          tok.id,
          `watch renewal failed ${fails} times: ${String(err).slice(0, 200)}`,
        );
      }
    }
  }
}
