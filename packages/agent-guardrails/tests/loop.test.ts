import { describe, expect, it } from "vitest";
import { checkLoopProtection } from "../src/loop.js";

const msgStub = (msgs: Array<{ direction: string; sent_by: string | null }>) => ({
  lastN: async (_t: string, _n: number) => msgs as any,
  insert: async () => {
    throw new Error("not used");
  },
});

describe("checkLoopProtection", () => {
  it("ok when fewer than 3 agent outbound", async () => {
    const r = await checkLoopProtection(
      { threadId: "t1" },
      msgStub([
        { direction: "outbound", sent_by: "agent" },
        { direction: "inbound", sent_by: "human" },
      ]) as any,
    );
    expect(r.ok).toBe(true);
  });

  it("blocked when 3 agent outbound in a row", async () => {
    const r = await checkLoopProtection(
      { threadId: "t1" },
      msgStub([
        { direction: "outbound", sent_by: "agent" },
        { direction: "outbound", sent_by: "agent" },
        { direction: "outbound", sent_by: "agent" },
      ]) as any,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("loop_protection");
  });
});
