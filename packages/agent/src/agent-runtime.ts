// AgentRuntime interface only. Implementations land in Phase 2.
// See: docs/superpowers/specs/2026-05-20-agent-mouth-vision-design.md §5.7

import type { Message, ChannelType } from "@agent-mouth/core";

export interface RuntimeConfig {
  provider: "claude" | "openai" | "gemini" | "ollama" | "mock";
  api_key?: string;
  model?: string;
  base_url?: string;
}

export interface BudgetState {
  daily_tokens_remaining: number;
  daily_usd_cap_remaining: number;
}

export interface ToolCall {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface AgentContext {
  workspace_id: string;
  // contact and policy types come in Phase 1; using `unknown` here keeps Phase 0 minimal
  contact: unknown;
  channel_type: ChannelType;
  incoming_message: Message;
  thread_history: Message[];
  policy: unknown;
  available_tools: unknown[];
  budget: BudgetState;
}

export interface AgentResponse {
  body: string;
  reasoning: string;
  tools_called: ToolCall[];
  tokens_used: { in: number; out: number; cached: number };
  cost_estimate_usd: number;
  metadata: {
    confidence: number;
    should_escalate: boolean;
  };
}

export interface AgentRuntime {
  initialize(config: RuntimeConfig): Promise<void>;
  respond(context: AgentContext): Promise<AgentResponse>;
  estimateCost(context: AgentContext): Promise<number>;
  dispose(): Promise<void>;
}
