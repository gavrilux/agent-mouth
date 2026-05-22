import type { AgentRuntime, AgentContext, AgentResponse, RuntimeConfig } from "./types.js";

export interface MockRuntimeConfig extends RuntimeConfig {
  body?: string;
  costUsd?: number;
  shouldEscalate?: boolean;
  confidence?: number;
  delayMs?: number;
  tokens?: { in: number; out: number; cached: number };
}

export class MockRuntime implements AgentRuntime {
  private config: MockRuntimeConfig = {};

  async initialize(config: MockRuntimeConfig): Promise<void> {
    this.config = config;
  }

  async respond(_ctx: AgentContext): Promise<AgentResponse> {
    if (this.config.delayMs) await new Promise((r) => setTimeout(r, this.config.delayMs));
    return {
      body: this.config.body ?? "mock response",
      reasoning: "mock reasoning",
      toolsCalled: [],
      tokens: this.config.tokens ?? { in: 0, out: 0, cached: 0 },
      costUsd: this.config.costUsd ?? 0,
      metadata: {
        confidence: this.config.confidence ?? 0.9,
        shouldEscalate: this.config.shouldEscalate ?? false,
      },
    };
  }

  async estimateCost(_ctx: AgentContext): Promise<number> {
    return this.config.costUsd ?? 0;
  }

  async dispose(): Promise<void> {}
}
