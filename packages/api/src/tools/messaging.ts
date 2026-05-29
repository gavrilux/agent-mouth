import { z } from "zod";
import { loadConfig, saveConfig } from "../config.js";
import type { ToolDef } from "../server.js";

const FilterEnum = z.enum(["mentions", "replies", "all"]);

export const sendMessageTool: ToolDef = {
  name: "send_message",
  description:
    "Send a message. For Telegram: `to` is a numeric chat id or handle. For Email: `to` is an email address; `subject` should be provided for new threads. For WhatsApp: `to` is the recipient `wa_id` (digits, no '+'); `subject` is ignored. If `channel` is omitted, the tool infers it from `reply_to_message_id`'s thread, falling back to the default transport.",
  inputSchema: {
    type: "object",
    required: ["body"],
    properties: {
      to: { type: "string" },
      channel: { type: "string", enum: ["telegram", "email", "whatsapp"] },
      body: { type: "string", minLength: 1 },
      reply_to_message_id: { type: "string" },
      subject: { type: "string" },
    },
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const parsed = z
      .object({
        to: z.string().optional(),
        channel: z.enum(["telegram", "email", "whatsapp"]).optional(),
        body: z.string().min(1),
        reply_to_message_id: z.string().optional(),
        subject: z.string().optional(),
      })
      .parse(input);

    // Resolve channel
    let channel = parsed.channel;
    if (!channel && parsed.reply_to_message_id && ctx.threadStore && ctx.channelStore) {
      try {
        const thread = await ctx.threadStore.findById(parsed.reply_to_message_id);
        if (thread) {
          const ch = await ctx.channelStore.findById(thread.channel_id);
          if (ch && (ch.type === "telegram" || ch.type === "email" || ch.type === "whatsapp")) {
            channel = ch.type;
          }
        }
      } catch {
        // ignore lookup failures, fall back to default
      }
    }

    // Pick transport
    const transport = (channel && ctx.transportRegistry)
      ? ctx.transportRegistry.get(channel)
      : ctx.transport;

    return transport.send({
      to: parsed.to,
      body: parsed.body,
      reply_to_message_id: parsed.reply_to_message_id,
      subject: parsed.subject,
    });
  },
};

export const readInboxTool: ToolDef = {
  name: "read_inbox",
  description:
    "Returns recent messages. With persistence: cross-channel from MessageStore. Without: long-polled from the active transport.",
  inputSchema: {
    type: "object",
    properties: {
      filter: { type: "string", enum: ["mentions", "replies", "all"] },
      since_message_id: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  handler: async (input, { transport, messageStore, workspaceId }) => {
    const parsed = z
      .object({
        filter: FilterEnum.optional().default("mentions"),
        since_message_id: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      })
      .parse(input);
    if (messageStore && workspaceId) {
      return messageStore.listRecent({
        workspaceId,
        sinceId: parsed.since_message_id,
        limit: parsed.limit,
      });
    }
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
  handler: async (input, { transport, messageStore, workspaceId }) => {
    const parsed = z
      .object({
        timeout_seconds: z.number().int().min(1).max(300).optional().default(30),
        filter: FilterEnum.optional().default("mentions"),
      })
      .parse(input);
    if (messageStore && workspaceId) {
      return messageStore.waitForNew({
        workspaceId,
        sinceCreatedAt: new Date().toISOString(),
        timeoutSeconds: parsed.timeout_seconds,
      });
    }
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
  handler: async (input, { configPath, offsetStore, handle }) => {
    const parsed = z.object({ up_to_message_id: z.string() }).parse(input);
    const updateId = Number(parsed.up_to_message_id.split(":")[0] ?? "0");

    if (offsetStore && handle) {
      const current = await offsetStore.getOffset(handle);
      const next = Math.max(current, updateId);
      await offsetStore.saveOffset(handle, next);
      return { ok: true, last_seen_update_id: next };
    }

    if (configPath) {
      const config = await loadConfig(configPath);
      if (!config) throw new Error("Config not found");
      config.last_seen_update_id = Math.max(config.last_seen_update_id, updateId);
      await saveConfig(configPath, config);
      return { ok: true, last_seen_update_id: config.last_seen_update_id };
    }

    throw new Error("mark_read requires either offsetStore+handle or configPath");
  },
};
