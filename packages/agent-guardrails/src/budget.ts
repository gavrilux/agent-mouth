import type { AuditLogStore, WorkspaceStore } from "@agent-mouth/core";
import type { GuardrailResult } from "./types.js";

export async function checkBudget(
  ctx: { workspaceId: string },
  audit: AuditLogStore,
  workspaces: WorkspaceStore,
): Promise<GuardrailResult> {
  const ws = await workspaces.getDefault();
  const cap = (ws as unknown as { daily_budget_usd_cap: number }).daily_budget_usd_cap ?? 5.0;
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const spent = await audit.sumCostUsdSince(ctx.workspaceId, startOfDay.toISOString());
  if (spent + 0.01 > cap) {
    return { ok: false, reason: `budget_cap_reached:${spent.toFixed(4)}/${cap}` };
  }
  return { ok: true };
}
