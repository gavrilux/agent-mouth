// packages/storage-supabase/src/contact-store.ts
import type { Contact, ContactStore } from "@agent-mouth/core";
import { ContactSchema } from "@agent-mouth/core";

export class SupabaseContactStore implements ContactStore {
  constructor(private readonly url: string, private readonly key: string) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async findById(workspaceId: string, id: string): Promise<Contact | null> {
    const url = `${this.url}/rest/v1/contacts?id=eq.${id}&workspace_id=eq.${workspaceId}&select=*&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`contact fetch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length ? ContactSchema.parse(rows[0]) : null;
  }

  async upsertByDisplayName(workspaceId: string, displayName: string): Promise<Contact> {
    const url = `${this.url}/rest/v1/contacts?on_conflict=workspace_id,display_name`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ Prefer: "resolution=merge-duplicates,return=representation" }),
      body: JSON.stringify({ workspace_id: workspaceId, display_name: displayName, notes: "" }),
    });
    if (!res.ok) throw new Error(`contact upsert failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[];
    return ContactSchema.parse(rows[0]);
  }

  async updateNotes(contactId: string, notes: string): Promise<void> {
    const truncated = notes.length > 2000 ? notes.slice(0, 2000) : notes;
    const res = await fetch(
      `${this.url}/rest/v1/contacts?id=eq.${contactId}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ notes: truncated }),
      },
    );
    if (!res.ok) throw new Error(`contacts updateNotes failed: ${res.status} ${await res.text()}`);
  }
}
