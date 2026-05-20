import { describe, it, expect } from "vitest";
import type { AgentRuntime, AgentContext, AgentResponse, RuntimeConfig } from "../src/agent-runtime";

describe("AgentRuntime interface contract", () => {
  it("exports AgentRuntime with initialize/respond/estimateCost/dispose", () => {
    const _stub: AgentRuntime = {
      initialize: async (_: RuntimeConfig) => {},
      respond: async (_: AgentContext) => ({
        body: "",
        reasoning: "",
        tools_called: [],
        tokens_used: { in: 0, out: 0, cached: 0 },
        cost_estimate_usd: 0,
        metadata: { confidence: 0, should_escalate: false },
      } as AgentResponse),
      estimateCost: async (_: AgentContext) => 0,
      dispose: async () => {},
    };
    expect(_stub).toBeDefined();
  });
});
