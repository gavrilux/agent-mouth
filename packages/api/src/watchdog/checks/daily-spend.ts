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
