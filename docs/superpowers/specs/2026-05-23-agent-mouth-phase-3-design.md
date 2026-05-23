# Agent Mouth — Phase 3 Design (Tools + Knowledge)

**Status:** Draft for review
**Date:** 2026-05-23
**Author:** Brainstorm session (Gavrilo + Claude)
**Depends on:** Phase 2 LIVE (ClaudeRuntime + auto-reply + notes updater)
**Related docs:**
- `2026-05-20-agent-mouth-vision-design.md` (vision, defines Phase 3 §6)
- `2026-05-22-agent-mouth-phase-2-design.md` (Phase 2 design, predecessor)

---

## §0. Goal

Give the agent **autonomy through tools**. After Phase 3, the bot can:

1. **Search the public web** (current news, prices, weather, anything past the LLM's training cutoff).
2. **Search the user's personal knowledge base** (Cerebro Digital — projects, decisions, sessions, profile) via semantic vector search.
3. **Read a full file** from the knowledge base for deep context.

All this stays **pluggable** so adding the next tool / knowledge source / vector store / search provider is one file + one line in a registry — same pattern as `RuntimeRegistry` from Phase 2.

**E2E gate**: "¿qué próximo paso tiene fiscalflow?" → bot reads `02-Proyectos/fiscalflow.md` and cites it. "¿cuál es la versión estable de Node.js?" → bot uses Tavily and cites the URL. Combined queries work in one turn.

---

## §1. Design decisions (locked in brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Scope of tools | Pluggable infra + 3 read-only tools MVP | Maximum optionality, zero risk for v1 |
| Knowledge access | `KnowledgeSource` interface + `GitKnowledgeSource` adapter | Agnostic; future users plug Notion/Obsidian/FS as separate adapters |
| Vector store | `VectorStore` interface + `PgvectorStore` adapter on Supabase | Consistent pluggable pattern; reuses existing infra; cheap |
| Web search | `WebSearchProvider` interface + `TavilyProvider` adapter | LLM-optimized results, generous free tier (1000q/mo), single key |
| Embeddings | `EmbeddingProvider` interface + `OpenAIEmbeddingProvider` (text-embedding-3-small) | $0.02/M tokens, 1536 dim, industry standard, swappable |
| 3 MVP tools | `search_web`, `search_knowledge`, `read_knowledge_file` | All read-only; cover web + personal context + deep dive |
| Tool authorization | Default open (`allowed_tools='["*"]'`) for read-only; `requiresExplicitGrant: true` flag for future destructive tools | Autonomy now, safety net later |

---

## §2. Architecture

### 2.1 New packages

```
packages/
├── knowledge-source/          NEW. KnowledgeSource interface + GitKnowledgeSource adapter
├── vector-store/              NEW. VectorStore interface + PgvectorStore adapter
├── web-search/                NEW. WebSearchProvider interface + TavilyProvider adapter
├── agent-tools/               NEW. Tool interface, ToolRegistry, 3 concrete tools
└── (existing unchanged)
```

### 2.2 Modified packages

- **`@agent-mouth/core`** — new interfaces (`KnowledgeSource`, `VectorStore`, `WebSearchProvider`, `EmbeddingProvider`, `Tool`, `ToolRegistry`) and shared types.
- **`@agent-mouth/agent-runtime`** — `ClaudeRuntime` gains the `tool_use → tool_result → ...` loop with `policy.max_tool_calls` cap.
- **`@agent-mouth/agent-guardrails`** — applies per-policy `allowed_tools` whitelist, `forbidden_topics_regex` to tool inputs, `escalate_triggers_regex` to tool outputs.
- **`@agent-mouth/agent`** — facade builds `ToolRegistry` and passes resolved tools to runtime.
- **`@agent-mouth/api`** — boot wiring: register knowledge source, vector store, web search, tools. New `knowledge.sync` job on a 15-min cron.

### 2.3 New tables (`0002_phase_3.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_sources (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL,             -- 'git', 'notion', 'filesystem', etc.
  config JSONB NOT NULL,          -- adapter-specific config
  last_synced_at TIMESTAMPTZ,
  last_sync_status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE knowledge_files (
  id UUID PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,     -- SHA256 → skip re-embed when unchanged
  last_modified TIMESTAMPTZ,
  indexed_at TIMESTAMPTZ,
  UNIQUE (source_id, path)
);

CREATE TABLE knowledge_chunks (
  id UUID PRIMARY KEY,
  file_id UUID NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding vector(1536),
  token_count INTEGER,
  metadata JSONB,                 -- { heading_path, line_start, line_end, frontmatter }
  UNIQUE (file_id, chunk_index)
);
CREATE INDEX idx_knowledge_chunks_embedding
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

ALTER TABLE policies ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '["*"]';
```

### 2.4 Fly.io changes

- **New volume** (`agent_mouth_knowledge`, 10 GB) mounted at `/data/knowledge`.
- **New secrets**: `TAVILY_API_KEY`, `OPENAI_API_KEY` (embeddings), `KNOWLEDGE_GIT_DEPLOY_KEY` (SSH deploy key for `gavrilux/CerebroDigital`).
- **New env vars**: `ENABLE_KNOWLEDGE_SYNC=true`, `ENABLE_AGENT_TOOLS=true`, `KNOWLEDGE_SYNC_INTERVAL_MIN=15`.
- **Cron**: worker registers a recurring `knowledge.sync` job in pg-boss every 15 min.

---

## §3. Knowledge ingestion

### 3.1 Flow

```
[Cron 15 min] → knowledge.sync job
              ↓
       GitKnowledgeSource.sync()
              ├─ git clone if /data/knowledge/<source>/ missing
              └─ git fetch + git reset --hard origin/<branch>
              ↓
       Diff by SHA256 → set of {added, modified, deleted} files
              ↓
       For each added/modified file:
              ├─ chunker.split(content) → markdown-aware chunks (~400 tok, 50 overlap)
              ├─ embedder.embed(chunks) → batch up to 100 vectors
              └─ vectorStore.upsert(file_id, chunks)
              ↓
       For each deleted file:
              └─ vectorStore.deleteByFileId(file_id)   (CASCADE handles in SQL)
              ↓
       UPDATE knowledge_sources SET last_synced_at, last_sync_status='ok'
```

### 3.2 `GitKnowledgeSource`

**Config schema** (stored as JSONB in `knowledge_sources.config`):

```ts
interface GitKnowledgeSourceConfig {
  repo_url: string;                 // git@github.com:org/repo.git
  branch: string;                   // 'main'
  deploy_key_env_var: string;       // 'KNOWLEDGE_GIT_DEPLOY_KEY' — read from process.env
  local_path: string;               // '/data/knowledge/cerebro'
  sync_interval_minutes: number;    // 15
  include_globs?: string[];         // default ['**/*.md']
  exclude_globs?: string[];         // default ['.git/**', '*.backup-*', 'node_modules/**']
}
```

**Sync semantics**:
- First sync: `git clone --depth 1 --branch <branch> <repo>` to `local_path`.
- Subsequent: `git fetch origin <branch> && git reset --hard origin/<branch>`.
- `listFiles()` walks `local_path` post-pull, applies include/exclude globs.
- `readFile(path)` reads disk directly.
- `getChangedSince(timestamp)` not used in MVP (diff is hash-based, not git-log-based).

### 3.3 `MarkdownChunker` (default chunker)

- Split by H2/H3 headings. If a section exceeds 500 tokens, sub-split by paragraphs.
- Each chunk gets a **breadcrumb prefix** like `# Doc Title > ## Section > ### Subsection\n\n<chunk text>` so the embedding captures hierarchy context.
- Chunk metadata: `{ heading_path, line_start, line_end, frontmatter }`. YAML frontmatter (`tipo`, `actualizado`, etc.) is duplicated into every chunk's metadata for filterable retrieval.
- Target chunk size: 400 tokens. Overlap: 50 tokens.

### 3.4 `EmbeddingProvider`

```ts
interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;   // batched
  embedQuery(text: string): Promise<number[]>;   // single, for query-time
}
```

**MVP adapter**: `OpenAIEmbeddingProvider` (`text-embedding-3-small`, 1536 dim, $0.02/M tok, max 100 inputs per request).

**Cost estimate**: 45 MB Cerebro Digital → ~150k tokens → ~$0.003 for full re-index. Incremental sync after first run: pennies/month.

### 3.5 Diff strategy

- Compare `knowledge_files.content_hash` (SHA256 of full file content) before re-embedding.
- If hash unchanged → skip (saves embedding cost on no-op pulls).
- If file no longer exists in source → delete from `knowledge_files` (cascade to chunks).

---

## §4. Tools

### 4.1 `Tool` interface

```ts
export interface ToolContext {
  workspaceId: string;
  contactId: string;
  threadId: string;
  policy: Policy;
  logger: Logger;
  abortSignal?: AbortSignal;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;                       // unique, snake_case
  readonly description: string;                // shown verbatim to the LLM
  readonly inputSchema: JsonSchema;            // Anthropic tool_use compatible
  readonly requiresExplicitGrant?: boolean;    // default false (read-only)
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}
```

### 4.2 `ToolRegistry`

```ts
export function registerTool(tool: Tool): void;
export function listTools(): Tool[];
export function getTool(name: string): Tool | undefined;
export function resolveToolsForPolicy(policy: Policy): Tool[];
export function _resetToolRegistry(): void;    // test-only
```

**Bootstrap** (`packages/agent-tools/src/index.ts`):

```ts
registerTool(new SearchWebTool({ provider: tavilyProvider }));
registerTool(new SearchKnowledgeTool({ vectorStore, embedder }));
registerTool(new ReadKnowledgeFileTool({ knowledgeSource }));
```

**Resolution logic**:

```ts
function resolveToolsForPolicy(policy: Policy): Tool[] {
  const allowed: string[] = JSON.parse(policy.allowed_tools);
  const all = listTools();
  if (allowed.length === 0) return [];
  if (allowed.includes("*")) {
    return all.filter(t => !t.requiresExplicitGrant);   // wildcard = read-only only
  }
  return all.filter(t => allowed.includes(t.name));
}
```

### 4.3 The 3 MVP tools

#### `search_web`

```ts
{
  name: "search_web",
  description: "Search the public web for current information. Use when the user asks about news, prices, weather, recent events, or anything that may have changed since your training cutoff. Returns curated results with citations.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query in natural language" },
      max_results: { type: "integer", default: 5, maximum: 10 }
    },
    required: ["query"]
  }
}
```

**Output**:

```ts
{
  results: Array<{ title: string; url: string; snippet: string; published_at?: string }>;
  answer?: string;   // Tavily's curated summary when available
}
```

Internally: `webSearchProvider.search(query, { maxResults })`.

#### `search_knowledge`

```ts
{
  name: "search_knowledge",
  description: "Search the user's personal knowledge base (Cerebro Digital — projects, decisions, sessions, profile). Use when the user references their work, asks about past decisions, project status, or anything personal. Returns relevant chunks with file paths so you can call read_knowledge_file for full context.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "integer", default: 5, maximum: 15 },
      filter: {
        type: "object",
        properties: {
          path_prefix: { type: "string", description: "e.g. '02-Proyectos/'" },
          frontmatter_tipo: { type: "string", description: "e.g. 'proyecto'" }
        }
      }
    },
    required: ["query"]
  }
}
```

**Output**:

```ts
{
  chunks: Array<{
    file_path: string;
    heading_path: string;
    text: string;
    score: number;
    file_last_modified: string;
  }>;
}
```

Internally: `embedder.embedQuery(query)` → `vectorStore.search(vec, { topK, filter, workspaceId })`. Workspace filtering enforced server-side.

#### `read_knowledge_file`

```ts
{
  name: "read_knowledge_file",
  description: "Read the full content of a file from the knowledge base. Use after search_knowledge if a chunk looks relevant and you need more context, or when you already know the exact path.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path returned by search_knowledge, e.g. '02-Proyectos/agent-mouth.md'" }
    },
    required: ["path"]
  }
}
```

**Output**:

```ts
{
  path: string;
  content: string;
  last_modified: string;
  token_count: number;
  truncated?: boolean;     // true if file > 50k tokens
}
```

Internally: `knowledgeSource.readFile(path)`. Files >50k tokens are truncated with `truncated: true`.

---

## §5. Agent loop

### 5.1 Sequence

```
1. Worker receives job agent.respond { messageId, content, ... }
2. Agent.respond() builds context:
   - workingMemory  (last N messages in thread)
   - episodicMemory (notes-updater output)
   - systemPrompt   (policy.system_prompt + auto-generated tools manifest)
3. Loop until stop_reason ≠ "tool_use" OR toolCallCount >= policy.max_tool_calls:
   a. runtime.generate({ messages, tools: resolveToolsForPolicy(policy) })
   b. For each tool_use block in response:
      - tool = getTool(name); if missing → tool_result { error: "unknown_tool" }
      - if not in allowedTools → tool_result { error: "tool_not_allowed" }
      - if forbidden_topics_regex matches input → tool_result { error: "forbidden_topic" }
      - check estimated cost vs daily_budget_usd_cap → may short-circuit
      - await tool.execute(input, ctx) with 30s timeout
      - on success: tool_result { content: <output> }
      - on error/timeout: tool_result { error: "<reason>" }
      - audit_log row: action="tool.call", details={ name, input, summary, latency, success }
   c. messages.push({ role:"user", content: tool_result blocks })
4. Final text response = last "text" content block
5. If escalate_triggers_regex matches final text → persist as draft, do NOT send, audit decision="escalated"
6. Else: transport.send(externalChatId, finalText)
7. Persist messages.outbound + audit_log final row with total cost
```

### 5.2 Caps and fallbacks

- `policy.max_tool_calls = 10` (already exists). If reached, the last turn is sent with `tools: []` to force a text response.
- If the agent still emits only tool_use after the cap → fallback message: `"No he podido completar la consulta. ¿Puedes reformular?"` + audit `decision="blocked"`, `block_reason="max_tool_calls_exhausted"`.
- Per-tool timeout: 30s. Timeout returns `{ error: "timeout" }` to the agent, which decides whether to retry or proceed.

### 5.3 Cost tracking

Each job now produces **N+1 audit rows**:
- 1 row per tool call (`action="tool.call"`)
- 1 final row (`action="agent.respond"`)

```ts
cost_usd = runtimeCost           // LLM tokens (Sonnet/Gemini)
         + embeddingCost          // search_knowledge queries
         + tavilyCost             // search_web (free up to 1000/mo, $0.001/q after)
```

Compared against `daily_budget_usd_cap` before every tool call. If next call would exceed cap, return `{ error: "budget_exceeded" }` and let the agent close with whatever info it already has.

### 5.4 Citations (system prompt instruction)

> Cuando uses `search_web`, cita la URL al final entre paréntesis.
> Cuando uses `search_knowledge` o `read_knowledge_file`, menciona el archivo (p.ej. `(según 02-Proyectos/agent-mouth.md)`).
> Si el usuario pregunta "¿de dónde sacas eso?", siempre responde con la fuente.

### 5.5 Out of scope for MVP

- Streaming tool_use mid-generation (no Telegram UI benefit; defer to Phase 5 if dashboard UI lands).
- Per-tool rate limits (`tool_rate_limits`). Global cap is enough today.
- Custom tool argument validation beyond JSON schema.

---

## §6. Guardrails extension

### 6.1 `allowed_tools` per policy

```sql
ALTER TABLE policies ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '["*"]';
```

Semantics:
- `'[]'` → no tools (Phase 2 backward-compatible behavior)
- `'["*"]'` → all read-only tools (wildcard, MVP default; destructive tools require explicit listing)
- `'["search_web","search_knowledge"]'` → only the listed tools (whether read-only or destructive)

### 6.2 Defense in depth

The agent loop **revalidates** before every `tool.execute()` even though the LLM only sees the resolved subset:

```ts
if (!allowedTools.has(toolCall.name)) {
  return { type: "tool_result", tool_use_id, content: { error: "tool_not_allowed" } };
}
```

### 6.3 Reuse of existing guardrails (Phase 2)

- **`forbidden_topics_regex`**: now also applied to `query`/`input` of `search_web` and `search_knowledge`. Match → tool_result `{ error: "forbidden_topic" }` before execution.
- **`escalate_triggers_regex`**: applied to the **final agent text** (after tool loop). Match → persist as draft, do not send, audit `decision="escalated"`.
- **`rate_limit_per_hour`**: counts whole jobs (1 reply = 1 hit), not tool calls.

### 6.4 Future-proofing destructive tools

When a tool with side-effects is added (e.g. `send_email`, `delete_knowledge_file`, `pay_invoice`):
1. Implement it with `requiresExplicitGrant: true`.
2. The default `["*"]` will NOT include it.
3. Policies that need it must explicitly list it: `allowed_tools='["*","send_email"]'`.
4. The flag forces conscious authorization — no surprise capability creep.

---

## §7. Rollout

### 7.1 Migration

Roll-forward only: `packages/storage-supabase/sql/0002_phase_3.sql` contains §2.3 statements + a seed for Gavrilo's knowledge source:

```sql
INSERT INTO knowledge_sources (id, workspace_id, type, config)
VALUES (
  gen_random_uuid(),
  '<gavrilo_workspace_id>',
  'git',
  '{
    "repo_url": "git@github.com:gavrilux/CerebroDigital.git",
    "branch": "main",
    "deploy_key_env_var": "KNOWLEDGE_GIT_DEPLOY_KEY",
    "local_path": "/data/knowledge/cerebro",
    "sync_interval_minutes": 15,
    "exclude_globs": [".git/**", "*.backup-*", "node_modules/**", "01-Perfil/credenciales*"]
  }'::jsonb
);
```

### 7.2 4-step rollout

**Step 1 — Infrastructure, tools disabled**
- `ENABLE_KNOWLEDGE_SYNC=true`, `ENABLE_AGENT_TOOLS=false`
- Worker runs first full `knowledge.sync` (~2 min, ~$0.003)
- Agent keeps Phase 2 behavior (no tools)
- **Verify**: `SELECT count(*) FROM knowledge_chunks` ≈ 3000; `SELECT count(*) FROM knowledge_files WHERE indexed_at IS NULL` = 0.

**Step 2 — Tools on, policy in `suggest`**
- `ENABLE_AGENT_TOOLS=true`
- Gavrilo's policy temporarily set to `suggest` (Phase 2 already supports this — creates draft instead of sending)
- Send: *"¿qué tengo pendiente esta semana?"*
- Check `drafts` table for the proposed reply; check `audit_log` for `tool.call` rows showing `search_knowledge`.
- **Verify**: `SELECT details FROM audit_log WHERE action='tool.call' ORDER BY created_at DESC LIMIT 5`.

**Step 3 — Policy back to `auto`**
- Restore Gavrilo's policy to `auto`.
- Send: *"¿quién es Albert?"* → expect citation of `02-Proyectos/agentiko-evento-bcn.md`.
- Send: *"¿cuál es la versión estable más reciente de Node.js?"* → expect Tavily-cited URL.

**Step 4 — Monitor 48 h**
- Aggregate `audit_log` by day: tool calls, cost, latency.
- If cost/day > 20% of cap → review tool usage patterns.
- If p95 latency > 15 s → consider parallelizing independent tool calls.

### 7.3 Defensive degradation matrix (built-in from day 1)

| Failure | Behavior |
|---|---|
| `knowledge.sync` job error | Audit-log error; agent serves from last successful index |
| pgvector unavailable | `search_knowledge` returns `{error}`; agent continues with web + memory |
| Tavily down | `search_web` returns `{error}`; agent answers with knowledge or no tools |
| OpenAI embeddings down | `search_knowledge` fails on query embed; pending indexing queues up |
| Tool timeout 30 s | tool_result `{error: "timeout"}`; agent decides retry/skip |
| `max_tool_calls` reached | Last turn called with `tools: []` to force text |
| Budget exceeded mid-job | Remaining tools return `{error: "budget_exceeded"}`; agent closes with current info |

### 7.4 E2E gate (done criteria)

All three must pass real-traffic in Telegram before declaring Phase 3 LIVE:

1. **Knowledge**: *"¿qué próximo paso tiene fiscalflow?"* → bot replies with content from `02-Proyectos/fiscalflow.md` and cites the file path.
2. **Web**: *"¿cuál es la versión estable más reciente de Node.js?"* → bot uses Tavily, returns correct number, cites URL.
3. **Combined**: *"resume mis 3 proyectos más activos y busca si hay novedades de Vercel hoy"* → bot uses `search_knowledge` + `search_web` in the same turn, synthesizes, cites both sources.

Pass = merge `feat/phase-3-tools-knowledge` to `main`, declare LIVE.

### 7.5 Effort

- Sprint 1 (3-4 days): `knowledge-source`, `vector-store`, `web-search`, `agent-tools` packages + interfaces + MVP adapters
- Sprint 2 (3-4 days): `agent-runtime` tool loop + `agent-guardrails` whitelist + audit
- Sprint 3 (2-3 days): wiring in `apps/api`, `knowledge.sync` cron, migration, secrets, Fly volume
- Sprint 4 (2 days): E2E gates + monitoring + docs

**Total: ~2 weeks full-time**, realistic 3-4 weeks calendar given other projects.

---

## §8. Non-goals (Phase 3)

Explicit to avoid scope creep:

- ❌ **`recall_thread`** (semantic search over past conversation messages). Requires auto-embedding pipeline for inbound/outbound messages — defer to Phase 3.1.
- ❌ **`google_calendar`** and other OAuth-gated tools. Wait for Phase 1b (Email) to land; calendars become valuable when negotiating times over email.
- ❌ **`mempalace_query`** or bridging existing MCPs. Architecturally sound but adds an external dependency we don't need yet.
- ❌ **Streaming tool_use**. No Telegram UI benefit.
- ❌ **Per-tool rate limits**. Global cap suffices.
- ❌ **Tool output sanitization** (PII redaction, HTML scrubbing). Add when it hurts.
- ❌ **Multi-source knowledge** (e.g. one user with both Git + Notion). Architecture supports it; MVP ships one source per workspace.

---

## §9. Open questions (to revisit during planning)

1. **Embedding model swap**: do we want to ship with `text-embedding-3-small` (OpenAI, $) or `gemini-embedding-001` (Google, free at low volume)? Free is tempting but adds Google API key dependency. **Tentative**: ship OpenAI for MVP, swap later if cost matters.
2. **Cron mechanism**: do we use pg-boss `send.every()` (native), a separate Fly machine cron, or `setInterval` in the worker? **Tentative**: pg-boss `send.every()` for consistency with the existing queue.
3. **Markdown chunker edge cases**: how do we handle tables, code blocks, very deep nesting (H4+)? **Tentative**: treat tables and code blocks as atomic (never split); H4+ flattens into nearest H3 breadcrumb.
4. **Secrets rotation flow**: `KNOWLEDGE_GIT_DEPLOY_KEY` needs documented rotation (revoke + regenerate + `fly secrets set`). **Tentative**: add to runbooks at Sprint 3.

These don't block design approval — they're tactical decisions for the implementation plan.
