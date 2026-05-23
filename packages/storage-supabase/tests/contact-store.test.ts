// packages/storage-supabase/tests/contact-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseContactStore } from "../src/contact-store.js";

describe("SupabaseContactStore", () => {
  const SUPA_URL = "https://x.supabase.co";
  const KEY = "anon-key";
  const WS = "11111111-1111-1111-1111-111111111111";
  const CONTACT_ID = "00000000-0000-0000-0000-000000000001";
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
        { id: CONTACT_ID, workspace_id: WS, display_name: "Gavrilo", notes: "", created_at: "2026-05-20T00:00:00Z" },
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

  it("updateNotes truncates at 2000 chars", async () => {
    const long = "x".repeat(3000);
    // updateNotes PATCHes; use 200 (jsdom doesn't support 204 in Response constructor)
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    // findById after update
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: CONTACT_ID, workspace_id: WS, display_name: "Gavrilo", notes: "x".repeat(2000), created_at: "2026-05-20T00:00:00Z" },
      ]), { status: 200 }),
    );
    const store = new SupabaseContactStore(SUPA_URL, KEY);
    await store.updateNotes(CONTACT_ID, long);
    const c = await store.findById(WS, CONTACT_ID);
    expect(c?.notes.length).toBeLessThanOrEqual(2000);

    // Also verify the PATCH body was truncated before sending
    const patchCall = fetchMock.mock.calls[0];
    const body = JSON.parse(patchCall[1].body as string) as { notes: string };
    expect(body.notes.length).toBe(2000);
  });
});
