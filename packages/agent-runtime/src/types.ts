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

export interface RuntimeToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface RuntimeToolResult {
  tool_use_id: string;
  output: unknown;
  isError?: boolean;
}

export type RuntimeStopReason = "end_turn" | "tool_use" | "max_tokens";

export interface AgentContext {
  workspaceId: string;
  contact: Contact;
  channelType: ChannelType;
  incomingMessage: ContextMessage;
  threadHistory: ContextMessage[];
  policy: Policy;
  availableTools: ToolDefinition[];
  budget: { remainingUsd: number };
  // Tool results from previous turn's tool calls. When set, these are injected as
  // a tool_result user message before the new turn.
  toolResults?: RuntimeToolResult[];
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
  // When stop_reason="tool_use" and external tools were requested by Claude,
  // these are the tool calls the controller must execute. body/reasoning are
  // empty strings in this case.
  toolCalls?: RuntimeToolCall[];
  stopReason?: RuntimeStopReason;
}

export interface RuntimeConfig {
  apiKey?: string;
  defaultModel?: string;
}

export type RespondTurnMessage =
  | { role: "user"; content: string }
  | { role: "user"; content: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> }
  | { role: "assistant"; content: string }
  | { role: "assistant"; content: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> };

export interface RespondTurnRequest {
  systemPrompt: string;
  // Message history including assistant tool_use blocks and user tool_result blocks
  messages: Array<RespondTurnMessage>;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  // The forced respond_to_user JSON output schema — runtime appends this tool and uses tool_choice:"any"
  respondToUserSchema: Record<string, unknown>;
  model: string;
  maxTokens: number;
}

export interface RespondTurnResponse {
  // When the model chose respond_to_user
  finalOutput?: { body: string; reasoning: string; confidence: number; should_escalate: boolean };
  // When the model chose external tools
  toolCalls?: RuntimeToolCall[];
  stopReason: RuntimeStopReason;
  tokens: { in: number; out: number; cached: number };
  costUsd: number;
}

export interface AgentRuntime {
  initialize(config: RuntimeConfig): Promise<void>;
  respond(context: AgentContext): Promise<AgentResponse>;
  estimateCost(context: AgentContext): Promise<number>;
  dispose(): Promise<void>;
  respondTurn?(req: RespondTurnRequest): Promise<RespondTurnResponse>;
}
