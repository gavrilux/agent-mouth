import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseMessageStore } from "../src/message-store.js";

const SUPA_URL = "https://x.supabase.co";
const KEY = "anon-key";
const WS = "11111111-1111-1111-1111-111111111111";
const THREAD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const CHAN = "22222222-2222-2222-2222-222222222222";
const M1 = "cccccccc-cccc-cccc-cccc-cccccccccc01";
const M2 = "cccccccc-cccc-cccc-cccc-cccccccccc02";

describe("SupabaseMessageStore", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("insert POSTs to messages and returns the row", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      {
        id: M1, thread_id: THREAD, channel_id: CHAN, channel_identity_id: null,
        direction: "inbound", content: "hola", attachments: [], raw_payload: { x: 1 },
        external_message_id: "42", sent_by: null, created_at: "2026-05-20T00:00:00Z",
      },
    ]), { status: 201 }));

    const s = new SupabaseMessageStore(SUPA_URL, KEY);
    const m = await s.insert({
      threadId: THREAD, channelId: CHAN, channelIdentityId: null,
      direction: "inbound", content: "hola", attachments: [],
      rawPayload: { x: 1 }, externalMessageId: "42", sentBy: null,
    });
    expect(m.id).toBe(M1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${SUPA_URL}/rest/v1/messages`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Prefer: "return=representation" }),
      }),
    );
  });

  it("listRecent filters by threadId, sinceId, limit", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const s = new SupabaseMessageStore(SUPA_URL, KEY);
    await s.listRecent({ workspaceId: WS, threadId: THREAD, sinceId: M2, limit: 10 });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`thread_id=eq.${THREAD}`);
    expect(calledUrl).toContain(`id=gt.${M2}`);
    expect(calledUrl).toContain("limit=10");
    expect(calledUrl).toContain("order=created_at.desc");
  });

  it("waitForNew polls until new messages appear or timeout fires", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))     // poll 1: nothing
      .mockResolvedValueOnce(new Response(JSON.stringify([            // poll 2: hit
        { id: "cccccccc-cccc-cccc-cccc-cccccccccc02", thread_id: THREAD, channel_id: CHAN, channel_identity_id: null,
          direction: "inbound", content: "yo", attachments: [], raw_payload: null,
          external_message_id: "43", sent_by: null, created_at: "2026-05-20T00:00:01Z" },
      ]), { status: 200 }));

    const s = new SupabaseMessageStore(SUPA_URL, KEY);
    // Compress polling to make the test fast.
    (s as unknown as { pollIntervalMs: number }).pollIntervalMs = 5;
    const out = await s.waitForNew({
      workspaceId: WS, sinceCreatedAt: "2026-05-20T00:00:00Z", timeoutSeconds: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("yo");
  });

  it("waitForNew returns empty array on timeout", async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));
    const s = new SupabaseMessageStore(SUPA_URL, KEY);
    (s as unknown as { pollIntervalMs: number }).pollIntervalMs = 5;
    const out = await s.waitForNew({
      workspaceId: WS, sinceCreatedAt: "2026-05-20T00:00:00Z", timeoutSeconds: 0,
    });
    expect(out).toEqual([]);
  });
});
