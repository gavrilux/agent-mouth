// packages/api/src/email-reauth.ts
//
// One-click email OAuth re-authorization.
//
// The Gmail OAuth app runs in Google "Testing" mode, so Google revokes the
// refresh token every 7 days. The auto-renewal cron can renew the Pub/Sub watch
// but NOT the refresh token (that needs human re-consent). Re-running the old
// localhost-based `email-setup` requires the production secrets on a local
// machine, which is painful.
//
// This module powers two HTTP routes (in serve-http) so re-auth becomes a single
// link click, with the token exchange + encryption happening ON the deployed
// machine (prod env already present), zero local secrets:
//   GET /email-oauth-start?token=<AUTH>  -> 302 to Google consent (with CSRF state)
//   GET /email-oauth-callback            -> exchange code, watch, store token
//
// Deferred proper fix (see decision 2026-06-03): move the agent email to a
// Google Workspace account and mark the OAuth app "Internal" so tokens never
// expire. Until then, this keeps re-auth painless.

import { SupabaseEmailTokenStore } from "@agent-mouth/storage-supabase";
import {
  GmailDriver,
  buildAuthUrl,
  encryptToken,
  exchangeCodeForTokens,
} from "@agent-mouth/transport-email";

export const EMAIL_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

/**
 * Single-use, TTL-bounded CSRF state store for the OAuth round-trip. In-memory
 * is fine: the flow completes in seconds, and a process restart just means the
 * user clicks the start link again. `now` is injected so it is trivially testable.
 */
export function createStateStore(ttlMs = 10 * 60_000) {
  const states = new Map<string, number>(); // state -> expiresAt (epoch ms)
  return {
    issue(value: string, now: number): void {
      states.set(value, now + ttlMs);
    },
    /** Returns true exactly once for a non-expired issued state, then forgets it. */
    consume(value: string, now: number): boolean {
      const expiresAt = states.get(value);
      if (expiresAt === undefined) return false;
      states.delete(value); // single-use regardless of expiry
      return expiresAt > now;
    },
  };
}

export function buildEmailReauthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  return buildAuthUrl({
    clientId: args.clientId,
    redirectUri: args.redirectUri,
    scopes: EMAIL_OAUTH_SCOPES,
    state: args.state,
  });
}

export interface CompleteEmailReauthArgs {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: string;
  topicName: string;
  supabaseUrl: string;
  supabaseKey: string;
  workspaceId: string;
}

/**
 * Exchange the OAuth code for a refresh token, (re)establish the Gmail watch, and
 * upsert the encrypted token. Mirrors the legacy `email-setup` CLI flow but runs
 * server-side. Throws on any failure; the caller turns that into a 5xx page.
 */
export async function completeEmailReauth(
  a: CompleteEmailReauthArgs,
): Promise<{ email_address: string; watch_expiration: string }> {
  const tokens = await exchangeCodeForTokens({
    clientId: a.clientId,
    clientSecret: a.clientSecret,
    redirectUri: a.redirectUri,
    code: a.code,
  });
  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh_token returned (auth URL must use prompt=consent + access_type=offline)",
    );
  }

  const driver = new GmailDriver({ clientId: a.clientId, clientSecret: a.clientSecret });
  const me = await driver.whoami({ refresh_token: tokens.refresh_token, email_address: "" });
  const watch = await driver.watch({
    auth: { refresh_token: tokens.refresh_token, email_address: me.email_address },
    topic_name: a.topicName,
  });

  // Ensure an email channel row exists (mirrors email-setup). Supabase REST.
  const restHeaders = {
    apikey: a.supabaseKey,
    Authorization: `Bearer ${a.supabaseKey}`,
    "Content-Type": "application/json",
  };
  const lookupUrl = `${a.supabaseUrl}/rest/v1/channels?workspace_id=eq.${a.workspaceId}&type=eq.email&select=id&limit=1`;
  const lookupRes = await fetch(lookupUrl, { headers: restHeaders });
  if (!lookupRes.ok) {
    throw new Error(`email channel lookup failed: ${lookupRes.status} ${await lookupRes.text()}`);
  }
  let channelId = ((await lookupRes.json()) as Array<{ id: string }>)[0]?.id;
  if (!channelId) {
    const insertRes = await fetch(`${a.supabaseUrl}/rest/v1/channels`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        workspace_id: a.workspaceId,
        type: "email",
        config: { email_address: me.email_address },
        status: "active",
      }),
    });
    if (!insertRes.ok) {
      throw new Error(`email channel insert failed: ${insertRes.status} ${await insertRes.text()}`);
    }
    channelId = ((await insertRes.json()) as Array<{ id: string }>)[0]?.id;
  }
  if (!channelId) throw new Error("could not resolve email channel id");

  const tokenStore = new SupabaseEmailTokenStore({ url: a.supabaseUrl, anonKey: a.supabaseKey });
  await tokenStore.upsert({
    workspace_id: a.workspaceId,
    channel_id: channelId,
    email_address: me.email_address,
    refresh_token_encrypted: encryptToken(tokens.refresh_token, a.encryptionKey),
    scopes: EMAIL_OAUTH_SCOPES,
    last_history_id: watch.history_id,
    watch_expiration: watch.expiration,
    status: "active",
    last_error: null,
    consecutive_renewal_failures: 0,
  });

  return { email_address: me.email_address, watch_expiration: watch.expiration };
}
