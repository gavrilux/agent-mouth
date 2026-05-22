# Agent Mouth — Phase 2: Basic Agent Runtime (Design Spec)

> **Status:** approved (brainstorming 2026-05-22), pending implementation plan.
> **Parent:** [2026-05-20-agent-mouth-vision-design.md](2026-05-20-agent-mouth-vision-design.md) §5 + §6.
> **Predecessor:** Phase 1a (Telegram routing + identity stack) — LIVE en `agent-mouth.fly.dev`.
> **Effort estimate:** ~3-4 semanas.

## §0. Summary

Phase 2 convierte agent-mouth de "router con silent fallback" en **plataforma de agente conversacional autónomo**. El bot pasa a responder mensajes según la policy resuelta por contacto/canal, con memoria working+episodic, guardrails completos y auditoría de cada invocación.

**Lo que entra:** `AgentRuntime` interface + `ClaudeRuntime` + `MockRuntime`, memoria working+episodic, policies `auto`/`suggest`/`escalate`/`silent` activas, cola async pg-boss, worker dentro del mismo proceso, los 8 guardrails del vision doc (agrupados en 4 bloques), AuditLog rico, notes auto-update tras conversación, dogfooding contra el propio operador (Gavrilo → @Gavrilux_bot, policy `auto`).

**Lo que NO entra (queda para Phase 3+):** semantic memory (pgvector), external tool registry (Phase 3); UI de aprobación de drafts (drafts se aprueban vía SQL hasta Phase 5); MCP tools de admin (`approve_draft`, `update_policy`, etc.); más canales (Email/WhatsApp/Discord — Phase 1b o Phase 4).

## §1. Decisiones cerradas en brainstorming

| # | Decisión | Razonamiento |
|---|---|---|
| 1 | Alcance: Phase 2 completo según vision doc §5 (~3-4 sem). | Fase coherente, sale producción cerrada. |
| 2 | Primer contacto activo: **Gavrilo → @Gavrilux_bot** (dogfooding). | Sin riesgo externo; Marco y Cuiner_bot quedan en `silent`. |
| 3 | Policy inicial de ese contacto: **`auto`** desde el día 1. | Valida la experiencia real (latencia, tono, errores) tal cual se sentirá un usuario externo. |
| 4 | Modelo LLM default: **`claude-sonnet-4-6`**. | Sweet spot quality/latency/cost para chat conversacional. |
| 5 | Aprobación de drafts: **solo en DB** (SQL hasta Phase 5). | Phase 2 escribe drafts a la tabla pero no construye flow de approval. |
| 6 | Invocación del agente: **async con cola** (pg-boss). | Webhook responde inmediato, worker absorbe latencia LLM. |
| 7 | `contact.notes`: **auto-update tras conversación** (Haiku 4.5). | El agente aprende sobre la persona sin intervención manual. |
| 8 | Guardrails: **los 8 del vision doc** (agrupados en 4 bloques). | Coste/abuso + caps respuesta + defensa básica + loop protection. |
| 9 | AuditLog: **incluido**, con columnas dedicadas (no solo JSONB). | Queries baratas para budget cap y rate limit. |
| 10 | Arquitectura: **Enfoque B** — sub-paquetes nuevos + pg-boss + worker mismo proceso. | Separación clara sin sobrecarga ops. Escalable a worker dedicado en Phase 5 sin reescribir. |

## §2. Arquitectura — nuevos paquetes

### Estado tras Phase 1a (actual)

```
packages/
├── core                    Router, types, IdentityResolver, PolicyEngine
├── storage-supabase        6 stores (workspaces, channels, contacts, channel_identities,
│                           policies, threads, messages, drafts, audit_log, users,
│                           agent_mouth_offsets)
├── storage-sqlite          idem self-host
├── storage-postgres        idem genérico
├── transport-telegram      grammy + webhook receiver
├── agent                   (vacío, placeholder)
└── api                     apps/api: Fly server + Telegram webhook + MCP /mcp
apps/cli                    CLI utilities
```

### Estado tras Phase 2

```
packages/
├── core                    + JobQueue interface, AgentInvoker contract
├── storage-supabase        + métodos en DraftStore, AuditLogStore, NotesStore (sub de ContactStore)
├── storage-sqlite/-postgres idem
├── transport-telegram      sin cambios
├── agent                   FACADE: compone runtime + memory + guardrails + notes-updater
├── agent-runtime           NUEVO: AgentRuntime iface + ClaudeRuntime + MockRuntime
├── agent-memory            NUEVO: WorkingMemoryBuilder + EpisodicMemoryBuilder
├── agent-guardrails        NUEVO: 4 bloques (budget, rate, prompt-injection+forbidden, loop)
├── agent-notes-updater     NUEVO: job que actualiza contact.notes tras conversación
├── queue-pgboss            NUEVO: implementación de JobQueue con pg-boss
└── api                     + worker loop (mismo proceso) + boot de pg-boss
```

**Reglas que se respetan:**
- `core` declara contratos (`JobQueue`, `AgentInvoker`), no implementaciones.
- El paquete `agent` queda como facade: `Agent.respond(context)` compone runtime+memory+guardrails. El worker solo conoce `agent`.
- `queue-pgboss` se aísla para poder swappear por BullMQ/SQS en Phase 5 sin tocar el agente.
- Tests unitarios por paquete; integración cruza paquetes en `apps/api/tests/integration/`.

## §3. Data model — migration `0003_phase2_agent.sql`

El schema base (Phase 0) ya tiene `workspaces`, `users`, `channels`, `contacts(notes)`, `policies`, `threads`, `messages`, `drafts` y `audit_log`. Phase 2 solo añade columnas y un par de índices.

```sql
-- 1. Guardrails per-policy + modelo override
ALTER TABLE policies
  ADD COLUMN model_id TEXT,                            -- NULL → default Sonnet 4.6
  ADD COLUMN rate_limit_per_hour INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN max_tokens_out INTEGER NOT NULL DEFAULT 8000,
  ADD COLUMN max_tool_calls INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN forbidden_topics_regex TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN escalate_triggers_regex TEXT[] NOT NULL DEFAULT '{}';

-- 2. Budget cap por workspace
ALTER TABLE workspaces
  ADD COLUMN daily_budget_usd_cap NUMERIC(10,4) NOT NULL DEFAULT 5.0;

-- 3. Audit log con columnas dedicadas (no solo details JSONB)
ALTER TABLE audit_log
  ADD COLUMN decision TEXT CHECK (decision IN ('sent','draft','blocked','escalated','no_action')),
  ADD COLUMN block_reason TEXT,
  ADD COLUMN model_id TEXT,
  ADD COLUMN tokens_in INTEGER,
  ADD COLUMN tokens_out INTEGER,
  ADD COLUMN tokens_cached INTEGER,
  ADD COLUMN cost_usd NUMERIC(12,6),
  ADD COLUMN latency_ms INTEGER;

CREATE INDEX idx_audit_workspace_day ON audit_log(workspace_id, created_at)
  WHERE decision IN ('sent','draft');

CREATE INDEX idx_audit_contact_recent ON audit_log(related_contact_id, created_at)
  WHERE decision IN ('sent','draft');

CREATE INDEX idx_messages_thread_direction ON messages(thread_id, direction, created_at DESC);

-- 4. Notes updater — marca por thread
ALTER TABLE threads
  ADD COLUMN notes_last_updated_at TIMESTAMPTZ;
```

pg-boss instala su propio schema `pgboss` (tablas `job`, `archive`, etc.) automáticamente al boot — no tocamos nada manualmente.

**Pricing de la decisión:** todas son ALTER TABLE ADD COLUMN con DEFAULT, sin backfill costoso. Reversible con DROP COLUMN si se aborta.

## §4. AgentRuntime — interface y flujo end-to-end

### 4.1 Interface (en `packages/agent-runtime/src/types.ts`)

```typescript
export interface AgentRuntime {
  initialize(config: RuntimeConfig): Promise<void>;
  respond(context: AgentContext): Promise<AgentResponse>;
  estimateCost(context: AgentContext): Promise<number>;
  dispose(): Promise<void>;
}

export interface AgentContext {
  workspaceId: string;
  contact: Contact;                    // incluye notes (episodic memory)
  channelType: ChannelType;
  incomingMessage: Message;
  threadHistory: Message[];            // últimos N (working memory)
  policy: ResolvedPolicy;              // system_prompt + model_id + caps + filters
  availableTools: ToolDefinition[];    // Phase 2: siempre []
  budget: { remainingUsd: number };
}

export interface AgentResponse {
  body: string;
  reasoning: string;
  toolsCalled: ToolCall[];             // Phase 2: siempre []
  tokens: { in: number; out: number; cached: number };
  costUsd: number;
  metadata: {
    confidence: number;                // 0-1
    shouldEscalate: boolean;           // self-escalate
  };
}
```

### 4.2 Implementaciones

- `claude-runtime.ts` — `@anthropic-ai/sdk`. Modelo default `claude-sonnet-4-6`. Prompt template con XML tags (`<contact_notes>`, `<thread_history>`, `<incoming_message>`). Devuelve JSON estructurado con `body` + `reasoning` + `shouldEscalate` + `confidence` vía tool use forzado.
- `mock-runtime.ts` — respuesta fija configurable. `costUsd=0`, `tokens=0`. Para tests deterministas.

### 4.3 Flujo end-to-end

```
1. Telegram webhook hit → apps/api/src/webhook.ts
2. Router.handle(update):
   ├─ IdentityResolver (Phase 1a, sin cambios) → contact
   ├─ PolicyEngine.resolve(contact, channelType) → ResolvedPolicy
   ├─ MessageStore.insert(inbound)
   └─ if policy.policy !== 'silent':
        JobQueue.enqueue('agent.respond', { messageId, workspaceId })
3. Webhook responde 200 OK inmediato.

--- async, worker poll cada 1s en mismo proceso ---

4. Worker recoge job 'agent.respond':
   ├─ Cargar contexto (MessageStore, ContactStore, lastN, policy)
   ├─ Guardrails pre-invoke (orden estricto):
   │    1. BudgetCheck      (SUM cost_usd hoy < daily_budget_usd_cap)
   │    2. RateLimitCheck   (COUNT auto-resp 1h < policy.rate_limit_per_hour)
   │    3. LoopProtection   (últimos 3 msg thread no son todos agent sin reply humano)
   │    4. Sanitize         (regex inplace, no bloquea)
   │    5. ForbiddenTopics  (regex policy → blocked)
   │    6. EscalateTriggers (regex policy → escalated)
   │    Si bloqueo → AuditLog + STOP
   ├─ AgentRuntime.respond(context)  ← LLM call
   ├─ Si response.metadata.shouldEscalate → AuditLog(decision='escalated') → STOP
   ├─ Según policy.policy:
   │    ├─ 'auto'    → Transport.send(body) → MessageStore.insertOutbound(sent_by='agent')
   │    │              → AuditLog(decision='sent', tokens, cost, latency)
   │    └─ 'suggest' → DraftStore.insert(proposed_body, agent_reasoning)
   │                   → AuditLog(decision='draft')
   └─ JobQueue.enqueue('agent.notes.maybe_update', { contactId, threadId })

--- async, job aparte ---

5. NotesUpdater.maybeUpdate(contactId, threadId):
   ├─ Heurística: msgs_nuevos ≥ 5 OR thread.closed. Si no → STOP silencioso.
   ├─ Throttle: max 1 update/thread/hora.
   ├─ LLM Haiku 4.5 con prompt "actualiza notes o devuelve NO_CHANGE"
   ├─ NO_CHANGE → AuditLog(action='notes_skipped') → STOP
   └─ change → ContactStore.updateNotes + threads.notes_last_updated_at = NOW()
              + AuditLog(action='notes_updated', cost_usd)
```

### 4.4 Idempotencia

pg-boss reintenta jobs fallidos. Para no enviar respuesta dos veces, dos capas:

**Capa 1 — pg-boss `singletonKey`:**
```typescript
await boss.send('agent.respond', { messageId }, { singletonKey: messageId });
```
Garantiza que para un `messageId` dado, solo haya un job activo en la cola en un momento. Si ya está procesándose y se reintenta el webhook, el insert se descarta.

**Capa 2 — check en `audit_log` antes de `Transport.send`:**
```typescript
const prior = await auditLog.find({
  relatedMessageId: ctx.incomingMessage.id,
  decision: ['sent', 'draft'],
});
if (prior) return; // ya respondida en un intento anterior, no re-enviar
```
Usa la columna `audit_log.related_message_id` (ya existe en Phase 0) + `decision` (nueva en Phase 2). Defensa contra el caso "job se ejecutó, mandó el mensaje, falló justo antes de marcar el job como completado, pg-boss reintenta".

DraftStore: si ya hay `draft.status='pending'` para el `message_id` → skip (consulta directa a `drafts` table).

## §5. Memoria

### 5.1 Working memory — `packages/agent-memory/src/working.ts`

```typescript
export class WorkingMemoryBuilder {
  constructor(private messages: MessageStore, private windowSize = 10) {}

  async build(threadId: string): Promise<Message[]> {
    return this.messages.lastN(threadId, this.windowSize);
  }
}
```

- N=10 por defecto. Configurable vía `policy.rules.working_memory_window`.
- Cero coste LLM. SELECT con índice `idx_messages_thread`.
- Inyectado como `<thread_history>` en system prompt.

### 5.2 Episodic memory — `packages/agent-memory/src/episodic.ts`

```typescript
export class EpisodicMemoryBuilder {
  constructor(private contacts: ContactStore) {}

  async build(contactId: string): Promise<string> {
    const c = await this.contacts.get(contactId);
    return c.notes; // "card" narrativa, texto libre
  }
}
```

- Inicialmente vacío. Se popula vía NotesUpdater.
- Inyectado como `<contact_notes>` en system prompt.
- Cap duro de 2000 chars al escribir (en `ContactStore.updateNotes`).

### 5.3 Notes updater — `packages/agent-notes-updater/`

**Trigger:** encolado al final del job `agent.respond`. El job mismo decide si gastar.

**Heurística pre-LLM (sin coste):**
- `msgs_nuevos_desde_ultima_update ≥ 5` OR `thread.closed`
- AND `now - threads.notes_last_updated_at >= 1 hora` (throttle)

**LLM (Haiku 4.5, temperatura 0.2):**
- Prompt corto fuerza JSON con `notes_updated: string | "NO_CHANGE"`.
- Regla "no inventes, solo deduce; preserva info previa cierta; máx 2000 chars".

**Safeguards contra drift:**

| Riesgo | Mitigación |
|---|---|
| Notes crecen sin parar | Cap 2000 chars en prompt + truncar duro en `updateNotes` |
| Alucinación | Haiku + temp 0.2 + prompt "no inventes" |
| Update por cada mensaje (caro) | Heurística 5 msgs nuevos OR thread cerrado |
| NO_CHANGE espurio que cuesta | ~$0.0001/skip con Haiku, auditado |
| PII sensible (tarjetas, claves) | Prompt explícito; classifier regex en Phase 3 |
| Loops update → respuesta → update | Throttle 1 update/thread/hora |

## §6. Guardrails

Todos en `packages/agent-guardrails/`. Cada uno expone `check(ctx) → GuardrailResult` puro.

```typescript
type GuardrailResult =
  | { ok: true }
  | { ok: false; reason: string; escalate?: boolean };
```

### 6.1 Bloque 1 — coste/abuso (pre-LLM)

- **BudgetCheck**: SUM `audit_log.cost_usd` workspace + hoy UTC. Si `spent + 0.01 > daily_budget_usd_cap` → blocked.
- **RateLimitCheck**: COUNT `audit_log` decision IN ('sent','draft') por contacto última hora. Si `>= policy.rate_limit_per_hour` → blocked.

### 6.2 Bloque 2 — caps por respuesta (in-LLM)

No es check separado: `policy.max_tokens_out` y `policy.max_tool_calls` se pasan al SDK Anthropic. Si el modelo se pasa de `max_tool_calls` en su loop interno, el runtime aborta y devuelve `shouldEscalate=true`.

### 6.3 Bloque 3 — defensa básica (pre-LLM, in-memory)

- **ContentSanitizer** (no bloquea, neutraliza):
  ```typescript
  const INJECTION_PATTERNS = [
    /<\s*system\s*>/gi,
    /ignore (previous|all|the) (instructions|prompt|rules)/gi,
    /you are now/gi,
    /\[\[SYSTEM\]\]/gi,
  ];
  ```
- **ForbiddenTopicsCheck**: regex match contra `policy.forbidden_topics_regex` → blocked.
- **EscalateTriggersCheck**: regex match contra `policy.escalate_triggers_regex` → escalated.

Defaults vacíos. Solo lo que añadas explícitamente.

### 6.4 Bloque 4 — loop protection (pre-LLM)

- Cargar `messages.lastN(threadId, 3)`.
- Si los 3 son `direction='outbound' AND sent_by='agent'` sin un `inbound` en medio → blocked, `block_reason='loop_protection'`.

### 6.5 Orden de ejecución

```
1. BudgetCheck            (SUM query)
2. RateLimitCheck         (COUNT query)
3. LoopProtectionCheck    (1 query indexada)
4. ContentSanitizer       (regex in-memory)
5. ForbiddenTopicsCheck   (regex in-memory)
6. EscalateTriggersCheck  (regex in-memory)
--- AgentRuntime.respond() ---
7. ResponseCaps           (config al SDK)
8. SelfEscalateCheck      (post-LLM)
```

Para en el primer bloqueo. Sin invocar LLM si algún check pre-LLM falla.

## §7. Testing strategy

### 7.1 Cobertura por paquete

| Paquete | Unit | Integration | E2E |
|---|---|---|---|
| `agent-runtime` | MockRuntime + ClaudeRuntime con SDK mockeado | ClaudeRuntime contra API Claude real (skippable con `SKIP_LLM_TESTS=1`) | — |
| `agent-memory` | builders contra storage in-memory | contra Supabase de test | — |
| `agent-guardrails` | puros, ~30 tests | — | — |
| `agent-notes-updater` | heurística sin LLM (mock) | con MockRuntime devolviendo NO_CHANGE o texto | — |
| `queue-pgboss` | mock pg-boss | contra Postgres test | — |
| `apps/api` | worker dispatch | worker + queue real + MockRuntime | webhook simulado → cola → MockRuntime → outbound persistido |

**Objetivo:** mantener los ~65 tests actuales + añadir ~80 nuevos = ~145 total. Verde antes de cada release.

### 7.2 Tests críticos obligatorios

1. Policy `silent` → no se encola job, AuditLog no escribe nada.
2. Policy `auto` → job → worker → outbound + `transport.send` llamado.
3. Policy `suggest` → draft creado, NO outbound, NO `transport.send`.
4. Budget cap excedido → `decision='blocked'`, cero LLM call.
5. Rate limit excedido → idem.
6. Loop detected (3 agent outbound seguidos) → idem.
7. Forbidden topic match → blocked + audit.
8. Escalate trigger match → escalated + audit.
9. Self-escalate post-LLM (`shouldEscalate=true`) → escalated.
10. Notes updater: heurística no se cumple → cero LLM, audit silencioso.
11. Notes updater: heurística sí → Haiku, notes actualizadas, audit.
12. Worker crash mid-job → pg-boss reintenta + idempotencia evita double-send.

## §8. Rollout plan — 5 pasos en producción

### Paso 0 — Pre-flight (sin tocar Fly)

- Migration `0003_phase2_agent.sql` aplicada en Supabase. Verificar columnas nuevas.
- pg-boss probado local: schema `pgboss` se crea al boot.
- Fly secrets nuevos: `ANTHROPIC_API_KEY`, `DEFAULT_AGENT_MODEL=claude-sonnet-4-6`, `NOTES_UPDATER_MODEL=claude-haiku-4-5-20251001`, `ENABLE_NOTES_UPDATER=false` (feature flag inicial).

### Paso 1 — Deploy con TODAS las policies en `silent`

- Deploy a `agent-mouth.fly.dev`. Worker arranca, pg-boss arranca, ningún contacto tiene policy ≠ silent.
- Comportamiento idéntico al actual (Phase 1a).
- Validar 24h: webhook responde 200, worker poll sin jobs, sin errores, sin leaks.

### Paso 2 — Activar contacto Gavrilo con `suggest` (intermedio)

- Aunque la decisión final es `auto`, paso intermedio: `suggest` para ver drafts antes de soltar.
- 5-10 drafts en DB revisados manualmente. Si calidad ok → siguiente.

### Paso 3 — Migrar Gavrilo a `auto`

- UPDATE policy a `auto`. Desde aquí @Gavrilux_bot responde.
- Vigilar:
  - `audit_log.cost_usd` — gasto real día
  - `audit_log.latency_ms` — objetivo <8s p95
  - `audit_log.decision` — fracción sent/blocked/escalated
- 48h estable → siguiente.

### Paso 4 — Activar notes updater

- `ENABLE_NOTES_UPDATER=true`. Verificar primer update + revisar 3 primeras notas manualmente.

### Paso 5 — Runbook

- `docs/superpowers/runbooks/2026-05-XX-phase-2-rollout.md` con todo lo de arriba + comandos de troubleshooting (pausar worker, cancelar cola, volver a silent en emergencia).

### Rollback

- Pasos 2-4: `UPDATE policies SET policy='silent'`. Sin redeploy.
- Worker problema: `WORKER_ENABLED=false` + redeploy, o `kill -9` del proceso para reinicio.

## §9. Out of scope (explícito)

| No entra | Por qué | Cuándo |
|---|---|---|
| Semantic memory (pgvector) + `semantic_search` tool | Vision doc lo asigna a Phase 3 | Phase 3 |
| External tool registry (Google Calendar, MemPalace, Linear como tools) | Idem | Phase 3 |
| UI de aprobación de drafts (web, Telegram inline keyboard) | Decisión: SQL hasta Phase 5 | Phase 5 |
| MCP tools de admin (`approve_draft`, `update_policy`, `view_audit`) | Drafts/policies se gestionan vía SQL | Phase 5 (junto con dashboard hosted) |
| Email/WhatsApp/Discord/Slack transports | Phase 1b (Email) o Phase 4 (resto) | Phase 1b / 4 |
| Worker en VM Fly separada | Enfoque C rechazado por sobrecarga ops | Phase 5 si hace falta escalar |
| Multi-language detection explícita + preferencia per-contact (Vision doc Q5) | Fuera por scope; Sonnet 4.6 responde nativamente en el idioma del incoming sin lógica extra. Si hace falta forzar idioma, se mete en `policy.system_prompt` manualmente. | Phase 3 si hay demanda |
| Forbidden topics con classifier LLM (no regex) | Sobrecoste no justificado para dogfooding | Phase 3+ |
| Streaming responses | Telegram no lo soporta nativo; con `editMessageText` se podría simular en Phase 4+ | Phase 4+ |

## §10. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| ClaudeRuntime no devuelve JSON válido | Media | Alto (parse error → crash worker) | Tool-use forzado + try/parse con fallback a `shouldEscalate=true` + audit |
| pg-boss schema choca con algo en Supabase | Baja | Medio | Probar primero en proyecto Supabase de test antes de migración prod |
| Worker en mismo proceso satura webhook bajo carga LLM | Media | Alto | Pool de concurrency = 2 inicialmente. Monitor p95. Si duele → Enfoque C |
| Notes updater alucina y mete basura en `contact.notes` | Media | Medio | Cap 2000 chars + Haiku + revisión manual primeros 3 updates + rollback trivial (`UPDATE notes=''`) |
| Loop protection trigger falso (3 mensajes legítimos del agente con preguntas) | Baja | Bajo | Es un blocker, no destructivo. El humano lee `block_reason` y ajusta policy si pasa |
| Cost runaway por bug | Baja | Alto | `daily_budget_usd_cap=$5` por defecto. Alarma manual diaria revisando audit_log |
| pg-boss pierde jobs en restart | Muy baja | Bajo | pg-boss persiste en Postgres; idempotencia por message_id evita re-send |
| Idempotencia falla (double-send) | Baja | Medio | Check explícito antes de send + tests integración 12 cubre |

## §11. Métricas de éxito

Al cerrar Phase 2 (post-rollout estable 1 semana):

- ✅ ≥80% de invocaciones del agente completan en <8s p95 (latency_ms)
- ✅ Coste medio por respuesta <$0.05 (tokens × Sonnet pricing)
- ✅ Cero double-sends (idempotencia funciona)
- ✅ 0 incidentes de budget runaway
- ✅ ≥1 actualización de `contact.notes` válida (validada manualmente)
- ✅ Tests verdes (~145 total)
- ✅ Rollback probado: silent → auto → silent sin downtime

## §12. Open questions (no bloqueantes)

| # | Pregunta | A resolver en |
|---|---|---|
| 1 | ¿Concurrency del worker = 2 o configurable per Fly machine size? | Implementación |
| 2 | ¿Polling interval de pg-boss = 1s default o más agresivo? | Implementación, ajustar con datos |
| 3 | ¿System prompt template global o per-policy desde el inicio? Phase 2 asume per-policy (`policies.system_prompt`) pero default vacío | Implementación |
| 4 | ¿Notes updater corre como job pg-boss separado o thread dentro del worker `agent.respond`? Spec sugiere job separado | Implementación |
| 5 | Confidence threshold para self-escalate (`metadata.confidence < ?` → escalate auto). Phase 2 deja siempre `false` desde el modelo, decisión humana | Phase 3 |

## §13. Referencias

- Vision doc: [2026-05-20-agent-mouth-vision-design.md](2026-05-20-agent-mouth-vision-design.md) §5 (Agent Autonomy Model) y §6 (Phase 2 row).
- Phase 1a plan: [../plans/2026-05-20-agent-mouth-phase-1a-telegram-routing.md](../plans/2026-05-20-agent-mouth-phase-1a-telegram-routing.md).
- Runbook Phase 1a cutover: [../runbooks/2026-05-20-phase-1a-webhook-cutover.md](../runbooks/2026-05-20-phase-1a-webhook-cutover.md).
- Schema actual: [`packages/storage-postgres/sql/0001_initial.sql`](../../../packages/storage-postgres/sql/0001_initial.sql), `storage-supabase/sql/0002_apply_phase0_schema.sql`.
- pg-boss: https://github.com/timgit/pg-boss
- Anthropic SDK: `@anthropic-ai/sdk` >=0.30
