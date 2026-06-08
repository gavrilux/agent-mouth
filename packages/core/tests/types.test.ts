import { describe, expect, it } from "vitest";
import type {
  AuditEntry,
  AuditLogStore,
  Draft,
  DraftStore,
  JobQueue,
  Policy,
} from "../src/index.js";

describe("Phase 2 types", () => {
  it("Policy has guardrail caps", () => {
    const p: Policy = {
      id: "p1",
      workspace_id: "w1",
      contact_id: "c1",
      channel_type: "telegram",
      policy: "auto",
      system_prompt: "",
      rules: {},
      priority: 0,
      model_id: null,
      rate_limit_per_hour: 10,
      max_tokens_out: 8000,
      max_tool_calls: 10,
      forbidden_topics_regex: [],
      escalate_triggers_regex: [],
      created_at: new Date().toISOString(),
    };
    expect(p.policy).toBe("auto");
  });

  it("Draft and AuditEntry types exist", () => {
    const d: Draft = {
      id: "d1",
      message_id: "m1",
      proposed_body: "hi",
      agent_reasoning: "",
      tools_called: [],
      status: "pending",
      approved_by: null,
      approved_at: null,
      created_at: new Date().toISOString(),
    };
    const a: AuditEntry = {
      id: "a1",
      workspace_id: "w1",
      action: "agent.respond",
      actor: "agent",
      details: {},
      related_message_id: "m1",
      related_contact_id: "c1",
      decision: "sent",
      block_reason: null,
      model_id: "claude-sonnet-4-6",
      tokens_in: 100,
      tokens_out: 50,
      tokens_cached: 0,
      cost_usd: 0.001,
      latency_ms: 1500,
      created_at: new Date().toISOString(),
    };
    expect(d.status).toBe("pending");
    expect(a.decision).toBe("sent");
  });
});
