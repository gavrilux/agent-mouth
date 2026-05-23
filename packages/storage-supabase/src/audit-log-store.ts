import type { AuditEntry, AuditLogInput, AuditLogStore } from "@agent-mouth/core";

export interface SupabaseAuditLogStoreOptions {
  url: string;
  anonKey: string;
}

export class SupabaseAuditLogStore implements AuditLogStore {
  constructor(private opts: SupabaseAuditLogStoreOptions) {}

  private headers() {
    return {
      apikey: this.opts.anonKey,
      Authorization: `Bearer ${this.opts.anonKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
  }

  async write(input: AuditLogInput): Promise<AuditEntry> {
    const body = JSON.stringify({
      workspace_id: input.workspace_id,
      action: input.action,
      actor: input.actor,
      details: input.details ?? {},
      related_message_id: input.related_message_id ?? null,
      related_contact_id: input.related_contact_id ?? null,
      decision: input.decision ?? null,
      block_reason: input.block_reason ?? null,
      model_id: input.model_id ?? null,
      tokens_in: input.tokens_in ?? null,
      tokens_out: input.tokens_out ?? null,
      tokens_cached: input.tokens_cached ?? null,
      cost_usd: input.cost_usd ?? null,
      latency_ms: input.latency_ms ?? null,
    });
    const res = await fetch(`${this.opts.url}/rest/v1/audit_log`, {
      method: "POST",
      headers: this.headers(),
      body,
    });
    if (!res.ok) throw new Error(`audit_log insert failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as AuditEntry[];
    return rows[0]!;
  }

  async sumCostUsdSince(workspaceId: string, sinceIso: string): Promise<number> {
    const url = new URL(`${this.opts.url}/rest/v1/audit_log`);
    url.searchParams.set("workspace_id", `eq.${workspaceId}`);
    url.searchParams.set("created_at", `gte.${sinceIso}`);
    url.searchParams.set("decision", "in.(sent,draft)");
    url.searchParams.set("select", "cost_usd");
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`audit_log sum failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as Array<{ cost_usd: number | null }>;
    return rows.reduce((acc, r) => acc + (r.cost_usd ?? 0), 0);
  }

  async countSentOrDraftSince(contactId: string, sinceIso: string): Promise<number> {
    const url = new URL(`${this.opts.url}/rest/v1/audit_log`);
    url.searchParams.set("related_contact_id", `eq.${contactId}`);
    url.searchParams.set("created_at", `gte.${sinceIso}`);
    url.searchParams.set("decision", "in.(sent,draft)");
    url.searchParams.set("select", "id");
    const res = await fetch(url, {
      headers: { ...this.headers(), Prefer: "count=exact" },
    });
    if (!res.ok) throw new Error(`audit_log count failed: ${res.status} ${await res.text()}`);
    const range = res.headers.get("content-range");
    const total = range?.split("/").at(-1) ?? "0";
    return Number.parseInt(total, 10) || 0;
  }

  async findRespondedFor(messageId: string): Promise<AuditEntry | null> {
    const url = new URL(`${this.opts.url}/rest/v1/audit_log`);
    url.searchParams.set("related_message_id", `eq.${messageId}`);
    url.searchParams.set("decision", "in.(sent,draft)");
    url.searchParams.set("limit", "1");
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`audit_log find failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as AuditEntry[];
    return rows[0] ?? null;
  }
}
