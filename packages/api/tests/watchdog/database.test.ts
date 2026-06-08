// packages/api/tests/watchdog/database.test.ts
import { describe, expect, it, vi } from "vitest";
import { checkDatabase } from "../../src/watchdog/checks/database.js";

describe("checkDatabase", () => {
  it("ok cuando connect + SELECT 1 funcionan", async () => {
    const client = { connect: vi.fn(async () => {}), query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })), end: vi.fn(async () => {}) };
    const r = await checkDatabase({ databaseUrl: "postgres://x", clientFactory: () => client });
    expect(r.status).toBe("ok");
    expect(client.end).toHaveBeenCalled();
  });

  it("down cuando la query falla, y cierra el cliente", async () => {
    const client = { connect: vi.fn(async () => {}), query: vi.fn(async () => { throw new Error("ECONNREFUSED"); }), end: vi.fn(async () => {}) };
    const r = await checkDatabase({ databaseUrl: "postgres://x", clientFactory: () => client });
    expect(r.status).toBe("down");
    expect(client.end).toHaveBeenCalled();
  });
});
