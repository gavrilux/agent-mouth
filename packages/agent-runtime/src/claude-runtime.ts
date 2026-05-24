import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentContext,
  AgentResponse,
  AgentRuntime,
  RuntimeConfig,
  RespondTurnRequest,
  RespondTurnResponse,
} from "./types.js";
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

    const respondTool = {
      name: "respond_to_user",
      description: "Construye la respuesta final al usuario con metadatos.",
      input_schema: {
        type: "object" as const,
        properties: {
          body: { type: "string", description: "Texto de respuesta al usuario." },
          reasoning: { type: "string", description: "Resumen breve de por qué esta respuesta." },
          confidence: { type: "number", description: "Confianza 0-1." },
          should_escalate: { type: "boolean", description: "true si el tema te supera." },
        },
        required: ["body", "reasoning", "confidence", "should_escalate"],
      },
    };

    const res = await this.client.messages.create({
      model,
      max_tokens: ctx.policy.max_tokens_out,
      system,
      messages,
      tools: [respondTool],
      tool_choice: { type: "tool", name: "respond_to_user" },
    });

    const toolUse = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "respond_to_user",
    );

    const tokens = {
      in: res.usage.input_tokens,
      out: res.usage.output_tokens,
      cached: (res.usage as unknown as Record<string, unknown>).cache_read_input_tokens as number ?? 0,
    };
    const costUsd = this.computeCost(model, tokens);

    if (!toolUse) {
      return {
        body: "",
        reasoning: "fallback: model did not invoke respond_to_user tool",
        toolsCalled: [],
        tokens,
        costUsd,
        metadata: { confidence: 0, shouldEscalate: true },
      };
    }

    const input = toolUse.input as {
      body: string;
      reasoning: string;
      confidence: number;
      should_escalate: boolean;
    };

    return {
      body: input.body,
      reasoning: input.reasoning,
      toolsCalled: [],
      tokens,
      costUsd,
      metadata: { confidence: input.confidence, shouldEscalate: input.should_escalate },
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

  async respondTurn(req: RespondTurnRequest): Promise<RespondTurnResponse> {
    if (!this.client) throw new Error("ClaudeRuntime not initialized");

    const respondTool = {
      name: "respond_to_user",
      description:
        "Construye la respuesta final al usuario con metadatos. Llama esta tool cuando ya tengas la respuesta lista; no llames más herramientas externas.",
      input_schema: req.respondToUserSchema as Anthropic.Tool["input_schema"],
    };

    const tools: Anthropic.Tool[] = [
      ...req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool["input_schema"],
      })),
      respondTool,
    ];

    const tool_choice: Anthropic.ToolChoice =
      req.tools.length === 0
        ? { type: "tool" as const, name: "respond_to_user" }
        : { type: "any" as const };

    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.systemPrompt,
      messages: req.messages as Anthropic.MessageParam[],
      tools,
      tool_choice,
    });

    const tokens = {
      in: res.usage.input_tokens,
      out: res.usage.output_tokens,
      cached: (res.usage as unknown as Record<string, unknown>).cache_read_input_tokens as number ?? 0,
    };
    const costUsd = this.computeCost(req.model, tokens);

    const respondCall = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "respond_to_user",
    );

    if (respondCall) {
      const input = respondCall.input as {
        body: string;
        reasoning: string;
        confidence: number;
        should_escalate: boolean;
      };
      return {
        finalOutput: input,
        stopReason: "end_turn",
        tokens,
        costUsd,
      };
    }

    const otherCalls = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    return {
      toolCalls: otherCalls.map((c) => ({
        id: c.id,
        name: c.name,
        input: c.input as Record<string, unknown>,
      })),
      stopReason: "tool_use",
      tokens,
      costUsd,
    };
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
