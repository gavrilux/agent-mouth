import { describe, expect, it } from "vitest";
import { checkBudget } from "../src/budget.js";

const auditStub = (spent: number) => ({
  sumCostUsdSince: async () => spent,
  countSentOrDraftSince: async () => 0,
  findRespondedFor: async () => null,
  write: async () => ({}) as any,
});

const wsStub = (cap: number) => ({
  getDefault: async () =>
    ({ id: "w1", daily_budget_usd_cap: cap, name: "T", plan: "self-host", created_at: "" }) as any,
});

describe("checkBudget", () => {
  it("ok when under cap", async () => {
    const r = await checkBudget({ workspaceId: "w1" }, auditStub(1.0), wsStub(5.0) as any);
    expect(r.ok).toBe(true);
  });

  it("blocked when over cap", async () => {
    const r = await checkBudget({ workspaceId: "w1" }, auditStub(4.999), wsStub(5.0) as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("budget_cap_reached");
  });
});
