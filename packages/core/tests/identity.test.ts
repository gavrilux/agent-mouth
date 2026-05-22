// packages/core/tests/identity.test.ts
import { describe, it, expect } from "vitest";
import {
  ContactSchema,
  ChannelIdentitySchema,
  PolicySchema,
  ChannelSchema,
  ThreadSchema,
  WorkspaceSchema,
} from "../src/identity.js";

describe("identity schemas", () => {
  const wsId = "00000000-0000-0000-0000-000000000099";
  const contactId = "00000000-0000-0000-0000-000000000001";
  const channelId = "00000000-0000-0000-0000-000000000002";

  it("WorkspaceSchema parses valid row", () => {
    const w = { id: wsId, name: "default", owner_user_id: null, plan: "self-host", created_at: "2026-05-20T00:00:00Z" };
    expect(WorkspaceSchema.parse(w)).toEqual({ ...w, daily_budget_usd_cap: 5 });
  });

  it("ContactSchema parses valid row", () => {
    const c = { id: contactId, workspace_id: wsId, display_name: "Gavrilo", notes: "", created_at: "2026-05-20T00:00:00Z" };
    expect(ContactSchema.parse(c)).toEqual(c);
  });

  it("ChannelSchema rejects unknown channel type", () => {
    expect(() =>
      ChannelSchema.parse({ id: channelId, workspace_id: wsId, type: "fax", config: {}, status: "active", created_at: "2026-05-20T00:00:00Z" }),
    ).toThrow();
  });

  it("ChannelIdentitySchema parses valid row", () => {
    const ci = { id: "00000000-0000-0000-0000-000000000003", contact_id: contactId, channel_id: channelId, identifier: "12345", verified: false };
    expect(ChannelIdentitySchema.parse(ci)).toEqual(ci);
  });

  it("PolicySchema parses with nullable contact_id and channel_type", () => {
    const p = {
      id: "00000000-0000-0000-0000-000000000004",
      workspace_id: wsId, contact_id: null, channel_type: null,
      policy: "silent", system_prompt: "", rules: {}, priority: 0,
      created_at: "2026-05-20T00:00:00Z",
    };
    expect(PolicySchema.parse(p)).toEqual({
      ...p,
      model_id: null,
      rate_limit_per_hour: 10,
      max_tokens_out: 8000,
      max_tool_calls: 10,
      forbidden_topics_regex: [],
      escalate_triggers_regex: [],
    });
  });

  it("ThreadSchema parses valid row", () => {
    const t = {
      id: "00000000-0000-0000-0000-000000000005",
      workspace_id: wsId, contact_id: contactId, channel_id: channelId,
      external_thread_id: "-5286864201", related_thread_ids: [],
      last_message_at: null, closed: false, created_at: "2026-05-20T00:00:00Z",
    };
    expect(ThreadSchema.parse(t)).toEqual(t);
  });
});
