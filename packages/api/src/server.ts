import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { OffsetStore, Transport } from "@agent-mouth/core";
import { logger } from "./logger.js";
import { tools } from "./registry.js";
import "./tools/_register.js";

export type { ToolContext, ToolDef } from "./registry.js";
export { registerTool } from "./registry.js";

export interface ServerOptions {
  transport: Transport;
  configPath?: string;
  offsetStore?: OffsetStore;
  handle?: string;
}

export function buildServer(opts: ServerOptions): Server {
  const server = new Server(
    { name: "agent-mouth", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    try {
      const result = await tool.handler(request.params.arguments ?? {}, {
        transport: opts.transport,
        configPath: opts.configPath,
        offsetStore: opts.offsetStore,
        handle: opts.handle,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, data: result }) }],
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
              error: { code: e.name, message: e.message, ...(e.hint ? { hint: e.hint } : {}) },
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
