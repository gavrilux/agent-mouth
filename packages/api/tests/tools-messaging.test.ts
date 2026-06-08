import type { Transport } from "@agent-mouth/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server";
import { readInboxTool, waitForMessagesTool } from "../src/tools/messaging.js";

function fakeTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    init: vi.fn(),
    whoami: vi.fn().mockResolvedValue({ handle: "me", display_name: "Me", chat_id: "-100" }),
    listContacts: vi.fn().mockResolvedValue([]),
    send: vi.fn().mockResolvedValue({ message_id: "42", timestamp: new Date() }),
    receive: vi.fn().mockResolvedValue([]),
    waitForMessages: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    ...overrides,
  };
}

async function callTool(client: Client, name: string, args: object) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text) as { ok: boolean; data?: unknown; error?: unknown };
}

async function connect(t: Transport) {
  const server = buildServer({ transport: t });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(c);
  return client;
}

describe("messaging tools", () => {
  it("send_message passes 'to' and 'body' to transport.send", async () => {
    const t = fakeTransport();
    const client = await connect(t);
    const r = await callTool(client, "send_message", {
      to: "marco_frontend_bot",
      body: "hola",
    });
    expect(r.ok).toBe(true);
    expect(t.send).toHaveBeenCalledWith({
      to: "marco_frontend_bot",
      body: "hola",
      reply_to_message_id: undefined,
    });
  });

  it("send_message rejects empty body", async () => {
    const client = await connect(fakeTransport());
    const r = await callTool(client, "send_message", { to: "x", body: "" });
    expect(r.ok).toBe(false);
  });

  it("read_inbox calls transport.receive with the given filter", async () => {
    const t = fakeTransport({
      receive: vi
        .fn()
        .mockResolvedValue([
          { id: "1:1", from_handle: "marco", body: "hi", timestamp: new Date(), is_mention: true },
        ]),
    });
    const client = await connect(t);
    const r = await callTool(client, "read_inbox", { filter: "mentions", limit: 50 });
    expect(r.ok).toBe(true);
    expect(t.receive).toHaveBeenCalledWith({
      filter: "mentions",
      limit: 50,
      since_message_id: undefined,
    });
    expect(r.data as unknown[]).toHaveLength(1);
  });

  it("wait_for_messages forwards timeout and filter", async () => {
    const t = fakeTransport({
      waitForMessages: vi.fn().mockResolvedValue([]),
    });
    const client = await connect(t);
    await callTool(client, "wait_for_messages", { timeout_seconds: 10, filter: "mentions" });
    expect(t.waitForMessages).toHaveBeenCalledWith({ timeout_seconds: 10, filter: "mentions" });
  });

  it("get_thread returns the reply chain for a message", async () => {
    const t = fakeTransport({
      receive: vi.fn().mockResolvedValue([
        {
          id: "1:1",
          from_handle: "marco",
          body: "first",
          timestamp: new Date(),
          is_mention: false,
        },
        {
          id: "2:2",
          from_handle: "me",
          body: "reply",
          timestamp: new Date(),
          reply_to_message_id: "1",
          is_mention: false,
        },
      ]),
    });
    const client = await connect(t);
    const r = await callTool(client, "get_thread", { reply_to_message_id: "1", limit: 50 });
    expect(r.ok).toBe(true);
    expect(r.data as unknown[]).toHaveLength(2);
  });

  it("mark_read updates last_seen_update_id in config file", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveConfig, loadConfig } = await import("../src/config");

    const tmp = mkdtempSync(join(tmpdir(), "am-"));
    const configPath = join(tmp, "config.json");
    await saveConfig(configPath, {
      transport: "telegram",
      telegram: { bot_token: "x", chat_id: "-100", handle: "me" },
      last_seen_update_id: 0,
    });

    const server = buildServer({ transport: fakeTransport(), configPath });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(c);

    await callTool(client, "mark_read", { up_to_message_id: "100:50" });

    const loaded = await loadConfig(configPath);
    expect(loaded?.last_seen_update_id).toBe(100);

    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("read_inbox with MessageStore present", () => {
  it("reads from messageStore.listRecent instead of transport.receive", async () => {
    const messageStore = {
      insert: vi.fn(),
      listRecent: vi.fn().mockResolvedValue([
        {
          id: "cccccccc-cccc-cccc-cccc-cccccccccc01",
          thread_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01",
          channel_id: "22222222-2222-2222-2222-222222222222",
          channel_identity_id: null,
          direction: "inbound",
          content: "hola",
          attachments: [],
          raw_payload: null,
          external_message_id: "42",
          sent_by: null,
          created_at: "2026-05-20T00:00:00Z",
        },
      ]),
      waitForNew: vi.fn(),
    };
    const transport = { receive: vi.fn() };
    const out = await readInboxTool.handler(
      { limit: 10 },
      {
        transport: transport as never,
        messageStore: messageStore as never,
        workspaceId: "ws",
      },
    );
    expect(messageStore.listRecent).toHaveBeenCalledWith({
      workspaceId: "ws",
      limit: 10,
      sinceId: undefined,
    });
    expect(transport.receive).not.toHaveBeenCalled();
    expect(Array.isArray(out)).toBe(true);
    expect((out as unknown[])[0]).toMatchObject({ content: "hola" });
  });
});

describe("wait_for_messages with MessageStore present", () => {
  it("uses messageStore.waitForNew", async () => {
    const messageStore = {
      insert: vi.fn(),
      listRecent: vi.fn(),
      waitForNew: vi.fn().mockResolvedValue([
        {
          id: "cccccccc-cccc-cccc-cccc-cccccccccc02",
          thread_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01",
          channel_id: "22222222-2222-2222-2222-222222222222",
          channel_identity_id: null,
          direction: "inbound",
          content: "yo",
          attachments: [],
          raw_payload: null,
          external_message_id: "43",
          sent_by: null,
          created_at: "2026-05-20T00:00:01Z",
        },
      ]),
    };
    const out = await waitForMessagesTool.handler(
      { timeout_seconds: 5 },
      {
        transport: { waitForMessages: vi.fn() } as never,
        messageStore: messageStore as never,
        workspaceId: "ws",
      },
    );
    expect(messageStore.waitForNew).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws",
        timeoutSeconds: 5,
      }),
    );
    expect((out as unknown[]).length).toBe(1);
  });
});
