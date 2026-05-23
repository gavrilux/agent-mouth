// packages/api/tests/worker-respond.test.ts
import { Agent } from "@agent-mouth/agent";
import { MockRuntime } from "@agent-mouth/agent-runtime";
import type {
  AuditLogStore,
  Contact,
  ContactStore,
  DraftStore,
  MessageStore,
  PersistedMessage,
  Policy,
  PolicyEngine,
  ThreadStore,
  Transport,
  Workspace,
  WorkspaceStore,
} from "@agent-mouth/core";
import type { PgBossQueue } from "@agent-mouth/queue-pgboss";
import type { SupabaseAuditLogStore, SupabaseDraftStore } from "@agent-mouth/storage-supabase";
import { describe, expect, it, vi } from "vitest";
import { handleRespondJob } from "../src/worker.js";
import type { RespondJobData, WorkerDeps } from "../src/worker.js";

// ─── ID constants ────────────────────────────────────────────────────────────
const WS = "11111111-1111-1111-1111-111111111111";
const CONTACT = "00000000-0000-0000-0000-000000000001";
const THREAD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const CHAN = "22222222-2222-2222-2222-222222222222";
const MSG_IN = "dddddddd-dddd-dddd-dddd-dddddddddd01";
const MSG_OUT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01";
const POLICY_ID = "33333333-3333-3333-3333-333333333333";

// ─── Base fixtures ────────────────────────────────────────────────────────────
const baseContact: Contact = {
  id: CONTACT,
  workspace_id: WS,
  display_name: "Test User",
  notes: "",
  created_at: "2026-05-20T00:00:00Z",
};

const baseWorkspace: Workspace = {
  id: WS,
  name: "Test WS",
  owner_user_id: null,
  plan: "self-host",
  daily_budget_usd_cap: 5,
  created_at: "2026-05-20T00:00:00Z",
};

const basePolicy: Policy = {
  id: POLICY_ID,
  workspace_id: WS,
  contact_id: null,
  channel_type: null,
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
  created_at: "2026-05-20T00:00:00Z",
};

const baseJobData: RespondJobData = {
  workspaceId: WS,
  contactId: CONTACT,
  threadId: THREAD,
  channelType: "telegram",
  channelId: CHAN,
  channelIdentityId: null,
  messageId: MSG_IN,
  messageContent: "hola",
};

function makeData(overrides?: Partial<RespondJobData>): RespondJobData {
  return { ...baseJobData, ...overrides };
}

// ─── Mock factory ─────────────────────────────────────────────────────────────
function makeCtx(
  overrides?: {
    runtimeConfig?: { body?: string; costUsd?: number; shouldEscalate?: boolean };
    policyOverride?: Partial<Policy>;
    auditOverrides?: {
      sumCostUsdSince?: ReturnType<typeof vi.fn>;
      countSentOrDraftSince?: ReturnType<typeof vi.fn>;
      findRespondedFor?: ReturnType<typeof vi.fn>;
    };
    messageLastN?: PersistedMessage[];
    draftFindPending?: null | object;
  },
  workerFlags?: { enableNotesUpdater?: boolean },
) {
  const runtime = new MockRuntime();
  // MockRuntime.initialize is a no-op but must be called per contract
  void runtime.initialize(overrides?.runtimeConfig ?? { body: "hola respuesta", costUsd: 0.001 });

  const policy = { ...basePolicy, ...overrides?.policyOverride };

  const contactStore = {
    findById: vi.fn().mockResolvedValue(baseContact),
    upsertByDisplayName: vi.fn(),
    updateNotes: vi.fn(),
  };

  const messageStore = {
    insert: vi.fn().mockResolvedValue({
      id: MSG_OUT,
      thread_id: THREAD,
      channel_id: CHAN,
      channel_identity_id: null,
      direction: "outbound" as const,
      content: "hola respuesta",
      attachments: [],
      raw_payload: null,
      external_message_id: null,
      sent_by: "agent" as const,
      created_at: "2026-05-20T00:01:00Z",
    }),
    lastN: vi.fn().mockResolvedValue(overrides?.messageLastN ?? []),
    countSinceTimestamp: vi.fn().mockResolvedValue(0),
    listRecent: vi.fn().mockResolvedValue([]),
    waitForNew: vi.fn().mockResolvedValue([]),
  };

  const workspaceStore = {
    getDefault: vi.fn().mockResolvedValue(baseWorkspace),
  };

  const policyEngine = {
    evaluate: vi.fn().mockResolvedValue(policy),
  };

  const transport = {
    send: vi.fn().mockResolvedValue({ message_id: 999 }),
  };

  const auditStore = {
    write: vi.fn().mockResolvedValue(undefined),
    sumCostUsdSince: vi.fn().mockResolvedValue(0),
    countSentOrDraftSince: vi.fn().mockResolvedValue(0),
    findRespondedFor: vi.fn().mockResolvedValue(null),
    ...(overrides?.auditOverrides ?? {}),
  };

  const draftStore = {
    insert: vi.fn().mockResolvedValue({
      id: "ff000000-0000-0000-0000-000000000001",
      message_id: MSG_IN,
      proposed_body: "hola respuesta",
      agent_reasoning: "mock reasoning",
      tools_called: [],
      status: "pending",
      approved_by: null,
      approved_at: null,
      created_at: "2026-05-20T00:01:00Z",
    }),
    findPendingByMessageId: vi.fn().mockResolvedValue(overrides?.draftFindPending ?? null),
  };

  const queue = {
    send: vi.fn().mockResolvedValue(null),
  };

  const deps: WorkerDeps = {
    databaseUrl: "postgres://unused",
    supabaseUrl: "https://unused.supabase.co",
    supabaseAnonKey: "unused-key",
    anthropicApiKey: "unused-key",
    defaultModel: "claude-3-5-haiku-20241022",
    notesModel: "claude-3-5-haiku-20241022",
    enableNotesUpdater: workerFlags?.enableNotesUpdater ?? false,
    contactStore: contactStore as unknown as ContactStore,
    messageStore: messageStore as unknown as MessageStore,
    threadStore: {} as unknown as ThreadStore,
    workspaceStore: workspaceStore as unknown as WorkspaceStore,
    policyEngine: policyEngine as unknown as PolicyEngine,
    transport: transport as unknown as Transport,
  };

  const agent = new Agent({
    runtime,
    contactStore: contactStore as unknown as ContactStore,
    messageStore: messageStore as unknown as MessageStore,
    auditLogStore: auditStore as unknown as AuditLogStore,
    workspaceStore: workspaceStore as unknown as WorkspaceStore,
  });

  return {
    agent,
    queue: queue as unknown as PgBossQueue,
    deps,
    auditStore: auditStore as unknown as SupabaseAuditLogStore,
    draftStore: draftStore as unknown as SupabaseDraftStore,
    // expose for assertion
    mocks: { transport, auditStore, draftStore, messageStore, queue },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe("handleRespondJob — ready_to_send (auto policy)", () => {
  it("calls transport.send, persists outbound message and writes audit with decision=sent", async () => {
    const ctx = makeCtx();
    await handleRespondJob(makeData(), ctx);

    expect(ctx.mocks.transport.send).toHaveBeenCalledOnce();
    expect(ctx.mocks.transport.send).toHaveBeenCalledWith({ to: CHAN, body: "hola respuesta" });

    expect(ctx.mocks.messageStore.insert).toHaveBeenCalledOnce();
    const insertArg = ctx.mocks.messageStore.insert.mock.calls[0][0];
    expect(insertArg.direction).toBe("outbound");
    expect(insertArg.sentBy).toBe("agent");
    expect(insertArg.threadId).toBe(THREAD);
    expect(insertArg.content).toBe("hola respuesta");

    expect(ctx.mocks.auditStore.write).toHaveBeenCalledOnce();
    const auditArg = ctx.mocks.auditStore.write.mock.calls[0][0];
    expect(auditArg.decision).toBe("sent");
    expect(auditArg.workspace_id).toBe(WS);
  });
});

describe("handleRespondJob — ready_to_draft (suggest policy)", () => {
  it("calls draftStore.insert, does NOT call transport.send, does NOT persist outbound message", async () => {
    const ctx = makeCtx({ policyOverride: { policy: "suggest" } });
    await handleRespondJob(makeData(), ctx);

    expect(ctx.mocks.transport.send).not.toHaveBeenCalled();
    expect(ctx.mocks.messageStore.insert).not.toHaveBeenCalled();
    expect(ctx.mocks.draftStore.insert).toHaveBeenCalledOnce();

    const auditArg = ctx.mocks.auditStore.write.mock.calls[0][0];
    expect(auditArg.decision).toBe("draft");
  });

  it("does NOT insert a second draft when findPendingByMessageId returns an existing draft (idempotency)", async () => {
    const existingDraft = {
      id: "ff000000-0000-0000-0000-000000000001",
      message_id: MSG_IN,
      proposed_body: "old draft",
      agent_reasoning: "old",
      tools_called: [],
      status: "pending",
      approved_by: null,
      approved_at: null,
      created_at: "2026-05-20T00:00:30Z",
    };
    const ctx = makeCtx({
      policyOverride: { policy: "suggest" },
      draftFindPending: existingDraft,
    });

    await handleRespondJob(makeData(), ctx);

    // draft already exists → insert must NOT be called again
    expect(ctx.mocks.draftStore.insert).not.toHaveBeenCalled();
    // audit still written
    expect(ctx.mocks.auditStore.write).toHaveBeenCalledOnce();
  });
});

describe("handleRespondJob — budget blocked", () => {
  it("writes audit with decision=blocked and does NOT call transport.send when budget cap is exceeded", async () => {
    // sumCostUsdSince returns > cap so budget check fails
    const ctx = makeCtx({
      auditOverrides: {
        sumCostUsdSince: vi.fn().mockResolvedValue(10), // 10 > 5 cap
      },
    });

    await handleRespondJob(makeData(), ctx);

    expect(ctx.mocks.transport.send).not.toHaveBeenCalled();
    expect(ctx.mocks.messageStore.insert).not.toHaveBeenCalled();

    expect(ctx.mocks.auditStore.write).toHaveBeenCalledOnce();
    const auditArg = ctx.mocks.auditStore.write.mock.calls[0][0];
    expect(auditArg.decision).toBe("blocked");
  });
});

describe("handleRespondJob — forbidden topic", () => {
  it("blocks and writes audit with decision=blocked when incoming content matches forbidden_topics_regex", async () => {
    const ctx = makeCtx({
      policyOverride: { forbidden_topics_regex: ["weapon"] },
    });
    const data: RespondJobData = { ...makeData(), messageContent: "buy a weapon now" };

    await handleRespondJob(data, ctx);

    expect(ctx.mocks.transport.send).not.toHaveBeenCalled();
    expect(ctx.mocks.messageStore.insert).not.toHaveBeenCalled();

    const auditArg = ctx.mocks.auditStore.write.mock.calls[0][0];
    expect(auditArg.decision).toBe("blocked");
  });
});

describe("handleRespondJob — loop protection", () => {
  it("blocks when the last 3 messages are all outbound agent messages", async () => {
    const agentMsg = (id: string): PersistedMessage => ({
      id,
      thread_id: THREAD,
      channel_id: CHAN,
      channel_identity_id: null,
      direction: "outbound",
      content: "agent msg",
      attachments: [],
      raw_payload: null,
      external_message_id: null,
      sent_by: "agent",
      created_at: "2026-05-20T00:00:00Z",
    });

    const ctx = makeCtx({
      messageLastN: [agentMsg("m-a1"), agentMsg("m-a2"), agentMsg("m-a3")],
    });

    await handleRespondJob(makeData(), ctx);

    expect(ctx.mocks.transport.send).not.toHaveBeenCalled();
    const auditArg = ctx.mocks.auditStore.write.mock.calls[0][0];
    expect(auditArg.decision).toBe("blocked");
  });
});

describe("handleRespondJob — escalate (MockRuntime.shouldEscalate=true)", () => {
  it("writes audit with decision=escalated and does NOT call transport.send", async () => {
    const ctx = makeCtx({
      runtimeConfig: { body: "ignored", costUsd: 0, shouldEscalate: true },
    });

    await handleRespondJob(makeData(), ctx);

    expect(ctx.mocks.transport.send).not.toHaveBeenCalled();
    expect(ctx.mocks.messageStore.insert).not.toHaveBeenCalled();

    const auditArg = ctx.mocks.auditStore.write.mock.calls[0][0];
    expect(auditArg.decision).toBe("escalated");
  });
});

describe("handleRespondJob — silent policy", () => {
  it("silent policy → early return, nothing called", async () => {
    const ctx = makeCtx({ policyOverride: { policy: "silent" } });
    await handleRespondJob(makeData(), ctx);
    expect(ctx.mocks.transport.send).not.toHaveBeenCalled();
    expect(ctx.mocks.messageStore.insert).not.toHaveBeenCalled();
    expect(ctx.mocks.auditStore.write).not.toHaveBeenCalled();
  });
});

describe("handleRespondJob — notes updater", () => {
  it("enableNotesUpdater=true → enqueues agent.notes.maybe_update", async () => {
    const ctx = makeCtx({}, { enableNotesUpdater: true });
    await handleRespondJob(makeData(), ctx);
    expect(ctx.mocks.queue.send).toHaveBeenCalledWith("agent.notes.maybe_update", {
      workspaceId: WS,
      contactId: CONTACT,
      threadId: THREAD,
    });
  });
});

describe("handleRespondJob — idempotency (findRespondedFor)", () => {
  it("findRespondedFor returns prior record → no_action, nothing sent", async () => {
    const ctx = makeCtx({
      auditOverrides: { findRespondedFor: vi.fn().mockResolvedValue({ id: "prior" }) },
    });
    await handleRespondJob(makeData(), ctx);
    expect(ctx.mocks.transport.send).not.toHaveBeenCalled();
    expect(ctx.mocks.messageStore.insert).not.toHaveBeenCalled();
    // Worker writes a blocked audit for idempotent_skip:already_responded
    const auditArg = ctx.mocks.auditStore.write.mock.calls[0][0];
    expect(auditArg.decision).toBe("blocked");
  });
});
