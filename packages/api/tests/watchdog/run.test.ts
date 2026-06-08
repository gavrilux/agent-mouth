// packages/api/tests/watchdog/run.test.ts
import { describe, expect, it, vi } from "vitest";
import { runWatchdogSweep } from "../../src/watchdog/run.js";
import type { CheckResult } from "../../src/watchdog/types.js";

describe("runWatchdogSweep", () => {
  it("recoge resultados y un check que lanza se convierte en down", async () => {
    let received: CheckResult[] = [];
    const report = vi.fn(async (rs: CheckResult[]) => {
      received = rs;
    });
    const heartbeat = vi.fn(async () => {});
    await runWatchdogSweep({
      checks: [
        { id: "a", run: async () => ({ id: "a", status: "ok", message: "ok" }) },
        {
          id: "b",
          run: async () => {
            throw new Error("boom");
          },
        },
      ],
      report,
      heartbeat,
    });
    expect(received.map((r) => `${r.id}:${r.status}`)).toEqual(["a:ok", "b:down"]);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it("el heartbeat se envía aunque report lance", async () => {
    const report = vi.fn(async () => {
      throw new Error("report fail");
    });
    const heartbeat = vi.fn(async () => {});
    await runWatchdogSweep({
      checks: [{ id: "a", run: async () => ({ id: "a", status: "ok", message: "ok" }) }],
      report,
      heartbeat,
    });
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});
