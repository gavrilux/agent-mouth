// packages/storage-supabase/src/policy-engine.ts
import type { Policy, PolicyEngine, Channel } from "@agent-mouth/core";
import { PolicySchema } from "@agent-mouth/core";

const DEFAULT_POLICY: Policy = {
  id: "00000000-0000-0000-0000-000000000000",
  workspace_id: "00000000-0000-0000-0000-000000000000",
  contact_id: null,
  channel_type: null,
  policy: "silent",
  system_prompt: "",
  rules: {},
  priority: 0,
  created_at: "1970-01-01T00:00:00.000Z",
};

export class SupabasePolicyEngine implements PolicyEngine {
  constructor(private readonly url: string, private readonly key: string) {}

  private headers() {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
  }

  async evaluate(args: {
    workspaceId: string;
    contactId: string;
    channelType: Channel["type"];
  }): Promise<Policy> {
    // Build query string manually to preserve raw PostgREST syntax
    // (URLSearchParams percent-encodes commas/parens which PostgREST requires unencoded)
    const params = [
      `workspace_id=eq.${args.workspaceId}`,
      `or=(contact_id.eq.${args.contactId},contact_id.is.null)`,
      `or=(channel_type.eq.${args.channelType},channel_type.is.null)`,
      `select=*`,
      `order=contact_id.desc.nullslast,channel_type.desc.nullslast,priority.desc`,
      `limit=1`,
    ];
    const url = `${this.url}/rest/v1/policies?${params.join("&")}`;

    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`policy fetch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    if (rows.length === 0) return { ...DEFAULT_POLICY, workspace_id: args.workspaceId };
    return PolicySchema.parse(rows[0]);
  }
}
