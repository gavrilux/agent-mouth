import { z } from "zod";
import { loadConfig, saveConfig } from "../config.js";
import type { ToolDef } from "../server.js";

const FilterEnum = z.enum(["mentions", "replies", "all"]);

export const sendMessageTool: ToolDef = {
  name: "send_message",
  description:
    "Send a message to the group. If `to` is a handle, the message is prefixed with @<handle> so the receiving bot picks it up. If `to` is omitted or 'broadcast', sends without mention.",
  inputSchema: {
    type: "object",
    required: ["body"],
    properties: {
      to: { type: "string" },
      body: { type: "string", minLength: 1 },
      reply_to_message_id: { type: "string" },
    },
    additionalProperties: false,
  },
  handler: async (input, { transport }) => {
    const parsed = z
      .object({
        to: z.string().optional(),
        body: z.string().min(1),
        reply_to_message_id: z.string().optional(),
      })
      .parse(input);
    return transport.send(parsed);
  },
};

export const readInboxTool: ToolDef = {
  name: "read_inbox",
  description:
    "Returns recent messages from the group. Use filter='mentions' for messages addressed to you, 'replies' for replies to your messages, 'all' for everything (default 'mentions').",
  inputSchema: {
    type: "object",
    properties: {
      filter: { type: "string", enum: ["mentions", "replies", "all"] },
      since_message_id: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  handler: async (input, { transport }) => {
    const parsed = z
      .object({
        filter: FilterEnum.optional().default("mentions"),
        since_message_id: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      })
      .parse(input);
    return transport.receive(parsed);
  },
};

export const waitForMessagesTool: ToolDef = {
  name: "wait_for_messages",
  description:
    "Blocks for up to timeout_seconds (default 30) waiting for new messages. Returns when a message arrives or on timeout.",
  inputSchema: {
    type: "object",
    properties: {
      timeout_seconds: { type: "integer", minimum: 1, maximum: 300 },
      filter: { type: "string", enum: ["mentions", "replies", "all"] },
    },
    additionalProperties: false,
  },
  handler: async (input, { transport }) => {
    const parsed = z
      .object({
        timeout_seconds: z.number().int().min(1).max(300).optional().default(30),
        filter: FilterEnum.optional().default("mentions"),
      })
      .parse(input);
    return transport.waitForMessages(parsed);
  },
};

export const getThreadTool: ToolDef = {
  name: "get_thread",
  description: "Returns the reply chain for a given message_id. Uses Telegram's reply structure.",
  inputSchema: {
    type: "object",
    required: ["reply_to_message_id"],
    properties: {
      reply_to_message_id: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  handler: async (input, { transport }) => {
    const parsed = z
      .object({
        reply_to_message_id: z.string(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      })
      .parse(input);
    // For now, fetch recent and filter by reply chain. Telegram doesn't have a "thread fetch" endpoint.
    const all = await transport.receive({ filter: "all", limit: parsed.limit });
    return all.filter(
      (m) =>
        m.id.endsWith(`:${parsed.reply_to_message_id}`) ||
        m.reply_to_message_id === parsed.reply_to_message_id,
    );
  },
};

export const markReadTool: ToolDef = {
  name: "mark_read",
  description:
    "Marks messages up to a given message_id as read. Persists last_seen_update_id locally.",
  inputSchema: {
    type: "object",
    required: ["up_to_message_id"],
    properties: { up_to_message_id: { type: "string" } },
    additionalProperties: false,
  },
  handler: async (input, { configPath }) => {
    const parsed = z.object({ up_to_message_id: z.string() }).parse(input);
    if (!configPath) {
      throw new Error("mark_read requires a config file path in server options");
    }
    const config = await loadConfig(configPath);
    if (!config) throw new Error("Config not found");

    // Message id is "<update_id>:<msg_id>" — extract update_id
    const updateId = Number(parsed.up_to_message_id.split(":")[0] ?? "0");
    config.last_seen_update_id = Math.max(config.last_seen_update_id, updateId);
    await saveConfig(configPath, config);
    return { ok: true, last_seen_update_id: config.last_seen_update_id };
  },
};
