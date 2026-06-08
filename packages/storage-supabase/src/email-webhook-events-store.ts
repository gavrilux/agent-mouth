export interface SupabaseEmailWebhookEventsStoreOptions {
  url: string;
  anonKey: string;
}

export class SupabaseEmailWebhookEventsStore {
  constructor(private readonly opts: SupabaseEmailWebhookEventsStoreOptions) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.opts.anonKey,
      Authorization: `Bearer ${this.opts.anonKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /**
   * Inserts the (email_address, history_id) row. Returns true if inserted (first time),
   * false if it already existed (duplicate webhook). Used for at-least-once dedup.
   */
  async recordOnce(emailAddress: string, historyId: string): Promise<boolean> {
    const url = `${this.opts.url}/rest/v1/email_webhook_events`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify({ email_address: emailAddress.toLowerCase(), history_id: historyId }),
    });
    if (res.status === 201) return true;
    if (res.status === 409) return false; // UNIQUE violation → duplicate
    throw new Error(`email_webhook_events insert failed: ${res.status} ${await res.text()}`);
  }
}
