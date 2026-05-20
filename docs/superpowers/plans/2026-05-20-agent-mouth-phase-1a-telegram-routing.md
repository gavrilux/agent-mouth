# Phase 1a — Telegram Routing + Identity Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@Gavrilux_bot` a real "agent mouth": receive Telegram messages via webhook (replacing long-polling), route by chat (forward The Cuina LAB group to the existing `lab.agentiko.es` bridge, persist everything else to Supabase), and expose persisted messages to Claude via the existing MCP tools. Build Identity foundations (ContactStore, IdentityResolver, PolicyEngine) so Phase 1b (Email) and Phase 2 (Agent) can build on them.

**Architecture:**

```
Telegram → POST /telegram-webhook (agent-mouth.fly.dev)
    ↓
[normalize: TelegramUpdate → InboundMessage]
    ↓
[pre-router: if chat_id ∈ BRIDGE_FORWARD_CHATS → forward to BRIDGE_FORWARD_URL, ack 200, exit]
    ↓
[IdentityResolver.resolveOrCreate → Contact + ChannelIdentity]
    ↓
[ThreadStore.resolveOrCreate → Thread]
    ↓
[PolicyEngine.evaluate → policy ∈ {auto, suggest, escalate, silent}]
    ↓
[MessageStore.insert → persist row with thread_id + policy outcome]
    ↓
ack 200 to Telegram
```

MCP `read_inbox` / `wait_for_messages` / `get_thread` switch from `transport.receive()` (long-polling) to reading from `MessageStore`. `send_message` continues using `transport.send()`. The Cuina LAB bridge keeps owning its group; agent-mouth owns the webhook and forwards group events to the bridge.

**Tech Stack:** TypeScript 5.5, pnpm 9 workspaces, Supabase (Postgres + REST), `node:http`, `grammy` (Telegram), `zod`, `vitest`, `pino`. No new external deps.

**Constraints:**
- `packages/mcp` is still present (Phase 0 G9 not yet executed). Do not edit it. All work happens in `core`, `storage-supabase`, `transport-telegram`, `api`.
- `agent-mouth.fly.dev` must keep serving `/health` and `/mcp` throughout. The webhook cutover (Task 41) is the single hard stop.
- Supabase project is already provisioned (Phase 0). SQL migrations applied manually via Supabase SQL editor (no migration runner yet — that's Phase 1b polish).
- The Cuina LAB bridge at `lab.agentiko.es/webhook` is a black box: forward to it, don't touch it.

**Effort estimate:** ~10-14 hours over 1-2 weeks (33 tasks, ~2-5 min each + reading/debugging).

---

## File Structure

**Created:**
- `packages/core/src/identity.ts` — `Contact`, `ChannelIdentity`, `Policy`, `Channel`, `Thread`, `Workspace` Zod schemas + types
- `packages/core/src/stores.ts` — `ContactStore`, `IdentityResolver`, `PolicyEngine`, `ThreadStore`, `MessageStore`, `WorkspaceStore` interfaces
- `packages/core/src/inbound.ts` — `InboundMessage` Zod schema (normalized cross-channel message)
- `packages/core/tests/identity.test.ts`
- `packages/core/tests/inbound.test.ts`
- `packages/storage-supabase/src/contact-store.ts`
- `packages/storage-supabase/src/identity-resolver.ts`
- `packages/storage-supabase/src/policy-engine.ts`
- `packages/storage-supabase/src/thread-store.ts`
- `packages/storage-supabase/src/message-store.ts`
- `packages/storage-supabase/src/workspace-store.ts`
- `packages/storage-supabase/tests/contact-store.test.ts`
- `packages/storage-supabase/tests/identity-resolver.test.ts`
- `packages/storage-supabase/tests/policy-engine.test.ts`
- `packages/storage-supabase/tests/thread-store.test.ts`
- `packages/storage-supabase/tests/message-store.test.ts`
- `packages/storage-supabase/sql/0002_apply_phase0_schema.sql` — Supabase-flavoured version of the Postgres schema (idempotent, runnable via SQL editor)
- `packages/transport-telegram/src/normalize.ts` — `telegramUpdateToInbound(update)` pure function
- `packages/transport-telegram/tests/normalize.test.ts`
- `packages/api/src/router.ts` — `processInbound(msg)` orchestrator (pre-router + identity + policy + persist)
- `packages/api/src/forwarders/bridge.ts` — `forwardToBridge(url, raw)` HTTP POST
- `packages/api/tests/router.test.ts`
- `packages/api/tests/forwarders-bridge.test.ts`
- `docs/superpowers/runbooks/2026-05-20-phase-1a-webhook-cutover.md` — operational runbook for Task 41

**Modified:**
- `packages/core/src/index.ts` — add re-exports of identity, stores, inbound
- `packages/api/src/registry.ts` — extend `ToolContext` with `messageStore?: MessageStore`, `workspaceId?: string`
- `packages/api/src/server.ts` — pass `messageStore` and `workspaceId` into `ToolContext`
- `packages/api/src/tools/messaging.ts` — `read_inbox`, `wait_for_messages`, `get_thread` read from `messageStore` when present, else fall back to `transport.receive()` (preserves CLI / self-host stdio mode)
- `packages/api/src/cli/serve-http.ts` — bootstrap stores, register `/telegram-webhook` endpoint, build server with `messageStore`
- `packages/storage-supabase/src/index.ts` — re-export new stores
- `packages/api/package.json` — no new deps (uses existing `zod`, `pino`, native `fetch`)

**Untouched:**
- `packages/mcp/*` — deprecated, deleted in Phase 0 G9
- `apps/cli/src/index.ts` — already dispatches to `@agent-mouth/api/cli/*`
- `packages/transport-telegram/src/telegram-transport.ts` — keeps long-polling for self-host stdio mode (only the webhook path replaces it in cloud)

---

## Group A — Domain types in `@agent-mouth/core`

### Task 1: Add identity Zod schemas to core

**Files:**
- Create: `packages/core/src/identity.ts`
- Test: `packages/core/tests/identity.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
    expect(WorkspaceSchema.parse(w)).toEqual(w);
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
    expect(PolicySchema.parse(p)).toEqual(p);
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
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @agent-mouth/core test
```
Expected: FAIL with "Cannot find module '../src/identity.js'".

- [ ] **Step 3: Implement schemas**

```typescript
// packages/core/src/identity.ts
import { z } from "zod";

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  owner_user_id: z.string().uuid().nullable(),
  plan: z.string().default("self-host"),
  created_at: z.string().datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const ContactSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  display_name: z.string().min(1),
  notes: z.string().default(""),
  created_at: z.string().datetime(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ChannelTypeEnum = z.enum(["telegram", "email", "whatsapp", "discord", "slack"]);
export type ChannelType = z.infer<typeof ChannelTypeEnum>;

export const ChannelSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  type: ChannelTypeEnum,
  config: z.record(z.unknown()),
  status: z.enum(["active", "paused", "error"]).default("active"),
  created_at: z.string().datetime(),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const ChannelIdentitySchema = z.object({
  id: z.string().uuid(),
  contact_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  identifier: z.string().min(1),
  verified: z.boolean().default(false),
});
export type ChannelIdentity = z.infer<typeof ChannelIdentitySchema>;

export const PolicyActionEnum = z.enum(["auto", "suggest", "escalate", "silent"]);
export type PolicyAction = z.infer<typeof PolicyActionEnum>;

export const PolicySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  contact_id: z.string().uuid().nullable(),
  channel_type: ChannelTypeEnum.nullable(),
  policy: PolicyActionEnum,
  system_prompt: z.string().default(""),
  rules: z.record(z.unknown()).default({}),
  priority: z.number().int().default(0),
  created_at: z.string().datetime(),
});
export type Policy = z.infer<typeof PolicySchema>;

export const ThreadSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  external_thread_id: z.string().nullable(),
  related_thread_ids: z.array(z.string().uuid()).default([]),
  last_message_at: z.string().datetime().nullable(),
  closed: z.boolean().default(false),
  created_at: z.string().datetime(),
});
export type Thread = z.infer<typeof ThreadSchema>;
```

- [ ] **Step 4: Run test, verify pass**

```
pnpm --filter @agent-mouth/core test
```
Expected: 6 new tests pass (10 total in core).

- [ ] **Step 5: Re-export from core index**

```typescript
// packages/core/src/index.ts — add line
export * from "./identity.js";
```

- [ ] **Step 6: Commit**

```
git add packages/core/src/identity.ts packages/core/tests/identity.test.ts packages/core/src/index.ts
git commit -m "feat(core): add identity domain schemas (Contact, Channel, Policy, Thread, Workspace)"
```

---

### Task 2: Add InboundMessage normalized schema to core

**Files:**
- Create: `packages/core/src/inbound.ts`
- Test: `packages/core/tests/inbound.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/tests/inbound.test.ts
import { describe, it, expect } from "vitest";
import { InboundMessageSchema } from "../src/inbound.js";

describe("InboundMessageSchema", () => {
  it("parses a minimal telegram inbound", () => {
    const msg = {
      channel_type: "telegram",
      external_message_id: "42",
      external_thread_id: "-5286864201",
      sender_identifier: "987654321",
      sender_display_name: "Gavrilo",
      sender_handle: null,
      chat_type: "private",
      content: "hola",
      attachments: [],
      raw_payload: { update_id: 1, message: { message_id: 42 } },
      received_at: "2026-05-20T14:46:49Z",
    };
    expect(InboundMessageSchema.parse(msg)).toEqual(msg);
  });

  it("requires content non-empty", () => {
    expect(() =>
      InboundMessageSchema.parse({
        channel_type: "telegram", external_message_id: "1", external_thread_id: "1",
        sender_identifier: "1", sender_display_name: "x", sender_handle: null,
        chat_type: "private", content: "", attachments: [], raw_payload: {},
        received_at: "2026-05-20T00:00:00Z",
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Verify failure**

```
pnpm --filter @agent-mouth/core test
```

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/inbound.ts
import { z } from "zod";
import { ChannelTypeEnum } from "./identity.js";

export const InboundMessageSchema = z.object({
  channel_type: ChannelTypeEnum,
  external_message_id: z.string().min(1),
  external_thread_id: z.string().min(1),
  sender_identifier: z.string().min(1),
  sender_display_name: z.string().min(1),
  sender_handle: z.string().nullable(),
  chat_type: z.enum(["private", "group", "supergroup", "channel"]),
  content: z.string().min(1),
  attachments: z.array(z.record(z.unknown())).default([]),
  raw_payload: z.record(z.unknown()),
  received_at: z.string().datetime(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
```

- [ ] **Step 4: Re-export**

```typescript
// packages/core/src/index.ts — add line
export * from "./inbound.js";
```

- [ ] **Step 5: Run tests, verify pass**

- [ ] **Step 6: Commit**

```
git commit -am "feat(core): add InboundMessage cross-channel schema"
```

---

### Task 3: Add store interfaces to core

**Files:**
- Create: `packages/core/src/stores.ts`

- [ ] **Step 1: Write interfaces (no test — interfaces have no runtime behaviour; type-check is the verification)**

```typescript
// packages/core/src/stores.ts
import type { Workspace, Contact, ChannelIdentity, Channel, Policy, Thread } from "./identity.js";
import type { InboundMessage } from "./inbound.js";

export interface WorkspaceStore {
  getDefault(): Promise<Workspace>;
}

export interface ContactStore {
  findById(workspaceId: string, id: string): Promise<Contact | null>;
  upsertByDisplayName(workspaceId: string, displayName: string): Promise<Contact>;
}

export interface IdentityResolveResult {
  contact: Contact;
  channel: Channel;
  channel_identity: ChannelIdentity;
  created: boolean;
}

export interface IdentityResolver {
  resolveOrCreate(args: {
    workspaceId: string;
    channelType: Channel["type"];
    identifier: string;
    displayName: string;
  }): Promise<IdentityResolveResult>;
}

export interface PolicyEngine {
  evaluate(args: {
    workspaceId: string;
    contactId: string;
    channelType: Channel["type"];
  }): Promise<Policy>;
}

export interface ThreadStore {
  resolveOrCreate(args: {
    workspaceId: string;
    contactId: string;
    channelId: string;
    externalThreadId: string;
  }): Promise<Thread>;
}

export interface PersistedMessageInput {
  threadId: string;
  channelId: string;
  channelIdentityId: string | null;
  direction: "inbound" | "outbound";
  content: string;
  attachments: Array<Record<string, unknown>>;
  rawPayload: Record<string, unknown> | null;
  externalMessageId: string | null;
  sentBy: "human" | "agent" | null;
}

export interface PersistedMessage {
  id: string;
  thread_id: string;
  channel_id: string;
  channel_identity_id: string | null;
  direction: "inbound" | "outbound";
  content: string;
  attachments: Array<Record<string, unknown>>;
  raw_payload: Record<string, unknown> | null;
  external_message_id: string | null;
  sent_by: "human" | "agent" | null;
  created_at: string;
}

export interface MessageStore {
  insert(msg: PersistedMessageInput): Promise<PersistedMessage>;
  listRecent(args: {
    workspaceId: string;
    threadId?: string;
    sinceId?: string;
    limit: number;
  }): Promise<PersistedMessage[]>;
  waitForNew(args: {
    workspaceId: string;
    sinceCreatedAt: string;
    timeoutSeconds: number;
  }): Promise<PersistedMessage[]>;
}
```

- [ ] **Step 2: Re-export**

```typescript
// packages/core/src/index.ts — add line
export * from "./stores.js";
```

- [ ] **Step 3: Build core, verify compile**

```
pnpm --filter @agent-mouth/core build
```
Expected: no TS errors.

- [ ] **Step 4: Commit**

```
git commit -am "feat(core): add store interfaces (ContactStore, IdentityResolver, PolicyEngine, ThreadStore, MessageStore, WorkspaceStore)"
```

---

## Group B — Supabase schema migration

### Task 4: Author the Supabase migration SQL

**Files:**
- Create: `packages/storage-supabase/sql/0002_apply_phase0_schema.sql`

This file mirrors `packages/storage-postgres/sql/0001_initial.sql` but is **idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) and adds the `agent_mouth_offsets` table for the existing `SupabaseOffsetStore` if missing.

- [ ] **Step 1: Write the migration**

```sql
-- packages/storage-supabase/sql/0002_apply_phase0_schema.sql
-- Run via Supabase SQL Editor on the agent-mouth project. Idempotent.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID,
  plan TEXT NOT NULL DEFAULT 'self-host',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL CHECK (type IN ('telegram','email','whatsapp','discord','slack')),
  config JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  display_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contact_ws_name ON contacts(workspace_id, display_name);

CREATE TABLE IF NOT EXISTS channel_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id),
  channel_id UUID NOT NULL REFERENCES channels(id),
  identifier TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (channel_id, identifier)
);

CREATE TABLE IF NOT EXISTS policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  contact_id UUID REFERENCES contacts(id),
  channel_type TEXT,
  policy TEXT NOT NULL CHECK (policy IN ('auto','suggest','escalate','silent')),
  system_prompt TEXT NOT NULL DEFAULT '',
  rules JSONB NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_policies_resolution
  ON policies(workspace_id, contact_id, channel_type, priority DESC);

CREATE TABLE IF NOT EXISTS threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  contact_id UUID NOT NULL REFERENCES contacts(id),
  channel_id UUID NOT NULL REFERENCES channels(id),
  external_thread_id TEXT,
  related_thread_ids UUID[] NOT NULL DEFAULT '{}',
  last_message_at TIMESTAMPTZ,
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_thread_channel_external
  ON threads(channel_id, external_thread_id);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id),
  channel_id UUID NOT NULL REFERENCES channels(id),
  channel_identity_id UUID REFERENCES channel_identities(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  content TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]',
  raw_payload JSONB,
  external_message_id TEXT,
  sent_by TEXT CHECK (sent_by IN ('human','agent') OR sent_by IS NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ws_created ON messages(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id),
  proposed_body TEXT NOT NULL,
  agent_reasoning TEXT NOT NULL DEFAULT '',
  tools_called JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','edited')),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('human','agent','system')),
  details JSONB NOT NULL DEFAULT '{}',
  related_message_id UUID REFERENCES messages(id),
  related_contact_id UUID REFERENCES contacts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_created ON audit_log(workspace_id, created_at DESC);

-- The existing offset store table (was created ad-hoc during Phase 0)
CREATE TABLE IF NOT EXISTS agent_mouth_offsets (
  handle TEXT PRIMARY KEY,
  update_id BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Commit**

```
git add packages/storage-supabase/sql/0002_apply_phase0_schema.sql
git commit -m "feat(storage-supabase): add Supabase migration SQL for Phase 1a schema"
```

---

### Task 5: Apply migration to Supabase (manual)

This is a **manual operational step**. No code commit.

- [ ] **Step 1: Open Supabase SQL editor**

URL: https://supabase.com/dashboard/project/<project-id>/sql/new (the user knows which project; from Phase 0).

- [ ] **Step 2: Paste contents of `packages/storage-supabase/sql/0002_apply_phase0_schema.sql` and run**

Expected: "Success. No rows returned." If a CREATE TABLE conflicts, the `IF NOT EXISTS` should swallow it. If a column conflict surfaces, stop and reconcile.

- [ ] **Step 3: Verify tables**

In SQL editor:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' ORDER BY table_name;
```
Expected output includes: `agent_mouth_offsets, audit_log, channel_identities, channels, contacts, drafts, messages, policies, threads, users, workspaces` (11 tables).

- [ ] **Step 4: Confirm operationally with the user before proceeding to Task 6**

---

### Task 6: Seed minimal workspace + Gavrilo contact

This is a **manual one-time seed** so the resolver has something to find before we ship code that auto-creates. No commit.

- [ ] **Step 1: Run seed SQL in Supabase SQL editor**

```sql
-- Default workspace
INSERT INTO workspaces (id, name, plan)
VALUES ('11111111-1111-1111-1111-111111111111', 'default', 'self-host')
ON CONFLICT (id) DO NOTHING;

-- Telegram channel (matches the production bot)
INSERT INTO channels (id, workspace_id, type, config, status)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'telegram',
  '{"handle":"Gavrilux_bot"}'::jsonb,
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- Default catch-all policy: silent (persist only, no agent action)
INSERT INTO policies (id, workspace_id, contact_id, channel_type, policy, priority)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  '11111111-1111-1111-1111-111111111111',
  NULL, NULL, 'silent', 0
)
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Note the UUIDs**

`WORKSPACE_ID=11111111-1111-1111-1111-111111111111`
`TELEGRAM_CHANNEL_ID=22222222-2222-2222-2222-222222222222`

These get set as Fly secrets in Task 38.

---

## Group C — SupabaseWorkspaceStore + SupabaseContactStore

### Task 7: SupabaseWorkspaceStore tests

**Files:**
- Create: `packages/storage-supabase/src/workspace-store.ts`
- Create: `packages/storage-supabase/tests/workspace-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/storage-supabase/tests/workspace-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseWorkspaceStore } from "../src/workspace-store.js";

describe("SupabaseWorkspaceStore", () => {
  const SUPA_URL = "https://x.supabase.co";
  const KEY = "anon-key";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("getDefault returns the default workspace by name", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: "11111111-1111-1111-1111-111111111111", name: "default", owner_user_id: null, plan: "self-host", created_at: "2026-05-20T00:00:00Z" },
      ]), { status: 200 }),
    );
    const store = new SupabaseWorkspaceStore(SUPA_URL, KEY);
    const w = await store.getDefault();
    expect(w.name).toBe("default");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/rest\/v1\/workspaces\?name=eq\.default&select=\*&limit=1/),
      expect.objectContaining({ headers: expect.objectContaining({ apikey: KEY }) }),
    );
  });

  it("throws when no default workspace exists", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const store = new SupabaseWorkspaceStore(SUPA_URL, KEY);
    await expect(store.getDefault()).rejects.toThrow(/no default workspace/i);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```
pnpm --filter @agent-mouth/storage-supabase test
```

- [ ] **Step 3: Implement**

```typescript
// packages/storage-supabase/src/workspace-store.ts
import type { Workspace, WorkspaceStore } from "@agent-mouth/core";
import { WorkspaceSchema } from "@agent-mouth/core";

export class SupabaseWorkspaceStore implements WorkspaceStore {
  constructor(private readonly url: string, private readonly key: string) {}

  private headers() {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
  }

  async getDefault(): Promise<Workspace> {
    const res = await fetch(
      `${this.url}/rest/v1/workspaces?name=eq.default&select=*&limit=1`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    if (rows.length === 0) throw new Error("no default workspace seeded");
    return WorkspaceSchema.parse(rows[0]);
  }
}
```

- [ ] **Step 4: Add to barrel**

```typescript
// packages/storage-supabase/src/index.ts — add line
export { SupabaseWorkspaceStore } from "./workspace-store.js";
```

- [ ] **Step 5: Run tests, verify pass**

- [ ] **Step 6: Commit**

```
git commit -am "feat(storage-supabase): SupabaseWorkspaceStore + tests"
```

---

### Task 8: SupabaseContactStore

**Files:**
- Create: `packages/storage-supabase/src/contact-store.ts`
- Create: `packages/storage-supabase/tests/contact-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/storage-supabase/tests/contact-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseContactStore } from "../src/contact-store.js";

describe("SupabaseContactStore", () => {
  const SUPA_URL = "https://x.supabase.co";
  const KEY = "anon-key";
  const WS = "11111111-1111-1111-1111-111111111111";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("findById returns null for missing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const store = new SupabaseContactStore(SUPA_URL, KEY);
    expect(await store.findById(WS, "00000000-0000-0000-0000-000000000999")).toBeNull();
  });

  it("upsertByDisplayName POSTs with merge-duplicates Prefer header", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: "00000000-0000-0000-0000-000000000001", workspace_id: WS, display_name: "Gavrilo", notes: "", created_at: "2026-05-20T00:00:00Z" },
      ]), { status: 201 }),
    );
    const store = new SupabaseContactStore(SUPA_URL, KEY);
    const c = await store.upsertByDisplayName(WS, "Gavrilo");
    expect(c.display_name).toBe("Gavrilo");
    expect(fetchMock).toHaveBeenCalledWith(
      `${SUPA_URL}/rest/v1/contacts?on_conflict=workspace_id,display_name`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Prefer: "resolution=merge-duplicates,return=representation",
        }),
        body: JSON.stringify({ workspace_id: WS, display_name: "Gavrilo", notes: "" }),
      }),
    );
  });
});
```

- [ ] **Step 2: Verify failure, then implement**

```typescript
// packages/storage-supabase/src/contact-store.ts
import type { Contact, ContactStore } from "@agent-mouth/core";
import { ContactSchema } from "@agent-mouth/core";

export class SupabaseContactStore implements ContactStore {
  constructor(private readonly url: string, private readonly key: string) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async findById(workspaceId: string, id: string): Promise<Contact | null> {
    const url = `${this.url}/rest/v1/contacts?id=eq.${id}&workspace_id=eq.${workspaceId}&select=*&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`contact fetch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length ? ContactSchema.parse(rows[0]) : null;
  }

  async upsertByDisplayName(workspaceId: string, displayName: string): Promise<Contact> {
    const url = `${this.url}/rest/v1/contacts?on_conflict=workspace_id,display_name`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ Prefer: "resolution=merge-duplicates,return=representation" }),
      body: JSON.stringify({ workspace_id: workspaceId, display_name: displayName, notes: "" }),
    });
    if (!res.ok) throw new Error(`contact upsert failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[];
    return ContactSchema.parse(rows[0]);
  }
}
```

- [ ] **Step 3: Add to barrel**

```typescript
// packages/storage-supabase/src/index.ts — add line
export { SupabaseContactStore } from "./contact-store.js";
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```
git commit -am "feat(storage-supabase): SupabaseContactStore with upsert by display_name"
```

---

## Group D — SupabaseIdentityResolver

### Task 9: SupabaseIdentityResolver tests

**Files:**
- Create: `packages/storage-supabase/src/identity-resolver.ts`
- Create: `packages/storage-supabase/tests/identity-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/storage-supabase/tests/identity-resolver.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseIdentityResolver } from "../src/identity-resolver.js";

const SUPA_URL = "https://x.supabase.co";
const KEY = "anon-key";
const WS = "11111111-1111-1111-1111-111111111111";
const CHAN = "22222222-2222-2222-2222-222222222222";
const CONTACT = "00000000-0000-0000-0000-000000000001";
const IDENT = "00000000-0000-0000-0000-000000000010";

describe("SupabaseIdentityResolver", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns existing identity without creating", async () => {
    // 1) lookup channel by workspace+type
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: CHAN, workspace_id: WS, type: "telegram", config: {}, status: "active", created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 200 }));
    // 2) lookup channel_identity by channel+identifier
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: IDENT, contact_id: CONTACT, channel_id: CHAN, identifier: "987654321", verified: false },
    ]), { status: 200 }));
    // 3) lookup contact by id
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: CONTACT, workspace_id: WS, display_name: "Gavrilo", notes: "", created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 200 }));

    const r = new SupabaseIdentityResolver(SUPA_URL, KEY);
    const out = await r.resolveOrCreate({
      workspaceId: WS, channelType: "telegram", identifier: "987654321", displayName: "Gavrilo",
    });
    expect(out.created).toBe(false);
    expect(out.contact.display_name).toBe("Gavrilo");
    expect(out.channel.type).toBe("telegram");
    expect(out.channel_identity.identifier).toBe("987654321");
  });

  it("auto-creates contact + identity when identity missing", async () => {
    // 1) channel
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: CHAN, workspace_id: WS, type: "telegram", config: {}, status: "active", created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 200 }));
    // 2) identity lookup: empty
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    // 3) upsert contact
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: CONTACT, workspace_id: WS, display_name: "NewUser", notes: "", created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 201 }));
    // 4) insert identity
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: IDENT, contact_id: CONTACT, channel_id: CHAN, identifier: "555", verified: false },
    ]), { status: 201 }));

    const r = new SupabaseIdentityResolver(SUPA_URL, KEY);
    const out = await r.resolveOrCreate({
      workspaceId: WS, channelType: "telegram", identifier: "555", displayName: "NewUser",
    });
    expect(out.created).toBe(true);
  });

  it("throws if no telegram channel configured for workspace", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const r = new SupabaseIdentityResolver(SUPA_URL, KEY);
    await expect(
      r.resolveOrCreate({ workspaceId: WS, channelType: "telegram", identifier: "1", displayName: "x" }),
    ).rejects.toThrow(/no telegram channel/i);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/storage-supabase/src/identity-resolver.ts
import type {
  Channel, ChannelIdentity, Contact,
  IdentityResolver, IdentityResolveResult,
} from "@agent-mouth/core";
import {
  ChannelSchema, ChannelIdentitySchema, ContactSchema,
} from "@agent-mouth/core";
import { SupabaseContactStore } from "./contact-store.js";

export class SupabaseIdentityResolver implements IdentityResolver {
  private contacts: SupabaseContactStore;
  constructor(private readonly url: string, private readonly key: string) {
    this.contacts = new SupabaseContactStore(url, key);
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async resolveOrCreate(args: {
    workspaceId: string;
    channelType: Channel["type"];
    identifier: string;
    displayName: string;
  }): Promise<IdentityResolveResult> {
    const channel = await this.findChannel(args.workspaceId, args.channelType);
    if (!channel) throw new Error(`no ${args.channelType} channel configured for workspace ${args.workspaceId}`);

    const existing = await this.findIdentity(channel.id, args.identifier);
    if (existing) {
      const contact = await this.contacts.findById(args.workspaceId, existing.contact_id);
      if (!contact) throw new Error(`identity ${existing.id} references missing contact ${existing.contact_id}`);
      return { contact, channel, channel_identity: existing, created: false };
    }

    const contact = await this.contacts.upsertByDisplayName(args.workspaceId, args.displayName);
    const created = await this.createIdentity(contact.id, channel.id, args.identifier);
    return { contact, channel, channel_identity: created, created: true };
  }

  private async findChannel(workspaceId: string, type: Channel["type"]): Promise<Channel | null> {
    const url = `${this.url}/rest/v1/channels?workspace_id=eq.${workspaceId}&type=eq.${type}&select=*&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`channel fetch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length ? ChannelSchema.parse(rows[0]) : null;
  }

  private async findIdentity(channelId: string, identifier: string): Promise<ChannelIdentity | null> {
    const url = `${this.url}/rest/v1/channel_identities?channel_id=eq.${channelId}&identifier=eq.${encodeURIComponent(identifier)}&select=*&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`identity fetch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length ? ChannelIdentitySchema.parse(rows[0]) : null;
  }

  private async createIdentity(contactId: string, channelId: string, identifier: string): Promise<ChannelIdentity> {
    const url = `${this.url}/rest/v1/channel_identities`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({ contact_id: contactId, channel_id: channelId, identifier, verified: false }),
    });
    if (!res.ok) throw new Error(`identity create failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[];
    return ChannelIdentitySchema.parse(rows[0]);
  }
}
```

- [ ] **Step 3: Add to barrel + run tests + commit**

```typescript
// packages/storage-supabase/src/index.ts — add line
export { SupabaseIdentityResolver } from "./identity-resolver.js";
```

```
pnpm --filter @agent-mouth/storage-supabase test
git commit -am "feat(storage-supabase): SupabaseIdentityResolver (find-or-create contact + identity)"
```

---

## Group E — SupabasePolicyEngine

### Task 10: PolicyEngine with fallback chain

**Files:**
- Create: `packages/storage-supabase/src/policy-engine.ts`
- Create: `packages/storage-supabase/tests/policy-engine.test.ts`

The fallback chain: prefer most-specific row. Order: (contact_id=X AND channel_type=Y) > (contact_id=X AND channel_type=NULL) > (contact_id=NULL AND channel_type=Y) > (contact_id=NULL AND channel_type=NULL). Within ties, highest `priority` wins.

We can express that as one Supabase query with `or=(contact_id.eq.X,contact_id.is.null)` + `or=(channel_type.eq.Y,channel_type.is.null)` ordered by specificity then priority, take first.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/storage-supabase/tests/policy-engine.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabasePolicyEngine } from "../src/policy-engine.js";

const SUPA_URL = "https://x.supabase.co";
const KEY = "anon-key";
const WS = "11111111-1111-1111-1111-111111111111";
const CONTACT = "00000000-0000-0000-0000-000000000001";

describe("SupabasePolicyEngine", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns the most specific policy when multiple rows match", async () => {
    // Supabase returns rows ordered by our request. Most-specific first.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: "p1", workspace_id: WS, contact_id: CONTACT, channel_type: "telegram", policy: "auto", system_prompt: "", rules: {}, priority: 0, created_at: "2026-05-20T00:00:00Z" },
      { id: "p2", workspace_id: WS, contact_id: null, channel_type: null, policy: "silent", system_prompt: "", rules: {}, priority: 0, created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 200 }));

    const e = new SupabasePolicyEngine(SUPA_URL, KEY);
    const p = await e.evaluate({ workspaceId: WS, contactId: CONTACT, channelType: "telegram" });
    expect(p.policy).toBe("auto");
  });

  it("falls back to default policy=silent when no rows", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const e = new SupabasePolicyEngine(SUPA_URL, KEY);
    const p = await e.evaluate({ workspaceId: WS, contactId: CONTACT, channelType: "telegram" });
    expect(p.policy).toBe("silent");
    expect(p.id).toBe("00000000-0000-0000-0000-000000000000"); // synthetic default
  });

  it("builds the correct OR query for fallback", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const e = new SupabasePolicyEngine(SUPA_URL, KEY);
    await e.evaluate({ workspaceId: WS, contactId: CONTACT, channelType: "telegram" });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`workspace_id=eq.${WS}`);
    expect(calledUrl).toContain(`or=(contact_id.eq.${CONTACT},contact_id.is.null)`);
    expect(calledUrl).toContain(`or=(channel_type.eq.telegram,channel_type.is.null)`);
    // most-specific-first order: contact desc nulls last, channel_type desc nulls last, priority desc
    expect(calledUrl).toContain(`order=contact_id.desc.nullslast,channel_type.desc.nullslast,priority.desc`);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/storage-supabase/src/policy-engine.ts
import type { Policy, PolicyEngine, Channel } from "@agent-mouth/core";
import { PolicySchema } from "@agent-mouth/core";

const DEFAULT_POLICY: Policy = {
  id: "00000000-0000-0000-0000-000000000000",
  workspace_id: "00000000-0000-0000-0000-000000000000",
  contact_id: null,
  channel_type: null,
  policy: "silent",
  system_prompt: "",
  rules: {},
  priority: 0,
  created_at: "1970-01-01T00:00:00.000Z",
};

export class SupabasePolicyEngine implements PolicyEngine {
  constructor(private readonly url: string, private readonly key: string) {}

  private headers() {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
  }

  async evaluate(args: {
    workspaceId: string;
    contactId: string;
    channelType: Channel["type"];
  }): Promise<Policy> {
    const qs = new URLSearchParams();
    qs.set("workspace_id", `eq.${args.workspaceId}`);
    qs.append("or", `(contact_id.eq.${args.contactId},contact_id.is.null)`);
    qs.append("or", `(channel_type.eq.${args.channelType},channel_type.is.null)`);
    qs.set("select", "*");
    qs.set("order", "contact_id.desc.nullslast,channel_type.desc.nullslast,priority.desc");
    qs.set("limit", "1");

    const url = `${this.url}/rest/v1/policies?${qs.toString()}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`policy fetch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    if (rows.length === 0) return { ...DEFAULT_POLICY, workspace_id: args.workspaceId };
    return PolicySchema.parse(rows[0]);
  }
}
```

- [ ] **Step 3: Barrel + tests + commit**

```typescript
// packages/storage-supabase/src/index.ts — add line
export { SupabasePolicyEngine } from "./policy-engine.js";
```

```
pnpm --filter @agent-mouth/storage-supabase test
git commit -am "feat(storage-supabase): SupabasePolicyEngine with fallback chain"
```

---

## Group F — SupabaseThreadStore + SupabaseMessageStore

### Task 11: SupabaseThreadStore

**Files:**
- Create: `packages/storage-supabase/src/thread-store.ts`
- Create: `packages/storage-supabase/tests/thread-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/storage-supabase/tests/thread-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseThreadStore } from "../src/thread-store.js";

const SUPA_URL = "https://x.supabase.co";
const KEY = "anon-key";
const WS = "11111111-1111-1111-1111-111111111111";
const CONTACT = "00000000-0000-0000-0000-000000000001";
const CHAN = "22222222-2222-2222-2222-222222222222";

describe("SupabaseThreadStore", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("upserts a thread on (channel_id, external_thread_id) and returns it", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: "t1", workspace_id: WS, contact_id: CONTACT, channel_id: CHAN, external_thread_id: "-5286864201", related_thread_ids: [], last_message_at: null, closed: false, created_at: "2026-05-20T00:00:00Z" },
    ]), { status: 201 }));
    const s = new SupabaseThreadStore(SUPA_URL, KEY);
    const t = await s.resolveOrCreate({ workspaceId: WS, contactId: CONTACT, channelId: CHAN, externalThreadId: "-5286864201" });
    expect(t.external_thread_id).toBe("-5286864201");
    expect(fetchMock).toHaveBeenCalledWith(
      `${SUPA_URL}/rest/v1/threads?on_conflict=channel_id,external_thread_id`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Prefer: "resolution=merge-duplicates,return=representation" }),
      }),
    );
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/storage-supabase/src/thread-store.ts
import type { Thread, ThreadStore } from "@agent-mouth/core";
import { ThreadSchema } from "@agent-mouth/core";

export class SupabaseThreadStore implements ThreadStore {
  constructor(private readonly url: string, private readonly key: string) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async resolveOrCreate(args: {
    workspaceId: string;
    contactId: string;
    channelId: string;
    externalThreadId: string;
  }): Promise<Thread> {
    const url = `${this.url}/rest/v1/threads?on_conflict=channel_id,external_thread_id`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ Prefer: "resolution=merge-duplicates,return=representation" }),
      body: JSON.stringify({
        workspace_id: args.workspaceId,
        contact_id: args.contactId,
        channel_id: args.channelId,
        external_thread_id: args.externalThreadId,
      }),
    });
    if (!res.ok) throw new Error(`thread upsert failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[];
    return ThreadSchema.parse(rows[0]);
  }
}
```

- [ ] **Step 3: Barrel + tests + commit**

```typescript
// packages/storage-supabase/src/index.ts — add line
export { SupabaseThreadStore } from "./thread-store.js";
```

```
pnpm --filter @agent-mouth/storage-supabase test
git commit -am "feat(storage-supabase): SupabaseThreadStore with upsert on (channel_id, external_thread_id)"
```

---

### Task 12: SupabaseMessageStore — insert + listRecent

**Files:**
- Create: `packages/storage-supabase/src/message-store.ts`
- Create: `packages/storage-supabase/tests/message-store.test.ts`

- [ ] **Step 1: Write the failing test (insert + listRecent only; waitForNew comes in Task 13)**

```typescript
// packages/storage-supabase/tests/message-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseMessageStore } from "../src/message-store.js";

const SUPA_URL = "https://x.supabase.co";
const KEY = "anon-key";
const WS = "11111111-1111-1111-1111-111111111111";
const THREAD = "00000000-0000-0000-0000-0000000000a1";
const CHAN = "22222222-2222-2222-2222-222222222222";

describe("SupabaseMessageStore", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("insert POSTs to messages and returns the row", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      {
        id: "m1", thread_id: THREAD, channel_id: CHAN, channel_identity_id: null,
        direction: "inbound", content: "hola", attachments: [], raw_payload: { x: 1 },
        external_message_id: "42", sent_by: null, created_at: "2026-05-20T00:00:00Z",
      },
    ]), { status: 201 }));

    const s = new SupabaseMessageStore(SUPA_URL, KEY);
    const m = await s.insert({
      threadId: THREAD, channelId: CHAN, channelIdentityId: null,
      direction: "inbound", content: "hola", attachments: [],
      rawPayload: { x: 1 }, externalMessageId: "42", sentBy: null,
    });
    expect(m.id).toBe("m1");
    expect(fetchMock).toHaveBeenCalledWith(
      `${SUPA_URL}/rest/v1/messages`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Prefer: "return=representation" }),
      }),
    );
  });

  it("listRecent filters by threadId, sinceId, limit", async () => {
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const s = new SupabaseMessageStore(SUPA_URL, KEY);
    await s.listRecent({ workspaceId: WS, threadId: THREAD, sinceId: "m0", limit: 10 });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`thread_id=eq.${THREAD}`);
    expect(calledUrl).toContain("id=gt.m0");
    expect(calledUrl).toContain("limit=10");
    expect(calledUrl).toContain("order=created_at.desc");
  });
});
```

- [ ] **Step 2: Implement (insert + listRecent stub for waitForNew)**

```typescript
// packages/storage-supabase/src/message-store.ts
import type { MessageStore, PersistedMessage, PersistedMessageInput } from "@agent-mouth/core";

export class SupabaseMessageStore implements MessageStore {
  constructor(private readonly url: string, private readonly key: string) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async insert(msg: PersistedMessageInput): Promise<PersistedMessage> {
    const res = await fetch(`${this.url}/rest/v1/messages`, {
      method: "POST",
      headers: this.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        thread_id: msg.threadId,
        channel_id: msg.channelId,
        channel_identity_id: msg.channelIdentityId,
        direction: msg.direction,
        content: msg.content,
        attachments: msg.attachments,
        raw_payload: msg.rawPayload,
        external_message_id: msg.externalMessageId,
        sent_by: msg.sentBy,
      }),
    });
    if (!res.ok) throw new Error(`message insert failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as PersistedMessage[];
    return rows[0];
  }

  async listRecent(args: {
    workspaceId: string;
    threadId?: string;
    sinceId?: string;
    limit: number;
  }): Promise<PersistedMessage[]> {
    const qs = new URLSearchParams();
    qs.set("select", "*");
    if (args.threadId) qs.set("thread_id", `eq.${args.threadId}`);
    if (args.sinceId) qs.set("id", `gt.${args.sinceId}`);
    qs.set("order", "created_at.desc");
    qs.set("limit", String(args.limit));
    const res = await fetch(`${this.url}/rest/v1/messages?${qs.toString()}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`message list failed: ${res.status}`);
    return (await res.json()) as PersistedMessage[];
  }

  async waitForNew(): Promise<PersistedMessage[]> {
    throw new Error("not implemented yet — Task 13");
  }
}
```

- [ ] **Step 3: Barrel + tests + commit**

```typescript
// packages/storage-supabase/src/index.ts — add line
export { SupabaseMessageStore } from "./message-store.js";
```

```
pnpm --filter @agent-mouth/storage-supabase test
git commit -am "feat(storage-supabase): SupabaseMessageStore insert + listRecent"
```

---

### Task 13: SupabaseMessageStore — waitForNew (polling-based)

Polling loop: every 2 s, query messages with `created_at > sinceCreatedAt`. Return on first hit or timeout.

- [ ] **Step 1: Write the failing test**

```typescript
// add to packages/storage-supabase/tests/message-store.test.ts

it("waitForNew polls until new messages appear or timeout fires", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response("[]", { status: 200 }))     // poll 1: nothing
    .mockResolvedValueOnce(new Response(JSON.stringify([            // poll 2: hit
      { id: "m2", thread_id: "t", channel_id: "c", channel_identity_id: null,
        direction: "inbound", content: "yo", attachments: [], raw_payload: null,
        external_message_id: "43", sent_by: null, created_at: "2026-05-20T00:00:01Z" },
    ]), { status: 200 }));

  const s = new SupabaseMessageStore(SUPA_URL, KEY);
  // Compress polling to make the test fast.
  (s as unknown as { pollIntervalMs: number }).pollIntervalMs = 5;
  const out = await s.waitForNew({
    workspaceId: WS, sinceCreatedAt: "2026-05-20T00:00:00Z", timeoutSeconds: 1,
  });
  expect(out).toHaveLength(1);
  expect(out[0].content).toBe("yo");
});

it("waitForNew returns empty array on timeout", async () => {
  fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));
  const s = new SupabaseMessageStore(SUPA_URL, KEY);
  (s as unknown as { pollIntervalMs: number }).pollIntervalMs = 5;
  const out = await s.waitForNew({
    workspaceId: WS, sinceCreatedAt: "2026-05-20T00:00:00Z", timeoutSeconds: 0,
  });
  expect(out).toEqual([]);
});
```

- [ ] **Step 2: Implement waitForNew**

```typescript
// inside SupabaseMessageStore, replace waitForNew

protected pollIntervalMs = 2000;

async waitForNew(args: {
  workspaceId: string;
  sinceCreatedAt: string;
  timeoutSeconds: number;
}): Promise<PersistedMessage[]> {
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const qs = new URLSearchParams();
    qs.set("select", "*");
    qs.set("created_at", `gt.${args.sinceCreatedAt}`);
    qs.set("order", "created_at.asc");
    qs.set("limit", "50");
    const res = await fetch(`${this.url}/rest/v1/messages?${qs.toString()}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`message poll failed: ${res.status}`);
    const rows = (await res.json()) as PersistedMessage[];
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, this.pollIntervalMs));
  }
  return [];
}
```

Note: change `private` to `protected pollIntervalMs = 2000` so tests can override it.

- [ ] **Step 3: Run tests, commit**

```
pnpm --filter @agent-mouth/storage-supabase test
git commit -am "feat(storage-supabase): SupabaseMessageStore.waitForNew polling implementation"
```

---

## Group G — Telegram update normalization

### Task 14: telegramUpdateToInbound pure function

**Files:**
- Create: `packages/transport-telegram/src/normalize.ts`
- Create: `packages/transport-telegram/tests/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/transport-telegram/tests/normalize.test.ts
import { describe, it, expect } from "vitest";
import { telegramUpdateToInbound } from "../src/normalize.js";

describe("telegramUpdateToInbound", () => {
  it("normalizes a private text message", () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 42,
        from: { id: 987654321, is_bot: false, first_name: "Gavrilo", username: "gavri" },
        chat: { id: 987654321, type: "private", first_name: "Gavrilo" },
        date: 1779290809,
        text: "hola",
      },
    };
    const out = telegramUpdateToInbound(update);
    expect(out).toMatchObject({
      channel_type: "telegram",
      external_message_id: "42",
      external_thread_id: "987654321",
      sender_identifier: "987654321",
      sender_display_name: "Gavrilo",
      sender_handle: "gavri",
      chat_type: "private",
      content: "hola",
    });
    expect(out!.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("normalizes a group message; thread_id is chat.id", () => {
    const update = {
      update_id: 2,
      message: {
        message_id: 99,
        from: { id: 111, is_bot: false, first_name: "Marco" },
        chat: { id: -5286864201, type: "group", title: "The Cuina LAB" },
        date: 1779290900,
        text: "@Gavrilux_bot test",
      },
    };
    const out = telegramUpdateToInbound(update);
    expect(out!.external_thread_id).toBe("-5286864201");
    expect(out!.chat_type).toBe("group");
  });

  it("returns null for non-message updates (e.g. edited_message we skip for Phase 1a)", () => {
    expect(telegramUpdateToInbound({ update_id: 3, edited_message: {} as unknown })).toBeNull();
  });

  it("returns null for messages without text (sticker, etc.)", () => {
    const update = {
      update_id: 4,
      message: { message_id: 50, from: { id: 1, is_bot: false, first_name: "x" }, chat: { id: 1, type: "private" }, date: 0 },
    };
    expect(telegramUpdateToInbound(update)).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/transport-telegram/src/normalize.ts
import type { InboundMessage } from "@agent-mouth/core";

interface TgUser { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string }
interface TgChat { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string; first_name?: string; last_name?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; date: number; text?: string }
interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: unknown }

export function telegramUpdateToInbound(update: TgUpdate): InboundMessage | null {
  const m = update.message;
  if (!m || !m.from || typeof m.text !== "string") return null;
  const displayName = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || String(m.from.id);
  return {
    channel_type: "telegram",
    external_message_id: String(m.message_id),
    external_thread_id: String(m.chat.id),
    sender_identifier: String(m.from.id),
    sender_display_name: displayName,
    sender_handle: m.from.username ?? null,
    chat_type: m.chat.type,
    content: m.text,
    attachments: [],
    raw_payload: update as unknown as Record<string, unknown>,
    received_at: new Date(m.date * 1000).toISOString(),
  };
}
```

- [ ] **Step 3: Run tests, commit**

```
pnpm --filter @agent-mouth/transport-telegram test
git commit -am "feat(transport-telegram): telegramUpdateToInbound normalizer + tests"
```

---

## Group H — Bridge forwarder

### Task 15: Bridge forwarder

**Files:**
- Create: `packages/api/src/forwarders/bridge.ts`
- Create: `packages/api/tests/forwarders-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/tests/forwarders-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { forwardToBridge } from "../src/forwarders/bridge.js";

describe("forwardToBridge", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("POSTs the raw payload as JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const ok = await forwardToBridge("https://lab.example/webhook", { update_id: 1 });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://lab.example/webhook", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    }));
  });

  it("returns false on non-2xx and does not throw", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 502 }));
    expect(await forwardToBridge("https://lab.example/webhook", {})).toBe(false);
  });

  it("returns false on network error and does not throw", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await forwardToBridge("https://lab.example/webhook", {})).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/api/src/forwarders/bridge.ts
import { logger } from "../logger.js";

export async function forwardToBridge(url: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, url }, "bridge forward non-2xx");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, url }, "bridge forward failed");
    return false;
  }
}
```

- [ ] **Step 3: Run tests, commit**

```
pnpm --filter @agent-mouth/api test
git commit -am "feat(api): bridge forwarder with graceful failure"
```

---

## Group I — Router orchestrator

### Task 16: Router processInbound

**Files:**
- Create: `packages/api/src/router.ts`
- Create: `packages/api/tests/router.test.ts`

`processInbound` decides:
1. If `external_thread_id` is in `BRIDGE_FORWARD_CHATS` → forward to `BRIDGE_FORWARD_URL`, return `{ kind: "forwarded" }`. Do not persist.
2. Else → resolve contact + identity → resolve thread → evaluate policy → persist. Return `{ kind: "persisted", policy, messageId }`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/tests/router.test.ts
import { describe, it, expect, vi } from "vitest";
import { processInbound, type RouterDeps } from "../src/router.js";

const WS = "11111111-1111-1111-1111-111111111111";
const CONTACT = "00000000-0000-0000-0000-000000000001";
const CHAN = "22222222-2222-2222-2222-222222222222";
const IDENT = "00000000-0000-0000-0000-000000000010";
const THREAD = "00000000-0000-0000-0000-0000000000a1";

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
        contact: { id: CONTACT, workspace_id: WS, display_name: "Gavrilo", notes: "", created_at: "2026-05-20T00:00:00Z" },
        channel: { id: CHAN, workspace_id: WS, type: "telegram", config: {}, status: "active", created_at: "2026-05-20T00:00:00Z" },
        channel_identity: { id: IDENT, contact_id: CONTACT, channel_id: CHAN, identifier: "987654321", verified: false },
        created: false,
      }),
    },
    threadStore: {
      resolveOrCreate: vi.fn().mockResolvedValue({
        id: THREAD, workspace_id: WS, contact_id: CONTACT, channel_id: CHAN,
        external_thread_id: "987654321", related_thread_ids: [], last_message_at: null, closed: false,
        created_at: "2026-05-20T00:00:00Z",
      }),
    },
    policyEngine: {
      evaluate: vi.fn().mockResolvedValue({
        id: "p1", workspace_id: WS, contact_id: null, channel_type: null,
        policy: "silent", system_prompt: "", rules: {}, priority: 0, created_at: "2026-05-20T00:00:00Z",
      }),
    },
    messageStore: {
      insert: vi.fn().mockResolvedValue({
        id: "m1", thread_id: THREAD, channel_id: CHAN, channel_identity_id: IDENT,
        direction: "inbound", content: "hola", attachments: [], raw_payload: { update_id: 1 },
        external_message_id: "42", sent_by: null, created_at: "2026-05-20T00:00:00Z",
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
    expect(out).toMatchObject({ kind: "persisted", policy: "silent", messageId: "m1" });
    expect(deps.identityResolver.resolveOrCreate).toHaveBeenCalled();
    expect(deps.threadStore.resolveOrCreate).toHaveBeenCalled();
    expect(deps.policyEngine.evaluate).toHaveBeenCalled();
    expect(deps.messageStore.insert).toHaveBeenCalled();
    expect(deps.forwarder).not.toHaveBeenCalled();
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
    const out = await processInbound(
      { ...baseInbound, external_thread_id: "-5286864201" },
      deps,
    );
    expect(out).toEqual({ kind: "forwarded", url: "https://lab.example/webhook", ok: false });
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/api/src/router.ts
import type {
  InboundMessage, IdentityResolver, PolicyEngine, ThreadStore, MessageStore, PolicyAction,
} from "@agent-mouth/core";

export interface RouterDeps {
  workspaceId: string;
  bridgeForwardChats: Set<string>;
  bridgeForwardUrl: string | null;
  identityResolver: IdentityResolver;
  threadStore: ThreadStore;
  policyEngine: PolicyEngine;
  messageStore: MessageStore;
  forwarder: (url: string, payload: unknown) => Promise<boolean>;
}

export type RouterResult =
  | { kind: "forwarded"; url: string; ok: boolean }
  | { kind: "persisted"; policy: PolicyAction; messageId: string }
  | { kind: "skipped"; reason: string };

export async function processInbound(msg: InboundMessage, deps: RouterDeps): Promise<RouterResult> {
  if (deps.bridgeForwardChats.has(msg.external_thread_id) && deps.bridgeForwardUrl) {
    const ok = await deps.forwarder(deps.bridgeForwardUrl, msg.raw_payload);
    return { kind: "forwarded", url: deps.bridgeForwardUrl, ok };
  }

  const ident = await deps.identityResolver.resolveOrCreate({
    workspaceId: deps.workspaceId,
    channelType: msg.channel_type,
    identifier: msg.sender_identifier,
    displayName: msg.sender_display_name,
  });

  const thread = await deps.threadStore.resolveOrCreate({
    workspaceId: deps.workspaceId,
    contactId: ident.contact.id,
    channelId: ident.channel.id,
    externalThreadId: msg.external_thread_id,
  });

  const policy = await deps.policyEngine.evaluate({
    workspaceId: deps.workspaceId,
    contactId: ident.contact.id,
    channelType: msg.channel_type,
  });

  const persisted = await deps.messageStore.insert({
    threadId: thread.id,
    channelId: ident.channel.id,
    channelIdentityId: ident.channel_identity.id,
    direction: "inbound",
    content: msg.content,
    attachments: msg.attachments,
    rawPayload: msg.raw_payload,
    externalMessageId: msg.external_message_id,
    sentBy: null,
  });

  return { kind: "persisted", policy: policy.policy, messageId: persisted.id };
}
```

- [ ] **Step 3: Run tests, commit**

```
pnpm --filter @agent-mouth/api test
git commit -am "feat(api): processInbound router (forward-or-persist with identity+policy)"
```

---

## Group J — Webhook endpoint + serve-http wiring

### Task 17: Extend ToolContext with messageStore + workspaceId

**Files:**
- Modify: `packages/api/src/registry.ts`
- Modify: `packages/api/src/server.ts`

- [ ] **Step 1: Modify registry.ts**

Find the `ToolContext` interface (it currently has `transport`, `configPath?`, `offsetStore?`, `handle?`). Extend:

```typescript
// packages/api/src/registry.ts — extend the ToolContext interface
import type { MessageStore } from "@agent-mouth/core";

export interface ToolContext {
  transport: Transport;
  configPath?: string;
  offsetStore?: OffsetStore;
  handle?: string;
  messageStore?: MessageStore;
  workspaceId?: string;
}
```

- [ ] **Step 2: Modify server.ts to pass these through**

```typescript
// packages/api/src/server.ts — extend ServerOptions and the handler context
import type { MessageStore, OffsetStore, Transport } from "@agent-mouth/core";

export interface ServerOptions {
  transport: Transport;
  configPath?: string;
  offsetStore?: OffsetStore;
  handle?: string;
  messageStore?: MessageStore;
  workspaceId?: string;
}

// inside buildServer, in the CallToolRequestSchema handler:
const result = await tool.handler(request.params.arguments ?? {}, {
  transport: opts.transport,
  configPath: opts.configPath,
  offsetStore: opts.offsetStore,
  handle: opts.handle,
  messageStore: opts.messageStore,
  workspaceId: opts.workspaceId,
});
```

- [ ] **Step 3: Run existing tests, verify no regression**

```
pnpm --filter @agent-mouth/api test
```

- [ ] **Step 4: Commit**

```
git commit -am "feat(api): extend ToolContext with messageStore + workspaceId (passthrough only)"
```

---

### Task 18: read_inbox reads from messageStore when present

**Files:**
- Modify: `packages/api/src/tools/messaging.ts`

When `ctx.messageStore` is defined, read from Supabase. Else fall back to `transport.receive` (preserves CLI stdio mode).

- [ ] **Step 1: Add tests to existing tools-messaging tests**

```typescript
// packages/api/tests/tools-messaging.test.ts — add at end of file

import { readInboxTool } from "../src/tools/messaging.js";

describe("read_inbox with MessageStore present", () => {
  it("reads from messageStore.listRecent instead of transport.receive", async () => {
    const messageStore = {
      insert: vi.fn(),
      listRecent: vi.fn().mockResolvedValue([
        { id: "m1", thread_id: "t1", channel_id: "c1", channel_identity_id: null,
          direction: "inbound", content: "hola", attachments: [], raw_payload: null,
          external_message_id: "42", sent_by: null, created_at: "2026-05-20T00:00:00Z" },
      ]),
      waitForNew: vi.fn(),
    };
    const transport = { receive: vi.fn() };
    const out = await readInboxTool.handler({ limit: 10 }, {
      transport: transport as never,
      messageStore: messageStore as never,
      workspaceId: "ws",
    });
    expect(messageStore.listRecent).toHaveBeenCalledWith({ workspaceId: "ws", limit: 10 });
    expect(transport.receive).not.toHaveBeenCalled();
    expect(Array.isArray(out)).toBe(true);
    expect((out as unknown[])[0]).toMatchObject({ id: "m1", content: "hola" });
  });
});
```

- [ ] **Step 2: Implement the branch**

```typescript
// packages/api/src/tools/messaging.ts — replace readInboxTool.handler

export const readInboxTool: ToolDef = {
  name: "read_inbox",
  description: "Returns recent messages. With persistence: cross-channel from MessageStore. Without: long-polled from the active transport.",
  inputSchema: {
    type: "object",
    properties: {
      filter: { type: "string", enum: ["mentions", "replies", "all"] },
      since_message_id: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  handler: async (input, { transport, messageStore, workspaceId }) => {
    const parsed = z
      .object({
        filter: FilterEnum.optional().default("mentions"),
        since_message_id: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      })
      .parse(input);
    if (messageStore && workspaceId) {
      return messageStore.listRecent({
        workspaceId,
        sinceId: parsed.since_message_id,
        limit: parsed.limit,
      });
    }
    return transport.receive(parsed);
  },
};
```

- [ ] **Step 3: Run tests, commit**

```
pnpm --filter @agent-mouth/api test
git commit -am "feat(api): read_inbox reads from MessageStore when present (fallback preserved)"
```

---

### Task 19: wait_for_messages reads from messageStore when present

- [ ] **Step 1: Add test mirroring Task 18 but for wait_for_messages and waitForNew**

```typescript
// packages/api/tests/tools-messaging.test.ts — add

import { waitForMessagesTool } from "../src/tools/messaging.js";

describe("wait_for_messages with MessageStore present", () => {
  it("uses messageStore.waitForNew", async () => {
    const messageStore = {
      insert: vi.fn(),
      listRecent: vi.fn(),
      waitForNew: vi.fn().mockResolvedValue([
        { id: "m1", thread_id: "t1", channel_id: "c1", channel_identity_id: null,
          direction: "inbound", content: "yo", attachments: [], raw_payload: null,
          external_message_id: "43", sent_by: null, created_at: "2026-05-20T00:00:01Z" },
      ]),
    };
    const before = new Date("2026-05-20T00:00:00Z").toISOString();
    const out = await waitForMessagesTool.handler(
      { timeout_seconds: 5 },
      { transport: { waitForMessages: vi.fn() } as never, messageStore: messageStore as never, workspaceId: "ws" },
    );
    expect(messageStore.waitForNew).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws", timeoutSeconds: 5,
    }));
    expect((out as unknown[]).length).toBe(1);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/api/src/tools/messaging.ts — replace waitForMessagesTool.handler

handler: async (input, { transport, messageStore, workspaceId }) => {
  const parsed = z
    .object({
      timeout_seconds: z.number().int().min(1).max(300).optional().default(30),
      filter: FilterEnum.optional().default("mentions"),
    })
    .parse(input);
  if (messageStore && workspaceId) {
    return messageStore.waitForNew({
      workspaceId,
      sinceCreatedAt: new Date().toISOString(),
      timeoutSeconds: parsed.timeout_seconds,
    });
  }
  return transport.waitForMessages(parsed);
},
```

- [ ] **Step 3: Run tests, commit**

```
pnpm --filter @agent-mouth/api test
git commit -am "feat(api): wait_for_messages uses MessageStore.waitForNew when present"
```

---

### Task 20: Webhook endpoint in serve-http

**Files:**
- Modify: `packages/api/src/cli/serve-http.ts`

Wire all the stores, accept POST `/telegram-webhook`, call `processInbound`, ACK 200.

- [ ] **Step 1: Add stores import and bootstrap section**

Replace the `serveHttp` body. Add at the top of the function (after the env validation block):

```typescript
// packages/api/src/cli/serve-http.ts — after the existing env-var checks

import {
  SupabaseContactStore, SupabaseIdentityResolver, SupabasePolicyEngine,
  SupabaseThreadStore, SupabaseMessageStore, SupabaseWorkspaceStore,
} from "@agent-mouth/storage-supabase";
import { telegramUpdateToInbound } from "@agent-mouth/transport-telegram";
import { processInbound, type RouterDeps } from "../router.js";
import { forwardToBridge } from "../forwarders/bridge.js";
import { InboundMessageSchema } from "@agent-mouth/core";

// inside serveHttp, after offsetStore is created:
const workspaceStore = new SupabaseWorkspaceStore(supabaseUrl, supabaseKey);
const workspace = await workspaceStore.getDefault();
const identityResolver = new SupabaseIdentityResolver(supabaseUrl, supabaseKey);
const policyEngine = new SupabasePolicyEngine(supabaseUrl, supabaseKey);
const threadStore = new SupabaseThreadStore(supabaseUrl, supabaseKey);
const messageStore = new SupabaseMessageStore(supabaseUrl, supabaseKey);

const bridgeForwardUrl = process.env.BRIDGE_FORWARD_URL ?? null;
const bridgeForwardChats = new Set(
  (process.env.BRIDGE_FORWARD_CHATS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean),
);

const routerDeps: RouterDeps = {
  workspaceId: workspace.id,
  bridgeForwardChats,
  bridgeForwardUrl,
  identityResolver,
  threadStore,
  policyEngine,
  messageStore,
  forwarder: forwardToBridge,
};
```

- [ ] **Step 2: Wire messageStore into buildServer call**

Replace the existing `buildServer({...})` invocation with:

```typescript
const server = buildServer({
  transport: telegramTransport,
  offsetStore,
  handle: config.telegram!.handle,
  messageStore,
  workspaceId: workspace.id,
});
```

- [ ] **Step 3: Add the `/telegram-webhook` route handler**

In the `httpServer = createServer(...)` callback, add this route before the 404 fallback:

```typescript
if (url.pathname === "/telegram-webhook" && req.method === "POST") {
  const body = await readJsonBody(req);
  const inbound = telegramUpdateToInbound(body as Parameters<typeof telegramUpdateToInbound>[0]);
  if (!inbound) {
    sendJson(res, 200, { ok: true, skipped: true });
    return;
  }
  // belt-and-suspenders: validate normalized shape
  const parsed = InboundMessageSchema.safeParse(inbound);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, "inbound schema mismatch");
    sendJson(res, 200, { ok: true, skipped: true });
    return;
  }
  const result = await processInbound(parsed.data, routerDeps);
  logger.info({ result }, "webhook processed");
  sendJson(res, 200, { ok: true, result });
  return;
}
```

- [ ] **Step 4: Build to verify TS compiles**

```
pnpm -r build
```

- [ ] **Step 5: Run all tests, verify everything still green**

```
pnpm -r test
```

- [ ] **Step 6: Commit**

```
git commit -am "feat(api): /telegram-webhook endpoint + Supabase stores wired into serve-http"
```

---

## Group K — Deploy + cutover

### Task 21: Write operational runbook

**Files:**
- Create: `docs/superpowers/runbooks/2026-05-20-phase-1a-webhook-cutover.md`

- [ ] **Step 1: Write runbook**

```markdown
# Phase 1a Webhook Cutover — Runbook

**When to use:** First deploy of Phase 1a code that swaps Telegram from `lab.agentiko.es` webhook → `agent-mouth.fly.dev/telegram-webhook`.

## Preconditions

- [ ] Supabase migration 0002 applied (Task 5 verified).
- [ ] Seed data inserted (Task 6 verified).
- [ ] Fly secrets set:
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY` (already from Phase 0)
  - `AGENT_MOUTH_BOT_TOKEN`, `AGENT_MOUTH_CHAT_ID`, `AGENT_MOUTH_HANDLE` (already)
  - `BRIDGE_FORWARD_URL=https://lab.agentiko.es/webhook` (new)
  - `BRIDGE_FORWARD_CHATS=<comma-separated Cuina LAB chat IDs>` (new)

## Cutover steps

1. Capture rollback info (CURRENT webhook URL — keep it for rollback):

```
flyctl ssh console -a agent-mouth -C \
  'node -e "fetch(`https://api.telegram.org/bot${process.env.AGENT_MOUTH_BOT_TOKEN}/getWebhookInfo`).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"'
```

   Save `result.url` as `OLD_WEBHOOK_URL` in your scratch notes.

2. Deploy:

```
flyctl deploy -a agent-mouth
```

   Wait for `[i] Machines have been updated` and verify `/health`:

```
curl -sf https://agent-mouth.fly.dev/health
```

3. Switch the Telegram webhook to agent-mouth:

```
flyctl ssh console -a agent-mouth -C \
  'node -e "fetch(`https://api.telegram.org/bot${process.env.AGENT_MOUTH_BOT_TOKEN}/setWebhook?url=https://agent-mouth.fly.dev/telegram-webhook&allowed_updates=[\"message\"]`).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"'
```

   Expected: `{ "ok": true, "result": true, "description": "Webhook was set" }`.

4. Validate private → MCP:

   - From your phone: send "hola test phase 1a" to `@Gavrilux_bot` in **private** chat.
   - Check Fly logs: `flyctl logs -a agent-mouth | tail -20` — expect `webhook processed` line with `kind: "persisted"`.
   - From Claude Code: call `mcp__agent-mouth__read_inbox` — expect the message in the response.

5. Validate group → bridge:

   - In The Cuina LAB Telegram group, send a message.
   - Check Fly logs: expect `webhook processed` with `kind: "forwarded", ok: true`.
   - Verify the bridge at `lab.agentiko.es` still reacts as before.

## Rollback

If anything misbehaves, revert the webhook:

```
flyctl ssh console -a agent-mouth -C \
  'node -e "fetch(`https://api.telegram.org/bot${process.env.AGENT_MOUTH_BOT_TOKEN}/setWebhook?url=<OLD_WEBHOOK_URL>&allowed_updates=[\"message\"]`).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"'
```

Then triage logs / metrics. The new code path is purely additive (the old bridge logic is unchanged) so rolling back the webhook URL is a complete rollback.

## Known limitations (Phase 1a)

- `mark_read` still uses the offset store (long-polling lineage). It's effectively a no-op when webhook owns inbound — to be retired in Phase 1b.
- `get_thread` still uses `transport.receive` (long-polling). Will fail-soft because polling now conflicts with the webhook. Retire/refactor in Phase 1b.
- Messages persist only for chats NOT in `BRIDGE_FORWARD_CHATS`. The Cuina LAB group remains owned by the bridge.
- `waitForNew` polls Supabase every 2 s. Acceptable for Phase 1a; switch to Postgres LISTEN/NOTIFY in Phase 1b if latency matters.
```

- [ ] **Step 2: Commit**

```
git add docs/superpowers/runbooks/2026-05-20-phase-1a-webhook-cutover.md
git commit -m "docs: webhook cutover runbook for Phase 1a"
```

---

### Task 22: Smoke test — full local build + test

- [ ] **Step 1: Run full build**

```
pnpm -r build
```

Expected: all 9 packages build cleanly.

- [ ] **Step 2: Run full test suite**

```
pnpm -r test
```

Expected: every test green. Approximate counts after Phase 1a:
- core: 10+ (was 4, +6 from identity, +2 from inbound)
- storage-supabase: 4 (offset) + 2 (workspace) + 2 (contact) + 3 (identity-resolver) + 3 (policy) + 1 (thread) + 4 (message-store) ≈ 19
- storage-sqlite: 1 (unchanged)
- storage-postgres: 0 (passWithNoTests)
- transport-telegram: 7 + 4 (normalize) = 11
- agent: 1 (unchanged)
- api: 11 (existing) + 3 (forwarder) + 3 (router) + 2 (read_inbox/wait via store) ≈ 19
- mcp: 18 (unchanged — Phase 0 G9 pending)

Total ~ 79 tests. If any are failing, stop and fix before deploying.

- [ ] **Step 3: Commit if any incidental cleanup happened during the smoke**

(Nothing to commit unless adjustments were needed.)

---

### Task 23: Set Fly secrets

This is a **manual operational step** (HARD STOP — needs explicit user confirmation before continuing).

- [ ] **Step 1: Identify Cuina LAB chat IDs**

The user must provide the Telegram chat ID(s) of the Cuina LAB group(s) that the bridge owns. They can grab one by checking a recent message in the group via the existing bridge logs, or via `getChat` API.

- [ ] **Step 2: Set secrets**

```
flyctl secrets set \
  BRIDGE_FORWARD_URL=https://lab.agentiko.es/webhook \
  BRIDGE_FORWARD_CHATS=<comma,separated,chat,ids> \
  -a agent-mouth
```

This triggers a Fly restart. Wait for healthy.

- [ ] **Step 3: Verify**

```
curl -sf https://agent-mouth.fly.dev/health
```

Expected: `{"ok":true,"handle":"Gavrilux_bot"}`.

---

### Task 24: HARD STOP — deploy + webhook cutover

**This task requires explicit user confirmation before each sub-step.**

- [ ] **Step 1: Confirm preconditions with user**

State: "Phase 1a code, tests green, runbook in place. About to deploy + flip the webhook. This is the live cutover — confirm?"

- [ ] **Step 2: Capture rollback URL**

Follow runbook §Cutover step 1. Save the existing webhook URL.

- [ ] **Step 3: Deploy**

```
flyctl deploy -a agent-mouth
```

- [ ] **Step 4: Wait for healthy + verify /health responds**

- [ ] **Step 5: Flip the webhook (runbook step 3)**

- [ ] **Step 6: Validate private → MCP (runbook step 4)**

- [ ] **Step 7: Validate group → bridge (runbook step 5)**

- [ ] **Step 8: Mark Phase 1a complete in the cerebro dashboard**

(User does this in their dashboard tool.)

---

## Self-review checklist (run before handoff)

- [ ] Every spec requirement from vision-design §4 inbound flow has a task: webhook receive (Task 20), normalize (Task 14), IdentityResolver (Task 9), PolicyEngine (Task 10), persist (Task 12). EventBus + AuditLog deferred to Phase 1b/2 per scope split.
- [ ] No placeholders ("TBD", "implement later") — verified.
- [ ] Type names consistent: `Contact`, `ChannelIdentity`, `Channel`, `Policy`, `Thread`, `InboundMessage`, `PersistedMessage` used identically across tasks 1-20.
- [ ] Method names consistent: `resolveOrCreate`, `evaluate`, `insert`, `listRecent`, `waitForNew`, `processInbound`, `forwardToBridge` — all referenced consistently.
- [ ] Every code-bearing step shows actual code, not "similar to above."
- [ ] Commits are frequent (one per task, plus subtask commits where needed).
- [ ] Rollback path documented for the only destructive op (webhook cutover).
