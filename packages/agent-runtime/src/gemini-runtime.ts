import { buildSystemPrompt, buildUserMessages } from "./prompt-builder.js";
import type { AgentContext, AgentResponse, AgentRuntime, RuntimeConfig } from "./types.js";

const PRICING: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash": { in: 0.075, out: 0.3 },
  "gemini-2.5-pro": { in: 1.25, out: 5 },
  "gemini-2.0-flash": { in: 0.075, out: 0.3 },
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string" },
    reasoning: { type: "string" },
    confidence: { type: "number" },
    should_escalate: { type: "boolean" },
  },
  required: ["body", "reasoning", "confidence", "should_escalate"],
};

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsage;
}

export class GeminiRuntime implements AgentRuntime {
  private apiKey: string | null = null;
  private defaultModel = "gemini-2.5-flash";
  private endpoint = "https://generativelanguage.googleapis.com/v1beta";

  async initialize(config: RuntimeConfig): Promise<void> {
    if (!config.apiKey) throw new Error("GeminiRuntime requires apiKey");
    this.apiKey = config.apiKey;
    if (config.defaultModel) this.defaultModel = config.defaultModel;
  }

  async respond(ctx: AgentContext): Promise<AgentResponse> {
    if (!this.apiKey) throw new Error("GeminiRuntime not initialized");
    const model = ctx.policy.model_id ?? this.defaultModel;

    const system = buildSystemPrompt(ctx);
    const msgs = buildUserMessages(ctx);
    const contents = msgs.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const url = `${this.endpoint}/models/${model}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          maxOutputTokens: ctx.policy.max_tokens_out,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as GeminiResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const tokens = {
      in: data.usageMetadata?.promptTokenCount ?? 0,
      out: data.usageMetadata?.candidatesTokenCount ?? 0,
      cached: data.usageMetadata?.cachedContentTokenCount ?? 0,
    };
    const costUsd = this.computeCost(model, tokens);

    let parsed: { body: string; reasoning: string; confidence: number; should_escalate: boolean };
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        body: "",
        reasoning: `fallback: model returned non-JSON output (${text.slice(0, 80)})`,
        toolsCalled: [],
        tokens,
        costUsd,
        metadata: { confidence: 0, shouldEscalate: true },
      };
    }

    return {
      body: parsed.body,
      reasoning: parsed.reasoning,
      toolsCalled: [],
      tokens,
      costUsd,
      metadata: { confidence: parsed.confidence, shouldEscalate: parsed.should_escalate },
    };
  }

  async estimateCost(ctx: AgentContext): Promise<number> {
    const model = ctx.policy.model_id ?? this.defaultModel;
    const p = PRICING[model] ?? PRICING["gemini-2.5-flash"]!;
    const approxIn = 1000;
    const approxOut = ctx.policy.max_tokens_out;
    return (approxIn / 1_000_000) * p.in + (approxOut / 1_000_000) * p.out;
  }

  async dispose(): Promise<void> {
    this.apiKey = null;
  }

  private computeCost(model: string, t: { in: number; out: number; cached: number }): number {
    const p = PRICING[model] ?? PRICING["gemini-2.5-flash"]!;
    return (t.in / 1_000_000) * p.in + (t.out / 1_000_000) * p.out;
  }
}
