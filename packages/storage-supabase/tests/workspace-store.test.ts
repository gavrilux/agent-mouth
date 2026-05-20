// packages/storage-supabase/tests/workspace-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseWorkspaceStore } from "../src/workspace-store.js";

describe("SupabaseWorkspaceStore", () => {
  const SUPA_URL = "https://x.supabase.co";
  const KEY = "anon-key";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("getDefault returns the default workspace by name", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: "11111111-1111-1111-1111-111111111111", name: "default", owner_user_id: null, plan: "self-host", created_at: "2026-05-20T00:00:00Z" },
      ]), { status: 200 }),
    );
    const store = new SupabaseWorkspaceStore(SUPA_URL, KEY);
    const w = await store.getDefault();
    expect(w.name).toBe("default");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/rest\/v1\/workspaces\?name=eq\.default&select=\*&limit=1/),
      expect.objectContaining({ headers: expect.objectContaining({ apikey: KEY }) }),
    );
  });

  it("throws when no default workspace exists", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const store = new SupabaseWorkspaceStore(SUPA_URL, KEY);
    await expect(store.getDefault()).rejects.toThrow(/no default workspace/i);
  });
});
