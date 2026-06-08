# Agent Mouth Watchdog (v1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un cron horario (`watchdog.sweep`) que detecta fallos silenciosos de entrada (email caído, webhook de Telegram desviado, WhatsApp inbound) y de recurso (DB, gasto cerca del cap), avisa por Telegram con la acción concreta (incl. el link de re-auth de 1 clic existente) con anti-spam, y deja un heartbeat externo para el caso "worker muerto".

**Architecture:** Módulo nuevo auto-contenido `packages/api/src/watchdog/` con checks aislados (cada uno una función pura con sus deps inyectadas), un `reporter` que aplica anti-spam contra una tabla `watchdog_alerts` (migración 0006), un `heartbeat` a healthchecks.io, y un `run` que orquesta. Se cablea como un cron pg-boss dentro de `startWorker` siguiendo el patrón de los crons existentes (Phase 3). No toca `runPhase3HealthCheck`.

**Tech Stack:** TypeScript (NodeNext, imports con `.js`), Node 20, pg-boss, `pg` (node-postgres), grammy (Telegram), Vitest 2.1, biome. Monorepo pnpm; paquete objetivo `@agent-mouth/api`.

**Spec:** `docs/superpowers/specs/2026-06-05-agent-mouth-watchdog-design.md`

**Convención de commits:** mensajes semánticos; **cada commit termina con una línea en blanco y luego** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Los comandos de abajo lo omiten por brevedad — añádelo siempre.

**Comando de test (paquete api):** `pnpm --filter @agent-mouth/api test` · un archivo: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/<file>` · tipos: `pnpm --filter @agent-mouth/api build` (tsc) · lint: `pnpm lint`.

---

## File Structure

**Crear:**
- `packages/api/src/watchdog/types.ts` — `CheckStatus`, `CheckResult`, `WatchdogStateRow`, `WatchdogStateStore` (interfaz). Solo tipos.
- `packages/api/src/watchdog/checks/email-inbound.ts` — check del email (usa `tokenStore.list`).
- `packages/api/src/watchdog/checks/telegram-webhook.ts` — check del webhook (fetch a `getWebhookInfo`).
- `packages/api/src/watchdog/checks/whatsapp-inbound.ts` — check WhatsApp (fetch a Graph API).
- `packages/api/src/watchdog/checks/database.ts` — check DB (`SELECT 1` con PgClient).
- `packages/api/src/watchdog/checks/daily-spend.ts` — check gasto (calca `budget.ts`).
- `packages/api/src/watchdog/reporter.ts` — anti-spam + compone + envía Telegram. **Corazón lógico.**
- `packages/api/src/watchdog/heartbeat.ts` — ping a healthchecks.io.
- `packages/api/src/watchdog/state.ts` — `PgWatchdogStateStore` (impl I/O de `WatchdogStateStore`).
- `packages/api/src/watchdog/run.ts` — `runWatchdogSweep` (orquesta checks + report + heartbeat).
- `packages/storage-supabase/sql/0006_watchdog.sql` — tabla `watchdog_alerts`.
- Tests en `packages/api/tests/watchdog/`: `email-inbound.test.ts`, `telegram-webhook.test.ts`, `whatsapp-inbound.test.ts`, `database.test.ts`, `daily-spend.test.ts`, `reporter.test.ts`, `heartbeat.test.ts`, `run.test.ts`.

**Modificar:**
- `packages/api/src/worker.ts` — añadir flags/config a `WorkerDeps` (interface, ~líneas 31–72); registrar el cron `watchdog.sweep` dentro de `startWorker` (tras el bloque email, ~línea 302); añadir imports del módulo watchdog.
- `packages/api/src/cli/serve-http.ts` — leer las env vars nuevas y pasarlas al objeto `startWorker({...})` (~líneas 355–381).

---

## Task 1: Tipos compartidos del watchdog

**Files:**
- Create: `packages/api/src/watchdog/types.ts`

> Archivo de solo tipos: no tiene comportamiento runtime, así que no lleva test propio (lo valida `tsc`). Es la base que importan las demás tareas.

- [ ] **Step 1: Escribir `types.ts`**

```ts
// packages/api/src/watchdog/types.ts

export type CheckStatus = "ok" | "warn" | "down";

/** Resultado de un check individual del watchdog. */
export interface CheckResult {
  id: string;
  status: CheckStatus;
  message: string;
  /** Acción sugerida para el humano (link, instrucción). Opcional. */
  action?: string;
}

/** Estado persistido por check, para anti-spam. Fechas en ISO 8601 o null. */
export interface WatchdogStateRow {
  check_id: string;
  status: CheckStatus;
  first_seen_at: string | null;
  last_alerted_at: string | null;
}

/** Almacén del estado anti-spam. La impl real (Postgres) vive en state.ts. */
export interface WatchdogStateStore {
  load(): Promise<WatchdogStateRow[]>;
  upsert(row: WatchdogStateRow): Promise<void>;
}
```

- [ ] **Step 2: Verificar que compila**

Run: `pnpm --filter @agent-mouth/api build`
Expected: PASS (sin errores de tipos).

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/watchdog/types.ts
git commit -m "feat(watchdog): shared types (CheckResult, WatchdogStateStore)"
```

---

## Task 2: Check `email-inbound`

**Files:**
- Create: `packages/api/src/watchdog/checks/email-inbound.ts`
- Test: `packages/api/tests/watchdog/email-inbound.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// packages/api/tests/watchdog/email-inbound.test.ts
import { describe, expect, it, vi } from "vitest";
import { checkEmailInbound } from "../../src/watchdog/checks/email-inbound.js";

const REAUTH = "https://agent-mouth.fly.dev/email-oauth-start?token=t";
const MARGIN = 24 * 3_600_000;
const now = () => new Date("2026-06-05T00:00:00.000Z");
const baseTok = {
  id: "1",
  email_address: "a@b.com",
  status: "active",
  watch_expiration: "2026-12-01T00:00:00.000Z",
  consecutive_renewal_failures: 0,
  last_error: null,
};
const store = (toks: unknown[]) => ({ list: vi.fn(async () => toks) }) as never;

describe("checkEmailInbound", () => {
  it("ok cuando activo, lejos de expirar y sin fallos", async () => {
    const r = await checkEmailInbound({ tokenStore: store([baseTok]), workspaceId: "w", reauthUrl: REAUTH, expiryMarginMs: MARGIN, now });
    expect(r.status).toBe("ok");
  });

  it("down sin token, con el link de re-auth", async () => {
    const r = await checkEmailInbound({ tokenStore: store([]), workspaceId: "w", reauthUrl: REAUTH, expiryMarginMs: MARGIN, now });
    expect(r.status).toBe("down");
    expect(r.action).toBe(REAUTH);
  });

  it("down cuando status != active", async () => {
    const r = await checkEmailInbound({ tokenStore: store([{ ...baseTok, status: "error", last_error: "revoked" }]), workspaceId: "w", reauthUrl: REAUTH, expiryMarginMs: MARGIN, now });
    expect(r.status).toBe("down");
    expect(r.action).toBe(REAUTH);
  });

  it("down con fallos de renovación", async () => {
    const r = await checkEmailInbound({ tokenStore: store([{ ...baseTok, consecutive_renewal_failures: 2 }]), workspaceId: "w", reauthUrl: REAUTH, expiryMarginMs: MARGIN, now });
    expect(r.status).toBe("down");
  });

  it("down (proactivo) cuando el watch expira dentro del margen", async () => {
    const r = await checkEmailInbound({ tokenStore: store([{ ...baseTok, watch_expiration: "2026-06-05T18:00:00.000Z" }]), workspaceId: "w", reauthUrl: REAUTH, expiryMarginMs: MARGIN, now });
    expect(r.status).toBe("down");
  });
});
```

- [ ] **Step 2: Correr el test → falla**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/email-inbound.test.ts`
Expected: FAIL ("Cannot find module .../email-inbound.js").

- [ ] **Step 3: Implementar el check**

```ts
// packages/api/src/watchdog/checks/email-inbound.ts
import type { SupabaseEmailTokenStore } from "@agent-mouth/storage-supabase";
import type { CheckResult } from "../types.js";

export interface EmailInboundCheckDeps {
  tokenStore: Pick<SupabaseEmailTokenStore, "list">;
  workspaceId: string;
  /** {PUBLIC_BASE_URL}/email-oauth-start?token=<AGENT_MOUTH_AUTH_TOKEN> */
  reauthUrl: string;
  /** Margen proactivo en ms (WATCHDOG_EMAIL_EXPIRY_MARGIN_HOURS * 3_600_000). */
  expiryMarginMs: number;
  now: () => Date;
}

const ID = "email-inbound";

export async function checkEmailInbound(deps: EmailInboundCheckDeps): Promise<CheckResult> {
  const tokens = await deps.tokenStore.list(deps.workspaceId);
  if (tokens.length === 0) {
    return { id: ID, status: "down", message: "email sin token configurado", action: deps.reauthUrl };
  }
  const tok = tokens[0] as {
    status: string;
    watch_expiration: string | null;
    consecutive_renewal_failures: number;
    last_error: string | null;
  };
  if (tok.status !== "active") {
    const suffix = tok.last_error ? ` (${tok.last_error})` : "";
    return { id: ID, status: "down", message: `email status=${tok.status}${suffix}`, action: deps.reauthUrl };
  }
  if (tok.consecutive_renewal_failures >= 1) {
    return { id: ID, status: "down", message: `email: ${tok.consecutive_renewal_failures} fallo(s) de renovación del watch`, action: deps.reauthUrl };
  }
  if (tok.watch_expiration) {
    const expMs = new Date(tok.watch_expiration).getTime();
    const nowMs = deps.now().getTime();
    if (expMs < nowMs + deps.expiryMarginMs) {
      const hours = Math.max(0, Math.round((expMs - nowMs) / 3_600_000));
      return { id: ID, status: "down", message: `email: watch expira en ~${hours}h`, action: deps.reauthUrl };
    }
  }
  return { id: ID, status: "ok", message: "ok" };
}
```

- [ ] **Step 4: Correr el test → pasa**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/email-inbound.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/watchdog/checks/email-inbound.ts packages/api/tests/watchdog/email-inbound.test.ts
git commit -m "feat(watchdog): email-inbound check (proactive expiry + re-auth link)"
```

---

## Task 3: Check `telegram-webhook`

**Files:**
- Create: `packages/api/src/watchdog/checks/telegram-webhook.ts`
- Test: `packages/api/tests/watchdog/telegram-webhook.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// packages/api/tests/watchdog/telegram-webhook.test.ts
import { describe, expect, it, vi } from "vitest";
import { checkTelegramWebhook } from "../../src/watchdog/checks/telegram-webhook.js";

const EXPECTED = "https://agent-mouth.fly.dev/telegram-webhook";
const fetchOk = (url: string) =>
  vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { url } }) })) as never;

describe("checkTelegramWebhook", () => {
  it("ok cuando el webhook apunta al esperado", async () => {
    const r = await checkTelegramWebhook({ botToken: "b", expectedUrl: EXPECTED, fetchFn: fetchOk(EXPECTED) });
    expect(r.status).toBe("ok");
  });

  it("down cuando el webhook está desviado", async () => {
    const r = await checkTelegramWebhook({ botToken: "b", expectedUrl: EXPECTED, fetchFn: fetchOk("https://lab.agentiko.es/webhook") });
    expect(r.status).toBe("down");
    expect(r.message).toContain("lab.agentiko.es");
  });

  it("down cuando getWebhookInfo no es 200", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as never;
    const r = await checkTelegramWebhook({ botToken: "b", expectedUrl: EXPECTED, fetchFn });
    expect(r.status).toBe("down");
  });
});
```

- [ ] **Step 2: Correr el test → falla**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/telegram-webhook.test.ts`
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Implementar el check**

```ts
// packages/api/src/watchdog/checks/telegram-webhook.ts
import type { CheckResult } from "../types.js";

export interface TelegramWebhookCheckDeps {
  botToken: string;
  /** {PUBLIC_BASE_URL}/telegram-webhook */
  expectedUrl: string;
  fetchFn?: typeof fetch;
}

const ID = "telegram-webhook";

export async function checkTelegramWebhook(deps: TelegramWebhookCheckDeps): Promise<CheckResult> {
  const f = deps.fetchFn ?? fetch;
  try {
    const res = await f(`https://api.telegram.org/bot${deps.botToken}/getWebhookInfo`);
    if (!res.ok) {
      return { id: ID, status: "down", message: `getWebhookInfo HTTP ${res.status}` };
    }
    const json = (await res.json()) as { ok?: boolean; result?: { url?: string } };
    const url = json.result?.url ?? "";
    if (url !== deps.expectedUrl) {
      return {
        id: ID,
        status: "down",
        message: `telegram webhook apunta a "${url || "(vacío)"}" (esperado "${deps.expectedUrl}")`,
        action: "Re-registra el webhook o revisa el bridge.",
      };
    }
    return { id: ID, status: "ok", message: "ok" };
  } catch (err) {
    return { id: ID, status: "down", message: `telegram getWebhookInfo falló: ${String(err)}` };
  }
}
```

- [ ] **Step 4: Correr el test → pasa**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/telegram-webhook.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/watchdog/checks/telegram-webhook.ts packages/api/tests/watchdog/telegram-webhook.test.ts
git commit -m "feat(watchdog): telegram-webhook check (detect diverted shared webhook)"
```

---

## Task 4: Check `whatsapp-inbound`

**Files:**
- Create: `packages/api/src/watchdog/checks/whatsapp-inbound.ts`
- Test: `packages/api/tests/watchdog/whatsapp-inbound.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// packages/api/tests/watchdog/whatsapp-inbound.test.ts
import { describe, expect, it, vi } from "vitest";
import { checkWhatsAppInbound } from "../../src/watchdog/checks/whatsapp-inbound.js";

const base = { graphVersion: "v21.0", phoneNumberId: "123", accessToken: "tok" };

describe("checkWhatsAppInbound", () => {
  it("ok (omitido) cuando está deshabilitado, sin llamar a fetch", async () => {
    const fetchFn = vi.fn() as never;
    const r = await checkWhatsAppInbound({ enabled: false, ...base, fetchFn });
    expect(r.status).toBe("ok");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("ok cuando Graph API responde 200", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "123" }) })) as never;
    const r = await checkWhatsAppInbound({ enabled: true, ...base, fetchFn });
    expect(r.status).toBe("ok");
  });

  it("down cuando Graph API no es 200", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as never;
    const r = await checkWhatsAppInbound({ enabled: true, ...base, fetchFn });
    expect(r.status).toBe("down");
  });
});
```

- [ ] **Step 2: Correr el test → falla**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/whatsapp-inbound.test.ts`
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Implementar el check**

```ts
// packages/api/src/watchdog/checks/whatsapp-inbound.ts
import type { CheckResult } from "../types.js";

export interface WhatsAppInboundCheckDeps {
  enabled: boolean;
  graphVersion: string;
  phoneNumberId: string;
  accessToken: string;
  fetchFn?: typeof fetch;
}

const ID = "whatsapp-inbound";

export async function checkWhatsAppInbound(deps: WhatsAppInboundCheckDeps): Promise<CheckResult> {
  if (!deps.enabled) {
    return { id: ID, status: "ok", message: "deshabilitado (omitido)" };
  }
  const f = deps.fetchFn ?? fetch;
  const url = `https://graph.facebook.com/${deps.graphVersion}/${deps.phoneNumberId}?fields=id`;
  try {
    const res = await f(url, { headers: { Authorization: `Bearer ${deps.accessToken}` } });
    if (!res.ok) {
      return { id: ID, status: "down", message: `whatsapp Graph API HTTP ${res.status}`, action: "Revisa WHATSAPP_ACCESS_TOKEN / número." };
    }
    return { id: ID, status: "ok", message: "ok" };
  } catch (err) {
    return { id: ID, status: "down", message: `whatsapp Graph API falló: ${String(err)}`, action: "Revisa WHATSAPP_ACCESS_TOKEN / número." };
  }
}
```

- [ ] **Step 4: Correr el test → pasa**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/whatsapp-inbound.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/watchdog/checks/whatsapp-inbound.ts packages/api/tests/watchdog/whatsapp-inbound.test.ts
git commit -m "feat(watchdog): whatsapp-inbound check (Graph API ping, skip when disabled)"
```

---

## Task 5: Check `database`

**Files:**
- Create: `packages/api/src/watchdog/checks/database.ts`
- Test: `packages/api/tests/watchdog/database.test.ts`

> Alcance (del spec §11): cubre "DB inalcanzable en 5s" vía `connectionTimeoutMillis`. Una query colgada indefinidamente queda fuera (marginal para `SELECT 1`). El cliente se inyecta para testear sin DB real.

- [ ] **Step 1: Escribir el test que falla**

```ts
// packages/api/tests/watchdog/database.test.ts
import { describe, expect, it, vi } from "vitest";
import { checkDatabase } from "../../src/watchdog/checks/database.js";

describe("checkDatabase", () => {
  it("ok cuando connect + SELECT 1 funcionan", async () => {
    const client = { connect: vi.fn(async () => {}), query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })), end: vi.fn(async () => {}) };
    const r = await checkDatabase({ databaseUrl: "postgres://x", clientFactory: () => client });
    expect(r.status).toBe("ok");
    expect(client.end).toHaveBeenCalled();
  });

  it("down cuando la query falla, y cierra el cliente", async () => {
    const client = { connect: vi.fn(async () => {}), query: vi.fn(async () => { throw new Error("ECONNREFUSED"); }), end: vi.fn(async () => {}) };
    const r = await checkDatabase({ databaseUrl: "postgres://x", clientFactory: () => client });
    expect(r.status).toBe("down");
    expect(client.end).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test → falla**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/database.test.ts`
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Implementar el check**

```ts
// packages/api/src/watchdog/checks/database.ts
import { Client as PgClient } from "pg";
import type { CheckResult } from "../types.js";

interface MinimalPgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface DatabaseCheckDeps {
  databaseUrl: string;
  timeoutMs?: number;
  /** Inyectable para tests; por defecto crea un Client real de `pg`. */
  clientFactory?: (cfg: { connectionString: string; connectionTimeoutMillis: number }) => MinimalPgClient;
}

const ID = "database";

export async function checkDatabase(deps: DatabaseCheckDeps): Promise<CheckResult> {
  const timeout = deps.timeoutMs ?? 5000;
  const make = deps.clientFactory ?? ((cfg) => new PgClient(cfg) as unknown as MinimalPgClient);
  const client = make({ connectionString: deps.databaseUrl, connectionTimeoutMillis: timeout });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { id: ID, status: "ok", message: "ok" };
  } catch (err) {
    return { id: ID, status: "down", message: `DB no responde: ${String(err)}`, action: "Revisa Supabase / DATABASE_URL." };
  } finally {
    await client.end().catch(() => {});
  }
}
```

- [ ] **Step 4: Correr el test → pasa**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/database.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/watchdog/checks/database.ts packages/api/tests/watchdog/database.test.ts
git commit -m "feat(watchdog): database reachability check (SELECT 1, 5s connect timeout)"
```

---

## Task 6: Check `daily-spend`

**Files:**
- Create: `packages/api/src/watchdog/checks/daily-spend.ts`
- Test: `packages/api/tests/watchdog/daily-spend.test.ts`

> Calca el cómputo de `packages/agent-guardrails/src/budget.ts`: medianoche **UTC** (`setUTCHours(0,0,0,0)`) + `audit.sumCostUsdSince(workspaceId, sinceIso)`, cap de `workspaces.getDefault().daily_budget_usd_cap` (default 5.0). Warn al 85%.

- [ ] **Step 1: Escribir el test que falla**

```ts
// packages/api/tests/watchdog/daily-spend.test.ts
import { describe, expect, it, vi } from "vitest";
import { checkDailySpend } from "../../src/watchdog/checks/daily-spend.js";

const now = () => new Date("2026-06-05T12:00:00.000Z");
const workspaces = (cap: number) => ({ getDefault: vi.fn(async () => ({ daily_budget_usd_cap: cap })) }) as never;
const audit = (spent: number) => ({ sumCostUsdSince: vi.fn(async () => spent) }) as never;

describe("checkDailySpend", () => {
  it("ok cuando el gasto está por debajo del 85% del cap", async () => {
    const r = await checkDailySpend({ workspaceId: "w", audit: audit(0.3), workspaces: workspaces(1), now });
    expect(r.status).toBe("ok");
  });

  it("warn al cruzar el 85% del cap", async () => {
    const r = await checkDailySpend({ workspaceId: "w", audit: audit(0.9), workspaces: workspaces(1), now });
    expect(r.status).toBe("warn");
    expect(r.message).toContain("%");
  });

  it("usa medianoche UTC como inicio del día", async () => {
    const sum = vi.fn(async () => 0.1);
    await checkDailySpend({ workspaceId: "w", audit: { sumCostUsdSince: sum } as never, workspaces: workspaces(1), now });
    expect(sum).toHaveBeenCalledWith("w", "2026-06-05T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Correr el test → falla**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/daily-spend.test.ts`
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Implementar el check**

```ts
// packages/api/src/watchdog/checks/daily-spend.ts
import type { AuditLogStore, WorkspaceStore } from "@agent-mouth/core";
import type { CheckResult } from "../types.js";

export interface DailySpendCheckDeps {
  workspaceId: string;
  audit: Pick<AuditLogStore, "sumCostUsdSince">;
  workspaces: Pick<WorkspaceStore, "getDefault">;
  /** Umbral de aviso como fracción del cap. Default 0.85. */
  warnRatio?: number;
  now: () => Date;
}

const ID = "daily-spend";

export async function checkDailySpend(deps: DailySpendCheckDeps): Promise<CheckResult> {
  const ws = await deps.workspaces.getDefault();
  const cap = (ws as unknown as { daily_budget_usd_cap?: number }).daily_budget_usd_cap ?? 5.0;
  const startOfDay = new Date(deps.now());
  startOfDay.setUTCHours(0, 0, 0, 0);
  const spent = await deps.audit.sumCostUsdSince(deps.workspaceId, startOfDay.toISOString());
  const ratio = deps.warnRatio ?? 0.85;
  if (spent >= ratio * cap) {
    const pct = Math.round((spent / cap) * 100);
    return { id: ID, status: "warn", message: `gasto del día al ${pct}% del cap ($${spent.toFixed(2)} de $${cap.toFixed(2)})` };
  }
  return { id: ID, status: "ok", message: `$${spent.toFixed(2)} de $${cap.toFixed(2)}` };
}
```

- [ ] **Step 4: Correr el test → pasa**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/daily-spend.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/watchdog/checks/daily-spend.ts packages/api/tests/watchdog/daily-spend.test.ts
git commit -m "feat(watchdog): daily-spend check (warn at 85% of cap, UTC day like budget guardrail)"
```

---

## Task 7: Reporter (anti-spam) — corazón lógico

**Files:**
- Create: `packages/api/src/watchdog/reporter.ts`
- Test: `packages/api/tests/watchdog/reporter.test.ts`

> Reglas: `ok→(warn|down)` alerta inmediata; `(warn|down)` sostenido alerta solo si pasaron ≥24h del último aviso; `(warn|down)→ok` un aviso de recuperación; todo-ok sin mal previo → no envía (devuelve null). `now` inyectado para testear el cooldown.

- [ ] **Step 1: Escribir el test que falla**

```ts
// packages/api/tests/watchdog/reporter.test.ts
import { describe, expect, it, vi } from "vitest";
import { reportSweep } from "../../src/watchdog/reporter.js";
import type { CheckResult, WatchdogStateRow } from "../../src/watchdog/types.js";

const T0 = "2026-06-05T00:00:00.000Z";
const at = (iso: string) => () => new Date(iso);

function makeDeps(prev: WatchdogStateRow[], nowIso: string) {
  const upsert = vi.fn(async () => {});
  const send = vi.fn(async () => ({ message_id: "1", timestamp: new Date(nowIso) }));
  return {
    deps: { stateStore: { load: vi.fn(async () => prev), upsert }, transport: { send }, alertChatId: "618021852", now: at(nowIso) },
    upsert,
    send,
  };
}

const down = (id: string): CheckResult => ({ id, status: "down", message: `${id} caído`, action: "fix" });
const ok = (id: string): CheckResult => ({ id, status: "ok", message: "ok" });

describe("reportSweep", () => {
  it("no envía nada cuando todo ok y no había estado malo", async () => {
    const { deps, send } = makeDeps([], T0);
    const body = await reportSweep([ok("email-inbound")], deps as never);
    expect(body).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("alerta en la transición ok→down y guarda first_seen + last_alerted", async () => {
    const { deps, send, upsert } = makeDeps([], T0);
    const body = await reportSweep([down("email-inbound")], deps as never);
    expect(send).toHaveBeenCalledTimes(1);
    expect(body).toContain("email-inbound caído");
    expect(upsert).toHaveBeenCalledWith({ check_id: "email-inbound", status: "down", first_seen_at: T0, last_alerted_at: T0 });
  });

  it("NO re-alerta si sigue down dentro de 24h", async () => {
    const prev: WatchdogStateRow[] = [{ check_id: "email-inbound", status: "down", first_seen_at: T0, last_alerted_at: T0 }];
    const { deps, send } = makeDeps(prev, "2026-06-05T06:00:00.000Z"); // +6h
    const body = await reportSweep([down("email-inbound")], deps as never);
    expect(send).not.toHaveBeenCalled();
    expect(body).toBeNull();
  });

  it("recuerda si sigue down pasadas 24h", async () => {
    const prev: WatchdogStateRow[] = [{ check_id: "email-inbound", status: "down", first_seen_at: T0, last_alerted_at: T0 }];
    const { deps, send } = makeDeps(prev, "2026-06-06T01:00:00.000Z"); // +25h
    await reportSweep([down("email-inbound")], deps as never);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("avisa de recuperación en down→ok una sola vez", async () => {
    const prev: WatchdogStateRow[] = [{ check_id: "email-inbound", status: "down", first_seen_at: T0, last_alerted_at: T0 }];
    const { deps, send, upsert } = makeDeps(prev, "2026-06-05T06:00:00.000Z");
    const body = await reportSweep([ok("email-inbound")], deps as never);
    expect(send).toHaveBeenCalledTimes(1);
    expect(body).toContain("Recuperado");
    expect(upsert).toHaveBeenCalledWith({ check_id: "email-inbound", status: "ok", first_seen_at: null, last_alerted_at: null });
  });
});
```

- [ ] **Step 2: Correr el test → falla**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/reporter.test.ts`
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Implementar el reporter**

```ts
// packages/api/src/watchdog/reporter.ts
import type { Transport } from "@agent-mouth/core";
import type { CheckResult, CheckStatus, WatchdogStateRow, WatchdogStateStore } from "./types.js";

const REMINDER_MS = 24 * 3_600_000;
const EMOJI: Record<CheckStatus, string> = { ok: "✅", warn: "🟠", down: "🔴" };

export interface ReporterDeps {
  stateStore: WatchdogStateStore;
  transport: Pick<Transport, "send">;
  alertChatId: string;
  now: () => Date;
}

/** Aplica anti-spam, compone el mensaje y lo envía. Devuelve el body enviado o null. */
export async function reportSweep(results: CheckResult[], deps: ReporterDeps): Promise<string | null> {
  const prev = new Map<string, WatchdogStateRow>();
  for (const row of await deps.stateStore.load()) prev.set(row.check_id, row);

  const nowIso = deps.now().toISOString();
  const nowMs = deps.now().getTime();
  const lines: string[] = [];

  for (const r of results) {
    const before = prev.get(r.id);
    const wasBad = !!before && before.status !== "ok";

    if (r.status !== "ok") {
      const firstSeen = wasBad && before?.first_seen_at ? before.first_seen_at : nowIso;
      const lastAlertedMs = before?.last_alerted_at ? new Date(before.last_alerted_at).getTime() : 0;
      const isTransition = !wasBad;
      const dueReminder = wasBad && nowMs - lastAlertedMs >= REMINDER_MS;
      if (isTransition || dueReminder) {
        lines.push(`${EMOJI[r.status]} ${r.message}${r.action ? ` → ${r.action}` : ""}`);
        await deps.stateStore.upsert({ check_id: r.id, status: r.status, first_seen_at: firstSeen, last_alerted_at: nowIso });
      } else {
        await deps.stateStore.upsert({ check_id: r.id, status: r.status, first_seen_at: firstSeen, last_alerted_at: before?.last_alerted_at ?? nowIso });
      }
    } else {
      if (wasBad) lines.push(`${EMOJI.ok} Recuperado: ${r.id}`);
      await deps.stateStore.upsert({ check_id: r.id, status: "ok", first_seen_at: null, last_alerted_at: null });
    }
  }

  if (lines.length === 0) return null;
  const body = `🛰️ Watchdog agent-mouth\n${lines.join("\n")}`;
  await deps.transport.send({ to: deps.alertChatId, body });
  return body;
}
```

- [ ] **Step 4: Correr el test → pasa**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/reporter.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/watchdog/reporter.ts packages/api/tests/watchdog/reporter.test.ts
git commit -m "feat(watchdog): reporter with anti-spam (transition + 24h reminder + recovery)"
```

---

## Task 8: Heartbeat (dead-man's-switch)

**Files:**
- Create: `packages/api/src/watchdog/heartbeat.ts`
- Test: `packages/api/tests/watchdog/heartbeat.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// packages/api/tests/watchdog/heartbeat.test.ts
import { describe, expect, it, vi } from "vitest";
import { sendHeartbeat } from "../../src/watchdog/heartbeat.js";

describe("sendHeartbeat", () => {
  it("no hace ping y devuelve false si no hay URL", async () => {
    const fetchFn = vi.fn() as never;
    const ok = await sendHeartbeat({ url: undefined, fetchFn });
    expect(ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("hace ping y devuelve true cuando hay URL", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true })) as never;
    const ok = await sendHeartbeat({ url: "https://hc.example/ping/abc", fetchFn });
    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith("https://hc.example/ping/abc");
  });

  it("devuelve false (sin lanzar) si el fetch falla", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("network"); }) as never;
    const ok = await sendHeartbeat({ url: "https://hc.example/ping/abc", fetchFn });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test → falla**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/heartbeat.test.ts`
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Implementar el heartbeat**

```ts
// packages/api/src/watchdog/heartbeat.ts
import { logger } from "../logger.js";

export interface HeartbeatDeps {
  url?: string;
  fetchFn?: typeof fetch;
}

/** Liveness ping. true si se envió, false si se omitió o falló (nunca lanza). */
export async function sendHeartbeat(deps: HeartbeatDeps): Promise<boolean> {
  if (!deps.url) {
    logger.warn("watchdog: HEALTHCHECKS_URL no configurado — heartbeat omitido");
    return false;
  }
  const f = deps.fetchFn ?? fetch;
  try {
    await f(deps.url);
    return true;
  } catch (err) {
    logger.error({ err: String(err) }, "watchdog: heartbeat falló");
    return false;
  }
}
```

- [ ] **Step 4: Correr el test → pasa**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/heartbeat.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/watchdog/heartbeat.ts packages/api/tests/watchdog/heartbeat.test.ts
git commit -m "feat(watchdog): healthchecks.io heartbeat (liveness, no-op without URL)"
```

---

## Task 9: State store (impl Postgres)

**Files:**
- Create: `packages/api/src/watchdog/state.ts`

> Impl I/O fina de `WatchdogStateStore` con `pg` (mismo patrón que `runPhase3HealthCheck`: abre/cierra `PgClient` por operación). Sin unit test directo (es I/O puro; la lógica anti-spam ya está cubierta en el reporter con un mock de esta interfaz). Se ejerce en el deploy/verificación manual (Task 14 nota).

- [ ] **Step 1: Escribir la implementación**

```ts
// packages/api/src/watchdog/state.ts
import { Client as PgClient } from "pg";
import type { WatchdogStateRow, WatchdogStateStore } from "./types.js";

export class PgWatchdogStateStore implements WatchdogStateStore {
  constructor(private readonly connectionString: string) {}

  async load(): Promise<WatchdogStateRow[]> {
    const pg = new PgClient({ connectionString: this.connectionString, connectionTimeoutMillis: 10_000 });
    try {
      await pg.connect();
      const res = await pg.query(
        "SELECT check_id, status, first_seen_at, last_alerted_at FROM watchdog_alerts",
      );
      return res.rows.map((r: Record<string, unknown>) => ({
        check_id: String(r.check_id),
        status: r.status as WatchdogStateRow["status"],
        first_seen_at: r.first_seen_at ? new Date(r.first_seen_at as string).toISOString() : null,
        last_alerted_at: r.last_alerted_at ? new Date(r.last_alerted_at as string).toISOString() : null,
      }));
    } finally {
      await pg.end().catch(() => {});
    }
  }

  async upsert(row: WatchdogStateRow): Promise<void> {
    const pg = new PgClient({ connectionString: this.connectionString, connectionTimeoutMillis: 10_000 });
    try {
      await pg.connect();
      await pg.query(
        `INSERT INTO watchdog_alerts (check_id, status, first_seen_at, last_alerted_at, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (check_id) DO UPDATE SET
           status = EXCLUDED.status,
           first_seen_at = EXCLUDED.first_seen_at,
           last_alerted_at = EXCLUDED.last_alerted_at,
           updated_at = now()`,
        [row.check_id, row.status, row.first_seen_at, row.last_alerted_at],
      );
    } finally {
      await pg.end().catch(() => {});
    }
  }
}
```

- [ ] **Step 2: Verificar que compila**

Run: `pnpm --filter @agent-mouth/api build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/watchdog/state.ts
git commit -m "feat(watchdog): PgWatchdogStateStore (anti-spam state persistence)"
```

---

## Task 10: Orquestador `runWatchdogSweep`

**Files:**
- Create: `packages/api/src/watchdog/run.ts`
- Test: `packages/api/tests/watchdog/run.test.ts`

> Ejecuta los checks con **aislamiento de fallos** (un check que lanza → `down`, no tumba el sweep), pasa los resultados a `report`, y al final llama a `heartbeat` (siempre, aunque `report` falle). `report` y `heartbeat` se inyectan como callbacks para testear sin tocar Postgres ni red.

- [ ] **Step 1: Escribir el test que falla**

```ts
// packages/api/tests/watchdog/run.test.ts
import { describe, expect, it, vi } from "vitest";
import { runWatchdogSweep } from "../../src/watchdog/run.js";
import type { CheckResult } from "../../src/watchdog/types.js";

describe("runWatchdogSweep", () => {
  it("recoge resultados y un check que lanza se convierte en down", async () => {
    let received: CheckResult[] = [];
    const report = vi.fn(async (rs: CheckResult[]) => { received = rs; });
    const heartbeat = vi.fn(async () => {});
    await runWatchdogSweep({
      checks: [
        { id: "a", run: async () => ({ id: "a", status: "ok", message: "ok" }) },
        { id: "b", run: async () => { throw new Error("boom"); } },
      ],
      report,
      heartbeat,
    });
    expect(received.map((r) => `${r.id}:${r.status}`)).toEqual(["a:ok", "b:down"]);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it("el heartbeat se envía aunque report lance", async () => {
    const report = vi.fn(async () => { throw new Error("report fail"); });
    const heartbeat = vi.fn(async () => {});
    await runWatchdogSweep({
      checks: [{ id: "a", run: async () => ({ id: "a", status: "ok", message: "ok" }) }],
      report,
      heartbeat,
    });
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Correr el test → falla**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/run.test.ts`
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Implementar el orquestador**

```ts
// packages/api/src/watchdog/run.ts
import { logger } from "../logger.js";
import type { CheckResult } from "./types.js";

export interface RunWatchdogSweepDeps {
  checks: { id: string; run: () => Promise<CheckResult> }[];
  report: (results: CheckResult[]) => Promise<unknown>;
  heartbeat: () => Promise<unknown>;
}

export async function runWatchdogSweep(deps: RunWatchdogSweepDeps): Promise<void> {
  const results: CheckResult[] = [];
  for (const c of deps.checks) {
    try {
      results.push(await c.run());
    } catch (err) {
      results.push({ id: c.id, status: "down", message: `check '${c.id}' lanzó: ${String(err)}` });
    }
  }
  try {
    await deps.report(results);
  } catch (err) {
    logger.error({ err: String(err) }, "watchdog: reporter falló");
  }
  await deps.heartbeat();
}
```

- [ ] **Step 4: Correr el test → pasa**

Run: `pnpm --filter @agent-mouth/api exec vitest run tests/watchdog/run.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/watchdog/run.ts packages/api/tests/watchdog/run.test.ts
git commit -m "feat(watchdog): runWatchdogSweep orchestrator (fault isolation + always heartbeat)"
```

---

## Task 11: Migración SQL `0006_watchdog`

**Files:**
- Create: `packages/storage-supabase/sql/0006_watchdog.sql`

- [ ] **Step 1: Escribir la migración**

```sql
-- 0006_watchdog.sql — anti-spam state for the watchdog sweep
-- Spec: docs/superpowers/specs/2026-06-05-agent-mouth-watchdog-design.md §5

CREATE TABLE IF NOT EXISTS watchdog_alerts (
  check_id        text PRIMARY KEY,
  status          text NOT NULL,            -- ok | warn | down
  first_seen_at   timestamptz,              -- inicio de la racha no-ok actual
  last_alerted_at timestamptz,              -- última alerta enviada por Telegram
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE watchdog_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full access" ON watchdog_alerts
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
```

- [ ] **Step 2: Verificar sintaxis (revisión visual)**

Comparar con `packages/storage-supabase/sql/0005_email_transport.sql`: mismo patrón de `CREATE TABLE IF NOT EXISTS` + `ENABLE ROW LEVEL SECURITY` + policy `service_role full access`. Sin dependencias a tablas inexistentes.

- [ ] **Step 3: Commit**

```bash
git add packages/storage-supabase/sql/0006_watchdog.sql
git commit -m "feat(storage): 0006 watchdog_alerts table (anti-spam state)"
```

---

## Task 12: Cablear el cron en `worker.ts`

**Files:**
- Modify: `packages/api/src/worker.ts` (imports al principio; `WorkerDeps` ~líneas 31–72; bloque nuevo tras el bloque email ~línea 302)

> Sin unit test (el registro de crons depende de pg-boss). Se valida con `tsc` (Step 4) y la verificación final (Task 14). El error de tipos te dirá si algún campo no encaja.

- [ ] **Step 1: Añadir imports del módulo watchdog**

Tras la línea `import { logger } from "./logger.js";` (línea 23 de `worker.ts`), añadir:

```ts
import { checkEmailInbound } from "./watchdog/checks/email-inbound.js";
import { checkTelegramWebhook } from "./watchdog/checks/telegram-webhook.js";
import { checkWhatsAppInbound } from "./watchdog/checks/whatsapp-inbound.js";
import { checkDatabase } from "./watchdog/checks/database.js";
import { checkDailySpend } from "./watchdog/checks/daily-spend.js";
import { reportSweep } from "./watchdog/reporter.js";
import { sendHeartbeat } from "./watchdog/heartbeat.js";
import { runWatchdogSweep } from "./watchdog/run.js";
import { PgWatchdogStateStore } from "./watchdog/state.js";
```

(`SupabaseAuditLogStore` ya está importado en la línea 19.)

- [ ] **Step 2: Extender `WorkerDeps`**

Dentro de la interface `WorkerDeps` (antes del cierre `}` en la línea 72), añadir:

```ts
  // Watchdog (v1) — fallos silenciosos de entrada + recursos
  enableWatchdog?: boolean;
  watchdog?: {
    intervalMin: number;
    emailExpiryMarginHours: number;
    healthchecksUrl?: string;
    publicBaseUrl: string;
    authToken: string;
    botToken: string;
    whatsapp: { enabled: boolean; graphVersion: string; phoneNumberId: string; accessToken: string };
  };
```

- [ ] **Step 3: Registrar el cron dentro de `startWorker`**

Justo después del bloque `if (deps.emailFetchDeps) { ... }` que termina en la línea 302 (antes de `return { queue, stop: ... }` en la línea 304), insertar:

```ts
  // ── Watchdog sweep (v1) ─────────────────────────────────────────────────────
  if (deps.enableWatchdog && deps.watchdog && deps.alertChatId && deps.defaultWorkspaceId) {
    const wd = deps.watchdog;
    const workspaceId = deps.defaultWorkspaceId;
    const alertChatId = deps.alertChatId;
    const reauthUrl = `${wd.publicBaseUrl}/email-oauth-start?token=${wd.authToken}`;
    const expectedWebhook = `${wd.publicBaseUrl}/telegram-webhook`;
    const stateStore = new PgWatchdogStateStore(deps.databaseUrl);
    const auditStore = new SupabaseAuditLogStore(deps.supabaseUrl, deps.supabaseAnonKey);
    const tokenStore = deps.emailFetchDeps?.tokenStore;
    const now = () => new Date();

    await queue.work("watchdog.sweep", async () => {
      const checks: { id: string; run: () => Promise<import("./watchdog/types.js").CheckResult> }[] = [
        {
          id: "telegram-webhook",
          run: () => checkTelegramWebhook({ botToken: wd.botToken, expectedUrl: expectedWebhook }),
        },
        {
          id: "whatsapp-inbound",
          run: () =>
            checkWhatsAppInbound({
              enabled: wd.whatsapp.enabled,
              graphVersion: wd.whatsapp.graphVersion,
              phoneNumberId: wd.whatsapp.phoneNumberId,
              accessToken: wd.whatsapp.accessToken,
            }),
        },
        { id: "database", run: () => checkDatabase({ databaseUrl: deps.databaseUrl }) },
        {
          id: "daily-spend",
          run: () => checkDailySpend({ workspaceId, audit: auditStore, workspaces: deps.workspaceStore, now }),
        },
      ];
      if (tokenStore) {
        checks.unshift({
          id: "email-inbound",
          run: () =>
            checkEmailInbound({
              tokenStore,
              workspaceId,
              reauthUrl,
              expiryMarginMs: wd.emailExpiryMarginHours * 3_600_000,
              now,
            }),
        });
      }
      await runWatchdogSweep({
        checks,
        report: (results) => reportSweep(results, { stateStore, transport: deps.transport, alertChatId, now }),
        heartbeat: () => sendHeartbeat({ url: wd.healthchecksUrl }),
      });
    });

    await queue.scheduleRecurring(
      "watchdog.sweep",
      `*/${wd.intervalMin} * * * *`,
      {},
      { singletonKey: "watchdog.sweep.singleton" },
    );
    await queue.send("watchdog.sweep", {}, { singletonKey: "watchdog.sweep.singleton" });
    logger.info({ intervalMin: wd.intervalMin }, "[watchdog] sweep cron registered");
  }
  // ────────────────────────────────────────────────────────────────────────────
```

- [ ] **Step 4: Verificar que compila**

Run: `pnpm --filter @agent-mouth/api build`
Expected: PASS (sin errores de tipos).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/worker.ts
git commit -m "feat(watchdog): register watchdog.sweep cron in startWorker"
```

---

## Task 13: Cablear env vars en `serve-http.ts`

**Files:**
- Modify: `packages/api/src/cli/serve-http.ts` (dentro del objeto pasado a `startWorker({...})`, ~líneas 355–381)

- [ ] **Step 1: Añadir el wiring de env**

Dentro del objeto literal que se pasa a `startWorker({ ... })`, justo después de la línea `transportRegistry: transportRegistry ?? undefined,` (línea 380) y antes del cierre `})` (línea 381), añadir:

```ts
        // Watchdog (v1) — inerte hasta ENABLE_WATCHDOG=true
        enableWatchdog: process.env.ENABLE_WATCHDOG === "true",
        watchdog: {
          intervalMin: process.env.WATCHDOG_INTERVAL_MIN ? Number(process.env.WATCHDOG_INTERVAL_MIN) : 60,
          emailExpiryMarginHours: process.env.WATCHDOG_EMAIL_EXPIRY_MARGIN_HOURS
            ? Number(process.env.WATCHDOG_EMAIL_EXPIRY_MARGIN_HOURS)
            : 24,
          healthchecksUrl: process.env.HEALTHCHECKS_URL,
          publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "https://agent-mouth.fly.dev",
          authToken: process.env.AGENT_MOUTH_AUTH_TOKEN ?? "",
          botToken: process.env.AGENT_MOUTH_BOT_TOKEN ?? "",
          whatsapp: {
            enabled: process.env.ENABLE_WHATSAPP_TRANSPORT === "true",
            graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0",
            phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
            accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? "",
          },
        },
```

- [ ] **Step 2: Verificar que compila**

Run: `pnpm --filter @agent-mouth/api build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/cli/serve-http.ts
git commit -m "feat(watchdog): wire ENABLE_WATCHDOG + config env vars into startWorker"
```

---

## Task 14: Verificación final

**Files:** ninguno (solo verificación).

- [ ] **Step 1: Suite completa del paquete api**

Run: `pnpm --filter @agent-mouth/api test`
Expected: PASS — todos los tests previos del paquete + los 8 archivos nuevos de `tests/watchdog/` (email-inbound 5, telegram-webhook 3, whatsapp-inbound 3, database 2, daily-spend 3, reporter 5, heartbeat 3, run 2 = 26 tests nuevos).

- [ ] **Step 2: Build + lint de todo el monorepo**

Run: `pnpm -r build && pnpm lint`
Expected: PASS (tsc sin errores; biome sin findings). Si biome se queja del orden de imports, corre `pnpm format` y re-commitea.

- [ ] **Step 3: Verificación manual diferida (notas para Gavrilo, NO ejecutar aquí)**

Documentar en el resumen de handoff (no es un paso de código). El deploy lo hace Gavrilo (`autopilot.excluir` = deploy/push/publish):
1. Aplicar `0006_watchdog.sql` por el **SQL editor de Supabase** (cuenta `gavrimarkovic4@gmail.com`).
2. `flyctl secrets set ENABLE_WATCHDOG=true HEALTHCHECKS_URL=<ping-url> --app agent-mouth` (+ opcionales `WATCHDOG_INTERVAL_MIN`, `WATCHDOG_EMAIL_EXPIRY_MARGIN_HOURS`).
3. Crear el check en healthchecks.io (periodo = intervalo + grace).
4. `flyctl deploy` y comprobar en `flyctl logs` la línea `[watchdog] sweep cron registered` + que el primer sweep corre. Probar en caliente: desviar temporalmente el watch del email o forzar un `status` no-active y ver llegar la alerta a Telegram con el link de re-auth.

- [ ] **Step 4: Commit final (si `pnpm format` cambió algo)**

```bash
git add -A
git commit -m "chore(watchdog): biome format pass"
```

---

## Self-Review (hecho por el autor del plan)

**1. Cobertura del spec:**
- §3 arquitectura (cron + módulo + PgClient directo, no tocar Phase 3) → Tasks 9, 12. ✅
- §4 los 5 checks → Tasks 2–6. ✅ (email proactivo con margen, telegram getWebhookInfo, whatsapp skip-when-off, database SELECT 1, daily-spend 85% UTC).
- §5 anti-spam (tabla 0006 + transiciones) → Tasks 7, 11. ✅
- §6 dead-man's-switch (heartbeat, no-op sin URL) → Task 8. ✅
- §7 config inerte tras `ENABLE_WATCHDOG` → Tasks 12, 13. ✅
- §8 formato de alerta (emojis 🔴/🟠/✅) → Task 7 reporter. ✅
- §9 testing por unidad + aislamiento de fallos → Tasks 2–8, 10. ✅
- §10 reparto humano → Task 14 Step 3. ✅

**2. Placeholders:** ninguno — todo step de código lleva el código completo; los comandos son ejecutables; no hay "TBD"/"similar a".

**3. Consistencia de tipos:** `CheckResult`/`CheckStatus`/`WatchdogStateRow`/`WatchdogStateStore` (Task 1) se usan idénticos en checks, reporter, state y run. `reportSweep(results, ReporterDeps)` y `runWatchdogSweep(RunWatchdogSweepDeps)` con `report`/`heartbeat` como callbacks coinciden entre Task 7/8/10 y el wiring de Task 12. `Transport.send({to, body})` y `Pick<...>` de stores coinciden con el dossier real.

**Decisión consciente (no placeholder):** `state.ts` (Task 9) no tiene unit test directo — es I/O fino; la lógica anti-spam vive en el reporter (Task 7), 100% testeada con un mock de `WatchdogStateStore`. Se verifica en deploy (Task 14 Step 3).
