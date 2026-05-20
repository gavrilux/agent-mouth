// packages/storage-supabase/src/identity-resolver.ts
import type {
  Channel, ChannelIdentity, Contact,
  IdentityResolver, IdentityResolveResult,
} from "@agent-mouth/core";
import {
  ChannelSchema, ChannelIdentitySchema, ContactSchema,
} from "@agent-mouth/core";
import { SupabaseContactStore } from "./contact-store.js";

export class SupabaseIdentityResolver implements IdentityResolver {
  private contacts: SupabaseContactStore;
  constructor(private readonly url: string, private readonly key: string) {
    this.contacts = new SupabaseContactStore(url, key);
  }

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
    channelType: Channel["type"];
    identifier: string;
    displayName: string;
  }): Promise<IdentityResolveResult> {
    const channel = await this.findChannel(args.workspaceId, args.channelType);
    if (!channel) throw new Error(`no ${args.channelType} channel configured for workspace ${args.workspaceId}`);

    const existing = await this.findIdentity(channel.id, args.identifier);
    if (existing) {
      const contact = await this.contacts.findById(args.workspaceId, existing.contact_id);
      if (!contact) throw new Error(`identity ${existing.id} references missing contact ${existing.contact_id}`);
      return { contact, channel, channel_identity: existing, created: false };
    }

    const contact = await this.contacts.upsertByDisplayName(args.workspaceId, args.displayName);
    const created = await this.createIdentity(contact.id, channel.id, args.identifier);
    return { contact, channel, channel_identity: created, created: true };
  }

  private async findChannel(workspaceId: string, type: Channel["type"]): Promise<Channel | null> {
    const url = `${this.url}/rest/v1/channels?workspace_id=eq.${workspaceId}&type=eq.${type}&select=*&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`channel fetch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length ? ChannelSchema.parse(rows[0]) : null;
  }

  private async findIdentity(channelId: string, identifier: string): Promise<ChannelIdentity | null> {
    const url = `${this.url}/rest/v1/channel_identities?channel_id=eq.${channelId}&identifier=eq.${encodeURIComponent(identifier)}&select=*&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`identity fetch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length ? ChannelIdentitySchema.parse(rows[0]) : null;
  }

  private async createIdentity(contactId: string, channelId: string, identifier: string): Promise<ChannelIdentity> {
    const url = `${this.url}/rest/v1/channel_identities`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({ contact_id: contactId, channel_id: channelId, identifier, verified: false }),
    });
    if (!res.ok) throw new Error(`identity create failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[];
    return ChannelIdentitySchema.parse(rows[0]);
  }
}
