import { afterEach, describe, expect, it, vi } from "vitest";
import { processInbound, type RouterDeps } from "../src/router.js";

const inboundEmail = {
  channel_type: "email" as const,
  external_message_id: "m1",
  external_thread_id: "t1",
  sender_identifier: "marco@thecuina.com",
  sender_display_name: "Marco",
  sender_handle: null,
  chat_type: "private" as const,
  content: "hello",
  attachments: [],
  raw_payload: {},
  received_at: "2026-05-25T10:00:00.000Z",
};

function makeDeps(): RouterDeps {
  return {
    workspaceId: "ws1",
    bridgeForwardChats: new Set(),
    bridgeForwardUrl: null,
    identityResolver: { resolveOrCreate: vi.fn(async () => ({
      contact: { id: "c1", workspace_id: "ws1", display_name: "Marco", notes: "", metadata: {}, created_at: "2026-05-25T00:00:00.000Z" },
      channel: { id: "ch1", workspace_id: "ws1", type: "email", config: {}, status: "active", created_at: "2026-05-25T00:00:00.000Z" },
      channel_identity: { id: "ci1", contact_id: "c1", channel_id: "ch1", identifier: "marco@thecuina.com", verified: false },
      created: false,
    })) } as never,
    threadStore: { resolveOrCreate: vi.fn(async () => ({ id: "th1", workspace_id: "ws1", contact_id: "c1", channel_id: "ch1", external_thread_id: "t1", related_thread_ids: [], last_message_at: null, closed: false, notes_last_updated_at: null, created_at: "2026-05-25T00:00:00.000Z" })) } as never,
    policyEngine: { evaluate: vi.fn(async () => ({
      id: "p1", workspace_id: "ws1", contact_id: null, channel_type: null,
      policy: "auto", system_prompt: "", rules: {}, priority: 0,
      created_at: "2026-05-25T00:00:00.000Z", model_id: null,
      rate_limit_per_hour: 30, max_tokens_out: 8000, max_tool_calls: 10,
      forbidden_topics_regex: [], escalate_triggers_regex: [],
      allowed_tools: '["*"]',
    })) } as never,
    messageStore: { insert: vi.fn(async () => ({ id: "msg-uuid" })) } as never,
    forwarder: vi.fn(),
  };
}

describe("router kill switch ENABLE_EMAIL_AUTO", () => {
  const origEnv = process.env.ENABLE_EMAIL_AUTO;
  afterEach(() => { process.env.ENABLE_EMAIL_AUTO = origEnv; });

  it("forces policy=silent when ENABLE_EMAIL_AUTO=false and channel_type=email", async () => {
    process.env.ENABLE_EMAIL_AUTO = "false";
    const result = await processInbound(inboundEmail, makeDeps());
    if (result.kind !== "persisted") throw new Error(`expected persisted, got ${result.kind}`);
    expect(result.policy).toBe("silent");
  });

  it("respects underlying policy=auto when ENABLE_EMAIL_AUTO=true", async () => {
    process.env.ENABLE_EMAIL_AUTO = "true";
    const result = await processInbound(inboundEmail, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("auto");
  });

  it("respects underlying policy=auto when ENABLE_EMAIL_AUTO is unset", async () => {
    delete process.env.ENABLE_EMAIL_AUTO;
    const result = await processInbound(inboundEmail, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("auto");
  });

  it("ignores kill switch for non-email channels", async () => {
    process.env.ENABLE_EMAIL_AUTO = "false";
    const telegramInbound = { ...inboundEmail, channel_type: "telegram" as const };
    const result = await processInbound(telegramInbound, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("auto");
  });
});
