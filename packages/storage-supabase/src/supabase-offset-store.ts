import type { OffsetStore } from "@agent-mouth/core";

export class SupabaseOffsetStore implements OffsetStore {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(url: string, anonKey: string, table = "agent_mouth_state") {
    this.baseUrl = `${url}/rest/v1/${table}`;
    this.headers = {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    };
  }

  async getOffset(handle: string): Promise<number> {
    const url = `${this.baseUrl}?handle=eq.${encodeURIComponent(handle)}&select=last_seen_update_id`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return 0;
    const rows = (await res.json()) as Array<{ last_seen_update_id: number }>;
    return rows[0]?.last_seen_update_id ?? 0;
  }

  async saveOffset(handle: string, updateId: number): Promise<void> {
    const url = this.baseUrl;
    await fetch(url, {
      method: "POST",
      headers: {
        ...this.headers,
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        handle,
        last_seen_update_id: updateId,
        updated_at: new Date().toISOString(),
      }),
    });
  }
}

export class NoopOffsetStore implements OffsetStore {
  async getOffset(_handle: string): Promise<number> {
    return 0;
  }
  async saveOffset(_handle: string, _updateId: number): Promise<void> {}
}
