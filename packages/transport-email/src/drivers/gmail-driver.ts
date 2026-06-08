import { buildMime, mimeToBase64Url } from "../mime.js";
// packages/transport-email/src/drivers/gmail-driver.ts
import { gmailMessageToNormalized } from "../normalize.js";
import { refreshAccessToken } from "../oauth/google.js";
import type {
  EmailDriverAuthCtx,
  FetchResult,
  SendEmailArgs,
  SendEmailResult,
  WatchResult,
} from "../types.js";
import type { EmailDriver } from "./driver.js";

const API_BASE = "https://gmail.googleapis.com/gmail/v1";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export interface GmailDriverConfig {
  clientId: string;
  clientSecret: string;
}

export class GmailDriver implements EmailDriver {
  readonly kind = "gmail" as const;
  readonly requiredScopes = GMAIL_SCOPES;

  constructor(private readonly cfg: GmailDriverConfig) {}

  private async getAccessToken(auth: EmailDriverAuthCtx): Promise<string> {
    const r = await refreshAccessToken({
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret,
      refreshToken: auth.refresh_token,
    });
    return r.access_token;
  }

  private authHeaders(accessToken: string): HeadersInit {
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
  }

  async whoami(auth: EmailDriverAuthCtx): Promise<{ email_address: string }> {
    const tok = await this.getAccessToken(auth);
    const res = await fetch(`${API_BASE}/users/me/profile`, { headers: this.authHeaders(tok) });
    if (!res.ok) throw new Error(`profile failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { emailAddress: string };
    return { email_address: body.emailAddress };
  }

  async fetchNewMessages(args: {
    auth: EmailDriverAuthCtx;
    last_cursor: string;
  }): Promise<FetchResult> {
    const tok = await this.getAccessToken(args.auth);

    // Primary: history.list
    const histUrl = new URL(`${API_BASE}/users/me/history`);
    histUrl.searchParams.set("startHistoryId", args.last_cursor || "1");
    histUrl.searchParams.set("historyTypes", "messageAdded");
    histUrl.searchParams.set("labelId", "INBOX");
    const histRes = await fetch(histUrl, { headers: this.authHeaders(tok) });

    if (histRes.status === 404) {
      // historyId expired (>7 days idle) — fallback to messages.list since the last known time.
      return this.fallbackResync(args.auth, tok);
    }
    if (!histRes.ok)
      throw new Error(`history.list failed: ${histRes.status} ${await histRes.text()}`);

    const hist = (await histRes.json()) as {
      historyId: string;
      history?: Array<{ messagesAdded?: Array<{ message: { id: string; threadId: string } }> }>;
    };

    const ids = new Set<string>();
    for (const h of hist.history ?? []) {
      for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
    }
    const messages = await this.fetchMessagesByIds(tok, [...ids]);
    return { messages, next_cursor: hist.historyId };
  }

  private async fallbackResync(_auth: EmailDriverAuthCtx, tok: string): Promise<FetchResult> {
    // Fetch INBOX messages from the last 24h as a coarse net.
    const sinceUnix = Math.floor((Date.now() - 24 * 3600 * 1000) / 1000);
    const listUrl = new URL(`${API_BASE}/users/me/messages`);
    listUrl.searchParams.set("q", `in:inbox after:${sinceUnix}`);
    listUrl.searchParams.set("maxResults", "100");
    const listRes = await fetch(listUrl, { headers: this.authHeaders(tok) });
    if (!listRes.ok) throw new Error(`messages.list fallback failed: ${listRes.status}`);
    const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
    const ids = (list.messages ?? []).map((m) => m.id);
    const messages = await this.fetchMessagesByIds(tok, ids);

    // Refresh historyId via profile
    const profRes = await fetch(`${API_BASE}/users/me/profile`, { headers: this.authHeaders(tok) });
    if (!profRes.ok) throw new Error(`profile (resync) failed: ${profRes.status}`);
    const prof = (await profRes.json()) as { historyId: string };
    return { messages, next_cursor: prof.historyId };
  }

  private async fetchMessagesByIds(tok: string, ids: string[]) {
    const out = [];
    for (const id of ids) {
      const res = await fetch(`${API_BASE}/users/me/messages/${id}?format=full`, {
        headers: this.authHeaders(tok),
      });
      if (!res.ok) continue; // skip individual failures
      const raw = (await res.json()) as Parameters<typeof gmailMessageToNormalized>[0];
      out.push(gmailMessageToNormalized(raw));
    }
    return out;
  }

  async send(args: {
    auth: EmailDriverAuthCtx;
    payload: SendEmailArgs;
  }): Promise<SendEmailResult> {
    const tok = await this.getAccessToken(args.auth);
    const mime = buildMime(args.payload);
    const raw = mimeToBase64Url(mime);
    const res = await fetch(`${API_BASE}/users/me/messages/send`, {
      method: "POST",
      headers: this.authHeaders(tok),
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`messages.send failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { id: string; threadId: string };
    return { message_id: body.id, thread_id: body.threadId };
  }

  async watch(args: { auth: EmailDriverAuthCtx; topic_name: string }): Promise<WatchResult> {
    const tok = await this.getAccessToken(args.auth);
    const res = await fetch(`${API_BASE}/users/me/watch`, {
      method: "POST",
      headers: this.authHeaders(tok),
      body: JSON.stringify({
        topicName: args.topic_name,
        labelIds: ["INBOX"],
        labelFilterAction: "include",
      }),
    });
    if (!res.ok) throw new Error(`users.watch failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { historyId: string; expiration: string };
    return {
      history_id: body.historyId,
      expiration: new Date(Number(body.expiration)).toISOString(),
    };
  }
}
