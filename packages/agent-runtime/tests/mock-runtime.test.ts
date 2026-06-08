import { describe, expect, it } from "vitest";
import { MockRuntime } from "../src/mock-runtime.js";
import type { AgentContext } from "../src/types.js";

const ctx: AgentContext = {
  workspaceId: "w1",
  contact: { id: "c1", workspace_id: "w1", display_name: "Test", notes: "", created_at: "" } as any,
  channelType: "telegram",
  incomingMessage: {
    id: "m1",
    direction: "inbound",
    content: "hi",
    sent_by: "human",
    created_at: "",
  },
  threadHistory: [],
  policy: {} as any,
  availableTools: [],
  budget: { remainingUsd: 5 },
};

describe("MockRuntime", () => {
  it("returns configured body", async () => {
    const rt = new MockRuntime();
    await rt.initialize({ body: "hello world" });
    const r = await rt.respond(ctx);
    expect(r.body).toBe("hello world");
    expect(r.costUsd).toBe(0);
  });

  it("returns shouldEscalate when configured", async () => {
    const rt = new MockRuntime();
    await rt.initialize({ shouldEscalate: true });
    const r = await rt.respond(ctx);
    expect(r.metadata.shouldEscalate).toBe(true);
  });
});
