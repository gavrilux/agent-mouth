import type { Policy } from "./identity.js";

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolContext {
  workspaceId: string;
  contactId: string;
  threadId: string;
  policy: Policy;
  logger: {
    info: (data: unknown, msg?: string) => void;
    warn: (data: unknown, msg?: string) => void;
    error: (data: unknown, msg?: string) => void;
  };
  abortSignal?: AbortSignal;
}

export interface ToolExecutionResult<T = unknown> {
  ok: boolean;
  output?: T;
  error?: string;
  costUsd: number;
  latencyMs: number;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly requiresExplicitGrant?: boolean;
  execute(
    input: TInput,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult<TOutput>>;
}
