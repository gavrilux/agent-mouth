import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { MessageStore, OffsetStore, Transport } from "@agent-mouth/core";
import { logger } from "./logger.js";
import { type ToolChannelRef, type ToolThreadRef, tools } from "./registry.js";
import "./tools/_register.js";
import type { ChannelType, Contact } from "@agent-mouth/core";

export type { ToolContext, ToolDef } from "./registry.js";
export { registerTool } from "./registry.js";

export interface ServerOptions {
  transport: Transport;
  configPath?: string;
  offsetStore?: OffsetStore;
  handle?: string;
  messageStore?: MessageStore;
  workspaceId?: string;
  // Phase 1b — optional multi-transport + identity helpers
  transportRegistry?: { get(type: ChannelType): Transport };
  threadStore?: { findById(id: string): Promise<ToolThreadRef | null> };
  channelStore?: { findById(id: string): Promise<ToolChannelRef | null> };
  contactStore?: {
    addEmailToMetadata(workspaceId: string, contactId: string, email: string): Promise<Contact>;
  };
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
        messageStore: opts.messageStore,
        workspaceId: opts.workspaceId,
        transportRegistry: opts.transportRegistry,
        threadStore: opts.threadStore,
        channelStore: opts.channelStore,
        contactStore: opts.contactStore,
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
