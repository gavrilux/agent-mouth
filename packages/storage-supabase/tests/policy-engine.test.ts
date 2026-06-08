// packages/storage-supabase/tests/policy-engine.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupabasePolicyEngine } from "../src/policy-engine.js";

const SUPA_URL = "https://x.supabase.co";
const KEY = "anon-key";
const WS = "11111111-1111-1111-1111-111111111111";
const CONTACT = "00000000-0000-0000-0000-000000000001";

describe("SupabasePolicyEngine", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns the most specific policy when multiple rows match", async () => {
    // Supabase returns rows ordered by our request. Most-specific first.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            workspace_id: WS,
            contact_id: CONTACT,
            channel_type: "telegram",
            policy: "auto",
            system_prompt: "",
            rules: {},
            priority: 0,
            created_at: "2026-05-20T00:00:00Z",
          },
          {
            id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            workspace_id: WS,
            contact_id: null,
            channel_type: null,
            policy: "silent",
            system_prompt: "",
            rules: {},
            priority: 0,
            created_at: "2026-05-20T00:00:00Z",
          },
        ]),
        { status: 200 },
      ),
    );

    const e = new SupabasePolicyEngine(SUPA_URL, KEY);
    const p = await e.evaluate({ workspaceId: WS, contactId: CONTACT, channelType: "telegram" });
    expect(p.policy).toBe("auto");
  });

  it("falls back to default policy=silent when no rows", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const e = new SupabasePolicyEngine(SUPA_URL, KEY);
    const p = await e.evaluate({ workspaceId: WS, contactId: CONTACT, channelType: "telegram" });
    expect(p.policy).toBe("silent");
    expect(p.id).toBe("00000000-0000-0000-0000-000000000000"); // synthetic default
  });

  it("builds the correct OR query for fallback", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const e = new SupabasePolicyEngine(SUPA_URL, KEY);
    await e.evaluate({ workspaceId: WS, contactId: CONTACT, channelType: "telegram" });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`workspace_id=eq.${WS}`);
    expect(calledUrl).toContain(`or=(contact_id.eq.${CONTACT},contact_id.is.null)`);
    expect(calledUrl).toContain(`or=(channel_type.eq.telegram,channel_type.is.null)`);
    // most-specific-first order: contact desc nulls last, channel_type desc nulls last, priority desc
    expect(calledUrl).toContain(
      `order=contact_id.desc.nullslast,channel_type.desc.nullslast,priority.desc`,
    );
  });
});
