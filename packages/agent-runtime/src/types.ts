import type { Contact, Policy } from "@agent-mouth/core";

export type ChannelType = "telegram" | "email" | "whatsapp" | "discord" | "slack";

export interface ContextMessage {
  id: string;
  direction: "inbound" | "outbound";
  content: string;
  sent_by: "human" | "agent" | null;
  created_at: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

export interface AgentContext {
  workspaceId: string;
  contact: Contact;
  channelType: ChannelType;
  incomingMessage: ContextMessage;
  threadHistory: ContextMessage[];
  policy: Policy;
  availableTools: ToolDefinition[];
  budget: { remainingUsd: number };
}

export interface AgentResponse {
  body: string;
  reasoning: string;
  toolsCalled: ToolCall[];
  tokens: { in: number; out: number; cached: number };
  costUsd: number;
  metadata: {
    confidence: number;
    shouldEscalate: boolean;
  };
}

export interface RuntimeConfig {
  apiKey?: string;
  defaultModel?: string;
}

export interface AgentRuntime {
  initialize(config: RuntimeConfig): Promise<void>;
  respond(context: AgentContext): Promise<AgentResponse>;
  estimateCost(context: AgentContext): Promise<number>;
  dispose(): Promise<void>;
}
