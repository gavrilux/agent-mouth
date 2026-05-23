import type { Draft, DraftStore } from "@agent-mouth/core";

export interface SupabaseDraftStoreOptions {
  url: string;
  anonKey: string;
}

export class SupabaseDraftStore implements DraftStore {
  constructor(private opts: SupabaseDraftStoreOptions) {}

  private headers() {
    return {
      apikey: this.opts.anonKey,
      Authorization: `Bearer ${this.opts.anonKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
  }

  async insert(input: {
    message_id: string;
    proposed_body: string;
    agent_reasoning: string;
    tools_called: Array<Record<string, unknown>>;
  }): Promise<Draft> {
    const res = await fetch(`${this.opts.url}/rest/v1/drafts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        message_id: input.message_id,
        proposed_body: input.proposed_body,
        agent_reasoning: input.agent_reasoning,
        tools_called: input.tools_called,
      }),
    });
    if (!res.ok) throw new Error(`drafts insert failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as Draft[];
    return rows[0]!;
  }

  async findPendingByMessageId(messageId: string): Promise<Draft | null> {
    const url = new URL(`${this.opts.url}/rest/v1/drafts`);
    url.searchParams.set("message_id", `eq.${messageId}`);
    url.searchParams.set("status", "eq.pending");
    url.searchParams.set("limit", "1");
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`drafts find failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as Draft[];
    return rows[0] ?? null;
  }
}
