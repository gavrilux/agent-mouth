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
      bot_id: 1,
      chat_id: "-100"
    }),
    listContacts: vi.fn().mockResolvedValue([]),
    send: vi.fn(),
    receive: vi.fn(),
    waitForMessages: vi.fn(),
    close: vi.fn()
  };
}

describe("server", () => {
  it("lists registered tools including whoami", async () => {
    const server = buildServer({ transport: fakeTransport() });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(clientT);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("whoami");
  });
});
