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

  const now = deps.now();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const lines: string[] = [];

  for (const r of results) {
    const before = prev.get(r.id);
    const wasBad = !!before && before.status !== "ok";

    if (r.status !== "ok") {
      const firstSeen = wasBad && before?.first_seen_at ? before.first_seen_at : nowIso;
      const lastAlertedMs = before?.last_alerted_at ? new Date(before.last_alerted_at).getTime() : 0;
      const isTransition = !wasBad || before?.status !== r.status;
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
