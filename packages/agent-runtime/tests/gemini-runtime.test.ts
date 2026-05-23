import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiRuntime } from "../src/gemini-runtime.js";
import type { AgentContext } from "../src/types.js";

const baseCtx: AgentContext = {
  workspaceId: "w1",
  contact: {
    id: "c1",
    workspace_id: "w1",
    display_name: "Gavrilo",
    notes: "",
    created_at: "",
  } as never,
  channelType: "telegram",
  incomingMessage: {
    id: "m1",
    direction: "inbound",
    content: "hola",
    sent_by: "human",
    created_at: "",
  },
  threadHistory: [],
  policy: {
    id: "p1",
    policy: "auto",
    system_prompt: "Sé conciso.",
    model_id: null,
    max_tokens_out: 500,
    max_tool_calls: 0,
    rate_limit_per_hour: 10,
    forbidden_topics_regex: [],
    escalate_triggers_regex: [],
    rules: {},
    priority: 0,
    workspace_id: "w1",
    contact_id: "c1",
    channel_type: "telegram",
  } as never,
  availableTools: [],
  budget: { remainingUsd: 1 },
};

function mockFetchOnce(body: object, ok = true, status = 200): void {
  const json = JSON.stringify(body);
  const res = {
    ok,
    status,
    json: () => Promise.resolve(JSON.parse(json)),
    text: () => Promise.resolve(json),
  } as unknown as Response;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeminiRuntime", () => {
  it("parses structured JSON response, computes cost", async () => {
    mockFetchOnce({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  body: "hola, ¿cómo va?",
                  reasoning: "saludo casual",
                  confidence: 0.9,
                  should_escalate: false,
                }),
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30 },
    });

    const rt = new GeminiRuntime();
    await rt.initialize({ apiKey: "fake-key", defaultModel: "gemini-2.5-flash" });
    const r = await rt.respond(baseCtx);

    expect(r.body).toBe("hola, ¿cómo va?");
    expect(r.reasoning).toBe("saludo casual");
    expect(r.metadata.confidence).toBe(0.9);
    expect(r.metadata.shouldEscalate).toBe(false);
    expect(r.tokens.in).toBe(100);
    expect(r.tokens.out).toBe(30);
    expect(r.costUsd).toBeCloseTo((100 / 1_000_000) * 0.075 + (30 / 1_000_000) * 0.3, 8);
  });

  it("falls back to escalate when response is non-JSON", async () => {
    mockFetchOnce({
      candidates: [{ content: { parts: [{ text: "este no es JSON válido" }] } }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 },
    });

    const rt = new GeminiRuntime();
    await rt.initialize({ apiKey: "fake-key" });
    const r = await rt.respond(baseCtx);

    expect(r.body).toBe("");
    expect(r.metadata.shouldEscalate).toBe(true);
    expect(r.metadata.confidence).toBe(0);
  });

  it("throws on non-2xx response", async () => {
    mockFetchOnce({ error: "rate limited" }, false, 429);
    const rt = new GeminiRuntime();
    await rt.initialize({ apiKey: "fake-key" });
    await expect(rt.respond(baseCtx)).rejects.toThrow(/429/);
  });

  it("requires apiKey on initialize", async () => {
    const rt = new GeminiRuntime();
    await expect(rt.initialize({})).rejects.toThrow(/requires apiKey/);
  });

  it("respects ctx.policy.model_id override", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementationOnce((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          body: "x",
                          reasoning: "y",
                          confidence: 1,
                          should_escalate: false,
                        }),
                      },
                    ],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }),
          text: () => Promise.resolve(""),
        } as unknown as Response);
      }),
    );

    const rt = new GeminiRuntime();
    await rt.initialize({ apiKey: "fake-key", defaultModel: "gemini-2.5-flash" });
    await rt.respond({
      ...baseCtx,
      policy: { ...baseCtx.policy, model_id: "gemini-2.5-pro" } as never,
    });
    expect(capturedUrl).toContain("/models/gemini-2.5-pro:generateContent");
  });
});
