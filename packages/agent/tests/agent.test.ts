import { MockRuntime } from "@agent-mouth/agent-runtime";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";

const contactStore = {
  findById: async (_w: string, id: string) =>
    id === "c1"
      ? { id: "c1", workspace_id: "w1", display_name: "G", notes: "test notes", created_at: "" }
      : null,
  upsertByDisplayName: async () => {
    throw new Error("not used");
  },
  updateNotes: async () => {},
};
const messages = { lastN: async () => [], insert: async () => ({}) as any };
const audit = {
  sumCostUsdSince: async () => 0,
  countSentOrDraftSince: async () => 0,
  findRespondedFor: async () => null,
  write: async () => ({}) as any,
};
const workspaces = {
  getDefault: async () =>
    ({ id: "w1", daily_budget_usd_cap: 5, name: "T", plan: "self-host", created_at: "" }) as any,
};

const policy = {
  id: "p1",
  workspace_id: "w1",
  contact_id: "c1",
  channel_type: "telegram",
  policy: "auto",
  system_prompt: "Sé conciso.",
  model_id: null,
  rate_limit_per_hour: 10,
  max_tokens_out: 500,
  max_tool_calls: 0,
  forbidden_topics_regex: [],
  escalate_triggers_regex: [],
  rules: {},
  priority: 0,
} as any;

describe("Agent facade", () => {
  it("returns decision=ready_to_send with mock runtime when all guardrails pass", async () => {
    const mock = new MockRuntime();
    await mock.initialize({ body: "hola humano" });
    const a = new Agent({
      runtime: mock,
      contactStore: contactStore as any,
      messageStore: messages as any,
      auditLogStore: audit as any,
      workspaceStore: workspaces as any,
    });
    const out = await a.respond({
      workspaceId: "w1",
      contactId: "c1",
      threadId: "t1",
      channelType: "telegram",
      incomingMessageId: "m1",
      incomingContent: "hola",
      policy,
    });
    expect(out.decision).toBe("ready_to_send");
    if (out.decision === "ready_to_send") expect(out.response.body).toBe("hola humano");
  });

  it("returns decision=blocked when forbidden topic matches", async () => {
    const mock = new MockRuntime();
    await mock.initialize({ body: "ignored" });
    const a = new Agent({
      runtime: mock,
      contactStore: contactStore as any,
      messageStore: messages as any,
      auditLogStore: audit as any,
      workspaceStore: workspaces as any,
    });
    const out = await a.respond({
      workspaceId: "w1",
      contactId: "c1",
      threadId: "t1",
      channelType: "telegram",
      incomingMessageId: "m1",
      incomingContent: "weapon stuff",
      policy: { ...policy, forbidden_topics_regex: ["weapon"] },
    });
    expect(out.decision).toBe("blocked");
    if (out.decision === "blocked") expect(out.blockReason).toContain("forbidden_topic");
  });
});
