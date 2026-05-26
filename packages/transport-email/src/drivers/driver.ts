import type {
  EmailDriverAuthCtx,
  FetchResult,
  SendEmailArgs,
  SendEmailResult,
  WatchResult,
} from "../types.js";

export interface EmailDriver {
  readonly kind: "gmail" | "imap" | string;

  /** OAuth scopes required for fetch/send/watch. Used during email:setup. */
  readonly requiredScopes: string[];

  /** Returns the email address associated with the auth context. */
  whoami(auth: EmailDriverAuthCtx): Promise<{ email_address: string }>;

  /** Fetch new messages since `last_cursor` (historyId for Gmail). */
  fetchNewMessages(args: {
    auth: EmailDriverAuthCtx;
    last_cursor: string;
  }): Promise<FetchResult>;

  /** Send an outbound email. */
  send(args: { auth: EmailDriverAuthCtx; payload: SendEmailArgs }): Promise<SendEmailResult>;

  /** Create or refresh a Pub/Sub push watch on INBOX. */
  watch(args: { auth: EmailDriverAuthCtx; topic_name: string }): Promise<WatchResult>;
}
