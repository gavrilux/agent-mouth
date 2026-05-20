# Agent Mouth — Vision Design Doc

**Status:** Draft v1 · 2026-05-20
**Author:** Gavrilo Markovic Jankovic + Claude
**Supersedes:** N/A (extends `2026-05-11-agent-mouth-design.md` and `-telegram-design.md`)
**Implementation specs spawned from this doc:** TBD (Fase 0 spec next)

---

## §1. Vision & Users

### What Agent Mouth is

> A multi-channel MCP layer that gives any AI agent autonomous presence across channels. The agent lives in the cloud, receives messages via Telegram/Email/WhatsApp/Slack like a human, maintains per-contact memory, and decides when to respond autonomously based on configurable policies — **granular per-contact × per-channel**.

It is **not** "an MCP for Telegram." It is **the communication infrastructure layer for AI agents** with multi-channel presence. Conceptual analog: what **Twilio** did for web apps (unified SMS/voice layer), Agent Mouth does for AI agents with multi-channel presence + autonomy.

### Example of per-contact × per-channel granularity

| Contact | Telegram | Email | WhatsApp |
|---|---|---|---|
| **Marco** (cofounder) | `auto` | `suggest` (draft for me) | `auto` |
| **Albert** (client BCN) | `suggest` | `suggest` | `escalate` always |
| **Mafra** (partner) | `auto` | `auto` | `auto` |
| **Spam/unknown** | `silent` | AI filter | `block` |

Reflects real life: each channel has its own formality and latency expectations. Email = formal, leaves trail → draft. Telegram = chat → auto OK. WhatsApp w/ clients = sensitive → escalate.

### Primary users (in order)

1. **You (AI developer)** — dogfooding. Unified inbox across Telegram + Email + Slack. Your personal agent responds for you per per-contact × per-channel policies you define. First customer.
2. **Other developers / agency owners** (AGENTIKO clients) — want to build agents for their clients. Self-host or use hosted.
3. **Small businesses** — automated multi-channel customer service. Buy hosted commercial version.

### Secondary users

4. Open-source contributors adding transports (Discord, Signal, SMS, whatever).
5. Other AI products consuming Agent Mouth as sub-layer via API/MCP (B2B2B).

---

## §2. Core Principles

Eight principles that guide every technical and product decision. Any proposal violating a principle requires strong justification.

### P1. Multi-tenant native
Every data model has `workspace_id`. Self-host = 1 workspace (fixed `workspace_id`). Hosted = N isolated workspaces with RLS. **No dual code path.** Avoids the "Postiz pain" of migrating mono→multi when users already exist.

### P2. Identity-first, not handle-first
The system thinks in people, not handles. `Marco` is a `Contact` with N `ChannelIdentity` rows. Queries are by contact, not by handle. Threading is cross-channel native. *Consequence:* without this, the agent has no coherent memory when Marco switches channels.

### P3. Policy-driven autonomy, granular per-contact × per-channel
Matrix `(contact, channel_type) → policy` with fallback chain:
1. `(contact, channel)` — exact match
2. `(contact, *)` — contact-wide policy
3. `(*, channel)` — workspace-wide policy for that channel
4. `(*, *)` — workspace default
5. **Final fallback: `escalate`** (safer than `auto`)

Grants granularity when needed, simplicity by default.

### P4. Agnostic core, swappable edges
- **Transports** behind `Transport` interface (TelegramTransport, EmailTransport, WhatsAppTransport, …)
- **Storage** behind `StorageAdapter` interface (SQLiteAdapter, PostgresAdapter, …)
- **Agent brain** behind `AgentRuntime` interface (ClaudeRuntime, OpenAIRuntime, LocalLLMRuntime, …)

Swapping one implementation must not require core changes. Tests use interface mocks.

### P5. Agent runtime with memory + tools — audit by default
The agent is NOT a pure function `(msg) → reply`. It is a runtime with:
- Short-term memory (recent thread)
- Long-term memory (contact "card", optional)
- Access to tools (external MCP servers: calendar, KB, Linear, etc.)
- Per-contact configurable system prompt

**Every autonomous action is recorded in audit log with reasoning.** User can review "what did the agent say and why" at any time. Drafts editable before send when policy=`suggest`.

### P6. Same codebase, OSS + hosted
**Single codebase under MIT license.** Commercial features (billing, multi-workspace admin, white-label) live behind feature flags and DI, not in a fork. Self-hoster sees full code; hosted activates flags.

### P7. MCP primary, REST secondary
- **MCP** is the primary surface — consumed by Claude Code, Cursor, other agents
- **REST API** for hosted dashboard and non-MCP integrations
- **Outbound webhooks** so external apps can react to events (`message.received`, `agent.responded`, `escalation.requested`)

### P8. LLM-provider agnostic
`AgentRuntime` is a swappable interface. Claude, GPT-4o, GPT-5, Gemini, Ollama local: all supported via their respective SDKs. User configures which to use + their API key. Self-host = your API key, your bill. Hosted = our markup.

---

## §3. Architecture Overview

Five layers behind clean interfaces. Arrows are dependencies (upper layer knows lower, not vice versa).

```
┌─────────────────────────────────────────────────────────────────┐
│  API Layer       MCP server | REST API | Webhook Dispatcher    │ ← consumed by
└─────────────────────────────────────────────────────────────────┘   Claude Code,
                          ↓                                            dashboards, etc.
┌─────────────────────────────────────────────────────────────────┐
│  Agent Runtime   AgentRuntime | MemoryService | ToolRegistry   │ ← runs the LLM
│                  AuditLog                                       │   with tools
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  Routing         RouterService | PolicyEngine                  │ ← decides what
│                                                                 │   happens per
└─────────────────────────────────────────────────────────────────┘   incoming msg
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  Identity        IdentityResolver | ContactStore                │ ← contacts ↔
│                                                                 │   channel ids
└─────────────────────────────────────────────────────────────────┘
                          ↓                ↑
┌─────────────────────────────────────────────────────────────────┐
│  Transports      TelegramTransport | EmailTransport |          │ ← edge I/O
│                  WhatsAppTransport | (future: Discord, Slack)  │
└─────────────────────────────────────────────────────────────────┘
                          ↓
                  [ Telegram | Gmail | WhatsApp Cloud ]
```

### Inbound flow (message arrives)

```
1. Transport receives raw event (Telegram webhook, IMAP push, …)
2. TransportAdapter.normalize(raw) → Message { from, channel_type, content, thread_ref, … }
3. IdentityResolver.resolve(channel_id, channel_type) → Contact
4. PolicyEngine.evaluate(contact, channel_type) → policy ∈ {auto, suggest, escalate, silent}
5. Switch on policy:
   ├─ auto      → AgentRuntime.respond(message, contact) → Transport.send()
   ├─ suggest   → AgentRuntime.draft(message, contact)   → DraftStore
   ├─ escalate  → NotificationService.notify(human)
   └─ silent    → persist only, no action
6. EventBus.publish("message.received") → WebhookDispatcher
7. AuditLog.write(action, reasoning, tools_called, timestamp)
```

### Outbound flow (human via MCP/REST)

```
1. Claude Code calls send_message({to: "marco", channel: "telegram", body: "..."})
2. MCP server → IdentityResolver.resolveOutbound("marco", "telegram") → ChannelIdentity
3. Transport.send(channel_identity, body)
4. AuditLog.write(action, human_initiated=true)
```

### Monorepo structure (pnpm workspaces)

```
agent-mouth/
├── packages/
│   ├── core/                  → interfaces, domain types, no I/O
│   ├── api/                   → MCP server, REST server, webhooks
│   ├── agent/                 → AgentRuntime, MemoryService, ToolRegistry
│   ├── identity/              → IdentityResolver, ContactStore interface
│   ├── routing/               → RouterService, PolicyEngine
│   ├── transports/
│   │   ├── transport-telegram/    ← exists (will be refactored)
│   │   ├── transport-email/       ← new in Phase 1
│   │   ├── transport-whatsapp/    ← Phase 4
│   │   └── transport-discord/     ← Phase 4
│   └── storage/
│       ├── storage-sqlite/    → self-host default
│       ├── storage-postgres/  → hosted
│       └── storage-test/      → in-memory for tests
└── apps/
    ├── cli/                   → npx agent-mouth (self-host entry)
    └── hosted/                → Next.js dashboard (future Phase 5)
```

**Why monorepo:** each transport and each storage adapter can be published independently on npm. A contributor can add `transport-signal` without touching core.

---

## §3.5 Cost Model

Four cost sources. Not all are LLM. Not all are mandatory.

### Cost 1: Agent Runtime LLM (autonomous responses)
Each autonomous agent response = 1+ LLM calls. Rough estimates with Claude Sonnet 4.7:
- Short reply without tools: ~3,000 tokens (in+out) ≈ **$0.012**
- Reply with thread memory + 2 tool calls: ~15,000 tokens ≈ **$0.060**

For 100 responses/day = **$1-6/day**. Equivalents:
- GPT-5: similar (~$0.01-0.05 per response)
- Gemini 2.5 Pro: ~60% cheaper
- Llama 3.3 70B on Ollama local: **$0** but requires hardware (32GB+ RAM)

### Cost 2: MCP Client LLM (your Claude Code / Cursor)
When YOU use Claude Code to `read_inbox`, that call consumes your Claude/OpenAI/etc. budget. **This is NOT Agent Mouth — it's your MCP client cost.** Same as when you use any other MCP server.

### Cost 3: Transport APIs (only some)

| Transport | Cost |
|---|---|
| Telegram | $0 |
| Gmail (Google API) | $0 (generous quotas) |
| Discord/Slack | $0 |
| **WhatsApp Business** | $0.005-0.10 per outgoing message + Meta verif (free) |
| **SMS (Twilio)** | ~$0.01 per message |

WhatsApp is the only "expensive" transport. Telegram, Gmail, Discord, Slack are all free.

### Cost 4: Infrastructure (hosting)
- Fly.io: **$0** in free tier for 1 VM 256MB (current state)
- Supabase: **$0** in free tier (up to 500MB DB)
- If scaled to commercial hosted: ~$20-100/month for hundreds of tenants

### Mitigations (product-level decisions)

1. **Budget caps per-workspace per-day** — "max $5/day in LLM, escalate everything to human after"
2. **Rate limits** — max N autonomous responses/hour per-contact
3. **Semantic caching** — if Marco asks "are you there?" 10 times in an hour, don't call LLM 10 times
4. **`suggest` mode uses same LLM as `auto`** but human filters before send → **zero transport cost** but same LLM cost. Useful starting cheap.
5. **Local LLM opt-in** — paranoid / no-budget users connect Ollama, spend $0 on LLM (lower quality)
6. **In hosted commercial**: pricing per processed messages + markup over LLM cost. Twilio model.

---

## §4. Identity & Contact Model

Eight entities. From outer (tenant definition) to inner (high-mutation: messages).

### Entity relations

```
Workspace ─┬─ Users (humans of the workspace; 1 in self-host, N in hosted)
           ├─ Channels (instances of transports configured)
           ├─ Contacts ──── ChannelIdentities (N per contact)
           ├─ Policies (matrix contact × channel_type)
           ├─ Threads ──── Messages ──── Drafts (if policy=suggest)
           └─ AuditLog
```

### Tables (Postgres-compatible, also SQLite-compatible)

```sql
workspaces (id, name, owner_user_id, plan, created_at)
users      (id, workspace_id, email, role, created_at)

-- Configured transport instances (a workspace may have 2 Telegram bots)
channels (
  id, workspace_id,
  type [telegram | email | whatsapp | discord | slack],
  config jsonb,            -- bot_token, smtp_creds, etc. ENCRYPTED
  status [active | paused | error],
  created_at
)

-- People (not handles)
contacts (
  id, workspace_id, display_name,
  notes text,              -- light-CRM "card" (long-term memory)
  created_at
)

-- N identities per contact (P2 Identity-first)
channel_identities (
  id, contact_id, channel_id,
  identifier text,         -- "@marco_bot", "marco@cuina.es", "+34xxx"
  verified boolean,        -- "did you confirm this email is really Marco?"
  UNIQUE (channel_id, identifier)
)

-- Policies with fallback chain (P3)
policies (
  id, workspace_id,
  contact_id nullable,     -- NULL = applies to all contacts
  channel_type nullable,   -- NULL = applies to all channels
  policy [auto | suggest | escalate | silent],
  system_prompt text,      -- agent personality for this contact/channel
  rules jsonb,             -- time windows, keywords, override conditions,
                           --   and available_tools whitelist (see §5.5)
  priority int             -- higher = evaluated first
)
```

### Policy resolution (fallback chain)

```python
def resolve_policy(contact_id, channel_type, workspace_id):
    candidates = [
        (contact_id, channel_type),    # 1. specific × specific
        (contact_id, None),            # 2. contact × any
        (None, channel_type),          # 3. any × channel
        (None, None),                  # 4. workspace default
    ]
    for c_id, ch in candidates:
        p = query_policy(workspace_id, c_id, ch)
        if p: return p
    return Policy(policy='escalate')   # 5. safe final fallback
```

### Threads & Messages

```sql
threads (
  id, workspace_id, contact_id, channel_id,
  external_thread_id text,    -- subject hash (email), msg thread (telegram)
  last_message_at, closed boolean,
  related_thread_ids uuid[]   -- cross-channel threads of same topic (P2)
)

messages (
  id, thread_id, channel_id, channel_identity_id,
  direction [inbound | outbound],
  content text, attachments jsonb,
  raw_payload jsonb,          -- raw transport payload for debug
  external_message_id text,   -- Telegram update_id, email Message-ID
  sent_by [human | agent],    -- who originated (outbound)
  created_at
)

drafts (
  id, message_id,             -- the message the agent wants to reply to
  proposed_body text,
  agent_reasoning text,       -- "I responded X because..."
  tools_called jsonb,         -- which tools agent called for this draft
  status [pending | approved | rejected | edited],
  approved_by, approved_at
)

audit_log (
  id, workspace_id,
  action text,                -- 'message.received', 'agent.responded', 'policy.evaluated'
  actor [human | agent | system],
  details jsonb,
  related_message_id, related_contact_id,
  created_at
)
```

### Key model notes

1. **`channels` ≠ `channel_types`** — `channels` are *instances* (your specific Telegram bot, your specific Gmail account). `channel_type` is the *category* ("telegram", "email"). A workspace may have 2 channels of type `telegram` with different bots.

2. **`policies` can have N rows per contact-channel** — for distinct rules with priorities. Useful for "Marco between 9-18h = auto, outside hours = escalate" as two rows with different `rules`.

3. **`drafts` separate from `messages`** — drafts do NOT pollute the messages table until approved/sent. When a draft is approved, an outbound `message` is created and the draft marked `approved`.

4. **`audit_log` is append-only** — never deleted or modified. Fulfills "audit by default" (P5). Partitionable by date to avoid unbounded growth.

5. **`raw_payload` in messages** — useful for debug and for a new `Transport` to reprocess historical messages if we add features later (e.g. attachment detection added late).

---

## §5. Agent Autonomy Model

How the agent decides what to do when invoked. Seven components.

### 5.1 Lifecycle — stateless runtime, state in DB

`AgentRuntime` is **not a live process**. There is no agent "awake" 24/7 waiting. When a message arrives:

```
Message → Router.evaluate(policy) → if needs agent: AgentRuntime.respond(context)
                                                          ↓
                                              LLM call (Claude/GPT/etc.)
                                                          ↓
                                            Response + audit + cleanup
```

Important for cost and scalability: we don't pay for a live process. Only real invocations.

Persistent state (memory, audit) lives in DB. The runtime is a *consumer* of that state, not its owner.

### 5.2 Per-policy behavior

| Policy | Invokes agent? | Sends reply? | Other actions |
|---|---|---|---|
| `auto` | ✅ Yes | ✅ Yes, automatic | Audit log with reasoning |
| `suggest` | ✅ Yes | ❌ No, saved as `draft` | Notify human "you have a draft" |
| `escalate` | ❌ No | ❌ No | Urgent notification to human + reason |
| `silent` | ❌ No | ❌ No | Persist message only (spam folder mode) |

### 5.3 Invocation contract

```typescript
interface AgentContext {
  workspace_id: UUID;
  contact: Contact;                 // with notes (long-term memory)
  channel_type: ChannelType;
  incoming_message: Message;
  thread_history: Message[];        // last N messages of thread
  policy: Policy;                   // includes system_prompt + rules + tools whitelist
  available_tools: Tool[];          // external MCPs accessible per policy
  budget: BudgetState;              // tokens remaining (rate limit / daily cap)
}

interface AgentResponse {
  body: string;
  reasoning: string;                // for audit
  tools_called: ToolCall[];
  tokens_used: { in, out, cached };
  cost_estimate_usd: number;
  metadata: {
    confidence: number;             // 0-1
    should_escalate: boolean;       // agent can self-escalate when uncertain
  };
}
```

**Subtle but critical point:** `metadata.should_escalate=true` lets the agent say "I'm not sure about this, better you handle it." That turns an `auto` into a de-facto `suggest`. This is the *agent's internal safeguard* — independent of human policies.

### 5.4 Memory model — four layers

| Layer | Stores | Queried when | Implementation | Cost |
|---|---|---|---|---|
| **Working** | last N messages of current thread | Always (every invocation) | `MessageStore.lastN(thread_id)` | Low |
| **Semantic** | embeddings of ALL contact's messages (cross-thread) | When agent needs to recall something specific | `VectorStore.search(contact_id, query)` | Medium |
| **Episodic** | `contact.notes` narrative ("card") | Always included in system prompt | `ContactStore.getNotes()` | Low |
| **External tools** | MempalaceMCP, KB, calendar, … | When agent invokes the tool | Tool calls (P5) | Variable |

**Composition in AgentContext:**

```typescript
const context: AgentContext = {
  // 1. Working memory — always
  thread_history: await messageStore.lastN(thread_id, 10),
  
  // 2. Semantic memory — only when agent requests it via tool
  // (not precomputed; agent decides when to search)
  
  // 3. Episodic memory — always, in system prompt
  contact_notes: contact.notes,
  
  // 4. External tools — available per policy
  available_tools: [
    'semantic_search',        // semantic memory exposed as tool
    'google_calendar',
    'mempalace_search',       // ← MemPalace as external tool, not internal memory
    ...
  ]
};
```

**Subtle decision:** `semantic_search` is exposed **as a tool**, not pre-fetched into context. Reasons:
- Auto-prefetch is expensive (each invocation = vector search + extra context tokens)
- Agent often doesn't need semantic history — just working + notes
- As a tool, the agent decides *when* to search and *what* to search for

### 5.4.1 VectorStore interface (added to §3 Architecture, Storage layer)

```typescript
interface VectorStore {
  embed(text: string): Promise<number[]>;
  upsert(workspace_id, contact_id, message_id, text): Promise<void>;
  search(workspace_id, contact_id, query: string, top_k: number): Promise<Message[]>;
}

class PgvectorStore     implements VectorStore { /* Supabase pgvector */ }
class LibSQLVectorStore implements VectorStore { /* SQLite with vector built-in */ }
class MockVectorStore   implements VectorStore { /* tests */ }
```

**Why pgvector and libsql:**
- **pgvector** is bundled with Supabase. No external DB (Pinecone, Weaviate) required.
- **libsql** is SQLite with built-in vector. Allows self-host without Postgres.
- Both respect P4 (storage-agnostic) and P1 (multi-tenant — partitioned by `workspace_id` + `contact_id`).

### 5.4.2 Embedding models (configurable)

| Model | Cost | Quality | Recommended for |
|---|---|---|---|
| OpenAI `text-embedding-3-small` | $0.02/1M tokens | Good | Default |
| Voyage `voyage-3` | $0.06/1M | Better | Hosted paid tier |
| Local `nomic-embed-text` (Ollama) | $0 | Decent | Self-host privacy-first |

**Real cost estimate:** indexing 10,000 messages (~1M tokens) = $0.02 once. Search at runtime = nearly zero (cached). Embedding is the cost, not the search.

### 5.4.3 Privacy boundaries

- **Cross-contact: never** — embeddings partitioned by `(workspace_id, contact_id)`. A query never crosses contacts. Legally important and prevents leak between distinct conversations.
- **Cross-workspace: never** — RLS in Postgres + filters in SQLite. Multi-tenant isolated.
- **MemPalace access** — only as optional external tool (no leak by default). User decides if to connect.

### 5.5 Tool integration — external MCP servers

The agent calls other MCPs as tools. Policy defines which tools are usable per contact/channel:

```jsonc
{
  "policy_id": "marco-telegram",
  "available_tools": [
    { "server": "google-calendar", "tools": ["check_availability"] },
    { "server": "linear", "tools": ["create_issue", "list_issues"] },
    { "server": "knowledge-base", "tools": ["search"] }
  ]
}
```

Enables real scenarios: *"Marco asks 'are you free Tuesday?'. Agent calls `google-calendar.check_availability`, sees 11am free, replies 'yes, 11am works'."*

Tool access is **per-policy, not global**. Marco can see your calendar; a new client cannot.

### 5.6 Guardrails (not optional)

| Guardrail | Configurable | Default |
|---|---|---|
| **Daily budget cap** (USD) | per-workspace | $5/day |
| **Rate limit per-contact per-hour** | per-policy | 10 auto-responses/hour |
| **Max tool calls per response** | per-policy | 10 |
| **Max tokens per response** | per-policy | 8000 out |
| **Prompt injection defense** | global | sanitize `<system>` strings, ignore "ignore previous instructions" |
| **Forbidden topics** | per-policy | configurable regex + optional classifier |
| **Loop protection** | global | if agent tries 3+ messages in row without waiting → stop |
| **Hard escalate triggers** | per-policy | "legal", "pago", "factura", "cancelo" → escalate |

When a guardrail trips → response is not sent, a `draft` is created with reason "BLOCKED: budget cap" or similar + ping to human.

### 5.7 Provider abstraction (P4 + P8)

```typescript
interface AgentRuntime {
  initialize(config: RuntimeConfig): Promise<void>;
  respond(context: AgentContext): Promise<AgentResponse>;
  estimateCost(context: AgentContext): Promise<number>;
  dispose(): Promise<void>;
}

// Swappable implementations:
class ClaudeRuntime extends AgentRuntime { /* Anthropic SDK */ }
class OpenAIRuntime extends AgentRuntime { /* OpenAI SDK */ }
class GeminiRuntime extends AgentRuntime { /* @google/generative-ai */ }
class OllamaRuntime extends AgentRuntime { /* local */ }
class MockRuntime   extends AgentRuntime { /* tests */ }
```

Each implementation has its own prompt template optimized for that model (Claude responds better with XML tags, GPT with markdown, etc.). Core knows none of this.

---

## §6. Phased Roadmap

Six phases. Each delivers value on its own. **You can stop after any phase and the system remains useful.**

### Dependency diagram

```
Phase 0 (Refactor) ─┬─► Phase 1 (Identity + Email) ─┬─► Phase 2 (Basic agent) ─► Phase 3 (Vector + Tools)
                    │                                │                              │
                    └──────────────────► Phase 4 (More channels) ───────────────────┤
                                                                                    │
                                              ──────────────► Phase 5 (Hosted commercial)
```

Phase 0 is prerequisite for everything. Phases 1, 2, 3 are sequential. Phase 4 (more channels) can start after Phase 1 if you want more channels before autonomous agent. Phase 5 requires everything above.

### Detailed table

| Phase | Name | Scope | Deliverable | Effort |
|---|---|---|---|---|
| **0** | Core refactor | Restructure repo into packages (core, transports, storage, agent, api). Migrate TelegramTransport. Base Postgres schema (workspaces → audit_log). Keep `agent-mouth.fly.dev` operational during refactor. | Current cloud keeps working with new internal architecture. Nobody notices. | ~2 weeks |
| **1** | Identity + Email | `ContactStore`, `IdentityResolver`, `PolicyEngine` with fallback chain, `EmailTransport` (Gmail API), `read_inbox` cross-channel (Telegram + Email), `send_message` with `channel` param. | Your unified inbox: read and send via Telegram + Email from Claude Code. Marco is a Contact with 2 identities. | ~3 weeks |
| **2** | Basic agent runtime | `AgentRuntime` interface + `ClaudeRuntime`. Working memory + episodic memory. Policy `auto` + `suggest` + `drafts` table. Basic guardrails (budget, rate limits). AuditLog. | Agent responds to Marco autonomously when policies allow. You approve drafts when policy=suggest. | ~3-4 weeks |
| **3** | Vector + Tools | `VectorStore` interface + `PgvectorStore`/`LibSQLVectorStore`. Auto-embedding pipeline. `semantic_search` as tool. `ToolRegistry` for external MCPs. Per-policy tool whitelist. | Agent can search past Marco conversations and call your Google Calendar / MemPalace / Linear per policy. | ~2-3 weeks |
| **4a** | WhatsApp transport | Meta Business API integration. WhatsApp threading. Pre-approved templates. | Marco/Albert/clients can talk to your agent via WhatsApp. | ~1 week + Meta verif wait |
| **4b** | Discord transport | Discord bot + webhook. Discord threading. | Agent accessible via Discord. Easy demo. | ~1 week |
| **4c** | Slack transport | Slack app + events API. | Agent accessible via Slack workspace. | ~1 week |
| **5** | Commercial hosted | Production-grade multi-tenant. Auth (Supabase Auth/Clerk). Next.js dashboard (`apps/hosted`). Billing (Stripe). Onboarding wizard. Marketing site. | `agent-mouth.com` LIVE. Other users can sign up, configure contacts/policies/channels without touching code. | ~4-6 weeks |

### Total estimation

- **Phases 0+1+2+3 only** (complete base system + agent + tools): **~10-12 weeks** full-time
- **Plus full Phase 4** (real multi-channel): **~14-16 weeks** full-time
- **Complete commercial hosted product (all phases)**: **~18-22 weeks** full-time

With realities (12+ active projects): likely **6-12 calendar months**.

### Key milestone: "MVP dogfooding"

**Minimum to use this daily yourself = Phases 0 + 1 + 2** (~8-9 weeks). At that point you have:
- Unified Telegram + Email inbox
- Agent that responds to Marco alone with drafts/auto per policy
- Audit log to review

From there decide whether to continue to Phase 3+4+5 or stop and enjoy.

### "Done" criteria per phase

Each phase has a **gate**: real E2E test validating the deliverable before next phase.

| Phase | Gate |
|---|---|
| 0 | `agent-mouth.fly.dev` still responds to Claude Code the same as before |
| 1 | Send email to your own account → appears in `read_inbox` alongside Telegram messages |
| 2 | Configure Marco=`auto` in Telegram. Marco writes you. You receive autonomous reply + audit log with reasoning |
| 3 | Configure `google_calendar` tool for Marco. Marco asks "are you free Tuesday?". Agent queries calendar and replies with real availability |
| 4a/b/c | Each channel passes its own E2E test (send + receive) |
| 5 | A beta tester signs up at `agent-mouth.com`, configures their own Telegram bot, receives first message, replies — all without touching code |

---

## §7. Non-goals + Open Questions

### 7.1 Non-goals (what Agent Mouth is NOT)

Explicit to avoid scope creep:

- ❌ **Not a CRM** — Pipedrive/HubSpot exist. Agent Mouth has minimal `contacts` for identity, not the commercial source of truth.
- ❌ **Not email marketing** — Brevo/Mailchimp exist. No mass campaigns, sequences, segmentation.
- ❌ **Not a help desk** — Intercom/Zendesk exist. No tickets, SLAs, agent queue management.
- ❌ **Not a Twilio alternative** — Twilio is pure transport. Agent Mouth adds *AI agent* on top. Internally Agent Mouth might use Twilio for SMS, not compete with it.
- ❌ **Not a generic agent framework** (LangChain, CrewAI) — specifically communicational, not general-purpose agent orchestration.
- ❌ **Not a persistent chat app** (Slack alternative) — message transport, not chat platform.
- ❌ **Not proactive** — REACTIVE to incoming messages and human invocations. Does not generate newsletters, cold outreach, or proactive notifications.
- ❌ **Does not replace your email client** (Gmail/Superhuman) — agentic layer that coexists. You still use Gmail directly when you want.
- ❌ **Not file management** — if Marco sends PDF, we store reference to transport raw payload, don't process/reuse the file.
- ❌ **No voice/video calls in v1.x** — telephony is totally different stack. Maybe v2 with Twilio Voice / Daily.
- ❌ **Not OSS pure-play without commercial path** — designed from day 1 to have a sellable hosted version.

### 7.2 Open questions (deferred decisions)

Things NOT decided today, to be resolved in their corresponding sub-spec:

| # | Question | When decided |
|---|---|---|
| 1 | **Hosted auth strategy** (Supabase Auth vs Clerk vs WorkOS) | Phase 5 spec |
| 2 | **Concrete pricing model** (per-message vs per-seat vs freemium with limits) | Phase 5 spec |
| 3 | **Voice transcription** of audio messages (local Whisper vs AssemblyAI) | Post-v1 phase |
| 4 | **Group chats / channels** (each Telegram/Slack channel = one thread?) | Phase 1 spec |
| 5 | **Multi-language responses** (agent in message's language? per-contact pref?) | Phase 2 spec |
| 6 | **OAuth flows for transports** (Gmail, WhatsApp Meta — UI guided vs config file) | Phase 1 (Gmail) and 4a (WhatsApp) specs |
| 7 | **GDPR / right-to-be-forgotten** — delete-by-contact flow | Before first external user |
| 8 | **Self-host distribution** (Docker compose vs npm vs Helm chart) | Phase 1 spec |
| 9 | **Telemetry opt-in** to improve product without violating privacy | Phase 5 |
| 10 | **Encryption at rest** for transport tokens and messages storage | Phase 0 spec (critical: never commit tokens plain text) |

### 7.3 Fixed technical decisions

To avoid re-litigating in each sub-spec:

✅ **TypeScript + Node 20+** (not Rust, not Go, not Python — aligns with current stack)
✅ **Postgres as primary DB** (pgvector built-in, multi-tenant via RLS) + libsql self-host option
✅ **MIT license** (not AGPL or dual license, at least for v1)
✅ **pnpm workspaces monorepo** (consistent with current)
✅ **MCP as primary surface**, REST as secondary
✅ **Stateless agent runtime** (no 24/7 live processes)
✅ **Storage-agnostic via interfaces** (P4 + P8)
✅ **Multi-tenant from day 1** (P1)

---

## Next steps

1. **This doc is signed off.** Commit.
2. **Phase 0 spec** — invoke `superpowers:writing-plans` to produce executable implementation plan for the core refactor. Until Phase 0 is done, the rest cannot start.
3. **Each subsequent phase** gets its own design refinement + plan + implementation, in sequence.

Phases 1+ specs SHOULD reference this doc and respect the principles. Any deviation requires updating this doc first.
