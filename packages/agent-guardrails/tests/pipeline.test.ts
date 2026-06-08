import { describe, expect, it } from "vitest";
import { runPreLLMGuardrails } from "../src/pipeline.js";

const auditOk = {
  sumCostUsdSince: async () => 0,
  countSentOrDraftSince: async () => 0,
  findRespondedFor: async () => null,
  write: async () => ({}) as any,
};
const wsOk = {
  getDefault: async () =>
    ({ id: "w1", daily_budget_usd_cap: 5, name: "T", plan: "self-host", created_at: "" }) as any,
};
const msgsOk = {
  lastN: async () => [],
  insert: async () => {
    throw new Error();
  },
};

const baseCtx = {
  workspaceId: "w1",
  contactId: "c1",
  threadId: "t1",
  incomingContent: "hola",
  policy: {
    rate_limit_per_hour: 10,
    forbidden_topics_regex: [],
    escalate_triggers_regex: [],
  } as any,
};

describe("runPreLLMGuardrails", () => {
  it("returns ok when all checks pass", async () => {
    const r = await runPreLLMGuardrails(baseCtx, {
      audit: auditOk as any,
      workspaces: wsOk as any,
      messages: msgsOk as any,
    });
    expect(r.result.ok).toBe(true);
    expect(r.sanitizedContent).toBe("hola");
  });

  it("returns escalate when escalate trigger matches", async () => {
    const r = await runPreLLMGuardrails(
      {
        ...baseCtx,
        incomingContent: "tema legal urgente",
        policy: { ...baseCtx.policy, escalate_triggers_regex: ["legal"] } as any,
      },
      { audit: auditOk as any, workspaces: wsOk as any, messages: msgsOk as any },
    );
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.escalate).toBe(true);
  });
});
