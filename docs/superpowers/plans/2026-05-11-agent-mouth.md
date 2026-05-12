# Agent Mouth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an open-source MCP server that lets AI agents from different people communicate directly via a shared Postgres backend, with chat + task-queue semantics.

**Architecture:** Monorepo with `packages/mcp` (TypeScript MCP server) and `packages/sql` (Postgres migrations). Each user installs the package locally, points it to a shared Postgres URL, registers an agent handle. Realtime via `LISTEN/NOTIFY`. Self-hosted, no central service.

**Tech Stack:** TypeScript 5.5+, Node 20 LTS, `@modelcontextprotocol/sdk`, `postgres` (postgres.js client), `pino` (logging), Vitest (testing), Biome (lint+format), `testcontainers` (integration DB), `bcrypt`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-05-11-agent-mouth-design.md`

---

## Implementation Phases

| Phase | Tasks | Result |
|-------|-------|--------|
| 1. Project foundation | 1-3 | Empty monorepo with TS, Vitest, Biome, CI scaffolding |
| 2. Database layer | 4-7 | Migration runner + tables + integration test setup |
| 3. Auth | 8-9 | Token generation + verification |
| 4. MCP server skeleton | 10-11 | Server that responds to MCP requests with a stub tool |
| 5. Identity tools | 12-15 | whoami, list_contacts, register_subagent, unregister_subagent |
| 6. Messaging tools | 16-19 | send_message, read_inbox, get_thread, mark_thread_read |
| 7. Tasks tools | 20-24 | create_task, list_tasks, accept_task, complete_task, reject_task |
| 8. Realtime | 25-26 | wait_for_messages via LISTEN/NOTIFY |
| 9. CLI | 27-29 | init, join, serve commands |
| 10. E2E + CI | 30-31 | Two-agent flow test + GitHub Actions |
| 11. Polish | 32-33 | README, quickstart, npm publish prep |

---

## Phase 1: Project foundation

### Task 1: Initialize monorepo with pnpm workspaces

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `.nvmrc`

- [ ] **Step 1: `git init` the project**

```bash
cd ~/CerebroDigital/02-Proyectos/agent-mouth
git init
git branch -M main
```

- [ ] **Step 2: Create `.nvmrc`**

```
20
```

- [ ] **Step 3: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 4: Create root `package.json`**

```json
{
  "name": "agent-mouth-monorepo",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "biome check .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "1.9.4",
    "typescript": "5.5.4"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
~/.agent-mouth/
coverage/
.env
.env.local
```

- [ ] **Step 6: Initialize git and commit**

```bash
pnpm install
git add .
git commit -m "chore: init monorepo with pnpm workspaces"
```

---

### Task 2: Configure TypeScript and Biome

**Files:**
- Create: `tsconfig.base.json`
- Create: `biome.json`

- [ ] **Step 1: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  }
}
```

- [ ] **Step 2: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "off" }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  }
}
```

- [ ] **Step 3: Verify Biome works**

```bash
pnpm exec biome check .
```

Expected: passes with no errors.

- [ ] **Step 4: Commit**

```bash
git add tsconfig.base.json biome.json
git commit -m "chore: configure TypeScript and Biome"
```

---

### Task 3: Scaffold `packages/mcp` and `packages/sql`

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/tsconfig.json`
- Create: `packages/mcp/vitest.config.ts`
- Create: `packages/mcp/src/index.ts`
- Create: `packages/sql/package.json`
- Create: `packages/sql/migrations/.gitkeep`

- [ ] **Step 1: Create `packages/mcp/package.json`**

```json
{
  "name": "agent-mouth",
  "version": "0.0.1",
  "type": "module",
  "bin": { "agent-mouth": "./dist/cli/index.js" },
  "exports": { ".": "./dist/index.js" },
  "files": ["dist/", "README.md"],
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "postgres": "^3.4.4",
    "bcrypt": "^5.1.1",
    "pino": "^9.4.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.2",
    "@types/node": "^20.16.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "@testcontainers/postgresql": "^10.13.0",
    "typescript": "5.5.4"
  }
}
```

- [ ] **Step 2: Create `packages/mcp/tsconfig.json`**

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

- [ ] **Step 3: Create `packages/mcp/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**"]
    },
    testTimeout: 30000
  }
});
```

- [ ] **Step 4: Create `packages/mcp/src/index.ts`**

```ts
export const VERSION = "0.0.1";
```

- [ ] **Step 5: Create `packages/sql/package.json`**

```json
{
  "name": "@agent-mouth/sql",
  "version": "0.0.1",
  "private": true,
  "files": ["migrations/"]
}
```

- [ ] **Step 6: Install and verify**

```bash
pnpm install
pnpm -r build
```

Expected: build succeeds in `packages/mcp/dist/`.

- [ ] **Step 7: Commit**

```bash
git add packages/ pnpm-lock.yaml
git commit -m "chore: scaffold mcp and sql packages"
```

---

## Phase 2: Database layer

### Task 4: Write the initial SQL migration

**Files:**
- Create: `packages/sql/migrations/001_initial.sql`

- [ ] **Step 1: Create `packages/sql/migrations/001_initial.sql`**

```sql
-- 001_initial.sql — Agent Mouth core schema

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle          TEXT UNIQUE NOT NULL,
  display_name    TEXT,
  token_hash      TEXT NOT NULL,
  parent_handle   TEXT REFERENCES agents(handle) ON DELETE CASCADE,
  visibility      TEXT NOT NULL DEFAULT 'public'
                  CHECK (visibility IN ('public', 'private')),
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ
);
CREATE INDEX idx_agents_parent ON agents(parent_handle);
CREATE INDEX idx_agents_expires ON agents(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE threads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT,
  kind            TEXT NOT NULL DEFAULT 'dm'
                  CHECK (kind IN ('dm', 'group')),
  created_by      UUID REFERENCES agents(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE thread_participants (
  thread_id       UUID REFERENCES threads(id) ON DELETE CASCADE,
  agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, agent_id)
);

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES agents(id),
  body            TEXT NOT NULL,
  reply_to        UUID REFERENCES messages(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_thread_time ON messages(thread_id, created_at DESC);

CREATE TABLE tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  assigned_to      UUID NOT NULL REFERENCES agents(id),
  title            TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'in_progress',
                                     'completed', 'rejected', 'cancelled')),
  result           TEXT,
  rejection_reason TEXT,
  accepted_at      TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_assignee_status ON tasks(assigned_to, status);

-- Trigger: NOTIFY each participant when a message arrives
CREATE OR REPLACE FUNCTION notify_recipients()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE threads SET last_message_at = NEW.created_at WHERE id = NEW.thread_id;
  PERFORM pg_notify(
    'agent_' || tp.agent_id::text,
    json_build_object(
      'type', 'new_message',
      'message_id', NEW.id,
      'thread_id', NEW.thread_id,
      'sender_id', NEW.sender_id
    )::text
  )
  FROM thread_participants tp
  WHERE tp.thread_id = NEW.thread_id AND tp.agent_id != NEW.sender_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_message_notify
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION notify_recipients();

-- Migration version tracking
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES ('001_initial');
```

- [ ] **Step 2: Commit**

```bash
git add packages/sql/migrations/001_initial.sql
git commit -m "feat(sql): initial schema with agents, threads, messages, tasks"
```

---

### Task 5: Build the migration runner

**Files:**
- Create: `packages/mcp/src/db/migrate.ts`
- Create: `packages/mcp/src/db/client.ts`
- Test: `packages/mcp/tests/integration/migrate.test.ts`

- [ ] **Step 1: Write the failing test `packages/mcp/tests/integration/migrate.test.ts`**

```ts
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../../src/db/migrate.js";

describe("migrate", () => {
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let sql: postgres.Sql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = postgres(container.getConnectionUri());
  });

  afterAll(async () => {
    await sql.end();
    await container.stop();
  });

  it("applies all migrations idempotently", async () => {
    await runMigrations(sql);
    await runMigrations(sql);

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    const names = tables.map((t) => t.table_name);
    expect(names).toContain("agents");
    expect(names).toContain("messages");
    expect(names).toContain("tasks");
    expect(names).toContain("threads");
    expect(names).toContain("thread_participants");
    expect(names).toContain("schema_migrations");
  });

  it("records applied migrations", async () => {
    const versions = await sql<{ version: string }[]>`
      SELECT version FROM schema_migrations ORDER BY version
    `;
    expect(versions.map((v) => v.version)).toContain("001_initial");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/mcp
pnpm test -- migrate.test.ts
```

Expected: FAIL — `runMigrations` not defined.

- [ ] **Step 3: Create `packages/mcp/src/db/client.ts`**

```ts
import postgres from "postgres";

export type Sql = postgres.Sql;

export function createClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    onnotice: () => {}, // suppress NOTICE log spam
    max: 10
  });
}
```

- [ ] **Step 4: Create `packages/mcp/src/db/migrate.ts`**

```ts
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./client.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../sql/migrations"
);

export async function runMigrations(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const applied = await sql<{ version: string }[]>`
    SELECT version FROM schema_migrations
  `;
  const appliedSet = new Set(applied.map((r) => r.version));

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (appliedSet.has(version)) continue;
    const contents = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await sql.unsafe(contents);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test -- migrate.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/db/ packages/mcp/tests/
git commit -m "feat(db): migration runner with idempotency"
```

---

### Task 6: Create test helper for spinning up Postgres + migrations

**Files:**
- Create: `packages/mcp/tests/helpers/db.ts`

- [ ] **Step 1: Create `packages/mcp/tests/helpers/db.ts`**

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { runMigrations } from "../../src/db/migrate.js";
import type { Sql } from "../../src/db/client.js";

export interface TestDb {
  sql: Sql;
  url: string;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:17-alpine"
  ).start();
  const url = container.getConnectionUri();
  const sql = postgres(url, { max: 5, onnotice: () => {} });
  await runMigrations(sql);
  return {
    sql,
    url,
    stop: async () => {
      await sql.end();
      await container.stop();
    }
  };
}

export async function truncateAll(sql: Sql): Promise<void> {
  await sql`
    TRUNCATE agents, threads, thread_participants, messages, tasks
    RESTART IDENTITY CASCADE
  `;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/mcp/tests/helpers/
git commit -m "test(db): shared test container helper"
```

---

### Task 7: Define typed DB row interfaces

**Files:**
- Create: `packages/mcp/src/db/types.ts`

- [ ] **Step 1: Create `packages/mcp/src/db/types.ts`**

```ts
export interface AgentRow {
  id: string;
  handle: string;
  display_name: string | null;
  token_hash: string;
  parent_handle: string | null;
  visibility: "public" | "private";
  metadata: Record<string, unknown>;
  created_at: Date;
  expires_at: Date | null;
  last_seen_at: Date | null;
}

export interface ThreadRow {
  id: string;
  title: string | null;
  kind: "dm" | "group";
  created_by: string | null;
  created_at: Date;
  last_message_at: Date;
}

export interface ThreadParticipantRow {
  thread_id: string;
  agent_id: string;
  joined_at: Date;
  last_read_at: Date;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  sender_id: string;
  body: string;
  reply_to: string | null;
  created_at: Date;
}

export interface TaskRow {
  id: string;
  message_id: string;
  assigned_to: string;
  title: string;
  description: string | null;
  status: "pending" | "accepted" | "in_progress" | "completed" | "rejected" | "cancelled";
  result: string | null;
  rejection_reason: string | null;
  accepted_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/mcp/src/db/types.ts
git commit -m "feat(db): typed row interfaces"
```

---

## Phase 3: Auth

### Task 8: Token generation and verification

**Files:**
- Create: `packages/mcp/src/auth/token.ts`
- Test: `packages/mcp/tests/unit/token.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/unit/token.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { generateToken, hashToken, verifyToken } from "../../src/auth/token.js";

describe("token", () => {
  it("generates a 36-char UUID v4", () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("verifies a hashed token", async () => {
    const t = generateToken();
    const hash = await hashToken(t);
    expect(await verifyToken(t, hash)).toBe(true);
    expect(await verifyToken("wrong-token", hash)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
pnpm test -- token.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/auth/token.ts`**

```ts
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";

const BCRYPT_ROUNDS = 10;

export function generateToken(): string {
  return randomUUID();
}

export async function hashToken(token: string): Promise<string> {
  return bcrypt.hash(token, BCRYPT_ROUNDS);
}

export async function verifyToken(token: string, hash: string): Promise<boolean> {
  return bcrypt.compare(token, hash);
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
pnpm test -- token.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/auth/ packages/mcp/tests/unit/token.test.ts
git commit -m "feat(auth): token generation and bcrypt verification"
```

---

### Task 9: Local config file (read/write `~/.agent-mouth/config.json`)

**Files:**
- Create: `packages/mcp/src/auth/config.ts`
- Test: `packages/mcp/tests/unit/config.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/unit/config.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/auth/config.js";

describe("config", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "am-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("returns null when file does not exist", async () => {
    expect(await loadConfig(join(tmp, "config.json"))).toBeNull();
  });

  it("round-trips a config", async () => {
    const path = join(tmp, "config.json");
    await saveConfig(path, {
      databaseUrl: "postgresql://localhost/test",
      handle: "gavrilo-backend",
      agentToken: "xyz"
    });
    const loaded = await loadConfig(path);
    expect(loaded?.handle).toBe("gavrilo-backend");
    expect(loaded?.agentToken).toBe("xyz");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- config.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/auth/config.ts`**

```ts
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  databaseUrl: string;
  handle: string;
  agentToken: string;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".agent-mouth", "config.json");
}

export async function loadConfig(path: string = defaultConfigPath()): Promise<Config | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveConfig(
  path: string,
  config: Config
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
  await chmod(path, 0o600);
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
pnpm test -- config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/auth/config.ts packages/mcp/tests/unit/config.test.ts
git commit -m "feat(auth): load/save local config with 0600 perms"
```

---

## Phase 4: MCP server skeleton

### Task 10: Session context (resolve agent from token)

**Files:**
- Create: `packages/mcp/src/session.ts`
- Test: `packages/mcp/tests/integration/session.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/integration/session.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../helpers/db.js";
import { generateToken, hashToken } from "../../src/auth/token.js";
import { resolveSession } from "../../src/session.js";

describe("session", () => {
  let db: TestDb;
  let token: string;

  beforeAll(async () => {
    db = await startTestDb();
    token = generateToken();
    const hash = await hashToken(token);
    await db.sql`
      INSERT INTO agents (handle, display_name, token_hash, visibility)
      VALUES ('gavrilo', 'Gavrilo', ${hash}, 'public')
    `;
  });
  afterAll(() => db.stop());

  it("resolves agent from valid token", async () => {
    const session = await resolveSession(db.sql, "gavrilo", token);
    expect(session.agent.handle).toBe("gavrilo");
  });

  it("rejects invalid token", async () => {
    await expect(resolveSession(db.sql, "gavrilo", "wrong")).rejects.toThrow("AUTH_ERROR");
  });

  it("rejects unknown handle", async () => {
    await expect(resolveSession(db.sql, "nobody", token)).rejects.toThrow("AUTH_ERROR");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- session.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/session.ts`**

```ts
import type { Sql } from "./db/client.js";
import type { AgentRow } from "./db/types.js";
import { verifyToken } from "./auth/token.js";

export interface Session {
  agent: AgentRow;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AUTH_ERROR";
  }
}

export async function resolveSession(
  sql: Sql,
  handle: string,
  token: string
): Promise<Session> {
  const rows = await sql<AgentRow[]>`
    SELECT * FROM agents WHERE handle = ${handle}
  `;
  if (rows.length === 0) throw new AuthError("AUTH_ERROR: unknown handle");
  const agent = rows[0]!;
  const ok = await verifyToken(token, agent.token_hash);
  if (!ok) throw new AuthError("AUTH_ERROR: invalid token");

  await sql`UPDATE agents SET last_seen_at = now() WHERE id = ${agent.id}`;
  return { agent };
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
pnpm test -- session.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/session.ts packages/mcp/tests/integration/session.test.ts
git commit -m "feat(session): resolve agent from token"
```

---

### Task 11: MCP server bootstrap with a single stub tool

**Files:**
- Create: `packages/mcp/src/server.ts`
- Create: `packages/mcp/src/logger.ts`
- Test: `packages/mcp/tests/integration/server.test.ts`

- [ ] **Step 1: Create `packages/mcp/src/logger.ts`**

```ts
import pino from "pino";

export const logger = pino({
  level: process.env.AGENT_MOUTH_LOG ?? "info",
  transport: { target: "pino/file", options: { destination: 2 } } // stderr (stdout is reserved for MCP)
});
```

- [ ] **Step 2: Write failing test `packages/mcp/tests/integration/server.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startTestDb, type TestDb } from "../helpers/db.js";
import { generateToken, hashToken } from "../../src/auth/token.js";
import { buildServer } from "../../src/server.js";

describe("server bootstrap", () => {
  let db: TestDb;
  let token: string;

  beforeAll(async () => {
    db = await startTestDb();
    token = generateToken();
    const hash = await hashToken(token);
    await db.sql`
      INSERT INTO agents (handle, display_name, token_hash)
      VALUES ('gavrilo', 'Gavrilo', ${hash})
    `;
  });
  afterAll(() => db.stop());

  it("lists registered tools including whoami", async () => {
    const server = buildServer({ sql: db.sql, handle: "gavrilo", token });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(clientT);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("whoami");
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

```bash
pnpm test -- server.test.ts
```

- [ ] **Step 4: Create `packages/mcp/src/server.ts`**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Sql } from "./db/client.js";
import { resolveSession } from "./session.js";
import { logger } from "./logger.js";

export interface ServerOptions {
  sql: Sql;
  handle: string;
  token: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler: (input: unknown, ctx: { sql: Sql; agentId: string; handle: string }) => Promise<unknown>;
}

const tools: ToolDef[] = [];

export function registerTool(tool: ToolDef): void {
  tools.push(tool);
}

export function buildServer(opts: ServerOptions): Server {
  const server = new Server(
    { name: "agent-mouth", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    const session = await resolveSession(opts.sql, opts.handle, opts.token);
    try {
      const result = await tool.handler(request.params.arguments ?? {}, {
        sql: opts.sql,
        agentId: session.agent.id,
        handle: session.agent.handle
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, data: result }) }]
      };
    } catch (err) {
      const e = err as Error;
      logger.error({ err: e, tool: request.params.name }, "tool failed");
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: false, error: { code: e.name, message: e.message } }) }
        ],
        isError: true
      };
    }
  });

  // Register whoami stub so the test passes; real impl in Task 12.
  registerTool({
    name: "whoami",
    description: "Stub",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => ({ handle: ctx.handle })
  });

  return server;
}
```

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- server.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/server.ts packages/mcp/src/logger.ts packages/mcp/tests/integration/server.test.ts
git commit -m "feat(server): MCP server with tool registry and auth wrapping"
```

---

## Phase 5: Identity tools

### Task 12: `whoami` (full impl) + helpers for handle/agent lookup

**Files:**
- Create: `packages/mcp/src/tools/identity.ts`
- Create: `packages/mcp/src/tools/_register.ts`
- Test: `packages/mcp/tests/integration/tools-identity.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/integration/tools-identity.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startTestDb, type TestDb, truncateAll } from "../helpers/db.js";
import { generateToken, hashToken } from "../../src/auth/token.js";
import { buildServer } from "../../src/server.js";

async function callTool(client: Client, name: string, args: object) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text) as { ok: boolean; data?: any; error?: any };
}

describe("identity tools", () => {
  let db: TestDb;

  beforeAll(async () => { db = await startTestDb(); });
  beforeEach(async () => { await truncateAll(db.sql); });
  afterAll(() => db.stop());

  async function connect(handle: string, token: string) {
    const server = buildServer({ sql: db.sql, handle, token });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(c);
    return client;
  }

  it("whoami returns the calling agent's profile", async () => {
    const token = generateToken();
    await db.sql`
      INSERT INTO agents (handle, display_name, token_hash)
      VALUES ('gavrilo', 'Gavrilo · Backend', ${await hashToken(token)})
    `;
    const client = await connect("gavrilo", token);
    const r = await callTool(client, "whoami", {});
    expect(r.ok).toBe(true);
    expect(r.data.handle).toBe("gavrilo");
    expect(r.data.display_name).toBe("Gavrilo · Backend");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-identity.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/tools/identity.ts`**

```ts
import { z } from "zod";
import type { Sql } from "../db/client.js";
import type { AgentRow } from "../db/types.js";
import type { ToolDef } from "../server.js";

export const whoamiTool: ToolDef = {
  name: "whoami",
  description: "Returns the calling agent's profile (handle, display name, parent, visibility, metadata).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_input, { sql, agentId }) => {
    const rows = await sql<AgentRow[]>`SELECT * FROM agents WHERE id = ${agentId}`;
    const a = rows[0]!;
    return {
      handle: a.handle,
      display_name: a.display_name,
      parent_handle: a.parent_handle,
      visibility: a.visibility,
      metadata: a.metadata
    };
  }
};
```

- [ ] **Step 4: Create `packages/mcp/src/tools/_register.ts`**

```ts
import { registerTool } from "../server.js";
import { whoamiTool } from "./identity.js";

let registered = false;

export function registerAllTools(): void {
  if (registered) return;
  registerTool(whoamiTool);
  registered = true;
}
```

- [ ] **Step 5: Update `packages/mcp/src/server.ts` to import and call `registerAllTools()`**

Replace the inline `registerTool({ name: "whoami", ... })` stub at the bottom of `buildServer` with:

```ts
import { registerAllTools } from "./tools/_register.js";

// inside buildServer, before `return server;`:
registerAllTools();
```

Delete the stub registration that was there.

- [ ] **Step 6: Run, expect PASS**

```bash
pnpm test -- tools-identity.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/src/server.ts packages/mcp/tests/integration/tools-identity.test.ts
git commit -m "feat(tools): whoami"
```

---

### Task 13: `list_contacts` with visibility filtering

**Files:**
- Modify: `packages/mcp/src/tools/identity.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/integration/tools-identity.test.ts`

- [ ] **Step 1: Add failing test to `tools-identity.test.ts`**

```ts
it("list_contacts excludes private agents that are not your descendants", async () => {
  const gToken = generateToken();
  const mToken = generateToken();
  await db.sql`
    INSERT INTO agents (handle, token_hash, visibility) VALUES
      ('gavrilo', ${await hashToken(gToken)}, 'public'),
      ('marco', ${await hashToken(mToken)}, 'public'),
      ('marco-secret-bot', ${await hashToken(generateToken())}, 'private')
  `;
  await db.sql`UPDATE agents SET parent_handle = 'marco' WHERE handle = 'marco-secret-bot'`;

  const client = await connect("gavrilo", gToken);
  const r = await callTool(client, "list_contacts", {});
  expect(r.ok).toBe(true);
  const handles = (r.data as { handle: string }[]).map((c) => c.handle);
  expect(handles).toContain("marco");
  expect(handles).not.toContain("marco-secret-bot");
  expect(handles).not.toContain("gavrilo"); // exclude self
});

it("list_contacts includes your own private subagents", async () => {
  const gToken = generateToken();
  await db.sql`
    INSERT INTO agents (handle, token_hash, visibility) VALUES
      ('gavrilo', ${await hashToken(gToken)}, 'public'),
      ('gavrilo-tester', ${await hashToken(generateToken())}, 'private')
  `;
  await db.sql`UPDATE agents SET parent_handle = 'gavrilo' WHERE handle = 'gavrilo-tester'`;

  const client = await connect("gavrilo", gToken);
  const r = await callTool(client, "list_contacts", {});
  const handles = (r.data as { handle: string }[]).map((c) => c.handle);
  expect(handles).toContain("gavrilo-tester");
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-identity.test.ts
```

- [ ] **Step 3: Append to `packages/mcp/src/tools/identity.ts`**

```ts
export const listContactsTool: ToolDef = {
  name: "list_contacts",
  description: "Lists agents visible to you (excludes yourself, excludes private agents that aren't your descendants).",
  inputSchema: {
    type: "object",
    properties: {
      visibility: { type: "string", enum: ["public", "all"] }
    },
    additionalProperties: false
  },
  handler: async (input, { sql, agentId, handle }) => {
    const parsed = z.object({ visibility: z.enum(["public", "all"]).optional() }).parse(input);
    const includeAll = parsed.visibility === "all";

    const rows = await sql<{
      handle: string;
      display_name: string | null;
      visibility: string;
      parent_handle: string | null;
      last_seen_at: Date | null;
    }[]>`
      SELECT handle, display_name, visibility, parent_handle, last_seen_at
      FROM agents
      WHERE id != ${agentId}
        AND (expires_at IS NULL OR expires_at > now())
        AND (
          visibility = 'public'
          OR ${includeAll}
          OR parent_handle = ${handle}
        )
      ORDER BY last_seen_at DESC NULLS LAST
    `;

    return rows.map((r) => ({
      handle: r.handle,
      display_name: r.display_name,
      visibility: r.visibility,
      parent_handle: r.parent_handle,
      last_seen_at: r.last_seen_at,
      online: r.last_seen_at ? Date.now() - r.last_seen_at.getTime() < 60_000 : false
    }));
  }
};
```

- [ ] **Step 4: Update `_register.ts`**

```ts
import { whoamiTool, listContactsTool } from "./identity.js";
// ...
registerTool(whoamiTool);
registerTool(listContactsTool);
```

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-identity.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/tests/integration/tools-identity.test.ts
git commit -m "feat(tools): list_contacts with visibility filtering"
```

---

### Task 14: `register_subagent`

**Files:**
- Modify: `packages/mcp/src/tools/identity.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/integration/tools-identity.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it("register_subagent creates child with TTL and returns one-time token", async () => {
  const gToken = generateToken();
  await db.sql`
    INSERT INTO agents (handle, token_hash) VALUES ('gavrilo', ${await hashToken(gToken)})
  `;
  const client = await connect("gavrilo", gToken);
  const r = await callTool(client, "register_subagent", {
    handle: "gavrilo-tester",
    ttl_minutes: 60,
    visibility: "private"
  });
  expect(r.ok).toBe(true);
  expect(r.data.handle).toBe("gavrilo-tester");
  expect(r.data.agent_token).toMatch(/^[0-9a-f-]{36}$/);

  const rows = await db.sql`
    SELECT parent_handle, visibility, expires_at FROM agents WHERE handle = 'gavrilo-tester'
  `;
  expect(rows[0].parent_handle).toBe("gavrilo");
  expect(rows[0].visibility).toBe("private");
  expect(rows[0].expires_at).toBeInstanceOf(Date);
});

it("register_subagent rejects duplicate handle", async () => {
  const gToken = generateToken();
  await db.sql`
    INSERT INTO agents (handle, token_hash) VALUES
      ('gavrilo', ${await hashToken(gToken)}),
      ('taken', ${await hashToken(generateToken())})
  `;
  const client = await connect("gavrilo", gToken);
  const r = await callTool(client, "register_subagent", { handle: "taken" });
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe("HANDLE_TAKEN");
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-identity.test.ts
```

- [ ] **Step 3: Append to `packages/mcp/src/tools/identity.ts`**

```ts
import { generateToken, hashToken } from "../auth/token.js";

export class HandleTakenError extends Error {
  constructor(handle: string) {
    super(`HANDLE_TAKEN: ${handle}`);
    this.name = "HANDLE_TAKEN";
  }
}

export const registerSubagentTool: ToolDef = {
  name: "register_subagent",
  description: "Registers a subagent under your handle. Returns a one-time agent_token that the subagent process must use to authenticate.",
  inputSchema: {
    type: "object",
    required: ["handle"],
    properties: {
      handle: { type: "string", minLength: 1, maxLength: 64 },
      display_name: { type: "string" },
      ttl_minutes: { type: "integer", minimum: 1 },
      visibility: { type: "string", enum: ["public", "private"] }
    },
    additionalProperties: false
  },
  handler: async (input, { sql, handle: parentHandle }) => {
    const parsed = z
      .object({
        handle: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
        display_name: z.string().optional(),
        ttl_minutes: z.number().int().positive().optional(),
        visibility: z.enum(["public", "private"]).optional().default("private")
      })
      .parse(input);

    const existing = await sql`SELECT 1 FROM agents WHERE handle = ${parsed.handle}`;
    if (existing.length > 0) throw new HandleTakenError(parsed.handle);

    const token = generateToken();
    const hash = await hashToken(token);
    const expiresAt = parsed.ttl_minutes
      ? new Date(Date.now() + parsed.ttl_minutes * 60_000)
      : null;

    await sql`
      INSERT INTO agents (handle, display_name, token_hash, parent_handle, visibility, expires_at)
      VALUES (${parsed.handle}, ${parsed.display_name ?? null}, ${hash},
              ${parentHandle}, ${parsed.visibility}, ${expiresAt})
    `;

    return { handle: parsed.handle, agent_token: token, expires_at: expiresAt };
  }
};
```

- [ ] **Step 4: Update `_register.ts`**

```ts
import { whoamiTool, listContactsTool, registerSubagentTool } from "./identity.js";
// ...
registerTool(registerSubagentTool);
```

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-identity.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/identity.ts packages/mcp/src/tools/_register.ts packages/mcp/tests/integration/tools-identity.test.ts
git commit -m "feat(tools): register_subagent"
```

---

### Task 15: `unregister_subagent`

**Files:**
- Modify: `packages/mcp/src/tools/identity.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/integration/tools-identity.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it("unregister_subagent deletes only your own subagents", async () => {
  const gToken = generateToken();
  const mToken = generateToken();
  await db.sql`
    INSERT INTO agents (handle, token_hash) VALUES
      ('gavrilo', ${await hashToken(gToken)}),
      ('marco', ${await hashToken(mToken)})
  `;
  await db.sql`
    INSERT INTO agents (handle, token_hash, parent_handle) VALUES
      ('gavrilo-sub', ${await hashToken(generateToken())}, 'gavrilo'),
      ('marco-sub', ${await hashToken(generateToken())}, 'marco')
  `;
  const client = await connect("gavrilo", gToken);

  const ok = await callTool(client, "unregister_subagent", { handle: "gavrilo-sub" });
  expect(ok.ok).toBe(true);

  const fail = await callTool(client, "unregister_subagent", { handle: "marco-sub" });
  expect(fail.ok).toBe(false);
  expect(fail.error.code).toBe("NOT_FOUND");

  const remaining = await db.sql`SELECT handle FROM agents WHERE parent_handle IS NOT NULL`;
  expect(remaining.map((r) => r.handle)).toEqual(["marco-sub"]);
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-identity.test.ts
```

- [ ] **Step 3: Append to `packages/mcp/src/tools/identity.ts`**

```ts
export class NotFoundError extends Error {
  constructor(message: string) {
    super(`NOT_FOUND: ${message}`);
    this.name = "NOT_FOUND";
  }
}

export const unregisterSubagentTool: ToolDef = {
  name: "unregister_subagent",
  description: "Deletes a subagent that you own (parent_handle = you).",
  inputSchema: {
    type: "object",
    required: ["handle"],
    properties: { handle: { type: "string" } },
    additionalProperties: false
  },
  handler: async (input, { sql, handle: parentHandle }) => {
    const parsed = z.object({ handle: z.string() }).parse(input);
    const result = await sql`
      DELETE FROM agents
      WHERE handle = ${parsed.handle} AND parent_handle = ${parentHandle}
    `;
    if (result.count === 0) {
      throw new NotFoundError(`no subagent '${parsed.handle}' under '${parentHandle}'`);
    }
    return { ok: true };
  }
};
```

- [ ] **Step 4: Update `_register.ts`** to add `unregisterSubagentTool`.

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-identity.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/identity.ts packages/mcp/src/tools/_register.ts packages/mcp/tests/integration/tools-identity.test.ts
git commit -m "feat(tools): unregister_subagent"
```

---

## Phase 6: Messaging tools

### Task 16: Thread resolution helper + `send_message`

**Files:**
- Create: `packages/mcp/src/tools/_helpers.ts`
- Create: `packages/mcp/src/tools/messaging.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Test: `packages/mcp/tests/integration/tools-messaging.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/integration/tools-messaging.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startTestDb, type TestDb, truncateAll } from "../helpers/db.js";
import { generateToken, hashToken } from "../../src/auth/token.js";
import { buildServer } from "../../src/server.js";

async function callTool(client: Client, name: string, args: object) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text) as { ok: boolean; data?: any; error?: any };
}

async function connect(db: TestDb, handle: string, token: string) {
  const server = buildServer({ sql: db.sql, handle, token });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(c);
  return client;
}

describe("messaging tools", () => {
  let db: TestDb;
  let gToken: string;
  let mToken: string;

  beforeAll(async () => { db = await startTestDb(); });
  beforeEach(async () => {
    await truncateAll(db.sql);
    gToken = generateToken();
    mToken = generateToken();
    await db.sql`
      INSERT INTO agents (handle, token_hash) VALUES
        ('gavrilo', ${await hashToken(gToken)}),
        ('marco', ${await hashToken(mToken)})
    `;
  });
  afterAll(() => db.stop());

  it("send_message to a handle auto-creates a DM thread", async () => {
    const client = await connect(db, "gavrilo", gToken);
    const r = await callTool(client, "send_message", { to: "marco", body: "hola" });
    expect(r.ok).toBe(true);
    expect(r.data.thread_id).toBeTypeOf("string");

    const msgs = await db.sql`SELECT body FROM messages`;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe("hola");

    const parts = await db.sql`SELECT agent_id FROM thread_participants`;
    expect(parts).toHaveLength(2);
  });

  it("send_message to same handle twice reuses the DM thread", async () => {
    const client = await connect(db, "gavrilo", gToken);
    const r1 = await callTool(client, "send_message", { to: "marco", body: "uno" });
    const r2 = await callTool(client, "send_message", { to: "marco", body: "dos" });
    expect(r1.data.thread_id).toBe(r2.data.thread_id);
  });

  it("send_message returns NOT_FOUND for unknown handle with suggestions", async () => {
    const client = await connect(db, "gavrilo", gToken);
    const r = await callTool(client, "send_message", { to: "marko", body: "x" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("NOT_FOUND");
    expect(r.error.hint).toContain("marco");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/tools/_helpers.ts`**

```ts
import type { Sql } from "../db/client.js";
import type { AgentRow } from "../db/types.js";

export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}

export async function findAgentByHandle(sql: Sql, handle: string): Promise<AgentRow | null> {
  const rows = await sql<AgentRow[]>`SELECT * FROM agents WHERE handle = ${handle}`;
  return rows[0] ?? null;
}

export async function suggestHandles(sql: Sql, target: string, limit = 3): Promise<string[]> {
  const rows = await sql<{ handle: string }[]>`SELECT handle FROM agents`;
  return rows
    .map((r) => ({ h: r.handle, d: levenshtein(r.handle, target) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.h);
}

export async function findOrCreateDmThread(
  sql: Sql,
  a: string,
  b: string
): Promise<string> {
  const existing = await sql<{ id: string }[]>`
    SELECT t.id FROM threads t
    JOIN thread_participants p1 ON p1.thread_id = t.id AND p1.agent_id = ${a}
    JOIN thread_participants p2 ON p2.thread_id = t.id AND p2.agent_id = ${b}
    WHERE t.kind = 'dm'
    LIMIT 1
  `;
  if (existing[0]) return existing[0].id;

  const [{ id }] = await sql<{ id: string }[]>`
    INSERT INTO threads (kind, created_by) VALUES ('dm', ${a})
    RETURNING id
  `;
  await sql`
    INSERT INTO thread_participants (thread_id, agent_id) VALUES
      (${id}, ${a}), (${id}, ${b})
  `;
  return id;
}
```

- [ ] **Step 4: Create `packages/mcp/src/tools/messaging.ts`**

```ts
import { z } from "zod";
import type { ToolDef } from "../server.js";
import { findAgentByHandle, findOrCreateDmThread, suggestHandles } from "./_helpers.js";
import { NotFoundError } from "./identity.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sendMessageTool: ToolDef = {
  name: "send_message",
  description: "Send a message to another agent. `to` can be a handle (auto-creates DM thread) or an existing thread_id.",
  inputSchema: {
    type: "object",
    required: ["to", "body"],
    properties: {
      to: { type: "string" },
      body: { type: "string", minLength: 1 },
      reply_to: { type: "string" }
    },
    additionalProperties: false
  },
  handler: async (input, { sql, agentId }) => {
    const parsed = z
      .object({
        to: z.string(),
        body: z.string().min(1),
        reply_to: z.string().uuid().optional()
      })
      .parse(input);

    let threadId: string;
    if (UUID_RE.test(parsed.to)) {
      const t = await sql`SELECT 1 FROM thread_participants WHERE thread_id = ${parsed.to} AND agent_id = ${agentId}`;
      if (t.length === 0) throw new NotFoundError(`thread ${parsed.to}`);
      threadId = parsed.to;
    } else {
      const target = await findAgentByHandle(sql, parsed.to);
      if (!target) {
        const suggestions = await suggestHandles(sql, parsed.to);
        const err = new NotFoundError(`handle '${parsed.to}'`);
        (err as Error & { hint?: string }).hint =
          suggestions.length > 0 ? `did you mean: ${suggestions.join(", ")}?` : "no similar handles found";
        throw err;
      }
      threadId = await findOrCreateDmThread(sql, agentId, target.id);
    }

    const [{ id, created_at }] = await sql<{ id: string; created_at: Date }[]>`
      INSERT INTO messages (thread_id, sender_id, body, reply_to)
      VALUES (${threadId}, ${agentId}, ${parsed.body}, ${parsed.reply_to ?? null})
      RETURNING id, created_at
    `;
    return { message_id: id, thread_id: threadId, created_at };
  }
};
```

- [ ] **Step 5: Update server `tool failed` error handler to propagate `hint`**

In `packages/mcp/src/server.ts`, replace the error JSON construction in the `CallToolRequestSchema` handler with:

```ts
const hint = (e as Error & { hint?: string }).hint;
return {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        ok: false,
        error: { code: e.name, message: e.message, ...(hint ? { hint } : {}) }
      })
    }
  ],
  isError: true
};
```

- [ ] **Step 6: Update `_register.ts`**

```ts
import { sendMessageTool } from "./messaging.js";
// ...
registerTool(sendMessageTool);
```

- [ ] **Step 7: Run, expect PASS**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/src/server.ts packages/mcp/tests/integration/tools-messaging.test.ts
git commit -m "feat(tools): send_message with auto-DM thread + handle suggestions"
```

---

### Task 17: `read_inbox`

**Files:**
- Modify: `packages/mcp/src/tools/messaging.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/integration/tools-messaging.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it("read_inbox returns threads with last message and unread count", async () => {
  const clientG = await connect(db, "gavrilo", gToken);
  const clientM = await connect(db, "marco", mToken);

  await callTool(clientG, "send_message", { to: "marco", body: "hola marco" });
  await callTool(clientG, "send_message", { to: "marco", body: "otro mensaje" });

  const inbox = await callTool(clientM, "read_inbox", { unread_only: true });
  expect(inbox.ok).toBe(true);
  expect(inbox.data).toHaveLength(1);
  expect(inbox.data[0].unread_count).toBe(2);
  expect(inbox.data[0].last_message.body).toBe("otro mensaje");
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 3: Append to `packages/mcp/src/tools/messaging.ts`**

```ts
export const readInboxTool: ToolDef = {
  name: "read_inbox",
  description: "Returns your threads (most recent first) with the last message and unread count.",
  inputSchema: {
    type: "object",
    properties: {
      unread_only: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 200 }
    },
    additionalProperties: false
  },
  handler: async (input, { sql, agentId }) => {
    const parsed = z
      .object({
        unread_only: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(200).optional().default(50)
      })
      .parse(input);

    return sql`
      SELECT
        t.id AS thread_id,
        t.title,
        t.kind,
        t.last_message_at,
        (SELECT COUNT(*) FROM messages m
          WHERE m.thread_id = t.id AND m.created_at > tp.last_read_at
            AND m.sender_id != ${agentId}) AS unread_count,
        (SELECT json_build_object(
            'message_id', m.id,
            'sender_id', m.sender_id,
            'sender_handle', a.handle,
            'body', m.body,
            'created_at', m.created_at
         ) FROM messages m
           JOIN agents a ON a.id = m.sender_id
           WHERE m.thread_id = t.id
           ORDER BY m.created_at DESC LIMIT 1) AS last_message
      FROM threads t
      JOIN thread_participants tp ON tp.thread_id = t.id AND tp.agent_id = ${agentId}
      WHERE ${parsed.unread_only
        ? sql`EXISTS (
            SELECT 1 FROM messages m
            WHERE m.thread_id = t.id
              AND m.created_at > tp.last_read_at
              AND m.sender_id != ${agentId}
          )`
        : sql`TRUE`}
      ORDER BY t.last_message_at DESC
      LIMIT ${parsed.limit}
    `;
  }
};
```

- [ ] **Step 4: Update `_register.ts`** to add `readInboxTool`.

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/tests/integration/tools-messaging.test.ts
git commit -m "feat(tools): read_inbox with unread filter"
```

---

### Task 18: `get_thread`

**Files:**
- Modify: `packages/mcp/src/tools/messaging.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/integration/tools-messaging.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it("get_thread returns messages in chronological order with sender handles", async () => {
  const clientG = await connect(db, "gavrilo", gToken);
  const clientM = await connect(db, "marco", mToken);
  const r1 = await callTool(clientG, "send_message", { to: "marco", body: "1" });
  await callTool(clientM, "send_message", { to: "gavrilo", body: "2" });
  await callTool(clientG, "send_message", { to: "marco", body: "3" });

  const tr = await callTool(clientG, "get_thread", { thread_id: r1.data.thread_id, limit: 10 });
  expect(tr.ok).toBe(true);
  expect(tr.data.map((m: any) => m.body)).toEqual(["1", "2", "3"]);
  expect(tr.data[0].sender_handle).toBe("gavrilo");
});

it("get_thread denies access to threads you don't participate in", async () => {
  const otherToken = generateToken();
  await db.sql`INSERT INTO agents (handle, token_hash) VALUES ('other', ${await hashToken(otherToken)})`;
  const clientG = await connect(db, "gavrilo", gToken);
  const r = await callTool(clientG, "send_message", { to: "marco", body: "secret" });
  const clientO = await connect(db, "other", otherToken);
  const denied = await callTool(clientO, "get_thread", { thread_id: r.data.thread_id });
  expect(denied.ok).toBe(false);
  expect(denied.error.code).toBe("NOT_FOUND");
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 3: Append to `packages/mcp/src/tools/messaging.ts`**

```ts
export const getThreadTool: ToolDef = {
  name: "get_thread",
  description: "Returns messages in a thread chronologically. Paginate older messages via `before`.",
  inputSchema: {
    type: "object",
    required: ["thread_id"],
    properties: {
      thread_id: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      before: { type: "string", format: "date-time" }
    },
    additionalProperties: false
  },
  handler: async (input, { sql, agentId }) => {
    const parsed = z
      .object({
        thread_id: z.string().uuid(),
        limit: z.number().int().min(1).max(200).optional().default(50),
        before: z.string().datetime().optional()
      })
      .parse(input);

    const access = await sql`
      SELECT 1 FROM thread_participants
      WHERE thread_id = ${parsed.thread_id} AND agent_id = ${agentId}
    `;
    if (access.length === 0) throw new NotFoundError(`thread ${parsed.thread_id}`);

    return sql`
      SELECT
        m.id AS message_id,
        m.body,
        m.reply_to,
        m.created_at,
        m.sender_id,
        a.handle AS sender_handle
      FROM messages m
      JOIN agents a ON a.id = m.sender_id
      WHERE m.thread_id = ${parsed.thread_id}
        AND ${parsed.before ? sql`m.created_at < ${parsed.before}` : sql`TRUE`}
      ORDER BY m.created_at ASC
      LIMIT ${parsed.limit}
    `;
  }
};
```

- [ ] **Step 4: Update `_register.ts`** to add `getThreadTool`.

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/tests/integration/tools-messaging.test.ts
git commit -m "feat(tools): get_thread with participation check"
```

---

### Task 19: `mark_thread_read`

**Files:**
- Modify: `packages/mcp/src/tools/messaging.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/integration/tools-messaging.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it("mark_thread_read sets last_read_at to now()", async () => {
  const clientG = await connect(db, "gavrilo", gToken);
  const clientM = await connect(db, "marco", mToken);
  const r = await callTool(clientG, "send_message", { to: "marco", body: "ping" });

  const before = await callTool(clientM, "read_inbox", { unread_only: true });
  expect(before.data[0].unread_count).toBe(1);

  await callTool(clientM, "mark_thread_read", { thread_id: r.data.thread_id });

  const after = await callTool(clientM, "read_inbox", { unread_only: true });
  expect(after.data).toHaveLength(0);
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 3: Append to `packages/mcp/src/tools/messaging.ts`**

```ts
export const markThreadReadTool: ToolDef = {
  name: "mark_thread_read",
  description: "Marks all messages in a thread as read up to the current moment.",
  inputSchema: {
    type: "object",
    required: ["thread_id"],
    properties: { thread_id: { type: "string" } },
    additionalProperties: false
  },
  handler: async (input, { sql, agentId }) => {
    const parsed = z.object({ thread_id: z.string().uuid() }).parse(input);
    const result = await sql`
      UPDATE thread_participants
      SET last_read_at = now()
      WHERE thread_id = ${parsed.thread_id} AND agent_id = ${agentId}
    `;
    if (result.count === 0) throw new NotFoundError(`thread ${parsed.thread_id}`);
    return { ok: true };
  }
};
```

- [ ] **Step 4: Update `_register.ts`** to add `markThreadReadTool`.

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/tests/integration/tools-messaging.test.ts
git commit -m "feat(tools): mark_thread_read"
```

---

## Phase 7: Tasks tools

### Task 20: `create_task` (creates message + task atomically)

**Files:**
- Create: `packages/mcp/src/tools/tasks.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Test: `packages/mcp/tests/integration/tools-tasks.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/integration/tools-tasks.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startTestDb, type TestDb, truncateAll } from "../helpers/db.js";
import { generateToken, hashToken } from "../../src/auth/token.js";
import { buildServer } from "../../src/server.js";

async function callTool(client: Client, name: string, args: object) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text) as { ok: boolean; data?: any; error?: any };
}

async function connect(db: TestDb, handle: string, token: string) {
  const server = buildServer({ sql: db.sql, handle, token });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(c);
  return client;
}

describe("tasks tools", () => {
  let db: TestDb;
  let gToken: string;
  let mToken: string;

  beforeAll(async () => { db = await startTestDb(); });
  beforeEach(async () => {
    await truncateAll(db.sql);
    gToken = generateToken();
    mToken = generateToken();
    await db.sql`
      INSERT INTO agents (handle, token_hash) VALUES
        ('gavrilo', ${await hashToken(gToken)}),
        ('marco', ${await hashToken(mToken)})
    `;
  });
  afterAll(() => db.stop());

  it("create_task without thread_id creates the thread + message + task", async () => {
    const clientG = await connect(db, "gavrilo", gToken);
    const r = await callTool(clientG, "create_task", {
      assigned_to: "marco",
      title: "Connect form to endpoint",
      description: "Use POST /orders/draft"
    });
    expect(r.ok).toBe(true);
    expect(r.data.task_id).toBeTypeOf("string");
    expect(r.data.thread_id).toBeTypeOf("string");
    expect(r.data.message_id).toBeTypeOf("string");

    const tasks = await db.sql`SELECT title, status FROM tasks`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Connect form to endpoint");
    expect(tasks[0].status).toBe("pending");

    const messages = await db.sql`SELECT body FROM messages`;
    expect(messages[0].body).toContain("Connect form to endpoint");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-tasks.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/tools/tasks.ts`**

```ts
import { z } from "zod";
import type { ToolDef } from "../server.js";
import { findAgentByHandle, findOrCreateDmThread, suggestHandles } from "./_helpers.js";
import { NotFoundError } from "./identity.js";

export const createTaskTool: ToolDef = {
  name: "create_task",
  description: "Creates a task addressed to another agent. If thread_id is omitted, opens or reuses the DM thread.",
  inputSchema: {
    type: "object",
    required: ["assigned_to", "title", "description"],
    properties: {
      assigned_to: { type: "string" },
      title: { type: "string", minLength: 1 },
      description: { type: "string" },
      thread_id: { type: "string" }
    },
    additionalProperties: false
  },
  handler: async (input, { sql, agentId }) => {
    const parsed = z
      .object({
        assigned_to: z.string(),
        title: z.string().min(1),
        description: z.string(),
        thread_id: z.string().uuid().optional()
      })
      .parse(input);

    const target = await findAgentByHandle(sql, parsed.assigned_to);
    if (!target) {
      const suggestions = await suggestHandles(sql, parsed.assigned_to);
      const err = new NotFoundError(`handle '${parsed.assigned_to}'`);
      (err as Error & { hint?: string }).hint =
        suggestions.length > 0 ? `did you mean: ${suggestions.join(", ")}?` : "no similar handles found";
      throw err;
    }

    const threadId = parsed.thread_id ?? (await findOrCreateDmThread(sql, agentId, target.id));

    const body = `📋 **Task:** ${parsed.title}\n\n${parsed.description}`;
    const [{ id: messageId }] = await sql<{ id: string }[]>`
      INSERT INTO messages (thread_id, sender_id, body)
      VALUES (${threadId}, ${agentId}, ${body})
      RETURNING id
    `;
    const [{ id: taskId }] = await sql<{ id: string }[]>`
      INSERT INTO tasks (message_id, assigned_to, title, description)
      VALUES (${messageId}, ${target.id}, ${parsed.title}, ${parsed.description})
      RETURNING id
    `;
    return { task_id: taskId, message_id: messageId, thread_id: threadId };
  }
};
```

- [ ] **Step 4: Update `_register.ts`** to add `createTaskTool` from `./tasks.js`.

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-tasks.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/tests/integration/tools-tasks.test.ts
git commit -m "feat(tools): create_task"
```

---

### Task 21: `list_tasks`

**Files:**
- Modify: `packages/mcp/src/tools/tasks.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/integration/tools-tasks.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it("list_tasks filters by role and status", async () => {
  const clientG = await connect(db, "gavrilo", gToken);
  const clientM = await connect(db, "marco", mToken);

  await callTool(clientG, "create_task", { assigned_to: "marco", title: "T1", description: "x" });
  await callTool(clientG, "create_task", { assigned_to: "marco", title: "T2", description: "y" });
  await callTool(clientM, "create_task", { assigned_to: "gavrilo", title: "T3", description: "z" });

  const assigneeM = await callTool(clientM, "list_tasks", { role: "assignee" });
  expect(assigneeM.data.map((t: any) => t.title).sort()).toEqual(["T1", "T2"]);

  const creatorM = await callTool(clientM, "list_tasks", { role: "creator" });
  expect(creatorM.data.map((t: any) => t.title)).toEqual(["T3"]);
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-tasks.test.ts
```

- [ ] **Step 3: Append to `packages/mcp/src/tools/tasks.ts`**

```ts
export const listTasksTool: ToolDef = {
  name: "list_tasks",
  description: "Lists tasks. role='assignee' (default) shows tasks assigned to you; role='creator' shows tasks you created.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "accepted", "in_progress", "completed", "rejected", "cancelled"]
      },
      role: { type: "string", enum: ["assignee", "creator"] }
    },
    additionalProperties: false
  },
  handler: async (input, { sql, agentId }) => {
    const parsed = z
      .object({
        status: z
          .enum(["pending", "accepted", "in_progress", "completed", "rejected", "cancelled"])
          .optional(),
        role: z.enum(["assignee", "creator"]).optional().default("assignee")
      })
      .parse(input);

    const roleClause =
      parsed.role === "assignee"
        ? sql`t.assigned_to = ${agentId}`
        : sql`m.sender_id = ${agentId}`;

    const statusClause = parsed.status ? sql`AND t.status = ${parsed.status}` : sql``;

    return sql`
      SELECT
        t.id AS task_id,
        t.title,
        t.description,
        t.status,
        t.result,
        t.rejection_reason,
        t.created_at,
        t.accepted_at,
        t.completed_at,
        t.message_id,
        m.thread_id,
        ca.handle AS created_by,
        aa.handle AS assigned_to
      FROM tasks t
      JOIN messages m ON m.id = t.message_id
      JOIN agents ca ON ca.id = m.sender_id
      JOIN agents aa ON aa.id = t.assigned_to
      WHERE ${roleClause}
      ${statusClause}
      ORDER BY t.created_at DESC
    `;
  }
};
```

- [ ] **Step 4: Update `_register.ts`** to add `listTasksTool`.

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-tasks.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/tests/integration/tools-tasks.test.ts
git commit -m "feat(tools): list_tasks"
```

---

### Task 22: `accept_task`

**Files:**
- Modify: `packages/mcp/src/tools/tasks.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/integration/tools-tasks.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it("accept_task transitions pending → in_progress only for assignee", async () => {
  const clientG = await connect(db, "gavrilo", gToken);
  const clientM = await connect(db, "marco", mToken);
  const r = await callTool(clientG, "create_task", { assigned_to: "marco", title: "T", description: "x" });

  const wrong = await callTool(clientG, "accept_task", { task_id: r.data.task_id });
  expect(wrong.ok).toBe(false);
  expect(wrong.error.code).toBe("NOT_FOUND");

  const ok = await callTool(clientM, "accept_task", { task_id: r.data.task_id });
  expect(ok.ok).toBe(true);

  const tasks = await db.sql`SELECT status, accepted_at FROM tasks`;
  expect(tasks[0].status).toBe("in_progress");
  expect(tasks[0].accepted_at).toBeInstanceOf(Date);
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-tasks.test.ts
```

- [ ] **Step 3: Append to `packages/mcp/src/tools/tasks.ts`**

```ts
export class InvalidStateError extends Error {
  constructor(message: string) {
    super(`INVALID_STATE: ${message}`);
    this.name = "INVALID_STATE";
  }
}

export const acceptTaskTool: ToolDef = {
  name: "accept_task",
  description: "Accept a pending task assigned to you. Transitions status to 'in_progress'.",
  inputSchema: {
    type: "object",
    required: ["task_id"],
    properties: { task_id: { type: "string" } },
    additionalProperties: false
  },
  handler: async (input, { sql, agentId }) => {
    const parsed = z.object({ task_id: z.string().uuid() }).parse(input);
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM tasks
      WHERE id = ${parsed.task_id} AND assigned_to = ${agentId}
    `;
    if (rows.length === 0) throw new NotFoundError(`task ${parsed.task_id}`);
    if (rows[0]!.status !== "pending") {
      throw new InvalidStateError(`task is '${rows[0]!.status}', expected 'pending'`);
    }
    await sql`
      UPDATE tasks
      SET status = 'in_progress', accepted_at = now()
      WHERE id = ${parsed.task_id}
    `;
    return { ok: true, status: "in_progress" };
  }
};
```

- [ ] **Step 4: Update `_register.ts`** to add `acceptTaskTool`.

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-tasks.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/tests/integration/tools-tasks.test.ts
git commit -m "feat(tools): accept_task"
```

---

### Task 23: `complete_task` (also posts result as message to the thread)

**Files:**
- Modify: `packages/mcp/src/tools/tasks.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/integration/tools-tasks.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it("complete_task posts a notification message and updates state", async () => {
  const clientG = await connect(db, "gavrilo", gToken);
  const clientM = await connect(db, "marco", mToken);
  const r = await callTool(clientG, "create_task", { assigned_to: "marco", title: "T", description: "x" });
  await callTool(clientM, "accept_task", { task_id: r.data.task_id });

  const c = await callTool(clientM, "complete_task", {
    task_id: r.data.task_id,
    result: "Done, commit abc123"
  });
  expect(c.ok).toBe(true);

  const tasks = await db.sql`SELECT status, result, completed_at FROM tasks`;
  expect(tasks[0].status).toBe("completed");
  expect(tasks[0].result).toBe("Done, commit abc123");

  const msgs = await db.sql`SELECT body FROM messages ORDER BY created_at`;
  expect(msgs).toHaveLength(2);
  expect(msgs[1].body).toContain("Done, commit abc123");
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-tasks.test.ts
```

- [ ] **Step 3: Append to `packages/mcp/src/tools/tasks.ts`**

```ts
export const completeTaskTool: ToolDef = {
  name: "complete_task",
  description: "Marks a task you've accepted as completed with a result. Posts the result as a message in the thread.",
  inputSchema: {
    type: "object",
    required: ["task_id", "result"],
    properties: {
      task_id: { type: "string" },
      result: { type: "string", minLength: 1 }
    },
    additionalProperties: false
  },
  handler: async (input, { sql, agentId }) => {
    const parsed = z
      .object({ task_id: z.string().uuid(), result: z.string().min(1) })
      .parse(input);

    const rows = await sql<{ status: string; message_id: string }[]>`
      SELECT status, message_id FROM tasks
      WHERE id = ${parsed.task_id} AND assigned_to = ${agentId}
    `;
    if (rows.length === 0) throw new NotFoundError(`task ${parsed.task_id}`);
    if (!["in_progress", "accepted"].includes(rows[0]!.status)) {
      throw new InvalidStateError(`task is '${rows[0]!.status}', expected 'in_progress' or 'accepted'`);
    }

    const [{ thread_id }] = await sql<{ thread_id: string }[]>`
      SELECT thread_id FROM messages WHERE id = ${rows[0]!.message_id}
    `;

    await sql.begin(async (tx) => {
      await tx`
        UPDATE tasks SET status = 'completed', result = ${parsed.result}, completed_at = now()
        WHERE id = ${parsed.task_id}
      `;
      await tx`
        INSERT INTO messages (thread_id, sender_id, body)
        VALUES (${thread_id}, ${agentId}, ${`✅ **Task completed:** ${parsed.result}`})
      `;
    });

    return { ok: true };
  }
};
```

- [ ] **Step 4: Update `_register.ts`** to add `completeTaskTool`.

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-tasks.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/tests/integration/tools-tasks.test.ts
git commit -m "feat(tools): complete_task with notification"
```

---

### Task 24: `reject_task`

**Files:**
- Modify: `packages/mcp/src/tools/tasks.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/integration/tools-tasks.test.ts`

- [ ] **Step 1: Add failing test**

```ts
it("reject_task records reason and posts message", async () => {
  const clientG = await connect(db, "gavrilo", gToken);
  const clientM = await connect(db, "marco", mToken);
  const r = await callTool(clientG, "create_task", { assigned_to: "marco", title: "T", description: "x" });

  const rj = await callTool(clientM, "reject_task", {
    task_id: r.data.task_id,
    reason: "out of scope"
  });
  expect(rj.ok).toBe(true);

  const tasks = await db.sql`SELECT status, rejection_reason FROM tasks`;
  expect(tasks[0].status).toBe("rejected");
  expect(tasks[0].rejection_reason).toBe("out of scope");
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-tasks.test.ts
```

- [ ] **Step 3: Append to `packages/mcp/src/tools/tasks.ts`**

```ts
export const rejectTaskTool: ToolDef = {
  name: "reject_task",
  description: "Reject a task assigned to you with a reason. Posts the rejection as a message in the thread.",
  inputSchema: {
    type: "object",
    required: ["task_id", "reason"],
    properties: {
      task_id: { type: "string" },
      reason: { type: "string", minLength: 1 }
    },
    additionalProperties: false
  },
  handler: async (input, { sql, agentId }) => {
    const parsed = z
      .object({ task_id: z.string().uuid(), reason: z.string().min(1) })
      .parse(input);

    const rows = await sql<{ status: string; message_id: string }[]>`
      SELECT status, message_id FROM tasks
      WHERE id = ${parsed.task_id} AND assigned_to = ${agentId}
    `;
    if (rows.length === 0) throw new NotFoundError(`task ${parsed.task_id}`);
    if (["completed", "rejected", "cancelled"].includes(rows[0]!.status)) {
      throw new InvalidStateError(`task already '${rows[0]!.status}'`);
    }

    const [{ thread_id }] = await sql<{ thread_id: string }[]>`
      SELECT thread_id FROM messages WHERE id = ${rows[0]!.message_id}
    `;

    await sql.begin(async (tx) => {
      await tx`
        UPDATE tasks SET status = 'rejected', rejection_reason = ${parsed.reason}
        WHERE id = ${parsed.task_id}
      `;
      await tx`
        INSERT INTO messages (thread_id, sender_id, body)
        VALUES (${thread_id}, ${agentId}, ${`❌ **Task rejected:** ${parsed.reason}`})
      `;
    });

    return { ok: true };
  }
};
```

- [ ] **Step 4: Update `_register.ts`** to add `rejectTaskTool`.

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test -- tools-tasks.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/tests/integration/tools-tasks.test.ts
git commit -m "feat(tools): reject_task"
```

---

## Phase 8: Realtime

### Task 25: Realtime listener (LISTEN/NOTIFY)

**Files:**
- Create: `packages/mcp/src/realtime/listener.ts`
- Test: `packages/mcp/tests/integration/realtime.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/integration/realtime.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { startTestDb, type TestDb, truncateAll } from "../helpers/db.js";
import { generateToken, hashToken } from "../../src/auth/token.js";
import { RealtimeListener } from "../../src/realtime/listener.js";

describe("realtime listener", () => {
  let db: TestDb;
  let gId: string;
  let mId: string;

  beforeAll(async () => { db = await startTestDb(); });
  beforeEach(async () => {
    await truncateAll(db.sql);
    const [g] = await db.sql`
      INSERT INTO agents (handle, token_hash) VALUES ('gavrilo', ${await hashToken(generateToken())})
      RETURNING id
    `;
    const [m] = await db.sql`
      INSERT INTO agents (handle, token_hash) VALUES ('marco', ${await hashToken(generateToken())})
      RETURNING id
    `;
    gId = g.id; mId = m.id;
  });
  afterAll(() => db.stop());

  it("receives a NOTIFY when a message is inserted in a thread you participate in", async () => {
    // Create thread + participants
    const [t] = await db.sql`
      INSERT INTO threads (kind, created_by) VALUES ('dm', ${gId}) RETURNING id
    `;
    await db.sql`
      INSERT INTO thread_participants (thread_id, agent_id) VALUES
        (${t.id}, ${gId}), (${t.id}, ${mId})
    `;

    const listener = new RealtimeListener(db.url, mId);
    await listener.start();

    const got = listener.waitForNext(5000);
    await db.sql`
      INSERT INTO messages (thread_id, sender_id, body) VALUES (${t.id}, ${gId}, 'hola')
    `;
    const evt = await got;
    expect(evt).toBeTruthy();
    expect(evt?.thread_id).toBe(t.id);
    await listener.stop();
  });

  it("waitForNext returns null on timeout", async () => {
    const listener = new RealtimeListener(db.url, mId);
    await listener.start();
    const evt = await listener.waitForNext(500);
    expect(evt).toBeNull();
    await listener.stop();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- realtime.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/realtime/listener.ts`**

```ts
import postgres from "postgres";
import { logger } from "../logger.js";

export interface NotifyEvent {
  type: "new_message";
  message_id: string;
  thread_id: string;
  sender_id: string;
}

export class RealtimeListener {
  private sql: postgres.Sql | null = null;
  private queue: NotifyEvent[] = [];
  private waiter: ((evt: NotifyEvent | null) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private databaseUrl: string, private agentId: string) {}

  async start(): Promise<void> {
    this.sql = postgres(this.databaseUrl, { max: 1, onnotice: () => {} });
    await this.sql.listen(`agent_${this.agentId}`, (payload) => {
      try {
        const evt = JSON.parse(payload) as NotifyEvent;
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          if (this.timer) { clearTimeout(this.timer); this.timer = null; }
          w(evt);
        } else {
          this.queue.push(evt);
        }
      } catch (err) {
        logger.warn({ err, payload }, "invalid NOTIFY payload");
      }
    });
  }

  waitForNext(timeoutMs: number): Promise<NotifyEvent | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.timer = setTimeout(() => {
        this.waiter = null;
        this.timer = null;
        resolve(null);
      }, timeoutMs);
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.sql) await this.sql.end();
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
pnpm test -- realtime.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/realtime/ packages/mcp/tests/integration/realtime.test.ts
git commit -m "feat(realtime): LISTEN/NOTIFY based event listener"
```

---

### Task 26: `wait_for_messages` tool (long-poll)

**Files:**
- Create: `packages/mcp/src/tools/realtime.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/src/server.ts` (inject realtime listener into context)
- Modify: `packages/mcp/tests/integration/tools-messaging.test.ts`

- [ ] **Step 1: Add failing test to `tools-messaging.test.ts`**

```ts
it("wait_for_messages wakes when a new message arrives", async () => {
  const clientG = await connect(db, "gavrilo", gToken);
  const clientM = await connect(db, "marco", mToken);
  // Pre-create thread by sending one message
  await callTool(clientG, "send_message", { to: "marco", body: "init" });

  // Marco starts waiting (5s timeout)
  const waitPromise = callTool(clientM, "wait_for_messages", { timeout_seconds: 5 });
  // 200ms later Gavrilo sends another
  setTimeout(() => { callTool(clientG, "send_message", { to: "marco", body: "ping" }); }, 200);

  const r = await waitPromise;
  expect(r.ok).toBe(true);
  expect(r.data).toHaveLength(1);
  expect(r.data[0].body).toBe("ping");
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 3: Modify `packages/mcp/src/server.ts` — add `realtime` to context**

Change `ServerOptions` to include the database URL, build the listener inside the server, and pass it to handlers:

```ts
import { RealtimeListener } from "./realtime/listener.js";

export interface ServerOptions {
  sql: Sql;
  databaseUrl: string;
  handle: string;
  token: string;
}

// Tool context now includes realtime + databaseUrl
export interface ToolContext {
  sql: Sql;
  databaseUrl: string;
  agentId: string;
  handle: string;
}
```

Update `ToolDef.handler` signature to use `ToolContext` and pass `databaseUrl` from `opts` when invoking the handler.

- [ ] **Step 4: Update all existing tool files** to import `ToolContext` from `../server.js` and use the new signature. No logic changes — only the second parameter type.

- [ ] **Step 5: Create `packages/mcp/src/tools/realtime.ts`**

```ts
import { z } from "zod";
import type { ToolDef } from "../server.js";
import { RealtimeListener } from "../realtime/listener.js";

export const waitForMessagesTool: ToolDef = {
  name: "wait_for_messages",
  description: "Blocks for up to timeout_seconds (default 30) waiting for a new message. Returns the new messages or an empty array on timeout.",
  inputSchema: {
    type: "object",
    properties: {
      timeout_seconds: { type: "integer", minimum: 1, maximum: 300 }
    },
    additionalProperties: false
  },
  handler: async (input, { sql, databaseUrl, agentId }) => {
    const parsed = z
      .object({ timeout_seconds: z.number().int().min(1).max(300).optional().default(30) })
      .parse(input);

    const listener = new RealtimeListener(databaseUrl, agentId);
    await listener.start();
    try {
      const evt = await listener.waitForNext(parsed.timeout_seconds * 1000);
      if (!evt) return [];
      const rows = await sql`
        SELECT
          m.id AS message_id,
          m.thread_id,
          m.body,
          m.created_at,
          a.handle AS sender_handle
        FROM messages m
        JOIN agents a ON a.id = m.sender_id
        WHERE m.id = ${evt.message_id}
      `;
      return rows;
    } finally {
      await listener.stop();
    }
  }
};
```

- [ ] **Step 6: Update `_register.ts`** to add `waitForMessagesTool`.

- [ ] **Step 7: Update test helper `connect` and existing tests** to pass `databaseUrl: db.url` to `buildServer`.

In all test files that call `buildServer({ sql: db.sql, handle, token })`, change to `buildServer({ sql: db.sql, databaseUrl: db.url, handle, token })`.

- [ ] **Step 8: Run all tests, expect PASS**

```bash
pnpm test
```

- [ ] **Step 9: Commit**

```bash
git add packages/mcp/src/
git add packages/mcp/tests/
git commit -m "feat(tools): wait_for_messages with long-poll via LISTEN/NOTIFY"
```

---

## Phase 9: CLI

### Task 27: CLI entry point + `serve` command

**Files:**
- Create: `packages/mcp/src/cli/index.ts`
- Create: `packages/mcp/src/cli/serve.ts`

- [ ] **Step 1: Create `packages/mcp/src/cli/serve.ts`**

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../auth/config.js";
import { createClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { buildServer } from "../server.js";
import { logger } from "../logger.js";

export async function serve(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    logger.error("No config found. Run `agent-mouth init` first.");
    process.exit(1);
  }
  const sql = createClient(config.databaseUrl);
  await runMigrations(sql);
  const server = buildServer({
    sql,
    databaseUrl: config.databaseUrl,
    handle: config.handle,
    token: config.agentToken
  });
  await server.connect(new StdioServerTransport());
  logger.info({ handle: config.handle }, "agent-mouth serving over stdio");
}
```

- [ ] **Step 2: Create `packages/mcp/src/cli/index.ts`**

```ts
#!/usr/bin/env node
import { serve } from "./serve.js";
import { init } from "./init.js";
import { join } from "./join.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case "serve": return serve();
    case "init":  return init(args);
    case "join":  return join(args);
    default:
      console.error("Usage: agent-mouth <serve|init|join>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Commit (skeleton — `init` and `join` come next)**

```bash
# Don't commit yet — init.ts and join.ts don't exist
```

---

### Task 28: `init` command

**Files:**
- Create: `packages/mcp/src/cli/init.ts`
- Create: `packages/mcp/src/cli/_prompt.ts`

- [ ] **Step 1: Create `packages/mcp/src/cli/_prompt.ts`**

```ts
import { createInterface } from "node:readline/promises";

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} `)).trim();
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 2: Create `packages/mcp/src/cli/init.ts`**

```ts
import { createClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { generateToken, hashToken } from "../auth/token.js";
import { defaultConfigPath, saveConfig } from "../auth/config.js";
import { prompt } from "./_prompt.js";

export async function init(_args: string[]): Promise<void> {
  console.log("🪞 Agent Mouth — init\n");
  const databaseUrl = await prompt("Database URL (postgres://...):");
  const handle = await prompt("Your handle (e.g. gavrilo-backend):");
  const displayName = await prompt("Display name (optional):");

  if (!databaseUrl || !handle) {
    console.error("Database URL and handle are required.");
    process.exit(1);
  }
  if (!/^[a-z0-9-]+$/.test(handle)) {
    console.error("Handle must be lowercase letters, digits and dashes only.");
    process.exit(1);
  }

  const sql = createClient(databaseUrl);
  try {
    await runMigrations(sql);
    const existing = await sql`SELECT 1 FROM agents WHERE handle = ${handle}`;
    if (existing.length > 0) {
      console.error(`Handle '${handle}' is already taken in this network.`);
      process.exit(1);
    }
    const token = generateToken();
    const hash = await hashToken(token);
    await sql`
      INSERT INTO agents (handle, display_name, token_hash, visibility)
      VALUES (${handle}, ${displayName || null}, ${hash}, 'public')
    `;
    const configPath = defaultConfigPath();
    await saveConfig(configPath, { databaseUrl, handle, agentToken: token });

    console.log(`\n✓ Registered as @${handle}`);
    console.log(`✓ Token saved to ${configPath}`);
    console.log("\n🎉 Share this join URL with teammates:");
    const encoded = Buffer.from(databaseUrl).toString("base64url");
    console.log(`   agent-mouth://join?db=${encoded}\n`);
    console.log("Add this to ~/.claude/settings.json under mcpServers:");
    console.log(`   { "agent-mouth": { "command": "npx", "args": ["agent-mouth", "serve"] } }`);
  } finally {
    await sql.end();
  }
}
```

- [ ] **Step 3: Manual smoke test (local Postgres or Docker)**

```bash
docker run --rm -d -p 5499:5432 -e POSTGRES_PASSWORD=test --name am-test postgres:17-alpine
sleep 3
pnpm --filter agent-mouth build
node packages/mcp/dist/cli/index.js init
# Enter: postgresql://postgres:test@localhost:5499/postgres
# Enter handle: test-user
# Verify: config file exists, agents row exists
docker stop am-test
```

Expected: config saved at `~/.agent-mouth/config.json`, agent row inserted.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/cli/
git commit -m "feat(cli): init command"
```

---

### Task 29: `join` command

**Files:**
- Create: `packages/mcp/src/cli/join.ts`

- [ ] **Step 1: Create `packages/mcp/src/cli/join.ts`**

```ts
import { createClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { generateToken, hashToken } from "../auth/token.js";
import { defaultConfigPath, saveConfig } from "../auth/config.js";
import { prompt } from "./_prompt.js";

export async function join(args: string[]): Promise<void> {
  const url = args[0];
  if (!url || !url.startsWith("agent-mouth://join?")) {
    console.error('Usage: agent-mouth join "agent-mouth://join?db=..."');
    process.exit(1);
  }

  const params = new URLSearchParams(url.replace("agent-mouth://join?", ""));
  const dbEncoded = params.get("db");
  if (!dbEncoded) {
    console.error("Invalid join URL: missing db parameter");
    process.exit(1);
  }
  const databaseUrl = Buffer.from(dbEncoded, "base64url").toString("utf8");

  const handle = await prompt("Your handle (e.g. marco-frontend):");
  const displayName = await prompt("Display name (optional):");
  if (!/^[a-z0-9-]+$/.test(handle)) {
    console.error("Handle must be lowercase letters, digits and dashes only.");
    process.exit(1);
  }

  const sql = createClient(databaseUrl);
  try {
    await runMigrations(sql);
    const existing = await sql`SELECT 1 FROM agents WHERE handle = ${handle}`;
    if (existing.length > 0) {
      console.error(`Handle '${handle}' is already taken in this network.`);
      process.exit(1);
    }
    const token = generateToken();
    const hash = await hashToken(token);
    await sql`
      INSERT INTO agents (handle, display_name, token_hash, visibility)
      VALUES (${handle}, ${displayName || null}, ${hash}, 'public')
    `;
    await saveConfig(defaultConfigPath(), { databaseUrl, handle, agentToken: token });
    console.log(`\n✓ Joined network as @${handle}`);
    console.log("Add this to ~/.claude/settings.json under mcpServers:");
    console.log(`   { "agent-mouth": { "command": "npx", "args": ["agent-mouth", "serve"] } }`);
  } finally {
    await sql.end();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/mcp/src/cli/join.ts
git commit -m "feat(cli): join command"
```

---

## Phase 10: E2E + CI

### Task 30: E2E test — two agents conversing

**Files:**
- Create: `packages/mcp/tests/e2e/two-agent-flow.test.ts`

- [ ] **Step 1: Create `packages/mcp/tests/e2e/two-agent-flow.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startTestDb, type TestDb } from "../helpers/db.js";
import { generateToken, hashToken } from "../../src/auth/token.js";
import { buildServer } from "../../src/server.js";

async function callTool(client: Client, name: string, args: object) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text) as { ok: boolean; data?: any; error?: any };
}

async function connect(db: TestDb, handle: string, token: string) {
  const server = buildServer({ sql: db.sql, databaseUrl: db.url, handle, token });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(c);
  return client;
}

describe("e2e: two-agent task flow", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    const gToken = "gtok-fixed-for-e2e";
    const mToken = "mtok-fixed-for-e2e";
    await db.sql`
      INSERT INTO agents (handle, display_name, token_hash) VALUES
        ('gavrilo', 'Gavrilo', ${await hashToken(gToken)}),
        ('marco', 'Marco', ${await hashToken(mToken)})
    `;
    (globalThis as any).__tokens = { gavrilo: gToken, marco: mToken };
  });
  afterAll(() => db.stop());

  it("Gavrilo creates a task, Marco accepts and completes, Gavrilo sees the result", async () => {
    const tokens = (globalThis as any).__tokens;
    const g = await connect(db, "gavrilo", tokens.gavrilo);
    const m = await connect(db, "marco", tokens.marco);

    // 1. Gavrilo announces the endpoint
    await callTool(g, "send_message", {
      to: "marco",
      body: "Added POST /orders/draft. Schema: { items: [{ sku, qty }] }"
    });
    // 2. Gavrilo creates the task
    const taskRes = await callTool(g, "create_task", {
      assigned_to: "marco",
      title: "Wire form to /orders/draft",
      description: "Use the schema from the previous message"
    });
    expect(taskRes.ok).toBe(true);

    // 3. Marco lists pending tasks
    const list = await callTool(m, "list_tasks", { role: "assignee", status: "pending" });
    expect(list.data).toHaveLength(1);
    expect(list.data[0].title).toBe("Wire form to /orders/draft");

    // 4. Marco accepts and completes
    await callTool(m, "accept_task", { task_id: taskRes.data.task_id });
    await callTool(m, "complete_task", {
      task_id: taskRes.data.task_id,
      result: "Done, commit abc123, preview: https://vercel..."
    });

    // 5. Gavrilo sees completed task with result
    const finalList = await callTool(g, "list_tasks", { role: "creator", status: "completed" });
    expect(finalList.data).toHaveLength(1);
    expect(finalList.data[0].result).toContain("commit abc123");

    // 6. Thread has 4 messages (announce, task, complete-notification, plus optional)
    const thread = await callTool(g, "get_thread", { thread_id: taskRes.data.thread_id });
    expect(thread.data.length).toBeGreaterThanOrEqual(3);
  });

  it("wait_for_messages wakes up across the two-agent boundary", async () => {
    const tokens = (globalThis as any).__tokens;
    const g = await connect(db, "gavrilo", tokens.gavrilo);
    const m = await connect(db, "marco", tokens.marco);

    const wait = callTool(m, "wait_for_messages", { timeout_seconds: 5 });
    setTimeout(() => { callTool(g, "send_message", { to: "marco", body: "wake up" }); }, 200);
    const r = await wait;
    expect(r.ok).toBe(true);
    expect(r.data.some((msg: any) => msg.body === "wake up")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect PASS**

```bash
pnpm test -- two-agent-flow.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/tests/e2e/
git commit -m "test(e2e): two-agent task flow"
```

---

### Task 31: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec biome check .
      - run: pnpm -r build
      - run: pnpm -r test
        env:
          AGENT_MOUTH_LOG: warn
```

- [ ] **Step 2: Commit**

```bash
git add .github/
git commit -m "ci: GitHub Actions with lint, build, test"
```

---

## Phase 11: Polish

### Task 32: README and quickstart docs

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `docs/quickstart.md`
- Create: `docs/self-host.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# Agent Mouth

> 💬 WhatsApp + task queue for AI agents. Self-hosted, open source MCP server.

Agent Mouth lets AI agents owned by different people (or different parts of one person's workflow) talk directly to each other through a shared Postgres backend — no copy-paste between humans.

## Quickstart (5 min)

1. Create a free Postgres (Supabase, Neon, Railway, or self-host).
2. Initialize:
   ```bash
   npx agent-mouth init
   ```
3. Add to `~/.claude/settings.json`:
   ```json
   { "mcpServers": { "agent-mouth": { "command": "npx", "args": ["agent-mouth", "serve"] } } }
   ```
4. Share the join URL printed by `init` with your teammate.

See [docs/quickstart.md](docs/quickstart.md) and [docs/self-host.md](docs/self-host.md).

## Tools

| Category | Tools |
|----------|-------|
| Identity | `whoami`, `list_contacts`, `register_subagent`, `unregister_subagent` |
| Messaging | `send_message`, `read_inbox`, `get_thread`, `mark_thread_read`, `wait_for_messages` |
| Tasks | `create_task`, `list_tasks`, `accept_task`, `complete_task`, `reject_task` |

## Architecture

See [docs/superpowers/specs/2026-05-11-agent-mouth-design.md](docs/superpowers/specs/2026-05-11-agent-mouth-design.md).

## License

MIT
```

- [ ] **Step 2: Create `LICENSE`** with MIT text. Replace `[YEAR]` with `2026` and `[FULLNAME]` with `Gavrilo Markovic Jankovic`.

- [ ] **Step 3: Write `docs/quickstart.md`**

```markdown
# Quickstart

## 1. Provision Postgres

The simplest path is **Supabase** (free tier sufficient for small teams):

1. Sign up at https://supabase.com
2. Create a new project
3. Copy the connection string from Project Settings → Database → Connection string (URI)

You can also use Neon, Railway, AWS RDS, or self-hosted Postgres ≥14.

## 2. First user initializes the network

```bash
npx agent-mouth init
```

You'll be prompted for the database URL, your handle, and display name. After registration, the CLI prints a `agent-mouth://join?...` URL — share that with teammates.

## 3. Teammates join

```bash
npx agent-mouth join "agent-mouth://join?db=..."
```

## 4. Connect to your AI client

**Claude Code** — add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agent-mouth": { "command": "npx", "args": ["agent-mouth", "serve"] }
  }
}
```

**Cursor / Windsurf** — see your client's MCP server config docs and use the same `npx agent-mouth serve` command.

## 5. First conversation

In your AI client:

> "Use the agent-mouth tool to send a message to @marco-frontend saying hello."

Your partner's agent will see it on its next `read_inbox` or `wait_for_messages` call.
```

- [ ] **Step 4: Write `docs/self-host.md`**

```markdown
# Self-Hosting

For maximum privacy, run your own Postgres. The cheapest path is a €5/month VPS (Hetzner CX11, DigitalOcean basic droplet).

## VPS setup (Ubuntu 24.04)

```bash
sudo apt update
sudo apt install -y postgresql-17
sudo -u postgres createuser --pwprompt agentmouth
sudo -u postgres createdb -O agentmouth agentmouth
```

Edit `/etc/postgresql/17/main/postgresql.conf`:
```
listen_addresses = '*'
```

Edit `/etc/postgresql/17/main/pg_hba.conf` — add (replace `<your-ip>`):
```
host    agentmouth    agentmouth    <your-ip>/32    scram-sha-256
```

Restart:
```bash
sudo systemctl restart postgresql
sudo ufw allow 5432/tcp
```

Your connection string is:
```
postgres://agentmouth:<password>@<vps-ip>:5432/agentmouth
```

## Backups

```bash
pg_dump $DATABASE_URL > backup-$(date +%F).sql
```

Cron daily:
```
0 3 * * * pg_dump $DATABASE_URL | gzip > /var/backups/agentmouth-$(date +\%F).sql.gz
```

## Security considerations

- Restrict `pg_hba.conf` to specific IPs (or use Tailscale for zero-config private networking)
- Use long random passwords (`openssl rand -hex 32`)
- Enable SSL: append `?sslmode=require` to the connection string
- Rotate `agent_token`s if a teammate leaves: delete their row in `agents`
```

- [ ] **Step 5: Commit**

```bash
git add README.md LICENSE docs/quickstart.md docs/self-host.md
git commit -m "docs: README, license, quickstart, self-host guide"
```

---

### Task 33: npm publish prep

**Files:**
- Modify: `packages/mcp/package.json`

- [ ] **Step 1: Verify package metadata**

Update `packages/mcp/package.json` to include publish-ready fields:

```json
{
  "name": "agent-mouth",
  "version": "0.1.0",
  "description": "MCP server: WhatsApp + task queue for AI agents",
  "keywords": ["mcp", "ai-agents", "claude", "postgres", "chat"],
  "homepage": "https://github.com/<your-org>/agent-mouth",
  "repository": { "type": "git", "url": "https://github.com/<your-org>/agent-mouth.git" },
  "license": "MIT",
  "author": "Gavrilo Markovic Jankovic",
  "type": "module",
  "bin": { "agent-mouth": "./dist/cli/index.js" },
  "exports": { ".": "./dist/index.js" },
  "files": ["dist/", "../sql/migrations/", "README.md"]
}
```

- [ ] **Step 2: Verify build produces a working binary**

```bash
pnpm -r build
chmod +x packages/mcp/dist/cli/index.js
node packages/mcp/dist/cli/index.js --help 2>&1 || true  # prints usage
```

- [ ] **Step 3: Dry-run publish**

```bash
cd packages/mcp
npm publish --dry-run
```

Verify the file list includes `dist/` and `migrations/`.

- [ ] **Step 4: Bump version and tag**

```bash
cd ../..
git add packages/mcp/package.json
git commit -m "chore: prepare v0.1.0 for publish"
git tag v0.1.0
```

- [ ] **Step 5: Push to GitHub and publish**

```bash
git push origin main --tags
cd packages/mcp
npm publish --access public
```

---

## Self-review checklist

Before handing off:

1. **Spec coverage** — every section of the spec has tasks:
   - Schema (§5) → Task 4
   - Tools (§6) → Tasks 12-26
   - Auth (§7) → Tasks 8-10
   - Onboarding (§8) → Tasks 28-29
   - Errors (§9) → cross-cutting (each tool handles its own; server formats responses)
   - Realtime (§10) → Tasks 25-26
   - Testing (§11) → covered throughout + Tasks 30-31
   - Repo structure (§12) → Task 3

2. **No placeholders** — every step has the exact code, the exact file path, the exact command. No "fill in details."

3. **Type consistency** — `ToolDef.handler` signature is unified after Task 26 (introduces `databaseUrl` to context). All earlier tools updated in Step 4 of Task 26.

4. **Frequent commits** — every task ends with a commit.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-11-agent-mouth.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration on a clean context per task.

**2. Inline Execution** — I execute tasks in this session with checkpoints for review every 3-5 tasks.

**Which approach?**
