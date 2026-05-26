import { afterEach, describe, expect, it, vi } from "vitest";
import { SupabaseIdentityResolver } from "../src/identity-resolver.js";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

const WS_ID = "11111111-1111-1111-1111-111111111111";
const CH_ID = "22222222-2222-2222-2222-222222222222";
const C_EXISTING = "33333333-3333-3333-3333-333333333333";
const C_MERGED = "44444444-4444-4444-4444-444444444444";
const C_NEW = "55555555-5555-5555-5555-555555555555";
const CI_UUID = "66666666-6666-6666-6666-666666666666";
const CI_NEW = "77777777-7777-7777-7777-777777777777";

const channel = {
  id: CH_ID,
  workspace_id: WS_ID,
  type: "email",
  config: {},
  status: "active",
  created_at: "2026-05-25T00:00:00.000Z",
};

function makeFetch(routes: Array<{ match: RegExp | string; handler: (init?: RequestInit) => Promise<Response> }>) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const s = String(url);
    for (const { match, handler } of routes) {
      if (typeof match === "string" ? s.includes(match) : match.test(s)) return handler(init);
    }
    throw new Error(`unexpected URL: ${s}`);
  }) as never;
}

describe("SupabaseIdentityResolver.resolveOrCreate (email)", () => {
  it("returns existing Contact on exact ChannelIdentity match (case-insensitive)", async () => {
    globalThis.fetch = makeFetch([
      { match: /\/rest\/v1\/channels\?/, handler: async () => new Response(JSON.stringify([channel]), { status: 200 }) },
      { match: /\/rest\/v1\/channel_identities/, handler: async () => new Response(JSON.stringify([{
        id: CI_UUID, contact_id: C_EXISTING, channel_id: CH_ID,
        identifier: "marco@thecuina.com", verified: false,
      }]), { status: 200 }) },
      { match: /\/rest\/v1\/contacts\?/, handler: async () => new Response(JSON.stringify([{
        id: C_EXISTING, workspace_id: WS_ID, display_name: "Marco",
        notes: "", metadata: {}, created_at: "2026-05-25T00:00:00.000Z",
      }]), { status: 200 }) },
    ]);

    const r = new SupabaseIdentityResolver("https://supabase", "anon");
    const result = await r.resolveOrCreate({
      workspaceId: WS_ID,
      channelType: "email",
      identifier: "Marco@TheCuina.com",  // mixed case — should still match
      displayName: "Marco",
    });
    expect(result.contact.id).toBe(C_EXISTING);
    expect(result.created).toBe(false);
  });

  it("auto-merges via contacts.metadata.email_addresses match (creates new ChannelIdentity)", async () => {
    let metadataLookupCalled = false;
    let identityCreateCalled = false;
    globalThis.fetch = makeFetch([
      { match: /\/rest\/v1\/channels\?/, handler: async () => new Response(JSON.stringify([channel]), { status: 200 }) },
      {
        match: /\/rest\/v1\/channel_identities/,
        handler: async (init) => {
          if (init?.method === "POST") {
            identityCreateCalled = true;
            return new Response(JSON.stringify([{
              id: CI_NEW, contact_id: C_MERGED, channel_id: CH_ID,
              identifier: "marco@thecuina.com", verified: false,
            }]), { status: 201 });
          }
          return new Response(JSON.stringify([]), { status: 200 }); // no exact CI match
        },
      },
      {
        match: /\/rest\/v1\/contacts/,
        handler: async (init) => {
          // Only GET requests should be the metadata lookup
          if (!init?.method || init.method === "GET") {
            metadataLookupCalled = true;
            return new Response(JSON.stringify([{
              id: C_MERGED, workspace_id: WS_ID, display_name: "Marco",
              notes: "", metadata: { email_addresses: ["marco@thecuina.com"] },
              created_at: "2026-05-25T00:00:00.000Z",
            }]), { status: 200 });
          }
          // POST/PATCH shouldn't be reached in auto-merge flow
          throw new Error(`unexpected contacts POST in auto-merge test`);
        },
      },
    ]);

    const r = new SupabaseIdentityResolver("https://supabase", "anon");
    const result = await r.resolveOrCreate({
      workspaceId: WS_ID,
      channelType: "email",
      identifier: "marco@thecuina.com",
      displayName: "Marco",
    });
    expect(result.contact.id).toBe(C_MERGED);
    expect(result.created).toBe(true);    // new ChannelIdentity, existing Contact
    expect(identityCreateCalled).toBe(true);
    expect(metadataLookupCalled).toBe(true);
  });

  it("creates new Contact + ChannelIdentity on no match", async () => {
    let contactCreateCalled = false;
    globalThis.fetch = makeFetch([
      { match: /\/rest\/v1\/channels\?/, handler: async () => new Response(JSON.stringify([channel]), { status: 200 }) },
      {
        match: /\/rest\/v1\/channel_identities/,
        handler: async (init) => {
          if (init?.method === "POST") {
            return new Response(JSON.stringify([{
              id: CI_NEW, contact_id: C_NEW, channel_id: CH_ID,
              identifier: "stranger@example.com", verified: false,
            }]), { status: 201 });
          }
          return new Response(JSON.stringify([]), { status: 200 });
        },
      },
      {
        match: /\/rest\/v1\/contacts\?/,
        handler: async (init) => {
          if (init?.method === "POST") {
            contactCreateCalled = true;
            return new Response(JSON.stringify([{
              id: C_NEW, workspace_id: WS_ID, display_name: "Stranger",
              notes: "", metadata: {}, created_at: "2026-05-25T00:00:00.000Z",
            }]), { status: 201 });
          }
          return new Response(JSON.stringify([]), { status: 200 });   // no metadata match
        },
      },
    ]);

    const r = new SupabaseIdentityResolver("https://supabase", "anon");
    const result = await r.resolveOrCreate({
      workspaceId: WS_ID,
      channelType: "email",
      identifier: "stranger@example.com",
      displayName: "Stranger",
    });
    expect(result.contact.id).toBe(C_NEW);
    expect(result.created).toBe(true);
    expect(contactCreateCalled).toBe(true);
  });
});
