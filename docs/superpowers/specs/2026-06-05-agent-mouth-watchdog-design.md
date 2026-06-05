# Agent Mouth — Watchdog de auto-vigilancia (v1) · Design

- **Fecha:** 2026-06-05
- **Estado:** aprobado (brainstorming) — pendiente de plan de implementación
- **Autor:** Gavrilo + Claude
- **Relacionado:** decisión `03-Decisiones/2026-06-03-agent-mouth-canales-email-workspace-internal` (Cerebro Digital); `email-reauth.ts` (re-auth de 1 clic, commit `b4f67ca`); `worker.ts` `runPhase3HealthCheck` (health-check Phase 3).

## 1. Contexto y problema

El agente (Gavrilux) habla por **Telegram + Email + WhatsApp** (Phase 4a LIVE desde 2026-06-03). El punto débil es operativo, no de producto: **fallos silenciosos de entrada**. El más conocido es el email — el OAuth de Google está en modo *Testing*, así que el refresh token caduca cada ~7 días; cuando cae, el agente deja de **oír** por email y **nadie se entera** hasta días después.

Dos piezas que **ya existen** y hoy no están conectadas:

1. **Re-auth de 1 clic** (`email-reauth.ts`): `GET /email-oauth-start?token=<AUTH>` → consent Google → `GET /email-oauth-callback` renueva refresh token + watch en el servidor, sin secrets locales. La *cura* ya existe.
2. **Health-check con alerta a Telegram** (`runPhase3HealthCheck`, cron diario 7:00 UTC): ya vigila error-ratio / coste / latencia / staleness del knowledge-sync y **ya envía** alertas vía `transport.send({ to, body })`.

**El gap:** nada detecta que el email (u otro canal de entrada) se ha caído, así que nadie te dice "usa el link de re-auth". Este spec cierra ese lazo y generaliza el patrón a otros fallos silenciosos de **recepción** y de **recurso**.

> **No** es un agente LLM nuevo. Es observabilidad determinista (cron + checks + alerta). El "agente" del replanteo AI-First = poner una rutina a vigilar lo que hoy vigila la memoria de un humano.

## 2. Objetivos / No-objetivos

**Objetivos (v1):**
- Detectar **email inbound caído** y alertar con el link de re-auth de 1 clic ya existente — **proactivamente** (antes de que caiga del todo, con margen configurable).
- Detectar **Telegram webhook desviado** (el bot comparte webhook con el bridge `cuina-lab-bridge`; si se re-registra, agent-mouth deja de recibir en silencio).
- Detectar **WhatsApp inbound** no operativo.
- Vigilar **recursos**: DB alcanzable (best-effort) y **gasto del día cerca del cap** $1.
- **Dead-man's-switch** para el caso "worker entero caído" vía heartbeat a un monitor externo (healthchecks.io).
- **Anti-spam**: alertar en la transición a rojo + recordatorio máx. 1×/24h + un aviso de recuperación. Nunca spamear en cada tick.

**No-objetivos (YAGNI):**
- No auto-reparar el OAuth (imposible sin consentimiento humano; el link de 1 clic *es* la cura). El fix permanente (email → Workspace Internal) sigue diferido a post-Phase 5 por decisión 2026-06-03.
- No canal de alerta alternativo: el `send` de Telegram va por Bot API directa y funciona aunque el webhook de **recepción** esté mal apuntado.
- No tocar `runPhase3HealthCheck` (cadencia y responsabilidades distintas).
- No dashboard, no UI, no métricas históricas más allá del estado anti-spam.

## 3. Arquitectura

Un cron nuevo de pg-boss, **`watchdog.sweep`**, registrado en `worker.ts` junto a los crons existentes, siguiendo el patrón ya establecido:

```ts
// en la función de arranque del worker, condicionado a deps disponibles
if (deps.enableWatchdog && deps.alertChatId && deps.defaultWorkspaceId) {
  await queue.work("watchdog.sweep", async () => {
    await runWatchdogSweep({
      databaseUrl: deps.databaseUrl,
      workspaceId: deps.defaultWorkspaceId!,
      transport: deps.transport,
      alertChatId: deps.alertChatId!,
      // + config: intervalo, margen email, healthchecksUrl, publicBaseUrl, authToken, flags whatsapp
    });
  });
  const intervalMin = deps.watchdogIntervalMin ?? 60;
  await queue.scheduleRecurring(
    "watchdog.sweep",
    `*/${intervalMin} * * * *`,
    {},
    { singletonKey: "watchdog.sweep.singleton" },
  );
  await queue.send("watchdog.sweep", {}, { singletonKey: "watchdog.sweep.singleton" }); // kick al boot
}
```

Módulo nuevo **`packages/api/src/watchdog/`**, auto-contenido (no toca los paquetes `core`/`storage` salvo la migración SQL). Lectura/escritura de Postgres con **`PgClient` directo**, igual que `runPhase3HealthCheck` (patrón establecido para jobs de mantenimiento; evita inflar los stores):

- `checks/` — una función por señal. Firma uniforme:
  ```ts
  type CheckStatus = "ok" | "warn" | "down";
  interface CheckResult { id: string; status: CheckStatus; message: string; action?: string; }
  type Check = (ctx: CheckCtx) => Promise<CheckResult>;
  ```
  Cada check es una **unidad aislada**: se entiende y testea sola con clients/fetch mockeados.
- `reporter.ts` — recibe `CheckResult[]`, aplica anti-spam contra el estado persistido, compone el mensaje y lo envía vía `transport.send`.
- `state.ts` — lee/escribe `watchdog_alerts` (PgClient directo).
- `heartbeat.ts` — `fetch(HEALTHCHECKS_URL)` al final del sweep si el worker está vivo.
- `run.ts` — `runWatchdogSweep`: ejecuta todos los checks (con aislamiento de fallos: un check que lanza excepción se trata como `down` con el error como mensaje, nunca tumba el sweep), pasa al reporter, y dispara el heartbeat.

**Por qué cron separado y no extender `runPhase3HealthCheck`:** el health-check es diario — inaceptable para "Telegram webhook desviado", donde se pierden mensajes en vivo — y mezclar responsabilidades lo convierte en cajón de sastre. Cron propio = frecuencia propia (horaria) + responsabilidad limpia. El watchdog **no duplica** lo que Phase 3 ya mira (error-ratio, latencia, staleness).

## 4. Los checks

| id | Señal de alerta | Severidad | `action` en la alerta |
|---|---|---|---|
| `email-inbound` | fila de `email_oauth_tokens` (del workspace) con `status != 'active'` **o** `watch_expiration < now() + margen` (margen = `WATCHDOG_EMAIL_EXPIRY_MARGIN_HOURS`, def. 24 → **proactivo**) **o** `consecutive_renewal_failures >= 1`. Sin fila → `down` ("email no configurado"). | `down` | `{PUBLIC_BASE_URL}/email-oauth-start?token=<AGENT_MOUTH_AUTH_TOKEN>` |
| `telegram-webhook` | `GET https://api.telegram.org/bot<AGENT_MOUTH_BOT_TOKEN>/getWebhookInfo` → `result.url` != `{PUBLIC_BASE_URL}/telegram-webhook`. | `down` | "Webhook desviado a `<url>`. Re-registra o revisa el bridge." |
| `whatsapp-inbound` | solo si `ENABLE_WHATSAPP_TRANSPORT`=true: `GET https://graph.facebook.com/<WHATSAPP_GRAPH_VERSION>/<WHATSAPP_PHONE_NUMBER_ID>?fields=id` con Bearer `<WHATSAPP_ACCESS_TOKEN>` ≠ 200. Si flag off → check omitido (no aparece). | `down` | "Graph API no responde. Revisa token/número." |
| `database` | `SELECT 1` con timeout de 5s falla o lo supera. | `down` | "Supabase/DB degradada." |
| `daily-spend` | gasto del día (mismo cómputo que el guardrail de presupuesto) `>= 0.85 * daily_budget_usd_cap`. | `warn` | "Gasto al N% del cap diario ($X de $1)." |

Queries concretas (PgClient directo, parametrizadas por `workspace_id`):
- `email-inbound`: `SELECT status, watch_expiration, consecutive_renewal_failures, last_error FROM email_oauth_tokens WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT 1`.
- `daily-spend`: reutiliza el **mismo cómputo de gasto-del-día que el guardrail de presupuesto** (`packages/agent-guardrails/budget.ts` + `AuditLogStore.sumCostUsdSince`) — fuente de verdad del gasto vs cap, para que el 85% sea coherente con el cap que el guardrail aplica. Cap leído de `workspaces.daily_budget_usd_cap`. (El plan confirmará el criterio exacto de "día" mirando `budget.ts`.)

## 5. Anti-spam (estado)

Migración nueva **`0006_watchdog.sql`** en `packages/storage-supabase/sql/`:

```sql
CREATE TABLE IF NOT EXISTS watchdog_alerts (
  check_id        text PRIMARY KEY,
  status          text NOT NULL,            -- último estado conocido: ok|warn|down
  first_seen_at   timestamptz,             -- cuándo entró en no-ok la racha actual
  last_alerted_at timestamptz,             -- última vez que avisamos por Telegram
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE watchdog_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full access" ON watchdog_alerts
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
```

Reglas del reporter (por check, comparando estado nuevo vs persistido):
- `ok → (warn|down)`: **alerta inmediata**; set `first_seen_at`, `last_alerted_at`.
- `(warn|down)` sostenido: **recordatorio solo si** `now - last_alerted_at >= 24h`; actualiza `last_alerted_at`.
- `(warn|down) → ok`: **un** aviso de recuperación (`✅ <id> recuperado`); limpia `first_seen_at`.
- Un único mensaje agregado por sweep con las líneas que tocan (cambios + recordatorios). Si no hay nada que decir → silencio.

## 6. Dead-man's-switch (healthchecks.io)

`heartbeat.ts` hace `fetch(HEALTHCHECKS_URL)` **al final de cada sweep, siempre que el worker esté vivo** — es *liveness*, no *readiness*: los problemas internos van por Telegram; el latido solo dice "sigo en pie". Si el worker cae entero, healthchecks.io deja de recibir el ping y avisa por su propio canal.

- `HEALTHCHECKS_URL` ausente → heartbeat omitido con `logger.warn` (no rompe el sweep).
- Setup (Gavrilo): crear un check en healthchecks.io con periodo = `WATCHDOG_INTERVAL_MIN` + grace, poner su ping-URL como secret.

**Limitación documentada:** el caso "DB muerta + worker vivo" no lo detecta ni el `database` check (pg-boss no dispara el tick sin DB) ni necesariamente healthchecks (el heartbeat no depende de DB y seguiría enviándose). Es un punto ciego conocido y aceptado en v1; la caída total de DB se delata indirectamente (dejan de llegar respuestas).

## 7. Configuración (env) — todo inerte hasta activar

| Env | Default | Uso |
|---|---|---|
| `ENABLE_WATCHDOG` | `false` | kill switch del cron entero (patrón del repo: feature inerte tras flag) |
| `WATCHDOG_INTERVAL_MIN` | `60` | periodo del sweep |
| `WATCHDOG_EMAIL_EXPIRY_MARGIN_HOURS` | `24` | avisar si el watch del email expira en < N horas (proactivo) |
| `HEALTHCHECKS_URL` | — | ping-URL del dead-man's-switch (opcional) |

Reutiliza: `AGENT_MOUTH_CHAT_ID` (destino de alertas), `PUBLIC_BASE_URL`, `AGENT_MOUTH_AUTH_TOKEN` (link re-auth), `AGENT_MOUTH_BOT_TOKEN` (getWebhookInfo), `ENABLE_WHATSAPP_TRANSPORT` + `WHATSAPP_*`, `DATABASE_URL`.

## 8. Formato de la alerta

```
🔴 Watchdog agent-mouth
• Email inbound: watch expira en 18h. Re-autoriza → https://agent-mouth.fly.dev/email-oauth-start?token=…
• Telegram webhook desviado (apunta a https://lab.agentiko.es/webhook). Revisa el bridge.
🟠 Gasto del día al 87% del cap ($0.87 de $1).
✅ Recuperado: WhatsApp
```

Emojis por severidad calcando `runPhase3HealthCheck`: `🔴` down, `🟠` warn, `✅` recuperación.

## 9. Testing (TDD, Vitest + biome)

Cada pieza es testeable en aislamiento:
- **Por check** (fetch/PgClient mockeados): `email-inbound` rojo en cada disparador (status, margen de expiración, fallos de renovación, sin fila) y verde en estado sano; `telegram-webhook` rojo cuando `result.url` difiere, verde cuando coincide; `whatsapp-inbound` omitido con flag off, rojo en no-200; `database` rojo en fallo/timeout; `daily-spend` warn al cruzar 85%.
- **Anti-spam (reporter + state)**: alerta en transición ok→down; **no** re-alerta dentro de 24h; recordatorio tras 24h; aviso de recuperación una sola vez; mensaje agregado bien compuesto.
- **Aislamiento de fallos**: un check que lanza no tumba el sweep; se reporta como `down`.
- **Heartbeat**: se llama al final; ausencia de `HEALTHCHECKS_URL` lo omite sin romper.

## 10. Reparto humano / agente

- **Claude (en local, esta rama `feat/agent-mouth-watchdog`):** módulo `watchdog/` + migración `0006` + tests, todo verde (vitest + tsc + biome). Sin push, sin deploy.
- **Gavrilo (lo marca `autopilot.excluir` = deploy/push/publish):**
  1. Aplicar `0006_watchdog.sql` por el **SQL editor de Supabase** (cuenta `gavrimarkovic4@gmail.com`; no `db push`).
  2. Secrets Fly: `flyctl secrets set ENABLE_WATCHDOG=true HEALTHCHECKS_URL=<url> --app agent-mouth` (+ opcionalmente `WATCHDOG_INTERVAL_MIN`, `WATCHDOG_EMAIL_EXPIRY_MARGIN_HOURS`).
  3. Crear el check en healthchecks.io.
  4. `flyctl deploy` y verificar en logs que `watchdog.sweep` se registra y que el primer sweep corre.

## 11. Limitaciones conocidas (anti-humo)

- **Punto ciego DB muerta + worker vivo** (ver §6).
- **`database` check best-effort**: el scheduler depende de la misma DB, así que captura sobre todo latencia/degradación parcial, no caída total.
- **Link de re-auth con `AGENT_MOUTH_AUTH_TOKEN` en la URL**: aceptable porque la alerta va a tu Telegram privado (chat `618021852`); es el mismo modelo de exposición que ya usa el flujo de re-auth existente.
- **Solape menor con Phase 3 en gasto**: Phase 3 ya avisa coste > $0.5 (diario, informativo); el watchdog avisa al 85% del cap (horario, accionable). Cadencias y propósitos distintos; el anti-spam evita ruido del watchdog. Aceptado.

## 12. Decisión de diseño registrada

Esto **implementa la parte de detección/alerta** que faltaba alrededor del re-auth de 1 clic ya existente. No altera la decisión 2026-06-03: el fix permanente del email (Workspace Internal, token que no caduca) sigue diferido a post-Phase 5. El watchdog hace que, mientras tanto, una caída se detecte en ≤1h y se resuelva con un clic, en vez de descubrirse días después.
