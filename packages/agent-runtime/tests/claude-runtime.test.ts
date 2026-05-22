import { describe, it, expect } from "vitest";
import { ClaudeRuntime } from "../src/claude-runtime.js";
import type { AgentContext } from "../src/types.js";

const SKIP = !process.env.ANTHROPIC_API_KEY || process.env.SKIP_LLM_TESTS === "1";

const baseCtx: AgentContext = {
  workspaceId: "w1",
  contact: {
    id: "c1", workspace_id: "w1", display_name: "Gavrilo",
    notes: "Habla español. Le gusta humor seco.", created_at: "",
  } as any,
  channelType: "telegram",
  incomingMessage: {
    id: "m1", direction: "inbound", content: "hola, cómo va",
    sent_by: "human", created_at: "",
  },
  threadHistory: [],
  policy: {
    id: "p1", policy: "auto", system_prompt: "Eres un asistente conciso.",
    model_id: null, max_tokens_out: 500, max_tool_calls: 0,
    rate_limit_per_hour: 10, forbidden_topics_regex: [], escalate_triggers_regex: [],
    rules: {}, priority: 0, workspace_id: "w1", contact_id: "c1", channel_type: "telegram",
  } as any,
  availableTools: [],
  budget: { remainingUsd: 5 },
};

describe.skipIf(SKIP)("ClaudeRuntime (live API)", () => {
  it("returns a response with body and cost", async () => {
    const rt = new ClaudeRuntime();
    await rt.initialize({ apiKey: process.env.ANTHROPIC_API_KEY, defaultModel: "claude-sonnet-4-6" });
    const r = await rt.respond(baseCtx);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.tokens.in).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThan(0);
    await rt.dispose();
  }, 30_000);
});
