// packages/api/tests/watchdog/heartbeat.test.ts
import { describe, expect, it, vi } from "vitest";
import { sendHeartbeat } from "../../src/watchdog/heartbeat.js";

describe("sendHeartbeat", () => {
  it("no hace ping y devuelve false si no hay URL", async () => {
    const fetchFn = vi.fn() as never;
    const ok = await sendHeartbeat({ url: undefined, fetchFn });
    expect(ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("hace ping y devuelve true cuando hay URL", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true })) as never;
    const ok = await sendHeartbeat({ url: "https://hc.example/ping/abc", fetchFn });
    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith("https://hc.example/ping/abc");
  });

  it("devuelve false (sin lanzar) si el fetch falla", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network");
    }) as never;
    const ok = await sendHeartbeat({ url: "https://hc.example/ping/abc", fetchFn });
    expect(ok).toBe(false);
  });
});
