import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeRuntime } from "../src/claude-runtime.js";

const RESPOND_TO_USER_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string" },
    reasoning: { type: "string" },
    confidence: { type: "number" },
    should_escalate: { type: "boolean" },
  },
  required: ["body", "reasoning", "confidence", "should_escalate"],
};

describe("ClaudeRuntime.respondTurn", () => {
  let rt: ClaudeRuntime;
  let createSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    rt = new ClaudeRuntime();
    await rt.initialize({ apiKey: "sk-test", defaultModel: "claude-sonnet-4-6" });
    createSpy = vi.fn();
    (rt as any).client = { messages: { create: createSpy } };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns toolCalls + stop_reason='tool_use' when Claude requests an external tool", async () => {
    createSpy.mockResolvedValueOnce({
      id: "msg_1",
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "search_web", input: { query: "node lts" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-6",
    });

    const res = await rt.respondTurn!({
      systemPrompt: "you are a bot",
      messages: [{ role: "user", content: "what's the current LTS?" }],
      tools: [
        {
          name: "search_web",
          description: "web search",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      respondToUserSchema: RESPOND_TO_USER_SCHEMA,
      model: "claude-sonnet-4-6",
      maxTokens: 1000,
    });

    expect(res.stopReason).toBe("tool_use");
    expect(res.toolCalls).toEqual([
      { id: "tu_1", name: "search_web", input: { query: "node lts" } },
    ]);
    expect(res.finalOutput).toBeUndefined();
    expect(res.tokens.in).toBe(10);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("returns finalOutput when respond_to_user is invoked", async () => {
    createSpy.mockResolvedValueOnce({
      id: "msg_2",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_resp",
          name: "respond_to_user",
          input: {
            body: "Hola.",
            reasoning: "saludo simple",
            confidence: 0.9,
            should_escalate: false,
          },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 8 },
      model: "claude-sonnet-4-6",
    });

    const res = await rt.respondTurn!({
      systemPrompt: "you are a bot",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      respondToUserSchema: RESPOND_TO_USER_SCHEMA,
      model: "claude-sonnet-4-6",
      maxTokens: 1000,
    });

    expect(res.stopReason).toBe("end_turn");
    expect(res.finalOutput).toEqual({
      body: "Hola.",
      reasoning: "saludo simple",
      confidence: 0.9,
      should_escalate: false,
    });
    expect(res.toolCalls).toBeUndefined();
  });

  it("passes tool_result blocks through to Anthropic", async () => {
    createSpy.mockResolvedValueOnce({
      id: "msg_3",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_resp",
          name: "respond_to_user",
          input: { body: "ok", reasoning: "", confidence: 0.8, should_escalate: false },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 5 },
      model: "claude-sonnet-4-6",
    });

    await rt.respondTurn!({
      systemPrompt: "x",
      messages: [
        { role: "user", content: "what?" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "search_web", input: { query: "x" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: '{"results":[]}',
              is_error: false,
            },
          ],
        },
      ],
      tools: [
        {
          name: "search_web",
          description: "web search",
          input_schema: { type: "object", properties: {} },
        },
      ],
      respondToUserSchema: RESPOND_TO_USER_SCHEMA,
      model: "claude-sonnet-4-6",
      maxTokens: 1000,
    });

    expect(createSpy).toHaveBeenCalledOnce();
    const req = createSpy.mock.calls[0][0];
    expect(req.tool_choice).toEqual({ type: "any" });
    expect(req.tools).toHaveLength(2); // search_web + respond_to_user
    expect(req.tools[1].name).toBe("respond_to_user");
    // tool_result message preserved
    const lastUser = req.messages[req.messages.length - 1];
    expect(lastUser.content[0].type).toBe("tool_result");
    expect(lastUser.content[0].tool_use_id).toBe("tu_1");
  });

  it("uses tool_choice=forced when tools list is empty (Phase 2 parity)", async () => {
    createSpy.mockResolvedValueOnce({
      id: "msg_4",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_resp",
          name: "respond_to_user",
          input: { body: "ok", reasoning: "", confidence: 0.8, should_escalate: false },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 3 },
      model: "claude-sonnet-4-6",
    });

    await rt.respondTurn!({
      systemPrompt: "x",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      respondToUserSchema: RESPOND_TO_USER_SCHEMA,
      model: "claude-sonnet-4-6",
      maxTokens: 1000,
    });

    const req = createSpy.mock.calls[0][0];
    expect(req.tool_choice).toEqual({ type: "tool", name: "respond_to_user" });
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0].name).toBe("respond_to_user");
  });
});
