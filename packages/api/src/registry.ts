import type { OffsetStore, Transport } from "@agent-mouth/core";

export interface ToolContext {
  transport: Transport;
  configPath?: string;
  offsetStore?: OffsetStore;
  handle?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

export const tools: ToolDef[] = [];

export function registerTool(tool: ToolDef): void {
  if (tools.find((t) => t.name === tool.name)) return; // idempotent
  tools.push(tool);
}
