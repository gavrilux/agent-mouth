import { describe, expect, it } from "vitest";
import { WorkingMemoryBuilder } from "../src/working.js";

const fakeStore = {
  lastN: async (threadId: string, n: number) =>
    Array.from({ length: Math.min(n, 5) }, (_, i) => ({
      id: `m${i}`,
      thread_id: threadId,
      direction: i % 2 === 0 ? "inbound" : "outbound",
      content: `msg ${i}`,
      created_at: new Date().toISOString(),
    })) as any,
  insert: async () => {
    throw new Error("not used");
  },
};

describe("WorkingMemoryBuilder", () => {
  it("returns last N messages from store", async () => {
    const b = new WorkingMemoryBuilder(fakeStore as any, 3);
    const r = await b.build("thread-1");
    expect(r.length).toBe(3);
    expect(r[0]!.thread_id).toBe("thread-1");
  });
});
