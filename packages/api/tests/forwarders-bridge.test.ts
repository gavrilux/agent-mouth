import { describe, it, expect, vi, beforeEach } from "vitest";
import { forwardToBridge } from "../src/forwarders/bridge.js";

describe("forwardToBridge", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("POSTs the raw payload as JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const ok = await forwardToBridge("https://lab.example/webhook", { update_id: 1 });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://lab.example/webhook", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    }));
  });

  it("returns false on non-2xx and does not throw", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 502 }));
    expect(await forwardToBridge("https://lab.example/webhook", {})).toBe(false);
  });

  it("returns false on network error and does not throw", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await forwardToBridge("https://lab.example/webhook", {})).toBe(false);
  });
});
