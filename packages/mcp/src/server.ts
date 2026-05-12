import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "./transports/types.js";
import { logger } from "./logger.js";
import "./tools/_register.js";

export interface ServerOptions {
  transport: Transport;
  configPath?: string;
}

export interface ToolContext {
  transport: Transport;
  configPath?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

const tools: ToolDef[] = [];

export function registerTool(tool: ToolDef): void {
  if (tools.find((t) => t.name === tool.name)) return; // idempotent
  tools.push(tool);
}

// Stub registration so the listTools test passes in Task 6.
// This is replaced by the real whoami tool in Task 7.
registerTool({
  name: "whoami",
  description: "stub — replaced in T7",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_input, ctx) => ctx.transport.whoami()
});

export function buildServer(opts: ServerOptions): Server {
  const server = new Server(
    { name: "agent-mouth", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    try {
      const result = await tool.handler(request.params.arguments ?? {}, {
        transport: opts.transport,
        configPath: opts.configPath
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, data: result }) }]
      };
    } catch (err) {
      const e = err as Error & { hint?: string };
      logger.error({ err: e, tool: request.params.name }, "tool failed");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: { code: e.name, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }
            })
          }
        ],
        isError: true
      };
    }
  });

  return server;
}
