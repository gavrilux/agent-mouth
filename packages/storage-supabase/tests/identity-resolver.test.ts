// packages/storage-supabase/tests/identity-resolver.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseIdentityResolver } from "../src/identity-resolver.js";

const SUPA_URL = "https://x.supabase.co";
const KEY = "anon-key";
const WS = "11111111-1111-1111-1111-111111111111";
const CHAN = "22222222-2222-2222-2222-222222222222";
const CONTACT = "00000000-0000-0000-0000-000000000001";
const IDENT = "00000000-0000-0000-0000-000000000010";

describe("SupabaseIdentityResolver", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns existing identity without creating", async () => {
    // 1) lookup channel by workspace+type
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: CHAN, workspace_id: WS, type: "telegram", config: {}, status: "active", created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 200 }));
    // 2) lookup channel_identity by channel+identifier
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: IDENT, contact_id: CONTACT, channel_id: CHAN, identifier: "987654321", verified: false },
    ]), { status: 200 }));
    // 3) lookup contact by id
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: CONTACT, workspace_id: WS, display_name: "Gavrilo", notes: "", created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 200 }));

    const r = new SupabaseIdentityResolver(SUPA_URL, KEY);
    const out = await r.resolveOrCreate({
      workspaceId: WS, channelType: "telegram", identifier: "987654321", displayName: "Gavrilo",
    });
    expect(out.created).toBe(false);
    expect(out.contact.display_name).toBe("Gavrilo");
    expect(out.channel.type).toBe("telegram");
    expect(out.channel_identity.identifier).toBe("987654321");
  });

  it("auto-creates contact + identity when identity missing", async () => {
    // 1) channel
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: CHAN, workspace_id: WS, type: "telegram", config: {}, status: "active", created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 200 }));
    // 2) identity lookup: empty
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    // 3) upsert contact
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: CONTACT, workspace_id: WS, display_name: "NewUser", notes: "", created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 201 }));
    // 4) insert identity
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: IDENT, contact_id: CONTACT, channel_id: CHAN, identifier: "555", verified: false },
    ]), { status: 201 }));

    const r = new SupabaseIdentityResolver(SUPA_URL, KEY);
    const out = await r.resolveOrCreate({
      workspaceId: WS, channelType: "telegram", identifier: "555", displayName: "NewUser",
    });
    expect(out.created).toBe(true);
  });

  it("throws if no telegram channel configured for workspace", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const r = new SupabaseIdentityResolver(SUPA_URL, KEY);
    await expect(
      r.resolveOrCreate({ workspaceId: WS, channelType: "telegram", identifier: "1", displayName: "x" }),
    ).rejects.toThrow(/no telegram channel/i);
  });
});
