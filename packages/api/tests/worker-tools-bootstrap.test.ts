// packages/api/tests/worker-tools-bootstrap.test.ts
//
// Tests that verify Phase 3 toolsResolver wiring in handleRespondJob:
//   1. When toolsResolver is supplied and returns non-empty tools, agent.respond is called with tools.
//   2. When toolsResolver is undefined (Phase 2 fallback), agent.respond is called without tools.

import { Agent } from "@agent-mouth/agent";
import { MockRuntime } from "@agent-mouth/agent-runtime";
import type {
  AuditLogStore,
  Contact,
  ContactStore,
  DraftStore,
  MessageStore,
  Policy,
  PolicyEngine,
  ThreadStore,
  Tool,
  Transport,
  Workspace,
  WorkspaceStore,
} from "@agent-mouth/core";
import type { PgBossQueue } from "@agent-mouth/queue-pgboss";
import type { SupabaseAuditLogStore, SupabaseDraftStore } from "@agent-mouth/storage-supabase";
import { describe, expect, it, vi } from "vitest";
import { handleRespondJob } from "../src/worker.js";
import type { RespondJobData, WorkerDeps } from "../src/worker.js";

// ─── ID constants ─────────────────────────────────────────────────────────────
const WS = "11111111-1111-1111-1111-111111111111";
const CONTACT = "00000000-0000-0000-0000-000000000001";
const THREAD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const CHAN = "22222222-2222-2222-2222-222222222222";
const MSG_IN = "dddddddd-dddd-dddd-dddd-dddddddddd01";
const MSG_OUT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01";
const POLICY_ID = "33333333-3333-3333-3333-333333333333";

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
  externalChatId: "987654321",
  messageId: MSG_IN,
  messageContent: "hola",
};

/** Minimal fake Tool object — only needs `name` for resolveToolsForPolicy filtering. */
const fakeTool: Tool = {
  name: "fake_search",
  description: "A fake search tool for testing",
  requiresExplicitGrant: false,
  inputSchema: { type: "object", properties: {}, required: [] },
  execute: vi.fn().mockResolvedValue({ result: "ok" }),
};

function makeMinimalCtx(toolsResolver?: (policy: Policy) => Tool[]) {
  const runtime = new MockRuntime();
  void runtime.initialize({ body: "resp", costUsd: 0.001 });

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
      content: "resp",
      attachments: [],
      raw_payload: null,
      external_message_id: null,
      sent_by: "agent" as const,
      created_at: "2026-05-20T00:01:00Z",
    }),
    lastN: vi.fn().mockResolvedValue([]),
    countSinceTimestamp: vi.fn().mockResolvedValue(0),
    listRecent: vi.fn().mockResolvedValue([]),
    waitForNew: vi.fn().mockResolvedValue([]),
  };
  const workspaceStore = {
    getDefault: vi.fn().mockResolvedValue(baseWorkspace),
  };
  const policyEngine = {
    evaluate: vi.fn().mockResolvedValue(basePolicy),
  };
  const transport = {
    send: vi.fn().mockResolvedValue({ message_id: 1 }),
  };
  const auditStore = {
    write: vi.fn().mockResolvedValue(undefined),
    sumCostUsdSince: vi.fn().mockResolvedValue(0),
    countSentOrDraftSince: vi.fn().mockResolvedValue(0),
    findRespondedFor: vi.fn().mockResolvedValue(null),
  };
  const draftStore = {
    insert: vi.fn().mockResolvedValue(null),
    findPendingByMessageId: vi.fn().mockResolvedValue(null),
  };
  const queue = { send: vi.fn().mockResolvedValue(null) };

  const deps: WorkerDeps = {
    databaseUrl: "postgres://unused",
    supabaseUrl: "https://unused.supabase.co",
    supabaseAnonKey: "unused-key",
    apiKeys: { ANTHROPIC_API_KEY: "unused-key" },
    defaultModel: "claude-3-5-haiku-20241022",
    notesModel: "claude-3-5-haiku-20241022",
    enableNotesUpdater: false,
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
    toolsResolver,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe("handleRespondJob — Phase 3 toolsResolver wiring", () => {
  it("calls agent.respond WITH tools when toolsResolver returns non-empty tools (Phase 3 path)", async () => {
    const toolsResolver = vi.fn((_policy: Policy) => [fakeTool]);
    const ctx = makeMinimalCtx(toolsResolver);

    const respondSpy = vi.spyOn(ctx.agent, "respond");

    await handleRespondJob(baseJobData, ctx);

    expect(toolsResolver).toHaveBeenCalledOnce();
    expect(respondSpy).toHaveBeenCalledOnce();
    const callArgs = respondSpy.mock.calls[0][0];
    expect(callArgs.tools).toEqual([fakeTool]);
  });

  it("calls agent.respond WITHOUT tools when toolsResolver is undefined (Phase 2 fallback)", async () => {
    const ctx = makeMinimalCtx(undefined);

    const respondSpy = vi.spyOn(ctx.agent, "respond");

    await handleRespondJob(baseJobData, ctx);

    expect(respondSpy).toHaveBeenCalledOnce();
    const callArgs = respondSpy.mock.calls[0][0];
    // tools must be undefined so Agent skips the tool loop entirely
    expect(callArgs.tools).toBeUndefined();
  });

  it("calls agent.respond WITHOUT tools when toolsResolver returns empty array (no tools available)", async () => {
    const toolsResolver = vi.fn((_policy: Policy) => [] as Tool[]);
    const ctx = makeMinimalCtx(toolsResolver);

    const respondSpy = vi.spyOn(ctx.agent, "respond");

    await handleRespondJob(baseJobData, ctx);

    expect(toolsResolver).toHaveBeenCalledOnce();
    expect(respondSpy).toHaveBeenCalledOnce();
    const callArgs = respondSpy.mock.calls[0][0];
    // Empty array is passed through — Agent interprets as no tools
    expect(callArgs.tools).toEqual([]);
  });
});
