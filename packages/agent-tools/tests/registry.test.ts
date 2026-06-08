import type { Policy, Tool } from "@agent-mouth/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetToolRegistry,
  getTool,
  listTools,
  registerTool,
  resolveToolsForPolicy,
} from "../src/registry.js";

function makeTool(name: string, requiresExplicitGrant = false): Tool {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    requiresExplicitGrant,
    execute: async () => ({ ok: true, output: { name }, costUsd: 0, latencyMs: 0 }),
  };
}

function policy(allowedTools: string[]): Policy {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    workspace_id: "00000000-0000-0000-0000-000000000002",
    contact_id: null,
    channel_type: null,
    policy: "auto",
    system_prompt: "",
    rules: {},
    priority: 0,
    model_id: null,
    rate_limit_per_hour: 30,
    max_tokens_out: 8000,
    max_tool_calls: 10,
    forbidden_topics_regex: [],
    escalate_triggers_regex: [],
    allowed_tools: JSON.stringify(allowedTools),
    created_at: "2026-05-23T00:00:00+00:00",
  } as unknown as Policy;
}

describe("tool registry", () => {
  beforeEach(() => _resetToolRegistry());

  it("registers and lists tools", () => {
    registerTool(makeTool("alpha"));
    registerTool(makeTool("beta"));
    expect(
      listTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  it("getTool returns by name", () => {
    registerTool(makeTool("alpha"));
    expect(getTool("alpha")?.name).toBe("alpha");
    expect(getTool("missing")).toBeUndefined();
  });

  it("resolveToolsForPolicy with '[]' returns none", () => {
    registerTool(makeTool("alpha"));
    expect(resolveToolsForPolicy(policy([]))).toEqual([]);
  });

  it("resolveToolsForPolicy with '[\"*\"]' returns all read-only tools", () => {
    registerTool(makeTool("read1"));
    registerTool(makeTool("destructive", true));
    const out = resolveToolsForPolicy(policy(["*"])).map((t) => t.name);
    expect(out).toEqual(["read1"]);
  });

  it("resolveToolsForPolicy with missing allowed_tools falls back to schema default ['*']", () => {
    registerTool(makeTool("read1"));
    registerTool(makeTool("destructive", true));
    const policyMissing = { ...policy(["*"]), allowed_tools: undefined } as unknown as Policy;
    const out = resolveToolsForPolicy(policyMissing).map((t) => t.name);
    expect(out).toEqual(["read1"]);
  });

  it("resolveToolsForPolicy with explicit list returns intersection (including destructive)", () => {
    registerTool(makeTool("read1"));
    registerTool(makeTool("destructive", true));
    const out = resolveToolsForPolicy(policy(["destructive"])).map((t) => t.name);
    expect(out).toEqual(["destructive"]);
  });
});
