import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseThreadStore } from "../src/thread-store.js";

const SUPA_URL = "https://x.supabase.co";
const KEY = "anon-key";
const WS = "11111111-1111-1111-1111-111111111111";
const CONTACT = "00000000-0000-0000-0000-000000000001";
const CHAN = "22222222-2222-2222-2222-222222222222";
const THREAD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";

describe("SupabaseThreadStore", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("upserts a thread on (channel_id, external_thread_id) and returns it", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: THREAD, workspace_id: WS, contact_id: CONTACT, channel_id: CHAN, external_thread_id: "-5286864201", related_thread_ids: [], last_message_at: null, closed: false, created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 201 }));
    const s = new SupabaseThreadStore(SUPA_URL, KEY);
    const t = await s.resolveOrCreate({ workspaceId: WS, contactId: CONTACT, channelId: CHAN, externalThreadId: "-5286864201" });
    expect(t.external_thread_id).toBe("-5286864201");
    expect(fetchMock).toHaveBeenCalledWith(
      `${SUPA_URL}/rest/v1/threads?on_conflict=channel_id,external_thread_id`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Prefer: "resolution=merge-duplicates,return=representation" }),
      }),
    );
  });
});
