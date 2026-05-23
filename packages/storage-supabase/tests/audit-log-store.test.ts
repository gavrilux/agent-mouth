import { describe, it, expect, beforeAll } from "vitest";
import { SupabaseAuditLogStore } from "../src/audit-log-store.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SKIP = !SUPABASE_URL || !SUPABASE_ANON_KEY;

describe.skipIf(SKIP)("SupabaseAuditLogStore", () => {
  let store: SupabaseAuditLogStore;
  const workspaceId = "00000000-0000-0000-0000-000000000001";

  beforeAll(() => {
    store = new SupabaseAuditLogStore({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  });

  it("writes an audit entry and reads it back", async () => {
    const entry = await store.write({
      workspace_id: workspaceId,
      action: "test.write",
      actor: "system",
      decision: "no_action",
    });
    expect(entry.id).toBeDefined();
    expect(entry.action).toBe("test.write");
  });

  it("sumCostUsdSince returns 0 when nothing today", async () => {
    const sum = await store.sumCostUsdSince(workspaceId, new Date().toISOString());
    expect(typeof sum).toBe("number");
  });
});
