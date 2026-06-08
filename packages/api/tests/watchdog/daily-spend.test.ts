// packages/api/tests/watchdog/daily-spend.test.ts
import { describe, expect, it, vi } from "vitest";
import { checkDailySpend } from "../../src/watchdog/checks/daily-spend.js";

const now = () => new Date("2026-06-05T12:00:00.000Z");
const workspaces = (cap: number) =>
  ({ getDefault: vi.fn(async () => ({ daily_budget_usd_cap: cap })) }) as never;
const audit = (spent: number) => ({ sumCostUsdSince: vi.fn(async () => spent) }) as never;

describe("checkDailySpend", () => {
  it("ok cuando el gasto está por debajo del 85% del cap", async () => {
    const r = await checkDailySpend({
      workspaceId: "w",
      audit: audit(0.3),
      workspaces: workspaces(1),
      now,
    });
    expect(r.status).toBe("ok");
  });

  it("warn al cruzar el 85% del cap", async () => {
    const r = await checkDailySpend({
      workspaceId: "w",
      audit: audit(0.9),
      workspaces: workspaces(1),
      now,
    });
    expect(r.status).toBe("warn");
    expect(r.message).toContain("%");
  });

  it("usa medianoche UTC como inicio del día", async () => {
    const sum = vi.fn(async () => 0.1);
    await checkDailySpend({
      workspaceId: "w",
      audit: { sumCostUsdSince: sum } as never,
      workspaces: workspaces(1),
      now,
    });
    expect(sum).toHaveBeenCalledWith("w", "2026-06-05T00:00:00.000Z");
  });
});
