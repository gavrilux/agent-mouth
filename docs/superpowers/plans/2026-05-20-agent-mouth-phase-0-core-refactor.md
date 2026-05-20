# Agent Mouth — Phase 0: Core Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the monolithic `packages/mcp` into clean packages (`core`, `storage-*`, `transport-telegram`, `agent`, `api`, `apps/cli`) without breaking `agent-mouth.fly.dev` operational behavior. Lay foundation for Phase 1+ work.

**Architecture:** Incremental side-by-side migration (no big-bang). Create new packages first, migrate code module-by-module, keep `packages/mcp` as a shim that re-exports until fully drained, then remove it. Each group of tasks ends with a smoke test against the live Fly.io deployment.

**Tech Stack:** TypeScript 5.5, Node 20, pnpm 9 workspaces, vitest, biome, @modelcontextprotocol/sdk, grammy, pino, zod. New: better-sqlite3 (for SqliteAdapter scaffold), postgres (for PostgresAdapter scaffold).

**Spec:** `docs/superpowers/specs/2026-05-20-agent-mouth-vision-design.md` §3 + §4 + §6 Phase 0 row.

---

## Pre-flight context

### Current file structure

```
packages/mcp/
├── src/
│   ├── cli/        index.ts, serve.ts, serve-http.ts, init.ts, join.ts, _prompt.ts
│   ├── tools/      messaging.ts, identity.ts, _register.ts
│   ├── transports/ telegram.ts, types.ts
│   ├── persistence/ supabase.ts
│   ├── config.ts, server.ts, registry.ts, logger.ts, index.ts
├── tests/unit/     5 test files
├── package.json    name: "agent-mouth" (published to npm)
└── vitest.config.ts
```

### Target file structure (end of Phase 0)

```
packages/
├── core/                   interfaces only: Transport, StorageAdapter, OffsetStore, Message types
├── storage-supabase/       SupabaseOffsetStore (preserves current Fly.io behavior)
├── storage-sqlite/         SqliteAdapter scaffold + schema
├── storage-postgres/       PostgresAdapter scaffold + schema (same SQL as sqlite via Drizzle)
├── transport-telegram/     TelegramTransport (migrated from mcp/transports)
├── agent/                  AgentRuntime interface + skeleton (no LLM impl yet)
└── api/                    MCP server + tools + serve-http (migrated from mcp)

apps/
└── cli/                    Published as "agent-mouth" on npm (new home of CLI)
                            Imports from packages/api

(packages/mcp/ deleted after migration; git history preserved via git mv)
```

### Critical safety net

Between each Group of tasks below there is a **Smoke Test** step. It deploys the current branch to a Fly.io staging app (`agent-mouth-staging`) and runs `whoami` via the MCP. If the smoke test fails, the group must be fixed before moving on. **Never push to `main` mid-refactor**; do all work on `feat/phase-0-refactor` branch.

### Branch + worktree setup (first action)

Before any task: create branch and worktree to isolate the refactor from the live `main`.

```bash
cd /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth
git checkout main && git pull
git checkout -b feat/phase-0-refactor
```

(If working in a worktree per `superpowers:using-git-worktrees`, set it up now.)

### Staging Fly.io app (one-time setup before any code change)

```bash
cd /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth
flyctl apps create agent-mouth-staging --org personal
# Set same secrets as production but with a STAGING_HANDLE:
flyctl secrets set \
  AGENT_MOUTH_BOT_TOKEN="<staging-bot-token>" \
  AGENT_MOUTH_CHAT_ID="<staging-chat-id>" \
  AGENT_MOUTH_HANDLE="staging_bot" \
  AGENT_MOUTH_AUTH_TOKEN="<staging-uuid>" \
  SUPABASE_URL="https://deicbuvcynqontfbnboe.supabase.co" \
  SUPABASE_ANON_KEY="<anon-key>" \
  --app agent-mouth-staging
```

If you don't want a staging bot, the smoke test can be a local `node dist/cli/index.js serve-http` + `curl localhost:3000/health` instead. Note this choice in the plan checklist for the implementer.

---

## Group 1: Workspace skeleton & shared config

This group only adds infrastructure (new directories, shared tsconfig, biome scope). No code moves yet. Build still passes because nothing changes for `packages/mcp`.

### Task 1: Add apps/ directory to workspace

**Files:**
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Update workspace patterns**

Open `pnpm-workspace.yaml`. Current content:

```yaml
packages:
  - "packages/*"
```

Replace with:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 2: Verify existing build still works**

Run: `pnpm install && pnpm -r build`
Expected: `agent-mouth` package builds successfully. No new packages exist yet, so no other builds run.

- [ ] **Step 3: Commit**

```bash
git add pnpm-workspace.yaml
git commit -m "chore(workspace): include apps/* in pnpm workspaces"
```

### Task 2: Create empty apps/ directory placeholder

**Files:**
- Create: `apps/.gitkeep`

- [ ] **Step 1: Create directory placeholder**

```bash
mkdir -p apps
touch apps/.gitkeep
```

- [ ] **Step 2: Commit**

```bash
git add apps/.gitkeep
git commit -m "chore(apps): scaffold apps directory"
```

### Task 3: Verify tsconfig.base.json supports new packages

**Files:**
- Read: `tsconfig.base.json`

- [ ] **Step 1: Read current tsconfig.base.json**

Run: `cat tsconfig.base.json`

Confirm it defines shared compiler options (target, module, strict, etc.). If it uses path aliases (`paths`) referencing only `packages/*`, no change needed — each new package will extend it with their own `tsconfig.json`.

- [ ] **Step 2: No code change required**

(Documented for clarity; the implementer should confirm the file is appropriate.)

### Task 4: Add biome scope verification

**Files:**
- Read: `biome.json`

- [ ] **Step 1: Read biome.json**

Run: `cat biome.json`

Confirm `files.include` or absence of `files.exclude` for new packages. Biome should lint `packages/*` and `apps/*` by default unless explicitly excluded. If biome.json has explicit `include`, add `apps/**` and `packages/**`.

- [ ] **Step 2: If changes needed, edit biome.json**

Otherwise skip.

- [ ] **Step 3: If edited, commit**

```bash
git add biome.json
git commit -m "chore(biome): include new packages and apps in lint scope"
```

### 🟢 Smoke Test #1 (after Group 1)

- [ ] **Smoke 1.1: Build all packages**

Run: `pnpm -r build`
Expected: only `agent-mouth` (in packages/mcp) builds. No errors.

- [ ] **Smoke 1.2: Run all tests**

Run: `pnpm -r test`
Expected: 18 tests pass in `agent-mouth`.

- [ ] **Smoke 1.3: Production health check**

Run: `curl -sf https://agent-mouth.fly.dev/health`
Expected: `{"ok":true,"handle":"Gavrilux_bot"}`

(Production untouched; this verifies nothing accidentally broke.)

---

## Group 2: packages/core — interfaces and domain types

Move interfaces and types to a dedicated package. **No implementation logic moves yet.**

### Task 5: Scaffold packages/core

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p packages/core/src
```

Create `packages/core/package.json`:

```json
{
  "name": "@agent-mouth/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist/"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "typescript": "5.5.4",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 3: Create stub index.ts**

Create `packages/core/src/index.ts`:

```typescript
// Re-exports the public surface of @agent-mouth/core.
// Populated in subsequent tasks.
export {};
```

- [ ] **Step 4: Install + verify build**

```bash
pnpm install
pnpm --filter @agent-mouth/core build
```

Expected: clean build, creates `packages/core/dist/index.js`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat(core): scaffold @agent-mouth/core package"
```

### Task 6: Move Transport interface from mcp to core

**Files:**
- Read: `packages/mcp/src/transports/types.ts`
- Create: `packages/core/src/transport.ts`
- Create: `packages/core/tests/transport.test.ts`

- [ ] **Step 1: Read existing types.ts**

Run: `cat packages/mcp/src/transports/types.ts`

Confirm it defines `Transport` interface and related types. (Implementer: paste actual content here when reading.)

- [ ] **Step 2: Write the failing test**

Create `packages/core/tests/transport.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { Transport, TransportConfig, ReceivedMessage, SentMessageResult } from "../src/transport";

describe("Transport interface contract", () => {
  it("exports Transport with init/send/receive/waitForMessages methods", () => {
    // Compile-time check: this test fails to compile if the interface is missing.
    const _stub: Transport = {
      init: async (_: TransportConfig) => {},
      send: async () => ({ message_id: "x" } as SentMessageResult),
      receive: async () => [] as ReceivedMessage[],
      waitForMessages: async () => [] as ReceivedMessage[],
    };
    expect(_stub).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/core test`
Expected: FAIL with TypeScript error "Cannot find module '../src/transport'".

- [ ] **Step 4: Create packages/core/src/transport.ts**

Copy the content of `packages/mcp/src/transports/types.ts` into `packages/core/src/transport.ts` exactly. (No logic changes — just relocation.) Then in `packages/core/src/index.ts`, add:

```typescript
export * from "./transport.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agent-mouth/core build && pnpm --filter @agent-mouth/core test`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/transport.ts packages/core/src/index.ts packages/core/tests/transport.test.ts
git commit -m "feat(core): add Transport interface (relocated from packages/mcp)"
```

### Task 7: Add vitest.config.ts to packages/core

**Files:**
- Create: `packages/core/vitest.config.ts`

- [ ] **Step 1: Create vitest config**

Create `packages/core/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 2: Verify test still passes**

Run: `pnpm --filter @agent-mouth/core test`
Expected: 1 test passes.

- [ ] **Step 3: Commit**

```bash
git add packages/core/vitest.config.ts
git commit -m "chore(core): add vitest config"
```

### Task 8: Add OffsetStore interface to core

**Files:**
- Read: `packages/mcp/src/persistence/supabase.ts`
- Create: `packages/core/src/offset-store.ts`
- Create: `packages/core/tests/offset-store.test.ts`

- [ ] **Step 1: Read existing supabase.ts**

Run: `cat packages/mcp/src/persistence/supabase.ts`

Confirm it defines `OffsetStore` interface alongside the Supabase implementation. The interface goes to core; the impl stays for now and will be moved in Task 11.

- [ ] **Step 2: Write the failing test**

Create `packages/core/tests/offset-store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { OffsetStore } from "../src/offset-store";

describe("OffsetStore interface", () => {
  it("requires getOffset and saveOffset methods", () => {
    const stub: OffsetStore = {
      getOffset: async () => 0,
      saveOffset: async () => {},
    };
    expect(stub).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/core test`
Expected: FAIL with "Cannot find module '../src/offset-store'".

- [ ] **Step 4: Create offset-store.ts**

Create `packages/core/src/offset-store.ts`:

```typescript
/**
 * Persistence interface for Telegram-style update offsets.
 * Allows different storage backends (Supabase, SQLite, Postgres, in-memory).
 */
export interface OffsetStore {
  getOffset(handle: string): Promise<number>;
  saveOffset(handle: string, updateId: number): Promise<void>;
}
```

Then in `packages/core/src/index.ts`, add:

```typescript
export * from "./offset-store.js";
```

(Final `index.ts` should now have two exports.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @agent-mouth/core build && pnpm --filter @agent-mouth/core test`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/offset-store.ts packages/core/src/index.ts packages/core/tests/offset-store.test.ts
git commit -m "feat(core): add OffsetStore interface"
```

### Task 9: Add basic domain types (Message, Channel, etc.)

**Files:**
- Create: `packages/core/src/domain.ts`
- Create: `packages/core/tests/domain.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/domain.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ChannelTypeSchema, MessageSchema, type ChannelType, type Message } from "../src/domain";

describe("Domain types", () => {
  it("validates channel types via Zod", () => {
    expect(ChannelTypeSchema.parse("telegram")).toBe("telegram");
    expect(ChannelTypeSchema.parse("email")).toBe("email");
    expect(ChannelTypeSchema.parse("whatsapp")).toBe("whatsapp");
    expect(() => ChannelTypeSchema.parse("carrier-pigeon")).toThrow(z.ZodError);
  });

  it("validates a normalized Message", () => {
    const msg: Message = {
      id: "msg-123",
      thread_id: "thread-1",
      channel_type: "telegram",
      direction: "inbound",
      external_id: "12345",
      sender_identifier: "@marco_bot",
      content: "hola",
      created_at: new Date().toISOString(),
    };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/core test`
Expected: FAIL "Cannot find module '../src/domain'".

- [ ] **Step 3: Create domain.ts**

Create `packages/core/src/domain.ts`:

```typescript
import { z } from "zod";

export const ChannelTypeSchema = z.enum([
  "telegram",
  "email",
  "whatsapp",
  "discord",
  "slack",
]);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const MessageDirectionSchema = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  channel_type: ChannelTypeSchema,
  direction: MessageDirectionSchema,
  external_id: z.string(),
  sender_identifier: z.string(),
  content: z.string(),
  created_at: z.string(), // ISO 8601
  attachments: z.array(z.unknown()).optional(),
  raw_payload: z.unknown().optional(),
});
export type Message = z.infer<typeof MessageSchema>;
```

Add to `packages/core/src/index.ts`:

```typescript
export * from "./domain.js";
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @agent-mouth/core build && pnpm --filter @agent-mouth/core test`
Expected: 3 tests pass total.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/domain.ts packages/core/src/index.ts packages/core/tests/domain.test.ts
git commit -m "feat(core): add domain types (ChannelType, Message)"
```

### 🟢 Smoke Test #2 (after Group 2)

- [ ] **Smoke 2.1: Build all packages**

Run: `pnpm -r build`
Expected: both `@agent-mouth/core` and `agent-mouth` build successfully.

- [ ] **Smoke 2.2: Run all tests**

Run: `pnpm -r test`
Expected: 3 tests pass in core + 18 tests pass in mcp = 21 total.

- [ ] **Smoke 2.3: Production health check** (untouched)

Run: `curl -sf https://agent-mouth.fly.dev/health`
Expected: `{"ok":true,"handle":"Gavrilux_bot"}`

---

## Group 3: packages/storage-supabase — extract OffsetStore impl

Move the Supabase implementation from `packages/mcp/src/persistence/supabase.ts` to its own package. `packages/mcp` will temporarily re-export from it to avoid breaking the build.

### Task 10: Scaffold packages/storage-supabase

**Files:**
- Create: `packages/storage-supabase/package.json`
- Create: `packages/storage-supabase/tsconfig.json`
- Create: `packages/storage-supabase/vitest.config.ts`
- Create: `packages/storage-supabase/src/index.ts`

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p packages/storage-supabase/src packages/storage-supabase/tests
```

Create `packages/storage-supabase/package.json`:

```json
{
  "name": "@agent-mouth/storage-supabase",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist/"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "typescript": "5.5.4",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/storage-supabase/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

Create `packages/storage-supabase/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Create stub index.ts**

Create `packages/storage-supabase/src/index.ts`:

```typescript
export {};
```

- [ ] **Step 5: Install and verify**

```bash
pnpm install
pnpm --filter @agent-mouth/storage-supabase build
```

Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/storage-supabase/
git commit -m "feat(storage-supabase): scaffold @agent-mouth/storage-supabase package"
```

### Task 11: Move SupabaseOffsetStore implementation

**Files:**
- Read: `packages/mcp/src/persistence/supabase.ts`
- Create: `packages/storage-supabase/src/supabase-offset-store.ts`
- Modify: `packages/storage-supabase/src/index.ts`
- Create: `packages/storage-supabase/tests/supabase-offset-store.test.ts`

- [ ] **Step 1: Read existing implementation**

Run: `cat packages/mcp/src/persistence/supabase.ts`

It contains `OffsetStore` interface (already in core now) and `SupabaseOffsetStore`/`NoopOffsetStore` implementations.

- [ ] **Step 2: Write the failing test**

Create `packages/storage-supabase/tests/supabase-offset-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseOffsetStore, NoopOffsetStore } from "../src/supabase-offset-store";

describe("SupabaseOffsetStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("getOffset returns 0 when no row exists", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    const store = new SupabaseOffsetStore("https://x.supabase.co", "anon");
    expect(await store.getOffset("handle1")).toBe(0);
  });

  it("getOffset returns row value", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ last_seen_update_id: 42 }],
    });
    const store = new SupabaseOffsetStore("https://x.supabase.co", "anon");
    expect(await store.getOffset("handle1")).toBe(42);
  });

  it("saveOffset POSTs upsert with merge-duplicates", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchSpy;
    const store = new SupabaseOffsetStore("https://x.supabase.co", "anon");
    await store.saveOffset("h", 99);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://x.supabase.co/rest/v1/agent_mouth_state",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Prefer: "resolution=merge-duplicates",
        }),
      }),
    );
  });
});

describe("NoopOffsetStore", () => {
  it("always returns 0 and no-ops saves", async () => {
    const store = new NoopOffsetStore();
    expect(await store.getOffset("any")).toBe(0);
    await expect(store.saveOffset("any", 1)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/storage-supabase test`
Expected: FAIL "Cannot find module '../src/supabase-offset-store'".

- [ ] **Step 4: Create supabase-offset-store.ts**

Copy the `SupabaseOffsetStore` and `NoopOffsetStore` class implementations from `packages/mcp/src/persistence/supabase.ts` into `packages/storage-supabase/src/supabase-offset-store.ts`. Change the interface import:

```typescript
import type { OffsetStore } from "@agent-mouth/core";

export class SupabaseOffsetStore implements OffsetStore {
  // ... existing implementation unchanged
}

export class NoopOffsetStore implements OffsetStore {
  async getOffset(_handle: string): Promise<number> { return 0; }
  async saveOffset(_handle: string, _updateId: number): Promise<void> {}
}
```

Update `packages/storage-supabase/src/index.ts`:

```typescript
export * from "./supabase-offset-store.js";
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @agent-mouth/storage-supabase build && pnpm --filter @agent-mouth/storage-supabase test`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/storage-supabase/
git commit -m "feat(storage-supabase): move SupabaseOffsetStore from packages/mcp"
```

### Task 12: Add storage-supabase as dependency of mcp

**Files:**
- Modify: `packages/mcp/package.json`
- Modify: `packages/mcp/src/persistence/supabase.ts`

- [ ] **Step 1: Add workspace dependency**

In `packages/mcp/package.json`, add to `dependencies`:

```json
"@agent-mouth/core": "workspace:*",
"@agent-mouth/storage-supabase": "workspace:*",
```

- [ ] **Step 2: Replace local impl with re-export**

Replace contents of `packages/mcp/src/persistence/supabase.ts` with:

```typescript
// Re-export from @agent-mouth/storage-supabase for backwards compatibility.
// This file will be deleted in Task 27 after all consumers migrate.
export { SupabaseOffsetStore, NoopOffsetStore } from "@agent-mouth/storage-supabase";
export type { OffsetStore } from "@agent-mouth/core";
```

- [ ] **Step 3: Verify build**

Run: `pnpm install && pnpm -r build`
Expected: all packages build clean.

- [ ] **Step 4: Run tests**

Run: `pnpm -r test`
Expected: 4 (storage-supabase) + 3 (core) + 18 (mcp) = 25 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/package.json packages/mcp/src/persistence/supabase.ts pnpm-lock.yaml
git commit -m "refactor(mcp): use @agent-mouth/storage-supabase as dep"
```

### 🟢 Smoke Test #3 (after Group 3)

- [ ] **Smoke 3.1: Build + test pass**

Run: `pnpm -r build && pnpm -r test`
Expected: 25 tests pass.

- [ ] **Smoke 3.2: Local serve-http boot**

Run in one terminal:
```bash
cd /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth/packages/mcp
AGENT_MOUTH_BOT_TOKEN=fake AGENT_MOUTH_CHAT_ID=-1 AGENT_MOUTH_HANDLE=test \
  SUPABASE_URL=https://example.com SUPABASE_ANON_KEY=fake \
  node dist/cli/index.js serve-http &
sleep 2
curl -s localhost:3000/health
kill %1
```
Expected: `{"ok":true,"handle":"test"}` then process exits.

- [ ] **Smoke 3.3: Production health check** (untouched)

Run: `curl -sf https://agent-mouth.fly.dev/health`
Expected: `{"ok":true,"handle":"Gavrilux_bot"}`

---

## Group 4: packages/transport-telegram — extract TelegramTransport

### Task 13: Scaffold packages/transport-telegram

**Files:**
- Create: `packages/transport-telegram/package.json`
- Create: `packages/transport-telegram/tsconfig.json`
- Create: `packages/transport-telegram/vitest.config.ts`
- Create: `packages/transport-telegram/src/index.ts`

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p packages/transport-telegram/src packages/transport-telegram/tests
```

Create `packages/transport-telegram/package.json`:

```json
{
  "name": "@agent-mouth/transport-telegram",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist/"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*",
    "grammy": "^1.30.0"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "typescript": "5.5.4",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/transport-telegram/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 3: Create vitest config and stub index**

Create `packages/transport-telegram/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

Create `packages/transport-telegram/src/index.ts`:

```typescript
export {};
```

- [ ] **Step 4: Install and verify**

```bash
pnpm install
pnpm --filter @agent-mouth/transport-telegram build
```

- [ ] **Step 5: Commit**

```bash
git add packages/transport-telegram/
git commit -m "feat(transport-telegram): scaffold @agent-mouth/transport-telegram package"
```

### Task 14: Move TelegramTransport implementation

**Files:**
- Read: `packages/mcp/src/transports/telegram.ts`
- Create: `packages/transport-telegram/src/telegram-transport.ts`
- Modify: `packages/transport-telegram/src/index.ts`

- [ ] **Step 1: Read existing implementation**

Run: `cat packages/mcp/src/transports/telegram.ts`

Confirm it contains the `TelegramTransport` class implementing the `Transport` interface, plus `TelegramConfig` type.

- [ ] **Step 2: Copy to new package**

Create `packages/transport-telegram/src/telegram-transport.ts` with the full contents of `packages/mcp/src/transports/telegram.ts`. Change imports:

```typescript
// Replace:
//   import type { Transport, TransportConfig, ... } from "./types.js";
// With:
import type { Transport, TransportConfig, ReceivedMessage, SentMessageResult, OffsetStore } from "@agent-mouth/core";
```

(Everything else: keep verbatim — same long-polling logic, same offset handling.)

- [ ] **Step 3: Update index.ts**

`packages/transport-telegram/src/index.ts`:

```typescript
export * from "./telegram-transport.js";
```

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @agent-mouth/transport-telegram build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-telegram/src/telegram-transport.ts packages/transport-telegram/src/index.ts
git commit -m "feat(transport-telegram): move TelegramTransport from packages/mcp"
```

### Task 15: Migrate telegram-transport tests

**Files:**
- Read: `packages/mcp/tests/unit/telegram-transport.test.ts`
- Create: `packages/transport-telegram/tests/telegram-transport.test.ts`

- [ ] **Step 1: Read existing tests**

Run: `cat packages/mcp/tests/unit/telegram-transport.test.ts`

- [ ] **Step 2: Copy tests with updated import paths**

Create `packages/transport-telegram/tests/telegram-transport.test.ts` with same content but:

```typescript
// Replace:
//   import { TelegramTransport } from "../../src/transports/telegram";
// With:
import { TelegramTransport } from "../src/telegram-transport";
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @agent-mouth/transport-telegram test`
Expected: 7 tests pass (same as in mcp originally).

- [ ] **Step 4: Commit**

```bash
git add packages/transport-telegram/tests/
git commit -m "test(transport-telegram): migrate telegram-transport tests"
```

### Task 16: Make packages/mcp re-export from transport-telegram

**Files:**
- Modify: `packages/mcp/package.json`
- Modify: `packages/mcp/src/transports/telegram.ts`
- Modify: `packages/mcp/src/transports/types.ts`

- [ ] **Step 1: Add workspace dep**

In `packages/mcp/package.json`, add to `dependencies`:

```json
"@agent-mouth/transport-telegram": "workspace:*"
```

- [ ] **Step 2: Replace transports/telegram.ts with re-export**

Replace contents of `packages/mcp/src/transports/telegram.ts` with:

```typescript
// Re-export from @agent-mouth/transport-telegram for backwards compatibility.
// This file will be deleted in Task 27.
export { TelegramTransport } from "@agent-mouth/transport-telegram";
export type { TelegramConfig } from "@agent-mouth/transport-telegram";
```

- [ ] **Step 3: Replace types.ts with re-export**

Replace contents of `packages/mcp/src/transports/types.ts` with:

```typescript
// Re-export from @agent-mouth/core.
// This file will be deleted in Task 27.
export type { Transport, TransportConfig, ReceivedMessage, SentMessageResult } from "@agent-mouth/core";
```

- [ ] **Step 4: Verify build**

Run: `pnpm install && pnpm -r build`
Expected: all packages build.

- [ ] **Step 5: Run all tests**

Run: `pnpm -r test`
Expected: 4 (storage-supabase) + 7 (transport-telegram) + 3 (core) + 18 (mcp) = 32 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/
git commit -m "refactor(mcp): use @agent-mouth/transport-telegram as dep"
```

### 🟢 Smoke Test #4 (after Group 4)

- [ ] **Smoke 4.1: Build + test**

Run: `pnpm -r build && pnpm -r test`
Expected: 32 tests pass.

- [ ] **Smoke 4.2: Local serve-http boot**

Same as Smoke 3.2.

- [ ] **Smoke 4.3: Production health check** (untouched)

Run: `curl -sf https://agent-mouth.fly.dev/health`

---

## Group 4b: packages/agent — skeleton interfaces only

Per Vision Doc §6 Phase 0 scope, the `agent` package must exist by end of Phase 0 even though no implementations land until Phase 2. We scaffold only the interface so Phase 2 can drop implementations into a pre-existing package.

### Task 16b: Scaffold packages/agent with AgentRuntime interface

**Files:**
- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/agent/vitest.config.ts`
- Create: `packages/agent/src/agent-runtime.ts`
- Create: `packages/agent/src/index.ts`
- Create: `packages/agent/tests/agent-runtime.test.ts`

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p packages/agent/src packages/agent/tests
```

Create `packages/agent/package.json`:

```json
{
  "name": "@agent-mouth/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist/"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "typescript": "5.5.4",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 3: Create vitest config**

`packages/agent/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
```

- [ ] **Step 4: Write the failing test**

Create `packages/agent/tests/agent-runtime.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { AgentRuntime, AgentContext, AgentResponse, RuntimeConfig } from "../src/agent-runtime";

describe("AgentRuntime interface contract", () => {
  it("exports AgentRuntime with initialize/respond/estimateCost/dispose", () => {
    const _stub: AgentRuntime = {
      initialize: async (_: RuntimeConfig) => {},
      respond: async (_: AgentContext) => ({
        body: "",
        reasoning: "",
        tools_called: [],
        tokens_used: { in: 0, out: 0, cached: 0 },
        cost_estimate_usd: 0,
        metadata: { confidence: 0, should_escalate: false },
      } as AgentResponse),
      estimateCost: async (_: AgentContext) => 0,
      dispose: async () => {},
    };
    expect(_stub).toBeDefined();
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm install && pnpm --filter @agent-mouth/agent test`
Expected: FAIL "Cannot find module '../src/agent-runtime'".

- [ ] **Step 6: Create agent-runtime.ts with interface only**

Create `packages/agent/src/agent-runtime.ts`:

```typescript
// AgentRuntime interface only. Implementations land in Phase 2.
// See: docs/superpowers/specs/2026-05-20-agent-mouth-vision-design.md §5.7

import type { Message, ChannelType } from "@agent-mouth/core";

export interface RuntimeConfig {
  provider: "claude" | "openai" | "gemini" | "ollama" | "mock";
  api_key?: string;
  model?: string;
  base_url?: string;
}

export interface BudgetState {
  daily_tokens_remaining: number;
  daily_usd_cap_remaining: number;
}

export interface ToolCall {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface AgentContext {
  workspace_id: string;
  // contact and policy types come in Phase 1; using `unknown` here keeps Phase 0 minimal
  contact: unknown;
  channel_type: ChannelType;
  incoming_message: Message;
  thread_history: Message[];
  policy: unknown;
  available_tools: unknown[];
  budget: BudgetState;
}

export interface AgentResponse {
  body: string;
  reasoning: string;
  tools_called: ToolCall[];
  tokens_used: { in: number; out: number; cached: number };
  cost_estimate_usd: number;
  metadata: {
    confidence: number;
    should_escalate: boolean;
  };
}

export interface AgentRuntime {
  initialize(config: RuntimeConfig): Promise<void>;
  respond(context: AgentContext): Promise<AgentResponse>;
  estimateCost(context: AgentContext): Promise<number>;
  dispose(): Promise<void>;
}
```

- [ ] **Step 7: Create index.ts**

Create `packages/agent/src/index.ts`:

```typescript
export * from "./agent-runtime.js";
```

- [ ] **Step 8: Run tests**

Run: `pnpm --filter @agent-mouth/agent build && pnpm --filter @agent-mouth/agent test`
Expected: 1 test passes.

- [ ] **Step 9: Commit**

```bash
git add packages/agent/ pnpm-lock.yaml
git commit -m "feat(agent): scaffold @agent-mouth/agent with AgentRuntime interface (no impls — Phase 2)"
```

### 🟢 Smoke Test #4b (after Group 4b)

- [ ] **Smoke 4b.1: Build + test**

Run: `pnpm -r build && pnpm -r test`
Expected: 32 (prior) + 1 (agent) = 33 tests pass.

- [ ] **Smoke 4b.2: Production health check** (untouched)

Run: `curl -sf https://agent-mouth.fly.dev/health`

---

## Group 5: packages/api — extract MCP server + tools

This is the largest group. It moves the MCP server (server.ts), tool definitions (tools/), the registry, the serve-http logic, and the config loader. Each task is bite-sized to minimize risk.

### Task 17: Scaffold packages/api

**Files:**
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/vitest.config.ts`
- Create: `packages/api/src/index.ts`

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p packages/api/src/tools packages/api/src/cli packages/api/tests
```

Create `packages/api/package.json`:

```json
{
  "name": "@agent-mouth/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist/"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*",
    "@agent-mouth/transport-telegram": "workspace:*",
    "@agent-mouth/storage-supabase": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "pino": "^9.4.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "typescript": "5.5.4",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 3: Create vitest config + stub**

`packages/api/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
```

`packages/api/src/index.ts`:

```typescript
export {};
```

- [ ] **Step 4: Install + verify**

```bash
pnpm install
pnpm --filter @agent-mouth/api build
```

- [ ] **Step 5: Commit**

```bash
git add packages/api/
git commit -m "feat(api): scaffold @agent-mouth/api package"
```

### Task 18: Move logger to api

**Files:**
- Read: `packages/mcp/src/logger.ts`
- Create: `packages/api/src/logger.ts`

- [ ] **Step 1: Read existing logger**

Run: `cat packages/mcp/src/logger.ts`

- [ ] **Step 2: Copy verbatim**

Create `packages/api/src/logger.ts` with same content as `packages/mcp/src/logger.ts`. (No interface dependency; standalone.)

- [ ] **Step 3: Build to verify**

Run: `pnpm --filter @agent-mouth/api build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/logger.ts
git commit -m "feat(api): move logger from packages/mcp"
```

### Task 19: Move config loader to api

**Files:**
- Read: `packages/mcp/src/config.ts`
- Create: `packages/api/src/config.ts`
- Create: `packages/api/tests/config.test.ts`
- Read: `packages/mcp/tests/unit/config.test.ts`

- [ ] **Step 1: Read existing config**

Run: `cat packages/mcp/src/config.ts && echo '---' && cat packages/mcp/tests/unit/config.test.ts`

- [ ] **Step 2: Copy config.ts and tests**

Copy `packages/mcp/src/config.ts` → `packages/api/src/config.ts` (no import changes; it's self-contained).

Copy `packages/mcp/tests/unit/config.test.ts` → `packages/api/tests/config.test.ts`, updating the import:

```typescript
// Replace:
//   import { ... } from "../../src/config";
// With:
import { /* original imports */ } from "../src/config";
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @agent-mouth/api build && pnpm --filter @agent-mouth/api test`
Expected: 2 tests pass (same as original config tests).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/config.ts packages/api/tests/config.test.ts
git commit -m "feat(api): move config loader from packages/mcp"
```

### Task 20: Move registry.ts and server.ts to api

**Files:**
- Read: `packages/mcp/src/registry.ts` and `packages/mcp/src/server.ts`
- Create: `packages/api/src/registry.ts` and `packages/api/src/server.ts`
- Create: `packages/api/tests/server.test.ts`

- [ ] **Step 1: Read source files**

Run: `cat packages/mcp/src/registry.ts && echo '---' && cat packages/mcp/src/server.ts`

- [ ] **Step 2: Copy with updated imports**

Copy both files to `packages/api/src/`. In each, update imports of `OffsetStore`, `Transport`, etc. to come from `@agent-mouth/core` instead of relative paths. Leave the rest of the logic unchanged.

Specifically in `registry.ts`:

```typescript
import type { Transport, OffsetStore } from "@agent-mouth/core";
```

And in `server.ts` keep the existing logic but update the OffsetStore import similarly.

- [ ] **Step 3: Migrate server test**

Copy `packages/mcp/tests/unit/server.test.ts` to `packages/api/tests/server.test.ts`. Update import paths:

```typescript
// Replace:
//   import { buildServer } from "../../src/server";
// With:
import { buildServer } from "../src/server";
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @agent-mouth/api build && pnpm --filter @agent-mouth/api test`
Expected: 3 tests pass (config + server).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/registry.ts packages/api/src/server.ts packages/api/tests/server.test.ts
git commit -m "feat(api): move registry and server from packages/mcp"
```

### Task 21: Move tools (identity + messaging) to api

**Files:**
- Read: `packages/mcp/src/tools/identity.ts`, `messaging.ts`, `_register.ts`
- Create: `packages/api/src/tools/identity.ts`, `messaging.ts`, `_register.ts`
- Migrate tests

- [ ] **Step 1: Copy tools files**

Copy each of:
- `packages/mcp/src/tools/identity.ts` → `packages/api/src/tools/identity.ts`
- `packages/mcp/src/tools/messaging.ts` → `packages/api/src/tools/messaging.ts`
- `packages/mcp/src/tools/_register.ts` → `packages/api/src/tools/_register.ts`

In each, update imports of `OffsetStore`/`Transport` to come from `@agent-mouth/core`. Leave logic unchanged.

- [ ] **Step 2: Migrate tools tests**

Copy:
- `packages/mcp/tests/unit/tools-identity.test.ts` → `packages/api/tests/tools-identity.test.ts`
- `packages/mcp/tests/unit/tools-messaging.test.ts` → `packages/api/tests/tools-messaging.test.ts`

Update import paths from `../../src/tools/...` to `../src/tools/...`.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @agent-mouth/api build && pnpm --filter @agent-mouth/api test`
Expected: 3 (config + server) + 2 (identity) + 6 (messaging) = 11 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/tools/ packages/api/tests/tools-*.test.ts
git commit -m "feat(api): move tools (identity + messaging) from packages/mcp"
```

### Task 22: Move serve-http and other CLI commands to api

**Files:**
- Read: `packages/mcp/src/cli/serve-http.ts`, `serve.ts`, `init.ts`, `join.ts`, `_prompt.ts`, `index.ts`
- Create: corresponding files under `packages/api/src/cli/`

- [ ] **Step 1: Copy all CLI files**

For each of `serve-http.ts`, `serve.ts`, `init.ts`, `join.ts`, `_prompt.ts`, `index.ts`:

Copy `packages/mcp/src/cli/<file>.ts` → `packages/api/src/cli/<file>.ts`.

Update imports inside each file:
- `from "../config.js"` → unchanged (still relative)
- `from "../server.js"` → unchanged
- `from "../persistence/supabase.js"` → `from "@agent-mouth/storage-supabase"`
- `from "../transports/telegram.js"` → `from "@agent-mouth/transport-telegram"`

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @agent-mouth/api build`
Expected: clean.

- [ ] **Step 3: Update api/src/index.ts to export public surface**

```typescript
export { serveHttp } from "./cli/serve-http.js";
export { buildServer } from "./server.js";
export { loadConfigFromEnv } from "./config.js";
```

- [ ] **Step 4: Run all tests**

Run: `pnpm -r test`
Expected: 11 (api) + 4 (storage-supabase) + 7 (transport-telegram) + 1 (agent) + 3 (core) + 18 (mcp original) = 44 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/cli/ packages/api/src/index.ts
git commit -m "feat(api): move CLI commands from packages/mcp"
```

### 🟢 Smoke Test #5 (after Group 5)

- [ ] **Smoke 5.1: Build + test**

Run: `pnpm -r build && pnpm -r test`
Expected: 44 tests pass.

- [ ] **Smoke 5.2: Local serve-http boot via api package**

```bash
cd /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth/packages/api
AGENT_MOUTH_BOT_TOKEN=fake AGENT_MOUTH_CHAT_ID=-1 AGENT_MOUTH_HANDLE=test \
  SUPABASE_URL=https://example.com SUPABASE_ANON_KEY=fake \
  node dist/cli/index.js serve-http &
sleep 2
curl -s localhost:3000/health
kill %1
```
Expected: `{"ok":true,"handle":"test"}`.

- [ ] **Smoke 5.3: Production health check** (untouched)

Run: `curl -sf https://agent-mouth.fly.dev/health`

---

## Group 6: apps/cli — new npm publish target

Create `apps/cli` as the new home for the `agent-mouth` npm package. It will replace `packages/mcp` as the npm-published artifact.

### Task 23: Scaffold apps/cli

**Files:**
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/index.ts`

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p apps/cli/src
```

Create `apps/cli/package.json`:

```json
{
  "name": "agent-mouth",
  "version": "0.2.0",
  "description": "MCP server for AI agents to talk to each other via multi-channel transports",
  "keywords": ["mcp", "ai-agents", "claude", "telegram", "chat", "agents"],
  "homepage": "https://github.com/gavrilux/agent-mouth",
  "repository": { "type": "git", "url": "https://github.com/gavrilux/agent-mouth.git" },
  "license": "MIT",
  "author": "Gavrilo Markovic Jankovic",
  "type": "module",
  "bin": { "agent-mouth": "./dist/index.js" },
  "files": ["dist/", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "cp ../../README.md ./README.md && cp ../../LICENSE ./LICENSE"
  },
  "dependencies": {
    "@agent-mouth/api": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "typescript": "5.5.4"
  }
}
```

Note bumped version to `0.2.0` because of breaking deps restructure (semver-wise, internal structure changed even if public API is the same).

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create src/index.ts as bin dispatcher**

`apps/cli/src/index.ts`:

```typescript
#!/usr/bin/env node
// Thin dispatcher. All logic lives in @agent-mouth/api.
import "@agent-mouth/api"; // ensure api dist exists at install time

const cmd = process.argv[2];

async function main() {
  switch (cmd) {
    case "serve": {
      const { serve } = await import("@agent-mouth/api/cli/serve");
      return serve();
    }
    case "serve-http": {
      const { serveHttp } = await import("@agent-mouth/api/cli/serve-http");
      return serveHttp();
    }
    case "init": {
      const { init } = await import("@agent-mouth/api/cli/init");
      return init();
    }
    case "join": {
      const { join } = await import("@agent-mouth/api/cli/join");
      return join();
    }
    default:
      console.error("Usage: agent-mouth <serve|serve-http|init|join>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Note: the dynamic imports of `@agent-mouth/api/cli/...` require subpath exports. Update `packages/api/package.json` accordingly in next step.

- [ ] **Step 4: Add subpath exports to api**

Modify `packages/api/package.json` `exports` field:

```json
"exports": {
  ".": "./dist/index.js",
  "./cli/serve": "./dist/cli/serve.js",
  "./cli/serve-http": "./dist/cli/serve-http.js",
  "./cli/init": "./dist/cli/init.js",
  "./cli/join": "./dist/cli/join.js"
}
```

- [ ] **Step 5: Build and verify**

Run: `pnpm install && pnpm -r build`
Expected: all packages and `agent-mouth` (apps/cli) build clean.

- [ ] **Step 6: Verify bin works**

Run:
```bash
chmod +x apps/cli/dist/index.js
AGENT_MOUTH_BOT_TOKEN=fake AGENT_MOUTH_CHAT_ID=-1 AGENT_MOUTH_HANDLE=test \
  SUPABASE_URL=https://example.com SUPABASE_ANON_KEY=fake \
  node apps/cli/dist/index.js serve-http &
sleep 2
curl -s localhost:3000/health
kill %1
```
Expected: `{"ok":true,"handle":"test"}`.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/ packages/api/package.json pnpm-lock.yaml
git commit -m "feat(apps/cli): create new agent-mouth npm bin (v0.2.0) dispatching to @agent-mouth/api"
```

### Task 24: Update root package.json scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add convenience scripts**

In root `package.json`, add to `scripts`:

```json
"dev:serve-http": "node apps/cli/dist/index.js serve-http",
"npm:pack": "pnpm --filter agent-mouth pack"
```

- [ ] **Step 2: Verify `npm:pack` produces a tarball**

```bash
pnpm -r build
pnpm npm:pack
```

Expected: `apps/cli/agent-mouth-0.2.0.tgz` exists. Inspect with `tar -tzf apps/cli/agent-mouth-0.2.0.tgz | head`. Should include `dist/index.js`, `package.json`, `README.md`, `LICENSE`.

- [ ] **Step 3: Clean up tarball + commit**

```bash
rm apps/cli/agent-mouth-0.2.0.tgz
git add package.json
git commit -m "chore(scripts): add dev:serve-http and npm:pack root scripts"
```

### 🟢 Smoke Test #6 (after Group 6)

- [ ] **Smoke 6.1: Build + test**

Run: `pnpm -r build && pnpm -r test`
Expected: 44 tests pass.

- [ ] **Smoke 6.2: Local serve via new apps/cli bin**

Same as Task 23 Step 6.

- [ ] **Smoke 6.3: Production health check** (untouched)

Run: `curl -sf https://agent-mouth.fly.dev/health`

---

## Group 7: Postgres schema + storage adapters scaffolding

Implement the base schema as `.sql` files and scaffold `storage-sqlite` + `storage-postgres` packages. **No CRUD logic yet** — that comes in Phase 1. Phase 0 only needs the schema files to exist and a smoke test that they parse.

### Task 25: Create base SQL schema

**Files:**
- Create: `packages/storage-sqlite/sql/0001_initial.sql`
- Create: `packages/storage-postgres/sql/0001_initial.sql`

- [ ] **Step 1: Scaffold storage-sqlite package**

```bash
mkdir -p packages/storage-sqlite/src packages/storage-sqlite/tests packages/storage-sqlite/sql
```

Create `packages/storage-sqlite/package.json`:

```json
{
  "name": "@agent-mouth/storage-sqlite",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js", "./sql/*": "./sql/*" },
  "files": ["dist/", "sql/"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*",
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.16.0",
    "typescript": "5.5.4",
    "vitest": "^2.1.0"
  }
}
```

Create `packages/storage-sqlite/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

Create `packages/storage-sqlite/src/index.ts`:

```typescript
// Implementations (CRUD adapters) come in Phase 1.
export {};
```

- [ ] **Step 2: Create SQLite schema**

Create `packages/storage-sqlite/sql/0001_initial.sql`:

```sql
-- Agent Mouth — base schema (Phase 0)
-- See: docs/superpowers/specs/2026-05-20-agent-mouth-vision-design.md §4

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT,
  plan TEXT NOT NULL DEFAULT 'self-host',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL CHECK (type IN ('telegram', 'email', 'whatsapp', 'discord', 'slack')),
  config TEXT NOT NULL,                -- JSON-serialized, encrypted at app level
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  display_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_identities (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  identifier TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,  -- boolean
  UNIQUE (channel_id, identifier)
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT REFERENCES contacts(id),
  channel_type TEXT,
  policy TEXT NOT NULL CHECK (policy IN ('auto', 'suggest', 'escalate', 'silent')),
  system_prompt TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '{}',     -- JSON-serialized
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_policies_resolution
  ON policies(workspace_id, contact_id, channel_type, priority DESC);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  external_thread_id TEXT,
  related_thread_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  last_message_at TEXT,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  channel_identity_id TEXT REFERENCES channel_identities(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',  -- JSON array
  raw_payload TEXT,                        -- JSON
  external_message_id TEXT,
  sent_by TEXT CHECK (sent_by IN ('human', 'agent') OR sent_by IS NULL),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  proposed_body TEXT NOT NULL,
  agent_reasoning TEXT NOT NULL DEFAULT '',
  tools_called TEXT NOT NULL DEFAULT '[]', -- JSON array
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'edited')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('human', 'agent', 'system')),
  details TEXT NOT NULL DEFAULT '{}',     -- JSON
  related_message_id TEXT REFERENCES messages(id),
  related_contact_id TEXT REFERENCES contacts(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_created ON audit_log(workspace_id, created_at DESC);
```

- [ ] **Step 3: Scaffold storage-postgres package**

```bash
mkdir -p packages/storage-postgres/src packages/storage-postgres/tests packages/storage-postgres/sql
```

Create `packages/storage-postgres/package.json`:

```json
{
  "name": "@agent-mouth/storage-postgres",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js", "./sql/*": "./sql/*" },
  "files": ["dist/", "sql/"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*",
    "postgres": "^3.4.0"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "typescript": "5.5.4",
    "vitest": "^2.1.0"
  }
}
```

Create `packages/storage-postgres/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

Create `packages/storage-postgres/src/index.ts`:

```typescript
// Implementations (CRUD adapters) come in Phase 1.
export {};
```

- [ ] **Step 4: Create Postgres schema**

Create `packages/storage-postgres/sql/0001_initial.sql`. Same as the SQLite schema but using Postgres syntax:

- Replace `TEXT PRIMARY KEY` with `UUID PRIMARY KEY DEFAULT gen_random_uuid()` (requires `pgcrypto` extension)
- Replace `INTEGER` for booleans with `BOOLEAN`
- Replace `TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` with `TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- Replace JSON-stored-as-TEXT with `JSONB`
- Replace `related_thread_ids TEXT` with `related_thread_ids UUID[]`

For brevity in this plan, the implementer should adapt mechanically from the SQLite schema in Step 2 above. **Do NOT skip any table.** Result file must be valid Postgres DDL.

The implementer can verify validity by piping into Supabase SQL Editor (the existing `deicbuvcynqontfbnboe` project — but in a transaction that ROLLBACKs at the end, so no side effects).

Also include at the top:

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
```

- [ ] **Step 5: Verify build**

Run: `pnpm install && pnpm -r build`
Expected: clean (no test files yet for these packages).

- [ ] **Step 6: Commit**

```bash
git add packages/storage-sqlite/ packages/storage-postgres/ pnpm-lock.yaml
git commit -m "feat(storage): add SQLite and Postgres schema scaffolds (Phase 0 §4 entities)"
```

### Task 26: Add schema parse smoke test

**Files:**
- Create: `packages/storage-sqlite/tests/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/storage-sqlite/tests/schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("SQLite schema", () => {
  it("parses and creates all 10 tables in 0001_initial.sql", () => {
    const sql = readFileSync(join(__dirname, "../sql/0001_initial.sql"), "utf8");
    const db = new Database(":memory:");
    db.exec(sql);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toEqual([
      "audit_log",
      "channel_identities",
      "channels",
      "contacts",
      "drafts",
      "messages",
      "policies",
      "threads",
      "users",
      "workspaces",
    ]);

    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/storage-sqlite test`
Expected: FAIL — likely missing `better-sqlite3` install or path errors. Once `pnpm install` completes and the SQL exists from Task 25, this test should pass.

- [ ] **Step 3: If it still fails after pnpm install, debug**

Likely causes: native module compile failure for better-sqlite3 (try `pnpm rebuild better-sqlite3`), schema syntax error (sqlite reports line number).

- [ ] **Step 4: Test passes**

Expected: 1 test passes — confirms schema is syntactically valid AND creates exactly the 10 expected tables.

- [ ] **Step 5: Commit**

```bash
git add packages/storage-sqlite/tests/schema.test.ts
git commit -m "test(storage-sqlite): schema parse smoke test (10 tables verified)"
```

### 🟢 Smoke Test #7 (after Group 7)

- [ ] **Smoke 7.1: Full build + test**

Run: `pnpm -r build && pnpm -r test`
Expected: 44 (prior) + 1 (schema) = 45 tests pass.

- [ ] **Smoke 7.2: Production health check** (still untouched)

Run: `curl -sf https://agent-mouth.fly.dev/health`

---

## Group 8: Dockerfile + Fly.io cutover

The current `Dockerfile` builds `packages/mcp`. We must rewrite it to build `apps/cli` (which is the new `agent-mouth` published package). Verify on the staging app first, then cut over production.

### Task 27: Update Dockerfile to build apps/cli

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Read current Dockerfile**

Run: `cat Dockerfile`

Current CMD: `["node", "dist/cli/index.js", "serve-http"]` from packages/mcp.

- [ ] **Step 2: Rewrite for apps/cli**

Replace contents of `Dockerfile`:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app

# Install pnpm — pinned to v9 (v11+ requires Node 22)
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json                 packages/core/
COPY packages/core/tsconfig.json                packages/core/
COPY packages/storage-supabase/package.json     packages/storage-supabase/
COPY packages/storage-supabase/tsconfig.json    packages/storage-supabase/
COPY packages/storage-sqlite/package.json       packages/storage-sqlite/
COPY packages/storage-sqlite/tsconfig.json      packages/storage-sqlite/
COPY packages/storage-postgres/package.json     packages/storage-postgres/
COPY packages/storage-postgres/tsconfig.json    packages/storage-postgres/
COPY packages/transport-telegram/package.json   packages/transport-telegram/
COPY packages/transport-telegram/tsconfig.json  packages/transport-telegram/
COPY packages/agent/package.json                packages/agent/
COPY packages/agent/tsconfig.json               packages/agent/
COPY packages/api/package.json                  packages/api/
COPY packages/api/tsconfig.json                 packages/api/
COPY apps/cli/package.json                      apps/cli/
COPY apps/cli/tsconfig.json                     apps/cli/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/core/src                          packages/core/src
COPY packages/storage-supabase/src              packages/storage-supabase/src
COPY packages/storage-sqlite/src                packages/storage-sqlite/src
COPY packages/storage-sqlite/sql                packages/storage-sqlite/sql
COPY packages/storage-postgres/src              packages/storage-postgres/src
COPY packages/storage-postgres/sql              packages/storage-postgres/sql
COPY packages/transport-telegram/src            packages/transport-telegram/src
COPY packages/agent/src                         packages/agent/src
COPY packages/api/src                           packages/api/src
COPY apps/cli/src                               apps/cli/src

# Build everything in topological order
RUN pnpm -r build

# Prune to production deps of apps/cli only
RUN pnpm --filter agent-mouth deploy --prod /prod

# --- Runtime image ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /prod/node_modules ./node_modules
COPY --from=builder /prod/package.json ./package.json
COPY --from=builder /prod/dist ./dist

EXPOSE 3000
CMD ["node", "dist/index.js", "serve-http"]
```

- [ ] **Step 3: Verify locally with Docker (if available)**

If Docker is installed locally:
```bash
docker build -t agent-mouth:phase0 .
docker run --rm -e AGENT_MOUTH_BOT_TOKEN=fake -e AGENT_MOUTH_CHAT_ID=-1 \
  -e AGENT_MOUTH_HANDLE=test -e SUPABASE_URL=https://example.com \
  -e SUPABASE_ANON_KEY=fake -p 3000:3000 agent-mouth:phase0 &
sleep 5
curl -s localhost:3000/health
docker stop $(docker ps -q --filter ancestor=agent-mouth:phase0)
```
Expected: `{"ok":true,"handle":"test"}`.

If no Docker locally, skip this and rely on the Fly.io staging deploy in Task 28.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "chore(deploy): update Dockerfile for new monorepo structure (apps/cli as bin)"
```

### Task 28: Deploy to Fly.io staging

**Files:**
- (No code changes — uses staging app created in pre-flight setup.)

- [ ] **Step 1: Deploy to staging**

```bash
cd /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth
flyctl deploy --app agent-mouth-staging --config fly.toml
```

(Note: `fly.toml`'s `app = 'agent-mouth'` may conflict. Override via `--app agent-mouth-staging` should work; if not, copy `fly.toml` → `fly.staging.toml`, change `app =` line, and use `--config fly.staging.toml`.)

Expected: build completes, machines start, health check passes.

- [ ] **Step 2: Verify staging /health**

Run: `curl -sf https://agent-mouth-staging.fly.dev/health`
Expected: `{"ok":true,"handle":"staging_bot"}`.

- [ ] **Step 3: Verify MCP /mcp requires auth**

Run: `curl -s -X POST https://agent-mouth-staging.fly.dev/mcp -d '{}'`
Expected: `{"error":"Unauthorized"}`.

- [ ] **Step 4: Verify MCP /mcp accepts authed call (whoami)**

```bash
STAGING_TOKEN=$(flyctl ssh console -C "printenv AGENT_MOUTH_AUTH_TOKEN" --app agent-mouth-staging)
curl -X POST https://agent-mouth-staging.fly.dev/mcp \
  -H "Authorization: Bearer $STAGING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```
Expected: JSON response with `handle:"staging_bot"`. (Output format depends on MCP SDK; just verify no error.)

- [ ] **Step 5: If smoke tests pass, no commit needed**

If staging fails, debug and iterate. **Do not proceed to Task 29 until staging is green.**

### Task 29: Cutover production

**Files:**
- (No code changes; pure deploy.)

- [ ] **Step 1: Merge feat/phase-0-refactor to main**

```bash
cd /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth
git checkout main
git merge --no-ff feat/phase-0-refactor -m "feat: Phase 0 — core refactor (#PHASE-0)"
```

(Manual `git push origin main` will be needed; the classifier blocks it from this session.)

- [ ] **Step 2: Wait for user to confirm push to main**

(Implementer pauses here. User pushes manually.)

- [ ] **Step 3: Deploy to production**

```bash
flyctl deploy --app agent-mouth
```
Expected: build completes, machines roll, health check passes within 60s.

- [ ] **Step 4: Verify production /health**

Run: `curl -sf https://agent-mouth.fly.dev/health`
Expected: `{"ok":true,"handle":"Gavrilux_bot"}`.

- [ ] **Step 5: Verify Claude Code still works**

Open a fresh Claude Code conversation. Run a prompt:

> "Call the agent-mouth whoami tool"

Expected: `Gavrilux_bot` returned. **This is the Phase 0 gate.**

- [ ] **Step 6: Tag release**

```bash
git tag -a phase-0-complete -m "Phase 0 — core refactor LIVE in production"
git push origin phase-0-complete  # user does this manually
```

### 🟢 Smoke Test #8 (Phase 0 gate)

- [ ] **Smoke 8.1: agent-mouth.fly.dev /health returns 200**

- [ ] **Smoke 8.2: Claude Code whoami succeeds**

- [ ] **Smoke 8.3: All tests pass on main**

Run: `pnpm -r test`
Expected: 45 tests pass.

**If all 8.x pass, Phase 0 is complete and gate is met.**

---

## Group 9: Cleanup packages/mcp

After production is verified stable for at least 24 hours (or one usage session), delete the now-empty `packages/mcp`.

### Task 30: Verify packages/mcp has no orphan code

**Files:**
- Audit: `packages/mcp/src/**`

- [ ] **Step 1: List remaining source files**

Run: `find packages/mcp/src -type f -name "*.ts" | xargs grep -L "^export.*from\|^// Re-export"`

Expected output: empty (all files are now thin re-exports).

If any file has real logic, it indicates an oversight from earlier tasks — investigate and migrate before continuing.

- [ ] **Step 2: List tests still in packages/mcp**

Run: `ls packages/mcp/tests/unit/`

Expected: same 5 tests that were originally there.

- [ ] **Step 3: Confirm tests are now duplicated in other packages**

For each test in `packages/mcp/tests/unit/`, verify the equivalent exists in `packages/api/tests/` or `packages/transport-telegram/tests/` (see Tasks 15, 19, 20, 21).

### Task 31: Delete packages/mcp

**Files:**
- Delete: `packages/mcp/`

- [ ] **Step 1: Remove the package**

```bash
git rm -r packages/mcp
```

- [ ] **Step 2: Run all tests + build**

Run: `pnpm install && pnpm -r build && pnpm -r test`
Expected: 27 tests pass (no mcp tests): 11 api + 4 storage-supabase + 7 transport-telegram + 1 agent + 3 core + 1 storage-sqlite schema. No build errors.

- [ ] **Step 3: Verify apps/cli still works**

Same smoke test as Task 23 Step 6.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove deprecated packages/mcp (all logic migrated to new packages)"
```

- [ ] **Step 5: Push to main (manual by user)**

After push, redeploy is optional — same code, just cleaner repo. The implementer may schedule a deploy to be safe:

```bash
flyctl deploy --app agent-mouth
```

### 🟢 Final Smoke Test (after Group 9)

- [ ] **Smoke F.1: Production /health**

Run: `curl -sf https://agent-mouth.fly.dev/health`

- [ ] **Smoke F.2: All tests pass**

Run: `pnpm -r test`

- [ ] **Smoke F.3: Repo structure matches target**

Run: `ls packages/ apps/`
Expected:
```
packages/  agent  api  core  storage-postgres  storage-sqlite  storage-supabase  transport-telegram
apps/      cli
```

(No `mcp/` directory.)

---

## Self-Review Checklist (run by implementer before each commit)

- [ ] All file paths in this task exist in the current branch.
- [ ] Code blocks compile (no syntax errors after copy).
- [ ] Imports updated to new package names.
- [ ] Tests run and pass.
- [ ] Commit message follows convention (`feat(scope):`, `refactor(scope):`, `chore(scope):`, etc.).

---

## What this plan does NOT do (deferred to later phases)

- ❌ Implement `ContactStore`, `IdentityResolver`, `PolicyEngine` (Phase 1)
- ❌ Implement `EmailTransport` (Phase 1)
- ❌ Implement `AgentRuntime` (Phase 2)
- ❌ Implement `VectorStore` (Phase 3)
- ❌ Wire SQLite/Postgres adapters into runtime (Phase 1+ — schemas exist in Phase 0, but no app code reads/writes them yet)
- ❌ Multi-tenant auth, billing, hosted dashboard (Phase 5)

Phase 0 is **pure infrastructure**: split the monolith, lay schemas, keep behavior identical. Nothing user-facing changes.

---

## Rollback strategy

If any production deploy fails after Task 29:

```bash
flyctl releases --app agent-mouth                       # find previous version
flyctl releases rollback <version> --app agent-mouth    # instant rollback
```

The previous version (current `main` before Phase 0 merge) is one Docker image away. **The refactor is fully reversible until packages/mcp is deleted in Task 31.** After that, only by reverting commits + redeploy.

---

## Estimated effort

- Group 1 (workspace skeleton): 1 hour
- Group 2 (core): 2-3 hours
- Group 3 (storage-supabase): 2 hours
- Group 4 (transport-telegram): 2 hours
- Group 5 (api — largest): 4-6 hours
- Group 6 (apps/cli): 2 hours
- Group 7 (schemas): 2-3 hours
- Group 8 (Dockerfile + Fly cutover): 2-4 hours (incl. debugging)
- Group 9 (cleanup): 1 hour

**Total: ~18-25 hours of focused work**, spread over ~2 weeks calendar time.

Each Group's Smoke Test is a natural pause point. Splitting work over multiple sessions: ideal break points are between Groups 4, 6, and 8.
