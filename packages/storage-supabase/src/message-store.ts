import type { MessageStore, PersistedMessage, PersistedMessageInput } from "@agent-mouth/core";

export class SupabaseMessageStore implements MessageStore {
  constructor(private readonly url: string, private readonly key: string) {}

  protected pollIntervalMs = 2000;

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async insert(msg: PersistedMessageInput): Promise<PersistedMessage> {
    const res = await fetch(`${this.url}/rest/v1/messages`, {
      method: "POST",
      headers: this.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        thread_id: msg.threadId,
        channel_id: msg.channelId,
        channel_identity_id: msg.channelIdentityId,
        direction: msg.direction,
        content: msg.content,
        attachments: msg.attachments,
        raw_payload: msg.rawPayload,
        external_message_id: msg.externalMessageId,
        sent_by: msg.sentBy,
      }),
    });
    if (!res.ok) throw new Error(`message insert failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as PersistedMessage[];
    return rows[0];
  }

  async listRecent(args: {
    workspaceId: string;
    threadId?: string;
    sinceId?: string;
    limit: number;
  }): Promise<PersistedMessage[]> {
    const params: string[] = ["select=*"];
    if (args.threadId) params.push(`thread_id=eq.${args.threadId}`);
    if (args.sinceId) params.push(`id=gt.${args.sinceId}`);
    params.push("order=created_at.desc");
    params.push(`limit=${args.limit}`);
    const res = await fetch(`${this.url}/rest/v1/messages?${params.join("&")}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`message list failed: ${res.status}`);
    return (await res.json()) as PersistedMessage[];
  }

  async waitForNew(args: {
    workspaceId: string;
    sinceCreatedAt: string;
    timeoutSeconds: number;
  }): Promise<PersistedMessage[]> {
    const deadline = Date.now() + args.timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const params = [
        "select=*",
        `created_at=gt.${args.sinceCreatedAt}`,
        "order=created_at.asc",
        "limit=50",
      ];
      const res = await fetch(`${this.url}/rest/v1/messages?${params.join("&")}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`message poll failed: ${res.status}`);
      const rows = (await res.json()) as PersistedMessage[];
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
    return [];
  }
}
