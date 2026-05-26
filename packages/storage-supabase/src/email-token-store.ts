import type { EmailToken } from "@agent-mouth/core";
import { EmailTokenSchema } from "@agent-mouth/core";

export interface SupabaseEmailTokenStoreOptions {
  url: string;
  anonKey: string;
}

export class SupabaseEmailTokenStore {
  constructor(private readonly opts: SupabaseEmailTokenStoreOptions) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.opts.anonKey,
      Authorization: `Bearer ${this.opts.anonKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async list(workspaceId?: string): Promise<EmailToken[]> {
    const wsClause = workspaceId ? `workspace_id=eq.${workspaceId}&` : "";
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?${wsClause}select=*`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`email_oauth_tokens list failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.map((r) => EmailTokenSchema.parse(r));
  }

  async getByAddress(workspaceId: string, email: string): Promise<EmailToken | null> {
    const enc = encodeURIComponent(email.toLowerCase());
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?workspace_id=eq.${workspaceId}&email_address=eq.${enc}&select=*&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`email_oauth_tokens get failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length ? EmailTokenSchema.parse(rows[0]) : null;
  }

  async upsert(row: Omit<EmailToken, "id" | "created_at" | "updated_at"> & { id?: string }): Promise<EmailToken> {
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?on_conflict=workspace_id,email_address`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ Prefer: "return=representation,resolution=merge-duplicates" }),
      body: JSON.stringify({ ...row, email_address: row.email_address.toLowerCase(), updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`email_oauth_tokens upsert failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[];
    return EmailTokenSchema.parse(rows[0]);
  }

  async updateCursor(id: string, historyId: string): Promise<void> {
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?id=eq.${id}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ last_history_id: historyId, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`email_oauth_tokens updateCursor failed: ${res.status}`);
  }

  async updateWatchExpiration(id: string, expiration: string): Promise<void> {
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?id=eq.${id}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({
        watch_expiration: expiration,
        consecutive_renewal_failures: 0,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`email_oauth_tokens updateWatchExpiration failed: ${res.status}`);
  }

  async markError(id: string, err: string): Promise<void> {
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?id=eq.${id}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({
        status: "error",
        last_error: err.slice(0, 1000),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`email_oauth_tokens markError failed: ${res.status}`);
  }

  async incrementRenewalFailures(id: string): Promise<number> {
    const cur = await fetch(
      `${this.opts.url}/rest/v1/email_oauth_tokens?id=eq.${id}&select=consecutive_renewal_failures`,
      { headers: this.headers() },
    );
    if (!cur.ok) throw new Error(`renewalFailures read failed: ${cur.status}`);
    const rows = (await cur.json()) as Array<{ consecutive_renewal_failures: number }>;
    const next = (rows[0]?.consecutive_renewal_failures ?? 0) + 1;
    const upd = await fetch(`${this.opts.url}/rest/v1/email_oauth_tokens?id=eq.${id}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ consecutive_renewal_failures: next, updated_at: new Date().toISOString() }),
    });
    if (!upd.ok) throw new Error(`renewalFailures inc failed: ${upd.status}`);
    return next;
  }
}
