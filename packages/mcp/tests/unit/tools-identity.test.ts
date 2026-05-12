import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import type { Transport } from "../../src/transports/types.js";

function fakeTransport(): Transport {
  return {
    init: vi.fn(),
    whoami: vi.fn().mockResolvedValue({
      handle: "gavrilo_backend_bot",
      display_name: "Gavrilo Backend",
      bot_id: 7,
      chat_id: "-100"
    }),
    listContacts: vi.fn().mockResolvedValue([
      { handle: "marco_frontend_bot", display_name: "Marco Front", is_bot: true }
    ]),
    send: vi.fn(),
    receive: vi.fn(),
    waitForMessages: vi.fn(),
    close: vi.fn()
  };
}

async function callTool(client: Client, name: string, args: object) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text) as { ok: boolean; data?: any; error?: any };
}

async function connect(t: Transport) {
  const server = buildServer({ transport: t });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(c);
  return client;
}

describe("identity tools", () => {
  it("whoami returns the agent's identity", async () => {
    const client = await connect(fakeTransport());
    const r = await callTool(client, "whoami", {});
    expect(r.ok).toBe(true);
    expect(r.data.handle).toBe("gavrilo_backend_bot");
  });

  it("list_contacts returns other group members", async () => {
    const client = await connect(fakeTransport());
    const r = await callTool(client, "list_contacts", {});
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].handle).toBe("marco_frontend_bot");
  });
});
