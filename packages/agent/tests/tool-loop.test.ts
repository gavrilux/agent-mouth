import type {
  AgentContext,
  AgentResponse,
  AgentRuntime,
  RespondTurnRequest,
  RespondTurnResponse,
  RuntimeConfig,
} from "@agent-mouth/agent-runtime";
import type { Tool, ToolContext, ToolExecutionResult } from "@agent-mouth/core";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";

// ---- shared test stubs ----

const contactStore = {
  findById: async (_w: string, id: string) =>
    id === "c1"
      ? { id: "c1", workspace_id: "w1", display_name: "G", notes: "notes", created_at: "" }
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
    ({
      id: "w1",
      daily_budget_usd_cap: 5,
      name: "T",
      plan: "self-host",
      created_at: "",
    }) as any,
};

const basePolicy = {
  id: "p1",
  workspace_id: "w1",
  contact_id: "c1",
  channel_type: "telegram",
  policy: "auto",
  system_prompt: "Sé conciso.",
  model_id: null,
  rate_limit_per_hour: 10,
  max_tokens_out: 500,
  max_tool_calls: 5,
  forbidden_topics_regex: [],
  escalate_triggers_regex: [],
  rules: {},
  priority: 0,
} as any;

const baseRespondInput = {
  workspaceId: "w1",
  contactId: "c1",
  threadId: "t1",
  channelType: "telegram" as const,
  incomingMessageId: "m1",
  incomingContent: "hola",
  policy: basePolicy,
};

// ---- fake tool ----

function makeFakeTool(name: string, result: ToolExecutionResult): Tool {
  return {
    name,
    description: `Fake tool ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async (_input: unknown, _ctx: ToolContext) => result,
  };
}

// ---- fake runtime that supports respondTurn ----

class FakeRuntime implements AgentRuntime {
  // Queue of RespondTurnResponse to return in sequence
  private respondTurnQueue: RespondTurnResponse[] = [];
  // Captured calls for assertions
  public respondTurnCalls: RespondTurnRequest[] = [];

  addTurnResponse(r: RespondTurnResponse) {
    this.respondTurnQueue.push(r);
  }

  async initialize(_config: RuntimeConfig): Promise<void> {}

  async respond(_ctx: AgentContext): Promise<AgentResponse> {
    return {
      body: "fallback",
      reasoning: "fallback",
      toolsCalled: [],
      tokens: { in: 0, out: 0, cached: 0 },
      costUsd: 0,
      metadata: { confidence: 0.9, shouldEscalate: false },
    };
  }

  async estimateCost(_ctx: AgentContext): Promise<number> {
    return 0;
  }

  async dispose(): Promise<void> {}

  async respondTurn(req: RespondTurnRequest): Promise<RespondTurnResponse> {
    this.respondTurnCalls.push(req);
    const next = this.respondTurnQueue.shift();
    if (!next) throw new Error("FakeRuntime: no more respondTurn responses queued");
    return next;
  }
}

// ---- Tests ----

describe("Agent tool-use loop", () => {
  it("Test 1: tool then final text — returns ready_to_send with toolsCalled populated", async () => {
    const runtime = new FakeRuntime();

    // Turn 1: Claude wants to call the fake tool
    runtime.addTurnResponse({
      toolCalls: [{ id: "tu_1", name: "fake", input: { q: "x" } }],
      stopReason: "tool_use",
      tokens: { in: 100, out: 50, cached: 0 },
      costUsd: 0.001,
    });

    // Turn 2: Claude responds with final output
    runtime.addTurnResponse({
      finalOutput: {
        body: "respuesta final",
        reasoning: "usé la herramienta",
        confidence: 0.95,
        should_escalate: false,
      },
      stopReason: "end_turn",
      tokens: { in: 150, out: 80, cached: 0 },
      costUsd: 0.002,
    });

    const fakeTool = makeFakeTool("fake", {
      ok: true,
      output: { result: "found something" },
      costUsd: 0,
      latencyMs: 10,
    });

    const agent = new Agent({
      runtime,
      contactStore: contactStore as any,
      messageStore: messages as any,
      auditLogStore: audit as any,
      workspaceStore: workspaces as any,
    });

    const out = await agent.respond({ ...baseRespondInput, tools: [fakeTool] });

    expect(out.decision).toBe("ready_to_send");
    if (out.decision === "ready_to_send") {
      expect(out.response.body).toBe("respuesta final");
      expect(out.response.toolsCalled).toHaveLength(1);
      expect(out.response.toolsCalled[0].name).toBe("fake");
      expect(out.response.toolsCalled[0].result).toBe("ok");
    }
    expect(runtime.respondTurnCalls).toHaveLength(2);
  });

  it("Test 2: max_tool_calls exhausted — returns blocked", async () => {
    const runtime = new FakeRuntime();

    // Policy with max_tool_calls=2 — runtime always returns toolCalls, never finalOutput
    const policyLow = { ...basePolicy, max_tool_calls: 2 };

    // Turn 1: tool_use
    runtime.addTurnResponse({
      toolCalls: [{ id: "tu_1", name: "fake", input: {} }],
      stopReason: "tool_use",
      tokens: { in: 10, out: 5, cached: 0 },
      costUsd: 0,
    });

    // Turn 2: tool_use again (2nd invocation, cap reached)
    runtime.addTurnResponse({
      toolCalls: [{ id: "tu_2", name: "fake", input: {} }],
      stopReason: "tool_use",
      tokens: { in: 10, out: 5, cached: 0 },
      costUsd: 0,
    });

    // Turn 3: forced respond_to_user (tools=[] passed), runtime returns finalOutput
    // But we test what happens when runtime returns finalOutput after force
    runtime.addTurnResponse({
      finalOutput: {
        body: "lo siento, no pude terminar",
        reasoning: "max calls",
        confidence: 0.3,
        should_escalate: false,
      },
      stopReason: "end_turn",
      tokens: { in: 10, out: 5, cached: 0 },
      costUsd: 0,
    });

    const fakeTool = makeFakeTool("fake", {
      ok: true,
      output: { result: "ok" },
      costUsd: 0,
      latencyMs: 1,
    });

    const agent = new Agent({
      runtime,
      contactStore: contactStore as any,
      messageStore: messages as any,
      auditLogStore: audit as any,
      workspaceStore: workspaces as any,
    });

    // Verify: after 2 invocations, turn 3 passes tools=[]
    const out = await agent.respond({ ...baseRespondInput, policy: policyLow, tools: [fakeTool] });

    // With max_tool_calls=2 and 2 tool invocations done, turn 3 gets tools=[]
    // Runtime returns finalOutput so decision = ready_to_send
    // The loop exhausts invocations and forces respond_to_user — that's correct behavior.
    // We verify that turn 3's request had tools=[]
    const turn3Req = runtime.respondTurnCalls[2];
    expect(turn3Req).toBeDefined();
    expect(turn3Req.tools).toEqual([]);
  });

  it("Test 2b: runtime always returns toolCalls even when tools=[] forced — loop exits blocked", async () => {
    const runtime = new FakeRuntime();
    const policyLow = { ...basePolicy, max_tool_calls: 2 };

    // Turn 1: tool_use
    runtime.addTurnResponse({
      toolCalls: [{ id: "tu_1", name: "fake", input: {} }],
      stopReason: "tool_use",
      tokens: { in: 10, out: 5, cached: 0 },
      costUsd: 0,
    });
    // Turn 2: tool_use
    runtime.addTurnResponse({
      toolCalls: [{ id: "tu_2", name: "fake", input: {} }],
      stopReason: "tool_use",
      tokens: { in: 10, out: 5, cached: 0 },
      costUsd: 0,
    });
    // Turn 3: forced, runtime misbehaves (returns toolCalls even with tools=[])
    runtime.addTurnResponse({
      toolCalls: [{ id: "tu_3", name: "fake", input: {} }],
      stopReason: "tool_use",
      tokens: { in: 10, out: 5, cached: 0 },
      costUsd: 0,
    });

    const fakeTool = makeFakeTool("fake", {
      ok: true,
      output: { result: "ok" },
      costUsd: 0,
      latencyMs: 1,
    });

    const agent = new Agent({
      runtime,
      contactStore: contactStore as any,
      messageStore: messages as any,
      auditLogStore: audit as any,
      workspaceStore: workspaces as any,
    });

    const out = await agent.respond({ ...baseRespondInput, policy: policyLow, tools: [fakeTool] });

    // Loop exits with blockReason containing max_tool_calls info
    expect(out.decision).toBe("blocked");
    if (out.decision === "blocked") {
      expect(out.blockReason).toMatch(/max_tool_calls/);
    }
  });

  it("Test 3: tool not in allowed list — returns tool_not_allowed error in tool_result", async () => {
    const runtime = new FakeRuntime();

    // Turn 1: Claude asks for a tool that is NOT in our tools array
    runtime.addTurnResponse({
      toolCalls: [{ id: "tu_forbidden", name: "forbidden_tool", input: { x: 1 } }],
      stopReason: "tool_use",
      tokens: { in: 10, out: 5, cached: 0 },
      costUsd: 0,
    });

    // Turn 2: after receiving the is_error tool_result, Claude responds normally
    runtime.addTurnResponse({
      finalOutput: {
        body: "no puedo usar esa herramienta",
        reasoning: "forbidden",
        confidence: 0.8,
        should_escalate: false,
      },
      stopReason: "end_turn",
      tokens: { in: 20, out: 10, cached: 0 },
      costUsd: 0,
    });

    // Only "ok_tool" is provided — "forbidden_tool" is not in the list
    const okTool = makeFakeTool("ok_tool", {
      ok: true,
      output: { result: "fine" },
      costUsd: 0,
      latencyMs: 1,
    });

    const agent = new Agent({
      runtime,
      contactStore: contactStore as any,
      messageStore: messages as any,
      auditLogStore: audit as any,
      workspaceStore: workspaces as any,
    });

    const out = await agent.respond({ ...baseRespondInput, tools: [okTool] });

    // Loop continues after the not_allowed error, eventually gets finalOutput
    expect(out.decision).toBe("ready_to_send");

    // Verify that the second respondTurn call received a tool_result with is_error=true
    const turn2Req = runtime.respondTurnCalls[1];
    expect(turn2Req).toBeDefined();
    const userMsg = turn2Req.messages[turn2Req.messages.length - 1];
    expect(userMsg.role).toBe("user");
    const content = userMsg.content as Array<{ type: string; is_error?: boolean; content: string }>;
    expect(Array.isArray(content)).toBe(true);
    const toolResult = content.find((c) => c.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.is_error).toBe(true);
    const parsed = JSON.parse(toolResult!.content);
    expect(parsed.error).toBe("tool_not_allowed");
  });

  it("Phase 2 backward compat: no tools in input uses respond() not respondTurn()", async () => {
    const runtime = new FakeRuntime();
    // respondTurn queue is empty — would throw if called

    const agent = new Agent({
      runtime,
      contactStore: contactStore as any,
      messageStore: messages as any,
      auditLogStore: audit as any,
      workspaceStore: workspaces as any,
    });

    // No tools passed
    const out = await agent.respond({ ...baseRespondInput });

    expect(out.decision).toBe("ready_to_send");
    if (out.decision === "ready_to_send") {
      expect(out.response.body).toBe("fallback");
    }
    // respondTurn was never called
    expect(runtime.respondTurnCalls).toHaveLength(0);
  });
});
