# Agent Mouth — Phase 3 (Tools + Knowledge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent autonomy through 3 read-only tools (`search_web`, `search_knowledge`, `read_knowledge_file`) backed by pluggable adapters (Tavily / pgvector / Git knowledge source / OpenAI embeddings), wired into the existing ClaudeRuntime tool-use loop with per-policy authorization and audit-log cost tracking.

**Architecture:** Five new pluggable abstractions (`KnowledgeSource`, `VectorStore`, `WebSearchProvider`, `EmbeddingProvider`, `Tool`) in `@agent-mouth/core`. Five new packages housing MVP adapters and the tool registry. `ClaudeRuntime` extended with a tool-use loop. `agent-guardrails` extended with per-policy `allowed_tools` whitelist. `apps/api` wires everything at boot and schedules a `knowledge.sync` job every 15 min via pg-boss.

**Tech Stack:** TypeScript 5.5 · Node 20 · pnpm monorepo · Vitest · Zod · pgvector (Supabase) · Tavily REST · OpenAI Embeddings REST · simple-git · pg-boss recurring jobs · Fly.io volumes.

**Spec reference:** `docs/superpowers/specs/2026-05-23-agent-mouth-phase-3-design.md`

---

## Branch strategy

All work happens on `feat/phase-3-tools-knowledge` branched from `main`. Merge to main only after the 3 E2E gates pass in production.

---

## File structure overview

### New packages

```
packages/knowledge-source/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # registry + re-exports
│   ├── types.ts                  # KnowledgeSource interface + shared types
│   ├── registry.ts               # registerKnowledgeSource / resolveKnowledgeSource
│   ├── git-source.ts             # GitKnowledgeSource adapter
│   └── chunkers/
│       ├── index.ts
│       └── markdown-chunker.ts   # MarkdownChunker (H2/H3 split, 400-tok target)
└── tests/
    ├── markdown-chunker.test.ts
    ├── git-source.test.ts
    └── registry.test.ts

packages/vector-store/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts                  # VectorStore interface
│   ├── registry.ts
│   └── pgvector-store.ts         # PgvectorStore adapter
└── tests/
    ├── pgvector-store.test.ts
    └── registry.test.ts

packages/web-search/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts                  # WebSearchProvider interface
│   ├── registry.ts
│   └── tavily-provider.ts        # TavilyProvider adapter (fetch-based)
└── tests/
    ├── tavily-provider.test.ts
    └── registry.test.ts

packages/embeddings/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts                  # EmbeddingProvider interface
│   ├── registry.ts
│   └── openai-provider.ts        # OpenAIEmbeddingProvider adapter
└── tests/
    ├── openai-provider.test.ts
    └── registry.test.ts

packages/agent-tools/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # registry + bootstrap
│   ├── types.ts                  # Tool, ToolContext, ToolRegistry
│   ├── registry.ts
│   ├── search-web-tool.ts
│   ├── search-knowledge-tool.ts
│   └── read-knowledge-file-tool.ts
└── tests/
    ├── registry.test.ts
    ├── search-web-tool.test.ts
    ├── search-knowledge-tool.test.ts
    └── read-knowledge-file-tool.test.ts
```

### Modified packages

```
packages/core/src/
├── index.ts                              # add re-exports of new interfaces
└── (5 new type files re-exported from new packages)

packages/agent-runtime/src/
├── claude-runtime.ts                     # add tool-use loop
└── types.ts                              # add ToolDefinition + ToolUseResult types

packages/agent-guardrails/src/
└── index.ts                              # add resolveAllowedTools + cost estimator hook

packages/storage-supabase/sql/
└── 0004_apply_phase3_schema.sql          # new tables + ALTER policies

packages/api/src/
├── index.ts                              # bootstrap registrations + cron job
├── worker.ts                             # add knowledge.sync job handler
└── config.ts                             # add Phase 3 env vars

apps/cli/src/
└── seed-knowledge.ts                     # new CLI to seed knowledge_sources row
```

---

## Sprint 1 — Foundation (Tasks 1-7)

### Task 1: Branch + scaffold migration file

**Files:**
- Create: `packages/storage-supabase/sql/0004_apply_phase3_schema.sql`

- [ ] **Step 1: Create feature branch**

```bash
cd /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth
git checkout main
git pull
git checkout -b feat/phase-3-tools-knowledge
```

- [ ] **Step 2: Create migration SQL with full schema**

Write `packages/storage-supabase/sql/0004_apply_phase3_schema.sql`:

```sql
-- Phase 3 schema — knowledge stores + per-policy tool authorization
-- Spec: docs/superpowers/specs/2026-05-23-agent-mouth-phase-3-design.md §2.3

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL,
  config JSONB NOT NULL,
  last_synced_at TIMESTAMPTZ,
  last_sync_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_workspace
  ON knowledge_sources(workspace_id);

CREATE TABLE IF NOT EXISTS knowledge_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  last_modified TIMESTAMPTZ,
  indexed_at TIMESTAMPTZ,
  UNIQUE (source_id, path)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_files_source
  ON knowledge_files(source_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding vector(1536),
  token_count INTEGER,
  metadata JSONB,
  UNIQUE (file_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS allowed_tools TEXT NOT NULL DEFAULT '["*"]';
```

- [ ] **Step 3: Commit migration**

```bash
git add packages/storage-supabase/sql/0004_apply_phase3_schema.sql
git commit -m "feat(phase-3): add knowledge schema migration + policies.allowed_tools"
```

---

### Task 2: Define core interfaces in `@agent-mouth/core`

**Files:**
- Create: `packages/core/src/knowledge.ts`
- Create: `packages/core/src/vector.ts`
- Create: `packages/core/src/web-search.ts`
- Create: `packages/core/src/embeddings.ts`
- Create: `packages/core/src/tools.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/phase-3-types.test.ts`

- [ ] **Step 1: Write failing type-shape test**

Create `packages/core/tests/phase-3-types.test.ts`:

```ts
import { describe, it, expectTypeOf } from "vitest";
import type {
  KnowledgeFile,
  KnowledgeSource,
  KnowledgeSourceConfig,
  VectorStore,
  VectorSearchResult,
  WebSearchProvider,
  WebSearchResult,
  EmbeddingProvider,
  Tool,
  ToolContext,
} from "../src/index.js";

describe("phase-3 core types are exported", () => {
  it("KnowledgeSource has init/sync/listFiles/readFile", () => {
    expectTypeOf<KnowledgeSource>().toHaveProperty("init");
    expectTypeOf<KnowledgeSource>().toHaveProperty("sync");
    expectTypeOf<KnowledgeSource>().toHaveProperty("listFiles");
    expectTypeOf<KnowledgeSource>().toHaveProperty("readFile");
  });
  it("VectorStore has upsert/search/deleteByFileId", () => {
    expectTypeOf<VectorStore>().toHaveProperty("upsert");
    expectTypeOf<VectorStore>().toHaveProperty("search");
    expectTypeOf<VectorStore>().toHaveProperty("deleteByFileId");
  });
  it("Tool has name/description/inputSchema/execute", () => {
    expectTypeOf<Tool>().toHaveProperty("name");
    expectTypeOf<Tool>().toHaveProperty("description");
    expectTypeOf<Tool>().toHaveProperty("inputSchema");
    expectTypeOf<Tool>().toHaveProperty("execute");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @agent-mouth/core test phase-3-types
```

Expected: FAIL with "Cannot find module" or type errors on missing exports.

- [ ] **Step 3: Implement `packages/core/src/knowledge.ts`**

```ts
export interface KnowledgeFile {
  path: string;
  contentHash: string;
  lastModified: Date;
  size: number;
}

export interface SyncResult {
  added: KnowledgeFile[];
  modified: KnowledgeFile[];
  deleted: string[];        // paths
  errors: Array<{ path: string; error: string }>;
}

export interface KnowledgeSourceConfig {
  [key: string]: unknown;
}

export interface KnowledgeSource {
  readonly type: string;
  init(config: KnowledgeSourceConfig, env: Record<string, string | undefined>): Promise<void>;
  sync(): Promise<SyncResult>;
  listFiles(): Promise<KnowledgeFile[]>;
  readFile(path: string): Promise<{ content: string; lastModified: Date }>;
}
```

- [ ] **Step 4: Implement `packages/core/src/vector.ts`**

```ts
export interface VectorChunkInput {
  fileId: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  tokenCount: number;
  metadata: Record<string, unknown>;
}

export interface VectorSearchFilter {
  workspaceId: string;
  pathPrefix?: string;
  frontmatterTipo?: string;
}

export interface VectorSearchResult {
  fileId: string;
  filePath: string;
  chunkIndex: number;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  readonly type: string;
  init(env: Record<string, string | undefined>): Promise<void>;
  upsert(fileId: string, chunks: VectorChunkInput[]): Promise<void>;
  deleteByFileId(fileId: string): Promise<void>;
  search(queryVector: number[], opts: { topK: number; filter: VectorSearchFilter }): Promise<VectorSearchResult[]>;
}
```

- [ ] **Step 5: Implement `packages/core/src/web-search.ts`**

```ts
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface WebSearchResult {
  results: WebSearchHit[];
  answer?: string;
}

export interface WebSearchProvider {
  readonly name: string;
  init(env: Record<string, string | undefined>): Promise<void>;
  search(query: string, opts: { maxResults: number }): Promise<WebSearchResult>;
}
```

- [ ] **Step 6: Implement `packages/core/src/embeddings.ts`**

```ts
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  init(env: Record<string, string | undefined>): Promise<void>;
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
```

- [ ] **Step 7: Implement `packages/core/src/tools.ts`**

```ts
import type { Policy } from "./identity.js";

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolContext {
  workspaceId: string;
  contactId: string;
  threadId: string;
  policy: Policy;
  logger: {
    info: (data: unknown, msg?: string) => void;
    warn: (data: unknown, msg?: string) => void;
    error: (data: unknown, msg?: string) => void;
  };
  abortSignal?: AbortSignal;
}

export interface ToolExecutionResult<T = unknown> {
  ok: boolean;
  output?: T;
  error?: string;
  costUsd: number;
  latencyMs: number;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly requiresExplicitGrant?: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<ToolExecutionResult<TOutput>>;
}
```

- [ ] **Step 8: Re-export from `packages/core/src/index.ts`**

Append to existing `index.ts`:

```ts
export * from "./knowledge.js";
export * from "./vector.js";
export * from "./web-search.js";
export * from "./embeddings.js";
export * from "./tools.js";
```

- [ ] **Step 9: Run test to verify it passes**

```bash
pnpm --filter @agent-mouth/core test phase-3-types
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/core
git commit -m "feat(core): add Phase 3 interfaces (KnowledgeSource, VectorStore, WebSearchProvider, EmbeddingProvider, Tool)"
```

---

### Task 3: Scaffold `@agent-mouth/embeddings` package + OpenAI adapter

**Files:**
- Create: `packages/embeddings/package.json`
- Create: `packages/embeddings/tsconfig.json`
- Create: `packages/embeddings/src/index.ts`
- Create: `packages/embeddings/src/types.ts`
- Create: `packages/embeddings/src/registry.ts`
- Create: `packages/embeddings/src/openai-provider.ts`
- Test: `packages/embeddings/tests/openai-provider.test.ts`
- Test: `packages/embeddings/tests/registry.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@agent-mouth/embeddings",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run",
    "lint": "biome check src tests"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write failing registry test**

Create `packages/embeddings/tests/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { EmbeddingProvider } from "@agent-mouth/core";
import {
  registerEmbeddingProvider,
  resolveEmbeddingProvider,
  _resetEmbeddingRegistry,
} from "../src/registry.js";

describe("embedding provider registry", () => {
  beforeEach(() => _resetEmbeddingRegistry());

  it("registers and resolves provider by name", async () => {
    const fake: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async (texts) => texts.map(() => [0, 0, 0, 0]),
      embedQuery: async () => [0, 0, 0, 0],
    };
    registerEmbeddingProvider("fake", { apiKeyEnv: "FAKE_KEY", factory: () => fake });
    const resolved = await resolveEmbeddingProvider("fake", { FAKE_KEY: "x" });
    expect(resolved.name).toBe("fake");
  });

  it("throws when API key env var is missing", async () => {
    registerEmbeddingProvider("openai", {
      apiKeyEnv: "OPENAI_API_KEY",
      factory: () => ({} as EmbeddingProvider),
    });
    await expect(resolveEmbeddingProvider("openai", {})).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
```

- [ ] **Step 4: Verify it fails**

```bash
pnpm --filter @agent-mouth/embeddings test registry
```

Expected: FAIL — missing source files.

- [ ] **Step 5: Implement `src/registry.ts`**

```ts
import type { EmbeddingProvider } from "@agent-mouth/core";

export interface EmbeddingProviderRegistration {
  apiKeyEnv: string;
  factory: () => EmbeddingProvider;
}

const registry = new Map<string, EmbeddingProviderRegistration>();

export function registerEmbeddingProvider(name: string, reg: EmbeddingProviderRegistration): void {
  registry.set(name, reg);
}

export function listEmbeddingProviders(): string[] {
  return Array.from(registry.keys());
}

export async function resolveEmbeddingProvider(
  name: string,
  env: Record<string, string | undefined>,
): Promise<EmbeddingProvider> {
  const reg = registry.get(name);
  if (!reg) {
    throw new Error(`No embedding provider registered for "${name}". Known: ${listEmbeddingProviders().join(", ") || "(none)"}`);
  }
  const apiKey = env[reg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Embedding provider "${name}" requires ${reg.apiKeyEnv} but it is not set`);
  }
  const provider = reg.factory();
  await provider.init(env);
  return provider;
}

export function _resetEmbeddingRegistry(): void {
  registry.clear();
}
```

- [ ] **Step 6: Implement `src/types.ts`**

```ts
// Re-export for ergonomics
export type { EmbeddingProvider } from "@agent-mouth/core";
export type { EmbeddingProviderRegistration } from "./registry.js";
```

- [ ] **Step 7: Write failing OpenAI provider test**

Create `packages/embeddings/tests/openai-provider.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { OpenAIEmbeddingProvider } from "../src/openai-provider.js";

describe("OpenAIEmbeddingProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to /v1/embeddings with model and input batch", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      }),
    });
    const p = new OpenAIEmbeddingProvider();
    await p.init({ OPENAI_API_KEY: "sk-test" });
    const out = await p.embed(["hello", "world"]);
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("embedQuery returns first vector from embed call", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
    });
    const p = new OpenAIEmbeddingProvider();
    await p.init({ OPENAI_API_KEY: "sk-test" });
    const v = await p.embedQuery("query");
    expect(v).toEqual([1, 2, 3]);
  });

  it("throws on non-ok response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "rate limit",
    });
    const p = new OpenAIEmbeddingProvider();
    await p.init({ OPENAI_API_KEY: "sk-test" });
    await expect(p.embed(["x"])).rejects.toThrow(/429/);
  });
});
```

- [ ] **Step 8: Implement `src/openai-provider.ts`**

```ts
import type { EmbeddingProvider } from "@agent-mouth/core";

const ENDPOINT = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions = 1536;
  private apiKey = "";

  async init(env: Record<string, string | undefined>): Promise<void> {
    const key = env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY required");
    this.apiKey = key;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // OpenAI accepts up to 2048 inputs per call; we keep batches small (100) to bound payload size.
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, input: batch }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI embeddings ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      for (const item of data.data) out.push(item.embedding);
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec;
  }
}
```

- [ ] **Step 9: Implement `src/index.ts`**

```ts
export * from "./registry.js";
export * from "./openai-provider.js";
export * from "./types.js";

import { registerEmbeddingProvider } from "./registry.js";
import { OpenAIEmbeddingProvider } from "./openai-provider.js";

registerEmbeddingProvider("openai", {
  apiKeyEnv: "OPENAI_API_KEY",
  factory: () => new OpenAIEmbeddingProvider(),
});
```

- [ ] **Step 10: Add package to root `pnpm-workspace.yaml` if not auto-globbed; install**

```bash
pnpm install
pnpm --filter @agent-mouth/embeddings test
```

Expected: all tests PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/embeddings pnpm-lock.yaml
git commit -m "feat(embeddings): add @agent-mouth/embeddings with OpenAI provider + registry"
```

---

### Task 4: Scaffold `@agent-mouth/web-search` package + Tavily adapter

**Files:**
- Create: `packages/web-search/package.json`
- Create: `packages/web-search/tsconfig.json`
- Create: `packages/web-search/src/{index,types,registry,tavily-provider}.ts`
- Test: `packages/web-search/tests/{registry,tavily-provider}.test.ts`

- [ ] **Step 1: Create `package.json` (same shape as embeddings, name `@agent-mouth/web-search`)**

Same template as Task 3 Step 1, change name to `@agent-mouth/web-search`.

- [ ] **Step 2: Create `tsconfig.json`** (identical template).

- [ ] **Step 3: Write failing registry test**

Create `packages/web-search/tests/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { WebSearchProvider } from "@agent-mouth/core";
import {
  registerWebSearchProvider,
  resolveWebSearchProvider,
  _resetWebSearchRegistry,
} from "../src/registry.js";

describe("web search registry", () => {
  beforeEach(() => _resetWebSearchRegistry());

  it("registers and resolves provider by name", async () => {
    const fake: WebSearchProvider = {
      name: "fake",
      init: async () => {},
      search: async () => ({ results: [] }),
    };
    registerWebSearchProvider("fake", { apiKeyEnv: "FAKE_KEY", factory: () => fake });
    const resolved = await resolveWebSearchProvider("fake", { FAKE_KEY: "x" });
    expect(resolved.name).toBe("fake");
  });

  it("throws when API key missing", async () => {
    registerWebSearchProvider("tavily", {
      apiKeyEnv: "TAVILY_API_KEY",
      factory: () => ({} as WebSearchProvider),
    });
    await expect(resolveWebSearchProvider("tavily", {})).rejects.toThrow(/TAVILY_API_KEY/);
  });
});
```

- [ ] **Step 4: Implement `src/registry.ts`** (mirror the embeddings registry, swap names):

```ts
import type { WebSearchProvider } from "@agent-mouth/core";

export interface WebSearchProviderRegistration {
  apiKeyEnv: string;
  factory: () => WebSearchProvider;
}

const registry = new Map<string, WebSearchProviderRegistration>();

export function registerWebSearchProvider(name: string, reg: WebSearchProviderRegistration): void {
  registry.set(name, reg);
}

export function listWebSearchProviders(): string[] {
  return Array.from(registry.keys());
}

export async function resolveWebSearchProvider(
  name: string,
  env: Record<string, string | undefined>,
): Promise<WebSearchProvider> {
  const reg = registry.get(name);
  if (!reg) {
    throw new Error(`No web search provider for "${name}". Known: ${listWebSearchProviders().join(", ") || "(none)"}`);
  }
  const apiKey = env[reg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Web search provider "${name}" requires ${reg.apiKeyEnv} but it is not set`);
  }
  const provider = reg.factory();
  await provider.init(env);
  return provider;
}

export function _resetWebSearchRegistry(): void {
  registry.clear();
}
```

- [ ] **Step 5: Write failing Tavily provider test**

Create `packages/web-search/tests/tavily-provider.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TavilyProvider } from "../src/tavily-provider.js";

describe("TavilyProvider", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("calls https://api.tavily.com/search with api_key and query", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        answer: "Node 22 is current LTS.",
        results: [
          { title: "Node Releases", url: "https://nodejs.org/en", content: "Node 22.0.0 ...", published_date: "2026-04-01" },
        ],
      }),
    });
    const p = new TavilyProvider();
    await p.init({ TAVILY_API_KEY: "tvly-test" });
    const out = await p.search("node lts", { maxResults: 5 });
    expect(out.answer).toBe("Node 22 is current LTS.");
    expect(out.results[0]).toEqual({
      title: "Node Releases",
      url: "https://nodejs.org/en",
      snippet: "Node 22.0.0 ...",
      publishedAt: "2026-04-01",
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on non-ok response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });
    const p = new TavilyProvider();
    await p.init({ TAVILY_API_KEY: "x" });
    await expect(p.search("q", { maxResults: 5 })).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 6: Implement `src/tavily-provider.ts`**

```ts
import type { WebSearchProvider, WebSearchResult } from "@agent-mouth/core";

const ENDPOINT = "https://api.tavily.com/search";

export class TavilyProvider implements WebSearchProvider {
  readonly name = "tavily";
  private apiKey = "";

  async init(env: Record<string, string | undefined>): Promise<void> {
    const key = env.TAVILY_API_KEY;
    if (!key) throw new Error("TAVILY_API_KEY required");
    this.apiKey = key;
  }

  async search(query: string, opts: { maxResults: number }): Promise<WebSearchResult> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: opts.maxResults,
        include_answer: true,
        search_depth: "basic",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Tavily ${res.status}: ${body}`);
    }
    const data = (await res.json()) as {
      answer?: string;
      results: Array<{ title: string; url: string; content: string; published_date?: string }>;
    };
    return {
      answer: data.answer,
      results: data.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        publishedAt: r.published_date,
      })),
    };
  }
}
```

- [ ] **Step 7: Implement `src/index.ts`**

```ts
export * from "./registry.js";
export * from "./tavily-provider.js";

import { registerWebSearchProvider } from "./registry.js";
import { TavilyProvider } from "./tavily-provider.js";

registerWebSearchProvider("tavily", {
  apiKeyEnv: "TAVILY_API_KEY",
  factory: () => new TavilyProvider(),
});
```

- [ ] **Step 8: Test + commit**

```bash
pnpm install
pnpm --filter @agent-mouth/web-search test
git add packages/web-search pnpm-lock.yaml
git commit -m "feat(web-search): add @agent-mouth/web-search with Tavily provider + registry"
```

---

### Task 5: Scaffold `@agent-mouth/knowledge-source` with MarkdownChunker

**Files:**
- Create: `packages/knowledge-source/package.json` (add `simple-git` dep)
- Create: `packages/knowledge-source/tsconfig.json`
- Create: `packages/knowledge-source/src/{index,types,registry,git-source}.ts`
- Create: `packages/knowledge-source/src/chunkers/{index,markdown-chunker}.ts`
- Test: `packages/knowledge-source/tests/markdown-chunker.test.ts`

This task focuses on the chunker because it's pure logic (no IO) and can be fully TDD'd first. Git source ships in Task 6.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@agent-mouth/knowledge-source",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run",
    "lint": "biome check src tests"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*",
    "simple-git": "^3.25.0",
    "gpt-tokenizer": "^2.4.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (template).

- [ ] **Step 3: Write failing markdown chunker test**

Create `packages/knowledge-source/tests/markdown-chunker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MarkdownChunker } from "../src/chunkers/markdown-chunker.js";

describe("MarkdownChunker", () => {
  it("splits by H2 headings, prepending breadcrumb to each chunk", () => {
    const md = `---
tipo: proyecto
actualizado: 2026-05-23
---

# Title

Intro paragraph.

## Section A

Body of A.

## Section B

Body of B.
`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "test.md" });
    expect(chunks.length).toBe(3);
    expect(chunks[0].text).toContain("# Title");
    expect(chunks[0].text).toContain("Intro paragraph.");
    expect(chunks[1].text).toContain("# Title > ## Section A");
    expect(chunks[1].text).toContain("Body of A.");
    expect(chunks[2].text).toContain("# Title > ## Section B");
  });

  it("includes frontmatter in metadata for every chunk", () => {
    const md = `---
tipo: proyecto
---
# T
body
`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "x.md" });
    expect(chunks[0].metadata.frontmatter).toEqual({ tipo: "proyecto" });
  });

  it("sub-splits sections exceeding maxTokens by paragraph", () => {
    const longPara = "lorem ipsum ".repeat(200); // ~600 tokens
    const md = `# T\n\n## S\n\n${longPara}\n\n${longPara}`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "long.md" });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(500);
    }
  });

  it("never splits inside code blocks", () => {
    const code = "```ts\n" + "const x = 1;\n".repeat(80) + "```";
    const md = `# T\n\n## S\n\n${code}`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "code.md" });
    const codeOpens = chunks.flatMap(c => c.text.match(/```/g) ?? []).length;
    expect(codeOpens % 2).toBe(0);
  });

  it("attaches line_start / line_end metadata", () => {
    const md = `# T\n\n## A\nline-a\n\n## B\nline-b\n`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "z.md" });
    expect(chunks[1].metadata.line_start).toBeTypeOf("number");
    expect(chunks[1].metadata.line_end).toBeTypeOf("number");
  });
});
```

- [ ] **Step 4: Verify it fails**

```bash
pnpm install
pnpm --filter @agent-mouth/knowledge-source test markdown-chunker
```

Expected: FAIL — file missing.

- [ ] **Step 5: Implement `src/chunkers/markdown-chunker.ts`**

```ts
import { encode } from "gpt-tokenizer";

export interface ChunkerOptions {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

export interface Chunk {
  text: string;
  tokenCount: number;
  metadata: {
    heading_path: string;
    line_start: number;
    line_end: number;
    frontmatter: Record<string, unknown>;
  };
}

interface Section {
  headingPath: string;
  lineStart: number;
  lineEnd: number;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(md: string): { frontmatter: Record<string, unknown>; rest: string; bodyStartLine: number } {
  const m = md.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, rest: md, bodyStartLine: 1 };
  const yaml = m[1];
  const frontmatter: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    frontmatter[key] = val;
  }
  const consumed = m[0];
  return {
    frontmatter,
    rest: md.slice(consumed.length),
    bodyStartLine: consumed.split("\n").length,
  };
}

function splitSections(md: string, bodyStartLine: number): Section[] {
  const lines = md.split("\n");
  const sections: Section[] = [];
  let h1 = "";
  let h2 = "";
  let h3 = "";
  let current: { headingPath: string; lineStart: number; bodyLines: string[] } | null = null;
  let inCode = false;

  const flush = (endLine: number) => {
    if (!current) return;
    sections.push({
      headingPath: current.headingPath,
      lineStart: current.lineStart,
      lineEnd: endLine,
      body: current.bodyLines.join("\n"),
    });
    current = null;
  };

  lines.forEach((raw, i) => {
    const lineNum = bodyStartLine + i;
    if (raw.startsWith("```")) inCode = !inCode;
    if (!inCode) {
      const h1m = raw.match(/^#\s+(.+)/);
      const h2m = raw.match(/^##\s+(.+)/);
      const h3m = raw.match(/^###\s+(.+)/);
      if (h1m) {
        flush(lineNum - 1);
        h1 = h1m[1].trim();
        h2 = "";
        h3 = "";
        current = { headingPath: `# ${h1}`, lineStart: lineNum, bodyLines: [raw] };
        return;
      }
      if (h2m) {
        flush(lineNum - 1);
        h2 = h2m[1].trim();
        h3 = "";
        current = { headingPath: `# ${h1} > ## ${h2}`, lineStart: lineNum, bodyLines: [raw] };
        return;
      }
      if (h3m) {
        flush(lineNum - 1);
        h3 = h3m[1].trim();
        current = { headingPath: `# ${h1} > ## ${h2} > ### ${h3}`, lineStart: lineNum, bodyLines: [raw] };
        return;
      }
    }
    if (!current) {
      current = { headingPath: "(preamble)", lineStart: lineNum, bodyLines: [raw] };
    } else {
      current.bodyLines.push(raw);
    }
  });
  flush(bodyStartLine + lines.length - 1);
  return sections;
}

function countTokens(text: string): number {
  return encode(text).length;
}

function splitByParagraphs(text: string, maxTokens: number): string[] {
  const paras = text.split(/\n\n+/);
  const out: string[] = [];
  let buf: string[] = [];
  let bufTok = 0;
  for (const p of paras) {
    const tok = countTokens(p);
    if (bufTok + tok > maxTokens && buf.length > 0) {
      out.push(buf.join("\n\n"));
      buf = [p];
      bufTok = tok;
    } else {
      buf.push(p);
      bufTok += tok;
    }
  }
  if (buf.length > 0) out.push(buf.join("\n\n"));
  return out;
}

export class MarkdownChunker {
  constructor(private readonly opts: ChunkerOptions) {}

  split(md: string, ctx: { path: string }): Chunk[] {
    const { frontmatter, rest, bodyStartLine } = parseFrontmatter(md);
    const sections = splitSections(rest, bodyStartLine);
    const chunks: Chunk[] = [];

    for (const section of sections) {
      const tok = countTokens(section.body);
      if (tok <= this.opts.maxTokens) {
        chunks.push({
          text: section.body,
          tokenCount: tok,
          metadata: {
            heading_path: section.headingPath,
            line_start: section.lineStart,
            line_end: section.lineEnd,
            frontmatter,
          },
        });
      } else {
        const parts = splitByParagraphs(section.body, this.opts.targetTokens);
        for (const part of parts) {
          const text = `${section.headingPath}\n\n${part}`;
          chunks.push({
            text,
            tokenCount: countTokens(text),
            metadata: {
              heading_path: section.headingPath,
              line_start: section.lineStart,
              line_end: section.lineEnd,
              frontmatter,
            },
          });
        }
      }
    }
    return chunks;
  }
}
```

- [ ] **Step 6: Run tests until green**

```bash
pnpm --filter @agent-mouth/knowledge-source test markdown-chunker
```

Iterate on the chunker implementation until all 5 tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/knowledge-source pnpm-lock.yaml
git commit -m "feat(knowledge-source): scaffold package with MarkdownChunker (TDD'd)"
```

---

### Task 6: Implement `GitKnowledgeSource` + registry

**Files:**
- Create: `packages/knowledge-source/src/git-source.ts`
- Create: `packages/knowledge-source/src/registry.ts`
- Create: `packages/knowledge-source/src/index.ts`
- Test: `packages/knowledge-source/tests/git-source.test.ts` (uses temp git repo)
- Test: `packages/knowledge-source/tests/registry.test.ts`

- [ ] **Step 1: Write failing registry test**

Create `packages/knowledge-source/tests/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { KnowledgeSource } from "@agent-mouth/core";
import {
  registerKnowledgeSourceType,
  resolveKnowledgeSource,
  _resetKnowledgeRegistry,
} from "../src/registry.js";

describe("knowledge source registry", () => {
  beforeEach(() => _resetKnowledgeRegistry());

  it("registers a type and resolves it by config.type", async () => {
    const fake: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: [], errors: [] }),
      listFiles: async () => [],
      readFile: async () => ({ content: "x", lastModified: new Date() }),
    };
    registerKnowledgeSourceType("fake", () => fake);
    const k = await resolveKnowledgeSource({ type: "fake", config: {}, env: {} });
    expect(k.type).toBe("fake");
  });

  it("throws for unknown type", async () => {
    await expect(
      resolveKnowledgeSource({ type: "nope", config: {}, env: {} }),
    ).rejects.toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Implement `src/registry.ts`**

```ts
import type { KnowledgeSource, KnowledgeSourceConfig } from "@agent-mouth/core";

const factories = new Map<string, () => KnowledgeSource>();

export function registerKnowledgeSourceType(type: string, factory: () => KnowledgeSource): void {
  factories.set(type, factory);
}

export function listKnowledgeSourceTypes(): string[] {
  return Array.from(factories.keys());
}

export async function resolveKnowledgeSource(args: {
  type: string;
  config: KnowledgeSourceConfig;
  env: Record<string, string | undefined>;
}): Promise<KnowledgeSource> {
  const factory = factories.get(args.type);
  if (!factory) {
    throw new Error(`No knowledge source for type "${args.type}". Known: ${listKnowledgeSourceTypes().join(", ") || "(none)"}`);
  }
  const source = factory();
  await source.init(args.config, args.env);
  return source;
}

export function _resetKnowledgeRegistry(): void {
  factories.clear();
}
```

- [ ] **Step 3: Write failing GitKnowledgeSource test**

Create `packages/knowledge-source/tests/git-source.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { GitKnowledgeSource } from "../src/git-source.js";

let upstreamRepo: string;
let workdir: string;

beforeEach(async () => {
  upstreamRepo = mkdtempSync(join(tmpdir(), "ks-upstream-"));
  workdir = mkdtempSync(join(tmpdir(), "ks-work-"));
  const g = simpleGit(upstreamRepo);
  await g.init(["--initial-branch=main"]);
  writeFileSync(join(upstreamRepo, "a.md"), "# A\n\ncontent");
  mkdirSync(join(upstreamRepo, "sub"), { recursive: true });
  writeFileSync(join(upstreamRepo, "sub", "b.md"), "# B\n\nmore");
  writeFileSync(join(upstreamRepo, "ignore.txt"), "skip me");
  await g.add(".");
  await g.addConfig("user.email", "test@test").addConfig("user.name", "Test");
  await g.commit("init");
});

afterEach(() => {
  rmSync(upstreamRepo, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

describe("GitKnowledgeSource", () => {
  it("clones on first sync and reports added files", async () => {
    const src = new GitKnowledgeSource();
    await src.init(
      { repo_url: upstreamRepo, branch: "main", local_path: workdir, include_globs: ["**/*.md"], exclude_globs: [] },
      {},
    );
    const result = await src.sync();
    const paths = result.added.map((f) => f.path).sort();
    expect(paths).toEqual(["a.md", "sub/b.md"]);
    expect(result.deleted).toEqual([]);
  });

  it("listFiles returns only .md files post-sync", async () => {
    const src = new GitKnowledgeSource();
    await src.init(
      { repo_url: upstreamRepo, branch: "main", local_path: workdir, include_globs: ["**/*.md"], exclude_globs: [] },
      {},
    );
    await src.sync();
    const files = await src.listFiles();
    expect(files.map((f) => f.path).sort()).toEqual(["a.md", "sub/b.md"]);
  });

  it("readFile returns content + lastModified", async () => {
    const src = new GitKnowledgeSource();
    await src.init(
      { repo_url: upstreamRepo, branch: "main", local_path: workdir, include_globs: ["**/*.md"], exclude_globs: [] },
      {},
    );
    await src.sync();
    const { content } = await src.readFile("a.md");
    expect(content).toContain("# A");
  });

  it("detects modifications on subsequent sync via content hash", async () => {
    const src = new GitKnowledgeSource();
    await src.init(
      { repo_url: upstreamRepo, branch: "main", local_path: workdir, include_globs: ["**/*.md"], exclude_globs: [] },
      {},
    );
    await src.sync();
    writeFileSync(join(upstreamRepo, "a.md"), "# A\n\nchanged");
    const g = simpleGit(upstreamRepo);
    await g.add(".").commit("modify a");
    const result = await src.sync();
    expect(result.modified.map((f) => f.path)).toContain("a.md");
  });

  it("detects deletions on subsequent sync", async () => {
    const src = new GitKnowledgeSource();
    await src.init(
      { repo_url: upstreamRepo, branch: "main", local_path: workdir, include_globs: ["**/*.md"], exclude_globs: [] },
      {},
    );
    await src.sync();
    rmSync(join(upstreamRepo, "a.md"));
    const g = simpleGit(upstreamRepo);
    await g.add(".").commit("delete a");
    const result = await src.sync();
    expect(result.deleted).toContain("a.md");
  });
});
```

- [ ] **Step 4: Implement `src/git-source.ts`**

```ts
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { KnowledgeSource, KnowledgeFile, SyncResult, KnowledgeSourceConfig } from "@agent-mouth/core";

export interface GitKnowledgeSourceConfig extends KnowledgeSourceConfig {
  repo_url: string;
  branch: string;
  local_path: string;
  include_globs?: string[];
  exclude_globs?: string[];
  deploy_key_env_var?: string;
}

function matchesGlob(path: string, globs: string[]): boolean {
  // simple-ish matcher: ** matches any depth; * matches no path separator
  for (const glob of globs) {
    const re = new RegExp(
      "^" +
        glob
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "::DOUBLESTAR::")
          .replace(/\*/g, "[^/]*")
          .replace(/::DOUBLESTAR::/g, ".*") +
        "$",
    );
    if (re.test(path)) return true;
  }
  return false;
}

function walkMd(root: string, sub = ""): string[] {
  const out: string[] = [];
  const dir = sub ? join(root, sub) : root;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkMd(root, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function hashFile(absPath: string): string {
  const content = readFileSync(absPath);
  return createHash("sha256").update(content).digest("hex");
}

export class GitKnowledgeSource implements KnowledgeSource {
  readonly type = "git";
  private cfg!: GitKnowledgeSourceConfig;
  private git!: SimpleGit;
  private lastHashes = new Map<string, string>();

  async init(config: KnowledgeSourceConfig, _env: Record<string, string | undefined>): Promise<void> {
    this.cfg = config as GitKnowledgeSourceConfig;
    if (!this.cfg.repo_url || !this.cfg.branch || !this.cfg.local_path) {
      throw new Error("GitKnowledgeSource requires repo_url, branch, local_path");
    }
  }

  async sync(): Promise<SyncResult> {
    if (!existsSync(join(this.cfg.local_path, ".git"))) {
      const top = simpleGit();
      await top.clone(this.cfg.repo_url, this.cfg.local_path, ["--depth", "1", "--branch", this.cfg.branch]);
    } else {
      this.git = simpleGit(this.cfg.local_path);
      await this.git.fetch("origin", this.cfg.branch);
      await this.git.reset(["--hard", `origin/${this.cfg.branch}`]);
    }
    this.git = simpleGit(this.cfg.local_path);

    const include = this.cfg.include_globs ?? ["**/*.md"];
    const exclude = this.cfg.exclude_globs ?? [];

    const allFiles = walkMd(this.cfg.local_path).filter(
      (p) => matchesGlob(p, include) && !matchesGlob(p, exclude),
    );

    const currentHashes = new Map<string, string>();
    const added: KnowledgeFile[] = [];
    const modified: KnowledgeFile[] = [];
    const errors: SyncResult["errors"] = [];

    for (const path of allFiles) {
      try {
        const abs = join(this.cfg.local_path, path);
        const h = hashFile(abs);
        currentHashes.set(path, h);
        const prev = this.lastHashes.get(path);
        const stat = statSync(abs);
        const kf: KnowledgeFile = { path, contentHash: h, lastModified: stat.mtime, size: stat.size };
        if (prev === undefined) added.push(kf);
        else if (prev !== h) modified.push(kf);
      } catch (err) {
        errors.push({ path, error: (err as Error).message });
      }
    }

    const deleted: string[] = [];
    for (const prevPath of this.lastHashes.keys()) {
      if (!currentHashes.has(prevPath)) deleted.push(prevPath);
    }

    this.lastHashes = currentHashes;
    return { added, modified, deleted, errors };
  }

  async listFiles(): Promise<KnowledgeFile[]> {
    const include = this.cfg.include_globs ?? ["**/*.md"];
    const exclude = this.cfg.exclude_globs ?? [];
    const all = walkMd(this.cfg.local_path).filter(
      (p) => matchesGlob(p, include) && !matchesGlob(p, exclude),
    );
    return all.map((path) => {
      const abs = join(this.cfg.local_path, path);
      const stat = statSync(abs);
      return { path, contentHash: hashFile(abs), lastModified: stat.mtime, size: stat.size };
    });
  }

  async readFile(path: string): Promise<{ content: string; lastModified: Date }> {
    const abs = join(this.cfg.local_path, path);
    if (!existsSync(abs)) throw new Error(`File not found: ${path}`);
    const content = readFileSync(abs, "utf-8");
    const stat = statSync(abs);
    return { content, lastModified: stat.mtime };
  }
}
```

- [ ] **Step 5: Implement `src/index.ts`**

```ts
export * from "./registry.js";
export * from "./git-source.js";
export * from "./chunkers/markdown-chunker.js";

import { registerKnowledgeSourceType } from "./registry.js";
import { GitKnowledgeSource } from "./git-source.js";

registerKnowledgeSourceType("git", () => new GitKnowledgeSource());
```

- [ ] **Step 6: Run all knowledge-source tests**

```bash
pnpm --filter @agent-mouth/knowledge-source test
```

Expected: all PASS (chunker tests from Task 5 + new git + registry tests).

- [ ] **Step 7: Commit**

```bash
git add packages/knowledge-source
git commit -m "feat(knowledge-source): add GitKnowledgeSource + registry (TDD with temp git repos)"
```

---

### Task 7: Scaffold `@agent-mouth/vector-store` with PgvectorStore

**Files:**
- Create: `packages/vector-store/package.json` (depends on `pg`)
- Create: `packages/vector-store/tsconfig.json`
- Create: `packages/vector-store/src/{index,types,registry,pgvector-store}.ts`
- Test: `packages/vector-store/tests/pgvector-store.test.ts` (requires `PGVECTOR_TEST_URL` env)
- Test: `packages/vector-store/tests/registry.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@agent-mouth/vector-store",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run",
    "lint": "biome check src tests"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (template).

- [ ] **Step 3: Write registry test** (mirror Task 3 Step 3 pattern, swap names — file `tests/registry.test.ts`).

Test that `registerVectorStoreType("pgvector", factory)` + `resolveVectorStore({type:"pgvector", env})` works.

- [ ] **Step 4: Implement `src/registry.ts`** (mirror knowledge-source registry pattern):

```ts
import type { VectorStore } from "@agent-mouth/core";

const factories = new Map<string, () => VectorStore>();

export function registerVectorStoreType(type: string, factory: () => VectorStore): void {
  factories.set(type, factory);
}

export function listVectorStoreTypes(): string[] {
  return Array.from(factories.keys());
}

export async function resolveVectorStore(args: {
  type: string;
  env: Record<string, string | undefined>;
}): Promise<VectorStore> {
  const factory = factories.get(args.type);
  if (!factory) throw new Error(`No vector store for type "${args.type}". Known: ${listVectorStoreTypes().join(", ") || "(none)"}`);
  const store = factory();
  await store.init(args.env);
  return store;
}

export function _resetVectorStoreRegistry(): void {
  factories.clear();
}
```

- [ ] **Step 5: Write failing PgvectorStore integration test**

Create `packages/vector-store/tests/pgvector-store.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { PgvectorStore } from "../src/pgvector-store.js";

const DATABASE_URL = process.env.PGVECTOR_TEST_URL;
const SHOULD_RUN = !!DATABASE_URL;

(SHOULD_RUN ? describe : describe.skip)("PgvectorStore (live pg)", () => {
  let store: PgvectorStore;
  let client: Client;
  const wsId = "00000000-0000-0000-0000-000000000001";

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await client.query(`
      DROP TABLE IF EXISTS knowledge_chunks_test CASCADE;
      DROP TABLE IF EXISTS knowledge_files_test CASCADE;
      DROP TABLE IF EXISTS knowledge_sources_test CASCADE;
    `);
    // Run minimal schema matching production
    await client.query(`
      CREATE TABLE knowledge_sources_test (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL
      );
      CREATE TABLE knowledge_files_test (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id uuid NOT NULL REFERENCES knowledge_sources_test(id) ON DELETE CASCADE,
        path text NOT NULL
      );
      CREATE TABLE knowledge_chunks_test (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        file_id uuid NOT NULL REFERENCES knowledge_files_test(id) ON DELETE CASCADE,
        chunk_index integer NOT NULL,
        text text NOT NULL,
        embedding vector(4),
        token_count integer,
        metadata jsonb,
        UNIQUE (file_id, chunk_index)
      );
    `);
    store = new PgvectorStore({
      tablePrefix: "knowledge_",
      tableSuffix: "_test",
      embeddingDim: 4,
    });
    await store.init({ DATABASE_URL: DATABASE_URL! });
  });

  afterAll(async () => {
    await client.query(`DROP TABLE knowledge_chunks_test, knowledge_files_test, knowledge_sources_test CASCADE`);
    await client.end();
    await store.close();
  });

  beforeEach(async () => {
    await client.query(`DELETE FROM knowledge_chunks_test`);
    await client.query(`DELETE FROM knowledge_files_test`);
    await client.query(`DELETE FROM knowledge_sources_test`);
  });

  it("upserts chunks and searches by cosine similarity", async () => {
    const srcRes = await client.query(`INSERT INTO knowledge_sources_test (workspace_id) VALUES ($1) RETURNING id`, [wsId]);
    const sourceId = srcRes.rows[0].id;
    const fileRes = await client.query(
      `INSERT INTO knowledge_files_test (source_id, path) VALUES ($1, $2) RETURNING id`,
      [sourceId, "test.md"],
    );
    const fileId = fileRes.rows[0].id;
    await store.upsert(fileId, [
      { fileId, chunkIndex: 0, text: "hello", embedding: [1, 0, 0, 0], tokenCount: 1, metadata: { heading_path: "H1" } },
      { fileId, chunkIndex: 1, text: "world", embedding: [0, 1, 0, 0], tokenCount: 1, metadata: { heading_path: "H2" } },
    ]);
    const results = await store.search([1, 0, 0, 0], {
      topK: 5,
      filter: { workspaceId: wsId },
    });
    expect(results[0].text).toBe("hello");
  });

  it("deleteByFileId removes chunks", async () => {
    const srcRes = await client.query(`INSERT INTO knowledge_sources_test (workspace_id) VALUES ($1) RETURNING id`, [wsId]);
    const sourceId = srcRes.rows[0].id;
    const fileRes = await client.query(
      `INSERT INTO knowledge_files_test (source_id, path) VALUES ($1, $2) RETURNING id`,
      [sourceId, "x.md"],
    );
    const fileId = fileRes.rows[0].id;
    await store.upsert(fileId, [
      { fileId, chunkIndex: 0, text: "x", embedding: [1, 0, 0, 0], tokenCount: 1, metadata: {} },
    ]);
    await store.deleteByFileId(fileId);
    const { rows } = await client.query(`SELECT count(*)::int FROM knowledge_chunks_test WHERE file_id=$1`, [fileId]);
    expect(rows[0].count).toBe(0);
  });
});
```

- [ ] **Step 6: Implement `src/pgvector-store.ts`**

```ts
import { Client } from "pg";
import type { VectorStore, VectorChunkInput, VectorSearchResult, VectorSearchFilter } from "@agent-mouth/core";

export interface PgvectorStoreOptions {
  tablePrefix?: string;       // default "knowledge_"
  tableSuffix?: string;       // default ""
  embeddingDim?: number;      // default 1536
}

export class PgvectorStore implements VectorStore {
  readonly type = "pgvector";
  private client: Client | null = null;
  private readonly chunksTable: string;
  private readonly filesTable: string;
  private readonly sourcesTable: string;

  constructor(private readonly opts: PgvectorStoreOptions = {}) {
    const prefix = opts.tablePrefix ?? "knowledge_";
    const suffix = opts.tableSuffix ?? "";
    this.chunksTable = `${prefix}chunks${suffix}`;
    this.filesTable = `${prefix}files${suffix}`;
    this.sourcesTable = `${prefix}sources${suffix}`;
  }

  async init(env: Record<string, string | undefined>): Promise<void> {
    const url = env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL required for PgvectorStore");
    this.client = new Client({ connectionString: url });
    await this.client.connect();
  }

  async close(): Promise<void> {
    if (this.client) await this.client.end();
    this.client = null;
  }

  async upsert(fileId: string, chunks: VectorChunkInput[]): Promise<void> {
    if (!this.client) throw new Error("not initialized");
    if (chunks.length === 0) return;
    await this.client.query("BEGIN");
    try {
      await this.client.query(`DELETE FROM ${this.chunksTable} WHERE file_id=$1`, [fileId]);
      for (const c of chunks) {
        const vectorLiteral = `[${c.embedding.join(",")}]`;
        await this.client.query(
          `INSERT INTO ${this.chunksTable} (file_id, chunk_index, text, embedding, token_count, metadata)
           VALUES ($1, $2, $3, $4::vector, $5, $6)`,
          [c.fileId, c.chunkIndex, c.text, vectorLiteral, c.tokenCount, JSON.stringify(c.metadata)],
        );
      }
      await this.client.query("COMMIT");
    } catch (err) {
      await this.client.query("ROLLBACK");
      throw err;
    }
  }

  async deleteByFileId(fileId: string): Promise<void> {
    if (!this.client) throw new Error("not initialized");
    await this.client.query(`DELETE FROM ${this.chunksTable} WHERE file_id=$1`, [fileId]);
  }

  async search(
    queryVector: number[],
    opts: { topK: number; filter: VectorSearchFilter },
  ): Promise<VectorSearchResult[]> {
    if (!this.client) throw new Error("not initialized");
    const vectorLiteral = `[${queryVector.join(",")}]`;
    const params: unknown[] = [vectorLiteral, opts.filter.workspaceId, opts.topK];
    let pathFilter = "";
    if (opts.filter.pathPrefix) {
      params.push(`${opts.filter.pathPrefix}%`);
      pathFilter = `AND f.path LIKE $${params.length}`;
    }
    let tipoFilter = "";
    if (opts.filter.frontmatterTipo) {
      params.push(opts.filter.frontmatterTipo);
      tipoFilter = `AND c.metadata->'frontmatter'->>'tipo' = $${params.length}`;
    }
    const sql = `
      SELECT
        c.file_id, f.path AS file_path, c.chunk_index, c.text,
        1 - (c.embedding <=> $1::vector) AS score,
        c.metadata
      FROM ${this.chunksTable} c
      JOIN ${this.filesTable} f ON f.id = c.file_id
      JOIN ${this.sourcesTable} s ON s.id = f.source_id
      WHERE s.workspace_id = $2
        AND c.embedding IS NOT NULL
        ${pathFilter}
        ${tipoFilter}
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3
    `;
    const { rows } = await this.client.query(sql, params);
    return rows.map((r) => ({
      fileId: r.file_id,
      filePath: r.file_path,
      chunkIndex: r.chunk_index,
      text: r.text,
      score: Number(r.score),
      metadata: r.metadata,
    }));
  }
}
```

- [ ] **Step 7: Implement `src/index.ts`**

```ts
export * from "./registry.js";
export * from "./pgvector-store.js";

import { registerVectorStoreType } from "./registry.js";
import { PgvectorStore } from "./pgvector-store.js";

registerVectorStoreType("pgvector", () => new PgvectorStore());
```

- [ ] **Step 8: Run tests**

```bash
pnpm install
pnpm --filter @agent-mouth/vector-store test
```

Expected: registry tests PASS. PgvectorStore tests skip unless `PGVECTOR_TEST_URL` is set in env.

To run the live tests locally:

```bash
PGVECTOR_TEST_URL=postgresql://postgres:postgres@localhost:5433/pgvector_test \
  pnpm --filter @agent-mouth/vector-store test
```

(Spin a throwaway Postgres-with-pgvector container if needed: `docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=postgres ankane/pgvector`.)

- [ ] **Step 9: Commit**

```bash
git add packages/vector-store pnpm-lock.yaml
git commit -m "feat(vector-store): add @agent-mouth/vector-store with PgvectorStore (TDD against live pg)"
```

---

## Sprint 2 — Tools + ingestion (Tasks 8-13)

### Task 8: Scaffold `@agent-mouth/agent-tools` package with registry

**Files:**
- Create: `packages/agent-tools/package.json`
- Create: `packages/agent-tools/tsconfig.json`
- Create: `packages/agent-tools/src/{index,types,registry}.ts`
- Test: `packages/agent-tools/tests/registry.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@agent-mouth/agent-tools",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run",
    "lint": "biome check src tests"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*",
    "@agent-mouth/web-search": "workspace:*",
    "@agent-mouth/vector-store": "workspace:*",
    "@agent-mouth/embeddings": "workspace:*",
    "@agent-mouth/knowledge-source": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (template).

- [ ] **Step 3: Write failing registry test**

Create `packages/agent-tools/tests/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { Tool, ToolContext, Policy } from "@agent-mouth/core";
import {
  registerTool,
  listTools,
  getTool,
  resolveToolsForPolicy,
  _resetToolRegistry,
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
    id: "p",
    workspace_id: "w",
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
    allowed_tools: JSON.stringify(allowedTools),
    created_at: "2026-05-23T00:00:00Z",
  } as unknown as Policy;
}

describe("tool registry", () => {
  beforeEach(() => _resetToolRegistry());

  it("registers and lists tools", () => {
    registerTool(makeTool("alpha"));
    registerTool(makeTool("beta"));
    expect(listTools().map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
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

  it("resolveToolsForPolicy with explicit list returns intersection (including destructive)", () => {
    registerTool(makeTool("read1"));
    registerTool(makeTool("destructive", true));
    const out = resolveToolsForPolicy(policy(["destructive"])).map((t) => t.name);
    expect(out).toEqual(["destructive"]);
  });
});
```

- [ ] **Step 4: Implement `src/registry.ts`**

```ts
import type { Tool, Policy } from "@agent-mouth/core";

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  tools.set(tool.name, tool);
}

export function listTools(): Tool[] {
  return Array.from(tools.values());
}

export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

export function resolveToolsForPolicy(policy: Policy): Tool[] {
  const raw = policy.allowed_tools ?? "[]";
  let allowed: string[];
  try {
    allowed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(allowed) || allowed.length === 0) return [];
  if (allowed.includes("*")) {
    return listTools().filter((t) => !t.requiresExplicitGrant);
  }
  return listTools().filter((t) => allowed.includes(t.name));
}

export function _resetToolRegistry(): void {
  tools.clear();
}
```

- [ ] **Step 5: Verify policy schema has `allowed_tools`**

Add `allowed_tools: z.string().default('["*"]')` to `PolicySchema` in `packages/core/src/identity.ts`. Modify the existing `PolicySchema` definition.

Update `packages/core/tests/identity.test.ts`: in `PolicySchema parses with nullable contact_id and channel_type`, add `allowed_tools: '["*"]'` to the expected default keys.

```ts
expect(PolicySchema.parse(p)).toEqual({
  ...p,
  model_id: null,
  rate_limit_per_hour: 10,
  max_tokens_out: 8000,
  max_tool_calls: 10,
  forbidden_topics_regex: [],
  escalate_triggers_regex: [],
  allowed_tools: '["*"]',
});
```

- [ ] **Step 6: Run tests**

```bash
pnpm install
pnpm --filter @agent-mouth/core test
pnpm --filter @agent-mouth/agent-tools test
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-tools packages/core pnpm-lock.yaml
git commit -m "feat(agent-tools): add registry + extend Policy schema with allowed_tools"
```

---

### Task 9: Implement `SearchWebTool`

**Files:**
- Create: `packages/agent-tools/src/search-web-tool.ts`
- Test: `packages/agent-tools/tests/search-web-tool.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/agent-tools/tests/search-web-tool.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { WebSearchProvider } from "@agent-mouth/core";
import { SearchWebTool } from "../src/search-web-tool.js";

function ctx(): any {
  return {
    workspaceId: "w",
    contactId: "c",
    threadId: "t",
    policy: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("SearchWebTool", () => {
  it("returns provider results wrapped with cost", async () => {
    const fakeProvider: WebSearchProvider = {
      name: "fake",
      init: async () => {},
      search: async (q) => ({
        answer: `answer for ${q}`,
        results: [{ title: "T", url: "https://x.com", snippet: "s" }],
      }),
    };
    const tool = new SearchWebTool({ provider: fakeProvider });
    const res = await tool.execute({ query: "node lts" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({
      results: [{ title: "T", url: "https://x.com", snippet: "s", publishedAt: undefined }],
      answer: "answer for node lts",
    });
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns ok=false on provider error", async () => {
    const fail: WebSearchProvider = {
      name: "fail",
      init: async () => {},
      search: async () => {
        throw new Error("boom");
      },
    };
    const tool = new SearchWebTool({ provider: fail });
    const res = await tool.execute({ query: "x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("boom");
  });

  it("defaults max_results to 5 when not provided", async () => {
    let capturedMax = 0;
    const spy: WebSearchProvider = {
      name: "spy",
      init: async () => {},
      search: async (_q, opts) => {
        capturedMax = opts.maxResults;
        return { results: [] };
      },
    };
    const tool = new SearchWebTool({ provider: spy });
    await tool.execute({ query: "x" }, ctx());
    expect(capturedMax).toBe(5);
  });
});
```

- [ ] **Step 2: Implement `src/search-web-tool.ts`**

```ts
import type { Tool, ToolContext, WebSearchProvider } from "@agent-mouth/core";

const ESTIMATED_COST_PER_CALL = 0.001;

export interface SearchWebInput {
  query: string;
  max_results?: number;
}

export class SearchWebTool implements Tool<SearchWebInput> {
  readonly name = "search_web";
  readonly description =
    "Search the public web for current information. Use when the user asks about news, prices, weather, recent events, or anything that may have changed since your training cutoff. Returns curated results with citations.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query in natural language" },
      max_results: { type: "integer", default: 5, maximum: 10 },
    },
    required: ["query"],
  };
  readonly requiresExplicitGrant = false;

  constructor(private readonly deps: { provider: WebSearchProvider }) {}

  async execute(input: SearchWebInput, _ctx: ToolContext) {
    const start = Date.now();
    try {
      const out = await this.deps.provider.search(input.query, { maxResults: input.max_results ?? 5 });
      return {
        ok: true,
        output: out,
        costUsd: ESTIMATED_COST_PER_CALL,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        costUsd: 0,
        latencyMs: Date.now() - start,
      };
    }
  }
}
```

- [ ] **Step 3: Test + commit**

```bash
pnpm --filter @agent-mouth/agent-tools test search-web-tool
git add packages/agent-tools/src/search-web-tool.ts packages/agent-tools/tests/search-web-tool.test.ts
git commit -m "feat(agent-tools): add SearchWebTool"
```

---

### Task 10: Implement `SearchKnowledgeTool`

**Files:**
- Create: `packages/agent-tools/src/search-knowledge-tool.ts`
- Test: `packages/agent-tools/tests/search-knowledge-tool.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import type { VectorStore, EmbeddingProvider } from "@agent-mouth/core";
import { SearchKnowledgeTool } from "../src/search-knowledge-tool.js";

function ctx(): any {
  return {
    workspaceId: "ws-1",
    contactId: "c",
    threadId: "t",
    policy: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("SearchKnowledgeTool", () => {
  it("embeds query, searches vector store, returns chunks with paths", async () => {
    const embedder: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async (txts) => txts.map(() => [0, 1, 0, 0]),
      embedQuery: async () => [0, 1, 0, 0],
    };
    const store: VectorStore = {
      type: "fake",
      init: async () => {},
      upsert: async () => {},
      deleteByFileId: async () => {},
      search: async (_v, opts) => [
        {
          fileId: "f1",
          filePath: "02-Proyectos/x.md",
          chunkIndex: 0,
          text: "matching text",
          score: 0.87,
          metadata: { heading_path: "# X > ## S", frontmatter: { tipo: "proyecto" } },
        },
      ],
    };
    const tool = new SearchKnowledgeTool({ embedder, vectorStore: store });
    const res = await tool.execute({ query: "where is x" }, ctx());
    expect(res.ok).toBe(true);
    const out = res.output as any;
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0].file_path).toBe("02-Proyectos/x.md");
    expect(out.chunks[0].heading_path).toBe("# X > ## S");
  });

  it("passes workspaceId filter from ctx", async () => {
    let captured: any;
    const embedder: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async () => [[0, 0, 0, 0]],
      embedQuery: async () => [0, 0, 0, 0],
    };
    const store: VectorStore = {
      type: "fake",
      init: async () => {},
      upsert: async () => {},
      deleteByFileId: async () => {},
      search: async (_v, opts) => {
        captured = opts;
        return [];
      },
    };
    const tool = new SearchKnowledgeTool({ embedder, vectorStore: store });
    await tool.execute({ query: "x", filter: { path_prefix: "02-" } }, ctx());
    expect(captured.filter.workspaceId).toBe("ws-1");
    expect(captured.filter.pathPrefix).toBe("02-");
  });
});
```

- [ ] **Step 2: Implement `src/search-knowledge-tool.ts`**

```ts
import type { Tool, ToolContext, VectorStore, EmbeddingProvider } from "@agent-mouth/core";

const EMBED_COST_PER_QUERY = 0.00002;

export interface SearchKnowledgeInput {
  query: string;
  max_results?: number;
  filter?: { path_prefix?: string; frontmatter_tipo?: string };
}

export class SearchKnowledgeTool implements Tool<SearchKnowledgeInput> {
  readonly name = "search_knowledge";
  readonly description =
    "Search the user's personal knowledge base (Cerebro Digital — projects, decisions, sessions, profile). Use when the user references their work, asks about past decisions, project status, or anything personal. Returns relevant chunks with file paths so you can call read_knowledge_file for full context.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string" },
      max_results: { type: "integer", default: 5, maximum: 15 },
      filter: {
        type: "object",
        properties: {
          path_prefix: { type: "string", description: "e.g. '02-Proyectos/'" },
          frontmatter_tipo: { type: "string", description: "e.g. 'proyecto'" },
        },
      },
    },
    required: ["query"],
  };
  readonly requiresExplicitGrant = false;

  constructor(private readonly deps: { embedder: EmbeddingProvider; vectorStore: VectorStore }) {}

  async execute(input: SearchKnowledgeInput, ctx: ToolContext) {
    const start = Date.now();
    try {
      const vec = await this.deps.embedder.embedQuery(input.query);
      const hits = await this.deps.vectorStore.search(vec, {
        topK: input.max_results ?? 5,
        filter: {
          workspaceId: ctx.workspaceId,
          pathPrefix: input.filter?.path_prefix,
          frontmatterTipo: input.filter?.frontmatter_tipo,
        },
      });
      return {
        ok: true,
        output: {
          chunks: hits.map((h) => ({
            file_path: h.filePath,
            heading_path: (h.metadata as any)?.heading_path ?? "",
            text: h.text,
            score: h.score,
          })),
        },
        costUsd: EMBED_COST_PER_QUERY,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        costUsd: 0,
        latencyMs: Date.now() - start,
      };
    }
  }
}
```

- [ ] **Step 3: Test + commit**

```bash
pnpm --filter @agent-mouth/agent-tools test search-knowledge-tool
git add packages/agent-tools/src/search-knowledge-tool.ts packages/agent-tools/tests/search-knowledge-tool.test.ts
git commit -m "feat(agent-tools): add SearchKnowledgeTool"
```

---

### Task 11: Implement `ReadKnowledgeFileTool`

**Files:**
- Create: `packages/agent-tools/src/read-knowledge-file-tool.ts`
- Test: `packages/agent-tools/tests/read-knowledge-file-tool.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import type { KnowledgeSource } from "@agent-mouth/core";
import { ReadKnowledgeFileTool } from "../src/read-knowledge-file-tool.js";

function ctx(): any {
  return {
    workspaceId: "w",
    contactId: "c",
    threadId: "t",
    policy: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("ReadKnowledgeFileTool", () => {
  it("returns full content + last_modified + token_count", async () => {
    const src: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: [], errors: [] }),
      listFiles: async () => [],
      readFile: async () => ({ content: "# Title\n\nbody content", lastModified: new Date("2026-05-23T12:00:00Z") }),
    };
    const tool = new ReadKnowledgeFileTool({ knowledgeSource: src });
    const res = await tool.execute({ path: "x.md" }, ctx());
    expect(res.ok).toBe(true);
    const out = res.output as any;
    expect(out.content).toContain("# Title");
    expect(out.path).toBe("x.md");
    expect(out.token_count).toBeGreaterThan(0);
  });

  it("returns truncated=true when file exceeds 50k tokens", async () => {
    const huge = "lorem ipsum ".repeat(20000); // ~60k tokens
    const src: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: [], errors: [] }),
      listFiles: async () => [],
      readFile: async () => ({ content: huge, lastModified: new Date() }),
    };
    const tool = new ReadKnowledgeFileTool({ knowledgeSource: src });
    const res = await tool.execute({ path: "big.md" }, ctx());
    expect((res.output as any).truncated).toBe(true);
    expect((res.output as any).token_count).toBeLessThanOrEqual(50000);
  });

  it("returns ok=false when readFile throws", async () => {
    const src: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: [], errors: [] }),
      listFiles: async () => [],
      readFile: async () => {
        throw new Error("not found");
      },
    };
    const tool = new ReadKnowledgeFileTool({ knowledgeSource: src });
    const res = await tool.execute({ path: "missing.md" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });
});
```

- [ ] **Step 2: Implement `src/read-knowledge-file-tool.ts`**

```ts
import { encode, decode } from "gpt-tokenizer";
import type { Tool, ToolContext, KnowledgeSource } from "@agent-mouth/core";

const MAX_TOKENS = 50000;

export interface ReadKnowledgeFileInput {
  path: string;
}

export class ReadKnowledgeFileTool implements Tool<ReadKnowledgeFileInput> {
  readonly name = "read_knowledge_file";
  readonly description =
    "Read the full content of a file from the knowledge base. Use after search_knowledge if a chunk looks relevant and you need more context, or when you already know the exact path.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Relative path returned by search_knowledge, e.g. '02-Proyectos/agent-mouth.md'" },
    },
    required: ["path"],
  };
  readonly requiresExplicitGrant = false;

  constructor(private readonly deps: { knowledgeSource: KnowledgeSource }) {}

  async execute(input: ReadKnowledgeFileInput, _ctx: ToolContext) {
    const start = Date.now();
    try {
      const { content, lastModified } = await this.deps.knowledgeSource.readFile(input.path);
      const tokens = encode(content);
      let outContent = content;
      let truncated = false;
      if (tokens.length > MAX_TOKENS) {
        outContent = decode(tokens.slice(0, MAX_TOKENS));
        truncated = true;
      }
      return {
        ok: true,
        output: {
          path: input.path,
          content: outContent,
          last_modified: lastModified.toISOString(),
          token_count: truncated ? MAX_TOKENS : tokens.length,
          truncated,
        },
        costUsd: 0,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        costUsd: 0,
        latencyMs: Date.now() - start,
      };
    }
  }
}
```

- [ ] **Step 3: Add `gpt-tokenizer` to agent-tools dependencies**

Edit `packages/agent-tools/package.json` → add `"gpt-tokenizer": "^2.4.0"` to `dependencies`.

- [ ] **Step 4: Implement `src/index.ts` (bootstrap)**

```ts
export * from "./registry.js";
export * from "./search-web-tool.js";
export * from "./search-knowledge-tool.js";
export * from "./read-knowledge-file-tool.js";

import { registerTool } from "./registry.js";
import { SearchWebTool } from "./search-web-tool.js";
import { SearchKnowledgeTool } from "./search-knowledge-tool.js";
import { ReadKnowledgeFileTool } from "./read-knowledge-file-tool.js";
import type { WebSearchProvider, VectorStore, EmbeddingProvider, KnowledgeSource } from "@agent-mouth/core";

export interface BootstrapToolsDeps {
  webSearchProvider: WebSearchProvider;
  vectorStore: VectorStore;
  embedder: EmbeddingProvider;
  knowledgeSource: KnowledgeSource;
}

export function bootstrapTools(deps: BootstrapToolsDeps): void {
  registerTool(new SearchWebTool({ provider: deps.webSearchProvider }));
  registerTool(new SearchKnowledgeTool({ embedder: deps.embedder, vectorStore: deps.vectorStore }));
  registerTool(new ReadKnowledgeFileTool({ knowledgeSource: deps.knowledgeSource }));
}
```

- [ ] **Step 5: Test + commit**

```bash
pnpm install
pnpm --filter @agent-mouth/agent-tools test
git add packages/agent-tools pnpm-lock.yaml
git commit -m "feat(agent-tools): add ReadKnowledgeFileTool + bootstrap helper"
```

---

### Task 12: Knowledge ingestion pipeline (sync handler)

**Files:**
- Create: `packages/knowledge-source/src/indexer.ts` (orchestrator)
- Test: `packages/knowledge-source/tests/indexer.test.ts`

This task wires the ingestion pipeline: source → chunker → embedder → vector store + records in `knowledge_files`.

- [ ] **Step 1: Write failing test (uses fakes for source/embedder/store + real pg for files table)**

Skip the live DB part for indexer unit tests; test purely the orchestration logic with fakes:

Create `packages/knowledge-source/tests/indexer.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { KnowledgeSource, EmbeddingProvider, VectorStore } from "@agent-mouth/core";
import { indexSource } from "../src/indexer.js";
import { MarkdownChunker } from "../src/chunkers/markdown-chunker.js";

interface FakeFileRow {
  id: string;
  source_id: string;
  path: string;
  content_hash: string;
  indexed_at: Date | null;
}

class FakeFilesRepo {
  rows: FakeFileRow[] = [];
  async getByPath(sourceId: string, path: string) {
    return this.rows.find((r) => r.source_id === sourceId && r.path === path) ?? null;
  }
  async upsert(row: Omit<FakeFileRow, "id">): Promise<string> {
    const existing = await this.getByPath(row.source_id, row.path);
    if (existing) {
      existing.content_hash = row.content_hash;
      existing.indexed_at = row.indexed_at;
      return existing.id;
    }
    const id = `f-${this.rows.length + 1}`;
    this.rows.push({ id, ...row });
    return id;
  }
  async deleteByPath(sourceId: string, path: string): Promise<string | null> {
    const idx = this.rows.findIndex((r) => r.source_id === sourceId && r.path === path);
    if (idx === -1) return null;
    const [removed] = this.rows.splice(idx, 1);
    return removed.id;
  }
}

describe("indexSource", () => {
  it("embeds added files and upserts chunks", async () => {
    const source: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({
        added: [{ path: "a.md", contentHash: "h1", lastModified: new Date(), size: 10 }],
        modified: [],
        deleted: [],
        errors: [],
      }),
      listFiles: async () => [],
      readFile: async () => ({ content: "# A\n\nbody", lastModified: new Date() }),
    };
    const embedder: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async (texts) => texts.map(() => [0, 0, 0, 0]),
      embedQuery: async () => [0, 0, 0, 0],
    };
    const upsertSpy = vi.fn(async () => {});
    const store = {
      type: "fake",
      init: async () => {},
      upsert: upsertSpy,
      deleteByFileId: vi.fn(async () => {}),
      search: vi.fn(async () => []),
    } as unknown as VectorStore;
    const filesRepo = new FakeFilesRepo();
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });

    const result = await indexSource({
      sourceId: "src-1",
      source,
      embedder,
      vectorStore: store,
      chunker,
      filesRepo,
    });
    expect(result.added).toBe(1);
    expect(filesRepo.rows).toHaveLength(1);
    expect(upsertSpy).toHaveBeenCalledOnce();
  });

  it("deletes vectors for removed files", async () => {
    const source: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: ["gone.md"], errors: [] }),
      listFiles: async () => [],
      readFile: async () => { throw new Error("nope"); },
    };
    const embedder: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async () => [],
      embedQuery: async () => [0, 0, 0, 0],
    };
    const deleteSpy = vi.fn(async () => {});
    const store = {
      type: "fake",
      init: async () => {},
      upsert: vi.fn(async () => {}),
      deleteByFileId: deleteSpy,
      search: vi.fn(async () => []),
    } as unknown as VectorStore;
    const filesRepo = new FakeFilesRepo();
    filesRepo.rows.push({ id: "f-existing", source_id: "src-1", path: "gone.md", content_hash: "old", indexed_at: new Date() });
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });

    const result = await indexSource({
      sourceId: "src-1",
      source,
      embedder,
      vectorStore: store,
      chunker,
      filesRepo,
    });
    expect(result.deleted).toBe(1);
    expect(deleteSpy).toHaveBeenCalledWith("f-existing");
    expect(filesRepo.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Define `KnowledgeFilesRepo` interface in `src/indexer.ts` and implement `indexSource`**

```ts
import type { EmbeddingProvider, VectorStore, KnowledgeSource, SyncResult } from "@agent-mouth/core";
import type { MarkdownChunker } from "./chunkers/markdown-chunker.js";

export interface KnowledgeFilesRepo {
  getByPath(sourceId: string, path: string): Promise<{ id: string; content_hash: string } | null>;
  upsert(row: { source_id: string; path: string; content_hash: string; indexed_at: Date | null }): Promise<string>;
  deleteByPath(sourceId: string, path: string): Promise<string | null>;
}

export interface IndexResult {
  added: number;
  modified: number;
  deleted: number;
  errors: number;
}

export interface IndexSourceArgs {
  sourceId: string;
  source: KnowledgeSource;
  embedder: EmbeddingProvider;
  vectorStore: VectorStore;
  chunker: MarkdownChunker;
  filesRepo: KnowledgeFilesRepo;
}

export async function indexSource(args: IndexSourceArgs): Promise<IndexResult> {
  const sync: SyncResult = await args.source.sync();
  const result: IndexResult = { added: 0, modified: 0, deleted: 0, errors: sync.errors.length };

  // Handle deletions first
  for (const path of sync.deleted) {
    const removedId = await args.filesRepo.deleteByPath(args.sourceId, path);
    if (removedId) {
      await args.vectorStore.deleteByFileId(removedId);
      result.deleted++;
    }
  }

  // Handle added + modified
  for (const kind of ["added", "modified"] as const) {
    for (const kf of sync[kind]) {
      try {
        const { content } = await args.source.readFile(kf.path);
        const chunks = args.chunker.split(content, { path: kf.path });
        const fileId = await args.filesRepo.upsert({
          source_id: args.sourceId,
          path: kf.path,
          content_hash: kf.contentHash,
          indexed_at: new Date(),
        });
        if (chunks.length === 0) continue;
        const embeddings = await args.embedder.embed(chunks.map((c) => c.text));
        await args.vectorStore.upsert(
          fileId,
          chunks.map((c, i) => ({
            fileId,
            chunkIndex: i,
            text: c.text,
            embedding: embeddings[i],
            tokenCount: c.tokenCount,
            metadata: c.metadata,
          })),
        );
        if (kind === "added") result.added++;
        else result.modified++;
      } catch (err) {
        result.errors++;
      }
    }
  }
  return result;
}
```

- [ ] **Step 3: Update `src/index.ts` to export indexer**

Append:

```ts
export * from "./indexer.js";
```

- [ ] **Step 4: Test + commit**

```bash
pnpm --filter @agent-mouth/knowledge-source test indexer
git add packages/knowledge-source
git commit -m "feat(knowledge-source): add indexSource orchestrator with KnowledgeFilesRepo interface"
```

---

### Task 13: Implement `KnowledgeFilesRepo` against Supabase

**Files:**
- Create: `packages/storage-supabase/src/knowledge-files-repo.ts`
- Modify: `packages/storage-supabase/src/index.ts` (re-export)
- Test: `packages/storage-supabase/tests/knowledge-files-repo.test.ts` (live pg test, gated on env var)

- [ ] **Step 1: Write failing live test**

Create `packages/storage-supabase/tests/knowledge-files-repo.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { SupabaseKnowledgeFilesRepo } from "../src/knowledge-files-repo.js";

const DATABASE_URL = process.env.PGVECTOR_TEST_URL;
(DATABASE_URL ? describe : describe.skip)("SupabaseKnowledgeFilesRepo", () => {
  let client: Client;
  let repo: SupabaseKnowledgeFilesRepo;
  let sourceId: string;
  const wsId = "00000000-0000-0000-0000-000000000001";

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await client.query(`DROP TABLE IF EXISTS knowledge_chunks, knowledge_files, knowledge_sources, workspaces CASCADE`);
    await client.query(`
      CREATE TABLE workspaces (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE knowledge_sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id), type text NOT NULL, config jsonb NOT NULL, created_at timestamptz DEFAULT now());
      CREATE TABLE knowledge_files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE, path text NOT NULL, content_hash text NOT NULL, indexed_at timestamptz, UNIQUE(source_id, path));
      INSERT INTO workspaces (id, name) VALUES ($1, 'test');
    `, [wsId]);
    const r = await client.query(`INSERT INTO knowledge_sources (workspace_id, type, config) VALUES ($1, 'git', '{}'::jsonb) RETURNING id`, [wsId]);
    sourceId = r.rows[0].id;
    repo = new SupabaseKnowledgeFilesRepo({ connectionString: DATABASE_URL! });
    await repo.init();
  });

  afterAll(async () => {
    await client.query(`DROP TABLE knowledge_chunks, knowledge_files, knowledge_sources, workspaces CASCADE`);
    await client.end();
    await repo.close();
  });

  beforeEach(async () => {
    await client.query(`DELETE FROM knowledge_files`);
  });

  it("upsert inserts a new row and returns id", async () => {
    const id = await repo.upsert({ source_id: sourceId, path: "a.md", content_hash: "h1", indexed_at: new Date() });
    expect(id).toBeTruthy();
  });

  it("upsert updates existing row by (source_id, path)", async () => {
    const id1 = await repo.upsert({ source_id: sourceId, path: "a.md", content_hash: "h1", indexed_at: new Date() });
    const id2 = await repo.upsert({ source_id: sourceId, path: "a.md", content_hash: "h2", indexed_at: new Date() });
    expect(id1).toBe(id2);
  });

  it("getByPath returns null when missing", async () => {
    const got = await repo.getByPath(sourceId, "missing.md");
    expect(got).toBeNull();
  });

  it("deleteByPath returns id if existed, null otherwise", async () => {
    const id = await repo.upsert({ source_id: sourceId, path: "a.md", content_hash: "h", indexed_at: new Date() });
    const removed = await repo.deleteByPath(sourceId, "a.md");
    expect(removed).toBe(id);
    const removedAgain = await repo.deleteByPath(sourceId, "a.md");
    expect(removedAgain).toBeNull();
  });
});
```

- [ ] **Step 2: Implement `src/knowledge-files-repo.ts`**

```ts
import { Client } from "pg";
import type { KnowledgeFilesRepo } from "@agent-mouth/knowledge-source";

export class SupabaseKnowledgeFilesRepo implements KnowledgeFilesRepo {
  private client: Client;

  constructor(opts: { connectionString: string }) {
    this.client = new Client({ connectionString: opts.connectionString });
  }

  async init(): Promise<void> {
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  async getByPath(sourceId: string, path: string) {
    const { rows } = await this.client.query(
      `SELECT id, content_hash FROM knowledge_files WHERE source_id=$1 AND path=$2 LIMIT 1`,
      [sourceId, path],
    );
    if (rows.length === 0) return null;
    return { id: rows[0].id, content_hash: rows[0].content_hash };
  }

  async upsert(row: { source_id: string; path: string; content_hash: string; indexed_at: Date | null }): Promise<string> {
    const { rows } = await this.client.query(
      `INSERT INTO knowledge_files (source_id, path, content_hash, indexed_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_id, path) DO UPDATE SET content_hash=EXCLUDED.content_hash, indexed_at=EXCLUDED.indexed_at
       RETURNING id`,
      [row.source_id, row.path, row.content_hash, row.indexed_at],
    );
    return rows[0].id;
  }

  async deleteByPath(sourceId: string, path: string): Promise<string | null> {
    const { rows } = await this.client.query(
      `DELETE FROM knowledge_files WHERE source_id=$1 AND path=$2 RETURNING id`,
      [sourceId, path],
    );
    if (rows.length === 0) return null;
    return rows[0].id;
  }
}
```

- [ ] **Step 3: Add `@agent-mouth/knowledge-source` dep to storage-supabase package.json** + re-export from `index.ts`:

```ts
export * from "./knowledge-files-repo.js";
```

- [ ] **Step 4: Test (live env) + commit**

```bash
pnpm install
PGVECTOR_TEST_URL=postgresql://... pnpm --filter @agent-mouth/storage-supabase test
git add packages/storage-supabase pnpm-lock.yaml
git commit -m "feat(storage-supabase): add SupabaseKnowledgeFilesRepo (live pg tests)"
```

---

## Sprint 3 — Agent loop integration (Tasks 14-18)

### Task 14: Extend `ClaudeRuntime` with tool-use loop

**Files:**
- Modify: `packages/agent-runtime/src/types.ts` (add tool types)
- Modify: `packages/agent-runtime/src/claude-runtime.ts` (loop)
- Test: `packages/agent-runtime/tests/claude-runtime-tools.test.ts`

- [ ] **Step 1: Extend `types.ts` with tool-aware request/response**

In `packages/agent-runtime/src/types.ts`, add (do NOT remove existing types):

```ts
export interface RuntimeToolDefinition {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface RuntimeToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface RuntimeToolResult {
  tool_use_id: string;
  output: unknown;
  isError?: boolean;
}

// Extend RespondRequest if needed:
//   tools?: RuntimeToolDefinition[];
//   tool_results?: RuntimeToolResult[];
// Extend RespondResponse:
//   tool_calls?: RuntimeToolCall[];
//   stop_reason?: "end_turn" | "tool_use" | "max_tokens";
```

Adjust the actual `RespondRequest` / `RespondResponse` interfaces to include these optional fields.

- [ ] **Step 2: Write failing claude-runtime tool-use test**

Create `packages/agent-runtime/tests/claude-runtime-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ClaudeRuntime } from "../src/claude-runtime.js";

describe("ClaudeRuntime tool-use", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns tool_calls + stop_reason='tool_use' when Claude requests a tool", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "search_web", input: { query: "x" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });

    const r = new ClaudeRuntime();
    await r.initialize({ apiKey: "sk-test", defaultModel: "claude-sonnet-4-6" });
    const res = await r.respond({
      systemPrompt: "you are a bot",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "search_web", description: "d", input_schema: { type: "object", properties: {} } }],
    });
    expect(res.stop_reason).toBe("tool_use");
    expect(res.tool_calls).toEqual([{ id: "tu_1", name: "search_web", input: { query: "x" } }]);
  });

  it("sends tool_results in next request as user message", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "msg_2",
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 5 },
      }),
    });

    const r = new ClaudeRuntime();
    await r.initialize({ apiKey: "sk-test", defaultModel: "claude-sonnet-4-6" });
    await r.respond({
      systemPrompt: "x",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "search_web", input: {} }] as any },
      ],
      tools: [],
      tool_results: [{ tool_use_id: "tu_1", output: { results: [] } }],
    });

    const callArgs = (globalThis.fetch as any).mock.calls[0][1];
    const body = JSON.parse(callArgs.body);
    const lastUser = body.messages[body.messages.length - 1];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content[0].type).toBe("tool_result");
    expect(lastUser.content[0].tool_use_id).toBe("tu_1");
  });
});
```

- [ ] **Step 3: Implement the loop changes in `claude-runtime.ts`**

In `packages/agent-runtime/src/claude-runtime.ts`, modify the `respond` method body to:

1. Accept `tools` and `tool_results` from the request.
2. Include `tools` in the Anthropic request body when present.
3. When `tool_results` are passed in, append them as a `{role:"user", content:[{type:"tool_result",...}]}` block before sending.
4. Parse Anthropic's response: if `stop_reason === "tool_use"`, populate `res.tool_calls`. Else extract text and populate `res.text`.

(Exact diff depends on current shape — engineer reads existing file and patches accordingly.)

- [ ] **Step 4: Run all agent-runtime tests**

```bash
pnpm --filter @agent-mouth/agent-runtime test
```

Expected: all pre-existing tests still PASS + new tool tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime
git commit -m "feat(agent-runtime): extend ClaudeRuntime with tool-use loop (tool_calls + tool_results)"
```

---

### Task 15: Extend `@agent-mouth/agent` facade with tool-use loop orchestration

**Files:**
- Modify: `packages/agent/src/agent.ts` (or wherever the facade lives)
- Test: `packages/agent/tests/tool-loop.test.ts`

- [ ] **Step 1: Read existing agent facade to understand current `respond` signature**

```bash
cat packages/agent/src/agent.ts
```

- [ ] **Step 2: Write failing test for multi-turn tool loop**

Create `packages/agent/tests/tool-loop.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { Tool, AgentRuntime } from "@agent-mouth/core";
import { runAgent } from "../src/agent.js";

// Two-turn scenario: agent calls one tool, then writes text answer
describe("runAgent tool loop", () => {
  it("executes tool then produces final text", async () => {
    let turn = 0;
    const runtime: AgentRuntime = {
      initialize: async () => {},
      respond: async () => {
        turn++;
        if (turn === 1) {
          return {
            text: null,
            stop_reason: "tool_use",
            tool_calls: [{ id: "tu_1", name: "fake", input: { q: "x" } }],
            usage: { input_tokens: 5, output_tokens: 5, cached_input_tokens: 0 },
            cost_usd: 0.001,
          } as any;
        }
        return {
          text: "I used the tool and the answer is 42.",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
          cost_usd: 0.001,
        } as any;
      },
    } as any;

    const fakeTool: Tool = {
      name: "fake",
      description: "",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true, output: { result: 42 }, costUsd: 0.0001, latencyMs: 10 }),
    };

    const result = await runAgent({
      runtime,
      tools: [fakeTool],
      maxToolCalls: 10,
      systemPrompt: "you are",
      messages: [{ role: "user", content: "?" }],
      ctx: {
        workspaceId: "w",
        contactId: "c",
        threadId: "t",
        policy: { allowed_tools: '["*"]', max_tool_calls: 10 } as any,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
    });

    expect(result.finalText).toBe("I used the tool and the answer is 42.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("fake");
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it("returns blocked when max_tool_calls reached without final text", async () => {
    const runtime: AgentRuntime = {
      initialize: async () => {},
      respond: async () => ({
        text: null,
        stop_reason: "tool_use",
        tool_calls: [{ id: "tu", name: "fake", input: {} }],
        usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
        cost_usd: 0.001,
      }) as any,
    } as any;
    const fakeTool: Tool = {
      name: "fake",
      description: "",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true, output: {}, costUsd: 0, latencyMs: 0 }),
    };

    const result = await runAgent({
      runtime,
      tools: [fakeTool],
      maxToolCalls: 2,
      systemPrompt: "x",
      messages: [{ role: "user", content: "?" }],
      ctx: {
        workspaceId: "w", contactId: "c", threadId: "t",
        policy: { allowed_tools: '["*"]', max_tool_calls: 2 } as any,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
    });
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe("max_tool_calls_exhausted");
  });

  it("returns tool_not_allowed if tool name not in allowedTools", async () => {
    let invocations = 0;
    const runtime: AgentRuntime = {
      initialize: async () => {},
      respond: async () => {
        invocations++;
        if (invocations === 1) {
          return {
            text: null,
            stop_reason: "tool_use",
            tool_calls: [{ id: "tu", name: "forbidden", input: {} }],
            usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
            cost_usd: 0,
          } as any;
        }
        return {
          text: "ok",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
          cost_usd: 0,
        } as any;
      },
    } as any;
    const ok: Tool = {
      name: "ok_tool",
      description: "",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true, output: {}, costUsd: 0, latencyMs: 0 }),
    };
    const result = await runAgent({
      runtime,
      tools: [ok],
      maxToolCalls: 10,
      systemPrompt: "x",
      messages: [{ role: "user", content: "?" }],
      ctx: {
        workspaceId: "w", contactId: "c", threadId: "t",
        policy: { allowed_tools: '["ok_tool"]', max_tool_calls: 10 } as any,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
    });
    expect(result.toolCalls[0].error).toContain("not_allowed");
  });
});
```

- [ ] **Step 2: Implement `runAgent` in `packages/agent/src/agent.ts`**

```ts
import type { Tool, ToolContext, AgentRuntime } from "@agent-mouth/core";

export interface ToolInvocationLog {
  id: string;
  name: string;
  input: unknown;
  ok: boolean;
  error?: string;
  costUsd: number;
  latencyMs: number;
}

export interface RunAgentArgs {
  runtime: AgentRuntime;
  tools: Tool[];
  maxToolCalls: number;
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  ctx: ToolContext;
}

export interface RunAgentResult {
  finalText: string | null;
  toolCalls: ToolInvocationLog[];
  totalCostUsd: number;
  blocked: boolean;
  blockReason?: string;
}

const TOOL_TIMEOUT_MS = 30000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const allowedNames = new Set(args.tools.map((t) => t.name));
  const toolDefs = args.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
  const messages = [...args.messages];
  const toolCalls: ToolInvocationLog[] = [];
  let totalCost = 0;
  let toolResultsForNext: Array<{ tool_use_id: string; output: unknown; isError?: boolean }> | undefined;

  for (let turn = 0; turn <= args.maxToolCalls; turn++) {
    const isLastTurn = turn === args.maxToolCalls;
    const resp = await args.runtime.respond({
      systemPrompt: args.systemPrompt,
      messages,
      tools: isLastTurn ? [] : toolDefs,
      tool_results: toolResultsForNext,
    } as any);
    totalCost += (resp as any).cost_usd ?? 0;
    toolResultsForNext = undefined;

    if ((resp as any).stop_reason !== "tool_use" || !(resp as any).tool_calls?.length) {
      return {
        finalText: (resp as any).text ?? null,
        toolCalls,
        totalCostUsd: totalCost,
        blocked: false,
      };
    }
    if (isLastTurn) {
      return {
        finalText: null,
        toolCalls,
        totalCostUsd: totalCost,
        blocked: true,
        blockReason: "max_tool_calls_exhausted",
      };
    }

    messages.push({ role: "assistant", content: (resp as any).tool_calls });
    const results: Array<{ tool_use_id: string; output: unknown; isError?: boolean }> = [];
    for (const call of (resp as any).tool_calls as Array<{ id: string; name: string; input: unknown }>) {
      const log: ToolInvocationLog = { id: call.id, name: call.name, input: call.input, ok: false, costUsd: 0, latencyMs: 0 };
      if (!allowedNames.has(call.name)) {
        log.error = "tool_not_allowed";
        results.push({ tool_use_id: call.id, output: { error: "tool_not_allowed" }, isError: true });
        toolCalls.push(log);
        continue;
      }
      const tool = args.tools.find((t) => t.name === call.name)!;
      try {
        const r = await withTimeout(tool.execute(call.input as any, args.ctx), TOOL_TIMEOUT_MS);
        log.ok = r.ok;
        log.error = r.error;
        log.costUsd = r.costUsd;
        log.latencyMs = r.latencyMs;
        totalCost += r.costUsd;
        results.push({
          tool_use_id: call.id,
          output: r.ok ? r.output : { error: r.error },
          isError: !r.ok,
        });
      } catch (err) {
        log.error = (err as Error).message;
        results.push({ tool_use_id: call.id, output: { error: log.error }, isError: true });
      }
      toolCalls.push(log);
    }
    toolResultsForNext = results;
  }

  // Should not reach here, but guard anyway
  return { finalText: null, toolCalls, totalCostUsd: totalCost, blocked: true, blockReason: "loop_exit_unexpected" };
}
```

- [ ] **Step 3: Tests + commit**

```bash
pnpm --filter @agent-mouth/agent test
git add packages/agent
git commit -m "feat(agent): add runAgent tool loop with allowed-tools enforcement + timeout"
```

---

### Task 16: Audit logging of tool calls

**Files:**
- Modify: existing audit log writer in `packages/api/src/worker.ts` or wherever `audit_log` rows are persisted today
- Test: `packages/api/tests/worker-audit.test.ts` (add cases)

- [ ] **Step 1: Find where `audit_log` rows are inserted today**

```bash
grep -rn "audit_log" packages/api/src/
```

- [ ] **Step 2: Add per-tool-call audit rows**

In the worker's `handleRespondJob`, after `runAgent` returns, iterate `result.toolCalls` and insert one `audit_log` row each:

```ts
for (const tc of result.toolCalls) {
  await auditLogStore.insert({
    workspace_id: data.workspaceId,
    action: "tool.call",
    actor: "agent",
    details: {
      tool_name: tc.name,
      input_summary: typeof tc.input === "object" ? JSON.stringify(tc.input).slice(0, 200) : String(tc.input),
      success: tc.ok,
      error: tc.error,
      cost_usd: tc.costUsd,
      latency_ms: tc.latencyMs,
    },
    related_message_id: data.messageId,
    cost_usd: tc.costUsd,
    latency_ms: tc.latencyMs,
  });
}
```

The existing `audit_log` final row for `agent.respond` should sum `tc.costUsd` into the total.

- [ ] **Step 3: Add a worker test that asserts N+1 audit rows when N tools used**

Add to existing worker tests (or create new file) — assert `auditLogStore.insert` called N+1 times when the runtime makes N tool calls.

- [ ] **Step 4: Test + commit**

```bash
pnpm --filter @agent-mouth/api test
git add packages/api
git commit -m "feat(api): persist one audit_log row per tool call + sum cost in final row"
```

---

### Task 17: Wire bootstrap in `apps/api/src/index.ts`

**Files:**
- Modify: `packages/api/src/index.ts` (boot wiring)
- Modify: `packages/api/src/config.ts` (env vars)
- Test: smoke run locally with `pnpm --filter @agent-mouth/api dev`

- [ ] **Step 1: Add env vars in `config.ts`**

```ts
export interface Phase3Config {
  enableKnowledgeSync: boolean;
  enableAgentTools: boolean;
  knowledgeSyncIntervalMin: number;
  tavilyApiKey: string | undefined;
  openaiApiKey: string | undefined;
  knowledgeGitDeployKey: string | undefined;
  databaseUrl: string | undefined;
}

export function loadPhase3Config(env: Record<string, string | undefined>): Phase3Config {
  return {
    enableKnowledgeSync: env.ENABLE_KNOWLEDGE_SYNC === "true",
    enableAgentTools: env.ENABLE_AGENT_TOOLS === "true",
    knowledgeSyncIntervalMin: Number(env.KNOWLEDGE_SYNC_INTERVAL_MIN ?? "15"),
    tavilyApiKey: env.TAVILY_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    knowledgeGitDeployKey: env.KNOWLEDGE_GIT_DEPLOY_KEY,
    databaseUrl: env.DATABASE_URL,
  };
}
```

- [ ] **Step 2: Wire in `packages/api/src/index.ts`**

After `startWorker(...)`, add:

```ts
import { resolveEmbeddingProvider, registerEmbeddingProvider } from "@agent-mouth/embeddings";
import { resolveWebSearchProvider } from "@agent-mouth/web-search";
import { resolveVectorStore, PgvectorStore } from "@agent-mouth/vector-store";
import { resolveKnowledgeSource, MarkdownChunker } from "@agent-mouth/knowledge-source";
import { bootstrapTools } from "@agent-mouth/agent-tools";
import { SupabaseKnowledgeFilesRepo } from "@agent-mouth/storage-supabase";
import "@agent-mouth/embeddings";   // side-effect: register openai
import "@agent-mouth/web-search";   // side-effect: register tavily
import "@agent-mouth/vector-store"; // side-effect: register pgvector
import "@agent-mouth/knowledge-source"; // side-effect: register git

const phase3 = loadPhase3Config(process.env);

if (phase3.enableAgentTools) {
  try {
    const embedder = await resolveEmbeddingProvider("openai", process.env);
    const webSearch = await resolveWebSearchProvider("tavily", process.env);
    const vectorStore = await resolveVectorStore({ type: "pgvector", env: process.env });
    // Knowledge source config comes from DB row inserted by seed
    const sourceRow = await db.query(`SELECT id, type, config FROM knowledge_sources LIMIT 1`);
    const knowledgeSource = sourceRow.rows[0]
      ? await resolveKnowledgeSource({ type: sourceRow.rows[0].type, config: sourceRow.rows[0].config, env: process.env })
      : null;
    if (knowledgeSource) {
      bootstrapTools({ webSearchProvider: webSearch, vectorStore, embedder, knowledgeSource });
      logger.info({ tools: ["search_web", "search_knowledge", "read_knowledge_file"] }, "agent tools registered");
    }
  } catch (err) {
    logger.error({ err }, "failed to bootstrap agent tools — falling back to Phase 2 (no tools)");
  }
}
```

- [ ] **Step 3: Run apps/api locally and smoke check**

```bash
pnpm --filter @agent-mouth/api dev
```

Hit `GET /health` — should respond 200. Log line "agent tools registered" should appear when `ENABLE_AGENT_TOOLS=true` and required secrets set.

- [ ] **Step 4: Commit**

```bash
git add packages/api
git commit -m "feat(api): wire Phase 3 bootstrap (embeddings + tavily + pgvector + knowledge source + tools)"
```

---

### Task 18: Register `knowledge.sync` recurring job

**Files:**
- Modify: `packages/api/src/worker.ts` (add job handler + schedule)
- Modify: `packages/queue-pgboss/src/pgboss-queue.ts` (add `scheduleRecurring` method if missing)

- [ ] **Step 1: Add `scheduleRecurring` method to `Queue` interface in `@agent-mouth/core`**

In `packages/core/src/index.ts` (or where Queue interface lives), add:

```ts
scheduleRecurring(name: string, cron: string, data: object, options?: { singletonKey?: string }): Promise<void>;
```

And in `packages/queue-pgboss/src/pgboss-queue.ts`:

```ts
async scheduleRecurring(name: string, cron: string, data: object): Promise<void> {
  await this.boss.createQueue(name);
  await this.boss.schedule(name, cron, data);
}
```

- [ ] **Step 2: Add `knowledge.sync` handler in `worker.ts`**

```ts
queue.work("knowledge.sync", async (_jobs) => {
  if (!phase3.enableKnowledgeSync) return;
  const sources = await db.query(`SELECT id, type, config FROM knowledge_sources`);
  for (const row of sources.rows) {
    try {
      const source = await resolveKnowledgeSource({ type: row.type, config: row.config, env: process.env });
      const embedder = await resolveEmbeddingProvider("openai", process.env);
      const vectorStore = await resolveVectorStore({ type: "pgvector", env: process.env });
      const filesRepo = new SupabaseKnowledgeFilesRepo({ connectionString: process.env.DATABASE_URL! });
      await filesRepo.init();
      const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
      const result = await indexSource({
        sourceId: row.id,
        source,
        embedder,
        vectorStore,
        chunker,
        filesRepo,
      });
      await db.query(
        `UPDATE knowledge_sources SET last_synced_at=NOW(), last_sync_status=$1 WHERE id=$2`,
        ["ok", row.id],
      );
      logger.info({ sourceId: row.id, result }, "knowledge.sync done");
      await filesRepo.close();
    } catch (err) {
      await db.query(
        `UPDATE knowledge_sources SET last_sync_status=$1 WHERE id=$2`,
        [`error: ${(err as Error).message}`, row.id],
      );
      logger.error({ err, sourceId: row.id }, "knowledge.sync failed");
    }
  }
});

if (phase3.enableKnowledgeSync) {
  // pg-boss cron syntax: "*/15 * * * *" → every 15 min
  await queue.scheduleRecurring(
    "knowledge.sync",
    `*/${phase3.knowledgeSyncIntervalMin} * * * *`,
    {},
  );
  // Also trigger one immediate run so first boot doesn't wait 15min
  await queue.send("knowledge.sync", {}, { singletonKey: `knowledge-sync-${Date.now()}` });
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/api packages/queue-pgboss packages/core
git commit -m "feat(api): register knowledge.sync cron job (default 15 min) + immediate kick on boot"
```

---

## Sprint 4 — Rollout (Tasks 19-23)

### Task 19: CLI to seed `knowledge_sources` row

**Files:**
- Create: `apps/cli/src/seed-knowledge.ts`
- Modify: `apps/cli/src/index.ts` (add new command)

- [ ] **Step 1: Implement `apps/cli/src/seed-knowledge.ts`**

```ts
import { Client } from "pg";

export async function seedGitKnowledgeSource(args: {
  databaseUrl: string;
  workspaceId: string;
  repoUrl: string;
  branch: string;
  localPath: string;
  excludeGlobs?: string[];
}): Promise<string> {
  const client = new Client({ connectionString: args.databaseUrl });
  await client.connect();
  try {
    const config = {
      repo_url: args.repoUrl,
      branch: args.branch,
      local_path: args.localPath,
      deploy_key_env_var: "KNOWLEDGE_GIT_DEPLOY_KEY",
      sync_interval_minutes: 15,
      include_globs: ["**/*.md"],
      exclude_globs: args.excludeGlobs ?? [".git/**", "*.backup-*", "node_modules/**", "01-Perfil/credenciales*"],
    };
    const { rows } = await client.query(
      `INSERT INTO knowledge_sources (workspace_id, type, config) VALUES ($1, 'git', $2::jsonb) RETURNING id`,
      [args.workspaceId, JSON.stringify(config)],
    );
    return rows[0].id;
  } finally {
    await client.end();
  }
}
```

- [ ] **Step 2: Add CLI command (mirror existing CLI command shape) in `apps/cli/src/index.ts`**

```ts
case "seed-knowledge": {
  const id = await seedGitKnowledgeSource({
    databaseUrl: process.env.DATABASE_URL!,
    workspaceId: process.env.WORKSPACE_ID!,
    repoUrl: "git@github.com:gavrilux/CerebroDigital.git",
    branch: "main",
    localPath: "/data/knowledge/cerebro",
  });
  console.log(`Seeded knowledge source: ${id}`);
  break;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli
git commit -m "feat(cli): add seed-knowledge command to insert knowledge_sources row"
```

---

### Task 20: Fly.io infra — volume, secrets, deploy

**Files:**
- Modify: `fly.toml` (mount, env vars)
- Create: `docs/runbooks/2026-05-23-phase-3-rollout.md`

- [ ] **Step 1: Edit `fly.toml`**

Add under existing config:

```toml
[mounts]
  source = "agent_mouth_knowledge"
  destination = "/data/knowledge"

[env]
  ENABLE_KNOWLEDGE_SYNC = "true"
  ENABLE_AGENT_TOOLS = "false"          # flipped to true in Step 2 of rollout
  KNOWLEDGE_SYNC_INTERVAL_MIN = "15"
  DEFAULT_AGENT_MODEL = "claude-sonnet-4-6"
  NOTES_UPDATER_MODEL = "claude-haiku-4-5-20251001"
  ENABLE_NOTES_UPDATER = "true"
```

- [ ] **Step 2: Create the volume**

```bash
flyctl volumes create agent_mouth_knowledge --region cdg --size 10 --app agent-mouth
```

- [ ] **Step 3: Set secrets**

```bash
flyctl secrets set --app agent-mouth \
  TAVILY_API_KEY="<value>" \
  OPENAI_API_KEY="<value>" \
  KNOWLEDGE_GIT_DEPLOY_KEY="$(cat ~/.ssh/cerebro_digital_deploy_key)"
```

(Generate the deploy key first: `ssh-keygen -t ed25519 -f ~/.ssh/cerebro_digital_deploy_key -N ""` then add the `.pub` to the CerebroDigital repo's Deploy Keys settings on GitHub.)

- [ ] **Step 4: Apply the migration to production Supabase**

Run `packages/storage-supabase/sql/0004_apply_phase3_schema.sql` via Supabase SQL Editor (gavrimarkovic4@gmail.com account, project `deicbuvcynqontfbnboe`).

- [ ] **Step 5: Run the seed command**

```bash
flyctl ssh console --app agent-mouth -C "node /app/apps/cli/dist/index.js seed-knowledge"
```

- [ ] **Step 6: Document rollout in runbook**

Write `docs/runbooks/2026-05-23-phase-3-rollout.md` covering: secret setup, volume creation, migration steps, seed command, env-var flip sequence (Step 1→2→3→4 from spec §7.2), rollback notes (set `ENABLE_AGENT_TOOLS=false`, `ENABLE_KNOWLEDGE_SYNC=false`).

- [ ] **Step 7: Commit + push**

```bash
git add fly.toml docs/runbooks/2026-05-23-phase-3-rollout.md
git commit -m "chore(fly): mount knowledge volume + env vars; add Phase 3 rollout runbook"
git push origin feat/phase-3-tools-knowledge
```

---

### Task 21: Step 1 — Deploy with tools OFF, verify knowledge sync

**Files:** none (operational)

- [ ] **Step 1: Deploy**

```bash
flyctl deploy --app agent-mouth
```

- [ ] **Step 2: Verify worker boot logs**

```bash
flyctl logs --app agent-mouth | head -50
```

Expected lines:
- `knowledge.sync done` within ~2 min of boot
- No `failed to bootstrap agent tools` errors (tools are OFF anyway)

- [ ] **Step 3: Verify DB state**

In Supabase SQL Editor:

```sql
SELECT count(*) FROM knowledge_sources;             -- should be 1
SELECT count(*) FROM knowledge_files;               -- should be > 100 (CerebroDigital md count)
SELECT count(*) FROM knowledge_chunks;              -- should be > 1000
SELECT count(*) FROM knowledge_files WHERE indexed_at IS NULL;  -- should be 0
SELECT last_synced_at, last_sync_status FROM knowledge_sources; -- ok
```

- [ ] **Step 4: Sanity check from Telegram**

Send the bot a private message: *"hola"*. Expect Phase 2 behavior (responds without tools). Audit log should NOT contain `tool.call` rows for this message.

---

### Task 22: Step 2-3 — Flip tools on, validate E2E gates

**Files:** none (operational)

- [ ] **Step 1: Flip `ENABLE_AGENT_TOOLS=true`**

```bash
flyctl secrets set --app agent-mouth ENABLE_AGENT_TOOLS=true
```

(This redeploys the app.)

- [ ] **Step 2: Temporarily set policy to `suggest`**

In Supabase SQL Editor:

```sql
UPDATE policies SET policy = 'suggest'
WHERE contact_id = '<gavrilo_contact_id>';
```

- [ ] **Step 3: Send Telegram message: "¿qué pendientes tengo esta semana?"**

Expected: row appears in `drafts` table with `proposed_body` summarizing the Dashboard. Audit log should contain a `tool.call` row with `tool_name='search_knowledge'`.

```sql
SELECT proposed_body FROM drafts ORDER BY created_at DESC LIMIT 1;
SELECT details FROM audit_log WHERE action='tool.call' ORDER BY created_at DESC LIMIT 5;
```

- [ ] **Step 4: Restore policy to `auto`**

```sql
UPDATE policies SET policy = 'auto'
WHERE contact_id = '<gavrilo_contact_id>';
```

- [ ] **Step 5: Run the 3 E2E gates from spec §7.4**

a. Send: *"¿qué próximo paso tiene fiscalflow?"* → bot replies with the actual content from `02-Proyectos/fiscalflow.md` and cites the file path.

b. Send: *"¿cuál es la versión estable más reciente de Node.js?"* → bot uses Tavily, returns correct number, cites URL.

c. Send: *"resume mis 3 proyectos más activos y busca si hay novedades de Vercel hoy"* → bot uses both tools in the same turn, synthesizes, cites both sources.

Mark each gate result in `docs/runbooks/2026-05-23-phase-3-rollout.md`.

---

### Task 23: Step 4 — 48h monitoring + merge to main

**Files:** none initially; updates to runbook + project docs after merge

- [ ] **Step 1: Set a calendar reminder for 48h later**

Use `ScheduleWakeup` or external calendar — check audit_log totals at +24h and +48h post-flip.

- [ ] **Step 2: Run monitoring queries each check-in**

```sql
SELECT
  date(created_at) AS day,
  count(*) FILTER (WHERE action='tool.call') AS tool_calls,
  sum(cost_usd) AS total_cost,
  avg(latency_ms) AS avg_latency,
  max(latency_ms) AS max_latency
FROM audit_log
WHERE created_at > now() - interval '48 hours'
GROUP BY 1;
```

If `total_cost > 0.50` on any day → review query patterns. If `max_latency > 30000` → investigate timeouts.

- [ ] **Step 3: If both gates pass and monitoring is healthy, merge to main**

```bash
git checkout main
git pull
git merge --no-ff feat/phase-3-tools-knowledge -m "Merge branch 'feat/phase-3-tools-knowledge' — Phase 3 LIVE in production"
git push origin main
```

- [ ] **Step 4: Update Cerebro Digital project file + Dashboard**

In `~/CerebroDigital/02-Proyectos/agent-mouth.md`, update the status section to `**Phase 3 LIVE**` and list the 3 tools. In `~/CerebroDigital/00-Dashboard.md`, update the agent-mouth row.

---

## Self-review

**Spec coverage check:**

| Spec section | Task(s) implementing it |
|---|---|
| §1 Decisions | All tasks adhere |
| §2.1 New packages | Tasks 3, 4, 5, 7, 8 |
| §2.2 Modified packages | Tasks 8, 14, 15, 16, 17, 18 |
| §2.3 New tables | Task 1 |
| §2.4 Fly changes | Task 20 |
| §3.1 Ingestion flow | Task 12 (`indexSource`) + Task 18 (`knowledge.sync` handler) |
| §3.2 GitKnowledgeSource | Task 6 |
| §3.3 MarkdownChunker | Task 5 |
| §3.4 EmbeddingProvider + OpenAI adapter | Task 3 |
| §3.5 Diff strategy (content_hash) | Task 6 (GitKnowledgeSource) + Task 13 (repo upsert) |
| §4.1 Tool interface | Task 2 |
| §4.2 ToolRegistry | Task 8 |
| §4.3 The 3 tools | Tasks 9, 10, 11 |
| §5.1 Agent loop sequence | Task 15 (`runAgent`) |
| §5.2 Caps + fallbacks | Task 15 (max_tool_calls, timeout) |
| §5.3 Cost tracking | Task 16 (audit_log) |
| §5.4 Citations (system prompt) | Implicit — system prompt comes from policy; no separate task. Document in Task 20 runbook. |
| §6.1 allowed_tools column | Tasks 1, 8 |
| §6.2 Defense in depth | Task 15 |
| §6.3 Reuse existing guardrails | Phase 2 code unchanged; works as-is |
| §6.4 requiresExplicitGrant flag | Tasks 2, 8 |
| §7.1 Migration | Task 1 |
| §7.2 4-step rollout | Tasks 21, 22, 23 |
| §7.3 Defensive degradation | Task 17 (try/catch bootstrap), Task 18 (try/catch in sync handler), Task 9-11 (each tool catches) |
| §7.4 E2E gate | Task 22 |
| §7.5 Effort estimate | This plan structures the 4 sprints |

**Placeholder scan**: no "TBD", "TODO", "implement later", "Add appropriate error handling", or "Similar to Task N" found.

**Type consistency check**: `KnowledgeSource`, `VectorStore`, `WebSearchProvider`, `EmbeddingProvider`, `Tool` are defined once in `@agent-mouth/core` (Task 2) and re-imported consistently across Tasks 3-15. `Policy.allowed_tools` is added once (Tasks 1 + 8) and read consistently in Task 15 (`runAgent`) and Task 8 (`resolveToolsForPolicy`).

One known soft spot: the `runAgent` interface in Task 15 references `(resp as any)` because the exact `RespondResponse` shape from Phase 2 isn't pinned in this plan — the engineer must read `packages/agent-runtime/src/types.ts` to confirm the new optional fields (`tool_calls`, `stop_reason`, etc.) added in Task 14. This is intentional: Task 14 owns the source of truth, Task 15 consumes it.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-05-23-agent-mouth-phase-3-tools-knowledge.md` (this file).

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec + code quality), fast iteration. Best for plans this size (23 tasks). Same session, no handoff.

**2. Inline Execution** — execute tasks here in the current session with batch checkpoints. Slower because each task lives in the main context.

**Which approach?**
