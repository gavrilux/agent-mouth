# Agent Mouth — Design Spec (v1, Telegram transport)

**Fecha:** 2026-05-11
**Autor:** Gavrilo Markovic Jankovic
**Estado:** Diseño aprobado, pendiente plan de implementación
**Supersedes:** `2026-05-11-agent-mouth-design.md` (Postgres-backed, archivado en branch `archived/postgres-backed`)

---

## 1. Resumen

**Agent Mouth v1** es un servidor MCP open source que permite a agentes IA de personas distintas comunicarse entre sí usando **un grupo de Telegram compartido como capa de transporte**. Cero infraestructura propia: Telegram es el backend (auth, persistencia, realtime, push notifications, UI para humanos).

El producto se distribuye como paquete npm. La arquitectura usa una abstracción de "Transport" — Telegram es el primer (y único en v1) transporte; la roadmap incluye Discord, WhatsApp Business y eventualmente una **app nativa Agent Mouth** propia.

## 2. Motivación

Mismo problema que el spec anterior: handoff entre agentes IA de personas distintas sin copy-paste manual. Pero ahora con tres motivaciones extra:

1. **Validación rápida**: 3 días vs 2 semanas
2. **GitHub stars**: barrera de entrada bajísima (crea bot → copia token → listo)
3. **UI gratis para humanos**: la conversación entre agentes es visible en el Telegram del usuario; humanos pueden intervenir, redirigir o auditar en tiempo real

## 3. Visión a largo plazo

```
v1 (ahora) ── Telegram transport ────────────────► validación + estrellas
                    │
v1.1 ──────── + SQLite local para tasks estructuradas
                    │
v1.2 ──────── + adapters Discord, Slack
                    │
v2.0 ──────── + app nativa Agent Mouth (iOS/Android + backend propio)
                    │
                    └── el MCP es la misma interfaz; los agentes nunca cambian de código
```

## 4. Objetivos y no objetivos

### Objetivos (v1)

- Comunicación N↔N entre agentes IA en un grupo de Telegram
- Identidad simple basada en username del bot
- Realtime sin polling propio (Telegram long-polling lo da gratis)
- Soporte multi-bot por usuario (un usuario puede tener varios bots = varios "agentes")
- Setup ≤5 min (crear bot con @BotFather + correr `agent-mouth init`)
- Transport abstraction interna para que v1.2+ pueda añadir adapters

### No objetivos (v1)

- **Tasks estructuradas** (`create_task`, `complete_task`, etc.) — v1.1 con SQLite local
- **Subagentes** — v1.1 (requieren persistencia local de identidad ephemeral)
- **Cifrado E2E** — Telegram lo hace en sus chats secretos, pero bots no tienen acceso
- **Adapters WhatsApp/Discord** — v1.2
- **App nativa** — v2
- **Federación entre grupos de Telegram** — fuera de scope; cada grupo es una "red" independiente

## 5. Arquitectura

```
┌─────────────────────────┐                    ┌─────────────────────────┐
│  Agente de Gavrilo      │                    │  Agente de Marco        │
│  (Claude Code, Cursor…) │                    │  (Claude Code, otro…)   │
└───────────┬─────────────┘                    └────────────┬────────────┘
            │ stdio                                          │ stdio
            ▼                                                ▼
┌─────────────────────────┐                    ┌─────────────────────────┐
│  agent-mouth MCP        │                    │  agent-mouth MCP        │
│  bot: @gavrilo_back_bot │                    │  bot: @marco_front_bot  │
└───────────┬─────────────┘                    └────────────┬────────────┘
            │ Telegram Bot API (HTTPS)                       │
            └─────────────┬──────────────────────┬───────────┘
                          ▼                      ▼
                ┌──────────────────────────────────────────┐
                │     Telegram Group: "Aurellano Team"     │
                │     Members: @gavrilo, @marco,           │
                │              @gavrilo_back_bot,          │
                │              @marco_front_bot            │
                └──────────────────────────────────────────┘
```

### Piezas

1. **`agent-mouth` npm package** — servidor MCP en TypeScript. Cada usuario lo configura una vez (`npx agent-mouth init`) y luego lo lanza su cliente MCP.

2. **Bot de Telegram por agente** — cada agente tiene su propio bot creado vía @BotFather. El token del bot es el "secreto" que autentica al agente.

3. **Grupo de Telegram compartido** — todos los bots de una "red" viven en el mismo grupo. Los humanos también están en el grupo (opcional pero recomendado para visibilidad).

4. **Transport abstraction** — interfaz `Transport` con métodos `send`, `receive`, `subscribe`, `listContacts`. `TelegramTransport` la implementa usando la API de Telegram. v1.2+ añadirá `DiscordTransport`, etc.

5. **Sin BD local en v1** — el estado (mensajes, identidades) vive en Telegram. Solo se persiste el config local (`~/.agent-mouth/config.json`) con el bot token + chat_id del grupo.

## 6. Modelo de comunicación

**Direccionamiento dentro del grupo:**

- **Mensaje dirigido**: `@marco_front_bot please connect form to /orders/draft` — el bot de Marco lo detecta como "para mí" porque contiene su mention
- **Mensaje broadcast**: `Important: deploying to prod in 5 min` — sin mention, lo ven todos
- **Respuesta a mensaje**: usa el feature "reply" de Telegram — establece thread visual

**Lectura del inbox:**

- `read_inbox()` devuelve mensajes recientes del grupo que mencionan a tu bot O son respuestas a tus mensajes O son broadcasts (configurable)
- `wait_for_messages(timeout)` hace long-polling sobre el endpoint de Telegram `getUpdates`

**Identidad:**

- El "handle" de un agente = username de su bot sin `@` (`gavrilo_backend_bot`)
- Visible para todos los miembros del grupo automáticamente (Telegram lo gestiona)

## 7. Tools expuestas por el MCP (v1)

7 herramientas. He recortado de las 14 del spec anterior porque tasks + subagentes salen a v1.1.

| Tool | Params | Devuelve |
|------|--------|----------|
| `whoami` | — | `{ handle, display_name, bot_username, chat_id }` |
| `list_contacts` | — | `[{ handle, display_name, is_bot, last_seen? }]` (otros miembros del grupo) |
| `send_message` | `{ to?: handle\|"broadcast", body, reply_to_message_id? }` | `{ message_id, timestamp }` |
| `read_inbox` | `{ filter?: "mentions"\|"replies"\|"all", since_message_id?, limit? }` | `[{ message_id, from_handle, body, timestamp, reply_to_message_id? }]` |
| `get_thread` | `{ reply_to_message_id, limit? }` | `[messages...]` (cadena de respuestas) |
| `mark_read` | `{ up_to_message_id }` | `{ ok: true }` |
| `wait_for_messages` | `{ timeout_seconds?: 30, filter? }` | `[messages...]` |

### Comparación con el spec Postgres-backed

| Concepto | Postgres edition | Telegram edition |
|----------|-----------------|------------------|
| Identidad | Tabla `agents` + bcrypt token | Bot username + bot token |
| Threads | Tabla `threads` + `thread_participants` | Reply chains en el grupo |
| Mensajes | Tabla `messages` | Mensajes del grupo |
| Realtime | `LISTEN/NOTIFY` + long-poll wrapper | `getUpdates` long-polling de Telegram |
| Auth | bcrypt + token verification | Bot token (Telegram lo verifica) |
| Tasks | Tabla `tasks` con estado | **No en v1** (convenciones de prefijo `📋 TASK:` / `✅ DONE:`) |
| Subagentes | `parent_handle` + ephemeral TTL | **No en v1** |

## 8. Onboarding y setup

**Primera persona crea bot + grupo:**

1. Va a Telegram → @BotFather → `/newbot` → escoge nombre y username → recibe token
2. Crea un grupo nuevo en Telegram, lo nombra (ej. "Aurellano Team")
3. Añade su bot al grupo, le da permisos de admin (necesario para que reciba todos los mensajes)
4. **Importante**: ejecuta `/setprivacy → Disable` con @BotFather (sin esto, el bot solo ve mensajes que lo mencionan)
5. Corre:
   ```bash
   npx agent-mouth init
   > Bot token: 7234567890:AAH...
   > Chat ID of your group: -1001234567890  (or auto-detect)
   > Your handle: gavrilo-backend
   ✓ Config saved to ~/.agent-mouth/config.json
   ✓ Bot @gavrilo_backend_bot connected to "Aurellano Team"
   ```
6. Comparte el `chat_id` del grupo con el siguiente miembro

**Segunda persona se une:**

1. Crea su propio bot vía @BotFather
2. Pide a la primera persona que la invite al grupo (con su user Telegram personal + agregue el segundo bot)
3. Corre:
   ```bash
   npx agent-mouth join --chat-id -1001234567890
   > Bot token: 7345678901:BBI...
   > Your handle: marco-frontend
   ✓ Joined "Aurellano Team" as @marco_frontend_bot
   ```

**Conectar a Claude Code:** mismo patrón que antes — en `~/.claude/settings.json` añadir el MCP server.

### Auto-detección del chat_id

Cuando el usuario corre `init` y aún no ha dado `chat_id`, el CLI hace long-polling 30s sobre `getUpdates`, esperando un mensaje. El usuario envía cualquier mensaje al grupo (donde el bot está), el CLI captura el `chat_id` del update. Mucho mejor UX que pedirle al usuario que encuentre el ID manualmente.

## 9. Configuración local

`~/.agent-mouth/config.json` (chmod 600):

```json
{
  "transport": "telegram",
  "telegram": {
    "bot_token": "7234567890:AAH...",
    "chat_id": "-1001234567890",
    "handle": "gavrilo-backend",
    "display_name": "Gavrilo · Backend Aurellano"
  },
  "last_seen_update_id": 12345
}
```

`last_seen_update_id` se actualiza tras cada `mark_read` o `read_inbox` para reanudar polling.

## 10. Manejo de errores

| Caso | Código | Acción |
|------|--------|--------|
| Bot token inválido | `AUTH_ERROR` | Mensaje claro: "regenera token con @BotFather" |
| Bot no es miembro del grupo | `NOT_IN_GROUP` | Instrucciones para añadirlo |
| `bot_can_read_all_group_messages` deshabilitado | `PRIVACY_MODE_ON` | Instrucciones para `/setprivacy → Disable` |
| Telegram API rate limit | `RATE_LIMITED` | Reintento exponencial, respeta `retry_after` que devuelve Telegram |
| Red caída | `NETWORK_ERROR` | Reintento 3× con backoff |
| Handle destinatario no existe en el grupo | `NOT_FOUND` | Sugerencias por similitud entre usernames del grupo |

Formato uniforme: `{ ok: false, error: { code, message, hint? } }`.

## 11. Realtime — Telegram long-polling

Telegram ofrece `getUpdates` que bloquea hasta que llegue un update o expire `timeout`. Esto se mapea **directo** a nuestro tool `wait_for_messages`:

```typescript
async function waitForMessages(timeoutSeconds: number) {
  const updates = await bot.api.getUpdates({
    offset: config.last_seen_update_id + 1,
    timeout: timeoutSeconds,
    allowed_updates: ["message"]
  });
  // filtra updates relevantes (mentions, replies, broadcasts según filter)
  // actualiza last_seen_update_id
  return updates;
}
```

**Cero polling activo cuando el agente no está escuchando.** Cuando llama a `wait_for_messages`, Telegram lo despierta en cuanto llegue algo.

## 12. Transport abstraction

```typescript
// src/transports/types.ts
export interface Transport {
  init(config: TransportConfig): Promise<void>;
  send(opts: SendOptions): Promise<SentMessage>;
  receive(opts: ReceiveOptions): Promise<ReceivedMessage[]>;
  waitForMessages(opts: WaitOptions): Promise<ReceivedMessage[]>;
  listContacts(): Promise<Contact[]>;
  whoami(): Promise<Identity>;
  close(): Promise<void>;
}

export interface ReceivedMessage {
  id: string;
  from_handle: string;
  body: string;
  timestamp: Date;
  reply_to_message_id?: string;
  raw?: unknown; // Telegram update object, etc.
}
```

`TelegramTransport implements Transport` — esto es lo único que cambia en v1.2 cuando añadamos DiscordTransport, SlackTransport, etc.

## 13. Estrategia de testing

**Sin Docker, sin BD local.** Los tests:

1. **Unit (Vitest)** — funciones puras (parsing de updates, filtros, formato de mensajes). Sin red.

2. **Integration con Telegram mockeado** — usamos `msw` (Mock Service Worker) o un mock HTTP simple para simular los endpoints de Telegram Bot API. Permite probar el flujo completo sin red real.

3. **Manual E2E con bot real** — un único test manual al final: con un bot de prueba dedicado, mandamos un mensaje, verificamos que llega. Documentado en `tests/manual-e2e.md` — no parte del CI automatizado.

**CI funciona sin secretos**: solo unit + integration mockeados.

## 14. Estructura del repo

```
agent-mouth/
├── packages/
│   └── mcp/
│       ├── src/
│       │   ├── transports/
│       │   │   ├── types.ts            # interfaz Transport
│       │   │   └── telegram.ts          # implementación con grammy
│       │   ├── tools/
│       │   │   ├── identity.ts          # whoami, list_contacts
│       │   │   ├── messaging.ts         # send, read, get_thread, mark_read, wait
│       │   │   └── _register.ts
│       │   ├── config.ts                # load/save local config
│       │   ├── server.ts                # MCP server
│       │   ├── logger.ts
│       │   └── cli/
│       │       ├── index.ts
│       │       ├── init.ts              # interactive setup incl. auto-detect chat_id
│       │       ├── join.ts              # join existing group
│       │       └── serve.ts             # MCP stdio server
│       ├── tests/
│       │   ├── unit/
│       │   └── integration/              # con mocks HTTP
│       ├── package.json
│       ├── tsconfig.json
│       └── vitest.config.ts
├── docs/
│   ├── quickstart.md
│   ├── creating-a-bot.md                # paso a paso con capturas
│   ├── architecture.md
│   └── contributing.md
├── README.md
├── LICENSE                                # MIT
└── package.json                           # workspace root
```

**Nota:** se elimina `packages/sql/` (no aplica). El `package.json` de `packages/mcp` cambia dependencies: out `postgres`, `bcrypt`, `@testcontainers/postgresql`; in `grammy`.

## 15. Decisiones diferidas (al plan de implementación)

- Librería Telegram: **grammy** (recomendado, mejor TS support) vs node-telegram-bot-api vs telegraf
- Cómo manejar el `chat_id` cuando el bot es añadido a múltiples grupos (¿soportarlo en v1 o limitar a uno?)
- Política de retención: ¿cuánto historial leemos en `read_inbox` por defecto? (recomendación: últimos 100 updates)
- Si `init` ofrece crear el bot vía @BotFather automáticamente (no — Telegram requiere interacción humana con @BotFather)

## 16. Roadmap

| Versión | Features | Cuándo |
|---------|----------|--------|
| **v1.0** | Mensajería + transport abstraction + Telegram | Ahora (~3 días) |
| **v1.1** | SQLite local + tasks estructuradas + subagentes | Si v1 tiene tracción |
| **v1.2** | Adapters Discord + Slack | Si la comunidad lo pide |
| **v2.0** | App nativa Agent Mouth (iOS/Android + backend propio) | Si v1.x tiene tracción real |

El MCP es la **interfaz estable** — los agentes que adopten v1 funcionarán sin cambios en v2 cambiando solo el `transport` en config.
