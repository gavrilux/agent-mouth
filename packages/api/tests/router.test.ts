// packages/api/tests/router.test.ts
import { describe, expect, it, vi } from "vitest";
import { type RouterDeps, processInbound } from "../src/router.js";

const WS = "11111111-1111-1111-1111-111111111111";
const CONTACT = "00000000-0000-0000-0000-000000000001";
const CHAN = "22222222-2222-2222-2222-222222222222";
const IDENT = "00000000-0000-0000-0000-000000000010";
const THREAD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const M1 = "cccccccc-cccc-cccc-cccc-cccccccccc01";

const baseInbound = {
  channel_type: "telegram" as const,
  external_message_id: "42",
  external_thread_id: "987654321",
  sender_identifier: "987654321",
  sender_display_name: "Gavrilo",
  sender_handle: "gavri",
  chat_type: "private" as const,
  content: "hola",
  attachments: [],
  raw_payload: { update_id: 1 },
  received_at: "2026-05-20T00:00:00.000Z",
};

function makeDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    workspaceId: WS,
    bridgeForwardChats: new Set(["-5286864201"]),
    bridgeForwardUrl: "https://lab.example/webhook",
    identityResolver: {
      resolveOrCreate: vi.fn().mockResolvedValue({
        contact: {
          id: CONTACT,
          workspace_id: WS,
          display_name: "Gavrilo",
          notes: "",
          created_at: "2026-05-20T00:00:00Z",
        },
        channel: {
          id: CHAN,
          workspace_id: WS,
          type: "telegram",
          config: {},
          status: "active",
          created_at: "2026-05-20T00:00:00Z",
        },
        channel_identity: {
          id: IDENT,
          contact_id: CONTACT,
          channel_id: CHAN,
          identifier: "987654321",
          verified: false,
        },
        created: false,
      }),
    },
    threadStore: {
      resolveOrCreate: vi.fn().mockResolvedValue({
        id: THREAD,
        workspace_id: WS,
        contact_id: CONTACT,
        channel_id: CHAN,
        external_thread_id: "987654321",
        related_thread_ids: [],
        last_message_at: null,
        closed: false,
        created_at: "2026-05-20T00:00:00Z",
      }),
    },
    policyEngine: {
      evaluate: vi.fn().mockResolvedValue({
        id: "33333333-3333-3333-3333-333333333333",
        workspace_id: WS,
        contact_id: null,
        channel_type: null,
        policy: "silent",
        system_prompt: "",
        rules: {},
        priority: 0,
        created_at: "2026-05-20T00:00:00Z",
      }),
    },
    messageStore: {
      insert: vi.fn().mockResolvedValue({
        id: M1,
        thread_id: THREAD,
        channel_id: CHAN,
        channel_identity_id: IDENT,
        direction: "inbound",
        content: "hola",
        attachments: [],
        raw_payload: { update_id: 1 },
        external_message_id: "42",
        sent_by: null,
        created_at: "2026-05-20T00:00:00Z",
      }),
      listRecent: vi.fn(),
      waitForNew: vi.fn(),
    },
    forwarder: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("processInbound", () => {
  it("persists private message via identity → thread → policy → message", async () => {
    const deps = makeDeps();
    const out = await processInbound(baseInbound, deps);
    expect(out).toMatchObject({ kind: "persisted", policy: "silent", messageId: M1 });
    expect(deps.identityResolver.resolveOrCreate).toHaveBeenCalled();
    expect(deps.threadStore.resolveOrCreate).toHaveBeenCalled();
    expect(deps.policyEngine.evaluate).toHaveBeenCalled();
    expect(deps.messageStore.insert).toHaveBeenCalled();
    expect(deps.forwarder).not.toHaveBeenCalled();
  });

  it("persisted result includes all fields needed by the worker", async () => {
    const deps = makeDeps();
    const out = await processInbound(baseInbound, deps);
    expect(out).toMatchObject({
      kind: "persisted",
      messageId: M1,
      contactId: CONTACT,
      threadId: THREAD,
      channelType: "telegram",
      channelId: CHAN,
      channelIdentityId: IDENT,
      messageContent: "hola",
    });
  });

  it("persisted result with policy=silent still returns all fields", async () => {
    // policy=silent → router returns the shape; enqueue decision is caller's responsibility
    const deps = makeDeps();
    const out = await processInbound(baseInbound, deps);
    if (out.kind !== "persisted") throw new Error("expected persisted");
    expect(out.policy).toBe("silent");
    expect(out.contactId).toBe(CONTACT);
    expect(out.threadId).toBe(THREAD);
    expect(out.channelType).toBe("telegram");
    expect(out.channelId).toBe(CHAN);
    expect(out.channelIdentityId).toBe(IDENT);
    expect(out.messageContent).toBe("hola");
  });

  it("forwards Cuina LAB group to bridge without persisting", async () => {
    const deps = makeDeps();
    const out = await processInbound(
      { ...baseInbound, external_thread_id: "-5286864201", chat_type: "group" },
      deps,
    );
    expect(out).toEqual({ kind: "forwarded", url: "https://lab.example/webhook", ok: true });
    expect(deps.forwarder).toHaveBeenCalledWith("https://lab.example/webhook", { update_id: 1 });
    expect(deps.identityResolver.resolveOrCreate).not.toHaveBeenCalled();
    expect(deps.messageStore.insert).not.toHaveBeenCalled();
  });

  it("returns kind=forwarded with ok=false when forwarder fails (still ACKs Telegram)", async () => {
    const deps = makeDeps({ forwarder: vi.fn().mockResolvedValue(false) });
    const out = await processInbound({ ...baseInbound, external_thread_id: "-5286864201" }, deps);
    expect(out).toEqual({ kind: "forwarded", url: "https://lab.example/webhook", ok: false });
  });
});
