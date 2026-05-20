// packages/storage-supabase/tests/contact-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseContactStore } from "../src/contact-store.js";

describe("SupabaseContactStore", () => {
  const SUPA_URL = "https://x.supabase.co";
  const KEY = "anon-key";
  const WS = "11111111-1111-1111-1111-111111111111";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("findById returns null for missing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const store = new SupabaseContactStore(SUPA_URL, KEY);
    expect(await store.findById(WS, "00000000-0000-0000-0000-000000000999")).toBeNull();
  });

  it("upsertByDisplayName POSTs with merge-duplicates Prefer header", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: "00000000-0000-0000-0000-000000000001", workspace_id: WS, display_name: "Gavrilo", notes: "", created_at: "2026-05-20T00:00:00Z" },
      ]), { status: 201 }),
    );
    const store = new SupabaseContactStore(SUPA_URL, KEY);
    const c = await store.upsertByDisplayName(WS, "Gavrilo");
    expect(c.display_name).toBe("Gavrilo");
    expect(fetchMock).toHaveBeenCalledWith(
      `${SUPA_URL}/rest/v1/contacts?on_conflict=workspace_id,display_name`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Prefer: "resolution=merge-duplicates,return=representation",
        }),
        body: JSON.stringify({ workspace_id: WS, display_name: "Gavrilo", notes: "" }),
      }),
    );
  });
});
