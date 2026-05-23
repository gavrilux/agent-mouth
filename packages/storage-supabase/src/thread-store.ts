import type { Thread, ThreadStore } from "@agent-mouth/core";
import { ThreadSchema } from "@agent-mouth/core";

export class SupabaseThreadStore implements ThreadStore {
  constructor(private readonly url: string, private readonly key: string) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async resolveOrCreate(args: {
    workspaceId: string;
    contactId: string;
    channelId: string;
    externalThreadId: string;
  }): Promise<Thread> {
    const url = `${this.url}/rest/v1/threads?on_conflict=channel_id,external_thread_id`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ Prefer: "resolution=merge-duplicates,return=representation" }),
      body: JSON.stringify({
        workspace_id: args.workspaceId,
        contact_id: args.contactId,
        channel_id: args.channelId,
        external_thread_id: args.externalThreadId,
      }),
    });
    if (!res.ok) throw new Error(`thread upsert failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[];
    return ThreadSchema.parse(rows[0]);
  }

  async get(threadId: string): Promise<Thread | null> {
    const res = await fetch(
      `${this.url}/rest/v1/threads?id=eq.${encodeURIComponent(threadId)}&limit=1`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`thread get failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[];
    if (!rows.length) return null;
    return ThreadSchema.parse(rows[0]);
  }

  async markNotesUpdated(threadId: string): Promise<void> {
    const res = await fetch(
      `${this.url}/rest/v1/threads?id=eq.${encodeURIComponent(threadId)}`,
      {
        method: "PATCH",
        headers: this.headers({ Prefer: "return=minimal" }),
        body: JSON.stringify({ notes_last_updated_at: new Date().toISOString() }),
      },
    );
    if (!res.ok) throw new Error(`thread markNotesUpdated failed: ${res.status} ${await res.text()}`);
  }
}
