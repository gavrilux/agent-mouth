// packages/storage-supabase/src/workspace-store.ts
import type { Workspace, WorkspaceStore } from "@agent-mouth/core";
import { WorkspaceSchema } from "@agent-mouth/core";

export class SupabaseWorkspaceStore implements WorkspaceStore {
  constructor(private readonly url: string, private readonly key: string) {}

  private headers() {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
  }

  async getDefault(): Promise<Workspace> {
    const res = await fetch(
      `${this.url}/rest/v1/workspaces?name=eq.default&select=*&limit=1`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    if (rows.length === 0) throw new Error("no default workspace seeded");
    return WorkspaceSchema.parse(rows[0]);
  }
}
