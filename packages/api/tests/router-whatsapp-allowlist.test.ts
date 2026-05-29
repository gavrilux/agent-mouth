import { afterEach, describe, expect, it, vi } from "vitest";
import { type RouterDeps, processInbound } from "../src/router.js";

const inboundWhatsapp = {
  channel_type: "whatsapp" as const,
  external_message_id: "wamid.ABC",
  external_thread_id: "34611111111",
  sender_identifier: "34611111111",
  sender_display_name: "Marco",
  sender_handle: null,
  chat_type: "private" as const,
  content: "hola",
  attachments: [],
  raw_payload: {},
  received_at: "2026-05-28T10:00:00.000Z",
};

function makeDeps(): RouterDeps {
  return {
    workspaceId: "ws1",
    bridgeForwardChats: new Set(),
    bridgeForwardUrl: null,
    identityResolver: {
      resolveOrCreate: vi.fn(async () => ({
        contact: {
          id: "c1",
          workspace_id: "ws1",
          display_name: "Marco",
          notes: "",
          metadata: {},
          created_at: "2026-05-28T00:00:00.000Z",
        },
        channel: {
          id: "ch1",
          workspace_id: "ws1",
          type: "whatsapp",
          config: {},
          status: "active",
          created_at: "2026-05-28T00:00:00.000Z",
        },
        channel_identity: {
          id: "ci1",
          contact_id: "c1",
          channel_id: "ch1",
          identifier: "34611111111",
          verified: false,
        },
        created: false,
      })),
    } as never,
    threadStore: {
      resolveOrCreate: vi.fn(async () => ({
        id: "th1",
        workspace_id: "ws1",
        contact_id: "c1",
        channel_id: "ch1",
        external_thread_id: "34611111111",
        related_thread_ids: [],
        last_message_at: null,
        closed: false,
        notes_last_updated_at: null,
        created_at: "2026-05-28T00:00:00.000Z",
      })),
    } as never,
    policyEngine: {
      evaluate: vi.fn(async () => ({
        id: "p1",
        workspace_id: "ws1",
        contact_id: null,
        channel_type: null,
        policy: "auto",
        system_prompt: "",
        rules: {},
        priority: 0,
        created_at: "2026-05-28T00:00:00.000Z",
        model_id: null,
        rate_limit_per_hour: 30,
        max_tokens_out: 8000,
        max_tool_calls: 10,
        forbidden_topics_regex: [],
        escalate_triggers_regex: [],
        allowed_tools: '["*"]',
      })),
    } as never,
    messageStore: { insert: vi.fn(async () => ({ id: "msg-uuid" })) } as never,
    forwarder: vi.fn(),
  };
}

describe("router WhatsApp allow-list + kill switch", () => {
  const origAuto = process.env.ENABLE_WHATSAPP_AUTO;
  const origList = process.env.WHATSAPP_ALLOWLIST;
  afterEach(() => {
    process.env.ENABLE_WHATSAPP_AUTO = origAuto;
    process.env.WHATSAPP_ALLOWLIST = origList;
  });

  it("allow-listed sender keeps policy=auto and externalChatId=wa_id", async () => {
    process.env.ENABLE_WHATSAPP_AUTO = "true";
    process.env.WHATSAPP_ALLOWLIST = "+34 611 111 111, 34622222222";
    const result = await processInbound(inboundWhatsapp, makeDeps());
    if (result.kind !== "persisted") throw new Error(`expected persisted, got ${result.kind}`);
    expect(result.policy).toBe("auto");
    expect(result.externalChatId).toBe("34611111111");
  });

  it("non-allow-listed sender → policy=silent", async () => {
    process.env.ENABLE_WHATSAPP_AUTO = "true";
    process.env.WHATSAPP_ALLOWLIST = "34999999999";
    const result = await processInbound(inboundWhatsapp, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("silent");
  });

  it("ENABLE_WHATSAPP_AUTO=false → policy=silent even if allow-listed", async () => {
    process.env.ENABLE_WHATSAPP_AUTO = "false";
    process.env.WHATSAPP_ALLOWLIST = "34611111111";
    const result = await processInbound(inboundWhatsapp, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("silent");
  });

  it("empty allow-list → all whatsapp senders silent", async () => {
    process.env.ENABLE_WHATSAPP_AUTO = "true";
    process.env.WHATSAPP_ALLOWLIST = "";
    const result = await processInbound(inboundWhatsapp, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("silent");
  });

  it("does not affect non-whatsapp channels", async () => {
    process.env.ENABLE_WHATSAPP_AUTO = "false";
    process.env.WHATSAPP_ALLOWLIST = "";
    const telegramInbound = { ...inboundWhatsapp, channel_type: "telegram" as const };
    const result = await processInbound(telegramInbound, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("auto");
  });
});
