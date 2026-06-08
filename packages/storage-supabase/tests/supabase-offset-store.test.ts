import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoopOffsetStore, SupabaseOffsetStore } from "../src/supabase-offset-store";

describe("SupabaseOffsetStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("getOffset returns 0 when no row exists", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    const store = new SupabaseOffsetStore("https://x.supabase.co", "anon");
    expect(await store.getOffset("handle1")).toBe(0);
  });

  it("getOffset returns row value", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ last_seen_update_id: 42 }],
    });
    const store = new SupabaseOffsetStore("https://x.supabase.co", "anon");
    expect(await store.getOffset("handle1")).toBe(42);
  });

  it("saveOffset POSTs upsert with merge-duplicates", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchSpy;
    const store = new SupabaseOffsetStore("https://x.supabase.co", "anon");
    await store.saveOffset("h", 99);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://x.supabase.co/rest/v1/agent_mouth_state",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Prefer: "resolution=merge-duplicates",
        }),
      }),
    );
  });
});

describe("NoopOffsetStore", () => {
  it("always returns 0 and no-ops saves", async () => {
    const store = new NoopOffsetStore();
    expect(await store.getOffset("any")).toBe(0);
    await expect(store.saveOffset("any", 1)).resolves.toBeUndefined();
  });
});
