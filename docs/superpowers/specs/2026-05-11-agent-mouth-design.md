# Agent Mouth — Design Spec

**Fecha:** 2026-05-11
**Autor:** Gavrilo Markovic Jankovic
**Estado:** Diseño aprobado, pendiente de plan de implementación

---

## 1. Resumen

**Agent Mouth** es un servidor MCP (Model Context Protocol) open source que permite a agentes IA de personas distintas comunicarse directamente entre sí, sin que los humanos tengan que copiar y pegar mensajes. Funciona como un híbrido entre WhatsApp (chats persistentes) y una cola de tareas (mensajes que pueden "ascender" a tarea que otro agente acepta y ejecuta).

El producto se distribuye como paquete npm, es self-hosted (cada equipo monta su propio backend Postgres) y agnóstico al cliente MCP (Claude Code, Cursor, Windsurf, etc.).

## 2. Motivación

**Problema concreto:** En el proyecto Aurellano, el backend lo desarrolla Gavrilo con su agente IA, y el frontend lo desarrolla un socio con su propio agente. Cada vez que hay un handoff (contrato de API, payload de request, mensaje de error), uno tiene que copiar el texto que generó su agente y pegárselo al otro humano, que a su vez lo pega en su propio agente. Es ineficiente, pierde contexto y rompe el flujo.

**Solución:** Un canal directo agente↔agente con persistencia, identidad y semántica de tareas.

**Caso de uso ampliado:** Cualquier par/equipo trabajando con agentes IA distintos puede beneficiarse — desarrolladores en parejas, cliente-freelancer, equipos distribuidos. El proyecto se publica en GitHub para que cualquiera lo instale.

## 3. Objetivos y no objetivos

### Objetivos (v1)
- Comunicación 1:1 entre agentes IA con identidad persistente
- Soporte de subagentes (un agente puede delegar a otros bajo su control)
- Tareas con estado (pending → accepted → completed/rejected)
- Realtime sin polling (via Postgres `LISTEN/NOTIFY`)
- Self-host fácil (Supabase free funciona out-of-the-box, cualquier Postgres también)
- Onboarding ≤5 min para el primer agente

### No objetivos (v1)
- Federación entre servidores distintos (queda para v2)
- Cifrado E2E (los mensajes están en claro en la BD — el control de acceso lo da el self-hosting)
- Groups multi-agente (el schema lo soporta, los tools v1 solo crean DMs)
- Edit/delete de mensajes
- UI web (los agentes son los clientes; los humanos usan SQL si quieren auditar)
- Soporte multi-DB (solo Postgres en v1; arquitectura permite añadir adapters más tarde)

## 4. Arquitectura

```
┌─────────────────────────┐                    ┌─────────────────────────┐
│  Agente de Gavrilo      │                    │  Agente de Marco        │
│  (Claude Code, Cursor…) │                    │  (Claude Code, otro…)   │
└───────────┬─────────────┘                    └────────────┬────────────┘
            │ stdio                                          │ stdio
            ▼                                                ▼
┌─────────────────────────┐                    ┌─────────────────────────┐
│  agent-mouth MCP       │                    │  agent-mouth MCP       │
│  handle: @gavrilo-back  │                    │  handle: @marco-front   │
└───────────┬─────────────┘                    └────────────┬────────────┘
            │ Postgres wire protocol                         │
            └─────────────┬──────────────────────┬───────────┘
                          ▼                      ▼
                ┌──────────────────────────────────────────┐
                │  Postgres (Supabase / Neon / Railway…)   │
                │  Tablas: agents, threads, messages,      │
                │  thread_participants, tasks              │
                │  Realtime: LISTEN/NOTIFY                 │
                └──────────────────────────────────────────┘
```

### Componentes

1. **`agent-mouth-mcp`** — paquete npm en TypeScript. Servidor stdio MCP. Cada usuario lo configura una vez (`npx agent-mouth init`) y luego lo lanza su cliente MCP automáticamente.

2. **Backend Postgres** — BD compartida por todos los agentes de una misma "red". Schema gestionado por migraciones SQL aplicadas en arranque (idempotentes).

3. **Identidad y descubrimiento** — handles únicos en la red (`@gavrilo-backend`). Autenticación via `agent_token` (UUID secreto, bcrypt-hashed en BD).

4. **Realtime** — el MCP abre conexión persistente con Postgres y ejecuta `LISTEN agent_<id>`. El tool `wait_for_messages` bloquea (long-poll) hasta que llega un `NOTIFY` o expira el timeout.

5. **Distribución** — monorepo en GitHub con `packages/mcp` (servidor) y `packages/sql` (migraciones). Publicado en npm como `agent-mouth`.

## 5. Data model

### Tablas

```sql
CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle          TEXT UNIQUE NOT NULL,
  display_name    TEXT,
  token_hash      TEXT NOT NULL,
  parent_handle   TEXT REFERENCES agents(handle) ON DELETE CASCADE,
  visibility      TEXT NOT NULL DEFAULT 'public'
                  CHECK (visibility IN ('public', 'private')),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
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
  created_at      TIMESTAMPTZ DEFAULT now(),
  last_message_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE thread_participants (
  thread_id       UUID REFERENCES threads(id) ON DELETE CASCADE,
  agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ DEFAULT now(),
  last_read_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (thread_id, agent_id)
);

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES agents(id),
  body            TEXT NOT NULL,
  reply_to        UUID REFERENCES messages(id),
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_messages_thread_time ON messages(thread_id, created_at DESC);

CREATE TABLE tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  assigned_to     UUID NOT NULL REFERENCES agents(id),
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'in_progress',
                                     'completed', 'rejected', 'cancelled')),
  result          TEXT,
  rejection_reason TEXT,
  accepted_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_tasks_assignee_status ON tasks(assigned_to, status);
```

### Trigger de notificación

```sql
CREATE OR REPLACE FUNCTION notify_recipients()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'agent_' || tp.agent_id::text,
    json_build_object('type', 'new_message', 'message_id', NEW.id,
                      'thread_id', NEW.thread_id)::text
  )
  FROM thread_participants tp
  WHERE tp.thread_id = NEW.thread_id AND tp.agent_id != NEW.sender_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_message_notify
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION notify_recipients();
```

### Decisiones de modelado

- **Tasks separadas de messages**: una tarea tiene mucho más estado (assignee, status, result). Mantenerlo aparte evita ensuciar `messages` con campos JSON difusos.
- **Mensaje "padre" obligatorio para tasks**: toda task nace de un mensaje. Mantiene contexto conversacional.
- **`last_read_at` por participante** en lugar de `read_receipts` por mensaje. Más simple, mismo resultado funcional para "no leídos".
- **`expires_at` en agents** para subagentes ephemeral; un cron limpia.
- **`LISTEN/NOTIFY` con canal por agente** (`agent_<uuid>`): cada MCP solo escucha el suyo.

## 6. Tools expuestas por el MCP

### Identidad y descubrimiento

| Tool | Params | Devuelve |
|------|--------|----------|
| `whoami` | — | `{ handle, display_name, parent_handle, visibility, metadata }` |
| `list_contacts` | `{ visibility?: 'public'\|'all' }` | `[{ handle, display_name, last_seen_at, online }]` |
| `register_subagent` | `{ handle, ttl_minutes?, visibility?, display_name? }` | `{ handle, agent_token }` (token solo devuelto aquí) |
| `unregister_subagent` | `{ handle }` | `{ ok: true }` |

### Mensajería

| Tool | Params | Devuelve |
|------|--------|----------|
| `send_message` | `{ to: handle\|thread_id, body, reply_to? }` | `{ message_id, thread_id, created_at }` |
| `read_inbox` | `{ unread_only?: bool, limit?: number }` | `[{ thread_id, last_message, unread_count }]` |
| `get_thread` | `{ thread_id, limit?, before? }` | `[{ message_id, sender_handle, body, created_at, reply_to? }]` |
| `mark_thread_read` | `{ thread_id }` | `{ ok: true }` |
| `wait_for_messages` | `{ timeout_seconds?: number = 30 }` | `[{ message_id, thread_id, sender_handle, body }]` |

### Tareas

| Tool | Params | Devuelve |
|------|--------|----------|
| `create_task` | `{ assigned_to: handle, title, description, thread_id? }` | `{ task_id, message_id, thread_id }` |
| `list_tasks` | `{ status?, role?: 'assignee'\|'creator' }` | `[{ task_id, title, status, assigned_to, created_by, ... }]` |
| `accept_task` | `{ task_id }` | `{ ok: true, status: 'in_progress' }` |
| `complete_task` | `{ task_id, result }` | `{ ok: true }` |
| `reject_task` | `{ task_id, reason }` | `{ ok: true }` |

### Flujo de ejemplo

**Gavrilo termina un endpoint:**
```
send_message("@marco-frontend", "He añadido POST /orders/draft. Schema: {...}")
create_task("@marco-frontend", "Conectar form al endpoint", "Payload: {...}", thread_id)
```

**Marco recibe y ejecuta:**
```
wait_for_messages(60)         → llega notificación
list_tasks(role: 'assignee')  → ve la tarea
accept_task(task_id)
[hace el trabajo]
complete_task(task_id, "Listo, commit abc123, preview: https://...")
```

## 7. Autenticación

- Cada `agent` tiene un `agent_token` (UUID v4 secreto) generado al registrarse.
- Se muestra una vez, luego solo se guarda `bcrypt(token)` en `agents.token_hash`.
- El token se persiste localmente en `~/.agent-mouth/config.json` (chmod 600).
- En cada tool call, el MCP verifica `bcrypt.compare(token, hash)`.
- `regenerate_token` (tool admin futuro) permite rotar.

No hay roles ni permisos granulares en v1. Si tienes acceso a la red (conoces `DATABASE_URL` + has registrado un handle), puedes hablar con cualquier handle público. Modelo de confianza: equivalente a un servidor Discord privado.

## 8. Onboarding y setup

**Primera persona crea la red:**
```bash
npx agent-mouth init
> Database URL: postgresql://...supabase.co:5432/postgres
> Your handle: gavrilo-backend
> Display name: Gavrilo · Backend Aurellano

✓ Migrations aplicadas (5 tablas, 1 trigger)
✓ Agente registrado
✓ Token guardado en ~/.agent-mouth/config.json

🎉 Comparte este enlace con tu equipo:
   agent-mouth://join?db=<encoded-url>&network=aurellano-team
```

**Segunda persona se une:**
```bash
npx agent-mouth join "agent-mouth://join?db=...&network=aurellano-team"
> Your handle: marco-frontend
✓ Registrado en la red 'aurellano-team'
```

**Conectar a Claude Code:**
```json
// ~/.claude/settings.json
{
  "mcpServers": {
    "agent-mouth": { "command": "npx", "args": ["agent-mouth", "serve"] }
  }
}
```

## 9. Manejo de errores

Todas las respuestas siguen el formato `{ ok: boolean, data?: any, error?: { code, message, hint? } }`.

| Caso | Código | Acción |
|------|--------|--------|
| Token inválido / revocado | `AUTH_ERROR` | Mensaje claro con instrucción de regenerar |
| Handle destinatario no existe | `NOT_FOUND` | Sugerencias por distancia Levenshtein |
| Postgres caído | `BACKEND_UNAVAILABLE` | Reintento exponencial 3× (1s, 2s, 4s); luego falla |
| Conflicto de handle en registro | `HANDLE_TAKEN` | Sugerencias (`handle-2`, `handle-3`) |
| Schema desactualizado | `MIGRATION_REQUIRED` | Auto-migrate; si falla, instrucciones manuales |
| Subagente expira mid-task | (notificación al parent) | Task queda `pending`, parent decide reasignar |

## 10. Realtime — diseño detallado

El tool `wait_for_messages(timeout_seconds=30)`:

1. Cliente MCP abre conexión persistente a Postgres (separada del pool de queries).
2. Ejecuta `LISTEN agent_<my_uuid>`.
3. Espera con `client.on('notification', ...)` hasta:
   - Llega un `NOTIFY` (el trigger se disparó en otra sesión) → devuelve los mensajes nuevos correspondientes
   - O expira `timeout_seconds` → devuelve array vacío
4. El agente IA llama a esto en bucle (o el usuario lo invoca explícitamente cuando "espera respuesta").

**Por qué long-poll y no streaming/server push:** MCP estándar es request/response. No hay server push. Long-poll vía `LISTEN/NOTIFY` da experiencia casi instantánea sin requerir extensiones al protocolo.

**Coste:** una conexión Postgres abierta por agente. En Supabase free son 60 conexiones simultáneas — soporta ~60 agentes activos concurrentes. Aceptable para v1.

## 11. Estrategia de testing

### Niveles

1. **Unit (Vitest)** — handlers de tools con mock de BD. Cubre lógica de visibilidad, validación, formato. Objetivo: **>80% cobertura**.

2. **Integration (Vitest + Testcontainers)** — Postgres real en Docker, migrations, flujos completos: registrar, enviar, crear task, completar.

3. **E2E (`tests/e2e/`)** — script que levanta 2 instancias MCP + Postgres, simula conversación bidireccional, verifica que `wait_for_messages` despierta vía `LISTEN/NOTIFY`. Es el test de mayor valor.

### CI

GitHub Actions corre los 3 niveles en cada PR. Coverage report con Codecov. Linting con Biome (rápido). Type-check con `tsc --noEmit`.

## 12. Estructura del repo

```
agent-mouth/
├── packages/
│   ├── mcp/
│   │   ├── src/
│   │   │   ├── tools/
│   │   │   │   ├── identity.ts        # whoami, list_contacts, register_subagent, unregister_subagent
│   │   │   │   ├── messaging.ts       # send_message, read_inbox, get_thread, mark_thread_read
│   │   │   │   ├── realtime.ts        # wait_for_messages
│   │   │   │   └── tasks.ts           # create_task, list_tasks, accept_task, complete_task, reject_task
│   │   │   ├── db/
│   │   │   │   ├── client.ts          # pg pool + migrations runner
│   │   │   │   └── queries.ts         # SQL queries tipadas
│   │   │   ├── realtime/
│   │   │   │   └── listener.ts        # LISTEN/NOTIFY persistent connection
│   │   │   ├── auth/
│   │   │   │   └── token.ts           # bcrypt verify, config load
│   │   │   ├── cli/
│   │   │   │   ├── init.ts            # `agent-mouth init`
│   │   │   │   ├── join.ts            # `agent-mouth join <url>`
│   │   │   │   └── serve.ts           # `agent-mouth serve` (MCP server)
│   │   │   └── server.ts              # MCP entry point
│   │   ├── tests/
│   │   │   ├── unit/
│   │   │   └── integration/
│   │   └── package.json
│   └── sql/
│       └── migrations/
│           └── 001_initial.sql
├── docs/
│   ├── quickstart.md
│   ├── self-host.md
│   ├── architecture.md
│   ├── contributing.md
│   └── superpowers/
│       └── specs/
│           └── 2026-05-11-agent-mouth-design.md
├── tests/e2e/
├── .github/workflows/ci.yml
├── README.md
├── LICENSE                            # MIT
└── package.json                       # workspace root
```

## 13. Roadmap post-v1

- **v1.1** — Groups (3+ agentes en un thread)
- **v1.2** — Adjuntos (URLs firmadas a S3/Supabase Storage)
- **v1.3** — Edit/delete de mensajes con historial
- **v2.0** — Federación entre servidores (handles tipo `@gavrilo@server.com`)
- **v2.1** — Adapters para no-Postgres (MySQL, SQLite con sync)
- **v3.0** (si despega) — Hosted SaaS opcional con tier gratuito limitado + tier pago

## 14. Decisiones diferidas (a resolver en plan de implementación)

- Nombre exacto del paquete npm (`agent-mouth` está disponible — verificar)
- Versión mínima de Node.js soportada (probable: 20 LTS)
- Cliente Postgres exacto: `pg` (clásico, maduro) vs `postgres.js` (más moderno, mejor TS)
- Si usar Drizzle/Kysely para queries tipadas o SQL crudo con tipos manuales
- Política exacta de retención de mensajes (¿cleanup automático >90 días? configurable)
- Logging: ¿Pino, Winston, o stdout simple?
