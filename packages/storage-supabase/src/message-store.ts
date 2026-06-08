import type { MessageStore, PersistedMessage, PersistedMessageInput } from "@agent-mouth/core";

export class SupabaseMessageStore implements MessageStore {
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}

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
    const row = rows[0];
    if (!row) throw new Error("message insert returned no rows");
    return row;
  }

  async countSinceTimestamp(threadId: string, sinceIso: string): Promise<number> {
    const params = [
      "select=id",
      `thread_id=eq.${encodeURIComponent(threadId)}`,
      `created_at=gte.${encodeURIComponent(sinceIso)}`,
    ];
    const res = await fetch(`${this.url}/rest/v1/messages?${params.join("&")}`, {
      headers: this.headers({ Prefer: "count=exact" }),
    });
    if (!res.ok) throw new Error(`message countSinceTimestamp failed: ${res.status}`);
    const contentRange = res.headers.get("content-range");
    if (!contentRange) return 0;
    // content-range: 0-N/TOTAL  or  */TOTAL
    const match = contentRange.match(/\/(\d+)$/);
    return match ? Number.parseInt(match[1]!, 10) : 0;
  }

  async lastN(threadId: string, n: number): Promise<PersistedMessage[]> {
    const params = ["select=*", `thread_id=eq.${threadId}`, "order=created_at.desc", `limit=${n}`];
    const res = await fetch(`${this.url}/rest/v1/messages?${params.join("&")}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`message lastN failed: ${res.status}`);
    const rows = (await res.json()) as PersistedMessage[];
    return rows.reverse();
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
    const res = await fetch(`${this.url}/rest/v1/messages?${params.join("&")}`, {
      headers: this.headers(),
    });
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
      const res = await fetch(`${this.url}/rest/v1/messages?${params.join("&")}`, {
        headers: this.headers(),
      });
      if (!res.ok) throw new Error(`message poll failed: ${res.status}`);
      const rows = (await res.json()) as PersistedMessage[];
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
    return [];
  }
}
