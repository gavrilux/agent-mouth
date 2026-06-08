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
