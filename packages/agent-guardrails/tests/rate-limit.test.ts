import { describe, it, expect } from "vitest";
import { checkRateLimit } from "../src/rate-limit.js";

const auditStub = (count: number) => ({
  sumCostUsdSince: async () => 0,
  countSentOrDraftSince: async () => count,
  findRespondedFor: async () => null,
  write: async () => ({} as any),
});

describe("checkRateLimit", () => {
  it("ok when under limit", async () => {
    const r = await checkRateLimit({ contactId: "c1", limit: 10 }, auditStub(5));
    expect(r.ok).toBe(true);
  });

  it("blocked when at limit", async () => {
    const r = await checkRateLimit({ contactId: "c1", limit: 10 }, auditStub(10));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("rate_limit");
  });
});
