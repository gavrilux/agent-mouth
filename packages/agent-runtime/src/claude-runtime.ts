import Anthropic from "@anthropic-ai/sdk";
import type { AgentContext, AgentResponse, AgentRuntime, RuntimeConfig } from "./types.js";
import { buildSystemPrompt, buildUserMessages } from "./prompt-builder.js";

const PRICING: Record<string, { in: number; out: number; cached_read: number }> = {
  "claude-sonnet-4-6": { in: 3, out: 15, cached_read: 0.3 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cached_read: 0.1 },
  "claude-opus-4-7": { in: 15, out: 75, cached_read: 1.5 },
};

export class ClaudeRuntime implements AgentRuntime {
  private client: Anthropic | null = null;
  private defaultModel = "claude-sonnet-4-6";

  async initialize(config: RuntimeConfig): Promise<void> {
    this.client = new Anthropic({ apiKey: config.apiKey });
    if (config.defaultModel) this.defaultModel = config.defaultModel;
  }

  async respond(ctx: AgentContext): Promise<AgentResponse> {
    if (!this.client) throw new Error("ClaudeRuntime not initialized");
    const model = ctx.policy.model_id ?? this.defaultModel;
    const system = buildSystemPrompt(ctx);
    const messages = buildUserMessages(ctx);

    const res = await this.client.messages.create({
      model,
      max_tokens: ctx.policy.max_tokens_out,
      system,
      messages,
    });

    const body = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const tokens = {
      in: res.usage.input_tokens,
      out: res.usage.output_tokens,
      // cache_read_input_tokens added in later SDK versions; cast for forward-compat
      cached: ((res.usage as unknown) as Record<string, unknown>)["cache_read_input_tokens"] as number ?? 0,
    };
    const costUsd = this.computeCost(model, tokens);

    return {
      body,
      reasoning: "(basic mode, no structured reasoning)",
      toolsCalled: [],
      tokens,
      costUsd,
      metadata: { confidence: 1, shouldEscalate: false },
    };
  }

  async estimateCost(ctx: AgentContext): Promise<number> {
    const model = ctx.policy.model_id ?? this.defaultModel;
    const p = PRICING[model] ?? PRICING["claude-sonnet-4-6"]!;
    const approxIn = 1000;
    const approxOut = ctx.policy.max_tokens_out;
    return (approxIn / 1_000_000) * p.in + (approxOut / 1_000_000) * p.out;
  }

  async dispose(): Promise<void> {
    this.client = null;
  }

  private computeCost(model: string, t: { in: number; out: number; cached: number }): number {
    const p = PRICING[model] ?? PRICING["claude-sonnet-4-6"]!;
    return (
      (t.in / 1_000_000) * p.in +
      (t.out / 1_000_000) * p.out +
      (t.cached / 1_000_000) * p.cached_read
    );
  }
}
